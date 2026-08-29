from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

from fastapi import Cookie, Depends, Header, HTTPException, Request

import config


ROLES = ("admin", "assessor", "viewer")
SESSION_COOKIE = os.environ.get("SEDONA_SESSION_COOKIE", "sedona_session")
CSRF_COOKIE = os.environ.get("SEDONA_CSRF_COOKIE", "sedona_csrf")
COOKIE_SECURE = os.environ.get("SEDONA_COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
SESSION_HOURS = int(os.environ.get("SEDONA_SESSION_HOURS", "8"))
AUTH_DIR = Path(config.DATA_DIR) / "auth"
AUTH_DB = AUTH_DIR / "sedona_auth.sqlite3"
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
HASH_BYTES = 64
SCRYPT_MAXMEM = 64 * 1024 * 1024


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    AUTH_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        AUTH_DIR.chmod(0o700)
    except OSError:
        pass
    conn = sqlite3.connect(AUTH_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    if AUTH_DB.exists():
        try:
            AUTH_DB.chmod(0o600)
        except OSError:
            pass
    return conn


def initialize() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin','assessor','viewer')),
                password_hash BLOB NOT NULL,
                password_salt BLOB NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                created_by TEXT
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash BLOB PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                csrf_hash BLOB NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
                ON auth_sessions(user_id);
            CREATE TABLE IF NOT EXISTS auth_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at TEXT NOT NULL,
                event TEXT NOT NULL,
                actor_user_id TEXT,
                subject_user_id TEXT,
                username TEXT,
                detail TEXT
            );
            """
        )

        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        bootstrap_user = os.environ.get("SEDONA_BOOTSTRAP_ADMIN_USERNAME", "").strip()
        bootstrap_password = os.environ.get("SEDONA_BOOTSTRAP_ADMIN_PASSWORD", "")
        if user_count == 0 and bool(bootstrap_user) != bool(bootstrap_password):
            raise RuntimeError(
                "Set both SEDONA_BOOTSTRAP_ADMIN_USERNAME and "
                "SEDONA_BOOTSTRAP_ADMIN_PASSWORD, or neither."
            )
        if user_count == 0 and bootstrap_user and bootstrap_password:
            create_user(
                bootstrap_user,
                bootstrap_password,
                "admin",
                display_name=os.environ.get("SEDONA_BOOTSTRAP_ADMIN_DISPLAY_NAME", "Sedona Administrator"),
                created_by=None,
                conn=conn,
            )
            _audit(conn, "bootstrap_admin_created", username=bootstrap_user.lower())
        elif user_count == 0:
            print(
                "[auth] no users configured; set the bootstrap-admin environment "
                "variables for the first start"
            )


def _audit(
    conn: sqlite3.Connection,
    event: str,
    *,
    actor_user_id: Optional[str] = None,
    subject_user_id: Optional[str] = None,
    username: Optional[str] = None,
    detail: Optional[str] = None,
) -> None:
    conn.execute(
        """
        INSERT INTO auth_audit
            (occurred_at, event, actor_user_id, subject_user_id, username, detail)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (_iso(_utcnow()), event, actor_user_id, subject_user_id, username, detail),
    )


def _normalize_username(username: str) -> str:
    value = (username or "").strip().lower()
    if not USERNAME_RE.fullmatch(value):
        raise ValueError(
            "username must be 3-64 characters using lowercase letters, numbers, '.', '_' or '-'"
        )
    return value


def _validate_password(password: str) -> None:
    if len(password or "") < 12:
        raise ValueError("password must be at least 12 characters")
    if len(password) > 1024:
        raise ValueError("password is too long")
    classes = (
        any(c.islower() for c in password),
        any(c.isupper() for c in password),
        any(c.isdigit() for c in password),
        any(not c.isalnum() for c in password),
    )
    if sum(classes) < 3:
        raise ValueError("password must use at least three character classes")


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=HASH_BYTES,
        maxmem=SCRYPT_MAXMEM,
    )


