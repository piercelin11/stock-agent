"use server";

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseBreakoutRow,
  parseAccumulationRow,
  replayBreakoutRange,
  replayAccumulationRange,
  type BreakoutRawRow,
  type AccumulationRawRow,
} from "../../scripts/lib/backtest-replay";
import {
  resolveBreakoutConfig,
  type BreakoutConfig,
} from "../../scripts/lib/breakout-shared";
import {
  resolveAccumulationConfig,
  type AccumulationConfig,
} from "../../scripts/lib/accumulation-shared";
import {
  computeBacktestStats,
  type BacktestStats,
  type CandidatePick,
} from "../../scripts/lib/backtest-stats";
import { loadForwardReturns } from "../../scripts/backtest/load-forward-returns";

// forward-returns cache 預設 horizons（與 build-forward-returns.ts 的 FORWARD_RETURN_HORIZONS 一致）。
// 這裡不 import 該常數以免把 build-forward-returns.ts（含 dotenv / Prisma 的 module-level import）
// 拉進 Next bundler；實際跑時優先讀 forward-returns.meta.json 的 horizons。
const DEFAULT_HORIZONS = [5, 10, 20];

// Layer 0 背景任務的 Server Actions（PLAN §5.1）。
// 模式照 CLAUDE.md「背景任務」段：spawn detached 子進程 → 子進程覆寫 progress.json → 這裡輪詢讀檔。
// 子進程是獨立 Node process，自己 makePrisma()，與 Next.js 連線池無關。

const REPO_ROOT = process.cwd();
const RUNS_DIR = join(REPO_ROOT, "data", "backtest-runs");

export type Strategy = "breakout" | "accumulation";

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

export interface RunSummary {
  runId: string;
  strategy: string;
  range: { start: string; end: string } | null;
  createdAt: string | null;
  status: string | null;
  completedDays: number | null;
  totalDays: number | null;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 觸發：spawn detached 子進程跑 run-layer0.ts，立刻回 runId
export async function startLayer0Run(input: {
  strategy: Strategy;
  start: string;
  end: string;
}): Promise<{ runId: string }> {
  const { strategy, start, end } = input;
  if (strategy !== "breakout" && strategy !== "accumulation") {
    throw new Error(`strategy 不合法：${strategy}`);
  }
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
    throw new Error("start / end 需為 YYYY-MM-DD");
  }
  if (start > end) throw new Error("start 不可晚於 end");

  // runId 在 spawn 前決定，讓 action 能立刻回傳；子進程用這個 runId 建目錄
  const runId = `${strategy}-${stamp()}`;

  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(REPO_ROOT, "scripts", "backtest", "run-layer0.ts");
  const child = spawn(
    process.execPath,
    [
      // 6 年全市場 Layer 0 逐日撈大量歷史列，預設 heap 偏緊，給到 8 GB
      "--max-old-space-size=8192",
      tsxCli,
      script,
      `--strategy=${strategy}`,
      `--start=${start}`,
      `--end=${end}`,
      `--run-id=${runId}`,
    ],
    { detached: true, stdio: "ignore", cwd: REPO_ROOT },
  );
  child.unref();

  return { runId };
}

// 輪詢：讀 data/backtest-runs/{runId}/progress.json
export async function getLayer0Progress(runId: string): Promise<ProgressSnapshot | null> {
  if (!/^[\w-]+$/.test(runId)) return null; // 防目錄穿越
  const p = join(RUNS_DIR, runId, "progress.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProgressSnapshot;
  } catch {
    return null; // 可能剛好讀到 atomic write 之間的空檔
  }
}

// 列出已有的 run（讀 data/backtest-runs/ 目錄 + 各 config.json / progress.json）
export async function listBacktestRuns(): Promise<RunSummary[]> {
  if (!existsSync(RUNS_DIR)) return [];
  const dirs = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const summaries: RunSummary[] = [];
  for (const runId of dirs) {
    const cfgPath = join(RUNS_DIR, runId, "config.json");
    const progPath = join(RUNS_DIR, runId, "progress.json");
    let strategy = "";
    let range: { start: string; end: string } | null = null;
    let createdAt: string | null = null;
    let status: string | null = null;
    let completedDays: number | null = null;
    let totalDays: number | null = null;
    try {
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        strategy = cfg.strategy ?? "";
        range = cfg.range ?? null;
        createdAt = cfg.createdAt ?? null;
      }
      if (existsSync(progPath)) {
        const prog = JSON.parse(readFileSync(progPath, "utf8"));
        status = prog.status ?? null;
        completedDays = prog.completedDays ?? null;
        totalDays = prog.totalDays ?? null;
      }
    } catch {
      // 略過壞掉的 run 目錄
    }
    summaries.push({ runId, strategy, range, createdAt, status, completedDays, totalDays });
  }

  summaries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return summaries;
}

