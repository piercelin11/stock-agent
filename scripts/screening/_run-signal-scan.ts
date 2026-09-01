// 被 lib/actions/signal-scan.ts 的 startSignalScan() spawn 的內部進入點（底線前綴 = 非手動入口）。
// 逐批進度（phase: "fetching-quotes"）由 runSignalScan 內部的 MIS 抓取負責覆寫 progress.json；
// 這支 runner 只在最外層覆寫 progress.json 的 done / error 終態。
//
// 只跑 realtime（eod 模式由 Server Action 同步在 Next 進程內 import 跑，秒級，不需要背景任務）。
import "dotenv/config";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { runSignalScan } from "./run-signal-scan";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, "..", "..", "data", "signal-scan-results");
const PROGRESS_PATH = join(RESULT_DIR, "progress.json");

function atomicWrite(path: string, obj: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${path}.tmp`, path);
}

async function main() {
  mkdirSync(RESULT_DIR, { recursive: true });
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const startedAt = new Date().toISOString();
  try {
    const out = await runSignalScan(new Date(), { prisma, source: "realtime" });
    atomicWrite(PROGRESS_PATH, {
      status: "done",
      phase: "done",
      queriedAt: out.queriedAt,
      fetchedBatches: 0,
      totalBatches: 0,
      failedCount: out.stats.failedCount ?? 0,
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
