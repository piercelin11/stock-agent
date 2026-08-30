"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  runScreening,
  type ScreeningResult,
  type ScreeningStrategy,
  type BreakoutRow,
  type AccumulationRow,
} from "../../lib/actions/screening";
import {
  startIntradayScan,
  getIntradayProgress,
  getIntradayResult,
  type IntradayProgress,
  type IntradayResult,
  type IntradayRow,
} from "../../lib/actions/intraday";
import { addToWatchlist } from "../../lib/actions/watchlist";
import { Button } from "../ui/Button";

type SortDir = "asc" | "desc";

// tab 值：intraday 是元件內 local 型別，不動 runScreening 的 ScreeningStrategy。
type Tab = ScreeningStrategy | "intraday";

const TAB_LABELS: Record<Tab, string> = {
  breakout: "第一根突破",
  accumulation: "冷水區醞釀",
  intraday: "盤中即時掃描",
};

interface Column<Row> {
  key: string;
  label: string;
  get: (r: Row) => number | string;
  render?: (r: Row) => React.ReactNode;
  numeric?: boolean;
}

function changePercentCell(v: number): React.ReactNode {
  return (
    <span className={v > 0 ? "text-red-600" : v < 0 ? "text-green-600" : ""}>
      {v.toFixed(2)}
    </span>
  );
}

