import { PrismaClient } from "../../../generated/prisma/client";
import type { DeepPartial } from "../types";
import { clip } from "./util";

// ---- 資格門檻（可調整）----
export const GATES = {
  minMarketCap: 3_000_000_000, // 30 億台幣（原 50 億）
  minVolumeShares: 1_000_000, // 1000 張
};

// ---- 強度評分權重（總和為 1，不需再正規化）----
export const WEIGHTS = {
  candleShape: 0.15,
  volumeStrength: 0.17,
  breakoutMargin: 0.1275,
  firstBar: 0.17,
  base: 0.17,
  proximityToHigh: 0.1275,
  relativeStrength: 0.085,
};

export const TRIGGER_VOLUME_RATIO = 2.0;
export const BASE_MIN_HISTORY_DAYS = 40;
export const BASE_MAX_WINDOW_DAYS = 240;
export const PROXIMITY_SHORT_WINDOW = 60;
export const PROXIMITY_LONG_WINDOW = 240;
export const RS_WINDOW_DAYS = 60;
export const FIRST_BAR_LOOKBACK_DAYS = 30;
export const NA_SCORE = 50; // rankScore 缺值補分

// ---- 曲線轉折點（§4 決定抽出的校準對象；其餘見各函式上方 TODO 註解）----
export const VOLUME_STRENGTH_CURVE = {
  lowRatio: 2, // 量比 2 倍
  lowScore: 40, // → 40 分
  highRatio: 6, // 量比 6 倍（以上）
  highScore: 100, // → 100 分
};
export const BREAKOUT_MARGIN_CURVE = {
  kneePct: 3, // 乖離 3% 為轉折點
  penaltyPerPct: 5, // 轉折後每多 1% 扣 5 分
  floor: 60, // 下限 60 分
};
export const BASE_CURVE = {
  depthWeight: 0.6, // depthScore 權重
  durationWeight: 0.4, // durationScore 權重
  durationCapDays: 40, // durationDays / 40 封頂
};

// ---- config 型別（門檻類走 gate，加權/曲線/視窗類走 score）----

/** 門檻類：決定誰進候選池。 */
export interface BreakoutGateConfig {
  minMarketCap: number; // 3_000_000_000
  minVolumeShares: number; // 1_000_000
  triggerVolumeRatio: number; // 2.0
}

/** 加權 / 曲線 / 視窗類：決定分數怎麼組。調這些不動候選池成員。 */
export interface BreakoutScoreConfig {
  weights: {
    candleShape: number;
    volumeStrength: number;
    breakoutMargin: number;
    firstBar: number;
    base: number;
    proximityToHigh: number;
    relativeStrength: number;
  };
  baseMinHistoryDays: number; // 40（degraded 門檻，見 §3：不剔除股票只降級分項 → 歸 score）
  baseMaxWindowDays: number; // 240
  proximityShortWindow: number; // 60
  proximityLongWindow: number; // 240
  rsWindowDays: number; // 60
  firstBarLookbackDays: number; // 30
  naScore: number; // 50（rankScore 缺值補分）
  curves: {
    volumeStrength: { lowRatio: number; lowScore: number; highRatio: number; highScore: number };
    breakoutMargin: { kneePct: number; penaltyPerPct: number; floor: number };
    base: { depthWeight: number; durationWeight: number; durationCapDays: number };
  };
}

export interface BreakoutConfig {
  gate: BreakoutGateConfig;
  score: BreakoutScoreConfig;
}

/** 現行預設。從既有 export const 組出來，數值不變。 */
export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = {
  gate: {
    minMarketCap: GATES.minMarketCap,
    minVolumeShares: GATES.minVolumeShares,
    triggerVolumeRatio: TRIGGER_VOLUME_RATIO,
  },
  score: {
    weights: { ...WEIGHTS },
    baseMinHistoryDays: BASE_MIN_HISTORY_DAYS,
    baseMaxWindowDays: BASE_MAX_WINDOW_DAYS,
    proximityShortWindow: PROXIMITY_SHORT_WINDOW,
    proximityLongWindow: PROXIMITY_LONG_WINDOW,
    rsWindowDays: RS_WINDOW_DAYS,
    firstBarLookbackDays: FIRST_BAR_LOOKBACK_DAYS,
    naScore: NA_SCORE,
    curves: {
      volumeStrength: { ...VOLUME_STRENGTH_CURVE },
      breakoutMargin: { ...BREAKOUT_MARGIN_CURVE },
      base: { ...BASE_CURVE },
    },
  },
};

