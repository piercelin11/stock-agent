import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBreakoutMarginMonotone,
  computeInstitutionalFlow,
  computeMarginSurgePercentile,
  computeProximityToHigh,
  computeTrendReversal,
  computeSingleDayConcentration,
  classifyInstBackground,
  consecutiveAboveBand,
  resolveSignalConfig,
  DEFAULT_SIGNAL_CONFIG,
  DEFAULT_INSTITUTIONAL_FLOW_CONFIG,
} from "./index";

// 跑：pnpm tsx --test scripts/lib/signal-factors/factors.test.ts

// ---- computeBreakoutMarginMonotone（§2.5 單調遞增、無倒扣）----

test("breakoutMarginMonotone: 0% 乖離 → 40 分", () => {
  const s = computeBreakoutMarginMonotone(100, 100, { kneePct: 3 });
  assert.equal(s, 40);
});

test("breakoutMarginMonotone: 剛好 3% 乖離 → 100 分", () => {
  const s = computeBreakoutMarginMonotone(103, 100, { kneePct: 3 });
  assert.ok(Math.abs(s - 100) < 1e-9);
});

test("breakoutMarginMonotone: 1.5% 乖離 → 70 分（線性中點）", () => {
  const s = computeBreakoutMarginMonotone(101.5, 100, { kneePct: 3 });
  assert.ok(Math.abs(s - 70) < 1e-9);
});

test("breakoutMarginMonotone: 8% 乖離 → 100 分（不倒扣，舊公式會是 75）", () => {
  const s = computeBreakoutMarginMonotone(108, 100, { kneePct: 3 });
  assert.equal(s, 100);
});

test("breakoutMarginMonotone: 負乖離（收在上軌下）→ 40 分下限", () => {
  const s = computeBreakoutMarginMonotone(97, 100, { kneePct: 3 });
  assert.equal(s, 40);
});

test("breakoutMarginMonotone: 單調遞增（掃 0~15%）", () => {
  let prev = -Infinity;
  for (let pct = 0; pct <= 15; pct += 0.5) {
    const s = computeBreakoutMarginMonotone(100 * (1 + pct / 100), 100, { kneePct: 3 });
    assert.ok(s >= prev - 1e-9, `pct=${pct} s=${s} 比前一個 ${prev} 低`);
    prev = s;
  }
});

// ---- computeMarginSurgePercentile（PLAN §2.1 / §2.3）----

const MS_CFG = { lookbackDays: 5, historyWindowDays: 40, minHistoryDays: 20 };

test("marginSurge: 序列長度 < lookbackDays + 1 → null", () => {
  const r = computeMarginSurgePercentile([100, 101, 102, 103, 104], MS_CFG);
  assert.equal(r, null);
});

test("marginSurge: 母體有效樣本 < minHistoryDays → null", () => {
  // 25 筆 → today 用 [0]/[5]，母體 i=1..40 但只有 index 到 24 有值 → 母體 ~19 筆 < 20
  const series = Array.from({ length: 25 }, (_, i) => 1000 + i);
  const r = computeMarginSurgePercentile(series, MS_CFG);
  assert.equal(r, null);
});

test("marginSurge: 融資餘額一路平（變化率全 0）→ 嚴格小於 → 百分位 0（不誤觸發）", () => {
  const series = Array(50).fill(1000);
  const r = computeMarginSurgePercentile(series, MS_CFG);
  assert.equal(r, 0);
});

test("marginSurge: 最近 5 日大增、過去平緩 → 百分位接近 100", () => {
  // index 0..4 = 突破後暴衝；index 5.. = 平緩
  const series: number[] = [];
  for (let i = 0; i < 50; i++) {
    series.push(i < 5 ? 2000 - i * 10 : 1000); // 新到舊：前 5 筆遠高於後面
  }
  const r = computeMarginSurgePercentile(series, MS_CFG);
  assert.ok(r !== null && r >= 95, `r=${r}`);
});

