"""HTTP API for the manual Z-stack (depth-from-focus) workflow.

The workflow mimics the Keyence VHX-900 "3D" mode without a motorised Z:
start a session, capture N frames as the user manually turns the Z knob,
then run focus stacking to produce an all-in-focus composite and a height
map.  Everything lives in memory; one active stack at a time.
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
from .vision.focus_stack import (
    colorize_height_map,
    compute_focus_stack,
    downsample_float_map,
    downsample_index_map,
    encode_png,
)


MIN_FRAMES_TO_COMPUTE = 3
MAX_FRAMES = 64  # upper bound to keep memory sane


class _ZStackSession:
    """In-memory state for one active z-stack session."""

    def __init__(self) -> None:
        self.id: str = uuid.uuid4().hex
        self.frames: List[np.ndarray] = []
        self.result: Optional[dict] = None

    def reset(self) -> None:
        self.frames = []
        self.result = None
        self.id = uuid.uuid4().hex


class ComputeBody(BaseModel):
    z_step_mm: float = Field(gt=0, le=10.0, description="Z delta between frames (mm)")
    z0_mm: float = Field(default=0.0, description="Absolute Z of first frame (mm)")


def make_zstack_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()
    session = _ZStackSession()
    lock = threading.Lock()

    def _require_result() -> dict:
        if session.result is None:
            raise HTTPException(status_code=404, detail="No computed z-stack. POST /zstack/compute first.")
        return session.result

    @router.post("/zstack/start")
    async def zstack_start():
        with lock:
            session.reset()
            return {
                "session_id": session.id,
                "frame_count": 0,
                "min_frames_to_compute": MIN_FRAMES_TO_COMPUTE,
                "max_frames": MAX_FRAMES,
            }

    @router.post("/zstack/capture")
    async def zstack_capture():
        with lock:
            if len(session.frames) >= MAX_FRAMES:
                raise HTTPException(status_code=400, detail=f"Frame limit reached ({MAX_FRAMES})")
            frame = camera.get_frame()
            if frame is None:
                raise HTTPException(status_code=503, detail="Camera returned no frame")
            # Store a copy — camera may recycle its buffer
            session.frames.append(frame.copy())
            # Any new capture invalidates an existing result
            session.result = None
            return {
                "session_id": session.id,
                "frame_index": len(session.frames) - 1,
                "frame_count": len(session.frames),
            }

    @router.get("/zstack/status")
    async def zstack_status():
        with lock:
            return {
                "session_id": session.id,
                "frame_count": len(session.frames),
                "has_result": session.result is not None,
                "min_frames_to_compute": MIN_FRAMES_TO_COMPUTE,
                "max_frames": MAX_FRAMES,
            }

    @router.post("/zstack/compute")
    async def zstack_compute(body: ComputeBody):
        with lock:
            if len(session.frames) < MIN_FRAMES_TO_COMPUTE:
                raise HTTPException(
                    status_code=400,
                    detail=f"Need at least {MIN_FRAMES_TO_COMPUTE} frames (have {len(session.frames)})",
                )
            try:
                result = compute_focus_stack(
                    session.frames,
                    z_step_mm=body.z_step_mm,
                    z0_mm=body.z0_mm,
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            session.result = result
            h, w = result["composite"].shape[:2]
            return {
                "session_id": session.id,
                "width": int(w),
                "height": int(h),
                "min_z": result["min_z"],
                "max_z": result["max_z"],
                "frame_count": len(session.frames),
                "composite_url": "/zstack/composite.png",
                "heightmap_url": "/zstack/heightmap.png",
            }

    @router.get("/zstack/composite.png")
    async def zstack_composite():
        with lock:
            result = _require_result()
            png = encode_png(result["composite"])
        return Response(content=png, media_type="image/png")

    @router.get("/zstack/heightmap.png")
    async def zstack_heightmap():
        with lock:
            result = _require_result()
            viz = colorize_height_map(result["height_map"])
            png = encode_png(viz)
        return Response(content=png, media_type="image/png")

    @router.get("/zstack/heightmap.raw")
    async def zstack_heightmap_raw():
        """Raw downsampled focus-index map for the 3D viewer.

        Returns the per-pixel best-focus frame index (before colormap) as a
        flat float array, plus metadata needed to reconstruct world-space Z.
        Downsampled to at most 256x256 to keep the JSON payload small.
        """
        with lock:
            result = _require_result()
            index_map = result["index_map"]
            peak_focus = result.get("peak_focus")
            max_bright = result.get("max_brightness")
            z_values = result["z_values"]
            frame_count = len(z_values)
            if frame_count >= 2:
                z_step_mm = float(z_values[1] - z_values[0])
            else:
                z_step_mm = 0.0
            down = downsample_index_map(index_map, max_side=256)
            # Confidence: per-pixel peak sharpness, normalized to [0,1] against
            # the 99th percentile (robust to a few noise spikes).
            if peak_focus is not None:
                conf_down = downsample_float_map(peak_focus, max_side=256)
                p99 = float(np.percentile(conf_down, 99.0)) or 1.0
                conf_norm = np.clip(conf_down / p99, 0.0, 1.0).astype(np.float32)
                confidence_list = conf_norm.reshape(-1).tolist()
            else:
                confidence_list = None
            # Per-pixel peak brightness, normalized 0..1.  Lets the 3D viewer
            # override confidence for overexposed regions via a slider.
            if max_bright is not None:
                bright_down = downsample_float_map(max_bright, max_side=256)
                bright_norm = np.clip(bright_down / 255.0, 0.0, 1.0).astype(np.float32)
                brightness_list = bright_norm.reshape(-1).tolist()
            else:
                brightness_list = None
        h, w = down.shape[:2]
        return {
            "width": int(w),
            "height": int(h),
            "data": down.reshape(-1).tolist(),
            "confidence": confidence_list,
            "brightness": brightness_list,
            "z_step_mm": z_step_mm,
            "frame_count": int(frame_count),
        }

    @router.post("/zstack/reset")
    async def zstack_reset():
        with lock:
            session.reset()
            return {"session_id": session.id, "frame_count": 0}

    return router
