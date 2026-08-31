// 統一因子庫（ROADMAP 4.5.3 / PLAN §2）—— run-signal-scan.ts 的單一 import 點。
//
// 設計取捨（PLAN §2.1 選 A）：本檔只做「re-export 舊評分函式 + 新增」，不把評分邏輯搬進來。
//   - 舊評分函式續住 breakout-shared.ts / accumulation-shared.ts（它們還有 config 三件組、
//     fetchXxxRawInputs helper 被別處引用）。
//   - 本檔新增：computeInstitutionalFlow（三大法人流向，全新因子）、
//     computeBreakoutMarginMonotone（§2.5 單調遞增版，舊 computeBreakoutMargin 不動）、
//     consecutiveAboveBand（§3.3 階段判定 helper，computeFirstBar 也改用它、行為不變）、
//     SignalScanConfig / DEFAULT_SIGNAL_CONFIG / resolveSignalConfig。
//
// 三處刻意偏離舊預設（PLAN §2.7 步驟 260）：
//   1. baseCurve 深度/時長 = 0.4 / 0.6（舊 breakout 是 0.6 / 0.4）—— §2.6
//   2. breakoutMargin 改單調遞增，penaltyPerPct / floor 不再生效 —— §2.5
//   3. breakout.weights 7 項勻出 institutionalFlow 的份額（總和維持 1）

import type { DeepPartial } from "./types";
import {
  clip,
  DEFAULT_BREAKOUT_CONFIG,
  // 評分函式（breakout 系）
  computeVolumeStrength,
  computeBreakoutMargin,
  computeFirstBar,
  computeBase,
  computeProximityToHigh,
  computeProximityScale,
  computeMarketWideReturns,
  computeCandleShape,
  rankScore,
  // DB helper（eod 路徑用）
  fetchBreakoutRawInputs,
  fetchTodayQuotes,
  fetchIndicatorsForDate,
  fetchHistoryWindow,
} from "./breakout-shared";
import {
  // 評分函式（accumulation 系）
  computeTrustRawMetrics,
  computeOtherInstitutionRatio,
  computeQuietVolumeRatio,
  combineChipScore,
  combineTrustScore,
  computeReadinessCoefficient,
  combineFinalScore,
  fetchAccumulationRawInputs,
} from "./accumulation-shared";

// ---- re-export：run-signal-scan.ts 一個 import 點拿齊所有評分函式 ----
export {
  clip,
  rankScore,
  computeVolumeStrength,
  computeBreakoutMargin,
  computeFirstBar,
  computeBase,
  computeProximityToHigh,
  computeProximityScale,
  computeMarketWideReturns,
  computeCandleShape,
  computeTrustRawMetrics,
  computeOtherInstitutionRatio,
  computeQuietVolumeRatio,
  combineChipScore,
  combineTrustScore,
  computeReadinessCoefficient,
  combineFinalScore,
  fetchBreakoutRawInputs,
  fetchTodayQuotes,
  fetchIndicatorsForDate,
  fetchHistoryWindow,
  fetchAccumulationRawInputs,
};
export type { HistoryPoint, BreakoutRawInputs, BreakoutQuoteRow } from "./breakout-shared";
export type { AccumulationRawInputs } from "./accumulation-shared";

// ============================================================================
// 2.5 computeBreakoutMarginMonotone —— 單調遞增版（舊 computeBreakoutMargin 不動）
// ============================================================================
//
// 舊版（breakout-shared.ts）：marginPct > kneePct 後每 1% 扣 penaltyPerPct 分、下限 floor
//   → 乖離越大分數越低（懲罰追高）。
// 新版：0~kneePct% 線性 40→100（不變）；> kneePct% 維持 100 封頂，不加不扣；
//   marginPct ≤ 0（收在上軌之下，理論上不進 breakout 階段，但盤中 h 代入可能邊界）→ clip 到 40 下限。
//
// config：只讀 curve.kneePct；penaltyPerPct / floor 在新公式裡不讀（欄位保留、給舊三支用）。

