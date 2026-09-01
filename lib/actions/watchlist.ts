"use server";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../prisma";
import { revalidatePath } from "next/cache";
import { Market } from "../../generated/prisma/client";
import {
  computeCandleShape,
  computeVolumeStrength,
  computeBase,
  computeProximityToHigh,
  computeInstitutionalFlow,
  consecutiveAboveBand,
  resolveBreakoutConfig,
  resolveAccumulationConfig,
  DEFAULT_INSTITUTIONAL_FLOW_CONFIG,
} from "../../scripts/lib/signal-factors/index";

// 與 run-signal-scan.ts 的 SignalStage 同義；此處不 import 該模組（避免把整個掃描管線拉進 bundle）。
export type SignalStage = "pre-breakout" | "breakout-day" | "extended";
import {
  fetchAllMisQuotes,
  computeElapsedRatio,
  type MisQuote,
} from "../../scripts/lib/mis-quotes";
import { SPARK_WINDOW, type SparkPoint } from "../dashboard-spark";
import { buildSparkSeries } from "../spark-series";

// ROADMAP 4.5.x：watchlist 頁改成卡片 gallery（PLAN docs/PLAN.md）。
// listWatchlist() 回傳從「三表鬆散快照 + 買入狀態」改成「卡片結構化資料」：
//   - stage：consecutiveAboveBand() 即時判定（不是 WatchlistItem.source 靜態欄位）
//   - 資料源 A 方案：DB 最新交易日 == 台北今日 → 用 DB（⚡）；否則自動打 MIS 盤中報價（🕐），阻塞 render
//   - 強度 PR：讀 data/signal-scan-results 最新 eod 結果的 relativeStrength（PLAN §3.1）
// 買入狀態欄位（isPurchased / buyPrice / ...）schema 保留，UI 不再顯示，updateWatchlistItem 仍留著。

const { score } = resolveBreakoutConfig();
const BASE_MAX_WINDOW = score.baseMaxWindowDays; // 240
const BASE_MIN_HISTORY = score.baseMinHistoryDays; // 40
const RS_RESULT_DIR = join(process.cwd(), "data", "signal-scan-results");

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
  source: string | null;

  stage: SignalStage; // consecutiveAboveBand() 即時判定
  dataFresh: boolean; // DB 最新交易日 == 台北今日 → ⚡ / else 🕐
  priceSource: "eod" | "realtime" | "estimated";
  refDate: string; // 卡片實際採用的資料日期（DB 用 quote.date；MIS 用其回傳日期或今日）

  close: number;
  changePercent: number;
  volumeRatio: number | null; // 今日（或盤中估全日）volume / volumeMa20
  spark: SparkPoint[]; // 近 60 日相對布林中軌偏離（舊 → 新）

  // 面向分數（0~100，缺資料為 null）——pre-breakout 底排用；breakout 卡片也算著（無害）
  candleScore: number | null;
  volumeScore: number | null;
  baseScore: number | null;
  degraded: string[];

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

