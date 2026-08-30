"use server";

import { prisma } from "../prisma";
import { revalidatePath } from "next/cache";

export interface WatchlistRow {
  stockCode: string;
  name: string;
  addedAt: string;
  notes: string | null;
  source: string | null;
  isPurchased: boolean;
  buyPrice: number | null;
  buyDate: string | null;
  targetPrice: number | null;
  stopLossPrice: number | null;
  // 當日快照（三表各自最新一筆，日期可能不同步）
  quote: { date: string; close: number; change: number; volume: number } | null;
  indicator: {
    date: string;
    ma20: number | null;
    ma60: number | null;
    bollingerUpper: number | null;
    bollingerLower: number | null;
    rsi14: number | null;
    macdStatus: string | null;
  } | null;
  institutional: {
    date: string;
    foreignNetBuy: number | null;
    investmentTrustNetBuy: number | null;
    dealerNetBuy: number | null;
  } | null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function listWatchlist(): Promise<WatchlistRow[]> {
  const items = await prisma.watchlistItem.findMany({
    include: { stock: { select: { name: true } } },
    orderBy: { addedAt: "desc" },
  });

  const rows = await Promise.all(
    items.map(async (item): Promise<WatchlistRow> => {
      const [quote, indicator, institutional] = await Promise.all([
        prisma.dailyQuote.findFirst({
          where: { stockCode: item.stockCode },
          orderBy: { date: "desc" },
          select: { date: true, close: true, change: true, volume: true },
        }),
        prisma.technicalIndicator.findFirst({
          where: { stockCode: item.stockCode },
          orderBy: { date: "desc" },
          select: {
            date: true,
            ma20: true,
            ma60: true,
            bollingerUpper: true,
            bollingerLower: true,
            rsi14: true,
            macdStatus: true,
          },
        }),
        prisma.institutionalTrading.findFirst({
          where: { stockCode: item.stockCode },
          orderBy: { date: "desc" },
          select: {
            date: true,
            foreignNetBuy: true,
            investmentTrustNetBuy: true,
            dealerNetBuy: true,
          },
        }),
      ]);

      return {
        stockCode: item.stockCode,
        name: item.stock.name,
        addedAt: isoDate(item.addedAt),
        notes: item.notes,
        source: item.source,
        isPurchased: item.isPurchased,
        buyPrice: item.buyPrice === null ? null : item.buyPrice.toNumber(),
        buyDate: item.buyDate === null ? null : isoDate(item.buyDate),
        targetPrice:
          item.targetPrice === null ? null : item.targetPrice.toNumber(),
        stopLossPrice:
          item.stopLossPrice === null ? null : item.stopLossPrice.toNumber(),
        quote: quote
          ? {
              date: isoDate(quote.date),
              close: quote.close,
              change: quote.change,
              volume: Number(quote.volume),
            }
          : null,
        indicator: indicator
          ? {
              date: isoDate(indicator.date),
              ma20: indicator.ma20,
              ma60: indicator.ma60,
              bollingerUpper: indicator.bollingerUpper,
              bollingerLower: indicator.bollingerLower,
              rsi14: indicator.rsi14,
              macdStatus: indicator.macdStatus,
            }
          : null,
        institutional: institutional
          ? {
              date: isoDate(institutional.date),
              foreignNetBuy:
                institutional.foreignNetBuy === null
                  ? null
                  : Number(institutional.foreignNetBuy),
              investmentTrustNetBuy:
                institutional.investmentTrustNetBuy === null
                  ? null
                  : Number(institutional.investmentTrustNetBuy),
              dealerNetBuy:
                institutional.dealerNetBuy === null
                  ? null
                  : Number(institutional.dealerNetBuy),
            }
          : null,
      };
    }),
  );

  return rows;
}

export async function addToWatchlist(input: {
  codes: string[];
  source?: string; // "breakout" | "accumulation" | "manual"
}): Promise<{ added: number; skipped: number }> {
  const requested = [...new Set(input.codes)];
  if (requested.length === 0) return { added: 0, skipped: 0 };

  // 過濾掉不存在的 code，避免 FK violation
  const existing = await prisma.stock.findMany({
    where: { code: { in: requested } },
    select: { code: true },
  });
  const validCodes = existing.map((s) => s.code);

  const result = await prisma.watchlistItem.createMany({
    data: validCodes.map((code) => ({
      stockCode: code,
      ...(input.source ? { source: input.source } : {}),
    })),
    skipDuplicates: true,
  });

  revalidatePath("/watchlist");
  return {
    added: result.count,
    skipped: requested.length - result.count,
  };
}

export async function removeFromWatchlist(input: {
  code: string;
}): Promise<void> {
  await prisma.watchlistItem.delete({ where: { stockCode: input.code } });
  revalidatePath("/watchlist");
}

export async function updateWatchlistItem(input: {
  code: string;
  isPurchased?: boolean;
  buyPrice?: number | null;
  buyDate?: string | null;
  targetPrice?: number | null;
  stopLossPrice?: number | null;
  notes?: string | null;
}): Promise<void> {
  const data: Record<string, unknown> = {};
  if (input.isPurchased !== undefined) data["isPurchased"] = input.isPurchased;
  if (input.buyPrice !== undefined) data["buyPrice"] = input.buyPrice;
  if (input.buyDate !== undefined)
    data["buyDate"] = input.buyDate === null ? null : new Date(input.buyDate);
  if (input.targetPrice !== undefined) data["targetPrice"] = input.targetPrice;
  if (input.stopLossPrice !== undefined)
    data["stopLossPrice"] = input.stopLossPrice;
  if (input.notes !== undefined) data["notes"] = input.notes;

  if (Object.keys(data).length === 0) return;

  await prisma.watchlistItem.update({
    where: { stockCode: input.code },
    data,
  });
  revalidatePath("/watchlist");
}
