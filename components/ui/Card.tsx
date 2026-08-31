export function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
      {title ? (
        <h2 className="mb-3 text-base font-semibold text-slate-500">{title}</h2>
      ) : null}
      {children}
    </div>
  );
}

/**
 * 全站「次級說明文字」的單一出處（卡片欄位名、燈號 label、分數 label…）。
 * 要整體調整這類字的大小 / 顏色，只改這裡。
 */
export function FieldLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`text-sm text-slate-400 ${className}`}>{children}</span>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-100">
        {value}
      </div>
    </div>
  );
}
