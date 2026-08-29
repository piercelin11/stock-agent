// 盤後選股 v2（投信吃貨訊號）共用純函式庫（無 Prisma / CLI）。
//
// 計分結構為乘法：最終分數 = 籌碼分數 × 技術就緒係數
//   - 籌碼分數（0~100）：主排序依據。投信分數 × 0.7 + 其他法人分數 × 0.3。
//   - 技術就緒係數（READINESS_FLOOR~1.0）：調節項。壓縮度 / 窒息量合成後線性映射，
//     下限刻意設在 0.5 而非 0——技術面沒收斂只把籌碼分數打折，不歸零、不從排名抹掉。
//
// 壓縮度分數直接重用 breakout-shared.ts 的 computeBase（帶寬歷史百分位 + 低帶寬持續天數），
// 與 calculate-breakout-strength.ts 口徑一致，未來兩系統結果可比對。

import type { DeepPartial } from "./types";

// ---- 視窗與資格門檻常數（比照 breakout-shared.ts 的 RS_WINDOW_DAYS 寫法，寫死不留活動範圍）----
export const INSTITUTIONAL_WINDOW_DAYS = 20; // 投信 / 其他法人分數的回看視窗（交易日）
export const SQUEEZE_VOLUME_WINDOW_DAYS = 5; // 窒息量的近期平均量比視窗（交易日）
export const BANDWIDTH_HISTORY_MAX_DAYS = 240; // 壓縮度分數的帶寬歷史窗（不含當日），對應 computeBase 需求
export const MIN_AVG_VOLUME_SHARES = 500_000; // 候選池資格：近 20 日均量下限（500 張），剔除長期無量的死股
export const READINESS_FLOOR = 0.5; // 技術就緒係數下限
export const MIN_INSTITUTIONAL_DAYS_RATIO = 0.5; // 視窗內三大法人有資料天數 < 一半 → degraded
export const MIN_SQUEEZE_VOLUME_DAYS = 3; // 近 5 日量比有效天數 < 3 → degraded
export const NEUTRAL_SCORE = 50; // degraded 時的中性分
export const BASE_MIN_HISTORY_DAYS = 40; // computeBase 的 degraded 門檻（沿用 breakout-shared 的預設值）

// ---- 待校準參數（跑完看前 20~30 名再調）----
export const CHIP_WEIGHTS = {
  trust: 0.7, // 投信分數（主因子）
  otherInstitution: 0.3, // 外資 + 自營商（確認性訊號）
};
export const TRUST_SUB_WEIGHTS = {
  buyFrequency: 0.5, // 窗內淨買超天數佔比
  netRatio: 0.5, // 窗內淨買超股數佔發行量比例
};
export const TECH_WEIGHTS = {
  squeeze: 0.5, // 布林帶寬壓縮度（computeBase）
  quietVolume: 0.5, // 窒息量（近 5 日平均量比）
};

// ---- config 型別（回測用：門檻類走 Layer 1，加權/曲線/視窗類走 Layer 2）----

/** 門檻類：決定誰進候選池（Layer 1）。回測時調這些要重篩池 → rankScore 要重跑。 */
export interface AccumulationGateConfig {
  minAvgVolumeShares: number; // 500_000
}

/** 加權 / 曲線 / 視窗類：決定分數怎麼組（Layer 2）。調這些不動候選池成員。 */
export interface AccumulationScoreConfig {
  institutionalWindowDays: number; // 20 // 回測調大此值需確認 Layer 0 序列夠長
  squeezeVolumeWindowDays: number; // 5 // 回測調大此值需確認 Layer 0 序列夠長
  bandwidthHistoryMaxDays: number; // 240 // 回測調大此值需確認 Layer 0 序列夠長
  readinessFloor: number; // 0.5
  minInstitutionalDaysRatio: number; // 0.5（degraded 判定，見 §3：不剔除股票只降級分項 → 歸 score）
  minSqueezeVolumeDays: number; // 3
  baseMinHistoryDays: number; // 40（computeBase 的 degraded 門檻）
  neutralScore: number; // 50
  chipWeights: { trust: number; otherInstitution: number }; // 0.7 / 0.3
  trustSubWeights: { buyFrequency: number; netRatio: number }; // 0.5 / 0.5
  techWeights: { squeeze: number; quietVolume: number }; // 0.5 / 0.5
}

export interface AccumulationConfig {
  gate: AccumulationGateConfig;
  score: AccumulationScoreConfig;
}

