// the only place that talks to the API; leave VITE_API_BASE_URL unset and vite proxies to :8080

import { SEV_LABELS } from "@/data/risks";

const BASE_URL = (import.meta.env?.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const CSRF_COOKIE = import.meta.env?.VITE_CSRF_COOKIE ?? "sedona_csrf";

// the little subtitle under each severity stat card
const SEV_TAGS = {
  vh: "Immediate action",
  h: "Review required",
  m: "Monitor",
  mn: "Track",
  l: "Noted",
};

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

// the marker normalize_finding writes for fields a legacy finding never recorded — not content
const MIGRATION_PLACEHOLDER = "unavailable";
function real(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === MIGRATION_PLACEHOLDER) return null;
  return value;
}

function cookieValue(name) {
  if (typeof document === "undefined") return "";
  const prefix = `${encodeURIComponent(name)}=`;
  const part = document.cookie.split("; ").find((item) => item.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : "";
}

// past this, we abort and throw a timeout error instead of leaving the ui spinning forever
const DEFAULT_TIMEOUT_MS = 30_000;

async function request(
  path,
  { method = "GET", body, form, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  // wrap the caller's signal (if any) in our own so either a timeout or an external cancel can abort the fetch
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // the session token is an HttpOnly cookie — JS never touches it, the browser attaches it
  const opts = { method, signal: controller.signal, headers: {}, credentials: "include" };
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    const csrf = cookieValue(CSRF_COOKIE);
    if (csrf) opts.headers["X-CSRF-Token"] = csrf;
  }
  if (form) {
    // don't set content-type ourselves — the browser needs to add the multipart boundary
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, opts);
  } catch (err) {
    if (timedOut) {
      throw new ApiError(
        0,
        "Request timed out — the server took too long to respond.",
        `${method} ${path} exceeded ${Math.round(timeoutMs / 1000)}s`
      );
    }
    // m9: distinguish a caller-initiated abort from a real network failure
    if (err.name === "AbortError" && !timedOut) {
      throw new ApiError(0, "Request cancelled.", "aborted");
    }
    // m7: wrap raw network failure (offline/DNS/CORS/reset) as ApiError so err.detail is always safe to read
    throw new ApiError(0, "Network error — could not reach the server.", err.message);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === "object") {
        detail = parsed.detail ?? res.statusText;
      }
    } catch {
      detail = res.statusText;
    }
    if (res.status === 401 && !path.startsWith("/auth/login") && typeof window !== "undefined") {
      window.dispatchEvent(new Event("sedona:unauthorized"));
    }
    throw new ApiError(res.status, `${method} ${path} failed (${res.status})`, detail);
  }

  if (res.status === 204) return null;
  // non-json responses (report downloads) come back as a blob for the caller to save
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return res.blob();
  // h8: a 2xx with malformed json would throw a raw SyntaxError without this guard
  try {
    return await res.json();
  } catch (err) {
    throw new ApiError(res.status, "Invalid JSON response", err.message);
  }
}

const uploadForm = (file) => {
  const fd = new FormData();
  fd.append("file", file);
  return fd;
};

// uploads and downloads take longer than the default timeout allows for, so they get their own
const LONG_TIMEOUT_MS = 120_000;

// biggest read in the app — 750KB on a full run. higher than this just lets a dead connection sit
const RESULTS_TIMEOUT_MS = 45_000;

// this one gates the whole app, so fail fast and retry rather than sit on a blank screen
const AUTH_TIMEOUT_MS = 8_000;

