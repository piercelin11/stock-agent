// Layer 1 + Layer 2 記憶體重算（ROADMAP 3.0 / PLAN §3）。
//
// 【純函式庫】import breakout-shared.ts / accumulation-shared.ts 的評分函式 + rankScore + config 型別，
// 不 import Prisma、不讀檔。輸入是「已讀進記憶體的 raw-factors 行陣列」。
//
// 職責：
//   Layer 1 — 套 gate 篩候選池
//   Layer 2 — 在候選池上重跑 rankScore → 套 score 評分函式 → 加權排名
//
// 唯二的「格式適配」邏輯：
//   1. parseBreakoutRow / parseAccumulationRow：Layer 0 為壓體積用位置對齊 tuple，這裡還原成具名。
//   2. sliceWindows：Layer 0 每個視窗多抓緩衝，這裡先截到 resolved config 視窗長度再算
//      （computeBase 對 260 筆 vs 240 筆的 percentile / p25 不同）。
// 其餘直接呼叫 shared 檔函式，與 calculate-breakout-strength.ts / calculate-accumulation-score.ts 同管線。

import {
  rankScore,
  computeVolumeStrength,
  computeBreakoutMargin,
  computeFirstBar,
  computeBase,
  computeProximityToHigh,
  computeMarketWideReturns,
  computeCandleShape,
  DEFAULT_BREAKOUT_CONFIG,
  type BreakoutConfig,
  type HistoryPoint,
} from "./breakout-shared";
import {
  rankScore as accRankScore,
  computeTrustRawMetrics,
  computeOtherInstitutionRatio,
  computeQuietVolumeRatio,
  combineChipScore,
  combineTrustScore,
  computeReadinessCoefficient,
  combineFinalScore,
  type AccumulationConfig,
} from "./accumulation-shared";

// accumulation 的壓縮度沿用 breakout 的 base 曲線（口徑一致，見 accumulation-shared.ts 檔頭）
const ACC_BASE_CURVE = DEFAULT_BREAKOUT_CONFIG.score.curves.base;

// ========================================================================
// raw-factors 行的形狀（parse 後）
// ========================================================================

/** breakout raw-factors/{date}.jsonl 一行 parse 後（tuple 已還原成具名）。 */
export interface BreakoutRawRow {
  date: string;
  code: string;
  name: string;
  close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number;
  volume: number;
  sharesOutstanding: number | null;
  bollingerUpper: number | null;
  bollingerBandwidth: number | null;
  volumeMa20: number | null;
  prevClose: number | null;
  prevTradingDate: string | null;
  // T-1 起往回 firstBarLookbackDays(+緩衝) 筆（新到舊）
  firstBarSeries: { close: number; bollingerUpper: number | null }[];
  // base + proximityToHigh 共用：T-1 起往回 baseMaxWindowDays(+緩衝) 筆（新到舊）
  history: HistoryPoint[];
  // relativeStrength：這一檔近 rsWindowDays+1(+緩衝) 筆 close（含當天，新到舊）
  rsCloseSeries: number[];
}

/** accumulation raw-factors/{date}.jsonl 一行 parse 後（tuple 已還原成具名）。 */
export interface AccumulationRawRow {
  date: string;
  code: string;
  name: string;
  close: number;
  sharesOutstanding: number | null;
  bollingerUpper: number | null;
  bollingerBandwidth: number | null;
  volumeMa20: number | null;
  prevTradingDate: string | null;
  // 三大法人視窗（+緩衝），新到舊，三序列同索引對齊
  institutional: { trustNetBuy: number; foreignPlusDealerNetBuy: number; volume: number }[];
  // 窒息量：近 squeezeVolumeWindowDays(+緩衝) 筆的原始 volume（新到舊）
  recentVolumes: number[];
  // 壓縮度：不含當日、往回 bandwidthHistoryMaxDays(+緩衝) 筆的 bandwidth（新到舊）
  bandwidthHistory: (number | null)[];
}

// ========================================================================
// 結果形狀（對齊 calculate-*.ts 的 results）
// ========================================================================

export interface ReplayResultBreakout {
  date: string;
  code: string;
  name: string;
  scores: {
    candleShape: number;
    volumeStrength: number;
    breakoutMargin: number;
    firstBar: number;
    base: number;
    proximityToHigh: number;
    relativeStrength: number;
  };
  totalScore: number;
  rank: number;
  degraded: string[];
}

export interface ReplayResultAccumulation {
  date: string;
  code: string;
  name: string;
  chipScore: number;
  readinessCoef: number;
  finalScore: number;
  rank: number;
  degraded: string[];
}

// ========================================================================
// parse：tuple → 具名
// ========================================================================

