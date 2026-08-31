import type { PrismaClient } from "../../generated/prisma/client";

// 大盤濾網（市場狀態燈號）純函式。PLAN §2。
//
// 定位：純函式庫但允許查 DB（比照 breakout-shared.ts）。無 CLI。
// 輸出 bullish / neutral / bearish 三段標籤，供人工判斷「要不要進場」「部位大小」。
// **不參與個股評分、不做 gate、不排除任何股票。**
//
// 分兩階段（同一份 PLAN）：
//   Step 1 = 只算「市場寬度 breadth」單維度（零新資料，DailyQuote + TechnicalIndicator 現成）。
//   Step 2 = TAIEX 日線落地後，補「指數位置 indexPosition」+「MA60 斜率 ma60Slope」兩維度，變三票合成。
// stage 由「TAIEX 的 TechnicalIndicator 是否有該日資料」自動決定（優雅降級）。

export type RegimeLabel = "bullish" | "neutral" | "bearish";

export interface DimensionScore {
  score: -1 | 0 | 1;
  degraded: boolean; // 資料不足 → score 記 0 且 degraded
  detail: Record<string, number | null>; // 該維度的原始數值（顯示 / 除錯用）
}

export interface MarketRegimeResult {
  date: string; // YYYY-MM-DD（DB 最新交易日）
  label: RegimeLabel;
  totalScore: number; // -3 ~ +3（Step 1 只有 breadth 時 -1 ~ +1）
  dimensions: {
    indexPosition: DimensionScore | null; // Step 1 為 null
    ma60Slope: DimensionScore | null; // Step 1 為 null
    breadth: DimensionScore;
  };
  stage: "step1-breadth-only" | "step2-full";
}

export interface CalculateRegimeOptions {
  prisma: PrismaClient; // 一律外部傳（pipeline 傳自建的、action 傳單例）
  config?: Partial<RegimeConfig>;
}

// ---- 門檻常數（集中，方便日後校準；首版未校準，肉眼對照盤感再調）----

export interface RegimeConfig {
  indexPosBufferDays: number; // 指數位置維度的「連續 N 交易日」緩衝
  ma60SlopeLookbackDays: number; // MA60 斜率回看天數
  ma60SlopeUpThreshold: number; // MA60 (今 - N日前) / N日前 > 此值 → +1（0.005 = 0.5%）
  ma60SlopeDownThreshold: number; // < -此值 → -1
  breadthBullPct: number; // 站上 MA60 佔比 > 此值 → +1
  breadthBearPct: number; // < 此值 → -1
  bullishTotalScore: number; // totalScore >= 此值 → bullish（三維時 2）
  bearishTotalScore: number; // <= 此值 → bearish（三維時 -2）
}

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  indexPosBufferDays: 3,
  ma60SlopeLookbackDays: 5,
  ma60SlopeUpThreshold: 0.005,
  ma60SlopeDownThreshold: 0.005,
  breadthBullPct: 55,
  breadthBearPct: 45,
  bullishTotalScore: 2,
  bearishTotalScore: -2,
};

// breadth 維度 degraded 門檻：分母（有 ma60 的檔數）< 此值 → 不表態
const BREADTH_MIN_DENOM = 500;

// ---- 查 DB helper（PLAN §2.7）----

/** 維度 A：該日全市場一般股票 close > 當日 ma60 的佔比 */
export async function fetchBreadthInputs(
  prisma: PrismaClient,
  date: Date,
): Promise<{ aboveMa60: number; total: number; pct: number }> {
  // 1. 該日全市場一般股票的 close（排除 TAIEX 本身）
  const quotes = await prisma.dailyQuote.findMany({
    where: { date, stock: { securityType: "stock" } },
    select: { stockCode: true, close: true },
  });
  if (quotes.length === 0) {
    return { aboveMa60: 0, total: 0, pct: 0 };
  }

  // 2. 同日 TechnicalIndicator.ma60
  const indicators = await prisma.technicalIndicator.findMany({
    where: { date, stockCode: { in: quotes.map((q) => q.stockCode) } },
    select: { stockCode: true, ma60: true },
  });
  const ma60ByCode = new Map<string, number | null>();
  for (const ind of indicators) {
    ma60ByCode.set(ind.stockCode, ind.ma60 === null ? null : Number(ind.ma60));
  }

  // 3. 逐檔比對：ma60 非 null 才計入分母
  let total = 0;
  let aboveMa60 = 0;
  for (const q of quotes) {
    const ma60 = ma60ByCode.get(q.stockCode);
    if (ma60 === undefined || ma60 === null) continue;
    total++;
    if (Number(q.close) > ma60) aboveMa60++;
  }

  const pct = total > 0 ? (aboveMa60 / total) * 100 : 0;
  return { aboveMa60, total, pct };
}

