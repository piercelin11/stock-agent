"use server";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateResult } from "../../scripts/screening/check-intraday-breakout";

// 盤中即時掃描的背景任務 Server Actions（PLAN §3）。
// 模式照 CLAUDE.md「背景任務」段：spawn detached 子進程跑 _run-intraday-scan.ts →
// 子進程逐批覆寫 progress.json → 這裡輪詢讀檔 → client setInterval 進度條。
// 子進程是獨立 Node process，自己 makePrisma()，與 Next.js 連線池無關。
//
// 只 import type { CandidateResult }——不 import checkIntradayBreakout 本體
// （它 module-level import "dotenv/config" + node:fs），type-only import 不會把實作拉進 bundler。

const REPO_ROOT = process.cwd();
const SNAPSHOT_DIR = join(REPO_ROOT, "data", "intraday-breakout-snapshots");
const PROGRESS_PATH = join(SNAPSHOT_DIR, "progress.json");

// 子進程若 crash 沒寫 error，progress.json 會永遠卡在 running。
// updatedAt 超過這個秒數沒更新 → 視為死掉的舊掃描，允許重跑。
const STALE_MS = 90_000;

export interface IntradayProgress {
  status: "running" | "done" | "error";
  phase: "fetching-quotes" | "scoring" | "done" | "error";
  queriedAt: string;
  fetchedBatches: number;
  totalBatches: number;
  failedCount: number;
  startedAt: string;
  updatedAt: string;
  warnings: string[];
  error: string | null;
}

export interface IntradayRow {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  volumeRatio: number;
  totalScore: number;
  rank: number;
  scores: CandidateResult["scores"];
  degraded: string[];
}

export interface IntradayResult {
  queriedAt: string;
  elapsedRatio: number;
  stats: Record<string, number>;
  warnings: string[];
  rows: IntradayRow[];
}

function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

function readProgress(): IntradayProgress | null {
  if (!existsSync(PROGRESS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as IntradayProgress;
  } catch {
    return null; // 可能剛好讀到 atomic write 之間的空檔
  }
}

/** spawn detached 子進程跑掃描，立刻回傳。同時只允許一個進行中。 */
export async function startIntradayScan(): Promise<{ started: boolean; reason?: string }> {
  const current = readProgress();
  if (
    current &&
    current.status === "running" &&
    Date.now() - new Date(current.updatedAt).getTime() < STALE_MS
  ) {
    return { started: false, reason: "已有掃描進行中" };
  }

  mkdirSync(SNAPSHOT_DIR, { recursive: true });

  // spawn 前先寫一份 running，讓 client 第一次輪詢就拿得到狀態（子進程啟動有幾秒延遲）。
  const startedAt = new Date().toISOString();
  atomicWrite(PROGRESS_PATH, {
    status: "running",
    phase: "fetching-quotes",
    queriedAt: startedAt,
    fetchedBatches: 0,
    totalBatches: 0,
    failedCount: 0,
    startedAt,
    updatedAt: startedAt,
    warnings: [],
    error: null,
  } satisfies IntradayProgress);

  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(REPO_ROOT, "scripts", "screening", "_run-intraday-scan.ts");
  const child = spawn(process.execPath, [tsxCli, script], {
    detached: true,
    stdio: "ignore",
    cwd: REPO_ROOT,
  });
  child.unref();

  return { started: true };
}

/** 讀 progress.json */
export async function getIntradayProgress(): Promise<IntradayProgress | null> {
  return readProgress();
}

/** 讀「最新」一份 {timestamp}.json 結果檔（排除 progress.json），轉成可序列化 rows */
export async function getIntradayResult(): Promise<IntradayResult | null> {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;

  let parsed: {
    queriedAt: string;
    elapsedRatio: number;
    stats?: Record<string, number>;
    warnings?: string[];
    results: CandidateResult[];
  };
  try {
    parsed = JSON.parse(readFileSync(join(SNAPSHOT_DIR, latest), "utf8"));
  } catch {
    return null;
  }

  // CandidateResult 已全是 number / string，無 Decimal / Date / BigInt，直接挑欄位。
  const rows: IntradayRow[] = parsed.results.map((r) => ({
    code: r.code,
    name: r.name,
    price: r.price,
    changePercent: r.changePercent,
    volumeRatio: r.volumeRatio,
    totalScore: r.totalScore,
    rank: r.rank,
    scores: r.scores,
    degraded: r.degraded,
  }));

  return {
    queriedAt: parsed.queriedAt,
    elapsedRatio: parsed.elapsedRatio,
    stats: { ...(parsed.stats ?? {}) },
    warnings: parsed.warnings ?? [],
    rows,
  };
}
