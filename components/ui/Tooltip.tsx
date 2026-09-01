"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../lib/cn";

// @radix-ui/react-tooltip 的手刻薄包裝（照 Button.tsx 用專案 token 的模式，不引入 shadcn）。
// hover（桌機）/ tap（手機）觸發；Portal + 自動 side 翻轉處理卡片邊緣碰撞。
// content 可傳多行 ReactNode（幾個 <div>）或帶換行的字串（配 whitespace-pre-line）。

export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className={cn(
              "z-50 max-w-[16rem] whitespace-pre-line rounded-md border border-border bg-card px-3 py-2 text-xs leading-relaxed text-card-foreground shadow-md",
              className,
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-card" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
