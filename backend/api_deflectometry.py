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
    compute_modulation,
    compute_wrapped_phase,
    phase_stats,
    pseudocolor_png_b64,
    remove_tilt,
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
        self.flat_white: Optional[np.ndarray] = None
        self.flat_black: Optional[np.ndarray] = None
        # Serializes capture-sequence so two concurrent runs can't interleave
        self.lock: asyncio.Lock = asyncio.Lock()

    def clear_capture(self) -> None:
        # NOTE: flat_white / flat_black persist across resets — they are
        # only recaptured explicitly via /flat-field.
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
    averages: int = Field(default=3, ge=1, le=10)


class PairBody(BaseModel):
    code: str


def make_deflectometry_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()
    # Single-active-session container; using a dict so nested functions can
    # rebind without `nonlocal`.
    state: dict[str, Optional[_Session]] = {"session": None}
    # Lobby: maps pairing codes to iPad WebSocket connections waiting to pair.
    lobby: dict[str, WebSocket] = {}

    def _current() -> Optional[_Session]:
        return state["session"]

    @router.post("/deflectometry/start", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_start(body: StartBody):
        existing = state["session"]
        # Idempotent: keep an existing session if it's already paired or has
        # work in progress. Only replace a fresh, unused session.
        if existing is not None and not existing.is_unused():
            return {
                "session_id": existing.id,
                "ipad_connected": existing.ws is not None,
            }
        sid = uuid.uuid4().hex
        state["session"] = _Session(sid)
        return {
            "session_id": sid,
            "ipad_connected": False,
        }

    @router.get("/deflectometry/status", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_status():
        s = _current()
        if s is None:
            return {
                "session_id": None,
                "ipad_connected": False,
                "captured_count": 0,
                "has_result": False,
                "has_flat_field": False,
                "last_result": None,
            }
        return {
            "session_id": s.id,
            "ipad_connected": s.ws is not None,
            "captured_count": len(s.frames),
            "has_result": s.last_result is not None,
            "has_flat_field": s.flat_white is not None and s.flat_black is not None,
            "last_result": s.last_result,
        }

    @router.post("/deflectometry/pair", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_pair(body: PairBody):
        code = body.code
        ws = lobby.get(code)
        if ws is None:
            raise HTTPException(404, detail="No iPad with that code is waiting")
        lobby.pop(code, None)
        # Auto-create session if needed
        s = _current()
        if s is None or s.is_unused():
            sid = uuid.uuid4().hex
            s = _Session(sid)
            state["session"] = s
        s.ws = ws
        await ws.send_json({"type": "paired", "session_id": s.id})
        return {"session_id": s.id, "ipad_connected": True}

    @router.post("/deflectometry/flat-field", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_flat_field():
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")

        async with s.lock:
            # White frame
            await _push_and_wait(
                s,
                {"type": "solid", "pattern_id": 1, "value": 255},
            )
            frame_w = camera.get_frame()
            if frame_w is None:
                raise HTTPException(503, detail="Camera returned no frame")
            s.flat_white = frame_w.copy()

            # Black frame
            await _push_and_wait(
                s,
                {"type": "solid", "pattern_id": 2, "value": 0},
            )
            frame_b = camera.get_frame()
            if frame_b is None:
                raise HTTPException(503, detail="Camera returned no frame")
            s.flat_black = frame_b.copy()

            # Return iPad to mid-gray
            await _push_and_wait(
                s,
                {"type": "clear", "pattern_id": 3},
            )

        return {"status": "ok", "has_flat_field": True}

    @router.post("/deflectometry/reset", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_reset(body: ResetBody = ResetBody()):  # noqa: B008
        s = _current()
        if s is not None:
            s.clear_capture()
        return {}

    async def _push_and_wait(
        s: _Session,
        payload: dict,
        timeout_s: float = 2.0,
        settle_s: float = 0.30,
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

    @router.post("/deflectometry/capture-sequence", dependencies=[Depends(_reject_hosted)])
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
                    # Average multiple captures to reduce random noise
                    accum = None
                    for _avg in range(body.averages):
                        frame = camera.get_frame()
                        if frame is None:
                            raise HTTPException(
                                503, detail="Camera returned no frame"
                            )
                        f = frame.astype(np.float64)
                        accum = f if accum is None else accum + f
                        if _avg < body.averages - 1:
                            await asyncio.sleep(0.05)
                    s.frames.append((accum / body.averages).astype(np.uint8))

        return {"captured_count": len(s.frames)}

    @router.post("/deflectometry/compute", dependencies=[Depends(_reject_hosted)])
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

        # Flat-field correction: normalize per-pixel intensity range
        if s.flat_white is not None and s.flat_black is not None:
            white = _to_gray(s.flat_white)
            black = _to_gray(s.flat_black)
            denom = white - black + 1e-6
            frames_x = [(f - black) / denom for f in frames_x]
            frames_y = [(f - black) / denom for f in frames_y]

        wrap_x = compute_wrapped_phase(frames_x)
        wrap_y = compute_wrapped_phase(frames_y)
        unw_x = remove_tilt(unwrap_phase(wrap_x, orientation="x"))
        unw_y = remove_tilt(unwrap_phase(wrap_y, orientation="y"))

        result = {
            "phase_x_png_b64": pseudocolor_png_b64(unw_x),
            "phase_y_png_b64": pseudocolor_png_b64(unw_y),
            "stats_x": phase_stats(unw_x),
            "stats_y": phase_stats(unw_y),
        }
        s.last_result = result
        return result

    @router.post("/deflectometry/diagnostics", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_diagnostics():
        """Save captured frames to disk and return diagnostic data.

        Writes each frame as a PNG in poc_output/deflectometry/ and returns
        per-frame stats, modulation maps, wrapped phase maps, and unwrapped
        phase maps — everything needed to debug fringe quality and unwrap
        failures.
        """
        import os
        s = _current()
        if s is None or len(s.frames) < 8:
            have = 0 if s is None else len(s.frames)
            raise HTTPException(400, detail=f"Need 8 frames (have {have})")

        out_dir = os.path.join(os.path.dirname(__file__), "..", "poc_output", "deflectometry")
        os.makedirs(out_dir, exist_ok=True)

        def _to_gray(f):
            arr = np.asarray(f, dtype=np.float64)
            return arr.mean(axis=-1) if arr.ndim == 3 else arr

        # Save raw frames as PNGs
        frame_stats = []
        for i, f in enumerate(s.frames[:8]):
            orientation = "x" if i < 4 else "y"
            phase_idx = i % 4
            fname = f"frame_{orientation}_{phase_idx}.png"
            import cv2
            cv2.imwrite(os.path.join(out_dir, fname), f)
            gray = _to_gray(f)
            frame_stats.append({
                "name": fname,
                "min": float(gray.min()),
                "max": float(gray.max()),
                "mean": float(gray.mean()),
                "std": float(gray.std()),
            })

        frames_x = [_to_gray(f) for f in s.frames[:4]]
        frames_y = [_to_gray(f) for f in s.frames[4:8]]

        # Apply flat-field if available
        if s.flat_white is not None and s.flat_black is not None:
            white = _to_gray(s.flat_white)
            black = _to_gray(s.flat_black)
            denom = white - black + 1e-6
            frames_x = [(f - black) / denom for f in frames_x]
            frames_y = [(f - black) / denom for f in frames_y]

        # Modulation (fringe contrast)
        mod_x = compute_modulation(frames_x)
        mod_y = compute_modulation(frames_y)

        # Wrapped phase
        wrap_x = compute_wrapped_phase(frames_x)
        wrap_y = compute_wrapped_phase(frames_y)

        # Unwrapped phase (before tilt removal)
        unw_x_raw = unwrap_phase(wrap_x, orientation="x")
        unw_y_raw = unwrap_phase(wrap_y, orientation="y")

        return {
            "frame_stats": frame_stats,
            "modulation_x": {
                "png_b64": pseudocolor_png_b64(mod_x),
                "min": float(mod_x.min()),
                "max": float(mod_x.max()),
                "mean": float(mod_x.mean()),
                "median": float(np.median(mod_x)),
            },
            "modulation_y": {
                "png_b64": pseudocolor_png_b64(mod_y),
                "min": float(mod_y.min()),
                "max": float(mod_y.max()),
                "mean": float(mod_y.mean()),
                "median": float(np.median(mod_y)),
            },
            "wrapped_x_png_b64": pseudocolor_png_b64(wrap_x),
            "wrapped_y_png_b64": pseudocolor_png_b64(wrap_y),
            "unwrapped_raw_x_png_b64": pseudocolor_png_b64(unw_x_raw),
            "unwrapped_raw_y_png_b64": pseudocolor_png_b64(unw_y_raw),
            "frames_saved_to": os.path.abspath(out_dir),
        }

    @router.websocket("/deflectometry/ws")
    async def deflectometry_ws(websocket: WebSocket):
        # Router-level Depends(_reject_hosted) does not apply to WebSocket
        # routes — enforce hosted-mode rejection explicitly.
        if getattr(websocket.app.state, "hosted", False):
            await websocket.close(code=1008)
            return

        await websocket.accept()

        # Wait for the first message — must be a hello with a pairing code.
        try:
            first = await websocket.receive_json()
        except WebSocketDisconnect:
            return
        if first.get("type") != "hello" or "pairing_code" not in first:
            await websocket.close(code=1008)
            return

        pairing_code: str = first["pairing_code"]
        lobby[pairing_code] = websocket

        try:
            while True:
                msg = await websocket.receive_json()
                mtype = msg.get("type")
                if mtype == "ack":
                    # Resolve pending ack on the session this WS is paired to
                    s = _current()
                    if s is not None and s.ws is websocket:
                        try:
                            pid = int(msg["pattern_id"])
                        except (KeyError, TypeError, ValueError):
                            continue
                        ev = s.pending_acks.get(pid)
                        if ev is not None:
                            ev.set()
                # Unknown message types are silently ignored
        except WebSocketDisconnect:
            pass
        finally:
            # Clean up lobby entry if still present
            lobby.pop(pairing_code, None)
            # Unset session.ws if this was the paired WS
            s = _current()
            if s is not None and s.ws is websocket:
                s.ws = None

    return router
