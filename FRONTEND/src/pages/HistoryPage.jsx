import { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IconHistory,
  IconShieldCheck,
  IconShield,
  IconTrash,
  IconArrowRight,
  IconLoader2,
  IconRefresh,
  IconSearch,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { api, adaptSessions } from "@/lib/api";
import { statusMeta } from "@/lib/sessionStatus";

// groups the many raw statuses into the handful a user filters by
const STATUS_GROUPS = {
  all:      () => true,
  // "uploaded" belongs here — its row offers Start analysis, so it is work in progress
  active:   (s) => ["uploaded", "queued", "assessing", "resolving", "awaiting_followup", "ready_for_report"].includes(s),
  complete: (s) => s === "complete",
  paused:   (s) => s === "paused",
  failed:   (s) => s === "failed",
};

const FILTER_OPTIONS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "complete", label: "Complete" },
  { key: "paused", label: "Paused" },
  { key: "failed", label: "Failed" },
];

export function HistoryPage({ navigate, sessionId, setSessionId }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState(null); // M11(a): surface per-row delete failures
  const [confirmDelete, setConfirmDelete] = useState(null); // the session pending a delete confirmation
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  async function loadSessions() {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.listSessions();
      setSessions(adaptSessions(resp));
    } catch (err) {
      setError("Could not load sessions. Make sure the API server is running.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSessions(); }, []);

  async function handleDelete(id) {
    setConfirmDelete(null);
    setDeleting(id);
    setDeleteError(null);
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      // M11(a): surface the error so a failed delete doesn't silently leave a ghost row
      setDeleteError(id);
      console.error("delete session failed:", err);
    } finally {
      setDeleting(null);
    }
  }

  // client-side search (by vendor name) + status group filter
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = STATUS_GROUPS[statusFilter] ?? STATUS_GROUPS.all;
    return sessions.filter((s) =>
      match(s.rawStatus) && (!q || (s.name ?? "").toLowerCase().includes(q))
    );
  }, [sessions, search, statusFilter]);

  function handleOpen(s) {
    setSessionId(s.id);
    // s.status is already collapsed to done/draft, so route off s.target instead — same field UserMenu uses
    navigate(s.target);
  }

  return (
    <PageShell>
      <PageHeader
        title="Session history"
        subtitle="All past and ongoing vendor risk assessments. Resume a paused session or view a completed report."
      />

      <div className="surface-panel overflow-hidden">
        {/* refresh re-fetches rather than trusting a stale list once a session moves states */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-[rgba(255,59,74,0.05)] px-5 py-3.5">
          <div className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
            <IconHistory className="h-4 w-4 text-crimson-light" />
            {loading ? "Loading…" : `${visible.length} session${visible.length !== 1 ? "s" : ""}`}
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            {/* search by vendor name */}
            <div className="flex min-w-[180px] items-center gap-2 rounded-lg border border-border bg-white/[0.04] px-2.5 py-1.5">
              <IconSearch className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <Input
                placeholder="Search vendor…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="text-[12.5px] placeholder:text-ink-faint"
              />
            </div>
            {/* status group filter */}
            <div className="flex flex-wrap gap-1">
              {FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setStatusFilter(opt.key)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    statusFilter === opt.key
                      ? "border-crimson bg-[var(--crimson-pale)] text-crimson-light"
                      : "border-white/[0.12] bg-surface-2 text-ink-dim hover:text-white"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={loadSessions}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-[11px] text-ink-faint hover:bg-white/5 hover:text-white transition-colors"
            >
              <IconRefresh className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
        </div>

        {/* three mutually exclusive states: loading, error, or the actual list */}
        {loading ? (
          <div className="flex items-center justify-center gap-3 p-16">
            <IconLoader2 className="h-6 w-6 animate-spin text-crimson-light" />
            <span className="text-[13px] text-ink-dim">Loading sessions…</span>
          </div>
        ) : error ? (
          <div className="p-10 text-center text-[13px] text-alarm-light">{error}</div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-16 text-center">
            <IconShield className="h-10 w-10 text-ink-faint/30" />
            <p className="text-[14px] font-semibold text-ink-dim">No sessions yet</p>
            <p className="text-[12px] text-ink-faint">Upload a vendor HECVAT to start your first assessment.</p>
            <Button variant="primary" onClick={() => navigate("upload")} className="mt-2">
              Start an assessment <IconArrowRight className="h-4 w-4" />
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-16 text-center">
            <IconSearch className="h-9 w-9 text-ink-faint/30" />
            <p className="text-[13px] text-ink-dim">No sessions match your filters.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((s) => {
              // one lookup, no fallbacks — an unmapped status reads "Unknown", not a raw token
              const meta = statusMeta(s.rawStatus ?? s.status);
              const isComplete = meta.actionable === "view";
              // every non-terminal status with somewhere to go gets a button
              const canStart = meta.actionable === "start";
              const canResume = meta.actionable === "resume";

              return (
                <div
                  key={s.id}
                  className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[rgba(255,59,74,0.06)]"
                >
                  {/* shield fills in only once the assessment is actually complete */}
                  <span className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]",
                    isComplete ? "bg-[var(--crimson-pale)] text-crimson-light" : "bg-white/[0.05] text-ink-faint"
                  )}>
                    {isComplete
                      ? <IconShieldCheck className="h-5 w-5" />
                      : <IconShield className="h-5 w-5" />}
                  </span>

                  {/* truncate the id since the full uuid isn't useful at a glance */}
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-ink">{s.name}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink-faint">
                      {s.createdAt ? `Created ${new Date(s.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })} at ${new Date(s.createdAt).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}` : "—"}
                    </div>
                    {/* a failed run should say why, not just offer a delete */}
                    {s.rawStatus === "failed" && s.error && (
                      <div className="mt-1 flex items-start gap-1.5 text-[11px] leading-[1.4] text-alarm-light/90">
                        <IconAlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                        <span>{s.error}</span>
                      </div>
                    )}
                  </div>

                  <Badge variant={meta.variant} size="pill">
                    {meta.label}
                  </Badge>

                  {/* any session with an actionable status gets a button — only failed runs don't */}
                  <div className="flex items-center gap-2">
                    {(isComplete || canResume || canStart) && (
                      <Button
                        size="sm"
                        variant={isComplete ? "sea" : "primary"}
                        onClick={() => handleOpen(s)}
                      >
                        {isComplete
                          ? "View report"
                          : canStart
                            ? (s.rawStatus === "failed" ? "Retry" : "Start analysis")
                            : "Resume"}
                        <IconArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {deleteError === s.id && (
                      <span className="text-[11px] text-alarm-light">Delete failed</span>
                    )}
                    <button
                      onClick={() => setConfirmDelete(s)}
                      disabled={deleting === s.id}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-alarm/10 hover:text-alarm-light disabled:opacity-40"
                    >
                      {deleting === s.id
                        ? <IconLoader2 className="h-4 w-4 animate-spin" />
                        : <IconTrash className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* deleting a session is irreversible, so confirm first */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            data-fx="none"
            className="fixed inset-0 z-[80] flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0 } }}
          >
            <div
              className="absolute inset-0 bg-black/25 backdrop-blur-sm"
              onClick={() => setConfirmDelete(null)}
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="surface-panel relative z-10 w-full max-w-[420px] p-6 text-center"
            >
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--crimson)]/12 text-crimson-light">
                <IconAlertTriangle className="h-6 w-6" />
              </span>
              <h3 className="mb-2 text-[16px] font-semibold text-white">
                Delete this session?
              </h3>
              <p className="mb-6 text-[13px] leading-[1.6] text-ink-dim">
                <span className="font-semibold text-ink">{confirmDelete.name}</span> and its report
                will be <span className="font-semibold text-crimson-light">permanently deleted</span>.
                This can't be undone.
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="default" onClick={() => setConfirmDelete(null)}>
                  Keep
                </Button>
                <Button
                  variant="default"
                  onClick={() => handleDelete(confirmDelete.id)}
                  className="border-crimson/60 bg-[var(--crimson)]/15 text-crimson-light hover:border-crimson hover:bg-[var(--crimson)]/25 hover:text-white"
                >
                  Delete
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
