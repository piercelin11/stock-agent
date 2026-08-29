import "dotenv/config";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import {
  fetchBreakoutRawInputs,
  fetchTodayQuotes,
  fetchIndicatorsForDate,
} from "../lib/breakout-shared";
import { fetchAccumulationRawInputs } from "../lib/accumulation-shared";
import { checkDataCompleteness, type CompletenessReport } from "./check-data-completeness";

// ========================================================================
// Layer 0 批次歷史模擬引擎（ROADMAP 3.3）
//
// 對回測區間每個交易日，用選股純函式的「撈 DB + 組視窗序列」邏輯，撈出全市場每檔的
// 「門檻判斷裸值 + rankScore 前的原始聚合值」，寫入
//   data/backtest-runs/{run-id}/raw-factors/{date}.jsonl（一行一檔股票）
//
// 【不套任何門檻、不算成品分數、不算 rankScore、不寫 DB】——這些留給後續 Layer 1/2/3。
// 同時寫 config.json（時間範圍 + 策略 + code 版本 + 視窗緩衝）與 progress.json（背景任務進度）。
// ========================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RUNS_DIR = join(REPO_ROOT, "data", "backtest-runs");

// ---- Layer 0 視窗緩衝（PLAN §3.3）：比 DEFAULT_*_CONFIG 預設多抓一截，留給 Layer 2 微調 ----
// 這些是 Layer 0 的「抓取策略」，不是選股邏輯參數，不進 BreakoutConfig / AccumulationConfig。
const LAYER0_WINDOW_BUFFER = {
  breakout: {
    historyWindowDays: 260, // base + proximity（預設 240）
    rsWindowDays: 75, // relativeStrength（預設 61 = 60+1）
    firstBarLookbackDays: 40, // firstBar（預設 30）
  },
  accumulation: {
    bandwidthHistoryMaxDays: 260, // 壓縮度（預設 240）
    institutionalWindowDays: 30, // 三大法人（預設 20）
    squeezeVolumeWindowDays: 15, // 窒息量（預設 5）
  },
} as const;

type Strategy = "breakout" | "accumulation";

export interface ProgressSnapshot {
  runId: string;
  status: "pending" | "running" | "done" | "error";
  phase: "completeness-check" | "layer0";
  totalDays: number;
  completedDays: number;
  currentDate: string | null;
  startedAt: string;
  updatedAt: string;
  error: string | null;
  completenessWarnings: string[];
}

export interface RunLayer0Options {
  strategy: Strategy;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  split?: { trainEnd: string; validStart: string }; // 選填，只記錄
  prisma?: PrismaClient;
  runId?: string; // 選填，預設自動生成
  resume?: boolean; // 從既有 run 的斷點續跑
  minTradingDays?: number; // 放寬「交易日母體過小」的 hard failure（小區間驗證跑用），預設 20
  onProgress?: (p: ProgressSnapshot) => void; // 背景 runner 用；CLI 直接 console
}

function makePrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---- raw-factors 無損編碼（PLAN §2.3 體積退路的替代：純編碼壓縮，不損失可重算能力）----
// 浮點數 round 到 6 位小數（遠超價格 tick 精度）；視窗序列用位置對齊的 tuple/純陣列，不用 {key:val}。
// history / bandwidthHistory 不存每筆 date——序列已是「從 prevTradingDate 起、新到舊、連續交易日」，
// Layer 2 的 computeBase / computeProximityToHigh 只按位置取值。
const RF_PRECISION = 6;
function r6(x: number | null | undefined): number | null {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  return Math.round(x * 1e6) / 1e6;
}

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function gitVersion(): { gitHash: string; dirty: boolean } {
  try {
    const hash = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
    const status = execSync("git status --porcelain", { cwd: REPO_ROOT }).toString().trim();
    const dirty = status.length > 0;
    return { gitHash: dirty ? `${hash}-dirty` : hash, dirty };
  } catch {
    return { gitHash: "unknown", dirty: false };
  }
}

// scripts/lib/{breakout-shared,accumulation-shared,types}.ts 內容做 sha256
function sharedLibHash(): string {
  const files = ["breakout-shared.ts", "accumulation-shared.ts", "types.ts"].map((f) =>
    join(REPO_ROOT, "scripts", "lib", f),
  );
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(f));
  return `sha256:${h.digest("hex")}`;
}