test("marginSurge: past <= 0（歷史某筆融資歸零）→ 該筆跳過、不炸", () => {
  const series = Array.from({ length: 50 }, (_, i) => 1000 + i);
  series[30] = 0; // 造一筆歸零
  const r = computeMarginSurgePercentile(series, MS_CFG);
  assert.ok(r !== null && r >= 0 && r <= 100, `r=${r}`);
});

// ---- computeInstitutionalFlow ----

const IF = DEFAULT_INSTITUTIONAL_FLOW_CONFIG;

test("institutionalFlow: volumeMa20 缺 → 中性 50 + degraded", () => {
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [1000, 1000, 1000, 1000, 1000],
    foreignNetBuyNewestFirst: [1000, 1000, 1000, 1000, 1000],
    todayTrustNetBuy: 100,
    todayForeignNetBuy: 100,
    volumeMa20: null,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.score, 50);
  assert.equal(r.degraded, true);
  assert.equal(r.marginChasing, false);
});

test("institutionalFlow: 近窗資料不足一半 → 中性 + degraded", () => {
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [1000, 1000], // 只有 2 天，lookback 5，半窗 3
    foreignNetBuyNewestFirst: [1000, 1000],
    todayTrustNetBuy: 100,
    todayForeignNetBuy: 100,
    volumeMa20: 1_000_000,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.score, 50);
  assert.equal(r.degraded, true);
});

test("institutionalFlow: 投信外資都達均量 50% → 滿分 100", () => {
  // 近 5 日投信淨買超合計 = volumeMa20 × 0.5 → trustFlow = 100；外資同理
  const ma = 1_000_000;
  const perDay = (ma * 0.5) / 5;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: Array(5).fill(perDay),
    foreignNetBuyNewestFirst: Array(5).fill(perDay),
    todayTrustNetBuy: 1,
    todayForeignNetBuy: 1,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.ok(Math.abs(r.score - 100) < 1e-6, `score=${r.score}`);
  assert.equal(r.degraded, false);
});

test("institutionalFlow: 淨賣超（負）→ clip 到 0 分段，且突破當日淨賣超封頂 40", () => {
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [-500, -500, -500, -500, -500],
    foreignNetBuyNewestFirst: [-500, -500, -500, -500, -500],
    todayTrustNetBuy: -100,
    todayForeignNetBuy: -100,
    volumeMa20: 1_000_000,
    marginSurgePercentile: null,
    config: IF,
  });
  // 近窗負 → flow clip 到 0 → score 0，再 min(0, 40) = 0
  assert.equal(r.score, 0);
  assert.equal(r.degraded, false);
});

test("institutionalFlow: 近窗強但突破當日法人翻空 → 封頂 sellCapScore(40)", () => {
  const ma = 1_000_000;
  const perDay = (ma * 0.5) / 5;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: Array(5).fill(perDay),
    foreignNetBuyNewestFirst: Array(5).fill(perDay),
    todayTrustNetBuy: -50_000,
    todayForeignNetBuy: -50_000,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.score, 40);
  assert.equal(r.degraded, false);
});

test("institutionalFlow: 當日法人任一為 null（盤中）→ 不封頂、degraded=true", () => {
  const ma = 1_000_000;
  const perDay = (ma * 0.5) / 5;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: Array(5).fill(perDay),
    foreignNetBuyNewestFirst: Array(5).fill(perDay),
    todayTrustNetBuy: null,
    todayForeignNetBuy: null,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.ok(Math.abs(r.score - 100) < 1e-6);
  assert.equal(r.degraded, true);
});

// ---- computeInstitutionalFlow: marginChasing 輸出（PLAN §2.3）----

const IF_MS_INPUT = {
  trustNetBuyNewestFirst: Array(5).fill(50_000),
  foreignNetBuyNewestFirst: Array(5).fill(50_000),
  volumeMa20: 1_000_000,
  config: IF,
};

test("marginChasing: marginSurgePercentile = null → false（即使當日法人淨賣超）", () => {
  const r = computeInstitutionalFlow({
    ...IF_MS_INPUT,
    todayTrustNetBuy: -100_000,
    todayForeignNetBuy: -100_000,
    marginSurgePercentile: null,
  });
  assert.equal(r.marginChasing, false);
});

