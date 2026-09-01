// MIS（mis.twse.com.tw）即時報價抓取 —— 純 Node 函式庫（無 Prisma / CLI），比照 scripts/lib/http.ts。
//
// 2026-08-31 從當時的 check-intraday-breakout.ts 抽出（該檔已於 4.5.4 退役移除）。
// 現由 run-signal-scan.ts 的 realtime 路徑使用。純搬移，行為不變。
//
// mis.twse.com.tw/stock/api/getStockInfo.jsp 是社群逆向工程端點，非官方文件。
// 回應中超過半數個股 `z`（成交價）為空——是 API bug（不是冷門股沒成交），呼叫端要自行處理
// （run-signal-scan.ts 用當日最高價 h 代入，見 PLAN §4）。本檔只負責「把 MIS 回應轉成結構化 quote」，
// 不做「缺 z 就丟掉」的判斷——那個決定留給呼叫端。

import { Market } from "../../generated/prisma/client";

export const MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
export const BATCH_SIZE = 120;
export const BATCH_DELAY_MS = 1500;

const MARKET_OPEN_HOUR = 9;
const MARKET_CLOSE_HOUR = 13;
const MARKET_CLOSE_MINUTE = 30;
/** 09:00–13:30 = 270 分鐘 */
export const TRADING_MINUTES = (MARKET_CLOSE_HOUR - MARKET_OPEN_HOUR) * 60 + MARKET_CLOSE_MINUTE;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 型別 ----
interface MisRawRow {
  c: string; // 代號
  n: string; // 名稱
  z: string; // 成交價（可能是 "-" 或缺失）
  y?: string; // 昨收
  v?: string; // 累計成交量（張，可能缺失或 "-"）
  d?: string; // 日期
  o?: string; // 開盤價（可能缺失或 "-"）
  h?: string; // 盤中至今最高價（可能缺失或 "-"）
  l?: string; // 盤中至今最低價（可能缺失或 "-"）
}

export interface MisQuote {
  code: string;
  name: string;
  /** 成交價；MIS 未回成交價（z 為 "-" / 缺失）時為 null，呼叫端決定如何代入 */
  price: number | null;
  prevClose: number | null;
  cumulativeVolume: number; // 股（MIS 原始為張，已 ×1000）
  date: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
}

function exChPrefix(market: Market): string {
  return market === Market.TWSE ? "tse" : "otc";
}

export function parseMisDate(raw: string | undefined): string | null {
  if (!raw) return null;
  // 觀察到的格式可能是 YYYYMMDD；若格式不符，回傳 null 而不是猜測解析
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(raw)) {
    return raw.replaceAll("/", "-");
  }
  return null;
}

/** 盤中經過時間比例（估全日量用）。raw 可能 < 0.05（開盤前）或 > 1（收盤後），clipped 夾在 [0.05, 1]。 */
export function computeElapsedRatio(now: Date): { raw: number; clipped: number } {
  const minutesSinceOpen =
    (now.getHours() - MARKET_OPEN_HOUR) * 60 + now.getMinutes() + now.getSeconds() / 60;
  const raw = minutesSinceOpen / TRADING_MINUTES;
  const clipped = Math.min(Math.max(raw, 0.05), 1.0);
  return { raw, clipped };
}

// ---- 批次抓取 ----
export async function fetchMisBatch(codes: { code: string; market: Market }[]): Promise<{
  quotes: MisQuote[];
  failed: boolean;
}> {
  const exCh = codes.map((c) => `${exChPrefix(c.market)}_${c.code}.tw`).join("|");
  const url = new URL(MIS_URL);
  url.searchParams.set("ex_ch", exCh);
  url.searchParams.set("json", "1");
  url.searchParams.set("delay", "0");

  try {
    const res = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.warn(`⚠ MIS 批次請求失敗: ${res.status} ${res.statusText}（${codes.length} 檔）`);
      return { quotes: [], failed: true };
    }
    const body = (await res.json()) as { msgArray?: MisRawRow[] };
    const rows = body.msgArray ?? [];

    const parsePositive = (raw: string | undefined): number | null => {
      if (raw === undefined || raw === "-") return null;
      const parsed = parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };

    const quotes: MisQuote[] = [];
    for (const row of rows) {
      // 缺 z 不再跳過——保留這筆，price = null，呼叫端決定代入策略（PLAN §4 的 MIS z bug）。
      const price = parsePositive(row.z);

      // MIS 的 v 欄位單位是「張」，換算成「股」以跟 DailyQuote.volume / gate 的股數單位一致
      const volumeRaw = row.v;
      const cumulativeVolumeLots =
        volumeRaw === undefined || volumeRaw === "-" ? 0 : parseFloat(volumeRaw) || 0;
      const cumulativeVolume = cumulativeVolumeLots * 1000;

      quotes.push({
        code: row.c,
        name: row.n,
        price,
        prevClose: parsePositive(row.y),
        cumulativeVolume,
        date: parseMisDate(row.d),
        open: parsePositive(row.o),
        high: parsePositive(row.h),
        low: parsePositive(row.l),
      });
    }
    return { quotes, failed: false };
  } catch (err) {
    console.warn(
      `⚠ MIS 批次請求例外: ${err instanceof Error ? err.message : String(err)}（${codes.length} 檔）`,
    );
    return { quotes: [], failed: true };
  }
}

/**
 * 全市場逐批抓 MIS 即時報價。BATCH_SIZE 檔/批，批間 sleep BATCH_DELAY_MS。
 * onBatch：每批完成後回呼（done / total / failedSoFar），供背景任務逐批寫 progress.json。
 */
export async function fetchAllMisQuotes(
  stocks: { code: string; market: Market }[],
  onBatch?: (done: number, total: number, failedSoFar: number) => void,
): Promise<{ quotes: Map<string, MisQuote>; failedCount: number }> {
  const quotes = new Map<string, MisQuote>();
  let failedCount = 0;

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    const { quotes: batchQuotes, failed } = await fetchMisBatch(batch);
    if (failed) {
      failedCount += batch.length;
    } else {
      for (const q of batchQuotes) {
        quotes.set(q.code, q);
      }
    }
    onBatch?.(Math.min(i + BATCH_SIZE, stocks.length), stocks.length, failedCount);
    if (i + BATCH_SIZE < stocks.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return { quotes, failedCount };
}
