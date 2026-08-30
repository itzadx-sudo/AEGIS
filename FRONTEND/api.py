# FastAPI layer over the same session JSON followup.py reads — a wrapper, not a second source of truth
import os
import re
import sys
import time
import uuid
import glob
import json
import threading
import traceback
from collections import defaultdict
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

# the backend lives in a sibling folder, so it's not importable without this path hack
BACKEND_DIR = os.path.join(os.path.dirname(__file__), "..", "BACKEND")
sys.path.insert(0, os.path.abspath(BACKEND_DIR))

import config
import ingest
import assess
import report
import followup
import rag
import gpu_engine
import auth
# rag/ingest pull chromadb in with the pysqlite3 shim already applied, so import it after them
import chromadb

app = FastAPI(title="Sedona Risk Assessment API", version="2.0")

AUTH = [Depends(auth.require_authenticated)]
ADMIN = [Depends(auth.require_admin)]
ASSESSOR = [Depends(auth.require_assessor)]

# default origins cover the Vite dev server so local frontend work doesn't need extra config
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get(
        "SEDONA_CORS_ORIGINS",
        "http://localhost:5173,http://localhost:4173",
    ).split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# pull storage locations from config so the API and CLI agree and can be relocated via env vars
UPLOAD_DIR  = config.UPLOAD_DIR
REPORTS_DIR = config.REPORTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

# this is rebuilt from disk on startup (see rehydrate below), so it's safe to keep purely in memory otherwise
SESSIONS: dict[str, dict] = {}

# per-session lock so two concurrent answer submissions can't clobber each other's read-modify-write on the session file
_session_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)

# one GPU, so one run at a time — _active_run names whoever holds it
_run_guard = threading.Lock()
_active_run: Optional[str] = None
# monotonic timestamp of the current acquire, used to spot a holder wedged in "queued"
_active_run_since: Optional[float] = None
# a queued session whose background task never started is stale after this long
QUEUED_STALE_SECONDS = 120
# statuses that mean a session is actively occupying the GPU
_RUNNING_STATES = ("queued", "assessing", "resolving")
# once a report is rendered it is the compliance artefact — its source data is frozen
_SEALED_STATES = ("complete",)


def _try_acquire_run(session_id: str, running_status: str) -> Optional[str]:
    global _active_run, _active_run_since
    with _run_guard:
        holder = _active_run
        if holder and holder in SESSIONS and SESSIONS[holder].get("status") in _RUNNING_STATES:
            # a background task that never started would hold the GPU forever, so time it out
            stuck_queued = (
                SESSIONS[holder].get("status") == "queued"
                and _active_run_since is not None
                and (time.monotonic() - _active_run_since) > QUEUED_STALE_SECONDS
            )
            if not stuck_queued:
                return holder
            print(f"[run-guard] session {holder} stuck in 'queued' for "
                  f"{int(time.monotonic() - _active_run_since)}s — reclaiming the GPU")
        _active_run = session_id
        _active_run_since = time.monotonic()
        # set the status under the same lock, or a concurrent acquire slips through the gap
        if session_id in SESSIONS:
            SESSIONS[session_id]["status"] = running_status
        return None


def _release_run(session_id: str) -> None:
    global _active_run, _active_run_since
    with _run_guard:
        if _active_run == session_id:
            _active_run = None
            _active_run_since = None


def _normalize_session_payload(session: dict) -> dict:
    normalized = dict(session or {})
    normalized["findings"] = [
        assess.normalize_finding(finding)
        for finding in normalized.get("findings", [])
    ]
    normalized["resolved_findings"] = {
        control_id: assess.normalize_finding(finding)
        for control_id, finding in (normalized.get("resolved_findings") or {}).items()
    }
    for summary_key in ("summary", "final_summary"):
        summary = normalized.get(summary_key)
        if not isinstance(summary, dict):
            continue
        summary = dict(summary)
        if "very_high_risks" not in summary and "extreme_risks" in summary:
            summary["very_high_risks"] = [
                assess.normalize_finding(finding)
                for finding in summary.pop("extreme_risks", [])
            ]
        summary["overall_risk_band"] = config.normalize_rmf_level(
            summary.get("overall_risk_band")
        )
        breakdown = dict(summary.get("rmf_breakdown") or {})
        if "EXTREME" in breakdown:
            breakdown["VERY_HIGH"] = breakdown.get("VERY_HIGH", 0) + breakdown.pop("EXTREME")
        summary["rmf_breakdown"] = breakdown
        normalized[summary_key] = summary
    return normalized


# rebuilds the in-memory SESSIONS registry from disk on boot, so a server restart doesn't strand in-flight or completed sessions
def _rehydrate_sessions_from_disk():
    used_reports: set[str] = set()  # tracks claimed report files so two sessions never end up pointing at the same one

    for path in glob.glob(os.path.join(REPORTS_DIR, "session_*.json")):
        sid = os.path.basename(path)[len("session_"):-len(".json")]
        if not sid or sid in SESSIONS:
            continue
        try:
            with open(path) as f:
                session = _normalize_session_payload(json.load(f))
        except Exception as e:
            print(f"[startup] could not read {path}: {e}")
            continue

        answered = len(session.get("followup_answers", {}))
        total_q  = len(session.get("followup_questions", {}))
        if session.get("resolved_findings"):
            status = "complete" if total_q and answered >= total_q else "ready_for_report"
        elif total_q:
            status = "awaiting_followup" if answered < total_q else "ready_for_report"
        else:
            status = "ready_for_report"

        # never derive "ready_for_report" from a run with no findings — that hid failures on restart
        if not session.get("findings") and session.get("status") in ("uploaded", "failed"):
            status = session["status"]

        # count-derived status alone can never land on "complete" when follow-ups were skipped, so trust an explicit persisted marker first
        try:
            if session.get("status") == "complete":
                status = "complete"
        except Exception as e:
            print(f"[startup] session {sid}: could not read persisted status ({e}), using derived status")

        # only trust a persisted "paused" flag while still mid-followup — otherwise a stale flag could yank a since-completed session back to paused
        try:
            if status == "awaiting_followup" and session.get("status") == "paused":
                status = "paused"
        except Exception as e:
            print(f"[startup] session {sid}: could not read persisted status ({e}), using derived status")

        # mtime, never now() — boot time would make every restored session claim it was created at startup
        created_at = session.get("created_at")
        if not created_at:
            try:
                created_at = datetime.fromtimestamp(os.path.getmtime(path)).isoformat()
            except OSError:
                created_at = datetime.now().isoformat()

        # keep the staged workbook so a restart can still start or retry the run
        hecvat_path = session.get("hecvat_path")
        if not (hecvat_path and os.path.exists(hecvat_path)):
            hecvat_path = None

        entry = {
            "status":       status,
            "service_name": session.get("service_name", "Unknown Vendor"),
            "hecvat_path":  hecvat_path,
            # survives a restart between upload and start, so the workbook name isn't lost
            "original_filename": session.get("original_filename"),
            "created_at":   created_at,
            "session_file": path,
            "summary":      session.get("summary"),
            # the failure reason lived only in memory, so a restart erased why a run failed
            "error":        session.get("error") if status == "failed" else None,
            # restore run timing so NFR-202 reporting survives a restart
            "started_at":      session.get("started_at"),
            "finished_at":     session.get("finished_at"),
            "elapsed_seconds": session.get("elapsed_seconds"),
            # legacy sessions stay unowned — never guess an owner
            "owner_user_id":    session.get("owner_user_id"),
            "assigned_user_ids": list(session.get("assigned_user_ids") or []),
        }

        # three fallback tiers to relocate the report files on disk, most-precise first: persisted exact basenames, then the session id embedded in the filename, then a legacy vendor-name glob for older reports
        if status == "complete":
            try:
                for meta_key, session_key in (("pdf_path", "report_pdf"),
                                              ("pptx_path", "report_pptx"),
                                              ("csv_path", "report_csv")):
                    name = session.get(session_key)
                    if name:
                        p = os.path.join(REPORTS_DIR, os.path.basename(name))
                        if os.path.exists(p):
                            entry[meta_key] = p
                            used_reports.add(p)

                sid_glob = glob.escape(sid)
                # no vendor-name tier for the CSV — older sessions have none and are rendered on demand
                if "csv_path" not in entry:
                    id_matches = sorted(
                        (p for p in glob.glob(os.path.join(REPORTS_DIR, f"risk_assessment_*_{sid_glob}_*.csv"))
                         if p not in used_reports),
                        key=os.path.getmtime, reverse=True,
                    )
                    if id_matches:
                        entry["csv_path"] = id_matches[0]
                        used_reports.add(id_matches[0])
                if "pdf_path" not in entry:
                    id_matches = sorted(
                        (p for p in glob.glob(os.path.join(REPORTS_DIR, f"risk_assessment_*_{sid_glob}_*.pdf"))
                         if p not in used_reports),
                        key=os.path.getmtime, reverse=True,
                    )
                    if id_matches:
                        entry["pdf_path"] = id_matches[0]
                        used_reports.add(id_matches[0])
                if "pptx_path" not in entry:
                    id_matches = sorted(
                        (p for p in glob.glob(os.path.join(REPORTS_DIR, f"risk_briefing_*_{sid_glob}_*.pptx"))
                         if p not in used_reports),
                        key=os.path.getmtime, reverse=True,
                    )
                    if id_matches:
                        entry["pptx_path"] = id_matches[0]
                        used_reports.add(id_matches[0])

                safe = (entry["service_name"].replace("/", "_").replace("\\", "_")
                        .replace(" ", "_").lower()[:40])
                safe_glob = glob.escape(safe)

                if "pdf_path" not in entry:
                    pdf_candidates = sorted(
                        (p for p in glob.glob(os.path.join(REPORTS_DIR, f"risk_assessment_{safe_glob}_*.pdf"))
                         if p not in used_reports),
                        key=os.path.getmtime, reverse=True,
                    )
                    if pdf_candidates:
                        entry["pdf_path"] = pdf_candidates[0]
                        used_reports.add(pdf_candidates[0])

                if "pptx_path" not in entry:
                    pptx_candidates = sorted(
                        (p for p in glob.glob(os.path.join(REPORTS_DIR, f"risk_briefing_{safe_glob}_*.pptx"))
                         if p not in used_reports),
                        key=os.path.getmtime, reverse=True,
                    )
                    if pptx_candidates:
                        entry["pptx_path"] = pptx_candidates[0]
                        used_reports.add(pptx_candidates[0])
            except Exception as e:
                print(f"[startup] session {sid}: could not locate report files: {e}")

        SESSIONS[sid] = entry
        print(f"[startup] rehydrated session {sid} — status={status}")

