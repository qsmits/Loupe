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
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .session_store import get_session_id_dep
from .vision.fringe import (
    analyze_interferogram,
    focus_quality,
    reanalyze,
    rasterize_polygon_mask,
)


# ── Session-scoped fringe cache ───────────────────────────────────────────

# Max image dimension in hosted mode (caps memory + CPU per request)
_HOSTED_MAX_DIM = 2048

class _FringeCache:
    """Per-session cache for fringe analysis state (last_image, last_mask).

    Non-hosted mode uses a single default session for backward compatibility.
    Hosted mode isolates each session and enforces limits.
    """

    def __init__(self, max_sessions: int = 50, ttl_seconds: float = 1800):
        self._data: dict[str, tuple[dict, float]] = {}
        self._lock = threading.Lock()
        self._max_sessions = max_sessions
        self._ttl = ttl_seconds

    def get(self, session_id: str, key: str):
        with self._lock:
            self._evict_expired()
            entry = self._data.get(session_id)
            if entry is None:
                return None
            store, _ = entry
            return store.get(key)

    def put(self, session_id: str, key: str, value):
        with self._lock:
            self._evict_expired()
            if session_id not in self._data:
                if len(self._data) >= self._max_sessions:
                    raise RuntimeError("Too many active fringe sessions")
                self._data[session_id] = ({}, time.monotonic())
            store, _ = self._data[session_id]
            store[key] = value
            self._data[session_id] = (store, time.monotonic())

    def _evict_expired(self):
        now = time.monotonic()
        expired = [k for k, (_, ts) in self._data.items() if now - ts > self._ttl]
        for k in expired:
            del self._data[k]


_fringe_cache = _FringeCache()


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


class AnalyzeBody(BaseModel):
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    mask_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    image_b64: Optional[str] = Field(default=None)
    roi: Optional[RoiRect] = Field(default=None)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)
    form_model: str = Field(default="zernike", pattern="^(zernike|plane)$")
    lens_k1: float = Field(default=0.0, ge=-2.0, le=2.0)


class ReanalyzeBody(BaseModel):
    coefficients: list[float]
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    surface_height: int = Field(gt=0)
    surface_width: int = Field(gt=0)
    mask: Optional[list[int]] = Field(default=None)
    n_zernike: int = Field(default=36, ge=1, le=66)
    form_model: str = Field(default="zernike", pattern="^(zernike|plane)$")


class ReanalyzeCarrierBody(BaseModel):
    carrier_y: int
    carrier_x: int
    image_b64: Optional[str] = Field(default=None)
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    mask_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)
    lens_k1: float = Field(default=0.0, ge=-2.0, le=2.0)


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
        )
        # Cache full-res mask for reanalyze/invert (mask_grid is downsampled)
        if "_mask_full" in result:
            _fringe_cache.put(session_id, "last_mask", result.pop("_mask_full"))
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
                    ),
                )
                # Cache full-res mask before sending result to client
                if "_mask_full" in result:
                    _fringe_cache.put(sid, "last_mask", result.pop("_mask_full"))
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
        )
        if "_mask_full" in result:
            _fringe_cache.put(session_id, "last_mask", result.pop("_mask_full"))
        return result

    return router
