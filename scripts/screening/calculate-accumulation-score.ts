import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import type { DeepPartial } from "../lib/types";
import { computeBase, DEFAULT_BREAKOUT_CONFIG } from "../lib/breakout-shared";
import {
  rankScore,
  computeTrustRawMetrics,
  computeOtherInstitutionRatio,
  computeQuietVolumeRatio,
  combineChipScore,
  combineTrustScore,
  computeReadinessCoefficient,
  combineFinalScore,
  resolveAccumulationConfig,
  type AccumulationConfig,
} from "../lib/accumulation-shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

// computeBase 的曲線參數：accumulation 沿用 breakout 的預設（壓縮度口徑一致，見 accumulation-shared.ts 檔頭）
const BASE_CURVE = DEFAULT_BREAKOUT_CONFIG.score.curves.base;

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---- 候選股快照：當日報價 + 當日指標 + 股本 ----
interface Snapshot {
  code: string;
  name: string;
  close: number;
  sharesOutstanding: number | null;
  bollingerUpper: number | null;
  bollingerBandwidth: number | null;
  volumeMa20: number | null;
}

async function buildCandidatePool(
  prisma: PrismaClient,
  date: Date,
  minAvgVolumeShares: number,
): Promise<{
  snapshots: Snapshot[];
  totalStocks: number;
  excludedAboveBand: number;
  excludedIlliquid: number;
}> {
  const quotes = await prisma.dailyQuote.findMany({
    where: { date, stock: { securityType: "stock" } },
    select: {
      stockCode: true,
      close: true,
      stock: { select: { name: true, sharesOutstanding: true } },
    },
  });

  if (quotes.length === 0) {
    return { snapshots: [], totalStocks: 0, excludedAboveBand: 0, excludedIlliquid: 0 };
  }

  const totalStocks = quotes.length;
  const codes = quotes.map((q) => q.stockCode);

  const indicators = await prisma.technicalIndicator.findMany({
    where: { date, stockCode: { in: codes } },
    select: { stockCode: true, bollingerUpper: true, bollingerBandwidth: true, volumeMa20: true },
  });
  const indicatorMap = new Map(indicators.map((i) => [i.stockCode, i]));

  let excludedAboveBand = 0;
  let excludedIlliquid = 0;
  const snapshots: Snapshot[] = [];

  for (const q of quotes) {
    const ind = indicatorMap.get(q.stockCode);
    const bollingerUpper = ind?.bollingerUpper ?? null;
    const volumeMa20 = ind?.volumeMa20 ?? null;

    // 1. 今日已站上布林上軌 → 與 calculate-breakout-strength.ts 觸發條件互斥，剔除
    if (bollingerUpper !== null && q.close > bollingerUpper) {
      excludedAboveBand += 1;
      continue;
    }

    // 2/3. 近 20 日均量下限 / volumeMa20 缺值 → 剔除（無法算窒息量，且冷門股量比不穩會霸榜）
    if (volumeMa20 === null || volumeMa20 <= 0 || volumeMa20 < minAvgVolumeShares) {
      excludedIlliquid += 1;
      continue;
    }

    snapshots.push({
      code: q.stockCode,
      name: q.stock.name,
      close: q.close,
      sharesOutstanding: q.stock.sharesOutstanding !== null ? Number(q.stock.sharesOutstanding) : null,
      bollingerUpper,
      bollingerBandwidth: ind?.bollingerBandwidth ?? null,
      volumeMa20,
    });
  }

  return { snapshots, totalStocks, excludedAboveBand, excludedIlliquid };
}

// ---- 各股票的原始因子輸入（新到舊排序的視窗序列，由 DB 一次撈完再組）----
interface FactorInputs {
  trustNetBuyNewestFirst: number[]; // investmentTrustNetBuy（近 INSTITUTIONAL_WINDOW_DAYS 天）
  foreignPlusDealerNewestFirst: number[]; // foreignNetBuy + dealerNetBuy（同窗）
  instVolumeNewestFirst: number[]; // 同窗對應的 DailyQuote.volume（其他法人集中度分母）
  quietVolumeRatioNewestFirst: number[]; // 近 SQUEEZE_VOLUME_WINDOW_DAYS 天 volume / volumeMa20
  bandwidthHistoryNewestFirst: (number | null)[]; // 不含當日，往前最多 BANDWIDTH_HISTORY_MAX_DAYS 天
}

