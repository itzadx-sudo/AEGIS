import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IconDatabase,
  IconShieldLock,
  IconFileSpreadsheet,
  IconRefresh,
  IconPlus,
  IconLoader2,
  IconCircleCheck,
  IconAlertTriangle,
  IconTrash,
  IconFile,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Field } from "@/lib/livingField";

// one card per corpus: it lists what's indexed and is the dropzone for adding to it
const SOURCES = [
  {
    key: "policy",
    statKey: "internal_policies",
    label: "Internal policies",
    role: "Your own rules — the yardstick every vendor answer gets measured against.",
    unit: "clauses indexed",
    kind: "PDF",
    accept: ".pdf",
    exts: [".pdf"],
    fn: "uploadPolicy",
    icon: IconShieldLock,
    tile: "from-[var(--crimson-light)] to-[var(--crimson)] shadow-[0_14px_34px_rgba(255,59,74,0.4)]",
    accent: "text-crimson-light",
  },
  {
    key: "hecvat",
    statKey: "hecvat_template",
    label: "HECVAT template",
    role: "The blank questionnaire — defines which questions an assessment walks through.",
    unit: "questions indexed",
    kind: "XLSX",
    // no .xls — openpyxl can't read the legacy format, so accepting it just fails later
    accept: ".xlsx,.xlsm",
    exts: [".xlsx", ".xlsm"],
    fn: "uploadHecvatTemplate",
    icon: IconFileSpreadsheet,
    tile: "from-[var(--gold)] to-[var(--ember)] shadow-[0_14px_34px_rgba(255,178,62,0.34)]",
    accent: "text-gold",
  },
];