export const api = {
  login: (username, password) =>
    request("/auth/login", { method: "POST", body: { username, password } }),
  signup: (username, displayName, password) =>
    request("/auth/signup", {
      method: "POST",
      body: { username, display_name: displayName, password },
    }),
  me: () => request("/auth/me", { timeoutMs: AUTH_TIMEOUT_MS }),
  logout: () => request("/auth/logout", { method: "POST" }),
  listUsers: () => request("/auth/users"),
  createUser: (user) => request("/auth/users", { method: "POST", body: user }),
  setUserDisabled: (userId, disabled) =>
    request(`/auth/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: { disabled },
    }),
  deleteUser: (userId) =>
    request(`/auth/users/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  resetUserPassword: (userId, password) =>
    request(`/auth/users/${encodeURIComponent(userId)}/password`, {
      method: "POST",
      body: { password },
    }),
  uploadPolicy: (file) =>
    request("/uploads/policy", { method: "POST", form: uploadForm(file), timeoutMs: LONG_TIMEOUT_MS }),
  uploadHecvatTemplate: (file) =>
    request("/uploads/hecvat-template", { method: "POST", form: uploadForm(file), timeoutMs: LONG_TIMEOUT_MS }),
  uploadSessionSoc2: (sessionId, file) =>
    request(`/sessions/${sessionId}/evidence/soc2`, {
      method: "POST",
      form: uploadForm(file),
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  uploadSessionVendorDoc: (sessionId, file) =>
    request(`/sessions/${sessionId}/evidence/vendor-doc`, {
      method: "POST",
      form: uploadForm(file),
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  listSessionEvidence: (sessionId) => request(`/sessions/${sessionId}/evidence`),
  // the call that creates a session; allowDuplicate follows the confirmed name warning
  uploadVendorHecvat: (file, serviceName = "Unknown Vendor", allowDuplicate = false) =>
    request(`/uploads/vendor-hecvat?service_name=${encodeURIComponent(serviceName)}${allowDuplicate ? "&allow_duplicate=true" : ""}`, {
      method: "POST",
      form: uploadForm(file),
      timeoutMs: LONG_TIMEOUT_MS,
    }),
  kbStats: () => request("/knowledge-base/stats"),
  // what's actually indexed, so a wrongly-uploaded document can be found and removed
  kbDocuments: () => request("/knowledge-base/documents"),
  deleteKbDocument: (collection, docId) =>
    request(`/knowledge-base/documents/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`, {
      method: "DELETE",
    }),

  startAnalysis: (sessionId) =>
    request(`/sessions/${sessionId}/start-analysis`, { method: "POST" }),

  // short timeout: on the default 30s a dropped network wedges the poller for half a minute
  getSessionStatus: (sessionId, { signal, timeoutMs = 8000 } = {}) =>
    request(`/sessions/${sessionId}/status`, { signal, timeoutMs }),
  getQuestions: (sessionId) => request(`/sessions/${sessionId}/questions`),
  submitAnswer: (sessionId, controlId, answer) =>
    request(`/sessions/${sessionId}/answers/${controlId}`, {
      method: "POST",
      body: { control_id: controlId, answer },
    }),
  editAnswer: (sessionId, controlId, answer) =>
    request(`/sessions/${sessionId}/answers/${controlId}`, {
      method: "PUT",
      body: { control_id: controlId, answer },
    }),
  skipQuestion: (sessionId, controlId, reason = "") =>
    request(`/sessions/${sessionId}/questions/${controlId}/skip`, {
      method: "POST",
      body: { control_id: controlId, reason },
    }),
  submitAnswersBatch: (sessionId, answers, pauseAfter = false) =>
    request(`/sessions/${sessionId}/answers`, {
      method: "POST",
      body: {
        answers: answers.map(({ controlId, answer }) => ({
          control_id: controlId,
          answer,
        })),
        pause_after: pauseAfter,
      },
    }),
  pauseSession: (sessionId) =>
    request(`/sessions/${sessionId}/pause`, { method: "POST" }),
  resumeSession: (sessionId) =>
    request(`/sessions/${sessionId}/resume`, { method: "POST" }),

  generateReport: (sessionId) =>
    request(`/sessions/${sessionId}/generate-report`, { method: "POST" }),

  // severity filter is optional — omit it to get everything back
  getResults: (sessionId, severity, { signal, timeoutMs = RESULTS_TIMEOUT_MS } = {}) =>
    request(
      `/sessions/${sessionId}/results${
        severity ? `?severity=${encodeURIComponent(severity)}` : ""
      }`,
      { signal, timeoutMs }
    ),

  listSessions: () => request("/sessions"),
  deleteSession: (sessionId) =>
    request(`/sessions/${sessionId}`, { method: "DELETE" }),
  assignSession: (sessionId, userIds) =>
    request(`/sessions/${sessionId}/assign`, {
      method: "POST",
      body: { user_ids: userIds },
    }),

  // goes through request() instead of a plain <a href> so the authenticated cookie is included
  downloadReport: (sessionId, fmt = "pdf") =>
    request(`/sessions/${sessionId}/report/download?fmt=${fmt}`, { timeoutMs: LONG_TIMEOUT_MS }),

  health: () => request("/health"),
};

// reshapes the backend's question payload into what AnalysisPage already expects
export function adaptQuestions(resp) {
  return {
    items: (resp.items ?? []).map((q) => ({
      id: q.control_id,
      text: q.question,
      ref: q.reference,
      answered: q.answered,
      answer: q.answer ?? null,
      skipped: q.skipped ?? false,
      skip: q.skip ?? null,
    })),
    total: resp.total ?? 0,
    answeredCount: resp.answered_count ?? 0,
  };
}

// builds both the stat-card summary and the risk list that ResultsPage/RiskRadar render
export function adaptResults(resp) {
  const counts = resp.counts ?? { vh: 0, h: 0, m: 0, mn: 0, l: 0 };
  return {
    counts,
    serviceName: resp.service_name ?? "",
    summary: ["vh", "h", "m", "mn", "l"].map((sev) => ({
      sev,
      label: SEV_LABELS[sev],
      count: counts[sev] ?? 0,
      tag: SEV_TAGS[sev],
    })),
    risks: (resp.risks ?? []).map((r) => ({
      sev: r.severity,
      title: r.title,
      desc: r.description,
      src: r.source,
      controlId: r.control_id,
      recommendation: r.recommendation,
      policyAlignment: r.policy_alignment ?? null,
      policyClause: r.policy_clause_referenced ?? null,
      riskCategories: r.risk_categories ?? [],
      riskDescription: real(r.risk_description),
      cause: real(r.cause),
      consequence: real(r.consequence),
      consequenceCategory: r.consequence_category ?? null,
      // map the "Unavailable" migration placeholder back to null so the modal drops the row
      // instead of rendering it as though the workbook said it
      sourceLocation: [
        real(r.source_workbook),
        real(r.source_worksheet),
        r.source_row ? `row ${r.source_row}` : null,
        real(r.source_cell),
      ].filter(Boolean).join(" · ") || null,
      requirement: real(r.requirement),
      vendorResponse: real(r.vendor_response),
      initialRisk: r.initial_risk_rating
        ? `L${r.initial_likelihood ?? 0} × I${r.initial_impact ?? 0} · ${String(r.initial_risk_rating).replace(/_/g, " ")}`
        : null,
      existingControls: r.existing_controls ?? [],
      controlEffectiveness: r.control_effectiveness ?? null,
      treatment: r.proposed_treatment ?? null,
      proposedControls: r.proposed_controls ?? [],
      residualRisk: r.residual_risk_rating
        ? `L${r.residual_likelihood ?? 0} × I${r.residual_impact ?? 0} · ${String(r.residual_risk_rating).replace(/_/g, " ")}`
        : null,
      evidenceReferences: r.evidence_references ?? [],
      evidenceTrace: (r.evidence_references ?? []).map((ref) =>
        [ref.filename, ref.page ? `page ${ref.page}` : null, ref.cell, ref.chunk_id]
          .filter(Boolean)
          .join(" · ")
      ),
      evidenceQuality: r.evidence_quality ?? null,
      vendorEvidenceState: r.vendor_evidence_state ?? null,
      assessmentStatus: r.assessment_status ?? null,
      consistencyStatus: r.consistency_status ?? null,
      manualReviewStatus: r.manual_review_status ?? null,
      // schema 1 predates these fields — their values are migration defaults, not results
      isLegacySchema: (r.schema_version ?? 2) < 2,
    })),
  };
}

// feeds the UserMenu's past-sessions list
export function adaptSessions(resp) {
  return (resp.sessions ?? []).map((s) => ({
    id: s.session_id,
    name: s.service_name,
    system: s.service_name ?? "",
    // rawStatus is the real status everyone reads; this coarse done/draft is kept only for legacy callers
    status: s.status === "complete" ? "done" : "draft",
    rawStatus: s.status,
    createdAt: s.created_at,
    resumable: s.resumable,
    viewable: s.viewable,
    error: s.error ?? null,
    target: s.viewable ? "results" : "analysis",
  }));
}
