"""Persistent CalibrationSession store. Location: data/calibration_sessions/{id}.json.

The store is a flat directory of JSON files, one per CalibrationSession.
Each file is written atomically via a sibling ``.tmp`` + rename.

The base directory is resolved at call time (not import time) so that
tests may point the env var ``DEFLECTOMETRY_CAL_DIR`` at a pytest
``tmp_path`` via ``monkeypatch.setenv``.
"""

from __future__ import annotations

import json
import logging
import os
import pathlib

log = logging.getLogger(__name__)

_DEFAULT_DIR = pathlib.Path(__file__).parent.parent / "data" / "calibration_sessions"


def _base_dir() -> pathlib.Path:
    """Resolve the on-disk directory for calibration sessions.

    Reads ``DEFLECTOMETRY_CAL_DIR`` fresh on every call so tests can point
    it at a tmp directory via monkeypatch.
    """
    env = os.environ.get("DEFLECTOMETRY_CAL_DIR")
    if env:
        return pathlib.Path(env)
    return _DEFAULT_DIR


def _ensure_dir() -> pathlib.Path:
    d = _base_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _atomic_write_json(path: pathlib.Path, data: dict) -> None:
    """Write ``data`` as pretty JSON to ``path`` atomically.

    Uses a sibling ``.tmp`` file + ``Path.replace`` so a crashed write
    never corrupts the destination file.
    """
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def _session_path(session_id: str) -> pathlib.Path:
    # Basic filename hygiene — session ids from build_calibration_session
    # are hex uuids, so this is purely defensive against malicious input.
    if not session_id or "/" in session_id or "\\" in session_id or ".." in session_id:
        raise ValueError(f"invalid session_id: {session_id!r}")
    return _base_dir() / f"{session_id}.json"


def save_calibration_session(session: dict) -> None:
    """Atomically persist a CalibrationSession dict to disk."""
    sid = session.get("id")
    if not sid:
        raise ValueError("session dict is missing 'id'")
    _ensure_dir()
    _atomic_write_json(_session_path(sid), session)


def load_calibration_session(session_id: str) -> dict | None:
    """Load a CalibrationSession by id, or return None if missing."""
    path = _session_path(session_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        log.exception("failed to parse CalibrationSession at %s", path)
        return None


def _summarize(session: dict) -> dict:
    """Shrink a session dict to the list-view summary fields."""
    return {
        "id": session.get("id"),
        "rig_fingerprint": session.get("rig_fingerprint"),
        "captured_at": session.get("captured_at"),
        "completeness": session.get("completeness"),
        "notes": session.get("notes", ""),
    }


def _iter_sessions() -> list[dict]:
    d = _base_dir()
    if not d.exists():
        return []
    out: list[dict] = []
    for path in d.iterdir():
        # Skip tmp files and non-JSON detritus.
        if not path.is_file() or path.suffix != ".json" or path.name.startswith("."):
            continue
        try:
            out.append(json.loads(path.read_text()))
        except Exception:
            log.warning("skipping unreadable CalibrationSession at %s", path)
    return out


def list_calibration_sessions(rig_fingerprint: str | None = None) -> list[dict]:
    """Return session summaries, newest first.

    If ``rig_fingerprint`` is supplied, filter to sessions with a matching
    fingerprint; otherwise return all.
    """
    sessions = _iter_sessions()
    if rig_fingerprint is not None:
        sessions = [s for s in sessions if s.get("rig_fingerprint") == rig_fingerprint]
    # Newest first by captured_at (ISO-8601 strings sort lexicographically).
    sessions.sort(key=lambda s: s.get("captured_at") or "", reverse=True)
    return [_summarize(s) for s in sessions]


def delete_calibration_session(session_id: str) -> bool:
    """Delete a session. Returns True if removed, False if it was missing."""
    path = _session_path(session_id)
    if not path.exists():
        return False
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def latest_for_rig(rig_fingerprint: str) -> dict | None:
    """Return the newest complete-enough session for this rig, or None.

    "Complete enough" = display + corner + sphere. Reference flat is not
    required here.
    """
    # Import here to avoid a circular import at module load time.
    from .vision.deflectometry import is_calibration_session_valid

    candidates = [
        s for s in _iter_sessions()
        if s.get("rig_fingerprint") == rig_fingerprint
    ]
    candidates = [s for s in candidates if is_calibration_session_valid(s)[0]]
    if not candidates:
        return None
    candidates.sort(key=lambda s: s.get("captured_at") or "", reverse=True)
    return candidates[0]
