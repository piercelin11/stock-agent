import "dotenv/config";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import type { DeepPartial } from "../lib/types";
import {
  rankScore,
  fetchHistoryWindow,
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
import {
  BATCH_SIZE,
  computeElapsedRatio,
  fetchAllMisQuotes,
  type MisQuote,
} from "../lib/mis-quotes";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SNAPSHOT_DIR = join(__dirname, "..", "..", "data", "intraday-breakout-snapshots");
const PROGRESS_PATH = join(SNAPSHOT_DIR, "progress.json");

/** 原子寫：先寫 .tmp 再 rename，避免輪詢讀到寫一半的檔（比照 backtest 的 atomicWrite）。 */
function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// MIS 即時報價抓取已抽到 scripts/lib/mis-quotes.ts（run-signal-scan.ts 的 realtime 路徑共用）。

// ---- 主流程 ----
export interface CandidateResult {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  volumeRatio: number;
  estimatedFullDayVolume: number;
  marketCap: number;
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
  degraded: string[];
}

export interface IntradaySnapshotOutput {
  queriedAt: string;
  elapsedRatio: number;
  stats: { totalQueried: number; failedCount: number; triggered: number; passedGates: number };
  warnings: string[];
  results: CandidateResult[];
}

export interface CheckIntradayBreakoutOptions {
  prisma?: PrismaClient;
  config?: DeepPartial<BreakoutConfig>;
  now?: Date;
}

export async function checkIntradayBreakout(
  options: CheckIntradayBreakoutOptions = {},
): Promise<IntradaySnapshotOutput> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  const config = resolveBreakoutConfig(options.config);
  const now = options.now ?? new Date();
  try {
    return await runSnapshot(prisma, config, now);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

async function runSnapshot(
  prisma: PrismaClient,
  config: BreakoutConfig,
  now: Date,
): Promise<IntradaySnapshotOutput> {
  const { gate, score } = config;
  const { raw: elapsedRatioRaw, clipped: elapsedRatio } = computeElapsedRatio(now);
  const startedAt = now.toISOString();
  const warnings: string[] = [];

  mkdirSync(SNAPSHOT_DIR, { recursive: true });

  function writeProgress(fields: {
    phase: "fetching-quotes" | "scoring";
    fetchedBatches: number;
    totalBatches: number;
    failedCount: number;
  }): void {
    atomicWrite(PROGRESS_PATH, {
      status: "running",
      phase: fields.phase,
      queriedAt: startedAt,
      fetchedBatches: fields.fetchedBatches,
      totalBatches: fields.totalBatches,
      failedCount: fields.failedCount,
      startedAt,
      updatedAt: new Date().toISOString(),
      warnings,
      error: null,
    });
  }

  if (elapsedRatioRaw < 0.05) {
    const msg = "目前為開盤前，預估量能可能不準確";
    console.warn(`⚠ ${msg}`);
    warnings.push(msg);
  }

  const stocks = await prisma.stock.findMany({
    where: { securityType: "stock" },
    select: { code: true, name: true, market: true, sharesOutstanding: true },
  });
  const stockByCode = new Map(stocks.map((s) => [s.code, s]));

  const totalBatches = Math.ceil(stocks.length / BATCH_SIZE);
  writeProgress({ phase: "fetching-quotes", fetchedBatches: 0, totalBatches, failedCount: 0 });

  const { quotes: misQuotes, failedCount } = await fetchAllMisQuotes(
    stocks.map((s) => ({ code: s.code, market: s.market })),
    (done, total, failedSoFar) => {
      writeProgress({
        phase: "fetching-quotes",
        fetchedBatches: Math.ceil(done / BATCH_SIZE),
        totalBatches: Math.ceil(total / BATCH_SIZE),
        failedCount: failedSoFar,
      });
    },
  );

  writeProgress({ phase: "scoring", fetchedBatches: totalBatches, totalBatches, failedCount });

  // MIS 日期 vs 資料庫最新 DailyQuote 日期錯位偵測
  const latestDbQuote = await prisma.dailyQuote.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const latestDbDateStr = latestDbQuote ? toIsoDate(latestDbQuote.date) : null;
  const misDateSample = [...misQuotes.values()].find((q) => q.date !== null)?.date ?? null;

  if (misDateSample && latestDbDateStr && misDateSample === latestDbDateStr) {
    const msg = `MIS 回傳資料日期（${misDateSample}）與資料庫最新 DailyQuote 日期相同，可能是開盤前或 pipeline 尚未執行，本次快照可能是重複查詢舊資料`;
    console.warn(`⚠ ${msg}`);
    warnings.push(msg);
  }

  const codes = [...misQuotes.keys()];

  // T-1 布林上軌、T-1 均量
  const prevDate = latestDbQuote?.date ?? null;
  const prevIndicators = prevDate
    ? await prisma.technicalIndicator.findMany({
        where: { date: prevDate, stockCode: { in: codes } },
        select: { stockCode: true, bollingerUpper: true, volumeMa20: true },
      })
    : [];
  const prevIndicatorByCode = new Map(prevIndicators.map((r) => [r.stockCode, r]));

  // 第一層：觸發（帶價 + 帶量）
  interface Triggered {
    code: string;
    name: string;
    price: number;
    bollingerUpper: number;
    volumeMa20: number;
    estimatedFullDayVolume: number;
    volumeRatio: number;
  }
  const triggered: Triggered[] = [];

  for (const code of codes) {
    const quote = misQuotes.get(code)!;
    // MIS z bug：缺成交價的檔在此腳本沿用舊行為直接跳過（run-signal-scan.ts 才做 h 代入）
    if (quote.price === null) continue;
    const ind = prevIndicatorByCode.get(code);
    if (!ind || ind.bollingerUpper === null || ind.volumeMa20 === null || ind.volumeMa20 <= 0) continue;

    const passPrice = quote.price > ind.bollingerUpper;
    if (!passPrice) continue;

    const estimatedFullDayVolume = quote.cumulativeVolume / elapsedRatio;
    const volumeRatio = estimatedFullDayVolume / ind.volumeMa20;
    const passVolume = volumeRatio >= gate.triggerVolumeRatio;
    if (!passVolume) continue;

    triggered.push({
      code,
      name: quote.name,
      price: quote.price,
      bollingerUpper: ind.bollingerUpper,
      volumeMa20: ind.volumeMa20,
      estimatedFullDayVolume,
      volumeRatio,
    });
  }

  // 第二層：資格門檻
  let marketCapNullCount = 0;
  const passed = triggered.filter((t) => {
    const stock = stockByCode.get(t.code);
    const sharesOutstanding = stock?.sharesOutstanding !== null && stock?.sharesOutstanding !== undefined
      ? Number(stock.sharesOutstanding)
      : null;
    if (sharesOutstanding === null) {
      marketCapNullCount += 1;
      return false;
    }
    const marketCap = sharesOutstanding * t.price;
    const passCap = marketCap >= gate.minMarketCap;
    const passVolume = t.estimatedFullDayVolume >= gate.minVolumeShares;
    return passCap && passVolume;
  });

  if (marketCapNullCount > 0) {
    console.log(`市值門檻：${marketCapNullCount} 檔因 sharesOutstanding 為 null 被擋下（未計入通過門檻數）`);
  }

  console.log(
    `\n盤中快照篩選 —— 查詢時間: ${now.toLocaleString("zh-TW", { hour12: false })} (今日經過時間比例: ${(elapsedRatio * 100).toFixed(1)}%)`,
  );

  const passedCodes = passed.map((t) => t.code);

  if (passedCodes.length === 0) {
    console.log(`\n共查詢 ${codes.length} 檔（因批次失敗缺漏 ${failedCount} 檔）`);
    console.log(`觸發帶價+帶量: ${triggered.length} 檔`);
    console.log(`通過資格門檻: 0 檔`);

    const outputDir = SNAPSHOT_DIR;
    mkdirSync(outputDir, { recursive: true });
    const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
    const outputPath = join(outputDir, `${timestamp}.json`);
    const stats = { totalQueried: codes.length, failedCount, triggered: triggered.length, passedGates: 0 };
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          queriedAt: now.toISOString(),
          elapsedRatio,
          gates: gate,
          weights: score.weights,
          stats,
          warnings,
          results: [],
        },
        null,
        2,
      ),
    );
    console.log(`\n結果已寫入 ${outputPath}`);
    return { queriedAt: now.toISOString(), elapsedRatio, stats, warnings, results: [] };
  }

  // firstBar：即時價 vs T-1 上軌，往回接 T-2 以前的連續天數
  const firstBarLookbackDays = score.firstBarLookbackDays;
  const priorDate = prevDate; // T-1（已是最新一筆 DailyQuote）
  const [firstBarQuotes, firstBarIndicators] = priorDate
    ? await Promise.all([
        prisma.dailyQuote.findMany({
          where: { stockCode: { in: passedCodes }, date: { lte: priorDate } },
          orderBy: { date: "desc" },
          take: firstBarLookbackDays * passedCodes.length,
          select: { stockCode: true, date: true, close: true },
        }),
        prisma.technicalIndicator.findMany({
          where: { stockCode: { in: passedCodes }, date: { lte: priorDate } },
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
    for (const t of passed) {
      const dates = datesByStock.get(t.code) ?? [];
      const closeMap = closeByStockDate.get(t.code);
      const upperMap = bollUpperByStockDate.get(t.code);
      // series[0] 是即時價（今天）vs T-1 上軌，其餘接 T-1 以前的逐日序列
      const historicalSeries = dates.map((d) => ({
        close: closeMap?.get(d.getTime()) ?? Number.NaN,
        bollingerUpper: upperMap?.get(d.getTime()) ?? null,
      }));
      firstBarSeriesByStock.set(t.code, [{ close: t.price, bollingerUpper: t.bollingerUpper }, ...historicalSeries]);
    }
  }

  // base / proximityToHigh：T-1 往前最多 240 筆（不含今天，直接重用收盤版邏輯與輸入）
  const baseHistoryByStock = priorDate
    ? await fetchHistoryWindow(prisma, priorDate, passedCodes, score.baseMaxWindowDays)
    : new Map<string, HistoryPoint[]>();
  const proximityHistoryByStock = baseHistoryByStock;

  // relativeStrength：全市場（含即時價作為「今天」）近 61 筆 close
  const marketHistoryRows = priorDate
    ? await prisma.dailyQuote.findMany({
        where: { stockCode: { in: codes }, date: { lte: priorDate } },
        orderBy: { date: "desc" },
        select: { stockCode: true, date: true, close: true },
      })
    : [];
  const marketHistoryByStock = new Map<string, { date: Date; close: number }[]>();
  for (const code of codes) {
    const quote = misQuotes.get(code)!;
    if (quote.price === null) continue; // 缺成交價：此腳本不納入 RS 母體（沿用舊行為）
    marketHistoryByStock.set(code, [{ date: now, close: quote.price }]);
  }
  for (const row of marketHistoryRows) {
    const list = marketHistoryByStock.get(row.stockCode);
    if (list && list.length < score.rsWindowDays + 1) list.push(row);
  }

  const { returns: marketReturns, historyDays: rsHistoryDays } = computeMarketWideReturns(
    codes,
    marketHistoryByStock,
    score.rsWindowDays,
  );
  const rsScoresAllMarket = rankScore(marketReturns, false, score.naScore);
  const rsScoreByCode = new Map(codes.map((c, i) => [c, { score: rsScoresAllMarket[i]!, historyDays: rsHistoryDays.get(c) ?? 0 }]));

  const results: CandidateResult[] = passed.map((t) => {
    const degraded: string[] = [];

    const volumeStrengthScore = computeVolumeStrength(t.volumeRatio, score.curves.volumeStrength);
    const breakoutMarginScore = computeBreakoutMargin(
      t.price,
      t.bollingerUpper,
      score.curves.breakoutMargin,
    );

    // 即時型態：close 用當下即時價，high/low 用當日至今盤中最高/最低，收盤前仍可能變動，非最終分數
    const misQuoteForShape = misQuotes.get(t.code)!;
    const candleShapeResult = computeCandleShape({
      open: misQuoteForShape.open,
      high: misQuoteForShape.high,
      low: misQuoteForShape.low,
      close: t.price,
    });
    if (candleShapeResult.degraded) degraded.push("candleShape");

    const firstBarResult = computeFirstBar(firstBarSeriesByStock, t.code);
    if (firstBarResult.degraded) degraded.push("firstBar");

    const stockBaseHistory = baseHistoryByStock.get(t.code) ?? [];
    const latestBandwidth = stockBaseHistory.length > 0 ? stockBaseHistory[0]!.bollingerBandwidth : null;
    const bandwidthHistoryForRank = stockBaseHistory.map((p) => p.bollingerBandwidth);
    const baseResult = computeBase(
      latestBandwidth,
      bandwidthHistoryForRank,
      score.baseMinHistoryDays,
      score.curves.base,
    );
    if (baseResult.degraded) degraded.push("base");

    const stockProximityHistory = proximityHistoryByStock.get(t.code) ?? [];
    const proximityCloseHistory = stockProximityHistory.map((p) => p.close);
    const proximityResult = computeProximityToHigh(
      t.price,
      proximityCloseHistory,
      score.proximityShortWindow,
      score.proximityLongWindow,
    );
    if (proximityResult.degraded) degraded.push("proximityToHigh240");

    const rs = rsScoreByCode.get(t.code)!;
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

    const stock = stockByCode.get(t.code);
    const sharesOutstanding = stock?.sharesOutstanding !== null && stock?.sharesOutstanding !== undefined
      ? Number(stock.sharesOutstanding)
      : 0;
    const marketCap = sharesOutstanding * t.price;

    const misQuote = misQuotes.get(t.code)!;
    const changePercent =
      misQuote.prevClose !== null ? ((t.price - misQuote.prevClose) / misQuote.prevClose) * 100 : 0;

    return {
      code: t.code,
      name: t.name,
      price: t.price,
      changePercent,
      volumeRatio: t.volumeRatio,
      estimatedFullDayVolume: t.estimatedFullDayVolume,
      marketCap,
      scores,
      totalScore,
      rank: 0,
      degraded,
    };
  });

  results.sort((a, b) => b.totalScore - a.totalScore);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  if (elapsedRatioRaw < 0.05) {
    console.log("⚠ 若非盤中時段執行，以下預估量能可能不準確");
  }

  console.log(
    "\n" +
      "排名".padEnd(6) +
      "代號".padEnd(8) +
      "名稱".padEnd(12) +
      "即時價".padEnd(10) +
      "漲跌%".padEnd(10) +
      "量比".padEnd(8) +
      "總分".padEnd(10) +
      "降級項目",
  );
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(
      String(r.rank).padEnd(6) +
        r.code.padEnd(8) +
        r.name.padEnd(10) +
        r.price.toFixed(2).padEnd(10) +
        r.changePercent.toFixed(2).padEnd(10) +
        r.volumeRatio.toFixed(2).padEnd(8) +
        r.totalScore.toFixed(1).padEnd(10) +
        (r.degraded.length > 0 ? r.degraded.join(",") : "-"),
    );
  }

  console.log(`\n共查詢 ${codes.length} 檔（因批次失敗缺漏 ${failedCount} 檔）`);
  console.log(`觸發帶價+帶量: ${triggered.length} 檔`);
  console.log(`通過資格門檻: ${passed.length} 檔`);

  const outputDir = SNAPSHOT_DIR;
  mkdirSync(outputDir, { recursive: true });
  const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const outputPath = join(outputDir, `${timestamp}.json`);
  const stats = {
    totalQueried: codes.length,
    failedCount,
    triggered: triggered.length,
    passedGates: passed.length,
  };
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        queriedAt: now.toISOString(),
        elapsedRatio,
        gates: gate,
        weights: score.weights,
        stats,
        warnings,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n結果已寫入 ${outputPath}`);
  return { queriedAt: now.toISOString(), elapsedRatio, stats, warnings, results };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  checkIntradayBreakout().catch((err) => {
    console.error("盤中快照篩選失敗:", err);
    process.exit(1);
  });
}