def _token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def _public_user(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
    }


def create_user(
    username: str,
    password: str,
    role: str,
    *,
    display_name: Optional[str] = None,
    created_by: Optional[str],
    conn: Optional[sqlite3.Connection] = None,
) -> dict:
    username = _normalize_username(username)
    _validate_password(password)
    if role not in ROLES:
        raise ValueError(f"role must be one of: {', '.join(ROLES)}")
    display_name = (display_name or username).strip()
    if not display_name or len(display_name) > 120:
        raise ValueError("display name must be 1-120 characters")

    owned_conn = conn is None
    db = conn or _connect()
    try:
        salt = secrets.token_bytes(32)
        user_id = secrets.token_hex(16)
        now = _iso(_utcnow())
        try:
            db.execute(
                """
                INSERT INTO users
                    (id, username, display_name, role, password_hash, password_salt,
                     disabled, created_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (
                    user_id,
                    username,
                    display_name,
                    role,
                    _hash_password(password, salt),
                    salt,
                    now,
                    created_by,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("username already exists") from exc
        _audit(
            db,
            "user_created",
            actor_user_id=created_by,
            subject_user_id=user_id,
            username=username,
            detail=f"role={role}",
        )
        if owned_conn:
            db.commit()
        row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _public_user(row)
    finally:
        if owned_conn:
            db.close()


def register_viewer(
    username: str,
    password: str,
    *,
    display_name: Optional[str] = None,
) -> dict:
    user = create_user(
        username,
        password,
        "viewer",
        display_name=display_name,
        created_by=None,
    )
    with _connect() as conn:
        _audit(
            conn,
            "viewer_self_registered",
            subject_user_id=user["id"],
            username=user["username"],
        )
    return user


def list_users() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM users ORDER BY username"
        ).fetchall()
        return [_public_user(row) for row in rows]


def set_user_disabled(user_id: str, disabled: bool, actor_user_id: str) -> dict:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise KeyError("user not found")
        if row["role"] == "admin" and disabled:
            active_admins = conn.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0"
            ).fetchone()[0]
            if active_admins <= 1:
                raise ValueError("cannot disable the last active administrator")
        conn.execute("UPDATE users SET disabled = ? WHERE id = ?", (int(disabled), user_id))
        if disabled:
            conn.execute(
                "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                (_iso(_utcnow()), user_id),
            )
        _audit(
            conn,
            "user_disabled" if disabled else "user_enabled",
            actor_user_id=actor_user_id,
            subject_user_id=user_id,
            username=row["username"],
        )
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _public_user(updated)


def delete_user(user_id: str, actor_user_id: str) -> dict:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise KeyError("user not found")
        if user_id == actor_user_id:
            raise ValueError("you cannot delete your own account")
        if row["role"] == "admin":
            other_admins = conn.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?",
                (user_id,),
            ).fetchone()[0]
            if other_admins == 0:
                raise ValueError("cannot delete the last active administrator")
        deleted = _public_user(row)
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        _audit(
            conn,
            "user_deleted",
            actor_user_id=actor_user_id,
            subject_user_id=user_id,
            username=row["username"],
            detail=f"role={row['role']}",
        )
        return deleted


def set_password(user_id: str, password: str, actor_user_id: str) -> None:
    _validate_password(password)
    salt = secrets.token_bytes(32)
    with _connect() as conn:
        row = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise KeyError("user not found")
        conn.execute(
            "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
            (_hash_password(password, salt), salt, user_id),
        )
        conn.execute(
            "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            (_iso(_utcnow()), user_id),
        )
        _audit(
            conn,
            "password_reset",
            actor_user_id=actor_user_id,
            subject_user_id=user_id,
            username=row["username"],
        )


def login(username: str, password: str) -> tuple[dict, str, str, datetime]:
    normalized = (username or "").strip().lower()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (normalized,)).fetchone()
        # Always perform scrypt, including for unknown users, to reduce username timing leaks.
        salt = row["password_salt"] if row else b"\0" * 32
        expected = row["password_hash"] if row else b"\0" * HASH_BYTES
        supplied = _hash_password(password or "", salt)
        valid = row is not None and hmac.compare_digest(supplied, expected) and not row["disabled"]
        if not valid:
            _audit(conn, "login_failed", username=normalized)
            raise PermissionError("invalid username or password")

        token = secrets.token_urlsafe(48)
        csrf = secrets.token_urlsafe(32)
        now = _utcnow()
        expires = now + timedelta(hours=SESSION_HOURS)
        conn.execute(
            """
            INSERT INTO auth_sessions
                (token_hash, user_id, csrf_hash, created_at, expires_at, last_seen_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                _token_hash(token),
                row["id"],
                _token_hash(csrf),
                _iso(now),
                _iso(expires),
                _iso(now),
            ),
        )
        _audit(conn, "login_succeeded", actor_user_id=row["id"], username=row["username"])
        return _public_user(row), token, csrf, expires