// 原子寫：先寫 .tmp 再 rename，避免輪詢讀到半截
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function windowConfigFor(strategy: Strategy) {
  return strategy === "breakout"
    ? {
        historyWindowDays: LAYER0_WINDOW_BUFFER.breakout.historyWindowDays,
        rsWindowDays: LAYER0_WINDOW_BUFFER.breakout.rsWindowDays,
        firstBarLookbackDays: LAYER0_WINDOW_BUFFER.breakout.firstBarLookbackDays,
      }
    : {
        bandwidthHistoryMaxDays: LAYER0_WINDOW_BUFFER.accumulation.bandwidthHistoryMaxDays,
        institutionalWindowDays: LAYER0_WINDOW_BUFFER.accumulation.institutionalWindowDays,
        squeezeVolumeWindowDays: LAYER0_WINDOW_BUFFER.accumulation.squeezeVolumeWindowDays,
      };
}

// ---- 交易日清單：區間內有 DailyQuote 一般股票資料的 distinct date（升冪）----
async function tradingDatesInRange(prisma: PrismaClient, start: Date, end: Date): Promise<Date[]> {
  const rows = await prisma.dailyQuote.findMany({
    where: { date: { gte: start, lte: end }, stock: { securityType: "stock" } },
    distinct: ["date"],
    orderBy: { date: "asc" },
    select: { date: true },
  });
  return rows.map((r) => r.date);
}

// ---- 逐股組 raw-factors 行 ----

function commonFields(
  date: string,
  code: string,
  name: string,
  quote: {
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
    volume: number;
    sharesOutstanding: number | null;
  },
  indicator: { bollingerUpper: number | null; bollingerBandwidth: number | null; volumeMa20: number | null } | null,
  prevTradingDate: Date | null,
) {
  return {
    date,
    code,
    name,
    close: r6(quote.close),
    open: r6(quote.open),
    high: r6(quote.high),
    low: r6(quote.low),
    change: r6(quote.change),
    volume: quote.volume,
    sharesOutstanding: quote.sharesOutstanding,
    bollingerUpper: r6(indicator?.bollingerUpper),
    bollingerBandwidth: r6(indicator?.bollingerBandwidth),
    volumeMa20: r6(indicator?.volumeMa20),
    prevClose: r6(quote.close - quote.change),
    prevTradingDate: prevTradingDate ? toIsoDate(prevTradingDate) : null,
  };
}