/** 現行預設。從既有 export const 組出來，數值不變。 */
export const DEFAULT_ACCUMULATION_CONFIG: AccumulationConfig = {
  gate: { minAvgVolumeShares: MIN_AVG_VOLUME_SHARES },
  score: {
    institutionalWindowDays: INSTITUTIONAL_WINDOW_DAYS,
    squeezeVolumeWindowDays: SQUEEZE_VOLUME_WINDOW_DAYS,
    bandwidthHistoryMaxDays: BANDWIDTH_HISTORY_MAX_DAYS,
    readinessFloor: READINESS_FLOOR,
    minInstitutionalDaysRatio: MIN_INSTITUTIONAL_DAYS_RATIO,
    minSqueezeVolumeDays: MIN_SQUEEZE_VOLUME_DAYS,
    baseMinHistoryDays: BASE_MIN_HISTORY_DAYS,
    neutralScore: NEUTRAL_SCORE,
    chipWeights: { ...CHIP_WEIGHTS },
    trustSubWeights: { ...TRUST_SUB_WEIGHTS },
    techWeights: { ...TECH_WEIGHTS },
  },
};

/** 深層合併：呼叫端只給想改的欄位。config 結構固定且淺 → 手寫展開，不用泛型遞迴 merge。 */
export function resolveAccumulationConfig(
  override?: DeepPartial<AccumulationConfig>,
): AccumulationConfig {
  const d = DEFAULT_ACCUMULATION_CONFIG;
  const g = override?.gate;
  const s = override?.score;
  return {
    gate: {
      minAvgVolumeShares: g?.minAvgVolumeShares ?? d.gate.minAvgVolumeShares,
    },
    score: {
      institutionalWindowDays: s?.institutionalWindowDays ?? d.score.institutionalWindowDays,
      squeezeVolumeWindowDays: s?.squeezeVolumeWindowDays ?? d.score.squeezeVolumeWindowDays,
      bandwidthHistoryMaxDays: s?.bandwidthHistoryMaxDays ?? d.score.bandwidthHistoryMaxDays,
      readinessFloor: s?.readinessFloor ?? d.score.readinessFloor,
      minInstitutionalDaysRatio: s?.minInstitutionalDaysRatio ?? d.score.minInstitutionalDaysRatio,
      minSqueezeVolumeDays: s?.minSqueezeVolumeDays ?? d.score.minSqueezeVolumeDays,
      baseMinHistoryDays: s?.baseMinHistoryDays ?? d.score.baseMinHistoryDays,
      neutralScore: s?.neutralScore ?? d.score.neutralScore,
      chipWeights: {
        trust: s?.chipWeights?.trust ?? d.score.chipWeights.trust,
        otherInstitution: s?.chipWeights?.otherInstitution ?? d.score.chipWeights.otherInstitution,
      },
      trustSubWeights: {
        buyFrequency: s?.trustSubWeights?.buyFrequency ?? d.score.trustSubWeights.buyFrequency,
        netRatio: s?.trustSubWeights?.netRatio ?? d.score.trustSubWeights.netRatio,
      },
      techWeights: {
        squeeze: s?.techWeights?.squeeze ?? d.score.techWeights.squeeze,
        quietVolume: s?.techWeights?.quietVolume ?? d.score.techWeights.quietVolume,
      },
    },
  };
}

export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// 對應 breakout-shared.ts / calculate-screen-score.ts 的 rankScore：cross-sectional percentile rank，0~100。
// lowerIsBetter=true 時數值越小排名分數越高。naScore：該欄位缺值時給的預設分數。
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

// ---- 投信買進動能：兩個子指標的原始值（rankScore 由呼叫端跨市場一次算）----

export interface TrustRawMetrics {
  buyFrequency: number | null; // 窗內 investmentTrustNetBuy > 0 的天數 ÷ 有資料天數（0~1）
  consecutiveBuyDays: number; // 由今日往回連續淨買超天數（僅記錄，不計分）
  netRatio: number | null; // 窗內淨買超股數加總 ÷ sharesOutstanding（帶正負號）；sharesOutstanding 為 null 時為 null
  dataDays: number; // 窗內實際有 InstitutionalTrading 資料的天數
  degraded: boolean; // dataDays 不足 → true
}

