import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Market, SecurityType } from "../../generated/prisma/client.js";
import { fetchJson } from "../lib/http.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// TWSE 個股融資融券彙總，支援任意歷史日期查詢
const TWSE_URL = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN";
// TPEx 個股融資融券餘額（依日期查詢），date 收西元 YYYY/MM/DD，可查歷史（與 TPEx 行情端點不同）
const TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/margin/balance";

interface TwseMarginResponse {
  stat: string;
  date?: string;
  tables?: { title?: string; fields?: string[]; data?: string[][] }[];
}

interface TpexMarginResponse {
  date?: string;
  tables?: { title?: string; date?: string; totalCount?: number; fields?: string[]; data?: (string | number)[][] }[];
}

interface MarginRow {
  code: string;
  name: string;
  marginBalance: bigint;
  marginBalancePrev: bigint;
  marginQuota: bigint | null;
  shortBalance: bigint;
  shortBalancePrev: bigint;
  offsetting: bigint | null;
}

interface FillSideResult {
  processed: number;
  skippedUnknownStocks: number;
  skippedNonStock: number;
  isNonTradingDay: boolean;
  actualDate: string | null;
}

export interface FillMarginResult {
  date: string;
  twse: FillSideResult;
  tpex: FillSideResult;
}

// "1,234" -> 1234000n（張 ×1000 → 股）；空字串 / "-" 視為 0（沒有信用交易餘額，不是缺值）
function parseLots(raw: string | number | undefined): bigint {
  if (raw === undefined) return 0n;
  const s = String(raw).trim();
  if (s === "" || s === "-") return 0n;
  const lots = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(lots) ? BigInt(Math.round(lots) * 1000) : 0n;
}

// nullable 欄位（marginQuota / offsetting）：缺值回 null 而非 0n
function parseLotsNullable(raw: string | number | undefined): bigint | null {
  if (raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "" || s === "-") return null;
  const lots = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(lots) ? BigInt(Math.round(lots) * 1000) : null;
}

// "115/08/28" -> "2026-08-28"
function rocSlashDateToIso(rocDate: string): string {
  const [rocYear, month, day] = rocDate.split("/");
  return `${parseInt(rocYear ?? "0", 10) + 1911}-${month}-${day}`;
}

// 沿用 fill-institutional-trading.ts 的分類規則
function toSecurityType(code: string, name: string): SecurityType {
  if (code.startsWith("00")) return SecurityType.etf;
  if (/^.{4}[A-Za-z]$/.test(code)) return SecurityType.preferred;
  if (/^\d{6}$/.test(code) || name.includes("購") || name.includes("售")) return SecurityType.warrant;
  if (/^\d{5}$/.test(code)) return SecurityType.bond;
  if (/^\d{4}$/.test(code)) return SecurityType.stock;
  return SecurityType.other;
}

// 這批保留一般股票 + 特別股（特別股也有信用交易資格）
function isTrackedType(t: SecurityType): boolean {
  return t === SecurityType.stock || t === SecurityType.preferred;
}

async function fetchTwseMargin(isoDate: string): Promise<MarginRow[] | null> {
  const url = new URL(TWSE_URL);
  url.searchParams.set("response", "json");
  url.searchParams.set("date", isoDate.replaceAll("-", ""));
  url.searchParams.set("selectType", "ALL");

  const body = await fetchJson<TwseMarginResponse>(url.toString());
  if (body.stat !== "OK" || !body.tables) {
    // 非交易日的 stat 是「很抱歉，沒有符合條件的資料!」，無 tables
    return null;
  }

  const expected = isoDate.replaceAll("-", "");
  if (body.date !== expected) {
    throw new Error(`TWSE MI_MARGN 回傳日期 ${body.date} 與請求日期 ${expected} 不符`);
  }

  // 個股明細在 tables[1]（tables[0] 是全市場彙總「信用交易統計」）
  const detail = body.tables[1];
  if (!detail?.data) {
    throw new Error("TWSE MI_MARGN 回應缺少 tables[1] 個股明細");
  }

  // 欄位（16 欄）：[0]代號 [1]名稱 [2]融資買進 [3]融資賣出 [4]融資現金償還 [5]融資前日餘額
  //   [6]融資今日餘額 [7]融資次一營業日限額 [8]融券買進 [9]融券賣出 [10]融券現券償還
  //   [11]融券前日餘額 [12]融券今日餘額 [13]融券次一營業日限額 [14]資券互抵 [15]註記
  return detail.data.map((row) => ({
    code: String(row[0]).trim(),
    name: String(row[1]).trim(),
    marginBalancePrev: parseLots(row[5]),
    marginBalance: parseLots(row[6]),
    marginQuota: parseLotsNullable(row[7]),
    shortBalancePrev: parseLots(row[11]),
    shortBalance: parseLots(row[12]),
    offsetting: parseLotsNullable(row[14]),
  }));
}

