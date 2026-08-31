import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBreakoutMarginMonotone,
  computeInstitutionalFlow,
  computeMarginSurgePercentile,
  consecutiveAboveBand,
  resolveSignalConfig,
  DEFAULT_SIGNAL_CONFIG,
  DEFAULT_INSTITUTIONAL_FLOW_CONFIG,
} from "./signal-factors";

// 跑：pnpm tsx --test scripts/lib/signal-factors.test.ts

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
