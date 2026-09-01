"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  runSignalScanEod,
  startSignalScan,
  getSignalScanProgress,
  getSignalScanResult,
  getScanMode,
  type SignalScanView,
  type SignalScanProgress,
  type SignalStage,
  type SignalSource,
} from "../../lib/actions/signal-scan";
import { addToWatchlist } from "../../lib/actions/watchlist";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";

// ROADMAP 4.5.3：三分頁（第一根突破 / 冷水區醞釀 / 盤中即時掃描）收斂成單頁 + 階段 filter。
// 「跑掃描」一顆按鈕，由 getScanMode() 決定文案與行為：
//   eod  → 「跑盤後掃描」，按 = runSignalScanEod()（秒級同步）
//   realtime → 「開始盤中掃描」，按 = startSignalScan() + 輪詢 progress.json（背景任務）

type SortDir = "asc" | "desc";

type StageFilter = "all" | SignalStage;

const STAGE_FILTER_LABELS: Record<StageFilter, string> = {
  all: "全部",
  "pre-breakout": "醞釀中",
  "breakout-day": "今日突破",
  extended: "已延伸",
};

const STAGE_LABELS: Record<SignalStage, string> = {
  "pre-breakout": "醞釀中",
  "breakout-day": "今日突破",
  extended: "已延伸",
};

// stage → WatchlistItem.source 映射（schema 的 source enum 不動）
function stageToSource(stage: SignalStage): "breakout" | "accumulation" {
  return stage === "pre-breakout" ? "accumulation" : "breakout";
}

type Row = SignalScanView["results"][number];

function changePercentCell(v: number): React.ReactNode {
  return (
    <span className={v > 0 ? "text-up" : v < 0 ? "text-down" : ""}>{v.toFixed(2)}</span>
  );
}

interface Column {
  key: string;
  label: string;
  get: (r: Row) => number | string;
  render?: (r: Row) => React.ReactNode;
  numeric?: boolean;
}

const columns: Column[] = [
  { key: "rank", label: "排名", get: (r) => r.rank, numeric: true },
  { key: "code", label: "代號", get: (r) => r.code },
  { key: "name", label: "名稱", get: (r) => r.name },
  {
    key: "close",
    label: "收盤/即時",
    get: (r) => r.close,
    render: (r) => (
      <span>
        {r.close.toFixed(2)}
        {r.priceSource === "estimated" ? (
          <span className="ml-1 rounded bg-warning/10 px-1 text-xs text-warning">估</span>
        ) : null}
        {r.warnings.includes("margin-chasing") ? (
          <span
            className="ml-1 rounded bg-destructive/10 px-1 text-xs text-destructive"
            title="margin-chasing：突破當日法人淨賣超 + 本檔融資近期暴增"
          >
            追
          </span>
        ) : null}
      </span>
    ),
    numeric: true,
  },
  {
    key: "changePercent",
    label: "漲跌%",
    get: (r) => r.changePercent,
    render: (r) => changePercentCell(r.changePercent),
    numeric: true,
  },
  {
    key: "stage",
    label: "階段",
    get: (r) => r.stage,
    render: (r) => STAGE_LABELS[r.stage],
  },
  {
    key: "totalScore",
    label: "總分",
    get: (r) => r.totalScore,
    render: (r) => r.totalScore.toFixed(1),
    numeric: true,
  },
  {
    key: "degraded",
    label: "降級項目",
    get: (r) => r.degraded.join(","),
    render: (r) => (r.degraded.length > 0 ? r.degraded.join(", ") : "—"),
  },
];

function scoreEntries(obj: Record<string, number | null>): [string, number | null][] {
  return Object.entries(obj);
}

