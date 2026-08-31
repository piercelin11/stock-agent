import { Card, FieldLabel, Stat } from "../components/ui/Card";
import { WatchlistPerfTable } from "../components/dashboard/WatchlistPerfTable";
import { getDbHealth } from "../lib/actions/health";

// health card queries Postgres on every request; never prerender it at build time.
export const dynamic = "force-dynamic";

function coverageClass(pct: number): string {
  if (pct < 50) return "text-rose-400";
  if (pct < 90) return "text-amber-400";
  return "text-slate-100";
}

export default async function Page() {
  const health = await getDbHealth();
  const { coverage } = health;
  const covRows: { label: string; count: number; pct: number }[] = [
    { label: "DailyQuote", ...coverage.quote },
    { label: "籌碼", ...coverage.institutional },
    { label: "技術指標", ...coverage.technical },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-100">Dashboard</h1>

      <Card title="資料狀態">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <FieldLabel>今日行情燈號</FieldLabel>
            <div className="mt-2 flex items-center gap-2 text-base">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  health.quoteFresh ? "bg-emerald-500" : "bg-rose-500"
                }`}
              />
              {health.quoteFresh ? (
                <span className="text-slate-100">
                  已更新（{health.latestQuoteDate}）
                </span>
              ) : (
                <span className="text-slate-300">
                  未更新（DB 最新 {health.latestQuoteDate ?? "無"}，今日{" "}
                  {health.today}）
                </span>
              )}
            </div>
          </div>

          <Stat
            label="一般股票檔數"
            value={health.stockCount.toLocaleString()}
          />

          <div>
            <FieldLabel>
              當日三表覆蓋率（基準 {health.latestQuoteDate ?? "—"}）
            </FieldLabel>
            <div className="mt-2 space-y-1 text-base">
              {covRows.map((row) => (
                <div key={row.label} className="flex justify-between gap-4">
                  <span className="text-slate-400">{row.label}</span>
                  <span className={`tabular-nums ${coverageClass(row.pct)}`}>
                    {row.pct}%{" "}
                    <span className="text-sm text-slate-500">
                      ({row.count} / {health.stockCount})
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card title="觀察類股今日表現（帶量帶價第一根視角）">
        <WatchlistPerfTable />
      </Card>
    </div>
  );
}