function taipeiTodayIso(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

// ============================================================================
// 最近 eod 掃描結果讀檔（不現算全市場）——供「強度 PR」欄 + 醞釀階段法人分數共用
// ============================================================================

interface ScanResultRow {
  code: string;
  stage?: string;
  scores?: {
    relativeStrength?: number;
    trustScore?: number;
    otherInstScore?: number;
  };
  detail?: {
    trustNetRatio?: number | null;
    otherInstRatio?: number | null;
  };
}

// 醞釀階段每檔從掃描結果拿的欄位（不在名單 → 該 code 無此 entry）
interface ScanPreInst {
  trustScore: number | null;
  otherInstScore: number | null;
  trustNetRatio: number | null;
  otherInstRatio: number | null;
}

interface LatestScan {
  scanDate: string;
  prByCode: Map<string, number>; // stage 不限：relativeStrength（強度 PR 欄）
  preInstByCode: Map<string, ScanPreInst>; // 只 pre-breakout：trustScore / otherInstScore / detail
}

function readLatestScan(): LatestScan | null {
  if (!existsSync(RS_RESULT_DIR)) return null;
  // 只讀 {YYYY-MM-DD}.json（eod 定案結果）；跳過 {timestamp}.json（realtime）與 progress.json
  const files = readdirSync(RS_RESULT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;

  try {
    const parsed = JSON.parse(readFileSync(join(RS_RESULT_DIR, latest), "utf8")) as {
      date?: string;
      results?: ScanResultRow[];
    };
    const scanDate = parsed.date ?? latest.replace(".json", "");
    const prByCode = new Map<string, number>();
    const preInstByCode = new Map<string, ScanPreInst>();
    for (const r of parsed.results ?? []) {
      const rs = r.scores?.relativeStrength;
      if (typeof rs === "number") prByCode.set(r.code, rs);
      if (r.stage === "pre-breakout") {
        preInstByCode.set(r.code, {
          trustScore:
            typeof r.scores?.trustScore === "number" ? r.scores.trustScore : null,
          otherInstScore:
            typeof r.scores?.otherInstScore === "number" ? r.scores.otherInstScore : null,
          trustNetRatio:
            typeof r.detail?.trustNetRatio === "number" ? r.detail.trustNetRatio : null,
          otherInstRatio:
            typeof r.detail?.otherInstRatio === "number" ? r.detail.otherInstRatio : null,
        });
      }
    }
    return { scanDate, prByCode, preInstByCode };
  } catch {
    return null;
  }
}

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

  // 資料源判斷：DB 最新一般股票交易日 == 台北今日？
  const latestQuote = await prisma.dailyQuote.findFirst({
    where: { stock: { securityType: "stock" } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const todayIso = taipeiTodayIso();
  const dataFresh = latestQuote ? isoDate(latestQuote.date) === todayIso : false;

  // 非當日 → 打 MIS 盤中報價（一次抓全部觀察股；< 50 檔 = 1 批）
  let misQuotes: Map<string, MisQuote> | null = null;
  let elapsedRatio = 1;
  if (!dataFresh) {
    const stocks = items.map((it) => ({
      code: it.stockCode,
      market: it.stock.market === Market.TPEx ? Market.TPEx : Market.TWSE,
    }));
    try {
      const res = await fetchAllMisQuotes(stocks);
      misQuotes = res.quotes;
      elapsedRatio = computeElapsedRatio(new Date()).clipped;
    } catch {
      misQuotes = null; // 抓取整體失敗 → 全部退回 DB 昨收
    }
  }

  const scan = readLatestScan();

  const rows = await Promise.all(
    items.map((item) => buildCardRow(item, dataFresh, misQuotes, elapsedRatio, scan)),
  );
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
  dataFresh: boolean,
  misQuotes: Map<string, MisQuote> | null,
  elapsedRatio: number,
  scan: LatestScan | null,
): Promise<WatchlistCardRow | null> {
  const code = item.stockCode;

  const dbQuote = await prisma.dailyQuote.findFirst({
    where: { stockCode: code },
    orderBy: { date: "desc" },
    select: { date: true, open: true, high: true, low: true, close: true, volume: true, change: true },
  });
  if (!dbQuote) return null;

  const [indicatorWindow, quoteWindow, institutional, instWindow] = await Promise.all([
    // 布林指標歷史（新到舊）：index 0 = 最新。bollingerUpper → 階段判定 / 突破幅度；
    // bollingerBandwidth → computeBase；bollingerMid → 走勢圖正規化
    prisma.technicalIndicator.findMany({
      where: { stockCode: code },
      orderBy: { date: "desc" },
      take: BASE_MAX_WINDOW + 1,
      select: { date: true, bollingerUpper: true, bollingerBandwidth: true, bollingerMid: true, volumeMa20: true },
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

  const degraded: string[] = [];

  // ---- 決定 close / volume / changePercent / priceSource / refDate ----
  const mis = misQuotes?.get(code);
  let close: number;
  let effectiveVolume: number; // 今日成交量（DB）或盤中估全日量（MIS）
  let changePercent: number;
  let priceSource: WatchlistCardRow["priceSource"];
  let refDate: string;

  if (dataFresh) {
    close = dbQuote.close;
    effectiveVolume = Number(dbQuote.volume);
    const prevClose = dbQuote.close - dbQuote.change;
    changePercent = prevClose > 0 ? (dbQuote.change / prevClose) * 100 : 0;
    priceSource = "eod";
    refDate = isoDate(dbQuote.date);
  } else if (mis && (mis.price !== null || mis.high !== null)) {
    if (mis.price !== null) {
      close = mis.price;
      priceSource = "realtime";
    } else {
      close = mis.high!;
      priceSource = "estimated";
    }
    effectiveVolume = elapsedRatio > 0 ? mis.cumulativeVolume / elapsedRatio : mis.cumulativeVolume;
    changePercent =
      mis.prevClose !== null && mis.prevClose > 0
        ? ((close - mis.prevClose) / mis.prevClose) * 100
        : 0;
    refDate = mis.date ?? taipeiTodayIso();
  } else {
    // 非當日、且 MIS 沒抓到（或 z/h 皆缺）→ 退回 DB 昨收
    close = dbQuote.close;
    effectiveVolume = Number(dbQuote.volume);
    const prevClose = dbQuote.close - dbQuote.change;
    changePercent = prevClose > 0 ? (dbQuote.change / prevClose) * 100 : 0;
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
  const stage: SignalStage =
    aboveBand.consecutiveDays <= 0
      ? "pre-breakout"
      : aboveBand.consecutiveDays <= 2
        ? "breakout-day"
        : "extended";

  // ---- 走勢圖 ----
  const midByDate = new Map<number, number | null>();
  for (const ind of indicatorWindow) midByDate.set(ind.date.getTime(), ind.bollingerMid);
  const spark = buildSparkSeries(quoteWindow.slice(0, SPARK_WINDOW), midByDate);

  // ---- volumeRatio ----
  const volumeMa20 = indicatorWindow[0]?.volumeMa20 ?? null;
  const volumeRatio =
    volumeMa20 != null && volumeMa20 > 0 ? effectiveVolume / volumeMa20 : null;

  // ---- K 棒 / 力道 / 位階 ----
  const candleInput = dataFresh
    ? { open: dbQuote.open, high: dbQuote.high, low: dbQuote.low, close }
    : mis
      ? { open: mis.open, high: mis.high, low: mis.low, close }
      : { open: dbQuote.open, high: dbQuote.high, low: dbQuote.low, close };
  const candleResult = computeCandleShape(candleInput);
  if (candleResult.degraded) degraded.push("candleShape");
  const candleScore = candleResult.degraded ? null : candleResult.score;

  let volumeScore: number | null = null;
  if (volumeRatio != null) {
    volumeScore = computeVolumeStrength(volumeRatio, score.curves.volumeStrength);
  } else {
    degraded.push("volume");
  }

  const latestBandwidth = indicatorWindow[0]?.bollingerBandwidth ?? null;
  const bandwidthHistory = indicatorWindow.slice(1).map((i) => i.bollingerBandwidth);
  const baseResult = computeBase(
    latestBandwidth,
    bandwidthHistory,
    BASE_MIN_HISTORY,
    score.curves.base,
  );
  if (baseResult.degraded) degraded.push("base");
  const baseScore = baseResult.degraded ? null : baseResult.score;

  // ---- breakout 階段：inst + factors ----
  let inst: WatchlistCardRow["inst"] = null;
  let factors: WatchlistCardRow["factors"] = null;
  let preInst: WatchlistCardRow["preInst"] = null;

  if (stage === "pre-breakout") {
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
    source: item.source,
    stage,
    dataFresh,
    priceSource,
    refDate,
    close,
    changePercent,
    volumeRatio,
    spark,
    candleScore,
    volumeScore,
    baseScore,
    degraded,
    inst,
    factors,
    preInst,
  };
}

// ============================================================================
// mutation（不變）
// ============================================================================

export async function addToWatchlist(input: {
  codes: string[];
  source?: string; // "breakout" | "accumulation" | "manual"
}): Promise<{ added: number; skipped: number }> {
  const requested = [...new Set(input.codes)];
  if (requested.length === 0) return { added: 0, skipped: 0 };

  const existing = await prisma.stock.findMany({
    where: { code: { in: requested } },
    select: { code: true },
  });
  const validCodes = existing.map((s) => s.code);

  const result = await prisma.watchlistItem.createMany({
    data: validCodes.map((code) => ({
      stockCode: code,
      ...(input.source ? { source: input.source } : {}),
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
  isPurchased?: boolean;
  buyPrice?: number | null;
  buyDate?: string | null;
  targetPrice?: number | null;
  stopLossPrice?: number | null;
  notes?: string | null;
}): Promise<void> {
  const data: Record<string, unknown> = {};
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
