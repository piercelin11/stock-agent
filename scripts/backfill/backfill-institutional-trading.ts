import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const FINMIND_TOKEN = process.env.FINMIND_API_KEY;
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";

const REQUEST_DELAY_MS = 6500;
const PROGRESS_INTERVAL = 25;

// 回補起始日（可用 BACKFILL_START_DATE 覆蓋）；endDate 固定為執行當天
const BACKFILL_START_DATE = process.env.BACKFILL_START_DATE ?? "2020-01-01";

// 測試用：透過 BACKFILL_LIMIT 環境變數限制處理股票數量
const LIMIT = process.env.BACKFILL_LIMIT ? parseInt(process.env.BACKFILL_LIMIT, 10) : undefined;

interface FinMindInstitutionalRow {
  date: string; // "2026-08-14"
  stock_id: string;
  buy: number;
  sell: number;
  name: string; // "Foreign_Investor" | "Foreign_Dealer_Self" | "Investment_Trust" | "Dealer_self" | "Dealer_Hedging"
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchInstitutionalHistory(
  stockId: string,
  startDate: string,
  endDate: string,
): Promise<FinMindInstitutionalRow[]> {
  const url = new URL(FINMIND_URL);
  url.searchParams.set("dataset", "TaiwanStockInstitutionalInvestorsBuySell");
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
  const body = (await res.json()) as { status: number; msg?: string; data: FinMindInstitutionalRow[] };
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
    where: { securityType: "stock", delistedAt: null }, // 排除已下市，省 FinMind 配額
    select: { code: true, market: true },
    orderBy: { code: "asc" },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`共 ${stocks.length} 支一般股票待處理${LIMIT ? `（測試模式，限制 ${LIMIT} 支）` : ""}。`);

  const today = new Date();
  const endDate = formatDate(today);
  const startDate = BACKFILL_START_DATE;

  console.log(`回補區間：${startDate} ~ ${endDate}`);

  let processed = 0;
  let tradesWritten = 0;
  const failed: string[] = [];

  for (const stock of stocks) {
    try {
      const rows = await fetchInstitutionalHistory(stock.code, startDate, endDate);

      const byDate = new Map<string, { foreignNetBuy: number; investmentTrustNetBuy: number; dealerNetBuy: number }>();

      for (const row of rows) {
        if (!byDate.has(row.date)) {
          byDate.set(row.date, { foreignNetBuy: 0, investmentTrustNetBuy: 0, dealerNetBuy: 0 });
        }
        const entry = byDate.get(row.date)!;
        const net = row.buy - row.sell;

        if (row.name === "Foreign_Investor" || row.name === "Foreign_Dealer_Self") {
          entry.foreignNetBuy += net;
        } else if (row.name === "Investment_Trust") {
          entry.investmentTrustNetBuy += net;
        } else if (row.name === "Dealer_self" || row.name === "Dealer_Hedging") {
          entry.dealerNetBuy += net;
        }
      }

      for (const [dateStr, values] of byDate) {
        const date = new Date(dateStr);
        await prisma.institutionalTrading.upsert({
          where: { stockCode_date: { stockCode: stock.code, date } },
          update: {
            foreignNetBuy: BigInt(Math.trunc(values.foreignNetBuy)),
            investmentTrustNetBuy: BigInt(Math.trunc(values.investmentTrustNetBuy)),
            dealerNetBuy: BigInt(Math.trunc(values.dealerNetBuy)),
            source: stock.market,
          },
          create: {
            stockCode: stock.code,
            date,
            foreignNetBuy: BigInt(Math.trunc(values.foreignNetBuy)),
            investmentTrustNetBuy: BigInt(Math.trunc(values.investmentTrustNetBuy)),
            dealerNetBuy: BigInt(Math.trunc(values.dealerNetBuy)),
            source: stock.market,
          },
        });
        tradesWritten++;
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
  console.log(`寫入 InstitutionalTrading 筆數: ${tradesWritten}`);
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
