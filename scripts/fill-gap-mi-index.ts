import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, SecurityType, Market } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const MI_INDEX_URL = "https://www.twse.com.tw/exchangeReport/MI_INDEX";
const DAILY_QUOTES_TABLE_INDEX = 8; // "每日收盤行情(全部)"

interface MiIndexResponse {
  stat: string;
  tables?: { title: string | null; fields: string[] | null; data: string[][] }[];
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

function toApiDate(date: string): string {
  return date.replaceAll("-", "");
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
  return parseFloat(raw.replace(/,/g, ""));
}

function parseChangeSign(raw: string): 1 | -1 | 0 {
  if (raw.includes("color:red")) return 1;
  if (raw.includes("color:green")) return -1;
  return 0;
}

function parseRow(row: string[]): ParsedRow | null {
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

async function fetchDailyQuotes(date: string): Promise<ParsedRow[] | null> {
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

  return table.data.map(parseRow).filter((r): r is ParsedRow => r !== null);
}

export async function fillOneDay(date: string): Promise<{ processed: number; newStocks: number; skippedDerivatives: number; isNonTradingDay: boolean }> {
  const rows = await fetchDailyQuotes(date);

  if (!rows) {
    console.log(`${date} 非交易日或無資料，跳過`);
    return { processed: 0, newStocks: 0, skippedDerivatives: 0, isNonTradingDay: true };
  }

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
          market: Market.TWSE,
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
        source: Market.TWSE,
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
        source: Market.TWSE,
      },
    });
    processed++;
  }

  console.log(
    `${date} 處理完成：共 ${processed} 筆（一般股票/ETF/特別股/其他），跳過權證/可轉債 ${skippedDerivatives} 筆，新增 ${newStocks} 支之前沒見過的 Stock`,
  );
  return { processed, newStocks, skippedDerivatives, isNonTradingDay: false };
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
  await fillOneDay(date);
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
