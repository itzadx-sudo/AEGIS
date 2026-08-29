import { useState, useRef } from "react";
import {
  IconHistory,
  IconShieldCheck,
  IconShield,
  IconShieldX,
  IconPlus,
  IconChevronDown,
  IconArrowRight,
  IconActivity,
  IconLoader2,
  IconSettings,
  IconDatabase,
  IconAdjustments,
  IconLogout,
  IconUsers,
} from "@tabler/icons-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, adaptSessions } from "@/lib/api";
import { Field } from "@/lib/livingField";

// anything not yet finished gets grouped into its own "active" section above the past ones
const ACTIVE_META = {
  queued:            { label: "Queued",           spin: false },
  uploaded:          { label: "Uploaded",          spin: false },
  assessing:         { label: "Assessing",         spin: true  },
  awaiting_followup: { label: "In progress",       spin: false },
  ready_for_report:  { label: "Ready for report",  spin: false },
  resolving:         { label: "Generating report", spin: true  },
  paused:            { label: "Paused",            spin: false },
};

export function UserMenu({ navigate, setSessionId, active, user, onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  // refetch on every open rather than caching, so the list can't go stale while the menu sits closed
  async function onOpenChange(isOpen) {
    setOpen(isOpen);
    if (isOpen) {
      // Radix swallows the trigger click, so fire the field effect here
      const el = triggerRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        Field.swirl(r.left + r.width / 2, r.top + r.height / 2, { maxR: 90, strength: 1.4, arms: 4, turns: 1.3 });
      }
      try {
        const resp = await api.listSessions();
        setSessions(adaptSessions(resp));
      } catch (err) {
        // M13: log so a 401/backend-down is distinguishable from an empty session list
        console.error("listSessions failed:", err);
        setSessions([]);
      }
    }
  }

  function openSession(s) {
    setSessionId(s.id);
    navigate(s.target);
  }

  function newSession() {
    setSessionId(null);
    navigate("upload");
  }

  const activeSessions = sessions.filter((s) => s.rawStatus in ACTIVE_META);
  const pastSessions = sessions.filter((s) => !(s.rawStatus in ACTIVE_META));
  // the pages this menu owns — the trigger stays lit while you're standing on one of them
  const ownsPage = active === "kb" || active === "history" || active === "users";

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          aria-label="Settings"
          className={cn(
            "group flex items-center gap-2 rounded-full border py-[3px] pl-[3px] pr-2.5 transition-colors focus:outline-none data-[state=open]:border-[rgba(255,59,74,0.5)] data-[state=open]:bg-[rgba(255,59,74,0.08)]",
            ownsPage
              ? "border-[rgba(255,59,74,0.35)] bg-[rgba(255,59,74,0.1)]"
              : "border-white/[0.1] bg-white/[0.04] hover:border-[rgba(255,59,74,0.4)] hover:bg-white/[0.06]"
          )}
        >
          {/* the gear says "settings" without spending nav width; the org identity heads the dropdown */}
          <span className="relative block h-[30px] w-[30px]">
            <span className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-[var(--ember)] to-[var(--crimson)] text-white shadow-[0_4px_12px_rgba(255,59,74,0.45)]">
              <IconSettings className="h-[17px] w-[17px] transition-transform duration-500 group-hover:rotate-90 group-data-[state=open]:rotate-90" />
            </span>
          </span>
          <IconChevronDown className="h-3.5 w-3.5 text-ink-faint transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      {/* capped to the space Radix reports, so a long session list scrolls inside the panel */}
      <DropdownMenuContent className="flex max-h-[var(--radix-dropdown-menu-content-available-height)] w-[340px] flex-col overflow-hidden p-0">
        <div className="shrink-0 border-b border-border bg-gradient-to-br from-[rgba(255,59,74,0.14)] to-[rgba(255,122,61,0.05)] p-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-11 w-11 bg-gradient-to-br from-[var(--ember)] to-[var(--crimson)] shadow-[0_6px_16px_rgba(255,59,74,0.45)]">
              <AvatarFallback className="bg-transparent text-[14px] font-semibold text-white">
                {(user?.display_name || user?.username || "MU").slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-white">{user?.display_name || user?.username}</div>
              <div className="mt-0.5 truncate font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                {user?.role} · local account
              </div>
            </div>
          </div>
        </div>

        {/* min-h-0 or flex-1 won't shrink below content height and the scrollbar never appears */}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {activeSessions.length > 0 && (
            <div className="border-b border-border p-2">
              <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
                <IconActivity className="h-3.5 w-3.5 text-crimson-light" />
                Active sessions
              </div>
              <div className="flex flex-col gap-[3px]">
                {activeSessions.slice(0, 3).map((s) => {
                  const meta = ACTIVE_META[s.rawStatus];
                  return (
                    <DropdownMenuItem
                      key={s.id}
                      onSelect={() => openSession(s)}
                      className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-[rgba(255,59,74,0.08)] data-[highlighted]:bg-[rgba(255,59,74,0.08)]"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--crimson-pale)] text-crimson-light">
                        {meta.spin
                          ? <IconLoader2 className="h-4 w-4 animate-spin" />
                          : <IconShield className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-semibold text-ink">{s.name}</span>
                        <span className="block truncate text-[11px] text-ink-faint">{meta.label}</span>
                      </span>
                      <Badge variant="wait" size="pill">{meta.label}</Badge>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </div>
          )}

          <div className="p-2">
            <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
              <IconHistory className="h-3.5 w-3.5 text-crimson-light" />
              Past sessions
            </div>

            <div className="flex flex-col gap-[3px]">
              {pastSessions.length === 0 ? (
                <div className="px-2 py-3 text-[11.5px] text-ink-faint">No past sessions yet.</div>
              ) : (
                pastSessions.slice(0, 4).map((s) => {
                  const failed = s.rawStatus === "failed";
                  return (
                    <DropdownMenuItem
                      key={s.id}
                      onSelect={() => openSession(s)}
                      className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-[rgba(255,59,74,0.08)] data-[highlighted]:bg-[rgba(255,59,74,0.08)]"
                    >
                      <span className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]",
                        failed ? "bg-void-2 text-ink-faint" : "bg-[var(--crimson-pale)] text-crimson-light"
                      )}>
                        {failed ? <IconShieldX className="h-4 w-4" /> : <IconShieldCheck className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-semibold text-ink">{s.name}</span>
                        <span className="block truncate text-[11px] text-ink-faint">
                          {failed ? "Failed" : "Complete"}
                        </span>
                      </span>
                      <Badge variant={failed ? "fail" : "done"} size="pill">
                        {failed ? "Failed" : "Complete"}
                      </Badge>
                    </DropdownMenuItem>
                  );
                })
              )}
            </div>
          </div>

          {/* neither is part of the numbered assessment pipeline, so they live here */}
          <div className="border-t border-border p-2">
            <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
              <IconAdjustments className="h-3.5 w-3.5 text-crimson-light" />
              Console
            </div>
            <div className="flex flex-col gap-[3px]">
              {[
                ...(user?.role === "admin" ? [
                  { page: "kb", icon: IconDatabase, label: "Knowledge base", hint: "Policies, SOC 2, HECVAT template" },
                  { page: "users", icon: IconUsers, label: "User access", hint: "Accounts, roles and permissions" },
                ] : []),
                { page: "history", icon: IconHistory, label: "View all history", hint: "Every past and ongoing session" },
              ].map((item) => {
                const isActive = active === item.page;
                const Icon = item.icon;
                return (
                  <DropdownMenuItem
                    key={item.page}
                    onSelect={() => navigate(item.page)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-[rgba(255,59,74,0.08)] data-[highlighted]:bg-[rgba(255,59,74,0.08)]",
                      isActive && "bg-[rgba(255,59,74,0.06)]"
                    )}
                  >
                    <span className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-crimson-light",
                      isActive ? "bg-[var(--crimson-pale)]" : "bg-void-2"
                    )}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold text-ink">{item.label}</span>
                      <span className="block truncate text-[11px] text-ink-faint">{item.hint}</span>
                    </span>
                    <IconArrowRight className="h-4 w-4 shrink-0 text-ink-faint" />
                  </DropdownMenuItem>
                );
              })}
            </div>
          </div>
        </div>
        {/* ^ end of scroll region — New session stays pinned below it, always reachable */}

        <div className="shrink-0 border-t border-border p-2">
          <div className="flex gap-2">
            {user?.role !== "viewer" && (
              <DropdownMenuItem
                onSelect={newSession}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-[var(--crimson)] to-[var(--crimson-deep)] px-3.5 py-2 text-[12px] font-semibold text-white shadow-[0_4px_14px_rgba(255,59,74,0.4)] transition-transform data-[highlighted]:-translate-y-px cursor-pointer"
              >
                <IconPlus className="h-3.5 w-3.5" /> New session
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={onLogout}
              className="flex items-center justify-center gap-1.5 rounded-full border border-white/[0.12] px-3.5 py-2 text-[12px] font-semibold text-ink-dim cursor-pointer data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-white"
            >
              <IconLogout className="h-3.5 w-3.5" /> Sign out
            </DropdownMenuItem>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
