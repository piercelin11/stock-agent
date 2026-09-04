// 統一 config（ROADMAP 4.5.3 / PLAN §2.7）—— SignalScanConfig / DEFAULT_SIGNAL_CONFIG / resolveSignalConfig。
//
// 三處刻意偏離舊 breakout 預設（PLAN §2.7 步驟 260）：
//   1. baseCurve 深度/時長 = 0.4 / 0.6（舊 breakout 是 0.6 / 0.4）—— §2.6
//   2. breakoutMargin 改單調遞增，penaltyPerPct / floor 不再生效 —— §2.5
//   3. breakout.weights 7 項勻出 institutionalFlow 的份額（總和維持 1）

import type { DeepPartial } from "../types";
import { DEFAULT_BREAKOUT_CONFIG } from "./breakout";
import type { InstitutionalFlowConfig } from "./institutional";
import type { TrendReversalConfig, ConcentrationConfig } from "./accumulation";

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
    // PLAN 8：籌碼面觀察標籤（setup 階段 warnings）。純標記、不動 setup 合成分數。
    trendReversal: TrendReversalConfig; // §2：{ recentDays: 5, priorDays: 15, minDataDays: 12 }
    concentration: ConcentrationConfig; // §5：{ thresholdRatio: 0.5, minWindowDays: 10, minTotalNetBuy: 0 }
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
  // PLAN 8 §4：法人濃度過高門檻（未校準，見 PLAN 8 §14）。
  crowdedThreshold: 0.8,
  // PLAN 8 §6：法人背景中性分類參數（未校準）。
  background: {
    recentDays: 5,
    priorDays: 15,
    activityEpsilon: 0.02,
    minDataDays: 12,
  },
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
    // PLAN 8（未校準，見 §14）：recentDays + priorDays 應 = institutionalWindowDays(20)
    trendReversal: { recentDays: 5, priorDays: 15, minDataDays: 12 },
    concentration: { thresholdRatio: 0.5, minWindowDays: 10, minTotalNetBuy: 0 },
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
      trendReversal: {
        recentDays: pb?.trendReversal?.recentDays ?? d.preBreakout.trendReversal.recentDays,
        priorDays: pb?.trendReversal?.priorDays ?? d.preBreakout.trendReversal.priorDays,
        minDataDays: pb?.trendReversal?.minDataDays ?? d.preBreakout.trendReversal.minDataDays,
      },
      concentration: {
        thresholdRatio:
          pb?.concentration?.thresholdRatio ?? d.preBreakout.concentration.thresholdRatio,
        minWindowDays:
          pb?.concentration?.minWindowDays ?? d.preBreakout.concentration.minWindowDays,
        minTotalNetBuy:
          pb?.concentration?.minTotalNetBuy ?? d.preBreakout.concentration.minTotalNetBuy,
      },
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
        crowdedThreshold:
          bo?.institutionalFlow?.crowdedThreshold ??
          d.breakout.institutionalFlow.crowdedThreshold,
        background: {
          recentDays:
            bo?.institutionalFlow?.background?.recentDays ??
            d.breakout.institutionalFlow.background.recentDays,
          priorDays:
            bo?.institutionalFlow?.background?.priorDays ??
            d.breakout.institutionalFlow.background.priorDays,
          activityEpsilon:
            bo?.institutionalFlow?.background?.activityEpsilon ??
            d.breakout.institutionalFlow.background.activityEpsilon,
          minDataDays:
            bo?.institutionalFlow?.background?.minDataDays ??
            d.breakout.institutionalFlow.background.minDataDays,
        },
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
