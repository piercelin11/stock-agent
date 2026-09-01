import { ScreeningPanel } from "../../components/screening/ScreeningPanel";
import { RegimeBanner } from "../../components/dashboard/RegimeBanner";
import { getMarketRegime } from "../../lib/actions/market-regime";

// client 元件會呼叫查 DB 的 Server Action；與其他頁一致標 force-dynamic。
export const dynamic = "force-dynamic";

export default async function ScreeningPage() {
  const regime = await getMarketRegime();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">選股</h1>
        <p className="mt-1 text-sm text-muted-foreground/70">
          單一訊號掃描：一顆按鈕自動判斷盤後 / 盤中資料源，全市場算完整因子分後依「第一根」
          狀態分成醞釀中 / 今日突破 / 已延伸三階段各自排名。結果不寫資料庫（落地 data/signal-scan-results）。
          勾選候選股可一鍵加入觀察清單。盤中模式為背景執行，可切走再回來看進度。
        </p>
      </div>
      {/* 按掃描前先看到大盤狀態；不擋按鈕。 */}
      <RegimeBanner regime={regime} variant="strip" />
      <ScreeningPanel />
    </div>
  );
}
