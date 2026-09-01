import { cn } from "../../lib/cn";
import { FACTOR_LABELS } from "../signal/labels";
import type { SignalScanView } from "../../lib/actions/signal-scan";

// 展開列右欄：突破因子（UI.md 第二節）。
//
// 核心規則（UI.md 2.2）：長條寬度用「因子內部分數（0~100）」，不是原始數值——四個因子原始單位
// 不同，直接比長短有誤導性。原始值只放右側灰字供人類理解，不參與長條寬度。
//
// 不放位階（base）因子（使用者已定；設計圖右欄無 base）。

type Row = SignalScanView["results"][number];
type Factors = NonNullable<Row["factors"]>;

/** UI.md 2.3：≥70 綠 / 40~69 琥珀 / <40 紅。 */
function barTone(score: number): string {
  if (score >= 70) return "bg-success";
  if (score >= 40) return "bg-warning";
  return "bg-destructive";
}

function FactorBar({
  label,
  score,
  raw,
}: {
  label: string;
  score: number;
  raw: string;
}) {
  return (
    <div className="grid grid-cols-[5rem_1fr_2.5rem_4rem] items-center gap-2 text-xs">
      <span className="text-muted-foreground/70">{label}</span>
      <div className="h-2.5 rounded bg-muted">
        <div
          className={cn("h-full rounded", barTone(score))}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
      <span className="text-right font-semibold tabular-nums">{score.toFixed(0)}</span>
      <span className="text-right tabular-nums text-muted-foreground/70">{raw}</span>
    </div>
  );
}

export function BreakoutFactorBars({
  factors,
  rs,
}: {
  factors: Factors;
  rs: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold text-muted-foreground/70">突破因子</div>
      <FactorBar
        label={FACTOR_LABELS.breakoutMargin}
        score={factors.breakoutMarginScore}
        raw={`${factors.breakoutMarginPct >= 0 ? "+" : ""}${factors.breakoutMarginPct.toFixed(1)}%`}
      />
      <FactorBar label={FACTOR_LABELS.relativeStrength} score={rs} raw={`${rs.toFixed(0)} 分位`} />
      <FactorBar
        label={FACTOR_LABELS.proximityShort}
        score={factors.proximityShortScore}
        raw={`${factors.proximityShortPct.toFixed(1)}%`}
      />
      <FactorBar
        label={FACTOR_LABELS.proximityLong}
        score={factors.proximityLongScore}
        raw={`${factors.proximityLongPct.toFixed(1)}%`}
      />
      <p className="text-xs text-muted-foreground/50">
        長條 = 因子內部分數（0~100），右側灰字為原始值（不參與長條）。
      </p>
    </div>
  );
}
