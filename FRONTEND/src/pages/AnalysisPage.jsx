import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IconSparkles,
  IconCornerDownLeft,
  IconCircleCheck,
  IconPencil,
  IconArrowRight,
  IconArrowLeft,
  IconLoader2,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { api, adaptQuestions } from "@/lib/api";

const POLL_MS = 3000;

// Human-readable labels for the backend status machine while work is running.
const STATUS_LABEL = {
  uploaded: "Queued",
  queued: "Queued",
  assessing: "Assessing every HECVAT control against your policies…",
  resolving: "Re-assessing answered controls and building your report…",
};

export function AnalysisPage({ navigate, sessionId }) {
  const [phase, setPhase] = useState("loading"); // loading | questions | generating | error
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");

  const [questions, setQuestions] = useState([]); // [{ id, text, ref, answered, answer }]
  const [drafts, setDrafts] = useState({}); // id -> textarea value
  const [current, setCurrent] = useState(0);

  const pollRef = useRef(null);
  const clearPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const loadQuestions = useCallback(async () => {
    const resp = await api.getQuestions(sessionId);
    const { items } = adaptQuestions(resp);
    setQuestions(items);
    setPhase("questions");
  }, [sessionId]);

  // Poll the assessment until it's ready for follow-up (or has no gaps).
  useEffect(() => {
    if (!sessionId) {
      setPhase("error");
      setError("No active session. Start a new assessment from the Upload page.");
      return;
    }

    let alive = true;
    async function tick() {
      try {
        const s = await api.getSessionStatus(sessionId);
        if (!alive) return;
        setStatus(s.status);
        if (s.status === "awaiting_followup" || s.status === "ready_for_report" || s.status === "paused") {
          clearPoll();
          await loadQuestions();
        } else if (s.status === "complete") {
          clearPoll();
          navigate("results");
        } else if (s.status === "failed") {
          clearPoll();
          setPhase("error");
          setError(s.error || "The assessment failed. Check the API server logs.");
        }
      } catch (err) {
        if (!alive) return;
        clearPoll();
        setPhase("error");
        setError(err?.detail || "Lost contact with the API server.");
      }
    }

    tick();
    pollRef.current = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearPoll();
    };
  }, [sessionId, loadQuestions, navigate]);

  const total = questions.length;
  const answeredCount = questions.filter((q) => q.answered).length;
  const q = questions[current];

  function nextOpen(from) {
    for (let k = 1; k <= total; k++) {
      const i = (from + k) % total;
      if (!questions[i].answered) return i;
    }
    return -1;
  }

  async function submit() {
    const val = (drafts[q.id] || "").trim();
    if (!val) return;
    try {
      await api.submitAnswer(sessionId, q.id, val);
      setQuestions((qs) =>
        qs.map((item) => (item.id === q.id ? { ...item, answered: true, answer: val } : item))
      );
      const n = nextOpen(current);
      if (n !== -1) setCurrent(n);
    } catch (err) {
      setError(err?.detail || "Couldn't save that answer.");
    }
  }

  function edit() {
    setDrafts((d) => ({ ...d, [q.id]: q.answer ?? "" }));
    setQuestions((qs) =>
      qs.map((item) => (item.id === q.id ? { ...item, answered: false } : item))
    );
  }

  async function generateReport() {
    setError("");
    setPhase("generating");
    try {
      await api.generateReport(sessionId);
      await new Promise((resolve, reject) => {
        const iv = setInterval(async () => {
          try {
            const s = await api.getSessionStatus(sessionId);
            setStatus(s.status);
            if (s.status === "complete") {
              clearInterval(iv);
              resolve();
            } else if (s.status === "failed") {
              clearInterval(iv);
              reject(new Error(s.error || "Report generation failed."));
            }
          } catch (err) {
            clearInterval(iv);
            reject(err);
          }
        }, POLL_MS);
      });
      navigate("results");
    } catch (err) {
      setPhase("questions");
      setError(err?.detail || err?.message || "Couldn't generate the report.");
    }
  }

  const go = (i) => setCurrent(Math.max(0, Math.min(total - 1, i)));

  // ── Loading / generating / error states ─────────────────────────────────────
  if (phase === "loading" || phase === "generating") {
    return (
      <PageShell>
        <PageHeader
          title="Gap analysis"
          subtitle="Aegis is working through the HECVAT. This can take a while for a full questionnaire."
        />
        <div className="surface-panel flex flex-col items-center gap-4 p-16 text-center">
          <IconLoader2 className="h-8 w-8 animate-spin text-crimson-light" />
          <div className="text-[14px] text-ink">
            {STATUS_LABEL[status] ?? (phase === "generating" ? STATUS_LABEL.resolving : "Working…")}
          </div>
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint">
            {status ?? "starting"}
          </div>
        </div>
      </PageShell>
    );
  }

  if (phase === "error") {
    return (
      <PageShell>
        <PageHeader title="Gap analysis" subtitle="Something needs your attention." />
        <div className="surface-panel flex flex-col items-center gap-4 p-12 text-center">
          <IconAlertTriangle className="h-7 w-7 text-alarm-light" />
          <div className="max-w-[480px] text-[14px] text-ink-dim">{error}</div>
          <Button variant="primary" onClick={() => navigate("upload")}>
            Back to upload
          </Button>
        </div>
      </PageShell>
    );
  }

  // ── No follow-up questions ───────────────────────────────────────────────────
  if (total === 0 || !q) {
    return (
      <PageShell>
        <PageHeader
          title="Gap analysis"
          subtitle="Nothing left to clarify — Aegis has everything it needs."
        />
        <div className="surface-panel p-10 text-center text-[14px] text-ink-dim">
          Nothing to clarify — the HECVAT answered everything Aegis needed.
        </div>
        {error && (
          <div className="mt-5 flex items-center gap-2 rounded-xl border border-[var(--alarm-pale)] bg-[rgba(227,28,47,0.06)] px-4 py-3 text-[13px] text-alarm-light">
            <IconAlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        <div className="mt-7 flex justify-end">
          <Button variant="sea" onClick={generateReport}>
            Generate report <IconArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </PageShell>
    );
  }

  const isAnswered = q.answered;
  const allDone = answeredCount === total;

  return (
    <PageShell>
      <PageHeader
        title="Gap analysis"
        subtitle="The HECVAT left a few things unanswered. Tell Aegis what you know to sharpen the report."
      />

      {/* Progress queue — click any segment to jump */}
      <div className="mb-7 flex items-center gap-4">
        <span className="shrink-0 font-mono text-[12px] font-semibold text-crimson-light">
          {answeredCount}/{total}
        </span>
        <div className="flex flex-1 gap-1.5">
          {questions.map((qq, i) => {
            const done = qq.answered;
            const active = i === current;
            return (
              <button
                key={qq.id}
                onClick={() => go(i)}
                aria-label={`Question ${i + 1}`}
                className="group relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.08]"
              >
                <span
                  className={cn(
                    "absolute inset-0 rounded-full transition-colors duration-300",
                    done
                      ? "bg-gradient-to-r from-[var(--crimson)] to-[var(--ember)]"
                      : active
                        ? "bg-crimson-light/50"
                        : "bg-transparent group-hover:bg-white/10"
                  )}
                />
                {active && (
                  <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-crimson" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Focused question */}
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
                Aegis needs a hand
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
                  <span>{q.answer}</span>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button size="sm" onClick={edit}>
                    <IconPencil className="h-3.5 w-3.5" /> Edit answer
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Textarea
                  rows={4}
                  placeholder="Type what you know…"
                  value={drafts[q.id] || ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [q.id]: e.target.value }))
                  }
                />
                <div className="mt-3 flex justify-end">
                  <Button variant="sea" onClick={submit}>
                    Save answer <IconCornerDownLeft className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <div className="flex items-center justify-between border-t border-border px-7 py-3.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => go(current - 1)}
            disabled={current === 0}
          >
            <IconArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => go(current + 1)}
            disabled={current === total - 1}
          >
            Next <IconArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-[var(--alarm-pale)] bg-[rgba(227,28,47,0.06)] px-4 py-3 text-[13px] text-alarm-light">
          <IconAlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="mt-7 flex items-center justify-end gap-3">
        {!allDone && (
          <span className="font-mono text-[11.5px] text-ink-faint">
            {total - answeredCount} still open · you can generate now and refine later
          </span>
        )}
        <Button variant="sea" onClick={generateReport}>
          Generate report <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </PageShell>
  );
}
