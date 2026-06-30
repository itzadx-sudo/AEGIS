import { motion } from "framer-motion";
import {
  IconUpload,
  IconMessageQuestion,
  IconShieldCheck,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { UserMenu } from "@/components/UserMenu";

const NAV_ITEMS = [
  { id: "upload", label: "Upload", icon: IconUpload },
  { id: "analysis", label: "Analysis", icon: IconMessageQuestion },
  { id: "results", label: "Results", icon: IconShieldCheck },
];

// Console-style command bar: monospace command segments with numeric indices
// and a sliding caret/underline that tracks the active route.
export function Navbar({ active, navigate, setSessionId }) {
  return (
    <nav className="sticky top-0 z-50 flex h-[68px] items-center gap-8 border-b border-border bg-[rgba(7,8,11,0.85)] px-16 shadow-[0_18px_50px_rgba(0,0,0,0.6)] backdrop-blur-md">
      {/* Identity */}
      <div className="flex items-center gap-3">
        <div className="logo-ping relative flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-gradient-to-br from-[var(--crimson)] to-[var(--crimson-deep)] text-[15px] font-semibold text-white shadow-[0_8px_22px_rgba(255,59,74,0.5),0_0_0_1px_rgba(255,255,255,0.08)_inset]">
          A
        </div>
        <div className="leading-none">
          <div className="font-mono text-[14.5px] font-semibold tracking-[0.05em] text-white">
            AEGIS
          </div>
          <div className="mt-[3px] font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-faint">
            risk console
          </div>
        </div>
      </div>

      {/* Command segments */}
      <div className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-black/30 px-2 py-1.5">
        <span className="select-none px-1 font-mono text-[12px] font-semibold text-crimson-light">
          &gt;
        </span>
        {NAV_ITEMS.map((item, i) => {
          const isActive = item.id === active;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={cn(
                "relative flex items-center gap-2 rounded-[6px] px-3 py-[7px] font-mono text-[11.5px] font-semibold uppercase tracking-[0.07em] transition-colors duration-200",
                isActive
                  ? "text-white"
                  : "text-ink-faint hover:bg-white/[0.03] hover:text-ink-dim"
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="nav-cursor"
                  transition={{ type: "spring", stiffness: 460, damping: 36 }}
                  className="absolute inset-0 rounded-[6px] border border-[rgba(255,59,74,0.35)] bg-[rgba(255,59,74,0.1)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                />
              )}
              <span className="relative z-10 flex items-center gap-2">
                <span
                  className={cn(
                    "text-[10px] tabular-nums",
                    isActive ? "text-crimson-light" : "text-ink-faint/60"
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <Icon className="h-[15px] w-[15px]" />
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      <UserMenu navigate={navigate} setSessionId={setSessionId} />
    </nav>
  );
}
