import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import type { DeepPartial } from "../lib/types";
import {
  rankScore,
  fetchBreakoutRawInputs,
  computeVolumeStrength,
  computeBreakoutMargin,
  computeFirstBar,
  computeBase,
  computeProximityToHigh,
  computeMarketWideReturns,
  computeCandleShape,
  resolveBreakoutConfig,
  type BreakoutConfig,
  type HistoryPoint,
} from "../lib/breakout-shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface BreakoutResult {
  code: string;
  name: string;
  close: number;
  changePercent: number;
  volumeRatio: number;
  scores: {
    candleShape: number;
    volumeStrength: number;
    breakoutMargin: number;
    firstBar: number;
    base: number;
    proximityToHigh: number;
    relativeStrength: number;
  };
  totalScore: number;
  rank: number;
  historyDays: number;
  degraded: string[];
}

export interface CalculateBreakoutOptions {
  prisma?: PrismaClient;
  config?: DeepPartial<BreakoutConfig>;
}

export async function calculateBreakoutStrength(
  date: Date,
  options: CalculateBreakoutOptions = {},
): Promise<{
  date: string;
  isNonTradingDay: boolean;
  stats: { totalStocks: number; triggered: number; passedGates: number };
}> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  const config = resolveBreakoutConfig(options.config);
  try {
    return await runCalculation(prisma, date, config);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

async function runCalculation(
  prisma: PrismaClient,
  date: Date,
  config: BreakoutConfig,
): Promise<{
  date: string;
  isNonTradingDay: boolean;
  stats: { totalStocks: number; triggered: number; passedGates: number };
}> {
  const { gate, score } = config;
  const dateStr = toIsoDate(date);

  // 撈當天全市場的原始輸入（撈 DB + 組視窗序列）。與 Layer 0 批次引擎共用同一份 helper。
  const rawInputs = await fetchBreakoutRawInputs(prisma, date, {
    firstBarLookbackDays: score.firstBarLookbackDays,
    baseMaxWindowDays: score.baseMaxWindowDays,
    rsWindowDays: score.rsWindowDays,
  });

  if (rawInputs.size === 0) {
    console.log(`${dateStr} 無任何 DailyQuote 資料（非交易日？），跳過`);
    return { date: dateStr, isNonTradingDay: true, stats: { totalStocks: 0, triggered: 0, passedGates: 0 } };
  }

  const quotes = [...rawInputs.values()].map((r) => r.quote);
  const totalStocks = quotes.length;
  const codes = quotes.map((q) => q.stockCode);

  const todayIndicators = new Map([...rawInputs].map(([c, r]) => [c, r.indicator]));

  // 第一層：觸發條件
  const triggeredQuotes = quotes.filter((q) => {
    const ind = todayIndicators.get(q.stockCode);
    if (!ind || ind.bollingerUpper === null || ind.volumeMa20 === null || ind.volumeMa20 <= 0) return false;
    const passPrice = q.close > ind.bollingerUpper;
    const passVolume = q.volume / ind.volumeMa20 >= gate.triggerVolumeRatio;
    return passPrice && passVolume;
  });

  const triggered = triggeredQuotes.length;

  // 第二層：資格門檻
  let marketCapNullCount = 0;
  const passedQuotes = triggeredQuotes.filter((q) => {
    if (q.sharesOutstanding === null) {
      marketCapNullCount += 1;
      return false;
    }
    const marketCap = q.sharesOutstanding * q.close;
    const passCap = marketCap >= gate.minMarketCap;
    const passVolume = q.volume >= gate.minVolumeShares;
    return passCap && passVolume;
  });

  if (marketCapNullCount > 0) {
    console.log(`市值門檻：${marketCapNullCount} 檔因 sharesOutstanding 為 null 被擋下（未計入 passedGates）`);
  }

  const passedGates = passedQuotes.length;

  if (passedGates === 0) {
    console.log(`${dateStr}：觸發 ${triggered} 檔，通過門檻 0 檔`);
    const outputDir = join(__dirname, "..", "..", "data", "breakout-strength-results");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `${dateStr}.json`);
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          date: dateStr,
          gates: gate,
          weights: score.weights,
          stats: { totalStocks, triggered, passedGates },
          results: [],
        },
        null,
        2,
      ),
    );
    return { date: dateStr, isNonTradingDay: false, stats: { totalStocks, triggered, passedGates } };
  }

  const passedCodes = passedQuotes.map((q) => q.stockCode);

  // firstBar / base / proximity 用的視窗序列都已由 fetchBreakoutRawInputs 撈好（全市場），
  // 這裡按需取用：firstBar / base / proximity 只需要 passedCodes，relativeStrength 需要全市場。
  const firstBarSeriesByStock = new Map<string, { close: number; bollingerUpper: number | null }[]>();
  const baseHistoryByStock = new Map<string, HistoryPoint[]>();
  for (const code of passedCodes) {
    const raw = rawInputs.get(code)!;
    firstBarSeriesByStock.set(code, raw.firstBarSeries);
    baseHistoryByStock.set(code, raw.history);
  }
  // proximityToHigh 用：同一組 T-1 起算的視窗資料可重用
  const proximityHistoryByStock = baseHistoryByStock;

  // relativeStrength 用：全市場近 61 筆 close，含今天
  const marketHistoryByStock = new Map<string, { date: Date; close: number }[]>();
  for (const code of codes) {
    marketHistoryByStock.set(code, rawInputs.get(code)!.rsCloseSeries);
  }

  const { returns: marketReturns, historyDays: rsHistoryDays } = computeMarketWideReturns(
    codes,
    marketHistoryByStock,
    score.rsWindowDays,
  );
  const rsScoresAllMarket = rankScore(marketReturns, false, score.naScore);
  const rsScoreByCode = new Map(codes.map((c, i) => [c, { score: rsScoresAllMarket[i]!, historyDays: rsHistoryDays.get(c) ?? 0 }]));

  const results: BreakoutResult[] = passedQuotes.map((q) => {
    const ind = todayIndicators.get(q.stockCode)!; // passedQuotes 已過觸發條件，必有非 null indicator
    const bollingerUpper = ind!.bollingerUpper!;
    const volumeMa20 = ind!.volumeMa20!;
    const volumeRatio = q.volume / volumeMa20;

    const prevClose = q.close - q.change;
    const changePercent = prevClose > 0 ? (q.change / prevClose) * 100 : 0;

    const degraded: string[] = [];

    const volumeStrengthScore = computeVolumeStrength(volumeRatio, score.curves.volumeStrength);
    const breakoutMarginScore = computeBreakoutMargin(
      q.close,
      bollingerUpper,
      score.curves.breakoutMargin,
    );

    const candleShapeResult = computeCandleShape({
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
    });
    if (candleShapeResult.degraded) degraded.push("candleShape");

    const firstBarResult = computeFirstBar(firstBarSeriesByStock, q.stockCode);
    if (firstBarResult.degraded) degraded.push("firstBar");

    const stockBaseHistory = baseHistoryByStock.get(q.stockCode) ?? [];
    const yesterdayBandwidth = stockBaseHistory.length > 0 ? stockBaseHistory[0]!.bollingerBandwidth : null;
    const bandwidthHistoryForRank = stockBaseHistory.map((p) => p.bollingerBandwidth);
    const baseResult = computeBase(
      yesterdayBandwidth,
      bandwidthHistoryForRank,
      score.baseMinHistoryDays,
      score.curves.base,
    );
    if (baseResult.degraded) degraded.push("base");

    const stockProximityHistory = proximityHistoryByStock.get(q.stockCode) ?? [];
    const proximityCloseHistory = stockProximityHistory.map((p) => p.close);
    const proximityResult = computeProximityToHigh(
      q.close,
      proximityCloseHistory,
      score.proximityShortWindow,
      score.proximityLongWindow,
    );
    if (proximityResult.degraded) degraded.push("proximityToHigh240");

    const rs = rsScoreByCode.get(q.stockCode)!;
    if (rs.historyDays < 2) degraded.push("relativeStrength");

    const scores = {
      candleShape: candleShapeResult.score,
      volumeStrength: volumeStrengthScore,
      breakoutMargin: breakoutMarginScore,
      firstBar: firstBarResult.score,
      base: baseResult.score,
      proximityToHigh: proximityResult.score,
      relativeStrength: rs.score,
    };

    const totalScore =
      scores.candleShape * score.weights.candleShape +
      scores.volumeStrength * score.weights.volumeStrength +
      scores.breakoutMargin * score.weights.breakoutMargin +
      scores.firstBar * score.weights.firstBar +
      scores.base * score.weights.base +
      scores.proximityToHigh * score.weights.proximityToHigh +
      scores.relativeStrength * score.weights.relativeStrength;

    return {
      code: q.stockCode,
      name: q.name,
      close: q.close,
      changePercent,
      volumeRatio,
      scores,
      totalScore,
      rank: 0,
      historyDays: Math.max(baseResult.historyDays, stockProximityHistory.length, rs.historyDays),
      degraded,
    };
  });

  results.sort((a, b) => b.totalScore - a.totalScore);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  console.log(`\n${dateStr} 突破強度候選（共 ${results.length} 檔）：\n`);
  console.log(
    "排名".padEnd(6) +
      "代號".padEnd(8) +
      "名稱".padEnd(12) +
      "收盤".padEnd(10) +
      "漲跌%".padEnd(10) +
      "量比".padEnd(8) +
      "總分".padEnd(10) +
      "降級項目",
  );
  console.log("-".repeat(90));
  for (const r of results) {
    console.log(
      String(r.rank).padEnd(6) +
        r.code.padEnd(8) +
        r.name.padEnd(10) +
        r.close.toFixed(2).padEnd(10) +
        r.changePercent.toFixed(2).padEnd(10) +
        r.volumeRatio.toFixed(2).padEnd(8) +
        r.totalScore.toFixed(1).padEnd(10) +
        (r.degraded.length > 0 ? r.degraded.join(",") : "-"),
    );
  }

  const outputDir = join(__dirname, "..", "..", "data", "breakout-strength-results");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${dateStr}.json`);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        date: dateStr,
        gates: gate,
        weights: score.weights,
        stats: { totalStocks, triggered, passedGates },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n結果已寫入 ${outputPath}`);

  return { date: dateStr, isNonTradingDay: false, stats: { totalStocks, triggered, passedGates } };
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
    // 找最新交易日需要一個 client；用一次性 client 查完即關，正式計算的 client 由 calculateBreakoutStrength 內部自建
    const bootstrapPrisma = makePrisma();
    try {
      const latest = await bootstrapPrisma.dailyQuote.findFirst({
        orderBy: { date: "desc" },
        select: { date: true },
      });
      if (!latest) {
        console.log("資料庫裡沒有任何 DailyQuote 資料。");
        return;
      }
      targetDate = latest.date;
    } finally {
      await bootstrapPrisma.$disconnect();
    }
  }

  await calculateBreakoutStrength(targetDate);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((err) => {
    console.error("breakoutStrength 計算失敗:", err);
    process.exit(1);
  });
}
