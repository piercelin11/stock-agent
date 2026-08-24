import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import {
  GATES,
  WEIGHTS,
  TRIGGER_VOLUME_RATIO,
  BASE_MAX_WINDOW_DAYS,
  RS_WINDOW_DAYS,
  rankScore,
  fetchHistoryWindow,
  computeVolumeStrength,
  computeBreakoutMargin,
  computeFirstBar,
  computeBase,
  computeProximityToHigh,
  computeMarketWideReturns,
  computeCandleShape,
  type HistoryPoint,
} from "./breakout-shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface QuoteRow {
  stockCode: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  volume: number;
  sharesOutstanding: number | null;
}

interface IndicatorRow {
  bollingerUpper: number | null;
  bollingerBandwidth: number | null;
  volumeMa20: number | null;
}

async function fetchTodayQuotes(date: Date): Promise<QuoteRow[]> {
  const quotes = await prisma.dailyQuote.findMany({
    where: { date, stock: { securityType: "stock" } },
    select: {
      stockCode: true,
      open: true,
      high: true,
      low: true,
      close: true,
      change: true,
      volume: true,
      stock: { select: { name: true, sharesOutstanding: true } },
    },
  });

  return quotes.map((q) => ({
    stockCode: q.stockCode,
    name: q.stock.name,
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    change: q.change,
    volume: Number(q.volume),
    sharesOutstanding: q.stock.sharesOutstanding !== null ? Number(q.stock.sharesOutstanding) : null,
  }));
}

