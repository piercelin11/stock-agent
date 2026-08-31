import type { MarketRegimeView } from "../../lib/actions/market-regime";
import type { DimensionScore } from "../../scripts/lib/market-regime";

// 大盤濾網橫幅。PLAN §5。Server Component，純顯示，無互動。
//
// 配色選擇：市場狀態燈號用**通用號誌色**（綠=通行=偏多、紅=停=偏空、琥珀=注意=中性），
// 跟個股漲跌色（台股慣例漲紅跌綠）**不同語意、不同區塊**，不會混淆。
//
// variant:
//   "banner"（預設，首頁）= 完整橫幅 + <details> 三維度明細
//   "strip"（/screening 頁頂）= 精簡一行：圓點 + 大盤：偏空 + advice，不展開明細

type Variant = "banner" | "strip";

const LABEL_ZH: Record<string, string> = {
  bullish: "偏多",
  neutral: "中性",
  bearish: "偏空",
};

const DOT_CLASS: Record<string, string> = {
  bullish: "bg-emerald-500",
  neutral: "bg-amber-500",
  bearish: "bg-rose-500",
};

const DIM_LABEL: Record<string, string> = {
  indexPosition: "指數位置",
  ma60Slope: "MA60 斜率",
  breadth: "市場寬度",
};

function dotClass(view: MarketRegimeView): string {
  if (!view.available || !view.label) return "bg-slate-600";
  return DOT_CLASS[view.label] ?? "bg-slate-600";
}

function labelZh(view: MarketRegimeView): string {
  if (!view.available || !view.label) return "無資料";
  return LABEL_ZH[view.label] ?? view.label;
}

function DimensionRow({
  name,
  dim,
}: {
  name: string;
  dim: DimensionScore | null;
}) {
  if (dim === null) {
    return (
      <div className="flex items-center justify-between gap-4 py-1">
        <span className="text-slate-500">{DIM_LABEL[name] ?? name}</span>
        <span className="text-sm text-slate-600">待 TAIEX 資料</span>
      </div>
    );
  }
  const sign = dim.score > 0 ? `+${dim.score}` : `${dim.score}`;
  const detailStr = Object.entries(dim.detail)
    .map(([k, v]) => `${k}=${v === null ? "—" : v}`)
    .join("　");
  return (
    <div className="py-1">
      <div className="flex items-center justify-between gap-4">
        <span className={dim.degraded ? "text-slate-500" : "text-slate-300"}>
          {DIM_LABEL[name] ?? name}
        </span>
        <span
          className={`tabular-nums ${dim.degraded ? "text-slate-500" : "text-slate-200"}`}
        >
          {sign}
          {dim.degraded ? (
            <span className="ml-1 text-xs text-slate-500">資料不足</span>
          ) : null}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-slate-500">{detailStr}</div>
    </div>
  );
}

export function RegimeBanner({
  regime,
  variant = "banner",
}: {
  regime: MarketRegimeView;
  variant?: Variant;
}) {
  const dot = dotClass(regime);
  const zh = labelZh(regime);
  const isBearish = regime.available && regime.label === "bearish";

  if (variant === "strip") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-800 bg-slate-900 px-4 py-2.5 text-sm">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="font-medium text-slate-100">大盤：{zh}</span>
        <span className="text-slate-400">{regime.advice}</span>
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border bg-slate-900 p-4 ${
        isBearish ? "border-rose-500/40" : "border-slate-800"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 inline-block h-3 w-3 shrink-0 rounded-full ${dot}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-base font-semibold text-slate-100">
              大盤：{zh}
            </span>
            {regime.available ? (
              <span className="text-sm text-slate-500">
                （基準 {regime.date}，score {regime.totalScore}）
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-400">{regime.advice}</p>

          {regime.available ? (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-300">
                三維度明細（stage {regime.stage}）
              </summary>
              <div className="mt-2 divide-y divide-slate-800 border-t border-slate-800">
                <DimensionRow
                  name="indexPosition"
                  dim={regime.dimensions.indexPosition}
                />
                <DimensionRow
                  name="ma60Slope"
                  dim={regime.dimensions.ma60Slope}
                />
                <DimensionRow name="breadth" dim={regime.dimensions.breadth} />
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