/** TAIEX 近 n 筆 close + 同日 ma60，新到舊；長度可能 < n（早期資料不足） */
export async function fetchTaiexCloseVsMa60(
  prisma: PrismaClient,
  date: Date,
  n: number,
): Promise<{ date: string; close: number; ma60: number | null }[]> {
  const quotes = await prisma.dailyQuote.findMany({
    where: { stockCode: "TAIEX", date: { lte: date } },
    orderBy: { date: "desc" },
    take: n,
    select: { date: true, close: true },
  });
  if (quotes.length === 0) return [];

  const indicators = await prisma.technicalIndicator.findMany({
    where: { stockCode: "TAIEX", date: { in: quotes.map((q) => q.date) } },
    select: { date: true, ma60: true },
  });
  const ma60ByIso = new Map<string, number | null>();
  for (const ind of indicators) {
    ma60ByIso.set(
      ind.date.toISOString().slice(0, 10),
      ind.ma60 === null ? null : Number(ind.ma60),
    );
  }

  return quotes.map((q) => {
    const iso = q.date.toISOString().slice(0, 10);
    return {
      date: iso,
      close: Number(q.close),
      ma60: ma60ByIso.has(iso) ? (ma60ByIso.get(iso) as number | null) : null,
    };
  });
}

/** TAIEX 近 n 筆 ma60，新到舊 */
export async function fetchTaiexMa60Series(
  prisma: PrismaClient,
  date: Date,
  n: number,
): Promise<(number | null)[]> {
  const rows = await prisma.technicalIndicator.findMany({
    where: { stockCode: "TAIEX", date: { lte: date } },
    orderBy: { date: "desc" },
    take: n,
    select: { ma60: true },
  });
  return rows.map((r) => (r.ma60 === null ? null : Number(r.ma60)));
}

/** 決定 stage：TAIEX 是否有該日的 TechnicalIndicator */
export async function hasTaiexIndicatorForDate(
  prisma: PrismaClient,
  date: Date,
): Promise<boolean> {
  const row = await prisma.technicalIndicator.findFirst({
    where: { stockCode: "TAIEX", date },
    select: { ma60: true },
  });
  return row !== null && row.ma60 !== null;
}

// ---- 維度計算 ----

/** 維度 A：市場寬度 breadth（Step 1 就做，PLAN §2.3） */
function scoreBreadth(
  inputs: { aboveMa60: number; total: number; pct: number },
  config: RegimeConfig,
): DimensionScore {
  const detail: Record<string, number | null> = {
    aboveMa60: inputs.aboveMa60,
    total: inputs.total,
    pct: Math.round(inputs.pct * 10) / 10,
  };

  if (inputs.total < BREADTH_MIN_DENOM) {
    return { score: 0, degraded: true, detail };
  }

  let score: -1 | 0 | 1 = 0;
  if (inputs.pct > config.breadthBullPct) score = 1;
  else if (inputs.pct < config.breadthBearPct) score = -1;

  return { score, degraded: false, detail };
}

