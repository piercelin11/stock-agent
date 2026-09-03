// 訊號因子 UI 的標籤中文名 + stage 標籤/顏色的單一出處（PLAN §5）。
//
// 純常數，非元件——screening 頁與 watchlist 頁都 import 這裡。要改任何一個標籤中文名
// （「突破幅度」→「乖離幅度」之類）只改這個檔，兩頁一起生效。不引 i18n 框架（YAGNI）。

import type { SignalStage } from "../../lib/actions/signal-scan";

// ---- stage（第一根突破 / 延續爆發 / 醞釀中）----

/** tab 顯示順序：首次突破 → 延續爆發 → 醞釀中（screening 既有順序，watchlist 沿用）。 */
export const STAGE_ORDER: SignalStage[] = ["breakoutDay", "extended", "setup"];

export const STAGE_LABELS: Record<SignalStage, string> = {
  "setup": "醞釀中",
  "breakoutDay": "首次突破",
  extended: "延續爆發",
};

/** 狀態 pill 底色（複用狀態語意 token；與台股漲跌色不同語意）。 */
export const STAGE_PILL_CLASS: Record<SignalStage, string> = {
  "breakoutDay": "bg-destructive/10 text-destructive",
  extended: "bg-warning/10 text-warning",
  "setup": "bg-muted text-muted-foreground",
};

// ---- 因子標籤 ----

export const FACTOR_LABELS = {
  // 法人籌碼區塊
  institutional: "法人籌碼",
  trust: "投信",
  foreign: "外資",
  // 醞釀階段法人籌碼區塊
  institutionalTrade: "法人買賣",
  trustBuyCalendar: "近20日投信買超日",
  otherInstitution: "外資 / 自營商",
  // 突破因子（screening 展開列長條圖 + watchlist 卡片底排純數字共用這組名字）
  breakoutMargin: "突破幅度",
  relativeStrength: "相對強度",
  proximityShort: "距 60 日高點",
  proximityLong: "距年高",
  // 位階/力道/K 棒（pre-breakout 卡片底排）
  candle: "K 棒",
  volume: "力道",
  base: "位階",
  volumeRatio: "量增",
} as const;
