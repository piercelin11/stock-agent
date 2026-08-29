"use client";

import { useEffect, useRef, useState } from "react";
import { getPocProgress, startPocTask } from "../lib/actions/poc";

// Background-task PoC (docs/PLAN.md §9). DELETE with the rest of the _poc files.

type Progress = Awaited<ReturnType<typeof getPocProgress>>;

export function PocRunner() {
  const [progress, setProgress] = useState<Progress>({
    current: 0,
    total: 10,
    status: "idle",
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  async function handleStart() {
    await startPocTask();
    setProgress((p) => ({ ...p, current: 0, status: "running" }));
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const next = await getPocProgress();
      setProgress(next);
      if ((next.status === "done" || next.status === "error") && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    }, 1000);
  }

  const pct = Math.round((progress.current / progress.total) * 100);

  return (
    <div>
      <button
        onClick={handleStart}
        disabled={progress.status === "running"}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {progress.status === "running" ? "Running…" : "Start PoC task"}
      </button>
      <div className="mt-3 h-2 w-full overflow-hidden rounded bg-slate-100">
        <div
          className="h-full bg-blue-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-slate-500 tabular-nums">
        {progress.current} / {progress.total} · {progress.status}
      </div>
    </div>
  );
}