/** 深層合併：呼叫端只給想改的欄位。config 結構固定且淺 → 手寫展開，不用泛型遞迴 merge。 */
export function resolveBreakoutConfig(override?: DeepPartial<BreakoutConfig>): BreakoutConfig {
  const d = DEFAULT_BREAKOUT_CONFIG;
  const g = override?.gate;
  const s = override?.score;
  return {
    gate: {
      minMarketCap: g?.minMarketCap ?? d.gate.minMarketCap,
      minVolumeShares: g?.minVolumeShares ?? d.gate.minVolumeShares,
      triggerVolumeRatio: g?.triggerVolumeRatio ?? d.gate.triggerVolumeRatio,
    },
    score: {
      weights: {
        candleShape: s?.weights?.candleShape ?? d.score.weights.candleShape,
        volumeStrength: s?.weights?.volumeStrength ?? d.score.weights.volumeStrength,
        breakoutMargin: s?.weights?.breakoutMargin ?? d.score.weights.breakoutMargin,
        firstBar: s?.weights?.firstBar ?? d.score.weights.firstBar,
        base: s?.weights?.base ?? d.score.weights.base,
        proximityToHigh: s?.weights?.proximityToHigh ?? d.score.weights.proximityToHigh,
        relativeStrength: s?.weights?.relativeStrength ?? d.score.weights.relativeStrength,
      },
      baseMinHistoryDays: s?.baseMinHistoryDays ?? d.score.baseMinHistoryDays,
      baseMaxWindowDays: s?.baseMaxWindowDays ?? d.score.baseMaxWindowDays,
      proximityShortWindow: s?.proximityShortWindow ?? d.score.proximityShortWindow,
      proximityLongWindow: s?.proximityLongWindow ?? d.score.proximityLongWindow,
      rsWindowDays: s?.rsWindowDays ?? d.score.rsWindowDays,
      firstBarLookbackDays: s?.firstBarLookbackDays ?? d.score.firstBarLookbackDays,
      naScore: s?.naScore ?? d.score.naScore,
      curves: {
        volumeStrength: {
          lowRatio: s?.curves?.volumeStrength?.lowRatio ?? d.score.curves.volumeStrength.lowRatio,
          lowScore: s?.curves?.volumeStrength?.lowScore ?? d.score.curves.volumeStrength.lowScore,
          highRatio: s?.curves?.volumeStrength?.highRatio ?? d.score.curves.volumeStrength.highRatio,
          highScore: s?.curves?.volumeStrength?.highScore ?? d.score.curves.volumeStrength.highScore,
        },
        breakoutMargin: {
          kneePct: s?.curves?.breakoutMargin?.kneePct ?? d.score.curves.breakoutMargin.kneePct,
          penaltyPerPct:
            s?.curves?.breakoutMargin?.penaltyPerPct ?? d.score.curves.breakoutMargin.penaltyPerPct,
          floor: s?.curves?.breakoutMargin?.floor ?? d.score.curves.breakoutMargin.floor,
        },
        base: {
          depthWeight: s?.curves?.base?.depthWeight ?? d.score.curves.base.depthWeight,
          durationWeight: s?.curves?.base?.durationWeight ?? d.score.curves.base.durationWeight,
          durationCapDays: s?.curves?.base?.durationCapDays ?? d.score.curves.base.durationCapDays,
        },
      },
    },
  };
}

export interface HistoryPoint {
  date: Date;
  close: number | null;
  bollingerBandwidth: number | null;
}

// ---- 撈 DB + 組視窗序列（正式跑與回測 Layer 0 撈的資料逐位元一致）----

export interface BreakoutQuoteRow {
  stockCode: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  volume: number;
  sharesOutstanding: number | null;
}

export interface BreakoutIndicatorRow {
  bollingerUpper: number | null;
  bollingerBandwidth: number | null;
  volumeMa20: number | null;
}

// 當天全市場 securityType="stock" 的 DailyQuote + Stock.name / sharesOutstanding
export async function fetchTodayQuotes(prisma: PrismaClient, date: Date): Promise<BreakoutQuoteRow[]> {
  const quotes = await prisma.dailyQuote.findMany({
    where: { date, stock: { securityType: "stock" } },
    select: {
      stockCode: true,
      open: true,
      high: true,
      low: true,
      close: true,
      change: true,
      volume: true,
      stock: { select: { name: true, sharesOutstanding: true } },
    },
  });

  return quotes.map((q) => ({
    stockCode: q.stockCode,
    name: q.stock.name,
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    change: q.change,
    volume: Number(q.volume),
    sharesOutstanding: q.stock.sharesOutstanding !== null ? Number(q.stock.sharesOutstanding) : null,
  }));
}

