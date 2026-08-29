import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBacktestStats,
  type CandidatePick,
  type ForwardReturnLookup,
} from "./backtest-stats";

// 專案首個單測檔（PLAN §6.3）。用 node:test + tsx，零新依賴。
// 跑：pnpm tsx --test scripts/lib/backtest-stats.test.ts

/** 用 plain object map 建一個 ForwardReturnLookup。 */
function lookup(
  data: Record<
    string,
    { ret: Record<number, number | null>; benchmarkRet: Record<number, number | null> }
  >,
): ForwardReturnLookup {
  return {
    get(date, code) {
      return data[`${date}|${code}`];
    },
  };
}

test("hitRate / avgReturn / medianReturn / winRate / profitFactor 手算對齊", () => {
  const picks: CandidatePick[] = [
    { date: "2025-01-06", code: "A", score: 90, rank: 1 },
    { date: "2025-01-06", code: "B", score: 80, rank: 2 },
    { date: "2025-01-06", code: "C", score: 70, rank: 3 },
  ];
  const fr = lookup({
    "2025-01-06|A": { ret: { 5: 10 }, benchmarkRet: { 5: 2 } }, // 勝、贏 benchmark
    "2025-01-06|B": { ret: { 5: -4 }, benchmarkRet: { 5: 2 } }, // 負、輸 benchmark
    "2025-01-06|C": { ret: { 5: 6 }, benchmarkRet: { 5: 8 } }, // 勝、輸 benchmark
  });

  const s = computeBacktestStats(picks, fr, { horizons: [5], quarterBuckets: false });
  const h = s.overall[5]!;

  assert.equal(h.n, 3);
  // ret > 0：A、C → 2/3
  assert.ok(Math.abs(h.winRate - 2 / 3) < 1e-12);
  // ret > benchmark：只有 A → 1/3
  assert.ok(Math.abs(h.hitRate - 1 / 3) < 1e-12);
  // avg(10, -4, 6) = 4
  assert.ok(Math.abs(h.avgReturn - 4) < 1e-12);
  // median(排序 -4, 6, 10) = 6
  assert.ok(Math.abs(h.medianReturn - 6) < 1e-12);
  // profitFactor = (10 + 6) / |-4| = 4
  assert.ok(Math.abs(h.profitFactor - 4) < 1e-12);
  // avgExcess = avg(10-2, -4-2, 6-8) = avg(8, -6, -2) = 0
  assert.ok(Math.abs(h.avgExcessReturn - 0) < 1e-12);
});

test("retN 為 null 的 pick：不進該 horizon 分母、不影響其他 horizon", () => {
  const picks: CandidatePick[] = [
    { date: "2025-02-03", code: "A", score: 50, rank: 1 },
    { date: "2025-02-03", code: "B", score: 40, rank: 2 },
  ];
  const fr = lookup({
    "2025-02-03|A": { ret: { 5: 3, 20: null }, benchmarkRet: { 5: 1, 20: 1 } },
    "2025-02-03|B": { ret: { 5: -1, 20: 9 }, benchmarkRet: { 5: 1, 20: 1 } },
  });

  const s = computeBacktestStats(picks, fr, { horizons: [5, 20], quarterBuckets: false });
  assert.equal(s.overall[5]!.n, 2);
  assert.equal(s.overall[20]!.n, 1); // A 的 ret20 是 null → 只剩 B
  assert.ok(Math.abs(s.overall[20]!.avgReturn - 9) < 1e-12);
});

test("maxDrawdown：已知累積曲線 (+10, -5, +3, -8)", () => {
  const picks: CandidatePick[] = [
    { date: "2025-03-03", code: "A", score: 1, rank: 1 },
    { date: "2025-03-04", code: "B", score: 1, rank: 1 },
    { date: "2025-03-05", code: "C", score: 1, rank: 1 },
    { date: "2025-03-06", code: "D", score: 1, rank: 1 },
  ];
  const fr = lookup({
    "2025-03-03|A": { ret: { 5: 10 }, benchmarkRet: { 5: 0 } },
    "2025-03-04|B": { ret: { 5: -5 }, benchmarkRet: { 5: 0 } },
    "2025-03-05|C": { ret: { 5: 3 }, benchmarkRet: { 5: 0 } },
    "2025-03-06|D": { ret: { 5: -8 }, benchmarkRet: { 5: 0 } },
  });
  // cum: 10, 5, 8, 0 ; peak: 10 ; 最大回撤 = 10 - 0 = 10
  const s = computeBacktestStats(picks, fr, { horizons: [5], quarterBuckets: false });
  assert.ok(Math.abs(s.overall[5]!.maxDrawdown - 10) < 1e-12);
});

