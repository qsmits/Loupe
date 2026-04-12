"""HTTP + WebSocket API for the deflectometry workflow.

The workflow uses a paired iPad as a controllable fringe display: the
backend pushes sinusoidal fringe patterns to the iPad over a WebSocket,
waits for a render ack, then captures a frame of the specular surface
through the microscope camera. An 8-frame sequence (4 phase-shifted
patterns per orientation, x and y) is reduced to wrapped phase,
unwrapped, and returned as statistics + pseudocolor previews.

Single active session at a time; all state lives in the router closure.
"""

from __future__ import annotations

import asyncio
import math
import uuid
from typing import Optional

import numpy as np
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .vision.deflectometry import (
    compute_wrapped_phase,
    phase_stats,
    pseudocolor_png_b64,
    unwrap_phase,
)


def _reject_hosted(request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Deflectometry is not available in hosted mode")


class _Session:
    """In-memory state for one active deflectometry session."""

    def __init__(self, sid: str) -> None:
        self.id: str = sid
        self.ws: Optional[WebSocket] = None
        self.pending_acks: dict[int, asyncio.Event] = {}
        self.frames: list[np.ndarray] = []
        self.last_result: Optional[dict] = None
        # Serializes capture-sequence so two concurrent runs can't interleave
        self.lock: asyncio.Lock = asyncio.Lock()

    def clear_capture(self) -> None:
        self.frames = []
        self.last_result = None

    def is_unused(self) -> bool:
        return (
            self.ws is None
            and not self.frames
            and self.last_result is None
        )


class StartBody(BaseModel):
    pass


class ResetBody(BaseModel):
    pass


class ComputeBody(BaseModel):
    pass


class CaptureBody(BaseModel):
    freq: int = Field(default=16, ge=1, le=256)


def make_deflectometry_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter(dependencies=[Depends(_reject_hosted)])
    # Single-active-session container; using a dict so nested functions can
    # rebind without `nonlocal`.
    state: dict[str, Optional[_Session]] = {"session": None}

    def _current() -> Optional[_Session]:
        return state["session"]

    @router.post("/deflectometry/start")
    async def deflectometry_start(body: StartBody):
        existing = state["session"]
        # Idempotent: keep an existing session if it's already paired or has
        # work in progress. Only replace a fresh, unused session.
        if existing is not None and not existing.is_unused():
            return {
                "session_id": existing.id,
                "pairing_url": f"/deflectometry-screen.html?session={existing.id}",
                "ipad_connected": existing.ws is not None,
            }
        sid = uuid.uuid4().hex
        state["session"] = _Session(sid)
        return {
            "session_id": sid,
            "pairing_url": f"/deflectometry-screen.html?session={sid}",
            "ipad_connected": False,
        }

    @router.get("/deflectometry/status")
    async def deflectometry_status():
        s = _current()
        if s is None:
            return {
                "session_id": None,
                "ipad_connected": False,
                "captured_count": 0,
                "has_result": False,
                "last_result": None,
            }
        return {
            "session_id": s.id,
            "ipad_connected": s.ws is not None,
            "captured_count": len(s.frames),
            "has_result": s.last_result is not None,
            "last_result": s.last_result,
        }

    @router.post("/deflectometry/reset")
    async def deflectometry_reset(body: ResetBody = ResetBody()):  # noqa: B008
        s = _current()
        if s is not None:
            s.clear_capture()
        return {}

    async def _push_and_wait(
        s: _Session,
        payload: dict,
        timeout_s: float = 2.0,
        settle_s: float = 0.12,
    ) -> None:
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")
        pid = int(payload["pattern_id"])
        ev = asyncio.Event()
        s.pending_acks[pid] = ev
        try:
            await s.ws.send_json(payload)
            try:
                await asyncio.wait_for(ev.wait(), timeout=timeout_s)
            except asyncio.TimeoutError:
                raise HTTPException(
                    503, detail=f"iPad ack timeout (pattern {pid})"
                )
        finally:
            s.pending_acks.pop(pid, None)
        # Small settle delay for the LCD to stabilize before camera capture
        await asyncio.sleep(settle_s)

    @router.post("/deflectometry/capture-sequence")
    async def deflectometry_capture_sequence(body: CaptureBody):
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")

        phases = [0.0, math.pi / 2.0, math.pi, 3.0 * math.pi / 2.0]

        async with s.lock:
            # Start of a new capture wipes any previous frames/result so the
            # 8-frame invariant holds.
            s.frames = []
            s.last_result = None
            pid = 0
            for orientation in ("x", "y"):
                for phase in phases:
                    pid += 1
                    await _push_and_wait(
                        s,
                        {
                            "type": "pattern",
                            "pattern_id": pid,
                            "freq": int(body.freq),
                            "phase": float(phase),
                            "orientation": orientation,
                        },
                    )
                    frame = camera.get_frame()
                    if frame is None:
                        raise HTTPException(
                            503, detail="Camera returned no frame"
                        )
                    # Copy so we don't hold a reference to a shared buffer
                    s.frames.append(frame.copy())

        return {"captured_count": len(s.frames)}

    @router.post("/deflectometry/compute")
    async def deflectometry_compute(body: ComputeBody = ComputeBody()):  # noqa: B008
        s = _current()
        if s is None or len(s.frames) < 8:
            have = 0 if s is None else len(s.frames)
            raise HTTPException(
                400,
                detail=f"Need 8 captured frames before compute (have {have})",
            )

        def _to_gray(f: np.ndarray) -> np.ndarray:
            arr = np.asarray(f, dtype=np.float64)
            if arr.ndim == 3:
                arr = arr.mean(axis=-1)
            return arr

        frames_x = [_to_gray(f) for f in s.frames[:4]]
        frames_y = [_to_gray(f) for f in s.frames[4:8]]

        wrap_x = compute_wrapped_phase(frames_x)
        wrap_y = compute_wrapped_phase(frames_y)
        unw_x = unwrap_phase(wrap_x, orientation="x")
        unw_y = unwrap_phase(wrap_y, orientation="y")

        result = {
            "phase_x_png_b64": pseudocolor_png_b64(unw_x),
            "phase_y_png_b64": pseudocolor_png_b64(unw_y),
            "stats_x": phase_stats(unw_x),
            "stats_y": phase_stats(unw_y),
        }
        s.last_result = result
        return result

    @router.websocket("/deflectometry/ws/{session_id}")
    async def deflectometry_ws(websocket: WebSocket, session_id: str):
        # Router-level Depends(_reject_hosted) does not apply to WebSocket
        # routes — enforce hosted-mode rejection explicitly.
        if getattr(websocket.app.state, "hosted", False):
            await websocket.close(code=1008)
            return
        s = _current()
        if s is None or s.id != session_id:
            await websocket.close(code=1008)
            return

        await websocket.accept()
        s.ws = websocket
        try:
            while True:
                msg = await websocket.receive_json()
                mtype = msg.get("type")
                if mtype == "ack":
                    try:
                        pid = int(msg["pattern_id"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    ev = s.pending_acks.get(pid)
                    if ev is not None:
                        ev.set()
                elif mtype == "hello":
                    # Handshake already recorded via s.ws = websocket above
                    pass
                # Unknown message types are silently ignored
        except WebSocketDisconnect:
            pass
        finally:
            if s.ws is websocket:
                s.ws = None

    return router
