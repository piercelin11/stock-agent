import type { PreBreakoutInst } from "../../lib/actions/watchlist";
import type { Tone } from "./InstitutionalFlowPanel";

// 醞釀階段（pre-breakout）卡片頂部籌碼 badge 判斷表（PLAN §3）。
// 與突破階段的 resolveInstChip（InstitutionalFlowPanel.tsx）並存，WatchlistCard 依 stage 分流。
// 門檻（trustScore >=70 / 40~69 / <40、consecutive >=5）首版拍板，待校準。

const CONSECUTIVE_STRONG = 5; // 「連續買」門檻（綁 consecutiveBuyDays），待校準

export function resolvePreBreakoutChip(
  preInst: PreBreakoutInst | null,
): { text: string; tone: Tone } {
  // 1. 資料不足
  if (preInst === null || preInst.degraded) {
    return { text: "籌碼資料不足", tone: "muted" };
  }

  const { trustScore, otherInstScore, consecutiveBuyDays } = preInst;
  const consecutive = consecutiveBuyDays >= CONSECUTIVE_STRONG;

  // 2. 不在掃描結果（無全市場百分位分數）但序列足 → 只依日曆型態判斷
  if (trustScore === null) {
    return consecutive
      ? { text: "投信近期連續買", tone: "success" }
      : { text: "投信買盤分散", tone: "muted" };
  }

  const other = otherInstScore ?? 0;

  // 3~4. 投信強
  if (trustScore >= 70) {
    return consecutive
      ? { text: "投信持續進場", tone: "success" }
      : { text: "投信分散布局", tone: "success" };
  }

  // 5~6. 投信中
  if (trustScore >= 40) {
    return other >= 70
      ? { text: "法人合力偏多", tone: "success" }
      : { text: "投信小幅偏多", tone: "warning" };
  }

  // 7~9. 投信弱
  if (other >= 70) {
    return { text: "外資自營偏多・投信未跟", tone: "warning" };
  }
  if (other < 40) {
    return { text: "籌碼尚無明顯佈局", tone: "muted" };
  }
  return { text: "籌碼中性", tone: "muted" };
}
