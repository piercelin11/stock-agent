"use server";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 首頁「立即更新資料」按鈕的背景任務 Server Actions。
// 模式照 CLAUDE.md「背景任務」段，但 spawn 的是「未改造的 daily-pipeline.ts 本體」——
// 該檔要保持給 launchd 用（不加 progress callback），所以進度只做粗粒度：
// 子進程存活時間 + 結束碼 + log 檔尾巴，不是 7 步逐步進度條。
// 終態由 parent（本 Next 進程）監聽 child.on("exit") 覆寫 progress.json；
// dev 模式 hot-reload 會丟這個 listener → 靠 STALE_MS 兜底。
//
// 不 import 任何 scripts/ 東西（連 type 都不用），純檔案 IO + spawn。

const REPO_ROOT = process.cwd();
const RUN_DIR = join(REPO_ROOT, "data", "daily-pipeline-runs");
const PROGRESS_PATH = join(RUN_DIR, "progress.json");

// daily-pipeline 正常跑完約數秒～數分鐘（技術指標改 latest 後）。
// 子進程 crash 沒寫終態、或 hot-reload 丟了 exit listener → progress.json 卡在 running。
// startedAt 超過這個秒數還 running → 視為死掉的舊執行，允許重跑、對外回報 error。
const STALE_MS = 20 * 60_000;

const LOG_TAIL_LINES = 12;

export interface DailyPipelineStatus {
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  logTail: string[]; // log 檔最後 N 行
  logFile: string; // log 檔基本檔名（位於 data/daily-pipeline-runs/）
  logPath: string; // 相對 repo root，給人 debug 顯示用
}

function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

function readProgress(): DailyPipelineStatus | null {
  if (!existsSync(PROGRESS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as DailyPipelineStatus;
  } catch {
    return null; // 可能剛好讀到 atomic write 之間的空檔
  }
}

// logFile 是基本檔名，永遠位於 RUN_DIR（靜態 scope，避免 Turbopack 追蹤整個專案）。
function tailLines(logFile: string, n: number): string[] {
  const path = join(RUN_DIR, logFile);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

/** spawn detached 子進程跑 daily-pipeline.ts，立刻回傳。同時只允許一個進行中。 */
export async function runDailyPipeline(): Promise<{ started: boolean; reason?: string }> {
  const current = readProgress();
  if (
    current &&
    current.status === "running" &&
    Date.now() - new Date(current.startedAt).getTime() < STALE_MS
  ) {
    return { started: false, reason: "pipeline 執行中" };
  }

  mkdirSync(RUN_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const logFile = `${stamp}.log`;
  const relLogPath = join("data", "daily-pipeline-runs", logFile);
  const absLogPath = join(RUN_DIR, logFile);

  // 先寫一份 running，讓 client 第一次輪詢就拿得到狀態（子進程啟動有幾秒延遲）。
  atomicWrite(PROGRESS_PATH, {
    status: "running",
    startedAt,
    finishedAt: null,
    exitCode: null,
    logTail: [],
    logFile,
    logPath: relLogPath,
  } satisfies DailyPipelineStatus);

  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(REPO_ROOT, "scripts", "pipeline", "daily-pipeline.ts");
  const out = openSync(absLogPath, "a");

  const child = spawn(process.execPath, [tsxCli, script], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: REPO_ROOT,
  });

  // parent 監聽結束覆寫終態（daily-pipeline.ts 不能改，所以不由子進程自寫）。
  // hot-reload 使本 listener 丟失時，getDailyPipelineStatus() 的 STALE 判定兜底。
  child.on("exit", (code) => {
    atomicWrite(PROGRESS_PATH, {
      status: code === 0 ? "done" : "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      logTail: tailLines(logFile, LOG_TAIL_LINES),
      logFile,
      logPath: relLogPath,
    } satisfies DailyPipelineStatus);
  });
  child.unref();

  return { started: true };
}

/** 讀 progress.json；running 中即時補最新 log tail；running 但超時則回報 error。 */
export async function getDailyPipelineStatus(): Promise<DailyPipelineStatus | null> {
  const p = readProgress();
  if (!p) return null;

  if (p.status === "running") {
    const elapsed = Date.now() - new Date(p.startedAt).getTime();
    if (elapsed >= STALE_MS) {
      // listener 可能已隨 hot-reload 丟失 → 視為失敗（log tail 幫 debug）。
      return {
        ...p,
        status: "error",
        finishedAt: p.finishedAt ?? new Date().toISOString(),
        logTail: tailLines(p.logFile, LOG_TAIL_LINES),
      };
    }
    // progress.json 裡的 logTail 只在終態才寫，running 中即時 tail log 檔。
    return { ...p, logTail: tailLines(p.logFile, LOG_TAIL_LINES) };
  }

  return p;
}
