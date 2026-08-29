"use client";

import { useEffect, useState } from "react";
import {
  startLayer0Run,
  getLayer0Progress,
  type ProgressSnapshot,
  type Strategy,
} from "../lib/actions/backtest";

export function BacktestRunner() {
  const [strategy, setStrategy] = useState<Strategy>("breakout");
  const [start, setStart] = useState("2026-08-20");
  const [end, setEnd] = useState("2026-08-27");
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    if (progress && (progress.status === "done" || progress.status === "error")) return;

    const timer = setInterval(async () => {
      const p = await getLayer0Progress(runId);
      if (p) setProgress(p);
    }, 2000);
    return () => clearInterval(timer);
  }, [runId, progress]);

  async function onStart() {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const { runId: id } = await startLayer0Run({ strategy, start, end });
      setRunId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pct =
    progress && progress.totalDays > 0
      ? Math.round((progress.completedDays / progress.totalDays) * 100)
      : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          策略
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as Strategy)}
          >
            <option value="breakout">breakout</option>
            <option value="accumulation">accumulation</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          起始日
          <input
            type="date"
            className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          結束日
          <input
            type="date"
            className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "啟動中…" : "開始 Layer 0 基準跑"}
        </button>
      </div>

      {error ? <div className="text-sm text-red-600">錯誤：{error}</div> : null}

      {runId ? (
        <div className="space-y-2">
          <div className="text-xs text-slate-400">
            run: <span className="font-mono text-slate-700">{runId}</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded bg-slate-100">
            <div
              className={`h-full transition-all ${
                progress?.status === "error" ? "bg-red-500" : "bg-slate-900"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="text-sm text-slate-600">
            {progress
              ? `${progress.phase} — ${progress.completedDays}/${progress.totalDays} (${pct}%) · ${progress.status}` +
                (progress.currentDate ? ` · ${progress.currentDate}` : "")
              : "等待進度檔…"}
          </div>
          {progress?.status === "error" && progress.error ? (
            <pre className="whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">
              {progress.error}
            </pre>
          ) : null}
          {progress && progress.completenessWarnings.length > 0 ? (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">完整性檢查摘要</summary>
              <ul className="mt-1 list-disc pl-5">
                {progress.completenessWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
