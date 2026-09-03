"use client";

import { useMemo, useState } from "react";
import type { WatchlistCardRow, SignalStage } from "../../lib/actions/watchlist";
import { cn } from "../../lib/cn";
import { STAGE_LABELS, STAGE_ORDER } from "../signal/labels";
import { WatchlistCard } from "./WatchlistCard";

// 卡片 gallery + 階段分頁（PLAN 6 §1 / §3）。
// tab 順序固定 首次突破 → 延續爆發 → 醞釀中；預設「首次突破」（breakoutDay）。
// 分類依 userStage ?? autoStage（手動分類優先）；autoStage 不同時 tab label 顯示「N 異動」。
// grid 一列 1~4 張，取決螢幕寬度。空 tab 顯示提示。

export function WatchlistGallery({ rows }: { rows: WatchlistCardRow[] }) {
  const [stage, setStage] = useState<SignalStage>("breakoutDay");

  const countByStage = useMemo(() => {
    const m: Record<SignalStage, { total: number; mismatch: number }> = {
      breakoutDay: { total: 0, mismatch: 0 },
      extended: { total: 0, mismatch: 0 },
      setup: { total: 0, mismatch: 0 },
    };
    for (const r of rows) {
      const tab = r.userStage ?? r.autoStage;
      m[tab].total += 1;
      if (r.autoStage !== tab) m[tab].mismatch += 1;
    }
    return m;
  }, [rows]);

  const shown = useMemo(
    () => rows.filter((r) => (r.userStage ?? r.autoStage) === stage),
    [rows, stage],
  );

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
            {STAGE_LABELS[s]}（{countByStage[s].total}
            {countByStage[s].mismatch > 0
              ? ` · ${countByStage[s].mismatch} 異動`
              : ""}
            ）
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
