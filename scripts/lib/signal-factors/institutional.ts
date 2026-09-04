// 三大法人流向 + margin-chasing 警示（ROADMAP 4.5.3 / PLAN §2.1–2.3）。
// 全新因子，不動舊 breakout / accumulation 評分。

import { clip } from "./util";

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

// ============================================================================
// 【設計：突破階段的 institutionalFlow 刻意只採「投信 + 外資」，排除自營商】
//
// 醞釀階段（accumulation.ts 的 computeOtherInstitutionRatio）用「外資 + 自營」是 20 日窗、看長期累積，
// 自營的方向雜訊會被時間拉長攤平。
//
// 但突破階段 computeInstitutionalFlow 是 lookbackDays(5) 短窗、且要判「突破當日」單日方向——
// 自營商當日買賣有大量「避險性交易」（發行權證 / 選擇權後的 delta hedging），跟「看多這檔股票」
// 無關卻會灌進淨買賣超數字。5 日短窗下這種噪音佔比過高、訊噪比不足，會讓「今日方向」判定失真。
// 故突破階段只採 trust(投信) + foreign(外資) 兩者。
//
// ⚠ 不要為了「跟醞釀階段對稱」而把自營加回來——兩個階段的窗長與判定目的不同，對稱不是目標。
// （PLAN 8 §7）
// ============================================================================

export interface InstitutionalFlowConfig {
  lookbackDays: number; // 5（近 5 個交易日）
  trustWeight: number; // 0.6（投信權重 > 外資）
  foreignWeight: number; // 0.4
  /** 正規化：(近 lookbackDays 日淨買超 ÷ volumeMa20) 落在 [0, clipDivisor] → 線性映射 0~100 */
  clipDivisor: number; // 0.5
  /** 突破當日法人「淨賣超」→ 分數封頂在此值（類似 computeCandleShape 收黑封頂） */
  sellCapScore: number; // 40
  /**
   * PLAN 8 §4：法人濃度過高門檻。(trustRatio + foreignRatio) > 此值 → institutionCrowded。
   * **不動 score**——只讓函式多回一個布林，由呼叫端掛 SignalResult.warnings 標記。
   * 與 sellCapScore 的封頂邏輯同一把尺（兩個 ratio 之和）：sellCap 管「法人已反手」，
   * crowded 管「法人尚未反手、但濃度已過高」，互補。
   */
  crowdedThreshold: number; // 0.8
  /** PLAN 8 §6：classifyInstBackground（中性背景分類，非風險）的參數。 */
  background: {
    recentDays: number; // 5
    priorDays: number; // 15
    activityEpsilon: number; // 0.02（前段「淨買超合計 ÷ volumeMa20」絕對值 <= 此值 → 視為「前段無動作」）
    minDataDays: number; // 12（資料不足 → instBackground = null）
  };
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
}): {
  score: number;
  degraded: boolean;
  marginChasing: boolean;
  // PLAN 8 §4：(trustRatio + foreignRatio) > config.crowdedThreshold。不動 score，只回布林。
  institutionCrowded: boolean;
  // PLAN §4.2：多回已算好的中繼值給前端 diverging bar 用（不動 score / degraded / marginChasing）。
  trustRatio: number; // 近 lookbackDays 日投信淨買超合計 ÷ volumeMa20（volumeMa20 缺 → 0）
  foreignRatio: number; // 同上，外資
  todayTrustDir: -1 | 0 | 1 | null; // sign(todayTrustNetBuy)；傳入 null → null
  todayForeignDir: -1 | 0 | 1 | null;
} {
  const { config } = input;
  const halfWindow = Math.ceil(config.lookbackDays / 2);

  const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const todayTrustDir: -1 | 0 | 1 | null =
    input.todayTrustNetBuy === null ? null : sign(input.todayTrustNetBuy);
  const todayForeignDir: -1 | 0 | 1 | null =
    input.todayForeignNetBuy === null ? null : sign(input.todayForeignNetBuy);

  // 1. volumeMa20 缺 / 近 lookbackDays 資料不足一半 → 中性
  const trustSeries = input.trustNetBuyNewestFirst.slice(0, config.lookbackDays);
  const foreignSeries = input.foreignNetBuyNewestFirst.slice(0, config.lookbackDays);
  const dataDays = Math.min(trustSeries.length, foreignSeries.length);
  const trustSum = trustSeries.reduce((s, v) => s + v, 0);
  const foreignSum = foreignSeries.reduce((s, v) => s + v, 0);
  if (input.volumeMa20 === null || input.volumeMa20 <= 0 || dataDays < halfWindow) {
    return {
      score: 50,
      degraded: true,
      marginChasing: false,
      institutionCrowded: false, // PLAN 8 §4：degraded 早退 → 恆 false
      trustRatio: 0,
      foreignRatio: 0,
      todayTrustDir,
      todayForeignDir,
    };
  }

  const trustRatio = trustSum / input.volumeMa20;
  const foreignRatio = foreignSum / input.volumeMa20;

  // 2. 近窗淨買超 ÷ volumeMa20 → clip [0, clipDivisor] → ×(100/clipDivisor) → 0~100
  const toFlowScore = (sum: number): number => {
    const ratio = sum / input.volumeMa20!;
    return clip(ratio, 0, config.clipDivisor) * (100 / config.clipDivisor);
  };
  const trustFlow = toFlowScore(trustSum);
  const foreignFlow = toFlowScore(foreignSum);

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

  // 6. PLAN 8 §4：法人濃度過高（近 lookbackDays 日淨買超佔均量比例過大）→ 散戶籌碼淺、體質脆弱。
  //    !!! 不動 score !!! 只回布林。用「兩個 ratio 之和」與 sellCapScore 的封頂邏輯同一把尺。
  //    degraded 早退分支（volumeMa20 缺 / 近窗不足）已提前 return，該處 institutionCrowded 恆 false。
  //    嚴格大於：sum 恰 = crowdedThreshold 不觸發（濃度是「買方濃度」，負 ratio 之和不會命中）。
  const institutionCrowded = trustRatio + foreignRatio > config.crowdedThreshold;

  // 7. clip
  return {
    score: clip(score, 0, 100),
    degraded,
    marginChasing,
    institutionCrowded,
    trustRatio,
    foreignRatio,
    todayTrustDir,
    todayForeignDir,
  };
}

