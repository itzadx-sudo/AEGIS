import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IconSparkles,
  IconCornerDownLeft,
  IconCircleCheck,
  IconPencil,
  IconArrowRight,
  IconArrowLeft,
  IconCloudUpload,
  IconAlertTriangle,
  IconShieldCheck,
  IconClock,
  IconLoader2,
  IconCertificate,
  IconFileText,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { api, adaptQuestions } from "@/lib/api";
import { Field } from "@/lib/livingField";

// keep this short — users are staring at a spinner while this runs
const POLL_INTERVAL = 3000;

// transport failures that say nothing about the run: 0 is our timeout, 5xx is the proxy
const TRANSIENT_POLL_STATUSES = new Set([0, 500, 502, 503, 504]);
// ~2 minutes at an 8s status timeout; at 5 it was ~40s, so a slow finalise looked like a lost run
const MAX_POLL_FAILS = 15;

// the resolver re-runs a full pass per answered control, so scale the wait with the answer count
const REPORT_MS_PER_ANSWER = 15000;    // generous per-control allowance
const REPORT_WAIT_OVERHEAD_MS = 300000; // + 5 min for PDF/PPTX rendering
const REPORT_WAIT_FLOOR_MS = 600000;    // never wait less than 10 min

// rotated under the scan line so the pause between polls never reads as frozen
const SCAN_HINTS = [
  "retrieving matching internal policies",
  "cross-checking vendor SOC 2 evidence",
  "scoring likelihood × impact",
  "flagging critical gaps",
  "aligning to the Murdoch RMF matrix",
];

// the report phase emits no per-item progress, so these steps advance on a timer as a lightweight indicator
const GENERATE_STEPS = [
  "resolving follow-up answers",
  "building PDF report",
  "building PPTX deck",
];

