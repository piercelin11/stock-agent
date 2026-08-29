"use server";

import { prisma } from "../prisma";

export async function getDbHealth() {
  const [quoteCount, latestQuote, stockCount] = await Promise.all([
    prisma.dailyQuote.count(),
    prisma.dailyQuote.findFirst({
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    prisma.stock.count(),
  ]);
  return {
    quoteCount,
    stockCount,
    latestQuoteDate: latestQuote?.date.toISOString().slice(0, 10) ?? null,
  };
}