_rehydrate_sessions_from_disk()


class FollowupAnswer(BaseModel):
    control_id: str
    answer: str

class FollowupSkip(BaseModel):
    control_id: str
    reason: Optional[str] = None

class SubmitAnswersRequest(BaseModel):
    answers: list[FollowupAnswer]
    pause_after: bool = False

class LoginRequest(BaseModel):
    username: str
    password: str

class SignupRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None

class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str
    display_name: Optional[str] = None

class UserStateRequest(BaseModel):
    disabled: bool

class PasswordResetRequest(BaseModel):
    password: str

class SessionAssignmentRequest(BaseModel):
    user_ids: list[str]

class ManualResolutionRequest(BaseModel):
    hecvat_compliance: str
    policy_alignment: str
    overall_status: str
    initial_likelihood: int
    initial_impact: int
    residual_likelihood: int
    residual_impact: int
    justification: str


MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # generous enough for PDF/XLSX while still capping abusive uploads

def _safe_filename(filename: str) -> str:
    # the client-controlled filename used to go straight into the on-disk path, so strip it down to something safe first
    base = os.path.basename(filename or "upload")
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return base or "upload"

def _save_upload(file: UploadFile, subdir: str = "") -> str:
    folder = os.path.join(UPLOAD_DIR, subdir) if subdir else UPLOAD_DIR
    os.makedirs(folder, exist_ok=True)
    safe_name = _safe_filename(file.filename)
    path = os.path.join(folder, f"{uuid.uuid4().hex}_{safe_name}")

    total = 0
    with open(path, "wb") as f:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                f.close()
                os.remove(path)
                raise HTTPException(413, f"file too large — max {MAX_UPLOAD_BYTES // (1024*1024)}MB")
            f.write(chunk)
    return path

def _load_session_file(session_id: str) -> Optional[dict]:
    meta = SESSIONS.get(session_id)
    if not meta or not meta.get("session_file") or not os.path.exists(meta["session_file"]):
        return None
    try:
        with open(meta["session_file"]) as f:
            return _normalize_session_payload(json.load(f))
    except Exception as e:
        print(f"[session {session_id}] could not read session file: {e}")
        return None

def _persist_stub(session_id: str) -> None:
    meta = SESSIONS.get(session_id)
    if not meta:
        return
    path = meta.get("session_file") or os.path.join(REPORTS_DIR, f"session_{session_id}.json")
    stub = {
        "_session_path": path,
        "service_name":  meta.get("service_name"),
        "created_at":    meta.get("created_at"),
        "status":        meta.get("status"),
        "error":         meta.get("error"),
        "hecvat_path":   meta.get("hecvat_path"),
        "original_filename": meta.get("original_filename"),
        "owner_user_id": meta.get("owner_user_id"),
        "assigned_user_ids": list(meta.get("assigned_user_ids") or []),
        "findings":      [],
        "summary":       None,
        "followup_questions": {},
        "followup_answers":   {},
    }
    try:
        os.makedirs(REPORTS_DIR, exist_ok=True)
        with open(path, "w") as f:
            json.dump(stub, f, indent=2)
        meta["session_file"] = path
    except Exception as e:
        print(f"[session {session_id}] could not persist stub: {e}")


def _persist_failure(session_id: str) -> None:
    meta = SESSIONS.get(session_id)
    if not meta:
        return
    session = _load_session_file(session_id)
    if session is None:
        _persist_stub(session_id)
        return
    session["status"] = "failed"
    session["error"]  = meta.get("error")
    try:
        followup.save_session(session, meta.get("session_file"))
    except Exception as e:
        print(f"[session {session_id}] could not persist failure: {e}")


def _sweep_orphaned_uploads() -> None:
    staged_dir = os.path.join(UPLOAD_DIR, "staged")
    if not os.path.isdir(staged_dir):
        return
    referenced = {m.get("hecvat_path") for m in SESSIONS.values() if m.get("hecvat_path")}
    removed = 0
    for name in os.listdir(staged_dir):
        full = os.path.join(staged_dir, name)
        if full in referenced or not os.path.isfile(full):
            continue
        try:
            os.remove(full)
            removed += 1
        except OSError as e:
            print(f"[startup] could not remove orphaned upload {name}: {e}")
    if removed:
        print(f"[startup] removed {removed} orphaned staged upload(s)")


# after rehydration, so restored sessions still count as referencing their upload
_sweep_orphaned_uploads()


_DOC_TYPE_LABELS = {"soc2": "SOC 2 Type 2", "vendor_doc": "Vendor document"}


