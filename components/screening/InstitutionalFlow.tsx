import { cn } from "../../lib/cn";
import type { SignalScanView } from "../../lib/actions/signal-scan";

// 展開列中欄：法人籌碼（UI.md 第一節）。
//
// 核心規則：diverging bar 的柱長用 inst.trustRatio / inst.foreignRatio
// （近 5 日淨買超 ÷ volumeMa20），不是股數、不是分數——柱長才跟分數公式同一把尺。
// 容器寬度代表 ±0.5（±50%）；達 ±0.5 = 圖表滿格 = 分數已封頂。
//
// 小箭頭 ▲/▼ 依 inst.todayXxxDir（今日單日方向），與柱子（近 5 日累積）是兩回事；
// 兩者不同號（近 5 日買、今日賣 = 翻臉）→ 柱子 opacity-50。

type Row = SignalScanView["results"][number];
type Inst = NonNullable<Row["inst"]>;

const CLIP_DIVISOR = 0.5; // 對齊 InstitutionalFlowConfig.clipDivisor

type Tone = "success" | "warning" | "destructive" | "muted";

const TONE_CHIP: Record<Tone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

/**
 * UI.md 1.4 chip 組合表。門檻（強/中/弱）首版拍板，註解標「待校準」。
 * 近 5 日流向強弱：ratio 合計 > 0.3 → 強、> 0 → 中、<= 0 → 弱。
 */
function resolveInstChip(inst: Inst, warnings: string[]): { text: string; tone: Tone } {
  const marginChasing = warnings.includes("margin-chasing");
  const ratioSum = inst.trustRatio + inst.foreignRatio;

  // 今日方向（任一為 null → 盤中未定）
  const todayKnown = inst.todayTrustDir !== null && inst.todayForeignDir !== null;
  const todaySum = todayKnown
    ? (inst.todayTrustDir ?? 0) + (inst.todayForeignDir ?? 0)
    : null;

  // 籌碼資料不足：兩個 ratio 都恰為 0（後端 volumeMa20 缺 / 近窗不足 → 回 0）
  const noData = inst.trustRatio === 0 && inst.foreignRatio === 0;
  if (noData) return { text: "籌碼資料不足", tone: "muted" };

  // 盤中今日未定
  if (todaySum === null) {
    const dir = ratioSum > 0 ? "偏多" : ratioSum < 0 ? "偏空" : "中性";
    return { text: `近期${dir}・今日未定`, tone: "muted" };
  }

  const buying = todaySum > 0;
  const selling = todaySum < 0;

  // 待校準：強/中/弱門檻
  const strong = ratioSum > 0.3;
  const mild = ratioSum > 0;

  if (buying) {
    if (strong) return { text: "法人同步進場", tone: "success" };
    if (mild) return { text: "法人續買", tone: "success" };
    // 近 5 日弱但今日仍買（兩機構分歧）
    return { text: "法人分歧偏多", tone: "warning" };
  }

  if (selling) {
    if (marginChasing) {
      return strong || mild
        ? { text: "融資追價警示", tone: "destructive" }
        : { text: "法人撤出＋融資追價", tone: "destructive" };
    }
    if (strong || mild) return { text: "近期強・今日翻臉", tone: "warning" };
    return { text: "法人同步撤出", tone: "destructive" };
  }

  // 今日持平
  return { text: ratioSum > 0 ? "近期偏多・今日持平" : "近期偏空・今日持平", tone: "muted" };
}

function DivergingBar({
  label,
  ratio,
  todayDir,
}: {
  label: string;
  ratio: number;
  todayDir: -1 | 0 | 1 | null;
}) {
  const magnitude = Math.min(Math.abs(ratio), CLIP_DIVISOR);
  const halfPct = (magnitude / CLIP_DIVISOR) * 50; // 佔容器半邊的百分比
  const buying = ratio > 0;

  // 柱子與今日箭頭不同號 → 翻臉，柱子調淡
  const flipped =
    todayDir !== null &&
    todayDir !== 0 &&
    ((buying && todayDir < 0) || (!buying && todayDir > 0));

  const barColor = buying ? "bg-success" : "bg-destructive";
  const arrow =
    todayDir === null || todayDir === 0 ? null : todayDir > 0 ? (
      <span className="text-success">▲</span>
    ) : (
      <span className="text-destructive">▼</span>
    );

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-10 shrink-0 text-muted-foreground/70">{label}</span>
      <div className="relative h-3 flex-1 rounded bg-muted">
        {/* 中線 */}
        <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
        <div
          className={cn("absolute top-0 h-full", barColor, flipped && "opacity-50")}
          style={
            buying
              ? { left: "50%", width: `${halfPct}%` }
              : { right: "50%", width: `${halfPct}%` }
          }
        />
      </div>
      <span
        className={cn(
          "w-14 shrink-0 text-right tabular-nums",
          buying ? "text-success" : ratio < 0 ? "text-destructive" : "text-muted-foreground/70",
        )}
      >
        {ratio >= 0 ? "+" : ""}
        {(ratio * 100).toFixed(0)}%
      </span>
      <span className="w-3 shrink-0 text-center">{arrow}</span>
    </div>
  );
}

export function InstitutionalFlow({
  inst,
  warnings,
}: {
  inst: Inst;
  warnings: string[];
}) {
  const chip = resolveInstChip(inst, warnings);
  const todayUnknown = inst.todayTrustDir === null || inst.todayForeignDir === null;
  const marginChasing = warnings.includes("margin-chasing");

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground/70">法人籌碼</div>

      <span className={cn("inline-block rounded px-2 py-0.5 text-xs font-medium", TONE_CHIP[chip.tone])}>
        {chip.text}
      </span>

      <div className="space-y-1.5 pt-1">
        <DivergingBar label="投信" ratio={inst.trustRatio} todayDir={inst.todayTrustDir} />
        <DivergingBar label="外資" ratio={inst.foreignRatio} todayDir={inst.todayForeignDir} />
      </div>

      <p className="text-xs text-muted-foreground/50">
        柱長 = 近 5 日淨買超 ÷ 20 日均量（±50% 為滿格）；▲▼ = 今日單日方向。
      </p>

      {marginChasing ? (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          融資 5 日增速排自己歷史前 20%，且今日法人翻空。
        </div>
      ) : null}

      {todayUnknown ? (
        <div className="text-xs text-muted-foreground/70">
          尚未取得今日法人資料，以上為近日資料。
        </div>
      ) : null}
    </div>
  );
}
