import { SPARK_CLIP, type SparkPoint } from "../../lib/dashboard-spark";

// 近 60 日走勢圖的純 SVG 元件。Dashboard 的 WatchlistPerfTable 與 Screening 展開列共用。
// SVG 的 stroke / <line stroke> 是硬編 HEX（Server Component 不能 getComputedStyle）。
// 這三個常數對應 globals.css 的 --up / --down / --muted-foreground，改色需同步 globals.css。
export const SPARK_UP = "#fb7185"; // --up (rose-400)
export const SPARK_DOWN = "#34d399"; // --down (emerald-400)
export const SPARK_BASELINE = "#475569"; // 對應 --muted-foreground 附近的中性灰（基準虛線）

/**
 * 近 60 日走勢圖：Y 軸 = 收盤相對布林中軌的偏離比例，固定夾在 ±SPARK_CLIP。
 * 所有卡共用同一刻度 → 盤整期線壓在中線窄帶、噴出時衝到上/下緣，卡跟卡之間絕對起伏可比。
 * 線色依「當日漲跌」紅(漲)/綠(跌)，線下漸層淡出。上下各留 PAD 邊距，避免頂到框邊。
 */
export function Sparkline({
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