def revoke(token: Optional[str], actor_user_id: Optional[str] = None) -> None:
    if not token:
        return
    with _connect() as conn:
        conn.execute(
            "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
            (_iso(_utcnow()), _token_hash(token)),
        )
        _audit(conn, "logout", actor_user_id=actor_user_id)


def authenticate(token: Optional[str]) -> tuple[dict, sqlite3.Row]:
    if not token:
        raise PermissionError("authentication required")
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT
                u.*, s.token_hash AS session_token_hash, s.csrf_hash,
                s.expires_at, s.revoked_at
            FROM auth_sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (_token_hash(token),),
        ).fetchone()
        if (
            not row
            or row["disabled"]
            or row["revoked_at"]
            or datetime.fromisoformat(row["expires_at"]) <= _utcnow()
        ):
            raise PermissionError("authentication required")
        conn.execute(
            "UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?",
            (_iso(_utcnow()), row["session_token_hash"]),
        )
        return _public_user(row), row


def require_authenticated(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    csrf_cookie: Optional[str] = Cookie(default=None, alias=CSRF_COOKIE),
    csrf_header: Optional[str] = Header(default=None, alias="X-CSRF-Token"),
) -> dict:
    try:
        actor, session_row = authenticate(session_token)
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc

    if request.method.upper() not in ("GET", "HEAD", "OPTIONS"):
        valid_csrf = (
            csrf_cookie
            and csrf_header
            and hmac.compare_digest(csrf_cookie, csrf_header)
            and hmac.compare_digest(_token_hash(csrf_header), session_row["csrf_hash"])
        )
        if not valid_csrf:
            raise HTTPException(403, "invalid or missing CSRF token")

    request.state.actor = actor
    request.state.session_token = session_token
    return actor


def require_roles(*roles: str):
    allowed = set(roles)
    if not allowed or not allowed.issubset(ROLES):
        raise ValueError("invalid role dependency")

    def dependency(actor: dict = Depends(require_authenticated)) -> dict:
        if actor["role"] not in allowed:
            raise HTTPException(403, "forbidden for this role")
        return actor

    return dependency


require_admin = require_roles("admin")
require_assessor = require_roles("admin", "assessor")


def cookie_options(expires: datetime, *, httponly: bool) -> dict:
    max_age = max(0, int((expires - _utcnow()).total_seconds()))
    return {
        "max_age": max_age,
        "secure": COOKIE_SECURE,
        "httponly": httponly,
        "samesite": "strict",
        "path": "/",
    }


def session_access_allowed(
    actor: dict,
    session_meta: dict,
    *,
    mutate: bool,
) -> bool:
    if actor["role"] == "admin":
        return True
    if actor["role"] == "assessor":
        return session_meta.get("owner_user_id") == actor["id"]
    if actor["role"] == "viewer" and not mutate:
        return (
            session_meta.get("status") == "complete"
            and actor["id"] in (session_meta.get("assigned_user_ids") or [])
        )
    return False


initialize()
