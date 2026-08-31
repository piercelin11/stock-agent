import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger";

const styles: Record<Variant, string> = {
  primary:
    "bg-blue-600 text-white hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400",
  secondary:
    "border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50",
  danger:
    "border border-rose-800 bg-slate-900 text-rose-400 hover:bg-rose-950 disabled:opacity-50",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles[variant]} ${className}`}
      {...props}
    />
  );
}