async function fetchIndicatorsForDate(date: Date, codes: string[]): Promise<Map<string, IndicatorRow>> {
  const rows = await prisma.technicalIndicator.findMany({
    where: { date, stockCode: { in: codes } },
    select: { stockCode: true, bollingerUpper: true, bollingerBandwidth: true, volumeMa20: true },
  });
  return new Map(rows.map((r) => [r.stockCode, r]));
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

export async function calculateBreakoutStrength(date: Date): Promise<{
  date: string;
  isNonTradingDay: boolean;
  stats: { totalStocks: number; triggered: number; passedGates: number };
}> {
  const dateStr = toIsoDate(date);
  const quotes = await fetchTodayQuotes(date);

  if (quotes.length === 0) {
    console.log(`${dateStr} 無任何 DailyQuote 資料（非交易日？），跳過`);
    return { date: dateStr, isNonTradingDay: true, stats: { totalStocks: 0, triggered: 0, passedGates: 0 } };
  }

  const totalStocks = quotes.length;
  const codes = quotes.map((q) => q.stockCode);

  const todayIndicators = await fetchIndicatorsForDate(date, codes);

  // 第一層：觸發條件
  const triggeredQuotes = quotes.filter((q) => {
    const ind = todayIndicators.get(q.stockCode);
    if (!ind || ind.bollingerUpper === null || ind.volumeMa20 === null || ind.volumeMa20 <= 0) return false;
    const passPrice = q.close > ind.bollingerUpper;
    const passVolume = q.volume / ind.volumeMa20 >= TRIGGER_VOLUME_RATIO;
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
    const passCap = marketCap >= GATES.minMarketCap;
    const passVolume = q.volume >= GATES.minVolumeShares;
    return passCap && passVolume;
  });

  if (marketCapNullCount > 0) {
    console.log(`市值門檻：${marketCapNullCount} 檔因 sharesOutstanding 為 null 被擋下（未計入 passedGates）`);
  }

  const passedGates = passedQuotes.length;

  if (passedGates === 0) {
    console.log(`${dateStr}：觸發 ${triggered} 檔，通過門檻 0 檔`);
    const outputDir = join(__dirname, "..", "data", "breakout-strength-results");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `${dateStr}.json`);
    writeFileSync(
      outputPath,
      JSON.stringify(
        { date: dateStr, gates: GATES, weights: WEIGHTS, stats: { totalStocks, triggered, passedGates }, results: [] },
        null,
        2,
      ),
    );
    return { date: dateStr, isNonTradingDay: false, stats: { totalStocks, triggered, passedGates } };
  }

  const passedCodes = passedQuotes.map((q) => q.stockCode);

  // T-1 日期：抓比 date 早的最近一個交易日
  const prevDayRow = await prisma.dailyQuote.findFirst({
    where: { date: { lt: date }, stockCode: { in: passedCodes } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const prevDate = prevDayRow?.date ?? null;

  // firstBar 用：逐日 close+bollingerUpper 序列（近期，往回抓多一點確保能數到連續天數斷點）
  const firstBarLookbackDays = 30;
  const [firstBarQuotes, firstBarIndicators] = prevDate
    ? await Promise.all([
        prisma.dailyQuote.findMany({
          where: { stockCode: { in: passedCodes }, date: { lte: prevDate } },
          orderBy: { date: "desc" },
          take: firstBarLookbackDays * passedCodes.length,
          select: { stockCode: true, date: true, close: true },
        }),
        prisma.technicalIndicator.findMany({
          where: { stockCode: { in: passedCodes }, date: { lte: prevDate } },
          orderBy: { date: "desc" },
          take: firstBarLookbackDays * passedCodes.length,
          select: { stockCode: true, date: true, bollingerUpper: true },
        }),
      ])
    : [[], []];

  const firstBarSeriesByStock = new Map<string, { close: number; bollingerUpper: number | null }[]>();
  {
    const closeByStockDate = new Map<string, Map<number, number>>();
    for (const row of firstBarQuotes) {
      let m = closeByStockDate.get(row.stockCode);
      if (!m) {
        m = new Map();
        closeByStockDate.set(row.stockCode, m);
      }
      m.set(row.date.getTime(), row.close);
    }
    const bollUpperByStockDate = new Map<string, Map<number, number | null>>();
    for (const row of firstBarIndicators) {
      let m = bollUpperByStockDate.get(row.stockCode);
      if (!m) {
        m = new Map();
        bollUpperByStockDate.set(row.stockCode, m);
      }
      m.set(row.date.getTime(), row.bollingerUpper);
    }
    const datesByStock = new Map<string, Date[]>();
    for (const row of firstBarQuotes) {
      let list = datesByStock.get(row.stockCode);
      if (!list) {
        list = [];
        datesByStock.set(row.stockCode, list);
      }
      if (list.length < firstBarLookbackDays) list.push(row.date);
    }
    for (const code of passedCodes) {
      const dates = datesByStock.get(code) ?? [];
      const closeMap = closeByStockDate.get(code);
      const upperMap = bollUpperByStockDate.get(code);
      firstBarSeriesByStock.set(
        code,
        dates.map((d) => ({
          close: closeMap?.get(d.getTime()) ?? Number.NaN,
          bollingerUpper: upperMap?.get(d.getTime()) ?? null,
        })),
      );
    }
  }

  // base 用：T-1 往前最多 240 筆 bandwidth（不含今天）
  const baseHistoryByStock: Map<string, HistoryPoint[]> = prevDate
    ? await fetchHistoryWindow(prisma, prevDate, passedCodes, BASE_MAX_WINDOW_DAYS)
    : new Map();

  // proximityToHigh 用：T-1 往前最多 240 筆 close（不含今天）
  const proximityHistoryByStock = baseHistoryByStock; // 同一組資料可重用（皆為 T-1 起算的 240 筆窗）

  // relativeStrength 用：全市場（totalStocks 全部）近 61 筆 close，含今天
  const marketHistoryRows = await prisma.dailyQuote.findMany({
    where: { stockCode: { in: codes }, date: { lte: date } },
    orderBy: { date: "desc" },
    select: { stockCode: true, date: true, close: true },
  });
  const marketHistoryByStock = new Map<string, { date: Date; close: number }[]>();
  for (const row of marketHistoryRows) {
    let list = marketHistoryByStock.get(row.stockCode);
    if (!list) {
      list = [];
      marketHistoryByStock.set(row.stockCode, list);
    }
    if (list.length < RS_WINDOW_DAYS + 1) list.push(row);
  }

  const { returns: marketReturns, historyDays: rsHistoryDays } = computeMarketWideReturns(codes, marketHistoryByStock);
  const rsScoresAllMarket = rankScore(marketReturns, false, 50);
  const rsScoreByCode = new Map(codes.map((c, i) => [c, { score: rsScoresAllMarket[i]!, historyDays: rsHistoryDays.get(c) ?? 0 }]));

  const results: BreakoutResult[] = passedQuotes.map((q) => {
    const ind = todayIndicators.get(q.stockCode)!;
    const bollingerUpper = ind.bollingerUpper!;
    const volumeMa20 = ind.volumeMa20!;
    const volumeRatio = q.volume / volumeMa20;

    const prevClose = q.close - q.change;
    const changePercent = prevClose > 0 ? (q.change / prevClose) * 100 : 0;

    const degraded: string[] = [];

    const volumeStrengthScore = computeVolumeStrength(volumeRatio);
    const breakoutMarginScore = computeBreakoutMargin(q.close, bollingerUpper);

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
    const baseResult = computeBase(yesterdayBandwidth, bandwidthHistoryForRank);
    if (baseResult.degraded) degraded.push("base");

    const stockProximityHistory = proximityHistoryByStock.get(q.stockCode) ?? [];
    const proximityCloseHistory = stockProximityHistory.map((p) => p.close);
    const proximityResult = computeProximityToHigh(q.close, proximityCloseHistory);
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
      scores.candleShape * WEIGHTS.candleShape +
      scores.volumeStrength * WEIGHTS.volumeStrength +
      scores.breakoutMargin * WEIGHTS.breakoutMargin +
      scores.firstBar * WEIGHTS.firstBar +
      scores.base * WEIGHTS.base +
      scores.proximityToHigh * WEIGHTS.proximityToHigh +
      scores.relativeStrength * WEIGHTS.relativeStrength;

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

  const outputDir = join(__dirname, "..", "data", "breakout-strength-results");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${dateStr}.json`);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        date: dateStr,
        gates: GATES,
        weights: WEIGHTS,
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

  await calculateBreakoutStrength(targetDate);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main()
    .catch((err) => {
      console.error("breakoutStrength 計算失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
