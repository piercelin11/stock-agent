import { PrismaClient } from "../generated/prisma/client.js";

// ---- 資格門檻（可調整，calculate-breakout-strength.ts 與 check-intraday-breakout.ts 共用）----
export const GATES = {
  minMarketCap: 5_000_000_000, // 50 億台幣
  minVolumeShares: 1_000_000, // 1000 張
};

// ---- 強度評分權重（總和為 1，不需再正規化）----
export const WEIGHTS = {
  volumeStrength: 0.2,
  breakoutMargin: 0.15,
  firstBar: 0.2,
  base: 0.2,
  proximityToHigh: 0.15,
  relativeStrength: 0.1,
};

export const TRIGGER_VOLUME_RATIO = 2.0;
export const BASE_MIN_HISTORY_DAYS = 40;
export const BASE_MAX_WINDOW_DAYS = 240;
export const PROXIMITY_SHORT_WINDOW = 60;
export const PROXIMITY_LONG_WINDOW = 240;
export const RS_WINDOW_DAYS = 60;

// 對應 calculate-screen-score.ts 的 rankScore：cross-sectional percentile rank，0~100
export function rankScore(values: (number | null)[], lowerIsBetter: boolean, naScore: number): number[] {
  const validEntries = values
    .map((v, i) => ({ v, i }))
    .filter((e): e is { v: number; i: number } => e.v !== null && !Number.isNaN(e.v));

  if (validEntries.length === 0) {
    return values.map(() => naScore);
  }

  const sorted = [...validEntries].sort((a, b) => (lowerIsBetter ? b.v - a.v : a.v - b.v));

  const result = new Array<number>(values.length).fill(naScore);
  for (let rank = 0; rank < sorted.length; rank++) {
    const percentile = ((rank + 1) / sorted.length) * 100;
    result[sorted[rank]!.i] = percentile;
  }
  return result;
}

export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface HistoryPoint {
  date: Date;
  close: number | null;
  bollingerBandwidth: number | null;
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
export function computeVolumeStrength(ratio: number): number {
  // 2倍=40分，6倍以上=100分，線性 clip
  const score = 40 + ((ratio - 2) / (6 - 2)) * (100 - 40);
  return clip(score, 40, 100);
}

// ---- 3b. breakoutMargin ----
export function computeBreakoutMargin(close: number, bollingerUpper: number): number {
  const marginPct = ((close - bollingerUpper) / bollingerUpper) * 100;
  const score = 40 + (marginPct / 3) * (100 - 40);
  return clip(score, 40, 100);
}

// ---- 3c. firstBar ----
// series[0] 是 T-1（或盤中版的「今天即時價 vs T-1 上軌」由呼叫端組出對應序列），依日期新到舊排序
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
): { score: number; degraded: boolean; historyDays: number } {
  const validHistory = bandwidthHistory.filter((v): v is number => v !== null && !Number.isNaN(v));

  if (latestBandwidth === null || validHistory.length < BASE_MIN_HISTORY_DAYS) {
    return { score: 50, degraded: true, historyDays: validHistory.length };
  }

  const sorted = [...validHistory].sort((a, b) => a - b);
  const rankIndex = sorted.findIndex((v) => v >= latestBandwidth);
  const p = ((rankIndex === -1 ? sorted.length - 1 : rankIndex) / (sorted.length - 1 || 1)) * 100;
  const depthScore = 100 - p;

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
  const durationScore = Math.min(durationDays / 40, 1) * 100;

  const score = depthScore * 0.6 + durationScore * 0.4;
  return { score, degraded: false, historyDays: validHistory.length };
}

// ---- 3e. proximityToHigh ----
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
): { score: number; degraded: boolean } {
  const validCloses = closeHistory.filter((v): v is number => v !== null && !Number.isNaN(v));

  if (validCloses.length < PROXIMITY_SHORT_WINDOW) {
    return { score: 50, degraded: true };
  }

  const shortWindow = validCloses.slice(0, PROXIMITY_SHORT_WINDOW);
  const longWindow = validCloses.slice(0, PROXIMITY_LONG_WINDOW);
  const degraded = validCloses.length < PROXIMITY_LONG_WINDOW;

  const shortScore = computeProximityScale(referenceClose, shortWindow);
  const longScore = computeProximityScale(referenceClose, longWindow);

  return { score: shortScore * 0.5 + longScore * 0.5, degraded };
}

// ---- 3f. relativeStrength：全市場先算好，候選股查百分位 ----
export function computeMarketWideReturns(
  codes: string[],
  historyByStock: Map<string, { date: Date; close: number }[]>,
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
    const windowLen = Math.min(history.length, RS_WINDOW_DAYS + 1);
    const oldest = history[windowLen - 1]!;

    if (oldest.close <= 0) {
      returns.push(null);
      continue;
    }
    returns.push(((latestClose - oldest.close) / oldest.close) * 100);
  }

  return { returns, historyDays };
}
