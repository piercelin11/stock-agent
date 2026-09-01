import { Card, FieldLabel, Stat } from "../components/ui/Card";
import { WatchlistPerfTable } from "../components/dashboard/WatchlistPerfTable";
import { RegimeBanner } from "../components/dashboard/RegimeBanner";
import { PipelineRunner } from "../components/dashboard/PipelineRunner";
import { getDbHealth } from "../lib/actions/health";
import { getMarketRegime } from "../lib/actions/market-regime";

// health card queries Postgres on every request; never prerender it at build time.
export const dynamic = "force-dynamic";

function coverageClass(pct: number): string {
  if (pct < 50) return "text-destructive";
  if (pct < 90) return "text-warning";
  return "text-foreground";
}

export default async function Page() {
  const [health, regime] = await Promise.all([
    getDbHealth(),
    getMarketRegime(),
  ]);
  const { coverage } = health;
  const covRows: { label: string; count: number; pct: number }[] = [
    { label: "DailyQuote", ...coverage.quote },
    { label: "籌碼", ...coverage.institutional },
    { label: "技術指標", ...coverage.technical },
    { label: "融資融券", ...coverage.margin },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>

      <RegimeBanner regime={regime} />

      <Card title="資料狀態">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <FieldLabel>今日行情燈號</FieldLabel>
            <div className="mt-2 flex items-center gap-2 text-base">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  health.quoteFresh ? "bg-success" : "bg-destructive"
                }`}
              />
              {health.quoteFresh ? (
                <span className="text-foreground">
                  已更新（{health.latestQuoteDate}）
                </span>
              ) : (
                <span className="text-foreground/80">
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
              當日四表覆蓋率（基準 {health.latestQuoteDate ?? "—"}）
            </FieldLabel>
            <div className="mt-2 space-y-1 text-base">
              {covRows.map((row) => (
                <div key={row.label} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className={`tabular-nums ${coverageClass(row.pct)}`}>
                    {row.pct}%{" "}
                    <span className="text-sm text-muted-foreground/70">
                      ({row.count} / {health.stockCount})
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <PipelineRunner />
      </Card>

      <Card title="觀察類股今日表現（帶量帶價第一根視角）">
        <WatchlistPerfTable />
      </Card>
    </div>
  );
}
