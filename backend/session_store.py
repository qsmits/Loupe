"""Per-session frame storage for multi-user hosted mode."""
import re
import hashlib
import hmac
import secrets
import threading
import time

import numpy as np
from fastapi import Request, HTTPException

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DEFAULT_SESSION_ID = "_default"
SESSION_COOKIE = "loupe_owner"
SESSION_MAX_AGE = 30 * 24 * 3600
# Caches are process-local too: a restart invalidates credentials and cached data.
_SESSION_KEY = secrets.token_bytes(32)


def session_owner(token: str | None) -> str | None:
    if not token or len(token) > 200:
        return None
    try:
        owner, issued, signature = token.split(".")
        message = f"{owner}.{issued}"
        expected = hmac.new(_SESSION_KEY, message.encode(), hashlib.sha256).hexdigest()
        age = time.time() - int(issued)
        if not hmac.compare_digest(signature, expected) or not 0 <= age <= SESSION_MAX_AGE:
            return None
        return owner
    except (ValueError, TypeError):
        return None


def issue_session_cookie(request, response) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if session_owner(token) is None:
        message = f"{secrets.token_hex(32)}.{int(time.time())}"
        signature = hmac.new(_SESSION_KEY, message.encode(), hashlib.sha256).hexdigest()
        token = f"{message}.{signature}"
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="strict",
                        secure=request.url.scheme == "https", max_age=SESSION_MAX_AGE,
                        path="/")
    response.headers["Cache-Control"] = "no-store"


def safe_error_detail(request: Request, exc: Exception, fallback: str = "Operation failed") -> str:
    """Return exception detail for HTTP responses. In hosted mode, scrub internal
    details (camera errors, file paths, GStreamer messages) to prevent info leaks."""
    if getattr(request.app.state, "hosted", False):
        import logging
        logging.getLogger(__name__).warning("Scrubbed error in hosted mode: %s", exc)
        return fallback
    return str(exc)


def validate_session_id(session_id: str) -> bool:
    return session_id == DEFAULT_SESSION_ID or bool(_UUID_RE.match(session_id))


def get_session_id_dep(request: Request) -> str:
    """FastAPI dependency: extract and validate session ID from X-Session-ID header.
    Returns DEFAULT_SESSION_ID when header is missing in non-hosted mode."""
    session_id = request.headers.get("X-Session-ID")
    if not session_id:
        if getattr(request.app.state, "hosted", False):
            raise HTTPException(400, detail="Missing X-Session-ID header")
        return DEFAULT_SESSION_ID
    if not validate_session_id(session_id):
        raise HTTPException(400, detail="Invalid session ID format")
    if getattr(request.app.state, "hosted", False):
        if session_id == DEFAULT_SESSION_ID:
            raise HTTPException(400, detail="A project UUID is required")
        owner = session_owner(request.cookies.get(SESSION_COOKIE))
        if owner is None:
            raise HTTPException(401, detail="Session required",
                                headers={"X-Loupe-Session-Required": "1"})
        # Project IDs are public/exportable namespaces, never credentials.
        return hmac.new(_SESSION_KEY, f"{owner}:{session_id}".encode(), hashlib.sha256).hexdigest()
    return session_id


class SessionFrameStore:
    """Thread-safe per-session frame storage with auto-expiration."""

    def __init__(self, max_sessions: int = 50, ttl_seconds: float = 1800):
        self._frames: dict[str, tuple[np.ndarray, float]] = {}
        self._lock = threading.Lock()
        self._max_sessions = max_sessions
        self._ttl = ttl_seconds

    def store(self, frame_or_sid, frame: np.ndarray | None = None) -> None:
        # Backward-compatible: store(frame) or store(session_id, frame)
        if frame is None:
            frame = frame_or_sid
            session_id = DEFAULT_SESSION_ID
        else:
            session_id = frame_or_sid
        with self._lock:
            self._evict_expired()
            if len(self._frames) >= self._max_sessions and session_id not in self._frames:
                raise RuntimeError("Too many active sessions")
            self._frames[session_id] = (frame.copy(), time.monotonic())

    def get(self, session_id: str = DEFAULT_SESSION_ID) -> np.ndarray | None:
        with self._lock:
            self._evict_expired()
            entry = self._frames.get(session_id)
            if entry is None:
                return None
            frame, _ = entry
            self._frames[session_id] = (frame, time.monotonic())
            return frame.copy()

    def clear(self, session_id: str = DEFAULT_SESSION_ID) -> None:
        with self._lock:
            self._frames.pop(session_id, None)

    def has_frame(self, session_id: str = DEFAULT_SESSION_ID) -> bool:
        with self._lock:
            return session_id in self._frames

    def _evict_expired(self) -> None:
        now = time.monotonic()
        expired = [k for k, (_, ts) in self._frames.items() if now - ts > self._ttl]
        for k in expired:
            del self._frames[k]
