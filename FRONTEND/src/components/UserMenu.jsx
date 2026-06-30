import { useEffect, useState } from "react";
import {
  IconHistory,
  IconShieldCheck,
  IconShield,
  IconLogout,
  IconPlus,
  IconChevronDown,
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

export function UserMenu({ navigate, setSessionId }) {
  const [sessions, setSessions] = useState([]);

  // Load past sessions from the backend whenever the menu mounts.
  useEffect(() => {
    let alive = true;
    api
      .listSessions()
      .then((resp) => alive && setSessions(adaptSessions(resp)))
      .catch(() => alive && setSessions([]));
    return () => {
      alive = false;
    };
  }, []);

  function openSession(s) {
    setSessionId?.(s.id);
    navigate(s.target);
  }

  return (
    <DropdownMenu>
      {/* Trigger — compact account chip */}
      <DropdownMenuTrigger asChild>
        <button className="group flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.04] py-[3px] pl-[3px] pr-2.5 transition-colors hover:border-[rgba(255,59,74,0.4)] hover:bg-white/[0.06] focus:outline-none data-[state=open]:border-[rgba(255,59,74,0.5)] data-[state=open]:bg-[rgba(255,59,74,0.08)]">
          <span className="relative block h-[30px] w-[30px]">
            <span className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-[var(--ember)] to-[var(--crimson)] font-mono text-[11px] font-semibold text-white shadow-[0_4px_12px_rgba(255,59,74,0.45)]">
              MU
            </span>
            <span className="absolute -bottom-px -right-px h-[9px] w-[9px] rounded-full border-2 border-void bg-[#35D07F] shadow-[0_0_8px_rgba(53,208,127,0.8)]" />
          </span>
          <IconChevronDown className="h-3.5 w-3.5 text-ink-faint transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      {/* Panel */}
      <DropdownMenuContent className="w-[340px] overflow-hidden p-0">
        {/* Identity header */}
        <div className="border-b border-border bg-gradient-to-br from-[rgba(255,59,74,0.14)] to-[rgba(255,122,61,0.05)] p-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-11 w-11 bg-gradient-to-br from-[var(--ember)] to-[var(--crimson)] shadow-[0_6px_16px_rgba(255,59,74,0.45)]">
              <AvatarFallback className="bg-transparent text-[14px] font-semibold text-white">
                MU
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-white">
                Murdoch University
              </div>
              <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-dim">
                risk.team@aegis.io
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="rounded-full bg-white/[0.06] px-2.5 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
              Risk team
            </span>
            <span className="flex items-center gap-1.5 rounded-full bg-[rgba(53,208,127,0.1)] px-2.5 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#35D07F]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#35D07F]" />
              Online
            </span>
          </div>
        </div>

        {/* Recent sessions */}
        <div className="p-2">
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
            <span className="flex items-center gap-1.5">
              <IconHistory className="h-3.5 w-3.5 text-crimson-light" />
              Recent sessions
            </span>
            <span>{sessions.length}</span>
          </div>

          <div className="flex flex-col gap-[3px]">
            {sessions.length === 0 ? (
              <div className="px-2.5 py-4 text-center text-[12px] text-ink-faint">
                No sessions yet
              </div>
            ) : (
              sessions.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() => openSession(s)}
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-[rgba(255,59,74,0.08)] data-[highlighted]:bg-[rgba(255,59,74,0.08)]"
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]",
                      s.status === "done"
                        ? "bg-[var(--crimson-pale)] text-crimson-light"
                        : "bg-void-2 text-ink-faint"
                    )}
                  >
                    {s.status === "done" ? (
                      <IconShieldCheck className="h-4 w-4" />
                    ) : (
                      <IconShield className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-semibold text-ink">
                      {s.name}
                    </span>
                    <span className="block truncate text-[11px] text-ink-faint">
                      {s.system}
                    </span>
                  </span>
                  <Badge
                    variant={s.status === "done" ? "done" : "draft"}
                    size="pill"
                  >
                    {s.status === "done" ? "Complete" : "Draft"}
                  </Badge>
                </DropdownMenuItem>
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border p-2">
          <DropdownMenuItem className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-medium text-ink-dim hover:bg-white/5 hover:text-white data-[highlighted]:bg-white/5 data-[highlighted]:text-white">
            <IconLogout className="h-3.5 w-3.5" /> Sign out
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setSessionId?.(null);
              navigate("upload");
            }}
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-br from-[var(--crimson)] to-[var(--crimson-deep)] px-3.5 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(255,59,74,0.4)] transition-transform data-[highlighted]:-translate-y-px">
            <IconPlus className="h-3.5 w-3.5" /> New session
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
