import "dotenv/config";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Market } from "../../generated/prisma/client";
import type { DeepPartial } from "../lib/types";
import {
  rankScore,
  computeVolumeStrength,
  computeFirstBar,
  computeBase,
  computeProximityToHigh,
  computeMarketWideReturns,
  computeCandleShape,
  computeTrustRawMetrics,
  computeOtherInstitutionRatio,
  computeQuietVolumeRatio,
  combineChipScore,
  combineTrustScore,
  computeReadinessCoefficient,
  combineFinalScore,
  computeBreakoutMarginMonotone,
  computeInstitutionalFlow,
  computeMarginSurgePercentile,
  consecutiveAboveBand,
  resolveSignalConfig,
  fetchBreakoutRawInputs,
  fetchAccumulationRawInputs,
  fetchHistoryWindow,
  type SignalScanConfig,
  type HistoryPoint,
  type BreakoutRawInputs,
} from "../lib/signal-factors/index";
import {
  BATCH_SIZE,
  computeElapsedRatio,
  fetchAllMisQuotes,
  type MisQuote,
} from "../lib/mis-quotes";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESULT_DIR = join(__dirname, "..", "..", "data", "signal-scan-results");
const PROGRESS_PATH = join(RESULT_DIR, "progress.json");

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Asia/Taipei 今天的 YYYY-MM-DD（比照其他腳本用 UTC+8 偏移）。 */
function taipeiTodayIso(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

// ============================================================================
// 對外型別（PLAN §3.1）
// ============================================================================

export type SignalStage = "pre-breakout" | "breakout-day" | "extended";
export type SignalSource = "eod" | "realtime";

export interface SignalResult {
  code: string;
  name: string;
  stage: SignalStage;
  close: number; // eod = 收盤定案；realtime = 即時價或 h 代入（見 priceSource）
  changePercent: number;
  totalScore: number; // 該股所屬階段的合併分數
  rank: number; // 同階段內排名
  priceSource: "eod" | "realtime" | "estimated";
  scores: Record<string, number>; // 該階段用到的分項
  detail?: Record<string, number | null>; // pre-breakout 的原始指標
  degraded: string[]; // 資料不足 / 不確定（語意不變）
  warnings: string[]; // PLAN §4：資料充足、系統明確發現的風險訊號（目前只有 "margin-chasing"）
  // PLAN §4.1：展開列三欄用的中繼值。只在 breakout-day / extended 的 push 帶；pre-breakout undefined。
  volumeRatio?: number; // 觸發量比（今日 volume / volumeMa20）
  inst?: {
    trustRatio: number; // 近 lookbackDays 日投信淨買超 ÷ volumeMa20
    foreignRatio: number; // 同上，外資
    todayTrustDir: -1 | 0 | 1 | null; // 今日投信淨買超方向（null = 盤中無當日資料）
    todayForeignDir: -1 | 0 | 1 | null;
  };
  factors?: {
    breakoutMarginScore: number; // = scores.breakoutMargin（重述，方便前端一次拿齊）
    breakoutMarginPct: number; // (close - bollingerUpper) / bollingerUpper * 100
    proximityShortScore: number; // computeProximityToHigh 短窗分數
    proximityLongScore: number; // 長窗分數
    proximityShortPct: number; // 收盤距短窗高點的 % 距離（<= 0）
    proximityLongPct: number; // 距長窗高點的 % 距離
  };
  // 醞釀階段法人籌碼區塊（前端 PreBreakoutInstitutional 用）。只在 pre-breakout 的 push 帶。
  // 與 lib/actions/watchlist.ts 的 PreBreakoutInst 結構相同（screening 展開列與 watchlist 卡片共用元件）。
  preInst?: {
    buyDayFlags: boolean[]; // 20 日投信淨買超 > 0 的逐日布林，舊 → 新
    buyDays: number;
    consecutiveBuyDays: number;
    dataDays: number;
    trustScore: number | null; // = scores.trustScore
    otherInstScore: number | null; // = scores.otherInstScore
    trustNetRatio: number | null; // = detail.trustNetRatio
    otherInstRatio: number | null; // = detail.otherInstRatio
    degraded: boolean; // dataDays < ceil(institutionalWindowDays * minInstitutionalDaysRatio)
  };
  // PLAN 2 §3.1：這檔是因為在 watchlist 才豁免 gate 進 results（未過 gate / 未達觸發量比）。
  // 前端據此標「觀察清單」提示，避免使用者誤以為它通過全部門檻。
  fromWatchlist?: boolean;
}

// PLAN 2 §3.2：所有 watchlist 成員的即時報價（不只過 gate 的），供 watchlist 頁 PLAN 3 讀。
// 與 SignalResult 分開：watchlist 頁需要「每一檔觀察股都有東西顯示」，即使它沒進 results。
export interface WatchlistQuote {
  code: string;
  name: string;
  close: number;
  changePercent: number;
  volume: number; // eod = 當日 DailyQuote.volume；realtime = 估全日量
  priceSource: "eod" | "realtime" | "estimated";
  refDate: string; // eod = 交易日；realtime = MIS 日期或今日
}

export interface SignalScanOutput {
  date: string; // eod = 交易日；realtime = 當下日期
  source: SignalSource;
  queriedAt: string;
  elapsedRatio?: number; // realtime 才有
  isNonTradingDay: boolean;
  stats: {
    totalStocks: number;
    passedGate: number;
    preBreakout: number;
    breakoutDay: number;
    extended: number;
    breakoutBelowVolume?: number; // close > 上軌但量比 < triggerVolumeRatio，不進 results
    failedCount?: number; // realtime MIS 批次失敗數
    estimatedCount?: number; // realtime 缺 z 用 h 代入的檔數
    skippedNoPriceCount?: number; // realtime z / h 都缺，跳過不評分
    watchlistExempt?: number; // PLAN 2 §3.1：因在 watchlist 而豁免 gate / 觸發量比進 results 的檔數
  };
  warnings: string[];
  results: SignalResult[];
  watchlistQuotes?: WatchlistQuote[]; // PLAN 2 §3.2：所有觀察股即時報價
}

export interface RunSignalScanOptions {
  prisma?: PrismaClient;
  config?: DeepPartial<SignalScanConfig>;
  source?: SignalSource;
  now?: Date;
}

// ============================================================================
// 主入口
// ============================================================================

export async function runSignalScan(
  date: Date,
  options: RunSignalScanOptions = {},
): Promise<SignalScanOutput> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  const config = resolveSignalConfig(options.config);
  const now = options.now ?? new Date();
  try {
    const source = await resolveSource(prisma, date, options.source, now);
    if (source === "eod") {
      return await runEod(prisma, config, date, now);
    }
    return await runRealtime(prisma, config, now);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

/** §3.2 資料源自動切換：options.source 有值用它；否則查 DB「今天的 DailyQuote 存在嗎」。 */
async function resolveSource(
  prisma: PrismaClient,
  date: Date,
  explicit: SignalSource | undefined,
  now: Date,
): Promise<SignalSource> {
  if (explicit) return explicit;
  const todayIso = taipeiTodayIso(now);
  // date 參數若被明確指定成非今天（CLI --date），視為 eod 補算
  if (toIsoDate(date) !== todayIso) return "eod";
  const todayQuote = await prisma.dailyQuote.findFirst({
    where: { date, stock: { securityType: "stock" } },
    select: { stockCode: true },
  });
  return todayQuote ? "eod" : "realtime";
}

// ============================================================================
// 共用：把一檔的 breakout 8 分項算完（eod / realtime 皆用），close 由呼叫端決定
// ============================================================================

interface BreakoutFactorInput {
  code: string;
  name: string;
  close: number;
  changePercent: number;
  bollingerUpper: number;
  volumeMa20: number;
  volumeRatio: number;
  // firstBar / base / proximity 用的序列（新到舊）
  firstBarSeries: { close: number; bollingerUpper: number | null }[];
  history: HistoryPoint[];
  // candleShape 輸入（realtime 缺 z 時 open/high/low 走 degraded）
  candle: { open: number | null; high: number | null; low: number | null; close: number };
  // relativeStrength 由呼叫端跨市場算好後傳分數
  rsScore: number;
  rsHistoryDays: number;
  // institutionalFlow 輸入
  instFlow: {
    trustNetBuyNewestFirst: number[];
    foreignNetBuyNewestFirst: number[];
    todayTrustNetBuy: number | null;
    todayForeignNetBuy: number | null;
  };
  // PLAN §5.2：融資餘額近期增速百分位（null = 盤中 / 資料不足 → margin-chasing 不觸發）
  marginSurgePercentile: number | null;
  // candleShape 是否因缺價走 degraded（realtime estimated）
  candleForcedDegraded: boolean;
}

interface BreakoutFactorOutput {
  scores: {
    candleShape: number;
    volumeStrength: number;
    breakoutMargin: number;
    firstBar: number;
    base: number;
    proximityToHigh: number;
    relativeStrength: number;
    institutionalFlow: number;
  };
  degraded: string[];
  warnings: string[]; // PLAN §5.2：目前只有 "margin-chasing"
  // PLAN §4.4：raw 中繼值，組裝成 SignalResult.inst / .factors 在呼叫端做。
  raw: {
    breakoutMarginPct: number;
    proximityShortScore: number;
    proximityLongScore: number;
    proximityShortPct: number;
    proximityLongPct: number;
    instTrustRatio: number;
    instForeignRatio: number;
    instTodayTrustDir: -1 | 0 | 1 | null;
    instTodayForeignDir: -1 | 0 | 1 | null;
  };
}

function computeBreakoutFactors(
  input: BreakoutFactorInput,
  config: SignalScanConfig,
): BreakoutFactorOutput {
  const b = config.breakout;
  const degraded: string[] = [];

  const volumeStrength = computeVolumeStrength(input.volumeRatio, b.curves.volumeStrength);
  const breakoutMargin = computeBreakoutMarginMonotone(
    input.close,
    input.bollingerUpper,
    b.curves.breakoutMargin,
  );

  let candleShape: number;
  if (input.candleForcedDegraded) {
    candleShape = 50;
    degraded.push("candleShape");
  } else {
    const cs = computeCandleShape(input.candle);
    candleShape = cs.score;
    if (cs.degraded) degraded.push("candleShape");
  }

  const fb = computeFirstBar(new Map([[input.code, input.firstBarSeries]]), input.code);
  if (fb.degraded) degraded.push("firstBar");

  const latestBandwidth = input.history.length > 0 ? input.history[0]!.bollingerBandwidth : null;
  const bandwidthHistory = input.history.map((p) => p.bollingerBandwidth);
  const baseResult = computeBase(
    latestBandwidth,
    bandwidthHistory,
    b.baseMinHistoryDays,
    config.baseCurve,
  );
  if (baseResult.degraded) degraded.push("base");

  const proximityResult = computeProximityToHigh(
    input.close,
    input.history.map((p) => p.close),
    b.proximityShortWindow,
    b.proximityLongWindow,
  );
  if (proximityResult.degraded) degraded.push("proximityToHigh240");

  const breakoutMarginPct = ((input.close - input.bollingerUpper) / input.bollingerUpper) * 100;

  if (input.rsHistoryDays < 2) degraded.push("relativeStrength");

  const flow = computeInstitutionalFlow({
    trustNetBuyNewestFirst: input.instFlow.trustNetBuyNewestFirst,
    foreignNetBuyNewestFirst: input.instFlow.foreignNetBuyNewestFirst,
    todayTrustNetBuy: input.instFlow.todayTrustNetBuy,
    todayForeignNetBuy: input.instFlow.todayForeignNetBuy,
    volumeMa20: input.volumeMa20,
    marginSurgePercentile: input.marginSurgePercentile,
    config: b.institutionalFlow,
  });
  if (flow.degraded) degraded.push("institutionalFlow");

  const warnings: string[] = [];
  if (flow.marginChasing) warnings.push("margin-chasing");

  return {
    scores: {
      candleShape,
      volumeStrength,
      breakoutMargin,
      firstBar: fb.score,
      base: baseResult.score,
      proximityToHigh: proximityResult.score,
      relativeStrength: input.rsScore,
      institutionalFlow: flow.score,
    },
    degraded,
    warnings,
    raw: {
      breakoutMarginPct,
      proximityShortScore: proximityResult.shortScore,
      proximityLongScore: proximityResult.longScore,
      proximityShortPct: proximityResult.shortPct,
      proximityLongPct: proximityResult.longPct,
      instTrustRatio: flow.trustRatio,
      instForeignRatio: flow.foreignRatio,
      instTodayTrustDir: flow.todayTrustDir,
      instTodayForeignDir: flow.todayForeignDir,
    },
  };
}

/** PLAN §4.4：把 computeBreakoutFactors 的 raw 中繼值組成 SignalResult.inst / .factors。 */
function breakoutExtras(factors: BreakoutFactorOutput): Pick<SignalResult, "inst" | "factors"> {
  return {
    inst: {
      trustRatio: factors.raw.instTrustRatio,
      foreignRatio: factors.raw.instForeignRatio,
      todayTrustDir: factors.raw.instTodayTrustDir,
      todayForeignDir: factors.raw.instTodayForeignDir,
    },
    factors: {
      breakoutMarginScore: factors.scores.breakoutMargin,
      breakoutMarginPct: factors.raw.breakoutMarginPct,
      proximityShortScore: factors.raw.proximityShortScore,
      proximityLongScore: factors.raw.proximityLongScore,
      proximityShortPct: factors.raw.proximityShortPct,
      proximityLongPct: factors.raw.proximityLongPct,
    },
  };
}

/** 醞釀階段：把 trustNetBuy 序列 + 已算好的分數/原始值組成 SignalResult.preInst（前端展開列/卡片共用元件用）。 */
function preBreakoutExtras(
  trustNetBuyNewestFirst: number[],
  trustScore: number,
  otherInstScore: number,
  trustNetRatio: number | null,
  otherInstRatio: number | null,
  minDataDays: number,
): Pick<SignalResult, "preInst"> {
  const flagsNewToOld = trustNetBuyNewestFirst.map((v) => v > 0);
  const dataDays = flagsNewToOld.length;
  let consecutiveBuyDays = 0;
  for (const f of flagsNewToOld) {
    if (f) consecutiveBuyDays += 1;
    else break;
  }
  return {
    preInst: {
      buyDayFlags: [...flagsNewToOld].reverse(), // 舊 → 新
      buyDays: flagsNewToOld.filter(Boolean).length,
      consecutiveBuyDays,
      dataDays,
      trustScore,
      otherInstScore,
      trustNetRatio,
      otherInstRatio,
      degraded: dataDays < minDataDays,
    },
  };
}

function breakoutTotalScore(
  scores: BreakoutFactorOutput["scores"],
  stage: "breakout-day" | "extended",
  config: SignalScanConfig,
): number {
  const w =
    stage === "extended"
      ? { ...config.breakout.weights, ...config.breakout.extendedWeights }
      : config.breakout.weights;
  return (
    scores.candleShape * w.candleShape +
    scores.volumeStrength * w.volumeStrength +
    scores.breakoutMargin * w.breakoutMargin +
    scores.firstBar * w.firstBar +
    scores.base * w.base +
    scores.proximityToHigh * w.proximityToHigh +
    scores.relativeStrength * w.relativeStrength +
    scores.institutionalFlow * w.institutionalFlow
  );
}

// ============================================================================
// EOD 路徑
// ============================================================================

async function runEod(
  prisma: PrismaClient,
  config: SignalScanConfig,
  date: Date,
  now: Date,
): Promise<SignalScanOutput> {
  const dateStr = toIsoDate(date);
  const b = config.breakout;
  const warnings: string[] = [];

  // 1. 撈全市場一般股票的 breakout 原始輸入（撈 DB + 組視窗序列，含 firstBar / base / proximity / rs）
  const rawInputs = await fetchBreakoutRawInputs(prisma, date, {
    firstBarLookbackDays: b.firstBarLookbackDays,
    baseMaxWindowDays: b.baseMaxWindowDays,
    rsWindowDays: b.rsWindowDays,
  });

  if (rawInputs.size === 0) {
    warnings.push(`${dateStr} 無任何 DailyQuote 資料（非交易日？）`);
    return emptyOutput(dateStr, "eod", now, warnings, true);
  }

  const allEntries = [...rawInputs.entries()];
  const totalStocks = allEntries.length;
  const codes = allEntries.map(([c]) => c);

  // PLAN 2 §3.1：watchlist 成員豁免 gate（RS 分數本來就全市場算，豁免後帶得到 PR / 醞釀籌碼）
  const watchlistCodes = new Set(
    (await prisma.watchlistItem.findMany({ select: { stockCode: true } })).map(
      (w) => w.stockCode,
    ),
  );

  // 2. relativeStrength：全市場一次算好百分位
  const marketHistoryByStock = new Map<string, { date: Date; close: number }[]>();
  for (const [code, raw] of allEntries) {
    marketHistoryByStock.set(code, raw.rsCloseSeries);
  }
  const { returns: marketReturns, historyDays: rsHistoryDays } = computeMarketWideReturns(
    codes,
    marketHistoryByStock,
    b.rsWindowDays,
  );
  const rsScores = rankScore(marketReturns, false, b.naScore);
  const rsByCode = new Map(
    codes.map((c, i) => [c, { score: rsScores[i]!, historyDays: rsHistoryDays.get(c) ?? 0 }]),
  );

  // 3. gate（市值 + 流動性）+ 階段判定
  interface Staged {
    code: string;
    name: string;
    close: number;
    changePercent: number;
    stage: SignalStage;
    raw: BreakoutRawInputs;
    volumeRatio: number | null; // breakout 階段才有意義（今日 volume / volumeMa20）
    bollingerUpper: number | null;
    volumeMa20: number | null;
  }
  const staged: Staged[] = [];
  let breakoutBelowVolume = 0;
  let watchlistExempt = 0;

  for (const [code, raw] of allEntries) {
    const q = raw.quote;
    const exempt = watchlistCodes.has(code);
    // PLAN 2 §3.1：exempt 檔一律 push 進 staged，gate 全跳過（含 sharesOutstanding null——
    // 下游 compute* 對缺值本來就有 degraded 處理）。
    // gate：市值 + 當日量 + 均量下限
    if (!exempt && q.sharesOutstanding === null) continue;
    if (!exempt) {
      const marketCap = q.sharesOutstanding! * q.close;
      if (marketCap < config.gate.minMarketCap) continue;
      if (q.volume < config.gate.minVolumeShares) continue;
    }

    const ind = raw.indicator;
    const volumeMa20 = ind?.volumeMa20 ?? null;
    if (
      !exempt &&
      (volumeMa20 === null || volumeMa20 <= 0 || volumeMa20 < config.gate.minAvgVolumeShares)
    ) {
      continue;
    }
    const bollingerUpper = ind?.bollingerUpper ?? null;

    const prevClose = q.close - q.change;
    const changePercent = prevClose > 0 ? (q.change / prevClose) * 100 : 0;

    // 階段判定：series[0] = 當日 close vs 當日 bollingerUpper，往回接 T-1 序列
    const stagingSeries = [
      { close: q.close, bollingerUpper },
      ...raw.firstBarSeries,
    ];
    const aboveBand = consecutiveAboveBand(stagingSeries);

    let stage: SignalStage;
    if (!aboveBand.ok) {
      // bollingerUpper 缺 → 無法判定站上與否，保守歸 pre-breakout（不進突破榜）
      stage = "pre-breakout";
    } else if (!aboveBand.latestAboveBand) {
      stage = "pre-breakout";
    } else if (volumeMa20 === null || volumeMa20 <= 0) {
      // exempt 檔沒有 volumeMa20（一般股票不會走到這，防呆）→ 無法算 breakout 分項，歸 pre-breakout
      stage = "pre-breakout";
    } else if (aboveBand.consecutiveDays <= config.staging.extendedAfterDays) {
      stage = "breakout-day";
    } else {
      stage = "extended";
    }

    let volumeRatio: number | null = null;
    if (stage !== "pre-breakout") {
      volumeRatio = volumeMa20 != null && volumeMa20 > 0 ? q.volume / volumeMa20 : null;
      // 觸發量比：只對 breakout 階段套用「進榜門檻」，沒過就不進 results（exempt 檔豁免——
      // 否則觀察股突破了但量沒到 2 倍又消失）
      if (
        !exempt &&
        (volumeRatio === null || volumeRatio < config.gate.triggerVolumeRatio)
      ) {
        breakoutBelowVolume += 1;
        continue;
      }
    }

    if (exempt) watchlistExempt += 1;
    staged.push({
      code,
      name: q.name,
      close: q.close,
      changePercent,
      stage,
      raw,
      volumeRatio,
      bollingerUpper,
      volumeMa20,
    });
  }

  const passedGate = staged.length;

  // 4. pre-breakout 需要 accumulation 因子（另撈三表），breakout 需要 institutionalFlow（另撈法人近 5 日）
  const preCodes = staged.filter((s) => s.stage === "pre-breakout").map((s) => s.code);
  const breakoutCodes = staged.filter((s) => s.stage !== "pre-breakout").map((s) => s.code);

  const volumeMa20ByCode = new Map<string, number | null>(
    staged.map((s) => [s.code, s.volumeMa20]),
  );
  const accInputs =
    preCodes.length > 0
      ? await fetchAccumulationRawInputs(prisma, date, preCodes, volumeMa20ByCode, {
          institutionalWindowDays: config.preBreakout.institutionalWindowDays,
          squeezeVolumeWindowDays: config.preBreakout.squeezeVolumeWindowDays,
          bandwidthHistoryMaxDays: b.baseMaxWindowDays,
        })
      : new Map();

  // institutionalFlow：breakout 階段近 lookbackDays 天 + 當日 投信 / 外資淨買超
  const flowInputByCode = await fetchInstitutionalFlowInputs(
    prisma,
    date,
    breakoutCodes,
    b.institutionalFlow.lookbackDays,
  );

  // PLAN §5.2：margin-chasing 用的融資餘額增速百分位（eod = 撈到掃描日含當日）
  const marginSurgeByCode = await fetchMarginSurgeInputs(prisma, date, breakoutCodes, {
    lookbackDays: b.institutionalFlow.marginChasing.lookbackDays,
    historyWindowDays: b.institutionalFlow.marginChasing.historyWindowDays,
    minHistoryDays: b.institutionalFlow.marginChasing.minHistoryDays,
  });

  // 5. 逐階段合併
  const results: SignalResult[] = [];

  // 5a. pre-breakout（乘法，沿用 accumulation 合成）
  const preStaged = staged.filter((s) => s.stage === "pre-breakout");
  if (preStaged.length > 0) {
    const pb = config.preBreakout;
    const trustRaw = preStaged.map((s) =>
      computeTrustRawMetrics(
        accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [],
        s.raw.quote.sharesOutstanding,
        pb.institutionalWindowDays,
        pb.minInstitutionalDaysRatio,
      ),
    );
    const otherRaw = preStaged.map((s) => {
      const fi = accInputs.get(s.code);
      return computeOtherInstitutionRatio(
        fi?.foreignPlusDealerNewestFirst ?? [],
        fi?.instVolumeNewestFirst ?? [],
        pb.institutionalWindowDays,
        pb.minInstitutionalDaysRatio,
      );
    });
    const quietRaw = preStaged.map((s) =>
      computeQuietVolumeRatio(
        accInputs.get(s.code)?.quietVolumeRatioNewestFirst ?? [],
        pb.squeezeVolumeWindowDays,
        pb.minSqueezeVolumeDays,
      ),
    );
    const baseRaw = preStaged.map((s) => {
      const history = accInputs.get(s.code)?.bandwidthHistoryNewestFirst ?? [];
      const latestBandwidth = s.raw.indicator?.bollingerBandwidth ?? null;
      return computeBase(latestBandwidth, history, pb.baseMinHistoryDays, config.baseCurve);
    });

    const trustFreqScores = rankScore(trustRaw.map((t) => t.buyFrequency), false, pb.neutralScore);
    const trustNetRatioScores = rankScore(trustRaw.map((t) => t.netRatio), false, pb.neutralScore);
    const otherInstScores = rankScore(otherRaw.map((o) => o.ratio), false, pb.neutralScore);
    const quietVolumeScores = rankScore(quietRaw.map((q) => q.avgRatio), true, pb.neutralScore);

    preStaged.forEach((s, i) => {
      const degraded: string[] = [];
      const t = trustRaw[i]!;
      const o = otherRaw[i]!;
      const q = quietRaw[i]!;
      const bs = baseRaw[i]!;

      if (t.degraded) degraded.push("trustMomentum");
      if (t.netRatio === null && !t.degraded) degraded.push("trustNetRatio");
      if (o.degraded) degraded.push("otherInstitution");
      if (q.degraded) degraded.push("quietVolume");
      if (bs.degraded) degraded.push("squeeze");

      const trustScore = t.degraded
        ? pb.neutralScore
        : combineTrustScore(
            trustFreqScores[i]!,
            t.netRatio === null ? null : trustNetRatioScores[i]!,
            pb.trustSubWeights,
          );
      const otherInstScore = otherInstScores[i]!;
      const chipScore = combineChipScore(trustScore, otherInstScore, pb.chipWeights);

      const squeezeScore = bs.score;
      const quietVolumeScore = quietVolumeScores[i]!;
      const readinessCoef = computeReadinessCoefficient(
        squeezeScore,
        quietVolumeScore,
        pb.techWeights,
        pb.readinessFloor,
      );
      const finalScore = combineFinalScore(chipScore, readinessCoef);

      results.push({
        code: s.code,
        name: s.name,
        stage: "pre-breakout",
        close: s.close,
        changePercent: s.changePercent,
        totalScore: finalScore,
        rank: 0,
        priceSource: "eod",
        scores: {
          trustScore,
          otherInstScore,
          squeezeScore,
          quietVolumeScore,
          chipScore,
          readinessCoef,
        },
        detail: {
          trustBuyFreq: t.buyFrequency,
          trustConsecutiveDays: t.consecutiveBuyDays,
          trustNetRatio: t.netRatio,
          otherInstRatio: o.ratio,
          squeezeDepthDays: bs.historyDays,
          avgVolumeRatio5d: q.avgRatio,
        },
        ...preBreakoutExtras(
          accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [],
          trustScore,
          otherInstScore,
          t.netRatio,
          o.ratio,
          Math.ceil(pb.institutionalWindowDays * pb.minInstitutionalDaysRatio),
        ),
        degraded,
        warnings: [], // pre-breakout 恆無 warnings（PLAN §4）
        ...(watchlistCodes.has(s.code) ? { fromWatchlist: true } : {}),
      });
    });
  }

  // 5b. breakout-day / extended（加權和，8 分項）
  const breakoutStaged = staged.filter((s) => s.stage !== "pre-breakout");
  for (const s of breakoutStaged) {
    const rs = rsByCode.get(s.code)!;
    const flowInput = flowInputByCode.get(s.code) ?? {
      trustNetBuyNewestFirst: [],
      foreignNetBuyNewestFirst: [],
      todayTrustNetBuy: null,
      todayForeignNetBuy: null,
    };
    const q = s.raw.quote;
    const factors = computeBreakoutFactors(
      {
        code: s.code,
        name: s.name,
        close: s.close,
        changePercent: s.changePercent,
        bollingerUpper: s.bollingerUpper!, // breakout 階段必有（latestAboveBand 為真）
        volumeMa20: s.volumeMa20!,
        volumeRatio: s.volumeRatio!,
        firstBarSeries: s.raw.firstBarSeries,
        history: s.raw.history,
        candle: { open: q.open, high: q.high, low: q.low, close: s.close },
        rsScore: rs.score,
        rsHistoryDays: rs.historyDays,
        instFlow: flowInput,
        marginSurgePercentile: marginSurgeByCode.get(s.code) ?? null,
        candleForcedDegraded: false,
      },
      config,
    );
    const stage = s.stage as "breakout-day" | "extended";
    const totalScore = breakoutTotalScore(factors.scores, stage, config);
    results.push({
      code: s.code,
      name: s.name,
      stage,
      close: s.close,
      changePercent: s.changePercent,
      totalScore,
      rank: 0,
      priceSource: "eod",
      scores: factors.scores,
      degraded: factors.degraded,
      warnings: factors.warnings,
      volumeRatio: s.volumeRatio!,
      ...breakoutExtras(factors),
      ...(watchlistCodes.has(s.code) ? { fromWatchlist: true } : {}),
    });
  }

  rankWithinStages(results);

  const stats = {
    totalStocks,
    passedGate,
    preBreakout: results.filter((r) => r.stage === "pre-breakout").length,
    breakoutDay: results.filter((r) => r.stage === "breakout-day").length,
    extended: results.filter((r) => r.stage === "extended").length,
    breakoutBelowVolume,
    watchlistExempt,
  };

  // PLAN 2 §3.2：所有 watchlist 成員的即時報價（eod = 一次批量查掃描日 DailyQuote）
  const watchlistQuotes = await buildEodWatchlistQuotes(
    prisma,
    date,
    dateStr,
    [...watchlistCodes],
  );

  const output: SignalScanOutput = {
    date: dateStr,
    source: "eod",
    queriedAt: now.toISOString(),
    isNonTradingDay: false,
    stats,
    warnings,
    results,
    watchlistQuotes,
  };

  printSummary(output);
  writeResult(dateStr, output, config);
  return output;
}

/** PLAN 2 §3.2（eod）：一次查掃描日的 DailyQuote，缺該日 quote 的檔不放進 watchlistQuotes。 */
async function buildEodWatchlistQuotes(
  prisma: PrismaClient,
  date: Date,
  dateStr: string,
  codes: string[],
): Promise<WatchlistQuote[]> {
  if (codes.length === 0) return [];
  const rows = await prisma.dailyQuote.findMany({
    where: { stockCode: { in: codes }, date },
    select: {
      stockCode: true,
      close: true,
      change: true,
      volume: true,
      stock: { select: { name: true } },
    },
  });
  return rows.map((r) => {
    const prevClose = r.close - r.change;
    return {
      code: r.stockCode,
      name: r.stock.name,
      close: r.close,
      changePercent: prevClose > 0 ? (r.change / prevClose) * 100 : 0,
      volume: Number(r.volume),
      priceSource: "eod" as const,
      refDate: dateStr,
    };
  });
}

// ============================================================================
// REALTIME 路徑（§3.2 + §4 MIS z bug）
// ============================================================================

async function runRealtime(
  prisma: PrismaClient,
  config: SignalScanConfig,
  now: Date,
): Promise<SignalScanOutput> {
  const b = config.breakout;
  const dateStr = taipeiTodayIso(now);
  const warnings: string[] = [];
  const { raw: elapsedRatioRaw, clipped: elapsedRatio } = computeElapsedRatio(now);
  const startedAt = now.toISOString();

  mkdirSync(RESULT_DIR, { recursive: true });

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

  // 結束時（成功）覆寫 progress.json 為 done —— CLI 直接跑也不會留下卡在 running 的殘檔。
  // 背景任務模式下 _run-signal-scan.ts 還會再寫一次（同資料，無害）；error 態由 runner 負責。
  function writeProgressDone(out: SignalScanOutput): void {
    atomicWrite(PROGRESS_PATH, {
      status: "done",
      phase: "done",
      queriedAt: out.queriedAt,
      fetchedBatches: 0,
      totalBatches: 0,
      failedCount: out.stats.failedCount ?? 0,
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
    // 排除已下市：MIS 對下市代號回空值本來就會被跳過，這裡只是省掉白打的 batch
    where: { securityType: "stock", delistedAt: null },
    select: { code: true, name: true, market: true, sharesOutstanding: true },
  });
  const stockByCode = new Map(stocks.map((s) => [s.code, s]));

  // PLAN 2 §3.1：watchlist 成員豁免 gate（eod 路徑同）
  const watchlistCodes = new Set(
    (await prisma.watchlistItem.findMany({ select: { stockCode: true } })).map(
      (w) => w.stockCode,
    ),
  );
  const totalBatches = Math.ceil(stocks.length / BATCH_SIZE);
  writeProgress({ phase: "fetching-quotes", fetchedBatches: 0, totalBatches, failedCount: 0 });

  const { quotes: misQuotes, failedCount } = await fetchAllMisQuotes(
    stocks.map((s) => ({ code: s.code, market: s.market as Market })),
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

  // T-1：最新一筆 DailyQuote 日期
  const latestDbQuote = await prisma.dailyQuote.findFirst({
    where: { stock: { securityType: "stock" } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const prevDate = latestDbQuote?.date ?? null;

  if (prevDate === null) {
    warnings.push("資料庫無 DailyQuote，無法取得 T-1 布林上軌 / 均量");
    const out = emptyOutput(dateStr, "realtime", now, warnings, false, elapsedRatio);
    const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
    writeResult(timestamp, out, config);
    writeProgressDone(out);
    return out;
  }

  const misDateSample = [...misQuotes.values()].find((q) => q.date !== null)?.date ?? null;
  const prevDateStr = toIsoDate(prevDate);
  if (misDateSample && misDateSample === prevDateStr) {
    warnings.push(
      `MIS 回傳資料日期（${misDateSample}）與資料庫最新 DailyQuote 相同，可能開盤前或 pipeline 尚未跑，本次可能是重複查詢舊資料`,
    );
  }

  const quotedCodes = [...misQuotes.keys()];

  // T-1 指標：全市場（後面 RS 母體用）
  const prevIndicators = await prisma.technicalIndicator.findMany({
    where: { date: prevDate, stockCode: { in: quotedCodes } },
    select: { stockCode: true, bollingerUpper: true, volumeMa20: true, bollingerBandwidth: true },
  });
  const prevIndByCode = new Map(prevIndicators.map((r) => [r.stockCode, r]));

  // ---- 每檔決定 close（z → realtime；缺 z 用 h → estimated；z/h 都缺 → 跳過）----
  interface RtRow {
    code: string;
    name: string;
    close: number;
    priceSource: "realtime" | "estimated";
    changePercent: number;
    estimatedFullDayVolume: number;
    quote: MisQuote;
  }
  const rtRows: RtRow[] = [];
  let estimatedCount = 0;
  let skippedNoPriceCount = 0;

  for (const code of quotedCodes) {
    const quote = misQuotes.get(code)!;
    let close: number;
    let priceSource: "realtime" | "estimated";
    if (quote.price !== null) {
      close = quote.price;
      priceSource = "realtime";
    } else if (quote.high !== null) {
      close = quote.high; // §4：h 是保守上界，代入只會低估突破強度
      priceSource = "estimated";
      estimatedCount += 1;
    } else {
      skippedNoPriceCount += 1;
      continue;
    }
    const changePercent =
      quote.prevClose !== null ? ((close - quote.prevClose) / quote.prevClose) * 100 : 0;
    const estimatedFullDayVolume = quote.cumulativeVolume / elapsedRatio;
    rtRows.push({ code, name: quote.name, close, priceSource, changePercent, estimatedFullDayVolume, quote });
  }

  if (estimatedCount > 0) {
    warnings.push(
      `MIS 有 ${estimatedCount} 檔無成交價，已用盤中最高價代入（突破判定保守、K 棒形態項為佔位分）`,
    );
  }

  const totalStocks = rtRows.length;

  // ---- relativeStrength：以 rtRows 為母體（即時 close 當「今天」），近 rsWindowDays+1 筆 ----
  const marketHistoryRows = await prisma.dailyQuote.findMany({
    where: { stockCode: { in: rtRows.map((r) => r.code) }, date: { lte: prevDate } },
    orderBy: { date: "desc" },
    select: { stockCode: true, date: true, close: true },
  });
  const marketHistoryByStock = new Map<string, { date: Date; close: number }[]>();
  for (const r of rtRows) {
    marketHistoryByStock.set(r.code, [{ date: now, close: r.close }]);
  }
  for (const row of marketHistoryRows) {
    const list = marketHistoryByStock.get(row.stockCode);
    if (list && list.length < b.rsWindowDays + 1) list.push(row);
  }
  const rtCodes = rtRows.map((r) => r.code);
  const { returns: marketReturns, historyDays: rsHistoryDays } = computeMarketWideReturns(
    rtCodes,
    marketHistoryByStock,
    b.rsWindowDays,
  );
  const rsScores = rankScore(marketReturns, false, b.naScore);
  const rsByCode = new Map(
    rtCodes.map((c, i) => [c, { score: rsScores[i]!, historyDays: rsHistoryDays.get(c) ?? 0 }]),
  );

  // ---- gate + 階段判定 ----
  interface RtStaged extends RtRow {
    stage: SignalStage;
    bollingerUpper: number | null;
    volumeMa20: number | null;
    bollingerBandwidth: number | null;
    volumeRatio: number | null;
  }
  const staged: RtStaged[] = [];
  let breakoutBelowVolume = 0;
  let watchlistExempt = 0;

  for (const row of rtRows) {
    const exempt = watchlistCodes.has(row.code);
    const stock = stockByCode.get(row.code);
    const sharesOutstanding =
      stock?.sharesOutstanding !== null && stock?.sharesOutstanding !== undefined
        ? Number(stock.sharesOutstanding)
        : null;
    if (!exempt) {
      if (sharesOutstanding === null) continue;
      const marketCap = sharesOutstanding * row.close;
      if (marketCap < config.gate.minMarketCap) continue;
      if (row.estimatedFullDayVolume < config.gate.minVolumeShares) continue;
    }

    const ind = prevIndByCode.get(row.code);
    const volumeMa20 = ind?.volumeMa20 ?? null;
    if (
      !exempt &&
      (volumeMa20 === null || volumeMa20 <= 0 || volumeMa20 < config.gate.minAvgVolumeShares)
    ) {
      continue;
    }
    const bollingerUpper = ind?.bollingerUpper ?? null;

    // 階段判定：即時 close（或 h 代入）vs T-1 上軌，往回接 T-1 以前序列（見下）
    // 這裡先只用 T-1 一筆判 latestAboveBand，consecutiveDays 需要歷史序列（下面補撈）
    let stage: SignalStage;
    if (bollingerUpper === null) {
      stage = "pre-breakout";
    } else if (row.close <= bollingerUpper) {
      stage = "pre-breakout";
    } else if (volumeMa20 === null || volumeMa20 <= 0) {
      // exempt 檔沒有 T-1 volumeMa20（防呆）→ 無法算 breakout 分項，歸 pre-breakout
      stage = "pre-breakout";
    } else {
      stage = "breakout-day"; // 先暫定，consecutiveDays 補算後可能升 extended
    }

    let volumeRatio: number | null = null;
    if (stage !== "pre-breakout") {
      volumeRatio =
        volumeMa20 != null && volumeMa20 > 0
          ? row.estimatedFullDayVolume / volumeMa20
          : null;
      if (
        !exempt &&
        (volumeRatio === null || volumeRatio < config.gate.triggerVolumeRatio)
      ) {
        breakoutBelowVolume += 1;
        continue;
      }
    }

    if (exempt) watchlistExempt += 1;
    staged.push({
      ...row,
      stage,
      bollingerUpper,
      volumeMa20,
      bollingerBandwidth: ind?.bollingerBandwidth ?? null,
      volumeRatio,
    });
  }

  const passedGate = staged.length;

  const preStaged = staged.filter((s) => s.stage === "pre-breakout");
  const breakoutStaged = staged.filter((s) => s.stage !== "pre-breakout");
  const breakoutCodes = breakoutStaged.map((s) => s.code);
  const preCodes = preStaged.map((s) => s.code);

  // ---- breakout 階段補撈：firstBar 序列（T-1 以前）+ base/proximity 歷史 ----
  const [firstBarSeriesByStock, historyByStock] = breakoutCodes.length > 0
    ? await Promise.all([
        fetchFirstBarSeriesToDate(prisma, prevDate, breakoutCodes, b.firstBarLookbackDays),
        fetchHistoryWindow(prisma, prevDate, breakoutCodes, b.baseMaxWindowDays),
      ])
    : [new Map<string, { close: number; bollingerUpper: number | null }[]>(), new Map<string, HistoryPoint[]>()];

  // institutionalFlow：到 T-1 為止的回看窗（當日法人盤中拿不到 → null → degraded）
  const flowInputByCode = await fetchInstitutionalFlowInputs(
    prisma,
    prevDate,
    breakoutCodes,
    b.institutionalFlow.lookbackDays,
    /* toDateInclusive */ true,
  );

  // PLAN §5.2：realtime 當日融資餘額晚上才公布 → toDate = null → 全 null → margin-chasing 不觸發
  const marginSurgeByCode = await fetchMarginSurgeInputs(prisma, null, breakoutCodes, {
    lookbackDays: b.institutionalFlow.marginChasing.lookbackDays,
    historyWindowDays: b.institutionalFlow.marginChasing.historyWindowDays,
    minHistoryDays: b.institutionalFlow.marginChasing.minHistoryDays,
  });

  // ---- pre-breakout 補撈：accumulation 三表（到 T-1） ----
  const volumeMa20ByCode = new Map<string, number | null>(staged.map((s) => [s.code, s.volumeMa20]));
  const accInputs =
    preCodes.length > 0
      ? await fetchAccumulationRawInputs(prisma, prevDate, preCodes, volumeMa20ByCode, {
          institutionalWindowDays: config.preBreakout.institutionalWindowDays,
          squeezeVolumeWindowDays: config.preBreakout.squeezeVolumeWindowDays,
          bandwidthHistoryMaxDays: b.baseMaxWindowDays,
        })
      : new Map();

  const results: SignalResult[] = [];

  // pre-breakout（乘法）
  if (preStaged.length > 0) {
    const pb = config.preBreakout;
    const sharesByCode = new Map(
      preStaged.map((s) => {
        const st = stockByCode.get(s.code);
        return [
          s.code,
          st?.sharesOutstanding !== null && st?.sharesOutstanding !== undefined
            ? Number(st.sharesOutstanding)
            : null,
        ];
      }),
    );
    const trustRaw = preStaged.map((s) =>
      computeTrustRawMetrics(
        accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [],
        sharesByCode.get(s.code) ?? null,
        pb.institutionalWindowDays,
        pb.minInstitutionalDaysRatio,
      ),
    );
    const otherRaw = preStaged.map((s) => {
      const fi = accInputs.get(s.code);
      return computeOtherInstitutionRatio(
        fi?.foreignPlusDealerNewestFirst ?? [],
        fi?.instVolumeNewestFirst ?? [],
        pb.institutionalWindowDays,
        pb.minInstitutionalDaysRatio,
      );
    });
    const quietRaw = preStaged.map((s) =>
      computeQuietVolumeRatio(
        accInputs.get(s.code)?.quietVolumeRatioNewestFirst ?? [],
        pb.squeezeVolumeWindowDays,
        pb.minSqueezeVolumeDays,
      ),
    );
    const baseRaw = preStaged.map((s) => {
      const history = accInputs.get(s.code)?.bandwidthHistoryNewestFirst ?? [];
      return computeBase(s.bollingerBandwidth, history, pb.baseMinHistoryDays, config.baseCurve);
    });

    const trustFreqScores = rankScore(trustRaw.map((t) => t.buyFrequency), false, pb.neutralScore);
    const trustNetRatioScores = rankScore(trustRaw.map((t) => t.netRatio), false, pb.neutralScore);
    const otherInstScores = rankScore(otherRaw.map((o) => o.ratio), false, pb.neutralScore);
    const quietVolumeScores = rankScore(quietRaw.map((q) => q.avgRatio), true, pb.neutralScore);

    preStaged.forEach((s, i) => {
      const degraded: string[] = [];
      const t = trustRaw[i]!;
      const o = otherRaw[i]!;
      const q = quietRaw[i]!;
      const bs = baseRaw[i]!;
      if (t.degraded) degraded.push("trustMomentum");
      if (t.netRatio === null && !t.degraded) degraded.push("trustNetRatio");
      if (o.degraded) degraded.push("otherInstitution");
      if (q.degraded) degraded.push("quietVolume");
      if (bs.degraded) degraded.push("squeeze");

      const trustScore = t.degraded
        ? pb.neutralScore
        : combineTrustScore(
            trustFreqScores[i]!,
            t.netRatio === null ? null : trustNetRatioScores[i]!,
            pb.trustSubWeights,
          );
      const otherInstScore = otherInstScores[i]!;
      const chipScore = combineChipScore(trustScore, otherInstScore, pb.chipWeights);
      const squeezeScore = bs.score;
      const quietVolumeScore = quietVolumeScores[i]!;
      const readinessCoef = computeReadinessCoefficient(
        squeezeScore,
        quietVolumeScore,
        pb.techWeights,
        pb.readinessFloor,
      );
      const finalScore = combineFinalScore(chipScore, readinessCoef);

      results.push({
        code: s.code,
        name: s.name,
        stage: "pre-breakout",
        close: s.close,
        changePercent: s.changePercent,
        totalScore: finalScore,
        rank: 0,
        priceSource: s.priceSource,
        scores: { trustScore, otherInstScore, squeezeScore, quietVolumeScore, chipScore, readinessCoef },
        detail: {
          trustBuyFreq: t.buyFrequency,
          trustConsecutiveDays: t.consecutiveBuyDays,
          trustNetRatio: t.netRatio,
          otherInstRatio: o.ratio,
          squeezeDepthDays: bs.historyDays,
          avgVolumeRatio5d: q.avgRatio,
        },
        ...preBreakoutExtras(
          accInputs.get(s.code)?.trustNetBuyNewestFirst ?? [],
          trustScore,
          otherInstScore,
          t.netRatio,
          o.ratio,
          Math.ceil(pb.institutionalWindowDays * pb.minInstitutionalDaysRatio),
        ),
        degraded,
        warnings: [], // pre-breakout 恆無 warnings（PLAN §4）
        ...(watchlistCodes.has(s.code) ? { fromWatchlist: true } : {}),
      });
    });
  }

  // breakout-day / extended
  for (const s of breakoutStaged) {
    // consecutiveDays：即時 close vs T-1 上軌，往回接 T-1 以前序列
    const stagingSeries = [
      { close: s.close, bollingerUpper: s.bollingerUpper },
      ...(firstBarSeriesByStock.get(s.code) ?? []),
    ];
    const aboveBand = consecutiveAboveBand(stagingSeries);
    const stage: "breakout-day" | "extended" =
      aboveBand.ok && aboveBand.consecutiveDays > config.staging.extendedAfterDays
        ? "extended"
        : "breakout-day";

    const rs = rsByCode.get(s.code)!;
    const flowInput = flowInputByCode.get(s.code) ?? {
      trustNetBuyNewestFirst: [],
      foreignNetBuyNewestFirst: [],
      todayTrustNetBuy: null,
      todayForeignNetBuy: null,
    };
    const factors = computeBreakoutFactors(
      {
        code: s.code,
        name: s.name,
        close: s.close,
        changePercent: s.changePercent,
        bollingerUpper: s.bollingerUpper!,
        volumeMa20: s.volumeMa20!,
        volumeRatio: s.volumeRatio!,
        firstBarSeries: firstBarSeriesByStock.get(s.code) ?? [],
        history: historyByStock.get(s.code) ?? [],
        candle: { open: s.quote.open, high: s.quote.high, low: s.quote.low, close: s.close },
        rsScore: rs.score,
        rsHistoryDays: rs.historyDays,
        instFlow: flowInput,
        marginSurgePercentile: marginSurgeByCode.get(s.code) ?? null, // realtime 恆 null
        candleForcedDegraded: s.priceSource === "estimated",
      },
      config,
    );
    const totalScore = breakoutTotalScore(factors.scores, stage, config);
    results.push({
      code: s.code,
      name: s.name,
      stage,
      close: s.close,
      changePercent: s.changePercent,
      totalScore,
      rank: 0,
      priceSource: s.priceSource,
      scores: factors.scores,
      degraded: factors.degraded,
      warnings: factors.warnings,
      volumeRatio: s.volumeRatio!,
      ...breakoutExtras(factors),
      ...(watchlistCodes.has(s.code) ? { fromWatchlist: true } : {}),
    });
  }

  rankWithinStages(results);

  const stats = {
    totalStocks,
    passedGate,
    preBreakout: results.filter((r) => r.stage === "pre-breakout").length,
    breakoutDay: results.filter((r) => r.stage === "breakout-day").length,
    extended: results.filter((r) => r.stage === "extended").length,
    breakoutBelowVolume,
    failedCount,
    estimatedCount,
    skippedNoPriceCount,
    watchlistExempt,
  };

  // PLAN 2 §3.2：所有 watchlist 成員即時報價——realtime 直接查 misQuotes 記憶體 Map（零額外 API）
  const watchlistQuotes: WatchlistQuote[] = [];
  for (const code of watchlistCodes) {
    const mis = misQuotes.get(code);
    if (!mis) continue;
    const stock = stockByCode.get(code);
    let close: number;
    let priceSource: WatchlistQuote["priceSource"];
    if (mis.price !== null) {
      close = mis.price;
      priceSource = "realtime";
    } else if (mis.high !== null) {
      close = mis.high;
      priceSource = "estimated";
    } else {
      continue; // z / h 皆缺 → 不放
    }
    watchlistQuotes.push({
      code,
      name: stock?.name ?? mis.name,
      close,
      changePercent:
        mis.prevClose !== null && mis.prevClose > 0
          ? ((close - mis.prevClose) / mis.prevClose) * 100
          : 0,
      volume: mis.cumulativeVolume / elapsedRatio, // 估全日量
      priceSource,
      refDate: mis.date ?? dateStr,
    });
  }

  const output: SignalScanOutput = {
    date: dateStr,
    source: "realtime",
    queriedAt: now.toISOString(),
    elapsedRatio,
    isNonTradingDay: false,
    stats,
    warnings,
    results,
    watchlistQuotes,
  };

  printSummary(output);
  const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  writeResult(timestamp, output, config);
  writeProgressDone(output);
  return output;
}

// ============================================================================
// 撈 DB helper（本檔專用）
// ============================================================================

interface InstitutionalFlowInput {
  trustNetBuyNewestFirst: number[];
  foreignNetBuyNewestFirst: number[];
  todayTrustNetBuy: number | null;
  todayForeignNetBuy: number | null;
}

/**
 * 近 lookbackDays 天 + 當日 投信 / 外資淨買超。
 * toDateInclusive=false（eod）：date 當天算「當日」，往回 lookbackDays 天算近窗。
 * toDateInclusive=true（realtime）：date（= T-1）為最新一筆，當日法人拿不到 → null。
 */
async function fetchInstitutionalFlowInputs(
  prisma: PrismaClient,
  date: Date,
  codes: string[],
  lookbackDays: number,
  toDateInclusive = false,
): Promise<Map<string, InstitutionalFlowInput>> {
  const result = new Map<string, InstitutionalFlowInput>();
  if (codes.length === 0) return result;

  const BATCH = 250;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const rows = await prisma.institutionalTrading.findMany({
      where: { stockCode: { in: batch }, date: { lte: date } },
      orderBy: { date: "desc" },
      select: {
        stockCode: true,
        date: true,
        foreignNetBuy: true,
        investmentTrustNetBuy: true,
      },
    });
    const byCode = new Map<string, typeof rows>();
    for (const r of rows) {
      let list = byCode.get(r.stockCode);
      if (!list) {
        list = [];
        byCode.set(r.stockCode, list);
      }
      if (list.length < lookbackDays + 1) list.push(r);
    }
    for (const code of batch) {
      const list = byCode.get(code) ?? [];
      const dateStr = toIsoDate(date);
      // eod：list[0] 若為 date 當天 → 當日法人；realtime：無當日法人
      const hasToday = !toDateInclusive && list.length > 0 && toIsoDate(list[0]!.date) === dateStr;
      const todayTrustNetBuy = hasToday ? Number(list[0]!.investmentTrustNetBuy ?? 0n) : null;
      const todayForeignNetBuy = hasToday ? Number(list[0]!.foreignNetBuy ?? 0n) : null;
      // 近窗：eod 用最近 lookbackDays 天（含當日）；realtime 用最近 lookbackDays 天（到 T-1）
      const window = list.slice(0, lookbackDays);
      result.set(code, {
        trustNetBuyNewestFirst: window.map((r) => Number(r.investmentTrustNetBuy ?? 0n)),
        foreignNetBuyNewestFirst: window.map((r) => Number(r.foreignNetBuy ?? 0n)),
        todayTrustNetBuy,
        todayForeignNetBuy,
      });
    }
  }
  return result;
}

/**
 * PLAN §5.1：撈 breakout 階段候選股的 MarginTrading.marginBalance 序列，算出每檔的 marginSurgePercentile。
 * toDate：eod = 掃描日（含當日融資餘額）；realtime = 傳 null（當日融資餘額晚上才公布）。
 * 回傳 Map<code, number | null>；toDate 為 null 時全部回 null（降級，比照法人子項盤中降級）。
 */
async function fetchMarginSurgeInputs(
  prisma: PrismaClient,
  toDate: Date | null,
  codes: string[],
  config: { lookbackDays: number; historyWindowDays: number; minHistoryDays: number },
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (codes.length === 0) return result;
  if (toDate === null) {
    for (const c of codes) result.set(c, null);
    return result;
  }

  const need = config.lookbackDays + config.historyWindowDays + 2; // 緩衝
  const BATCH = 250;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const rows = await prisma.marginTrading.findMany({
      where: { stockCode: { in: batch }, date: { lte: toDate } },
      orderBy: { date: "desc" },
      select: { stockCode: true, date: true, marginBalance: true },
    });
    const byCode = new Map<string, number[]>();
    for (const r of rows) {
      let list = byCode.get(r.stockCode);
      if (!list) {
        list = [];
        byCode.set(r.stockCode, list);
      }
      if (list.length < need) list.push(Number(r.marginBalance)); // BigInt → number（融資餘額量級遠小於 2^53）
    }
    for (const code of batch) {
      result.set(code, computeMarginSurgePercentile(byCode.get(code) ?? [], config));
    }
  }
  return result;
}

/** T-1（含）起往回 lookbackDays 筆 close + bollingerUpper（新到舊），供 realtime 階段判定接歷史序列。 */
async function fetchFirstBarSeriesToDate(
  prisma: PrismaClient,
  toDate: Date,
  codes: string[],
  lookbackDays: number,
): Promise<Map<string, { close: number; bollingerUpper: number | null }[]>> {
  const result = new Map<string, { close: number; bollingerUpper: number | null }[]>();
  if (codes.length === 0) return result;

  const BATCH = 250;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const [quotes, indicators] = await Promise.all([
      prisma.dailyQuote.findMany({
        where: { stockCode: { in: batch }, date: { lte: toDate } },
        orderBy: { date: "desc" },
        take: lookbackDays * batch.length,
        select: { stockCode: true, date: true, close: true },
      }),
      prisma.technicalIndicator.findMany({
        where: { stockCode: { in: batch }, date: { lte: toDate } },
        orderBy: { date: "desc" },
        take: lookbackDays * batch.length,
        select: { stockCode: true, date: true, bollingerUpper: true },
      }),
    ]);
    const closeByCodeDate = new Map<string, Map<number, number>>();
    const datesByCode = new Map<string, Date[]>();
    for (const r of quotes) {
      let m = closeByCodeDate.get(r.stockCode);
      if (!m) {
        m = new Map();
        closeByCodeDate.set(r.stockCode, m);
      }
      m.set(r.date.getTime(), r.close);
      let list = datesByCode.get(r.stockCode);
      if (!list) {
        list = [];
        datesByCode.set(r.stockCode, list);
      }
      if (list.length < lookbackDays) list.push(r.date);
    }
    const upperByCodeDate = new Map<string, Map<number, number | null>>();
    for (const r of indicators) {
      let m = upperByCodeDate.get(r.stockCode);
      if (!m) {
        m = new Map();
        upperByCodeDate.set(r.stockCode, m);
      }
      m.set(r.date.getTime(), r.bollingerUpper);
    }
    for (const code of batch) {
      const dates = datesByCode.get(code) ?? [];
      const cm = closeByCodeDate.get(code);
      const um = upperByCodeDate.get(code);
      result.set(
        code,
        dates.map((d) => ({
          close: cm?.get(d.getTime()) ?? Number.NaN,
          bollingerUpper: um?.get(d.getTime()) ?? null,
        })),
      );
    }
  }
  return result;
}

// ============================================================================
// 共用尾段
// ============================================================================

function rankWithinStages(results: SignalResult[]): void {
  const stages: SignalStage[] = ["pre-breakout", "breakout-day", "extended"];
  for (const stage of stages) {
    const group = results.filter((r) => r.stage === stage);
    group.sort((a, b) => b.totalScore - a.totalScore);
    group.forEach((r, i) => {
      r.rank = i + 1;
    });
  }
}

function emptyOutput(
  dateStr: string,
  source: SignalSource,
  now: Date,
  warnings: string[],
  isNonTradingDay: boolean,
  elapsedRatio?: number,
): SignalScanOutput {
  const out: SignalScanOutput = {
    date: dateStr,
    source,
    queriedAt: now.toISOString(),
    isNonTradingDay,
    stats: { totalStocks: 0, passedGate: 0, preBreakout: 0, breakoutDay: 0, extended: 0 },
    warnings,
    results: [],
  };
  if (elapsedRatio !== undefined) out.elapsedRatio = elapsedRatio;
  return out;
}

function printSummary(out: SignalScanOutput): void {
  console.log(
    `\n訊號掃描（${out.source}） ${out.date} —— 全市場 ${out.stats.totalStocks} 檔、過 gate ${out.stats.passedGate} 檔`,
  );
  console.log(
    `  醞釀中 ${out.stats.preBreakout} · 今日突破 ${out.stats.breakoutDay} · 已延伸 ${out.stats.extended}` +
      (out.stats.breakoutBelowVolume ? ` · 量不足未進榜 ${out.stats.breakoutBelowVolume}` : "") +
      (out.stats.watchlistExempt ? ` · 觀察股豁免 ${out.stats.watchlistExempt}` : "") +
      (out.stats.estimatedCount ? ` · 估價 ${out.stats.estimatedCount}` : "") +
      (out.stats.skippedNoPriceCount ? ` · 無價跳過 ${out.stats.skippedNoPriceCount}` : ""),
  );
  for (const stage of ["breakout-day", "extended", "pre-breakout"] as SignalStage[]) {
    const rows = out.results.filter((r) => r.stage === stage).slice(0, 15);
    if (rows.length === 0) continue;
    console.log(`\n  [${stage}] 前 ${rows.length}：`);
    for (const r of rows) {
      console.log(
        `  ${String(r.rank).padStart(3)}  ${r.code.padEnd(7)} ${r.name.padEnd(10)} ` +
          `${r.close.toFixed(2).padStart(9)}  ${r.changePercent.toFixed(2).padStart(7)}%  ` +
          `分 ${r.totalScore.toFixed(1).padStart(6)}  ${r.degraded.length ? r.degraded.join(",") : "-"}` +
          `${r.warnings.length ? `  ⚠ ${r.warnings.join(",")}` : ""}`,
      );
    }
  }
}

function writeResult(nameStamp: string, out: SignalScanOutput, config: SignalScanConfig): void {
  mkdirSync(RESULT_DIR, { recursive: true });
  const outputPath = join(RESULT_DIR, `${nameStamp}.json`);
  writeFileSync(outputPath, JSON.stringify({ ...out, params: config }, null, 2));
  console.log(`\n結果已寫入 ${outputPath}`);
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): { date: Date | null; source: SignalSource | null } {
  const dateArg = process.argv.find((a) => a.startsWith("--date="));
  const sourceArg = process.argv.find((a) => a.startsWith("--source="));
  let date: Date | null = null;
  if (dateArg) {
    const raw = dateArg.split("=")[1]!;
    date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error(`--date 格式錯誤: ${raw}`);
  }
  let source: SignalSource | null = null;
  if (sourceArg) {
    const raw = sourceArg.split("=")[1]!;
    if (raw !== "eod" && raw !== "realtime") throw new Error(`--source 只能是 eod / realtime: ${raw}`);
    source = raw;
  }
  return { date, source };
}

async function main() {
  const { date: argDate, source: argSource } = parseArgs();
  const prisma = makePrisma();
  try {
    let targetDate = argDate;
    if (!targetDate) {
      if (argSource === "eod") {
        // 強制 eod、沒帶日期 → 跑 DB 最新交易日
        const latest = await prisma.dailyQuote.findFirst({
          where: { stock: { securityType: "stock" } },
          orderBy: { date: "desc" },
          select: { date: true },
        });
        if (!latest) {
          console.log("資料庫裡沒有任何 DailyQuote 資料。");
          return;
        }
        targetDate = latest.date;
      } else {
        // 自動判斷 / 強制 realtime：傳「當下」給 runSignalScan，由 resolveSource 決定
        // （今天有 DailyQuote → eod 跑今天；沒有 → realtime 打 MIS）
        targetDate = new Date();
      }
    }
    await runSignalScan(targetDate, {
      prisma,
      ...(argSource ? { source: argSource } : {}),
    });
  } finally {
    await prisma.$disconnect();
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((err) => {
    console.error("訊號掃描失敗:", err);
    process.exit(1);
  });
}