export function ScreeningPanel() {
  const [mode, setMode] = useState<{ source: SignalSource; latestEodDate: string | null } | null>(
    null,
  );
  // 使用者手動選的模式（預設 = getScanMode() 的判斷結果，可覆蓋）
  const [chosenMode, setChosenMode] = useState<SignalSource | null>(null);

  const [view, setView] = useState<SignalScanView | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // realtime 背景任務 state
  const [progress, setProgress] = useState<SignalScanProgress | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [sortKey, setSortKey] = useState("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addMsg, setAddMsg] = useState<string | null>(null);

  function resetTableState() {
    setStageFilter("all");
    setSortKey("rank");
    setSortDir("asc");
    setExpandedCode(null);
    setSelected(new Set());
    setAddMsg(null);
  }

  // 一進頁問 scan mode（決定 toggle 的預設值；使用者之後可手動切）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await getScanMode();
      if (cancelled) return;
      setMode(m);
      setChosenMode((prev) => prev ?? m.source);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- realtime 輪詢 ----
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const p = await getSignalScanProgress();
      if (!p) return;
      setProgress(p);
      if (p.status === "done") {
        stopPolling();
        setScanBusy(false);
        const res = await getSignalScanResult();
        setView(res);
        resetTableState();
      } else if (p.status === "error") {
        stopPolling();
        setScanBusy(false);
        setError(p.error ?? "掃描失敗");
      }
    }, 2000);
  }, [stopPolling]);

  // 掛載時若 progress.json 還在 running（切走又回來），接管輪詢。
  // 但 running 逾時（子進程死掉、或 CLI 手動跑留下的殘檔）→ 當它不存在，不接管。
  const STALE_MS = 90_000;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await getSignalScanProgress();
      if (cancelled) return;
      const isFresh =
        p?.status === "running" && Date.now() - new Date(p.updatedAt).getTime() < STALE_MS;
      if (p && (p.status !== "running" || isFresh)) setProgress(p);
      if (isFresh) {
        setScanBusy(true);
        startPolling();
      } else if (p?.status === "done" && !view) {
        const res = await getSignalScanResult();
        if (!cancelled) setView(res);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  function runEod() {
    setError(null);
    setAddMsg(null);
    startTransition(async () => {
      try {
        const v = await runSignalScanEod();
        setView(v);
        resetTableState();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  async function runRealtime() {
    setError(null);
    setAddMsg(null);
    const res = await startSignalScan();
    if (!res.started) {
      setError(res.reason ?? "無法啟動掃描");
      return;
    }
    setView(null);
    setProgress(null);
    setScanBusy(true);
    resetTableState();
    startPolling();
  }

  // 按「跑掃描」：依使用者選的模式分派。
  // 選「盤後」但今天 DB 尚無資料（mode.source === "realtime"）→ 實際改跑盤中，UI 另有提示。
  function runScan() {
    if (chosenMode === "eod" && mode?.source === "eod") {
      runEod();
    } else {
      void runRealtime();
    }
  }

  // 選了盤後、但今天還沒有盤後資料 → 會 fallback 到盤中
  const eodFallbackToRealtime = chosenMode === "eod" && mode?.source === "realtime";
  const effectiveMode: SignalSource = chosenMode === "eod" && !eodFallbackToRealtime ? "eod" : "realtime";

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // 全部 filter 時 rank 會有重複（每階段各 1..N）→ 預設用 totalScore 降冪較合理
      setSortDir(key === "totalScore" ? "desc" : "asc");
    }
  }

  const allRows = view?.results ?? [];
  const filteredRows = useMemo(
    () => (stageFilter === "all" ? allRows : allRows.filter((r) => r.stage === stageFilter)),
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
      // rank 在「全部」filter 時同名次多筆 → 次要以 totalScore 降冪
      if (cmp === 0 && sortKey === "rank") cmp = b.totalScore - a.totalScore;
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

  const isRealtime = effectiveMode === "realtime";
  const estimatedCount = view?.stats.estimatedCount ?? 0;

  return (
    <div className="space-y-4">
      {/* 模式切換 + 掃描按鈕 */}
      <div className="flex flex-wrap items-center gap-4">
        {mode === null ? (
          <span className="text-sm text-muted-foreground/70">判斷掃描模式中…</span>
        ) : (
          <>
            <div className="inline-flex overflow-hidden rounded-lg border border-border text-sm">
              {(["eod", "realtime"] as SignalSource[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setChosenMode(m)}
                  disabled={scanBusy || isPending}
                  className={cn(
                    "px-3 py-1.5 disabled:opacity-50",
                    chosenMode === m
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "eod" ? "盤後定案" : "盤中即時"}
                </button>
              ))}
            </div>
            <Button
              onClick={runScan}
              disabled={scanBusy || isPending}
            >
              {scanBusy ? "掃描中…" : isPending ? "計算中…" : "跑掃描"}
            </Button>
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
        ) : scanBusy && progress?.status === "running" ? (
          <span className="text-sm text-muted-foreground">
            {progress.phase === "scoring"
              ? "評分中…"
              : `抓取即時報價中… ${progress.fetchedBatches}/${progress.totalBatches || "?"} 批`}
          </span>
        ) : scanBusy ? (
          <span className="text-sm text-muted-foreground">啟動中…</span>
        ) : null}
      </div>

      {/* 選了盤後但今天還沒有盤後資料 → 會 fallback 盤中 */}
      {eodFallbackToRealtime ? (
        <div className="rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          今天尚無盤後資料（daily-pipeline 未跑或非交易日），按「跑掃描」會改跑盤中即時掃描。
          {mode?.latestEodDate ? `最新盤後資料日：${mode.latestEodDate}。` : null}
        </div>
      ) : null}

      {/* realtime 常駐警語 */}
      {isRealtime ? (
        <div className="rounded border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          盤中即時掃描：對 <code>mis.twse.com.tw</code> 即時報價跑全市場快照，約需 20–30 秒。
          收盤價 / 量 / OHLC / 布林上軌為即時或估計值，<strong>與盤後結果不可直接比較</strong>。
          缺成交價的檔以盤中最高價代入（列尾標「估」）。可切走再回來看進度。
        </div>
      ) : null}

      {/* realtime 進度條 */}
      {scanBusy && progress?.status === "running" && progress.totalBatches > 0 ? (
        <div className="h-2 w-full overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{
              width: `${Math.min(
                100,
                Math.round((progress.fetchedBatches / progress.totalBatches) * 100),
              )}%`,
            }}
          />
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

      {view?.isNonTradingDay ? (
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
          {/* 階段 filter */}
          <div className="flex gap-1 border-b border-border">
            {(Object.keys(STAGE_FILTER_LABELS) as StageFilter[]).map((f) => {
              const count =
                f === "all" ? allRows.length : allRows.filter((r) => r.stage === f).length;
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
                  {STAGE_FILTER_LABELS[f]}（{count}）
                </button>
              );
            })}
          </div>

          {stageFilter === "all" ? (
            <p className="text-xs text-muted-foreground/70">
              「全部」檢視：排名為各階段內名次，不同階段分數語意不同、不可直接比較（預設依總分降冪）。
            </p>
          ) : null}

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
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => toggleSort(c.key)}
                      className={`cursor-pointer select-none px-3 py-2 font-medium ${
                        c.numeric ? "text-right" : "text-left"
                      }`}
                    >
                      {c.label}
                      {sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
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
            <Detail row={row} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Detail({ row }: { row: Row }) {
  const isPre = row.stage === "pre-breakout";
  return (
    <div className="space-y-3">
      {row.warnings.includes("margin-chasing") ? (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          ⚠ margin-chasing：突破當日三大法人（投信＋外資）淨賣超，且本檔融資餘額近期增速排在自己歷史前
          20%——散戶追價、法人可能在派發。系統僅標記，未調整分數，請自行判斷是否排除。
        </div>
      ) : null}
      {row.priceSource === "estimated" ? (
        <div className="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
          此檔盤中無成交價，突破判定基於盤中最高價（保守），K 棒形態項為佔位分。
        </div>
      ) : null}
      <div>
        <div className="mb-1 text-xs font-semibold text-muted-foreground/70">
          {isPre ? "評分明細（醞釀分項）" : "評分明細（突破 8 分項）"}
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-4">
          {scoreEntries(row.scores).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-muted-foreground/70">{k}</span>
              <span className="tabular-nums">{v?.toFixed(1) ?? "—"}</span>
            </div>
          ))}
        </div>
      </div>
      {isPre && row.detail ? (
        <div>
          <div className="mb-1 text-xs font-semibold text-muted-foreground/70">原始指標</div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-3">
            {scoreEntries(row.detail).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-muted-foreground/70">{k}</span>
                <span className="tabular-nums">
                  {v === null ? "—" : Number.isInteger(v) ? v : v.toFixed(3)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