export function parseBreakoutRow(json: string | Record<string, unknown>): BreakoutRawRow {
  const o = typeof json === "string" ? (JSON.parse(json) as Record<string, unknown>) : json;
  const firstBarSeries = ((o.firstBarSeries as [number, number | null][]) ?? []).map((t) => ({
    close: t[0],
    bollingerUpper: t[1],
  }));
  // history tuple = [close, bollingerBandwidth]；不存 date（序列為 prevTradingDate 起連續交易日、新到舊）
  const history: HistoryPoint[] = ((o.history as [number | null, number | null][]) ?? []).map((t) => ({
    date: new Date(0), // 位置對齊即可，computeBase / computeProximityToHigh 不看 date
    close: t[0],
    bollingerBandwidth: t[1],
  }));
  return {
    date: o.date as string,
    code: o.code as string,
    name: o.name as string,
    close: o.close as number,
    open: (o.open as number | null) ?? null,
    high: (o.high as number | null) ?? null,
    low: (o.low as number | null) ?? null,
    change: (o.change as number) ?? 0,
    volume: o.volume as number,
    sharesOutstanding: (o.sharesOutstanding as number | null) ?? null,
    bollingerUpper: (o.bollingerUpper as number | null) ?? null,
    bollingerBandwidth: (o.bollingerBandwidth as number | null) ?? null,
    volumeMa20: (o.volumeMa20 as number | null) ?? null,
    prevClose: (o.prevClose as number | null) ?? null,
    prevTradingDate: (o.prevTradingDate as string | null) ?? null,
    firstBarSeries,
    history,
    rsCloseSeries: ((o.rsCloseSeries as (number | null)[]) ?? []).filter(
      (v): v is number => v !== null && !Number.isNaN(v),
    ),
  };
}

export function parseAccumulationRow(json: string | Record<string, unknown>): AccumulationRawRow {
  const o = typeof json === "string" ? (JSON.parse(json) as Record<string, unknown>) : json;
  const institutional = ((o.institutional as [number, number, number][]) ?? []).map((t) => ({
    trustNetBuy: t[0],
    foreignPlusDealerNetBuy: t[1],
    volume: t[2],
  }));
  return {
    date: o.date as string,
    code: o.code as string,
    name: o.name as string,
    close: o.close as number,
    sharesOutstanding: (o.sharesOutstanding as number | null) ?? null,
    bollingerUpper: (o.bollingerUpper as number | null) ?? null,
    bollingerBandwidth: (o.bollingerBandwidth as number | null) ?? null,
    volumeMa20: (o.volumeMa20 as number | null) ?? null,
    prevTradingDate: (o.prevTradingDate as string | null) ?? null,
    institutional,
    recentVolumes: ((o.recentVolumes as number[]) ?? []).slice(),
    bandwidthHistory: ((o.bandwidthHistory as (number | null)[]) ?? []).slice(),
  };
}

// ========================================================================
// sliceWindows：緩衝陣列截到 resolved config 視窗長度
// ========================================================================

function sliceBreakoutWindows(row: BreakoutRawRow, config: BreakoutConfig): BreakoutRawRow {
  const s = config.score;
  return {
    ...row,
    firstBarSeries: row.firstBarSeries.slice(0, s.firstBarLookbackDays),
    history: row.history.slice(0, s.baseMaxWindowDays),
    // computeMarketWideReturns 需要 rsWindowDays + 1 筆（含當天）
    rsCloseSeries: row.rsCloseSeries.slice(0, s.rsWindowDays + 1),
  };
}

function sliceAccumulationWindows(
  row: AccumulationRawRow,
  config: AccumulationConfig,
): AccumulationRawRow {
  const s = config.score;
  return {
    ...row,
    institutional: row.institutional.slice(0, s.institutionalWindowDays),
    recentVolumes: row.recentVolumes.slice(0, s.squeezeVolumeWindowDays),
    bandwidthHistory: row.bandwidthHistory.slice(0, s.bandwidthHistoryMaxDays),
  };
}

// ========================================================================
// replayBreakout（對照 calculate-breakout-strength.ts 的 runCalculation）
// ========================================================================

