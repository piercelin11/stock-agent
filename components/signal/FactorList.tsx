import { ClockIcon } from "@radix-ui/react-icons";
import { cn } from "../../lib/cn";
import { FieldLabel } from "../ui/Card";
import { FACTOR_LABELS } from "./labels";
import type { WatchlistCardRow } from "../../lib/actions/watchlist";

// 卡片底排因子：label + 數字（PLAN §3，非長條圖——screening 的 BreakoutFactorBars 才用長條）。
//
//   breakout-day / extended：量增 x2.3 · 距年高 10% · 強度 PR90 · 突破 +9.5%（原始值）
//     「強度」讀最近掃描結果的 RS 百分位（PLAN §3.1）；掃描結果比卡片資料舊 → PR 旁加 🕐；
//     不在掃描結果裡 → 「—」。
//   pre-breakout：量增 x2.3 · K 棒 / 力道 / 位階（三分數 0~100，比照 WatchlistPerfTable 的 ScoreItem）

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <FieldLabel className="text-muted-foreground/70">{label}</FieldLabel>
      <span className="text-base font-medium tabular-nums text-foreground/90">{children}</span>
    </div>
  );
}

/** 三分數（K 棒/力道/位階）：>=70 綠 / 40~70 foreground/80 / <40 灰；null 顯「—」+ degraded 加「不足」。 */
function scoreClass(v: number | null): string {
  if (v === null) return "text-muted-foreground/70";
  if (v >= 70) return "text-success";
  if (v >= 40) return "text-foreground/80";
  return "text-muted-foreground/70";
}

function ScoreCell({
  label,
  value,
  degraded,
}: {
  label: string;
  value: number | null;
  degraded: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <FieldLabel className="text-muted-foreground/70">{label}</FieldLabel>
      {value === null ? (
        <span className="text-base text-muted-foreground/70">
          —
          {degraded ? (
            <span className="ml-1 rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">
              不足
            </span>
          ) : null}
        </span>
      ) : (
        <span className={cn("text-base font-semibold tabular-nums", scoreClass(value))}>
          {value.toFixed(0)}
        </span>
      )}
    </div>
  );
}

export function FactorList({ row }: { row: WatchlistCardRow }) {
  const volRatio =
    row.volumeRatio === null ? "—" : `x${row.volumeRatio.toFixed(1)}`;

  if (row.stage === "pre-breakout") {
    return (
      <div className="flex items-end justify-between gap-2">
        <Cell label={FACTOR_LABELS.volumeRatio}>{volRatio}</Cell>
        <ScoreCell
          label={FACTOR_LABELS.candle}
          value={row.candleScore}
          degraded={row.degraded.includes("candleShape")}
        />
        <ScoreCell
          label={FACTOR_LABELS.volume}
          value={row.volumeScore}
          degraded={row.degraded.includes("volume")}
        />
        <ScoreCell
          label={FACTOR_LABELS.base}
          value={row.baseScore}
          degraded={row.degraded.includes("base")}
        />
      </div>
    );
  }

  // breakout-day / extended
  const f = row.factors;
  const rs =
    f == null || f.relativeStrength === null
      ? null
      : Math.round(f.relativeStrength);

  return (
    <div className="flex items-end justify-between gap-2">
      <Cell label={FACTOR_LABELS.volumeRatio}>{volRatio}</Cell>
      <Cell label={FACTOR_LABELS.proximityLong}>
        {f == null ? "—" : `${f.proximityLongPct.toFixed(1)}%`}
      </Cell>
      <Cell label={FACTOR_LABELS.relativeStrength}>
        {rs === null ? (
          "—"
        ) : (
          <span className="inline-flex items-center gap-0.5">
            PR{rs}
            {f?.relativeStrengthStale ? (
              <ClockIcon
                className="h-3 w-3 text-muted-foreground/60"
                aria-label="此 PR 取自較舊的掃描結果"
              />
            ) : null}
          </span>
        )}
      </Cell>
      <Cell label={FACTOR_LABELS.breakoutMargin}>
        {f == null
          ? "—"
          : `${f.breakoutMarginPct >= 0 ? "+" : ""}${f.breakoutMarginPct.toFixed(1)}%`}
      </Cell>
    </div>
  );
}
