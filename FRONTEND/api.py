"""
api.py — FastAPI layer for Aegis, matching the 5-page frontend:
  Upload → Analysis (Gap Q&A) → Results → Sessions → Report

Status machine per session:
  uploaded → assessing → awaiting_followup → paused → resolving → complete

"paused" exists because answering follow-up questions may require sending them
to the vendor and waiting for a reply — this can take days. The session must
survive that gap and be resumable from the Sessions page.

Design notes:
- All long LLM-calling work (assess, resolve) runs as background tasks.
- Session state is the single source of truth — same JSON file the CLI's
  followup.py already reads/writes. The API is a thin layer over it.
- One assessment = one session = one row on the Sessions page.
"""

import os
import sys
import uuid
import shutil
import json
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# api.py lives in FRONTEND/ but the assessment engine lives in ../BACKEND.
# Put BACKEND on the import path so `import assess` etc. resolve regardless of
# the working directory uvicorn was launched from.
BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "BACKEND"))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import ingest
import assess
import report
import followup

app = FastAPI(title="Aegis Risk Assessment API", version="1.0")

# Allow the Vite dev server (and any configured deployed origin) to call the API.
# AEGIS_CORS_ORIGINS is a comma-separated list; defaults cover local dev.
_default_origins = "http://localhost:5173,http://127.0.0.1:5173"
_cors_origins = [o.strip() for o in os.environ.get("AEGIS_CORS_ORIGINS", _default_origins).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR  = "./uploads_tmp"
REPORTS_DIR = "./reports"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

# In-memory registry: session_id -> job metadata.
# session_id == the assessment's unique id, shared with the session_file on disk.
SESSIONS: dict[str, dict] = {}


# ── Schemas ────────────────────────────────────────────────────────────────────

class FollowupAnswer(BaseModel):
    control_id: str
    answer: str

class SubmitAnswersRequest(BaseModel):
    answers: list[FollowupAnswer]
    pause_after: bool = False   # true = save and stop here, resume later


# ── Helpers ──────────────────────────────────────────────────────────────────────

def _save_upload(file: UploadFile, subdir: str = "") -> str:
    folder = os.path.join(UPLOAD_DIR, subdir) if subdir else UPLOAD_DIR
    os.makedirs(folder, exist_ok=True)
    # Strip any directory components from the client-supplied filename so it can
    # never traverse outside `folder` (e.g. "x/../../etc/passwd"). The uuid
    # prefix guarantees uniqueness; basename() guarantees containment.
    safe_name = os.path.basename(file.filename or "") or "upload"
    path = os.path.join(folder, f"{uuid.uuid4().hex}_{safe_name}")
    with open(path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return path

def _load_session_file(session_id: str) -> Optional[dict]:
    meta = SESSIONS.get(session_id)
    if not meta or not meta.get("session_file") or not os.path.exists(meta["session_file"]):
        return None
    with open(meta["session_file"]) as f:
        return json.load(f)

def _ext_kind(filename: str) -> str:
    ext = filename.lower().rsplit(".", 1)[-1]
    return {"pdf": "pdf", "docx": "doc", "doc": "doc", "xlsx": "xls", "xls": "xls"}.get(ext, "other")


# ════════════════════════════════════════════════════════════════════════════════
# PAGE 1 — UPLOAD
# ════════════════════════════════════════════════════════════════════════════════

@app.post("/uploads/policy")
def upload_policy(file: UploadFile = File(...)):
    """Murdoch internal policy PDF → knowledge base. Drives the 'Parsed' tag in the file list."""
    path = _save_upload(file)
    try:
        ingest.ingest_policy_pdf(path)
        return {"filename": file.filename, "kind": _ext_kind(file.filename), "status": "Parsed"}
    except Exception as e:
        return {"filename": file.filename, "kind": _ext_kind(file.filename), "status": "Failed", "error": str(e)}
    finally:
        os.remove(path)


@app.post("/uploads/hecvat-template")
def upload_hecvat_template(file: UploadFile = File(...)):
    """HECVAT template xlsx → guidance reference, not a vendor submission."""
    path = _save_upload(file)
    try:
        ingest.ingest_hecvat_template(path)
        return {"filename": file.filename, "kind": "xls", "status": "Parsed"}
    finally:
        os.remove(path)


@app.post("/uploads/soc2")
def upload_soc2(file: UploadFile = File(...)):
    """Vendor SOC 2 Type 2 → vendor evidence collection (corroboration only)."""
    path = _save_upload(file)
    try:
        ingest.ingest_soc2_pdf(path)
        return {"filename": file.filename, "kind": "pdf", "status": "Parsed"}
    finally:
        os.remove(path)


@app.post("/uploads/vendor-doc")
def upload_vendor_doc(file: UploadFile = File(...)):
    """Any other vendor evidence document."""
    path = _save_upload(file)
    try:
        ingest.ingest_vendor_doc_pdf(path)
        return {"filename": file.filename, "kind": _ext_kind(file.filename), "status": "Parsed"}
    finally:
        os.remove(path)


@app.post("/uploads/vendor-hecvat")
def upload_vendor_hecvat(file: UploadFile = File(...), service_name: str = "Unknown Vendor"):
    """
    The vendor's FILLED HECVAT — this is what gets assessed.
    Stages the file and creates a new session in 'uploaded' status.
    Does NOT start assessment yet — "Start analysis" button does that.
    """
    path = _save_upload(file, subdir="staged")
    session_id = uuid.uuid4().hex
    SESSIONS[session_id] = {
        "status":       "uploaded",
        "service_name": service_name,
        "hecvat_path":  path,
        "created_at":   datetime.now().isoformat(),
        "session_file": None,
    }
    return {"session_id": session_id, "filename": file.filename, "kind": "xls", "status": "Parsed"}


@app.get("/knowledge-base/stats")
def kb_stats():
    """Used by the upload page to show ingested document counts, if displayed."""
    import chromadb
    import config
    client = chromadb.PersistentClient(path=config.CHROMA_DIR)
    out = {}
    for key, name in (
        ("internal_policies", config.CHROMA_COLLECTION_POLICIES),
        ("soc2_controls",     config.CHROMA_COLLECTION_SOC2),
    ):
        try:
            out[key] = client.get_collection(name).count()
        except Exception:
            out[key] = 0
    return out


# ════════════════════════════════════════════════════════════════════════════════
# Start analysis — bridges Upload page → Analysis page
# ════════════════════════════════════════════════════════════════════════════════

def _run_full_assessment(session_id: str):
    """Background worker for the initial assessment pass."""
    meta = SESSIONS[session_id]
    try:
        meta["status"] = "assessing"
        findings = assess.run_assessment(meta["hecvat_path"], meta["service_name"])
        summary  = assess.summarize_findings(findings)

        # One JSON file per assessment so concurrent sessions never collide.
        session_file = os.path.join(REPORTS_DIR, f"session_{session_id}.json")
        followup.build_session(findings, summary, meta["service_name"], session_path=session_file)
        meta["session_file"] = session_file

        session = _load_session_file(session_id)
        has_questions = bool(session and session.get("followup_questions"))

        meta["status"] = "awaiting_followup" if has_questions else "ready_for_report"
        meta["summary"] = summary
    except Exception as e:
        meta["status"] = "failed"
        meta["error"]  = str(e)
    finally:
        if os.path.exists(meta["hecvat_path"]):
            os.remove(meta["hecvat_path"])   # vendor HECVAT never persisted


@app.post("/sessions/{session_id}/start-analysis")
def start_analysis(session_id: str, background_tasks: BackgroundTasks):
    """Triggered by the 'Start analysis' button on the Upload page."""
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, "session not found")
    if meta["status"] != "uploaded":
        raise HTTPException(409, f"cannot start — session status is '{meta['status']}'")

    meta["status"] = "queued"
    background_tasks.add_task(_run_full_assessment, session_id)
    return {"session_id": session_id, "status": "queued"}


# ════════════════════════════════════════════════════════════════════════════════
# PAGE 2 — ANALYSIS (Gap Q&A) — drives qaList, progress bar, submit/edit
# ════════════════════════════════════════════════════════════════════════════════

@app.get("/sessions/{session_id}/status")
def get_session_status(session_id: str):
    """
    Poll this while on the Analysis page (or anywhere) to know what to render:
    uploaded | queued | assessing | awaiting_followup | paused | resolving |
    ready_for_report | complete | failed
    """
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, "session not found")
    return {k: v for k, v in meta.items() if k != "hecvat_path"}


