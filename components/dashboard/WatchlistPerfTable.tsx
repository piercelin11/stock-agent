import { FieldLabel } from "../ui/Card";
import {
  getWatchlistPerformance,
  type WatchlistPerfRow,
} from "../../lib/actions/dashboard";
import { SPARK_CLIP, type SparkPoint } from "../../lib/dashboard-spark";
import { cn } from "../../lib/cn";

// Sparkline 內 SVG 的 stroke / <line stroke> 是硬編 HEX（Server Component 不能 getComputedStyle）。
// 這三個常數對應 globals.css 的 --up / --down / --muted-foreground，改色需同步 globals.css。
const SPARK_UP = "#fb7185"; // --up (rose-400)
const SPARK_DOWN = "#34d399"; // --down (emerald-400)
const SPARK_BASELINE = "#475569"; // 對應 --muted-foreground 附近的中性灰（基準虛線）

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

/**
 * 近 60 日走勢圖：Y 軸 = 收盤相對布林中軌的偏離比例，固定夾在 ±SPARK_CLIP。
 * 所有卡共用同一刻度 → 盤整期線壓在中線窄帶、噴出時衝到上/下緣，卡跟卡之間絕對起伏可比。
 * 線色依「當日漲跌」紅(漲)/綠(跌)，線下漸層淡出。上下各留 PAD 邊距，避免頂到框邊。
 */
function Sparkline({
  points,
  rising,
}: {
  points: SparkPoint[];
  rising: boolean;
}) {
  const W = 200;
  const H = 88;
  const PAD = 8; // dev = ±SPARK_CLIP 對應到 y = PAD / H-PAD，不貼框邊
  const n = points.length;
  const gradId = `spark-grad-${rising ? "up" : "down"}`;

  // 有效點（dev 非 null）轉成座標
  const coords = points
    .map((p, i) => {
      if (p.dev === null) return null;
      const x = n <= 1 ? 0 : (i / (n - 1)) * W;
      // dev ∈ [-CLIP, +CLIP] → y ∈ [H-PAD, PAD]（+CLIP 靠近頂端，留 PAD 空間）
      const y = H / 2 - (p.dev / SPARK_CLIP) * (H / 2 - PAD);
      return { x, y };
    })
    .filter((c): c is { x: number; y: number } => c !== null);

  const stroke = rising ? SPARK_UP : SPARK_DOWN;

  if (coords.length < 2) {
    return (
      <div className="flex h-22 w-50 items-center justify-center rounded bg-muted/40 text-sm text-muted-foreground/50">
        資料不足
      </div>
    );
  }

  const linePath = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    `${linePath} L${coords[coords.length - 1]!.x.toFixed(1)},${H} ` +
    `L${coords[0]!.x.toFixed(1)},${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-22 w-50 shrink-0"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* 布林中軌基準線（dev = 0） */}
      <line
        x1="0"
        y1={H / 2}
        x2={W}
        y2={H / 2}
        stroke={SPARK_BASELINE}
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
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
