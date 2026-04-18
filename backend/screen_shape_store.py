"""Persistent ScreenShape store. Location: data/screen_shape.json.

Only one ScreenShape is "active" at a time — unlike CalibrationSessions which
are keyed by id. Rationale: the screen shape only changes when the iPad is
physically recalibrated, so we don't need per-session history. Additional
shapes can still be saved to alternate paths by callers that want to keep
backups.

The base path is resolved at call time (not import time) so tests may point
``DEFLECTOMETRY_SCREEN_SHAPE_PATH`` at a pytest ``tmp_path`` via
``monkeypatch.setenv``.
"""

from __future__ import annotations

import json
import logging
import os
import pathlib

from .vision.screen_shape import ScreenShape

log = logging.getLogger(__name__)

_DEFAULT_PATH = (
    pathlib.Path(__file__).parent.parent / "data" / "screen_shape.json"
)


def default_screen_shape_path() -> pathlib.Path:
    """Resolve the on-disk path for the active screen shape.

    Reads ``DEFLECTOMETRY_SCREEN_SHAPE_PATH`` fresh on every call so tests
    can point it at a tmp path via ``monkeypatch.setenv``.
    """
    env = os.environ.get("DEFLECTOMETRY_SCREEN_SHAPE_PATH")
    if env:
        return pathlib.Path(env)
    return _DEFAULT_PATH


def _atomic_write_json(path: pathlib.Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def save_screen_shape(
    shape: ScreenShape, path: str | os.PathLike | None = None
) -> str:
    """Atomically persist a ScreenShape to disk.

    Parameters
    ----------
    shape : ScreenShape instance (Rectangular2DShape or Distorted2DShape).
    path : optional override; defaults to :func:`default_screen_shape_path`.

    Returns
    -------
    The absolute path written, as a string.
    """
    target = pathlib.Path(path) if path is not None else default_screen_shape_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(target, shape.as_dict())
    return str(target)


def load_screen_shape(
    path: str | os.PathLike | None = None,
) -> ScreenShape | None:
    """Load the active ScreenShape from disk, or return None if missing.

    Returns None if the file doesn't exist OR if it fails to parse (with a
    logged exception) — callers should treat both as "no calibration yet".
    """
    target = pathlib.Path(path) if path is not None else default_screen_shape_path()
    if not target.exists():
        return None
    try:
        data = json.loads(target.read_text())
    except Exception:
        log.exception("failed to parse ScreenShape at %s", target)
        return None
    try:
        return ScreenShape.from_dict(data)
    except Exception:
        log.exception("failed to reconstruct ScreenShape from %s", target)
        return None


def delete_screen_shape(path: str | os.PathLike | None = None) -> bool:
    """Remove the saved ScreenShape. Returns True if removed, False if absent."""
    target = pathlib.Path(path) if path is not None else default_screen_shape_path()
    if not target.exists():
        return False
    try:
        target.unlink()
        return True
    except FileNotFoundError:
        return False
