import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IconCloudUpload,
  IconDatabase,
  IconFileTypePdf,
  IconFileSpreadsheet,
  IconShieldLock,
  IconShieldCheck,
  IconCircleCheck,
  IconPlus,
  IconArrowRight,
  IconAlertTriangle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Field } from "@/lib/livingField";


// starting a new upload while one of these is active spawns a second run and detaches this one, hence the confirm dialog
const ACCEPTED_HECVAT_EXTS = [".xlsx", ".xlsm"];

const IN_PROGRESS = new Set([
  "queued", "assessing", "awaiting_followup", "ready_for_report", "resolving", "paused",
]);

export function UploadPage({ navigate, setSessionId, sessionId, sessionStatus }) {
  const [service, setService] = useState("");
  const [hecvatFile, setHecvatFile] = useState(null);
  const [feedItems, setFeedItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false); // shown when starting fresh would background an in-progress run
  const [confirmDup, setConfirmDup] = useState(false); // shown when the vendor name matches an existing session
  const [existingNames, setExistingNames] = useState([]); // lowercased names of existing sessions, for the dup check
  const [dragging, setDragging] = useState(false);

  const hasActiveRun = Boolean(sessionId) && IN_PROGRESS.has(sessionStatus);

  const hecvatInputRef = useRef(null);
  // h7: track whether we're still on this page so a slow upload can't navigate for us after we've left
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // pull existing session names so we can warn (not block) on a duplicate vendor name
  useEffect(() => {
    api.listSessions()
      .then((resp) => {
        if (!mountedRef.current) return;
        setExistingNames((resp.sessions ?? []).map((s) => (s.service_name ?? "").trim().toLowerCase()));
      })
      .catch(() => {}); // a failed lookup just means no dup warning — never blocks the upload
  }, []);

  // shared by the picker and the dropzone; nothing uploads until start analysis
  function pickHecvat(file) {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED_HECVAT_EXTS.includes(ext)) {
      setError(`${file.name} isn't a supported workbook — use ${ACCEPTED_HECVAT_EXTS.join(" or ")}.`);
      return;
    }
    setHecvatFile(file);
    setError(null);
    setFeedItems([{
      name: file.name,
      role: "HECVAT",
      status: "ready",
      icon: IconFileSpreadsheet,
      tone: "bg-[var(--gold-pale)] text-gold",
    }]);
  }

  function onHecvatPick(e) {
    pickHecvat(e.target.files?.[0]);
    // M10(a): reset so re-selecting the same file after a failure fires a change event
    e.target.value = "";
  }


  // clears the staged HECVAT before submit so a wrong file can be swapped out
  function clearHecvat() {
    setHecvatFile(null);
    setFeedItems([]);
    setError(null);
  }


  // validates and confirms first; the real work happens in doStartAnalysis
  function startAnalysis(e) {
    // validation errors show a warning and shift the layout — fire NO field effect on those clicks
    if (!hecvatFile) {
      setError("Please select the vendor's HECVAT file first.");
      return;
    }
    if (!service.trim()) {
      setError("Please enter a vendor / service name.");
      return;
    }
    // bloom on the next frame — the banner clearing shifts the button before it settles
    setError(null);
    const btn = e?.currentTarget;
    if (btn) {
      requestAnimationFrame(() => {
        const r = btn.getBoundingClientRect();
        Field.bloom(r.left + r.width / 2, r.top + r.height / 2);
      });
    }
    if (hasActiveRun) {
      setConfirmOpen(true);
      return;
    }
    if (isDuplicateName) {
      setConfirmDup(true);
      return;
    }
    doStartAnalysis();
  }

  function confirmStartNew() {
    setConfirmOpen(false);
    // still warn about a duplicate name after clearing the in-progress warning
    if (isDuplicateName) {
      setConfirmDup(true);
      return;
    }
    doStartAnalysis();
  }

  function confirmStartDup() {
    setConfirmDup(false);
    // tell the backend the warning was accepted, or it 409s and this button does nothing
    doStartAnalysis(true);
  }

  async function doStartAnalysis(allowDuplicate = false) {
    setLoading(true);
    setError(null);

    setFeedItems([{
      name: hecvatFile.name,
      role: "HECVAT",
      status: "uploading",
      icon: IconFileSpreadsheet,
      tone: "bg-[var(--gold-pale)] text-gold",
    }]);

    try {
      // this call is what actually creates the session
      const uploadResp = await api.uploadVendorHecvat(hecvatFile, service.trim(), allowDuplicate);

      setFeedItems([{
        name: hecvatFile.name,
        role: "HECVAT",
        status: "ok",
        icon: IconFileSpreadsheet,
        tone: "bg-[var(--gold-pale)] text-gold",
      }]);

      // set this before starting, so a failed start doesn't orphan the session
      if (!mountedRef.current) return;
      setSessionId(uploadResp.session_id);

      try {
        // assessment runs in the background from here on, we just navigate away
        await api.startAnalysis(uploadResp.session_id);
      } catch (startErr) {
        if (!mountedRef.current) return;
        // a 409 (e.g. another assessment already running) carries a clear reason in .detail — show that verbatim
        const msg = startErr.status === 409
          ? (startErr.detail ?? startErr.message)
          : (startErr.message ?? "Failed to start analysis.") + " The file uploaded fine — please try starting the analysis again.";
        setError(msg);
        setFeedItems((f) => f.map((i) => ({ ...i, status: "fail" })));
        return;
      }

      if (!mountedRef.current) return;
      navigate("analysis");
    } catch (err) {
      // 409 means duplicate name — surface a clear message rather than a raw API error
      const msg = err?.status === 409
        ? (err?.detail ?? err?.message ?? "A session with this name already exists. Please use a different vendor name.")
        : (err?.message ?? "Upload failed. Check the API server is running.");
      setError(msg);
      setFeedItems((f) => f.map((i) => ({ ...i, status: "fail" })));
    } finally {
      setLoading(false);
    }
  }

  const readyToStart = Boolean(hecvatFile) && Boolean(service.trim());
  const isDuplicateName = existingNames.includes(service.trim().toLowerCase());

  return (
    <PageShell>
      <PageHeader
        title="Upload documents"
        subtitle="Start with the vendor's filled HECVAT. Supporting docs like SOC 2 reports help back up their answers."
      />

      <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]">
        {/* clicking anywhere in this box opens the file picker, not just the button */}
        <div
          data-fx="bloom"
          // without preventDefault on dragover, a real drop navigates away and opens the file
          role="button"
          tabIndex={0}
          aria-label="Add the vendor's HECVAT — click or drop a file"
          className={cn(
            "upload-glow surface-panel relative flex cursor-pointer flex-col items-center justify-center overflow-hidden border-dashed px-8 py-12 text-center transition-colors",
            dragging
              ? "border-crimson bg-[rgba(255,59,74,0.06)]"
              : "border-[rgba(255,90,100,0.28)] hover:border-crimson"
          )}
          onClick={() => hecvatInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return; // let the name field type its own spaces/enters
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hecvatInputRef.current?.click(); }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return; // only an inner element, not a real leave
            setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer?.files?.[0];
            if (file) pickHecvat(file);
          }}
        >
          <div className="mx-auto mb-5 flex h-[64px] w-[64px] items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--crimson-light)] to-[var(--crimson)] text-white shadow-[0_18px_42px_rgba(255,59,74,0.5)]">
            <IconCloudUpload className="h-7 w-7" />
          </div>
          <h3 className="mb-2 text-[18px] font-semibold text-white">
            {hecvatFile ? hecvatFile.name : "Add the vendor's HECVAT"}
          </h3>
          <p className="mb-6 max-w-[400px] text-[13px] leading-[1.6] text-ink-dim">
            {hecvatFile
              ? "File selected. Enter a vendor name below and click Start analysis."
              : "Drop the filled HECVAT (.xlsx) here. We'll check each answer against your policies and flag the gaps."}
          </p>

          <div
            className="flex w-full max-w-[420px] flex-col gap-2.5"
            onClick={(e) => e.stopPropagation()}
          >
            <label
              htmlFor="vendor-service-name"
              className="text-left font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim"
            >
              Vendor / service name
            </label>
            <div
              className={cn(
                "flex items-center rounded-xl border-2 bg-void-2 px-3.5 py-2.5 shadow-[0_4px_18px_rgba(0,0,0,0.35)] transition-colors",
                service.trim() ? "border-crimson-light" : "border-crimson-deep focus-within:border-crimson-light"
              )}
            >
              <Input
                id="vendor-service-name"
                placeholder="e.g. Acme Cloud Services"
                value={service}
                onChange={(e) => setService(e.target.value)}
                className="text-[14px] placeholder:text-ink-faint"
              />
            </div>
            <Button
              variant="primary"
              onClick={() => hecvatInputRef.current?.click()}
            >
              {hecvatFile ? "Change file" : "Browse files"}
            </Button>
          </div>

          {/* native input stays hidden, triggered programmatically via hecvatInputRef */}
          <input
            ref={hecvatInputRef}
            type="file"
            accept=".xlsx,.xlsm"
            className="hidden"
            onChange={onHecvatPick}
          />
        </div>

        {/* mirrors whatever's in feedItems — empty state, uploading, or parsed */}
        <div className="upload-glow surface-panel relative flex flex-col overflow-hidden p-5">
          <div className="flex items-center justify-between border-b border-border pb-3.5">
            <div className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
              <IconDatabase className="h-4 w-4 text-crimson-light" />
              Ingestion feed
            </div>
            <Badge variant="count" size="default">
              {feedItems.length} file{feedItems.length !== 1 ? "s" : ""}
            </Badge>
          </div>

          <div className="mt-3.5 flex flex-1 flex-col gap-2.5">
            {feedItems.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-[12px] text-ink-faint">
                No files uploaded yet
              </div>
            ) : (
              feedItems.map((f) => (
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
                    <Badge variant={f.status === "ok" ? "ok" : f.status === "fail" ? "fail" : f.status === "uploading" ? "wait" : "ok"} size="default">
                      {f.status === "ok" ? "Parsed" : f.status === "fail" ? "Failed" : f.status === "uploading" ? "Uploading…" : "Ready"}
                    </Badge>
                    {/* let the user swap out a wrong file before starting — not while it's uploading */}
                    {f.status === "ready" && !loading && (
                      <button
                        type="button"
                        onClick={clearHecvat}
                        aria-label="Remove file"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-alarm/10 hover:text-alarm-light"
                      >
                        <IconX className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>


      {error && (
        <div className="mt-4 rounded-xl border border-alarm/30 bg-alarm/10 px-4 py-3 text-[13px] text-alarm-light">
          {error}
        </div>
      )}

      <div className="mt-7 flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        <span className="font-mono text-[11.5px] text-ink-faint">
          {readyToStart ? "Ready to assess" : ""}
        </span>
        <Button
          variant="sea"
          data-fx="none"
          onClick={startAnalysis}
          disabled={loading}
          className={cn(
            "px-6 py-3 text-[13px]",
            readyToStart && !loading && "shadow-[0_14px_34px_rgba(168,17,42,0.4)]"
          )}
        >
          {loading ? (
            <><IconLoader2 className="h-[18px] w-[18px] animate-spin" /> Starting analysis…</>
          ) : (
            <>
              <IconShieldCheck className="h-[18px] w-[18px]" />
              Start analysis
              <IconArrowRight className="h-[18px] w-[18px]" />
            </>
          )}
        </Button>
      </div>

      {/* only shown when hasActiveRun trips the guard in startAnalysis */}
      <AnimatePresence>
        {confirmOpen && (
          <motion.div
            className="fixed inset-0 z-[80] flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0 } }}
          >
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setConfirmOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="surface-panel relative z-10 w-full max-w-[420px] p-6 text-center"
            >
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--gold-pale)] text-gold">
                <IconAlertTriangle className="h-6 w-6" />
              </span>
              <h3 className="mb-2 text-[16px] font-semibold text-white">
                An assessment is already in progress
              </h3>
              <p className="mb-6 text-[13px] leading-[1.6] text-ink-dim">
                Starting a new HECVAT won't stop the current run — it keeps going in the
                background and stays in your history. This new assessment simply becomes the
                one you're viewing.
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="default" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button variant="sea" onClick={confirmStartNew}>
                  Start new anyway <IconArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* non-blocking heads-up when the vendor name matches an existing session — re-running a vendor is legitimate */}
      <AnimatePresence>
        {confirmDup && (
          <motion.div
            className="fixed inset-0 z-[80] flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0 } }}
          >
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setConfirmDup(false)}
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="surface-panel relative z-10 w-full max-w-[420px] p-6 text-center"
            >
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--gold-pale)] text-gold">
                <IconAlertTriangle className="h-6 w-6" />
              </span>
              <h3 className="mb-2 text-[16px] font-semibold text-white">
                A session named &ldquo;{service.trim()}&rdquo; already exists
              </h3>
              <p className="mb-6 text-[13px] leading-[1.6] text-ink-dim">
                That's fine if you're re-running this vendor — each assessment is tracked separately.
                Just checking it wasn't a mistake.
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="default" onClick={() => setConfirmDup(false)}>
                  Cancel
                </Button>
                <Button variant="sea" onClick={confirmStartDup}>
                  Continue anyway <IconArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
