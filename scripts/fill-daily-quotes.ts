import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, SecurityType, Market } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const MI_INDEX_URL = "https://www.twse.com.tw/exchangeReport/MI_INDEX";
const DAILY_QUOTES_TABLE_INDEX = 8; // "每日收盤行情(全部)"
const TPEX_QUOTES_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

interface MiIndexResponse {
  stat: string;
  tables?: { title: string | null; fields: string[] | null; data: string[][] }[];
}

interface TpexRow {
  Date: string;
  SecuritiesCompanyCode: string;
  CompanyName: string;
  Close: string;
  Change: string;
  Open: string;
  High: string;
  Low: string;
  TradingShares: string;
}

interface ParsedRow {
  code: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  change: number;
}

interface FillResult {
  date: string | null;
  processed: number;
  newStocks: number;
  skippedDerivatives: number;
  isNonTradingDay: boolean;
  isStaleDate?: boolean; // TPEx 專用：回傳日期與預期的「今天」不符（無法指定歷史日期造成），此時已跳過寫入
}

function toApiDate(date: string): string {
  return date.replaceAll("-", "");
}

// TPEx 的 Date 欄位是民國年，例如 "1150817" -> "2026-08-17"
function rocDateToIso(rocDate: string): string {
  const rocYear = parseInt(rocDate.slice(0, 3), 10);
  const month = rocDate.slice(3, 5);
  const day = rocDate.slice(5, 7);
  const year = rocYear + 1911;
  return `${year}-${month}-${day}`;
}

function toSecurityType(code: string, name: string): SecurityType {
  if (code.startsWith("00")) return SecurityType.etf;
  if (/^.{4}[A-Za-z]$/.test(code)) return SecurityType.preferred;
  if (/^\d{6}$/.test(code) || name.includes("購") || name.includes("售")) return SecurityType.warrant;
  if (/^\d{5}$/.test(code)) return SecurityType.bond;
  if (/^\d{4}$/.test(code)) return SecurityType.stock;
  return SecurityType.other;
}

function parseNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, "").trim());
}

function parseChangeSign(raw: string): 1 | -1 | 0 {
  if (raw.includes("color:red")) return 1;
  if (raw.includes("color:green")) return -1;
  return 0;
}

function parseMiIndexRow(row: string[]): ParsedRow | null {
  const [code, name, tradeVolume, , , open, high, low, close, changeSign, changeAmount] = row;

  if (
    code === undefined ||
    name === undefined ||
    tradeVolume === undefined ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined ||
    changeSign === undefined ||
    changeAmount === undefined
  ) {
    return null;
  }

  const closeNum = parseNumber(close);
  const openNum = parseNumber(open);
  const highNum = parseNumber(high);
  const lowNum = parseNumber(low);
  const volumeNum = parseNumber(tradeVolume);
  const changeAmountNum = parseNumber(changeAmount);

  if (![closeNum, openNum, highNum, lowNum, volumeNum].every(Number.isFinite)) {
    return null;
  }

  const sign = parseChangeSign(changeSign);
  const change = Number.isFinite(changeAmountNum) ? changeAmountNum * sign : 0;

  return {
    code: code.trim(),
    name: name.trim(),
    open: openNum,
    high: highNum,
    low: lowNum,
    close: closeNum,
    volume: BigInt(Math.trunc(volumeNum)),
    change,
  };
}

function parseTpexRow(row: TpexRow): ParsedRow | null {
  const closeNum = parseNumber(row.Close);
  const openNum = parseNumber(row.Open);
  const highNum = parseNumber(row.High);
  const lowNum = parseNumber(row.Low);
  const volumeNum = parseNumber(row.TradingShares);
  const changeNum = parseNumber(row.Change);

  if (![closeNum, openNum, highNum, lowNum, volumeNum].every(Number.isFinite)) {
    return null;
  }

  return {
    code: row.SecuritiesCompanyCode.trim(),
    name: row.CompanyName.trim(),
    open: openNum,
    high: highNum,
    low: lowNum,
    close: closeNum,
    volume: BigInt(Math.trunc(volumeNum)),
    change: Number.isFinite(changeNum) ? changeNum : 0,
  };
}

