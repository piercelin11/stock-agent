// PLAN 2 §2：資料脈絡單一真相來源。
//
// 「盤中該用 DB 昨收還是 MIS 即時」的判斷 + 如何 fallback，收斂到這一支 helper。
// 物理上仍是 DB + JSON 兩來源（盤中衍生值不落 DB，遵循專案「衍生值不落地」哲學），
// 這裡只統一「判斷用哪個」。
//
// **非 "use server"**（純函式 + 讀檔，被多個 action 呼叫；比照 lib/dashboard-spark.ts / lib/latest-scan.ts）。
// 收 prisma（呼叫端傳前端單例）——比照 scripts/lib/market-regime.ts 一律外部傳。

import type { PrismaClient } from "../generated/prisma/client";
import { readLatestScan, type LatestScan } from "./latest-scan";

export type DataMode = "eod" | "intraday" | "stale";

export interface DataContext {
  mode: DataMode;
  //  eod      = DB 最新一般股票交易日 == 台北今日 → 用 DB（盤後定案）
  //  intraday = 非今日 + 現在台北平日 09:00–13:30 + 有「夠新」的掃描 JSON → 用 JSON（PLAN 3 才真的用）
  //  stale    = 非今日 + 盤外 / 無夠新 JSON → 用 DB 昨收（畫面標「收盤定案 {date}」）
  asOfDate: string; // 畫面該顯示的「截至」日期
  latestEodDate: string; // DB 最新一般股票交易日（YYYY-MM-DD）
  latestScan: LatestScan | null; // preferRealtime 讀到的最新掃描結果（intraday/stale 都附）
}

// 掃描 JSON「夠新」的上限：PLAN 3 的 launchd 每 30 分跑 → 30 分間隔 + 5 分緩衝。
// 超過 = 伺服器沒開或 launchd 沒跑成 → 退 stale。
const INTRADAY_STALE_MS = 35 * 60_000;

/** 台北現在時間（用 +8 偏移，避免依賴伺服器 TZ；專案其他地方也是這套路）。 */
function taipeiNow(now: Date): { iso: string; hour: number; minute: number; weekday: number } {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  return {
    iso: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(), // 0 = 週日
  };
}

function isTaipeiTradingHours(t: {
  hour: number;
  minute: number;
  weekday: number;
}): boolean {
  if (t.weekday === 0 || t.weekday === 6) return false; // 週末
  const mins = t.hour * 60 + t.minute;
  return mins >= 9 * 60 && mins <= 13 * 60 + 30; // 09:00–13:30
}

export async function resolveDataContext(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DataContext> {
  const latest = await prisma.dailyQuote.findFirst({
    where: { stock: { securityType: "stock" } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const latestEodDate = latest ? latest.date.toISOString().slice(0, 10) : "";

  const t = taipeiNow(now);
  const latestScan = readLatestScan({ preferRealtime: true });

  if (latestEodDate && latestEodDate === t.iso) {
    return { mode: "eod", asOfDate: t.iso, latestEodDate, latestScan };
  }

  if (
    isTaipeiTradingHours(t) &&
    latestScan &&
    latestScan.source === "realtime" &&
    latestScan.timestamp &&
    now.getTime() - new Date(latestScan.timestamp).getTime() < INTRADAY_STALE_MS
  ) {
    return {
      mode: "intraday",
      asOfDate: latestScan.scanDate,
      latestEodDate,
      latestScan,
    };
  }

  return { mode: "stale", asOfDate: latestEodDate, latestEodDate, latestScan };
}