export function replayBreakout(
  rawRows: BreakoutRawRow[],
  config: BreakoutConfig,
): ReplayResultBreakout[] {
  const { gate, score } = config;
  const rows = rawRows.map((r) => sliceBreakoutWindows(r, config));
  if (rows.length === 0) return [];

  const dateStr = rows[0]!.date;
  const codes = rows.map((r) => r.code);

  // ---- 第一層：觸發條件 ----
  const triggered = rows.filter((r) => {
    if (
      r.bollingerUpper === null ||
      r.volumeMa20 === null ||
      r.volumeMa20 <= 0
    ) {
      return false;
    }
    const passPrice = r.close > r.bollingerUpper;
    const passVolume = r.volume / r.volumeMa20 >= gate.triggerVolumeRatio;
    return passPrice && passVolume;
  });

  // ---- 第二層：資格門檻 ----
  const passed = triggered.filter((r) => {
    if (r.sharesOutstanding === null) return false;
    const marketCap = r.sharesOutstanding * r.close;
    return marketCap >= gate.minMarketCap && r.volume >= gate.minVolumeShares;
  });

  if (passed.length === 0) return [];

  // ---- RS：母體為全市場 ----
  const marketHistoryByStock = new Map<string, { date: Date; close: number }[]>();
  for (const r of rows) {
    // computeMarketWideReturns 只看 .close 與長度；date 給 dummy
    marketHistoryByStock.set(
      r.code,
      r.rsCloseSeries.map((c) => ({ date: new Date(0), close: c })),
    );
  }
  const { returns: marketReturns, historyDays: rsHistoryDays } = computeMarketWideReturns(
    codes,
    marketHistoryByStock,
    score.rsWindowDays,
  );
  const rsScoresAllMarket = rankScore(marketReturns, false, score.naScore);
  const rsScoreByCode = new Map(
    codes.map((c, i) => [
      c,
      { score: rsScoresAllMarket[i]!, historyDays: rsHistoryDays.get(c) ?? 0 },
    ]),
  );

  // ---- 逐股票評分 ----
  const firstBarSeriesByStock = new Map<string, { close: number; bollingerUpper: number | null }[]>();
  for (const r of passed) firstBarSeriesByStock.set(r.code, r.firstBarSeries);

  const results: ReplayResultBreakout[] = passed.map((r) => {
    const bollingerUpper = r.bollingerUpper!;
    const volumeMa20 = r.volumeMa20!;
    const volumeRatio = r.volume / volumeMa20;

    const degraded: string[] = [];

    const volumeStrengthScore = computeVolumeStrength(volumeRatio, score.curves.volumeStrength);
    const breakoutMarginScore = computeBreakoutMargin(
      r.close,
      bollingerUpper,
      score.curves.breakoutMargin,
    );

    const candleShapeResult = computeCandleShape({
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    });
    if (candleShapeResult.degraded) degraded.push("candleShape");

    const firstBarResult = computeFirstBar(firstBarSeriesByStock, r.code);
    if (firstBarResult.degraded) degraded.push("firstBar");

    const stockBaseHistory = r.history;
    const yesterdayBandwidth =
      stockBaseHistory.length > 0 ? stockBaseHistory[0]!.bollingerBandwidth : null;
    const bandwidthHistoryForRank = stockBaseHistory.map((p) => p.bollingerBandwidth);
    const baseResult = computeBase(
      yesterdayBandwidth,
      bandwidthHistoryForRank,
      score.baseMinHistoryDays,
      score.curves.base,
    );
    if (baseResult.degraded) degraded.push("base");

    const proximityCloseHistory = stockBaseHistory.map((p) => p.close);
    const proximityResult = computeProximityToHigh(
      r.close,
      proximityCloseHistory,
      score.proximityShortWindow,
      score.proximityLongWindow,
    );
    if (proximityResult.degraded) degraded.push("proximityToHigh240");

    const rs = rsScoreByCode.get(r.code)!;
    if (rs.historyDays < 2) degraded.push("relativeStrength");

    const scores = {
      candleShape: candleShapeResult.score,
      volumeStrength: volumeStrengthScore,
      breakoutMargin: breakoutMarginScore,
      firstBar: firstBarResult.score,
      base: baseResult.score,
      proximityToHigh: proximityResult.score,
      relativeStrength: rs.score,
    };

    const totalScore =
      scores.candleShape * score.weights.candleShape +
      scores.volumeStrength * score.weights.volumeStrength +
      scores.breakoutMargin * score.weights.breakoutMargin +
      scores.firstBar * score.weights.firstBar +
      scores.base * score.weights.base +
      scores.proximityToHigh * score.weights.proximityToHigh +
      scores.relativeStrength * score.weights.relativeStrength;

    return {
      date: dateStr,
      code: r.code,
      name: r.name,
      scores,
      totalScore,
      rank: 0,
      degraded,
    };
  });

  results.sort((a, b) => b.totalScore - a.totalScore);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });
  return results;
}

// ========================================================================
// replayAccumulation（對照 calculate-accumulation-score.ts 的 runCalculation）
// ========================================================================

