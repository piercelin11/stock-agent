import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Market } from "../../generated/prisma/client";
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

const __dirname = dirname(fileURLToPath(import.meta.url));

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

const MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const BATCH_SIZE = 120;
const BATCH_DELAY_MS = 1500;

const MARKET_OPEN_HOUR = 9;
const MARKET_CLOSE_HOUR = 13;
const MARKET_CLOSE_MINUTE = 30;
const TRADING_MINUTES = (MARKET_CLOSE_HOUR - MARKET_OPEN_HOUR) * 60 + MARKET_CLOSE_MINUTE; // 270 分鐘

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---- MIS 即時報價 ----
interface MisRawRow {
  c: string; // 代號
  n: string; // 名稱
  z: string; // 成交價（可能是 "-"）
  y?: string; // 昨收
  v?: string; // 累計成交量（張，可能缺失或 "-"）
  d?: string; // 日期
  o?: string; // 開盤價（可能缺失或 "-"）
  h?: string; // 盤中至今最高價（可能缺失或 "-"）
  l?: string; // 盤中至今最低價（可能缺失或 "-"）
}

interface MisQuote {
  code: string;
  name: string;
  price: number;
  prevClose: number | null;
  cumulativeVolume: number;
  date: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
}

function exChPrefix(market: Market): string {
  return market === Market.TWSE ? "tse" : "otc";
}

function parseMisDate(raw: string | undefined): string | null {
  if (!raw) return null;
  // 觀察到的格式可能是 YYYYMMDD；若格式不符，回傳 null 而不是猜測解析
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(raw)) {
    return raw.replaceAll("/", "-");
  }
  return null;
}

async function fetchMisBatch(codes: { code: string; market: Market }[]): Promise<{
  quotes: MisQuote[];
  failed: boolean;
}> {
  const exCh = codes.map((c) => `${exChPrefix(c.market)}_${c.code}.tw`).join("|");
  const url = new URL(MIS_URL);
  url.searchParams.set("ex_ch", exCh);
  url.searchParams.set("json", "1");
  url.searchParams.set("delay", "0");

  try {
    const res = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.warn(`⚠ MIS 批次請求失敗: ${res.status} ${res.statusText}（${codes.length} 檔）`);
      return { quotes: [], failed: true };
    }
    const body = (await res.json()) as { msgArray?: MisRawRow[] };
    const rows = body.msgArray ?? [];

    const quotes: MisQuote[] = [];
    for (const row of rows) {
      if (row.z === "-" || row.z === undefined) continue; // 尚無成交，跳過
      const price = parseFloat(row.z);
      if (!Number.isFinite(price)) continue;

      // MIS 的 v 欄位單位是「張」，換算成「股」以跟 DailyQuote.volume / GATES.minVolumeShares 的股數單位一致
      const volumeRaw = row.v;
      const cumulativeVolumeLots =
        volumeRaw === undefined || volumeRaw === "-" ? 0 : (parseFloat(volumeRaw) || 0);
      const cumulativeVolume = cumulativeVolumeLots * 1000;

      const prevCloseRaw = row.y;
      const prevCloseParsed =
        prevCloseRaw === undefined || prevCloseRaw === "-" ? NaN : parseFloat(prevCloseRaw);
      const prevClose = Number.isFinite(prevCloseParsed) && prevCloseParsed > 0 ? prevCloseParsed : null;

      const parsePositive = (raw: string | undefined): number | null => {
        if (raw === undefined || raw === "-") return null;
        const parsed = parseFloat(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      };

      quotes.push({
        code: row.c,
        name: row.n,
        price,
        prevClose,
        cumulativeVolume,
        date: parseMisDate(row.d),
        open: parsePositive(row.o),
        high: parsePositive(row.h),
        low: parsePositive(row.l),
      });
    }
    return { quotes, failed: false };
  } catch (err) {
    console.warn(`⚠ MIS 批次請求例外: ${err instanceof Error ? err.message : String(err)}（${codes.length} 檔）`);
    return { quotes: [], failed: true };
  }
}

