// 階段判定 helper（ROADMAP 4.5.3 / PLAN §2.5 + §3.3）。
//
//   - consecutiveAboveBand：run-signal-scan.ts 打階段標籤（setup / breakoutDay / extended）
//     的依據。breakout.ts 的 computeFirstBar 本體不改（它有「使用者明確要求保留的
//     ≤2→50 / >2→20 緩衝」語意，PLAN 不動）。
//   - computeBreakoutMarginMonotone：§2.5 單調遞增版（舊 computeBreakoutMargin 不動）。

import { clip } from "./util";

// ============================================================================
// §2.5 computeBreakoutMarginMonotone —— 單調遞增版（舊 computeBreakoutMargin 不動）
// ============================================================================
//
// 舊版（breakout.ts）：marginPct > kneePct 後每 1% 扣 penaltyPerPct 分、下限 floor
//   → 乖離越大分數越低（懲罰追高）。
// 新版：0~kneePct% 線性 40→100（不變）；> kneePct% 維持 100 封頂，不加不扣；
//   marginPct ≤ 0（收在上軌之下，理論上不進 breakout 階段，但盤中 h 代入可能邊界）→ clip 到 40 下限。
//
// config：只讀 curve.kneePct；penaltyPerPct / floor 在新公式裡不讀（欄位保留、給舊三支用）。

export function computeBreakoutMarginMonotone(
  close: number,
  bollingerUpper: number,
  curve: { kneePct: number },
): number {
  const marginPct = ((close - bollingerUpper) / bollingerUpper) * 100;
  if (marginPct <= 0) return 40;
  if (marginPct <= curve.kneePct) {
    return clip(40 + (marginPct / curve.kneePct) * 60, 40, 100);
  }
  return 100;
}

// ============================================================================
// §3.3 consecutiveAboveBand —— 「連續站上布林上軌天數」helper（階段判定依據）
// ============================================================================
//
// run-signal-scan.ts 拿它打階段標籤（setup / breakoutDay / extended）。
// series[0] 是最新一筆（eod = 當日收盤；盤中 = 即時價或 h 代入 vs T-1 上軌），依日期新到舊排序。

export interface AboveBandState {
  /** series 有效、可判定 */
  ok: boolean;
  /** 最新一筆 close 是否 > 當筆 bollingerUpper */
  latestAboveBand: boolean;
  /** 從 series[0] 往回連續收在上軌上方的天數（series[0] 若站上算 1；未站上為 0） */
  consecutiveDays: number;
}

export function consecutiveAboveBand(
  series: { close: number; bollingerUpper: number | null }[],
): AboveBandState {
  if (series.length === 0 || series[0]!.bollingerUpper === null) {
    return { ok: false, latestAboveBand: false, consecutiveDays: 0 };
  }
  const latest = series[0]!;
  if (latest.close <= latest.bollingerUpper!) {
    return { ok: true, latestAboveBand: false, consecutiveDays: 0 };
  }
  let consecutiveDays = 0;
  for (const point of series) {
    if (point.bollingerUpper === null) break;
    if (point.close > point.bollingerUpper) consecutiveDays += 1;
    else break;
  }
  return { ok: true, latestAboveBand: true, consecutiveDays };
}