const breakoutColumns: Column<BreakoutRow>[] = [
  { key: "rank", label: "排名", get: (r) => r.rank, numeric: true },
  { key: "code", label: "代號", get: (r) => r.code },
  { key: "name", label: "名稱", get: (r) => r.name },
  {
    key: "close",
    label: "收盤",
    get: (r) => r.close,
    render: (r) => r.close.toFixed(2),
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
    key: "volumeRatio",
    label: "量比",
    get: (r) => r.volumeRatio,
    render: (r) => r.volumeRatio.toFixed(2),
    numeric: true,
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

const accumulationColumns: Column<AccumulationRow>[] = [
  { key: "rank", label: "排名", get: (r) => r.rank, numeric: true },
  { key: "code", label: "代號", get: (r) => r.code },
  { key: "name", label: "名稱", get: (r) => r.name },
  {
    key: "close",
    label: "收盤",
    get: (r) => r.close,
    render: (r) => r.close.toFixed(2),
    numeric: true,
  },
  {
    key: "chipScore",
    label: "籌碼分",
    get: (r) => r.chipScore,
    render: (r) => r.chipScore.toFixed(1),
    numeric: true,
  },
  {
    key: "readinessCoef",
    label: "就緒係數",
    get: (r) => r.readinessCoef,
    render: (r) => r.readinessCoef.toFixed(3),
    numeric: true,
  },
  {
    key: "finalScore",
    label: "最終分",
    get: (r) => r.finalScore,
    render: (r) => r.finalScore.toFixed(1),
    numeric: true,
  },
  {
    key: "degraded",
    label: "降級項目",
    get: (r) => r.degraded.join(","),
    render: (r) => (r.degraded.length > 0 ? r.degraded.join(", ") : "—"),
  },
];

// 盤中 rows 跟 breakout rows 幾乎一樣，另開一份標題文案不同的 columns，
// 但 Column 型別、排序邏輯、<Detail> 展開（吃 scores）、勾選加入全部共用。
const intradayColumns: Column<IntradayRow>[] = [
  { key: "rank", label: "排名", get: (r) => r.rank, numeric: true },
  { key: "code", label: "代號", get: (r) => r.code },
  { key: "name", label: "名稱", get: (r) => r.name },
  {
    key: "price",
    label: "即時價",
    get: (r) => r.price,
    render: (r) => r.price.toFixed(2),
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
    key: "volumeRatio",
    label: "量比(估)",
    get: (r) => r.volumeRatio,
    render: (r) => r.volumeRatio.toFixed(2),
    numeric: true,
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

type AnyRow = BreakoutRow | AccumulationRow | IntradayRow;

function scoreEntries(obj: Record<string, number | null>): [string, number | null][] {
  return Object.entries(obj);
}

export function ScreeningPanel() {
  const [tab, setTab] = useState<Tab>("breakout");

  // 盤後兩策略：各自獨立保留結果
  const [results, setResults] = useState<
    Partial<Record<ScreeningStrategy, ScreeningResult>>
  >({});
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 盤中專屬 state（不放進 results，形狀不同）
  const [intradayProgress, setIntradayProgress] = useState<IntradayProgress | null>(null);
  const [intradayResult, setIntradayResult] = useState<IntradayResult | null>(null);
  const [intradayError, setIntradayError] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [sortKey, setSortKey] = useState("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addMsg, setAddMsg] = useState<string | null>(null);

  const result = tab === "intraday" ? undefined : results[tab];

  function resetTableState() {
    setSortKey("rank");
    setSortDir("asc");
    setExpandedCode(null);
    setSelected(new Set());
    setAddMsg(null);
  }

  function switchTab(next: Tab) {
    setTab(next);
    resetTableState();
    setError(null);
  }

  function run() {
    if (tab === "intraday") return;
    setError(null);
    setAddMsg(null);
    const strategy = tab;
    startTransition(async () => {
      try {
        const r = await runScreening({ strategy });
        setResults((prev) => ({ ...prev, [strategy]: r }));
        resetTableState();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  // ---- 盤中掃描：輪詢 ----
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const p = await getIntradayProgress();
      if (!p) return; // progress.json 還沒出現，維持「啟動中…」
      setIntradayProgress(p);
      if (p.status === "done") {
        stopPolling();
        setScanBusy(false);
        const res = await getIntradayResult();
        setIntradayResult(res);
        resetTableState();
      } else if (p.status === "error") {
        stopPolling();
        setScanBusy(false);
        setIntradayError(p.error ?? "掃描失敗");
      }
    }, 2000);
  }, [stopPolling]);

  // 切到 intraday tab 時，若 progress.json 還在 running 就重新開始輪詢（切走只停輪詢、沒中斷子進程）。
  useEffect(() => {
    if (tab !== "intraday") {
      stopPolling();
      return;
    }
    let cancelled = false;
    (async () => {
      const p = await getIntradayProgress();
      if (cancelled) return;
      if (p) setIntradayProgress(p);
      if (p?.status === "running") {
        setScanBusy(true);
        startPolling();
      } else if (p?.status === "done" && !intradayResult) {
        const res = await getIntradayResult();
        if (!cancelled) setIntradayResult(res);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => stopPolling, [stopPolling]);

  async function startScan() {
    setIntradayError(null);
    setAddMsg(null);
    const res = await startIntradayScan();
    if (!res.started) {
      setIntradayError(res.reason ?? "無法啟動掃描");
      return;
    }
    setIntradayResult(null);
    setIntradayProgress(null);
    setScanBusy(true);
    resetTableState();
    startPolling();
  }

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const rows: AnyRow[] =
    tab === "intraday"
      ? (intradayResult?.rows ?? [])
      : ((tab === "breakout"
          ? result?.breakoutRows
          : result?.accumulationRows) ?? []);

  const columns = (
    tab === "breakout"
      ? breakoutColumns
      : tab === "accumulation"
        ? accumulationColumns
        : intradayColumns
  ) as Column<AnyRow>[];

  const sortedRows = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      let cmp: number;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, columns, sortKey, sortDir]);

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
        const res = await addToWatchlist({
          codes: [...selected],
          source: tab,
        });
        setAddMsg(`已加入 ${res.added} 檔，略過 ${res.skipped} 檔（已在清單）`);
        setSelected(new Set());
      } catch (e) {
        setAddMsg(`加入失敗：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  const isIntraday = tab === "intraday";
  const intradayDone = isIntraday && intradayProgress?.status === "done";

  return (
    <div className="space-y-4">
      {/* 分頁 */}
      <div className="flex gap-1 border-b border-slate-200">
        {(Object.keys(TAB_LABELS) as Tab[]).map((s) => (
          <button
            key={s}
            onClick={() => switchTab(s)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === s
                ? "border-b-2 border-slate-900 text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {TAB_LABELS[s]}
          </button>
        ))}
      </div>

      {isIntraday ? (
        <>
          {/* 常駐警語 */}
          <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            盤中即時掃描：對 <code>mis.twse.com.tw</code> 即時報價跑全市場快照，約需
            20–30 秒。收盤價 / 量 / OHLC / 布林上軌為即時或估計值，
            <strong>與盤後結果不可直接比較</strong>。僅盤中 09:00–13:30 有效。可切走再回來看進度。
          </div>

          <div className="flex items-center gap-4">
            <Button onClick={startScan} disabled={scanBusy}>
              {scanBusy ? "掃描中…" : "開始掃描"}
            </Button>
            {scanBusy && intradayProgress?.status === "running" ? (
              <span className="text-sm text-slate-500">
                {intradayProgress.phase === "scoring"
                  ? "評分中…"
                  : `抓取即時報價中… ${intradayProgress.fetchedBatches}/${
                      intradayProgress.totalBatches || "?"
                    } 批`}
              </span>
            ) : scanBusy ? (
              <span className="text-sm text-slate-500">啟動中…</span>
            ) : intradayResult ? (
              <span className="text-sm text-slate-500">
                查詢時間：{new Date(intradayResult.queriedAt).toLocaleString("zh-TW", { hour12: false })}
                {" · "}
                {Object.entries(intradayResult.stats)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")}
              </span>
            ) : null}
          </div>

          {/* 進度條 */}
          {scanBusy && intradayProgress?.status === "running" && intradayProgress.totalBatches > 0 ? (
            <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
              <div
                className="h-full bg-slate-900 transition-all"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round(
                      (intradayProgress.fetchedBatches / intradayProgress.totalBatches) * 100,
                    ),
                  )}%`,
                }}
              />
            </div>
          ) : null}

          {intradayError ? (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {intradayError}
            </div>
          ) : null}

          {intradayResult && intradayResult.warnings.length > 0 ? (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              <ul className="list-disc pl-5">
                {intradayResult.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {intradayDone && rows.length === 0 ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              本次快照無符合條件的候選股。
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex items-center gap-4">
            <Button onClick={run} disabled={isPending}>
              {isPending ? "計算中…" : "跑選股"}
            </Button>
            {result?.date ? (
              <span className="text-sm text-slate-500">
                交易日：{result.date}
                {result.stats
                  ? " · " +
                    Object.entries(result.stats)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" ")
                  : null}
              </span>
            ) : null}
          </div>

          {error ? (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {result?.isNonTradingDay ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              最新交易日尚無資料，請先跑 daily-pipeline。
            </div>
          ) : result && rows.length === 0 ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              無符合條件的候選股。
            </div>
          ) : null}
        </>
      )}

      {rows.length > 0 ? (
        <>
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              onClick={addSelected}
              disabled={isPending || selected.size === 0}
            >
              加入觀察清單（{selected.size}）
            </Button>
            {addMsg ? (
              <span className="text-sm text-slate-600">{addMsg}</span>
            ) : null}
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
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
                      {sortKey === c.key
                        ? sortDir === "asc"
                          ? " ▲"
                          : " ▼"
                        : ""}
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
                      columns={columns}
                      tab={tab}
                      isExpanded={isExpanded}
                      isSelected={selected.has(r.code)}
                      onToggleExpand={() =>
                        setExpandedCode(isExpanded ? null : r.code)
                      }
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
  columns,
  tab,
  isExpanded,
  isSelected,
  onToggleExpand,
  onToggleSelect,
}: {
  row: AnyRow;
  columns: Column<AnyRow>[];
  tab: Tab;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
}) {
  return (
    <>
      <tr className="border-t border-slate-100 hover:bg-slate-50">
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
        <tr className="bg-slate-50">
          <td colSpan={columns.length + 1} className="px-6 py-3">
            <Detail row={row} tab={tab} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Detail({ row, tab }: { row: AnyRow; tab: Tab }) {
  // breakout 與 intraday 共用同一套 7 分項渲染（scores 同形狀）。
  if (tab === "breakout" || tab === "intraday") {
    const r = row as BreakoutRow | IntradayRow;
    return (
      <div>
        <div className="mb-1 text-xs font-semibold text-slate-500">
          評分明細（7 分項）
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-4">
          {scoreEntries(r.scores).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-slate-500">{k}</span>
              <span className="tabular-nums">{v?.toFixed(1) ?? "—"}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const r = row as AccumulationRow;
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs font-semibold text-slate-500">
          分項（4 項）
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-4">
          {scoreEntries(r.breakdown).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-slate-500">{k}</span>
              <span className="tabular-nums">{v?.toFixed(1) ?? "—"}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold text-slate-500">
          原始指標（6 項）
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-3">
          {scoreEntries(r.detail).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-slate-500">{k}</span>
              <span className="tabular-nums">
                {v === null
                  ? "—"
                  : Number.isInteger(v)
                    ? v
                    : v.toFixed(3)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
