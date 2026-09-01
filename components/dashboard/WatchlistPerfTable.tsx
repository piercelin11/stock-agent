import { FieldLabel } from "../ui/Card";
import {
  getWatchlistPerformance,
  type WatchlistPerfRow,
} from "../../lib/actions/dashboard";
import { Sparkline } from "../ui/Sparkline";
import { cn } from "../../lib/cn";

function scoreClass(v: number | null): string {
  if (v === null) return "text-muted-foreground/70";
  if (v >= 70) return "text-success";
  if (v >= 40) return "text-foreground/80";
  return "text-muted-foreground/70";
}

function ScoreItem({
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
        <span
          className={cn("text-lg font-semibold tabular-nums", scoreClass(value))}
        >
          {value.toFixed(0)}
        </span>
      )}
    </div>
  );
}

function Card({ row }: { row: WatchlistPerfRow }) {
  const cp = row.changePercent;
  const rising = cp >= 0;
  const cpClass = rising ? "text-up" : "text-down";

  const instClass =
    row.instTotalNet === null
      ? "text-muted-foreground/70"
      : row.instTotalNet > 0
        ? "text-up"
        : row.instTotalNet < 0
          ? "text-down"
          : "text-foreground/80";
  const trustClass =
    row.trustNet === null
      ? "text-muted-foreground/70"
      : row.trustNet > 0
        ? "text-up"
        : row.trustNet < 0
          ? "text-down"
          : "text-muted-foreground";

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex gap-4">
        <Sparkline points={row.spark} rising={rising} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight text-foreground">
              {row.stockCode}
            </span>
            <span className={cn("text-base font-medium tabular-nums", cpClass)}>
              {rising ? "+" : ""}
              {cp.toFixed(2)}%
            </span>
            {row.aboveBollingerUpper ? (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                突破
              </span>
            ) : null}
          </div>
          <div className="flex items-baseline gap-2 text-sm text-muted-foreground">
            <span className="truncate">{row.name}</span>
            <span className="tabular-nums text-muted-foreground/70">
              {row.close.toFixed(2)}
            </span>
            <span className="text-xs text-muted-foreground/50">{row.refDate}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between border-t border-border pt-3">
        <ScoreItem
          label="K 棒"
          value={row.candleScore}
          degraded={row.degraded.includes("candleShape")}
        />
        <ScoreItem
          label="力道"
          value={row.volumeScore}
          degraded={row.degraded.includes("volume")}
        />
        <ScoreItem
          label="位階"
          value={row.baseScore}
          degraded={row.degraded.includes("base")}
        />
        <div className="flex flex-col items-end gap-0.5">
          <FieldLabel className="text-muted-foreground/70">籌碼（張）</FieldLabel>
          <span className={cn("text-base tabular-nums", instClass)}>
            合計{" "}
            {row.instTotalNet === null
              ? "—"
              : `${row.instTotalNet > 0 ? "+" : ""}${row.instTotalNet}`}
          </span>
          <span className={cn("text-sm tabular-nums", trustClass)}>
            投信{" "}
            {row.trustNet === null
              ? "—"
              : `${row.trustNet > 0 ? "+" : ""}${row.trustNet}`}
          </span>
        </div>
      </div>
    </div>
  );
}

export async function WatchlistPerfTable() {
  const rows = await getWatchlistPerformance();

  if (rows.length === 0) {
    return (
      <div className="text-base text-muted-foreground">
        觀察清單為空，先到 Screening 加入標的。
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((r) => (
        <Card key={r.stockCode} row={r} />
      ))}
    </div>
  );
}
