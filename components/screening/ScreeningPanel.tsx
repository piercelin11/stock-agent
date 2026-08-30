"use client";

import { useMemo, useState, useTransition } from "react";
import {
  runScreening,
  type ScreeningResult,
  type ScreeningStrategy,
  type BreakoutRow,
  type AccumulationRow,
} from "../../lib/actions/screening";
import { addToWatchlist } from "../../lib/actions/watchlist";
import { Button } from "../ui/Button";

type SortDir = "asc" | "desc";

const STRATEGY_LABELS: Record<ScreeningStrategy, string> = {
  breakout: "第一根突破",
  accumulation: "冷水區醞釀",
};

interface Column<Row> {
  key: string;
  label: string;
  get: (r: Row) => number | string;
  render?: (r: Row) => React.ReactNode;
  numeric?: boolean;
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
    render: (r) => (
      <span
        className={
          r.changePercent > 0
            ? "text-red-600"
            : r.changePercent < 0
              ? "text-green-600"
              : ""
        }
      >
        {r.changePercent.toFixed(2)}
      </span>
    ),
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

function scoreEntries(obj: Record<string, number | null>): [string, number | null][] {
  return Object.entries(obj);
}

export function ScreeningPanel() {
  const [strategy, setStrategy] = useState<ScreeningStrategy>("breakout");
  // 各策略獨立保留結果
  const [results, setResults] = useState<
    Partial<Record<ScreeningStrategy, ScreeningResult>>
  >({});
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addMsg, setAddMsg] = useState<string | null>(null);

  const result = results[strategy];

  function switchStrategy(next: ScreeningStrategy) {
    setStrategy(next);
    setSortKey("rank");
    setSortDir("asc");
    setExpandedCode(null);
    setSelected(new Set());
    setAddMsg(null);
    setError(null);
  }

  function run() {
    setError(null);
    setAddMsg(null);
    startTransition(async () => {
      try {
        const r = await runScreening({ strategy });
        setResults((prev) => ({ ...prev, [strategy]: r }));
        setSelected(new Set());
        setExpandedCode(null);
        setSortKey("rank");
        setSortDir("asc");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const rows: (BreakoutRow | AccumulationRow)[] =
    (strategy === "breakout"
      ? result?.breakoutRows
      : result?.accumulationRows) ?? [];

  const columns =
    strategy === "breakout"
      ? (breakoutColumns as Column<BreakoutRow | AccumulationRow>[])
      : (accumulationColumns as Column<BreakoutRow | AccumulationRow>[]);

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
          source: strategy,
        });
        setAddMsg(`已加入 ${res.added} 檔，略過 ${res.skipped} 檔（已在清單）`);
        setSelected(new Set());
      } catch (e) {
        setAddMsg(
          `加入失敗：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* 分頁 */}
      <div className="flex gap-1 border-b border-slate-200">
        {(Object.keys(STRATEGY_LABELS) as ScreeningStrategy[]).map((s) => (
          <button
            key={s}
            onClick={() => switchStrategy(s)}
            className={`px-4 py-2 text-sm font-medium ${
              strategy === s
                ? "border-b-2 border-slate-900 text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {STRATEGY_LABELS[s]}
          </button>
        ))}
      </div>

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
                      strategy={strategy}
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
  strategy,
  isExpanded,
  isSelected,
  onToggleExpand,
  onToggleSelect,
}: {
  row: BreakoutRow | AccumulationRow;
  columns: Column<BreakoutRow | AccumulationRow>[];
  strategy: ScreeningStrategy;
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
            <Detail row={row} strategy={strategy} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Detail({
  row,
  strategy,
}: {
  row: BreakoutRow | AccumulationRow;
  strategy: ScreeningStrategy;
}) {
  if (strategy === "breakout") {
    const r = row as BreakoutRow;
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