async function buildFactorInputs(
  prisma: PrismaClient,
  date: Date,
  snapshots: Snapshot[],
  score: AccumulationConfig["score"],
): Promise<Map<string, FactorInputs>> {
  const codes = snapshots.map((s) => s.code);
  const volumeMa20ByCode = new Map(snapshots.map((s) => [s.code, s.volumeMa20!]));

  // 一次撈三張表的歷史（都 lte date，新到舊），再逐股票截視窗
  const [instRows, quoteRows, indicatorRows] = await Promise.all([
    prisma.institutionalTrading.findMany({
      where: { stockCode: { in: codes }, date: { lte: date } },
      orderBy: { date: "desc" },
      select: {
        stockCode: true,
        date: true,
        foreignNetBuy: true,
        investmentTrustNetBuy: true,
        dealerNetBuy: true,
      },
    }),
    prisma.dailyQuote.findMany({
      where: { stockCode: { in: codes }, date: { lte: date } },
      orderBy: { date: "desc" },
      select: { stockCode: true, date: true, volume: true },
    }),
    prisma.technicalIndicator.findMany({
      where: { stockCode: { in: codes }, date: { lt: date } }, // 不含當日
      orderBy: { date: "desc" },
      select: { stockCode: true, date: true, bollingerBandwidth: true },
    }),
  ]);

  // volume 依 stockCode + date 建索引（供其他法人集中度的分母對齊三大法人日期）
  const volumeByCodeDate = new Map<string, Map<number, number>>();
  const quoteDatesByCode = new Map<string, Date[]>();
  for (const r of quoteRows) {
    let m = volumeByCodeDate.get(r.stockCode);
    if (!m) {
      m = new Map();
      volumeByCodeDate.set(r.stockCode, m);
    }
    m.set(r.date.getTime(), Number(r.volume));

    let list = quoteDatesByCode.get(r.stockCode);
    if (!list) {
      list = [];
      quoteDatesByCode.set(r.stockCode, list);
    }
    list.push(r.date);
  }

  const instByCode = new Map<string, typeof instRows>();
  for (const r of instRows) {
    let list = instByCode.get(r.stockCode);
    if (!list) {
      list = [];
      instByCode.set(r.stockCode, list);
    }
    list.push(r);
  }

  const bandwidthByCode = new Map<string, (number | null)[]>();
  for (const r of indicatorRows) {
    let list = bandwidthByCode.get(r.stockCode);
    if (!list) {
      list = [];
      bandwidthByCode.set(r.stockCode, list);
    }
    if (list.length < score.bandwidthHistoryMaxDays) list.push(r.bollingerBandwidth);
  }

  const result = new Map<string, FactorInputs>();

  for (const code of codes) {
    const instList = (instByCode.get(code) ?? []).slice(0, score.institutionalWindowDays);
    const volMap = volumeByCodeDate.get(code);

    const trustNetBuyNewestFirst = instList.map((r) => Number(r.investmentTrustNetBuy ?? 0n));
    const foreignPlusDealerNewestFirst = instList.map(
      (r) => Number(r.foreignNetBuy ?? 0n) + Number(r.dealerNetBuy ?? 0n),
    );
    // 其他法人集中度的分母：與三大法人同一批日期的成交量
    const instVolumeNewestFirst = instList.map((r) => volMap?.get(r.date.getTime()) ?? 0);

    // 窒息量：近 SQUEEZE_VOLUME_WINDOW_DAYS 個交易日的 volume / volumeMa20
    const ma20 = volumeMa20ByCode.get(code)!;
    const recentDates = (quoteDatesByCode.get(code) ?? []).slice(0, score.squeezeVolumeWindowDays);
    const quietVolumeRatioNewestFirst = recentDates
      .map((d) => volMap?.get(d.getTime()) ?? null)
      .filter((v): v is number => v !== null)
      .map((v) => v / ma20);

    result.set(code, {
      trustNetBuyNewestFirst,
      foreignPlusDealerNewestFirst,
      instVolumeNewestFirst,
      quietVolumeRatioNewestFirst,
      bandwidthHistoryNewestFirst: bandwidthByCode.get(code) ?? [],
    });
  }

  return result;
}

