import { BacktestRunner } from "../../components/BacktestRunner";
import { Card } from "../../components/ui/Card";
import { listBacktestRuns } from "../../lib/actions/backtest";

// 讀 data/backtest-runs/ 目錄 + 查完整性檢查會查 DB；不要在 build time 預渲染。
export const dynamic = "force-dynamic";

export default async function BacktestPage() {
  const runs = await listBacktestRuns();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Backtest</h1>

      <Card title="Layer 0 基準跑（批次歷史模擬引擎）">
        <p className="mb-4 text-sm text-slate-500">
          對回測區間每個交易日，用選股純函式撈 DB 算出全市場每檔的「門檻裸值 + rankScore 前的原始聚合值」，
          寫入 <span className="font-mono">data/backtest-runs/{"{run-id}"}/raw-factors/</span>。不套門檻、不算分數、不寫 DB。
        </p>
        <BacktestRunner />
      </Card>

      <Card title="已有的 run">
        {runs.length === 0 ? (
          <div className="text-sm text-slate-400">尚無 run。</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400">
                <th className="py-1 pr-4">run-id</th>
                <th className="py-1 pr-4">策略</th>
                <th className="py-1 pr-4">區間</th>
                <th className="py-1 pr-4">進度</th>
                <th className="py-1 pr-4">狀態</th>
                <th className="py-1">建立時間</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} className="border-t border-slate-100">
                  <td className="py-1.5 pr-4 font-mono text-xs text-slate-700">{r.runId}</td>
                  <td className="py-1.5 pr-4">{r.strategy || "—"}</td>
                  <td className="py-1.5 pr-4 text-slate-600">
                    {r.range ? `${r.range.start} → ${r.range.end}` : "—"}
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums text-slate-600">
                    {r.completedDays !== null && r.totalDays !== null
                      ? `${r.completedDays}/${r.totalDays}`
                      : "—"}
                  </td>
                  <td className="py-1.5 pr-4">
                    <span
                      className={
                        r.status === "done"
                          ? "text-green-600"
                          : r.status === "error"
                            ? "text-red-600"
                            : "text-slate-600"
                      }
                    >
                      {r.status ?? "—"}
                    </span>
                  </td>
                  <td className="py-1.5 text-xs text-slate-500">{r.createdAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
