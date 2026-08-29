// Background-task PoC (docs/PLAN.md §9). Simulates a long-running job that
// writes progress to a file every second. DELETE this file (and the whole
// scripts/_poc/ dir + lib/actions/poc.ts + components/PocRunner.tsx) when the
// real backtest Layer 0 runner lands.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PROGRESS_PATH = resolve(process.cwd(), "data/_poc/progress.json");
const TOTAL = 10;

async function writeProgress(current: number, status: string) {
  await mkdir(dirname(PROGRESS_PATH), { recursive: true });
  await writeFile(
    PROGRESS_PATH,
    JSON.stringify({ current, total: TOTAL, status, updatedAt: new Date().toISOString() }),
  );
}

async function main() {
  await writeProgress(0, "running");
  for (let i = 1; i <= TOTAL; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    await writeProgress(i, i === TOTAL ? "done" : "running");
  }
}

main().catch(async (err) => {
  console.error(err);
  await writeProgress(0, "error");
  process.exit(1);
});