// ========================================================================
// PLAN §5.1：forward-returns cache 補齊（spawn）+ 完整重算 + 統計摘要（同步）
// ========================================================================

const CACHE_DIR = join(REPO_ROOT, "data", "backtest-cache");

// 補齊某區間的 forward-returns cache：spawn detached 子進程跑 build-forward-returns.ts
// （可能幾分鐘），比照 startLayer0Run / CLAUDE.md 背景任務模式，action 立刻回傳。
export async function ensureForwardReturns(input: {
  start: string;
  end: string;
}): Promise<{ started: boolean }> {
  const { start, end } = input;
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
    throw new Error("start / end 需為 YYYY-MM-DD");
  }
  if (start > end) throw new Error("start 不可晚於 end");

  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(REPO_ROOT, "scripts", "backtest", "build-forward-returns.ts");
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=4096", tsxCli, script, `--start=${start}`, `--end=${end}`],
    { detached: true, stdio: "ignore", cwd: REPO_ROOT },
  );
  child.unref();
  return { started: true };
}

function readRunConfig(runId: string): { strategy: string; range: { start: string; end: string } | null } {
  const cfgPath = join(RUNS_DIR, runId, "config.json");
  if (!existsSync(cfgPath)) throw new Error(`找不到 run ${runId} 的 config.json`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  return { strategy: cfg.strategy ?? "", range: cfg.range ?? null };
}

function readMetaHorizons(): number[] {
  const metaPath = join(CACHE_DIR, "forward-returns.meta.json");
  if (!existsSync(metaPath)) return DEFAULT_HORIZONS;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { horizons?: number[] };
    return Array.isArray(meta.horizons) && meta.horizons.length > 0 ? meta.horizons : DEFAULT_HORIZONS;
  } catch {
    return DEFAULT_HORIZONS;
  }
}

// 讀 raw-factors/*.jsonl → 逐日 parse → Map<date, rows>
function loadRawFactorsByDate<T>(
  runId: string,
  parse: (o: Record<string, unknown>) => T,
): Map<string, T[]> {
  const dir = join(RUNS_DIR, runId, "raw-factors");
  const byDate = new Map<string, T[]>();
  if (!existsSync(dir)) return byDate;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const date = f.replace(/\.jsonl$/, "");
    const content = readFileSync(join(dir, f), "utf8");
    const rows: T[] = [];
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      rows.push(parse(JSON.parse(line) as Record<string, unknown>));
    }
    byDate.set(date, rows);
  }
  return byDate;
}

// 對某個已完成的 run，用 DEFAULT config（或傳入 override）跑一次完整重算 + 統計，回摘要。
// 【同步、Next.js 進程內】純記憶體 + 純函式（讀 .jsonl → replayXxxRange → computeBacktestStats），
// 不 spawn 子進程（跟 Layer 0 不同——Layer 0 慢且查 DB，這個快且純算）。
export async function runBacktestSummary(input: {
  runId: string;
  configOverride?: unknown;
  horizons?: number[];
  split?: { trainEnd: string; validStart: string };
}): Promise<BacktestStats> {
  const { runId, configOverride } = input;
  if (!/^[\w-]+$/.test(runId)) throw new Error("runId 不合法");

  const { strategy } = readRunConfig(runId);
  const horizons = input.horizons ?? readMetaHorizons();
  const forwardReturns = loadForwardReturns();

  const picks: CandidatePick[] = [];

  if (strategy === "breakout") {
    const config: BreakoutConfig = resolveBreakoutConfig(
      (configOverride as Parameters<typeof resolveBreakoutConfig>[0]) ?? undefined,
    );
    const byDate = loadRawFactorsByDate<BreakoutRawRow>(runId, parseBreakoutRow);
    const replayed = replayBreakoutRange(byDate, config);
    for (const [, results] of replayed) {
      for (const r of results) {
        picks.push({ date: r.date, code: r.code, score: r.totalScore, rank: r.rank });
      }
    }
  } else if (strategy === "accumulation") {
    const config: AccumulationConfig = resolveAccumulationConfig(
      (configOverride as Parameters<typeof resolveAccumulationConfig>[0]) ?? undefined,
    );
    const byDate = loadRawFactorsByDate<AccumulationRawRow>(runId, parseAccumulationRow);
    const replayed = replayAccumulationRange(byDate, config);
    for (const [, results] of replayed) {
      for (const r of results) {
        picks.push({ date: r.date, code: r.code, score: r.finalScore, rank: r.rank });
      }
    }
  } else {
    throw new Error(`run ${runId} 的 strategy 不明：${strategy}`);
  }

  const options: Parameters<typeof computeBacktestStats>[2] = { horizons };
  if (input.split) options.split = input.split;
  return computeBacktestStats(picks, forwardReturns, options);
}
