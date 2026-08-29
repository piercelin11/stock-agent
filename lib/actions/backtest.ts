"use server";

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