test("marginChasing: percentile 90 + 當日法人淨賣超 → true", () => {
  const r = computeInstitutionalFlow({
    ...IF_MS_INPUT,
    todayTrustNetBuy: -100_000,
    todayForeignNetBuy: -100_000,
    marginSurgePercentile: 90,
  });
  assert.equal(r.marginChasing, true);
});

test("marginChasing: percentile 90 + 當日法人淨買超 → false", () => {
  const r = computeInstitutionalFlow({
    ...IF_MS_INPUT,
    todayTrustNetBuy: 100_000,
    todayForeignNetBuy: 100_000,
    marginSurgePercentile: 90,
  });
  assert.equal(r.marginChasing, false);
});

test("marginChasing: percentile 50（< threshold 80）+ 當日法人淨賣超 → false", () => {
  const r = computeInstitutionalFlow({
    ...IF_MS_INPUT,
    todayTrustNetBuy: -100_000,
    todayForeignNetBuy: -100_000,
    marginSurgePercentile: 50,
  });
  assert.equal(r.marginChasing, false);
});

test("marginChasing: true 時 score 跟沒有 margin 輸入時完全一致（不動分數）", () => {
  const base = {
    trustNetBuyNewestFirst: Array(5).fill(50_000),
    foreignNetBuyNewestFirst: Array(5).fill(50_000),
    todayTrustNetBuy: -100_000,
    todayForeignNetBuy: -100_000,
    volumeMa20: 1_000_000,
    config: IF,
  };
  const withMs = computeInstitutionalFlow({ ...base, marginSurgePercentile: 95 });
  const withoutMs = computeInstitutionalFlow({ ...base, marginSurgePercentile: null });
  assert.equal(withMs.score, withoutMs.score);
  assert.equal(withMs.marginChasing, true);
  assert.equal(withoutMs.marginChasing, false);
});

// ---- computeInstitutionalFlow: PLAN §4.2 中繼值回傳 ----

test("institutionalFlow §4.2: trustRatio / foreignRatio = 近窗淨買超合計 ÷ volumeMa20", () => {
  const ma = 1_000_000;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [100_000, 100_000, 50_000, 0, 0], // 合計 250_000 → 0.25
    foreignNetBuyNewestFirst: [-40_000, -10_000, 0, 0, 0], // 合計 -50_000 → -0.05
    todayTrustNetBuy: 1,
    todayForeignNetBuy: -1,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.ok(Math.abs(r.trustRatio - 0.25) < 1e-9, `trustRatio=${r.trustRatio}`);
  assert.ok(Math.abs(r.foreignRatio - -0.05) < 1e-9, `foreignRatio=${r.foreignRatio}`);
});

test("institutionalFlow §4.2: volumeMa20 缺 → trustRatio / foreignRatio 回 0，todayXxxDir 照常算", () => {
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [1000, 1000, 1000, 1000, 1000],
    foreignNetBuyNewestFirst: [1000, 1000, 1000, 1000, 1000],
    todayTrustNetBuy: 500,
    todayForeignNetBuy: -500,
    volumeMa20: null,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.trustRatio, 0);
  assert.equal(r.foreignRatio, 0);
  assert.equal(r.todayTrustDir, 1);
  assert.equal(r.todayForeignDir, -1);
});

test("institutionalFlow §4.2: todayXxxDir 對 null / 正 / 負 / 0 四種輸入", () => {
  const mk = (t: number | null, f: number | null) =>
    computeInstitutionalFlow({
      trustNetBuyNewestFirst: Array(5).fill(1000),
      foreignNetBuyNewestFirst: Array(5).fill(1000),
      todayTrustNetBuy: t,
      todayForeignNetBuy: f,
      volumeMa20: 1_000_000,
      marginSurgePercentile: null,
      config: IF,
    });
  assert.equal(mk(null, null).todayTrustDir, null);
  assert.equal(mk(null, null).todayForeignDir, null);
  assert.equal(mk(123, -1).todayTrustDir, 1);
  assert.equal(mk(123, -1).todayForeignDir, -1);
  assert.equal(mk(0, 0).todayTrustDir, 0);
  assert.equal(mk(0, 0).todayForeignDir, 0);
});

