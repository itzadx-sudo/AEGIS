import { useState } from "react";
import {
  IconCloudUpload,
  IconDatabase,
  IconFileTypePdf,
  IconFileSpreadsheet,
  IconShieldLock,
  IconTable,
  IconFiles,
  IconCircleCheck,
  IconPlus,
  IconArrowRight,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";

// Live ingestion feed (maps to the upload responses' parsed/processing status).
const FEED = [
  { name: "Vendor_HECVAT_v2.xlsx", role: "HECVAT", pct: 100, status: "ok", icon: IconFileSpreadsheet, tone: "bg-[var(--gold-pale)] text-gold" },
  { name: "SOC2_Type2_Report.pdf", role: "SOC 2", pct: 100, status: "ok", icon: IconFileTypePdf, tone: "bg-[var(--alarm-pale)] text-alarm-light" },
  { name: "Murdoch_Policy.pdf", role: "Policy", pct: 62, status: "wait", icon: IconShieldLock, tone: "bg-[var(--crimson-pale)] text-crimson-light" },
];

// Typed supporting-evidence slots — one per backend ingest endpoint.
const EVIDENCE = [
  { key: "soc2", title: "SOC 2 Type 2", hint: "Vendor audit report", icon: IconFileTypePdf, parsed: true },
  { key: "policy", title: "Internal Policy", hint: "Murdoch policy PDF", icon: IconShieldLock, parsed: true },
  { key: "template", title: "HECVAT Template", hint: "Guidance reference", icon: IconTable, parsed: false },
  { key: "other", title: "Other Evidence", hint: "Any vendor docs", icon: IconFiles, parsed: false },
];

export function UploadPage({ navigate }) {
  const [service, setService] = useState("");
  const [slots, setSlots] = useState(() =>
    Object.fromEntries(EVIDENCE.map((e) => [e.key, e.parsed]))
  );

  return (
    <PageShell>
      <PageHeader
        title="Upload documents"
        subtitle="Start with the vendor's filled HECVAT. Supporting docs like SOC 2 reports help back up their answers."
      />

      <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]">
        {/* Hero intake — the document Aegis actually assesses */}
        <div className="upload-glow relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-crimson-deep bg-gradient-to-br from-[rgba(255,59,74,0.05)] to-[rgba(255,122,61,0.06)] px-8 py-12 text-center transition-all hover:border-crimson hover:from-[rgba(255,59,74,0.1)] hover:to-[rgba(255,122,61,0.1)]">
          <div className="mx-auto mb-5 flex h-[64px] w-[64px] items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--crimson-light)] to-[var(--crimson)] text-white shadow-[0_18px_42px_rgba(255,59,74,0.5)]">
            <IconCloudUpload className="h-7 w-7" />
          </div>
          <h3 className="mb-2 text-[18px] font-semibold text-white">
            Add the vendor's HECVAT
          </h3>
          <p className="mb-6 max-w-[400px] text-[13px] leading-[1.6] text-ink-dim">
            Drop the filled .xlsx here. We'll check each answer against your
            policies and flag the gaps.
          </p>

          <div className="flex w-full max-w-[420px] flex-col gap-2.5">
            <Input
              placeholder="Vendor / service name…"
              value={service}
              onChange={(e) => setService(e.target.value)}
            />
            <Button variant="primary">Browse files</Button>
          </div>
        </div>

        {/* Live ingestion feed */}
        <div className="surface-panel flex flex-col p-5">
          <div className="flex items-center justify-between border-b border-border pb-3.5">
            <div className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
              <IconDatabase className="h-4 w-4 text-crimson-light" />
              Ingestion feed
            </div>
            <Badge variant="count" size="default">
              {FEED.length} files
            </Badge>
          </div>

          <div className="mt-3.5 flex flex-1 flex-col gap-2.5">
            {FEED.map((f) => (
              <div
                key={f.name}
                className="rounded-xl border border-border bg-void-2 px-3.5 py-3 transition-all hover:border-[var(--crimson-pale)]"
              >
                <div className="flex items-center gap-3">
                  <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]", f.tone)}>
                    <f.icon className="h-4 w-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[12.5px] font-medium text-ink">
                      {f.name}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                      {f.role}
                    </span>
                  </span>
                  <Badge variant={f.status} size="default">
                    {f.status === "ok" ? "Parsed" : "Processing…"}
                  </Badge>
                </div>
                {f.status !== "ok" && <Progress value={f.pct} className="mt-2.5" />}
              </div>
            ))}
          </div>

          {/* Knowledge-base stats */}
          <div className="mt-4 flex items-center gap-4 border-t border-border pt-4 font-mono text-[11px] text-ink-faint">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-crimson-light" />
              12 policies
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-gold" />
              48 SOC 2 controls
            </span>
          </div>
        </div>
      </div>

      {/* Supporting evidence — typed slots */}
      <div className="mt-6">
        <div className="mb-3 flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          Supporting evidence
          <span className="font-sans text-[11px] normal-case tracking-normal text-ink-faint/70">
            · optional, improves corroboration
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {EVIDENCE.map((slot) => {
            const parsed = slots[slot.key];
            return (
              <button
                key={slot.key}
                onClick={() =>
                  setSlots((s) => ({ ...s, [slot.key]: !s[slot.key] }))
                }
                className="surface-panel group flex flex-col items-start gap-3 p-4 text-left transition-colors duration-200 hover:border-crimson"
              >
                <span
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors",
                    parsed
                      ? "bg-[var(--crimson-pale)] text-crimson-light"
                      : "bg-surface-2 text-ink-faint group-hover:text-crimson-light"
                  )}
                >
                  <slot.icon className="h-[18px] w-[18px]" />
                </span>
                <div>
                  <div className="text-[13px] font-semibold text-ink">
                    {slot.title}
                  </div>
                  <div className="text-[11.5px] text-ink-dim">{slot.hint}</div>
                </div>
                <span
                  className={cn(
                    "mt-0.5 inline-flex items-center gap-1 font-mono text-[10.5px] font-medium uppercase tracking-[0.06em]",
                    parsed ? "text-crimson-light" : "text-ink-faint"
                  )}
                >
                  {parsed ? (
                    <>
                      <IconCircleCheck className="h-3.5 w-3.5" /> Parsed
                    </>
                  ) : (
                    <>
                      <IconPlus className="h-3.5 w-3.5" /> Add file
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-7 flex justify-end">
        <Button variant="sea" onClick={() => navigate("analysis")}>
          Start analysis <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </PageShell>
  );
}
