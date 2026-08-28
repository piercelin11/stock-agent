import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const FINMIND_TOKEN = process.env.FINMIND_API_KEY;
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const REQUEST_DELAY_MS = 6000;
const SCREENER_RESULTS_DIR = path.join(process.cwd(), "data", "screener-results");

const INSTITUTIONAL_DAYS_BACK = 30;
const REVENUE_MONTHS_BACK = 12;
const FINANCIAL_QUARTERS_BACK = 8;
const NEWS_DAYS_BACK = 14;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return formatDate(d);
}

async function finmindRequest<T>(dataset: string, dataId: string, params: Record<string, string> = {}): Promise<T[]> {
  const url = new URL(FINMIND_URL);
  url.searchParams.set("dataset", dataset);
  url.searchParams.set("data_id", dataId);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (FINMIND_TOKEN) {
    url.searchParams.set("token", FINMIND_TOKEN);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`FinMind API 請求失敗 (${dataset}/${dataId}): ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { status: number; msg?: string; data: T[] };
  if (body.status !== 200) {
    throw new Error(`FinMind API 回傳錯誤 (${dataset}/${dataId}): ${body.msg ?? body.status}`);
  }
  return body.data;
}

// ---------- 任務 a: 籌碼面 ----------

interface FinMindInstitutionalRow {
  date: string;
  stock_id: string;
  buy: number;
  sell: number;
  name: string; // "Foreign_Investor" | "Foreign_Dealer_Self" | "Investment_Trust" | "Dealer_self" | "Dealer_Hedging"
}

async function fetchInstitutionalTrading(stockCode: string, market: "TWSE" | "TPEx"): Promise<number> {
  const rows = await finmindRequest<FinMindInstitutionalRow>("TaiwanStockInstitutionalInvestorsBuySell", stockCode, {
    start_date: daysAgo(INSTITUTIONAL_DAYS_BACK),
    end_date: daysAgo(0),
  });

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

  let written = 0;
  for (const [dateStr, values] of byDate) {
    const date = new Date(dateStr);
    await prisma.institutionalTrading.upsert({
      where: { stockCode_date: { stockCode, date } },
      update: {
        foreignNetBuy: BigInt(Math.trunc(values.foreignNetBuy)),
        investmentTrustNetBuy: BigInt(Math.trunc(values.investmentTrustNetBuy)),
        dealerNetBuy: BigInt(Math.trunc(values.dealerNetBuy)),
        source: market,
      },
      create: {
        stockCode,
        date,
        foreignNetBuy: BigInt(Math.trunc(values.foreignNetBuy)),
        investmentTrustNetBuy: BigInt(Math.trunc(values.investmentTrustNetBuy)),
        dealerNetBuy: BigInt(Math.trunc(values.dealerNetBuy)),
        source: market,
      },
    });
    written++;
  }

  return written;
}

// ---------- 任務 b: 月營收 ----------

interface FinMindRevenueRow {
  date: string;
  stock_id: string;
  country: string;
  revenue: number;
  revenue_month: number;
  revenue_year: number;
}

async function fetchMonthRevenue(stockCode: string): Promise<number> {
  const rows = await finmindRequest<FinMindRevenueRow>("TaiwanStockMonthRevenue", stockCode, {
    start_date: monthsAgo(REVENUE_MONTHS_BACK),
    end_date: daysAgo(0),
  });

  let written = 0;
  for (const row of rows) {
    await prisma.monthRevenue.upsert({
      where: { stockCode_year_month: { stockCode, year: row.revenue_year, month: row.revenue_month } },
      update: { revenue: BigInt(Math.trunc(row.revenue)) },
      create: {
        stockCode,
        year: row.revenue_year,
        month: row.revenue_month,
        revenue: BigInt(Math.trunc(row.revenue)),
      },
    });
    written++;
  }

  return written;
}

// ---------- 任務 c: 季報 ----------

interface FinMindFinancialStatementRow {
  date: string; // 季末日期，如 "2026-06-30"
  stock_id: string;
  type: string; // "Revenue" | "GrossProfit" | "OperatingIncome" | "IncomeAfterTaxes" | "EPS" | ...
  value: number;
  origin_name: string;
}

const FINANCIAL_STATEMENT_TYPE_MAP: Record<string, "revenue" | "grossProfit" | "operatingIncome" | "netIncome" | "eps"> = {
  Revenue: "revenue",
  GrossProfit: "grossProfit",
  OperatingIncome: "operatingIncome",
  IncomeAfterTaxes: "netIncome",
  EPS: "eps",
};

function quarterEndDateToYearQuarter(dateStr: string): { year: number; quarter: number } {
  const [yearStr, monthStr] = dateStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const quarter = Math.ceil(month / 3);
  return { year, quarter };
}

async function fetchFinancialStatements(stockCode: string): Promise<number> {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - FINANCIAL_QUARTERS_BACK * 3);

  const rows = await finmindRequest<FinMindFinancialStatementRow>("TaiwanStockFinancialStatements", stockCode, {
    start_date: formatDate(startDate),
    end_date: daysAgo(0),
  });

  const byQuarter = new Map<string, { year: number; quarter: number; fields: Partial<Record<"revenue" | "grossProfit" | "operatingIncome" | "netIncome" | "eps", number>> }>();

  for (const row of rows) {
    const field = FINANCIAL_STATEMENT_TYPE_MAP[row.type];
    if (!field) continue;

    const { year, quarter } = quarterEndDateToYearQuarter(row.date);
    const key = `${year}-${quarter}`;
    if (!byQuarter.has(key)) {
      byQuarter.set(key, { year, quarter, fields: {} });
    }
    byQuarter.get(key)!.fields[field] = row.value;
  }

  let written = 0;
  for (const { year, quarter, fields } of byQuarter.values()) {
    const data: {
      revenue?: bigint;
      grossProfit?: bigint;
      operatingIncome?: bigint;
      netIncome?: bigint;
      eps?: number;
    } = {};
    if (fields.revenue !== undefined) data.revenue = BigInt(Math.trunc(fields.revenue));
    if (fields.grossProfit !== undefined) data.grossProfit = BigInt(Math.trunc(fields.grossProfit));
    if (fields.operatingIncome !== undefined) data.operatingIncome = BigInt(Math.trunc(fields.operatingIncome));
    if (fields.netIncome !== undefined) data.netIncome = BigInt(Math.trunc(fields.netIncome));
    if (fields.eps !== undefined) data.eps = fields.eps;

    await prisma.financialStatement.upsert({
      where: { stockCode_year_quarter: { stockCode, year, quarter } },
      update: data,
      create: { stockCode, year, quarter, ...data },
    });
    written++;
  }

  return written;
}

// ---------- 任務 d: 消息面 ----------

interface FinMindNewsRow {
  date: string; // "2026-08-04 01:02:00"
  stock_id: string;
  link: string;
  source: string;
  title: string;
}

async function fetchNews(stockCode: string): Promise<number> {
  const rows = await finmindRequest<FinMindNewsRow>("TaiwanStockNews", stockCode, {
    start_date: daysAgo(NEWS_DAYS_BACK),
  });

  const cutoff = new Date(daysAgo(NEWS_DAYS_BACK));

  // FinMind 同一則新聞可能因不同 source 別名重複出現，依 link 去重，保留第一筆
  const byLink = new Map<string, FinMindNewsRow>();
  for (const row of rows) {
    if (new Date(row.date) < cutoff) continue;
    if (!byLink.has(row.link)) {
      byLink.set(row.link, row);
    }
  }

  let written = 0;
  for (const row of byLink.values()) {
    const existing = await prisma.newsArticle.findUnique({ where: { link: row.link } });

    let newsId: number;
    if (existing) {
      newsId = existing.id;
    } else {
      const created = await prisma.newsArticle.create({
        data: {
          title: row.title,
          link: row.link,
          source: row.source,
          publishedAt: new Date(row.date),
        },
      });
      newsId = created.id;
      written++;
    }

    await prisma.newsStock.upsert({
      where: { newsId_stockCode: { newsId, stockCode } },
      update: {},
      create: { newsId, stockCode },
    });
  }

  return written;
}

// ---------- 主流程 ----------

interface ScreenerResult {
  date: string;
  results: { code: string; name: string }[];
}

function findLatestScreenerFile(): string {
  const files = fs
    .readdirSync(SCREENER_RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`${SCREENER_RESULTS_DIR} 目錄下沒有任何篩選結果檔案`);
  }
  const latest = files[files.length - 1]!;
  return path.join(SCREENER_RESULTS_DIR, latest);
}

function resolveScreenerFile(): string {
  const dateArg = process.argv.find((arg) => arg.startsWith("--date="));
  if (dateArg) {
    const date = dateArg.split("=")[1];
    return path.join(SCREENER_RESULTS_DIR, `${date}.json`);
  }
  return findLatestScreenerFile();
}

interface FailureRecord {
  code: string;
  step: "institutional" | "revenue" | "financial" | "news";
  error: string;
}

async function main() {
  if (!FINMIND_TOKEN) {
    console.warn("警告: 未設定 FINMIND_API_KEY，將以未註冊額度（300次/小時）呼叫 API。");
  }

  const filePath = resolveScreenerFile();
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到篩選結果檔案: ${filePath}`);
  }

  const screenerData = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ScreenerResult;
  const candidates = screenerData.results;

  console.log(`讀取篩選結果: ${filePath}`);
  console.log(`候選股數量: ${candidates.length}`);
  console.log(`預估耗時: 約 ${Math.ceil((candidates.length * 4 * (REQUEST_DELAY_MS / 1000)) / 60)} 分鐘\n`);

  const stocks = await prisma.stock.findMany({
    where: { code: { in: candidates.map((c) => c.code) } },
    select: { code: true, market: true },
  });
  const marketByCode = new Map(stocks.map((s) => [s.code, s.market]));

  let institutionalWritten = 0;
  let revenueWritten = 0;
  let financialWritten = 0;
  let newsWritten = 0;
  const failures: FailureRecord[] = [];

  for (const [i, candidate] of candidates.entries()) {
    const market = marketByCode.get(candidate.code);

    if (!market) {
      console.error(`跳過 ${candidate.code}（${candidate.name}）：資料庫中找不到對應的 Stock 記錄`);
      failures.push({ code: candidate.code, step: "institutional", error: "找不到 Stock 記錄" });
      continue;
    }

    // a. 籌碼面
    try {
      institutionalWritten += await fetchInstitutionalTrading(candidate.code, market);
    } catch (err) {
      console.error(`${candidate.code} 籌碼面抓取失敗:`, err instanceof Error ? err.message : err);
      failures.push({ code: candidate.code, step: "institutional", error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(REQUEST_DELAY_MS);

    // b. 月營收
    try {
      revenueWritten += await fetchMonthRevenue(candidate.code);
    } catch (err) {
      console.error(`${candidate.code} 月營收抓取失敗:`, err instanceof Error ? err.message : err);
      failures.push({ code: candidate.code, step: "revenue", error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(REQUEST_DELAY_MS);

    // c. 季報
    try {
      financialWritten += await fetchFinancialStatements(candidate.code);
    } catch (err) {
      console.error(`${candidate.code} 季報抓取失敗:`, err instanceof Error ? err.message : err);
      failures.push({ code: candidate.code, step: "financial", error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(REQUEST_DELAY_MS);

    // d. 消息面
    try {
      newsWritten += await fetchNews(candidate.code);
    } catch (err) {
      console.error(`${candidate.code} 消息面抓取失敗:`, err instanceof Error ? err.message : err);
      failures.push({ code: candidate.code, step: "news", error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(REQUEST_DELAY_MS);

    console.log(`已處理 ${i + 1}/${candidates.length} 檔: ${candidate.code} ${candidate.name}`);
  }

  console.log("\n===== 候選股深度資料抓取完成 =====");
  console.log(`處理候選股數: ${candidates.length}`);
  console.log(`寫入 InstitutionalTrading 筆數: ${institutionalWritten}`);
  console.log(`寫入 MonthRevenue 筆數: ${revenueWritten}`);
  console.log(`寫入 FinancialStatement 筆數: ${financialWritten}`);
  console.log(`新增 NewsArticle 筆數: ${newsWritten}`);
  console.log(`失敗次數: ${failures.length}`);
  if (failures.length > 0) {
    console.log("失敗明細:");
    for (const f of failures) {
      console.log(`  - ${f.code} [${f.step}]: ${f.error}`);
    }
  }
}

main()
  .catch((err) => {
    console.error("腳本執行失敗:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
