"use server";

import { prisma } from "../prisma";

export interface DbHealth {
  today: string; // 伺服器今日 YYYY-MM-DD（Asia/Taipei）
  latestQuoteDate: string | null;
  quoteFresh: boolean; // latestQuoteDate === today
  stockCount: number; // securityType = "stock" 的檔數（分母）
  coverage: {
    quote: { count: number; pct: number };
    institutional: { count: number; pct: number };
    technical: { count: number; pct: number };
  };
}

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(
    new Date(),
  );
}

function pct(count: number, denom: number): number {
  return denom > 0 ? Math.round((count / denom) * 1000) / 10 : 0;
}

export async function getDbHealth(): Promise<DbHealth> {
  const today = taipeiToday();

  const [latestQuote, stockCount] = await Promise.all([
    prisma.dailyQuote.findFirst({
      where: { stock: { securityType: "stock" } },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    prisma.stock.count({ where: { securityType: "stock" } }),
  ]);

  const latestQuoteDate = latestQuote?.date.toISOString().slice(0, 10) ?? null;
  const quoteFresh = latestQuoteDate === today;

  // 覆蓋率基準日：DB 最新交易日（非交易日 today 無資料會全 0）。
  const refDate = latestQuoteDate
    ? new Date(latestQuoteDate + "T00:00:00.000Z")
    : null;

  let quoteCount = 0;
  let institutionalCount = 0;
  let technicalCount = 0;
  if (refDate) {
    [quoteCount, institutionalCount, technicalCount] = await Promise.all([
      prisma.dailyQuote.count({
        where: { date: refDate, stock: { securityType: "stock" } },
      }),
      prisma.institutionalTrading.count({ where: { date: refDate } }),
      prisma.technicalIndicator.count({ where: { date: refDate } }),
    ]);
  }

  return {
    today,
    latestQuoteDate,
    quoteFresh,
    stockCount,
    coverage: {
      quote: { count: quoteCount, pct: pct(quoteCount, stockCount) },
      institutional: {
        count: institutionalCount,
        pct: pct(institutionalCount, stockCount),
      },
      technical: {
        count: technicalCount,
        pct: pct(technicalCount, stockCount),
      },
    },
  };
}
