"use server";

import { prisma } from "../prisma";
import { revalidatePath } from "next/cache";
import { resolveDataContext, type DataContext, type DataMode } from "../data-context";
import {
  computeProximityToHigh,
  computeInstitutionalFlow,
  consecutiveAboveBand,
  resolveBreakoutConfig,
  resolveAccumulationConfig,
  DEFAULT_INSTITUTIONAL_FLOW_CONFIG,
} from "../../scripts/lib/signal-factors/index";

// SignalStage 型別走 signal-scan re-export（`import type` 會被 erase，不會把掃描管線拉進 bundle）。
import type { SignalStage } from "./signal-scan";
export type { SignalStage };
import { SPARK_WINDOW, type SparkPoint } from "../dashboard-spark";
import { buildSparkSeries } from "../spark-series";

// ROADMAP 4.5.x：watchlist 頁卡片 gallery。
// PLAN 3 §3：資料源從「A 方案：一進頁自動打 MIS」改成「三分支，接 resolveDataContext()」——
//   - stage：consecutiveAboveBand() 即時判定（不是 WatchlistItem.source 靜態欄位）
//   - ctx.mode === "eod"      → 讀 DB 當日（⚡）。與改版前相同。
//   - ctx.mode === "intraday" → 讀最新 realtime 掃描 JSON 的 watchlistQuotes + resultByCode（🕐）。
//                               分項不需前端現算（豁免 gate 後觀察股都在 results[]）。
//   - ctx.mode === "stale"    → 讀 DB 昨收（🕐）+ 卡片標「收盤定案 {latestEodDate}」。
//   **進頁不再打 MIS**——盤中即時報價統一由 intraday-scan.ts（launchd 每 30 分）產出。
//   強度 PR / 醞釀籌碼：統一走 ctx.latestScan（preferRealtime）的 prByCode / preInstByCode / resultByCode。
// 買入狀態欄位（isPurchased / buyPrice / ...）schema 保留，UI 不再顯示，updateWatchlistItem 仍留著。

const { score } = resolveBreakoutConfig();
const BASE_MAX_WINDOW = score.baseMaxWindowDays; // 240（布林指標歷史撈取窗，供階段判定 / 走勢圖）

// 醞釀階段（pre-breakout）法人籌碼區塊用（PLAN 醞釀中卡片法人籌碼區塊）
const ACC = resolveAccumulationConfig().score;
const PRE_INST_WINDOW = ACC.institutionalWindowDays; // 20
const PRE_INST_MIN_DAYS = Math.ceil(
  ACC.institutionalWindowDays * ACC.minInstitutionalDaysRatio,
); // ceil(20 * 0.5) = 10

export interface WatchlistCardRow {
  stockCode: string;
  name: string;
  addedAt: string;

  stage: SignalStage; // 卡片因子實際採用的階段 = userStage ?? autoStage
  userStage: SignalStage; // 手動分類（加入時 = 當下 autoStage；理論上恆有值，既有資料 null → autoStage）
  autoStage: SignalStage; // 即時判定（consecutiveAboveBand），只拿來比對 + 不一致 chip
  mode: DataMode; // resolveDataContext().mode——卡片自己組「收盤定案」字串（§3.4）
  dataFresh: boolean; // 僅 mode === "eod" 為 true → ⚡ / intraday·stale 皆 false → 🕐
  priceSource: "eod" | "realtime" | "estimated"; // intraday 用 realtime/estimated；eod·stale 一律 eod
  latestEodDate: string; // DB 最新一般股票交易日（stale 卡片顯示「收盤定案 {date}」）
  refDate: string; // 卡片實際採用的資料日期（DB 用 quote.date；intraday 用 watchlistQuote.refDate）

  close: number;
  changePercent: number;
  volumeRatio: number | null; // 今日（或盤中估全日）volume / volumeMa20——醞釀中「量增」欄仍用
  spark: SparkPoint[]; // 近 60 日相對布林中軌偏離（舊 → 新）

  // 法人 diverging bar 中繼值——只在 breakout-day / extended 組；pre-breakout = null
  inst: {
    trustRatio: number;
    foreignRatio: number;
    todayTrustDir: -1 | 0 | 1 | null;
    todayForeignDir: -1 | 0 | 1 | null;
  } | null;

