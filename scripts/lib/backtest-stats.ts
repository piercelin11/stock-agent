// Layer 3 統計純函式（ROADMAP 3.5 / PLAN §4）。
//
// 【純函式庫】不碰 DB、不讀檔、不 import React / Prisma。
// 輸入：某組參數重算出來的候選名單（含分數 / rank）+ forward-returns cache。
// 輸出：命中率、平均 / 中位數報酬、勝率、賺賠比、最大回撤、按季穩定性、
//       按分數分層（topN 切點）、訓練 / 驗證期分段統計。
//
// forward-returns cache 由呼叫端（scripts/backtest/load-forward-returns.ts）從
// data/backtest-cache/forward-returns.jsonl 讀進來包成 ForwardReturnLookup。

export interface CandidatePick {
  date: string; // YYYY-MM-DD
  code: string;
  score: number; // breakout=totalScore / accumulation=finalScore
  rank: number; // 當天在候選名單內的名次（1-based）
}

export interface ForwardReturnLookup {
  // (date, code) → { retN, benchmarkRetN }
  get(
    date: string,
    code: string,
  ):
    | {
        ret: Record<number, number | null>;
        benchmarkRet: Record<number, number | null>;
      }
    | undefined;
}

export interface BacktestStatsOptions {
  horizons: number[]; // e.g. [5, 10, 20]
  topN?: number[]; // 分層驗證切點，預設 [10, 30, Infinity]（Infinity = 全候選）
  split?: { trainEnd: string; validStart: string }; // 有給則額外輸出 train / valid 分段
  quarterBuckets?: boolean; // 預設 true：按季輸出穩定性
}

export interface HorizonStats {
  n: number; // 納入統計的 (date, code) 數（該 horizon retN 非 null）
  hitRate: number; // ret > benchmarkRet 的比例（benchmarkRet 為 null 的 pick 不計入分母）
  avgReturn: number;
  medianReturn: number;
  avgExcessReturn: number; // mean(ret - benchmarkRet)（兩者皆非 null 的子集）
  winRate: number; // ret > 0 的比例
  profitFactor: number; // Σ 正報酬 / |Σ 負報酬|（無負報酬 → Infinity；無正報酬 → 0）
  maxDrawdown: number; // 按 date 排序、等權不重疊部位報酬的累積曲線 peak-to-trough 最大跌幅（%，>= 0）
}

export interface BacktestStats {
  overall: Record<number, HorizonStats>; // 每個 horizon 一組
  byTopN: Record<number, Record<number, HorizonStats>>; // topN 切點 → horizon → stats
  byQuarter?: Record<string, Record<number, HorizonStats>>; // "2025Q1" → horizon → stats
  bySplit?: {
    train: Record<number, HorizonStats>;
    valid: Record<number, HorizonStats>;
  };
  meta: { totalPicks: number; datesCovered: number; horizons: number[] };
}

