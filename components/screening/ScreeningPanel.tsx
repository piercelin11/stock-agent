"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  getScreeningContext,
  getScreeningResult,
  type SignalScanView,
  type SignalStage,
} from "../../lib/actions/signal-scan";
import type { DataMode } from "../../lib/data-context";
import { addToWatchlist } from "../../lib/actions/watchlist";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { STAGE_LABELS, STAGE_PILL_CLASS, STAGE_ORDER } from "../signal/labels";
import { SignalDetail } from "./SignalDetail";

// PLAN 4：選股頁拉回跟 watchlist 同一心智模型——進頁問 resolveDataContext()，它說用哪份就用哪份，
// 讀一次就定住（要看最新自己重整）。移除盤後/盤中 toggle、realtime 背景任務（spawn + 輪詢
// progress.json + 接管）、自動刷新（setInterval 60 秒比 timestamp）——這一大坨狀態機是「昨」
// badge 事故的根因。realtime 掃描的背景產出者只剩 intraday-scan.ts（launchd 每 30 分）。
//
// 進頁：getScreeningContext() → 狀態行文案；getScreeningResult() → 依 mode 回結果
//   eod            → 同步跑一次盤後掃描（秒級），使用者不用按任何按鈕。
//   intraday/stale → 讀 launchd 產出的最新 realtime {timestamp}.json。
// 一顆按鈕手動重跑：eod =「重跑盤後掃描」（秒級）；realtime =「立即掃描」（同步卡 UI ~30 秒）。

type SortDir = "asc" | "desc";

// tab 收斂成三階段：StageFilter 直接 = SignalStage。
type StageFilter = SignalStage;

// 順序固定：首次突破 → 延續爆發 → 醞釀中；預設選中「首次突破」。
const STAGE_TABS: SignalStage[] = STAGE_ORDER;

// stage → WatchlistItem.source 映射（schema 的 source enum 不動）
function stageToSource(stage: SignalStage): "breakout" | "accumulation" {
  return stage === "pre-breakout" ? "accumulation" : "breakout";
}

type Row = SignalScanView["results"][number];

// 籌碼 chip（表格「籌碼」欄）：一句話結論。醞釀中階段後端無 inst → 呼叫端不渲染此欄內容。
function instCell(r: Row): React.ReactNode {
  if (!r.inst) return <span className="text-muted-foreground/50">—</span>;
  const marginChasing = r.warnings.includes("margin-chasing");
  const ratioSum = r.inst.trustRatio + r.inst.foreignRatio;
  const todayKnown = r.inst.todayTrustDir !== null && r.inst.todayForeignDir !== null;
  const noData = r.inst.trustRatio === 0 && r.inst.foreignRatio === 0;

  let text: string;
  let cls: string;
  if (marginChasing) {
    text = "融資追價";
    cls = "bg-destructive/10 text-destructive";
  } else if (noData) {
    text = "資料不足";
    cls = "bg-muted text-muted-foreground";
  } else if (ratioSum > 0) {
    text = "法人偏多";
    cls = "bg-success/10 text-success";
  } else if (ratioSum < 0) {
    text = "法人偏空";
    cls = "bg-destructive/10 text-destructive";
  } else {
    text = "中性";
    cls = "bg-muted text-muted-foreground";
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", cls)}>{text}</span>
      {!todayKnown && !noData ? (
        <span
          className="rounded bg-muted px-1 text-xs text-muted-foreground"
          title="盤中未取得今日法人，沿用近日資料"
        >
          昨
        </span>
      ) : null}
    </span>
  );
}

interface Column {
  key: string;
  label: string;
  get: (r: Row) => number | string;
  render?: (r: Row) => React.ReactNode;
  numeric?: boolean;
  sortable?: boolean; // 預設 true；false 時 th 不掛 onClick、不顯箭頭
}

const columns: Column[] = [
  { key: "rank", label: "排名", get: (r) => r.rank, numeric: true },
  { key: "code", label: "代號", get: (r) => r.code },
  { key: "name", label: "名稱", get: (r) => r.name },
  {
    key: "close",
    label: "價格",
    get: (r) => r.close,
    render: (r) => (
      <span>
        {r.close.toFixed(2)}
        {r.priceSource === "estimated" ? (
          <span className="ml-1 rounded bg-warning/10 px-1 text-xs text-warning">估</span>
        ) : null}
      </span>
    ),
    numeric: true,
  },
  {
    key: "changePercent",
    label: "漲跌%",
    get: (r) => r.changePercent,
    render: (r) => (
      <span className={r.changePercent > 0 ? "text-up" : r.changePercent < 0 ? "text-down" : ""}>
        {r.changePercent >= 0 ? "+" : ""}
        {r.changePercent.toFixed(2)}
      </span>
    ),
    numeric: true,
  },
  {
    key: "stage",
    label: "狀態",
    get: (r) => r.stage,
    render: (r) => (
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-xs font-medium",
          STAGE_PILL_CLASS[r.stage],
        )}
      >
        {STAGE_LABELS[r.stage]}
      </span>
    ),
  },
  {
    key: "volumeRatio",
    label: "量增",
    get: (r) => r.volumeRatio ?? -1,
    render: (r) =>
      r.volumeRatio === undefined ? (
        <span className="text-muted-foreground/50">—</span>
      ) : (
        `x${r.volumeRatio.toFixed(1)}`
      ),
    numeric: true,
  },
  {
    key: "inst",
    label: "籌碼",
    get: (r) => (r.inst ? r.inst.trustRatio + r.inst.foreignRatio : 0),
    render: instCell,
    sortable: false,
  },
  {
    key: "totalScore",
    label: "總分",
    get: (r) => r.totalScore,
    render: (r) => r.totalScore.toFixed(1),
    numeric: true,
  },
];