// 指定日期、指定股票的 TechnicalIndicator（bollingerUpper / bollingerBandwidth / volumeMa20）
export async function fetchIndicatorsForDate(
  prisma: PrismaClient,
  date: Date,
  codes: string[],
): Promise<Map<string, BreakoutIndicatorRow>> {
  const rows = await prisma.technicalIndicator.findMany({
    where: { date, stockCode: { in: codes } },
    select: { stockCode: true, bollingerUpper: true, bollingerBandwidth: true, volumeMa20: true },
  });
  return new Map(rows.map((r) => [r.stockCode, r]));
}

/** fetchBreakoutRawInputs 的視窗長度。正式跑傳 DEFAULT_BREAKOUT_CONFIG.score 對應值；Layer 0 傳加緩衝的值。 */
export interface BreakoutFetchWindows {
  firstBarLookbackDays: number;
  baseMaxWindowDays: number;
  rsWindowDays: number;
}

/** 一支股票的 breakout 原始輸入（撈 DB + 組序列的結果，尚未套門檻、未評分）。 */
export interface BreakoutRawInputs {
  quote: BreakoutQuoteRow;
  indicator: BreakoutIndicatorRow | null;
  prevTradingDate: Date | null;
  // T-1 起往回 firstBarLookbackDays 筆（新到舊），close + bollingerUpper 對齊
  firstBarSeries: { close: number; bollingerUpper: number | null }[];
  // base + proximityToHigh 共用：T-1 起往回 baseMaxWindowDays 筆（新到舊）
  history: HistoryPoint[];
  // relativeStrength：這一檔近 rsWindowDays+1 筆 close（含當天，新到舊）
  rsCloseSeries: { date: Date; close: number }[];
}