// ---- computeProximityToHigh: PLAN §4.3 中繼值回傳 ----

test("proximityToHigh §4.3: shortScore + longScore 一致於舊 score * 2（等價性）", () => {
  const history = Array.from({ length: 240 }, (_, i) => 90 + (i % 20)); // 90~109 起伏
  const r = computeProximityToHigh(105, history, 60, 240);
  assert.ok(
    Math.abs(r.shortScore * 0.5 + r.longScore * 0.5 - r.score) < 1e-9,
    `score=${r.score} short=${r.shortScore} long=${r.longScore}`,
  );
});

test("proximityToHigh §4.3: shortPct / longPct <= 0，收在窗內新高 → 0", () => {
  const history = Array.from({ length: 240 }, () => 80); // 全部 80
  const r = computeProximityToHigh(100, history, 60, 240); // 100 是新高
  assert.equal(r.shortPct, 0);
  assert.equal(r.longPct, 0);
  const r2 = computeProximityToHigh(90, history, 60, 240); // 距高點 90 有 (90-90)/90=0（因為 max 含 referenceClose）
  assert.ok(r2.shortPct <= 0);
});

test("proximityToHigh §4.3: degraded 早退分支 → 新欄位預設值", () => {
  const r = computeProximityToHigh(100, [90, 91, 92], 60, 240); // < shortWindowDays
  assert.equal(r.degraded, true);
  assert.equal(r.score, 50);
  assert.equal(r.shortScore, 50);
  assert.equal(r.longScore, 50);
  assert.equal(r.shortPct, 0);
  assert.equal(r.longPct, 0);
});

test("proximityToHigh §4.3: 收盤明顯低於歷史高點 → shortPct 為負", () => {
  const history = [...Array(60).fill(200), ...Array(180).fill(100)];
  const r = computeProximityToHigh(150, history, 60, 240);
  // 短窗 max = 200，(150-200)/200 = -25%
  assert.ok(Math.abs(r.shortPct - -25) < 1e-9, `shortPct=${r.shortPct}`);
});

// ---- consecutiveAboveBand ----

test("consecutiveAboveBand: 空序列 → ok=false", () => {
  const r = consecutiveAboveBand([]);
  assert.equal(r.ok, false);
  assert.equal(r.latestAboveBand, false);
});

