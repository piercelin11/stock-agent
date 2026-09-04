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

// ============================================================================
// PLAN 8 §8：標籤系統統一管理
// ============================================================================
//
// Tone / TONE_CHIP 從 InstitutionalFlowPanel.tsx 搬來當單一出處（labels.ts 是純常數檔、
// 被多頁 import，不宜反過來 import 元件）。InstitutionalFlowPanel.tsx 改成 re-export，
// 既有 `import { Tone } from "./InstitutionalFlowPanel"` 路徑不炸。

export type Tone = "success" | "warning" | "destructive" | "muted";

/** chip 底色（inline badge 用；淡底無邊框）。 */
export const TONE_CHIP: Record<Tone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

// ---- §8.1 warnings 中央清單 ----
//
// 目前 "margin-chasing" 這個 magic string 散在多個檔案硬比對、中文說明寫死在 SignalDetail.tsx。
// 統一收進這個 map，每筆帶 title / detail（意義）/ trigger（觸發條件白話）/ tone。
// 三個頁面（SignalDetail / ScreeningPanel / WatchlistCard）渲染 warning 都查這裡。
// 門檻值本身在 scripts/lib/signal-factors/config.ts 的 SignalScanConfig（首版未校準，見 PLAN 8 §14）。

export type WarningKey =
  | "margin-chasing"
  | "trend-reversal"
  | "concentration"
  | "institution-crowded";

export const WARNING_LABELS: Record<
  WarningKey,
  { title: string; detail: string; trigger: string; tone: Tone }
> = {
  "margin-chasing": {
    title: "融資追價",
    detail:
      "突破當日三大法人（投信＋外資）淨賣超，且本檔融資餘額近期增速排在自己歷史前 20%——散戶追價、法人可能在派發。系統僅標記，未調整分數。",
    trigger:
      "breakoutDay/extended 階段 · 突破當日投信+外資淨賣超 · computeMarginSurgePercentile > surgePercentileThreshold(80)",
    tone: "destructive",
  },
  "trend-reversal": {
    title: "近期轉賣",
    detail:
      "投信在前 15 個交易日淨買超為正、但最近 5 個交易日轉為淨賣——20 日總量看起來仍在累積，實際上近期已在出貨，疑似假突破誘多。",
    trigger:
      "setup 階段 · 投信近 5 日淨買超合計 < 0 且 前 15 日淨買超合計 > 0（computeTrendReversal）",
    tone: "destructive",
  },
  concentration: {
    title: "單日爆量",
    detail:
      "近 20 個交易日外資＋自營的買超，超過一半集中在單一交易日——那波「法人累積」其實是一次性動作，不是穩定進場。",
    trigger:
      "setup 階段 · 窗內單一交易日買超 ÷ 窗內總正買超 > thresholdRatio(0.5)（computeSingleDayConcentration，只看外資+自營）",
    tone: "warning",
  },
  "institution-crowded": {
    title: "法人擁擠",
    detail:
      "近 5 個交易日投信＋外資的淨買超合計，佔 20 日均量的比例過高——法人籌碼濃度大、散戶浮額少，一旦法人反手賣壓會很急。此時尚未反手，僅為體質提示。",
    trigger:
      "breakoutDay/extended 階段 · (trustRatio + foreignRatio) > crowdedThreshold(0.8)（computeInstitutionalFlow）",
    tone: "warning",
  },
};

// ---- §8.2 chip 文字常數化 ----
//
// chip 文字不再是散在 resolveInstChip / resolvePreBreakoutChip 裡的字串 literal。
// 函式的分支結構不改（if/else 判斷邏輯不動），只把每分支的文字 + tone 收進常數、
// 函式改引用，且每分支上方補「觸發條件 + 意義」註解。

/** 突破階段結論 chip（resolveInstChip 用）。key = 語意代號，非顯示順序。 */
export const INST_CHIP = {
  noData: { text: "籌碼資料不足", tone: "muted" as Tone },
  recentBullPend: { text: "近期偏多・今日未定", tone: "muted" as Tone },
  recentBearPend: { text: "近期偏空・今日未定", tone: "muted" as Tone },
  recentFlatPend: { text: "近期中性・今日未定", tone: "muted" as Tone },
  allInBuy: { text: "法人同步進場", tone: "success" as Tone },
  keepBuy: { text: "法人續買", tone: "success" as Tone },
  splitBull: { text: "法人分歧偏多", tone: "warning" as Tone },
  marginChaseStrong: { text: "融資追價警示", tone: "destructive" as Tone },
  marginChaseWeak: { text: "法人撤出＋融資追價", tone: "destructive" as Tone },
  flipToday: { text: "近期強・今日翻臉", tone: "warning" as Tone },
  allOut: { text: "法人同步撤出", tone: "destructive" as Tone },
  crowded: { text: "法人擁擠", tone: "warning" as Tone }, // PLAN 8 §4 新增
  recentBullFlat: { text: "近期偏多・今日持平", tone: "muted" as Tone },
  recentBearFlat: { text: "近期偏空・今日持平", tone: "muted" as Tone },
} as const;

/** 醞釀階段結論 chip（resolvePreBreakoutChip 用）。 */
export const PRE_CHIP = {
  noData: { text: "籌碼資料不足", tone: "muted" as Tone },
  trendReversal: { text: "投信近期轉賣", tone: "destructive" as Tone }, // PLAN 8 §2
  concentration: { text: "外資單日爆量", tone: "warning" as Tone }, // PLAN 8 §5
  trustStreakOnly: { text: "投信近期連續買", tone: "success" as Tone },
  trustSplitOnly: { text: "投信買盤分散", tone: "muted" as Tone },
  trustHeavyStreak: { text: "投信持續進場", tone: "success" as Tone },
  trustHeavySplit: { text: "投信分散布局", tone: "success" as Tone },
  bothBull: { text: "法人合力偏多", tone: "success" as Tone },
  trustMildBull: { text: "投信小幅偏多", tone: "warning" as Tone },
  otherBullNoTrust: { text: "外資自營偏多・投信未跟", tone: "warning" as Tone },
  noSetup: { text: "籌碼尚無明顯佈局", tone: "muted" as Tone },
  neutral: { text: "籌碼中性", tone: "muted" as Tone },
} as const;

// ---- §6.4 instBackground（中性背景，非 warnings）----

export const INST_BACKGROUND_LABELS: Record<
  "positioned-early" | "fresh-entry",
  { text: string; hint: string }
> = {
  "positioned-early": { text: "法人早佈局", hint: "過去 20 日投信持續買超，突破前已進場" },
  "fresh-entry": { text: "法人剛進場", hint: "前 15 日投信無明顯動作，近 5 日才買進、追突破" },
};
