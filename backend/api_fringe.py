"""HTTP API for fringe analysis mode.

Stateless per request: each analysis takes a single image and returns
complete results.  The /reanalyze endpoint accepts cached Zernike
coefficients for instant re-computation when toggling subtraction terms.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import threading
import time
import uuid
from typing import Any, Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator
from typing import Literal

from .cameras.base import BaseCamera
from .image_upload import validate_image_upload
from .compute_pool import fringe_compute
from .session_store import get_session_id_dep
from .vision.fringe import (
    analyze_interferogram,
    average_wavefronts,
    focus_quality,
    rasterize_polygon_mask,
    reanalyze,
    subtract_wavefronts,
    undistort_frame,
    wrap_wavefront_result,
)


# ── Session-scoped fringe cache ───────────────────────────────────────────

# Max analysis dimension for uploaded images (all modes) and for every frame in
# hosted mode (caps memory + CPU per request). A 48 MP phone photo of a flat
# takes minutes through the pipeline and gains nothing: the fringe period is
# hundreds of pixels at that size.
_MAX_ANALYSIS_DIM = 2048

# Seconds between SSE keep-alive comments while an analysis stage runs; the
# client aborts after 30 s (120 s hosted) without receiving any bytes.
_SSE_HEARTBEAT_S = 5.0
_SSE_MAX_WALL_S = 600.0   # hard server-side cap on one analysis stream

# Maximum number of capture summaries retained per session (FIFO; oldest evicted).
# Module-level so tests can monkeypatch.
_CAPTURES_PER_SESSION = 100


def _memory_size(value, seen=None):
    """Count retained Python containers and array backing buffers once."""
    seen = set() if seen is None else seen
    if id(value) in seen:
        return 0
    seen.add(id(value))
    size = sys.getsizeof(value)
    if isinstance(value, np.ndarray):
        return size + (_memory_size(value.base, seen) if value.base is not None else 0)
    if isinstance(value, dict):
        return size + sum(_memory_size(k, seen) + _memory_size(v, seen) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return size + sum(_memory_size(v, seen) for v in value)
    return size


class _FringeCache:
    """Per-session cache for fringe analysis state.

    Stores two kinds of data per session:
    - key/value entries (e.g. ``last_image``, ``last_mask``) via get/put.
    - A FIFO-capped list of lightweight capture summaries appended via
      :meth:`append_capture` and read via :meth:`list_captures`.

    Non-hosted mode uses a single default session for backward compatibility.
    Hosted mode isolates each session and enforces limits.
    """

    def __init__(self, max_sessions: int = 50, ttl_seconds: float = 1800,
                 max_bytes: int = 256 * 1024 * 1024, per_session_bytes: int = 64 * 1024 * 1024):
        # session_id -> (store_dict, captures_list, last_access_monotonic)
        self._data: dict[str, tuple[dict, list, float]] = {}
        # session_id -> {result_id: full_result_dict}
        # Bounded indirectly: full results are evicted alongside their
        # corresponding summary when the captures list is FIFO-trimmed.
        self._full_results: dict[str, dict[str, dict]] = {}
        self._pending_evictions: dict[str, int] = {}
        self._lock = threading.Lock()
        self._max_sessions = max_sessions
        self._ttl = ttl_seconds
        self._max_bytes = max_bytes
        self._per_session_bytes = per_session_bytes

    def get(self, session_id: str, key: str):
        with self._lock:
            self._evict_expired()
            entry = self._data.get(session_id)
            if entry is None:
                return None
            store, _captures, _ = entry
            return store.get(key)

    def put(self, session_id: str, key: str, value):
        with self._lock:
            self._evict_expired()
            self._ensure_session(session_id)
            store, captures, _ = self._data[session_id]
            candidate = {**store, key: value}
            kept, full, evicted = self._fit_history(
                session_id, candidate, captures, self._full_results.get(session_id, {}))
            self._data[session_id] = (candidate, kept, time.monotonic())
            self._full_results[session_id] = full
            self._pending_evictions[session_id] = self._pending_evictions.get(session_id, 0) + evicted

    def append_capture(self, session_id: str, summary: dict) -> None:
        """Append a capture summary to the session's FIFO list.

        Enforces the per-session cap (``_CAPTURES_PER_SESSION``); oldest
        entries are evicted when the list grows beyond the cap.  When a
        summary is evicted, its corresponding full result (if any) is also
        purged so the two stores stay in sync.
        """
        with self._lock:
            self._evict_expired()
            self._ensure_session(session_id)
            store, captures, _ = self._data[session_id]
            self._check_budget(session_id, store, [*captures, summary], self._full_results.get(session_id, {}))
            captures.append(summary)
            # Honor the live module-level cap (tests may monkeypatch).
            cap = _CAPTURES_PER_SESSION
            full_results = self._full_results.setdefault(session_id, {})
            if cap >= 0:
                while len(captures) > cap:
                    evicted = captures.pop(0)
                    eid = evicted.get("id")
                    if eid is not None:
                        full_results.pop(eid, None)
            self._data[session_id] = (store, captures, time.monotonic())

    def put_full_result(self, session_id: str, result_id: str,
                        result: dict) -> None:
        """Store the full analyze result keyed by id for a session.

        Bounded by the captures-list cap: when a summary is evicted the
        matching full result is dropped too (see :meth:`append_capture`).
        """
        with self._lock:
            self._evict_expired()
            self._ensure_session(session_id)
            store, captures, _ = self._data[session_id]
            full = self._full_results.setdefault(session_id, {})
            try:
                self._check_budget(session_id, store, captures, {**full, result_id: result})
            except HTTPException:
                # Do not leave an unreadable summary behind after a rejected new capture.
                if result_id not in full:
                    captures[:] = [c for c in captures if c.get("id") != result_id]
                raise
            full[result_id] = result
            self._data[session_id] = (store, captures, time.monotonic())

    def _fit_history(self, session_id, store, captures, full, *, keep_id=None):
        """Plan FIFO eviction without changing live state if the candidate cannot fit."""
        captures, full = list(captures), dict(full)
        evicted = 0
        while True:
            try:
                self._check_budget(session_id, store, captures, full)
                return captures, full, evicted
            except HTTPException:
                oldest = next((c for c in captures if c.get("id") != keep_id), None)
                if oldest is None:
                    raise
                captures.remove(oldest)
                full.pop(oldest.get("id"), None)
                evicted += 1

    def store_capture(self, session_id: str, summary: dict, result: dict, *, latest=False) -> None:
        """Commit a summary and its full result together, within both FIFO limits.

        Only this session's oldest captures may be retired. A single result
        that cannot fit leaves the existing history intact. No unreadable
        summary is published while its full result is still being admitted.
        """
        with self._lock:
            self._evict_expired()
            self._ensure_session(session_id)
            store, captures, _ = self._data[session_id]
            result_id = summary["id"]
            if latest:
                store = {**store, "last_capture_id": result_id}
            captures = [c for c in captures if c.get("id") != result_id] + [summary]
            full = {**self._full_results.get(session_id, {}), result_id: dict(result)}
            evicted = self._pending_evictions.get(session_id, 0)
            cap = _CAPTURES_PER_SESSION
            while cap >= 0 and len(captures) > cap:
                full.pop(captures.pop(0).get("id"), None)
                evicted += 1
            warning = ("Older session captures were removed to stay within temporary storage limits. "
                       "The current analysis is complete. Export captures you need to keep.")
            while True:
                cached = dict(result)
                if evicted:
                    cached["warnings"] = [*result.get("warnings", []), warning]
                if result_id in full:
                    full[result_id] = cached
                kept, candidate_full, removed = self._fit_history(
                    session_id, store, captures, full, keep_id=result_id)
                captures, full = kept, candidate_full
                evicted += removed
                if not removed:
                    break  # includes the final warning's memory in the budget check
            self._data[session_id] = (store, captures, time.monotonic())
            self._full_results[session_id] = full
            self._pending_evictions.pop(session_id, None)
            if evicted:
                result["warnings"] = cached["warnings"]

    def get_full_result(self, session_id: str,
                        result_id: str) -> dict | None:
        """Return the full result dict for ``result_id`` (or None)."""
        with self._lock:
            self._evict_expired()
            return self._full_results.get(session_id, {}).get(result_id)

    def list_captures(self, session_id: str) -> list[dict]:
        """Return a copy of the captures list (oldest first).

        Each dict is shallow-copied so callers cannot mutate internal state
        through the returned list.
        """
        with self._lock:
            self._evict_expired()
            entry = self._data.get(session_id)
            if entry is None:
                return []
            _store, captures, _ = entry
            return [dict(c) for c in captures]

    def clear_session(self, session_id: str) -> None:
        """Clear ``last_image``, ``last_mask``, captures list, and full results."""
        with self._lock:
            self._evict_expired()
            self._full_results.pop(session_id, None)
            self._pending_evictions.pop(session_id, None)
            entry = self._data.get(session_id)
            if entry is None:
                return
            store, captures, _ = entry
            store.clear()
            captures.clear()
            self._data[session_id] = (store, captures, time.monotonic())

    def _check_budget(self, session_id, store, captures, full):
        candidate = _memory_size((store, captures, full))
        total = candidate + sum(_memory_size((s, c, self._full_results.get(sid, {})))
                                for sid, (s, c, _) in self._data.items() if sid != session_id)
        if candidate > self._per_session_bytes or total > self._max_bytes:
            raise HTTPException(503, "Fringe storage is full; export and clear captures before retrying")

    def _ensure_session(self, session_id: str) -> None:
        if session_id not in self._data:
            if len(self._data) >= self._max_sessions:
                raise RuntimeError("Too many active fringe sessions")
            self._data[session_id] = ({}, [], time.monotonic())
            self._full_results.pop(session_id, None)
            self._pending_evictions.pop(session_id, None)

    def _evict_expired(self):
        now = time.monotonic()
        expired = [k for k, (_, _, ts) in self._data.items() if now - ts > self._ttl]
        for k in expired:
            del self._data[k]
            self._full_results.pop(k, None)
            self._pending_evictions.pop(k, None)


_fringe_cache = _FringeCache()


def _record_capture(session_id: str, result: dict, *, latest=False) -> None:
    """Append a lightweight summary of a wrapped analyze result to the session.

    Called on captures and recorded derived results, including carrier
    overrides. Summary and full result are admitted atomically.
    """
    summary = {
        "analysis_method": result.get("analysis_method"),
        "id": result.get("id"),
        "origin": result.get("origin"),
        "captured_at": result.get("captured_at"),
        "source_ids": list(result.get("source_ids") or []),
        "source_polarities": result.get("source_polarities"),
        "pv_nm": result.get("pv_nm"),
        "rms_nm": result.get("rms_nm"),
        "pv_waves": result.get("pv_waves"),
        "rms_waves": result.get("rms_waves"),
        "pv_fringes": result.get("pv_fringes"),
        "rms_fringes": result.get("rms_fringes"),
        "measurement_model": result.get("measurement_model"),
        "incidence_model": result.get("incidence_model"),
        "height_semantics": result.get("height_semantics"),
        "absolute_sign_known": result.get("absolute_sign_known"),
        "specimen_surface_relative_sign": result.get("specimen_surface_relative_sign"),
        "reference_flat_error_included": result.get("reference_flat_error_included"),
        "wavelength_nm": result.get("wavelength_nm"),
        "n_valid_pixels": result.get("n_valid_pixels"),
        "n_total_pixels": result.get("n_total_pixels"),
        "surface_height": result.get("surface_height"),
        "surface_width": result.get("surface_width"),
        "calibration_snapshot": result.get("calibration_snapshot"),
    }
    _fringe_cache.store_capture(session_id, summary, result, latest=latest)


def _best_gray(image: np.ndarray) -> np.ndarray:
    """Convert color image to grayscale using the highest-contrast channel.

    For monochromatic light sources (sodium, HeNe, green LED), standard
    luminance weighting mixes in noisy channels.  Picking the channel with
    the highest standard deviation preserves fringe contrast.
    """
    if image.ndim != 3:
        return image
    # OpenCV BGR order
    stds = [float(image[:, :, c].std()) for c in range(image.shape[2])]
    best = int(np.argmax(stds))
    return image[:, :, best]


def _cap_image_size(image: np.ndarray, request: Request, *, uploaded: bool,
                    max_dimension: int | None = None) -> np.ndarray:
    """Downsample uploads (and, when hosted, any frame) above the analysis cap.

    Local camera frames stay native unless an explicit method/comparison cap is supplied.
    """
    if max_dimension is None and not uploaded and not getattr(request.app.state, "hosted", False):
        return image
    h, w = image.shape[:2]
    limit = max_dimension or _MAX_ANALYSIS_DIM
    if max(h, w) <= limit:
        return image
    scale = limit / max(h, w)
    new_w = max(1, int(w * scale))
    new_h = max(1, int(h * scale))
    return cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)


def _reject_hosted(request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Not available in hosted mode")


class MaskPolygon(BaseModel):
    vertices: list[tuple[float, float]]
    include: bool = True


class RoiRect(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


class CalibrationSnapshot(BaseModel):
    """Snapshot of the calibration state used for an analysis.

    M1.1: accepts arbitrary fields (extra='allow') so the client can send
    whatever it has. M1.2 will tighten the schema to the canonical fields
    (mm_per_pixel, captured_at, method, wavelength_nm, …).
    """
    model_config = {"extra": "allow"}
    # 0 is the explicit "uncalibrated" sentinel; negatives are still invalid.
    mm_per_pixel: Optional[float] = Field(default=None, ge=0)
    captured_at: Optional[str] = None
    method: Optional[str] = None
    wavelength_nm: Optional[float] = Field(default=None, gt=0)


class ApertureRecipe(BaseModel):
    """Geometry recipe used to build the analysis mask.

    M1.1: opaque pass-through (extra='allow'). M1.4 formalizes the shape
    (circle/polygon/ring) and adds validation + an id field.
    """
    model_config = {"extra": "allow"}
    id: Optional[str] = None
    kind: Optional[str] = None


class AnalyzeBody(BaseModel):
    analysis_method: str = Field(default="current", pattern="^(current|hybrid|composite)$")
    reconstructed_preview: bool = False
    analysis_max_dimension: Literal[1024] | None = None
    wavelength_nm: float = Field(default=589.3, gt=0, le=2000)
    mask_threshold: float = Field(default=0.30, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    image_b64: Optional[str] = Field(default=None)
    roi: Optional[RoiRect] = Field(default=None)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)
    form_model: str = Field(default="plane", pattern="^(zernike|plane|poly2|poly3)$")
    lens_k1: float = Field(default=0.0, ge=-2.0, le=2.0)
    correct_2pi_jumps: bool = Field(default=True)
    calibration: Optional[CalibrationSnapshot] = Field(default=None)
    aperture_recipe: Optional[ApertureRecipe] = Field(default=None)
    # M2.5 — user-tunable DFT parameters. None = optical-flat auto default.
    lpf_sigma_frac: Optional[float] = Field(default=None, gt=0, le=5.0)
    dc_margin_override: Optional[int] = Field(default=None, ge=0, le=32)
    # M2.1 — exponential DC high-pass cutoff (FFT bins). Default 1.5 matches
    # legacy dc_margin=2 sensitivity with a smooth ramp instead of a cliff.
    dc_cutoff_cycles: float = Field(default=1.5, ge=0.0, le=32.0)


class ReanalyzeBody(BaseModel):
    coefficients: list[FiniteFloat] = Field(max_length=66)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    wavelength_nm: float = Field(default=589.3, gt=0, le=2000)
    surface_height: int = Field(gt=0, le=16384)
    surface_width: int = Field(gt=0, le=16384)
    mask: Optional[list[int]] = Field(default=None, max_length=1024 * 1024)
    n_zernike: int = Field(default=36, ge=1, le=66)
    form_model: str = Field(default="zernike", pattern="^(zernike|plane|poly2|poly3)$")
    # M1.3 raw-grid path: when all three are provided, reanalyze operates
    # on the cached pre-form-removal heightmap instead of reconstructing
    # from Zernike coefficients alone.
    raw_height_grid_nm: Optional[list[FiniteFloat]] = Field(default=None, max_length=256 * 256)
    raw_wavelength_nm: Optional[float] = Field(default=None, gt=0, le=2000)
    raw_grid_rows: Optional[int] = Field(default=None, gt=0, le=256)
    raw_grid_cols: Optional[int] = Field(default=None, gt=0, le=256)

    @model_validator(mode="after")
    def bounded_grid(self):
        supplied = [self.raw_height_grid_nm is not None,
                    self.raw_grid_rows is not None, self.raw_grid_cols is not None]
        surface_pixels = self.surface_height * self.surface_width
        if any(supplied) and not all(supplied):
            raise ValueError("Raw grid values, rows and columns must be provided together")
        if all(supplied):
            pixels = self.raw_grid_rows * self.raw_grid_cols
            if len(self.raw_height_grid_nm) != pixels:
                raise ValueError("Raw grid length does not match its dimensions")
        else:
            pixels = surface_pixels
            if pixels > 1024 * 1024:
                raise ValueError("Coefficient reconstruction is limited to 1048576 pixels; supply the raw grid")
        if self.mask is not None and len(self.mask) not in (pixels, surface_pixels):
            raise ValueError("Mask length does not match the grid or surface")
        return self


class ReanalyzeCarrierBody(BaseModel):
    analysis_method: str = Field(default="current", pattern="^(current|hybrid|composite)$")
    reconstructed_preview: bool = False
    analysis_max_dimension: Literal[1024] | None = None
    form_model: str = Field(default="plane", pattern="^(zernike|plane|poly2|poly3)$")
    carrier_y: float
    carrier_x: float
    image_b64: Optional[str] = Field(default=None)
    wavelength_nm: float = Field(default=589.3, gt=0, le=2000)
    mask_threshold: float = Field(default=0.30, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)
    lens_k1: float = Field(default=0.0, ge=-2.0, le=2.0)
    correct_2pi_jumps: bool = Field(default=True)
    calibration: Optional[CalibrationSnapshot] = Field(default=None)
    aperture_recipe: Optional[ApertureRecipe] = Field(default=None)
    # M2.5 — user-tunable DFT parameters. None = optical-flat auto default.
    lpf_sigma_frac: Optional[float] = Field(default=None, gt=0, le=5.0)
    dc_margin_override: Optional[int] = Field(default=None, ge=0, le=32)
    # M2.1 — exponential DC high-pass cutoff (FFT bins). Default 1.5.
    dc_cutoff_cycles: float = Field(default=1.5, ge=0.0, le=32.0)


class SubtractBody(BaseModel):
    # Silence the "register shadows BaseModel.register" warning.  The field
    # name is part of the public API contract (M3.5 spec).
    model_config = ConfigDict(protected_namespaces=())

    measurement_id: str
    reference_id: str
    wavelength_nm: Optional[float] = Field(default=None, gt=0)
    # M3.5 — when True (default), apply sub-pixel registration before
    # subtraction. Set False to use the pixel-aligned M3.4 behavior.
    register: bool = True
    reference_polarity: Optional[Literal[-1, 1]] = None


class AverageBody(BaseModel):
    source_ids: list[str] = Field(..., min_length=2)
    wavelength_nm: Optional[float] = Field(default=None, gt=0)
    rejection: Literal["none", "sigma", "mad"] = "none"
    rejection_threshold: float = Field(default=3.0, gt=0, le=10)
    source_polarities: Optional[list[Literal[-1, 1]]] = None
    # Task 9: the frontend's running-average widget recomputes on every
    # capture add/toggle -- a live preview, not a save. Recording each of
    # those recomputes as a new capture let ~51 averaged frames push past
    # _CAPTURES_PER_SESSION, evicting the very source captures the next
    # recompute needed and 404ing on itself. Explicit "save this average"
    # flows (the Session tab's multi-select average, and chained averaging)
    # leave this at the default True so the result stays resolvable by id.
    record: bool = True


def _resolve_request_wavelength(body: BaseModel) -> tuple[float, str | None]:
    """Resolve wavelength without allowing computation/metadata mismatch."""
    wavelength = float(getattr(body, "wavelength_nm"))
    calibration = getattr(body, "calibration", None)
    calibration_wavelength = getattr(calibration, "wavelength_nm", None)
    explicitly_sent = "wavelength_nm" in body.model_fields_set
    if calibration_wavelength is not None:
        calibration_wavelength = float(calibration_wavelength)
        if explicitly_sent and abs(wavelength - calibration_wavelength) > 1e-9:
            raise HTTPException(
                400,
                detail=(
                    "wavelength_nm disagrees with calibration.wavelength_nm; "
                    "send one consistent physical wavelength"
                ),
            )
        if not explicitly_sent:
            wavelength = calibration_wavelength
            setattr(body, "wavelength_nm", wavelength)
            return wavelength, None
    if not explicitly_sent:
        return wavelength, (
            f"Wavelength omitted; assumed {wavelength:.1f} nm. "
            "Set the calibrated source wavelength for quantitative results."
        )
    return wavelength, None


def _applied_calibration_snapshot(body: BaseModel, resolution=None) -> dict | None:
    """Return provenance synchronized to the parameters actually applied."""
    calibration = getattr(body, "calibration", None)
    if calibration is None:
        return None
    snapshot = calibration.model_dump()
    snapshot["wavelength_nm"] = float(getattr(body, "wavelength_nm"))
    if hasattr(body, "lens_k1"):
        snapshot["lens_k1"] = float(getattr(body, "lens_k1"))
    if resolution and snapshot.get("mm_per_pixel") and resolution['original'] != resolution['analyzed']:
        snapshot['input_mm_per_pixel'] = snapshot['mm_per_pixel']
        snapshot['mm_per_pixel'] *= max(resolution['original']) / max(resolution['analyzed'])
    return snapshot


def _resize_analysis_frame(image, body, request, *, uploaded, original_shape=None):
    """Resize once before lens correction/masks; retain full-frame scale provenance."""
    local_fit = body.analysis_method in ('hybrid', 'composite')
    limit = 1024 if local_fit else body.analysis_max_dimension
    original = list(original_shape if original_shape is not None else image.shape[:2])
    image = _cap_image_size(image, request, uploaded=uploaded, max_dimension=limit)
    cap = limit or (_MAX_ANALYSIS_DIM if uploaded or getattr(request.app.state, 'hosted', False) else None)
    return image, dict(original=original, analyzed=list(image.shape[:2]), max_dimension=cap)


def _record_resolution(result, resolution):
    result['server_resolution'] = resolution
    if resolution['original'] != resolution['analyzed']:
        h, w = resolution['original']; ah, aw = resolution['analyzed']
        result.setdefault('warnings', []).append(
            f'Server analysis resized {w}×{h} to {aw}×{ah} pixels before lens correction and area selection. '
            'Fine surface detail may be attenuated.')


# M3.7 — Capture export/import
_CAPTURE_EXPORT_VERSION = 1

# Required fields on an imported capture body.  Wider validation is left
# to downstream consumers; we only enforce the minimum needed for the
# session list + grid renderers to function.
_IMPORT_REQUIRED_FIELDS = (
    "id",
    "origin",
    "raw_height_grid_nm",
    "display_height_grid_nm",
    "grid_rows",
    "grid_cols",
    "mask_grid",
    "wavelength_nm",
)


class ImportBody(BaseModel):
    """Body for /fringe/session/import.

    `result` is a previously exported capture dict (the value returned by
    /fringe/session/capture/{id}).  Validation is intentionally minimal —
    any extra fields round-trip untouched.
    """
    model_config = {"extra": "allow"}
    result: dict[str, Any]


def _prepare_fringe_image(image: np.ndarray, body: BaseModel,
                          roi=None) -> tuple[np.ndarray, np.ndarray | None, bool]:
    """Correct camera geometry in the full-frame domain BEFORE any ROI crop.

    Polygon coordinates refer to the corrected preview. Cache callers keep
    the raw full frame separately, so carrier reanalysis can repeat this
    transform exactly once, including when k1 changes.
    """
    if body.lens_k1:
        image = undistort_frame(image.astype(np.float64), body.lens_k1)
    roi = roi if roi is not None else getattr(body, "roi", None)
    cropped = False
    if roi is not None and not body.mask_polygons:
        ih, iw = image.shape[:2]
        x0, y0 = int(roi.x * iw), int(roi.y * ih)
        x1 = min(int((roi.x + roi.w) * iw), iw)
        y1 = min(int((roi.y + roi.h) * ih), ih)
        if x1 - x0 > 10 and y1 - y0 > 10:
            image = image[y0:y1, x0:x1]
            cropped = True
    custom_mask = None
    if body.mask_polygons:
        custom_mask = rasterize_polygon_mask(
            [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
            *image.shape[:2],
        )
    return image, custom_mask, cropped


def make_fringe_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()

    @router.post("/fringe/analyze")
    async def fringe_analyze(body: AnalyzeBody, request: Request,
                             session_id: str = Depends(get_session_id_dep)):
        """Run the full fringe analysis pipeline.

        Accepts either:
        - image_b64: base64-encoded image (drag-drop or file upload)
        - No image: uses the current frozen camera frame
        """
        _, wavelength_warning = _resolve_request_wavelength(body)
        if body.image_b64:
            # Decode uploaded image
            try:
                img_bytes = base64.b64decode(body.image_b64)
                validate_image_upload(img_bytes, getattr(request.app.state, "hosted", False))
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("Could not decode image")
                image = _best_gray(image)
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(400, detail=f"Invalid image: {e}")
        else:
            # Use camera frame
            frame = camera.get_frame()
            if frame is None:
                raise HTTPException(503, detail="Camera returned no frame")
            image = frame
            if image.ndim == 3:
                image = _best_gray(image)

        image, resolution = _resize_analysis_frame(image, body, request, uploaded=bool(body.image_b64))

        _fringe_cache.put(session_id, "last_image", image.copy())
        _fringe_cache.put(session_id, "last_resolution", resolution)
        _fringe_cache.put(session_id, "last_roi", body.roi if not body.mask_polygons else None)
        image, custom_mask, cropped = _prepare_fringe_image(image, body)

        try:
            result = await fringe_compute.run(analyze_interferogram,
                image,
                wavelength_nm=body.wavelength_nm,
                mask_threshold=body.mask_threshold,
                subtract_terms=body.subtract_terms,
                n_zernike=body.n_zernike,
                use_full_mask=cropped,
                custom_mask=custom_mask,
                form_model=body.form_model,
                lens_k1=body.lens_k1,
                image_is_undistorted=True,
                correct_2pi_jumps=body.correct_2pi_jumps,
                analysis_method=body.analysis_method,
                reconstructed_preview=body.reconstructed_preview,
                lpf_sigma_frac=body.lpf_sigma_frac,
                dc_margin_override=body.dc_margin_override,
                dc_cutoff_cycles=body.dc_cutoff_cycles,
            )
        except ValueError as exc:
            raise HTTPException(422, detail=str(exc)) from exc
        # Cache full-res mask for reanalyze/invert (mask_grid is downsampled)
        if "_mask_full" in result:
            _fringe_cache.put(session_id, "last_mask", result.pop("_mask_full"))
        _record_resolution(result, resolution)
        wrap_wavefront_result(
            result,
            origin="capture",
            calibration=_applied_calibration_snapshot(body, resolution),
            aperture_recipe=body.aperture_recipe.model_dump() if body.aperture_recipe else None,
        )
        if wavelength_warning:
            result["warnings"].append(wavelength_warning)
        # M2.5 + M2.1: echo applied tuning so the UI can display server-resolved
        # values (including the new dc_cutoff_cycles knob).
        result["tuning"] = {
            "mask_threshold": body.mask_threshold,
            "lpf_sigma_frac": body.lpf_sigma_frac,
            "dc_margin_override": body.dc_margin_override,
            "dc_cutoff_cycles": body.dc_cutoff_cycles,
        }
        _record_capture(session_id, result, latest=True)
        return result

    @router.post("/fringe/analyze-stream")
    async def fringe_analyze_stream(body: AnalyzeBody, request: Request,
                                    session_id: str = Depends(get_session_id_dep)):
        """Run the full fringe analysis pipeline with SSE progress events.

        Returns a text/event-stream where each event is a JSON object.
        Progress events: {"stage": str, "progress": float, "message": str}
        Final event:     {"stage": "done", "progress": 1.0, "result": {...}}
        Error event:     {"stage": "error", "message": str}
        """
        _, wavelength_warning = _resolve_request_wavelength(body)
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        # Decode image before starting the stream so we can emit error events
        # inside the stream rather than returning an HTTP error.
        if body.image_b64:
            try:
                img_bytes = base64.b64decode(body.image_b64)
                validate_image_upload(img_bytes, getattr(request.app.state, "hosted", False))
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("Could not decode image")
                image = _best_gray(image)
            except HTTPException:
                raise
            except Exception as e:
                err_msg = str(e)
                async def _error_stream(msg=err_msg):
                    yield f"data: {json.dumps({'stage': 'error', 'message': msg})}\n\n"
                return StreamingResponse(_error_stream(), media_type="text/event-stream")
        else:
            frame = camera.get_frame()
            if frame is None:
                async def _error_stream():
                    yield f"data: {json.dumps({'stage': 'error', 'message': 'Camera returned no frame'})}\n\n"
                return StreamingResponse(_error_stream(), media_type="text/event-stream")
            image = frame
            if image.ndim == 3:
                image = _best_gray(image)

        image, resolution = _resize_analysis_frame(image, body, request, uploaded=bool(body.image_b64))

        _fringe_cache.put(session_id, "last_image", image.copy())
        _fringe_cache.put(session_id, "last_resolution", resolution)
        _fringe_cache.put(session_id, "last_roi", body.roi if not body.mask_polygons else None)
        image, custom_mask, cropped = _prepare_fringe_image(image, body)
        # Capture session_id for use inside the closure
        sid = session_id

        def _on_progress(stage: str, progress: float, message: str) -> None:
            event = {"stage": stage, "progress": progress, "message": message}
            loop.call_soon_threadsafe(queue.put_nowait, event)

        job = fringe_compute.submit(
            analyze_interferogram,
            image,
            wavelength_nm=body.wavelength_nm,
            mask_threshold=body.mask_threshold,
            subtract_terms=body.subtract_terms,
            n_zernike=body.n_zernike,
            use_full_mask=cropped,
            custom_mask=custom_mask,
            on_progress=_on_progress,
            form_model=body.form_model,
            lens_k1=body.lens_k1,
            image_is_undistorted=True,
            correct_2pi_jumps=body.correct_2pi_jumps,
            analysis_method=body.analysis_method,
            reconstructed_preview=body.reconstructed_preview,
            lpf_sigma_frac=body.lpf_sigma_frac,
            dc_margin_override=body.dc_margin_override,
            dc_cutoff_cycles=body.dc_cutoff_cycles,
        )

        async def _run_analysis():
            try:
                result = await asyncio.wrap_future(job)
                # Cache full-res mask before sending result to client
                if "_mask_full" in result:
                    _fringe_cache.put(sid, "last_mask", result.pop("_mask_full"))
                _record_resolution(result, resolution)
                wrap_wavefront_result(
                    result,
                    origin="capture",
                    calibration=_applied_calibration_snapshot(body, resolution),
                    aperture_recipe=body.aperture_recipe.model_dump() if body.aperture_recipe else None,
                )
                if wavelength_warning:
                    result["warnings"].append(wavelength_warning)
                # M2.5 + M2.1: echo applied tuning so the UI can display server-resolved values.
                result["tuning"] = {
                    "mask_threshold": body.mask_threshold,
                    "lpf_sigma_frac": body.lpf_sigma_frac,
                    "dc_margin_override": body.dc_margin_override,
                    "dc_cutoff_cycles": body.dc_cutoff_cycles,
                }
                _record_capture(sid, result, latest=True)
                await queue.put({"stage": "done", "progress": 1.0, "result": result})
            except Exception as exc:
                await queue.put({"stage": "error", "message": str(exc)})

        async def _event_stream():
            task = asyncio.ensure_future(_run_analysis())
            started = time.monotonic()
            try:
                while True:
                    if time.monotonic() - started > _SSE_MAX_WALL_S:
                        job.cancel()  # best effort: a running worker cannot be interrupted
                        task.cancel()
                        yield ("data: " + json.dumps({
                            "stage": "error",
                            "message": f"Analysis exceeded {_SSE_MAX_WALL_S:.0f} s and was stopped",
                        }) + "\n\n")
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), _SSE_HEARTBEAT_S)
                    except asyncio.TimeoutError:
                        # SSE comment: ignored by the client's parser, but it
                        # resets the inactivity timer during long stages.
                        yield ": keepalive\n\n"
                        continue
                    yield f"data: {json.dumps(event)}\n\n"
                    if event.get("stage") in ("done", "error"):
                        break
            finally:
                task.cancel()

        return StreamingResponse(_event_stream(), media_type="text/event-stream")

    @router.post("/fringe/reanalyze")
    async def fringe_reanalyze(body: ReanalyzeBody,
                               session_id: str = Depends(get_session_id_dep)):
        """Re-analyze with different Zernike subtraction (no FFT, fast)."""
        _, wavelength_warning = _resolve_request_wavelength(body)
        mask = body.mask
        if mask is None:
            mask = _fringe_cache.get(session_id, "last_mask")
        result = await fringe_compute.run(reanalyze,
            coefficients=body.coefficients,
            subtract_terms=body.subtract_terms,
            wavelength_nm=body.wavelength_nm,
            surface_shape=(body.surface_height, body.surface_width),
            mask_serialized=mask,
            n_zernike=body.n_zernike,
            form_model=body.form_model,
            raw_height_grid_nm=body.raw_height_grid_nm,
            raw_wavelength_nm=body.raw_wavelength_nm,
            raw_grid_rows=body.raw_grid_rows,
            raw_grid_cols=body.raw_grid_cols,
        )
        if wavelength_warning:
            result.setdefault("warnings", []).append(wavelength_warning)
        return result

    @router.get("/fringe/focus-quality", dependencies=[Depends(_reject_hosted)])  # camera-only
    async def fringe_focus_quality():
        """Return the focus quality score of the current camera frame."""
        frame = camera.get_frame()
        if frame is None:
            raise HTTPException(503, detail="Camera returned no frame")
        score = focus_quality(frame)
        return {"score": score}

    @router.post("/fringe/reanalyze-carrier")
    async def fringe_reanalyze_carrier(body: ReanalyzeCarrierBody, request: Request,
                                       session_id: str = Depends(get_session_id_dep)):
        """Re-analyze with a manually selected carrier peak."""
        _, wavelength_warning = _resolve_request_wavelength(body)
        if body.image_b64:
            try:
                img_bytes = base64.b64decode(body.image_b64)
                validate_image_upload(img_bytes, getattr(request.app.state, "hosted", False))
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("Could not decode image")
                image = _best_gray(image)
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(400, detail=f"Invalid image: {e}")
        else:
            cached = _fringe_cache.get(session_id, "last_image")
            if cached is not None:
                image = cached
            else:
                raise HTTPException(400, detail="No cached image. Run /fringe/analyze first or provide image_b64.")

        previous_resolution = None if body.image_b64 else _fringe_cache.get(session_id, "last_resolution")
        image, resolution = _resize_analysis_frame(image, body, request, uploaded=bool(body.image_b64),
            original_shape=previous_resolution['original'] if previous_resolution else None)
        cached_roi = None if body.image_b64 else _fringe_cache.get(session_id, "last_roi")
        image, custom_mask, cropped = _prepare_fringe_image(image, body, cached_roi)

        try:
            result = await fringe_compute.run(analyze_interferogram,
                image,
                wavelength_nm=body.wavelength_nm,
                mask_threshold=body.mask_threshold,
                subtract_terms=body.subtract_terms,
                n_zernike=body.n_zernike,
                custom_mask=custom_mask,
                use_full_mask=cropped,
                carrier_override=(body.carrier_y, body.carrier_x),
                form_model=body.form_model,
                lens_k1=body.lens_k1,
                image_is_undistorted=True,
                correct_2pi_jumps=body.correct_2pi_jumps,
                analysis_method=body.analysis_method,
                reconstructed_preview=body.reconstructed_preview,
                lpf_sigma_frac=body.lpf_sigma_frac,
                dc_margin_override=body.dc_margin_override,
                dc_cutoff_cycles=body.dc_cutoff_cycles,
            )
        except ValueError as exc:
            raise HTTPException(422, detail=str(exc)) from exc
        if "_mask_full" in result:
            _fringe_cache.put(session_id, "last_mask", result.pop("_mask_full"))
        # Fix 2: link the override back to the most recent cached capture
        # when the image came from the session cache. When the user uploaded
        # a fresh image_b64 the cached `last_image` may not match it, so
        # leave source_ids empty in that case to avoid lying about provenance.
        source_ids: list[str] = []
        if not body.image_b64:
            last_capture_id = _fringe_cache.get(session_id, "last_capture_id")
            if last_capture_id:
                source_ids = [last_capture_id]
        _record_resolution(result, resolution)
        wrap_wavefront_result(
            result,
            origin="capture",
            calibration=_applied_calibration_snapshot(body, resolution),
            aperture_recipe=body.aperture_recipe.model_dump() if body.aperture_recipe else None,
            source_ids=source_ids,
        )
        if wavelength_warning:
            result["warnings"].append(wavelength_warning)
        # M2.5 + M2.1: echo applied tuning so the UI can display server-resolved values.
        result["tuning"] = {
            "mask_threshold": body.mask_threshold,
            "lpf_sigma_frac": body.lpf_sigma_frac,
            "dc_margin_override": body.dc_margin_override,
            "dc_cutoff_cycles": body.dc_cutoff_cycles,
        }
        # Fix 3 (Open Q 1): record the manually-carrier reanalysis as a
        # first-class capture so the user can export it and chain it into
        # subtract/average. source_ids preserves provenance when the override
        # was applied to a cached capture; captured_at distinguishes it from
        # the prior analyze.
        _record_capture(session_id, result)
        return result

    @router.post("/fringe/subtract")
    async def fringe_subtract(body: SubtractBody, request: Request,
                              session_id: str = Depends(get_session_id_dep)):
        """Subtract two in-session captures with optional sub-pixel registration.

        See :func:`backend.vision.fringe.subtract_wavefronts`.  Both inputs
        must already exist in the session's capture cache.  Returns the full
        wrapped subtracted result and records it as a new capture so it can
        be chained into further subtractions.
        """
        measurement = _fringe_cache.get_full_result(session_id, body.measurement_id)
        reference = _fringe_cache.get_full_result(session_id, body.reference_id)
        if measurement is None:
            raise HTTPException(404, detail=f"Unknown measurement_id: {body.measurement_id}")
        if reference is None:
            raise HTTPException(404, detail=f"Unknown reference_id: {body.reference_id}")
        hosted_flag = bool(getattr(request.app.state, "hosted", False))
        try:
            result = await fringe_compute.run(subtract_wavefronts,
                measurement, reference,
                wavelength_nm=body.wavelength_nm,
                register=bool(body.register),
                hosted=hosted_flag,
                reference_polarity=body.reference_polarity,
            )
        except ValueError as exc:
            raise HTTPException(400, detail=str(exc))
        # Fix 4 (P2a): surface metrologically suspicious origin combos as
        # warnings (not hard blocks). These append to the wrapped result's
        # warnings list so the UI banner picks them up.
        origin_warnings: list[str] = []
        m_origin = measurement.get("origin")
        r_origin = reference.get("origin")
        if m_origin == "subtracted" or r_origin == "subtracted":
            origin_warnings.append(
                "Subtracting a subtracted wavefront — result is a "
                "second-order difference; interpretation depends on the "
                "original chain."
            )
        if r_origin == "average":
            origin_warnings.append(
                "Reference is an average — ensure it represents the "
                "intended systematic (e.g., flat-only, not sample-included)."
            )
        if origin_warnings:
            existing = result.get("warnings") or []
            result["warnings"] = list(existing) + origin_warnings
        _record_capture(session_id, result)
        return result

    @router.post("/fringe/average")
    async def fringe_average(body: AverageBody,
                             session_id: str = Depends(get_session_id_dep)):
        """Average multiple in-session captures (pixel-aligned, no registration).

        See :func:`backend.vision.fringe.average_wavefronts`.  All inputs must
        already exist in the session's capture cache.  Returns the full wrapped
        averaged result.  When ``body.record`` is True (the default), also
        records it as a new capture so it can be chained into further
        averages or subtractions.  The frontend's running-average widget
        passes ``record=False`` for its live-preview recomputes (Task 9) so
        that toggling captures in/out doesn't consume FIFO capture slots.
        """
        sources: list[dict] = []
        for sid in body.source_ids:
            r = _fringe_cache.get_full_result(session_id, sid)
            if r is None:
                raise HTTPException(404, detail=f"Unknown source_id: {sid}")
            sources.append(r)
        try:
            result = await fringe_compute.run(average_wavefronts,
                sources,
                wavelength_nm=body.wavelength_nm,
                rejection=body.rejection,
                rejection_threshold=body.rejection_threshold,
                source_polarities=body.source_polarities,
            )
        except ValueError as exc:
            raise HTTPException(400, detail=str(exc))
        # Fix 4 (P2a): warn when averaging includes derived wavefronts.
        non_capture_origins = sorted({
            (s.get("origin") or "capture") for s in sources
            if (s.get("origin") or "capture") != "capture"
        })
        if non_capture_origins:
            existing = result.get("warnings") or []
            result["warnings"] = list(existing) + [
                f"Averaging includes non-capture origins "
                f"({', '.join(non_capture_origins)}) — derived wavefronts "
                f"inherit any residual errors from their sources."
            ]
        if body.record:
            _record_capture(session_id, result)
        return result

    @router.get("/fringe/session/captures")
    async def fringe_session_captures(session_id: str = Depends(get_session_id_dep)):
        """Return the per-session capture summaries (oldest first)."""
        return {"captures": _fringe_cache.list_captures(session_id)}

    @router.get("/fringe/session/capture/{capture_id}")
    async def fringe_capture_export(capture_id: str,
                                    session_id: str = Depends(get_session_id_dep)):
        """Full JSON export of a single capture, including grids.

        Returns the cached WavefrontResult dict with an extra
        ``_export_version`` field for forward-compatible imports.  404 if
        the capture id is unknown for this session.
        """
        full = _fringe_cache.get_full_result(session_id, capture_id)
        if full is None:
            raise HTTPException(404, detail=f"Unknown capture_id: {capture_id}")
        out = dict(full)
        out["_export_version"] = _CAPTURE_EXPORT_VERSION
        return out

    @router.post("/fringe/session/import")
    async def fringe_capture_import(body: ImportBody,
                                    session_id: str = Depends(get_session_id_dep)):
        """Import a previously-exported WavefrontResult into the current session.

        Generates a fresh id so imports never collide with existing
        captures in the session; the original id is preserved on the
        ``imported_from_id`` field.  Lightweight shape validation only.
        """
        result = body.result
        if not isinstance(result, dict):
            raise HTTPException(400, detail="result must be an object")

        version = result.get("_export_version")
        if version is not None and version != _CAPTURE_EXPORT_VERSION:
            raise HTTPException(
                400,
                detail=f"Unsupported _export_version: {version} "
                       f"(expected {_CAPTURE_EXPORT_VERSION})",
            )

        missing = [k for k in _IMPORT_REQUIRED_FIELDS if k not in result]
        if missing:
            raise HTTPException(
                400, detail=f"Missing required fields: {', '.join(missing)}",
            )

        rows = result.get("grid_rows")
        cols = result.get("grid_cols")
        if not isinstance(rows, int) or not isinstance(cols, int) \
                or rows <= 0 or cols <= 0:
            raise HTTPException(400, detail="grid_rows/grid_cols must be positive ints")
        expected_len = rows * cols

        # Memory safety: every grid-shaped field must match grid_rows*grid_cols.
        for grid_key in ("raw_height_grid_nm", "display_height_grid_nm",
                         "mask_grid", "raw_mask_grid", "height_grid",
                         "trusted_mask_grid"):
            grid = result.get(grid_key)
            if grid is None:
                continue
            if not isinstance(grid, list):
                raise HTTPException(
                    400, detail=f"{grid_key} must be a list",
                )
            if len(grid) != expected_len:
                raise HTTPException(
                    400,
                    detail=f"{grid_key} length {len(grid)} does not match "
                           f"grid_rows*grid_cols ({expected_len})",
                )

        # Mint a fresh id; remember the original on `imported_from_id`.
        new = dict(result)
        new.pop("_export_version", None)
        original_id = new.get("id")
        new["imported_from_id"] = original_id
        new["id"] = uuid.uuid4().hex
        # Origin is preserved from the export (subtracted/average/capture).

        _record_capture(session_id, new)
        return new

    @router.post("/fringe/session/clear")
    async def fringe_session_clear(session_id: str = Depends(get_session_id_dep)):
        """Clear last_image, last_mask, and captures list for the session."""
        _fringe_cache.clear_session(session_id)
        return {"cleared": True}

    return router
