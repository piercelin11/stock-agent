import type { PreBreakoutInst } from "../../lib/actions/watchlist";
import { PRE_CHIP, type Tone } from "./labels";

// 醞釀階段（pre-breakout）卡片頂部籌碼 badge 判斷表（PLAN §3）。
// 與突破階段的 resolveInstChip（InstitutionalFlowPanel.tsx）並存，WatchlistCard 依 stage 分流。
// 門檻（trustScore >=70 / 40~69 / <40、consecutive >=5）首版拍板，待校準。
//
// PLAN 8 §8.2：分支結構不改，文字改引用 labels.ts 的 PRE_CHIP，每分支上方補觸發條件註解。
// PLAN 8 §8.2 新分支：簽名加 warnings（比照 resolveInstChip）；warnings 含
//   "trend-reversal" → PRE_CHIP.trendReversal（近期轉賣，destructive）
//   "concentration"  → PRE_CHIP.concentration（外資單日爆量，warning）
//   兩者前置於現有 9 條（noData 之後）；trend-reversal 優先於 concentration（destructive 較重）。

const CONSECUTIVE_STRONG = 5; // 「連續買」門檻（綁 consecutiveBuyDays），待校準

export function resolvePreBreakoutChip(
  preInst: PreBreakoutInst | null,
  warnings: string[] = [],
): { text: string; tone: Tone } {
  // 1. 資料不足
  if (preInst === null || preInst.degraded) {
    return PRE_CHIP.noData;
  }

  // PLAN 8 §2：投信前 15 日在買、近 5 日轉賣 → 假突破誘多（前置，比一般籌碼結論重要）
  if (warnings.includes("trend-reversal")) return PRE_CHIP.trendReversal;
  // PLAN 8 §5：近 20 日外資+自營買超集中單一交易日 → 非常態爆量偽裝成累積
  if (warnings.includes("concentration")) return PRE_CHIP.concentration;

  const { trustScore, otherInstScore, consecutiveBuyDays } = preInst;
  const consecutive = consecutiveBuyDays >= CONSECUTIVE_STRONG;

  // 2. 不在掃描結果（無全市場百分位分數）但序列足 → 只依日曆型態判斷
  if (trustScore === null) {
    // 連續買超 >= 5 日 → 連續買；否則買盤分散
    return consecutive ? PRE_CHIP.trustStreakOnly : PRE_CHIP.trustSplitOnly;
  }

  const other = otherInstScore ?? 0;

  // 3~4. 投信強（trustScore >= 70）
  if (trustScore >= 70) {
    // 加連續買超 → 持續進場；否則 → 分散布局（分數高但不連續）
    return consecutive ? PRE_CHIP.trustHeavyStreak : PRE_CHIP.trustHeavySplit;
  }

  // 5~6. 投信中（trustScore 40~69）
  if (trustScore >= 40) {
    // 外資自營也強（otherInstScore >= 70）→ 兩邊合力偏多；否則 → 投信小幅偏多
    return other >= 70 ? PRE_CHIP.bothBull : PRE_CHIP.trustMildBull;
  }

  // 7~9. 投信弱（trustScore < 40）
  // 外資自營強但投信沒跟 → 偏多但欠投信確認
  if (other >= 70) {
    return PRE_CHIP.otherBullNoTrust;
  }
  // 兩邊都弱（otherInstScore < 40）→ 尚無明顯佈局
  if (other < 40) {
    return PRE_CHIP.noSetup;
  }
  // 其餘 → 中性
  return PRE_CHIP.neutral;
}
