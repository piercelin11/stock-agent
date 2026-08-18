import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Market, SecurityType } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TWSE_URL = "https://www.twse.com.tw/exchangeReport/BWIBBU_d";
// TPEx「個股本益比、殖利率、股價淨值比（依日期查詢）」，date 參數收西元 YYYY/MM/DD，可查歷史
const TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate";

// 回傳筆數與 Stock 表普通股筆數差異超過此比例時 log warning
const COUNT_DIFF_WARN_RATIO = 0.05;

interface TwseBwibbuResponse {
  stat: string;
  date?: string;
  data?: string[][];
}

interface TpexPeQryResponse {
  tables?: { date: string; totalCount: number; data: (string | number)[][] }[];
}

interface ValuationRow {
  code: string;
  peRatio: number | null;
  pbRatio: number | null;
  dividendYield: number | null;
  closePrice: number | null;
}

interface FillSideResult {
  processed: number;
  skippedUnknownStocks: number;
  isNonTradingDay: boolean;
}

export interface FillValuationResult {
  date: string;
  twse: FillSideResult;
  tpex: FillSideResult;
}

// 以「本地時區」的年月日輸出 ISO 日期字串，避免 toISOString() 在 UTC+8 凌晨變成前一天
function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "12.34" -> 12.34；"-"、"N/A"、空字串等缺值 -> null；含千分位逗號要先去除
function parseDecimal(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const num = parseFloat(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(num) ? num : null;
}

// "115/06/01" -> "2026-06-01"
function rocSlashDateToIso(rocDate: string): string {
  const [rocYear, month, day] = rocDate.split("/");
  return `${parseInt(rocYear ?? "0", 10) + 1911}-${month}-${day}`;
}

async function fetchTwseValuations(isoDate: string): Promise<ValuationRow[] | null> {
  const url = new URL(TWSE_URL);
  url.searchParams.set("response", "json");
  url.searchParams.set("date", isoDate.replaceAll("-", ""));
  url.searchParams.set("selectType", "ALL");

  const res = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    throw new Error(`TWSE BWIBBU_d 請求失敗 (${isoDate}): ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as TwseBwibbuResponse;
  if (body.stat !== "OK" || !body.data) {
    // 非交易日的 stat 是「很抱歉，沒有符合條件的資料!」
    return null;
  }

  const expected = isoDate.replaceAll("-", "");
  if (body.date !== expected) {
    throw new Error(`TWSE BWIBBU_d 回傳日期 ${body.date} 與請求日期 ${expected} 不符`);
  }

  // 欄位順序：[證券代號, 證券名稱, 收盤價, 殖利率(%), 股利年度, 本益比, 股價淨值比, 財報年/季]
  return body.data.map((row) => ({
    code: String(row[0]).trim(),
    closePrice: parseDecimal(row[2]),
    dividendYield: parseDecimal(row[3]),
    peRatio: parseDecimal(row[5]),
    pbRatio: parseDecimal(row[6]),
  }));
}

async function fetchTpexValuations(isoDate: string): Promise<ValuationRow[] | null> {
  const url = new URL(TPEX_URL);
  url.searchParams.set("date", isoDate.replaceAll("-", "/"));
  url.searchParams.set("id", "");
  url.searchParams.set("response", "json");

  const res = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    throw new Error(`TPEx peQryDate 請求失敗 (${isoDate}): ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as TpexPeQryResponse;
  const table = body.tables?.[0];
  if (!table || table.totalCount === 0 || !table.data || table.data.length === 0) {
    // 非交易日 totalCount 為 0
    return null;
  }

  if (rocSlashDateToIso(table.date) !== isoDate) {
    throw new Error(`TPEx peQryDate 回傳日期 ${table.date} 與請求日期 ${isoDate} 不符`);
  }

  // 欄位順序：[股票代號, 公司名稱, 本益比, 每股股利, 股利年度, 殖利率(%), 股價淨值比, 財報年/季]，無收盤價
  return table.data.map((row) => ({
    code: String(row[0]).trim(),
    peRatio: parseDecimal(row[2]),
    dividendYield: parseDecimal(row[5]),
    pbRatio: parseDecimal(row[6]),
    closePrice: null,
  }));
}

async function writeValuations(
  rows: ValuationRow[],
  dateObj: Date,
  source: "TWSE" | "TPEX",
  existingCodes: Set<string>,
): Promise<{ processed: number; skippedUnknownStocks: number }> {
  let processed = 0;
  let skippedUnknownStocks = 0;

  for (const row of rows) {
    if (!existingCodes.has(row.code)) {
      skippedUnknownStocks++;
      continue; // 只寫入 Stock 表已存在的代號
    }

    const data = {
      peRatio: row.peRatio,
      pbRatio: row.pbRatio,
      dividendYield: row.dividendYield,
      closePrice: row.closePrice,
      source,
    };
    await prisma.stockValuation.upsert({
      where: { stockCode_date: { stockCode: row.code, date: dateObj } },
      update: data,
      create: { stockCode: row.code, date: dateObj, ...data },
    });
    processed++;
  }

  return { processed, skippedUnknownStocks };
}

async function warnIfCountDiverges(market: Market, apiCount: number) {
  const dbCount = await prisma.stock.count({
    where: { market, securityType: SecurityType.stock },
  });
  const diffRatio = Math.abs(apiCount - dbCount) / dbCount;
  if (diffRatio > COUNT_DIFF_WARN_RATIO) {
    console.warn(
      `⚠ ${market} 估值 API 回傳 ${apiCount} 筆，與 Stock 表普通股 ${dbCount} 檔差異 ${(diffRatio * 100).toFixed(1)}%（估值端點僅涵蓋有估值資料的普通股，差異過大時再深究）`,
    );
  }
}

async function fillOneSide(
  isoDate: string,
  dateObj: Date,
  market: Market,
  existingCodes: Set<string>,
): Promise<FillSideResult> {
  const source = market === Market.TWSE ? "TWSE" : "TPEX";
  const rows =
    market === Market.TWSE ? await fetchTwseValuations(isoDate) : await fetchTpexValuations(isoDate);

  if (!rows) {
    console.log(`${isoDate} ${source} 估值無資料（非交易日？），跳過`);
    return { processed: 0, skippedUnknownStocks: 0, isNonTradingDay: true };
  }

  await warnIfCountDiverges(market, rows.length);
  const { processed, skippedUnknownStocks } = await writeValuations(rows, dateObj, source, existingCodes);
  console.log(
    `${isoDate} ${source} 估值寫入完成：共 ${processed} 筆，跳過 Stock 表沒有的代號 ${skippedUnknownStocks} 筆`,
  );
  return { processed, skippedUnknownStocks, isNonTradingDay: false };
}

// 抓取指定日期的 TWSE + TPEx 個股估值（PE/PB/殖利率）寫入 StockValuation
export async function fillOneDayValuation(date: Date): Promise<FillValuationResult> {
  const isoDate = toIsoDate(date);
  const dateObj = new Date(isoDate);

  const stocks = await prisma.stock.findMany({ select: { code: true } });
  const existingCodes = new Set(stocks.map((s) => s.code));

  const twse = await fillOneSide(isoDate, dateObj, Market.TWSE, existingCodes);
  const tpex = await fillOneSide(isoDate, dateObj, Market.TPEx, existingCodes);

  return { date: isoDate, twse, tpex };
}

function parseArgs(): { date: Date } {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  if (!arg) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return { date: today };
  }
  const raw = arg.slice("--date=".length);
  const normalized = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`--date 格式錯誤，應為 YYYY-MM-DD 或 YYYYMMDD，收到: ${raw}`);
  }
  return { date: new Date(normalized) };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  const { date } = parseArgs();
  fillOneDayValuation(date)
    .catch((err) => {
      console.error("估值抓取失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
