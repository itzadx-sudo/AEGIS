import { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IconSearch,
  IconFileTypePdf,
  IconPresentation,
  IconLoader2,
  IconAlertTriangle,
  IconShieldSearch,
  IconFileSpreadsheet,
  IconChevronRight,
  IconRefresh,
  IconX
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { RiskRadar } from "@/components/RiskRadar";
import { cn } from "@/lib/utils";
import { SEV_LABELS, SEV_ORDER } from "@/data/risks";
import { api, adaptResults } from "@/lib/api";

const CHIP_ON = {
  vh: "bg-alarm border-alarm text-white",
  h:  "bg-ember border-ember text-[#21110A]",
  m:  "bg-gold border-gold text-[#221703]",
  mn: "bg-sand border-sand text-[#211a08]",
  l:  "bg-slate border-slate text-white",
};

const GROUP_LABEL = {
  vh: "bg-[#2d080d] text-alarm-light border-b-[rgba(227,28,47,0.28)]",
  h:  "bg-[#2d170f] text-ember border-b-[rgba(255,122,61,0.25)]",
  m:  "bg-[#2d200f] text-gold border-b-[rgba(255,178,62,0.25)]",
  mn: "bg-[#241f14] text-sand border-b-[rgba(194,163,107,0.25)]",
  l:  "bg-[#18191d] text-slate border-b-[rgba(113,122,136,0.28)]",
};

const DOT = {
  vh: "bg-alarm shadow-[0_0_9px_var(--alarm)]",
  h:  "bg-ember",
  m:  "bg-gold",
  mn: "bg-sand",
  l:  "bg-slate",
};

// modal detail rows, in reading order. A field the API didn't send is dropped, never
// placeholdered; `wide` marks free text that needs the full panel width
const DETAIL_FIELDS = [
  { key: "desc",            label: "Finding", wide: true },
  { key: "sourceLocation",  label: "Source location" },
  { key: "requirement",     label: "Requirement", wide: true },
  { key: "vendorResponse",  label: "Vendor response", wide: true },
  { key: "riskCategories",  label: "Risk categories", format: (v) => Array.isArray(v) ? v.join(", ") : String(v) },
  { key: "cause",           label: "Cause" },
  { key: "consequence",     label: "Consequence" },
  { key: "existingControls", label: "Existing controls", format: (v) => Array.isArray(v) ? v.join("; ") : String(v), wide: true },
  { key: "controlEffectiveness", label: "Control effectiveness", format: (v) => String(v).replace(/_/g, " ") },
  { key: "initialRisk",     label: "Initial risk", format: (v) => String(v).replace("VERY HIGH", "Very High") },
  { key: "treatment",       label: "Proposed treatment" },
  { key: "proposedControls", label: "Proposed controls", format: (v) => Array.isArray(v) ? v.join("; ") : String(v), wide: true },
  { key: "residualRisk",    label: "Residual risk", format: (v) => String(v).replace("VERY HIGH", "Very High") },
  { key: "src",            label: "Evidence source" },
  { key: "evidenceTrace",  label: "Evidence trace", format: (v) => Array.isArray(v) ? v.join("; ") : String(v), wide: true },
  { key: "evidenceQuality", label: "Evidence quality" },
  { key: "vendorEvidenceState", label: "Vendor evidence state" },
  { key: "policyAlignment", label: "Policy alignment", format: (v) => v.replace(/_/g, " ") },
  { key: "policyClause",    label: "Policy clause referenced", quoted: true, wide: true },
  { key: "consistencyStatus", label: "Consistency status", format: (v) => String(v).replace(/_/g, " ") },
  { key: "manualReviewStatus", label: "Manual review", format: (v) => String(v).replace(/_/g, " ") },
  { key: "recommendation",  label: "Recommendation", wide: true },
];

// worth another go; a 409 or 404 never is. 500 counts — that's how the proxy reports a restarting api
function isTransient(err) {
  return err?.status === 0 || err?.status >= 500;
}

// translate raw api errors like "results not ready (status='awaiting_followup')" into something a user can act on
function describeError(err) {
  const status = err?.status;
  const detail = err?.detail || err?.message || "Unknown error.";

  if (status === 409) {
    const state = /status='([^']+)'/.exec(detail)?.[1];
    const because = {
      awaiting_followup: "the follow-up questions haven't all been answered yet",
      ready_for_report:  "the report hasn't been generated yet",
      assessing:         "the assessment is still running",
      resolving:         "the report is still being generated",
      paused:            "this session is paused",
      uploaded:          "the assessment hasn't been started yet",
    }[state];
    return {
      title: "This report isn't ready to view yet",
      reason: because
        ? `Results only appear once the assessment is complete — right now ${because}. Open this session from the Analysis page to finish it, then generate the report.`
        : "Results only appear once the assessment is complete. Finish the analysis and generate the report first.",
    };
  }
  if (status === 404) {
    return {
      title: "This session couldn't be found",
      reason: "It may have been deleted. Pick another session from your history.",
    };
  }
  if (status === 0) {
    return {
      title: "Couldn't reach the results",
      reason: `${detail}. Retried twice without getting through — check the connection, or that the API server is running.`,
    };
  }
  if (status >= 500) {
    return {
      title: "The server couldn't return the results",
      reason: `${detail}. This is usually temporary — the API may be restarting.`,
    };
  }
  return {
    title: "Something went wrong while loading the results",
    reason: detail,
  };
}

