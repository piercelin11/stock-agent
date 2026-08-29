"use server";

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Background-task PoC (docs/PLAN.md §9). Pattern to reuse for the real backtest
// runner: spawn a detached tsx process, have it write progress to a file, poll
// that file from a Server Action. DELETE with the rest of the _poc files.

const TSX_CLI = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const TASK_SCRIPT = resolve(process.cwd(), "scripts/_poc/long-task.ts");
const PROGRESS_PATH = resolve(process.cwd(), "data/_poc/progress.json");

type PocProgress = {
  current: number;
  total: number;
  status: "idle" | "running" | "done" | "error";
  updatedAt?: string;
};

export async function startPocTask(): Promise<{ started: true }> {
  const child = spawn(process.execPath, [TSX_CLI, TASK_SCRIPT], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });
  child.unref();
  return { started: true };
}

export async function getPocProgress(): Promise<PocProgress> {
  try {
    const raw = await readFile(PROGRESS_PATH, "utf8");
    return JSON.parse(raw) as PocProgress;
  } catch {
    return { current: 0, total: 10, status: "idle" };
  }
}
