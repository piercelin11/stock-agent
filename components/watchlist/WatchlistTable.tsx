"use client";

import { useState, useTransition } from "react";
import {
  removeFromWatchlist,
  updateWatchlistItem,
  type WatchlistRow,
} from "../../lib/actions/watchlist";
import { Button } from "../ui/Button";

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits);
}

// *NetBuy 為股數 → 顯示「張」（/1000）
function lots(n: number | null): string {
  return n === null ? "—" : Math.round(n / 1000).toLocaleString();
}

function changePercent(row: WatchlistRow): number | null {
  if (!row.quote) return null;
  const prevClose = row.quote.close - row.quote.change;
  return prevClose > 0 ? (row.quote.change / prevClose) * 100 : 0;
}

export function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  return (
    <div className="space-y-4">
      {rows.map((row) => (
        <WatchlistCard key={row.stockCode} row={row} />
      ))}
    </div>
  );
}

function WatchlistCard({ row }: { row: WatchlistRow }) {
  const [isPending, startTransition] = useTransition();
  const cp = changePercent(row);

  function update(patch: Parameters<typeof updateWatchlistItem>[0]) {
    startTransition(async () => {
      await updateWatchlistItem(patch);
    });
  }

  function remove() {
    startTransition(async () => {
      await removeFromWatchlist({ code: row.stockCode });
    });
  }

  // 受控輸入的本地暫存（onBlur 才寫回）
  const [buyPrice, setBuyPrice] = useState(
    row.buyPrice === null ? "" : String(row.buyPrice),
  );
  const [buyDate, setBuyDate] = useState(row.buyDate ?? "");
  const [targetPrice, setTargetPrice] = useState(
    row.targetPrice === null ? "" : String(row.targetPrice),
  );
  const [stopLossPrice, setStopLossPrice] = useState(
    row.stopLossPrice === null ? "" : String(row.stopLossPrice),
  );
  const [notes, setNotes] = useState(row.notes ?? "");

  const numOrNull = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      {/* 標頭 */}
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-lg font-semibold text-foreground">
          {row.stockCode}
        </span>
        <span className="text-foreground/80">{row.name}</span>
        {row.source ? (
          <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {row.source}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">加入於 {row.addedAt}</span>
        <div className="ml-auto">
          <Button variant="danger" onClick={remove} disabled={isPending}>
            移除
          </Button>
        </div>
      </div>

      {/* 當日快照 */}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <SnapshotBlock title="報價" date={row.quote?.date}>
          {row.quote ? (
            <>
              <Field label="收盤" value={fmt(row.quote.close)} />
              <Field
                label="漲跌%"
                value={
                  <span
                    className={
                      cp && cp > 0
                        ? "text-up"
                        : cp && cp < 0
                          ? "text-down"
                          : ""
                    }
                  >
                    {cp === null ? "—" : cp.toFixed(2)}
                  </span>
                }
              />
              <Field label="量（張）" value={lots(row.quote.volume)} />
            </>
          ) : (
            <span className="text-xs text-muted-foreground">無資料</span>
          )}
        </SnapshotBlock>

        <SnapshotBlock title="技術" date={row.indicator?.date}>
          {row.indicator ? (
            <>
              <Field label="MA20" value={fmt(row.indicator.ma20)} />
              <Field label="MA60" value={fmt(row.indicator.ma60)} />
              <Field
                label="布林上軌"
                value={fmt(row.indicator.bollingerUpper)}
              />
              <Field
                label="布林下軌"
                value={fmt(row.indicator.bollingerLower)}
              />
              <Field label="RSI14" value={fmt(row.indicator.rsi14, 1)} />
              <Field
                label="MACD"
                value={row.indicator.macdStatus ?? "—"}
              />
            </>
          ) : (
            <span className="text-xs text-muted-foreground">無資料</span>
          )}
        </SnapshotBlock>

        <SnapshotBlock title="籌碼（張）" date={row.institutional?.date}>
          {row.institutional ? (
            <>
              <Field
                label="外資"
                value={lots(row.institutional.foreignNetBuy)}
              />
              <Field
                label="投信"
                value={lots(row.institutional.investmentTrustNetBuy)}
              />
              <Field
                label="自營"
                value={lots(row.institutional.dealerNetBuy)}
              />
            </>
          ) : (
            <span className="text-xs text-muted-foreground">無資料</span>
          )}
        </SnapshotBlock>
      </div>

      {/* 買入狀態區 */}
      <div className="mt-4 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={row.isPurchased}
            disabled={isPending}
            onChange={(e) =>
              update({ code: row.stockCode, isPurchased: e.target.checked })
            }
          />
          已進場
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {row.isPurchased ? (
            <>
              <InputField
                label="買入均價"
                value={buyPrice}
                onChange={setBuyPrice}
                onBlur={() =>
                  update({
                    code: row.stockCode,
                    buyPrice: numOrNull(buyPrice),
                  })
                }
                disabled={isPending}
              />
              <InputField
                label="買入日"
                type="date"
                value={buyDate}
                onChange={setBuyDate}
                onBlur={() =>
                  update({
                    code: row.stockCode,
                    buyDate: buyDate.trim() === "" ? null : buyDate,
                  })
                }
                disabled={isPending}
              />
              <InputField
                label="目標價"
                value={targetPrice}
                onChange={setTargetPrice}
                onBlur={() =>
                  update({
                    code: row.stockCode,
                    targetPrice: numOrNull(targetPrice),
                  })
                }
                disabled={isPending}
              />
              <InputField
                label="停損價"
                value={stopLossPrice}
                onChange={setStopLossPrice}
                onBlur={() =>
                  update({
                    code: row.stockCode,
                    stopLossPrice: numOrNull(stopLossPrice),
                  })
                }
                disabled={isPending}
              />
            </>
          ) : (
            <InputField
              label="目標買價"
              value={targetPrice}
              onChange={setTargetPrice}
              onBlur={() =>
                update({
                  code: row.stockCode,
                  targetPrice: numOrNull(targetPrice),
                })
              }
              disabled={isPending}
            />
          )}
        </div>

        <div className="mt-3">
          <label className="text-xs text-muted-foreground">備註</label>
          <textarea
            className="mt-1 w-full rounded border border-input bg-transparent px-2 py-1 text-sm text-foreground"
            rows={2}
            value={notes}
            disabled={isPending}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() =>
              update({
                code: row.stockCode,
                notes: notes.trim() === "" ? null : notes,
              })
            }
          />
        </div>
      </div>
    </div>
  );
}

function SnapshotBlock({
  title,
  date,
  children,
}: {
  title: string;
  date?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border bg-muted/50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-semibold text-muted-foreground/70">{title}</span>
        <span className="text-xs text-muted-foreground">{date ?? "—"}</span>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground/70">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  onBlur,
  type = "text",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <input
        type={type}
        inputMode={type === "text" ? "decimal" : undefined}
        className="mt-1 w-full rounded border border-input bg-transparent px-2 py-1 text-sm text-foreground tabular-nums"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </div>
  );
}