@app.get("/sessions/{session_id}/questions")
def get_questions(session_id: str):
    """
    Populates qaList. Each item maps directly to a .qa-item card:
    question text, HECVAT/section reference, and whether it's answered (for progress bar).
    """
    session = _load_session_file(session_id)
    if not session:
        raise HTTPException(404, "session not found or assessment not yet complete")

    findings_map = {f["control_id"]: f for f in session["findings"]}
    answered     = session.get("followup_answers", {})

    items = []
    for cid, q in session.get("followup_questions", {}).items():
        f = findings_map.get(cid, {})
        items.append({
            "control_id":   cid,
            "question":     q,
            "reference":    f"HECVAT · {f.get('section', '')}",
            "answered":     cid in answered,
            "answer":       answered.get(cid),
            "status":       f.get("overall_status"),
            "rmf_level":    f.get("rmf_level"),
            "gap_description": f.get("gap_description"),
        })

    return {
        "items": items,
        "total": len(items),
        "answered_count": len(answered),
    }


@app.post("/sessions/{session_id}/answers/{control_id}")
def submit_one_answer(session_id: str, control_id: str, body: FollowupAnswer):
    """
    Maps to submitAnswer(id) — fired when the assessor hits 'Submit' on one question.
    Saves immediately; does not trigger re-assessment (that happens on 'Generate report').
    """
    session = _load_session_file(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    if control_id != body.control_id:
        raise HTTPException(400, "control_id mismatch")

    session["followup_answers"][control_id] = body.answer
    followup.save_session(session, SESSIONS[session_id]["session_file"])
    return {"status": "saved", "control_id": control_id}


@app.put("/sessions/{session_id}/answers/{control_id}")
def edit_one_answer(session_id: str, control_id: str, body: FollowupAnswer):
    """Maps to editAnswer(id) → submitAnswer(id) again. Same effect as POST, explicit verb for clarity."""
    return submit_one_answer(session_id, control_id, body)


@app.post("/sessions/{session_id}/answers")
def submit_answers_batch(session_id: str, body: SubmitAnswersRequest):
    """
    Bulk submit — useful if the frontend batches answers before sending.
    pause_after=true: save and explicitly mark session 'paused' (vendor reply pending).
    """
    session = _load_session_file(session_id)
    if not session:
        raise HTTPException(404, "session not found")

    for item in body.answers:
        session["followup_answers"][item.control_id] = item.answer
    followup.save_session(session, SESSIONS[session_id]["session_file"])

    if body.pause_after:
        SESSIONS[session_id]["status"] = "paused"

    return {"status": "saved", "count": len(body.answers), "session_status": SESSIONS[session_id]["status"]}


# ── Pause / Resume — the core of your stated requirement ───────────────────────

@app.post("/sessions/{session_id}/pause")
def pause_session(session_id: str):
    """
    Explicit pause — e.g. assessor is about to send questions to the vendor
    and won't have answers for days. Session just sits as 'paused'; nothing
    is lost since answers already submitted are saved to session_file on disk.
    """
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, "session not found")
    if meta["status"] not in ("awaiting_followup", "paused"):
        raise HTTPException(409, f"cannot pause from status '{meta['status']}'")
    meta["status"] = "paused"
    return {"session_id": session_id, "status": "paused"}


