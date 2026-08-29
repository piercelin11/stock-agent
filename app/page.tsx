import { ChartSmoke } from "../components/ChartSmoke";
import { Card, Stat } from "../components/ui/Card";
import { getDbHealth } from "../lib/actions/health";

// health card queries Postgres on every request; never prerender it at build time.
export const dynamic = "force-dynamic";

export default async function Page() {
  const health = await getDbHealth();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>

      <Card title="DB 連通性">
        <div className="flex gap-10">
          <Stat label="DailyQuote 筆數" value={health.quoteCount.toLocaleString()} />
          <Stat label="Stock 筆數" value={health.stockCount.toLocaleString()} />
          <Stat label="最新報價日期" value={health.latestQuoteDate ?? "—"} />
        </div>
      </Card>

      <Card title="Recharts smoke（寫死資料）">
        <ChartSmoke />
      </Card>
    </div>
  );
}
