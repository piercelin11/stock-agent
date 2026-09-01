import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

// 維護 Stock.delistedAt（下市標記）。手動低頻執行（月跑一次等級），不進 daily-pipeline——
// 復牌股的行情入庫不依賴這個 flag（fill-daily-quotes 是「API 回什麼就 upsert 什麼」），
// flag 的消費者只有 getDbHealth 覆蓋率分母與 FinMind backfill 跳過名單，遲鈍幾週無害。
//
// 規則（門檻 60 個日曆日，不會誤傷減資/分割型停牌，那類約兩週）：
// - 標記：securityType=stock 且（最後 DailyQuote 距 DB 全市場最新交易日 > 60 天，或從無行情）
//   → delistedAt = 最後行情日；從無行情者 = 2020-01-01（語意：回補起點前已下市）。
// - 復活清除：delistedAt 非 null 但最後行情落在 60 天內 → 清回 null（復牌、誤標都靠這條自癒）。
//
// pnpm tsx scripts/backfill/mark-delisted.ts

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const STALE_DAYS = 60;
const NEVER_QUOTED_SENTINEL = new Date("2020-01-01");

async function main() {
  const latestQuote = await prisma.dailyQuote.aggregate({ _max: { date: true } });
  const latestTradingDay = latestQuote._max.date;
  if (!latestTradingDay) throw new Error("DailyQuote 是空的，無法判定最新交易日");
  const cutoff = new Date(latestTradingDay.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);
  console.log(
    `DB 最新交易日: ${latestTradingDay.toISOString().slice(0, 10)}，門檻: 最後行情早於 ${cutoff.toISOString().slice(0, 10)}（${STALE_DAYS} 日曆日）`,
  );

  const stocks = await prisma.stock.findMany({
    where: { securityType: "stock" },
    select: { code: true, name: true, delistedAt: true },
  });

  // 每檔最後行情日（一次 groupBy，避免逐檔 findFirst）
  const lastDates = await prisma.dailyQuote.groupBy({
    by: ["stockCode"],
    _max: { date: true },
  });
  const lastByCode = new Map(lastDates.map((r) => [r.stockCode, r._max.date]));

  const marked: string[] = [];
  const cleared: string[] = [];

  for (const s of stocks) {
    const last = lastByCode.get(s.code) ?? null;
    const isStale = last === null || last < cutoff;

    if (isStale && s.delistedAt === null) {
      const delistedAt = last ?? NEVER_QUOTED_SENTINEL;
      await prisma.stock.update({ where: { code: s.code }, data: { delistedAt } });
      marked.push(`${s.code} ${s.name}（最後行情 ${last ? last.toISOString().slice(0, 10) : "無"}）`);
    } else if (!isStale && s.delistedAt !== null) {
      await prisma.stock.update({ where: { code: s.code }, data: { delistedAt: null } });
      cleared.push(`${s.code} ${s.name}（最後行情 ${last!.toISOString().slice(0, 10)}，復活）`);
    }
  }

  console.log(`\n=== 本次標記下市 ${marked.length} 檔 ===`);
  for (const line of marked) console.log(line);
  console.log(`\n=== 本次復活清除 ${cleared.length} 檔 ===`);
  for (const line of cleared) console.log(line);

  const totalDelisted = await prisma.stock.count({
    where: { securityType: "stock", delistedAt: { not: null } },
  });
  const totalActive = await prisma.stock.count({
    where: { securityType: "stock", delistedAt: null },
  });
  console.log(`\n目前狀態：存續 ${totalActive} 檔 / 已下市 ${totalDelisted} 檔`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
