"""Per-session frame storage for multi-user hosted mode."""
import re
import threading
import time

import numpy as np
from fastapi import Request, HTTPException

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DEFAULT_SESSION_ID = "_default"


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
