import "dotenv/config";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import {
  calculateMarketRegime,
  type MarketRegimeResult,
} from "../lib/market-regime.js";

// 大盤濾網（市場狀態燈號）pipeline 步驟。PLAN §3。
//
// 薄殼：建 prisma → 找 DB 最新交易日 → calculateMarketRegime → 原子寫
// data/market-regime/{date}.json（不落地 DB）。
// 每日算一次（daily-pipeline 第 5 步，非關鍵路徑）。盤中會多次取 → 允許一天多筆（覆寫同檔）。

const __dirname = dirname(fileURLToPath(import.meta.url));

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export async function calculateOneDayRegime(
  date: Date,
  client: PrismaClient,
): Promise<MarketRegimeResult> {
  const result = await calculateMarketRegime(date, { prisma: client });

  const outputDir = join(__dirname, "..", "..", "data", "market-regime");
  mkdirSync(outputDir, { recursive: true });

  // 原子寫：先寫 .tmp 再 renameSync（比照 intraday progress.json）
  const tmpPath = join(outputDir, `${result.date}.json.tmp`);
  const finalPath = join(outputDir, `${result.date}.json`);
  writeFileSync(
    tmpPath,
    JSON.stringify(
      { ...result, generatedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  renameSync(tmpPath, finalPath);

  return result;
}

function parseDateArg(): Date | null {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  if (!arg) return null;
  const raw = arg.slice("--date=".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`--date 需要 YYYY-MM-DD 格式，收到: ${raw}`);
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

async function main() {
  const explicitDate = parseDateArg();

  let target: Date;
  if (explicitDate) {
    target = explicitDate;
  } else {
    const latestQuote = await prisma.dailyQuote.findFirst({
      where: { stock: { securityType: "stock" } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (!latestQuote) {
      console.log("DailyQuote 沒有任何一般股票資料，無法計算");
      return;
    }
    target = latestQuote.date;
  }

  const result = await calculateOneDayRegime(target, prisma);
  const b = result.dimensions.breadth;
  console.log(
    `大盤濾網 ${result.date}：${result.label}（totalScore ${result.totalScore}, stage ${result.stage}）`,
  );
  console.log(
    `  市場寬度：score ${b.score}${b.degraded ? "（資料不足）" : ""}，站上 MA60 ${b.detail.aboveMa60}/${b.detail.total}（${b.detail.pct}%）`,
  );
  if (result.dimensions.indexPosition) {
    const ip = result.dimensions.indexPosition;
    console.log(
      `  指數位置：score ${ip.score}${ip.degraded ? "（資料不足）" : ""}，TAIEX ${ip.detail.latestClose} vs MA60 ${ip.detail.latestMa60}`,
    );
  }
  if (result.dimensions.ma60Slope) {
    const sl = result.dimensions.ma60Slope;
    console.log(
      `  MA60 斜率：score ${sl.score}${sl.degraded ? "（資料不足）" : ""}，slope ${sl.detail.slopePct}%`,
    );
  }
}

const isMain =
  process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main()
    .catch((err) => {
      console.error("大盤濾網計算失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
