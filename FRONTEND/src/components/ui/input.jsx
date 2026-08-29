import * as React from "react";
import { cn } from "@/lib/utils";

// Input is chrome-less because most callers sit in a panel that draws the border; compose
// this when a form stands alone, and add pl-9 for a leading icon
export const FIELD_SHELL =
  "h-11 rounded-[10px] border border-[var(--line-strong)] bg-[rgba(7,8,11,0.72)] px-3 " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition-colors focus:border-crimson " +
  "focus:ring-2 focus:ring-[rgba(255,59,74,0.16)]";

const Input = React.forwardRef(({ className, type = "text", ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "w-full bg-transparent text-[13px] text-ink font-sans outline-none placeholder:text-ink-faint",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
