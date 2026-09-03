// PLAN 2 §1：掃描結果 JSON 的唯一讀取入口。
//
// 從 lib/actions/watchlist.ts 內建的 readLatestScan() 搬出來、擴充成回傳更完整的 map。
// **非 "use server"**（純檔案 IO + 純函式，供多個 action import；比照 lib/dashboard-spark.ts 是值不是 server）。
//
// 職責：跨頁面「拿某幾檔的分數 / 分項」。與 lib/actions/signal-scan.ts 的 getScreeningResult()
// （screening 頁進頁 / 手動重跑時拿整份結果用）職責不同、不合併——signal-scan.ts 自帶
// readLatestRealtimeFile()，本檔另有 parseScanFile() + eod/realtime 比對邏輯。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  SignalResult,
  SignalScanOutput,
  WatchlistQuote,
} from "../scripts/screening/run-signal-scan";

const RESULT_DIR = join(process.cwd(), "data", "signal-scan-results");

// 醞釀階段每檔從掃描結果拿的欄位（不在名單 → 該 code 無此 entry）
export interface ScanPreInst {
  trustScore: number | null;
  otherInstScore: number | null;
  trustNetRatio: number | null;
  otherInstRatio: number | null;
}

// ScanResultLite = SignalResult 的可序列化子集。JSON 就是這個形狀，不另外裁。
export type ScanResultLite = SignalResult;

export interface LatestScan {
  scanDate: string;
  source: "eod" | "realtime";
  timestamp: string; // JSON 的 queriedAt（判新舊用）
  prByCode: Map<string, number>; // relativeStrength（強度 PR 欄）
  preInstByCode: Map<string, ScanPreInst>; // 只 pre-breakout：trustScore / otherInstScore / detail
  resultByCode: Map<string, ScanResultLite>; // 每檔完整分項（PLAN 3 的 watchlist 三分支用）
  watchlistQuotesByCode: Map<string, WatchlistQuote>; // §3.2 產出的觀察股即時報價
}

export interface ReadLatestScanOptions {
  // 預設（false）：只讀 {YYYY-MM-DD}.json（eod 定案）——給 watchlist / dashboard 的「強度 PR」「醞釀籌碼」用。
  // true（PLAN 3 的 intraday 模式）：比較 {YYYY-MM-DD}.json 與 {台北今日}-intraday.json 的 queriedAt，回較新者。
  preferRealtime?: boolean;
  // PLAN 5 §1.3：realtime 掃描檔改成固定檔名 {台北今日}-intraday.json（不再 readdir + sort 時間戳）。
  // readLatestScan 是純讀檔、沒有 now——由呼叫端（data-context 已有 taipeiNow）傳「台北今日」進來。
  // 省略時本檔自算（UTC+8 偏移，比照其他檔）。
  todayIso?: string;
}

/** 讀單一掃描結果檔並解析成 SignalScanOutput（含 params，忽略即可）。壞檔回 null。 */
export function parseScanFile(path: string): SignalScanOutput | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SignalScanOutput;
  } catch {
    return null;
  }
}

function listEodFiles(): string[] {
  if (!existsSync(RESULT_DIR)) return [];
  return readdirSync(RESULT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function taipeiTodayIso(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function buildLatestScan(out: SignalScanOutput, fallbackDate: string): LatestScan {
  const prByCode = new Map<string, number>();
  const preInstByCode = new Map<string, ScanPreInst>();
  const resultByCode = new Map<string, ScanResultLite>();
  for (const r of out.results ?? []) {
    resultByCode.set(r.code, r);
    const rs = r.scores?.["relativeStrength"];
    if (typeof rs === "number") prByCode.set(r.code, rs);
    if (r.stage === "setup") {
      preInstByCode.set(r.code, {
        trustScore:
          typeof r.scores?.["trustScore"] === "number" ? r.scores["trustScore"] : null,
        otherInstScore:
          typeof r.scores?.["otherInstScore"] === "number"
            ? r.scores["otherInstScore"]
            : null,
        trustNetRatio:
          typeof r.detail?.["trustNetRatio"] === "number"
            ? r.detail["trustNetRatio"]
            : null,
        otherInstRatio:
          typeof r.detail?.["otherInstRatio"] === "number"
            ? r.detail["otherInstRatio"]
            : null,
      });
    }
  }
  const watchlistQuotesByCode = new Map<string, WatchlistQuote>();
  for (const q of out.watchlistQuotes ?? []) watchlistQuotesByCode.set(q.code, q);

  return {
    scanDate: out.date ?? fallbackDate,
    source: out.source ?? "eod",
    timestamp: out.queriedAt ?? "",
    prByCode,
    preInstByCode,
    resultByCode,
    watchlistQuotesByCode,
  };
}

export function readLatestScan(options: ReadLatestScanOptions = {}): LatestScan | null {
  const eodFiles = listEodFiles();
  const latestEodName = eodFiles.at(-1);
  const latestEod = latestEodName
    ? parseScanFile(join(RESULT_DIR, latestEodName))
    : null;

  if (!options.preferRealtime) {
    if (!latestEod || !latestEodName) return null;
    return buildLatestScan(latestEod, latestEodName.replace(".json", ""));
  }

  // preferRealtime：比較最新 eod 與「今日 realtime」的 queriedAt，回較新者。
  // PLAN 5 §1.3：realtime 檔改成固定檔名 {台北今日}-intraday.json（每 30 分覆蓋同一檔）。
  //   跨日殘留防呆：若 {昨天}-intraday.json 還在、{今天} 沒有 → 讀不到今天的 → 不 fallback
  //   去讀昨天的（今天 launchd 還沒跑第一次，走 stale 才正確）。
  const todayIso = options.todayIso ?? taipeiTodayIso();
  const rtPath = join(RESULT_DIR, `${todayIso}-intraday.json`);
  const latestRt = existsSync(rtPath) ? parseScanFile(rtPath) : null;

  const candidates: { out: SignalScanOutput; fallbackDate: string }[] = [];
  if (latestEod && latestEodName) {
    candidates.push({ out: latestEod, fallbackDate: latestEodName.replace(".json", "") });
  }
  if (latestRt) {
    candidates.push({ out: latestRt, fallbackDate: todayIso });
  }
  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      new Date(b.out.queriedAt ?? 0).getTime() -
      new Date(a.out.queriedAt ?? 0).getTime(),
  );
  const winner = candidates[0]!;
  return buildLatestScan(winner.out, winner.fallbackDate);
}