interface AccumulationResult {
  code: string;
  name: string;
  date: string;
  close: number;
  chipScore: number;
  readinessCoef: number;
  finalScore: number;
  rank: number;
  breakdown: {
    trustScore: number;
    otherInstScore: number;
    squeezeScore: number;
    quietVolumeScore: number;
  };
  detail: {
    trustBuyFreq: number | null;
    trustConsecutiveDays: number;
    trustNetRatio: number | null;
    otherInstRatio: number | null;
    squeezeDepthDays: number;
    avgVolumeRatio5d: number | null;
  };
  degraded: string[];
}

export interface CalculateAccumulationOptions {
  prisma?: PrismaClient;
  config?: DeepPartial<AccumulationConfig>;
}

export async function calculateAccumulationScore(
  date: Date,
  options: CalculateAccumulationOptions = {},
): Promise<{
  date: string;
  isNonTradingDay: boolean;
  poolStats: { totalStocks: number; excludedAboveBand: number; excludedIlliquid: number; scored: number };
}> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  const config = resolveAccumulationConfig(options.config);
  try {
    return await runCalculation(prisma, date, config);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

async function runCalculation(
  prisma: PrismaClient,
  date: Date,
  config: AccumulationConfig,
): Promise<{
  date: string;
  isNonTradingDay: boolean;
  poolStats: { totalStocks: number; excludedAboveBand: number; excludedIlliquid: number; scored: number };
}> {
  const { gate, score } = config;
  const dateStr = toIsoDate(date);

  const { snapshots, totalStocks, excludedAboveBand, excludedIlliquid } = await buildCandidatePool(
    prisma,
    date,
    gate.minAvgVolumeShares,
  );

  if (totalStocks === 0) {
    console.log(`${dateStr} 無任何 DailyQuote 資料（非交易日？），跳過`);
    return {
      date: dateStr,
      isNonTradingDay: true,
      poolStats: { totalStocks: 0, excludedAboveBand: 0, excludedIlliquid: 0, scored: 0 },
    };
  }

  if (snapshots.length === 0) {
    console.log(
      `${dateStr}：候選池為空（共 ${totalStocks} 檔，剔除站上上軌 ${excludedAboveBand}、低流動性 ${excludedIlliquid}）`,
    );
    writeOutput(dateStr, config, { totalStocks, excludedAboveBand, excludedIlliquid, scored: 0 }, []);
    return {
      date: dateStr,
      isNonTradingDay: false,
      poolStats: { totalStocks, excludedAboveBand, excludedIlliquid, scored: 0 },
    };
  }

  const factorInputs = await buildFactorInputs(prisma, date, snapshots, score);

  // ---- 逐股票算原始指標 ----
  const trustRaw = snapshots.map((s) =>
    computeTrustRawMetrics(
      factorInputs.get(s.code)!.trustNetBuyNewestFirst,
      s.sharesOutstanding,
      score.institutionalWindowDays,
      score.minInstitutionalDaysRatio,
    ),
  );
  const otherInstRaw = snapshots.map((s) => {
    const fi = factorInputs.get(s.code)!;
    return computeOtherInstitutionRatio(
      fi.foreignPlusDealerNewestFirst,
      fi.instVolumeNewestFirst,
      score.institutionalWindowDays,
      score.minInstitutionalDaysRatio,
    );
  });
  const quietRaw = snapshots.map((s) =>
    computeQuietVolumeRatio(
      factorInputs.get(s.code)!.quietVolumeRatioNewestFirst,
      score.squeezeVolumeWindowDays,
      score.minSqueezeVolumeDays,
    ),
  );
  const baseRaw = snapshots.map((s) => {
    const history = factorInputs.get(s.code)!.bandwidthHistoryNewestFirst;
    return computeBase(s.bollingerBandwidth, history, score.baseMinHistoryDays, BASE_CURVE);
  });

  // ---- 跨市場 rankScore ----
  const trustFreqScores = rankScore(
    trustRaw.map((t) => t.buyFrequency),
    false,
    score.neutralScore,
  );
  const trustNetRatioScores = rankScore(
    trustRaw.map((t) => t.netRatio),
    false,
    score.neutralScore,
  );
  const otherInstScores = rankScore(
    otherInstRaw.map((o) => o.ratio),
    false,
    score.neutralScore,
  );
  // 窒息量：量比越低分數越高
  const quietVolumeScores = rankScore(
    quietRaw.map((q) => q.avgRatio),
    true,
    score.neutralScore,
  );

  // ---- 合成 ----
  const results: AccumulationResult[] = snapshots.map((s, i) => {
    const degraded: string[] = [];

    const t = trustRaw[i]!;
    const o = otherInstRaw[i]!;
    const q = quietRaw[i]!;
    const b = baseRaw[i]!;

    if (t.degraded) degraded.push("trustMomentum");
    if (t.netRatio === null && !t.degraded) degraded.push("trustNetRatio");
    if (o.degraded) degraded.push("otherInstitution");
    if (q.degraded) degraded.push("quietVolume");
    if (b.degraded) degraded.push("squeeze");

    const trustScore = t.degraded
      ? score.neutralScore
      : combineTrustScore(
          trustFreqScores[i]!,
          t.netRatio === null ? null : trustNetRatioScores[i]!,
          score.trustSubWeights,
        );
    const otherInstScore = otherInstScores[i]!;
    const chipScore = combineChipScore(trustScore, otherInstScore, score.chipWeights);

    const squeezeScore = b.score;
    const quietVolumeScore = quietVolumeScores[i]!;
    const readinessCoef = computeReadinessCoefficient(
      squeezeScore,
      quietVolumeScore,
      score.techWeights,
      score.readinessFloor,
    );

    const finalScore = combineFinalScore(chipScore, readinessCoef);

    return {
      code: s.code,
      name: s.name,
      date: dateStr,
      close: s.close,
      chipScore,
      readinessCoef,
      finalScore,
      rank: 0,
      breakdown: { trustScore, otherInstScore, squeezeScore, quietVolumeScore },
      detail: {
        trustBuyFreq: t.buyFrequency,
        trustConsecutiveDays: t.consecutiveBuyDays,
        trustNetRatio: t.netRatio,
        otherInstRatio: o.ratio,
        squeezeDepthDays: b.historyDays,
        avgVolumeRatio5d: q.avgRatio,
      },
      degraded,
    };
  });

  results.sort((a, b) => b.finalScore - a.finalScore);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  // ---- console 前 30 名 ----
  console.log(
    `\n${dateStr} 投信吃貨訊號排名（候選池 ${snapshots.length} 檔；剔除站上上軌 ${excludedAboveBand}、低流動性 ${excludedIlliquid}）：\n`,
  );
  console.log(
    "排名".padEnd(6) +
      "代號".padEnd(8) +
      "名稱".padEnd(12) +
      "收盤".padEnd(10) +
      "籌碼分".padEnd(9) +
      "就緒係數".padEnd(10) +
      "最終分".padEnd(9) +
      "降級項目",
  );
  console.log("-".repeat(95));
  for (const r of results.slice(0, 30)) {
    console.log(
      String(r.rank).padEnd(6) +
        r.code.padEnd(8) +
        r.name.padEnd(10) +
        r.close.toFixed(2).padEnd(10) +
        r.chipScore.toFixed(1).padEnd(9) +
        r.readinessCoef.toFixed(3).padEnd(10) +
        r.finalScore.toFixed(1).padEnd(9) +
        (r.degraded.length > 0 ? r.degraded.join(",") : "-"),
    );
  }

  writeOutput(
    dateStr,
    config,
    { totalStocks, excludedAboveBand, excludedIlliquid, scored: results.length },
    results,
  );

  return {
    date: dateStr,
    isNonTradingDay: false,
    poolStats: { totalStocks, excludedAboveBand, excludedIlliquid, scored: results.length },
  };
}

function writeOutput(
  dateStr: string,
  config: AccumulationConfig,
  poolStats: { totalStocks: number; excludedAboveBand: number; excludedIlliquid: number; scored: number },
  results: AccumulationResult[],
): void {
  const outputDir = join(__dirname, "..", "..", "data", "accumulation-score-results");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${dateStr}.json`);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        date: dateStr,
        windowDays: config.score.institutionalWindowDays,
        // 實際生效的 config（不傳 options.config 時即為 DEFAULT_ACCUMULATION_CONFIG）
        params: {
          gate: config.gate,
          score: config.score,
        },
        poolStats,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n結果已寫入 ${outputPath}`);
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
    // 找最新交易日需要一個 client；用一次性 client 查完即關，正式計算的 client 由 calculateAccumulationScore 內部自建
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

  await calculateAccumulationScore(targetDate);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((err) => {
    console.error("accumulationScore 計算失敗:", err);
    process.exit(1);
  });
}
