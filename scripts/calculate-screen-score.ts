import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const WEIGHTS = {
  value: 0.15,
  liquidity: 0.1,
  momentum: 0.2,
  reversal: 0.1,
  activity: 0.15,
  stability: 0.1,
  size: 0.1,
  theme_heat: 0.1,
  topic_alignment: 0, // 目前固定中性分，不參與加權（權重設0，等未來題材系統做好再調整）
};

// 對應 python 版 _rank_score：cross-sectional percentile rank，0~100
// lowerIsBetter=true 時，數值越小排名分數越高（例如 PE、PB）
// naScore：該股票這個欄位缺值時給的預設分數
export function rankScore(values: (number | null)[], lowerIsBetter: boolean, naScore: number): number[] {
  const validEntries = values
    .map((v, i) => ({ v, i }))
    .filter((e): e is { v: number; i: number } => e.v !== null && !Number.isNaN(e.v));

  if (validEntries.length === 0) {
    return values.map(() => naScore);
  }

  // 由「較差」排到「較好」：lowerIsBetter 時數值越大越差，反之數值越小越差
  const sorted = [...validEntries].sort((a, b) => (lowerIsBetter ? b.v - a.v : a.v - b.v));

  const result = new Array<number>(values.length).fill(naScore);
  for (let rank = 0; rank < sorted.length; rank++) {
    // 小於等於自己的個數（依排序方向）/ 有效值總數 x 100 —— 排序越後面（越好）分數越高
    const percentile = ((rank + 1) / sorted.length) * 100;
    result[sorted[rank]!.i] = percentile;
  }
  return result;
}

function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function log10Safe(value: number): number | null {
  return value > 0 ? Math.log10(value) : null;
}

interface StockSnapshot {
  code: string;
  name: string;
  close: number;
  changePercent: number;
  volume: number;
  sharesOutstanding: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  ma20: number | null;
  volumeMa20: number | null;
  volatility20d: number | null;
  maxDrawdown20d: number | null;
  atr20: number | null;
  rsi14: number | null;
  macdStatus: string | null;
  change60dPercent: number | null;
  sectorAvgChangePercent: number | null;
  sectorRank: number | null;
}

