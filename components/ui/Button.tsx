import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

// quick-talk 式：cva 管 variant 維度。目前只有 variant（無 size），要加 size 再擴。
const buttonVariants = cva(
  "rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary:
          "border border-border bg-muted text-foreground/80 hover:bg-muted/70",
        danger:
          "bg-destructive/10 text-destructive hover:bg-destructive/20",
      },
    },
    defaultVariants: {
      variant: "primary",
    },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ variant, className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}