// ============================================================================
// PLAN 8 §6：classifyInstBackground —— 突破階段法人背景（中性分類，非風險）
// ============================================================================
//
// 比較近 recentDays 日 vs 前 priorDays 日投信淨買超方向（合計仍是 recentDays + priorDays 日窗）：
//   positioned-early：前段淨買超 > 0（過去 20 日持續佈局，有備而來）
//   fresh-entry     ：前段「淨買超 ÷ volumeMa20」絕對值 <= activityEpsilon（前段沒動作）
//                     且近段 > 0（剛進場追突破）
//   其他 / 資料不足  ：null（前端不渲染）
// 純中性背景資訊，不進 warnings、不動 score。
// （positioned-early 判定放在 fresh-entry 之前——前段在買就算早佈局，不管前段活躍度。）

export interface InstBackgroundConfig {
  recentDays: number; // 5
  priorDays: number; // 15
  activityEpsilon: number; // 0.02
  minDataDays: number; // 12
}

export function classifyInstBackground(
  trustNetBuyNewestFirst: number[],
  volumeMa20: number | null,
  config: InstBackgroundConfig,
): "positioned-early" | "fresh-entry" | null {
  const { recentDays, priorDays, activityEpsilon, minDataDays } = config;
  const n = trustNetBuyNewestFirst.length;
  if (n < minDataDays || volumeMa20 === null || volumeMa20 <= 0) return null;

  const recent = trustNetBuyNewestFirst.slice(0, recentDays);
  const prior = trustNetBuyNewestFirst.slice(recentDays, recentDays + priorDays);
  if (recent.length === 0 || prior.length === 0) return null;

  const recentSum = recent.reduce((s, v) => s + v, 0);
  const priorSum = prior.reduce((s, v) => s + v, 0);
  const priorActivity = Math.abs(priorSum) / volumeMa20;

  if (priorSum > 0) return "positioned-early";
  if (priorActivity <= activityEpsilon && recentSum > 0) return "fresh-entry";
  return null;
}
