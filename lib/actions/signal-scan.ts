"use server";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../prisma";
import {
  runSignalScan,
  type SignalScanOutput,
  type SignalResult,
  type SignalStage,
  type SignalSource,
} from "../../scripts/screening/run-signal-scan";

// ROADMAP 4.5.3：取代 screening.ts（runScreening）+ intraday.ts（3 個 action）。
//
// eod 模式：同步在 Next 進程內 import 呼叫 runSignalScan（秒級），傳 prisma 單例。
// realtime 模式：背景任務（比照舊 intraday）——spawn detached 子進程跑 _run-signal-scan.ts，
//   子進程逐批覆寫 progress.json，這裡輪詢讀檔，client setInterval poll。
//
// 只 import type { SignalScanOutput, ... }（type-only）——runSignalScan 本體會被 import 進 bundle，
// 但它已在 screening.ts 舊模式運作過（同步 import 純函式），沿用同一套。realtime 的 MIS 抓取只走
// 子進程，不進 bundle。

const REPO_ROOT = process.cwd();
const RESULT_DIR = join(REPO_ROOT, "data", "signal-scan-results");
const PROGRESS_PATH = join(RESULT_DIR, "progress.json");

const STALE_MS = 90_000;

// ---- view 型別（邊界轉換後的可序列化版；SignalResult 已全是 number/string）----
export type { SignalStage, SignalSource };

export interface SignalScanView {
  date: string;
  source: SignalSource;
  queriedAt: string;
  elapsedRatio?: number;
  isNonTradingDay: boolean;
  stats: Record<string, number>;
  warnings: string[];
  results: SignalResult[];
}

export interface SignalScanProgress {
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

function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

function toView(out: SignalScanOutput): SignalScanView {
  const view: SignalScanView = {
    date: out.date,
    source: out.source,
    queriedAt: out.queriedAt,
    isNonTradingDay: out.isNonTradingDay,
    stats: { ...out.stats } as Record<string, number>,
    warnings: out.warnings,
    results: out.results,
  };
  if (out.elapsedRatio !== undefined) view.elapsedRatio = out.elapsedRatio;
  return view;
}

// ============================================================================
// getScanMode —— 前端一進頁先問這個，決定顯示「跑盤後掃描」還是「開始盤中掃描」
// ============================================================================

export async function getScanMode(): Promise<{
  source: SignalSource;
  latestEodDate: string | null;
}> {
  const todayIso = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const latest = await prisma.dailyQuote.findFirst({
    where: { stock: { securityType: "stock" } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const latestEodDate = latest ? latest.date.toISOString().slice(0, 10) : null;
  const source: SignalSource = latestEodDate === todayIso ? "eod" : "realtime";
  return { source, latestEodDate };
}

// ============================================================================
// eod 模式：同步跑
// ============================================================================

export async function runSignalScanEod(): Promise<SignalScanView> {
  const latest = await prisma.dailyQuote.findFirst({
    where: { stock: { securityType: "stock" } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!latest) {
    return {
      date: "",
      source: "eod",
      queriedAt: new Date().toISOString(),
      isNonTradingDay: true,
      stats: {},
      warnings: ["資料庫尚無 DailyQuote，請先跑 daily-pipeline"],
      results: [],
    };
  }
  // 傳前端 Prisma 單例 + 強制 eod（跑 DB 最新交易日）。純函式偵測 options.prisma 時不 $disconnect。
  const out = await runSignalScan(latest.date, { prisma, source: "eod" });
  return toView(out);
}

// ============================================================================
// realtime 模式：背景任務
// ============================================================================

function readProgress(): SignalScanProgress | null {
  if (!existsSync(PROGRESS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as SignalScanProgress;
  } catch {
    return null;
  }
}

export async function startSignalScan(): Promise<{ started: boolean; reason?: string }> {
  const current = readProgress();
  if (
    current &&
    current.status === "running" &&
    Date.now() - new Date(current.updatedAt).getTime() < STALE_MS
  ) {
    return { started: false, reason: "已有掃描進行中" };
  }

  mkdirSync(RESULT_DIR, { recursive: true });

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
  } satisfies SignalScanProgress);

  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(REPO_ROOT, "scripts", "screening", "_run-signal-scan.ts");
  const child = spawn(process.execPath, [tsxCli, script], {
    detached: true,
    stdio: "ignore",
    cwd: REPO_ROOT,
  });
  child.unref();

  return { started: true };
}

export async function getSignalScanProgress(): Promise<SignalScanProgress | null> {
  return readProgress();
}

export async function getSignalScanResult(): Promise<SignalScanView | null> {
  if (!existsSync(RESULT_DIR)) return null;
  const files = readdirSync(RESULT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;

  let parsed: SignalScanOutput;
  try {
    parsed = JSON.parse(readFileSync(join(RESULT_DIR, latest), "utf8")) as SignalScanOutput;
  } catch {
    return null;
  }
  return toView(parsed);
}
