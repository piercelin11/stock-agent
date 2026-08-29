import { BacktestRunner } from "../../components/BacktestRunner";
import { BacktestSummary } from "../../components/BacktestSummary";
import { ForwardReturnsBuilder } from "../../components/ForwardReturnsBuilder";
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

      <Card title="Layer 0.5 forward-returns cache">
        <ForwardReturnsBuilder />
      </Card>

      <Card title="已有的 run">
        {runs.length === 0 ? (
          <div className="text-sm text-slate-400">尚無 run。</div>
        ) : (
          <div className="space-y-6">
            {runs.map((r) => (
              <div key={r.runId} className="rounded border border-slate-100 p-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="font-mono text-xs text-slate-700">{r.runId}</span>
                  <span className="text-slate-600">{r.strategy || "—"}</span>
                  <span className="text-slate-600">
                    {r.range ? `${r.range.start} → ${r.range.end}` : "—"}
                  </span>
                  <span className="tabular-nums text-slate-600">
                    {r.completedDays !== null && r.totalDays !== null
                      ? `${r.completedDays}/${r.totalDays}`
                      : "—"}
                  </span>
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
                  <span className="text-xs text-slate-500">{r.createdAt ?? "—"}</span>
                </div>
                {r.status === "done" ? (
                  <div className="mt-3">
                    <BacktestSummary runId={r.runId} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