const REDUCED = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// roll the count up and flash the card, so an ingest of 40 clauses isn't a silent number swap
function useCountUp(target) {
  const [display, setDisplay] = useState(0);
  const [bumped, setBumped] = useState(false);
  const fromRef = useRef(0);

  useEffect(() => {
    if (target == null) return;
    const from = fromRef.current;
    if (from === target) return;
    if (REDUCED()) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const grew = target > from && from !== 0;
    const t0 = performance.now();
    const dur = 900;
    let raf = 0;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(from + (target - from) * eased);
      fromRef.current = v; // track the rendered value so an interrupted run resumes from where it stopped
      setDisplay(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    if (grew) {
      setBumped(true);
      const t = setTimeout(() => setBumped(false), 1200);
      return () => { cancelAnimationFrame(raf); clearTimeout(t); };
    }
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return { display, bumped };
}

// fire from an element's centre — outcomes land long after the click that caused them
function fieldAt(el, fn, opts) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  fn(r.left + r.width / 2, r.top + r.height / 2, opts);
}

function SourceCard({ source, count, loading, busy, onFile, documents = [], deletingId, onDelete }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const cardRef = useRef(null);
  const { display, bumped } = useCountUp(count);
  const Icon = source.icon;

  function pick(file, coords) {
    if (!file) return;
    onFile(source, file, cardRef.current, coords);
  }

  return (
    <motion.div
      ref={cardRef}
      // the card is its own field emitter: a swirl on click echoes the picker opening
      data-fx="swirl-sm"
      role="button"
      tabIndex={0}
      aria-label={`Add to ${source.label}`}
      onClick={() => { if (!busy) inputRef.current?.click(); }}
      onKeyDown={(e) => {
        if (busy || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault();
        if (busy || dragging) return;
        setDragging(true);
        // the field answers the drag before the drop lands, so the page feels alive under the cursor
        Field.ripple(e.clientX, e.clientY, { maxR: 92, strength: 1.2, sparks: 5 });
      }}
      onDragLeave={(e) => {
        // relatedTarget inside the card means we only crossed an inner element, not actually left
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (busy) return;
        Field.cascade(e.clientX, e.clientY, { strength: 1.6, streams: 7 });
        pick(e.dataTransfer.files?.[0], { x: e.clientX, y: e.clientY });
      }}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={cn(
        "upload-glow surface-panel group relative flex cursor-pointer flex-col overflow-hidden p-5 transition-colors",
        dragging
          ? "border-crimson bg-[rgba(255,59,74,0.06)]"
          : "hover:border-[rgba(255,90,100,0.45)]",
        busy && "cursor-progress"
      )}
    >
      {/* sweeps across the card while its upload is in flight — the panel-level echo of the field's scan */}
      {busy && (
        <span
          aria-hidden
          className="kb-sweep pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--crimson)] to-transparent"
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            "flex h-[46px] w-[46px] items-center justify-center rounded-[14px] bg-gradient-to-br text-white transition-transform duration-300 group-hover:scale-105",
            source.tile
          )}
        >
          <Icon className="h-[22px] w-[22px]" />
        </span>
        <Badge variant="count" size="pill">{source.kind}</Badge>
      </div>

      <div className="mt-4 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {source.label}
      </div>

      <div className="mt-1.5 flex items-baseline gap-2">
        {loading ? (
          <span className="my-1 block h-[26px] w-[72px] animate-pulse rounded-md bg-white/[0.06]" />
        ) : (
          <span
            className={cn(
              "font-mono text-[34px] font-bold leading-none tabular-nums transition-colors duration-500",
              bumped ? source.accent : "text-white"
            )}
          >
            {display.toLocaleString()}
          </span>
        )}
        <span className="text-[11.5px] text-ink-faint">{source.unit}</span>
      </div>

      <p className="mt-2.5 text-[12.5px] leading-[1.55] text-ink-dim">{source.role}</p>

      {/* the documents themselves — counts alone left a mistaken upload unfindable */}
      <div className="mt-3.5 flex-1">
        {documents.length === 0 ? (
          <p className="font-mono text-[11px] text-ink-faint">Nothing indexed yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {documents.map((doc) => {
              const isDeleting = deletingId === doc.doc_id;
              return (
                <li
                  key={doc.doc_id}
                  className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]"
                >
                  <IconFile className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={doc.display_name}>
                    {doc.display_name}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-faint">
                    {doc.chunk_count}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${doc.display_name}`}
                    disabled={busy || isDeleting}
                    onClick={(e) => { e.stopPropagation(); onDelete?.(doc); }}
                    // always rendered — a hover-only control is invisible to keyboard and touch
                    className="shrink-0 rounded p-1 text-ink-faint/60 transition hover:bg-alarm/15 hover:text-alarm-light focus-visible:text-alarm-light disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isDeleting
                      ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                      : <IconTrash className="h-3.5 w-3.5" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
          {busy ? "Ingesting…" : dragging ? "Release to ingest" : `Drop ${source.kind} or click`}
        </span>
        <Button
          size="sm"
          variant="default"
          disabled={busy}
          // the card already owns the click effect; let it bubble for the field but don't double-open the picker
          onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
        >
          {busy
            ? <><IconLoader2 className="h-3.5 w-3.5 animate-spin" /> Uploading</>
            : <><IconPlus className="h-3.5 w-3.5" /> Add</>}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={source.accept}
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = ""; // reset so re-picking the same file after a failure still fires onChange
        }}
      />
    </motion.div>
  );
}

export function KnowledgeBasePage() {
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [log, setLog] = useState([]);   // this session's ingests, newest first
  // what's actually indexed, keyed by collection — lets a wrongly-uploaded document be removed
  const [docs, setDocs] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    // an upload in flight leaves the field's scan swarm running — stop it if the user navigates away
    return () => { mountedRef.current = false; Field.stopScan(); };
  }, []);

  const loadStats = useCallback(() => {
    setLoading(true);
    return api
      .kbStats()
      .then((r) => {
        if (!mountedRef.current) return;
        setStats(r);
        setStatsError(null);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setStatsError(err.detail || err.message || "Could not load knowledge base stats");
      })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, []);

  const loadDocs = useCallback(() => {
    return api
      .kbDocuments()
      .then((r) => { if (mountedRef.current) setDocs(r.collections || {}); })
      .catch((err) => {
        // a failure here shouldn't blank the counts — the cards still work without the list
        console.error("could not load knowledge base documents:", err);
      });
  }, []);

  const refresh = useCallback(() => Promise.all([loadStats(), loadDocs()]), [loadStats, loadDocs]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete(doc) {
    setConfirmDelete(null);
    setDeletingId(doc.doc_id);
    setDeleteError(null);
    try {
      await api.deleteKbDocument(doc.collection, doc.doc_id);
      if (!mountedRef.current) return;
      setLog((l) => [{
        id: `${Date.now()}-del-${doc.doc_id}`, name: doc.display_name,
        label: "Removed from knowledge base", status: "ok",
        detail: `${doc.chunk_count} chunk${doc.chunk_count === 1 ? "" : "s"} deleted.`, at: new Date(),
      }, ...l]);
      await refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setDeleteError(err.detail || err.message || "Delete failed.");
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  }

  async function handleFile(source, file, cardEl, coords) {
    // reject the wrong file type up front — the backend would 4xx anyway, and a local no is instant
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!source.exts.includes(ext)) {
      if (coords) Field.scatter(coords.x, coords.y, { count: 14, radius: 46 });
      else fieldAt(cardEl, Field.scatter, { count: 14, radius: 46 });
      setLog((l) => [{
        id: `${Date.now()}-${file.name}`,
        name: file.name,
        label: source.label,
        status: "fail",
        detail: `${source.label} takes ${source.kind} files.`,
        at: new Date(),
      }, ...l]);
      return;
    }

    const entryId = `${Date.now()}-${file.name}`;
    setBusyKey(source.key);
    setLog((l) => [{
      id: entryId, name: file.name, label: source.label, status: "uploading", detail: null, at: new Date(),
    }, ...l]);
    // ingestion is the same "system is working" moment the analysis page uses, so it gets the same swarm
    Field.startScan();

    try {
      await api[source.fn](file);
      if (!mountedRef.current) return;
      setLog((l) => l.map((e) => e.id === entryId
        ? { ...e, status: "ok", detail: "Parsed and indexed." } : e));
      fieldAt(cardEl, Field.bloom, { maxR: 168, strength: 1.7 });
      await refresh();   // counts roll up to the new totals, and the document list picks up the new file
    } catch (err) {
      if (!mountedRef.current) return;
      setLog((l) => l.map((e) => e.id === entryId
        ? { ...e, status: "fail", detail: err.detail || err.message || "Upload failed." } : e));
      fieldAt(cardEl, Field.scatter, { count: 16, radius: 54 });
    } finally {
      Field.stopScan();
      if (mountedRef.current) setBusyKey(null);
    }
  }

  // no vendor evidence here — it is session-scoped, not an institution-wide source of truth
  const extras = Object.entries(stats ?? {}).filter(
    ([k]) => k !== "soc2_controls" && !SOURCES.some((s) => s.statKey === k)
  );
  const total = SOURCES.reduce(
    (sum, source) => sum + (Number(stats?.[source.statKey]) || 0), 0
  );

  return (
    <PageShell>
      <PageHeader
        title="Knowledge base"
        subtitle="What the assessment engine treats as its source of truth. Drop a document on a card to teach it more."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
          <IconDatabase className="h-4 w-4 text-crimson-light" />
          Source of truth
          {!loading && !statsError && (
            <Badge variant="count" size="pill">
              {total.toLocaleString()} indexed
            </Badge>
          )}
        </div>
        <button
          onClick={loadStats}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-[11px] text-ink-faint transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
        >
          <IconRefresh className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {statsError && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-alarm/30 bg-alarm/10 px-4 py-3 text-[13px] text-alarm-light">
          <IconAlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span>{statsError}</span>
        </div>
      )}

      {deleteError && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-alarm/30 bg-alarm/10 px-4 py-3 text-[13px] text-alarm-light">
          <IconAlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span>{deleteError}</span>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {SOURCES.map((s) => (
          <SourceCard
            key={s.key}
            source={s}
            count={stats?.[s.statKey] ?? null}
            loading={loading && !stats}
            busy={busyKey === s.key}
            onFile={handleFile}
            documents={docs?.[s.statKey] ?? []}
            deletingId={deletingId}
            onDelete={(doc) => setConfirmDelete(doc)}
          />
        ))}

        <div className="surface-panel flex flex-col justify-between p-5">
          <div>
            <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[14px] bg-void-2 text-ink-dim">
              <IconFile className="h-[22px] w-[22px]" />
            </span>
            <div className="mt-4 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Vendor evidence
            </div>
            <p className="mt-2 text-[12.5px] leading-[1.6] text-ink-dim">
              SOC 2 reports and supporting PDFs are attached from Gap Analysis and isolated to
              that vendor session. They are never added to this global source of truth.
            </p>
          </div>
        </div>

        {extras.map(([name, value]) => (
          <div key={name} className="surface-panel flex flex-col p-5">
            <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[14px] bg-void-2 text-ink-dim">
              <IconDatabase className="h-[22px] w-[22px]" />
            </span>
            <div className="mt-4 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              {name.replace(/_/g, " ")}
            </div>
            <div className="mt-1.5 font-mono text-[34px] font-bold leading-none tabular-nums text-white">
              {typeof value === "number" ? value.toLocaleString() : String(value)}
            </div>
          </div>
        ))}
      </div>

      {/* mirrors the upload page's feed, so both places read the same */}
      <div className="surface-panel mt-5 overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-[rgba(255,59,74,0.05)] px-5 py-3.5">
          <div className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
            <IconDatabase className="h-4 w-4 text-crimson-light" />
            Ingestion log
          </div>
          <Badge variant="count" size="default">
            {log.length} {log.length === 1 ? "document" : "documents"}
          </Badge>
        </div>

        {log.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center">
            <IconDatabase className="h-9 w-9 text-ink-faint/30" />
            <p className="text-[13px] text-ink-dim">Nothing ingested this session.</p>
            <p className="text-[12px] text-ink-faint">
              Anything you add above shows up here with its parse result.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {log.map((e) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-[rgba(255,59,74,0.06)]"
                >
                  <span className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
                    e.status === "ok" ? "bg-[var(--crimson-pale)] text-crimson-light"
                      : e.status === "fail" ? "bg-[var(--alarm-pale)] text-alarm-light"
                      : "bg-void-2 text-ink-faint"
                  )}>
                    {e.status === "uploading" ? <IconLoader2 className="h-4 w-4 animate-spin" />
                      : e.status === "ok" ? <IconCircleCheck className="h-4 w-4" />
                      : <IconAlertTriangle className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] font-medium text-ink">{e.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                      {e.label}
                      {e.detail ? ` · ${e.detail}` : ""}
                    </span>
                  </span>
                  <span className="hidden shrink-0 font-mono text-[11px] text-ink-faint sm:block">
                    {e.at.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <Badge
                    variant={e.status === "ok" ? "done" : e.status === "fail" ? "fail" : "wait"}
                    size="pill"
                  >
                    {e.status === "ok" ? "Indexed" : e.status === "fail" ? "Failed" : "Uploading…"}
                  </Badge>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* this changes what every future assessment is measured against — confirm it */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="fixed inset-0 z-50 flex items-center justify-center px-6"
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
              className="surface-panel relative z-10 w-full max-w-[440px] p-6 text-center"
            >
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--crimson)]/12 text-crimson-light">
                <IconAlertTriangle className="h-6 w-6" />
              </span>
              <h3 className="mb-2 text-[16px] font-semibold text-white">
                Remove this document?
              </h3>
              <p className="mb-6 text-[13px] leading-[1.6] text-ink-dim">
                <span className="font-semibold text-ink">{confirmDelete.display_name}</span> and its{" "}
                <span className="font-semibold text-ink">{confirmDelete.chunk_count}</span> indexed
                chunk{confirmDelete.chunk_count === 1 ? "" : "s"} will be{" "}
                <span className="font-semibold text-crimson-light">permanently removed</span> from
                the knowledge base. Future assessments will no longer be measured against it.
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="default" onClick={() => setConfirmDelete(null)}>
                  Keep
                </Button>
                <Button
                  variant="default"
                  onClick={() => handleDelete(confirmDelete)}
                  className="border-crimson/60 bg-[var(--crimson)]/15 text-crimson-light hover:border-crimson hover:bg-[var(--crimson)]/25 hover:text-white"
                >
                  Remove
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