test("consecutiveAboveBand: 最新 close ≤ 上軌 → latestAboveBand=false, consecutiveDays=0", () => {
  const r = consecutiveAboveBand([
    { close: 99, bollingerUpper: 100 },
    { close: 101, bollingerUpper: 100 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.latestAboveBand, false);
  assert.equal(r.consecutiveDays, 0);
});

test("consecutiveAboveBand: 連 3 天站上 → consecutiveDays=3", () => {
  const r = consecutiveAboveBand([
    { close: 105, bollingerUpper: 100 },
    { close: 104, bollingerUpper: 100 },
    { close: 103, bollingerUpper: 100 },
    { close: 98, bollingerUpper: 100 },
  ]);
  assert.equal(r.latestAboveBand, true);
  assert.equal(r.consecutiveDays, 3);
});

test("consecutiveAboveBand: 中途 bollingerUpper null 截斷", () => {
  const r = consecutiveAboveBand([
    { close: 105, bollingerUpper: 100 },
    { close: 104, bollingerUpper: null },
    { close: 103, bollingerUpper: 100 },
  ]);
  assert.equal(r.consecutiveDays, 1);
});

// ---- resolveSignalConfig ----

test("resolveSignalConfig: 無 override = DEFAULT", () => {
  const c = resolveSignalConfig();
  assert.deepEqual(c, DEFAULT_SIGNAL_CONFIG);
});

test("resolveSignalConfig: baseCurve 預設深度 0.4 / 時長 0.6（§2.6 對調）", () => {
  const c = resolveSignalConfig();
  assert.equal(c.baseCurve.depthWeight, 0.4);
  assert.equal(c.baseCurve.durationWeight, 0.6);
});

test("resolveSignalConfig: breakout.weights 總和為 1", () => {
  const c = resolveSignalConfig();
  const sum = Object.values(c.breakout.weights).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
});

test("resolveSignalConfig: institutionalFlow 權重 = 0.10", () => {
  const c = resolveSignalConfig();
  assert.equal(c.breakout.weights.institutionalFlow, 0.1);
});

test("resolveSignalConfig: 部分 override 只改指定欄位", () => {
  const c = resolveSignalConfig({ gate: { minMarketCap: 999 }, staging: { extendedAfterDays: 5 } });
  assert.equal(c.gate.minMarketCap, 999);
  assert.equal(c.gate.minVolumeShares, DEFAULT_SIGNAL_CONFIG.gate.minVolumeShares);
  assert.equal(c.staging.extendedAfterDays, 5);
});

test("resolveSignalConfig: PLAN 8 新欄位預設值 + override 只改指定欄位", () => {
  const d = resolveSignalConfig();
  assert.deepEqual(d.preBreakout.trendReversal, { recentDays: 5, priorDays: 15, minDataDays: 12 });
  assert.deepEqual(d.preBreakout.concentration, {
    thresholdRatio: 0.5,
    minWindowDays: 10,
    minTotalNetBuy: 0,
  });
  assert.equal(d.breakout.institutionalFlow.crowdedThreshold, 0.8);
  assert.deepEqual(d.breakout.institutionalFlow.background, {
    recentDays: 5,
    priorDays: 15,
    activityEpsilon: 0.02,
    minDataDays: 12,
  });

  const c = resolveSignalConfig({
    preBreakout: { trendReversal: { recentDays: 7 }, concentration: { thresholdRatio: 0.6 } },
    breakout: { institutionalFlow: { crowdedThreshold: 0.9, background: { minDataDays: 15 } } },
  });
  assert.equal(c.preBreakout.trendReversal.recentDays, 7);
  assert.equal(c.preBreakout.trendReversal.priorDays, 15); // 未 override → 預設
  assert.equal(c.preBreakout.concentration.thresholdRatio, 0.6);
  assert.equal(c.preBreakout.concentration.minWindowDays, 10);
  assert.equal(c.breakout.institutionalFlow.crowdedThreshold, 0.9);
  assert.equal(c.breakout.institutionalFlow.background.minDataDays, 15);
  assert.equal(c.breakout.institutionalFlow.background.recentDays, 5);
});

// ============================================================================
// PLAN 8 §2：computeTrendReversal
// ============================================================================

const TR_CFG = { recentDays: 5, priorDays: 15, minDataDays: 12 };

test("trendReversal: 序列長度 < minDataDays → false", () => {
  assert.equal(computeTrendReversal(new Array(10).fill(1000), TR_CFG), false);
});

test("trendReversal: 前段買、近段轉賣 → true", () => {
  const series = [-500, -500, -500, -500, -500, ...new Array(15).fill(1000)];
  assert.equal(computeTrendReversal(series, TR_CFG), true);
});

test("trendReversal: 兩段都在賣（一路賣，不是「轉」）→ false", () => {
  assert.equal(computeTrendReversal(new Array(20).fill(-500), TR_CFG), false);
});

test("trendReversal: 兩段都在買（正常累積）→ false", () => {
  assert.equal(computeTrendReversal(new Array(20).fill(1000), TR_CFG), false);
});

test("trendReversal: 近段剛好打平（recentSum === 0）→ false", () => {
  const series = [100, -100, 50, -50, 0, ...new Array(15).fill(1000)];
  assert.equal(computeTrendReversal(series, TR_CFG), false);
});

test("trendReversal: 前段打平（priorSum === 0）+ 近段賣 → false", () => {
  // 前 15 天正負相抵合計 0
  const prior15 = [3000, -3000, 2000, -2000, 1000, -1000, 500, -500, 0, 0, 0, 0, 0, 0, 0];
  const series = [-500, -500, -500, -500, -500, ...prior15];
  assert.equal(prior15.reduce((s, v) => s + v, 0), 0);
  assert.equal(computeTrendReversal(series, TR_CFG), false);
});

test("trendReversal: 序列恰 12 筆（= minDataDays），近 5 賣前 7 買 → true", () => {
  const series = [-100, -100, -100, -100, -100, 500, 500, 500, 500, 500, 500, 500];
  assert.equal(series.length, 12);
  assert.equal(computeTrendReversal(series, TR_CFG), true);
});

// ============================================================================
// PLAN 8 §4：computeInstitutionalFlow 的 institutionCrowded
// ============================================================================

test("institutionCrowded: trustRatio + foreignRatio 遠超 0.8 → true", () => {
  const ma = 1_000_000;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [ma * 0.6, 0, 0, 0, 0],
    foreignNetBuyNewestFirst: [ma * 0.5, 0, 0, 0, 0],
    todayTrustNetBuy: 100,
    todayForeignNetBuy: 100,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.institutionCrowded, true);
});

test("institutionCrowded: sum 剛好 0.8（用嚴格大於）→ false", () => {
  const ma = 1_000_000;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [ma * 0.4, 0, 0, 0, 0],
    foreignNetBuyNewestFirst: [ma * 0.4, 0, 0, 0, 0],
    todayTrustNetBuy: 100,
    todayForeignNetBuy: 100,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.institutionCrowded, false);
});