export function ResultsPage({ sessionId }) {
  const [filters, setFilters] = useState(new Set());
  const [query, setQuery] = useState("");
  const [risks, setRisks] = useState([]);
  const [summary, setSummary] = useState(null);
  const [serviceName, setServiceName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(null); // tracks which format is mid-download: "pdf", "pptx", or null
  const [downloadError, setDownloadError] = useState(null);
  const [selected, setSelected] = useState(null); // the finding whose detail modal is open
  const [reloadTick, setReloadTick] = useState(0); // bumping this refetches — drives the retry button
  const [retrying, setRetrying] = useState(false);
  const [slow, setSlow] = useState(false); // a spinner with no explanation reads as hung

  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const id = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(id);
  }, [loading]);

  useEffect(() => {
    let cancelled = false; // guards against a stale response landing after the user switched sessions
    const controller = new AbortController();
    // retry a couple of times before stranding the user on an error page
    async function load(attempt = 0) {
      setError(null); // clear any previous session's error before this one has a chance to fail too
      if (!sessionId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      let queued = false; // another attempt is pending, so the spinner has to stay up
      try {
        const resp = await api.getResults(sessionId, undefined, { signal: controller.signal });
        if (cancelled) return;
        const adapted = adaptResults(resp);
        setRisks(adapted.risks);
        setSummary(adapted.summary);
        setServiceName(adapted.serviceName);
      } catch (err) {
        if (cancelled || err.detail === "aborted") return;
        if (isTransient(err) && attempt < 2) {
          queued = true;
          setRetrying(true);
          setTimeout(() => { if (!cancelled) load(attempt + 1); }, 1000 * (attempt + 1));
          return;
        }
        setError(err);
      } finally {
        if (!cancelled && !queued) {
          setLoading(false);
          setRetrying(false);
        }
      }
    }
    load();
    return () => { cancelled = true; controller.abort(); };
  }, [sessionId, reloadTick]);

  // Escape closes the modal — the backdrop alone strands keyboard users
  useEffect(() => {
    if (!selected) return;
    const onKey = (e) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // filtered out from under an open modal — close it rather than show a card that's gone
  useEffect(() => {
    if (selected && !risks.includes(selected)) setSelected(null);
  }, [risks, selected]);

  // aria-modal promises the rest of the page is inert, so focus has to actually move here
  useEffect(() => {
    if (!selected) return;
    const opener = document.activeElement;
    const dialog = document.querySelector('[role="dialog"]');
    (dialog?.querySelector("[data-modal-close]") ?? dialog)?.focus?.();
    return () => opener?.focus?.();
  }, [selected]);

  // goes through api.downloadReport since a plain <a href> can't attach the auth header and would 401
  async function handleDownload(fmt) {
    if (!sessionId || downloading) return;
    setDownloading(fmt);
    setDownloadError(null);
    try {
      const blob = await api.downloadReport(sessionId, fmt);
      const ext = fmt === "pptx" ? "pptx" : "pdf";
      // human-readable name, no session UUID — falls back to a generic label if the vendor name is missing
      const safeVendor = (serviceName || "vendor").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "vendor";
      const kind = fmt === "pptx" ? "RiskBriefing" : "RiskAssessment";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${kind}_${safeVendor}.${ext}`;
      document.body.appendChild(a);
      a.click();
      // delay the revoke — doing it same-tick as click() can abort larger downloads in firefox/safari
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (err) {
      setDownloadError(err.message ?? "Download failed.");
    } finally {
      setDownloading(null);
    }
  }

  // same endpoint as the PDF and PPTX — building the CSV here covered fewer controls
  async function handleCsvDownload() {
    setDownloading("csv");
    setDownloadError(null);
    try {
      const blob = await api.downloadReport(sessionId, "csv");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(serviceName || "Vendor").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "Vendor"}_RiskAssessment.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err.detail || err.message || "CSV export failed.");
    } finally {
      setDownloading(null);
    }
  }

  function toggleFilter(sev) {
    setFilters((prev) => {
      const next = new Set(prev);
      next.has(sev) ? next.delete(sev) : next.add(sev);
      return next;
    });
  }

  const idxOf = useMemo(() => new Map(risks.map((r, i) => [r, i])), [risks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return risks.filter((r) => {
      const matchSev = filters.size === 0 || filters.has(r.sev);
      // the id is printed on every card and is the first thing anyone searches for
      const matchQ =
        !q ||
        r.controlId?.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.desc?.toLowerCase().includes(q);
      return matchSev && matchQ;
    });
  }, [risks, filters, query]);

  const rows = useMemo(() => {
    const groups = {};
    filtered.forEach((r) => { (groups[r.sev] ||= []).push(r); });
    const out = [];
    SEV_ORDER.forEach((sev) => {
      if (!groups[sev]) return;
      out.push({ type: "header", sev, key: `h-${sev}`, count: groups[sev].length });
      groups[sev].forEach((r, i) =>
        out.push({ type: "item", sev, key: `i-${idxOf.get(r)}`, risk: r, index: i })
      );
    });
    return out;
  }, [filtered, idxOf]);

  // keyed off severity filters only, not search text, so typing doesn't retrigger the reveal animation
  const filterKey = useMemo(() => [...filters].sort().join("|"), [filters]);

  if (loading) {
    return (
      <PageShell>
        <PageHeader title="Risk results" subtitle="Loading assessment results…" />
        <div className="surface-panel flex flex-col items-center justify-center gap-2 p-16">
          <div className="flex items-center gap-3">
            <IconLoader2 className="h-8 w-8 animate-spin text-crimson-light" />
            <span className="text-[14px] text-ink-dim">
              {retrying ? "Connection stalled — retrying…" : "Fetching results…"}
            </span>
          </div>
          {slow && !retrying && (
            <span className="text-[12px] text-ink-faint">
              A full assessment is a large download — still going.
            </span>
          )}
        </div>
      </PageShell>
    );
  }

  if (error) {
    const { title, reason } = describeError(error);
    const canRetry = isTransient(error);
    return (
      <PageShell>
        <PageHeader title="Risk results" subtitle="Could not load results." />
        <div className="surface-panel flex flex-col items-center gap-3 p-12 text-center">
          <IconAlertTriangle className="h-9 w-9 text-alarm-light/70" />
          <div className="text-[15px] font-semibold text-ink">{title}</div>
          <p className="max-w-[440px] text-[13px] leading-[1.6] text-ink-dim">{reason}</p>
          {canRetry && (
            <Button className="mt-2" onClick={() => setReloadTick((t) => t + 1)}>
              <IconRefresh className="mr-2 h-4 w-4" />
              Try again
            </Button>
          )}
        </div>
      </PageShell>
    );
  }

  // bail out before rendering RiskRadar with a null summary — it falls back to mock data otherwise
  if (!sessionId) {
    return (
      <PageShell>
        <PageHeader title="Risk results" subtitle="No assessment selected." />
        <div className="surface-panel flex flex-col items-center gap-3 p-12 text-center">
          <IconShieldSearch className="h-9 w-9 text-ink-faint/50" />
          <div className="text-[15px] font-semibold text-ink">Nothing to show yet</div>
          <p className="max-w-[440px] text-[13px] leading-[1.6] text-ink-dim">
            Upload a document to start an assessment, or open a completed session from your history to view its results.
          </p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader title="Risk results" />

      <RiskRadar risks={risks} summary={summary} />

      {/* severity chips act as a toggleable segmented control, wraps on narrow screens */}
      <div className="surface-panel mb-4 flex flex-wrap items-center gap-x-3 gap-y-2.5 px-[15px] py-[11px]">
        <div className="flex min-w-[180px] flex-1 items-center gap-2">
          <IconSearch className="h-4 w-4 shrink-0 text-ink-faint" />
          <Input
            placeholder="Search findings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {/* "All" clears every filter; its burst is the biggest of the row (data-sev="all") */}
          <motion.button
            data-fx="sevburst"
            data-sev="all"
            onClick={() => setFilters(new Set())}
            whileTap={{ scale: 0.94 }}
            className={cn(
              "rounded-md border px-3 py-[6px] text-[11.5px] font-semibold leading-none transition-colors duration-200",
              filters.size === 0
                ? "border-crimson bg-[rgba(255,59,74,0.12)] text-crimson-light"
                : "border-white/[0.14] bg-surface-2 text-ink hover:border-crimson hover:text-crimson-light"
            )}
          >
            All
          </motion.button>
          {SEV_ORDER.map((sev) => {
            const on = filters.has(sev);
            return (
              <motion.button
                key={sev}
                data-fx="sevburst"
                data-sev={sev}
                onClick={() => toggleFilter(sev)}
                whileTap={{ scale: 0.96 }}
                className={cn(
                  "rounded-md border px-3 py-[6px] text-[11.5px] font-medium leading-none transition-colors duration-200",
                  on ? CHIP_ON[sev] : "border-white/[0.14] bg-surface-2 text-ink hover:border-crimson hover:text-crimson-light"
                )}
              >
                {SEV_LABELS[sev]}
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* grouped by severity, sorted worst-first via SEV_ORDER */}
      <div className="surface-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-[rgba(255,59,74,0.05)] px-[19px] py-[13px]">
          <strong className="flex items-center gap-1.5 font-mono text-[12px] text-ink">
            <span className="tabular-nums">{filtered.length}</span>
            finding{filtered.length !== 1 ? "s" : ""}
          </strong>
          <span className="text-[12px] text-ink-dim">Sorted by severity</span>
        </div>

        {/* fixed height, not max-h — filtering to 0 findings used to collapse the panel and jump the page */}
        <div className="scroll-thin h-[400px] overflow-y-auto">
          {rows.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="p-[46px] text-center text-[13px] text-ink-faint"
            >
              <IconSearch className="mx-auto mb-2 h-6 w-6 opacity-40" />
              {risks.length === 0
                ? "No findings — all controls passed."
                : query.trim()
                  ? "No findings match your search."
                  : "No findings at this severity."}
            </motion.div>
          ) : (
            <motion.div
              key={filterKey}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            >
              {rows.map((row) =>
                row.type === "header" ? (
                  <motion.div
                    key={row.key}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1], delay: 0.05 * SEV_ORDER.indexOf(row.sev) }}
                    className={cn(
                      "sticky top-0 z-[1] flex items-center justify-between border-b px-[19px] py-[9px] font-mono text-[11px] font-semibold uppercase tracking-[0.07em]",
                      GROUP_LABEL[row.sev]
                    )}
                  >
                    <span>{SEV_LABELS[row.sev]}</span>
                    <span className="font-bold tabular-nums">{row.count}</span>
                  </motion.div>
                ) : (
                  /* the row carries only what identifies the finding — control id, section, and the gap
                     itself. Source, policy alignment, the quoted clause and the recommendation all moved
                     into the modal, so scanning 60+ findings doesn't mean scrolling past five blocks each */
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => setSelected(row.risk)}
                    aria-label={`View details for ${row.risk.controlId || row.risk.title}`}
                    className={`group flex w-full items-center gap-3.5 border-b border-border px-[19px] py-3 text-left last:border-b-0 finding-row sev-${row.sev}`}
                  >
                    <div className={cn("h-2 w-2 shrink-0 rounded-full", DOT[row.sev])} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-[3px] flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold leading-[1.4] text-ink">
                        {row.risk.controlId && (
                          <span className="rounded border border-white/[0.14] bg-black/30 px-1.5 py-[1px] font-mono text-[10.5px] font-semibold tracking-wide text-ink-dim">
                            {row.risk.controlId}
                          </span>
                        )}
                        {row.risk.title}
                      </div>
                      {/* clamped, not truncated — the full text is one click away */}
                      <div className="line-clamp-2 text-[12px] leading-[1.5] text-ink-dim">
                        {row.risk.desc}
                      </div>
                    </div>
                    <Badge variant={row.sev} size="sm" className="shrink-0">
                      {SEV_LABELS[row.sev]}
                    </Badge>
                    <IconChevronRight className="h-4 w-4 shrink-0 text-ink-faint transition-colors group-hover:text-crimson-light" />
                  </button>
                )
              )}
            </motion.div>
          )}
        </div>
      </div>

      <div className="mt-[18px] flex flex-col items-end gap-2">
        {downloadError && (
          <span className="text-[12px] text-alarm-light">{downloadError}</span>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="primary"
            data-fx="cascade"
            disabled={!sessionId || downloading !== null}
            onClick={() => handleDownload("pdf")}
          >
            {downloading === "pdf" ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconFileTypePdf className="h-4 w-4" />
            )}
            Download PDF
          </Button>
          <Button
            variant="primary"
            data-fx="cascade"
            disabled={!sessionId || downloading !== null}
            onClick={() => handleDownload("pptx")}
          >
            {downloading === "pptx" ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconPresentation className="h-4 w-4" />
            )}
            Download PPTX
          </Button>
          <Button
            variant="primary"
            data-fx="cascade"
            disabled={!sessionId || risks.length === 0}
            onClick={handleCsvDownload}
          >
            <IconFileSpreadsheet className="h-4 w-4" />
            Download CSV
          </Button>
        </div>
      </div>

      {/* a grid, not a stacked column, so ~20 fields fit without scrolling; the overlay keeps
          overflow-y-auto as a fallback for findings with long free text */}
      <AnimatePresence>
        {selected && (
          <motion.div
            data-fx="none"
            className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-4 py-[4vh]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0 } }}
          >
            <div
              className="fixed inset-0 bg-black/25 backdrop-blur-sm"
              onClick={() => setSelected(null)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="surface-panel relative z-10 my-auto w-full max-w-[1040px] overflow-hidden"
            >
              {/* header tinted to the finding's severity, same colour language as the group headers */}
              <div className={cn(
                "flex items-start gap-3 border-b px-6 py-4",
                GROUP_LABEL[selected.sev]
              )}>
                <div className={cn("mt-[7px] h-2 w-2 shrink-0 rounded-full", DOT[selected.sev])} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {selected.controlId && (
                      <span className="rounded border border-white/[0.14] bg-black/30 px-1.5 py-[1px] font-mono text-[10.5px] font-semibold tracking-wide text-ink-dim">
                        {selected.controlId}
                      </span>
                    )}
                    <Badge variant={selected.sev} size="sm">
                      {SEV_LABELS[selected.sev]}
                    </Badge>
                  </div>
                  <h3 className="mt-1.5 text-[15px] font-semibold leading-[1.4] text-white">
                    {selected.title}
                  </h3>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  aria-label="Close"
                  data-modal-close
                  className="-mr-1.5 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-white/5 hover:text-white"
                >
                  <IconX className="h-4 w-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-6 py-5 sm:grid-cols-3">
                {/* without this note, a legacy finding's migration defaults read as assessment conclusions */}
                {selected.isLegacySchema && (
                  <div className="col-span-full flex items-start gap-2 rounded-lg border border-gold/25 bg-gold/[0.07] px-3 py-2.5 text-[11.5px] leading-[1.55] text-sand">
                    <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Assessed before the current risk schema.</span>
                  </div>
                )}
                {DETAIL_FIELDS.map(({ key, label, format, quoted, wide }) => {
                  const raw = selected[key];
                  // drop empty fields rather than printing "N/A" — an absent value is the backend's answer
                  if (
                    raw === null
                    || raw === undefined
                    || raw === ""
                    || (Array.isArray(raw) && raw.length === 0)
                  ) return null;
                  const value = format ? format(raw) : String(raw);
                  return (
                    <div key={key} className={cn(wide && "col-span-full")}>
                      <div className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
                        {label}
                      </div>
                      <p className={cn(
                        "text-[13px] leading-[1.65] text-ink-dim",
                        quoted && "border-l-2 border-crimson/40 pl-3 italic"
                      )}>
                        {quoted ? `"${value}"` : value}
                      </p>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
