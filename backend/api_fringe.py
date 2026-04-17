"""HTTP API for fringe analysis mode.

Stateless per request: each analysis takes a single image and returns
complete results.  The /reanalyze endpoint accepts cached Zernike
coefficients for instant re-computation when toggling subtraction terms.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time
import uuid
from typing import Any, Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from .cameras.base import BaseCamera
from .session_store import get_session_id_dep
from .vision.fringe import (
    analyze_interferogram,
    average_wavefronts,
    focus_quality,
    rasterize_polygon_mask,
    reanalyze,
    subtract_wavefronts,
    wrap_wavefront_result,
)


# ── Session-scoped fringe cache ───────────────────────────────────────────

# Max image dimension in hosted mode (caps memory + CPU per request)
_HOSTED_MAX_DIM = 2048

# Maximum number of capture summaries retained per session (FIFO; oldest evicted).
# Module-level so tests can monkeypatch.
_CAPTURES_PER_SESSION = 100


class _FringeCache:
    """Per-session cache for fringe analysis state.

    Stores two kinds of data per session:
    - key/value entries (e.g. ``last_image``, ``last_mask``) via get/put.
    - A FIFO-capped list of lightweight capture summaries appended via
      :meth:`append_capture` and read via :meth:`list_captures`.

    Non-hosted mode uses a single default session for backward compatibility.
    Hosted mode isolates each session and enforces limits.
    """

    def __init__(self, max_sessions: int = 50, ttl_seconds: float = 1800):
        # session_id -> (store_dict, captures_list, last_access_monotonic)
        self._data: dict[str, tuple[dict, list, float]] = {}
        # session_id -> {result_id: full_result_dict}
        # Bounded indirectly: full results are evicted alongside their
        # corresponding summary when the captures list is FIFO-trimmed.
        self._full_results: dict[str, dict[str, dict]] = {}
        self._lock = threading.Lock()
        self._max_sessions = max_sessions
        self._ttl = ttl_seconds

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
            store[key] = value
            self._data[session_id] = (store, captures, time.monotonic())

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
            self._full_results.setdefault(session_id, {})[result_id] = result
            store, captures, _ = self._data[session_id]
            self._data[session_id] = (store, captures, time.monotonic())

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
            entry = self._data.get(session_id)
            if entry is None:
                return
            store, captures, _ = entry
            store.clear()
            captures.clear()
            self._data[session_id] = (store, captures, time.monotonic())

    def _ensure_session(self, session_id: str) -> None:
        if session_id not in self._data:
            if len(self._data) >= self._max_sessions:
                raise RuntimeError("Too many active fringe sessions")
            self._data[session_id] = ({}, [], time.monotonic())

    def _evict_expired(self):
        now = time.monotonic()
        expired = [k for k, (_, _, ts) in self._data.items() if now - ts > self._ttl]
        for k in expired:
            del self._data[k]
            self._full_results.pop(k, None)


_fringe_cache = _FringeCache()


def _record_capture(session_id: str, result: dict) -> None:
    """Append a lightweight summary of a wrapped analyze result to the session.

    Called after :func:`wrap_wavefront_result` on new captures only — never
    for re-analyses of an existing image (e.g. ``/fringe/reanalyze-carrier``).
    """
    summary = {
        "id": result.get("id"),
        "origin": result.get("origin"),
        "captured_at": result.get("captured_at"),
        "source_ids": list(result.get("source_ids") or []),
        "pv_nm": result.get("pv_nm"),
        "rms_nm": result.get("rms_nm"),
        "pv_waves": result.get("pv_waves"),
        "rms_waves": result.get("rms_waves"),
        "strehl": result.get("strehl"),
        "wavelength_nm": result.get("wavelength_nm"),
        "n_valid_pixels": result.get("n_valid_pixels"),
        "n_total_pixels": result.get("n_total_pixels"),
        "surface_height": result.get("surface_height"),
        "surface_width": result.get("surface_width"),
        "calibration_snapshot": result.get("calibration_snapshot"),
    }
    _fringe_cache.append_capture(session_id, summary)


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


def _cap_image_size(image: np.ndarray, request: Request) -> np.ndarray:
    """Downsample image if it exceeds the hosted-mode size limit."""
    if not getattr(request.app.state, "hosted", False):
        return image
    h, w = image.shape[:2]
    if max(h, w) <= _HOSTED_MAX_DIM:
        return image
    scale = _HOSTED_MAX_DIM / max(h, w)
    new_w = int(w * scale)
    new_h = int(h * scale)
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
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    mask_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    image_b64: Optional[str] = Field(default=None)
    roi: Optional[RoiRect] = Field(default=None)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)
    form_model: str = Field(default="zernike", pattern="^(zernike|plane|poly2|poly3)$")
    lens_k1: float = Field(default=0.0, ge=-2.0, le=2.0)
    correct_2pi_jumps: bool = Field(default=True)
    calibration: Optional[CalibrationSnapshot] = Field(default=None)
    aperture_recipe: Optional[ApertureRecipe] = Field(default=None)
    # M2.5 — user-tunable DFT parameters. None = auto (preserve legacy defaults).
    lpf_sigma_frac: Optional[float] = Field(default=None, gt=0, le=5.0)
    dc_margin_override: Optional[int] = Field(default=None, ge=0, le=32)
    # M2.1 — exponential DC high-pass cutoff (FFT bins). Default 1.5 matches
    # legacy dc_margin=2 sensitivity with a smooth ramp instead of a cliff.
    dc_cutoff_cycles: float = Field(default=1.5, ge=0.0, le=32.0)


class ReanalyzeBody(BaseModel):
    coefficients: list[float]
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    surface_height: int = Field(gt=0)
    surface_width: int = Field(gt=0)
    mask: Optional[list[int]] = Field(default=None)
    n_zernike: int = Field(default=36, ge=1, le=66)
    form_model: str = Field(default="zernike", pattern="^(zernike|plane|poly2|poly3)$")
    # M1.3 raw-grid path: when all three are provided, reanalyze operates
    # on the cached pre-form-removal heightmap instead of reconstructing
    # from Zernike coefficients alone.
    raw_height_grid_nm: Optional[list[float]] = Field(default=None)
    raw_grid_rows: Optional[int] = Field(default=None, gt=0)
    raw_grid_cols: Optional[int] = Field(default=None, gt=0)


class ReanalyzeCarrierBody(BaseModel):
    carrier_y: float
    carrier_x: float
    image_b64: Optional[str] = Field(default=None)
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    mask_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)
    lens_k1: float = Field(default=0.0, ge=-2.0, le=2.0)
    correct_2pi_jumps: bool = Field(default=True)
    calibration: Optional[CalibrationSnapshot] = Field(default=None)
    aperture_recipe: Optional[ApertureRecipe] = Field(default=None)
    # M2.5 — user-tunable DFT parameters. None = auto (preserve legacy defaults).
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


class AverageBody(BaseModel):
    source_ids: list[str] = Field(..., min_length=2)
    wavelength_nm: Optional[float] = Field(default=None, gt=0)
    rejection: Literal["none", "sigma", "mad"] = "none"
    rejection_threshold: float = Field(default=3.0, gt=0, le=10)


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
        if body.image_b64:
            # Decode uploaded image
            try:
                img_bytes = base64.b64decode(body.image_b64)
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("Could not decode image")
                image = _best_gray(image)
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

        image = _cap_image_size(image, request)

        # Crop to ROI if specified (legacy rectangle mode)
        if body.roi and not body.mask_polygons:
            ih, iw = image.shape[:2]
            x0 = int(body.roi.x * iw)
            y0 = int(body.roi.y * ih)
            x1 = min(int((body.roi.x + body.roi.w) * iw), iw)
            y1 = min(int((body.roi.y + body.roi.h) * ih), ih)
            if x1 - x0 > 10 and y1 - y0 > 10:
                image = image[y0:y1, x0:x1]

        # Build polygon mask if provided
        custom_mask = None
        if body.mask_polygons:
            ih, iw = image.shape[:2]
            custom_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )

        _fringe_cache.put(session_id, "last_image", image.copy())

        result = analyze_interferogram(
            image,
            wavelength_nm=body.wavelength_nm,
            mask_threshold=body.mask_threshold,
            subtract_terms=body.subtract_terms,
            n_zernike=body.n_zernike,
            use_full_mask=body.roi is not None and not body.mask_polygons,
            custom_mask=custom_mask,
            form_model=body.form_model,
            lens_k1=body.lens_k1,
            correct_2pi_jumps=body.correct_2pi_jumps,
            lpf_sigma_frac=body.lpf_sigma_frac,
            dc_margin_override=body.dc_margin_override,
            dc_cutoff_cycles=body.dc_cutoff_cycles,
        )
        # Cache full-res mask for reanalyze/invert (mask_grid is downsampled)
        if "_mask_full" in result:
            _fringe_cache.put(session_id, "last_mask", result.pop("_mask_full"))
        wrap_wavefront_result(
            result,
            origin="capture",
            calibration=body.calibration.model_dump() if body.calibration else None,
            aperture_recipe=body.aperture_recipe.model_dump() if body.aperture_recipe else None,
        )
        # M2.5 + M2.1: echo applied tuning so the UI can display server-resolved
        # values (including the new dc_cutoff_cycles knob).
        result["tuning"] = {
            "mask_threshold": body.mask_threshold,
            "lpf_sigma_frac": body.lpf_sigma_frac,
            "dc_margin_override": body.dc_margin_override,
            "dc_cutoff_cycles": body.dc_cutoff_cycles,
        }
        _record_capture(session_id, result)
        _fringe_cache.put_full_result(session_id, result["id"], result)
        # Track the most recent capture so /fringe/reanalyze-carrier can
        # link a manual carrier override back to its source capture (Fix 2).
        _fringe_cache.put(session_id, "last_capture_id", result["id"])
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
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        # Decode image before starting the stream so we can emit error events
        # inside the stream rather than returning an HTTP error.
        if body.image_b64:
            try:
                img_bytes = base64.b64decode(body.image_b64)
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("Could not decode image")
                image = _best_gray(image)
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

        image = _cap_image_size(image, request)

        # Crop to ROI if specified (legacy rectangle mode)
        if body.roi and not body.mask_polygons:
            ih, iw = image.shape[:2]
            x0 = int(body.roi.x * iw)
            y0 = int(body.roi.y * ih)
            x1 = min(int((body.roi.x + body.roi.w) * iw), iw)
            y1 = min(int((body.roi.y + body.roi.h) * ih), ih)
            if x1 - x0 > 10 and y1 - y0 > 10:
                image = image[y0:y1, x0:x1]

        # Build polygon mask if provided
        custom_mask = None
        if body.mask_polygons:
            ih, iw = image.shape[:2]
            custom_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )

        _fringe_cache.put(session_id, "last_image", image.copy())
        # Capture session_id for use inside the closure
        sid = session_id

        def _on_progress(stage: str, progress: float, message: str) -> None:
            event = {"stage": stage, "progress": progress, "message": message}
            loop.call_soon_threadsafe(queue.put_nowait, event)

        async def _run_analysis():
            try:
                result = await loop.run_in_executor(
                    None,
                    lambda: analyze_interferogram(
                        image,
                        wavelength_nm=body.wavelength_nm,
                        mask_threshold=body.mask_threshold,
                        subtract_terms=body.subtract_terms,
                        n_zernike=body.n_zernike,
                        use_full_mask=body.roi is not None and not body.mask_polygons,
                        custom_mask=custom_mask,
                        on_progress=_on_progress,
                        form_model=body.form_model,
                        lens_k1=body.lens_k1,
                        correct_2pi_jumps=body.correct_2pi_jumps,
                        lpf_sigma_frac=body.lpf_sigma_frac,
                        dc_margin_override=body.dc_margin_override,
                        dc_cutoff_cycles=body.dc_cutoff_cycles,
                    ),
                )
                # Cache full-res mask before sending result to client
                if "_mask_full" in result:
                    _fringe_cache.put(sid, "last_mask", result.pop("_mask_full"))
                wrap_wavefront_result(
                    result,
                    origin="capture",
                    calibration=body.calibration.model_dump() if body.calibration else None,
                    aperture_recipe=body.aperture_recipe.model_dump() if body.aperture_recipe else None,
                )
                # M2.5 + M2.1: echo applied tuning so the UI can display server-resolved values.
                result["tuning"] = {
                    "mask_threshold": body.mask_threshold,
                    "lpf_sigma_frac": body.lpf_sigma_frac,
                    "dc_margin_override": body.dc_margin_override,
                    "dc_cutoff_cycles": body.dc_cutoff_cycles,
                }
                _record_capture(sid, result)
                _fringe_cache.put_full_result(sid, result["id"], result)
                # Track the most recent capture so /fringe/reanalyze-carrier
                # can link a manual carrier override back to its source
                # capture (Fix 2).
                _fringe_cache.put(sid, "last_capture_id", result["id"])
                await queue.put({"stage": "done", "progress": 1.0, "result": result})
            except Exception as exc:
                await queue.put({"stage": "error", "message": str(exc)})

        async def _event_stream():
            task = asyncio.ensure_future(_run_analysis())
            try:
                while True:
                    event = await queue.get()
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
        mask = body.mask
        if mask is None:
            mask = _fringe_cache.get(session_id, "last_mask")
        result = reanalyze(
            coefficients=body.coefficients,
            subtract_terms=body.subtract_terms,
            wavelength_nm=body.wavelength_nm,
            surface_shape=(body.surface_height, body.surface_width),
            mask_serialized=mask,
            n_zernike=body.n_zernike,
            form_model=body.form_model,
            raw_height_grid_nm=body.raw_height_grid_nm,
            raw_grid_rows=body.raw_grid_rows,
            raw_grid_cols=body.raw_grid_cols,
        )
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
        if body.image_b64:
            try:
                img_bytes = base64.b64decode(body.image_b64)
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError("Could not decode image")
                image = _best_gray(image)
                image = _cap_image_size(image, request)
            except Exception as e:
                raise HTTPException(400, detail=f"Invalid image: {e}")
        else:
            cached = _fringe_cache.get(session_id, "last_image")
            if cached is not None:
                image = cached
            else:
                raise HTTPException(400, detail="No cached image. Run /fringe/analyze first or provide image_b64.")

        custom_mask = None
        if body.mask_polygons:
            ih, iw = image.shape[:2]
            custom_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )

        result = analyze_interferogram(
            image,
            wavelength_nm=body.wavelength_nm,
            mask_threshold=body.mask_threshold,
            subtract_terms=body.subtract_terms,
            n_zernike=body.n_zernike,
            custom_mask=custom_mask,
            carrier_override=(body.carrier_y, body.carrier_x),
            lens_k1=body.lens_k1,
            correct_2pi_jumps=body.correct_2pi_jumps,
            lpf_sigma_frac=body.lpf_sigma_frac,
            dc_margin_override=body.dc_margin_override,
            dc_cutoff_cycles=body.dc_cutoff_cycles,
        )
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
        wrap_wavefront_result(
            result,
            origin="capture",
            calibration=body.calibration.model_dump() if body.calibration else None,
            aperture_recipe=body.aperture_recipe.model_dump() if body.aperture_recipe else None,
            source_ids=source_ids,
        )
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
        _fringe_cache.put_full_result(session_id, result["id"], result)
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
            result = subtract_wavefronts(
                measurement, reference,
                wavelength_nm=body.wavelength_nm,
                register=bool(body.register),
                hosted=hosted_flag,
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
        _fringe_cache.put_full_result(session_id, result["id"], result)
        return result

    @router.post("/fringe/average")
    async def fringe_average(body: AverageBody,
                             session_id: str = Depends(get_session_id_dep)):
        """Average multiple in-session captures (pixel-aligned, no registration).

        See :func:`backend.vision.fringe.average_wavefronts`.  All inputs must
        already exist in the session's capture cache.  Returns the full wrapped
        averaged result and records it as a new capture so it can be chained
        into further averages or subtractions.
        """
        sources: list[dict] = []
        for sid in body.source_ids:
            r = _fringe_cache.get_full_result(session_id, sid)
            if r is None:
                raise HTTPException(404, detail=f"Unknown source_id: {sid}")
            sources.append(r)
        try:
            result = average_wavefronts(
                sources,
                wavelength_nm=body.wavelength_nm,
                rejection=body.rejection,
                rejection_threshold=body.rejection_threshold,
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
        _record_capture(session_id, result)
        _fringe_cache.put_full_result(session_id, result["id"], result)
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
        _fringe_cache.put_full_result(session_id, new["id"], new)
        return new

    @router.post("/fringe/session/clear")
    async def fringe_session_clear(session_id: str = Depends(get_session_id_dep)):
        """Clear last_image, last_mask, and captures list for the session."""
        _fringe_cache.clear_session(session_id)
        return {"cleared": True}

    return router
