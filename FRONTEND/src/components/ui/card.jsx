import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border border-border bg-surface p-7 shadow-[0_30px_80px_rgba(0,0,0,0.55),0_2px_0_rgba(255,255,255,0.03)_inset]",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

export { Card };