export function computeBreakoutMarginMonotone(
  close: number,
  bollingerUpper: number,
  curve: { kneePct: number },
): number {
  const marginPct = ((close - bollingerUpper) / bollingerUpper) * 100;
  if (marginPct <= 0) return 40;
  if (marginPct <= curve.kneePct) {
    return clip(40 + (marginPct / curve.kneePct) * 60, 40, 100);
  }
  return 100;
}

// ============================================================================
// PLAN §2.1 computeMarginSurgePercentile —— 融資餘額近期增速 vs 自己歷史百分位
// ============================================================================
//
// margin-chasing 警示的輸入端：算「這檔融資餘額近 lookbackDays 日累積變化率」對
// 「這檔自己過去 historyWindowDays 天、每天各自往回 lookbackDays 日的同種累積變化率」
// 母體取的百分位（0~100）。純函式、吃序列、不查 DB。
//
// 設計（PLAN §2.1 設計備註）：
//   - 母體用「過去每一天各自的近 lookbackDays 日累積變化率」，不是「單日變化率」——
//     確保 today 與母體是同一種量在比。
//   - 百分位用「嚴格小於」：平盤時 today changeRate = 0、母體也全 0，`0 < 0` 為 false
//     → 百分位 0，不誤觸發（PLAN §2.3 挖出的坑）。
//   - past <= 0（融資餘額歸零 / 缺值）→ 該筆跳過、不炸。

export interface MarginSurgeConfig {
  lookbackDays: number; // 5（近 5 個交易日累積變化率）
  historyWindowDays: number; // 40（百分位母體：這檔過去 N 天的同種變化率）
  minHistoryDays: number; // 20（母體有效樣本 < 此值 → 回 null，比照 computeBase 保守門檻）
}

/**
 * marginBalanceNewestFirst：這檔的 MarginTrading.marginBalance 序列，日期新到舊，
 *   長度已由呼叫端截到 lookbackDays + historyWindowDays + 1 附近。
 * 回傳：近 lookbackDays 日累積變化率，對「過去 historyWindowDays 天、每天各自往回 lookbackDays 日的
 *   累積變化率」母體取的百分位（0~100，越高代表這檔近期融資增速排在自己歷史越前面）。
 *   資料不足（母體有效樣本 < minHistoryDays）→ null。
 */
export function computeMarginSurgePercentile(
  marginBalanceNewestFirst: number[],
  config: MarginSurgeConfig,
): number | null {
  const { lookbackDays, historyWindowDays, minHistoryDays } = config;

  // 需要至少「當前這筆 + lookbackDays 筆」才能算今天的累積變化率
  if (marginBalanceNewestFirst.length < lookbackDays + 1) return null;

  // 單筆「近 lookbackDays 日累積變化率」：(series[i] - series[i+lookbackDays]) / series[i+lookbackDays]
  const changeRateAt = (i: number): number | null => {
    const now = marginBalanceNewestFirst[i];
    const past = marginBalanceNewestFirst[i + lookbackDays];
    if (now === undefined || past === undefined || past <= 0) return null;
    return (now - past) / past;
  };

  const today = changeRateAt(0);
  if (today === null) return null;

  // 母體：i = 1 .. historyWindowDays，每個 i 算一筆歷史累積變化率
  const population: number[] = [];
  for (let i = 1; i <= historyWindowDays; i++) {
    const r = changeRateAt(i);
    if (r !== null) population.push(r);
  }
  if (population.length < minHistoryDays) return null;

  // 百分位：母體中「嚴格小於」today 的比例 × 100（平盤 → 0，不誤觸發）
  const below = population.filter((v) => v < today).length;
  return (below / population.length) * 100;
}

// ============================================================================
// 2.3 computeInstitutionalFlow —— 三大法人流向（全新因子）
// ============================================================================
//
// 目的：突破當日 / 近日「投信 + 外資是否站在買方」。給 breakout-day / extended 階段用
// （pre-breakout 已有更細的「投信動能」分項，不重複）。

