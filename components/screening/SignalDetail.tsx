import type { SignalScanView } from "../../lib/actions/signal-scan";
import { SignalSparkPanel } from "./SignalSparkPanel";
import { InstitutionalFlowPanel } from "../signal/InstitutionalFlowPanel";
import { PreBreakoutInstitutional } from "../signal/PreBreakoutInstitutional";
import { BreakoutFactorBars } from "./BreakoutFactorBars";
import { WarningBanner } from "../signal/WarningBanner";
import { INST_BACKGROUND_LABELS } from "../signal/labels";

// 展開列內容（PLAN §3）。原 ScreeningPanel 內的 Detail function 搬進本檔（ScreeningPanel 已太長）。
//
// stage 分支：
//   pre-breakout → 左線圖 + 醞釀階段法人籌碼區塊（20 格買超日曆 + 兩條全市場百分位進度條）
//   breakout-day / extended → 三欄卡：左線圖 / 中法人 diverging bar / 右突破因子
//
// 頂部 WarningBanner（PLAN 8：margin-chasing / trend-reversal / concentration / institution-crowded
// 多個一起渲染）、estimated 琥珀框在兩種 stage 都渲染。

type Row = SignalScanView["results"][number];

export function SignalDetail({ row }: { row: Row }) {
  const isPre = row.stage === "setup";
  const rising = row.changePercent >= 0;
  const bg = row.instBackground ? INST_BACKGROUND_LABELS[row.instBackground] : null;

  return (
    <div className="space-y-3">
      <WarningBanner warnings={row.warnings} />
      {row.priceSource === "estimated" ? (
        <div className="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
          此檔盤中無成交價，突破判定基於盤中最高價（保守），K 棒形態項為佔位分。
        </div>
      ) : null}

      {isPre ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SignalSparkPanel code={row.code} rising={rising} />
            {row.preInst ? (
              <PreBreakoutInstitutional preInst={row.preInst} />
            ) : (
              <div className="text-xs text-muted-foreground/70">無法人籌碼資料</div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <SignalSparkPanel code={row.code} rising={rising} />
            {row.inst ? (
              <div className="space-y-2">
                <InstitutionalFlowPanel inst={row.inst} warnings={row.warnings} />
                {bg ? (
                  <p className="text-xs text-muted-foreground/70">
                    {bg.text}
                    <span className="text-muted-foreground/50">・{bg.hint}</span>
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground/70">無法人籌碼資料</div>
            )}
            {row.factors ? (
              <BreakoutFactorBars
                factors={row.factors}
                rs={row.scores.relativeStrength ?? 0}
              />
            ) : (
              <div className="text-xs text-muted-foreground/70">無突破因子資料</div>
            )}
          </div>
        </div>
      )}

      {row.degraded.length > 0 ? (
        <p className="text-xs text-muted-foreground/70">
          降級項目：{row.degraded.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
