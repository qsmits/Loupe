"""REST API endpoints for reticle presets."""

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

RETICLES_DIR = Path(__file__).parent.parent / "reticles"

router = APIRouter(prefix="/reticles", tags=["reticles"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_path(category: str, name: str) -> Path:
    """
    Resolve a (category, name) pair to an absolute path inside RETICLES_DIR
    and raise 404 if the result escapes the allowed root or is not a .json file.
    """
    # Reject explicit traversal characters before resolution
    for part in (category, name):
        if ".." in part or "/" in part or "\\" in part:
            raise HTTPException(status_code=404, detail="Reticle not found")
    # Strip .json suffix if the caller included it (both "m3" and "m3.json" work)
    if name.endswith(".json"):
        name = name[:-5]
    path = (RETICLES_DIR / category / f"{name}.json").resolve()
    # Confirm the resolved path is still within RETICLES_DIR
    try:
        path.relative_to(RETICLES_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail="Reticle not found")
    if path.suffix != ".json":
        raise HTTPException(status_code=404, detail="Reticle not found")
    return path


def _entry_for(path: Path) -> dict:
    """Return the catalogue entry dict for a reticle file."""
    entry: dict = {"file": path.stem, "name": path.stem, "description": ""}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data.get("name"), str):
            entry["name"] = data["name"]
        if isinstance(data.get("description"), str):
            entry["description"] = data["description"]
    except (json.JSONDecodeError, OSError, UnicodeDecodeError, ValueError):
        pass
    return entry


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
def list_reticles():
    """List all reticles grouped by subdirectory (category)."""
    categories: dict[str, list[dict]] = {}
    if not RETICLES_DIR.exists():
        return {"categories": categories}
    for subdir in sorted(RETICLES_DIR.iterdir()):
        if not subdir.is_dir() or subdir.is_symlink():
            continue
        entries = sorted(
            (_entry_for(f) for f in subdir.glob("*.json") if not f.is_symlink()),
            key=lambda e: e["file"],
        )
        if entries:
            categories[subdir.name] = entries
    return {"categories": categories}


@router.get("/{category}/{name}")
def get_reticle(category: str, name: str):
    """Return the full JSON content of a specific reticle file."""
    path = _safe_path(category, name)
    if not path.exists() or path.is_symlink():
        raise HTTPException(status_code=404, detail="Reticle not found")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        raise HTTPException(status_code=500, detail="Failed to read reticle file")


# POST /reticles/custom removed — reticle export/import is client-side only