test("institutionCrowded: sum < 0.8（正常濃度）→ false", () => {
  const ma = 1_000_000;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [ma * 0.2, 0, 0, 0, 0],
    foreignNetBuyNewestFirst: [ma * 0.2, 0, 0, 0, 0],
    todayTrustNetBuy: 100,
    todayForeignNetBuy: 100,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.institutionCrowded, false);
});

test("institutionCrowded: volumeMa20 缺（degraded 早退）→ false", () => {
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [5_000_000, 0, 0, 0, 0],
    foreignNetBuyNewestFirst: [5_000_000, 0, 0, 0, 0],
    todayTrustNetBuy: 100,
    todayForeignNetBuy: 100,
    volumeMa20: null,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.institutionCrowded, false);
});

test("institutionCrowded: 法人淨賣超（負 ratio 之和）→ false", () => {
  const ma = 1_000_000;
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [-ma * 0.5, 0, 0, 0, 0],
    foreignNetBuyNewestFirst: [-ma * 0.5, 0, 0, 0, 0],
    todayTrustNetBuy: -100,
    todayForeignNetBuy: -100,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  assert.equal(r.institutionCrowded, false);
});

test("institutionCrowded: true 時 score 與手算一致（不動分數）", () => {
  const ma = 1_000_000;
  // 投信 5 日合計 = ma*0.6、外資 = ma*0.5 → sum 1.1 > 0.8；當日淨買超（不觸發 sellCap）
  const r = computeInstitutionalFlow({
    trustNetBuyNewestFirst: [ma * 0.6, 0, 0, 0, 0],
    foreignNetBuyNewestFirst: [ma * 0.5, 0, 0, 0, 0],
    todayTrustNetBuy: 100,
    todayForeignNetBuy: 100,
    volumeMa20: ma,
    marginSurgePercentile: null,
    config: IF,
  });
  // trustFlow: clip(0.6, 0, 0.5) * 200 = 100；foreignFlow: clip(0.5, 0, 0.5) * 200 = 100
  // score = 100 * 0.6 + 100 * 0.4 = 100
  assert.equal(r.institutionCrowded, true);
  assert.equal(r.score, 100);
});

// ============================================================================
// PLAN 8 §5：computeSingleDayConcentration
// ============================================================================

const CC_CFG = { thresholdRatio: 0.5, minWindowDays: 10, minTotalNetBuy: 0 };

test("concentration: 序列長度 < minWindowDays → false", () => {
  assert.equal(computeSingleDayConcentration(new Array(8).fill(1000), CC_CFG), false);
});

