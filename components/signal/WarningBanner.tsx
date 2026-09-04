import { WARNING_LABELS, type WarningKey } from "./labels";
import { cn } from "../../lib/cn";

// PLAN 8 §8.3：命中的 warnings 逐條渲染成提示框。screening 展開列 + watchlist 卡片共用。
// 取代 SignalDetail.tsx 裡寫死的 margin-chasing 紅框——多個 warning 一起渲染，文字 / 底色查
// WARNING_LABELS（中央清單，單一出處）。空陣列 → 不渲染。

const BANNER_CLASS: Record<string, string> = {
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  success: "border-success/30 bg-success/10 text-success",
  muted: "border-border bg-muted text-muted-foreground",
};

export function WarningBanner({ warnings }: { warnings: string[] }) {
  const hits = warnings.filter((w): w is WarningKey => w in WARNING_LABELS);
  if (hits.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {hits.map((key) => {
        const { title, detail, tone } = WARNING_LABELS[key];
        return (
          <div key={key} className={cn("rounded border p-2 text-xs", BANNER_CLASS[tone])}>
            ⚠ {title}：{detail}
          </div>
        );
      })}
    </div>
  );
}
