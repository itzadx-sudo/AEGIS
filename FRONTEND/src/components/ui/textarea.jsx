import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full resize-y rounded-sm border border-border bg-void-2 px-3.5 py-2.5 text-[13px] leading-[1.55] text-ink font-sans transition-all duration-150 placeholder:text-ink-faint focus:outline-none focus:border-crimson focus:bg-surface-2 focus:shadow-[0_0_0_3px_rgba(255,59,74,0.18)]",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
