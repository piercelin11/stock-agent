import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

type PrismaClientLike = PrismaClient;

const FINMIND_TOKEN = process.env.FINMIND_API_KEY;
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";

const REQUEST_DELAY_MS = 6500;

// FinMind 的加權指數代號（2026-08-31 實測 TaiwanStockPrice?data_id=TAIEX 有回日線 OHLC）。
const INDEX_CODE = "TAIEX";

// 回補起始日（可用 BACKFILL_START_DATE 覆蓋）；endDate 固定為執行當天。
const BACKFILL_START_DATE = process.env.BACKFILL_START_DATE ?? "2020-01-01";

interface FinMindPriceRow {
  date: string; // "2026-08-14"
  stock_id: string;
  open: number;
  max: number;
  min: number;
  close: number;
  Trading_Volume: number; // 指數這欄是全市場成交量
  spread: number; // 漲跌
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchPriceHistory(
  dataId: string,
  startDate: string,
  endDate: string,
): Promise<FinMindPriceRow[]> {
  const url = new URL(FINMIND_URL);
  url.searchParams.set("dataset", "TaiwanStockPrice");
  url.searchParams.set("data_id", dataId);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  if (FINMIND_TOKEN) {
    url.searchParams.set("token", FINMIND_TOKEN);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`FinMind API 請求失敗 (${dataId}): ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { status: number; msg?: string; data: FinMindPriceRow[] };
  if (body.status !== 200) {
    throw new Error(`FinMind API 回傳錯誤 (${dataId}): ${body.msg ?? body.status}`);
  }
  return body.data;
}

/**
 * 確保 TAIEX 這筆 Stock（securityType=index）存在。
 * TAIEX 不在 seed 的股票清單裡（seed 來源是 TaiwanStockInfo，指數不在內）。
 * 這筆 Stock 只給大盤濾網算 MA60/帶寬用，不是個股、不進任何選股候選池。
 */
async function ensureIndexStock(prisma: PrismaClientLike): Promise<void> {
  await prisma.stock.upsert({
    where: { code: INDEX_CODE },
    update: {},
    create: {
      code: INDEX_CODE,
      name: "發行量加權股價指數",
      market: "TWSE",
      securityType: "index",
      sectorId: null,
    },
  });
}

async function upsertIndexRows(
  prisma: PrismaClientLike,
  rows: FinMindPriceRow[],
): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const date = new Date(row.date);
    const change = row.spread ?? 0;

    await prisma.dailyQuote.upsert({
      where: { stockCode_date: { stockCode: INDEX_CODE, date } },
      update: {
        open: row.open,
        high: row.max,
        low: row.min,
        close: row.close,
        volume: BigInt(Math.trunc(row.Trading_Volume)),
        change,
        source: "TWSE",
      },
      create: {
        stockCode: INDEX_CODE,
        date,
        open: row.open,
        high: row.max,
        low: row.min,
        close: row.close,
        volume: BigInt(Math.trunc(row.Trading_Volume)),
        change,
        source: "TWSE",
      },
    });
    written++;
  }
  return written;
}

/**
 * 補「單一日期」的 TAIEX 行情（daily-pipeline.ts 第 1.5 步用）。
 *
 * 比照 fill-daily-quotes.ts 的 fillOneDayTwse：吃 isoDate、可選傳入 prisma（不 $disconnect）、
 * 回 { processed, isNonTradingDay }。FinMind 對非交易日不回該日 row → data 空 → isNonTradingDay=true。
 */
export async function fillTodayIndex(
  isoDate: string,
  injectedPrisma?: PrismaClientLike,
): Promise<{ processed: number; isNonTradingDay: boolean }> {
  const ownsPrisma = !injectedPrisma;
  const prisma =
    injectedPrisma ??
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });

  try {
    await ensureIndexStock(prisma);
    const rows = await fetchPriceHistory(INDEX_CODE, isoDate, isoDate);
    const sameDay = rows.filter((r) => r.date === isoDate);
    if (sameDay.length === 0) {
      return { processed: 0, isNonTradingDay: true };
    }
    const processed = await upsertIndexRows(prisma, sameDay);
    return { processed, isNonTradingDay: false };
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

async function main() {
  if (!FINMIND_TOKEN) {
    console.warn("警告: 未設定 FINMIND_API_KEY，將以未註冊額度（300次/小時）呼叫 API。");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    await ensureIndexStock(prisma);
    console.log(`Stock 記錄 ${INDEX_CODE} 已就緒（securityType=index）`);

    const today = new Date();
    const endDate = formatDate(today);
    const startDate = BACKFILL_START_DATE;

    console.log(`回補區間：${startDate} ~ ${endDate}`);
    console.log(
      `注意：TAIEX 的 DailyQuote 只給大盤濾網算 MA60/帶寬用，不進任何選股候選池；` +
        `volume 存的是 FinMind 回的全市場成交量（對 TAIEX 無 volumeMa20 意義但無害）。\n`,
    );

    let quotesWritten = 0;

    try {
      const rows = await fetchPriceHistory(INDEX_CODE, startDate, endDate);
      console.log(`${INDEX_CODE}：FinMind 回傳 ${rows.length} 筆`);
      quotesWritten = await upsertIndexRows(prisma, rows);
    } catch (err) {
      console.error(`處理 ${INDEX_CODE} 失敗:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }

    await sleep(REQUEST_DELAY_MS);

    console.log("\n===== 回補完成 =====");
    console.log(`寫入 DailyQuote 筆數: ${quotesWritten}`);
  } finally {
    await prisma.$disconnect();
  }
}

// CLI 執行才跑 main()；被 daily-pipeline.ts import 時只取 fillTodayIndex，不觸發全區間回補。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("回補腳本執行失敗:", err);
    process.exit(1);
  });
}