// ---- 基本統計小工具 ----

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// 等權、不重疊部位：把 picks 按 date 升冪，retN 視為一連串獨立部位報酬，
// 算累積曲線（相加，簡化模型不做複利）的最大 peak-to-trough 跌幅。回傳非負百分點。
function maxDrawdownOf(picksSortedByDate: { ret: number }[]): number {
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of picksSortedByDate) {
    cum += p.ret;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

interface PickWithReturns {
  date: string;
  code: string;
  score: number;
  rank: number;
  ret: Record<number, number | null>;
  benchmarkRet: Record<number, number | null>;
}

function computeHorizonStats(picks: PickWithReturns[], horizon: number): HorizonStats {
  const withRet = picks
    .filter((p) => {
      const r = p.ret[horizon];
      return r !== null && r !== undefined && !Number.isNaN(r);
    })
    .map((p) => ({
      date: p.date,
      ret: p.ret[horizon] as number,
      benchmarkRet: p.benchmarkRet[horizon],
    }));

  const n = withRet.length;
  if (n === 0) {
    return {
      n: 0,
      hitRate: 0,
      avgReturn: 0,
      medianReturn: 0,
      avgExcessReturn: 0,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0,
    };
  }

  const rets = withRet.map((p) => p.ret);
  const avgReturn = mean(rets);
  const medianReturn = medianOf(rets);
  const winRate = withRet.filter((p) => p.ret > 0).length / n;

  const posSum = rets.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const negSum = rets.filter((r) => r < 0).reduce((s, v) => s + v, 0);
  const profitFactor = negSum === 0 ? (posSum === 0 ? 0 : Infinity) : posSum / Math.abs(negSum);

  // 命中率 / 超額報酬：只看 benchmarkRet 非 null 的子集
  const withBench = withRet.filter(
    (p) => p.benchmarkRet !== null && p.benchmarkRet !== undefined && !Number.isNaN(p.benchmarkRet),
  );
  const hitRate =
    withBench.length > 0
      ? withBench.filter((p) => p.ret > (p.benchmarkRet as number)).length / withBench.length
      : 0;
  const avgExcessReturn =
    withBench.length > 0
      ? mean(withBench.map((p) => p.ret - (p.benchmarkRet as number)))
      : 0;

  const sortedByDate = [...withRet].sort((a, b) => a.date.localeCompare(b.date));
  const maxDrawdown = maxDrawdownOf(sortedByDate);

  return { n, hitRate, avgReturn, medianReturn, avgExcessReturn, winRate, profitFactor, maxDrawdown };
}

function statsForAllHorizons(
  picks: PickWithReturns[],
  horizons: number[],
): Record<number, HorizonStats> {
  const out: Record<number, HorizonStats> = {};
  for (const h of horizons) out[h] = computeHorizonStats(picks, h);
  return out;
}

// YYYY-MM-DD → "YYYYQn"
function quarterBucket(date: string): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}Q${q}`;
}

export function computeBacktestStats(
  picks: CandidatePick[],
  forwardReturns: ForwardReturnLookup,
  options: BacktestStatsOptions,
): BacktestStats {
  const horizons = options.horizons.slice().sort((a, b) => a - b);
  const topN = options.topN ?? [10, 30, Infinity];
  const quarterBuckets = options.quarterBuckets ?? true;

  // ---- join forward-returns ----
  const enriched: PickWithReturns[] = picks.map((p) => {
    const fr = forwardReturns.get(p.date, p.code);
    return {
      date: p.date,
      code: p.code,
      score: p.score,
      rank: p.rank,
      ret: fr?.ret ?? {},
      benchmarkRet: fr?.benchmarkRet ?? {},
    };
  });

  const overall = statsForAllHorizons(enriched, horizons);

  // ---- byTopN：每天 rank <= N 的 pick 子集 ----
  const byTopN: Record<number, Record<number, HorizonStats>> = {};
  for (const cut of topN) {
    const subset = enriched.filter((p) => p.rank <= cut);
    byTopN[cut] = statsForAllHorizons(subset, horizons);
  }

  const result: BacktestStats = {
    overall,
    byTopN,
    meta: {
      totalPicks: picks.length,
      datesCovered: new Set(picks.map((p) => p.date)).size,
      horizons,
    },
  };

  // ---- byQuarter ----
  if (quarterBuckets) {
    const buckets = new Map<string, PickWithReturns[]>();
    for (const p of enriched) {
      const b = quarterBucket(p.date);
      let list = buckets.get(b);
      if (!list) {
        list = [];
        buckets.set(b, list);
      }
      list.push(p);
    }
    const byQuarter: Record<string, Record<number, HorizonStats>> = {};
    for (const [b, list] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      byQuarter[b] = statsForAllHorizons(list, horizons);
    }
    result.byQuarter = byQuarter;
  }

  // ---- bySplit ----
  if (options.split) {
    const { trainEnd, validStart } = options.split;
    const train = enriched.filter((p) => p.date <= trainEnd);
    const valid = enriched.filter((p) => p.date >= validStart);
    result.bySplit = {
      train: statsForAllHorizons(train, horizons),
      valid: statsForAllHorizons(valid, horizons),
    };
  }

  return result;
}