interface ScreeningCtx {
  mode: DataMode;
  asOfDate: string;
  latestEodDate: string | null;
  hasScan: boolean;
}

export function ScreeningPanel() {
  const [ctx, setCtx] = useState<ScreeningCtx | null>(null);
  const [view, setView] = useState<SignalScanView | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [stageFilter, setStageFilter] = useState<StageFilter>("breakout-day");
  const [sortKey, setSortKey] = useState("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addMsg, setAddMsg] = useState<string | null>(null);

  function resetTableState() {
    setStageFilter("breakout-day");
    setSortKey("rank");
    setSortDir("asc");
    setExpandedCode(null);
    setSelected(new Set());
    setAddMsg(null);
  }

  // 進頁載入：問 context → 依 mode 拿結果（eod 同步跑、intraday/stale 讀最新 realtime JSON）。
  // 讀一次就定住，不自動輪詢（跟 watchlist 一致）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getScreeningContext();
        if (cancelled) return;
        setCtx(c);
        const res = await getScreeningResult();
        if (cancelled) return;
        setView(res);
        resetTableState();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 「跑掃描」按鈕：eod → 重跑盤後（秒級）；intraday/stale → 立即掃描（同步卡 UI ~30 秒）。
  function rerun() {
    if (!ctx) return;
    setError(null);
    setAddMsg(null);
    const force = ctx.mode === "eod" ? "eod" : "realtime";
    startTransition(async () => {
      try {
        const res = await getScreeningResult({ force });
        setView(res);
        resetTableState();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function toggleSort(key: string) {
    const col = columns.find((c) => c.key === key);
    if (col && col.sortable === false) return;
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "totalScore" ? "desc" : "asc");
    }
  }

  const allRows = view?.results ?? [];
  const filteredRows = useMemo(
    () => allRows.filter((r) => r.stage === stageFilter),
    [allRows, stageFilter],
  );

  const sortedRows = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filteredRows;
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      let cmp: number;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filteredRows, sortKey, sortDir]);

  function toggleSelect(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function addSelected() {
    if (selected.size === 0) return;
    setAddMsg(null);
    startTransition(async () => {
      try {
        // 每檔用自己的 stage 對應 source；混階段時逐 source 分組呼叫。
        const bySource = new Map<"breakout" | "accumulation", string[]>();
        for (const code of selected) {
          const row = allRows.find((r) => r.code === code);
          if (!row) continue;
          const src = stageToSource(row.stage);
          const list = bySource.get(src) ?? [];
          list.push(code);
          bySource.set(src, list);
        }
        let added = 0;
        let skipped = 0;
        for (const [src, codes] of bySource) {
          const res = await addToWatchlist({ codes, source: src });
          added += res.added;
          skipped += res.skipped;
        }
        setAddMsg(`已加入 ${added} 檔，略過 ${skipped} 檔（已在清單）`);
        setSelected(new Set());
      } catch (e) {
        setAddMsg(`加入失敗：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  const estimatedCount = view?.stats.estimatedCount ?? 0;
  const isRealtimeMode = ctx !== null && ctx.mode !== "eod";

  // 狀態行文案（§1）
  function statusLine(): string {
    if (!ctx) return "";
    if (ctx.mode === "eod") return `盤後定案 · ${ctx.asOfDate}`;
    if (ctx.mode === "intraday")
      return `盤中即時 · 背景每 30 分更新，重整頁面看最新 · 截至 ${ctx.asOfDate}`;
    // stale
    return ctx.hasScan
      ? `盤後未跑，顯示最近一次掃描（${ctx.asOfDate}）`
      : "尚無掃描結果";
  }

  const rerunLabel = ctx?.mode === "eod" ? "重跑盤後掃描" : "立即掃描";

  return (
    <div className="space-y-4">
      {/* 狀態行 + 手動重跑按鈕 */}
      <div className="flex flex-wrap items-center gap-4">
        {loading || !ctx ? (
          <span className="text-sm text-muted-foreground/70">載入中…</span>
        ) : (
          <>
            <Button onClick={rerun} disabled={isPending}>
              {isPending
                ? isRealtimeMode
                  ? "掃描中…（約 30 秒）"
                  : "計算中…"
                : rerunLabel}
            </Button>
            <span className="text-sm text-muted-foreground">{statusLine()}</span>
          </>
        )}

        {view ? (
          <span className="text-sm text-muted-foreground">
            {view.source === "eod" ? "交易日" : "查詢時間"}：
            {view.source === "eod"
              ? view.date
              : new Date(view.queriedAt).toLocaleString("zh-TW", { hour12: false })}
            {" · "}
            全市場 {view.stats.totalStocks} · 過 gate {view.stats.passedGate} · 醞釀{" "}
            {view.stats.preBreakout} · 突破 {view.stats.breakoutDay} · 延伸 {view.stats.extended}
            {estimatedCount > 0 ? (
              <span className="ml-2 rounded bg-warning/10 px-1 text-xs text-warning">
                估 {estimatedCount} 檔
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      {/* realtime 常駐警語 */}
      {isRealtimeMode ? (
        <div className="rounded border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          盤中即時掃描每 30 分由背景排程（launchd）自動跑，對 <code>mis.twse.com.tw</code>{" "}
          即時報價跑全市場快照。收盤價 / 量 / OHLC / 布林上軌為即時或估計值，
          <strong>與盤後結果不可直接比較</strong>。缺成交價的檔以盤中最高價代入（列尾標「估」）。
          按「立即掃描」會現場同步跑一次，約需 20–30 秒。
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && view.warnings.length > 0 ? (
        <div className="rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <ul className="list-disc pl-5">
            {view.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!loading && !view ? (
        <div className="rounded border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          尚無盤中掃描結果——稍候（背景每 30 分自動跑）或按「立即掃描」。
        </div>
      ) : view?.isNonTradingDay ? (
        <div className="rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          最新交易日尚無資料，請先跑 daily-pipeline。
        </div>
      ) : view && allRows.length === 0 ? (
        <div className="rounded border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          無符合條件的候選股。
        </div>
      ) : null}

      {allRows.length > 0 ? (
        <>
          {/* 階段 filter（三 tab，各 tab 內 rank 是該階段內名次） */}
          <div className="flex gap-1 border-b border-border">
            {STAGE_TABS.map((f) => {
              const count = allRows.filter((r) => r.stage === f).length;
              return (
                <button
                  key={f}
                  onClick={() => {
                    setStageFilter(f);
                    setExpandedCode(null);
                  }}
                  className={cn(
                    "px-4 py-2 text-sm font-medium",
                    stageFilter === f
                      ? "border-b-2 border-primary text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground",
                  )}
                >
                  {STAGE_LABELS[f]}（{count}）
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              onClick={addSelected}
              disabled={isPending || selected.size === 0}
            >
              加入觀察清單（{selected.size}）
            </Button>
            {addMsg ? <span className="text-sm text-muted-foreground">{addMsg}</span> : null}
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2"></th>
                  {columns.map((c) => {
                    const sortable = c.sortable !== false;
                    return (
                      <th
                        key={c.key}
                        onClick={sortable ? () => toggleSort(c.key) : undefined}
                        className={cn(
                          "select-none px-3 py-2 font-medium",
                          c.numeric ? "text-right" : "text-left",
                          sortable && "cursor-pointer",
                        )}
                      >
                        {c.label}
                        {sortable && sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const isExpanded = expandedCode === r.code;
                  return (
                    <RowGroup
                      key={r.code}
                      row={r}
                      isExpanded={isExpanded}
                      isSelected={selected.has(r.code)}
                      onToggleExpand={() => setExpandedCode(isExpanded ? null : r.code)}
                      onToggleSelect={() => toggleSelect(r.code)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

function RowGroup({
  row,
  isExpanded,
  isSelected,
  onToggleExpand,
  onToggleSelect,
}: {
  row: Row;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
}) {
  return (
    <>
      <tr
        className={cn(
          "border-t border-border hover:bg-muted/50",
          isSelected && "bg-primary/10",
          row.priceSource === "estimated" && "text-muted-foreground",
        )}
      >
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            aria-label={`選取 ${row.code}`}
          />
        </td>
        {columns.map((c) => (
          <td
            key={c.key}
            onClick={onToggleExpand}
            className={`cursor-pointer px-3 py-2 tabular-nums ${
              c.numeric ? "text-right" : "text-left"
            }`}
          >
            {c.render ? c.render(row) : c.get(row)}
          </td>
        ))}
      </tr>
      {isExpanded ? (
        <tr className="bg-muted/50">
          <td colSpan={columns.length + 1} className="px-6 py-3">
            <SignalDetail row={row} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
