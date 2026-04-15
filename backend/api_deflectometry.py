"""HTTP + WebSocket API for the deflectometry workflow.

The workflow uses a paired iPad as a controllable fringe display: the
backend pushes sinusoidal fringe patterns to the iPad over a WebSocket,
waits for a render ack, then captures a frame of the specular surface
through the microscope camera. A 16-frame sequence (8 phase-shifted
patterns per orientation, x and y) is reduced to wrapped phase,
unwrapped, and returned as statistics + pseudocolor previews.

8-step phase shifting (vs. the previous 4-step) suppresses harmonics up
to the 3rd order, making phase extraction robust against LCD gamma
non-linearity.

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
    create_modulation_mask,
    build_response_lut,
    find_optimal_smooth_sigma,
    fit_sphere_calibration,
    frankot_chellappa,
    phase_stats,
    pseudocolor_png_b64,
    diverging_png_b64,
    remove_tilt,
    unwrap_phase,
    compute_slope_magnitude,
    compute_curl_residual,
    compute_quality_summary,
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
        self.ref_phase_x: Optional[np.ndarray] = None
        self.ref_phase_y: Optional[np.ndarray] = None
        self.cal_factor: Optional[float] = None  # phase-rad → mm
        self.freq: int = 16  # fringe frequency used during last capture
        self.inverse_lut = None  # 256-entry uint8 array from display calibration
        # Serializes capture-sequence so two concurrent runs can't interleave
        self.lock: asyncio.Lock = asyncio.Lock()

    def clear_capture(self) -> None:
        # NOTE: flat_white / flat_black and ref_phase_x / ref_phase_y persist
        # across resets — they are only recaptured explicitly.
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
    mask_threshold: float = Field(default=0.02, ge=0.0, le=0.5)
    smooth_sigma: float = Field(default=0.0, ge=0.0, le=10.0)


class CaptureBody(BaseModel):
    freq: int = Field(default=16, ge=1, le=256)
    averages: int = Field(default=3, ge=1, le=10)
    gamma: float = Field(default=2.2, ge=1.0, le=3.0)


class CaptureReferenceBody(BaseModel):
    freq: int = Field(default=16, ge=1, le=256)
    averages: int = Field(default=3, ge=1, le=10)
    gamma: float = Field(default=2.2, ge=1.0, le=3.0)


class HeightmapBody(BaseModel):
    mask_threshold: float = Field(default=0.02, ge=0.0, le=0.5)
    smooth_sigma: float = Field(default=0.0, ge=0.0, le=10.0)


class CalibrateSphereBody(BaseModel):
    sphere_diameter_mm: float = Field(gt=0)
    px_per_mm: float = Field(gt=0)


class DiagnosticsBody(BaseModel):
    smooth_sigma: float = Field(default=0.0, ge=0.0, le=10.0)


class ExportRunBody(BaseModel):
    pass


class ProfileDisplay(BaseModel):
    model: str = ""
    pixel_pitch_mm: float = 0.0962

class ProfileCapture(BaseModel):
    freq: int = 16
    averages: int = 3
    gamma: float = 2.2

class ProfileProcessing(BaseModel):
    mask_threshold: float = 0.02
    smooth_sigma: float = 0.0

class ProfileGeometry(BaseModel):
    notes: str = ""

class ProfileCalibration(BaseModel):
    cal_factor: float | None = None
    sphere_diameter_mm: float | None = None

class DeflectometryProfile(BaseModel):
    name: str
    display: ProfileDisplay = ProfileDisplay()
    capture: ProfileCapture = ProfileCapture()
    processing: ProfileProcessing = ProfileProcessing()
    geometry: ProfileGeometry = ProfileGeometry()
    calibration: ProfileCalibration = ProfileCalibration()

class LoadProfileBody(BaseModel):
    name: str


def make_deflectometry_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()
    # Single-active-session container; using a dict so nested functions can
    # rebind without `nonlocal`.
    state: dict[str, Optional[_Session]] = {"session": None}

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
                "has_display_cal": False,
                "last_result": None,
            }
        return {
            "session_id": s.id,
            "ipad_connected": s.ws is not None,
            "captured_count": len(s.frames),
            "has_result": s.last_result is not None,
            "has_flat_field": s.flat_white is not None and s.flat_black is not None,
            "has_display_cal": s.inverse_lut is not None,
            "has_reference": s.ref_phase_x is not None,
            "cal_factor": s.cal_factor,
            "last_result": s.last_result,
        }

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

            # Return iPad to centering pattern
            if s.ws is not None:
                await s.ws.send_json({"type": "centering"})

        return {"status": "ok", "has_flat_field": True}

    def _compute_unwrapped(s: _Session, smooth_sigma: float = 0.0):
        """Shared pipeline: flat-field correct, wrap, unwrap, tilt-remove.

        Returns (unw_x, unw_y, frames_x, frames_y) where frames are the
        (possibly flat-field-corrected) gray frames used for modulation.
        """
        def _to_gray(f: np.ndarray) -> np.ndarray:
            arr = np.asarray(f, dtype=np.float64)
            if arr.ndim == 3:
                arr = arr.mean(axis=-1)
            return arr

        frames_x = [_to_gray(f) for f in s.frames[:8]]
        frames_y = [_to_gray(f) for f in s.frames[8:16]]

        if s.flat_white is not None and s.flat_black is not None:
            white = _to_gray(s.flat_white)
            black = _to_gray(s.flat_black)
            denom = white - black + 1e-6
            frames_x = [(f - black) / denom for f in frames_x]
            frames_y = [(f - black) / denom for f in frames_y]

        if smooth_sigma > 0:
            from scipy.ndimage import gaussian_filter
            frames_x = [gaussian_filter(f, sigma=smooth_sigma) for f in frames_x]
            frames_y = [gaussian_filter(f, sigma=smooth_sigma) for f in frames_y]

        wrap_x = compute_wrapped_phase(frames_x)
        wrap_y = compute_wrapped_phase(frames_y)
        unw_x = remove_tilt(unwrap_phase(wrap_x, orientation="x"))
        unw_y = remove_tilt(unwrap_phase(wrap_y, orientation="y"))

        return unw_x, unw_y, frames_x, frames_y

    @router.post("/deflectometry/capture-reference", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_capture_reference(body: CaptureReferenceBody):
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")

        phases = [k * math.pi / 4.0 for k in range(8)]

        async with s.lock:
            ref_frames: list[np.ndarray] = []
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
                            "gamma": float(body.gamma),
                        },
                    )
                    accum = None
                    for _avg in range(body.averages):
                        frame = camera.get_frame()
                        if frame is None:
                            raise HTTPException(503, detail="Camera returned no frame")
                        f = frame.astype(np.float64)
                        accum = f if accum is None else accum + f
                        if _avg < body.averages - 1:
                            await asyncio.sleep(0.05)
                    ref_frames.append((accum / body.averages).astype(np.uint8))

        # Temporarily stash ref_frames, compute unwrapped phase, then restore
        orig_frames = s.frames
        orig_result = s.last_result
        s.frames = ref_frames
        try:
            unw_x, unw_y, _, _ = _compute_unwrapped(s)
        finally:
            s.frames = orig_frames
            s.last_result = orig_result

        s.ref_phase_x = unw_x
        s.ref_phase_y = unw_y

        # Return iPad to centering pattern
        if s.ws is not None:
            await s.ws.send_json({"type": "centering"})

        return {"status": "ok", "has_reference": True}

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

        phases = [k * math.pi / 4.0 for k in range(8)]

        async with s.lock:
            # Start of a new capture wipes any previous frames/result so the
            # 16-frame invariant holds.
            s.frames = []
            s.last_result = None
            s.freq = body.freq
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
                            "gamma": float(body.gamma),
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

        # Return iPad to centering pattern
        if s.ws is not None:
            await s.ws.send_json({"type": "centering"})

        return {"captured_count": len(s.frames)}

    @router.post("/deflectometry/compute", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_compute(body: ComputeBody = ComputeBody()):  # noqa: B008
        s = _current()
        if s is None or len(s.frames) < 16:
            have = 0 if s is None else len(s.frames)
            raise HTTPException(
                400,
                detail=f"Need 16 captured frames before compute (have {have})",
            )

        unw_x, unw_y, frames_x, frames_y = _compute_unwrapped(s, smooth_sigma=body.smooth_sigma)

        # Reference subtraction
        has_reference = False
        if s.ref_phase_x is not None and s.ref_phase_y is not None:
            if s.ref_phase_x.shape == unw_x.shape and s.ref_phase_y.shape == unw_y.shape:
                unw_x = unw_x - s.ref_phase_x
                unw_y = unw_y - s.ref_phase_y
                has_reference = True

        # Modulation-based masking
        mod_x = compute_modulation(frames_x)
        mod_y = compute_modulation(frames_y)
        mask = create_modulation_mask(mod_x, mod_y, threshold_frac=body.mask_threshold)
        mask_valid_frac = float(mask.sum()) / float(mask.size) if mask.size > 0 else 0.0

        # Slope magnitude and curl residual
        slope_mag = compute_slope_magnitude(unw_x, unw_y, mask=mask)
        curl = compute_curl_residual(unw_x, unw_y, mask=mask)

        # Quality summary
        quality = compute_quality_summary(
            unw_x, unw_y, mask, mod_x, mod_y, frames_x, frames_y,
        )

        result = {
            "phase_x_png_b64": pseudocolor_png_b64(unw_x, mask=mask),
            "phase_y_png_b64": pseudocolor_png_b64(unw_y, mask=mask),
            "slope_mag_png_b64": pseudocolor_png_b64(slope_mag, mask=mask),
            "curl_png_b64": diverging_png_b64(curl, mask=mask),
            "stats_x": phase_stats(unw_x, mask=mask),
            "stats_y": phase_stats(unw_y, mask=mask),
            "stats_slope_mag": phase_stats(slope_mag, mask=mask),
            "stats_curl": phase_stats(curl, mask=mask),
            "has_reference": has_reference,
            "mask_valid_frac": mask_valid_frac,
            "cal_factor": s.cal_factor,
            "quality": quality,
        }
        s.last_result = result
        # Store unwrapped phases and mask for heightmap endpoint
        s._last_unw_x = unw_x
        s._last_unw_y = unw_y
        s._last_mask = mask
        return result

    @router.post("/deflectometry/heightmap", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_heightmap(body: HeightmapBody = HeightmapBody()):  # noqa: B008
        import cv2 as cv2_local
        s = _current()
        if s is None or s.last_result is None:
            raise HTTPException(400, detail="Run compute first")

        unw_x = s._last_unw_x
        unw_y = s._last_unw_y
        # Recompute mask with the requested threshold so the 3D view
        # respects the slider value even if it differs from the last compute.
        if len(s.frames) >= 16:
            def _to_gray(f):
                arr = np.asarray(f, dtype=np.float64)
                return arr.mean(axis=-1) if arr.ndim == 3 else arr
            frames_x = [_to_gray(f) for f in s.frames[:8]]
            frames_y = [_to_gray(f) for f in s.frames[8:16]]
            if s.flat_white is not None and s.flat_black is not None:
                white = _to_gray(s.flat_white)
                black = _to_gray(s.flat_black)
                denom = white - black + 1e-6
                frames_x = [(f - black) / denom for f in frames_x]
                frames_y = [(f - black) / denom for f in frames_y]
            if body.smooth_sigma > 0:
                from scipy.ndimage import gaussian_filter
                frames_x = [gaussian_filter(f, sigma=body.smooth_sigma) for f in frames_x]
                frames_y = [gaussian_filter(f, sigma=body.smooth_sigma) for f in frames_y]
            mod_x = compute_modulation(frames_x)
            mod_y = compute_modulation(frames_y)
            mask = create_modulation_mask(mod_x, mod_y, threshold_frac=body.mask_threshold)
        else:
            mask = s._last_mask

        height = frankot_chellappa(unw_x, unw_y, mask=mask)

        # Apply calibration if available (phase-rad → mm → µm)
        cal = s.cal_factor
        unit = "rad"
        if cal is not None:
            height = height * cal * 1000.0  # → µm
            unit = "µm"

        # Downsampled dimensions: max 256px on long edge
        h, w = height.shape
        long_edge = max(h, w)
        if long_edge > 256:
            scale = 256.0 / long_edge
            new_w = max(1, int(round(w * scale)))
            new_h = max(1, int(round(h * scale)))
        else:
            new_w, new_h = w, h

        if new_w != w or new_h != h:
            # Set NaN (masked) pixels to 0 before resize
            h_filled = height.copy()
            nan_mask = np.isnan(h_filled)
            h_filled[nan_mask] = 0.0

            h_small = cv2_local.resize(
                h_filled.astype(np.float32), (new_w, new_h),
                interpolation=cv2_local.INTER_AREA,
            )

            # Resize mask separately
            mask_float = mask.astype(np.float32)
            mask_small = cv2_local.resize(
                mask_float, (new_w, new_h),
                interpolation=cv2_local.INTER_AREA,
            )
            mask_ds = mask_small > 0.5
            h_small[~mask_ds] = float("nan")
        else:
            h_small = height.astype(np.float32)
            mask_ds = mask

        # Stats on valid pixels
        stats = phase_stats(h_small[mask_ds]) if mask_ds.any() else {"pv": 0.0, "rms": 0.0, "mean": 0.0}

        # Build flat lists, replacing NaN with None for JSON
        data_list = []
        mask_list = []
        for val, m in zip(h_small.ravel(), mask_ds.ravel()):
            data_list.append(None if np.isnan(val) else float(val))
            mask_list.append(1 if m else 0)

        has_reference = s.ref_phase_x is not None

        return {
            "width": new_w,
            "height": new_h,
            "data": data_list,
            "mask": mask_list,
            "stats": stats,
            "has_reference": has_reference,
            "unit": unit,
            "cal_factor": cal,
        }

    @router.post("/deflectometry/calibrate-sphere", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_calibrate_sphere(body: CalibrateSphereBody):
        s = _current()
        if s is None or s.last_result is None:
            raise HTTPException(400, detail="Run compute first")
        if not hasattr(s, "_last_unw_x"):
            raise HTTPException(400, detail="No height data — run compute first")

        # Build height map from stored unwrapped phases
        mask = s._last_mask
        height = frankot_chellappa(s._last_unw_x, s._last_unw_y, mask=mask)

        mm_per_px = 1.0 / body.px_per_mm
        sphere_radius_mm = body.sphere_diameter_mm / 2.0

        try:
            result = fit_sphere_calibration(
                height, mask, sphere_radius_mm, mm_per_px
            )
        except ValueError as e:
            raise HTTPException(400, detail=str(e))

        s.cal_factor = result["cal_factor"]
        # Update stored result so status polling reflects calibration
        if s.last_result is not None:
            s.last_result["cal_factor"] = result["cal_factor"]
        return result

    @router.post("/deflectometry/auto-smooth", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_auto_smooth():
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if len(s.frames) < 16:
            raise HTTPException(400, detail="Capture frames first (need at least 16)")

        # Use the first X-fringe frame (index 0), converted to grayscale
        frame = np.asarray(s.frames[0], dtype=np.float64)
        if frame.ndim == 3:
            frame = frame.mean(axis=-1)

        # Apply flat-field correction if available
        if s.flat_white is not None and s.flat_black is not None:
            white = np.asarray(s.flat_white, dtype=np.float64)
            black = np.asarray(s.flat_black, dtype=np.float64)
            if white.ndim == 3:
                white = white.mean(axis=-1)
            if black.ndim == 3:
                black = black.mean(axis=-1)
            frame = (frame - black) / (white - black + 1e-6)

        sigma = find_optimal_smooth_sigma(frame, fringe_freq=s.freq or 16)
        return {"sigma": sigma}

    @router.post("/deflectometry/calibrate-display", dependencies=[Depends(_reject_hosted)])
    async def calibrate_display():
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")

        n_steps = 12
        commanded = np.linspace(0, 255, n_steps).astype(int)
        observed = []

        async with s.lock:
            for i, val in enumerate(commanded):
                msg = {"type": "solid", "value": int(val), "pattern_id": 9000 + i}
                await _push_and_wait(s, msg, timeout_s=5.0)
                frame = camera.get_frame()
                if frame is None:
                    raise HTTPException(500, detail=f"Frame capture failed at step {i}")
                gray = frame if frame.ndim == 2 else frame.mean(axis=2)
                h, w = gray.shape
                roi = gray[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4]
                observed.append(float(np.median(roi)))

            # Restore display to centering pattern
            if s.ws is not None:
                await s.ws.send_json({"type": "centering"})

        obs_arr = np.array(observed, dtype=np.float64)
        fwd, inv = build_response_lut(commanded.astype(np.float64), obs_arr)
        s.inverse_lut = inv

        return {
            "status": "ok",
            "n_steps": n_steps,
            "commanded": commanded.tolist(),
            "observed": [round(v, 1) for v in observed],
            "max_deviation_from_gamma": _max_gamma_deviation(commanded, obs_arr),
        }

    def _max_gamma_deviation(commanded, observed):
        """Max % deviation between measured response and gamma 2.2 assumption."""
        cmd_norm = commanded.astype(np.float64) / 255.0
        expected_gamma = 255.0 * cmd_norm ** 2.2
        if observed.max() > 0:
            obs_norm = observed / observed.max() * 255.0
        else:
            obs_norm = observed
        diff = np.abs(obs_norm - expected_gamma)
        if len(diff) > 2:
            diff = diff[1:-1]
        return round(float(diff.max() / 255.0 * 100), 1)

    @router.post("/deflectometry/diagnostics", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_diagnostics(body: DiagnosticsBody = DiagnosticsBody()):  # noqa: B008
        """Save captured frames to disk and return diagnostic data.

        Writes each frame as a PNG in poc_output/deflectometry/ and returns
        per-frame stats, modulation maps, wrapped phase maps, and unwrapped
        phase maps — everything needed to debug fringe quality and unwrap
        failures.
        """
        import os
        s = _current()
        if s is None or len(s.frames) < 16:
            have = 0 if s is None else len(s.frames)
            raise HTTPException(400, detail=f"Need 16 frames (have {have})")

        out_dir = os.path.join(os.path.dirname(__file__), "..", "poc_output", "deflectometry")
        os.makedirs(out_dir, exist_ok=True)

        def _to_gray(f):
            arr = np.asarray(f, dtype=np.float64)
            return arr.mean(axis=-1) if arr.ndim == 3 else arr

        # Save raw frames as PNGs
        frame_stats = []
        for i, f in enumerate(s.frames[:16]):
            orientation = "x" if i < 8 else "y"
            phase_idx = i % 8
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

        frames_x = [_to_gray(f) for f in s.frames[:8]]
        frames_y = [_to_gray(f) for f in s.frames[8:16]]

        # Apply flat-field if available
        if s.flat_white is not None and s.flat_black is not None:
            white = _to_gray(s.flat_white)
            black = _to_gray(s.flat_black)
            denom = white - black + 1e-6
            frames_x = [(f - black) / denom for f in frames_x]
            frames_y = [(f - black) / denom for f in frames_y]

        if body.smooth_sigma > 0:
            from scipy.ndimage import gaussian_filter
            frames_x = [gaussian_filter(f, sigma=body.smooth_sigma) for f in frames_x]
            frames_y = [gaussian_filter(f, sigma=body.smooth_sigma) for f in frames_y]

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

    @router.post("/deflectometry/export-run", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_export_run(body: ExportRunBody = ExportRunBody()):  # noqa: B008
        """Return a structured JSON record of the current measurement run."""
        import datetime
        s = _current()
        if s is None or s.last_result is None:
            raise HTTPException(400, detail="Run compute first")

        result = s.last_result

        return {
            "version": 1,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "acquisition": {
                "n_frames": len(s.frames),
                "n_phase_steps": 8,
                "frequency_cycles": s.freq,
                "gamma": 2.2,
                "smooth_sigma": 0.0,
                "mask_threshold": 0.02,
                "has_flat_field": s.flat_white is not None,
                "has_reference": s.ref_phase_x is not None,
            },
            "calibration": {
                "cal_factor": s.cal_factor,
            },
            "quality": result.get("quality"),
            "stats": {
                "phase_x": result.get("stats_x"),
                "phase_y": result.get("stats_y"),
                "slope_magnitude": result.get("stats_slope_mag"),
                "curl": result.get("stats_curl"),
            },
            "modulation": {
                "x_median": result.get("quality", {}).get("modulation_x_median"),
                "y_median": result.get("quality", {}).get("modulation_y_median"),
            },
            "mask_valid_frac": result.get("mask_valid_frac"),
        }

    @router.get("/deflectometry/profiles")
    def list_profiles():
        from .config import load_config
        cfg = load_config()
        return cfg.get("deflectometry_profiles", [])

    @router.post("/deflectometry/profiles")
    def save_profile(profile: DeflectometryProfile):
        from .config import load_config, save_config
        cfg = load_config()
        profiles = cfg.get("deflectometry_profiles", [])
        profiles = [p for p in profiles if p.get("name") != profile.name]
        profiles.append(profile.model_dump())
        save_config({"deflectometry_profiles": profiles,
                      "deflectometry_active_profile": profile.name})
        return profile.model_dump()

    @router.delete("/deflectometry/profiles/{name}")
    def delete_profile(name: str):
        from .config import load_config, save_config
        cfg = load_config()
        profiles = cfg.get("deflectometry_profiles", [])
        new_profiles = [p for p in profiles if p.get("name") != name]
        if len(new_profiles) == len(profiles):
            raise HTTPException(404, f"Profile '{name}' not found")
        active = cfg.get("deflectometry_active_profile")
        updates = {"deflectometry_profiles": new_profiles}
        if active == name:
            updates["deflectometry_active_profile"] = None
        save_config(updates)
        return {"status": "deleted"}

    @router.post("/deflectometry/profiles/load")
    def load_profile(body: LoadProfileBody):
        from .config import load_config, save_config
        cfg = load_config()
        profiles = cfg.get("deflectometry_profiles", [])
        match = next((p for p in profiles if p.get("name") == body.name), None)
        if not match:
            raise HTTPException(404, f"Profile '{body.name}' not found")
        s = state.get("session")
        if s and match.get("calibration", {}).get("cal_factor") is not None:
            s.cal_factor = match["calibration"]["cal_factor"]
        save_config({"deflectometry_active_profile": body.name})
        return match

    @router.websocket("/deflectometry/ws")
    async def deflectometry_ws(websocket: WebSocket):
        # Router-level Depends(_reject_hosted) does not apply to WebSocket
        # routes — enforce hosted-mode rejection explicitly.
        if getattr(websocket.app.state, "hosted", False):
            await websocket.close(code=1008)
            return

        await websocket.accept()

        # Auto-attach to the current session (create one if needed).
        s = _current()
        if s is None or s.is_unused():
            sid = uuid.uuid4().hex
            s = _Session(sid)
            state["session"] = s
        s.ws = websocket
        await websocket.send_json({"type": "paired", "session_id": s.id})
        await websocket.send_json({"type": "centering"})

        try:
            while True:
                msg = await websocket.receive_json()
                mtype = msg.get("type")
                if mtype == "ack":
                    s2 = _current()
                    if s2 is not None and s2.ws is websocket:
                        try:
                            pid = int(msg["pattern_id"])
                        except (KeyError, TypeError, ValueError):
                            continue
                        ev = s2.pending_acks.get(pid)
                        if ev is not None:
                            ev.set()
        except WebSocketDisconnect:
            pass
        finally:
            s2 = _current()
            if s2 is not None and s2.ws is websocket:
                s2.ws = None

    return router