// seconds → M:SS, for the ETA readout
function fmtDur(secs) {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// server-anchored elapsed: re-sync to the server value each poll, tick locally in between so it stays smooth
function useLiveElapsed(serverElapsed) {
  const [secs, setSecs] = useState(serverElapsed ?? 0);
  const anchor = useRef({ base: serverElapsed ?? 0, at: Date.now() });
  useEffect(() => {
    // m12: reset to 0 when null so a new session doesn't briefly show the old session's elapsed
    if (serverElapsed == null) {
      anchor.current = { base: 0, at: Date.now() };
      setSecs(0);
      return;
    }
    anchor.current = { base: serverElapsed, at: Date.now() };
    setSecs(serverElapsed);
  }, [serverElapsed]);
  useEffect(() => {
    const id = setInterval(() => {
      const { base, at } = anchor.current;
      setSecs(base + Math.floor((Date.now() - at) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

function EvidenceAttachments({ sessionId, compact = false }) {
  const [documents, setDocuments] = useState([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(() => {
    if (!sessionId) return;
    api.listSessionEvidence(sessionId)
      .then((response) => setDocuments(response.documents ?? []))
      .catch(() => setDocuments([]));
  }, [sessionId]);

  useEffect(refresh, [refresh]);

  async function upload(kind, file) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setMessage("Evidence attachments must be PDF files.");
      return;
    }
    setBusy(kind);
    setMessage("");
    try {
      const result = kind === "soc2"
        ? await api.uploadSessionSoc2(sessionId, file)
        : await api.uploadSessionVendorDoc(sessionId, file);
      setMessage(
        result.status === "Manual review required"
          ? `${file.name} was retained for manual review; no searchable text was found.`
          : `${file.name} attached to this assessment only.`
      );
      refresh();
    } catch (err) {
      setMessage(err.message || "Evidence upload failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    // surface-panel, not a hand-rolled box — rounded-xl is 12px against the card's 22px
    <div className={cn(
      "surface-panel w-full text-left",
      compact ? "p-4" : "max-w-[660px] p-5"
    )}>
      <div className="mb-3">
        <p className="text-[13px] font-semibold text-ink">Assessment evidence</p>
        <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-dim">
          Attach vendor SOC 2 reports or supporting PDFs. Files are isolated to this session;
          typed follow-up answers are treated as unverified claims.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          ["soc2", "SOC 2 report", IconCertificate],
          ["vendor", "Supporting PDF", IconFileText],
        ].map(([kind, label, Icon]) => (
          <label
            key={kind}
            className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-surface-1 px-3 py-2 text-[12px] font-semibold text-ink transition-colors hover:border-crimson/50"
          >
            {busy === kind ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4 text-crimson-light" />}
            {busy === kind ? "Uploading…" : label}
            <input
              type="file"
              accept=".pdf,application/pdf"
              className="sr-only"
              disabled={Boolean(busy)}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                upload(kind, file);
              }}
            />
          </label>
        ))}
      </div>
      {documents.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-[10.5px] text-ink-dim">
          {documents.map((doc) => (
            <li key={doc.document_id} className="flex justify-between gap-3">
              <span className="truncate">{doc.filename}</span>
              <span className="shrink-0">{doc.chunk_count} chunks · {doc.evidence_state}</span>
            </li>
          ))}
        </ul>
      )}
      {message && <p className="mt-3 text-[11.5px] leading-[1.5] text-ink-dim">{message}</p>}
    </div>
  );
}

// m13: isolated component so its 1hz tick doesn't cascade re-renders into the 259-cell decode grid
function ElapsedReadout({ elapsed }) {
  const display = useLiveElapsed(elapsed);
  // a queued run has no server timing yet — counting from zero invents a clock for work
  // that has not started, which reads as a scan that is running and getting nowhere
  if (elapsed == null) return "--:--";
  return display;
}

// blinking block cursor trailing the live scan line
function Caret() {
  return (
    <motion.span
      className="ml-1 inline-block h-[13px] w-[7px] translate-y-[2px] bg-crimson-light"
      animate={{ opacity: [1, 1, 0, 0] }}
      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
    />
  );
}

// loading screen — a translucent scan console floating on the ambient aurora
function AssessmentLoader({ statusLabel, phase, progress, serviceName, onCancel, offline }) {
  const total = progress?.total ?? 0;
  const done = Math.min(progress?.done ?? 0, total || 0);
  // floor + cap at 99 until the last control actually lands, so 258/259 doesn't read as a stuck "100%"
  const pct = total > 0 ? (done >= total ? 100 : Math.min(99, Math.floor((done / total) * 100))) : 0;
  const control = progress?.control_id;
  const section = progress?.section;
  // m13: elapsed is now read by ElapsedReadout so its 1hz tick doesn't re-render the whole grid

  const generating = phase === "generating";
  const booting = !generating && total === 0;
  const scanning = !generating && !booting;
  // scan grid is full but the backend is still wrapping up (preparing follow-ups / finalizing the run)
  const finalizing = scanning && total > 0 && done >= total;

  // stop the field's orbit on unmount so it fades out with the page
  useEffect(() => {
    Field.startScan(window.innerWidth / 2, window.innerHeight * 0.5);
    return () => Field.stopScan();
  }, []);

  // linear ETA from the server-anchored elapsed and how many controls are done
  const serverElapsed = progress?.elapsed ?? 0;
  // only estimate while >1 control remains — on the last one the linear guess collapses to a "stuck" few seconds
  const eta = scanning && done >= 1 && total - done > 1
    ? Math.round((serverElapsed / done) * (total - done))
    : null;

  const [hint, setHint] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setHint((h) => (h + 1) % SCAN_HINTS.length), 2400);
    return () => clearInterval(id);
  }, []);

  // walk through the report-build steps on a timer (no backend signal for this phase)
  const [genStep, setGenStep] = useState(0);
  useEffect(() => {
    if (!generating) return;
    setGenStep(0);
    const id = setInterval(() => setGenStep((s) => Math.min(s + 1, GENERATE_STEPS.length - 1)), 2600);
    return () => clearInterval(id);
  }, [generating]);

  return (
    <div className="relative flex min-h-[72vh] w-full items-center justify-center">
      <div className="relative z-10 w-full max-w-[940px] px-4">
        {/* glass console — translucent so the aurora glows through instead of a solid box */}
        {/* radius matches the surface-panel boxes on the upload page so the app reads as one system */}
        <div className="overflow-hidden rounded-[22px] border border-white/[0.09] bg-[rgba(9,10,14,0.44)] shadow-[0_30px_90px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-lg">
          {/* title bar */}
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5 font-mono text-[11px]">
            <div className="flex items-center gap-2 text-ink-dim">
              <span className="h-1.5 w-1.5 rounded-full bg-crimson-light/70" />
              sedona://scan
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-crimson-light">
                <motion.span
                  className={cn("h-1.5 w-1.5 rounded-full",
                    offline ? "bg-ember" : "bg-crimson-light shadow-[0_0_8px_var(--crimson)]")}
                  animate={{ opacity: [1, 0.25, 1] }}
                  transition={{ duration: 1.4, repeat: Infinity }}
                />
                {offline ? "RECONNECTING" : "LIVE"}
              </div>
              {/* only offer cancel while the scan is live — the report phase is nearly done anyway */}
              {!generating && onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded-md border border-white/10 px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-ink-faint transition-colors hover:border-crimson-light/40 hover:text-crimson-light"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="px-7 py-11 font-mono text-[12.5px] leading-[1.7]">
            {/* command echo */}
            <div>
              <span className="text-crimson-light">$</span>{" "}
              <span className="text-ink">sedona assess</span>{" "}
              <span className="text-ink-dim">--service</span>{" "}
              <span className="text-ink">&quot;{serviceName || "vendor"}&quot;</span>
              {total > 0 && (
                <>
                  {" "}
                  <span className="text-ink-dim">--controls</span>{" "}
                  <span className="text-ink">{total}</span>
                </>
              )}
            </div>

            {/* no [ok] lines — the run is accepted, and that is all we actually know */}
            {booting && (
              <div className="mt-2 space-y-0.5">
                <div className="text-ink">
                  <span className="text-crimson-light">[▸]</span> warming up
                  <Caret />
                </div>
              </div>
            )}

            {generating && (
              <div className="mt-2 space-y-0.5">
                {GENERATE_STEPS.map((line, i) => {
                  if (i < genStep) return (
                    <div key={line} className="text-ink-dim">
                      <span className="text-crimson-light">[ok]</span> {line}
                    </div>
                  );
                  if (i === genStep) return (
                    <div key={line} className="text-ink">
                      <span className="text-crimson-light">[▸]</span> {line}
                      <Caret />
                    </div>
                  );
                  return (
                    <div key={line} className="text-ink-faint">
                      <span className="text-ink-faint">[ ]</span> {line}
                    </div>
                  );
                })}
              </div>
            )}

            {scanning && (
              <>
                {/* decode-matrix: one cell per control, lighting up as the scan advances */}
                <div
                  className="my-4 grid gap-[3px]"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(10px, 1fr))" }}
                >
                  {Array.from({ length: total }).map((_, i) => {
                    const state = i < done ? "done" : i === done ? "head" : "pending";
                    return (
                      <div
                        key={i}
                        className={cn(
                          "aspect-square rounded-[2px] transition-colors duration-500",
                          state === "done" && "bg-gradient-to-br from-[var(--crimson)] to-[var(--ember)]",
                          state === "head" && "animate-pulse bg-crimson-light shadow-[0_0_10px_var(--crimson)]",
                          state === "pending" && "bg-white/[0.06]"
                        )}
                      />
                    );
                  })}
                </div>

                {/* live scan line — the control being scored, or a finalizing note once the grid is full */}
                <div className="text-ink">
                  <span className="text-crimson-light">▸</span>{" "}
                  {finalizing ? (
                    <>compiling results<Caret /></>
                  ) : (
                    <>
                      scanning <span className="text-white">{control || "…"}</span>
                      {section && <span className="text-ink-dim"> · {section}</span>}
                      <Caret />
                    </>
                  )}
                </div>

                <div className="h-5 text-ink-faint">
                  <AnimatePresence mode="wait">
                    <motion.span
                      key={hint}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.35 }}
                    >
                      <span className="text-ink-dim">└─</span> {SCAN_HINTS[hint]}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </>
            )}

            {/* footer telemetry */}
            <div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-3 text-[11px] text-ink-faint">
              <span>{offline ? "Lost contact with the server — retrying" : statusLabel}</span>
              <span className="tabular-nums">
                {total > 0 && (
                  <span className="text-ink-dim">
                    <span className="text-crimson-light">{done}</span>/{total} · {pct}% ·{" "}
                  </span>
                )}
                elapsed{" "}
                {offline
                  ? <span className="text-ink-dim">
                      {progress?.elapsed == null ? "--:--" : fmtDur(progress.elapsed)}
                    </span>
                  : <ElapsedReadout elapsed={progress?.elapsed} />}
                {!offline && eta != null && eta > 0 && (
                  <span className="text-ink-dim"> · ~{fmtDur(eta)} left</span>
                )}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AnalysisPage({ navigate, sessionId, setSessionId }) {
  // ask the session list rather than assert "nothing running" with no session selected
  const [activeRun, setActiveRun] = useState(null);
  useEffect(() => {
    if (sessionId) { setActiveRun(null); return; }
    let cancelled = false;
    api.listSessions()
      .then((r) => {
        if (cancelled) return;
        const running = (r.sessions ?? []).find((s) =>
          ["queued", "assessing", "resolving"].includes(s.status));
        setActiveRun(running ? { id: running.session_id, name: running.service_name } : null);
      })
      .catch(() => { if (!cancelled) setActiveRun(null); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [drafts, setDrafts] = useState({});
  const [current, setCurrent] = useState(0);
  // which phase we're in: polling, not_started, ready, generating, complete, or failed
  const [pollStatus, setPollStatus] = useState("polling");
  const [statusLabel, setStatusLabel] = useState("Running assessment…");
  const [progress, setProgress] = useState(null); // live {done,total,control_id,section} from the backend
  const [serviceName, setServiceName] = useState(""); // echoed into the scan console command line
  const [error, setError] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [starting, setStarting] = useState(false);   // start-analysis request in flight
  const [startError, setStartError] = useState(null); // e.g. the 409 when another run holds the GPU
  const [reportSlow, setReportSlow] = useState(false); // report outran the wait window but is still building
  const [offline, setOffline] = useState(false); // polls are failing; the numbers on screen are stale

  // holds the *live* sessionId so async work started for an old session can detect it's stale
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // set the instant the user confirms cancel, so an in-flight poll ignores the imminent 404
  const cancellingRef = useRef(false);

  // in-flight guard + transient-failure streak, so one slow/blipped poll can't stack up or kill the whole view
  const pollingRef = useRef(false);
  const pollFailsRef = useRef(0);

  const poll = useCallback(async () => {
    if (cancellingRef.current) return; // tearing down, don't react to a 404 on the way out
    if (!sessionId) {
      // no real session to check against, so just drop into the empty state
      setPollStatus("ready");
      return;
    }
    if (pollingRef.current) return; // a slow poll is still in flight — don't pile another on top of it
    pollingRef.current = true;
    // M9: capture the session we're polling for so a stale resolve can't clobber a new session's state
    const targetId = sessionId;
    try {
      const status = await api.getSessionStatus(targetId);
      if (cancellingRef.current || targetId !== sessionIdRef.current) return; // cancelled or session changed mid-flight
      pollFailsRef.current = 0; // got a response — clear the transient-failure streak
      setOffline(false);
      const s = status.status;

      if (s === "uploaded") {
        // staged but never started — stop polling and say so rather than show a live screen
        if (status.service_name) setServiceName(status.service_name);
        setPollStatus("not_started");
        return;
      }
      if (s === "assessing" || s === "queued") {
        setStatusLabel(s === "queued" ? "Queued for assessment…" : "Running assessment…");
        setProgress(status.progress ?? null);
        if (status.service_name) setServiceName(status.service_name);
        return;
      }
      if (s === "awaiting_followup" || s === "ready_for_report") {
        const resp = await api.getQuestions(targetId);
        if (targetId !== sessionIdRef.current) return;
        const adapted = adaptQuestions(resp);
        setQuestions(adapted.items);
        // carry over answers already captured so re-polling doesn't blank the form
        const pre = {};
        adapted.items.forEach((q) => { if (q.answered && q.answer) pre[q.id] = q.answer; });
        setAnswers(pre);
        setPollStatus("ready");
        return;
      }
      if (s === "complete") {
        // report's already built — land on a done state instead of polling forever
        setPollStatus("complete");
        return;
      }
      if (s === "resolving") {
        // h6: resolving is the "generating report" state — show the generating loader
        setStatusLabel("Generating report…");
        setPollStatus("generating");
        return;
      }
      if (s === "paused") {
        // h6: paused means the user stepped away mid-followup — auto-resume and keep polling
        try {
          await api.resumeSession(targetId);
        } catch {
          // if resume fails, just keep polling until it succeeds
        }
        return;
      }
      if (s === "failed") {
        setError(status.error ?? "Assessment failed. Check the server logs.");
        setPollStatus("failed");
        return;
      }
      // any unrecognised status — log it so it's visible but keep polling rather than hanging forever
      console.warn(`[poll] unrecognised session status: ${s}`);
    } catch (err) {
      if (cancellingRef.current || sessionIdRef.current !== targetId) return; // don't flash a 404 on the way out of a cancel
      // a failed poll doesn't mean a failed run — the scan lives on the server, so ride out blips
      pollFailsRef.current += 1;
      if (TRANSIENT_POLL_STATUSES.has(err?.status) && pollFailsRef.current < MAX_POLL_FAILS) {
        // say so immediately — the screen is now showing numbers from before contact was lost
        setOffline(true);
        return;
      }
      if (TRANSIENT_POLL_STATUSES.has(err?.status)) {
        // persisted too long — say that, rather than claim the assessment failed
        setError(
          "Lost contact with the server while this assessment was running. The run may still be "
          + "in progress — reopen it from History in a moment."
        );
      } else {
        setError(err.message);
      }
      setPollStatus("failed");
    } finally {
      pollingRef.current = false;
    }
  }, [sessionId]);

  // reset everything on session change, otherwise stale questions/status make switching look like a no-op
  useEffect(() => {
    setPollStatus("polling");
    setStatusLabel("Running assessment…");
    setProgress(null);
    setServiceName("");
    setQuestions([]);
    setAnswers({});
    setDrafts({});
    setCurrent(0);
    setError(null);
    setConfirmCancel(false);
    setStarting(false);
    setStartError(null);
    setReportSlow(false);
    setOffline(false);
    cancellingRef.current = false;
    pollingRef.current = false;
    pollFailsRef.current = 0;
  }, [sessionId]);

  // "generating" polls too — its own wait loop dies with the click handler, so a reload
  // mid-report left nothing watching it
  useEffect(() => {
    if (pollStatus !== "polling" && pollStatus !== "generating") return;
    poll(); // check right away rather than waiting a full interval
    const id = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [poll, pollStatus]);

  // jump to the next unanswered question, wrapping — on the last card this used to do nothing
  function skipToNextUnanswered() {
    if (!questions.length) return;
    for (let i = 1; i <= questions.length; i++) {
      const idx = (current + i) % questions.length;
      if (answers[questions[idx].id] === undefined && !questions[idx].skipped) {
        go(idx);
        return;
      }
    }
    // everything answered — go to the next card so the button still feels responsive
    if (current + 1 < questions.length) go(current + 1);
  }

  async function submit() {
    const q = questions[current];
    const val = (drafts[q.id] || "").trim();
    if (!val) return;

    try {
      if (sessionId) {
        // m11: use editAnswer (PUT) if this control was already answered so the backend always accepts the call
        if (answers[q.id] !== undefined) {
          await api.editAnswer(sessionId, q.id, val);
        } else {
          await api.submitAnswer(sessionId, q.id, val);
        }
      }
      const updated = { ...answers, [q.id]: val };
      setAnswers(updated);
      const n = nextOpen(current, updated);
      if (n !== -1) setCurrent(n);
    } catch (err) {
      setError(err.message);
    }
  }

  function edit() {
    const q = questions[current];
    setDrafts((d) => ({ ...d, [q.id]: answers[q.id] }));
    setAnswers((a) => { const next = { ...a }; delete next[q.id]; return next; });
  }

  function nextOpen(from, ans) {
    for (let k = 1; k <= questions.length; k++) {
      const i = (from + k) % questions.length;
      if (!(questions[i].id in ans) && !questions[i].skipped) return i;
    }
    return -1;
  }

  const go = (i) => setCurrent(Math.max(0, Math.min(questions.length - 1, i)));

  // kick off a run for a session that was uploaded but never started
  async function startAnalysis() {
    if (!sessionId || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await api.startAnalysis(sessionId);
      // back to the live poll — the status will move to queued/assessing and the loader takes over
      setStatusLabel("Queued for assessment…");
      setPollStatus("polling");
    } catch (err) {
      // usually a 409 because another run holds the GPU — stay put and let them retry
      setStartError(err.detail ?? err.message ?? "Could not start the assessment.");
    } finally {
      setStarting(false);
    }
  }

  async function generateReport() {
    if (!sessionId) { navigate("results"); return; }
    const targetId = sessionId;
    setPollStatus("generating");
    setStatusLabel("Generating report…");
    setReportSlow(false);
    try {
      await api.generateReport(targetId);
      // scale the wait with the answer count — a flat cap expired mid-run on real workloads
      const answeredCount = Object.keys(answers).length;
      const budgetMs = Math.max(
        REPORT_WAIT_FLOOR_MS,
        answeredCount * REPORT_MS_PER_ANSWER + REPORT_WAIT_OVERHEAD_MS
      );
      const deadline = Date.now() + budgetMs;

      const wait = () => new Promise((r) => setTimeout(r, POLL_INTERVAL));
      while (Date.now() < deadline) {
        await wait();
        if (targetId !== sessionIdRef.current) return;
        const s = await api.getSessionStatus(targetId);
        if (targetId !== sessionIdRef.current) return;
        // navigate as soon as the report is ready
        if (s.status === "complete") {
          navigate("results");
          return;
        }
        if (s.status === "failed") throw new Error(s.error ?? "Report generation failed.");
        // resolving is normal — keep polling, don't exit
      }
      // we stopped waiting; the report hasn't failed and will land in History
      setReportSlow(true);
    } catch (err) {
      if (targetId !== sessionIdRef.current) return;
      setError(err.detail ?? err.message);
      setPollStatus("ready");
    }
  }

  async function cancelAnalysis() {
    cancellingRef.current = true;
    setConfirmCancel(false);
    try {
      // deletes the session and its staged hecvat; the backend scan bails at its next control
      if (sessionId) await api.deleteSession(sessionId);
    } catch {
      // already gone or unreachable — we're leaving this page anyway
    }
    // drop the now-deleted session so nothing polls it and 404s
    setSessionId?.(null);
    navigate("upload");
  }

  // offer the live run instead of inviting a second one that would 409
  if (!sessionId && activeRun) {
    return (
      <PageShell>
        <PageHeader title="Gap Analysis" titleClassName="[word-spacing:-0.2em]"
                    subtitle="An assessment is already running." />
        <div className="surface-panel flex flex-col items-center justify-center gap-4 p-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--crimson-pale)] text-crimson-light">
            <IconLoader2 className="h-6 w-6 animate-spin" />
          </span>
          <p className="text-[15px] font-semibold text-ink">{activeRun.name} is being assessed</p>
          <p className="max-w-[440px] text-[12.5px] leading-[1.6] text-ink-dim">
            Only one assessment can run at a time. Open it to watch progress, or wait for it to finish
            before starting another.
          </p>
          <Button variant="sea" onClick={() => setSessionId(activeRun.id)} className="mt-1 px-6 py-3 text-[13px]">
            Open running assessment <IconArrowRight className="h-[18px] w-[18px]" />
          </Button>
        </div>
      </PageShell>
    );
  }

  // nothing uploaded yet, so send them to upload rather than offer a report cta
  if (!sessionId) {
    return (
      <PageShell>
        <PageHeader title="Gap Analysis" titleClassName="[word-spacing:-0.2em]" subtitle="No assessment in progress." />
        <div className="surface-panel flex flex-col items-center justify-center gap-4 p-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-ink-faint">
            <IconCloudUpload className="h-6 w-6" />
          </span>
          <p className="text-[15px] font-semibold text-ink">Nothing to analyse yet</p>
          <p className="max-w-[440px] text-[12.5px] leading-[1.6] text-ink-dim">
            Upload a vendor's HECVAT to start an assessment — Sedona will surface any gaps that need clarifying right here.
          </p>
          <Button variant="sea" onClick={() => navigate("upload")} className="mt-1 px-6 py-3 text-[13px]">
            <IconCloudUpload className="h-[18px] w-[18px]" />
            Go to upload
            <IconArrowRight className="h-[18px] w-[18px]" />
          </Button>
        </div>
      </PageShell>
    );
  }

  // checked first — pollStatus still reads "generating" once we've handed off to History
  if ((pollStatus === "polling" || pollStatus === "generating") && !reportSlow) {
    return (
      <PageShell>
        <AssessmentLoader
          statusLabel={statusLabel}
          offline={offline}
          phase={pollStatus === "generating" ? "generating" : "assessing"}
          progress={progress}
          serviceName={serviceName}
          onCancel={() => setConfirmCancel(true)}
        />

        <AnimatePresence>
          {confirmCancel && (
            <motion.div
              data-fx="none"
              className="fixed inset-0 z-[80] flex items-center justify-center p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0 } }}
            >
              <div
                className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                onClick={() => setConfirmCancel(false)}
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
                  Cancel this analysis?
                </h3>
                {/* two disclaimers: the run stops, and the upload itself is destroyed */}
                <p className="mb-2 text-[13px] leading-[1.6] text-ink-dim">
                  This stops the assessment currently in progress — its results won't be saved.
                </p>
                <p className="mb-6 text-[13px] leading-[1.6] text-ink-dim">
                  Your uploaded HECVAT file will also be <span className="font-semibold text-crimson-light">permanently deleted</span> — you'll need to re-upload it to run this again.
                </p>
                <div className="flex justify-center gap-3">
                  <Button variant="default" onClick={() => setConfirmCancel(false)}>
                    Keep analysing
                  </Button>
                  <Button
                    variant="default"
                    onClick={cancelAnalysis}
                    className="border-crimson/60 bg-[var(--crimson)]/15 text-crimson-light hover:border-crimson hover:bg-[var(--crimson)]/25 hover:text-white"
                  >
                    Cancel &amp; delete
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </PageShell>
    );
  }

  // we stopped waiting, but the backend is still building — this is not a failure
  if (reportSlow) {
    return (
      <PageShell>
        <PageHeader
          title="Gap Analysis"
          titleClassName="[word-spacing:-0.2em]"
          subtitle="Your report is still being generated."
        />
        <div className="surface-panel flex flex-col items-center justify-center gap-4 p-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-ink-faint">
            <IconClock className="h-6 w-6" />
          </span>
          <p className="text-[15px] font-semibold text-ink">Still generating — check History shortly</p>
          <p className="max-w-[460px] text-[12.5px] leading-[1.6] text-ink-dim">
            This assessment has a lot of answers to resolve, so the report is taking longer than we
            wait here. It's still running and nothing has been lost — it will appear in Session
            history as soon as it's finished.
          </p>
          <div className="mt-1 flex gap-3">
            <Button variant="sea" onClick={() => navigate("history")}>
              Go to history <IconArrowRight className="h-4 w-4" />
            </Button>
            <Button
              variant="default"
              onClick={() => { setReportSlow(false); setPollStatus("polling"); }}
            >
              Keep waiting
            </Button>
          </div>
        </div>
      </PageShell>
    );
  }

  // uploaded but never started — offer the action instead of a spinner for work that isn't running
  if (pollStatus === "not_started") {
    return (
      <PageShell>
        <PageHeader
          title="Gap Analysis"
          titleClassName="[word-spacing:-0.2em]"
          subtitle="This assessment hasn't been started yet."
        />
        <div className="surface-panel flex flex-col items-center justify-center gap-4 p-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-ink-faint">
            <IconShieldCheck className="h-6 w-6" />
          </span>
          <p className="text-[15px] font-semibold text-ink">
            {serviceName ? `${serviceName} is ready to assess` : "Ready to assess"}
          </p>
          <p className="max-w-[440px] text-[12.5px] leading-[1.6] text-ink-dim">
            The HECVAT has been uploaded but the assessment hasn't run yet. Only one assessment can run
            at a time, so if another is still in progress you'll need to wait for it to finish.
          </p>
          <EvidenceAttachments sessionId={sessionId} />
          {startError && (
            <p className="max-w-[440px] text-[12.5px] leading-[1.6] text-alarm-light">{startError}</p>
          )}
          <Button variant="sea" onClick={startAnalysis} disabled={starting} className="mt-1 px-6 py-3 text-[13px]">
            {starting ? "Starting…" : "Start analysis"}
            <IconArrowRight className="h-[18px] w-[18px]" />
          </Button>
        </div>
      </PageShell>
    );
  }

  if (pollStatus === "failed") {
    return (
      <PageShell>
        <PageHeader title="Gap Analysis" titleClassName="[word-spacing:-0.2em]" subtitle="Something went wrong." />
        <div className="surface-panel flex flex-col items-center gap-4 p-10 text-center">
          <p className="text-[14px] text-alarm-light">{error}</p>
          {/* the API accepts start-analysis from "failed", so offer a retry */}
          <p className="max-w-[420px] text-[12.5px] leading-[1.6] text-ink-dim">
            If the cause was temporary — a model server that was down, or another assessment
            holding the GPU — you can run this one again.
          </p>
          <Button variant="sea" onClick={startAnalysis} disabled={starting} className="mt-1 px-6 py-3 text-[13px]">
            {starting ? "Retrying…" : "Retry assessment"}
          </Button>
        </div>
      </PageShell>
    );
  }

  // report's done, so point at results instead of showing the assessment spinner
  if (pollStatus === "complete") {
    return (
      <PageShell>
        <PageHeader title="Gap Analysis" titleClassName="[word-spacing:-0.2em]" subtitle="This assessment is already complete." />
        <div className="surface-panel flex flex-col items-center justify-center gap-4 p-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--crimson-pale)] text-crimson-light">
            <IconCircleCheck className="h-6 w-6" />
          </span>
          <p className="text-[14px] font-semibold text-ink">Gap analysis finished</p>
          <p className="max-w-[420px] text-[12.5px] leading-[1.6] text-ink-dim">
            Sedona has everything it needs and the report has been generated. Head to Results to review the findings.
          </p>
          <Button variant="sea" onClick={() => navigate("results")} className="mt-1">
            View results <IconArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </PageShell>
    );
  }

  // nothing left to clarify, so the only next step is one clear cta to build the report
  if (questions.length === 0) {
    return (
      <PageShell>
        <PageHeader title="Gap Analysis" titleClassName="[word-spacing:-0.2em]" subtitle="Nothing left to clarify — Sedona has everything it needs." />
        <div className="surface-panel flex flex-col items-center justify-center gap-4 p-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--crimson-pale)] text-crimson-light">
            <IconSparkles className="h-6 w-6" />
          </span>
          <p className="text-[15px] font-semibold text-ink">Everything checks out</p>
          <p className="max-w-[440px] text-[12.5px] leading-[1.6] text-ink-dim">
            The HECVAT answered everything Sedona needed — there are no follow-up questions to resolve. You're ready to build the risk report.
          </p>
          <Button variant="sea" onClick={generateReport} className="mt-1 px-6 py-3 text-[13px]">
            <IconSparkles className="h-[18px] w-[18px] " />
            Generate risk report
            <IconArrowRight className="h-[18px] w-[18px]" />
          </Button>
        </div>
      </PageShell>
    );
  }

  const q = questions[current];
  const total = questions.length;
  const answeredCount = Object.keys(answers).length;
  const skippedCount = questions.filter((item) => item.skipped && !(item.id in answers)).length;
  const reviewedCount = answeredCount + skippedCount;
  const isAnswered = q.id in answers;

  return (
    <PageShell>
      <PageHeader
        title="Gap Analysis"
        titleClassName="[word-spacing:-0.2em]"
        subtitle="The HECVAT left a few things unanswered. Tell Sedona what you know, or drop in another HECVAT that fills them in."
      />

      <div className="mb-5">
        <EvidenceAttachments sessionId={sessionId} compact />
      </div>

      {/* these dots double as a progress bar and a jump-to-question nav */}
      <div className="mb-7 flex items-center gap-4">
        <span className="shrink-0 font-mono text-[12px] font-semibold text-crimson-light">
          {reviewedCount}/{total}
        </span>
        <div className="flex flex-1 gap-1.5">
          {questions.map((qq, i) => {
            const done = qq.id in answers || qq.skipped;
            const active = i === current;
            return (
              <button
                key={qq.id}
                onClick={() => go(i)}
                aria-label={`Question ${i + 1}`}
                className="group relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.08]"
              >
                <span className={cn(
                  "absolute inset-0 rounded-full transition-colors duration-300",
                  done ? "bg-gradient-to-r from-[var(--crimson)] to-[var(--ember)]"
                       : active ? "bg-crimson-light/50" : "bg-transparent group-hover:bg-white/10"
                )} />
                {active && <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-crimson" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* only the current question renders — animate presence handles the swap */}
      <div className="surface-panel relative overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={q.id}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="p-7"
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                <IconSparkles className="h-3.5 w-3.5 text-crimson-light" />
                Sedona needs a hand
              </div>
              <span className="font-mono text-[11px] text-ink-faint">
                Question {current + 1} of {total}
              </span>
            </div>

            <h2 className="mb-1.5 max-w-[760px] text-[19px] font-semibold leading-[1.4] text-white">
              {q.text}
            </h2>
            <div className="mb-5 font-mono text-[11px] font-medium text-crimson-light">
              {q.ref}
            </div>

            {isAnswered ? (
              <div className="rounded-xl border border-[var(--crimson-pale)] bg-[rgba(255,59,74,0.04)] p-4">
                <div className="flex items-start gap-2.5 text-[13.5px] leading-[1.6] text-ink">
                  <IconCircleCheck className="mt-px h-[18px] w-[18px] shrink-0 text-crimson-light" />
                  <span>{answers[q.id]}</span>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button size="sm" onClick={edit}>
                    <IconPencil className="h-3.5 w-3.5" /> Edit answer
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {q.skipped && (
                  <p className="mb-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11.5px] text-ink-dim">
                    Previously skipped{q.skip?.reason ? `: ${q.skip.reason}` : ""}. You can still add an answer.
                  </p>
                )}
                <Textarea
                  rows={4}
                  placeholder="Type what you know… (or skip this question)"
                  value={drafts[q.id] || ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                />
                <div className="mt-3 flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        if (sessionId) await api.skipQuestion(sessionId, q.id);
                        setQuestions((items) => items.map((item) =>
                          item.id === q.id
                            ? { ...item, skipped: true, skip: { reason: "Skipped without a reason" } }
                            : item
                        ));
                        skipToNextUnanswered();
                      } catch (err) {
                        setError(err.message || "Could not record the skipped question.");
                      }
                    }}
                  >
                    Skip question
                  </Button>
                  {/* submit() no-ops on a blank answer — skipping is the way past a question */}
                  <Button
                    variant="sea"
                    onClick={submit}
                    disabled={!(drafts[q.id] || "").trim()}
                  >
                    Save answer <IconCornerDownLeft className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <div className="flex items-center justify-between border-t border-border px-7 py-3.5">
          <Button variant="ghost" size="sm" onClick={() => go(current - 1)} disabled={current === 0}>
            <IconArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button variant="ghost" size="sm" onClick={() => go(current + 1)} disabled={current === total - 1}>
            Next <IconArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>



      {error && (
        <div className="mt-4 rounded-xl border border-alarm/30 bg-alarm/10 px-4 py-3 text-[13px] text-alarm-light">
          {error}
        </div>
      )}

      <div className="mt-7 flex items-center justify-end gap-3">
        <span className="font-mono text-[11.5px] text-ink-faint">
          {answeredCount} answered · {skippedCount} skipped · {total} total
        </span>
        <Button variant="sea" onClick={generateReport}>
          Generate report <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </PageShell>
  );
}
