import { useEffect, useRef, useState } from "react";
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
  IconLoader2,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { api, adaptUploadFile } from "@/lib/api";

// Typed supporting-evidence slots — each maps to one backend ingest endpoint.
const EVIDENCE = [
  { key: "soc2", title: "SOC 2 Type 2", hint: "Vendor audit report", icon: IconFileTypePdf, upload: api.uploadSoc2, role: "SOC 2", accept: ".pdf" },
  { key: "policy", title: "Internal Policy", hint: "Murdoch policy PDF", icon: IconShieldLock, upload: api.uploadPolicy, role: "Policy", accept: ".pdf" },
  { key: "template", title: "HECVAT Template", hint: "Guidance reference", icon: IconTable, upload: api.uploadHecvatTemplate, role: "Template", accept: ".xlsx,.xls" },
  { key: "other", title: "Other Evidence", hint: "Any vendor docs", icon: IconFiles, upload: api.uploadVendorDoc, role: "Evidence", accept: ".pdf,.docx,.doc" },
];

const ROLE_TONE = {
  HECVAT: "bg-[var(--gold-pale)] text-gold",
  "SOC 2": "bg-[var(--alarm-pale)] text-alarm-light",
  Policy: "bg-[var(--crimson-pale)] text-crimson-light",
  Template: "bg-[var(--gold-pale)] text-gold",
  Evidence: "bg-[var(--crimson-pale)] text-crimson-light",
};

const ROLE_ICON = {
  HECVAT: IconFileSpreadsheet,
  "SOC 2": IconFileTypePdf,
  Policy: IconShieldLock,
  Template: IconTable,
  Evidence: IconFiles,
};