@app.post("/sessions/{session_id}/resume")
def resume_session(session_id: str):
    """
    Resume a paused session. Frontend calls this from the Sessions page 'Resume' button.
    Just flips status back so the Analysis page reopens with remaining questions.
    """
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, "session not found")
    if meta["status"] != "paused":
        raise HTTPException(409, f"session is not paused (status='{meta['status']}')")

    session = _load_session_file(session_id)
    answered_count   = len(session.get("followup_answers", {}))
    total_questions  = len(session.get("followup_questions", {}))
    meta["status"] = "awaiting_followup" if answered_count < total_questions else "ready_for_report"
    return {"session_id": session_id, "status": meta["status"]}


# ════════════════════════════════════════════════════════════════════════════════
# Generate report — bridges Analysis page → Results/Report pages
# ════════════════════════════════════════════════════════════════════════════════

def _run_resolve_and_report(session_id: str):
    """
    Background worker for 'Generate report' button.
    Re-assesses any controls with answers, then builds the final PDF/Excel.
    """
    meta = SESSIONS[session_id]
    try:
        meta["status"] = "resolving"
        session = _load_session_file(session_id)
        answered_ids = list(session.get("followup_answers", {}).keys())

        if answered_ids:
            # Re-assess answered controls, persisting to this session's own file.
            # regenerate_report=False: we build the consolidated report below.
            followup._resolve(
                session, answered_ids,
                session_path=meta["session_file"],
                regenerate_report=False,
            )
            session = _load_session_file(session_id)   # reload post-resolve

        # Merge resolved findings for a consistent final report object
        resolved_map = session.get("resolved_findings", {})
        final_findings = [resolved_map.get(f["control_id"], f) for f in session["findings"]]
        final_summary  = assess.summarize_findings(final_findings)

        pdf_path, excel_path = report.generate_all(
            final_findings, final_summary, meta["service_name"], REPORTS_DIR
        )

        meta.update({
            "status":     "complete",
            "summary":    final_summary,
            "pdf_path":   pdf_path,
            "excel_path": excel_path,
        })
    except Exception as e:
        meta["status"] = "failed"
        meta["error"]  = str(e)


@app.post("/sessions/{session_id}/generate-report")
def generate_report(session_id: str, background_tasks: BackgroundTasks):
    """
    'Generate report' button on the Analysis page.
    Allowed even with unanswered questions — those simply keep their original
    finding (no follow-up applied). This matches "pause now, finish later":
    the report can still be produced now, and a fuller report regenerated
    after resolving more answers later.
    """
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, "session not found")
    if meta["status"] not in ("awaiting_followup", "ready_for_report", "paused"):
        raise HTTPException(409, f"cannot generate report from status '{meta['status']}'")

    meta["status"] = "resolving"
    background_tasks.add_task(_run_resolve_and_report, session_id)
    return {"session_id": session_id, "status": "resolving"}