async function fetchTpexMargin(isoDate: string): Promise<MarginRow[] | null> {
  const url = new URL(TPEX_URL);
  url.searchParams.set("date", isoDate.replaceAll("-", "/"));
  url.searchParams.set("id", "");
  url.searchParams.set("response", "json");

  const body = await fetchJson<TpexMarginResponse>(url.toString());
  const table = body.tables?.[0];
  if (!table || !table.totalCount || !table.data || table.data.length === 0) {
    // 非交易日 totalCount 為 0 / data 空
    return null;
  }

  if (table.date && rocSlashDateToIso(table.date) !== isoDate) {
    throw new Error(`TPEx margin/balance 回傳日期 ${table.date} 與請求日期 ${isoDate} 不符`);
  }

  // 欄位（20 欄）：[0]代號 [1]名稱 [2]前資餘額(張) [3]資買 [4]資賣 [5]現償 [6]資餘額
  //   [7]資屬證金 [8]資使用率(%) [9]資限額 [10]前券餘額(張) [11]券賣 [12]券買 [13]券償
  //   [14]券餘額 [15]券屬證金 [16]券使用率(%) [17]券限額 [18]資券相抵(張) [19]備註
  return table.data.map((row) => ({
    code: String(row[0]).trim(),
    name: String(row[1]).trim(),
    marginBalancePrev: parseLots(row[2]),
    marginBalance: parseLots(row[6]),
    marginQuota: parseLotsNullable(row[9]),
    shortBalancePrev: parseLots(row[10]),
    shortBalance: parseLots(row[14]),
    offsetting: parseLotsNullable(row[18]),
  }));
}

async function writeMarginRows(
  rows: MarginRow[],
  dateObj: Date,
  source: Market,
  existingCodes: Set<string>,
): Promise<{ processed: number; skippedUnknownStocks: number; skippedNonStock: number }> {
  let processed = 0;
  let skippedUnknownStocks = 0;
  let skippedNonStock = 0;

  for (const row of rows) {
    if (!isTrackedType(toSecurityType(row.code, row.name))) {
      skippedNonStock++;
      continue; // ETF/權證/可轉債等不寫入
    }

    // 只寫入 Stock 表已存在的代號：信用交易資料不該是新股票的來源
    if (!existingCodes.has(row.code)) {
      skippedUnknownStocks++;
      continue;
    }

    const data = {
      marginBalance: row.marginBalance,
      marginBalancePrev: row.marginBalancePrev,
      marginQuota: row.marginQuota,
      shortBalance: row.shortBalance,
      shortBalancePrev: row.shortBalancePrev,
      offsetting: row.offsetting,
      source,
    };
    await prisma.marginTrading.upsert({
      where: { stockCode_date: { stockCode: row.code, date: dateObj } },
      update: data,
      create: { stockCode: row.code, date: dateObj, ...data },
    });
    processed++;
  }

  return { processed, skippedUnknownStocks, skippedNonStock };
}