export function UploadPage({ navigate, setSessionId }) {
  const [service, setService] = useState("");
  const [vendorFile, setVendorFile] = useState(null);
  const [feed, setFeed] = useState([]); // [{ name, role, status: "ok"|"wait"|"fail" }]
  const [slotStatus, setSlotStatus] = useState({}); // key -> "ok"|"wait"|"fail"
  const [kb, setKb] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const vendorInput = useRef(null);
  const slotInputs = useRef({});

  // Load real knowledge-base counts for the footer chips.
  useEffect(() => {
    let alive = true;
    api
      .kbStats()
      .then((s) => alive && setKb(s))
      .catch(() => alive && setKb(null));
    return () => {
      alive = false;
    };
  }, []);

  function upsertFeed(name, role, status) {
    setFeed((prev) => {
      const next = prev.filter((f) => f.name !== name);
      return [...next, { name, role, status }];
    });
  }

  function onVendorPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setVendorFile(file);
    upsertFeed(file.name, "HECVAT", "ok");
  }

  async function onSlotPick(slot, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setSlotStatus((s) => ({ ...s, [slot.key]: "wait" }));
    upsertFeed(file.name, slot.role, "wait");
    try {
      const resp = await slot.upload(file);
      const adapted = adaptUploadFile(resp);
      const status = adapted.status === "ok" ? "ok" : "fail";
      setSlotStatus((s) => ({ ...s, [slot.key]: status }));
      upsertFeed(file.name, slot.role, status);
      if (status === "fail") setError(`Couldn't parse ${file.name}.`);
    } catch (err) {
      setSlotStatus((s) => ({ ...s, [slot.key]: "fail" }));
      upsertFeed(file.name, slot.role, "fail");
      setError(err?.detail || `Failed to upload ${file.name}.`);
    }
  }

  async function startAnalysis() {
    if (!vendorFile) {
      setError("Add the vendor's filled HECVAT (.xlsx) first.");
      return;
    }
    setError("");
    setStarting(true);
    try {
      const up = await api.uploadVendorHecvat(vendorFile, service.trim() || "Unknown Vendor");
      const sessionId = up.session_id;
      await api.startAnalysis(sessionId);
      setSessionId(sessionId);
      navigate("analysis");
    } catch (err) {
      setError(err?.detail || "Couldn't start the analysis. Is the API running?");
      setStarting(false);
    }
  }

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

          <input
            ref={vendorInput}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={onVendorPick}
          />

          <div className="flex w-full max-w-[420px] flex-col gap-2.5">
            <Input
              placeholder="Vendor / service name…"
              value={service}
              onChange={(e) => setService(e.target.value)}
            />
            <Button variant="primary" onClick={() => vendorInput.current?.click()}>
              {vendorFile ? "Choose a different file" : "Browse files"}
            </Button>
            {vendorFile && (
              <div className="flex items-center justify-center gap-1.5 font-mono text-[11.5px] text-crimson-light">
                <IconCircleCheck className="h-3.5 w-3.5" />
                {vendorFile.name}
              </div>
            )}
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
              {feed.length} file{feed.length !== 1 ? "s" : ""}
            </Badge>
          </div>

          <div className="mt-3.5 flex flex-1 flex-col gap-2.5">
            {feed.length === 0 ? (
              <div className="flex flex-1 items-center justify-center py-8 text-center text-[12px] text-ink-faint">
                No documents added yet.
              </div>
            ) : (
              feed.map((f) => {
                const Icon = ROLE_ICON[f.role] ?? IconFiles;
                const tone = ROLE_TONE[f.role] ?? "bg-void-2 text-ink-faint";
                return (
                  <div
                    key={f.name}
                    className="rounded-xl border border-border bg-void-2 px-3.5 py-3 transition-all hover:border-[var(--crimson-pale)]"
                  >
                    <div className="flex items-center gap-3">
                      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]", tone)}>
                        <Icon className="h-4 w-4" />
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
                        {f.status === "ok" ? "Parsed" : f.status === "fail" ? "Failed" : "Processing…"}
                      </Badge>
                    </div>
                    {f.status === "wait" && <Progress value={66} className="mt-2.5" />}
                  </div>
                );
              })
            )}
          </div>

          {/* Knowledge-base stats — live from the backend */}
          <div className="mt-4 flex items-center gap-4 border-t border-border pt-4 font-mono text-[11px] text-ink-faint">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-crimson-light" />
              {kb ? kb.internal_policies : "—"} policies
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-gold" />
              {kb ? kb.soc2_controls : "—"} SOC 2 controls
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
            const status = slotStatus[slot.key];
            const parsed = status === "ok";
            const busy = status === "wait";
            const failed = status === "fail";
            return (
              <div key={slot.key}>
                <input
                  ref={(el) => (slotInputs.current[slot.key] = el)}
                  type="file"
                  accept={slot.accept}
                  className="hidden"
                  onChange={(e) => onSlotPick(slot, e)}
                />
                <button
                  onClick={() => slotInputs.current[slot.key]?.click()}
                  className="surface-panel group flex w-full flex-col items-start gap-3 p-4 text-left transition-colors duration-200 hover:border-crimson"
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
                      parsed ? "text-crimson-light" : failed ? "text-alarm-light" : "text-ink-faint"
                    )}
                  >
                    {busy ? (
                      <>
                        <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> Parsing…
                      </>
                    ) : parsed ? (
                      <>
                        <IconCircleCheck className="h-3.5 w-3.5" /> Parsed
                      </>
                    ) : failed ? (
                      <>
                        <IconAlertTriangle className="h-3.5 w-3.5" /> Retry
                      </>
                    ) : (
                      <>
                        <IconPlus className="h-3.5 w-3.5" /> Add file
                      </>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-[var(--alarm-pale)] bg-[rgba(227,28,47,0.06)] px-4 py-3 text-[13px] text-alarm-light">
          <IconAlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="mt-7 flex justify-end">
        <Button variant="sea" onClick={startAnalysis} disabled={starting || !vendorFile}>
          {starting ? (
            <>
              <IconLoader2 className="h-4 w-4 animate-spin" /> Starting…
            </>
          ) : (
            <>
              Start analysis <IconArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </PageShell>
  );
}
