import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const FINMIND_TOKEN = process.env.FINMIND_API_KEY;
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";

const CALENDAR_DAYS_BACK = 480;
const REQUEST_DELAY_MS = 6500;
const PROGRESS_INTERVAL = 50;

// 測試用：透過 BACKFILL_LIMIT 環境變數限制處理股票數量
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : undefined;

interface FinMindPriceRow {
  date: string; // "2026-08-14"
  stock_id: string;
  open: number;
  max: number;
  min: number;
  close: number;
  Trading_Volume: number;
  spread: number; // 漲跌
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchPriceHistory(stockId: string, startDate: string, endDate: string): Promise<FinMindPriceRow[]> {
  const url = new URL(FINMIND_URL);
  url.searchParams.set("dataset", "TaiwanStockPrice");
  url.searchParams.set("data_id", stockId);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  if (FINMIND_TOKEN) {
    url.searchParams.set("token", FINMIND_TOKEN);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`FinMind API 請求失敗 (${stockId}): ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { status: number; msg?: string; data: FinMindPriceRow[] };
  if (body.status !== 200) {
    throw new Error(`FinMind API 回傳錯誤 (${stockId}): ${body.msg ?? body.status}`);
  }
  return body.data;
}

async function main() {
  if (!FINMIND_TOKEN) {
    console.warn("警告: 未設定 FINMIND_API_KEY，將以未註冊額度（300次/小時）呼叫 API。");
  }

  const stocks = await prisma.stock.findMany({
    where: { securityType: "stock" },
    select: { code: true, market: true },
    orderBy: { code: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`共 ${stocks.length} 支一般股票待處理${LIMIT ? `（測試模式，限制 ${LIMIT} 支）` : ""}。`);

  const today = new Date();
  const endDate = formatDate(today);
  const startDateObj = new Date(today);
  startDateObj.setDate(startDateObj.getDate() - CALENDAR_DAYS_BACK);
  const startDate = formatDate(startDateObj);

  let processed = 0;
  let quotesWritten = 0;
  const failed: string[] = [];

  for (const stock of stocks) {
    try {
      const rows = await fetchPriceHistory(stock.code, startDate, endDate);

      for (const row of rows) {
        const date = new Date(row.date);
        const change = row.spread ?? 0;

        await prisma.dailyQuote.upsert({
          where: { stockCode_date: { stockCode: stock.code, date } },
          update: {
            open: row.open,
            high: row.max,
            low: row.min,
            close: row.close,
            volume: BigInt(Math.trunc(row.Trading_Volume)),
            change,
            source: stock.market,
          },
          create: {
            stockCode: stock.code,
            date,
            open: row.open,
            high: row.max,
            low: row.min,
            close: row.close,
            volume: BigInt(Math.trunc(row.Trading_Volume)),
            change,
            source: stock.market,
          },
        });
        quotesWritten++;
      }

      processed++;

      if (processed % PROGRESS_INTERVAL === 0) {
        console.log(`已處理 ${processed}/${stocks.length}`);
      }
    } catch (err) {
      console.error(`處理 ${stock.code} 失敗:`, err instanceof Error ? err.message : err);
      failed.push(stock.code);
      processed++;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log("\n===== 回補完成 =====");
  console.log(`處理股票數: ${processed}`);
  console.log(`寫入 DailyQuote 筆數: ${quotesWritten}`);
  console.log(`失敗: ${failed.length}`);
  if (failed.length > 0) {
    console.log(`失敗代號清單: ${failed.join(", ")}`);
  }
}

main()
  .catch((err) => {
    console.error("回補腳本執行失敗:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
