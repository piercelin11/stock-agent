import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { fillOneDayTwse, fillTodayTpex } from "./fill-daily-quotes.js";
import { calculateTechnicalIndicators } from "./calculate-technical-indicators.js";
import { runScreener } from "./run-screener.js";
import { fillOneDayValuation } from "./fill-gap-valuation.js";
import { calculateOneDayHeat } from "./calculate-industry-heat.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const FILL_DELAY_MS = 2500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function listDatesBetween(startExclusive: Date, endInclusive: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(startExclusive);
  cursor.setDate(cursor.getDate() + 1);

  while (cursor <= endInclusive) {
    dates.push(formatDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

class PipelineStepError extends Error {
  constructor(step: string, detail: string, cause: unknown) {
    super(`[${step}] ${detail}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PipelineStepError";
  }
}

async function main() {
  const startedAt = new Date();
  console.log(`===== 每日主流程開始 ${startedAt.toISOString()} =====`);

  let gapDaysFilled = 0;
  let todayQuotesWritten = 0;
  let todayDerivativesSkipped = 0;
  let candidateCount = 0;
  let valuationsWritten = 0;
  let heatSectorCount = 0;

  // 2. 檢查缺漏
  let gapDates: string[] = [];
  try {
    const latest = await prisma.dailyQuote.findFirst({
      orderBy: { date: "desc" },
      select: { date: true },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (latest) {
      const latestDate = new Date(latest.date);
      latestDate.setHours(0, 0, 0, 0);
      gapDates = listDatesBetween(latestDate, today);
    } else {
      // 資料庫完全沒有資料，只補today
      gapDates = [];
    }

    if (gapDates.length === 0) {
      console.log("沒有缺漏日期，資料已是最新。");
    } else {
      console.log(`發現 ${gapDates.length} 個缺漏日期: ${gapDates.join(", ")}`);
    }
  } catch (err) {
    throw new PipelineStepError("檢查缺漏", "查詢 DailyQuote 最新日期失敗", err);
  }

  // 3. 補齊缺漏（僅 TWSE，TPEx OpenAPI 不支援指定歷史日期）
  for (const date of gapDates) {
    try {
      const result = await fillOneDayTwse(date);
      if (!result.isNonTradingDay) {
        gapDaysFilled++;
      }
    } catch (err) {
      throw new PipelineStepError("補齊缺漏", `處理日期 ${date} 失敗`, err);
    }
    await sleep(FILL_DELAY_MS);
  }

  // 4. 確保今天的資料也是最新的（TWSE + TPEx）
  const todayStr = formatDate(new Date());
  try {
    const twseResult = await fillOneDayTwse(todayStr);
    await sleep(FILL_DELAY_MS);
    const tpexResult = await fillTodayTpex();
    todayQuotesWritten = twseResult.processed + tpexResult.processed;
    todayDerivativesSkipped = twseResult.skippedDerivatives + tpexResult.skippedDerivatives;
  } catch (err) {
    throw new PipelineStepError("補齊今日資料", `處理日期 ${todayStr} 失敗`, err);
  }

  // 5. 重新計算技術指標
  try {
    await calculateTechnicalIndicators();
  } catch (err) {
    throw new PipelineStepError("計算技術指標", "計算失敗", err);
  }

  // 5.5 抓取估值（PE/PB/殖利率）：失敗不中斷 pipeline，其餘步驟照跑
  try {
    const valuationResult = await fillOneDayValuation(new Date(todayStr));
    valuationsWritten = valuationResult.twse.processed + valuationResult.tpex.processed;
  } catch (err) {
    console.error(`[抓取估值] 處理日期 ${todayStr} 失敗（不中斷，繼續後續步驟）:`, err instanceof Error ? err.message : err);
  }

  // 5.6 計算產業熱度（依最新一個有 DailyQuote 資料的日子）：失敗不中斷 pipeline
  try {
    const latestQuote = await prisma.dailyQuote.findFirst({
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (latestQuote) {
      const heatResult = await calculateOneDayHeat(latestQuote.date);
      heatSectorCount = heatResult.sectorCount;
    }
  } catch (err) {
    console.error("[產業熱度] 計算失敗（不中斷，繼續後續步驟）:", err instanceof Error ? err.message : err);
  }

  // 6. 跑篩選
  try {
    const screenerResult = await runScreener();
    candidateCount = screenerResult?.candidateCount ?? 0;
    console.log(`今日篩選出 ${candidateCount} 檔候選股`);
  } catch (err) {
    throw new PipelineStepError("跑篩選", "篩選失敗", err);
  }

  const finishedAt = new Date();
  const elapsedSeconds = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);

  console.log(`\n===== 每日主流程結束 ${finishedAt.toISOString()} =====`);
  console.log(`總耗時: ${elapsedSeconds} 秒`);
  console.log(`補齊缺漏天數: ${gapDaysFilled}`);
  console.log(`今日新增報價筆數: ${todayQuotesWritten}`);
  console.log(`今日跳過權證/可轉債: ${todayDerivativesSkipped} 筆`);
  console.log(`今日估值寫入筆數: ${valuationsWritten}`);
  console.log(`產業熱度計算產業數: ${heatSectorCount}`);
  console.log(`篩選出候選股: ${candidateCount} 檔`);
}

main()
  .catch((err) => {
    console.error("\n===== 每日主流程執行失敗 =====");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
