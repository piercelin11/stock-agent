// 近 60 日走勢圖的序列建構純函式。
// dashboard.ts（getWatchlistPerformance）與 signal-scan.ts（getSignalSpark）共用。
//
// 規則：每點 = 當日收盤「相對布林中軌的偏離比例」＝(close − bollingerMid) / bollingerMid，
// 夾在 ±SPARK_CLIP。無同日 bollingerMid（或 mid 為 0）→ 該點 dev = null。

import { SPARK_CLIP, type SparkPoint } from "./dashboard-spark";

/**
 * @param quoteWindow 近 SPARK_WINDOW 筆 { date, close }。**新到舊**排序（呼叫端 date desc 查出來直接傳）。
 *                    函式內部會反轉成舊→新輸出。
 * @param midByDate   date.getTime() → bollingerMid（number | null）
 * @returns SparkPoint[]，舊→新，長度 = quoteWindow.length
 */
export function buildSparkSeries(
  quoteWindow: { date: Date; close: number }[],
  midByDate: Map<number, number | null>,
): SparkPoint[] {
  return quoteWindow
    .slice()
    .reverse() // 舊 → 新
    .map((q) => {
      const mid = midByDate.get(q.date.getTime()) ?? null;
      if (mid == null || mid === 0) return { dev: null };
      const raw = (q.close - mid) / mid;
      return { dev: Math.max(-SPARK_CLIP, Math.min(SPARK_CLIP, raw)) };
    });
}
