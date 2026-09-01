"use server";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../prisma";
import {
  runSignalScan,
  type SignalScanOutput,
  type SignalResult,
  type SignalStage,
  type SignalSource,
  type WatchlistQuote,
} from "../../scripts/screening/run-signal-scan";
import { SPARK_WINDOW, type SparkPoint } from "../dashboard-spark";
import { buildSparkSeries } from "../spark-series";
import { resolveDataContext, type DataMode } from "../data-context";

// ROADMAP 4.5.3 / PLAN 4：選股頁資料源統一走 resolveDataContext()。
//
// 前端一進頁：getScreeningContext() 拿 { mode, asOfDate, latestEodDate, hasScan } →
//   getScreeningResult() 依 mode 回對應結果：
//     eod            → 先讀 data/signal-scan-results/{date}.json（無時間戳）；沒有才同步
//                       runSignalScan 算一次（秒級）並寫入。daily-pipeline 不會自動產出這份檔
//                       （run-signal-scan.ts 獨立手動執行，不進 pipeline）——只有「當天第一次
//                       進選股頁」或手動重跑會觸發計算，同一天內之後進頁都是讀檔，不重算。
//     intraday/stale → 讀最新 realtime {timestamp}.json（launchd 的 intraday-scan.ts 產出）。
//   手動重跑：getScreeningResult({ force }) —— eod 一律重算並覆寫該檔；realtime 同步卡 UI ~30 秒
//     （不再 spawn 背景子進程 + 輪詢 progress.json，PLAN 4 移除那套狀態機）。
//
// runSignalScan 本體會被 import 進 bundle（同步純函式，screening.ts 舊模式已這樣跑過）；
// realtime 的 MIS 抓取在同步呼叫裡完成，會卡住 Server Action ~30 秒——這是 PLAN 4 的取捨。

const REPO_ROOT = process.cwd();
const RESULT_DIR = join(REPO_ROOT, "data", "signal-scan-results");

// ---- view 型別（邊界轉換後的可序列化版；SignalResult 已全是 number/string）----
export type { SignalStage, SignalSource };

export interface SignalScanView {
  date: string;
  source: SignalSource;
  queriedAt: string;
  elapsedRatio?: number;
  isNonTradingDay: boolean;
  stats: Record<string, number>;
  warnings: string[];
  results: SignalResult[];
  watchlistQuotes?: WatchlistQuote[]; // PLAN 2 §3.2：透傳
}

function toView(out: SignalScanOutput): SignalScanView {
  const view: SignalScanView = {
    date: out.date,
    source: out.source,
    queriedAt: out.queriedAt,
    isNonTradingDay: out.isNonTradingDay,
    stats: { ...out.stats } as Record<string, number>,
    warnings: out.warnings,
    results: out.results,
  };
  if (out.elapsedRatio !== undefined) view.elapsedRatio = out.elapsedRatio;
  if (out.watchlistQuotes !== undefined) view.watchlistQuotes = out.watchlistQuotes;
  return view;
}

