import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Market } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// MOPS 公開資料：上市/上櫃公司基本資料，最後一欄「已發行普通股數或TDR原股發行股數」直接就是股數
// 注意：絕對不要用「實收資本額 ÷ 面額」推算，面額不是每家都 10 元（例：國巨 2327 面額 2.5 元）
const SOURCES: { market: Market; url: string }[] = [
  { market: Market.TWSE, url: "https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv" },
  { market: Market.TPEx, url: "https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv" },
];

const CODE_COLUMN = "公司代號";
const SHARES_COLUMN = "已發行普通股數或TDR原股發行股數";

// 最小 CSV parser：處理引號包覆、引號內的逗號/換行、"" 跳脫
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

async function updateOneMarket(market: Market, url: string) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    throw new Error(`下載 ${url} 失敗: ${res.status} ${res.statusText}`);
  }
  const text = (await res.text()).replace(/^﻿/, ""); // 去 BOM

  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error(`${market} CSV 為空`);

  const codeIdx = header.indexOf(CODE_COLUMN);
  const sharesIdx = header.indexOf(SHARES_COLUMN);
  if (codeIdx === -1 || sharesIdx === -1) {
    throw new Error(`${market} CSV 找不到必要欄位（${CODE_COLUMN} / ${SHARES_COLUMN}），實際欄位: ${header.join(", ")}`);
  }

  const now = new Date();
  let updated = 0;
  let skippedUnknown = 0;
  const csvCodes = new Set<string>();

  for (const row of rows.slice(1)) {
    const code = row[codeIdx]?.trim();
    const sharesRaw = row[sharesIdx]?.trim().replace(/,/g, "");
    if (!code || !sharesRaw || !/^\d+$/.test(sharesRaw)) continue;
    csvCodes.add(code);

    const result = await prisma.stock.updateMany({
      where: { code },
      data: { sharesOutstanding: BigInt(sharesRaw), sharesOutstandingUpdatedAt: now },
    });
    if (result.count > 0) {
      updated++;
    } else {
      skippedUnknown++; // CSV 有但 Stock 表沒有（可能是特別股或未入庫標的）
    }
  }

  // Stock 表有但 CSV 沒有的普通股：log warning，不動原值
  const dbStocks = await prisma.stock.findMany({
    where: { market, securityType: "stock" },
    select: { code: true },
  });
  const missingInCsv = dbStocks.filter((s) => !csvCodes.has(s.code));

  console.log(
    `${market} 股本更新完成：更新 ${updated} 檔，CSV 有但 Stock 表沒有 ${skippedUnknown} 檔（跳過）`,
  );
  if (missingInCsv.length > 0) {
    console.warn(
      `⚠ ${market} Stock 表有 ${missingInCsv.length} 檔普通股不在 CSV 中（不動原值），例如: ${missingInCsv.slice(0, 10).map((s) => s.code).join(", ")}${missingInCsv.length > 10 ? " ..." : ""}`,
    );
  }
}

async function main() {
  for (const { market, url } of SOURCES) {
    await updateOneMarket(market, url);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main()
    .catch((err) => {
      console.error("股本更新失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
