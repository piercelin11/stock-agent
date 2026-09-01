import { LightningBoltIcon, ClockIcon } from "@radix-ui/react-icons";
import { cn } from "../../lib/cn";

// 卡片左上角資料新鮮度標示（PLAN §2）。
//   fresh = DB 最新交易日 == 台北今日 → ⚡ 閃電（最新定案資料）
//   !fresh → 🕐 時鐘（非當日：DB 昨收 or 盤中即時值，日期仍非今日交易日）

export function FreshnessBadge({ fresh }: { fresh: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-full",
        fresh ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
      )}
      title={fresh ? "當日最新資料" : "非當日資料（昨收或盤中即時值）"}
    >
      {fresh ? (
        <LightningBoltIcon className="h-3.5 w-3.5" />
      ) : (
        <ClockIcon className="h-3.5 w-3.5" />
      )}
    </span>
  );
}
