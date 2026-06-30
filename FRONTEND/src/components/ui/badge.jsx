import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full font-semibold whitespace-nowrap",
  {
    variants: {
      variant: {
        vh: "bg-[var(--alarm-pale)] text-alarm-light",
        h: "bg-[var(--ember-pale)] text-ember",
        m: "bg-[var(--gold-pale)] text-gold",
        mn: "bg-[var(--sand-pale)] text-sand",
        l: "bg-[var(--slate-pale)] text-slate",
        ok: "bg-[var(--slate-pale)] text-[#C2CCD6]",
        wait: "bg-[var(--gold-pale)] text-gold",
        done: "bg-[var(--slate-pale)] text-[#C2CCD6]",
        draft:
          "bg-void-2 text-ink-faint border border-border",
        count: "bg-[var(--crimson-pale)] text-crimson-light font-mono",
      },
      size: {
        default: "px-[11px] py-1 text-[11px]",
        sm: "px-[9px] py-0.5 text-[11px]",
        pill: "px-[11px] py-1 text-[10px]",
      },
    },
    defaultVariants: {
      variant: "vh",
      size: "default",
    },
  }
);

function Badge({ className, variant, size, ...props }) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
