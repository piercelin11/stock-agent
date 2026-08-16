import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, SecurityType, Market } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo";

interface FinMindStockInfo {
  industry_category: string;
  stock_id: string;
  stock_name: string;
  type: string;
  date: string;
}

function toMarket(type: string): Market | null {
  if (type === "twse") return Market.TWSE;
  if (type === "tpex") return Market.TPEx;
  return null; // 例如 "emerging"（興櫃），目前 Market enum 未涵蓋，直接跳過
}

function toSecurityType(code: string): SecurityType {
  if (code.startsWith("00")) return SecurityType.etf;
  if (/^.{4}[A-Za-z]$/.test(code)) return SecurityType.preferred;
  if (/^\d{4}$/.test(code)) return SecurityType.stock;
  return SecurityType.other;
}

async function main() {
  const res = await fetch(FINMIND_URL);
  if (!res.ok) {
    throw new Error(`FinMind API 請求失敗: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data: FinMindStockInfo[] };
  const rows = body.data;

  const sectorIdCache = new Map<string, number>();
  const securityTypeCounts: Record<string, number> = {};
  let processed = 0;
  let skipped = 0;

  for (const row of rows) {
    const market = toMarket(row.type);
    if (!market) {
      skipped++;
      continue;
    }

    let sectorId = sectorIdCache.get(row.industry_category);
    if (sectorId === undefined) {
      const sector = await prisma.sector.upsert({
        where: { name: row.industry_category },
        update: {},
        create: { name: row.industry_category },
      });
      sectorId = sector.id;
      sectorIdCache.set(row.industry_category, sectorId);
    }

    const securityType = toSecurityType(row.stock_id);

    await prisma.stock.upsert({
      where: { code: row.stock_id },
      update: {
        name: row.stock_name,
        market,
        securityType,
        sectorId,
      },
      create: {
        code: row.stock_id,
        name: row.stock_name,
        market,
        securityType,
        sectorId,
      },
    });

    securityTypeCounts[securityType] = (securityTypeCounts[securityType] ?? 0) + 1;
    processed++;

    if (processed % 500 === 0) {
      console.log(`已處理 ${processed}/${rows.length} 筆`);
    }
  }

  console.log(`\n完成。總筆數: ${rows.length}，寫入: ${processed}，跳過(非 twse/tpex): ${skipped}`);
  console.log("各 securityType 統計:", securityTypeCounts);
}

main()
  .catch((err) => {
    console.error("Seed 執行失敗:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
