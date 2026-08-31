// 近 60 日走勢圖的共用常數與型別。
// 為什麼獨立一檔：`lib/actions/dashboard.ts` 檔頭是 `"use server"`，只能匯出 async function，
// 不能匯出 const / 值。走勢圖的刻度常數同時被 action（算資料）與元件（畫 SVG）用到 → 抽這裡。

/** Y 軸夾在 ±SPARK_CLIP（收盤相對布林中軌的偏離比例），所有卡共用同一刻度 */
export const SPARK_CLIP = 0.25;
/** 走勢圖天數 */
export const SPARK_WINDOW = 60;

export interface SparkPoint {
  /** (close − bollingerMid) / bollingerMid，已夾在 ±SPARK_CLIP；無 bollingerMid 該點為 null */
  dev: number | null;
}