export interface InstitutionalFlowConfig {
  lookbackDays: number; // 5（近 5 個交易日）
  trustWeight: number; // 0.6（投信權重 > 外資）
  foreignWeight: number; // 0.4
  /** 正規化：(近 lookbackDays 日淨買超 ÷ volumeMa20) 落在 [0, clipDivisor] → 線性映射 0~100 */
  clipDivisor: number; // 0.5
  /** 突破當日法人「淨賣超」→ 分數封頂在此值（類似 computeCandleShape 收黑封頂） */
  sellCapScore: number; // 40
  /**
   * PLAN §2.2 margin-chasing 警示子區塊。**不動 score**——只讓函式多回一個 marginChasing 布林，
   * 由呼叫端掛 SignalResult.warnings 標記。
   */
  marginChasing: {
    lookbackDays: number; // 5（近 5 個交易日融資累積變化率）
    historyWindowDays: number; // 40（百分位母體天數）
    minHistoryDays: number; // 20（母體有效樣本下限）
    surgePercentileThreshold: number; // 80（> 此值 + 突破當日法人淨賣超 → marginChasing）
  };
}

export function computeInstitutionalFlow(input: {
  trustNetBuyNewestFirst: number[]; // 近 lookbackDays 天投信淨買超（股）
  foreignNetBuyNewestFirst: number[]; // 近 lookbackDays 天外資淨買超（股）
  todayTrustNetBuy: number | null; // 突破當日投信淨買超（盤中版 = null → 降級）
  todayForeignNetBuy: number | null; // 突破當日外資淨買超
  volumeMa20: number | null;
  marginSurgePercentile: number | null; // PLAN §2.2：null = 盤中 / 資料不足 → 不觸發
  config: InstitutionalFlowConfig;
}): { score: number; degraded: boolean; marginChasing: boolean } {
  const { config } = input;
  const halfWindow = Math.ceil(config.lookbackDays / 2);

  // 1. volumeMa20 缺 / 近 lookbackDays 資料不足一半 → 中性
  const trustSeries = input.trustNetBuyNewestFirst.slice(0, config.lookbackDays);
  const foreignSeries = input.foreignNetBuyNewestFirst.slice(0, config.lookbackDays);
  const dataDays = Math.min(trustSeries.length, foreignSeries.length);
  if (input.volumeMa20 === null || input.volumeMa20 <= 0 || dataDays < halfWindow) {
    return { score: 50, degraded: true, marginChasing: false };
  }

  // 2. 近窗淨買超 ÷ volumeMa20 → clip [0, clipDivisor] → ×(100/clipDivisor) → 0~100
  const toFlowScore = (series: number[]): number => {
    const sum = series.reduce((s, v) => s + v, 0);
    const ratio = sum / input.volumeMa20!;
    return clip(ratio, 0, config.clipDivisor) * (100 / config.clipDivisor);
  };
  const trustFlow = toFlowScore(trustSeries);
  const foreignFlow = toFlowScore(foreignSeries);

  // 3. 加權合成
  let score = trustFlow * config.trustWeight + foreignFlow * config.foreignWeight;

  // 4. 突破當日法人淨賣超封頂
  let degraded = false;
  if (input.todayTrustNetBuy === null || input.todayForeignNetBuy === null) {
    // 盤中拿不到當日法人 → 不封頂、但標 degraded（給中性訊號用途，比照現有 degraded 機制）
    degraded = true;
  } else if (input.todayTrustNetBuy + input.todayForeignNetBuy < 0) {
    score = Math.min(score, config.sellCapScore);
  }

  // 5. margin-chasing 判定（PLAN §2.2）：突破當日法人淨賣超 且 這檔融資近期暴增（跟自己比）。
  //    !!! 不動 score !!! 只回一個布林讓呼叫端掛 warnings 標記。
  //    marginSurgePercentile 為 null（盤中拿不到 / 資料不足）→ 一律 false，不依賴 JS 的 `null > 80`
  //    隱式行為，靠前面的 `!== null` 明確擋掉。
  const bothTodayKnown =
    input.todayTrustNetBuy !== null && input.todayForeignNetBuy !== null;
  const todayNetSell = bothTodayKnown && input.todayTrustNetBuy! + input.todayForeignNetBuy! < 0;
  const marginChasing =
    input.marginSurgePercentile !== null &&
    input.marginSurgePercentile > config.marginChasing.surgePercentileThreshold &&
    todayNetSell;

  // 6. clip
  return { score: clip(score, 0, 100), degraded, marginChasing };
}

