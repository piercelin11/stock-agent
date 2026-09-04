import { cn } from "../../lib/cn";
import { FACTOR_LABELS, INST_CHIP, TONE_CHIP, type Tone } from "./labels";

// PLAN 8 §8：Tone / TONE_CHIP 的定義搬到 labels.ts（純常數檔，單一出處）。這裡 re-export
// 讓既有 `import { Tone, TONE_CHIP } from "./InstitutionalFlowPanel"` 路徑不炸。
export { TONE_CHIP } from "./labels";
export type { Tone } from "./labels";

// 法人籌碼區塊：screening 展開列中欄 + watchlist 卡片共用（PLAN §5）。
// 原檔 components/screening/InstitutionalFlow.tsx，4.5.x watchlist 改版時搬進 components/signal/。
//
// 核心規則：diverging bar 的柱長用 inst.trustRatio / inst.foreignRatio
// （近 5 日淨買超 ÷ volumeMa20），不是股數、不是分數——柱長才跟分數公式同一把尺。
// 容器寬度代表 ±0.5（±50%）；達 ±0.5 = 圖表滿格 = 分數已封頂。
//
// 小箭頭 ▲/▼ 依 inst.todayXxxDir（今日單日方向），與柱子（近 5 日累積）是兩回事；
// 兩者不同號（近 5 日買、今日賣 = 翻臉）→ 柱子 opacity-50。

// SignalResult.inst 與 WatchlistCardRow.inst 結構相同，這裡定 local 型別讓兩邊都能傳。
export interface Inst {
  trustRatio: number;
  foreignRatio: number;
  todayTrustDir: -1 | 0 | 1 | null;
  todayForeignDir: -1 | 0 | 1 | null;
}

const CLIP_DIVISOR = 0.5; // 對齊 InstitutionalFlowConfig.clipDivisor

/**
 * chip 組合表：近 5 日流向強弱 × 今日方向 × margin-chasing → 一句話結論。
 * 門檻（強/中/弱）首版拍板，待校準。watchlist 卡片頂部的籌碼結論 chip 也用這支。
 *
 * PLAN 8 §8.2：分支結構不改，文字改引用 labels.ts 的 INST_CHIP，每分支上方補觸發條件註解。
 * PLAN 8 §8.2 新分支：warnings 含 "institution-crowded" → INST_CHIP.crowded
 *   （放在 noData 之後、一般流向結論之前；margin-chasing 的 destructive chip 仍優先——
 *    marginChasing 只在 selling 分支內判定，crowded 這個獨立前置檢查不會蓋掉它，因為
 *    「今日淨賣超 + margin-chasing」的股票也可能同時 crowded，此時走 selling 分支的
 *    destructive chip 語意更重、更該顯示）。
 */
export function resolveInstChip(inst: Inst, warnings: string[]): { text: string; tone: Tone } {
  const marginChasing = warnings.includes("margin-chasing");
  const crowded = warnings.includes("institution-crowded");
  const ratioSum = inst.trustRatio + inst.foreignRatio;

  // 今日方向（任一為 null → 盤中未定）
  const todayKnown = inst.todayTrustDir !== null && inst.todayForeignDir !== null;
  const todaySum = todayKnown
    ? (inst.todayTrustDir ?? 0) + (inst.todayForeignDir ?? 0)
    : null;

  // 籌碼資料不足：兩個 ratio 都恰為 0（後端 volumeMa20 缺 / 近窗不足 → 回 0）
  const noData = inst.trustRatio === 0 && inst.foreignRatio === 0;
  if (noData) return INST_CHIP.noData;

  // PLAN 8 §4：法人濃度過高（trustRatio + foreignRatio > 0.8）——散戶浮額少、體質脆弱。
  //   前置於一般流向結論；但今日淨賣超（走下面 selling 分支）語意更重、不被此攔截，
  //   所以只在「今日還在買 / 今日未定」時 crowded 才拿到最終 chip。
  if (crowded && (todaySum === null || todaySum >= 0)) return INST_CHIP.crowded;

  // 盤中今日未定
  if (todaySum === null) {
    // 近 5 日流向和 > 0 偏多 / < 0 偏空 / = 0 中性；今日方向盤中拿不到
    return ratioSum > 0
      ? INST_CHIP.recentBullPend
      : ratioSum < 0
        ? INST_CHIP.recentBearPend
        : INST_CHIP.recentFlatPend;
  }

  const buying = todaySum > 0;
  const selling = todaySum < 0;

  // 待校準：強/中/弱門檻
  const strong = ratioSum > 0.3;
  const mild = ratioSum > 0;

  if (buying) {
    // 近 5 日強(ratioSum>0.3) + 今日買 → 法人火力集中，最強的偏多訊號
    if (strong) return INST_CHIP.allInBuy;
    // 近 5 日小幅偏多 + 今日買 → 續買
    if (mild) return INST_CHIP.keepBuy;
    // 近 5 日弱但今日仍買（兩機構分歧）
    return INST_CHIP.splitBull;
  }

  if (selling) {
    if (marginChasing) {
      // 今日法人淨賣超 + 融資追價：近 5 日還算強 = 派發疑慮 / 近 5 日也弱 = 法人已撤+散戶硬追
      return strong || mild ? INST_CHIP.marginChaseStrong : INST_CHIP.marginChaseWeak;
    }
    // 近 5 日強但今日翻賣 → 翻臉（尚無融資追價佐證，暫列 warning）
    if (strong || mild) return INST_CHIP.flipToday;
    // 近 5 日也弱 + 今日賣 → 法人同步撤出
    return INST_CHIP.allOut;
  }

  // 今日持平：只看近 5 日方向
  return ratioSum > 0 ? INST_CHIP.recentBullFlat : INST_CHIP.recentBearFlat;
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

export function InstitutionalFlowPanel({
  inst,
  warnings,
  /** watchlist 卡片頂部已另有籌碼結論 chip → 傳 false 不重複顯示。screening 展開列預設 true。 */
  showChip = true,
}: {
  inst: Inst;
  warnings: string[];
  showChip?: boolean;
}) {
  const chip = resolveInstChip(inst, warnings);
  const todayUnknown = inst.todayTrustDir === null || inst.todayForeignDir === null;
  const marginChasing = warnings.includes("margin-chasing");

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground/70">
        {FACTOR_LABELS.institutional}
      </div>

      {showChip ? (
        <span
          className={cn(
            "inline-block rounded px-2 py-0.5 text-xs font-medium",
            TONE_CHIP[chip.tone],
          )}
        >
          {chip.text}
        </span>
      ) : null}

      <div className="space-y-1.5 pt-1">
        <DivergingBar
          label={FACTOR_LABELS.trust}
          ratio={inst.trustRatio}
          todayDir={inst.todayTrustDir}
        />
        <DivergingBar
          label={FACTOR_LABELS.foreign}
          ratio={inst.foreignRatio}
          todayDir={inst.todayForeignDir}
        />
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
