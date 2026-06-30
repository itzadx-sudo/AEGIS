import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium font-sans transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // Subtle default button
        default:
          "border border-border bg-surface-2 text-ink-dim hover:bg-surface hover:border-crimson hover:text-crimson-light hover:shadow-[0_8px_22px_rgba(255,59,74,0.2)]",
        // Neutral, elevated button
        primary:
          "border border-strong bg-surface text-white shadow-[0_16px_36px_rgba(0,0,0,0.5)] hover:border-crimson hover:shadow-[0_16px_36px_rgba(0,0,0,0.5),0_0_0_1px_var(--crimson)_inset]",
        // Brand call-to-action — smooth, faint gradient (styled in .btn-sea)
        sea: "btn-sea text-white",
        ghost: "text-ink-dim hover:bg-white/5 hover:text-white",
      },
      size: {
        default: "px-[19px] py-2.5 text-[12.5px]",
        sm: "px-[13px] py-[7px] text-[11.5px]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const Button = React.forwardRef(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