// ============================================================================
// 3.3 consecutiveAboveBand —— 「連續站上布林上軌天數」helper（階段判定依據）
// ============================================================================
//
// computeFirstBar 內部就是數這個（breakout-shared.ts:549-561），這裡抽成獨立 helper，
// run-signal-scan.ts 拿它打階段標籤（pre-breakout / breakout-day / extended）。
// computeFirstBar 本體不改（它有「使用者明確要求保留的 ≤2→50 / >2→20 緩衝」語意，PLAN 不動）。
//
// series[0] 是最新一筆（eod = 當日收盤；盤中 = 即時價或 h 代入 vs T-1 上軌），依日期新到舊排序。

export interface AboveBandState {
  /** series 有效、可判定 */
  ok: boolean;
  /** 最新一筆 close 是否 > 當筆 bollingerUpper */
  latestAboveBand: boolean;
  /** 從 series[0] 往回連續收在上軌上方的天數（series[0] 若站上算 1；未站上為 0） */
  consecutiveDays: number;
}

export function consecutiveAboveBand(
  series: { close: number; bollingerUpper: number | null }[],
): AboveBandState {
  if (series.length === 0 || series[0]!.bollingerUpper === null) {
    return { ok: false, latestAboveBand: false, consecutiveDays: 0 };
  }
  const latest = series[0]!;
  if (latest.close <= latest.bollingerUpper!) {
    return { ok: true, latestAboveBand: false, consecutiveDays: 0 };
  }
  let consecutiveDays = 0;
  for (const point of series) {
    if (point.bollingerUpper === null) break;
    if (point.close > point.bollingerUpper) consecutiveDays += 1;
    else break;
  }
  return { ok: true, latestAboveBand: true, consecutiveDays };
}

// ============================================================================
// 2.7 SignalScanConfig —— 統一 config
// ============================================================================

const B = DEFAULT_BREAKOUT_CONFIG;

export interface SignalScanConfig {
  gate: {
    minMarketCap: number; // 3_000_000_000（沿用 breakout）
    minVolumeShares: number; // 1_000_000（沿用 breakout）
    minAvgVolumeShares: number; // 500_000（沿用 accumulation，剔除死股）
    triggerVolumeRatio: number; // 2.0（只對 breakout-day / extended 進榜門檻套用，見 §3.3）
  };
  // 壓縮度曲線（§2.6：深度/時長權重對調）。pre-breakout 與 breakout 共用同一份。
  baseCurve: {
    depthWeight: number; // 0.4（原 breakout 預設 0.6，本管線對調）
    durationWeight: number; // 0.6（原 0.4）
    durationCapDays: number; // 40（不變）
  };
  // pre-breakout 階段合併（乘法）
  preBreakout: {
    chipWeights: { trust: number; otherInstitution: number }; // 0.7 / 0.3
    trustSubWeights: { buyFrequency: number; netRatio: number }; // 0.5 / 0.5
    techWeights: { squeeze: number; quietVolume: number }; // 0.5 / 0.5
    readinessFloor: number; // 0.5
    institutionalWindowDays: number; // 20
    squeezeVolumeWindowDays: number; // 5
    minInstitutionalDaysRatio: number; // 0.5
    minSqueezeVolumeDays: number; // 3
    baseMinHistoryDays: number; // 40
    neutralScore: number; // 50
  };
  // breakout-day / extended 階段合併（加權和，總和 1）
  breakout: {
    weights: {
      candleShape: number;
      volumeStrength: number;
      breakoutMargin: number;
      firstBar: number;
      base: number;
      proximityToHigh: number;
      relativeStrength: number;
      institutionalFlow: number; // 新
    };
    /** extended 首版跟 breakout-day 相同（空物件 = fallback 到 weights）；留欄位供日後分開調 */
    extendedWeights: Partial<SignalScanConfig["breakout"]["weights"]>;
    curves: {
      volumeStrength: { lowRatio: number; lowScore: number; highRatio: number; highScore: number };
      breakoutMargin: { kneePct: number }; // 只留 kneePct；penaltyPerPct/floor 新公式不讀
    };
    institutionalFlow: InstitutionalFlowConfig;
    // 視窗 / degraded 門檻沿用 breakout
    baseMaxWindowDays: number; // 240
    proximityShortWindow: number; // 60
    proximityLongWindow: number; // 240
    rsWindowDays: number; // 60
    firstBarLookbackDays: number; // 30
    baseMinHistoryDays: number; // 40
    naScore: number; // 50
  };
  staging: {
    /** firstBar 連續站上上軌 > N 天 → extended（沿用 firstBar 內部「> 2 天」語意，§3.3） */
    extendedAfterDays: number; // 2
  };
}