export function replayAccumulation(
  rawRows: AccumulationRawRow[],
  config: AccumulationConfig,
): ReplayResultAccumulation[] {
  const { gate, score } = config;
  const rows = rawRows.map((r) => sliceAccumulationWindows(r, config));
  if (rows.length === 0) return [];

  const dateStr = rows[0]!.date;

  // ---- Layer 1：候選池門檻（buildCandidatePool）----
  const snapshots = rows.filter((r) => {
    // 1. 今日已站上布林上軌 → 剔除
    if (r.bollingerUpper !== null && r.close > r.bollingerUpper) return false;
    // 2/3. 近 20 日均量下限 / volumeMa20 缺值 → 剔除
    if (r.volumeMa20 === null || r.volumeMa20 <= 0 || r.volumeMa20 < gate.minAvgVolumeShares) {
      return false;
    }
    return true;
  });

  if (snapshots.length === 0) return [];

  // ---- Layer 2：四分項原始值 → 跨候選池 rankScore ----
  const trustRaw = snapshots.map((s) =>
    computeTrustRawMetrics(
      s.institutional.map((x) => x.trustNetBuy),
      s.sharesOutstanding,
      score.institutionalWindowDays,
      score.minInstitutionalDaysRatio,
    ),
  );
  const otherInstRaw = snapshots.map((s) =>
    computeOtherInstitutionRatio(
      s.institutional.map((x) => x.foreignPlusDealerNetBuy),
      s.institutional.map((x) => x.volume),
      score.institutionalWindowDays,
      score.minInstitutionalDaysRatio,
    ),
  );
  const quietRaw = snapshots.map((s) => {
    const ma20 = s.volumeMa20!; // Layer 1 已擋掉 null / <=0
    const ratioSeries = s.recentVolumes.map((v) => v / ma20);
    return computeQuietVolumeRatio(ratioSeries, score.squeezeVolumeWindowDays, score.minSqueezeVolumeDays);
  });
  const baseRaw = snapshots.map((s) =>
    computeBase(s.bollingerBandwidth, s.bandwidthHistory, score.baseMinHistoryDays, ACC_BASE_CURVE),
  );

  const trustFreqScores = accRankScore(
    trustRaw.map((t) => t.buyFrequency),
    false,
    score.neutralScore,
  );
  const trustNetRatioScores = accRankScore(
    trustRaw.map((t) => t.netRatio),
    false,
    score.neutralScore,
  );
  const otherInstScores = accRankScore(
    otherInstRaw.map((o) => o.ratio),
    false,
    score.neutralScore,
  );
  const quietVolumeScores = accRankScore(
    quietRaw.map((q) => q.avgRatio),
    true,
    score.neutralScore,
  );

  // ---- 合成 ----
  const results: ReplayResultAccumulation[] = snapshots.map((s, i) => {
    const degraded: string[] = [];

    const t = trustRaw[i]!;
    const o = otherInstRaw[i]!;
    const q = quietRaw[i]!;
    const b = baseRaw[i]!;

    if (t.degraded) degraded.push("trustMomentum");
    if (t.netRatio === null && !t.degraded) degraded.push("trustNetRatio");
    if (o.degraded) degraded.push("otherInstitution");
    if (q.degraded) degraded.push("quietVolume");
    if (b.degraded) degraded.push("squeeze");

    const trustScore = t.degraded
      ? score.neutralScore
      : combineTrustScore(
          trustFreqScores[i]!,
          t.netRatio === null ? null : trustNetRatioScores[i]!,
          score.trustSubWeights,
        );
    const otherInstScore = otherInstScores[i]!;
    const chipScore = combineChipScore(trustScore, otherInstScore, score.chipWeights);

    const squeezeScore = b.score;
    const quietVolumeScore = quietVolumeScores[i]!;
    const readinessCoef = computeReadinessCoefficient(
      squeezeScore,
      quietVolumeScore,
      score.techWeights,
      score.readinessFloor,
    );

    const finalScore = combineFinalScore(chipScore, readinessCoef);

    return {
      date: dateStr,
      code: s.code,
      name: s.name,
      chipScore,
      readinessCoef,
      finalScore,
      rank: 0,
      degraded,
    };
  });

  results.sort((a, b) => b.finalScore - a.finalScore);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });
  return results;
}

// ========================================================================
// 多日批次版：Map<date, rows> → Map<date, ReplayResult[]>
// ========================================================================

export function replayBreakoutRange(
  byDate: Map<string, BreakoutRawRow[]>,
  config: BreakoutConfig,
): Map<string, ReplayResultBreakout[]> {
  const out = new Map<string, ReplayResultBreakout[]>();
  for (const [date, rows] of byDate) out.set(date, replayBreakout(rows, config));
  return out;
}

export function replayAccumulationRange(
  byDate: Map<string, AccumulationRawRow[]>,
  config: AccumulationConfig,
): Map<string, ReplayResultAccumulation[]> {
  const out = new Map<string, ReplayResultAccumulation[]>();
  for (const [date, rows] of byDate) out.set(date, replayAccumulation(rows, config));
  return out;
}