async function fetchAllMisQuotes(
  stocks: { code: string; market: Market }[],
): Promise<{ quotes: Map<string, MisQuote>; failedCount: number }> {
  const quotes = new Map<string, MisQuote>();
  let failedCount = 0;

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    const { quotes: batchQuotes, failed } = await fetchMisBatch(batch);
    if (failed) {
      failedCount += batch.length;
    } else {
      for (const q of batchQuotes) {
        quotes.set(q.code, q);
      }
    }
    if (i + BATCH_SIZE < stocks.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return { quotes, failedCount };
}

// ---- elapsedRatio ----
function computeElapsedRatio(now: Date): { raw: number; clipped: number } {
  const minutesSinceOpen =
    (now.getHours() - MARKET_OPEN_HOUR) * 60 + now.getMinutes() + now.getSeconds() / 60;
  const raw = minutesSinceOpen / TRADING_MINUTES;
  const clipped = Math.min(Math.max(raw, 0.05), 1.0);
  return { raw, clipped };
}

// ---- 主流程 ----
interface CandidateResult {
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

export interface CheckIntradayBreakoutOptions {
  prisma?: PrismaClient;
  config?: DeepPartial<BreakoutConfig>;
  now?: Date;
}

export async function checkIntradayBreakout(options: CheckIntradayBreakoutOptions = {}): Promise<void> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  const config = resolveBreakoutConfig(options.config);
  const now = options.now ?? new Date();
  try {
    await runSnapshot(prisma, config, now);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

async function runSnapshot(prisma: PrismaClient, config: BreakoutConfig, now: Date): Promise<void> {
  const { gate, score } = config;
  const { raw: elapsedRatioRaw, clipped: elapsedRatio } = computeElapsedRatio(now);

  if (elapsedRatioRaw < 0.05) {
    console.warn("⚠ 目前為開盤前，預估量能可能不準確");
  }

  const stocks = await prisma.stock.findMany({
    where: { securityType: "stock" },
    select: { code: true, name: true, market: true, sharesOutstanding: true },
  });
  const stockByCode = new Map(stocks.map((s) => [s.code, s]));

  const { quotes: misQuotes, failedCount } = await fetchAllMisQuotes(
    stocks.map((s) => ({ code: s.code, market: s.market })),
  );

  // MIS 日期 vs 資料庫最新 DailyQuote 日期錯位偵測
  const latestDbQuote = await prisma.dailyQuote.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const latestDbDateStr = latestDbQuote ? toIsoDate(latestDbQuote.date) : null;
  const misDateSample = [...misQuotes.values()].find((q) => q.date !== null)?.date ?? null;

  if (misDateSample && latestDbDateStr && misDateSample === latestDbDateStr) {
    console.warn(
      `⚠ MIS 回傳資料日期（${misDateSample}）與資料庫最新 DailyQuote 日期相同，可能是開盤前或 pipeline 尚未執行，本次快照可能是重複查詢舊資料`,
    );
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

    const outputDir = join(__dirname, "..", "..", "data", "intraday-breakout-snapshots");
    mkdirSync(outputDir, { recursive: true });
    const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
    const outputPath = join(outputDir, `${timestamp}.json`);
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          queriedAt: now.toISOString(),
          elapsedRatio,
          gates: gate,
          weights: score.weights,
          stats: { totalQueried: codes.length, failedCount, triggered: triggered.length, passedGates: 0 },
          results: [],
        },
        null,
        2,
      ),
    );
    console.log(`\n結果已寫入 ${outputPath}`);
    return;
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

  const outputDir = join(__dirname, "..", "..", "data", "intraday-breakout-snapshots");
  mkdirSync(outputDir, { recursive: true });
  const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const outputPath = join(outputDir, `${timestamp}.json`);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        queriedAt: now.toISOString(),
        elapsedRatio,
        gates: gate,
        weights: score.weights,
        stats: { totalQueried: codes.length, failedCount, triggered: triggered.length, passedGates: passed.length },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n結果已寫入 ${outputPath}`);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  checkIntradayBreakout().catch((err) => {
    console.error("盤中快照篩選失敗:", err);
    process.exit(1);
  });
}