/** 維度 B：指數位置 indexPosition（Step 2，PLAN §2.4） */
function scoreIndexPosition(
  rows: { date: string; close: number; ma60: number | null }[],
  config: RegimeConfig,
): DimensionScore {
  const n = config.indexPosBufferDays;
  const latest = rows[0];
  const detail: Record<string, number | null> = {
    latestClose: latest ? latest.close : null,
    latestMa60: latest ? latest.ma60 : null,
    daysAbove: rows.filter((r) => r.ma60 !== null && r.close > r.ma60).length,
    daysBelow: rows.filter((r) => r.ma60 !== null && r.close < r.ma60).length,
  };

  if (rows.length < n || rows.some((r) => r.ma60 === null)) {
    return { score: 0, degraded: true, detail };
  }

  const allAbove = rows.every((r) => r.close > (r.ma60 as number));
  const allBelow = rows.every((r) => r.close < (r.ma60 as number));
  let score: -1 | 0 | 1 = 0;
  if (allAbove) score = 1;
  else if (allBelow) score = -1;

  return { score, degraded: false, detail };
}

/** 維度 C：MA60 斜率 ma60Slope（Step 2，PLAN §2.5） */
function scoreMa60Slope(
  series: (number | null)[],
  config: RegimeConfig,
): DimensionScore {
  const n = config.ma60SlopeLookbackDays;
  const latest = series[0] ?? null;
  const past = series[n] ?? null;

  const detail: Record<string, number | null> = {
    latestMa60: latest,
    pastMa60: past,
    slopePct: null,
  };

  if (
    series.length < n + 1 ||
    latest === null ||
    past === null ||
    past <= 0
  ) {
    return { score: 0, degraded: true, detail };
  }

  const slope = (latest - past) / past;
  detail.slopePct = Math.round(slope * 10000) / 100;

  let score: -1 | 0 | 1 = 0;
  if (slope > config.ma60SlopeUpThreshold) score = 1;
  else if (slope < -config.ma60SlopeDownThreshold) score = -1;

  return { score, degraded: false, detail };
}

// ---- 合成（PLAN §2.6）----

function decideLabel(
  stage: MarketRegimeResult["stage"],
  totalScore: number,
  breadthScore: number,
  config: RegimeConfig,
): RegimeLabel {
  if (stage === "step1-breadth-only") {
    // 只有一維、範圍 -1~+1，直接看 breadth.score
    if (breadthScore === 1) return "bullish";
    if (breadthScore === -1) return "bearish";
    return "neutral";
  }
  if (totalScore >= config.bullishTotalScore) return "bullish";
  if (totalScore <= config.bearishTotalScore) return "bearish";
  return "neutral";
}

export async function calculateMarketRegime(
  date: Date,
  options: CalculateRegimeOptions,
): Promise<MarketRegimeResult> {
  const { prisma } = options;
  const config: RegimeConfig = { ...DEFAULT_REGIME_CONFIG, ...options.config };
  const isoDate = date.toISOString().slice(0, 10);

  // 維度 A：breadth（一律算）
  const breadthInputs = await fetchBreadthInputs(prisma, date);
  const breadth = scoreBreadth(breadthInputs, config);

  // stage：TAIEX 指標是否備妥
  const step2 = await hasTaiexIndicatorForDate(prisma, date);
  const stage: MarketRegimeResult["stage"] = step2
    ? "step2-full"
    : "step1-breadth-only";

  let indexPosition: DimensionScore | null = null;
  let ma60Slope: DimensionScore | null = null;

  if (step2) {
    const closeVsMa60 = await fetchTaiexCloseVsMa60(
      prisma,
      date,
      config.indexPosBufferDays,
    );
    indexPosition = scoreIndexPosition(closeVsMa60, config);

    const ma60Series = await fetchTaiexMa60Series(
      prisma,
      date,
      config.ma60SlopeLookbackDays + 1,
    );
    ma60Slope = scoreMa60Slope(ma60Series, config);
  }

  const dims = step2
    ? [indexPosition as DimensionScore, ma60Slope as DimensionScore, breadth]
    : [breadth];
  const totalScore = dims.reduce((s, d) => s + d.score, 0);

  const label = decideLabel(stage, totalScore, breadth.score, config);

  return {
    date: isoDate,
    label,
    totalScore,
    dimensions: { indexPosition, ma60Slope, breadth },
    stage,
  };
}
