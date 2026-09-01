import Link from "next/link";
import { listWatchlist } from "../../lib/actions/watchlist";
import { WatchlistTable } from "../../components/watchlist/WatchlistTable";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const rows = await listWatchlist();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">觀察清單</h1>
        <p className="mt-1 text-sm text-muted-foreground/70">
          手動維護的正式觀察名單。每檔顯示三表（報價 / 技術 / 籌碼）各自最新一筆。
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          觀察清單是空的，去
          <Link href="/screening" className="mx-1 text-foreground underline">
            選股頁
          </Link>
          挑幾檔。
        </div>
      ) : (
        <WatchlistTable rows={rows} />
      )}
    </div>
  );
}
