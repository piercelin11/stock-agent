"use client";

import { useState } from "react";
import { ensureForwardReturns } from "../lib/actions/backtest";

export function ForwardReturnsBuilder() {
  const [start, setStart] = useState("2024-01-02");
  const [end, setEnd] = useState("2026-05-30");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onRun() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await ensureForwardReturns({ start, end });
      setMsg(`已在背景啟動 build-forward-returns（${start} → ${end}）。完成後 cache 會自動更新。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        對每個 (交易日, 全市場股票) 用之後的 OHLC 算 5 / 10 / 20 日報酬 + 0050 同期報酬，寫入{" "}
        <span className="font-mono">data/backtest-cache/forward-returns.jsonl</span>（全域、跨策略共用，算過的跳過）。
      </p>
      <div className="flex flex-wrap items-end gap-4">
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
          onClick={onRun}
          disabled={busy}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "啟動中…" : "補 forward-returns cache"}
        </button>
      </div>
      {msg ? <div className="text-sm text-green-700">{msg}</div> : null}
      {error ? <div className="text-sm text-red-600">錯誤：{error}</div> : null}
    </div>
  );
}
