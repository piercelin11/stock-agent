import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Market, SecurityType } from "../generated/prisma/client.js";
import { fetchJson } from "./http.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// 三大法人買賣超日報，支援任意歷史日期查詢
const TWSE_URL = "https://www.twse.com.tw/rwd/zh/fund/T86";
// TPEx 三大法人買賣日報，不支援日期參數，永遠回傳「目前最新一天」
const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading";

interface TwseT86Response {
  stat: string;
  date?: string;
  data?: string[][];
}

interface TpexInstitutionalRow {
  Date: string;
  SecuritiesCompanyCode: string;
  CompanyName: string;
  "ForeignInvestorsIncludeMainlandAreaInvestors-Difference": string;
  "ForeignDealers-Difference": string;
  "SecuritiesInvestmentTrustCompanies-Difference": string;
  "Dealers-Difference": string;
}

interface InstitutionalRow {
  code: string;
  name: string;
  foreignNetBuy: number;
  investmentTrustNetBuy: number;
  dealerNetBuy: number;
}

interface FillSideResult {
  processed: number;
  skippedUnknownStocks: number;
  skippedNonStock: number;
  isNonTradingDay: boolean;
  actualDate: string | null; // TPEx 無法指定日期，回傳的資料實際日期可能不是請求日期
  isStaleDate?: boolean; // TPEx 專用：回傳日期與預期日期不符，已跳過寫入
}

export interface FillInstitutionalResult {
  date: string;
  twse: FillSideResult;
  tpex: FillSideResult;
}

// "1,234,567" -> 1234567；缺值/非數字 -> 0（法人買賣超沒有資料通常代表當天無買賣，視為 0 較合理）
function parseNumber(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const num = parseFloat(raw.replace(/,/g, "").trim());
  return Number.isFinite(num) ? num : 0;
}

// TPEx 的 Date 欄位是民國年，例如 "1150821" -> "2026-08-21"（與 fill-daily-quotes.ts 的 rocDateToIso 邏輯相同）
function rocDateToIso(rocDate: string): string {
  const rocYear = parseInt(rocDate.slice(0, 3), 10);
  const month = rocDate.slice(3, 5);
  const day = rocDate.slice(5, 7);
  const year = rocYear + 1911;
  return `${year}-${month}-${day}`;
}

// 沿用 fill-daily-quotes.ts 的分類規則，這裡只保留一般股票（stock），ETF/權證/可轉債等不寫入籌碼表
function toSecurityType(code: string, name: string): SecurityType {
  if (code.startsWith("00")) return SecurityType.etf;
  if (/^.{4}[A-Za-z]$/.test(code)) return SecurityType.preferred;
  if (/^\d{6}$/.test(code) || name.includes("購") || name.includes("售")) return SecurityType.warrant;
  if (/^\d{5}$/.test(code)) return SecurityType.bond;
  if (/^\d{4}$/.test(code)) return SecurityType.stock;
  return SecurityType.other;
}

async function fetchTwseInstitutional(isoDate: string): Promise<InstitutionalRow[] | null> {
  const url = new URL(TWSE_URL);
  url.searchParams.set("date", isoDate.replaceAll("-", ""));
  url.searchParams.set("selectType", "ALL");
  url.searchParams.set("response", "json");

  const body = await fetchJson<TwseT86Response>(url.toString());
  if (body.stat !== "OK" || !body.data) {
    // 非交易日的 stat 是「很抱歉，沒有符合條件的資料!」
    return null;
  }

  const expected = isoDate.replaceAll("-", "");
  if (body.date !== expected) {
    throw new Error(`TWSE T86 回傳日期 ${body.date} 與請求日期 ${expected} 不符`);
  }

  // 欄位順序：[證券代號, 證券名稱, 外陸資買進, 外陸資賣出, 外陸資買賣超, 外資自營商買進, 外資自營商賣出,
  //           外資自營商買賣超, 投信買進, 投信賣出, 投信買賣超, 自營商買賣超(合計), ...]
  return body.data.map((row) => ({
    code: String(row[0]).trim(),
    name: String(row[1]).trim(),
    foreignNetBuy: parseNumber(row[4]) + parseNumber(row[7]),
    investmentTrustNetBuy: parseNumber(row[10]),
    dealerNetBuy: parseNumber(row[11]),
  }));
}

// TPEx OpenAPI 不支援指定日期查詢，只能拿到目前的最新一天
async function fetchTpexInstitutional(): Promise<{ date: string; rows: InstitutionalRow[] } | null> {
  const body = await fetchJson<TpexInstitutionalRow[]>(TPEX_URL);
  const firstRow = body[0];
  if (!Array.isArray(body) || firstRow === undefined) {
    return null;
  }

  const date = rocDateToIso(firstRow.Date);
  // 欄位名稱本身不規則（大小寫、空格不一致，如 "Dealers -TotalSell"），
  // 因此只信賴現成算好的 *-Difference 欄位，不自己重算 buy - sell
  const rows = body.map((row) => ({
    code: row.SecuritiesCompanyCode.trim(),
    name: row.CompanyName.trim(),
    foreignNetBuy:
      parseNumber(row["ForeignInvestorsIncludeMainlandAreaInvestors-Difference"]) +
      parseNumber(row["ForeignDealers-Difference"]),
    investmentTrustNetBuy: parseNumber(row["SecuritiesInvestmentTrustCompanies-Difference"]),
    dealerNetBuy: parseNumber(row["Dealers-Difference"]),
  }));

  return { date, rows };
}