/** 最新 realtime 掃描檔（{timestamp}.json）。壞檔 / 無檔回 null。 */
function readLatestRealtimeFile(): SignalScanOutput | null {
  if (!existsSync(RESULT_DIR)) return null;
  const files = readdirSync(RESULT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;
  try {
    return JSON.parse(readFileSync(join(RESULT_DIR, latest), "utf8")) as SignalScanOutput;
  } catch {
    return null;
  }
}

/** eod 掃描檔（{date}.json，無時間戳）。壞檔 / 無檔回 null。 */
function readEodFile(dateStr: string): SignalScanOutput | null {
  const path = join(RESULT_DIR, `${dateStr}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SignalScanOutput;
  } catch {
    return null;
  }
}

// ============================================================================
// getScreeningContext —— 前端一進頁先問這個，決定狀態行文案 + 有沒有結果可顯示
// ============================================================================
//
// 直接透傳 resolveDataContext() 的關鍵欄位 + hasScan（「有沒有可顯示的掃描結果」）。
//   eod            → hasScan = 有 latestEodDate（進頁讀 {date}.json，沒有才同步算一次，見下）。
//   intraday/stale → hasScan = data/signal-scan-results/ 有 realtime {timestamp}.json。

export async function getScreeningContext(): Promise<{
  mode: DataMode;
  asOfDate: string;
  latestEodDate: string | null;
  hasScan: boolean;
}> {
  const ctx = await resolveDataContext(prisma);
  const hasScan =
    ctx.mode === "eod" ? Boolean(ctx.latestEodDate) : readLatestRealtimeFile() !== null;
  return {
    mode: ctx.mode,
    asOfDate: ctx.asOfDate,
    latestEodDate: ctx.latestEodDate || null,
    hasScan,
  };
}

// ============================================================================
// getScreeningResult —— 單一入口：依 resolveDataContext().mode（或 force）回結果
// ============================================================================

export async function getScreeningResult(
  opts: { force?: "eod" | "realtime" } = {},
): Promise<SignalScanView | null> {
  const ctx = await resolveDataContext(prisma);
  const mode = opts.force ?? (ctx.mode === "eod" ? "eod" : "realtime");

  if (mode === "eod") {
    // 「強制 eod 補算」語意：跑 DB 最新一般股票交易日。runSignalScan 要 Date 物件。
    const latest = await prisma.dailyQuote.findFirst({
      where: { stock: { securityType: "stock" } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (!latest) {
      return {
        date: "",
        source: "eod",
        queriedAt: new Date().toISOString(),
        isNonTradingDay: true,
        stats: {},
        warnings: ["資料庫尚無 DailyQuote，請先跑 daily-pipeline"],
        results: [],
      };
    }
    const dateStr = latest.date.toISOString().slice(0, 10);
    // 非強制重跑：{date}.json 已存在就直接讀，不重算（daily-pipeline 不會自動產出這份檔，
    // 只有「當天第一次進頁」或手動重跑才需要真的算）。
    if (opts.force !== "eod") {
      const cached = readEodFile(dateStr);
      if (cached) return toView(cached);
    }
    // 傳前端 Prisma 單例 + 強制 eod。純函式偵測 options.prisma 時不 $disconnect。
    // 一律重算並覆寫 {date}.json（含 force:"eod" 手動重跑、與檔案不存在/壞檔的 fallback）。
    const out = await runSignalScan(latest.date, { prisma, source: "eod" });
    return toView(out);
  }

  // realtime：force 時同步跑一次全市場 MIS 掃描（卡 UI ~30 秒，寫 {timestamp}.json）；
  // 不 force 時讀 launchd 產出的最新 realtime {timestamp}.json（intraday / stale 的一般進頁路徑）。
  if (opts.force === "realtime") {
    const out = await runSignalScan(new Date(), { prisma, source: "realtime" });
    return toView(out);
  }
  const rt = readLatestRealtimeFile();
  return rt ? toView(rt) : null;
}

// ============================================================================
// getSignalSpark —— 展開列左欄近 60 交易日走勢圖（按需撈，PLAN §3.1）
// ============================================================================
//
// 純讀 DB、回可序列化 SparkPoint[]。realtime / eod 都用同一支（都讀 DB 歷史，與當下報價源無關）。
// 查不到 → 回 []（前端顯示「資料不足」）。方向（rising）前端已有 row.changePercent，不放這裡。

export async function getSignalSpark(code: string): Promise<SparkPoint[]> {
  const [quotes, indicators] = await Promise.all([
    prisma.dailyQuote.findMany({
      where: { stockCode: code },
      orderBy: { date: "desc" },
      take: SPARK_WINDOW,
      select: { date: true, close: true },
    }),
    prisma.technicalIndicator.findMany({
      where: { stockCode: code },
      orderBy: { date: "desc" },
      take: SPARK_WINDOW,
      select: { date: true, bollingerMid: true },
    }),
  ]);
  if (quotes.length === 0) return [];

  const midByDate = new Map<number, number | null>();
  for (const ind of indicators) midByDate.set(ind.date.getTime(), ind.bollingerMid);

  return buildSparkSeries(quotes, midByDate);
}
