import { useMemo } from "react";
import { motion } from "framer-motion";
import { RISKS, SEV_SUMMARY, SEV_ORDER, SEV_LABELS } from "@/data/risks";

// Severity colour (space-separated RGB for use in rgb(... / alpha)).
const SEV_RGB = {
  vh: "227 28 47",
  h: "255 122 61",
  m: "255 178 62",
  mn: "194 163 107",
  l: "113 122 136",
};

// Brightened, high-contrast tone for the big severity counts so they read
// cleanly against the dark panel.
const SEV_VAL = { vh: "#ff6b72", h: "#ff9061", m: "#ffc061", mn: "#d6bd8a", l: "#aab2bf" };

// Where each severity orbits: Very High hugs the core, Low rides the perimeter.
const BAND = { vh: 0.36, h: 0.52, m: 0.68, mn: 0.84, l: 0.96 };

// Weighting used to roll the findings up into a single 0–100 risk index.
const WEIGHT = { vh: 10, h: 7, m: 4, mn: 2, l: 1 };

const SIZE = 264;
const R = 118; // max blip radius
const C = SIZE / 2; // centre

function verdictFor(index) {
  if (index >= 70) return { label: "Very High", rgb: SEV_RGB.vh };
  if (index >= 45) return { label: "High", rgb: SEV_RGB.h };
  if (index >= 25) return { label: "Medium", rgb: SEV_RGB.m };
  if (index >= 12) return { label: "Minor", rgb: SEV_RGB.mn };
  return { label: "Low", rgb: SEV_RGB.l };
}