async function writeInstitutionalRows(
  rows: InstitutionalRow[],
  dateObj: Date,
  source: Market,
  existingCodes: Set<string>,
): Promise<{ processed: number; skippedUnknownStocks: number; skippedNonStock: number }> {
  let processed = 0;
  let skippedUnknownStocks = 0;
  let skippedNonStock = 0;

  for (const row of rows) {
    if (toSecurityType(row.code, row.name) !== SecurityType.stock) {
      skippedNonStock++;
      continue; // ETF/權證/可轉債等不寫入籌碼表
    }

    // 只寫入 Stock 表已存在的代號：籌碼資料不該是新股票的來源，股票清單由報價流程（fill-daily-quotes.ts）建立
    if (!existingCodes.has(row.code)) {
      skippedUnknownStocks++;
      continue;
    }

    const data = {
      foreignNetBuy: BigInt(Math.trunc(row.foreignNetBuy)),
      investmentTrustNetBuy: BigInt(Math.trunc(row.investmentTrustNetBuy)),
      dealerNetBuy: BigInt(Math.trunc(row.dealerNetBuy)),
      source,
    };
    await prisma.institutionalTrading.upsert({
      where: { stockCode_date: { stockCode: row.code, date: dateObj } },
      update: data,
      create: { stockCode: row.code, date: dateObj, ...data },
    });
    processed++;
  }

  return { processed, skippedUnknownStocks, skippedNonStock };
}

async function fillTwseSide(isoDate: string, existingCodes: Set<string>): Promise<FillSideResult> {
  const rows = await fetchTwseInstitutional(isoDate);

  if (!rows) {
    console.log(`${isoDate} TWSE 三大法人籌碼非交易日或無資料，跳過`);
    return { processed: 0, skippedUnknownStocks: 0, skippedNonStock: 0, isNonTradingDay: true, actualDate: null };
  }

  const dateObj = new Date(isoDate);
  const { processed, skippedUnknownStocks, skippedNonStock } = await writeInstitutionalRows(
    rows,
    dateObj,
    Market.TWSE,
    existingCodes,
  );
  console.log(
    `${isoDate} TWSE 三大法人籌碼寫入完成：共 ${processed} 筆，跳過非一般股票 ${skippedNonStock} 筆，跳過 Stock 表沒有的代號 ${skippedUnknownStocks} 筆`,
  );
  return { processed, skippedUnknownStocks, skippedNonStock, isNonTradingDay: false, actualDate: isoDate };
}

async function fillTpexSide(expectedIsoDate: string, existingCodes: Set<string>): Promise<FillSideResult> {
  const result = await fetchTpexInstitutional();

  if (!result) {
    console.log("TPEx 三大法人籌碼今日無資料，跳過");
    return { processed: 0, skippedUnknownStocks: 0, skippedNonStock: 0, isNonTradingDay: true, actualDate: null };
  }

  const { date: actualDate, rows } = result;
  if (actualDate !== expectedIsoDate) {
    // 不是錯誤：TPEx 無法指定日期，可能非交易日或資料尚未更新，跳過寫入（避免把舊資料當成當日資料覆蓋進去）
    console.warn(
      `⚠ TPEx 三大法人籌碼回傳日期為 ${actualDate}，與預期日期 ${expectedIsoDate} 不同（可能非交易日或資料尚未更新），跳過寫入`,
    );
    return { processed: 0, skippedUnknownStocks: 0, skippedNonStock: 0, isNonTradingDay: false, actualDate, isStaleDate: true };
  }

  const dateObj = new Date(actualDate);
  const { processed, skippedUnknownStocks, skippedNonStock } = await writeInstitutionalRows(
    rows,
    dateObj,
    Market.TPEx,
    existingCodes,
  );
  console.log(
    `${actualDate} TPEx 三大法人籌碼寫入完成：共 ${processed} 筆，跳過非一般股票 ${skippedNonStock} 筆，跳過 Stock 表沒有的代號 ${skippedUnknownStocks} 筆`,
  );
  return { processed, skippedUnknownStocks, skippedNonStock, isNonTradingDay: false, actualDate };
}

// 抓取指定日期的 TWSE + TPEx 三大法人買賣超寫入 InstitutionalTrading
// 注意：TPEx 端點無法指定歷史日期，只能拿到「目前最新一天」，實際寫入日期以 API 回傳為準（見 FillSideResult.actualDate）
export async function fillOneDayInstitutional(date: string): Promise<FillInstitutionalResult> {
  const stocks = await prisma.stock.findMany({
    where: { securityType: SecurityType.stock },
    select: { code: true },
  });
  const existingCodes = new Set(stocks.map((s) => s.code));

  const twse = await fillTwseSide(date, existingCodes);
  const tpex = await fillTpexSide(date, existingCodes);

  return { date, twse, tpex };
}

function parseArgs(): { date: string } {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  if (!arg) {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    return { date: `${y}-${m}-${d}` };
  }
  const raw = arg.slice("--date=".length);
  const normalized = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`--date 格式錯誤，應為 YYYY-MM-DD 或 YYYYMMDD，收到: ${raw}`);
  }
  return { date: normalized };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  const { date } = parseArgs();
  fillOneDayInstitutional(date)
    .catch((err) => {
      console.error("三大法人籌碼抓取失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
