export function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      {title ? (
        <h2 className="mb-3 text-sm font-semibold text-slate-500">{title}</h2>
      ) : null}
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value}
      </div>
    </div>
  );
}
