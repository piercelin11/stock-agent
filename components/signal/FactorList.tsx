import { ClockIcon } from "@radix-ui/react-icons";
import { FieldLabel } from "../ui/Card";
import { FACTOR_LABELS } from "./labels";
import type { WatchlistCardRow } from "../../lib/actions/watchlist";

// 卡片底排因子：label + 數字（PLAN §3，非長條圖——screening 的 BreakoutFactorBars 才用長條）。
//
//   breakout-day / extended：量增 x2.3 · 距年高 10% · 強度 PR90 · 突破 +9.5%（原始值）
//     「強度」讀最近掃描結果的 RS 百分位（PLAN §3.1）；掃描結果比卡片資料舊 → PR 旁加 🕐；
//     不在掃描結果裡 → 「—」。
//   pre-breakout：只留「量增」（PLAN 3——K 棒 / 力道 / 位階三個「單檔現算」分數已從醞釀中卡片移除，
//     那三個正是「盤中要現算還是讀 JSON」岔路的來源；拿掉後三個模式一律不現算這些）。

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <FieldLabel className="text-muted-foreground/70">{label}</FieldLabel>
      <span className="text-base font-medium tabular-nums text-foreground/90">{children}</span>
    </div>
  );
}

export function FactorList({ row }: { row: WatchlistCardRow }) {
  const volRatio =
    row.volumeRatio === null ? "—" : `x${row.volumeRatio.toFixed(1)}`;

  if (row.stage === "setup") {
    return (
      <div className="flex items-end justify-between gap-2">
        <Cell label={FACTOR_LABELS.volumeRatio}>{volRatio}</Cell>
      </div>
    );
  }

  // breakout-day / extended。PLAN 7：row.factors 一律有值（去 nullable），f == null 死碼已移除。
  const f = row.factors;
  const rs = f.relativeStrength === null ? null : Math.round(f.relativeStrength);

  return (
    <div className="flex items-end justify-between gap-2">
      <Cell label={FACTOR_LABELS.volumeRatio}>{volRatio}</Cell>
      <Cell label={FACTOR_LABELS.proximityLong}>
        {`${f.proximityLongPct.toFixed(1)}%`}
      </Cell>
      <Cell label={FACTOR_LABELS.relativeStrength}>
        {rs === null ? (
          "—"
        ) : (
          <span className="inline-flex items-center gap-0.5">
            PR{rs}
            {f.relativeStrengthStale ? (
              <ClockIcon
                className="h-3 w-3 text-muted-foreground/60"
                aria-label="此 PR 取自較舊的掃描結果"
              />
            ) : null}
          </span>
        )}
      </Cell>
      <Cell label={FACTOR_LABELS.breakoutMargin}>
        {`${f.breakoutMarginPct >= 0 ? "+" : ""}${f.breakoutMarginPct.toFixed(1)}%`}
      </Cell>
    </div>
  );
}
