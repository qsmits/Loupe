"""HTTP API for the XY image stitching workflow.

The workflow supports toolmaker's microscopes with manual XY micrometers:
start a session with grid dimensions, capture tiles at each position,
then stitch them into a seamless panorama.  One active session at a time.
"""

from __future__ import annotations

import threading
import uuid
from typing import Dict, List, Optional, Tuple

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .vision.focus_stack import encode_png
from .vision.stitch import compute_overlap_px, stitch_grid


class _StitchSession:
    """In-memory state for one active stitching session."""

    def __init__(self) -> None:
        self.id: str = uuid.uuid4().hex
        self.grid_shape: Tuple[int, int] = (1, 1)  # (cols, rows)
        self.tiles: Dict[Tuple[int, int], np.ndarray] = {}
        self.overlap_frac: float = 0.20
        self.px_per_mm: Optional[float] = None
        self.result: Optional[np.ndarray] = None
        self.sensor_shape: Optional[Tuple[int, int]] = None  # (h, w)

    def reset(self) -> None:
        self.id = uuid.uuid4().hex
        self.grid_shape = (1, 1)
        self.tiles = {}
        self.overlap_frac = 0.20
        self.px_per_mm = None
        self.result = None
        self.sensor_shape = None


def _serpentine_order(cols: int, rows: int) -> List[List[int]]:
    """Return scan order as list of [col, row] in serpentine order."""
    order = []
    for r in range(rows):
        if r % 2 == 0:
            for c in range(cols):
                order.append([c, r])
        else:
            for c in range(cols - 1, -1, -1):
                order.append([c, r])
    return order


class StartBody(BaseModel):
    cols: int = Field(ge=1, le=20)
    rows: int = Field(ge=1, le=20)
    overlap_pct: float = Field(default=20.0, ge=1.0, le=80.0)
    px_per_mm: Optional[float] = Field(default=None, gt=0)


class CaptureBody(BaseModel):
    col: int
    row: int


def make_stitch_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()
    session = _StitchSession()
    lock = threading.Lock()

    @router.post("/stitch/start")
    async def stitch_start(body: StartBody):
        with lock:
            session.reset()
            session.grid_shape = (body.cols, body.rows)
            session.overlap_frac = body.overlap_pct / 100.0
            session.px_per_mm = body.px_per_mm

            cols, rows = session.grid_shape
            total = cols * rows
            scan_order = _serpentine_order(cols, rows)

            step_mm = None
            if session.px_per_mm and session.px_per_mm > 0:
                # We need the sensor width to compute step_mm, but we don't
                # have a frame yet.  Grab one to determine sensor dimensions.
                frame = camera.get_frame()
                if frame is not None:
                    session.sensor_shape = (frame.shape[0], frame.shape[1])
                    sensor_w = frame.shape[1]
                    overlap_px = compute_overlap_px(sensor_w, session.overlap_frac)
                    step_px = sensor_w - overlap_px
                    step_mm = round(step_px / session.px_per_mm, 4)

            return {
                "session_id": session.id,
                "grid_shape": [cols, rows],
                "total_tiles": total,
                "scan_order": scan_order,
                "step_mm": step_mm,
            }

    @router.post("/stitch/capture")
    async def stitch_capture(body: CaptureBody):
        with lock:
            cols, rows = session.grid_shape
            if body.col < 0 or body.col >= cols or body.row < 0 or body.row >= rows:
                raise HTTPException(
                    status_code=400,
                    detail=f"Position ({body.col}, {body.row}) outside grid {cols}x{rows}",
                )

            frame = camera.get_frame()
            if frame is None:
                raise HTTPException(status_code=503, detail="Camera returned no frame")

            # Store sensor shape from first capture
            if session.sensor_shape is None:
                session.sensor_shape = (frame.shape[0], frame.shape[1])

            session.tiles[(body.col, body.row)] = frame.copy()
            # Invalidate any previous result
            session.result = None

            return {
                "session_id": session.id,
                "captured_count": len(session.tiles),
                "total_tiles": cols * rows,
                "position": [body.col, body.row],
            }

    @router.post("/stitch/compute")
    async def stitch_compute():
        with lock:
            cols, rows = session.grid_shape
            total = cols * rows
            if len(session.tiles) < total:
                raise HTTPException(
                    status_code=400,
                    detail=f"Not all tiles captured: have {len(session.tiles)}, need {total}",
                )

            if session.sensor_shape is None:
                raise HTTPException(status_code=400, detail="No sensor shape available")

            _h, w = session.sensor_shape
            overlap_px = compute_overlap_px(w, session.overlap_frac)

            try:
                result = stitch_grid(session.tiles, session.grid_shape, overlap_px)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Stitching failed: {e}")

            session.result = result
            rh, rw = result.shape[:2]

            return {
                "session_id": session.id,
                "width": int(rw),
                "height": int(rh),
                "result_url": "/stitch/result.png",
            }

    @router.get("/stitch/result.png")
    async def stitch_result_png():
        with lock:
            if session.result is None:
                raise HTTPException(status_code=404, detail="No stitched result. POST /stitch/compute first.")
            png = encode_png(session.result)
        return Response(content=png, media_type="image/png")

    @router.get("/stitch/status")
    async def stitch_status():
        with lock:
            cols, rows = session.grid_shape
            total = cols * rows
            captured = [[c, r] for (c, r) in sorted(session.tiles.keys())]
            result_dims = None
            if session.result is not None:
                rh, rw = session.result.shape[:2]
                result_dims = {"width": int(rw), "height": int(rh)}

            return {
                "session_id": session.id,
                "grid_shape": [cols, rows],
                "captured": captured,
                "total_tiles": total,
                "has_result": session.result is not None,
                "result_dims": result_dims,
                "overlap_pct": round(session.overlap_frac * 100, 1),
                "px_per_mm": session.px_per_mm,
            }

    @router.post("/stitch/reset")
    async def stitch_reset():
        with lock:
            session.reset()
            return {"session_id": session.id}

    return router