// series 依日期新到舊排序，長度已由呼叫端截到視窗天數。sharesOutstanding 為 null → netRatio 為 null。
export function computeTrustRawMetrics(
  netBuySeriesNewestFirst: number[],
  sharesOutstanding: number | null,
  windowDays: number,
  minDaysRatio: number,
): TrustRawMetrics {
  const dataDays = netBuySeriesNewestFirst.length;

  if (dataDays < Math.ceil(windowDays * minDaysRatio)) {
    return { buyFrequency: null, consecutiveBuyDays: 0, netRatio: null, dataDays, degraded: true };
  }

  const buyDays = netBuySeriesNewestFirst.filter((v) => v > 0).length;
  const buyFrequency = buyDays / dataDays;

  let consecutiveBuyDays = 0;
  for (const v of netBuySeriesNewestFirst) {
    if (v > 0) consecutiveBuyDays += 1;
    else break;
  }

  const netSum = netBuySeriesNewestFirst.reduce((s, v) => s + v, 0);
  const netRatio = sharesOutstanding !== null && sharesOutstanding > 0 ? netSum / sharesOutstanding : null;

  return { buyFrequency, consecutiveBuyDays, netRatio, dataDays, degraded: false };
}

// ---- 其他法人（外資 + 自營商，排除投信）區間集中度 ----
// 比例的加總：sum(foreignNetBuy + dealerNetBuy) / sum(volume)，帶正負號。
// 不用「每天算比例再平均」（清淡日分母小會暴衝）。窗內資料不足 → null（呼叫端 rankScore 給 naScore）。
export function computeOtherInstitutionRatio(
  foreignPlusDealerNewestFirst: number[],
  volumeNewestFirst: number[],
  windowDays: number,
  minDaysRatio: number,
): { ratio: number | null; dataDays: number; degraded: boolean } {
  const dataDays = Math.min(foreignPlusDealerNewestFirst.length, volumeNewestFirst.length);

  if (dataDays < Math.ceil(windowDays * minDaysRatio)) {
    return { ratio: null, dataDays, degraded: true };
  }

  let netSum = 0;
  let volSum = 0;
  for (let i = 0; i < dataDays; i++) {
    netSum += foreignPlusDealerNewestFirst[i]!;
    volSum += volumeNewestFirst[i]!;
  }

  if (volSum <= 0) {
    return { ratio: null, dataDays, degraded: true };
  }

  return { ratio: netSum / volSum, dataDays, degraded: false };
}

// ---- 窒息量：近 squeezeVolumeWindowDays 天平均量比（越低越窒息）----
// ratioSeries：近幾日的 volume / volumeMa20，新到舊，呼叫端已過濾 null / volumeMa20<=0。
export function computeQuietVolumeRatio(
  ratioSeriesNewestFirst: number[],
  windowDays: number,
  minDays: number,
): {
  avgRatio: number | null;
  usedDays: number;
  degraded: boolean;
} {
  const window = ratioSeriesNewestFirst.slice(0, windowDays);
  const usedDays = window.length;

  if (usedDays < minDays) {
    return { avgRatio: null, usedDays, degraded: true };
  }

  const avgRatio = window.reduce((s, v) => s + v, 0) / usedDays;
  return { avgRatio, usedDays, degraded: false };
}

// ---- 合成 ----

// 籌碼分數 = 投信分數 × trust + 其他法人分數 × otherInstitution（兩者皆為 0~100 的 rankScore 結果）
export function combineChipScore(
  trustScore: number,
  otherInstScore: number,
  weights: AccumulationScoreConfig["chipWeights"],
): number {
  return trustScore * weights.trust + otherInstScore * weights.otherInstitution;
}

// 投信分數 = 頻率分 × buyFrequency + 佔比分 × netRatio。佔比子項 degraded 時只用頻率分。
export function combineTrustScore(
  buyFreqScore: number,
  netRatioScore: number | null,
  weights: AccumulationScoreConfig["trustSubWeights"],
): number {
  if (netRatioScore === null) return buyFreqScore;
  return buyFreqScore * weights.buyFrequency + netRatioScore * weights.netRatio;
}

// 技術原始分（0~100）→ 就緒係數（readinessFloor~1.0），線性映射。
export function computeReadinessCoefficient(
  squeezeScore: number,
  quietVolumeScore: number,
  weights: AccumulationScoreConfig["techWeights"],
  readinessFloor: number,
): number {
  const techRaw = clip(squeezeScore * weights.squeeze + quietVolumeScore * weights.quietVolume, 0, 100);
  return readinessFloor + (1 - readinessFloor) * (techRaw / 100);
}

// 最終分數 = 籌碼分數 × 就緒係數
export function combineFinalScore(chipScore: number, readinessCoef: number): number {
  return chipScore * readinessCoef;
}
