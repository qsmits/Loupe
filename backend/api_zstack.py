"""HTTP API for the manual Z-stack (depth-from-focus) workflow.

The workflow mimics the Keyence VHX-900 "3D" mode without a motorised Z:
start a session, capture N frames as the user manually turns the Z knob,
then run focus stacking to produce an all-in-focus composite and a height
map.  Everything lives in memory; one active stack at a time.
"""

from __future__ import annotations

import base64
import threading
import uuid
from typing import List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .vision.focus_stack import (
    colorize_height_map,
    compute_focus_stack,
    compute_focus_stack_pyramid,
    downsample_float_map,
    downsample_index_map,
    encode_png,
)
from .vision.heightmap_analysis import (
    detrend as detrend_height_map,
    sample_profile,
)


_DETREND_MODES = ("none", "plane", "poly2")


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


DEFAULT_HDR_STOPS = [-2.0, 0.0, 2.0]


class CaptureHdrBody(BaseModel):
    stops: Optional[List[float]] = Field(
        default=None,
        description="EV stops for the bracket. Defaults to [-2, 0, +2].",
    )


class ProfileBody(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float
    samples: Optional[int] = None
    detrend: str = "none"
    px_per_mm: Optional[float] = None


class ComputeBody(BaseModel):
    z_step_mm: float = Field(gt=0, le=10.0, description="Z delta between frames (mm)")
    z0_mm: float = Field(default=0.0, description="Absolute Z of first frame (mm)")
    mode: str = Field(
        default="pyramid",
        description="Fusion mode: 'pyramid' (Laplacian pyramid fusion, default — preserves more detail) or 'argmax' (per-pixel best-focus)",
    )


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

    def _hdr_supported() -> bool:
        # Any camera wrapper that exposes capture_hdr_bracket (i.e. CameraReader
        # around a real hardware camera).  NullCamera wrappers still expose the
        # method, so also check is_null.
        if not hasattr(camera, "capture_hdr_bracket"):
            return False
        try:
            if getattr(camera, "is_null", False):
                return False
        except Exception:
            pass
        # Only Aravis exposes usable microsecond-precision exposure control;
        # OpenCV's CAP_PROP_EXPOSURE is unreliable (esp. on macOS).
        try:
            info = camera.get_info()
            model = str(info.get("model", "")).lower()
        except Exception:
            return False
        # Heuristic: treat anything with a non-trivial exposure value as supported,
        # and explicitly exclude OpenCV webcams which report model "opencv".
        if "opencv" in model or "webcam" in model:
            return False
        return True

    @router.get("/zstack/status")
    async def zstack_status():
        with lock:
            return {
                "session_id": session.id,
                "frame_count": len(session.frames),
                "has_result": session.result is not None,
                "min_frames_to_compute": MIN_FRAMES_TO_COMPUTE,
                "max_frames": MAX_FRAMES,
                "hdr_supported": _hdr_supported(),
                "hdr_default_stops": DEFAULT_HDR_STOPS,
            }

    @router.post("/zstack/capture-hdr")
    async def zstack_capture_hdr(body: CaptureHdrBody):
        """Capture one Z slice with HDR exposure bracketing.

        Captures N frames at different exposures, Mertens-fuses them into a
        single LDR frame, and appends that fused frame to the session — so
        downstream focus stacking treats an HDR slice exactly like a normal
        one.
        """
        if not _hdr_supported():
            raise HTTPException(status_code=501, detail="Active camera does not support HDR bracketing")
        stops = body.stops if body.stops else DEFAULT_HDR_STOPS
        if not stops or len(stops) < 2:
            raise HTTPException(status_code=400, detail="Need at least 2 stops for HDR")
        with lock:
            if len(session.frames) >= MAX_FRAMES:
                raise HTTPException(status_code=400, detail=f"Frame limit reached ({MAX_FRAMES})")
            try:
                brackets = camera.capture_hdr_bracket(stops)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"HDR bracket failed: {e}")
            try:
                merger = cv2.createMergeMertens()
                fused_f = merger.process(brackets)  # float32, roughly [0,1]
                fused_u8 = np.clip(fused_f * 255.0, 0, 255).astype(np.uint8)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Mertens merge failed: {e}")
            session.frames.append(fused_u8)
            session.result = None
            return {
                "session_id": session.id,
                "frame_index": len(session.frames) - 1,
                "frame_count": len(session.frames),
                "hdr": True,
                "stops": list(stops),
                "bracket_count": len(brackets),
            }

    @router.post("/zstack/compute")
    async def zstack_compute(body: ComputeBody):
        with lock:
            if len(session.frames) < MIN_FRAMES_TO_COMPUTE:
                raise HTTPException(
                    status_code=400,
                    detail=f"Need at least {MIN_FRAMES_TO_COMPUTE} frames (have {len(session.frames)})",
                )
            mode = (body.mode or "argmax").lower()
            if mode not in ("argmax", "pyramid"):
                raise HTTPException(status_code=400, detail=f"Unknown fusion mode: {mode}")
            try:
                if mode == "pyramid":
                    result = compute_focus_stack_pyramid(
                        session.frames,
                        z_step_mm=body.z_step_mm,
                        z0_mm=body.z0_mm,
                    )
                else:
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
                "mode": mode,
            }

    @router.get("/zstack/composite.png")
    async def zstack_composite():
        with lock:
            result = _require_result()
            png = encode_png(result["composite"])
        return Response(content=png, media_type="image/png")

    @router.get("/zstack/heightmap.png")
    async def zstack_heightmap(detrend: str = Query("none")):
        if detrend not in _DETREND_MODES:
            raise HTTPException(status_code=400, detail=f"Unknown detrend mode: {detrend}")
        with lock:
            result = _require_result()
            hm = detrend_height_map(result["height_map"], detrend)
            viz = colorize_height_map(hm)
            png = encode_png(viz)
        return Response(content=png, media_type="image/png")

    @router.get("/zstack/heightmap.raw")
    async def zstack_heightmap_raw(detrend: str = Query("none")):
        """Raw downsampled focus-index map for the 3D viewer.

        Returns the per-pixel best-focus frame index (before colormap) as a
        flat float array, plus metadata needed to reconstruct world-space Z.
        Downsampled to at most 256x256 to keep the JSON payload small.

        ``detrend`` removes stage tilt (``plane``) or tilt + lens curvature
        (``poly2``) from the full-resolution height map before downsampling.
        The fit is subtracted in mm-space, then converted back to index-units
        so the 3D viewer's calibrate-Z math (Δindex × z_step_mm) still works.
        """
        if detrend not in _DETREND_MODES:
            raise HTTPException(status_code=400, detail=f"Unknown detrend mode: {detrend}")
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
            if detrend != "none" and z_step_mm > 0:
                # Detrend in mm-space at full resolution, then re-express as
                # a float index map so the rest of the pipeline is unchanged.
                hm = detrend_height_map(result["height_map"], detrend)
                z0 = float(z_values[0])
                idx_full = (hm - z0) / z_step_mm
                down = downsample_float_map(idx_full.astype(np.float32), max_side=256)
            else:
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

    @router.post("/zstack/profile")
    async def zstack_profile(body: ProfileBody):
        if body.detrend not in _DETREND_MODES:
            raise HTTPException(status_code=400, detail=f"Unknown detrend mode: {body.detrend}")
        with lock:
            result = _require_result()
            hm = detrend_height_map(result["height_map"], body.detrend)
        # Sampling is pure-numpy and doesn't need the session lock held.
        prof = sample_profile(
            hm,
            (body.x0, body.y0),
            (body.x1, body.y1),
            samples=body.samples,
        )
        length_px = prof["length_px"]
        t = prof["t"]
        ppm = body.px_per_mm
        if ppm is not None and ppm > 0:
            length_mm = length_px / ppm
            distances = (t * length_px / ppm)
            distances_unit = "mm"
        else:
            length_mm = None
            distances = t * length_px
            distances_unit = "px"
        z_mm = prof["z_mm"]
        # Phase 3 slot: compute roughness from (distances, z_mm) here and add
        # a "roughness" key to the response.
        def _round_list(a, nd=4):
            return [round(float(v), nd) for v in a]
        return {
            "length_px": round(float(length_px), 4),
            "length_mm": None if length_mm is None else round(float(length_mm), 6),
            "samples": int(len(z_mm)),
            "distances": _round_list(distances, 6),
            "distances_unit": distances_unit,
            "z_mm": _round_list(z_mm, 6),
            "x_px": _round_list(prof["x_px"], 3),
            "y_px": _round_list(prof["y_px"], 3),
            "z_min_mm": round(float(z_mm.min()), 6),
            "z_max_mm": round(float(z_mm.max()), 6),
            "detrend": body.detrend,
        }

    @router.get("/zstack/test-hdr-bracket")
    async def zstack_test_hdr_bracket(
        stops: str = Query("-2,0,2", description="Comma-separated EV stops"),
    ):
        """Debug helper: capture an HDR bracket synchronously and return the
        raw frames + their Mertens merge as base64 PNGs, plus the exposures
        used.  Used to verify reader-thread timing on real hardware before
        wiring this into the full /zstack/capture-hdr workflow.
        """
        try:
            stop_list = [float(s.strip()) for s in stops.split(",") if s.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid stops list")
        if not stop_list:
            raise HTTPException(status_code=400, detail="At least one stop required")
        if not hasattr(camera, "capture_hdr_bracket"):
            raise HTTPException(status_code=501, detail="Active camera does not support HDR bracket")

        try:
            info_before = camera.get_info()
            baseline = float(info_before.get("exposure", 0.0))
            frames = camera.capture_hdr_bracket(stop_list)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"HDR bracket failed: {e}")

        def _to_png_b64(img: np.ndarray) -> str:
            ok, buf = cv2.imencode(".png", img)
            if not ok:
                raise RuntimeError("PNG encode failed")
            return base64.b64encode(buf.tobytes()).decode("ascii")

        # Mertens exposure fusion — expects a list of uint8 BGR/gray frames.
        try:
            merger = cv2.createMergeMertens()
            fused_f = merger.process(frames)  # float32 HxWx3, roughly [0,1]
            fused_u8 = np.clip(fused_f * 255.0, 0, 255).astype(np.uint8)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Mertens merge failed: {e}")

        return {
            "baseline_exposure_us": baseline,
            "stops": stop_list,
            "exposures_us": [baseline * (2.0 ** s) for s in stop_list],
            "mean_intensity": [float(f.mean()) for f in frames],
            "frames_png_b64": [_to_png_b64(f) for f in frames],
            "merged_png_b64": _to_png_b64(fused_u8),
            "width": int(frames[0].shape[1]),
            "height": int(frames[0].shape[0]),
        }

    @router.post("/zstack/reset")
    async def zstack_reset():
        with lock:
            session.reset()
            return {"session_id": session.id, "frame_count": 0}

    return router