def _evidence_label(finding: dict) -> str:
    if not finding.get("vendor_evidence_corroborated"):
        return "HECVAT"
    doc_types = finding.get("evidence_doc_types") or []
    labels = [_DOC_TYPE_LABELS.get(d, "Vendor document") for d in doc_types]
    # de-duplicate while keeping order
    seen, ordered = set(), []
    for l in labels:
        if l not in seen:
            seen.add(l); ordered.append(l)
    return " + ".join(ordered) if ordered else "HECVAT"


# only the fields the modal draws — the full evidence record was 817 KB of a 1.2 MB response
_EVIDENCE_FIELDS_SHOWN = ("filename", "page", "cell", "chunk_id")


def _evidence_for_display(references: list) -> list[dict]:
    trimmed = []
    for reference in references or []:
        if not isinstance(reference, dict):
            continue
        trimmed.append({
            key: reference.get(key)
            for key in _EVIDENCE_FIELDS_SHOWN
            if reference.get(key) is not None
        })
    return trimmed


MAX_SERVICE_NAME = 120

# bidi overrides make "‮gnp.exe" display as "exe.png" — strip the whole Cf class
_BIDI_AND_INVISIBLES = re.compile(r"[​-‏‪-‮⁦-⁩﻿]")


def _validated_service_name(name: str) -> str:
    cleaned = _BIDI_AND_INVISIBLES.sub("", name or "").strip()
    if not cleaned:
        raise HTTPException(400, "vendor / service name is required")
    if len(cleaned) > MAX_SERVICE_NAME:
        raise HTTPException(400, f"vendor / service name is too long — max {MAX_SERVICE_NAME} characters")
    return cleaned


def _validated_answer(session: dict, control_id: str, answer: str) -> str:
    questions = session.get("followup_questions") or {}
    if control_id not in questions:
        raise HTTPException(
            400,
            f"'{control_id}' is not one of this session's follow-up questions"
        )
    if not (answer or "").strip():
        raise HTTPException(400, "answer cannot be empty — skip the question instead of answering it blank")
    return answer


def _scrub_paths(msg: str) -> str:
    msg = re.sub(r"/[\w./-]*/uploads_tmp/[\w./-]*", "<uploaded file>", msg)
    msg = re.sub(r"/home/[\w.-]+/[\w./-]*", "<server path>", msg)
    return msg


def _actor(request: Request) -> dict:
    actor = getattr(request.state, "actor", None)
    if not actor:
        raise HTTPException(401, "authentication required")
    return actor


def _authorized_session(request: Request, session_id: str, *, mutate: bool) -> dict:
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, "session not found")
    if not auth.session_access_allowed(_actor(request), meta, mutate=mutate):
        raise HTTPException(403, "forbidden for this session")
    return meta


def _set_auth_cookies(response: Response, token: str, csrf: str, expires: datetime) -> None:
    response.set_cookie(
        key=auth.SESSION_COOKIE,
        value=token,
        **auth.cookie_options(expires, httponly=True),
    )
    response.set_cookie(
        key=auth.CSRF_COOKIE,
        value=csrf,
        **auth.cookie_options(expires, httponly=False),
    )


@app.post("/auth/login")
def login(body: LoginRequest, response: Response):
    try:
        user, token, csrf, expires = auth.login(body.username, body.password)
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    _set_auth_cookies(response, token, csrf, expires)
    return {"user": user}


@app.post("/auth/signup", status_code=201)
def signup(body: SignupRequest, response: Response):
    try:
        auth.register_viewer(
            body.username,
            body.password,
            display_name=body.display_name,
        )
        user, token, csrf, expires = auth.login(body.username, body.password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    _set_auth_cookies(response, token, csrf, expires)
    return {"user": user}


@app.get("/auth/me", dependencies=AUTH)
def auth_me(request: Request):
    return {"user": _actor(request)}


@app.post("/auth/logout", dependencies=AUTH)
def logout(request: Request, response: Response):
    actor = _actor(request)
    auth.revoke(getattr(request.state, "session_token", None), actor["id"])
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    response.delete_cookie(auth.CSRF_COOKIE, path="/")
    return {"status": "logged_out"}


@app.get("/auth/users", dependencies=ADMIN)
def users_list():
    return {"users": auth.list_users()}


@app.post("/auth/users", dependencies=ADMIN)
def users_create(body: CreateUserRequest, request: Request):
    try:
        user = auth.create_user(
            body.username,
            body.password,
            body.role,
            display_name=body.display_name,
            created_by=_actor(request)["id"],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"user": user}


@app.patch("/auth/users/{user_id}", dependencies=ADMIN)
def users_set_state(user_id: str, body: UserStateRequest, request: Request):
    if user_id == _actor(request)["id"] and body.disabled:
        raise HTTPException(400, "you cannot disable your own account")
    try:
        user = auth.set_user_disabled(user_id, body.disabled, _actor(request)["id"])
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"user": user}


@app.delete("/auth/users/{user_id}", dependencies=ADMIN)
def users_delete(user_id: str, request: Request):
    owned = sum(
        1 for meta in SESSIONS.values()
        if meta.get("owner_user_id") == user_id
    )
    if owned:
        raise HTTPException(
            409,
            f"this account owns {owned} assessment session{'s' if owned != 1 else ''} — "
            "reassign them or disable the account instead",
        )
    try:
        deleted = auth.delete_user(user_id, _actor(request)["id"])
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"deleted": deleted}


@app.post("/auth/users/{user_id}/password", dependencies=ADMIN)
def users_reset_password(user_id: str, body: PasswordResetRequest, request: Request):
    try:
        auth.set_password(user_id, body.password, _actor(request)["id"])
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"status": "password_reset"}