test("concentration: 單日爆量（1 天 8000、其他 19 天各 100）→ true", () => {
  const series = [8000, ...new Array(19).fill(100)];
  assert.equal(computeSingleDayConcentration(series, CC_CFG), true);
});

test("concentration: 分散累積（20 天各 500）→ false", () => {
  assert.equal(computeSingleDayConcentration(new Array(20).fill(500), CC_CFG), false);
});

test("concentration: 窗內完全沒買超（全負）→ false", () => {
  assert.equal(computeSingleDayConcentration(new Array(20).fill(-500), CC_CFG), false);
});

test("concentration: 單日佔比剛好 0.5（用嚴格大於）→ false", () => {
  const series = [1000, 1000, 0, 0, 0, 0, 0, 0, 0, 0];
  // totalPositive = 2000, maxSingleDay = 1000 → 0.5，不 > 0.5
  assert.equal(computeSingleDayConcentration(series, CC_CFG), false);
});

test("concentration: 有大賣日壓低淨買超但分母用總正買超 → 仍正確（false）", () => {
  const series = [5000, -8000, 1000, 1000, 500, 500, 500, 500, 500, 500];
  // totalPositive = 5000+1000+1000+3000 = 10000, maxSingleDay 5000 / 10000 = 0.5 → false
  assert.equal(computeSingleDayConcentration(series, CC_CFG), false);
});

test("concentration: 單日佔比 ~0.58 + 有賣日 → true", () => {
  const series = [7000, -3000, 1000, 500, 500, 500, 500, 500, 500, 500];
  // totalPositive = 7000 + 1000 + 4000 = 12000, 7000/12000 ≈ 0.583 → true
  assert.equal(computeSingleDayConcentration(series, CC_CFG), true);
});

// ============================================================================
// PLAN 8 §6：classifyInstBackground
// ============================================================================

const BG_CFG = { recentDays: 5, priorDays: 15, activityEpsilon: 0.02, minDataDays: 12 };
const BG_MA = 1_000_000;

test("instBackground: 資料不足（< minDataDays）→ null", () => {
  assert.equal(classifyInstBackground(new Array(10).fill(1000), BG_MA, BG_CFG), null);
});

test("instBackground: volumeMa20 缺 → null", () => {
  assert.equal(classifyInstBackground(new Array(20).fill(1000), null, BG_CFG), null);
});

test("instBackground: 前段在買 → positioned-early", () => {
  assert.equal(
    classifyInstBackground(new Array(20).fill(5000), BG_MA, BG_CFG),
    "positioned-early",
  );
});

test("instBackground: 前段幾乎無動作 + 近段在買 → fresh-entry", () => {
  const series = [8000, 8000, 8000, 8000, 8000, ...new Array(15).fill(0)];
  assert.equal(classifyInstBackground(series, BG_MA, BG_CFG), "fresh-entry");
});

test("instBackground: 前段小賣（活動高於 epsilon）+ 近段買 → null", () => {
  const series = [8000, 8000, 8000, 8000, 8000, ...new Array(15).fill(-3000)];
  // priorSum -45000, priorActivity 0.045 > 0.02, priorSum 不 > 0 → null
  assert.equal(classifyInstBackground(series, BG_MA, BG_CFG), null);
});

test("instBackground: 前段無動作但近段也沒買 → null", () => {
  const series = [-1000, -1000, -1000, -1000, -1000, ...new Array(15).fill(0)];
  assert.equal(classifyInstBackground(series, BG_MA, BG_CFG), null);
});

test("instBackground: 前段活動剛好 = epsilon（邊界，用 <=）+ 近段買 → fresh-entry", () => {
  // priorSum 必須 <= 0（否則走 positioned-early），且 |priorSum| / MA 恰 = 0.02
  // → priorSum = -20000（前段小額淨賣、活動量剛好在門檻上）
  const prior15 = [-20000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const series = [3000, 3000, 3000, 3000, 3000, ...prior15];
  assert.equal(Math.abs(prior15.reduce((s, v) => s + v, 0)) / BG_MA, 0.02);
  assert.equal(classifyInstBackground(series, BG_MA, BG_CFG), "fresh-entry");
});
