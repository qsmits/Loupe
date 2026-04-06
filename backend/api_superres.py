"""HTTP API for the super-resolution (shift-and-add) workflow.

The user captures multiple frames at known sub-pixel shifts using
micrometer handwheels, then the backend reconstructs a higher-resolution
image via shift-and-add.  One active session at a time.
"""

from __future__ import annotations

import threading
import uuid
from typing import List, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .vision.superres import compute_shift_grid, estimate_shifts, reconstruct, shifts_to_um
from .vision.focus_stack import encode_png


VALID_SCALES = (2, 4)


class _SuperResSession:
    """In-memory state for one active super-resolution session."""

    def __init__(self) -> None:
        self.id: str = uuid.uuid4().hex
        self.scale: int = 2
        self.pixel_pitch_um: float = 1.0
        self.frames: List[np.ndarray] = []
        self.target_shifts: List[tuple] = []
        self.result: Optional[np.ndarray] = None

    def reset(self) -> None:
        self.id = uuid.uuid4().hex
        self.scale = 2
        self.pixel_pitch_um = 1.0
        self.frames = []
        self.target_shifts = []
        self.result = None


class StartBody(BaseModel):
    scale: int = Field(default=2, description="Upscale factor: 2 or 4")
    pixel_pitch_um: float = Field(default=1.0, gt=0, description="Pixel pitch in micrometers")


def make_superres_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()
    session = _SuperResSession()
    lock = threading.Lock()

    @router.post("/superres/start")
    async def superres_start(body: StartBody):
        if body.scale not in VALID_SCALES:
            raise HTTPException(
                status_code=400,
                detail=f"Scale must be one of {VALID_SCALES}, got {body.scale}",
            )
        with lock:
            session.reset()
            session.scale = body.scale
            session.pixel_pitch_um = body.pixel_pitch_um
            session.target_shifts = compute_shift_grid(body.scale)
            total = len(session.target_shifts)
            um_shifts = shifts_to_um(session.target_shifts, body.pixel_pitch_um)
            return {
                "session_id": session.id,
                "scale": session.scale,
                "total_frames": total,
                "shifts_um": [[dx, dy] for dx, dy in um_shifts],
                "shifts_frac": [[dx, dy] for dx, dy in session.target_shifts],
            }

    @router.post("/superres/capture")
    async def superres_capture():
        with lock:
            total = len(session.target_shifts)
            if not total:
                raise HTTPException(status_code=400, detail="No active session. POST /superres/start first.")
            if len(session.frames) >= total:
                raise HTTPException(status_code=400, detail=f"All {total} frames already captured")
            frame = camera.get_frame()
            if frame is None:
                raise HTTPException(status_code=503, detail="Camera returned no frame")
            session.frames.append(frame.copy())
            session.result = None
            return {
                "session_id": session.id,
                "frame_index": len(session.frames) - 1,
                "frame_count": len(session.frames),
                "total_needed": total,
            }

    @router.post("/superres/compute")
    async def superres_compute():
        with lock:
            total = len(session.target_shifts)
            if len(session.frames) < total:
                raise HTTPException(
                    status_code=400,
                    detail=f"Need {total} frames (have {len(session.frames)})",
                )
            try:
                shifts = estimate_shifts(session.frames, ref_idx=0)
                result = reconstruct(session.frames, shifts, session.scale)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Reconstruction failed: {e}")
            session.result = result
            h, w = result.shape[:2]
            return {
                "session_id": session.id,
                "width": int(w),
                "height": int(h),
                "scale": session.scale,
                "result_url": "/superres/result.png",
            }

    @router.get("/superres/result.png")
    async def superres_result_png():
        with lock:
            if session.result is None:
                raise HTTPException(status_code=404, detail="No result. POST /superres/compute first.")
            png = encode_png(session.result)
        return Response(content=png, media_type="image/png")

    @router.get("/superres/status")
    async def superres_status():
        with lock:
            total = len(session.target_shifts)
            return {
                "session_id": session.id,
                "scale": session.scale,
                "frame_count": len(session.frames),
                "total_needed": total,
                "has_result": session.result is not None,
                "pixel_pitch_um": session.pixel_pitch_um,
                "shifts_um": [
                    [dx, dy]
                    for dx, dy in shifts_to_um(session.target_shifts, session.pixel_pitch_um)
                ] if total > 0 else [],
            }

    @router.post("/superres/reset")
    async def superres_reset():
        with lock:
            session.reset()
            return {"session_id": session.id}

    return router
