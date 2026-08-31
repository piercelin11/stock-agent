"use server";

import { prisma } from "../prisma";
import {
  computeCandleShape,
  computeVolumeStrength,
  computeBase,
  resolveBreakoutConfig,
} from "../../scripts/lib/breakout-shared";
import { SPARK_CLIP, SPARK_WINDOW, type SparkPoint } from "../dashboard-spark";

// 近 60 日走勢圖：每點 = 當日收盤「相對布林中軌的偏離比例」＝(close − bollingerMid) / bollingerMid，
// 夾在 ±SPARK_CLIP。以布林帶寬正規化 → 盤整期貼近 0（線壓中間窄帶）、噴出時衝向邊界；
// 各檔絕對起伏可比，不受個股絕對振幅影響（波動大的股票布林中軌一起放大，偏離比例仍歸一）。
// 常數與 SparkPoint 型別定義在 lib/dashboard-spark.ts（本檔 "use server" 不能匯出值）。

export interface WatchlistPerfRow {
  stockCode: string;
  name: string;
  refDate: string; // 該檔實際取到的當日資料日期（quote 的 date）
  close: number;
  changePercent: number;
  // 近 60 日相對布林中軌偏離（舊 → 新），畫左側走勢圖用
  spark: SparkPoint[];
  // 面向分數（0~100，缺資料為 null）
  candleScore: number | null;
  volumeScore: number | null;
  baseScore: number | null; // 位階（高＝低位階剛起步）
  // 動能
  aboveBollingerUpper: boolean | null;
  // 籌碼（張，可為 null）
  instTotalNet: number | null;
  trustNet: number | null;
  degraded: string[];
}

const { score } = resolveBreakoutConfig();
const BASE_MAX_WINDOW = score.baseMaxWindowDays; // 240
const BASE_MIN_HISTORY = score.baseMinHistoryDays; // 40

export async function getWatchlistPerformance(): Promise<WatchlistPerfRow[]> {
  const items = await prisma.watchlistItem.findMany({
    include: { stock: { select: { name: true } } },
    orderBy: { addedAt: "desc" },
  });
  if (items.length === 0) return [];

  const rows = await Promise.all(
    items.map(async (item): Promise<WatchlistPerfRow | null> => {
      const quote = await prisma.dailyQuote.findFirst({
        where: { stockCode: item.stockCode },
        orderBy: { date: "desc" },
        select: {
          date: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
          change: true,
        },
      });
      if (!quote) return null;

      const refDate = quote.date;

      const [quoteWindow, indicatorWindow, institutional] = await Promise.all([
        // 近 61 筆（當日 + 前 60 日）：前 20 筆算 20 日均量、全部拿去畫走勢圖
        prisma.dailyQuote.findMany({
          where: { stockCode: item.stockCode, date: { lte: refDate } },
          orderBy: { date: "desc" },
          take: Math.max(21, SPARK_WINDOW),
          select: { date: true, close: true, volume: true },
        }),
        // 布林指標歷史（新到舊）：index 0 = refDate 當日。bollingerBandwidth → computeBase；bollingerMid → 走勢圖正規化
        prisma.technicalIndicator.findMany({
          where: { stockCode: item.stockCode, date: { lte: refDate } },
          orderBy: { date: "desc" },
          take: BASE_MAX_WINDOW + 1,
          select: {
            date: true,
            bollingerBandwidth: true,
            bollingerUpper: true,
            bollingerMid: true,
          },
        }),
        prisma.institutionalTrading.findFirst({
          where: { stockCode: item.stockCode },
          orderBy: { date: "desc" },
          select: {
            foreignNetBuy: true,
            investmentTrustNetBuy: true,
            dealerNetBuy: true,
          },
        }),
      ]);

      const degraded: string[] = [];

      // 漲跌%
      const prevClose = quote.close - quote.change;
      const changePercent =
        prevClose > 0 ? (quote.change / prevClose) * 100 : 0;

      // K 棒
      const candleResult = computeCandleShape({
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
      });
      if (candleResult.degraded) degraded.push("candleShape");
      const candleScore = candleResult.degraded ? null : candleResult.score;

      // 近 60 日走勢圖：把每天 close 對到同日 bollingerMid，算偏離比例並夾 ±SPARK_CLIP
      const midByDate = new Map<number, number | null>();
      for (const ind of indicatorWindow) {
        midByDate.set(ind.date.getTime(), ind.bollingerMid);
      }
      const spark: SparkPoint[] = quoteWindow
        .slice(0, SPARK_WINDOW)
        .slice()
        .reverse() // 舊 → 新
        .map((q) => {
          const mid = midByDate.get(q.date.getTime()) ?? null;
          if (mid == null || mid === 0) return { dev: null };
          const raw = (q.close - mid) / mid;
          return { dev: Math.max(-SPARK_CLIP, Math.min(SPARK_CLIP, raw)) };
        });

      // 力道（量能）：今日量 / 近 20 日均量
      const todayVolume = Number(quote.volume);
      const prior20 = quoteWindow.slice(1, 21).map((q) => Number(q.volume));
      const avg20Volume =
        prior20.length > 0
          ? prior20.reduce((a, b) => a + b, 0) / prior20.length
          : 0;
      let volumeScore: number | null = null;
      if (avg20Volume > 0) {
        volumeScore = computeVolumeStrength(
          todayVolume / avg20Volume,
          score.curves.volumeStrength,
        );
      } else {
        degraded.push("volume");
      }

      // 位階 / 盤整多久：computeBase 吃布林帶寬（新到舊，不含當前這筆）
      const latestBandwidth = indicatorWindow[0]?.bollingerBandwidth ?? null;
      const bandwidthHistory = indicatorWindow
        .slice(1)
        .map((i) => i.bollingerBandwidth);
      const baseResult = computeBase(
        latestBandwidth,
        bandwidthHistory,
        BASE_MIN_HISTORY,
        score.curves.base,
      );
      if (baseResult.degraded) degraded.push("base");
      const baseScore = baseResult.degraded ? null : baseResult.score;

      // 動能：當日是否站上布林上軌（用當日 indicator）
      const bollingerUpper = indicatorWindow[0]?.bollingerUpper ?? null;
      const aboveBollingerUpper =
        bollingerUpper != null ? quote.close >= bollingerUpper : null;

      // 籌碼：三欄單位為「股」，換算成「張」
      let instTotalNet: number | null = null;
      let trustNet: number | null = null;
      if (institutional) {
        const f = Number(institutional.foreignNetBuy ?? 0);
        const t = Number(institutional.investmentTrustNetBuy ?? 0);
        const d = Number(institutional.dealerNetBuy ?? 0);
        instTotalNet = Math.round((f + t + d) / 1000);
        trustNet =
          institutional.investmentTrustNetBuy === null
            ? null
            : Math.round(t / 1000);
      }

      return {
        stockCode: item.stockCode,
        name: item.stock.name,
        refDate: refDate.toISOString().slice(0, 10),
        close: quote.close,
        changePercent,
        spark,
        candleScore,
        volumeScore,
        baseScore,
        aboveBollingerUpper,
        instTotalNet,
        trustNet,
        degraded,
      };
    }),
  );

  return rows.filter((r): r is WatchlistPerfRow => r !== null);
}