// 撈「當天全市場」的 breakout 原始輸入。codes 省略時 = 當天全市場一般股票（Layer 0 用）；
// 傳 codes 時只撈那幾支（正式跑篩完門檻後用）。回傳 Map 以 stockCode 為鍵。
export async function fetchBreakoutRawInputs(
  prisma: PrismaClient,
  date: Date,
  windows: BreakoutFetchWindows,
  codes?: string[],
): Promise<Map<string, BreakoutRawInputs>> {
  const quotes = await fetchTodayQuotes(prisma, date);
  const filteredQuotes = codes ? quotes.filter((q) => codes.includes(q.stockCode)) : quotes;
  const targetCodes = filteredQuotes.map((q) => q.stockCode);

  const result = new Map<string, BreakoutRawInputs>();
  if (targetCodes.length === 0) return result;

  const todayIndicators = await fetchIndicatorsForDate(prisma, date, targetCodes);

  // T-1 交易日：比 date 早的最近一個交易日（用目標股票集合去查，行為對齊原腳本）
  const prevDayRow = await prisma.dailyQuote.findFirst({
    where: { date: { lt: date }, stockCode: { in: targetCodes } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const prevDate = prevDayRow?.date ?? null;

  // firstBar：T-1 起往回 firstBarLookbackDays 筆 close + bollingerUpper
  const [firstBarQuotes, firstBarIndicators] = prevDate
    ? await Promise.all([
        prisma.dailyQuote.findMany({
          where: { stockCode: { in: targetCodes }, date: { lte: prevDate } },
          orderBy: { date: "desc" },
          take: windows.firstBarLookbackDays * targetCodes.length,
          select: { stockCode: true, date: true, close: true },
        }),
        prisma.technicalIndicator.findMany({
          where: { stockCode: { in: targetCodes }, date: { lte: prevDate } },
          orderBy: { date: "desc" },
          take: windows.firstBarLookbackDays * targetCodes.length,
          select: { stockCode: true, date: true, bollingerUpper: true },
        }),
      ])
    : [[], []];

  const firstBarSeriesByStock = new Map<string, { close: number; bollingerUpper: number | null }[]>();
  {
    const closeByStockDate = new Map<string, Map<number, number>>();
    for (const row of firstBarQuotes) {
      let m = closeByStockDate.get(row.stockCode);
      if (!m) {
        m = new Map();
        closeByStockDate.set(row.stockCode, m);
      }
      m.set(row.date.getTime(), row.close);
    }
    const bollUpperByStockDate = new Map<string, Map<number, number | null>>();
    for (const row of firstBarIndicators) {
      let m = bollUpperByStockDate.get(row.stockCode);
      if (!m) {
        m = new Map();
        bollUpperByStockDate.set(row.stockCode, m);
      }
      m.set(row.date.getTime(), row.bollingerUpper);
    }
    const datesByStock = new Map<string, Date[]>();
    for (const row of firstBarQuotes) {
      let list = datesByStock.get(row.stockCode);
      if (!list) {
        list = [];
        datesByStock.set(row.stockCode, list);
      }
      if (list.length < windows.firstBarLookbackDays) list.push(row.date);
    }
    for (const code of targetCodes) {
      const dates = datesByStock.get(code) ?? [];
      const closeMap = closeByStockDate.get(code);
      const upperMap = bollUpperByStockDate.get(code);
      firstBarSeriesByStock.set(
        code,
        dates.map((d) => ({
          close: closeMap?.get(d.getTime()) ?? Number.NaN,
          bollingerUpper: upperMap?.get(d.getTime()) ?? null,
        })),
      );
    }
  }

  // base + proximity：T-1 往回最多 baseMaxWindowDays 筆 { date, close, bollingerBandwidth }
  const historyByStock: Map<string, HistoryPoint[]> = prevDate
    ? await fetchHistoryWindow(prisma, prevDate, targetCodes, windows.baseMaxWindowDays)
    : new Map();

  // relativeStrength：目標股票集合近 rsWindowDays+1 筆 close（含今天，新到舊）
  const marketHistoryRows = await prisma.dailyQuote.findMany({
    where: { stockCode: { in: targetCodes }, date: { lte: date } },
    orderBy: { date: "desc" },
    select: { stockCode: true, date: true, close: true },
  });
  const rsCloseByStock = new Map<string, { date: Date; close: number }[]>();
  for (const row of marketHistoryRows) {
    let list = rsCloseByStock.get(row.stockCode);
    if (!list) {
      list = [];
      rsCloseByStock.set(row.stockCode, list);
    }
    if (list.length < windows.rsWindowDays + 1) list.push({ date: row.date, close: row.close });
  }

  for (const q of filteredQuotes) {
    result.set(q.stockCode, {
      quote: q,
      indicator: todayIndicators.get(q.stockCode) ?? null,
      prevTradingDate: prevDate,
      firstBarSeries: firstBarSeriesByStock.get(q.stockCode) ?? [],
      history: historyByStock.get(q.stockCode) ?? [],
      rsCloseSeries: rsCloseByStock.get(q.stockCode) ?? [],
    });
  }

  return result;
}

// 抓每支股票近 N 個交易日（含 asOfDate）的 close + bollingerBandwidth，依日期新到舊排序
export async function fetchHistoryWindow(
  prisma: PrismaClient,
  asOfDate: Date,
  codes: string[],
  maxDays: number,
): Promise<Map<string, HistoryPoint[]>> {
  const [quoteHistory, indicatorHistory] = await Promise.all([
    prisma.dailyQuote.findMany({
      where: { stockCode: { in: codes }, date: { lte: asOfDate } },
      orderBy: { date: "desc" },
      select: { stockCode: true, date: true, close: true },
    }),
    prisma.technicalIndicator.findMany({
      where: { stockCode: { in: codes }, date: { lte: asOfDate } },
      orderBy: { date: "desc" },
      select: { stockCode: true, date: true, bollingerBandwidth: true },
    }),
  ]);

  const closeByStockDate = new Map<string, Map<number, number>>();
  const datesByStock = new Map<string, Date[]>();
  for (const row of quoteHistory) {
    let dateMap = closeByStockDate.get(row.stockCode);
    if (!dateMap) {
      dateMap = new Map();
      closeByStockDate.set(row.stockCode, dateMap);
    }
    dateMap.set(row.date.getTime(), row.close);

    let dateList = datesByStock.get(row.stockCode);
    if (!dateList) {
      dateList = [];
      datesByStock.set(row.stockCode, dateList);
    }
    if (dateList.length < maxDays) dateList.push(row.date);
  }

  const bandwidthByStockDate = new Map<string, Map<number, number | null>>();
  for (const row of indicatorHistory) {
    let dateMap = bandwidthByStockDate.get(row.stockCode);
    if (!dateMap) {
      dateMap = new Map();
      bandwidthByStockDate.set(row.stockCode, dateMap);
    }
    dateMap.set(row.date.getTime(), row.bollingerBandwidth);
  }

  const result = new Map<string, HistoryPoint[]>();
  for (const code of codes) {
    const dates = datesByStock.get(code) ?? [];
    const closeMap = closeByStockDate.get(code);
    const bandwidthMap = bandwidthByStockDate.get(code);
    result.set(
      code,
      dates.map((d) => ({
        date: d,
        close: closeMap?.get(d.getTime()) ?? null,
        bollingerBandwidth: bandwidthMap?.get(d.getTime()) ?? null,
      })),
    );
  }
  return result;
}

// ---- 3a. volumeStrength ----
export function computeVolumeStrength(
  ratio: number,
  curve: BreakoutScoreConfig["curves"]["volumeStrength"],
): number {
  // lowRatio 倍 = lowScore 分，highRatio 倍以上 = highScore 分，線性 clip
  const score =
    curve.lowScore +
    ((ratio - curve.lowRatio) / (curve.highRatio - curve.lowRatio)) * (curve.highScore - curve.lowScore);
  return clip(score, curve.lowScore, curve.highScore);
}

// ---- 3b. breakoutMargin ----
export function computeBreakoutMargin(
  close: number,
  bollingerUpper: number,
  curve: BreakoutScoreConfig["curves"]["breakoutMargin"],
): number {
  const marginPct = ((close - bollingerUpper) / bollingerUpper) * 100;
  if (marginPct <= curve.kneePct) {
    return clip(40 + (marginPct / curve.kneePct) * 60, 40, 100);
  }
  // 超過 kneePct% 乖離後，每多 1% 扣 penaltyPerPct 分，下限 floor 分（避免跟乖離不足的股票混在同一分數帶）
  return clip(100 - (marginPct - curve.kneePct) * curve.penaltyPerPct, curve.floor, 100);
}

// ---- 3g. candleShape ----
export interface CandleInput {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

// TODO(backtest): 若要校準此曲線（上影線 40%、收黑封頂 50、0.5/0.5 合成），抽進 config.score.curves
export function computeCandleShape(candle: CandleInput): { score: number; degraded: boolean } {
  const { open, high, low, close } = candle;

  if (open === null || high === null || low === null) {
    return { score: 50, degraded: true };
  }

  const range = high - low;
  if (range <= 0) {
    // 一字線（例如鎖漲停無量交易），視為最強型態
    return { score: 100, degraded: false };
  }

  // 上影線分數：無上影線=100分，上影線佔全天振幅40%以上=40分（floor），中間線性
  const upperShadowRatio = (high - Math.max(open, close)) / range;
  const shadowScore = clip(100 - (upperShadowRatio / 0.4) * 60, 40, 100);

  // 收盤位置分數：收在最高點=100分，收在最低點=40分（floor）
  const closeLocation = (close - low) / range;
  const locScore = clip(40 + closeLocation * 60, 40, 100);

  let score = shadowScore * 0.5 + locScore * 0.5;

  // 收黑（綠K）額外懲罰：不論上影線多短，當日表態轉弱是獨立警訊，直接封頂
  if (close < open) {
    score = Math.min(score, 50);
  }

  return { score: clip(score, 0, 100), degraded: false };
}

// ---- 3c. firstBar ----
// series[0] 是 T-1（或盤中版的「今天即時價 vs T-1 上軌」由呼叫端組出對應序列），依日期新到舊排序
// TODO(backtest): 連續天數 ≤2→50 / >2→20 是離散規則不是曲線，且使用者明確要求保留此緩衝（PROGRESS 2026-08-27），不抽
export function computeFirstBar(
  seriesByStock: Map<string, { close: number; bollingerUpper: number | null }[]>,
  code: string,
): { score: number; degraded: boolean } {
  const series = seriesByStock.get(code) ?? [];
  if (series.length === 0) {
    return { score: 50, degraded: true };
  }

  // series[0] 是最新一筆（收盤版為 T-1，盤中版為即時價）；先確認它本身
  const latest = series[0]!;
  if (latest.bollingerUpper === null) {
    return { score: 50, degraded: true };
  }

  if (latest.close <= latest.bollingerUpper) {
    return { score: 100, degraded: false };
  }

  // 已在上軌之上，往回數連續收在上軌上方的天數（series[0] 算 1 天）
  let consecutiveDays = 0;
  for (const point of series) {
    if (point.bollingerUpper === null) break;
    if (point.close > point.bollingerUpper) {
      consecutiveDays += 1;
    } else {
      break;
    }
  }

  if (consecutiveDays <= 2) return { score: 50, degraded: false };
  return { score: 20, degraded: false };
}

// ---- 3d. base ----
export function computeBase(
  latestBandwidth: number | null,
  bandwidthHistory: (number | null)[], // 往前最多 240 筆（不含當前這筆），新到舊排序
  minHistoryDays: number,
  curve: BreakoutScoreConfig["curves"]["base"],
): { score: number; degraded: boolean; historyDays: number } {
  const validHistory = bandwidthHistory.filter((v): v is number => v !== null && !Number.isNaN(v));

  if (latestBandwidth === null || validHistory.length < minHistoryDays) {
    return { score: 50, degraded: true, historyDays: validHistory.length };
  }

  const sorted = [...validHistory].sort((a, b) => a - b);
  const rankIndex = sorted.findIndex((v) => v >= latestBandwidth);
  const p = ((rankIndex === -1 ? sorted.length - 1 : rankIndex) / (sorted.length - 1 || 1)) * 100;
  const depthScore = 100 - p;

  // p25 門檻（0.25）：「低帶寬持續天數」的定義本身，改了語意就變了 → 不抽（§4）
  const p25Index = Math.floor(sorted.length * 0.25);
  const p25Threshold = sorted[Math.min(p25Index, sorted.length - 1)]!;

  let durationDays = 0;
  for (const v of bandwidthHistory) {
    if (v !== null && v < p25Threshold) {
      durationDays += 1;
    } else {
      break;
    }
  }
  const durationScore = Math.min(durationDays / curve.durationCapDays, 1) * 100;

  const score = depthScore * curve.depthWeight + durationScore * curve.durationWeight;
  return { score, degraded: false, historyDays: validHistory.length };
}

// ---- 3e. proximityToHigh ----
// TODO(backtest): 若要校準此曲線（0.7 下界、short/long 0.5/0.5 合成），抽進 config.score.curves
export function computeProximityScale(referenceClose: number, closesInWindow: number[]): number {
  if (closesInWindow.length === 0) return 50;
  const highInWindow = Math.max(...closesInWindow, referenceClose);
  const r = referenceClose / highInWindow;
  if (r >= 1) return 100;
  return clip(((r - 0.7) / 0.3) * 100, 0, 100);
}

export function computeProximityToHigh(
  referenceClose: number,
  closeHistory: (number | null)[], // 往前最多 240 筆，新到舊排序，不含 referenceClose 本身
  shortWindowDays: number,
  longWindowDays: number,
): { score: number; degraded: boolean } {
  const validCloses = closeHistory.filter((v): v is number => v !== null && !Number.isNaN(v));

  if (validCloses.length < shortWindowDays) {
    return { score: 50, degraded: true };
  }

  const shortWindow = validCloses.slice(0, shortWindowDays);
  const longWindow = validCloses.slice(0, longWindowDays);
  const degraded = validCloses.length < longWindowDays;

  const shortScore = computeProximityScale(referenceClose, shortWindow);
  const longScore = computeProximityScale(referenceClose, longWindow);

  return { score: shortScore * 0.5 + longScore * 0.5, degraded };
}

// ---- 3f. relativeStrength：全市場先算好，候選股查百分位 ----
export function computeMarketWideReturns(
  codes: string[],
  historyByStock: Map<string, { date: Date; close: number }[]>,
  rsWindowDays: number,
): { returns: (number | null)[]; historyDays: Map<string, number> } {
  const returns: (number | null)[] = [];
  const historyDays = new Map<string, number>();

  for (const code of codes) {
    const history = historyByStock.get(code) ?? []; // 新到舊排序，含今天（或盤中即時價當第一筆）
    historyDays.set(code, history.length);

    if (history.length < 2) {
      returns.push(null);
      continue;
    }

    const latestClose = history[0]!.close;
    const windowLen = Math.min(history.length, rsWindowDays + 1);
    const oldest = history[windowLen - 1]!;

    if (oldest.close <= 0) {
      returns.push(null);
      continue;
    }
    returns.push(((latestClose - oldest.close) / oldest.close) * 100);
  }

  return { returns, historyDays };
}
