import Link from "next/link";
import { listWatchlist } from "../../lib/actions/watchlist";
import { WatchlistGallery } from "../../components/watchlist/WatchlistGallery";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const rows = await listWatchlist();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">觀察清單</h1>
        <p className="mt-1 text-sm text-muted-foreground/70">
          手動維護的正式觀察名單。依「連續站上布林上軌天數」即時分成首次突破 / 延續爆發 / 醞釀中。
          資料庫有當日資料時用資料庫（⚡），否則自動抓盤中即時報價（🕐）。
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
        <WatchlistGallery rows={rows} />
      )}
    </div>
  );
}