test("byTopN：5 個 pick rank 1..5，topN=[2, Infinity]", () => {
  const picks: CandidatePick[] = [1, 2, 3, 4, 5].map((rank) => ({
    date: "2025-04-07",
    code: `S${rank}`,
    score: 100 - rank,
    rank,
  }));
  const fr = lookup(
    Object.fromEntries(
      picks.map((p) => [`${p.date}|${p.code}`, { ret: { 5: p.rank }, benchmarkRet: { 5: 0 } }]),
    ),
  );

  const s = computeBacktestStats(picks, fr, {
    horizons: [5],
    topN: [2, Infinity],
    quarterBuckets: false,
  });
  assert.equal(s.byTopN[2]![5]!.n, 2); // 只有 rank 1, 2
  assert.equal(s.byTopN[Infinity]![5]!.n, 5);
  // top2 平均 = avg(1, 2) = 1.5
  assert.ok(Math.abs(s.byTopN[2]![5]!.avgReturn - 1.5) < 1e-12);
});

test("split：pick 跨 trainEnd → bySplit.train / valid 各自筆數正確", () => {
  const picks: CandidatePick[] = [
    { date: "2025-01-15", code: "A", score: 1, rank: 1 },
    { date: "2025-02-15", code: "B", score: 1, rank: 1 },
    { date: "2025-06-15", code: "C", score: 1, rank: 1 },
    { date: "2025-07-15", code: "D", score: 1, rank: 1 },
  ];
  const fr = lookup(
    Object.fromEntries(
      picks.map((p) => [`${p.date}|${p.code}`, { ret: { 5: 1 }, benchmarkRet: { 5: 0 } }]),
    ),
  );

  const s = computeBacktestStats(picks, fr, {
    horizons: [5],
    split: { trainEnd: "2025-05-31", validStart: "2025-06-01" },
    quarterBuckets: false,
  });
  assert.ok(s.bySplit);
  assert.equal(s.bySplit!.train[5]!.n, 2); // A, B
  assert.equal(s.bySplit!.valid[5]!.n, 2); // C, D
});

test("byQuarter：date → YYYYQn 分桶", () => {
  const picks: CandidatePick[] = [
    { date: "2025-01-06", code: "A", score: 1, rank: 1 },
    { date: "2025-03-31", code: "B", score: 1, rank: 1 },
    { date: "2025-04-01", code: "C", score: 1, rank: 1 },
  ];
  const fr = lookup(
    Object.fromEntries(
      picks.map((p) => [`${p.date}|${p.code}`, { ret: { 5: 1 }, benchmarkRet: { 5: 0 } }]),
    ),
  );
  const s = computeBacktestStats(picks, fr, { horizons: [5] });
  assert.ok(s.byQuarter);
  assert.equal(s.byQuarter!["2025Q1"]![5]!.n, 2);
  assert.equal(s.byQuarter!["2025Q2"]![5]!.n, 1);
});

test("profitFactor：無負報酬 → Infinity；無正報酬 → 0", () => {
  const allPos: CandidatePick[] = [
    { date: "2025-01-06", code: "A", score: 1, rank: 1 },
    { date: "2025-01-06", code: "B", score: 1, rank: 2 },
  ];
  const frPos = lookup({
    "2025-01-06|A": { ret: { 5: 3 }, benchmarkRet: { 5: 0 } },
    "2025-01-06|B": { ret: { 5: 5 }, benchmarkRet: { 5: 0 } },
  });
  assert.equal(
    computeBacktestStats(allPos, frPos, { horizons: [5], quarterBuckets: false }).overall[5]!
      .profitFactor,
    Infinity,
  );

  const frNeg = lookup({
    "2025-01-06|A": { ret: { 5: -3 }, benchmarkRet: { 5: 0 } },
    "2025-01-06|B": { ret: { 5: -5 }, benchmarkRet: { 5: 0 } },
  });
  assert.equal(
    computeBacktestStats(allPos, frNeg, { horizons: [5], quarterBuckets: false }).overall[5]!
      .profitFactor,
    0,
  );
});
