import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { IconSearch, IconFileTypePdf, IconPresentation } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { RiskRadar } from "@/components/RiskRadar";
import { cn } from "@/lib/utils";
import { RISKS, SEV_LABELS, SEV_ORDER } from "@/data/risks";

const CHIP_ON = {
  vh: "bg-alarm border-alarm text-white",
  h: "bg-ember border-ember text-[#21110A]",
  m: "bg-gold border-gold text-[#221703]",
  mn: "bg-sand border-sand text-[#211a08]",
  l: "bg-slate border-slate text-white",
};

// Opaque solid header fills (each severity tint pre-composited over the
// near-black panel) so the sticky group labels render reliably and don't need
// to backdrop-blur the scrolling content behind them — that was the main cause
// of the laggy hover/scroll in the findings list.
const GROUP_LABEL = {
  vh: "bg-[#2d080d] text-alarm-light border-b-[rgba(227,28,47,0.28)]",
  h: "bg-[#2d170f] text-ember border-b-[rgba(255,122,61,0.25)]",
  m: "bg-[#2d200f] text-gold border-b-[rgba(255,178,62,0.25)]",
  mn: "bg-[#241f14] text-sand border-b-[rgba(194,163,107,0.25)]",
  l: "bg-[#18191d] text-slate border-b-[rgba(113,122,136,0.28)]",
};

const DOT = {
  vh: "bg-alarm shadow-[0_0_9px_var(--alarm)]",
  h: "bg-ember",
  m: "bg-gold",
  mn: "bg-sand",
  l: "bg-slate",
};

// Springy layout transition shared by every animated row.
const LAYOUT_SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.7 };

export function ResultsPage() {
  const [filters, setFilters] = useState(new Set());
  const [query, setQuery] = useState("");

  const idxOf = useMemo(() => new Map(RISKS.map((r, i) => [r, i])), []);

  function toggleFilter(sev) {
    setFilters((prev) => {
      const next = new Set(prev);
      next.has(sev) ? next.delete(sev) : next.add(sev);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return RISKS.filter((r) => {
      const matchSev = filters.size === 0 || filters.has(r.sev);
      const matchQ =
        !q ||
        r.title.toLowerCase().includes(q) ||
        r.desc.toLowerCase().includes(q);
      return matchSev && matchQ;
    });
  }, [filters, query]);

  // Flatten into an ordered stream of header + item nodes so framer-motion can
  // animate position changes across severity groups as things filter in/out.
  const rows = useMemo(() => {
    const groups = {};
    filtered.forEach((r) => {
      (groups[r.sev] ||= []).push(r);
    });
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

  return (
    <PageShell>
      <PageHeader
        title="Risk results"
        subtitle="Risks identified across your uploaded documents. Use the filter bar to narrow by severity."
      />

      {/* Threat radar — signature posture visualisation + severity breakdown */}
      <RiskRadar />

      {/* Filter bar */}
      <div className="surface-panel mb-4 flex items-center gap-2 px-[15px] py-[11px]">
        <IconSearch className="h-4 w-4 text-ink-faint" />
        <Input
          placeholder="Search findings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex gap-1.5">
          {SEV_ORDER.map((sev) => {
            const on = filters.has(sev);
            return (
              <motion.button
                key={sev}
                onClick={() => toggleFilter(sev)}
                whileTap={{ scale: 0.9 }}
                animate={{ scale: on ? 1.05 : 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 24 }}
                className={cn(
                  "rounded-full border px-3 py-[5px] text-[11.5px] font-medium transition-colors duration-200",
                  on
                    ? CHIP_ON[sev]
                    : "border-border bg-void-2 text-ink-dim hover:border-crimson hover:text-crimson-light"
                )}
              >
                {SEV_LABELS[sev]}
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Risk list */}
      <div className="surface-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-[rgba(255,59,74,0.05)] px-[19px] py-[13px]">
          <strong className="flex items-center gap-1 font-mono text-[12px] text-ink">
            <span className="inline-flex w-4 justify-end overflow-hidden">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={filtered.length}
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -10, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="tabular-nums"
                >
                  {filtered.length}
                </motion.span>
              </AnimatePresence>
            </span>
            finding{filtered.length !== 1 ? "s" : ""}
          </strong>
          <span className="text-[12px] text-ink-dim">Sorted by severity</span>
        </div>

        <div className="scroll-thin max-h-[400px] overflow-y-auto">
          <AnimatePresence mode="popLayout" initial={false}>
            {rows.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.2 }}
                className="p-[46px] text-center text-[13px] text-ink-faint"
              >
                <IconSearch className="mx-auto mb-2 h-6 w-6 opacity-40" />
                No findings match your search.
              </motion.div>
            ) : (
              rows.map((row) =>
                row.type === "header" ? (
                  <motion.div
                    key={row.key}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={LAYOUT_SPRING}
                    className={cn(
                      "sticky top-0 z-[1] flex items-center justify-between border-b px-[19px] py-[9px] font-mono text-[11px] font-semibold uppercase tracking-[0.07em]",
                      GROUP_LABEL[row.sev]
                    )}
                  >
                    <span>{SEV_LABELS[row.sev]}</span>
                    <span className="font-bold tabular-nums">{row.count}</span>
                  </motion.div>
                ) : (
                  <motion.div
                    key={row.key}
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -16, scale: 0.97 }}
                    transition={{ ...LAYOUT_SPRING, delay: Math.min(row.index * 0.03, 0.12) }}
                    className="flex items-start gap-3.5 border-b border-border px-[19px] py-3.5 transition-colors duration-150 last:border-b-0 hover:bg-surface-2"
                  >
                    <div className={cn("mt-[5px] h-2 w-2 shrink-0 rounded-full", DOT[row.sev])} />
                    <div className="flex-1">
                      <div className="mb-[3px] text-[13px] font-semibold leading-[1.4] text-ink">
                        {row.risk.title}
                      </div>
                      <div className="text-[12px] leading-[1.5] text-ink-dim">
                        {row.risk.desc}
                      </div>
                      <div className="mt-1 font-mono text-[11px] font-medium text-crimson-light">
                        {row.risk.src}
                      </div>
                    </div>
                    <Badge variant={row.sev} size="sm" className="mt-0.5">
                      {SEV_LABELS[row.sev]}
                    </Badge>
                  </motion.div>
                )
              )
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="mt-[18px] flex justify-end gap-2">
        <Button variant="primary">
          <IconFileTypePdf className="h-4 w-4" /> Download PDF
        </Button>
        <Button variant="sea">
          <IconPresentation className="h-4 w-4" /> Download PPTX
        </Button>
      </div>
    </PageShell>
  );
}
