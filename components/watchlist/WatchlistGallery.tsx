"use client";

import { useMemo, useState } from "react";
import type { WatchlistCardRow, SignalStage } from "../../lib/actions/watchlist";
import { cn } from "../../lib/cn";
import { STAGE_LABELS, STAGE_ORDER } from "../signal/labels";
import { WatchlistCard } from "./WatchlistCard";

// 卡片 gallery + 階段分頁（PLAN §1 / §3）。
// tab 順序固定 首次突破 → 延續爆發 → 醞釀中；預設「首次突破」（breakout-day）。
// grid 一列 1~4 張，取決螢幕寬度。空 tab 顯示提示。

export function WatchlistGallery({ rows }: { rows: WatchlistCardRow[] }) {
  const [stage, setStage] = useState<SignalStage>("breakout-day");

  const countByStage = useMemo(() => {
    const m: Record<SignalStage, number> = {
      "breakout-day": 0,
      extended: 0,
      "pre-breakout": 0,
    };
    for (const r of rows) m[r.stage] += 1;
    return m;
  }, [rows]);

  const shown = useMemo(() => rows.filter((r) => r.stage === stage), [rows, stage]);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border">
        {STAGE_ORDER.map((s) => (
          <button
            key={s}
            onClick={() => setStage(s)}
            className={cn(
              "px-4 py-2 text-sm font-medium",
              stage === s
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground/70 hover:text-foreground",
            )}
          >
            {STAGE_LABELS[s]}（{countByStage[s]}）
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          此分類目前無觀察股。
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {shown.map((r) => (
            <WatchlistCard key={r.stockCode} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}