async function fillTwseSide(isoDate: string, existingCodes: Set<string>): Promise<FillSideResult> {
  const rows = await fetchTwseMargin(isoDate);

  if (!rows) {
    console.log(`${isoDate} TWSE 融資融券非交易日或無資料，跳過`);
    return {
      processed: 0,
      skippedUnknownStocks: 0,
      skippedNonStock: 0,
      isNonTradingDay: true,
      actualDate: null,
    };
  }

  const dateObj = new Date(isoDate);
  const { processed, skippedUnknownStocks, skippedNonStock } = await writeMarginRows(
    rows,
    dateObj,
    Market.TWSE,
    existingCodes,
  );
  console.log(
    `${isoDate} TWSE 融資融券寫入完成：共 ${processed} 筆，跳過非追蹤類型 ${skippedNonStock} 筆，跳過 Stock 表沒有的代號 ${skippedUnknownStocks} 筆`,
  );
  return { processed, skippedUnknownStocks, skippedNonStock, isNonTradingDay: false, actualDate: isoDate };
}

async function fillTpexSide(isoDate: string, existingCodes: Set<string>): Promise<FillSideResult> {
  const rows = await fetchTpexMargin(isoDate);

  if (!rows) {
    console.log(`${isoDate} TPEx 融資融券非交易日或無資料，跳過`);
    return {
      processed: 0,
      skippedUnknownStocks: 0,
      skippedNonStock: 0,
      isNonTradingDay: true,
      actualDate: null,
    };
  }

  const dateObj = new Date(isoDate);
  const { processed, skippedUnknownStocks, skippedNonStock } = await writeMarginRows(
    rows,
    dateObj,
    Market.TPEx,
    existingCodes,
  );
  console.log(
    `${isoDate} TPEx 融資融券寫入完成：共 ${processed} 筆，跳過非追蹤類型 ${skippedNonStock} 筆，跳過 Stock 表沒有的代號 ${skippedUnknownStocks} 筆`,
  );
  return { processed, skippedUnknownStocks, skippedNonStock, isNonTradingDay: false, actualDate: isoDate };
}

// 抓取指定日期的 TWSE + TPEx 個股信用交易餘額寫入 MarginTrading
// 兩端點皆支援歷史日期查詢；循序 await，前者 throw 就整支 throw（pipeline 端用 try/catch 包成非關鍵路徑）
export async function fillOneDayMargin(date: string): Promise<FillMarginResult> {
  const stocks = await prisma.stock.findMany({
    where: { securityType: { in: [SecurityType.stock, SecurityType.preferred] } },
    select: { code: true },
  });
  const existingCodes = new Set(stocks.map((s) => s.code));

  const twse = await fillTwseSide(date, existingCodes);
  const tpex = await fillTpexSide(date, existingCodes);

  return { date, twse, tpex };
}

function localToday(): string {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeDate(raw: string): string {
  const normalized = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`--date 格式錯誤，應為 YYYY-MM-DD 或 YYYYMMDD，收到: ${raw}`);
  }
  return normalized;
}

function parseArgs(): { date?: string; backfill?: number } {
  const dateArg = process.argv.find((a) => a.startsWith("--date="));
  const backfillArg = process.argv.find((a) => a.startsWith("--backfill="));

  if (dateArg && backfillArg) {
    throw new Error("--date 與 --backfill 不能同時使用");
  }

  if (backfillArg) {
    const n = parseInt(backfillArg.slice("--backfill=".length), 10);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--backfill 應為正整數，收到: ${backfillArg.slice("--backfill=".length)}`);
    }
    return { backfill: n };
  }

  if (dateArg) {
    return { date: normalizeDate(dateArg.slice("--date=".length)) };
  }

  return { date: localToday() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 從今天往回逐個日曆日抓，非交易日不計數，實得約 N 個交易日
async function runBackfill(n: number): Promise<void> {
  const collected: string[] = [];
  const start = new Date(localToday() + "T00:00:00");
  for (let i = 0; collected.length < n && i < n + 6; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const result = await fillOneDayMargin(iso);
    const isTradingDay = !result.twse.isNonTradingDay || !result.tpex.isNonTradingDay;
    if (isTradingDay) collected.push(iso);
    await sleep(1500);
  }
  console.log(`\n回補完成：實得 ${collected.length} 個交易日（${collected.join(", ")}）`);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  const { date, backfill } = parseArgs();
  (backfill !== undefined ? runBackfill(backfill) : fillOneDayMargin(date!).then(() => {}))
    .catch((err) => {
      console.error("融資融券抓取失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