async function buildBreakoutJsonl(prisma: PrismaClient, date: Date): Promise<string> {
  const dateStr = toIsoDate(date);
  const raw = await fetchBreakoutRawInputs(prisma, date, {
    firstBarLookbackDays: LAYER0_WINDOW_BUFFER.breakout.firstBarLookbackDays,
    baseMaxWindowDays: LAYER0_WINDOW_BUFFER.breakout.historyWindowDays,
    rsWindowDays: LAYER0_WINDOW_BUFFER.breakout.rsWindowDays,
  });

  const lines: string[] = [];
  for (const [code, r] of raw) {
    const row = {
      ...commonFields(dateStr, code, r.quote.name, r.quote, r.indicator, r.prevTradingDate),
      // firstBar：T-1 起往回 firstBarLookbackDays 筆（新到舊）。tuple [close, bollingerUpper]，位置對齊。
      firstBarSeries: r.firstBarSeries.map((p) => [r6(p.close), r6(p.bollingerUpper)]),
      // base + proximityToHigh 共用：T-1 起往回 historyWindowDays 筆（新到舊）。
      // tuple [close, bollingerBandwidth]，不存 date——序列為 prevTradingDate 起連續交易日、新到舊。
      history: r.history.map((p) => [r6(p.close), r6(p.bollingerBandwidth)]),
      // relativeStrength：這一檔近 rsWindowDays+1 筆 close（含當天，新到舊）
      rsCloseSeries: r.rsCloseSeries.map((p) => r6(p.close)),
    };
    lines.push(JSON.stringify(row));
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

async function buildAccumulationJsonl(prisma: PrismaClient, date: Date): Promise<string> {
  const dateStr = toIsoDate(date);
  // Layer 0 = 全市場，不套 buildCandidatePool 門檻。只需要當天全市場的 quote + indicator
  // （含 volumeMa20 / bollingerUpper / bollingerBandwidth），再餵給 fetchAccumulationRawInputs。
  const quotes = await fetchTodayQuotes(prisma, date);
  const codes = quotes.map((q) => q.stockCode);
  const indicators = await fetchIndicatorsForDate(prisma, date, codes);

  // T-1 交易日（commonFields 的 prevTradingDate）
  const prevRow = await prisma.dailyQuote.findFirst({
    where: { date: { lt: date }, stockCode: { in: codes } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const prevDate = prevRow?.date ?? null;

  const volumeMa20ByCode = new Map<string, number | null>(
    codes.map((c) => [c, indicators.get(c)?.volumeMa20 ?? null]),
  );

  const acc = await fetchAccumulationRawInputs(prisma, date, codes, volumeMa20ByCode, {
    institutionalWindowDays: LAYER0_WINDOW_BUFFER.accumulation.institutionalWindowDays,
    squeezeVolumeWindowDays: LAYER0_WINDOW_BUFFER.accumulation.squeezeVolumeWindowDays,
    bandwidthHistoryMaxDays: LAYER0_WINDOW_BUFFER.accumulation.bandwidthHistoryMaxDays,
  });

  const lines: string[] = [];
  for (const q of quotes) {
    const code = q.stockCode;
    const b = { quote: q, indicator: indicators.get(code) ?? null, prevTradingDate: prevDate };
    const a = acc.get(code)!;
    // institutional：把三大法人視窗 + 對齊日期的 volume 併成一個陣列（新到舊）
    // trustNetBuy / foreignPlusDealerNetBuy / volume 三序列同索引對齊
    // 三大法人視窗：tuple [trustNetBuy, foreignPlusDealerNetBuy, volume]，位置對齊、新到舊。
    const institutional = a.trustNetBuyNewestFirst.map((trust, i) => [
      trust,
      a.foreignPlusDealerNewestFirst[i] ?? 0,
      a.instVolumeNewestFirst[i] ?? 0,
    ]);
    const row = {
      ...commonFields(dateStr, code, b.quote.name, b.quote, b.indicator, b.prevTradingDate),
      institutional,
      // 窒息量：近 squeezeVolumeWindowDays + 緩衝 筆的原始 volume（新到舊）。
      // 存原始 volume 而非「volume / volumeMa20」——Layer 2 才能改 volumeMa20 口徑（PLAN §2.3）。
      recentVolumes: a.recentVolumesNewestFirst,
      // 壓縮度（computeBase）：不含當日、往回 bandwidthHistoryMaxDays 筆的 bandwidth（新到舊）
      bandwidthHistory: a.bandwidthHistoryNewestFirst.map((v) => r6(v)),
    };
    lines.push(JSON.stringify(row));
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

// ========================================================================

export async function runLayer0(
  options: RunLayer0Options,
): Promise<{ runId: string; outputDir: string }> {
  const prisma = options.prisma ?? makePrisma();
  const ownsPrisma = options.prisma === undefined;
  try {
    return await execute(prisma, options);
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

async function execute(
  prisma: PrismaClient,
  options: RunLayer0Options,
): Promise<{ runId: string; outputDir: string }> {
  const { strategy, start, end, split, resume } = options;

  // ---- resume：讀既有 run 的 config.json 拿 range/strategy ----
  let runId = options.runId;
  let createdAt = new Date().toISOString();
  if (resume) {
    if (!runId) throw new Error("--resume 需要同時指定 --run-id");
    const cfgPath = join(RUNS_DIR, runId, "config.json");
    if (!existsSync(cfgPath)) throw new Error(`找不到 run ${runId} 的 config.json`);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (cfg.strategy !== strategy) {
      throw new Error(`--resume：strategy 不符（run 是 ${cfg.strategy}，傳入 ${strategy}）`);
    }
    createdAt = cfg.createdAt;
  }
  if (!runId) runId = `${strategy}-${nowStamp()}`;

  const outputDir = join(RUNS_DIR, runId);
  const rawFactorsDir = join(outputDir, "raw-factors");
  const progressPath = join(outputDir, "progress.json");
  const configPath = join(outputDir, "config.json");

  // 併發防呆：同一 run-id 已有 progress.json 且 status=running 且 60 秒內更新過 → 拒絕（除非 resume）。
  // 兩個 process 同時寫同一個 run 目錄會讓計數 / 檔案交錯。
  if (!resume && existsSync(progressPath)) {
    try {
      const prev = JSON.parse(readFileSync(progressPath, "utf8")) as ProgressSnapshot;
      const staleMs = Date.now() - new Date(prev.updatedAt).getTime();
      if (prev.status === "running" && staleMs < 60_000) {
        throw new Error(
          `run-id "${runId}" 似乎正在被另一個 process 執行（progress.json ${Math.round(staleMs / 1000)}s 前更新）。` +
            `確認沒有其他 run 在跑，或改用 --run-id 換一個名字。`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("正在被另一個")) throw e;
      // JSON 壞掉 / 讀取失敗 → 當作沒有前一次，繼續
    }
  }

  mkdirSync(rawFactorsDir, { recursive: true });

  const startedAt = new Date().toISOString();
  let progress: ProgressSnapshot = {
    runId,
    status: "pending",
    phase: "completeness-check",
    totalDays: 0,
    completedDays: 0,
    currentDate: null,
    startedAt,
    updatedAt: startedAt,
    error: null,
    completenessWarnings: [],
  };
  const emitProgress = (patch: Partial<ProgressSnapshot>) => {
    progress = { ...progress, ...patch, updatedAt: new Date().toISOString() };
    atomicWrite(progressPath, JSON.stringify(progress, null, 2));
    options.onProgress?.(progress);
  };
  emitProgress({});

  // ---- 1. 資料完整性檢查（§4）----
  const report: CompletenessReport = await checkDataCompleteness(
    { start, end },
    options.minTradingDays !== undefined
      ? { prisma, minTradingDays: options.minTradingDays }
      : { prisma },
  );
  const warnings = summarizeCompleteness(report);
  emitProgress({ completenessWarnings: warnings });

  if (report.hardFailures.length > 0) {
    emitProgress({
      status: "error",
      error: `資料完整性硬性缺漏，中止：\n${report.hardFailures.join("\n")}`,
    });
    console.error(progress.error);
    throw new Error("completeness hard failure");
  }

  // ---- 2. 交易日清單 ----
  const allTradingDates = await tradingDatesInRange(prisma, new Date(start), new Date(end));

  // resume：跳過已寫出的 {date}.jsonl
  const doneDates = new Set(
    existsSync(rawFactorsDir)
      ? readdirSync(rawFactorsDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => f.replace(/\.jsonl$/, ""))
      : [],
  );
  const pendingDates = resume
    ? allTradingDates.filter((d) => !doneDates.has(toIsoDate(d)))
    : allTradingDates;

  // ---- 3. 寫 config.json ----
  const git = gitVersion();
  const wc = windowConfigFor(strategy);
  const config = {
    runId,
    strategy,
    createdAt,
    ...(resume ? { resumedAt: new Date().toISOString() } : {}),
    range: { start, end },
    split: split
      ? {
          trainStart: start,
          trainEnd: split.trainEnd,
          validStart: split.validStart,
          validEnd: end,
        }
      : null,
    codeVersion: { gitHash: git.gitHash, dirty: git.dirty, note: "" },
    sharedLibHash: sharedLibHash(),
    layer0: {
      tradingDays: allTradingDates.length,
      completedDays: doneDates.size,
      totalRowsWritten: 0,
      windowConfig: wc,
    },
  };
  atomicWrite(configPath, JSON.stringify(config, null, 2));

  // ---- 4. 逐交易日 ----
  emitProgress({
    status: "running",
    phase: "layer0",
    totalDays: allTradingDates.length,
    completedDays: doneDates.size,
  });

  let totalRowsWritten = 0;
  for (const d of pendingDates) {
    const dateStr = toIsoDate(d);
    try {
      const jsonl =
        strategy === "breakout"
          ? await buildBreakoutJsonl(prisma, d)
          : await buildAccumulationJsonl(prisma, d);
      const outPath = join(rawFactorsDir, `${dateStr}.jsonl`);
      atomicWrite(outPath, jsonl);
      totalRowsWritten += jsonl.length > 0 ? jsonl.trimEnd().split("\n").length : 0;
      // completedDays 從實際檔案數推導（自我修正），不用累加器——避免同一 run-id 被兩個 process
      // 同時跑時計數超過 totalDays
      const doneCount = readdirSync(rawFactorsDir).filter((f) => f.endsWith(".jsonl")).length;
      emitProgress({ completedDays: Math.min(doneCount, allTradingDates.length), currentDate: dateStr });
    } catch (err) {
      emitProgress({
        status: "error",
        error: `交易日 ${dateStr} 失敗：${err instanceof Error ? err.message : String(err)}`,
      });
      console.error(progress.error);
      throw err;
    }
  }

  // ---- 5. 補齊統計 ----
  const finalDoneCount = existsSync(rawFactorsDir)
    ? readdirSync(rawFactorsDir).filter((f) => f.endsWith(".jsonl")).length
    : 0;
  config.layer0.completedDays = Math.min(finalDoneCount, allTradingDates.length);
  config.layer0.totalRowsWritten =
    (resume ? config.layer0.totalRowsWritten : 0) + totalRowsWritten;
  atomicWrite(configPath, JSON.stringify(config, null, 2));
  emitProgress({
    status: "done",
    currentDate: null,
    completedDays: Math.min(finalDoneCount, allTradingDates.length),
  });

  return { runId, outputDir };
}

function summarizeCompleteness(report: CompletenessReport): string[] {
  const out: string[] = [];
  out.push(`交易日母體 ${report.tradingDays} 天`);
  for (const [name, cov] of [
    ["DailyQuote", report.tables.dailyQuote],
    ["TechnicalIndicator", report.tables.technicalIndicator],
    ["InstitutionalTrading", report.tables.institutionalTrading],
  ] as const) {
    out.push(`${name} 覆蓋率 ${(cov.coverageRatio * 100).toFixed(1)}%（${cov.totalRows} 筆）`);
  }
  if (report.missingDates.technicalIndicator.length > 0) {
    out.push(`TechnicalIndicator 缺 ${report.missingDates.technicalIndicator.length} 個交易日`);
  }
  if (report.missingDates.institutionalTrading.length > 0) {
    out.push(`InstitutionalTrading 缺 ${report.missingDates.institutionalTrading.length} 個交易日`);
  }
  if (report.thinStocks.length > 0) {
    out.push(
      `單股缺漏 ${report.thinStocks.length} 筆（前 3：` +
        report.thinStocks
          .slice(0, 3)
          .map((t) => `${t.code}/${t.table} ${(t.ratio * 100).toFixed(0)}%`)
          .join(", ") +
        "）",
    );
  }
  return out;
}

// ---- CLI ----

function parseArgs() {
  const get = (k: string) => {
    const a = process.argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.split("=")[1]! : undefined;
  };
  const strategy = get("strategy") as Strategy | undefined;
  const start = get("start");
  const end = get("end");
  const trainEnd = get("train-end");
  const validStart = get("valid-start");
  const runId = get("run-id");
  const resume = process.argv.includes("--resume") || get("resume") !== undefined;
  const resumeRunId = get("resume") ?? runId;
  const minTradingDaysStr = get("min-trading-days");
  const minTradingDays = minTradingDaysStr !== undefined ? Number(minTradingDaysStr) : undefined;

  return {
    strategy,
    start,
    end,
    trainEnd,
    validStart,
    runId: resume ? resumeRunId : runId,
    resume,
    minTradingDays,
  };
}

async function main() {
  const args = parseArgs();

  if (args.resume) {
    if (!args.runId) throw new Error("--resume 需要 --run-id=<run-id> 或 --resume=<run-id>");
    // resume 時 strategy/start/end 從 config.json 讀；但 execute 仍要求傳入，先讀出來
    const cfgPath = join(RUNS_DIR, args.runId, "config.json");
    if (!existsSync(cfgPath)) throw new Error(`找不到 run ${args.runId}`);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const resumeOpts: RunLayer0Options = {
      strategy: cfg.strategy,
      start: cfg.range.start,
      end: cfg.range.end,
      runId: args.runId,
      resume: true,
      onProgress: (p) =>
        console.log(`[${p.phase}] ${p.completedDays}/${p.totalDays} ${p.currentDate ?? ""} (${p.status})`),
    };
    if (args.minTradingDays !== undefined && !Number.isNaN(args.minTradingDays)) {
      resumeOpts.minTradingDays = args.minTradingDays;
    }
    await runLayer0(resumeOpts);
    return;
  }

  if (!args.strategy || !args.start || !args.end) {
    throw new Error(
      "用法：--strategy=breakout|accumulation --start=YYYY-MM-DD --end=YYYY-MM-DD [--train-end=... --valid-start=...] [--run-id=...]\n" +
        "      --resume=<run-id>（斷點續跑）",
    );
  }
  if (args.strategy !== "breakout" && args.strategy !== "accumulation") {
    throw new Error(`--strategy 必須是 breakout 或 accumulation，收到 ${args.strategy}`);
  }

  const opts: RunLayer0Options = {
    strategy: args.strategy,
    start: args.start,
    end: args.end,
    onProgress: (p) =>
      console.log(
        `[${p.phase}] ${p.completedDays}/${p.totalDays} ${p.currentDate ?? ""} (${p.status})`,
      ),
  };
  if (args.trainEnd && args.validStart) {
    opts.split = { trainEnd: args.trainEnd, validStart: args.validStart };
  }
  if (args.runId) opts.runId = args.runId;
  if (args.minTradingDays !== undefined && !Number.isNaN(args.minTradingDays)) {
    opts.minTradingDays = args.minTradingDays;
  }

  const { runId, outputDir } = await runLayer0(opts);
  console.log(`\n完成。run: ${runId}\n輸出：${outputDir}`);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((err) => {
    console.error("Layer 0 執行失敗:", err);
    process.exit(1);
  });
}
