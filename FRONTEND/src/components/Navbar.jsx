import { motion } from "framer-motion";
import {
  IconUpload,
  IconMessageQuestion,
  IconShieldCheck,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { UserMenu } from "@/components/UserMenu";

// numbered tabs are the pipeline only; housekeeping lives in the settings dropdown
const NAV_ITEMS = [
  { id: "upload", label: "Upload", icon: IconUpload, fx: "nav-ripple" },
  { id: "analysis", label: "Analysis", icon: IconMessageQuestion, fx: "nav-swirl" },
  { id: "results", label: "Results", icon: IconShieldCheck, fx: "nav-burst" },
];

// figures out which tab to nudge the user toward next, based on where their session sits in the pipeline
function nextStepFor(status, sessionId) {
  if (status === "complete") return "results";
  if (!sessionId) return "upload";        // no session yet, so the obvious first move is to upload one
  if (!status) return null;               // status hasn't come back yet, stay neutral instead of guessing
  if (status === "uploaded") return "upload";
  return "analysis";
}

// renders like a terminal command bar — numbered segments with a sliding cursor under whichever tab is active
export function Navbar({ active, navigate, setSessionId, sessionId, sessionStatus, user, onLogout }) {
  const nextStep = nextStepFor(sessionStatus, sessionId);
  // treat an unknown next step as "on path" so the active tab doesn't dim while we're still figuring out where the user should go
  const onPath = nextStep === null || active === nextStep;
  return (
    <nav className="sticky top-0 z-50 flex h-[68px] items-center gap-8 border-b border-border bg-[rgba(9,10,14,0.55)] px-16 shadow-[0_18px_50px_rgba(0,0,0,0.45)] backdrop-blur-lg backdrop-saturate-150">
      <div className="flex items-center gap-3">
        <div className="relative flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-gradient-to-br from-[var(--crimson)] to-[var(--crimson-deep)] text-[15px] font-semibold text-white shadow-[0_8px_22px_rgba(255,59,74,0.5),0_0_0_1px_rgba(255,255,255,0.08)_inset]">
          S
        </div>
        <div className="leading-none">
          <div className="font-mono text-[14.5px] font-semibold tracking-[0.05em] text-white">
            SEDONA
          </div>
          <div className="mt-[3px] font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-faint">
            risk console
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-black/30 px-2 py-1.5">
        <span className="select-none px-1 font-mono text-[12px] font-semibold text-crimson-light">
          &gt;
        </span>
        {NAV_ITEMS.filter((item) => user?.role !== "viewer" || item.id === "results").map((item, i) => {
          const isActive = item.id === active;
          // once a report exists there's nothing left to analyze, so lock the tab instead of leaving a dead end
          const isDisabled = item.id === "analysis" && sessionStatus === "complete";
          // beacon only lights up a tab you're not already standing on
          const isBeacon = item.id === nextStep && !isActive && !isDisabled;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              data-fx={item.fx}
              onClick={() => { if (!isDisabled) navigate(item.id); }}
              disabled={isDisabled}
              title={isDisabled ? "Assessment complete — view the Results" : undefined}
              className={cn(
                "relative flex items-center gap-2 rounded-[6px] px-3 py-[7px] font-mono text-[11.5px] font-semibold uppercase tracking-[0.07em] transition-colors duration-200",
                isDisabled
                  ? "cursor-not-allowed text-ink-faint opacity-40"
                  : isActive
                  ? onPath ? "text-white" : "text-ink-dim"
                  : isBeacon
                  ? "text-white hover:bg-white/[0.03]"
                  : "text-ink-faint hover:bg-white/[0.03] hover:text-ink-dim"
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="nav-cursor"
                  transition={{ type: "spring", stiffness: 460, damping: 36 }}
                  className={cn(
                    "absolute inset-0 rounded-[6px] border",
                    onPath
                      ? "border-[rgba(255,59,74,0.35)] bg-[rgba(255,59,74,0.1)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                      : "border-[rgba(255,59,74,0.26)] bg-[rgba(255,59,74,0.08)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
                  )}
                />
              )}
              {isBeacon && (
                <span
                  aria-hidden
                  className="nav-beacon pointer-events-none absolute inset-0 rounded-[6px] bg-[rgba(255,59,74,0.08)]"
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

      <UserMenu
        navigate={navigate}
        setSessionId={setSessionId}
        active={active}
        user={user}
        onLogout={onLogout}
      />
    </nav>
  );
}


