import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { fillOneDayTwse, fillTodayTpex } from "./fill-daily-quotes.js";
import { fillOneDayInstitutional } from "./fill-institutional-trading.js";
import { fillOneDayValuation } from "./fill-gap-valuation.js";
import { calculateTechnicalIndicators } from "./calculate-technical-indicators.js";
import { calculateOneDayHeat } from "./calculate-industry-heat.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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

  let quotesWritten = 0;
  let quotesDerivativesSkipped = 0;
  let institutionalWritten = 0;
  let valuationsWritten = 0;
  let indicatorsProcessed = 0;
  let heatSectorCount = 0;
  let warningCount = 0;

  const todayStr = formatDate(new Date());

  // 1. 補齊今天的報價（TWSE + TPEx）
  let twseHasData = false;
  let tpexHasData = false;
  try {
    const twseResult = await fillOneDayTwse(todayStr);
    const tpexResult = await fillTodayTpex(todayStr);
    quotesWritten = twseResult.processed + tpexResult.processed;
    quotesDerivativesSkipped = twseResult.skippedDerivatives + tpexResult.skippedDerivatives;
    twseHasData = !twseResult.isNonTradingDay;
    tpexHasData = !tpexResult.isStaleDate && !tpexResult.isNonTradingDay;
    if (tpexResult.isStaleDate) warningCount++;
  } catch (err) {
    throw new PipelineStepError("補齊今日報價", `處理日期 ${todayStr} 失敗`, err);
  }

  // TWSE 沒開盤且 TPEx 也拿不到當日資料：今天沒有任何當日資料可用，後面的計算沒有意義，提前結束
  if (!twseHasData && !tpexHasData) {
    console.log(`${todayStr} TWSE 與 TPEx 皆無當日資料，判定為非交易日，跳過後續所有步驟`);
    const finishedAt = new Date();
    const elapsedSeconds = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
    console.log(`\n===== 每日主流程結束（提前結束） ${finishedAt.toISOString()} =====`);
    console.log(`總耗時: ${elapsedSeconds} 秒`);
    console.log(`今日新增報價筆數: ${quotesWritten}`);
    console.log(`今日警告: ${warningCount} 則`);
    return;
  }

  // 2. 抓取今天的三大法人籌碼（TWSE + TPEx）
  try {
    const institutionalResult = await fillOneDayInstitutional(todayStr);
    institutionalWritten = institutionalResult.twse.processed + institutionalResult.tpex.processed;
    if (institutionalResult.tpex.isStaleDate) warningCount++;
  } catch (err) {
    throw new PipelineStepError("抓取今日籌碼", `處理日期 ${todayStr} 失敗`, err);
  }

  // 3. 抓取今天的估值（本益比/股價淨值比/殖利率，TWSE + TPEx）
  try {
    const valuationResult = await fillOneDayValuation(new Date(todayStr));
    valuationsWritten = valuationResult.twse.processed + valuationResult.tpex.processed;
  } catch (err) {
    throw new PipelineStepError("抓取今日估值", `處理日期 ${todayStr} 失敗`, err);
  }

  // 4. 重新計算技術指標
  try {
    const indicatorResult = await calculateTechnicalIndicators();
    indicatorsProcessed = indicatorResult.processed;
  } catch (err) {
    throw new PipelineStepError("計算技術指標", "計算失敗", err);
  }

  // 5. 計算產業熱度（依最新一個有 DailyQuote 資料的日子，而非寫死今天，避免假日執行時查無資料）
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
    throw new PipelineStepError("計算產業熱度", "計算失敗", err);
  }

  const finishedAt = new Date();
  const elapsedSeconds = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);

  console.log(`\n===== 每日主流程結束 ${finishedAt.toISOString()} =====`);
  console.log(`總耗時: ${elapsedSeconds} 秒`);
  console.log(`今日新增報價筆數: ${quotesWritten}`);
  console.log(`今日跳過權證/可轉債: ${quotesDerivativesSkipped} 筆`);
  console.log(`今日籌碼寫入筆數: ${institutionalWritten}`);
  console.log(`今日估值寫入筆數: ${valuationsWritten}`);
  console.log(`技術指標處理筆數: ${indicatorsProcessed}`);
  console.log(`產業熱度計算產業數: ${heatSectorCount}`);
  console.log(`今日警告: ${warningCount} 則`);
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
