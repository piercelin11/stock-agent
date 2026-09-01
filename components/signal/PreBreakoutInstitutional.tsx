import { InfoCircledIcon } from "@radix-ui/react-icons";
import { cn } from "../../lib/cn";
import { Tooltip } from "../ui/Tooltip";
import { FACTOR_LABELS } from "./labels";
import type { PreBreakoutInst } from "../../lib/actions/watchlist";

// 醞釀階段（pre-breakout）「法人籌碼」區塊——screening 展開列 + watchlist 卡片共用（PLAN §1–2）。
//
// 突破階段的 InstitutionalFlowPanel 是「近 5 日淨買超 ÷ 均量 diverging bar + 今日方向箭頭」。
// 醞釀階段公式（computeTrustRawMetrics + computeOtherInstitutionRatio）是 20 日窗口、只看
// 頻率與累積佔比、沒有「今日方向」概念 → 完全不同的視覺：20 格買超日曆 + 兩條全市場百分位進度條。
//
// 進度條寬度 = scores.trustScore / otherInstScore（run-signal-scan 跑全市場算好的 rankScore
// 百分位）。watchlist 幾檔算不出百分位 → 讀最近 eod 掃描結果；不在名單 → 退化（見下）。
//
// PreBreakoutInst 型別在 lib/actions/watchlist.ts（type-only import，erase 掉不進 bundle）；
// SignalResult.preInst（scripts/screening/run-signal-scan.ts）結構相同、結構相容可直接傳。

const CAL_COLS = 10;

export function PreBreakoutInstitutional({ preInst }: { preInst: PreBreakoutInst }) {
  // 序列 < 門檻天數 → 整區塊只留標題 + 一行提示
  if (preInst.degraded) {
    return (
      <div className="space-y-2">
        <div className="text-xs font-semibold text-muted-foreground/70">
          {FACTOR_LABELS.institutionalTrade}
        </div>
        <p className="text-xs text-muted-foreground/50">近 20 日投信資料不足。</p>
      </div>
    );
  }

  const inScan = preInst.trustScore !== null;

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground/70">
        {FACTOR_LABELS.institutionalTrade}
      </div>

      {/* 20 格投信買超日曆（舊 → 新，2×10）。買超天數 / 連續天數收進日曆 label 右側的 ⓘ。 */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground/50">
        <span>{FACTOR_LABELS.trustBuyCalendar}</span>
        <Tooltip
          content={
            <span>
              近20日買超 {preInst.buyDays} 天，最近連續 {preInst.consecutiveBuyDays} 天
            </span>
          }
        >
          <button
            type="button"
            className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
            aria-label="近20日投信買超日說明"
          >
            <InfoCircledIcon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
      <BuyCalendar flags={preInst.buyDayFlags} />

      {/* 投信分數列 */}
      <ScoreRow
        label={FACTOR_LABELS.trust}
        score={preInst.trustScore}
        barClass="bg-success"
        tooltip={
          <div className="space-y-0.5">
            {preInst.trustNetRatio !== null ? (
              <div>
                買超金額佔已發行股數 {(preInst.trustNetRatio * 100).toFixed(1)}%
              </div>
            ) : null}
            {inScan && preInst.trustScore !== null ? (
              <div>優於全市場 {Math.round(preInst.trustScore)}% 的個股</div>
            ) : (
              <div>此檔不在最近盤後掃描的醞釀名單，無全市場排名。</div>
            )}
          </div>
        }
      />

      {/* 外資 / 自營商分數列——只在掃描結果有值時顯示（無逐日資料、非本階段主訊號） */}
      {inScan && preInst.otherInstScore !== null ? (
        <ScoreRow
          label={FACTOR_LABELS.otherInstitution}
          score={preInst.otherInstScore}
          barClass="bg-warning"
          tooltip={
            preInst.otherInstRatio !== null ? (
              <div>
                外資＋自營商20日合計淨買超，佔同期成交量{" "}
                {(preInst.otherInstRatio * 100).toFixed(1)}%
              </div>
            ) : (
              <div>外資＋自營商20日合計淨買超集中度。</div>
            )
          }
        />
      ) : null}
    </div>
  );
}

function BuyCalendar({ flags }: { flags: boolean[] }) {
  // 不足 20 格 → 舊端（前面）補「無資料」灰格
  const pad = Math.max(0, CAL_COLS * 2 - flags.length);
  const cells: (boolean | null)[] = [
    ...Array.from({ length: pad }, () => null),
    ...flags,
  ];
  return (
    <div className="grid grid-cols-10 gap-1">
      {cells.map((c, i) => (
        <span
          key={i}
          className={cn(
            "aspect-square rounded-sm",
            c === null ? "bg-muted/40" : c ? "bg-success" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

function ScoreRow({
  label,
  score,
  barClass,
  tooltip,
}: {
  label: string;
  score: number | null;
  barClass: string;
  tooltip: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground/70">{label}</span>
      <div className="h-2 flex-1 rounded bg-muted">
        {score !== null ? (
          <div
            className={cn("h-full rounded", barClass)}
            style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
          />
        ) : null}
      </div>
      <span className="w-7 shrink-0 text-right tabular-nums text-foreground/90">
        {score === null ? "—" : Math.round(score)}
      </span>
      <Tooltip content={tooltip}>
        <button
          type="button"
          className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
          aria-label={`${label}分數說明`}
        >
          <InfoCircledIcon className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