async function fetchTwseQuotes(date: string): Promise<ParsedRow[] | null> {
  const url = new URL(MI_INDEX_URL);
  url.searchParams.set("response", "json");
  url.searchParams.set("date", toApiDate(date));
  url.searchParams.set("type", "ALL");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    throw new Error(`MI_INDEX API 請求失敗 (${date}): ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as MiIndexResponse;
  if (!body.tables) {
    // 非交易日或無資料時，回應不含 tables 欄位
    return null;
  }

  const table = body.tables[DAILY_QUOTES_TABLE_INDEX];
  if (!table || !table.data || table.data.length === 0) {
    return null;
  }

  return table.data.map(parseMiIndexRow).filter((r): r is ParsedRow => r !== null);
}

// TPEx OpenAPI 不支援指定日期查詢，只能拿到目前的最新一天，跟 top20-gainers.js 同源
async function fetchTpexQuotes(): Promise<{ date: string; rows: ParsedRow[] } | null> {
  const res = await fetch(TPEX_QUOTES_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    throw new Error(`TPEx OpenAPI 請求失敗: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as TpexRow[];
  const firstRow = body[0];
  if (!Array.isArray(body) || firstRow === undefined) {
    return null;
  }

  const date = rocDateToIso(firstRow.Date);
  const rows = body.map(parseTpexRow).filter((r): r is ParsedRow => r !== null);
  return { date, rows };
}

async function writeRows(rows: ParsedRow[], date: string, market: Market): Promise<{ processed: number; newStocks: number; skippedDerivatives: number }> {
  const dateObj = new Date(date);
  let processed = 0;
  let newStocks = 0;
  let skippedDerivatives = 0;

  for (const row of rows) {
    const securityType = toSecurityType(row.code, row.name);

    if (securityType === SecurityType.warrant || securityType === SecurityType.bond) {
      skippedDerivatives++;
      continue; // 不建立 Stock、不寫入 DailyQuote，處理下一筆
    }

    const existingStock = await prisma.stock.findUnique({
      where: { code: row.code },
      select: { code: true },
    });

    if (!existingStock) {
      await prisma.stock.create({
        data: {
          code: row.code,
          name: row.name,
          market,
          securityType,
        },
      });
      newStocks++;
    }

    await prisma.dailyQuote.upsert({
      where: { stockCode_date: { stockCode: row.code, date: dateObj } },
      update: {
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        change: row.change,
        source: market,
      },
      create: {
        stockCode: row.code,
        date: dateObj,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        change: row.change,
        source: market,
      },
    });
    processed++;
  }

  return { processed, newStocks, skippedDerivatives };
}

// 補齊「指定單一天」的上市（TWSE）報價，用 MI_INDEX，支援任意歷史日期
export async function fillOneDayTwse(date: string): Promise<FillResult> {
  const rows = await fetchTwseQuotes(date);

  if (!rows) {
    console.log(`${date} TWSE 非交易日或無資料，跳過`);
    return { date, processed: 0, newStocks: 0, skippedDerivatives: 0, isNonTradingDay: true };
  }

  const { processed, newStocks, skippedDerivatives } = await writeRows(rows, date, Market.TWSE);

  console.log(
    `${date} TWSE 處理完成：共 ${processed} 筆（一般股票/ETF/特別股/其他），跳過權證/可轉債 ${skippedDerivatives} 筆，新增 ${newStocks} 支之前沒見過的 Stock`,
  );
  return { date, processed, newStocks, skippedDerivatives, isNonTradingDay: false };
}

// 補齊「今天」的上櫃（TPEx）報價，TPEx OpenAPI 不支援指定歷史日期，只能拿到目前最新一天。
// expectedIsoDate 預設為系統當天日期，若 API 回傳的日期與預期不符（非交易日或資料尚未更新），
// 跳過寫入以避免把舊資料當成當日資料覆蓋進去，並回傳 isStaleDate 供呼叫端統計警告。
export async function fillTodayTpex(expectedIsoDate?: string): Promise<FillResult> {
  const expected = expectedIsoDate ?? new Date().toISOString().slice(0, 10);
  const result = await fetchTpexQuotes();

  if (!result) {
    console.log("TPEx 今日無資料，跳過");
    return { date: null, processed: 0, newStocks: 0, skippedDerivatives: 0, isNonTradingDay: true };
  }

  const { date, rows } = result;
  if (date !== expected) {
    console.warn(
      `⚠ TPEx 報價回傳日期為 ${date}，與預期日期 ${expected} 不同（可能非交易日或資料尚未更新），跳過寫入`,
    );
    return { date, processed: 0, newStocks: 0, skippedDerivatives: 0, isNonTradingDay: false, isStaleDate: true };
  }

  const { processed, newStocks, skippedDerivatives } = await writeRows(rows, date, Market.TPEx);

  console.log(
    `${date} TPEx 處理完成：共 ${processed} 筆（一般股票/ETF/特別股/其他），跳過權證/可轉債 ${skippedDerivatives} 筆，新增 ${newStocks} 支之前沒見過的 Stock`,
  );
  return { date, processed, newStocks, skippedDerivatives, isNonTradingDay: false, isStaleDate: false };
}

function parseArgs(): { date: string } {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  if (!arg) {
    throw new Error("缺少必要參數 --date=YYYY-MM-DD");
  }
  const date = arg.slice("--date=".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date 格式錯誤，應為 YYYY-MM-DD，收到: ${date}`);
  }
  return { date };
}

async function main() {
  const { date } = parseArgs();
  await fillOneDayTwse(date);
  await fillTodayTpex();
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main()
    .catch((err) => {
      console.error("補齊資料失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
