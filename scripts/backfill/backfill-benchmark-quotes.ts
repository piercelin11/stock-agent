import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const FINMIND_TOKEN = process.env.FINMIND_API_KEY;
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";

const REQUEST_DELAY_MS = 6500;

// 回測大盤基準標的。目前只有 0050；之後要加 006208 / 其他就往陣列 push。
// 不碰 TechnicalIndicator / InstitutionalTrading——基準只需要收盤價算報酬。
const BENCHMARK_CODES = ["0050"];

// 回補起始日（可用 BACKFILL_START_DATE 覆蓋）；endDate 固定為執行當天。
// FinMind 單支查 6 年不會被截斷（CLAUDE.md 已驗證）。
const BACKFILL_START_DATE = process.env.BACKFILL_START_DATE ?? "2020-01-01";

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

async function fetchPriceHistory(
  stockId: string,
  startDate: string,
  endDate: string,
): Promise<FinMindPriceRow[]> {
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

  const today = new Date();
  const endDate = formatDate(today);
  const startDate = BACKFILL_START_DATE;

  console.log(`基準標的：${BENCHMARK_CODES.join(", ")}`);
  console.log(`回補區間：${startDate} ~ ${endDate}`);
  console.log(
    "注意：0050 未還原股價，除息日 close 含假跌幅；若基準報酬對除息敏感，日後改抓 TaiwanStockPriceAdj。\n",
  );

  let quotesWritten = 0;
  const failed: string[] = [];

  for (const code of BENCHMARK_CODES) {
    // 基準標的必須已存在於 Stock 表（0050 由 seed 建立，securityType=etf）。
    const stock = await prisma.stock.findUnique({
      where: { code },
      select: { code: true, market: true, name: true },
    });
    if (!stock) {
      console.error(`Stock 表沒有 ${code}，跳過（先確認 seed 有建立此標的）`);
      failed.push(code);
      continue;
    }

    try {
      const rows = await fetchPriceHistory(code, startDate, endDate);
      console.log(`${code} ${stock.name}：FinMind 回傳 ${rows.length} 筆`);

      for (const row of rows) {
        const date = new Date(row.date);
        const change = row.spread ?? 0;

        await prisma.dailyQuote.upsert({
          where: { stockCode_date: { stockCode: code, date } },
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
            stockCode: code,
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
    } catch (err) {
      console.error(`處理 ${code} 失敗:`, err instanceof Error ? err.message : err);
      failed.push(code);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log("\n===== 回補完成 =====");
  console.log(`寫入 DailyQuote 筆數: ${quotesWritten}`);
  console.log(`失敗: ${failed.length}${failed.length > 0 ? `（${failed.join(", ")}）` : ""}`);
}

main()
  .catch((err) => {
    console.error("回補腳本執行失敗:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
