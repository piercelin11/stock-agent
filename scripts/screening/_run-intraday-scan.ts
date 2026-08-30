// 被 lib/actions/intraday.ts 的 startIntradayScan() spawn 的內部進入點。
// 底線前綴 = 內部 runner，不是給人手動跑的（比照 scripts/_poc 歷史慣例）。
//
// 職責分工：checkIntradayBreakout 內部負責 phase: "fetching-quotes" 的逐批進度覆寫；
// 這支 runner 只在最外層覆寫 progress.json 的 done / error 終態。
import "dotenv/config";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { checkIntradayBreakout } from "./check-intraday-breakout";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "..", "data", "intraday-breakout-snapshots");
const PROGRESS_PATH = join(SNAPSHOT_DIR, "progress.json");

function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

async function main() {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const startedAt = new Date().toISOString();
  try {
    const out = await checkIntradayBreakout({ prisma });
    atomicWrite(PROGRESS_PATH, {
      status: "done",
      phase: "done",
      queriedAt: out.queriedAt,
      fetchedBatches: 0,
      totalBatches: 0, // done 態不看
      failedCount: out.stats.failedCount,
      startedAt,
      updatedAt: new Date().toISOString(),
      warnings: out.warnings,
      error: null,
    });
  } catch (err) {
    atomicWrite(PROGRESS_PATH, {
      status: "error",
      phase: "error",
      queriedAt: startedAt,
      fetchedBatches: 0,
      totalBatches: 0,
      failedCount: 0,
      startedAt,
      updatedAt: new Date().toISOString(),
      warnings: [],
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
