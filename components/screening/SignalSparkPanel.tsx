"use client";

import { useEffect, useState } from "react";
import { getSignalSpark } from "../../lib/actions/signal-scan";
import { Sparkline } from "../ui/Sparkline";
import type { SparkPoint } from "../../lib/dashboard-spark";

// 展開列左欄：近 60 交易日走勢圖。按需撈（PLAN §3.1）——展開時 useEffect 依 code 呼叫
// getSignalSpark(code)，載入中顯示同 Sparkline「資料不足」框樣式的載入文字。
// 切換展開列時元件卸載重撈，不做跨列快取（YAGNI）。

export function SignalSparkPanel({ code, rising }: { code: string; rising: boolean }) {
  const [points, setPoints] = useState<SparkPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    (async () => {
      const p = await getSignalSpark(code);
      if (!cancelled) setPoints(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-muted-foreground/70">近 60 交易日走勢</div>
      {points === null ? (
        <div className="flex h-22 w-50 items-center justify-center rounded bg-muted/40 text-sm text-muted-foreground/50">
          資料載入中…
        </div>
      ) : (
        <Sparkline points={points} rising={rising} />
      )}
    </div>
  );
}
