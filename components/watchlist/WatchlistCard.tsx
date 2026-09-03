"use client";

import { useTransition } from "react";
import {
  removeFromWatchlist,
  updateWatchlistItem,
  type WatchlistCardRow,
} from "../../lib/actions/watchlist";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Sparkline } from "../ui/Sparkline";
import { FreshnessBadge } from "../signal/FreshnessBadge";
import { FactorList } from "../signal/FactorList";
import {
  InstitutionalFlowPanel,
  resolveInstChip,
  TONE_CHIP,
} from "../signal/InstitutionalFlowPanel";
import { PreBreakoutInstitutional } from "../signal/PreBreakoutInstitutional";
import { resolvePreBreakoutChip } from "../signal/pre-breakout-chip";
import { STAGE_LABELS, STAGE_ORDER, STAGE_PILL_CLASS } from "../signal/labels";

export function WatchlistCard({ row }: { row: WatchlistCardRow }) {
  const [isPending, startTransition] = useTransition();
  const rising = row.changePercent >= 0;
  const cpClass = rising ? "text-up" : "text-down";

  function remove() {
    startTransition(async () => {
      await removeFromWatchlist({ code: row.stockCode });
    });
  }

  const stageMismatch = row.userStage !== row.autoStage;

  const chip =
    row.stage === "setup"
      ? resolvePreBreakoutChip(row.preInst)
      : row.inst
        ? resolveInstChip(row.inst, [])
        : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4">
      {/* 標頭 */}
      <div className="flex items-start gap-2">
        <FreshnessBadge fresh={row.dataFresh} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-3xl font-semibold tracking-tight text-foreground">
              {row.stockCode}
            </span>
            <span className={cn("text-base font-medium tabular-nums", cpClass)}>
              {rising ? "+" : ""}
              {row.changePercent.toFixed(2)}%
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-medium",
                STAGE_PILL_CLASS[row.stage],
              )}
            >
              {STAGE_LABELS[row.stage]}
            </span>
            {chip ? (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-xs font-medium",
                  TONE_CHIP[chip.tone],
                )}
              >
                {chip.text}
              </span>
            ) : null}
            {stageMismatch ? (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-xs font-medium",
                  STAGE_PILL_CLASS[row.autoStage],
                )}
              >
                ⚠ 自動判定：{STAGE_LABELS[row.autoStage]}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
            <span className="truncate">{row.name}</span>
            <span className="tabular-nums text-muted-foreground/70">
              {row.close.toFixed(2)}
            </span>
            {row.priceSource === "estimated" ? (
              <span className="rounded bg-warning/10 px-1 text-xs text-warning">估</span>
            ) : null}
            {/* §3.4：stale（盤外）= 收盤定案價，明確告知非即時；intraday = 盤中即時，只顯示日期 */}
            <span className="text-xs text-muted-foreground/50">
              {row.mode === "stale"
                ? `收盤定案 ${row.latestEodDate || row.refDate}`
                : row.mode === "intraday"
                  ? `盤中 ${row.refDate}`
                  : row.refDate}
            </span>
          </div>
        </div>
        <Button variant="danger" onClick={remove} disabled={isPending}>
          移除
        </Button>
      </div>

      {/* 走勢圖 */}
      <Sparkline points={row.spark} rising={rising} />

      {/* 法人籌碼區塊：breakout 階段 = diverging bar；醞釀階段 = 20 格日曆 + 百分位進度條 */}
      {row.stage === "setup" ? (
        row.preInst ? (
          <PreBreakoutInstitutional preInst={row.preInst} />
        ) : null
      ) : row.inst ? (
        <InstitutionalFlowPanel inst={row.inst} warnings={[]} showChip={false} />
      ) : null}

      {/* 底排因子 */}
      <div className="border-t border-border pt-3">
        <FactorList row={row} />
      </div>

      {/* 改分類（PLAN 6 §3.7）：手動指定 userStage，當前高亮 */}
      <div className="flex flex-wrap items-center gap-1 border-t border-border pt-3">
        <span className="mr-1 text-xs text-muted-foreground/70">分類</span>
        {STAGE_ORDER.map((s) => (
          <button
            key={s}
            onClick={() =>
              startTransition(() =>
                updateWatchlistItem({ code: row.stockCode, userStage: s }),
              )
            }
            disabled={isPending || row.userStage === s}
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium",
              row.userStage === s
                ? STAGE_PILL_CLASS[s]
                : "bg-muted text-muted-foreground/70 hover:text-foreground",
            )}
          >
            {STAGE_LABELS[s]}
          </button>
        ))}
      </div>
    </div>
  );
}
