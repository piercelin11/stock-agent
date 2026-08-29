"use client";

import { useState } from "react";
import { runBacktestSummary } from "../lib/actions/backtest";
import type { BacktestStats, HorizonStats } from "../scripts/lib/backtest-stats";

const FIELDS: { key: keyof HorizonStats; label: string; digits: number }[] = [
  { key: "n", label: "n", digits: 0 },
  { key: "hitRate", label: "命中率", digits: 3 },
  { key: "avgReturn", label: "平均報酬%", digits: 2 },
  { key: "medianReturn", label: "中位數%", digits: 2 },
  { key: "avgExcessReturn", label: "超額%", digits: 2 },
  { key: "winRate", label: "勝率", digits: 3 },
  { key: "profitFactor", label: "賺賠比", digits: 2 },
  { key: "maxDrawdown", label: "最大回撤%", digits: 1 },
];

function fmt(v: number, digits: number): string {
  if (!Number.isFinite(v)) return "∞";
  return digits === 0 ? String(v) : v.toFixed(digits);
}

function StatsTable({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; stats: Record<number, HorizonStats> }[];
}) {
  const horizons = rows.length > 0 ? Object.keys(rows[0]!.stats).map(Number).sort((a, b) => a - b) : [];
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-slate-500">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="py-1 pr-3">分層 / horizon</th>
              {FIELDS.map((f) => (
                <th key={f.key} className="py-1 pr-3">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row) =>
              horizons.map((h) => (
                <tr key={`${row.label}-${h}`} className="border-t border-slate-100">
                  <td className="py-1 pr-3 text-slate-600">
                    {row.label} · {h}d
                  </td>
                  {FIELDS.map((f) => (
                    <td key={f.key} className="py-1 pr-3 text-slate-700">
                      {fmt(row.stats[h]![f.key], f.digits)}
                    </td>
                  ))}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BacktestSummary({ runId }: { runId: string }) {
  const [stats, setStats] = useState<BacktestStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setBusy(true);
    setError(null);
    try {
      const s = await runBacktestSummary({ runId });
      setStats(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onRun}
        disabled={busy}
        className="rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {busy ? "重算中…" : "跑統計摘要"}
      </button>

      {error ? <div className="text-xs text-red-600">錯誤：{error}</div> : null}

      {stats ? (
        <div className="space-y-4">
          <div className="text-xs text-slate-400">
            {stats.meta.totalPicks} picks · {stats.meta.datesCovered} 個交易日
          </div>
          <StatsTable title="overall" rows={[{ label: "all", stats: stats.overall }]} />
          <StatsTable
            title="byTopN（分數分層單調性）"
            rows={Object.entries(stats.byTopN).map(([cut, s]) => ({
              label: cut === "Infinity" ? "top∞" : `top${cut}`,
              stats: s,
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}
