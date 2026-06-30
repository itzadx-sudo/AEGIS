import * as React from "react";
import { cn } from "@/lib/utils";

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
