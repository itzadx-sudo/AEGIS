import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IconSparkles,
  IconCornerDownLeft,
  IconCircleCheck,
  IconPencil,
  IconArrowRight,
  IconArrowLeft,
  IconCloudUpload,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { OPEN_QUESTIONS } from "@/data/risks";

export function AnalysisPage({ navigate }) {
  const [answers, setAnswers] = useState({}); // id -> submitted text
  const [drafts, setDrafts] = useState({}); // id -> textarea value
  const [current, setCurrent] = useState(0);

  const total = OPEN_QUESTIONS.length;
  const answeredCount = Object.keys(answers).length;
  const q = OPEN_QUESTIONS[current];

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
      </PageShell>
    );
  }

  const isAnswered = q.id in answers;
  const allDone = answeredCount === total;

  // Jump to the next still-open question (wraps around).
  function nextOpen(from, ans) {
    for (let k = 1; k <= total; k++) {
      const i = (from + k) % total;
      if (!(OPEN_QUESTIONS[i].id in ans)) return i;
    }
    return -1;
  }

  function submit() {
    const val = (drafts[q.id] || "").trim();
    if (!val) return;
    const updated = { ...answers, [q.id]: val };
    setAnswers(updated);
    const n = nextOpen(current, updated);
    if (n !== -1) setCurrent(n);
  }

  function edit() {
    setDrafts((d) => ({ ...d, [q.id]: answers[q.id] }));
    setAnswers((a) => {
      const next = { ...a };
      delete next[q.id];
      return next;
    });
  }

  const go = (i) => setCurrent(Math.max(0, Math.min(total - 1, i)));

  return (
    <PageShell>
      <PageHeader
        title="Gap analysis"
        subtitle="The HECVAT left a few things unanswered. Tell Aegis what you know, or drop in another HECVAT that fills them in."
      />

      {/* Progress queue — click any segment to jump */}
      <div className="mb-7 flex items-center gap-4">
        <span className="shrink-0 font-mono text-[12px] font-semibold text-crimson-light">
          {answeredCount}/{total}
        </span>
        <div className="flex flex-1 gap-1.5">
          {OPEN_QUESTIONS.map((qq, i) => {
            const done = qq.id in answers;
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

      {/* Focused question — shared panel surface */}
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

      {/* Upload another HECVAT instead */}
      <div className="surface-panel mt-5 flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--crimson-pale)] text-crimson-light">
            <IconCloudUpload className="h-5 w-5" />
          </span>
          <div>
            <div className="text-[13px] font-semibold text-ink">
              Got an updated HECVAT?
            </div>
            <div className="text-[12px] text-ink-dim">
              Drop it in and Aegis answers these for you.
            </div>
          </div>
        </div>
        <Button variant="primary" size="sm">
          Upload HECVAT
        </Button>
      </div>

      <div className="mt-7 flex items-center justify-end gap-3">
        {!allDone && (
          <span className="font-mono text-[11.5px] text-ink-faint">
            {total - answeredCount} still open
          </span>
        )}
        <Button variant="sea" onClick={() => navigate("results")}>
          Continue <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </PageShell>
  );
}
