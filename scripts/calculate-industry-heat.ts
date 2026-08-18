import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

interface HeatResult {
  date: string;
  sectorCount: number;
  isNonTradingDay: boolean;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// 依指定日期的 DailyQuote 計算各產業等權熱度並寫入 IndustryHeatSnapshot
export async function calculateOneDayHeat(date: Date): Promise<HeatResult> {
  const quotes = await prisma.dailyQuote.findMany({
    where: { date },
    select: {
      close: true,
      change: true,
      volume: true,
      stock: { select: { sectorId: true } },
    },
  });

  if (quotes.length === 0) {
    console.log(`${toIsoDate(date)} 無任何 DailyQuote 資料（非交易日？），跳過`);
    return { date: toIsoDate(date), sectorCount: 0, isNonTradingDay: true };
  }

  // 分組累計：排除無產業別、當日無成交、無法算漲跌幅（前收 <= 0）的股票
  const groups = new Map<number, { sum: number; rising: number; falling: number; total: number }>();
  for (const q of quotes) {
    const sectorId = q.stock.sectorId;
    if (sectorId === null) continue;
    if (q.volume === 0n) continue;

    const prevClose = q.close - q.change;
    if (prevClose <= 0) continue;
    const changePercent = (q.change / prevClose) * 100;

    let group = groups.get(sectorId);
    if (!group) {
      group = { sum: 0, rising: 0, falling: 0, total: 0 };
      groups.set(sectorId, group);
    }
    group.sum += changePercent;
    group.total++;
    if (changePercent > 0) group.rising++;
    else if (changePercent < 0) group.falling++;
  }

  const ranked = [...groups.entries()]
    .map(([sectorId, g]) => ({
      sectorId,
      avgChangePercent: g.sum / g.total,
      risingCount: g.rising,
      fallingCount: g.falling,
      totalCount: g.total,
    }))
    .sort((a, b) => b.avgChangePercent - a.avgChangePercent);

  for (const [index, row] of ranked.entries()) {
    const rank = index + 1;
    const data = {
      avgChangePercent: row.avgChangePercent.toFixed(4),
      risingCount: row.risingCount,
      fallingCount: row.fallingCount,
      totalCount: row.totalCount,
      rank,
    };
    await prisma.industryHeatSnapshot.upsert({
      where: { sectorId_date: { sectorId: row.sectorId, date } },
      update: data,
      create: { sectorId: row.sectorId, date, ...data },
    });
  }

  console.log(`${toIsoDate(date)} 產業熱度計算完成：共 ${ranked.length} 個產業`);
  return { date: toIsoDate(date), sectorCount: ranked.length, isNonTradingDay: false };
}

// 取最近 N 個「有 DailyQuote 資料的日子」（由新到舊）
async function recentTradingDates(count: number): Promise<Date[]> {
  const rows = await prisma.dailyQuote.findMany({
    distinct: ["date"],
    orderBy: { date: "desc" },
    take: count,
    select: { date: true },
  });
  return rows.map((r) => r.date);
}

async function printLatestTop5(date: Date) {
  const top = await prisma.industryHeatSnapshot.findMany({
    where: { date },
    orderBy: { rank: "asc" },
    take: 5,
    include: { sector: { select: { name: true } } },
  });
  console.log(`\n${toIsoDate(date)} 產業熱度排名前 5：`);
  for (const row of top) {
    console.log(
      `  ${row.rank}. ${row.sector.name}：平均 ${row.avgChangePercent}%（漲 ${row.risingCount} / 跌 ${row.fallingCount} / 共 ${row.totalCount} 檔）`,
    );
  }
}

function parseArgs(): { backfill: number } {
  const idx = process.argv.indexOf("--backfill");
  if (idx === -1) return { backfill: 1 };
  const raw = process.argv[idx + 1];
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--backfill 需要正整數，收到: ${raw}`);
  }
  return { backfill: n };
}

async function main() {
  const { backfill } = parseArgs();
  const dates = await recentTradingDates(backfill);
  if (dates.length === 0) {
    console.log("DailyQuote 沒有任何資料，無法計算");
    return;
  }

  // 由舊到新逐日計算
  for (const date of [...dates].reverse()) {
    await calculateOneDayHeat(date);
  }

  const latest = dates[0];
  if (latest) await printLatestTop5(latest);
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main()
    .catch((err) => {
      console.error("產業熱度計算失敗:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