# ════════════════════════════════════════════════════════════════════════════════
# PAGE 3 — RESULTS (stat cards, severity chips/filter, risk cards)
# ════════════════════════════════════════════════════════════════════════════════

@app.get("/sessions/{session_id}/results")
def get_results(session_id: str, severity: Optional[str] = None):
    """
    Populates the stat-vh/h/m/mn/l counters and the filterable risk list.
    Severity follows Murdoch University's Risk Assessment Matrix (5-level output).
    severity filter accepts: vh (Very High), h (High), m (Medium), mn (Minor), l (Low) — matches frontend's toggleFilter keys.
    """
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, "session not found")
    if meta["status"] != "complete":
        raise HTTPException(409, f"results not ready (status='{meta['status']}')")

    session  = _load_session_file(session_id)
    resolved = session.get("resolved_findings", {})
    findings = [resolved.get(f["control_id"], f) for f in session["findings"]]

    # rmf_level values come from config.RMF_MATRIX: EXTREME is the top tier.
    sev_key_map = {"EXTREME": "vh", "HIGH": "h", "MEDIUM": "m", "MINOR": "mn", "LOW": "l"}
    counts = {"vh": 0, "h": 0, "m": 0, "mn": 0, "l": 0}
    risk_cards = []

    for f in findings:
        if f.get("overall_status") not in ("GAP", "PARTIAL"):
            continue
        key = sev_key_map.get(f.get("rmf_level"), "l")
        counts[key] += 1
        risk_cards.append({
            "control_id":  f["control_id"],
            "severity":    key,
            "title":       f.get("section", f["control_id"]),
            "description": f.get("gap_description"),
            "source":      "HECVAT" if not f.get("vendor_evidence_corroborated") else "SOC 2 Type 2",
            "recommendation": f.get("recommendation"),
        })

    if severity:
        risk_cards = [r for r in risk_cards if r["severity"] == severity]

    return {"counts": counts, "risks": risk_cards}


# ════════════════════════════════════════════════════════════════════════════════
# PAGE 4 — SESSIONS (list, view, resume, delete)
# ════════════════════════════════════════════════════════════════════════════════

@app.get("/sessions")
def list_sessions():
    """
    Populates the Sessions page list. Each row needs: name, meta line,
    status badge, and whether 'Resume' or 'View' is the right action.
    """
    rows = []
    for sid, meta in SESSIONS.items():
        rows.append({
            "session_id":   sid,
            "service_name": meta.get("service_name"),
            "status":       meta.get("status"),
            "created_at":   meta.get("created_at"),
            "resumable":    meta.get("status") == "paused",
            "viewable":     meta.get("status") == "complete",
        })
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return {"sessions": rows}


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    """Maps to the trash icon button on a paused session row."""
    meta = SESSIONS.pop(session_id, None)
    if not meta:
        raise HTTPException(404, "session not found")
    if meta.get("session_file") and os.path.exists(meta["session_file"]):
        os.remove(meta["session_file"])
    return {"status": "deleted", "session_id": session_id}


# ════════════════════════════════════════════════════════════════════════════════
# PAGE 5 — REPORT (preview + downloads)
# ════════════════════════════════════════════════════════════════════════════════

@app.get("/sessions/{session_id}/report/preview")
def report_preview(session_id: str):
    """
    Lightweight JSON used to render the report-body preview pane
    (executive summary stats + key findings + recommendations)
    without making the browser fetch the full PDF first.
    """
    meta = SESSIONS.get(session_id)
    if not meta or meta.get("status") != "complete":
        raise HTTPException(409, "report not ready")

    summary = meta["summary"]
    results = get_results(session_id)

    return {
        "service_name": meta["service_name"],
        "stats": results["counts"],
        "key_findings": results["risks"][:6],
        "recommendations": [r["recommendation"] for r in results["risks"] if r.get("recommendation")][:5],
    }


@app.get("/sessions/{session_id}/report/download")
def report_download(session_id: str, fmt: str = "pdf"):
    """'Download PDF' / 'Download PPTX' buttons. fmt: pdf | excel (pptx not yet generated by pipeline)."""
    meta = SESSIONS.get(session_id)
    if not meta or meta.get("status") != "complete":
        raise HTTPException(409, "report not ready")

    path = meta.get("pdf_path") if fmt == "pdf" else meta.get("excel_path")
    if not path or not os.path.exists(path):
        raise HTTPException(404, f"{fmt} report not found")
    return FileResponse(path, filename=os.path.basename(path))


@app.get("/health")
def health():
    return {"status": "ok"}