// 首版 breakout 權重：從現行 7 項（總和 1）各 ×0.90，勻出 institutionalFlow: 0.10。
const IF_WEIGHT = 0.1;
const BREAKOUT_WEIGHTS: SignalScanConfig["breakout"]["weights"] = {
  candleShape: B.score.weights.candleShape * (1 - IF_WEIGHT),
  volumeStrength: B.score.weights.volumeStrength * (1 - IF_WEIGHT),
  breakoutMargin: B.score.weights.breakoutMargin * (1 - IF_WEIGHT),
  firstBar: B.score.weights.firstBar * (1 - IF_WEIGHT),
  base: B.score.weights.base * (1 - IF_WEIGHT),
  proximityToHigh: B.score.weights.proximityToHigh * (1 - IF_WEIGHT),
  relativeStrength: B.score.weights.relativeStrength * (1 - IF_WEIGHT),
  institutionalFlow: IF_WEIGHT,
};

export const DEFAULT_INSTITUTIONAL_FLOW_CONFIG: InstitutionalFlowConfig = {
  lookbackDays: 5,
  trustWeight: 0.6,
  foreignWeight: 0.4,
  clipDivisor: 0.5,
  sellCapScore: 40,
  marginChasing: {
    lookbackDays: 5,
    historyWindowDays: 40,
    minHistoryDays: 20,
    surgePercentileThreshold: 80,
  },
};

export const DEFAULT_SIGNAL_CONFIG: SignalScanConfig = {
  gate: {
    minMarketCap: B.gate.minMarketCap,
    minVolumeShares: B.gate.minVolumeShares,
    minAvgVolumeShares: 500_000,
    triggerVolumeRatio: B.gate.triggerVolumeRatio,
  },
  baseCurve: {
    depthWeight: 0.4, // §2.6 對調
    durationWeight: 0.6,
    durationCapDays: B.score.curves.base.durationCapDays,
  },
  preBreakout: {
    chipWeights: { trust: 0.7, otherInstitution: 0.3 },
    trustSubWeights: { buyFrequency: 0.5, netRatio: 0.5 },
    techWeights: { squeeze: 0.5, quietVolume: 0.5 },
    readinessFloor: 0.5,
    institutionalWindowDays: 20,
    squeezeVolumeWindowDays: 5,
    minInstitutionalDaysRatio: 0.5,
    minSqueezeVolumeDays: 3,
    baseMinHistoryDays: 40,
    neutralScore: 50,
  },
  breakout: {
    weights: { ...BREAKOUT_WEIGHTS },
    extendedWeights: {},
    curves: {
      volumeStrength: { ...B.score.curves.volumeStrength },
      breakoutMargin: { kneePct: B.score.curves.breakoutMargin.kneePct },
    },
    institutionalFlow: { ...DEFAULT_INSTITUTIONAL_FLOW_CONFIG },
    baseMaxWindowDays: B.score.baseMaxWindowDays,
    proximityShortWindow: B.score.proximityShortWindow,
    proximityLongWindow: B.score.proximityLongWindow,
    rsWindowDays: B.score.rsWindowDays,
    firstBarLookbackDays: B.score.firstBarLookbackDays,
    baseMinHistoryDays: B.score.baseMinHistoryDays,
    naScore: B.score.naScore,
  },
  staging: {
    extendedAfterDays: 2,
  },
};