  // 底排突破因子原始值——只在 breakout-day / extended 組；pre-breakout = null
  factors: {
    proximityLongPct: number; // 距一年高點 %（<= 0）
    breakoutMarginPct: number; // (close - bollingerUpper) / bollingerUpper * 100
    relativeStrength: number | null; // §3.1：最近掃描結果的 PR；不在結果裡 = null
    relativeStrengthStale: boolean; // §3.1：掃描結果日期 != 卡片資料日期
  } | null;

  // 醞釀階段法人籌碼區塊——只在 pre-breakout 組；breakout 階段 null
  preInst: PreBreakoutInst | null;
}

export interface PreBreakoutInst {
  // 20 格日曆：舊 → 新，長度可能 < 20（前面補「無資料」由前端處理）。true = 該日投信淨買超 > 0
  buyDayFlags: boolean[];
  buyDays: number; // buyDayFlags 中 true 的數量
  consecutiveBuyDays: number; // 從最新往回連續買超天數
  dataDays: number; // 20 日窗內實際有 InstitutionalTrading 的天數（= buyDayFlags.length）
  // 掃描結果帶入（該檔不在最近 eod 掃描的 pre-breakout 名單 → null）
  trustScore: number | null; // scores.trustScore（rankScore 加權合成，0~100）
  otherInstScore: number | null; // scores.otherInstScore（rankScore(otherInstRatio)，0~100）
  trustNetRatio: number | null; // detail.trustNetRatio 或 action 現算（sharesOutstanding null → null）
  otherInstRatio: number | null; // detail.otherInstRatio
  degraded: boolean; // dataDays < PRE_INST_MIN_DAYS
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// 最近掃描結果讀檔（供「強度 PR」欄 + 醞釀階段法人分數）已搬到 lib/latest-scan.ts（PLAN 2 §1）。

// ============================================================================
// listWatchlist —— 卡片 gallery 資料
// ============================================================================

export async function listWatchlist(): Promise<WatchlistCardRow[]> {
  const items = await prisma.watchlistItem.findMany({
    include: {
      stock: { select: { name: true, market: true, sharesOutstanding: true } },
    },
    orderBy: { addedAt: "desc" },
  });
  if (items.length === 0) return [];

  // 資料脈絡單一真相來源（PLAN 2 §2 / PLAN 3 §3）。
  // ctx.mode ∈ { eod, intraday, stale }；ctx.latestScan = readLatestScan({ preferRealtime: true })。
  // **進頁不打 MIS**——盤中即時報價由 intraday-scan.ts（launchd 每 30 分）寫進掃描 JSON，這裡讀 JSON。
  const ctx = await resolveDataContext(prisma);

  const rows = await Promise.all(items.map((item) => buildCardRow(item, ctx)));
  return rows.filter((r): r is WatchlistCardRow => r !== null);
}

type WatchlistItemWithStock = Awaited<
  ReturnType<
    typeof prisma.watchlistItem.findMany<{
      include: { stock: { select: { name: true; market: true; sharesOutstanding: true } } };
    }>
  >
>[number];

async function buildCardRow(
  item: WatchlistItemWithStock,
  ctx: DataContext,
): Promise<WatchlistCardRow | null> {
  const code = item.stockCode;
  const dataFresh = ctx.mode === "eod";
  const scan = ctx.latestScan; // readLatestScan({ preferRealtime: true })——PR / 醞釀籌碼 / 盤中報價 統一來源

  const dbQuote = await prisma.dailyQuote.findFirst({
    where: { stockCode: code },
    orderBy: { date: "desc" },
    select: { date: true, open: true, high: true, low: true, close: true, volume: true, change: true },
  });
  if (!dbQuote) return null;

  const [indicatorWindow, quoteWindow, institutional, instWindow] = await Promise.all([
    // 布林指標歷史（新到舊）：index 0 = 最新。bollingerUpper → 階段判定 / 突破幅度；
    // bollingerMid → 走勢圖正規化；volumeMa20 → volumeRatio
    prisma.technicalIndicator.findMany({
      where: { stockCode: code },
      orderBy: { date: "desc" },
      take: BASE_MAX_WINDOW + 1,
      select: { date: true, bollingerUpper: true, bollingerMid: true, volumeMa20: true },
    }),
    // 近 SPARK_WINDOW 筆收盤（走勢圖 + proximity 母體）
    prisma.dailyQuote.findMany({
      where: { stockCode: code },
      orderBy: { date: "desc" },
      take: Math.max(SPARK_WINDOW, score.proximityLongWindow + 1),
      select: { date: true, close: true, volume: true },
    }),
    prisma.institutionalTrading.findFirst({
      where: { stockCode: code },
      orderBy: { date: "desc" },
      select: { date: true, foreignNetBuy: true, investmentTrustNetBuy: true, dealerNetBuy: true },
    }),
    // 近 PRE_INST_WINDOW(20) 日投信/外資淨買超（新到舊）——breakout diverging bar 取前 5 筆；
    // pre-breakout 的 20 格日曆用全部。
    prisma.institutionalTrading.findMany({
      where: { stockCode: code },
      orderBy: { date: "desc" },
      take: PRE_INST_WINDOW,
      select: { foreignNetBuy: true, investmentTrustNetBuy: true },
    }),
  ]);

  // ---- 決定 close / volume / changePercent / priceSource / refDate（三分支，PLAN 3 §3）----
  //   eod    → DB 當日
  //   intraday → ctx.latestScan.watchlistQuotesByCode（intraday-scan.ts 產出的即時報價）；
  //              該 code 不在（MIS 沒抓到 / z·h 皆缺）→ 個別退回 DB 昨收，不影響其他檔
  //   stale  → DB 昨收
  const wq =
    ctx.mode === "intraday" ? scan?.watchlistQuotesByCode.get(code) ?? null : null;

  let close: number;
  let effectiveVolume: number; // 當日成交量（DB）或盤中估全日量（watchlistQuote.volume）
  let changePercent: number;
  let priceSource: WatchlistCardRow["priceSource"];
  let refDate: string;

  const dbPrevClose = dbQuote.close - dbQuote.change;
  const dbChangePercent = dbPrevClose > 0 ? (dbQuote.change / dbPrevClose) * 100 : 0;

  if (wq) {
    close = wq.close;
    effectiveVolume = wq.volume; // 已是估全日量（run-signal-scan.ts §3.2 產出）
    changePercent = wq.changePercent;
    priceSource = wq.priceSource; // "realtime" | "estimated"
    refDate = wq.refDate;
  } else {
    // eod / stale / intraday 個別 fallback：一律 DB 昨收
    close = dbQuote.close;
    effectiveVolume = Number(dbQuote.volume);
    changePercent = dbChangePercent;
    priceSource = "eod";
    refDate = isoDate(dbQuote.date);
  }

  // ---- 階段：consecutiveAboveBand 從 [0] 往回逐日比 close vs 當筆布林上軌 ----
  // [0] 用即時/當日 close，歷史筆用 quoteWindow 的真實收盤（非當日時上軌是 T-1 的，可接受）。
  const closeByDate = new Map<number, number>();
  for (const q of quoteWindow) closeByDate.set(q.date.getTime(), q.close);
  const stagingSeries = indicatorWindow.map((ind, i) => ({
    close: i === 0 ? close : (closeByDate.get(ind.date.getTime()) ?? NaN),
    bollingerUpper: ind.bollingerUpper,
  }));
  const aboveBand = consecutiveAboveBand(stagingSeries);
  const autoStage: SignalStage =
    aboveBand.consecutiveDays <= 0
      ? "setup"
      : aboveBand.consecutiveDays <= 2
        ? "breakoutDay"
        : "extended";
  // 卡片因子渲染看 stage；使用者手動分類優先，未指定（既有資料）fallback autoStage。
  const stage: SignalStage = item.userStage ?? autoStage;

  // ---- 走勢圖 ----
  const midByDate = new Map<number, number | null>();
  for (const ind of indicatorWindow) midByDate.set(ind.date.getTime(), ind.bollingerMid);
  const spark = buildSparkSeries(quoteWindow.slice(0, SPARK_WINDOW), midByDate);

  // ---- volumeRatio（醞釀中「量增」欄 + breakout 底排都用）----
  // 一定要現算：需要「當前 volume」（DB 當日量 or 盤中估全日量）÷ T-1 volumeMa20。
  const volumeMa20 = indicatorWindow[0]?.volumeMa20 ?? null;
  const volumeRatio =
    volumeMa20 != null && volumeMa20 > 0 ? effectiveVolume / volumeMa20 : null;

  // ---- breakout 階段：inst + factors ----
  let inst: WatchlistCardRow["inst"] = null;
  let factors: WatchlistCardRow["factors"] = null;
  let preInst: WatchlistCardRow["preInst"] = null;

  if (stage === "setup") {
    // 20 格日曆：投信 20 日淨買超序列（新到舊），前端 reverse 成舊→新
    const trustSeriesNewToOld = instWindow.map((r) =>
      Number(r.investmentTrustNetBuy ?? 0),
    );
    const dataDays = trustSeriesNewToOld.length;
    const buyDayFlags = trustSeriesNewToOld.map((v) => v > 0);
    const buyDays = buyDayFlags.filter(Boolean).length;
    let consecutiveBuyDays = 0;
    for (const flag of buyDayFlags) {
      // buyDayFlags 是新→舊，從最新往回數連續買超
      if (flag) consecutiveBuyDays += 1;
      else break;
    }

    // 分數 / detail：優先讀最近 eod 掃描結果（rankScore 是全市場百分位，watchlist 算不出）
    const fromScan = scan?.preInstByCode.get(code) ?? null;

    // trustNetRatio：掃描結果有就用；沒有則 action 用 20 日序列 ÷ sharesOutstanding 現算
    let trustNetRatio: number | null = fromScan?.trustNetRatio ?? null;
    if (trustNetRatio === null && dataDays >= PRE_INST_MIN_DAYS) {
      const shares = item.stock.sharesOutstanding;
      if (shares != null && Number(shares) > 0) {
        const netSum = trustSeriesNewToOld.reduce((s, v) => s + v, 0);
        trustNetRatio = netSum / Number(shares);
      }
    }

    preInst = {
      buyDayFlags: buyDayFlags.reverse(), // 舊 → 新
      buyDays,
      consecutiveBuyDays,
      dataDays,
      trustScore: fromScan?.trustScore ?? null,
      otherInstScore: fromScan?.otherInstScore ?? null,
      trustNetRatio,
      otherInstRatio: fromScan?.otherInstRatio ?? null,
      degraded: dataDays < PRE_INST_MIN_DAYS,
    };
  } else {
    const bollingerUpper = indicatorWindow[0]?.bollingerUpper ?? null;

    // 法人 diverging bar
    const trustSeries = instWindow.map((r) => Number(r.investmentTrustNetBuy ?? 0));
    const foreignSeries = instWindow.map((r) => Number(r.foreignNetBuy ?? 0));
    // 今日單日方向：只有當日籌碼（籌碼日期 == refDate）才算「今日」；否則 null（元件底部提示「近日資料」）
    const instToday =
      institutional && isoDate(institutional.date) === refDate ? institutional : null;
    const flow = computeInstitutionalFlow({
      trustNetBuyNewestFirst: trustSeries,
      foreignNetBuyNewestFirst: foreignSeries,
      todayTrustNetBuy:
        instToday && instToday.investmentTrustNetBuy !== null
          ? Number(instToday.investmentTrustNetBuy)
          : null,
      todayForeignNetBuy:
        instToday && instToday.foreignNetBuy !== null ? Number(instToday.foreignNetBuy) : null,
      volumeMa20,
      marginSurgePercentile: null, // watchlist 不做 margin-chasing 警示
      config: DEFAULT_INSTITUTIONAL_FLOW_CONFIG,
    });
    inst = {
      trustRatio: flow.trustRatio,
      foreignRatio: flow.foreignRatio,
      todayTrustDir: flow.todayTrustDir,
      todayForeignDir: flow.todayForeignDir,
    };

    // 突破因子原始值
    const closeHistory = quoteWindow.slice(1).map((q) => q.close); // 不含當前
    const prox = computeProximityToHigh(
      close,
      closeHistory,
      score.proximityShortWindow,
      score.proximityLongWindow,
    );
    const breakoutMarginPct =
      bollingerUpper != null && bollingerUpper > 0
        ? ((close - bollingerUpper) / bollingerUpper) * 100
        : 0;

    const pr = scan?.prByCode.get(code);
    factors = {
      proximityLongPct: prox.longPct,
      breakoutMarginPct,
      relativeStrength: typeof pr === "number" ? pr : null,
      relativeStrengthStale: scan != null && scan.scanDate !== refDate,
    };
  }

  return {
    stockCode: code,
    name: item.stock.name,
    addedAt: isoDate(item.addedAt),
    stage,
    userStage: item.userStage ?? autoStage,
    autoStage,
    mode: ctx.mode,
    dataFresh,
    priceSource,
    latestEodDate: ctx.latestEodDate,
    refDate,
    close,
    changePercent,
    volumeRatio,
    spark,
    inst,
    factors,
    preInst,
  };
}

// ============================================================================
// mutation（不變）
// ============================================================================

// 加入 watchlist 時算即時 autoStage（PLAN 6 §3.2）。只用 DB 資料（eod 視角）——加入動作
// 在盤中也不該打 MIS 卡住。缺指標的檔不放進 Map，呼叫端 fallback "setup"。
async function computeAutoStages(
  codes: string[],
): Promise<Map<string, SignalStage>> {
  const out = new Map<string, SignalStage>();
  await Promise.all(
    codes.map(async (code) => {
      const [quote, indicators] = await Promise.all([
        prisma.dailyQuote.findFirst({
          where: { stockCode: code },
          orderBy: { date: "desc" },
          select: { date: true, close: true },
        }),
        // 布林上軌歷史（新到舊）——consecutiveAboveBand 從 [0] 往回逐日比
        prisma.technicalIndicator.findMany({
          where: { stockCode: code },
          orderBy: { date: "desc" },
          take: BASE_MAX_WINDOW + 1,
          select: { date: true, bollingerUpper: true },
        }),
      ]);
      if (!quote || indicators.length === 0) return;

      const closeByDate = new Map<number, number>();
      closeByDate.set(quote.date.getTime(), quote.close);
      const series = indicators.map((ind, i) => ({
        close:
          i === 0 ? quote.close : (closeByDate.get(ind.date.getTime()) ?? NaN),
        bollingerUpper: ind.bollingerUpper,
      }));
      const aboveBand = consecutiveAboveBand(series);
      out.set(
        code,
        aboveBand.consecutiveDays <= 0
          ? "setup"
          : aboveBand.consecutiveDays <= 2
            ? "breakoutDay"
            : "extended",
      );
    }),
  );
  return out;
}

export async function addToWatchlist(input: {
  codes: string[];
}): Promise<{ added: number; skipped: number }> {
  const requested = [...new Set(input.codes)];
  if (requested.length === 0) return { added: 0, skipped: 0 };

  const existing = await prisma.stock.findMany({
    where: { code: { in: requested } },
    select: { code: true },
  });
  const validCodes = existing.map((s) => s.code);
  if (validCodes.length === 0)
    return { added: 0, skipped: requested.length };

  // 加入當下算即時 autoStage 寫進 userStage（算不出 → "setup"）。
  const autoStageByCode = await computeAutoStages(validCodes);

  const result = await prisma.watchlistItem.createMany({
    data: validCodes.map((code) => ({
      stockCode: code,
      userStage: autoStageByCode.get(code) ?? "setup",
    })),
    skipDuplicates: true,
  });

  revalidatePath("/watchlist");
  return { added: result.count, skipped: requested.length - result.count };
}

export async function removeFromWatchlist(input: { code: string }): Promise<void> {
  await prisma.watchlistItem.delete({ where: { stockCode: input.code } });
  revalidatePath("/watchlist");
}

// 買入狀態欄位 UI 已移除，此 action 保留（schema 欄位仍在，未來可能再用）。
export async function updateWatchlistItem(input: {
  code: string;
  userStage?: SignalStage; // 手動分類（PLAN 6）——SignalStage 字串值 == Prisma enum 成員名，直接傳不需 map
  isPurchased?: boolean;
  buyPrice?: number | null;
  buyDate?: string | null;
  targetPrice?: number | null;
  stopLossPrice?: number | null;
  notes?: string | null;
}): Promise<void> {
  const data: Record<string, unknown> = {};
  if (input.userStage !== undefined) data["userStage"] = input.userStage;
  if (input.isPurchased !== undefined) data["isPurchased"] = input.isPurchased;
  if (input.buyPrice !== undefined) data["buyPrice"] = input.buyPrice;
  if (input.buyDate !== undefined)
    data["buyDate"] = input.buyDate === null ? null : new Date(input.buyDate);
  if (input.targetPrice !== undefined) data["targetPrice"] = input.targetPrice;
  if (input.stopLossPrice !== undefined) data["stopLossPrice"] = input.stopLossPrice;
  if (input.notes !== undefined) data["notes"] = input.notes;

  if (Object.keys(data).length === 0) return;

  await prisma.watchlistItem.update({ where: { stockCode: input.code }, data });
  revalidatePath("/watchlist");
}