def _ingest_upload(file: UploadFile, ingest_fn, kind: Optional[str] = None) -> dict:
    path = _save_upload(file)
    try:
        # the staged path is "<uuid>_<name>"; ingest records the name the admin actually sent
        ingest_fn(path, file.filename)
        # drop cached collection handles — a stale one breaks report generation
        rag.invalidate_cache()
        return {"filename": file.filename, "kind": kind or _ext_kind(file.filename), "status": "Parsed"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[upload] {file.filename} failed: {traceback.format_exc()}")
        raise HTTPException(400, f"could not ingest '{file.filename}': {_scrub_paths(str(e))}")
    finally:
        if os.path.exists(path):
            os.remove(path)


def _ext_kind(filename: str) -> str:
    ext = filename.lower().rsplit(".", 1)[-1]
    return {"pdf": "pdf", "docx": "doc", "doc": "doc", "xlsx": "xls", "xls": "xls"}.get(ext, "other")


@app.post("/uploads/policy", dependencies=ADMIN)
def upload_policy(file: UploadFile = File(...)):
    return _ingest_upload(file, ingest.ingest_policy_pdf)


@app.post("/uploads/hecvat-template", dependencies=ADMIN)
def upload_hecvat_template(file: UploadFile = File(...)):
    return _ingest_upload(file, ingest.ingest_hecvat_template, kind="xls")


@app.post("/uploads/soc2", dependencies=ADMIN)
def upload_soc2_legacy():
    raise HTTPException(
        410,
        "Global vendor evidence uploads are disabled. Attach evidence to an assessment session.",
    )


@app.post("/uploads/vendor-doc", dependencies=ADMIN)
def upload_vendor_doc_legacy():
    raise HTTPException(
        410,
        "Global vendor evidence uploads are disabled. Attach evidence to an assessment session.",
    )


@app.post("/uploads/vendor-hecvat", dependencies=ASSESSOR)
def upload_vendor_hecvat(request: Request, file: UploadFile = File(...),
                         service_name: str = "Unknown Vendor",
                         allow_duplicate: bool = False):
    actor = _actor(request)
    service_name = _validated_service_name(service_name)
    # warn on a duplicate vendor name; allow_duplicate is what makes the UI's "start anyway" work
    if not allow_duplicate:
        name_lower = service_name.lower()
        # snapshot before iterating so a concurrent delete/background task can't raise "dict changed size" (h5)
        for sid, meta in list(SESSIONS.items()):
            if not auth.session_access_allowed(actor, meta, mutate=False):
                continue
            if (meta.get("service_name") or "").strip().lower() == name_lower:
                raise HTTPException(
                    409,
                    f"A session named \"{service_name}\" already exists. "
                    "Please use a different vendor or service name (e.g. add a version or date)."
                )

    # just stages the session — assessment only kicks off once the user hits "start analysis"
    path = _save_upload(file, subdir="staged")

    # parse now, not at start-analysis — a zero-byte file used to report "Parsed" and fail later
    try:
        controls = assess.parse_uploaded_hecvat(path)
        if not controls:
            raise ValueError("no assessable controls found — is this a filled HECVAT workbook?")
    except HTTPException:
        raise
    except Exception as e:
        if os.path.exists(path):
            os.remove(path)
        raise HTTPException(400, f"could not read '{file.filename}': {_scrub_paths(str(e))}")
    session_id = uuid.uuid4().hex
    SESSIONS[session_id] = {
        "status":       "uploaded",
        "service_name": service_name,
        "hecvat_path":  path,
        # keep the name the vendor sent, so source_workbook names a document someone can look up
        "original_filename": _safe_filename(file.filename),
        "created_at":   datetime.now().isoformat(),
        "session_file": None,
        "owner_user_id": actor["id"],
        "assigned_user_ids": [],
    }
    # persist immediately, or a restart drops the session and orphans its upload
    _persist_stub(session_id)
    return {"session_id": session_id, "filename": file.filename, "kind": "xls", "status": "Parsed"}


def _ingest_session_evidence(
    request: Request,
    session_id: str,
    file: UploadFile,
    ingest_fn,
) -> dict:
    meta = _authorized_session(request, session_id, mutate=True)
    if meta.get("status") in _RUNNING_STATES or meta.get("status") in _SEALED_STATES:
        raise HTTPException(409, "evidence cannot be changed while a session is running or sealed")
    actor = _actor(request)
    path = _save_upload(file, subdir="evidence_staging")
    try:
        result = ingest_fn(
            path,
            session_id=session_id,
            vendor_id=meta["service_name"],
            owner_user_id=actor["id"],
            source_filename=file.filename,
        )
        rag.invalidate_cache()
        return {
            "filename": file.filename,
            "status": "Parsed" if result.get("chunk_count") else "Manual review required",
            **result,
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[evidence {session_id}] {file.filename} failed: {traceback.format_exc()}")
        raise HTTPException(400, f"could not ingest '{file.filename}': {_scrub_paths(str(exc))}")
    finally:
        if os.path.exists(path):
            os.remove(path)


@app.post("/sessions/{session_id}/evidence/soc2", dependencies=ASSESSOR)
def upload_session_soc2(session_id: str, request: Request, file: UploadFile = File(...)):
    return _ingest_session_evidence(request, session_id, file, ingest.ingest_soc2_pdf)


@app.post("/sessions/{session_id}/evidence/vendor-doc", dependencies=ASSESSOR)
def upload_session_vendor_doc(session_id: str, request: Request, file: UploadFile = File(...)):
    return _ingest_session_evidence(request, session_id, file, ingest.ingest_vendor_doc_pdf)


@app.get("/sessions/{session_id}/evidence", dependencies=AUTH)
def list_session_evidence(session_id: str, request: Request):
    _authorized_session(request, session_id, mutate=False)
    return {"documents": ingest.list_scoped_evidence(session_id)}


@app.get("/knowledge-base/documents", dependencies=ADMIN)
def kb_documents():
    out = {}
    for name in ingest.KB_COLLECTIONS:
        try:
            out[name] = ingest.list_documents(name)
        except Exception as e:
            print(f"[kb_documents] could not list '{name}': {e}")
            out[name] = []
    return {"collections": out}


@app.delete("/knowledge-base/documents/{collection}/{doc_id}", dependencies=ADMIN)
def kb_delete_document(collection: str, doc_id: str):
    # check against the known collections so this can't be aimed at an arbitrary one
    if collection not in ingest.KB_COLLECTIONS:
        raise HTTPException(400, f"unknown collection '{collection}'")
    try:
        removed = ingest.delete_document(collection, doc_id)
    except Exception as e:
        print(f"[kb_delete] {collection}/{doc_id} failed: {traceback.format_exc()}")
        raise HTTPException(500, f"delete failed: {e}")
    if removed == 0:
        raise HTTPException(404, f"no document '{doc_id}' in {collection}")
    # drop cached collection handles — a stale one breaks report generation
    rag.invalidate_cache()
    return {"status": "deleted", "collection": collection, "doc_id": doc_id, "chunks_removed": removed}


@app.get("/knowledge-base/stats", dependencies=ADMIN)
def kb_stats():
    import chromadb
    # use config so stats honour SEDONA_CHROMA_DIR and agree with what ingest/rag actually read/write
    client = chromadb.PersistentClient(path=config.CHROMA_DIR)
    out = {}
    for name in (config.CHROMA_COLLECTION_POLICIES,
                 config.CHROMA_COLLECTION_HECVAT_TEMPLATE,
                 config.CHROMA_COLLECTION_SOC2):
        try:
            out[name] = client.get_collection(name).count()
        except Exception as e:
            print(f"[kb_stats] could not query '{name}': {e}")
            out[name] = 0
    return out


def _run_full_assessment(session_id: str):
    # m6: use .get() so a session deleted between scheduling and execution fails gracefully
    meta = SESSIONS.get(session_id)
    if meta is None:
        _release_run(session_id)
        return
    # starts on the first control so elapsed times the real scan (first→last), not warmup; monotonic to survive clock changes
    started = None
    try:
        with _session_locks[session_id]:
            meta["status"] = "assessing"
            meta["started_at"] = datetime.now().isoformat()
            meta.pop("finished_at", None)      # a retry re-times from scratch
            meta.pop("elapsed_seconds", None)
            meta["progress"] = {"done": 0, "total": 0, "control_id": None, "section": None, "elapsed": 0}

        # feed live per-control progress into meta so the status endpoint can drive the loading screen
        def _progress(done, total, control_id, section):
            nonlocal started
            if started is None:
                started = time.monotonic()
            if session_id not in SESSIONS:
                return  # h4: session deleted mid-run, don't write back
            with _session_locks[session_id]:
                meta["progress"] = {"done": done, "total": total, "control_id": control_id, "section": section,
                                    "elapsed": int(time.monotonic() - started)}

        findings = assess.run_assessment(
            meta["hecvat_path"],
            meta["service_name"],
            progress_cb=_progress,
            should_cancel=lambda: session_id not in SESSIONS,
            session_id=session_id,
            vendor_id=meta["service_name"],
            source_filename=meta.get("original_filename"),
        )
        summary  = assess.summarize_findings(findings)

        # one llm call per gap finding — held under the lock it stalled every status poll
        session_file_path = os.path.join(REPORTS_DIR, f"session_{session_id}.json")
        session = followup.build_session_payload(
            findings, summary, meta["service_name"],
            session_path=session_file_path
        )
        has_questions = bool(session.get("followup_questions"))
        finished_at = datetime.now().isoformat()

        # finalise under the lock, or a delete landing here leaves a file that resurrects on reboot
        with _session_locks[session_id]:
            if session_id not in SESSIONS:
                return  # deleted while assessing, discard — nothing lands on disk
            # stamp the creation time into the file so a restart restores the real date, not boot time
            session["session_id"] = session_id
            session["created_at"] = meta.get("created_at")
            session["owner_user_id"] = meta.get("owner_user_id")
            session["assigned_user_ids"] = list(meta.get("assigned_user_ids") or [])
            meta["status"] = "awaiting_followup" if has_questions else "ready_for_report"
            meta["summary"] = summary
            # persist the run timing with the session so NFR-202 is measurable after a restart
            meta["finished_at"] = finished_at
            if meta.get("started_at"):
                try:
                    meta["elapsed_seconds"] = int(
                        (datetime.fromisoformat(finished_at)
                         - datetime.fromisoformat(meta["started_at"])).total_seconds()
                    )
                except Exception as e:
                    print(f"[session {session_id}] could not compute elapsed time: {e}")
            for k in ("started_at", "finished_at", "elapsed_seconds"):
                if meta.get(k) is not None:
                    session[k] = meta[k]
            # everything is stamped in already, so this is one write instead of three
            followup.save_session(session, session_file_path)
            meta["session_file"] = session_file_path
            meta.pop("error", None)
            meta.pop("progress", None)

        # m5: wrap cleanup in its own try/except so a missing/locked file can't flip a good run to failed
        try:
            if os.path.exists(meta.get("hecvat_path", "")):
                os.remove(meta["hecvat_path"])
        except Exception as e:
            print(f"[session {session_id}] could not remove hecvat file: {e}")
    except assess.AssessmentCancelled:
        # session was deleted mid-scan (that's what tripped should_cancel) — discard, nothing to write back
        return
    except Exception as e:
        # the session only keeps str(e), so log the traceback or an intermittent failure is undiagnosable
        print(f"[session {session_id}] assessment failed:\n{traceback.format_exc()}")
        with _session_locks[session_id]:
            meta["status"] = "failed"
            meta["error"]  = str(e)
            # l6a: clear progress so a stale progress dict doesn't sit next to status: failed
            meta.pop("progress", None)
        # persist the failure, otherwise a restart re-derives this as ready_for_report
        _persist_failure(session_id)
    finally:
        # always free the GPU so the next assessment can start, whatever the outcome
        _release_run(session_id)


@app.post("/sessions/{session_id}/start-analysis", dependencies=AUTH)
def start_analysis(session_id: str, background_tasks: BackgroundTasks, request: Request):
    meta = _authorized_session(request, session_id, mutate=True)
    if meta["status"] not in ("uploaded", "failed"):
        raise HTTPException(409, f"cannot start — session status is '{meta['status']}'")
    if not meta.get("hecvat_path") or not os.path.exists(meta["hecvat_path"]):
        raise HTTPException(409, "original HECVAT file is no longer available — please re-upload")

    # catch it here too, so an empty knowledge base is an upfront error rather than an empty run
    try:
        corpus = rag.policy_corpus_size()
    except Exception as e:
        print(f"[session {session_id}] could not check knowledge base size: {e}")
        corpus = None  # don't block the run on a failed check — the assess-side preflight still guards it
    if corpus == 0:
        raise HTTPException(
            409,
            "Knowledge base is empty — no policy documents have been ingested, so there is nothing to "
            "assess this vendor against. Upload your policy documents on the Knowledge Base page first."
        )

    busy = _try_acquire_run(session_id, "queued")
    if busy:
        raise HTTPException(409, "An assessment is already running — wait for it to finish before starting another.")

    background_tasks.add_task(_run_full_assessment, session_id)
    return {"session_id": session_id, "status": "queued"}


@app.get("/sessions/{session_id}/status", dependencies=AUTH)
def get_session_status(session_id: str, request: Request):
    meta = _authorized_session(request, session_id, mutate=False)
    # h5: snapshot under the lock so iteration can't race with a background task adding/popping keys
    with _session_locks[session_id]:
        data = dict(meta)
    # m8: return only the fields the frontend needs — don't leak internal paths or raw exception strings
    # polled every 5s, so keep it small: "summary" is the whole finding set, 2MB on a full run
    ALLOWED = {"status", "service_name", "created_at", "progress", "error",
               "started_at", "finished_at", "elapsed_seconds"}
    return {k: v for k, v in data.items() if k in ALLOWED}


@app.get("/sessions/{session_id}/questions", dependencies=AUTH)
def get_questions(session_id: str, request: Request):
    _authorized_session(request, session_id, mutate=False)
    session = _load_session_file(session_id)
    if not session:
        raise HTTPException(404, "session not found or assessment not yet complete")

    findings_map = {f["control_id"]: f for f in session["findings"]}
    answered     = session.get("followup_answers", {})
    skipped      = session.get("followup_skips", {})

    items = []
    for cid, q in session.get("followup_questions", {}).items():
        f = findings_map.get(cid, {})
        items.append({
            "control_id":      cid,
            "question":        q,
            "reference":       f"HECVAT · {f.get('section', '')}",
            "answered":        cid in answered,
            "answer":          answered.get(cid),
            "skipped":         cid in skipped,
            "skip":            skipped.get(cid),
            "status":          f.get("overall_status"),
            "rmf_level":       f.get("rmf_level"),
            "gap_description": f.get("gap_description"),
        })

    return {
        "items": items,
        "total": len(items),
        "answered_count": len(answered),
        "skipped_count": len(skipped),
    }


def _record_followup_event(
    session: dict,
    *,
    request: Request,
    control_id: str,
    action: str,
    value: Optional[str],
) -> None:
    actor = _actor(request)
    session.setdefault("followup_history", []).append({
        "control_id": control_id,
        "action": action,
        "value": value,
        "actor_user_id": actor["id"],
        "actor_username": actor["username"],
        "timestamp": datetime.now().astimezone().isoformat(),
    })


@app.post(
    "/sessions/{session_id}/findings/{control_id}/manual-resolution",
    dependencies=ASSESSOR,
)
def resolve_consistency_manually(
    session_id: str,
    control_id: str,
    body: ManualResolutionRequest,
    request: Request,
):
    meta = _authorized_session(request, session_id, mutate=True)
    if meta.get("status") in _SEALED_STATES:
        raise HTTPException(
            409,
            "this assessment is complete; create a new assessment for a revised resolution",
        )
    justification = (body.justification or "").strip()
    if len(justification) < 20:
        raise HTTPException(400, "manual-resolution justification must be at least 20 characters")

    hecvat = assess._coerce_status(body.hecvat_compliance)
    policy = assess._coerce_status(body.policy_alignment, default="NOT_ASSESSED")
    if hecvat not in ("COMPLIANT", "PARTIAL", "GAP"):
        raise HTTPException(400, "invalid HECVAT compliance value")
    if policy not in ("COMPLIANT", "PARTIAL", "GAP", "NOT_ASSESSED"):
        raise HTTPException(400, "invalid policy alignment value")
    initial_likelihood = assess._coerce_score(body.initial_likelihood)
    initial_impact = assess._coerce_score(body.initial_impact)
    residual_likelihood = assess._coerce_score(body.residual_likelihood)
    residual_impact = assess._coerce_score(body.residual_impact)
    if 0 in (
        initial_likelihood,
        initial_impact,
        residual_likelihood,
        residual_impact,
    ):
        raise HTTPException(400, "all likelihood and impact values must be integers from 1 to 5")
    derived_status, _ = assess.reconcile_overall_status(hecvat, policy)
    claimed_status = assess._coerce_status(body.overall_status, default=derived_status)
    if claimed_status != derived_status:
        raise HTTPException(
            400,
            f"overall_status must be {derived_status} for the selected component statuses",
        )

    with _session_locks[session_id]:
        session = _load_session_file(session_id)
        if not session:
            raise HTTPException(404, "session not found")
        resolved = session.setdefault("resolved_findings", {})
        original = next(
            (
                finding for finding in session.get("findings", [])
                if finding.get("control_id") == control_id
            ),
            None,
        )
        finding = dict(resolved.get(control_id) or original or {})
        if not finding:
            raise HTTPException(404, "finding not found")
        if finding.get("consistency_status") not in (
            "NO_CONSENSUS",
            "MANUALLY_RESOLVED",
        ):
            raise HTTPException(409, "this finding already has an accepted model consensus")

        finding.update({
            "hecvat_compliance": hecvat,
            "policy_alignment": policy,
            "overall_status": derived_status,
            "assessment_status": derived_status,
            "initial_likelihood": initial_likelihood,
            "initial_impact": initial_impact,
            "residual_likelihood": residual_likelihood,
            "residual_impact": residual_impact,
            "consistency_status": "MANUALLY_RESOLVED",
            "manual_review_status": "RESOLVED",
            "manual_resolution": {
                "reviewer_user_id": _actor(request)["id"],
                "reviewer_username": _actor(request)["username"],
                "justification": justification,
                "resolved_at": datetime.now().astimezone().isoformat(),
            },
        })
        finding.update(assess.compute_rmf_risk(finding))
        finding = assess.normalize_finding(finding)
        resolved[control_id] = finding
        final_findings = [
            resolved.get(item["control_id"], item)
            for item in session.get("findings", [])
        ]
        session["final_summary"] = assess.summarize_findings(final_findings)
        followup.save_session(session, meta.get("session_file"))
        meta["summary"] = session["final_summary"]

    return {"finding": finding, "summary": session["final_summary"]}


@app.post("/sessions/{session_id}/answers/{control_id}", dependencies=AUTH)
def submit_one_answer(session_id: str, control_id: str, body: FollowupAnswer,
                      request: Request):
    _authorized_session(request, session_id, mutate=True)
    if control_id != body.control_id:
        raise HTTPException(400, "control_id mismatch")

    with _session_locks[session_id]:
        # no writes while a run holds the session, or this save races the resolver and one update is lost
        running = SESSIONS.get(session_id)
        if running and running.get("status") in _RUNNING_STATES:
            raise HTTPException(409, "cannot save answers while the assessment or report is running")
        # the report is out — its source data must not change underneath it
        if running and running.get("status") in _SEALED_STATES:
            raise HTTPException(
                409,
                "this assessment is complete — start a new session to re-assess"
            )

        session = _load_session_file(session_id)
        if not session:
            raise HTTPException(404, "session not found")

        answer = _validated_answer(session, control_id, body.answer)
        action = "answer_edited" if control_id in session.get("followup_answers", {}) else "answer_saved"
        session.setdefault("followup_answers", {})[control_id] = answer
        session.setdefault("followup_skips", {}).pop(control_id, None)
        _record_followup_event(
            session,
            request=request,
            control_id=control_id,
            action=action,
            value=answer,
        )
        followup.save_session(session, SESSIONS[session_id].get("session_file"))

    return {"status": "saved", "control_id": control_id}


@app.put("/sessions/{session_id}/answers/{control_id}", dependencies=AUTH)
def edit_one_answer(session_id: str, control_id: str, body: FollowupAnswer,
                    request: Request):
    return submit_one_answer(session_id, control_id, body, request)


@app.post("/sessions/{session_id}/questions/{control_id}/skip", dependencies=AUTH)
def skip_followup_question(
    session_id: str,
    control_id: str,
    body: FollowupSkip,
    request: Request,
):
    _authorized_session(request, session_id, mutate=True)
    if control_id != body.control_id:
        raise HTTPException(400, "control_id mismatch")
    with _session_locks[session_id]:
        meta = SESSIONS.get(session_id)
        if meta and meta.get("status") in _RUNNING_STATES + _SEALED_STATES:
            raise HTTPException(409, "questions cannot be changed while a session is running or sealed")
        session = _load_session_file(session_id)
        if not session:
            raise HTTPException(404, "session not found")
        if control_id not in (session.get("followup_questions") or {}):
            raise HTTPException(400, "unknown follow-up question")
        reason = (body.reason or "").strip() or "Skipped without a reason"
        session.setdefault("followup_skips", {})[control_id] = {
            "reason": reason,
            "skipped_at": datetime.now().astimezone().isoformat(),
            "skipped_by": _actor(request)["username"],
        }
        session.setdefault("followup_answers", {}).pop(control_id, None)
        _record_followup_event(
            session,
            request=request,
            control_id=control_id,
            action="question_skipped",
            value=reason,
        )
        followup.save_session(session, meta.get("session_file"))
    return {"status": "skipped", "control_id": control_id}


@app.post("/sessions/{session_id}/answers", dependencies=AUTH)
def submit_answers_batch(session_id: str, body: SubmitAnswersRequest, request: Request):
    _authorized_session(request, session_id, mutate=True)
    with _session_locks[session_id]:
        # no writes while a run holds the session, or this save races the resolver and one update is lost
        running = SESSIONS.get(session_id)
        if running and running.get("status") in _RUNNING_STATES:
            raise HTTPException(409, "cannot save answers while the assessment or report is running")
        # see _SEALED_STATES — a rendered report's source data is frozen
        if running and running.get("status") in _SEALED_STATES:
            raise HTTPException(
                409,
                "this assessment is complete — start a new session to re-assess"
            )

        session = _load_session_file(session_id)
        if not session:
            raise HTTPException(404, "session not found")

        answers = session.setdefault("followup_answers", {})
        for item in body.answers:
            answer = _validated_answer(session, item.control_id, item.answer)
            action = "answer_edited" if item.control_id in answers else "answer_saved"
            answers[item.control_id] = answer
            session.setdefault("followup_skips", {}).pop(item.control_id, None)
            _record_followup_event(
                session,
                request=request,
                control_id=item.control_id,
                action=action,
                value=answer,
            )

        if body.pause_after:
            SESSIONS[session_id]["status"] = "paused"
            # write the pause to disk too, otherwise a restart would forget and rehydrate this as awaiting_followup
            session["status"] = "paused"

        followup.save_session(session, SESSIONS[session_id].get("session_file"))
        status = SESSIONS[session_id]["status"]

    return {"status": "saved", "count": len(body.answers), "session_status": status}


@app.post("/sessions/{session_id}/pause", dependencies=AUTH)
def pause_session(session_id: str, request: Request):
    meta = _authorized_session(request, session_id, mutate=True)
    if meta["status"] not in ("awaiting_followup", "paused"):
        raise HTTPException(409, f"cannot pause from status '{meta['status']}'")

    # move the status write inside the lock so it's consistent with the disk write (M5)
    with _session_locks[session_id]:
        meta["status"] = "paused"
        try:
            session = _load_session_file(session_id)
            if session is not None:
                session["status"] = "paused"
                followup.save_session(session, meta.get("session_file"))
        except Exception as e:
            print(f"[session {session_id}] could not persist paused status: {e}")

    return {"session_id": session_id, "status": "paused"}


@app.post("/sessions/{session_id}/resume", dependencies=AUTH)
def resume_session(session_id: str, request: Request):
    meta = _authorized_session(request, session_id, mutate=True)
    if meta["status"] != "paused":
        raise HTTPException(409, f"session is not paused (status='{meta['status']}')")

    with _session_locks[session_id]:
        session = _load_session_file(session_id)
        if not session:
            raise HTTPException(404, "session file missing on disk — cannot resume")

        answered_count  = len(session.get("followup_answers", {}))
        total_questions = len(session.get("followup_questions", {}))
        meta["status"] = "awaiting_followup" if answered_count < total_questions else "ready_for_report"

        # clear the persisted "paused" flag now, or a later restart would strand this session back in paused
        session["status"] = meta["status"]
        try:
            followup.save_session(session, meta.get("session_file"))
        except Exception as e:
            print(f"[session {session_id}] could not persist resumed status: {e}")

    return {"session_id": session_id, "status": meta["status"]}


def _run_resolve_and_report(session_id: str):
    # m6: use .get() so a session deleted between scheduling and execution fails gracefully
    meta = SESSIONS.get(session_id)
    if meta is None:
        _release_run(session_id)
        return
    try:
        with _session_locks[session_id]:
            meta["status"] = "resolving"
        session = _load_session_file(session_id)
        answered_ids = list(session.get("followup_answers", {}).keys())

        if answered_ids:
            # H8: pass generate_report=False so _resolve doesn't create an orphaned copy in ./reports
            followup._resolve(session, answered_ids, generate_report=False)
            session = _load_session_file(session_id)

        resolved_map   = session.get("resolved_findings", {})
        final_findings = [resolved_map.get(f["control_id"], f) for f in session["findings"]]
        final_summary  = assess.summarize_findings(final_findings)

        pdf_path, pptx_path, csv_path = report.generate_all(
            final_findings, final_summary, meta["service_name"], REPORTS_DIR,
            session_id=session_id,
        )

        with _session_locks[session_id]:
            # deleted while rendering — don't write "complete" back for a session that is gone
            if session_id not in SESSIONS:
                return
            meta.update({
                "status":    "complete",
                "summary":   final_summary,
                "pdf_path":  pdf_path,
                "pptx_path": pptx_path,
                "csv_path":  csv_path,
            })

        # persist basenames (not full paths) so this still resolves correctly if REPORTS_DIR ever moves
        try:
            session["status"]        = "complete"
            session["report_pdf"]    = os.path.basename(pdf_path)
            session["report_pptx"]   = os.path.basename(pptx_path)
            session["report_csv"]    = os.path.basename(csv_path)
            followup.save_session(session, meta.get("session_file"))
        except Exception as e:
            print(f"[session {session_id}] could not persist completion marker: {e}")
    except Exception as e:
        # str(e) alone won't locate a failure inside resolve or rendering
        print(f"[session {session_id}] resolve/report failed:\n{traceback.format_exc()}")
        with _session_locks[session_id]:
            meta["status"] = "failed"
            meta["error"]  = str(e)
        _persist_failure(session_id)
    finally:
        # always free the GPU so the next assessment can start, whatever the outcome
        _release_run(session_id)


@app.post("/sessions/{session_id}/generate-report", dependencies=AUTH)
def generate_report(session_id: str, background_tasks: BackgroundTasks, request: Request):
    meta = _authorized_session(request, session_id, mutate=True)
    # m7: allow retry from failed in addition to the normal pre-report states
    if meta["status"] not in ("awaiting_followup", "ready_for_report", "paused", "failed"):
        raise HTTPException(409, f"cannot generate report from status '{meta['status']}'")

    # open follow-ups are fine — questions can be skipped, so report on whatever was answered

    busy = _try_acquire_run(session_id, "resolving")
    if busy:
        raise HTTPException(409, "An assessment is already running — wait for it to finish before starting another.")

    background_tasks.add_task(_run_resolve_and_report, session_id)
    return {"session_id": session_id, "status": "resolving"}


@app.get("/sessions/{session_id}/results", dependencies=AUTH)
def get_results(session_id: str, request: Request, severity: Optional[str] = None):
    meta = _authorized_session(request, session_id, mutate=False)
    if meta["status"] != "complete":
        raise HTTPException(409, f"results not ready (status='{meta['status']}')")

    session  = _load_session_file(session_id)
    resolved = session.get("resolved_findings", {})
    findings = [resolved.get(f["control_id"], f) for f in session["findings"]]

    # NOT_SCORED buckets as low, so an unscored gap can't masquerade as a critical finding
    sev_key_map = {"VERY_HIGH": "vh", "HIGH": "h", "MEDIUM": "m", "MINOR": "mn", "LOW": "l", "NOT_SCORED": "l"}
    counts = {"vh": 0, "h": 0, "m": 0, "mn": 0, "l": 0}
    risk_cards = []

    for f in findings:
        status = f.get("overall_status")
        inconsistent = f.get("consistency_status") == "NO_CONSENSUS"
        # skip controls with no evidence — they don't contribute to the risk picture
        if status == "INSUFFICIENT_EVIDENCE":
            continue
        key = sev_key_map.get(config.normalize_rmf_level(f.get("rmf_level")), "l")
        # only GAP and PARTIAL get a card; COMPLIANT still counts toward the totals
        if status in ("GAP", "PARTIAL") or inconsistent:
            if not inconsistent:
                counts[key] += 1
            risk_cards.append({
                "control_id":     f["control_id"],
                "severity":       key,
                "title":          f.get("section", f["control_id"]),
                "description":    (
                    (
                        "The assessment run did not produce a usable result; manual review is required."
                        if config.CONSISTENCY_RUNS == 1 else
                        f"{config.CONSISTENCY_RUNS} independent assessment runs did not reach "
                        "consensus; manual review is required."
                    )
                    if inconsistent else f.get("gap_description")
                ),
                # label from the evidence actually retrieved, not from a boolean the model set itself
                "source":         _evidence_label(f),
                "recommendation": f.get("recommendation"),
                "policy_alignment":         f.get("policy_alignment"),
                "policy_clause_referenced": f.get("policy_clause_referenced"),
                "risk_categories":          f.get("risk_categories", []),
                "risk_description":         f.get("risk_description"),
                "cause":                    f.get("cause"),
                "consequence":              f.get("consequence"),
                "consequence_category":     f.get("consequence_category"),
                "source_workbook":          f.get("source_workbook"),
                "source_worksheet":         f.get("source_worksheet"),
                "source_row":               f.get("source_row"),
                "source_cell":              f.get("source_cell"),
                "requirement":              f.get("requirement"),
                "vendor_response":          f.get("vendor_response"),
                "initial_likelihood":       f.get("initial_likelihood"),
                "initial_impact":           f.get("initial_impact"),
                "initial_risk_rating":      f.get("initial_risk_rating"),
                "existing_controls":        f.get("existing_controls", []),
                "control_effectiveness":    f.get("control_effectiveness"),
                "proposed_treatment":       f.get("proposed_treatment"),
                "proposed_controls":        f.get("proposed_controls", []),
                "residual_likelihood":      f.get("residual_likelihood"),
                "residual_impact":          f.get("residual_impact"),
                "residual_risk_rating":     f.get("residual_risk_rating"),
                "evidence_references":      _evidence_for_display(f.get("evidence_references")),
                "evidence_quality":         f.get("evidence_quality"),
                # the modal has a row for this; without the field an "exception found" was invisible
                "vendor_evidence_state":    f.get("vendor_evidence_state"),
                "assessment_status":        f.get("assessment_status"),
                "consistency_status":       f.get("consistency_status"),
                "manual_review_status":     f.get("manual_review_status"),
                # send the schema version so the UI can tell a migration default from a real result
                "schema_version":           (f.get("audit_metadata") or {}).get("schema_version"),
		    })

    if severity:
        risk_cards = [r for r in risk_cards if r["severity"] == severity]

    return {"counts": counts, "risks": risk_cards, "service_name": meta.get("service_name")}


@app.get("/sessions", dependencies=AUTH)
def list_sessions(request: Request):
    actor = _actor(request)
    # h5: snapshot the registry before iterating so a concurrent delete can't cause RuntimeError
    rows = []
    for sid, meta in list(SESSIONS.items()):
        if not auth.session_access_allowed(actor, meta, mutate=False):
            continue
        rows.append({
            "session_id":   sid,
            "service_name": meta.get("service_name"),
            "status":       meta.get("status"),
            "created_at":   meta.get("created_at"),
            "resumable":    meta.get("status") == "paused",
            "viewable":     meta.get("status") == "complete",
            # surface the failure reason so a failed row isn't just a dead end with a delete button
            "error":        meta.get("error") if meta.get("status") == "failed" else None,
            "owner_user_id": meta.get("owner_user_id"),
            "assigned_user_ids": list(meta.get("assigned_user_ids") or []),
        })
    # coerce to str — a single row with a missing created_at would otherwise blow up the whole list with a TypeError
    rows.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return {"sessions": rows}


@app.post("/sessions/{session_id}/assign", dependencies=ADMIN)
def assign_session(session_id: str, body: SessionAssignmentRequest, request: Request):
    meta = _authorized_session(request, session_id, mutate=True)
    users = {user["id"]: user for user in auth.list_users()}
    requested = list(dict.fromkeys(body.user_ids))
    missing = [user_id for user_id in requested if user_id not in users or users[user_id]["disabled"]]
    if missing:
        raise HTTPException(400, "one or more assigned users do not exist or are disabled")
    meta["assigned_user_ids"] = requested
    session = _load_session_file(session_id)
    if session is not None:
        session["assigned_user_ids"] = requested
        followup.save_session(session, meta.get("session_file"))
    else:
        _persist_stub(session_id)
    return {"session_id": session_id, "assigned_user_ids": requested}


@app.delete("/sessions/{session_id}", dependencies=AUTH)
def delete_session(session_id: str, request: Request):
    _authorized_session(request, session_id, mutate=True)
    # h4: take the lock so a concurrent background task sees the session is gone before it writes back
    lock = _session_locks.get(session_id)
    if lock:
        lock.acquire()
    try:
        meta = SESSIONS.pop(session_id, None)
    finally:
        if lock:
            lock.release()
    if not meta:
        raise HTTPException(404, "session not found")
    # remove the deterministic path too, in case a late write left one that would resurrect on reboot
    for sf in {meta.get("session_file"), os.path.join(REPORTS_DIR, f"session_{session_id}.json")}:
        if sf and os.path.exists(sf):
            try:
                os.remove(sf)
            except Exception as e:
                print(f"[session {session_id}] could not remove session file: {e}")
    # h4: also clean up the staged hecvat upload so it doesn't leak on disk
    for key in ("hecvat_path", "pdf_path", "pptx_path", "csv_path"):
        p = meta.get(key)
        if p and os.path.exists(p):
            try:
                os.remove(p)
            except Exception as e:
                print(f"[session {session_id}] could not remove {key} ({p}): {e}")
    removed_chunks = ingest.delete_scoped_evidence(session_id)
    if removed_chunks:
        rag.invalidate_cache()
    # l5: remove the lock entry to stop _session_locks from growing unbounded
    _session_locks.pop(session_id, None)
    return {"status": "deleted", "session_id": session_id}


@app.get("/sessions/{session_id}/report/preview", dependencies=AUTH)
def report_preview(session_id: str, request: Request):
    meta = _authorized_session(request, session_id, mutate=False)
    if meta.get("status") != "complete":
        raise HTTPException(409, "report not ready")

    results = get_results(session_id, request)
    return {
        "service_name":    meta["service_name"],
        "stats":           results["counts"],
        "key_findings":    results["risks"][:6],
        "recommendations": [r["recommendation"] for r in results["risks"] if r.get("recommendation")][:5],
    }


def _download_filename(service_name: str, fmt: str) -> str:
    # the on-disk name carries the session uuid for restart matching; the user shouldn't see it
    safe = re.sub(r"[^A-Za-z0-9]+", "_", (service_name or "vendor")).strip("_") or "vendor"
    kind = "RiskBriefing" if fmt == "pptx" else "RiskAssessment"
    return f"{kind}_{safe}.{fmt}"


@app.get("/sessions/{session_id}/report/download", dependencies=AUTH)
def report_download(session_id: str, request: Request, fmt: str = "pdf"):
    # checked before readiness, so a bad format says so instead of hiding behind "not ready"
    if fmt not in ("pdf", "pptx", "csv"):
        raise HTTPException(400, f"invalid fmt '{fmt}' — use 'pdf', 'pptx' or 'csv'")
    meta = _authorized_session(request, session_id, mutate=False)
    if meta.get("status") != "complete":
        raise HTTPException(409, "report not ready")

    if fmt == "csv":
        # serve the sealed CSV as-is, so all three exports stay the same frozen artefact
        sealed = meta.get("csv_path")
        if sealed and os.path.exists(sealed):
            return FileResponse(
                sealed,
                filename=_download_filename(meta.get("service_name"), "csv"),
                media_type="text/csv; charset=utf-8",
            )
        # older sessions have no sealed CSV — render from the same canonical findings
        session = _load_session_file(session_id)
        if not session:
            raise HTTPException(404, "session data not found")
        resolved = session.get("resolved_findings", {})
        findings = [resolved.get(f["control_id"], f) for f in session.get("findings", [])]
        csv_bytes = report.findings_to_csv(findings)
        return Response(
            content=csv_bytes,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition":
                     f'attachment; filename="{_download_filename(meta.get("service_name"), "csv")}"'},
        )

    path = meta.get("pdf_path") if fmt == "pdf" else meta.get("pptx_path")
    if not path or not os.path.exists(path):
        raise HTTPException(404, f"{fmt} report not found")
    media_type = (
        "application/pdf" if fmt == "pdf"
        else "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )
    return FileResponse(path, filename=_download_filename(meta.get("service_name"), fmt), media_type=media_type)


@app.get("/health")
def health(strict: bool = False):
    services = gpu_engine.service_status()

    chroma = {"reachable": False, "collections": {}}
    try:
        client = chromadb.PersistentClient(path=config.CHROMA_DIR)
        for name in (config.CHROMA_COLLECTION_POLICIES,
                     config.CHROMA_COLLECTION_HECVAT_TEMPLATE,
                     config.CHROMA_COLLECTION_SOC2):
            try:
                chroma["collections"][name] = client.get_collection(name).count()
            except Exception:
                chroma["collections"][name] = 0  # not ingested yet — not a store failure
        chroma["reachable"] = True
    except Exception as e:
        chroma["error"] = str(e)

    # an empty policy corpus isn't a crash, but nothing would reach the model — surface it
    policy_chunks = (chroma["collections"].get(config.CHROMA_COLLECTION_POLICIES, 0)
                     + chroma["collections"].get(config.CHROMA_COLLECTION_HECVAT_TEMPLATE, 0))

    healthy = (services["llm"]["reachable"]
               and services["embeddings"]["reachable"]
               and chroma["reachable"]
               and policy_chunks > 0)

    body = {
        "status":   "ok" if healthy else "degraded",
        "services": services,
        "chroma":   chroma,
        "can_assess": healthy,
    }
    if not healthy:
        reasons = []
        # gpu_engine attaches an "error" when it knows more than "the port did not answer" —
        # under the ollama backend that is usually a model tag that was never pulled
        if not services["llm"]["reachable"]:
            reasons.append(services["llm"].get("error") or "LLM server unreachable")
        if not services["embeddings"]["reachable"]:
            reasons.append(services["embeddings"].get("error") or "embedding server unreachable")
        if not chroma["reachable"]:                 reasons.append("vector store unreadable")
        elif policy_chunks == 0:                    reasons.append("no policy or HECVAT template chunks ingested")
        body["reasons"] = reasons

    if strict and not healthy:
        return JSONResponse(status_code=503, content=body)
    return body