/** 深層合併：呼叫端只給想改的欄位。手寫展開，比照現有兩個 resolve 函式。 */
export function resolveSignalConfig(override?: DeepPartial<SignalScanConfig>): SignalScanConfig {
  const d = DEFAULT_SIGNAL_CONFIG;
  const g = override?.gate;
  const bc = override?.baseCurve;
  const pb = override?.preBreakout;
  const bo = override?.breakout;
  const st = override?.staging;
  return {
    gate: {
      minMarketCap: g?.minMarketCap ?? d.gate.minMarketCap,
      minVolumeShares: g?.minVolumeShares ?? d.gate.minVolumeShares,
      minAvgVolumeShares: g?.minAvgVolumeShares ?? d.gate.minAvgVolumeShares,
      triggerVolumeRatio: g?.triggerVolumeRatio ?? d.gate.triggerVolumeRatio,
    },
    baseCurve: {
      depthWeight: bc?.depthWeight ?? d.baseCurve.depthWeight,
      durationWeight: bc?.durationWeight ?? d.baseCurve.durationWeight,
      durationCapDays: bc?.durationCapDays ?? d.baseCurve.durationCapDays,
    },
    preBreakout: {
      chipWeights: {
        trust: pb?.chipWeights?.trust ?? d.preBreakout.chipWeights.trust,
        otherInstitution:
          pb?.chipWeights?.otherInstitution ?? d.preBreakout.chipWeights.otherInstitution,
      },
      trustSubWeights: {
        buyFrequency:
          pb?.trustSubWeights?.buyFrequency ?? d.preBreakout.trustSubWeights.buyFrequency,
        netRatio: pb?.trustSubWeights?.netRatio ?? d.preBreakout.trustSubWeights.netRatio,
      },
      techWeights: {
        squeeze: pb?.techWeights?.squeeze ?? d.preBreakout.techWeights.squeeze,
        quietVolume: pb?.techWeights?.quietVolume ?? d.preBreakout.techWeights.quietVolume,
      },
      readinessFloor: pb?.readinessFloor ?? d.preBreakout.readinessFloor,
      institutionalWindowDays:
        pb?.institutionalWindowDays ?? d.preBreakout.institutionalWindowDays,
      squeezeVolumeWindowDays:
        pb?.squeezeVolumeWindowDays ?? d.preBreakout.squeezeVolumeWindowDays,
      minInstitutionalDaysRatio:
        pb?.minInstitutionalDaysRatio ?? d.preBreakout.minInstitutionalDaysRatio,
      minSqueezeVolumeDays: pb?.minSqueezeVolumeDays ?? d.preBreakout.minSqueezeVolumeDays,
      baseMinHistoryDays: pb?.baseMinHistoryDays ?? d.preBreakout.baseMinHistoryDays,
      neutralScore: pb?.neutralScore ?? d.preBreakout.neutralScore,
    },
    breakout: {
      weights: {
        candleShape: bo?.weights?.candleShape ?? d.breakout.weights.candleShape,
        volumeStrength: bo?.weights?.volumeStrength ?? d.breakout.weights.volumeStrength,
        breakoutMargin: bo?.weights?.breakoutMargin ?? d.breakout.weights.breakoutMargin,
        firstBar: bo?.weights?.firstBar ?? d.breakout.weights.firstBar,
        base: bo?.weights?.base ?? d.breakout.weights.base,
        proximityToHigh: bo?.weights?.proximityToHigh ?? d.breakout.weights.proximityToHigh,
        relativeStrength: bo?.weights?.relativeStrength ?? d.breakout.weights.relativeStrength,
        institutionalFlow:
          bo?.weights?.institutionalFlow ?? d.breakout.weights.institutionalFlow,
      },
      extendedWeights: {
        ...d.breakout.extendedWeights,
        ...(bo?.extendedWeights as Partial<SignalScanConfig["breakout"]["weights"]> | undefined),
      },
      curves: {
        volumeStrength: {
          lowRatio:
            bo?.curves?.volumeStrength?.lowRatio ?? d.breakout.curves.volumeStrength.lowRatio,
          lowScore:
            bo?.curves?.volumeStrength?.lowScore ?? d.breakout.curves.volumeStrength.lowScore,
          highRatio:
            bo?.curves?.volumeStrength?.highRatio ?? d.breakout.curves.volumeStrength.highRatio,
          highScore:
            bo?.curves?.volumeStrength?.highScore ?? d.breakout.curves.volumeStrength.highScore,
        },
        breakoutMargin: {
          kneePct: bo?.curves?.breakoutMargin?.kneePct ?? d.breakout.curves.breakoutMargin.kneePct,
        },
      },
      institutionalFlow: {
        lookbackDays:
          bo?.institutionalFlow?.lookbackDays ?? d.breakout.institutionalFlow.lookbackDays,
        trustWeight:
          bo?.institutionalFlow?.trustWeight ?? d.breakout.institutionalFlow.trustWeight,
        foreignWeight:
          bo?.institutionalFlow?.foreignWeight ?? d.breakout.institutionalFlow.foreignWeight,
        clipDivisor:
          bo?.institutionalFlow?.clipDivisor ?? d.breakout.institutionalFlow.clipDivisor,
        sellCapScore:
          bo?.institutionalFlow?.sellCapScore ?? d.breakout.institutionalFlow.sellCapScore,
        marginChasing: {
          lookbackDays:
            bo?.institutionalFlow?.marginChasing?.lookbackDays ??
            d.breakout.institutionalFlow.marginChasing.lookbackDays,
          historyWindowDays:
            bo?.institutionalFlow?.marginChasing?.historyWindowDays ??
            d.breakout.institutionalFlow.marginChasing.historyWindowDays,
          minHistoryDays:
            bo?.institutionalFlow?.marginChasing?.minHistoryDays ??
            d.breakout.institutionalFlow.marginChasing.minHistoryDays,
          surgePercentileThreshold:
            bo?.institutionalFlow?.marginChasing?.surgePercentileThreshold ??
            d.breakout.institutionalFlow.marginChasing.surgePercentileThreshold,
        },
      },
      baseMaxWindowDays: bo?.baseMaxWindowDays ?? d.breakout.baseMaxWindowDays,
      proximityShortWindow: bo?.proximityShortWindow ?? d.breakout.proximityShortWindow,
      proximityLongWindow: bo?.proximityLongWindow ?? d.breakout.proximityLongWindow,
      rsWindowDays: bo?.rsWindowDays ?? d.breakout.rsWindowDays,
      firstBarLookbackDays: bo?.firstBarLookbackDays ?? d.breakout.firstBarLookbackDays,
      baseMinHistoryDays: bo?.baseMinHistoryDays ?? d.breakout.baseMinHistoryDays,
      naScore: bo?.naScore ?? d.breakout.naScore,
    },
    staging: {
      extendedAfterDays: st?.extendedAfterDays ?? d.staging.extendedAfterDays,
    },
  };
}

/** computeBase 需要的 curve 形狀。SignalScanConfig.baseCurve 直接吻合。 */
export function baseCurveFor(config: SignalScanConfig): {
  depthWeight: number;
  durationWeight: number;
  durationCapDays: number;
} {
  return config.baseCurve;
}