interface FactorScores {
  value: number;
  size: number;
  liquidity: number;
  momentum: number;
  reversal: number;
  activity: number;
  stability: number;
  theme_heat: number;
  topic_alignment: number;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function buildSnapshots(date: Date): Promise<StockSnapshot[]> {
  const quotes = await prisma.dailyQuote.findMany({
    where: { date, stock: { securityType: "stock" } },
    select: {
      stockCode: true,
      close: true,
      change: true,
      volume: true,
      stock: { select: { name: true, sharesOutstanding: true, sectorId: true } },
    },
  });

  if (quotes.length === 0) return [];

  const codes = quotes.map((q) => q.stockCode);

  const [indicators, valuations, heatSnapshots, history] = await Promise.all([
    prisma.technicalIndicator.findMany({
      where: { date, stockCode: { in: codes } },
      select: {
        stockCode: true,
        ma20: true,
        volumeMa20: true,
        volatility20d: true,
        maxDrawdown20d: true,
        atr20: true,
        rsi14: true,
        macdStatus: true,
      },
    }),
    prisma.stockValuation.findMany({
      where: { date, stockCode: { in: codes } },
      select: { stockCode: true, peRatio: true, pbRatio: true },
    }),
    prisma.industryHeatSnapshot.findMany({
      where: { date },
      select: { sectorId: true, avgChangePercent: true, rank: true },
    }),
    // 60 個交易日前的收盤價：依 stockCode 抓最近 61 筆（含當天）取最舊一筆
    prisma.dailyQuote.findMany({
      where: { stockCode: { in: codes }, date: { lte: date } },
      orderBy: { date: "desc" },
      select: { stockCode: true, date: true, close: true },
    }),
  ]);

  const indicatorMap = new Map(indicators.map((i) => [i.stockCode, i]));
  const valuationMap = new Map(valuations.map((v) => [v.stockCode, v]));
  const heatMap = new Map(heatSnapshots.map((h) => [h.sectorId, h]));

  const historyByStock = new Map<string, { date: Date; close: number }[]>();
  for (const row of history) {
    const list = historyByStock.get(row.stockCode);
    if (list) list.push(row);
    else historyByStock.set(row.stockCode, [row]);
  }

  const sectorByCode = new Map(quotes.map((q) => [q.stockCode, q.stock.sectorId]));

  return quotes.map((q): StockSnapshot => {
    const indicator = indicatorMap.get(q.stockCode);
    const valuation = valuationMap.get(q.stockCode);
    const sectorId = sectorByCode.get(q.stockCode);
    const heat = sectorId !== null && sectorId !== undefined ? heatMap.get(sectorId) : undefined;

    const prevClose = q.close - q.change;
    const changePercent = prevClose > 0 ? (q.change / prevClose) * 100 : 0;

    const stockHistory = historyByStock.get(q.stockCode) ?? [];
    // stockHistory 已依 date desc 排序，取最舊一筆（最多 61 筆，含當天）當作 60 日前收盤價
    const oldest = stockHistory.length > 0 ? stockHistory[stockHistory.length - 1] : undefined;
    const change60dPercent =
      oldest && oldest.close > 0 && stockHistory.length > 1 ? ((q.close - oldest.close) / oldest.close) * 100 : null;

    return {
      code: q.stockCode,
      name: q.stock.name,
      close: q.close,
      changePercent,
      volume: Number(q.volume),
      sharesOutstanding: q.stock.sharesOutstanding !== null ? Number(q.stock.sharesOutstanding) : null,
      peRatio: valuation?.peRatio !== null && valuation?.peRatio !== undefined ? Number(valuation.peRatio) : null,
      pbRatio: valuation?.pbRatio !== null && valuation?.pbRatio !== undefined ? Number(valuation.pbRatio) : null,
      ma20: indicator?.ma20 ?? null,
      volumeMa20: indicator?.volumeMa20 ?? null,
      volatility20d: indicator?.volatility20d ?? null,
      maxDrawdown20d: indicator?.maxDrawdown20d ?? null,
      atr20: indicator?.atr20 ?? null,
      rsi14: indicator?.rsi14 ?? null,
      macdStatus: indicator?.macdStatus ?? null,
      change60dPercent,
      sectorAvgChangePercent: heat ? Number(heat.avgChangePercent) : null,
      sectorRank: heat?.rank ?? null,
    };
  });
}

function computeValueFactor(snapshots: StockSnapshot[]): number[] {
  const peValues = snapshots.map((s) => (s.peRatio !== null && s.peRatio > 0 && s.peRatio < 500 ? s.peRatio : null));
  const pbValues = snapshots.map((s) => (s.pbRatio !== null && s.pbRatio > 0 && s.pbRatio < 50 ? s.pbRatio : null));
  const peScores = rankScore(peValues, true, 25);
  const pbScores = rankScore(pbValues, true, 25);
  // PE 權重較高
  return snapshots.map((_, i) => peScores[i]! * 0.65 + pbScores[i]! * 0.35);
}

function computeSizeFactor(snapshots: StockSnapshot[]): number[] {
  const marketCaps = snapshots.map((s) => {
    if (s.sharesOutstanding === null) return null;
    const cap = s.sharesOutstanding * s.close;
    return log10Safe(cap);
  });
  return rankScore(marketCaps, false, 35);
}

function computeLiquidityFactor(snapshots: StockSnapshot[]): number[] {
  const turnovers = snapshots.map((s) => log10Safe(s.close * s.volume));
  return rankScore(turnovers, false, 20);
}

const MOMENTUM_CHASE_START_PCT = 6; // 漲幅超過此值開始扣分（追高風險）
const MOMENTUM_DOWNSIDE_START_PCT = -4; // 跌幅超過此值開始扣分

function computeMomentumFactor(s: StockSnapshot): number {
  let score = 60 + s.changePercent * 2.5;

  if (s.changePercent > MOMENTUM_CHASE_START_PCT) {
    score -= (s.changePercent - MOMENTUM_CHASE_START_PCT) * 3;
  }
  if (s.changePercent < MOMENTUM_DOWNSIDE_START_PCT) {
    score -= (MOMENTUM_DOWNSIDE_START_PCT - s.changePercent) * 3;
  }

  if (s.change60dPercent !== null) {
    score = score * 0.7 + clip(55 + s.change60dPercent * 0.8, 0, 100) * 0.3;
  }

  if (s.macdStatus === "bullish") score += 6;
  else if (s.macdStatus === "bearish") score -= 8;

  return clip(score, 0, 100);
}

const REVERSAL_IDEAL_DIP_PCT = -3;
const REVERSAL_DEEP_DIP_PCT = -8;
const REVERSAL_OVERHEAT_PCT = 1;

function computeReversalFactor(s: StockSnapshot): number {
  const distance = Math.abs(s.changePercent - REVERSAL_IDEAL_DIP_PCT);
  let score = 75 - distance * 5;

  if (s.changePercent < REVERSAL_DEEP_DIP_PCT) {
    score -= (REVERSAL_DEEP_DIP_PCT - s.changePercent) * 4;
  }
  if (s.changePercent > REVERSAL_OVERHEAT_PCT) {
    score -= (s.changePercent - REVERSAL_OVERHEAT_PCT) * 6;
  }

  if (s.rsi14 !== null) {
    if (s.rsi14 < 30) score += (30 - s.rsi14) * 0.8; // 超賣加分
    else if (s.rsi14 > 70) score -= (s.rsi14 - 70) * 0.8; // 超買扣分
  }

  return clip(score, 0, 100);
}

const ACTIVITY_IDEAL_VOLUME_RATIO = 2.0;
const ACTIVITY_HIGH_VOLUME_RATIO = 5.0;
const ACTIVITY_IDEAL_TURNOVER_PCT = 4.0;
const ACTIVITY_HIGH_TURNOVER_PCT = 12.0;

function computeActivityFactor(s: StockSnapshot): number {
  let volumeScore = 50;
  if (s.volumeMa20 !== null && s.volumeMa20 > 0) {
    const ratio = s.volume / s.volumeMa20;
    volumeScore = 80 - Math.abs(ratio - ACTIVITY_IDEAL_VOLUME_RATIO) * 12;
    if (ratio > ACTIVITY_HIGH_VOLUME_RATIO) {
      volumeScore -= (ratio - ACTIVITY_HIGH_VOLUME_RATIO) * 8;
    }
  }

  let turnoverScore = 50;
  if (s.sharesOutstanding !== null && s.sharesOutstanding > 0) {
    const turnoverPct = (s.volume / s.sharesOutstanding) * 100;
    turnoverScore = 80 - Math.abs(turnoverPct - ACTIVITY_IDEAL_TURNOVER_PCT) * 6;
    if (turnoverPct > ACTIVITY_HIGH_TURNOVER_PCT) {
      turnoverScore -= (turnoverPct - ACTIVITY_HIGH_TURNOVER_PCT) * 4;
    }
  }

  return clip(volumeScore * 0.5 + turnoverScore * 0.5, 0, 100);
}

function computeStabilityFactor(s: StockSnapshot): number {
  let score = 78 - Math.abs(s.changePercent) * 3;

  if (s.peRatio !== null && s.peRatio < 0) score -= 10;

  if (s.volatility20d !== null && s.volatility20d > 45) {
    score -= (s.volatility20d - 45) * 1.5;
  }
  if (s.maxDrawdown20d !== null && s.maxDrawdown20d < -12) {
    score -= (-12 - s.maxDrawdown20d) * 1.5;
  }
  if (s.atr20 !== null && s.close > 0) {
    const atrPct = (s.atr20 / s.close) * 100;
    if (atrPct > 6) score -= (atrPct - 6) * 3;
  }

  return clip(score, 0, 100);
}

function computeThemeHeatFactor(s: StockSnapshot): number {
  if (s.sectorAvgChangePercent === null) return 50;

  let score = 50 + s.sectorAvgChangePercent * 6.0;
  if (s.sectorRank !== null) {
    score += clip(10 - s.sectorRank, 0, 10);
  }
  return clip(score, 0, 100);
}

function computeFactors(snapshots: StockSnapshot[]): FactorScores[] {
  const valueScores = computeValueFactor(snapshots);
  const sizeScores = computeSizeFactor(snapshots);
  const liquidityScores = computeLiquidityFactor(snapshots);

  return snapshots.map((s, i) => ({
    value: valueScores[i]!,
    size: sizeScores[i]!,
    liquidity: liquidityScores[i]!,
    momentum: computeMomentumFactor(s),
    reversal: computeReversalFactor(s),
    activity: computeActivityFactor(s),
    stability: computeStabilityFactor(s),
    theme_heat: computeThemeHeatFactor(s),
    topic_alignment: 50, // 固定中性分，尚無題材 Tag 系統
  }));
}

function combineScore(factors: FactorScores): number {
  const totalWeight = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
  const weightedSum = (Object.keys(WEIGHTS) as (keyof FactorScores)[]).reduce(
    (sum, key) => sum + factors[key] * WEIGHTS[key],
    0,
  );
  return weightedSum / totalWeight;
}

interface ScoreResult {
  code: string;
  name: string;
  screenScore: number;
  factors: FactorScores;
  rank: number;
}

export async function calculateScreenScore(date: Date): Promise<{
  date: string;
  scoredCount: number;
  isNonTradingDay: boolean;
}> {
  const dateStr = toIsoDate(date);
  const snapshots = await buildSnapshots(date);

  if (snapshots.length === 0) {
    console.log(`${dateStr} 無任何 DailyQuote 資料（非交易日？），跳過`);
    return { date: dateStr, scoredCount: 0, isNonTradingDay: true };
  }

  const factorsList = computeFactors(snapshots);

  const results: ScoreResult[] = snapshots
    .map((s, i) => ({
      code: s.code,
      name: s.name,
      screenScore: combineScore(factorsList[i]!),
      factors: factorsList[i]!,
    }))
    .sort((a, b) => b.screenScore - a.screenScore)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  console.log(`\n${dateStr} screenScore 排名前 20：\n`);
  console.log("排名".padEnd(6) + "代號".padEnd(8) + "名稱".padEnd(14) + "分數");
  console.log("-".repeat(50));
  for (const r of results.slice(0, 20)) {
    console.log(`${String(r.rank).padEnd(6)}${r.code.padEnd(8)}${r.name.padEnd(12)}${r.screenScore.toFixed(2)}`);
  }

  const outputDir = join(__dirname, "..", "data", "screen-score-results");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${dateStr}.json`);
  writeFileSync(outputPath, JSON.stringify({ date: dateStr, results }, null, 2));
  console.log(`\n結果已寫入 ${outputPath}`);

  return { date: dateStr, scoredCount: results.length, isNonTradingDay: false };
}

function parseArgs(): { date: Date | null } {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  if (!arg) return { date: null };
  const raw = arg.split("=")[1]!;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--date 格式錯誤: ${raw}`);
  }
  return { date };
}

async function main() {
  const { date: argDate } = parseArgs();

  let targetDate = argDate;
  if (!targetDate) {
    const latest = await prisma.dailyQuote.findFirst({
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (!latest) {
      console.log("資料庫裡沒有任何 DailyQuote 資料。");
      return;
    }
    targetDate = latest.date;
  }

  await calculateScreenScore(targetDate);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main()
    .catch((err) => {
      console.error("screenScore 計算失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
