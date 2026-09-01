import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { fillOneDayTwse, fillTodayTpex } from "./fill-daily-quotes.js";
import { fillTodayIndex } from "../backfill/backfill-index-quotes.js";
import { fillOneDayInstitutional } from "./fill-institutional-trading.js";
import { fillOneDayValuation } from "./fill-gap-valuation.js";
import { fillOneDayMargin } from "./fill-margin-trading.js";
import { calculateTechnicalIndicators } from "./calculate-technical-indicators.js";
import { calculateOneDayRegime } from "./calculate-market-regime.js";
import { calculateOneDayHeat } from "./calculate-industry-heat.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// 冷進程連續打兩個政府 host（TWSE → TPEx）之間喘口氣：TWSE 那次呼叫已把 DNS/TLS 暖起來，
// 但 www.tpex.org.tw 是這個進程碰的第二個 host，第一次握手常被 RST（launchd 事故 2026-09-01）。
const TPEX_COLD_GAP_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

class PipelineStepError extends Error {
  constructor(step: string, detail: string, cause: unknown) {
    super(`[${step}] ${detail}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PipelineStepError";
  }
}

async function main() {
  const startedAt = new Date();
  console.log(`===== 每日主流程開始 ${startedAt.toISOString()} =====`);

  const todayStr = formatDate(new Date());

  // 當日成功標記檔：17:00 已成功時，讓 17:30 / 18:00 的補跑秒退，不重跑 20 分鐘。
  // 只在「跑完無致命錯誤」（正常結束 or 非交易日提前結束）時寫，致命錯誤不寫 → 補跑才有意義。
  const OK_MARK = join(process.cwd(), "data", "daily-pipeline-runs", `${todayStr}.ok`);
  if (existsSync(OK_MARK)) {
    console.log(`${todayStr} 今日 pipeline 已成功執行過（${OK_MARK}），跳過。`);
    return;
  }

  let quotesWritten = 0;
  let quotesDerivativesSkipped = 0;
  let indexWritten = 0;
  let institutionalWritten = 0;
  let valuationsWritten = 0;
  let marginWritten = 0;
  let indicatorsProcessed = 0;
  let regimeLabel = "—";
  let heatSectorCount = 0;
  let warningCount = 0;

  // 1. 補齊今天的報價
  let twseHasData = false;
  let tpexHasData = false;

  // 1a. TWSE 報價（關鍵路徑：失敗 throw）
  try {
    const twseResult = await fillOneDayTwse(todayStr);
    quotesWritten += twseResult.processed;
    quotesDerivativesSkipped += twseResult.skippedDerivatives;
    twseHasData = !twseResult.isNonTradingDay;
  } catch (err) {
    throw new PipelineStepError("補齊今日 TWSE 報價", `處理日期 ${todayStr} 失敗`, err);
  }

  // 1b. 冷進程連續打兩個政府 host 之間喘口氣
  await sleep(TPEX_COLD_GAP_MS);

  // 1c. TPEx 報價（非關鍵路徑：失敗只 warn，tpexHasData 留 false）
  //     TPEx OpenAPI 本來就只給「最新一天」，隔天 pipeline 會再抓；缺的那天可用 backfill-daily-quotes.ts 補。
  //     比照第 3.5 步融資融券的既有寫法。
  try {
    const tpexResult = await fillTodayTpex(todayStr);
    quotesWritten += tpexResult.processed;
    quotesDerivativesSkipped += tpexResult.skippedDerivatives;
    tpexHasData = !tpexResult.isStaleDate && !tpexResult.isNonTradingDay;
    if (tpexResult.isStaleDate) warningCount++;
  } catch (err) {
    console.warn(
      `[TPEx 報價] 抓取失敗（不中斷 pipeline）: ${err instanceof Error ? err.message : String(err)}`,
    );
    warningCount++;
    // tpexHasData 維持初始 false
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
    writeOkMark(OK_MARK); // 非交易日的補跑同樣該秒退
    return;
  }

  // 1.5. 補齊今天的加權指數（TAIEX）行情
  // FinMind TaiwanStockPrice?data_id=TAIEX，含完整 OHLC。pipeline 唯一補 TAIEX DailyQuote 的地方
  // （fill-daily-quotes 抓的是全市場個股，MI_INDEX 個股明細不含加權指數這筆）。
  // 第 4 步 calculate-technical-indicators 的 where 有納入 TAIEX、第 5 步大盤濾網吃它算 MA60/斜率，
  // 都依賴這步先補好當日 close。關鍵路徑：FinMind 盤後即有當日 TAIEX（2026-09-01 實測），拿不到就 throw。
  try {
    const indexResult = await fillTodayIndex(todayStr, prisma);
    indexWritten = indexResult.processed;
    if (indexResult.isNonTradingDay) {
      // 走到這裡代表 TWSE/TPEx 有當日資料（前面沒提前結束），TAIEX 卻沒有 → 資料源不同步，印警告不中斷
      console.warn(`[加權指數] ${todayStr} FinMind 尚無當日 TAIEX，跳過（大盤濾網會降級 step1-breadth-only）`);
      warningCount++;
    }
  } catch (err) {
    throw new PipelineStepError("補齊今日加權指數", `處理日期 ${todayStr} 失敗`, err);
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

  // 3.5. 抓取今天的融資融券餘額（TWSE + TPEx）
  // 非關鍵路徑：融資融券證交所通常傍晚才出，TWSE+TPEx 都拿不到當日資料時印警告，不讓 pipeline 非 0 結束。
  try {
    const marginResult = await fillOneDayMargin(todayStr);
    marginWritten = marginResult.twse.processed + marginResult.tpex.processed;
    const twseGot = !marginResult.twse.isNonTradingDay;
    const tpexGot = !marginResult.tpex.isNonTradingDay;
    if (!twseGot && !tpexGot) {
      console.warn(`[融資融券] ${todayStr} TWSE 與 TPEx 皆無當日資料（通常傍晚才出），跳過`);
      warningCount++;
    }
  } catch (err) {
    console.warn(
      `[融資融券] 抓取失敗（不中斷 pipeline）: ${err instanceof Error ? err.message : String(err)}`,
    );
    warningCount++;
  }

  // 4. 重新計算技術指標（只算當天：每支撈最近 ~250 筆當輸入、只 upsert 最新一天，秒級）
  //    where 有納入 TAIEX，所以第 1.5 步補好的當日 TAIEX close 會在這步一併算出 TechnicalIndicator。
  // 代價：pipeline 漏跑那天的技術指標不會自動補，需手動 calculate-technical-indicators.ts <code> 全歷史重算。
  try {
    const indicatorResult = await calculateTechnicalIndicators(undefined, { mode: "latest" });
    indicatorsProcessed = indicatorResult.processed;
  } catch (err) {
    throw new PipelineStepError("計算技術指標", "計算失敗", err);
  }

  // 5. 計算大盤濾網（市場狀態燈號）
  // 依賴第 4 步已更新 TAIEX 的 TechnicalIndicator（1.4 改完後 calculateTechnicalIndicators() 會一起更新）。
  // 非關鍵路徑：失敗印警告，不 throw、不讓 pipeline 非 0 結束。
  try {
    const latestQuote = await prisma.dailyQuote.findFirst({
      where: { stock: { securityType: "stock" } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (latestQuote) {
      const regime = await calculateOneDayRegime(latestQuote.date, prisma);
      regimeLabel = regime.label;
      console.log(
        `大盤濾網：${regime.label}（totalScore ${regime.totalScore}, stage ${regime.stage}）`,
      );
    }
  } catch (err) {
    console.warn(
      `[大盤濾網] 計算失敗（不中斷 pipeline）: ${err instanceof Error ? err.message : String(err)}`,
    );
    warningCount++;
  }

  // 6. 計算產業熱度（依最新一個有 DailyQuote 資料的日子，而非寫死今天，避免假日執行時查無資料）
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
  console.log(`今日加權指數寫入筆數: ${indexWritten}`);
  console.log(`今日跳過權證/可轉債: ${quotesDerivativesSkipped} 筆`);
  console.log(`今日籌碼寫入筆數: ${institutionalWritten}`);
  console.log(`今日估值寫入筆數: ${valuationsWritten}`);
  console.log(`今日融資融券寫入筆數: ${marginWritten}`);
  console.log(`技術指標處理筆數: ${indicatorsProcessed}`);
  console.log(`大盤濾網: ${regimeLabel}`);
  console.log(`產業熱度計算產業數: ${heatSectorCount}`);
  console.log(`今日警告: ${warningCount} 則`);

  writeOkMark(OK_MARK);
}

function writeOkMark(okMark: string): void {
  mkdirSync(dirname(okMark), { recursive: true });
  writeFileSync(okMark, new Date().toISOString());
}

main()
  .catch((err) => {
    console.error("\n===== 每日主流程執行失敗 =====");
    console.error(err instanceof Error ? err.message : err);
    if (err instanceof Error && err.cause) {
      console.error("原因 (cause):", err.cause);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
