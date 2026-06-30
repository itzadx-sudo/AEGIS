/**
 * api.js — the single integration surface between this frontend and the FastAPI
 * backend in `api.py`. Every function here maps 1:1 to an endpoint; the
 * `adapt*` helpers reshape backend payloads into the exact shapes the existing
 * components already render (so wiring up = swap mock data for an adapter call).
 *
 * Backend severity keys already match the frontend (Murdoch Risk Matrix
 * levels): vh=Very High, h=High, m=Medium, mn=Minor, l=Low.
 *
 * Configure the backend origin with VITE_API_BASE_URL (see .env.example).
 * In dev, vite.config.js also proxies the API route prefixes to the backend,
 * so leaving VITE_API_BASE_URL empty + running the backend on :8080 just works.
 */

import { SEV_LABELS } from "@/data/risks";

const BASE_URL = (import.meta.env?.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

/** Tag line shown under each severity stat card. */
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

async function request(path, { method = "GET", body, form, signal } = {}) {
  const opts = { method, signal, headers: {} };
  if (form) {
    opts.body = form; // FormData — browser sets the multipart boundary
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, opts);

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
    throw new ApiError(res.status, `${method} ${path} failed (${res.status})`, detail);
  }

  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.blob();
}

const uploadForm = (file) => {
  const fd = new FormData();
  fd.append("file", file);
  return fd;
};

/* ─────────────────────────── Endpoints (1:1 with api.py) ──────────────────── */

export const api = {
  // ── Page 1 · Upload ──────────────────────────────────────────────────────
  uploadPolicy: (file) =>
    request("/uploads/policy", { method: "POST", form: uploadForm(file) }),
  uploadHecvatTemplate: (file) =>
    request("/uploads/hecvat-template", { method: "POST", form: uploadForm(file) }),
  uploadSoc2: (file) =>
    request("/uploads/soc2", { method: "POST", form: uploadForm(file) }),
  uploadVendorDoc: (file) =>
    request("/uploads/vendor-doc", { method: "POST", form: uploadForm(file) }),
  /** The vendor's FILLED HECVAT — creates a session. Returns { session_id, ... }. */
  uploadVendorHecvat: (file, serviceName = "Unknown Vendor") =>
    request(`/uploads/vendor-hecvat?service_name=${encodeURIComponent(serviceName)}`, {
      method: "POST",
      form: uploadForm(file),
    }),
  kbStats: () => request("/knowledge-base/stats"),

  // ── Upload → Analysis bridge ─────────────────────────────────────────────
  startAnalysis: (sessionId) =>
    request(`/sessions/${sessionId}/start-analysis`, { method: "POST" }),

  // ── Page 2 · Analysis (Gap Q&A) ──────────────────────────────────────────
  getSessionStatus: (sessionId) => request(`/sessions/${sessionId}/status`),
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

  // ── Analysis → Results/Report bridge ─────────────────────────────────────
  generateReport: (sessionId) =>
    request(`/sessions/${sessionId}/generate-report`, { method: "POST" }),

  // ── Page 3 · Results ─────────────────────────────────────────────────────
  /** severity is optional: "vh" | "h" | "m" | "mn" | "l". */
  getResults: (sessionId, severity) =>
    request(
      `/sessions/${sessionId}/results${
        severity ? `?severity=${encodeURIComponent(severity)}` : ""
      }`
    ),

  // ── Page 4 · Sessions ────────────────────────────────────────────────────
  listSessions: () => request("/sessions"),
  deleteSession: (sessionId) =>
    request(`/sessions/${sessionId}`, { method: "DELETE" }),

  // ── Page 5 · Report ──────────────────────────────────────────────────────
  getReportPreview: (sessionId) =>
    request(`/sessions/${sessionId}/report/preview`),
  /** Direct href for an <a download> button. fmt: "pdf" | "excel". */
  reportDownloadUrl: (sessionId, fmt = "pdf") =>
    `${BASE_URL}/sessions/${sessionId}/report/download?fmt=${fmt}`,
  downloadReport: (sessionId, fmt = "pdf") =>
    request(`/sessions/${sessionId}/report/download?fmt=${fmt}`),

  health: () => request("/health"),
};

/* ───────────────────── Adapters: backend → frontend shapes ────────────────── */

/** Upload response → the UploadPage file-row shape. */
export function adaptUploadFile(resp) {
  const statusMap = { Parsed: "ok", Processing: "wait", Failed: "fail" };
  return {
    name: resp.filename,
    kind: resp.kind, // "pdf" | "doc" | "xls" | "other"
    status: statusMap[resp.status] ?? "wait",
    sessionId: resp.session_id, // present on the vendor-hecvat upload
  };
}

/** GET /questions → AnalysisPage question shape ({ id, text, ref, answered, answer }). */
export function adaptQuestions(resp) {
  return {
    items: (resp.items ?? []).map((q) => ({
      id: q.control_id,
      text: q.question,
      ref: q.reference,
      answered: q.answered,
      answer: q.answer ?? null,
    })),
    total: resp.total ?? 0,
    answeredCount: resp.answered_count ?? 0,
  };
}

/**
 * GET /results → the shapes ResultsPage + RiskRadar consume:
 *   summary: [{ sev, label, count, tag }]   (the stat cards / radar legend)
 *   risks:   [{ sev, title, desc, src, controlId, recommendation }]
 */
export function adaptResults(resp) {
  const counts = resp.counts ?? { vh: 0, h: 0, m: 0, mn: 0, l: 0 };
  return {
    counts,
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
    })),
  };
}

/** GET /sessions → the UserMenu past-sessions rows. */
export function adaptSessions(resp) {
  return (resp.sessions ?? []).map((s) => ({
    id: s.session_id,
    name: s.service_name,
    // UserMenu renders `system` as the row subtitle. The backend's /sessions
    // rows don't return a separate system/product name (only `service_name`),
    // so fall back to it here.
    system: s.service_name ?? "",
    // UserMenu treats `status === "done"` as complete (else "Draft"); the
    // backend's terminal/viewable status literal is "complete".
    status: s.status === "complete" ? "done" : "draft",
    createdAt: s.created_at,
    resumable: s.resumable,
    viewable: s.viewable,
    // Where the row's action should navigate the UI.
    target: s.viewable ? "results" : "analysis",
  }));
}

/** GET /report/preview → the report preview pane shape. */
export function adaptReportPreview(resp) {
  return {
    serviceName: resp.service_name,
    stats: resp.stats,
    keyFindings: (resp.key_findings ?? []).map((r) => ({
      sev: r.severity,
      title: r.title,
      desc: r.description,
      src: r.source,
    })),
    recommendations: resp.recommendations ?? [],
  };
}