export function RiskRadar() {
  // Deterministic blip placement: golden-angle spiral for an organic spread,
  // radius fixed by severity band with a little jitter so rings aren't rigid.
  const blips = useMemo(
    () =>
      RISKS.map((r, i) => {
        const ang = i * 137.508 * (Math.PI / 180);
        const jitter = ((i % 3) - 1) * 7;
        const rad = (BAND[r.sev] ?? 0.93) * R + jitter;
        return {
          ...r,
          i,
          x: C + rad * Math.cos(ang),
          y: C + rad * Math.sin(ang),
        };
      }),
    []
  );

  const total = SEV_SUMMARY.reduce((s, v) => s + v.count, 0);
  const score = SEV_SUMMARY.reduce((s, v) => s + v.count * WEIGHT[v.sev], 0);
  const index = total === 0 ? 0 : Math.min(100, Math.round((score / (total * 10)) * 100));
  const verdict = verdictFor(index);

  const vhCount = SEV_SUMMARY.find((s) => s.sev === "vh")?.count ?? 0;
  const hCount = SEV_SUMMARY.find((s) => s.sev === "h")?.count ?? 0;

  return (
    <div className="surface-panel mb-6 grid grid-cols-1 items-stretch gap-9 overflow-hidden p-8 lg:grid-cols-[264px_minmax(0,1fr)_1px_minmax(0,1fr)]">
      {/* Radar */}
      <div
        className="relative mx-auto"
        style={{ width: SIZE, height: SIZE }}
      >
        {/* outer dish */}
        <div className="absolute inset-0 rounded-full border border-white/[0.08] bg-[radial-gradient(circle_at_50%_50%,rgba(255,59,74,0.05),transparent_62%)] shadow-[inset_0_0_50px_rgba(0,0,0,0.6)]" />

        {/* concentric severity rings */}
        {Object.values(BAND).map((f) => (
          <div
            key={f}
            className="absolute rounded-full border border-white/[0.06]"
            style={{
              width: 2 * R * f,
              height: 2 * R * f,
              left: C,
              top: C,
              transform: "translate(-50%,-50%)",
            }}
          />
        ))}

        {/* crosshair */}
        <div className="absolute left-1/2 top-2 h-[calc(100%-1rem)] w-px -translate-x-1/2 bg-white/[0.05]" />
        <div className="absolute top-1/2 left-2 h-px w-[calc(100%-1rem)] -translate-y-1/2 bg-white/[0.05]" />

        {/* sweeping beam — pure CSS rotation so it runs on the compositor and
            doesn't keep framer-motion's main-thread frame loop alive. That loop
            was making hover/scroll on the Results page feel sluggish. */}
        <div
          aria-hidden
          className="radar-sweep absolute inset-0 rounded-full"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, transparent 288deg, rgba(255,59,74,0.04) 320deg, rgba(255,59,74,0.26) 350deg, rgba(255,124,115,0.5) 360deg)",
          }}
        />

        {/* blips */}
        {blips.map((b) => {
          const rgb = SEV_RGB[b.sev] ?? "113 122 136";
          return (
          <motion.div
            key={b.i}
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full"
            style={{
              left: b.x,
              top: b.y,
              background: `rgb(${rgb})`,
              boxShadow: `0 0 10px 1px rgb(${rgb} / 0.85)`,
            }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
              delay: 0.35 + b.i * 0.05,
              type: "spring",
              stiffness: 380,
              damping: 16,
            }}
            whileHover={{ scale: 1.7 }}
            title={`${SEV_LABELS[b.sev]} — ${b.title}`}
          />
          );
        })}

        {/* centre hub */}
        <div
          className="absolute left-1/2 top-1/2 flex h-[80px] w-[80px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border bg-[#0a0c10]"
          style={{
            borderColor: `rgb(${verdict.rgb} / 0.55)`,
            boxShadow: `0 0 34px rgb(${verdict.rgb} / 0.35), inset 0 0 20px rgb(${verdict.rgb} / 0.2)`,
          }}
        >
          <div
            className="font-mono text-[24px] font-bold leading-none"
            style={{ color: `rgb(${verdict.rgb})` }}
          >
            {index}
          </div>
          <div className="mt-1 font-mono text-[7.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Risk index
          </div>
        </div>
      </div>

      {/* Posture readout */}
      <div className="flex flex-col justify-center gap-4 text-center">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
          Security posture
        </div>

        <div className="flex items-end justify-center gap-3">
          <span
            className="font-mono text-[46px] font-bold leading-none"
            style={{
              color: `rgb(${verdict.rgb})`,
              textShadow: `0 0 28px rgb(${verdict.rgb} / 0.4)`,
            }}
          >
            {index}
          </span>
          <span className="mb-1.5 font-mono text-[13px] text-ink-faint">
            / 100
          </span>
          <span
            className="mb-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold"
            style={{
              color: `rgb(${verdict.rgb})`,
              background: `rgb(${verdict.rgb} / 0.12)`,
              boxShadow: `inset 0 0 0 1px rgb(${verdict.rgb} / 0.4)`,
            }}
          >
            {verdict.label}
          </span>
        </div>

        <p className="mx-auto max-w-[360px] text-[12.5px] leading-[1.65] text-ink-dim">
          {vhCount} very-high and {hCount} high-severity risks orbit closest to
          the core — worth reviewing first before you decide on this vendor.
        </p>
      </div>

      {/* Center divider — sits in the gutter, equidistant from both panes */}
      <div
        aria-hidden
        className="hidden w-px self-stretch bg-white/[0.08] lg:block"
      />

      {/* Severity breakdown — the counts, rendered plainly (no card chrome) */}
      <div className="flex flex-col justify-center gap-5">
        <div className="text-center font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
          Findings by severity
        </div>

        <div className="mx-auto grid w-full max-w-[320px] grid-cols-2 gap-x-8 gap-y-6">
          {SEV_ORDER.map((sev) => {
            const count = SEV_SUMMARY.find((s) => s.sev === sev)?.count ?? 0;
            return (
              <div
                key={sev}
                className="flex flex-col items-center gap-1.5 text-center"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: `rgb(${SEV_RGB[sev] ?? "113 122 136"})`,
                      boxShadow: `0 0 7px rgb(${SEV_RGB[sev] ?? "113 122 136"} / 0.8)`,
                    }}
                  />
                  <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
                    {SEV_LABELS[sev]}
                  </span>
                </div>
                <span
                  className="font-mono text-[36px] font-bold leading-none"
                  style={{
                    color: SEV_VAL[sev] ?? "#aab2bf",
                    textShadow: `0 0 22px rgb(${SEV_RGB[sev] ?? "113 122 136"} / 0.3)`,
                  }}
                >
                  {count}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
