import { ScreeningPanel } from "../../components/screening/ScreeningPanel";

// client 元件會呼叫查 DB 的 Server Action；與其他頁一致標 force-dynamic。
export const dynamic = "force-dynamic";

export default function ScreeningPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">選股</h1>
        <p className="mt-1 text-sm text-slate-500">
          跑最新交易日的盤後選股，結果不寫資料庫（沿用純函式的 data/*-results 落地）。
          勾選候選股可一鍵加入觀察清單。
        </p>
      </div>
      <ScreeningPanel />
    </div>
  );
}
