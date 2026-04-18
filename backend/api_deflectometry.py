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

from . import calibration_store
from .cameras.base import BaseCamera
from .vision.mask_utils import rasterize_polygon_mask
from .vision.deflectometry import (
    build_calibration_session,
    compute_modulation,
    compute_rig_fingerprint,
    compute_wrapped_phase,
    create_modulation_mask,
    build_response_lut,
    cascade_unwrap,
    find_optimal_smooth_sigma,
    fit_sphere_calibration,
    frankot_chellappa,
    is_calibration_session_valid,
    phase_stats,
    pseudocolor_png_b64,
    diverging_png_b64,
    remove_tilt,
    unwrap_phase,
    compute_slope_magnitude,
    compute_curl_residual,
    compute_quality_summary,
    analyze_display_check,
    wrap_deflectometry_result,
    CAPTURE_STYLES,
    DEFAULT_CONSISTENCY_THRESHOLD,
    DEFAULT_MULTI_FREQ_PERIODS,
)
from .vision.deflectometry_compute import (
    compute_geometric_slopes,
    fit_paraboloid_with_uncertainty,
    propagate_uncertainty_to_um,
    resolve_geometry_inputs,
)


_ENVELOPE_CACHE_CAP = 20

# Envelope keys that are additive on /compute responses (whitelist used to
# build the response without leaking the heavy numpy grids).
_ENVELOPE_RESPONSE_FIELDS = (
    "id", "origin", "source_ids", "captured_at",
    "calibration_snapshot", "geometry", "tuning",
    "aperture_recipe", "warnings",
    # Phase 4 Wave 3 additions — small scalar/dict metadata; the heavy
    # ``surface_hits_world_grid`` stays off the compute response.
    "slope_method", "paraboloid_fit", "uncertainty_um",
    # Honesty milestone (A1): split phase vs slope products. These are
    # rendered PNG strings + small stats dicts, safe to include on the
    # response.
    "slope_x_png_b64", "slope_y_png_b64",
    "stats_phase_x", "stats_phase_y",
    "stats_slope_x", "stats_slope_y",
)


def _envelope_to_json_safe(env: dict) -> dict:
    """Recursively convert numpy arrays / scalars / NaN to JSON-safe values.

    Numpy arrays become nested lists; boolean masks become 0/1 ints; NaN
    becomes None; numpy scalars become their Python equivalents.
    """

    def _convert(value):
        if value is None:
            return None
        if isinstance(value, np.ndarray):
            if value.dtype == bool:
                return value.astype(np.int8).tolist()
            arr = value
            if np.issubdtype(arr.dtype, np.floating):
                out = np.where(np.isnan(arr), None, arr.astype(object))
                return out.tolist()
            return arr.tolist()
        if isinstance(value, (np.floating,)):
            f = float(value)
            return None if math.isnan(f) else f
        if isinstance(value, (np.integer,)):
            return int(value)
        if isinstance(value, (np.bool_,)):
            return bool(value)
        if isinstance(value, float):
            return None if math.isnan(value) else value
        if isinstance(value, dict):
            return {k: _convert(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_convert(v) for v in value]
        return value

    return _convert(env)


def _reject_hosted(request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Deflectometry is not available in hosted mode")


class _Session:
    """In-memory state for one active deflectometry session.

    Frame ordering convention in ``self.frames`` depends on ``capture_style``:

    ``capture_style == "fast"`` (legacy, 16 frames)::
        frames[0..7]   : freq=self.freq, orientation X, phases 0..7
        frames[8..15]  : freq=self.freq, orientation Y, phases 0..7

    ``capture_style == "multi_freq"`` (16 × len(periods) frames)::
        for each period p in self.periods (coarsest → finest):
            frames[base+0..7]  : freq=p, orientation X, phases 0..7
            frames[base+8..15] : freq=p, orientation Y, phases 0..7

    For 3 periods this is 48 frames arranged as::
        [P0 X×8, P0 Y×8, P1 X×8, P1 Y×8, P2 X×8, P2 Y×8]
    """

    def __init__(self, sid: str) -> None:
        self.id: str = sid
        self.ws: Optional[WebSocket] = None
        self.pending_acks: dict[int, asyncio.Event] = {}
        # Flat list of captured frames; see class docstring for the ordering
        # convention per capture_style.
        self.frames: list[np.ndarray] = []
        self.capture_style: str = "multi_freq"
        self.periods: tuple[int, ...] = tuple(DEFAULT_MULTI_FREQ_PERIODS)
        self.last_result: Optional[dict] = None
        self.last_envelope: Optional[dict] = None
        self._envelope_cache: dict[str, dict] = {}
        self._envelope_order: list[str] = []
        self.flat_white: Optional[np.ndarray] = None
        self.flat_black: Optional[np.ndarray] = None
        self.ref_phase_x: Optional[np.ndarray] = None
        self.ref_phase_y: Optional[np.ndarray] = None
        self.cal_factor: Optional[float] = None  # phase-rad → mm
        self.freq: int = 16  # fringe frequency used during last fast capture
        self.inverse_lut: Optional[np.ndarray] = None  # 256-entry uint8 LUT
        # Bound CalibrationSession (disk-persisted envelope). Set via the
        # /deflectometry/calibrations/bind/{id} endpoint after the wizard
        # completes. None = no cal session bound to this live session.
        self.active_cal_session_id: Optional[str] = None
        # Phase 3B Wave 2: stashed ball-calibration samples pending solve.
        # Each entry is a dict matching the BallSampleBody shape plus the
        # grids resolved from the referenced envelope at add-time.
        self.ball_samples: list[dict] = []
        # Honesty milestone: user-asserted specimen-to-camera distance (mm).
        # Set by profile load or carried on the body; /compute consults this
        # when the body does not override. None → geometric mode locked out.
        self.surface_distance_mm: float | None = None
        # Serializes capture-sequence so two concurrent runs can't interleave
        self.lock: asyncio.Lock = asyncio.Lock()

    def clear_capture(self) -> None:
        # NOTE: flat_white / flat_black and ref_phase_x / ref_phase_y persist
        # across resets — they are only recaptured explicitly. _envelope_cache
        # also persists so previously-fetched results stay retrievable.
        self.frames = []
        self.last_result = None
        self.last_envelope = None
        self.capture_style = "multi_freq"
        self.periods = tuple(DEFAULT_MULTI_FREQ_PERIODS)

    def cache_envelope(self, env: dict) -> None:
        eid = env.get("id")
        if not eid:
            return
        if eid in self._envelope_cache:
            try:
                self._envelope_order.remove(eid)
            except ValueError:
                pass
        self._envelope_cache[eid] = env
        self._envelope_order.append(eid)
        while len(self._envelope_order) > _ENVELOPE_CACHE_CAP:
            evicted = self._envelope_order.pop(0)
            self._envelope_cache.pop(evicted, None)

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


class MaskPolygon(BaseModel):
    vertices: list[tuple[float, float]]
    include: bool = True


class ComputeBody(BaseModel):
    mask_threshold: float = Field(default=0.02, ge=0.0, le=0.5)
    smooth_sigma: float = Field(default=0.0, ge=0.0, le=10.0)
    mask_polygons: list[MaskPolygon] | None = None
    # Phase 4 Wave 3: slope-solver selector. None → auto (geometric if
    # available, phase_proxy otherwise). Explicit values force the branch.
    slope_method: str | None = None
    # Phase 4 Wave 3: optional lateral calibration hint (px/mm) for the
    # paraboloid fit. When None, resolved from the bound CalibrationSession
    # or defaults to 1.0 (treating pixels as the mm unit).
    pixels_per_mm: float | None = Field(default=None, gt=0)
    # Phase 4 Wave 3: optional explicit screen distance hint (mm).
    screen_distance_mm: float | None = Field(default=None, gt=0)
    # Honesty milestone: user-asserted specimen-to-camera distance along the
    # optical axis (mm). When supplied, unlocks geometric mode (combined with
    # the other geometry completeness checks). See
    # ``resolve_geometry_inputs`` docstring for the exact convention.
    surface_distance_mm: float | None = Field(default=None, gt=0, le=2000)


class CaptureBody(BaseModel):
    # ``freq`` is only honored when capture_style='fast' (legacy single-freq).
    freq: int = Field(default=16, ge=1, le=256)
    averages: int = Field(default=3, ge=1, le=10)
    gamma: float = Field(default=2.2, ge=1.0, le=3.0)
    capture_style: str = Field(default="multi_freq")
    # Optional list of fringe periods for multi_freq mode. None → default
    # (DEFAULT_MULTI_FREQ_PERIODS). MUST be strictly ascending positive ints
    # (coarsest → finest). Ignored when capture_style='fast'.
    periods: list[int] | None = None


class CaptureReferenceBody(BaseModel):
    freq: int = Field(default=16, ge=1, le=256)
    averages: int = Field(default=3, ge=1, le=10)
    gamma: float = Field(default=2.2, ge=1.0, le=3.0)
    capture_style: str = Field(default="multi_freq")
    periods: list[int] | None = None


class HeightmapBody(BaseModel):
    mask_threshold: float = Field(default=0.02, ge=0.0, le=0.5)
    smooth_sigma: float = Field(default=0.0, ge=0.0, le=10.0)
    mask_polygons: list[MaskPolygon] | None = None


class CalibrateSphereBody(BaseModel):
    sphere_diameter_mm: float = Field(gt=0)
    px_per_mm: float = Field(gt=0)


class DiagnosticsBody(BaseModel):
    smooth_sigma: float = Field(default=0.0, ge=0.0, le=10.0)
    mask_polygons: list[MaskPolygon] | None = None


class ExportRunBody(BaseModel):
    pass


class ProfileDisplay(BaseModel):
    model: str = ""
    pixel_pitch_mm: float = Field(default=0.0962, gt=0)

class ProfileCapture(BaseModel):
    freq: int = 16
    averages: int = 3
    gamma: float = 2.2
    # Capture style: "multi_freq" (default, ~24s, recommended) or "fast" (~8s).
    # multi_freq uses cascade-unwrapping across 3 fringe periods for robust phase
    # extraction; fast uses a single period (legacy 16-frame). Older profiles
    # without this field default to "multi_freq" per Phase 2 plan decision #4.
    capture_style: str = "multi_freq"

class ProfileProcessing(BaseModel):
    mask_threshold: float = 0.02
    smooth_sigma: float = 0.0

class ProfileGeometry(BaseModel):
    notes: str = ""
    # Honesty milestone: persisted user-asserted specimen-to-camera distance.
    # When a profile is loaded, this value is stashed on the live session so
    # subsequent /compute calls auto-pick it up (body override still wins).
    surface_distance_mm: float | None = Field(default=None, gt=0, le=2000)

class ProfileCalibration(BaseModel):
    cal_factor: float | None = None
    sphere_diameter_mm: float | None = None

class ProfileUI(BaseModel):
    # Default tab to switch to when this profile is loaded.
    # One of: "height", "x_slope", "y_slope", "slope_mag", "curl", "diag".
    default_tab: str = "height"

class DeflectometryProfile(BaseModel):
    name: str
    display: ProfileDisplay = ProfileDisplay()
    capture: ProfileCapture = ProfileCapture()
    processing: ProfileProcessing = ProfileProcessing()
    geometry: ProfileGeometry = ProfileGeometry()
    calibration: ProfileCalibration = ProfileCalibration()
    ui: ProfileUI = ProfileUI()

class LoadProfileBody(BaseModel):
    name: str


class SaveCalibrationBody(BaseModel):
    rig_fingerprint: str
    display_response: dict | None = None
    corner_check: dict | None = None
    sphere_cal: dict | None = None
    reference_flat: dict | None = None
    screen_shape: dict | None = None
    # Snapshot of the microscope-mode lateral calibration at save time.
    # Expected shape: {"pixels_per_mm": float, "calibrated_at": iso8601 | None,
    # "source": "microscope_mode_cal"}. The frontend sources pixels_per_mm
    # from state.calibration (microscope-mode cal); None means the user never
    # ran microscope cal before the wizard.
    microscope_calibration: dict | None = None
    notes: str = ""


class AutoRebindBody(BaseModel):
    rig_fingerprint: str
    # Microscope mm/px (from state.calibration.pixelsPerMm on the frontend).
    # Used to detect drift between the saved cal session and the current
    # microscope cal — emits a warning in the response if they differ.
    microscope_px_per_mm: float | None = None
    # These aren't strictly required by the endpoint (we match by rig
    # fingerprint only) but are carried so the frontend can pass the same
    # rig descriptor as its /rig-fingerprint call without a second trip.
    display_model: str | None = None
    pixel_pitch_mm: float | None = None


class ScreenShapeBody(BaseModel):
    """Accepts a serialized ScreenShape dict. Self-describing via ``kind``.

    ``model_config = {"extra": "allow"}`` so callers may include any
    kind-specific fields (control_uv, control_xyz_mm, residual_rms_mm,
    calibrated_at, schema_version, ...) without having to enumerate them.
    Validation of the shape itself happens in ``ScreenShape.from_dict``.
    """
    model_config = {"extra": "allow"}
    kind: str
    width_mm: float
    height_mm: float


# ---------------------------------------------------------------------------
# Phase 3B Wave 2: ball calibration request models
# ---------------------------------------------------------------------------


class DetectBallBody(BaseModel):
    envelope_id: str
    center_hint_px: tuple[float, float] | None = None
    radius_hint_px: float | None = None
    min_radius_px: int = Field(default=30, ge=5, le=2000)
    max_radius_px: int = Field(default=400, ge=10, le=4000)


class BallSampleBody(BaseModel):
    envelope_id: str
    ball_diameter_mm: float = Field(gt=0)
    ball_center_px: tuple[float, float]
    ball_radius_px: float = Field(gt=0)
    ball_position_world_mm: tuple[float, float, float] | None = None
    label: str = ""


class CalibrateScreenShapeBody(BaseModel):
    camera_model: dict
    camera_pose: dict
    screen_width_mm: float = Field(gt=0)
    screen_height_mm: float = Field(gt=0)
    estimated_screen_distance_mm: float = Field(gt=0)
    estimated_screen_rotation: dict | None = None
    stage2_min_control_points: int = Field(default=25, ge=4, le=10000)
    stage2_grid_size: int = Field(default=16, ge=4, le=128)
    modulation_floor: float = Field(default=0.02, ge=0.0, le=1.0)
    consistency_floor: float = Field(default=0.6, ge=0.0, le=1.0)


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

    def _current_cal_session_summary(s: _Session | None) -> dict | None:
        """Load the currently-bound CalibrationSession and reduce to summary.

        Returns None if no session is bound, or if the bound id is no longer
        on disk (e.g. it was deleted out from under the live session).
        """
        if s is None or s.active_cal_session_id is None:
            return None
        loaded = calibration_store.load_calibration_session(s.active_cal_session_id)
        if loaded is None:
            return None
        return {
            "id": loaded.get("id"),
            "captured_at": loaded.get("captured_at"),
            "completeness": loaded.get("completeness"),
            "rig_fingerprint": loaded.get("rig_fingerprint"),
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
                "display_linearization": "gamma",
                "last_result": None,
                "active_cal_session": None,
            }
        return {
            "session_id": s.id,
            "ipad_connected": s.ws is not None,
            "captured_count": len(s.frames),
            "has_result": s.last_result is not None,
            "has_flat_field": s.flat_white is not None and s.flat_black is not None,
            "has_display_cal": s.inverse_lut is not None,
            "display_linearization": (
                "lut" if s.inverse_lut is not None else "gamma"
            ),
            "has_reference": s.ref_phase_x is not None,
            "cal_factor": s.cal_factor,
            "last_result": s.last_result,
            "active_cal_session": _current_cal_session_summary(s),
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

        Capture-style aware:

        * "fast": single-period captures (16 frames). Uses ``np.unwrap`` along
          the varying axis. Consistency maps are all-ones.
        * "multi_freq": len(periods) periods × 16 frames. Per-orientation
          wrapped phases are fed through :func:`cascade_unwrap` to produce
          an unambiguous absolute phase plus a per-pixel consistency map.
          The **finest-period** frames are returned as ``frames_x/frames_y``
          so modulation, clipping, and other quality metrics are computed
          against the highest-fidelity data.

        Returns
        -------
        (unw_x, unw_y, frames_x, frames_y,
         consistency_x, consistency_y,
         wraps_x_per_period, wraps_y_per_period)
        """
        def _to_gray(f: np.ndarray) -> np.ndarray:
            arr = np.asarray(f, dtype=np.float64)
            if arr.ndim == 3:
                arr = arr.mean(axis=-1)
            return arr

        def _flat_field(frames: list[np.ndarray]) -> list[np.ndarray]:
            if s.flat_white is None or s.flat_black is None:
                return frames
            white = _to_gray(s.flat_white)
            black = _to_gray(s.flat_black)
            denom = white - black + 1e-6
            return [(f - black) / denom for f in frames]

        def _smooth(frames: list[np.ndarray]) -> list[np.ndarray]:
            if smooth_sigma <= 0:
                return frames
            from scipy.ndimage import gaussian_filter
            return [gaussian_filter(f, sigma=smooth_sigma) for f in frames]

        if s.capture_style == "multi_freq":
            periods = list(s.periods)
            n_periods = len(periods)
            expected = 16 * n_periods
            if len(s.frames) < expected:
                raise HTTPException(
                    400,
                    detail=(
                        f"Need {expected} frames for multi_freq "
                        f"({n_periods} periods × 16), have {len(s.frames)}"
                    ),
                )
            wraps_x: list[np.ndarray] = []
            wraps_y: list[np.ndarray] = []
            frames_x_last: list[np.ndarray] = []
            frames_y_last: list[np.ndarray] = []
            for i in range(n_periods):
                base = 16 * i
                fx = [_to_gray(f) for f in s.frames[base:base + 8]]
                fy = [_to_gray(f) for f in s.frames[base + 8:base + 16]]
                fx = _flat_field(fx)
                fy = _flat_field(fy)
                fx = _smooth(fx)
                fy = _smooth(fy)
                wraps_x.append(compute_wrapped_phase(fx))
                wraps_y.append(compute_wrapped_phase(fy))
                if i == n_periods - 1:
                    frames_x_last = fx
                    frames_y_last = fy

            casc_x, cons_x = cascade_unwrap(wraps_x, periods)
            casc_y, cons_y = cascade_unwrap(wraps_y, periods)
            unw_x = remove_tilt(casc_x)
            unw_y = remove_tilt(casc_y)
            return (
                unw_x, unw_y, frames_x_last, frames_y_last,
                cons_x, cons_y, wraps_x, wraps_y,
            )

        # Fast (legacy single-freq) path.
        frames_x = [_to_gray(f) for f in s.frames[:8]]
        frames_y = [_to_gray(f) for f in s.frames[8:16]]
        frames_x = _flat_field(frames_x)
        frames_y = _flat_field(frames_y)
        frames_x = _smooth(frames_x)
        frames_y = _smooth(frames_y)

        wrap_x = compute_wrapped_phase(frames_x)
        wrap_y = compute_wrapped_phase(frames_y)
        unw_x = remove_tilt(unwrap_phase(wrap_x, orientation="x"))
        unw_y = remove_tilt(unwrap_phase(wrap_y, orientation="y"))

        cons_x = np.ones_like(unw_x)
        cons_y = np.ones_like(unw_y)
        return (
            unw_x, unw_y, frames_x, frames_y,
            cons_x, cons_y, [wrap_x], [wrap_y],
        )

    def _resolve_periods(capture_style: str, body_freq: int,
                         body_periods: list[int] | None) -> list[int]:
        """Resolve the period list used for a capture given the body args.

        fast        → [body_freq] (single period).
        multi_freq  → body_periods if provided else DEFAULT_MULTI_FREQ_PERIODS.

        Validates: strictly ascending positive ints. Raises HTTPException 422
        on invalid input.
        """
        if capture_style == "fast":
            return [int(body_freq)]
        if capture_style == "multi_freq":
            periods = (
                list(body_periods) if body_periods is not None
                else list(DEFAULT_MULTI_FREQ_PERIODS)
            )
            if not periods:
                raise HTTPException(422, detail="periods must be non-empty")
            prev = 0
            for p in periods:
                if not isinstance(p, int) or p <= 0:
                    raise HTTPException(
                        422, detail=f"periods must be positive ints, got {periods}"
                    )
                if p <= prev:
                    raise HTTPException(
                        422,
                        detail=(
                            f"periods must be strictly ascending (coarsest → finest), "
                            f"got {periods}"
                        ),
                    )
                prev = p
            return periods
        raise HTTPException(
            422,
            detail=(
                f"capture_style must be one of {list(CAPTURE_STYLES)}, "
                f"got {capture_style!r}"
            ),
        )

    @router.post("/deflectometry/capture-reference", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_capture_reference(body: CaptureReferenceBody):
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")

        if body.capture_style not in CAPTURE_STYLES:
            raise HTTPException(
                422,
                detail=(
                    f"capture_style must be one of {list(CAPTURE_STYLES)}, "
                    f"got {body.capture_style!r}"
                ),
            )
        periods = _resolve_periods(body.capture_style, body.freq, body.periods)

        phases = [k * math.pi / 4.0 for k in range(8)]

        async with s.lock:
            # Sync LUT (or lut_clear) to the iPad so the reference capture
            # uses the same display-linearization path as subsequent runs.
            await _sync_lut_to_ipad(s)
            ref_frames: list[np.ndarray] = []
            pid = 0
            for period in periods:
                for orientation in ("x", "y"):
                    for phase in phases:
                        pid += 1
                        await _push_and_wait(
                            s,
                            {
                                "type": "pattern",
                                "pattern_id": pid,
                                "freq": int(period),
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
        orig_style = s.capture_style
        orig_periods = s.periods
        s.frames = ref_frames
        s.capture_style = body.capture_style
        s.periods = tuple(periods)
        try:
            unw_x, unw_y, *_ = _compute_unwrapped(s)
        finally:
            s.frames = orig_frames
            s.last_result = orig_result
            s.capture_style = orig_style
            s.periods = orig_periods

        s.ref_phase_x = unw_x
        s.ref_phase_y = unw_y

        # If a CalibrationSession is already bound, persist the ref arrays
        # to its .npz sidecar so a server restart can restore them via
        # /auto-rebind. If not bound yet (wizard hasn't saved), the arrays
        # live only on the live session until save_calibration picks them up.
        if s.active_cal_session_id:
            try:
                calibration_store.save_reference_flat(
                    s.active_cal_session_id, s.ref_phase_x, s.ref_phase_y,
                )
            except Exception:
                import logging as _logging
                _logging.getLogger(__name__).exception(
                    "failed to persist reference_flat for bound session %s",
                    s.active_cal_session_id,
                )

        # Return iPad to centering pattern
        if s.ws is not None:
            await s.ws.send_json({"type": "centering"})

        return {
            "status": "ok",
            "has_reference": True,
            "capture_style": body.capture_style,
            "periods": list(periods),
        }

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

    # Reserved pattern_id used for LUT sync messages (both "lut" push and
    # "lut_clear"). Distinct from the per-frame pattern counter so ack
    # routing can't collide with a capture frame.
    _LUT_PATTERN_ID = 7000

    async def _sync_lut_to_ipad(s: _Session, timeout_s: float = 2.0) -> None:
        """Push the current inverse LUT (or lut_clear) to the iPad.

        If ``s.inverse_lut`` is populated, sends {"type": "lut", "inverse_lut": [...]}
        and awaits ack. Otherwise sends {"type": "lut_clear"} so a previously
        configured LUT on the iPad is discarded.

        Safe to call without an iPad attached — silently no-ops.
        """
        if s.ws is None:
            return
        if s.inverse_lut is not None:
            lut = np.asarray(s.inverse_lut).astype(int).tolist()
            payload = {
                "type": "lut",
                "pattern_id": _LUT_PATTERN_ID,
                "inverse_lut": lut,
            }
        else:
            payload = {"type": "lut_clear", "pattern_id": _LUT_PATTERN_ID}
        # Use a short settle time — the iPad just stores the LUT, there's
        # nothing to stabilize on screen.
        await _push_and_wait(s, payload, timeout_s=timeout_s, settle_s=0.0)

    @router.post("/deflectometry/capture-sequence", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_capture_sequence(body: CaptureBody):
        # Validate body before checking session / ws state so invalid input
        # surfaces as 422 regardless of pairing status.
        if body.capture_style not in CAPTURE_STYLES:
            raise HTTPException(
                422,
                detail=(
                    f"capture_style must be one of {list(CAPTURE_STYLES)}, "
                    f"got {body.capture_style!r}"
                ),
            )
        periods = _resolve_periods(body.capture_style, body.freq, body.periods)

        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")

        phases = [k * math.pi / 4.0 for k in range(8)]

        async with s.lock:
            # Start of a new capture wipes any previous frames/result. The
            # frame-count invariant depends on capture_style (see _Session).
            s.frames = []
            s.last_result = None
            s.capture_style = body.capture_style
            s.periods = tuple(periods)
            s.freq = int(periods[-1])  # finest period, for auto-smooth / legacy
            # Sync the calibrated display LUT (or lut_clear) to the iPad
            # before the capture loop so every pattern is rendered through
            # the correct response-linearization path.
            await _sync_lut_to_ipad(s)
            pid = 0
            for period in periods:
                for orientation in ("x", "y"):
                    for phase in phases:
                        pid += 1
                        await _push_and_wait(
                            s,
                            {
                                "type": "pattern",
                                "pattern_id": pid,
                                "freq": int(period),
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

        return {
            "captured_count": len(s.frames),
            "capture_style": s.capture_style,
            "periods": list(s.periods),
        }

    @router.post("/deflectometry/compute", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_compute(body: ComputeBody = ComputeBody()):  # noqa: B008
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        expected_frames = (
            16 * len(s.periods) if s.capture_style == "multi_freq" else 16
        )
        if len(s.frames) < expected_frames:
            raise HTTPException(
                400,
                detail=(
                    f"Need {expected_frames} captured frames before compute "
                    f"(have {len(s.frames)}, capture_style={s.capture_style})"
                ),
            )
        # Validate slope_method up-front — either None (auto), "geometric",
        # or "phase_proxy".
        if body.slope_method is not None and body.slope_method not in (
            "geometric", "phase_proxy",
        ):
            raise HTTPException(
                422,
                detail=(
                    "slope_method must be 'geometric', 'phase_proxy', or None "
                    f"(auto), got {body.slope_method!r}"
                ),
            )

        (
            unw_x, unw_y, frames_x, frames_y,
            cons_x, cons_y, wraps_x_per_period, wraps_y_per_period,
        ) = _compute_unwrapped(s, smooth_sigma=body.smooth_sigma)

        # Reference subtraction
        has_reference = False
        if s.ref_phase_x is not None and s.ref_phase_y is not None:
            if s.ref_phase_x.shape == unw_x.shape and s.ref_phase_y.shape == unw_y.shape:
                unw_x = unw_x - s.ref_phase_x
                unw_y = unw_y - s.ref_phase_y
                has_reference = True

        # Modulation-based masking (uses finest-period frames)
        mod_x = compute_modulation(frames_x)
        mod_y = compute_modulation(frames_y)
        modulation_mask = create_modulation_mask(
            mod_x, mod_y, threshold_frac=body.mask_threshold
        )

        # Combine X and Y consistency into a single worst-case map.
        phase_consistency = np.minimum(cons_x, cons_y)

        # Base trusted mask is modulation ∩ (consistency ≥ threshold).
        # For fast captures consistency is all-ones so this collapses to modulation.
        consistency_ok = phase_consistency >= DEFAULT_CONSISTENCY_THRESHOLD
        mask = modulation_mask & consistency_ok

        # Intersect with user-drawn mask if provided
        if body.mask_polygons:
            ih, iw = mask.shape
            user_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )
            mask = mask & user_mask

        mask_valid_frac = float(mask.sum()) / float(mask.size) if mask.size > 0 else 0.0

        # ── Phase 4 Wave 3: pick the slope-solver branch ────────────────
        # Resolve user-asserted surface distance: body field wins, otherwise
        # whatever the last loaded profile stashed on the session.
        effective_surface_distance_mm = body.surface_distance_mm
        if effective_surface_distance_mm is None:
            effective_surface_distance_mm = getattr(s, "surface_distance_mm", None)

        geom = resolve_geometry_inputs(
            s,
            pixels_per_mm=body.pixels_per_mm,
            screen_distance_mm=body.screen_distance_mm,
            surface_distance_mm=effective_surface_distance_mm,
        )
        if body.slope_method == "geometric":
            use_geometric = bool(geom["geometry_complete"])
            if not use_geometric:
                raise HTTPException(
                    400,
                    detail=(
                        "slope_method='geometric' requested but geometry is "
                        "incomplete — bind a CalibrationSession with sphere_cal, "
                        "provide pixels_per_mm, and supply surface_distance_mm "
                        "(the specimen-to-camera distance along the optical axis)."
                    ),
                )
        elif body.slope_method == "phase_proxy":
            use_geometric = False
        else:
            # Auto-select: use geometric if available.
            use_geometric = bool(geom["geometry_complete"])

        paraboloid_fit: dict | None = None
        uncertainty_um: dict | None = None
        surface_hits_world: np.ndarray | None = None

        # Frequency used for phase→screen-uv normalization in the
        # geometric path. For multi_freq the cascade output scales to the
        # finest period; for fast it's s.freq.
        finest_freq = float(
            s.periods[-1] if s.capture_style == "multi_freq" else s.freq
        )

        if use_geometric:
            try:
                slope_x_grid, slope_y_grid, surface_hits_world, geom_valid = (
                    compute_geometric_slopes(
                        phase_x=unw_x,
                        phase_y=unw_y,
                        trusted_mask=mask,
                        camera_model=geom["camera_model"],
                        camera_pose=geom["camera_pose"],
                        screen_shape=geom["screen_shape"],
                        screen_pose=geom["screen_pose"],
                        surface_plane_point=geom["surface_plane"]["point"],
                        surface_plane_normal=geom["surface_plane"]["normal"],
                        freq=finest_freq,
                    )
                )
            except Exception as exc:  # defensive: bad geometry → fall back
                slope_x_grid = unw_x
                slope_y_grid = unw_y
                slope_method = "phase_proxy"
                use_geometric = False
                # Re-run with the legacy path below; record the reason so
                # ``quality.warnings`` surfaces it after the summary is built.
                fallback_reason = f"geometric path failed: {exc}"
            else:
                slope_method = "geometric"
                # Intersect trusted mask with the chain-valid mask so
                # downstream slope/curl/quality reflect only good pixels.
                mask = mask & geom_valid
                fallback_reason = None
        else:
            slope_x_grid = unw_x
            slope_y_grid = unw_y
            slope_method = "phase_proxy"
            fallback_reason = None

        # Slope magnitude and curl residual (on whichever slopes we picked)
        slope_mag = compute_slope_magnitude(slope_x_grid, slope_y_grid, mask=mask)
        curl = compute_curl_residual(slope_x_grid, slope_y_grid, mask=mask)

        # Quality summary (always uses current slope fields — same shape)
        quality = compute_quality_summary(
            slope_x_grid, slope_y_grid, mask, mod_x, mod_y, frames_x, frames_y,
        )
        if fallback_reason:
            quality.setdefault("warnings", []).append(fallback_reason)

        # Paraboloid fit + uncertainty (geometric path only).
        if slope_method == "geometric":
            ppm_fit = geom["pixels_per_mm"] or body.pixels_per_mm or 1.0
            try:
                paraboloid_fit = fit_paraboloid_with_uncertainty(
                    slope_x_grid=slope_x_grid,
                    slope_y_grid=slope_y_grid,
                    mask=mask,
                    pixels_per_mm=float(ppm_fit),
                )
            except ValueError as exc:
                paraboloid_fit = None
                quality.setdefault("warnings", []).append(
                    f"paraboloid fit failed: {exc}"
                )
            if paraboloid_fit is not None:
                # No sphere_cal uncertainty wired yet — pass None for now.
                # Wave-2 will persist a per-cal uncertainty.
                uncertainty_um = propagate_uncertainty_to_um(
                    paraboloid_fit,
                    cal_factor_uncertainty=None,
                    geometric_pose_uncertainty=None,
                )

        # ── Unwrap-jump risk indicator ──────────────────────────────────
        if s.capture_style == "multi_freq":
            if modulation_mask.any():
                bad = (phase_consistency < DEFAULT_CONSISTENCY_THRESHOLD) & modulation_mask
                bad_frac = float(bad.sum()) / float(modulation_mask.sum())
            else:
                bad_frac = 0.0
            if bad_frac > 0.05:
                unwrap_jump_risk = "high"
            elif bad_frac > 0.01:
                unwrap_jump_risk = "medium"
            else:
                unwrap_jump_risk = "low"
            if unwrap_jump_risk == "high":
                quality.setdefault("warnings", []).append(
                    f"{bad_frac*100:.1f}% of in-mask pixels show phase "
                    f"inconsistency across periods — unwrap errors likely."
                )
        else:
            unwrap_jump_risk = "unknown"
        quality["unwrap_jump_risk"] = unwrap_jump_risk

        # A1: split phase vs slope products. Phase PNGs/stats come from the
        # unwrapped-phase grids (``unw_x/unw_y``); slope PNGs/stats come from
        # the selected solver's slope grids (``slope_x_grid/slope_y_grid``).
        # In phase_proxy mode the slope grids ARE aliases of the phase grids,
        # so the rendered slope PNGs look identical — that's correct, because
        # in proxy mode "phase IS the slope proxy".
        stats_phase_x = phase_stats(unw_x, mask=mask)
        stats_phase_y = phase_stats(unw_y, mask=mask)
        stats_slope_x = phase_stats(slope_x_grid, mask=mask)
        stats_slope_y = phase_stats(slope_y_grid, mask=mask)
        result = {
            "phase_x_png_b64": pseudocolor_png_b64(unw_x, mask=mask),
            "phase_y_png_b64": pseudocolor_png_b64(unw_y, mask=mask),
            "slope_x_png_b64": pseudocolor_png_b64(slope_x_grid, mask=mask),
            "slope_y_png_b64": pseudocolor_png_b64(slope_y_grid, mask=mask),
            "slope_mag_png_b64": pseudocolor_png_b64(slope_mag, mask=mask),
            "curl_png_b64": diverging_png_b64(curl, mask=mask),
            # Legacy aliases kept for backward compat: stats_x/stats_y
            # continue to reflect the unwrapped-phase grid (same as
            # stats_phase_x/stats_phase_y).
            "stats_x": stats_phase_x,
            "stats_y": stats_phase_y,
            "stats_phase_x": stats_phase_x,
            "stats_phase_y": stats_phase_y,
            "stats_slope_x": stats_slope_x,
            "stats_slope_y": stats_slope_y,
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
        # A2: also cache the slope grids the solver actually picked, so
        # /heightmap integrates the same branch /compute selected. In
        # phase_proxy mode the grids alias the phase grids (no-op); in
        # geometric mode they are geometry-derived and numerically differ.
        s._last_slope_x = slope_x_grid
        s._last_slope_y = slope_y_grid
        s._last_slope_method = slope_method

        # ── Phase 0: build the DeflectometryResult envelope ─────────────
        style_tag = "fast" if s.capture_style == "fast" else "multi_freq"
        calibration_snapshot = {
            "cal_factor": s.cal_factor,
            "has_flat_field": s.flat_white is not None,
            "has_reference": s.ref_phase_x is not None,
            "has_display_lut": s.inverse_lut is not None,
            "display_linearization": (
                "lut" if s.inverse_lut is not None else "gamma"
            ),
            "freq": s.freq,
        }
        # Report geometry from the Phase-4 resolver so the envelope carries
        # the same view the slope solver used. When the geometry is
        # incomplete we leave these fields null to preserve the Phase-0
        # envelope contract — callers shouldn't see placeholder poses
        # leak through the wire as if they were real cal data.
        if geom["geometry_complete"]:
            geometry = {
                "screen_pose": geom["screen_pose"].as_dict(),
                "camera_pose": geom["camera_pose"].as_dict(),
                "surface_pose": None,  # not yet modelled as SE(3)
                "screen_distance_mm": geom.get("screen_distance_mm"),
                "surface_distance_mm": geom.get("surface_distance_mm"),
            }
        else:
            geometry = {
                "screen_pose": None,
                "camera_pose": None,
                "surface_pose": None,
                "screen_distance_mm": None,
                "surface_distance_mm": None,
            }
        tuning = {
            "freq": s.freq,
            "smooth_sigma": body.smooth_sigma,
            "mask_threshold": body.mask_threshold,
            "capture_style": style_tag,
            "periods": list(s.periods),
            "slope_method": slope_method,
        }
        # Augment the calibration snapshot with a geometry-complete flag so
        # the UI/exports can tell the branch taken.
        calibration_snapshot["geometry_complete"] = bool(geom["geometry_complete"])
        aperture_recipe = {
            "mask_threshold": body.mask_threshold,
            "polygons": (
                [p.model_dump() for p in body.mask_polygons]
                if body.mask_polygons else None
            ),
        }

        envelope = dict(result)
        envelope["phase_x_grid"] = unw_x
        envelope["phase_y_grid"] = unw_y
        envelope["modulation_x_grid"] = mod_x
        envelope["modulation_y_grid"] = mod_y
        # Phase 4 Wave 3: slope grids now honor the selected solver.
        envelope["slope_x_grid"] = slope_x_grid
        envelope["slope_y_grid"] = slope_y_grid
        envelope["trusted_mask_grid"] = mask
        envelope["display_phase_x_grid"] = unw_x
        envelope["display_phase_y_grid"] = unw_y
        # ── Phase 2 / Track 1 additions ─────────────────────────────────
        envelope["phase_consistency_grid"] = phase_consistency
        envelope["phase_x_grid_per_period"] = list(wraps_x_per_period)
        envelope["phase_y_grid_per_period"] = list(wraps_y_per_period)
        envelope["periods_used"] = list(s.periods)
        # ── Phase 4 Wave 3 additions ────────────────────────────────────
        envelope["slope_method"] = slope_method
        envelope["paraboloid_fit"] = paraboloid_fit
        envelope["uncertainty_um"] = uncertainty_um
        if surface_hits_world is not None:
            envelope["surface_hits_world_grid"] = surface_hits_world

        wrap_deflectometry_result(
            envelope,
            origin="capture",
            calibration_snapshot=calibration_snapshot,
            geometry=geometry,
            tuning=tuning,
            aperture_recipe=aperture_recipe,
        )

        s.last_envelope = envelope
        s.cache_envelope(envelope)

        # Additive: surface envelope metadata on the response without
        # ballooning it with the numeric grids. Use .get so newer fields
        # that only exist in some branches (paraboloid_fit, uncertainty_um)
        # default to None rather than raising.
        for field in _ENVELOPE_RESPONSE_FIELDS:
            result[field] = envelope.get(field)
        return result

    @router.get("/deflectometry/result/{result_id}", dependencies=[Depends(_reject_hosted)])
    def deflectometry_get_result(result_id: str):
        s = _current()
        if s is None:
            raise HTTPException(404, detail="No active session")
        env = s._envelope_cache.get(result_id)
        if env is None:
            raise HTTPException(404, detail=f"Result {result_id} not found")
        return _envelope_to_json_safe(env)

    @router.post("/deflectometry/heightmap", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_heightmap(body: HeightmapBody = HeightmapBody()):  # noqa: B008
        import cv2 as cv2_local
        s = _current()
        if s is None or s.last_result is None:
            raise HTTPException(400, detail="Run compute first")

        # A2: integrate the SLOPE grids the solver picked, not the raw
        # unwrapped phase. In phase_proxy mode these alias unw_x/unw_y so
        # behavior is unchanged; in geometric mode this makes the 3D view
        # and the "±µm RMS" headline read from the same data source.
        slope_x_src = getattr(s, "_last_slope_x", None)
        slope_y_src = getattr(s, "_last_slope_y", None)
        slope_method = getattr(s, "_last_slope_method", None)
        if slope_x_src is None or slope_y_src is None:
            # Legacy / defensive: pre-A2 compute results only cached phase.
            slope_x_src = s._last_unw_x
            slope_y_src = s._last_unw_y
            slope_method = slope_method or "phase_proxy"
        # Recompute mask with the requested threshold so the 3D view
        # respects the slider value even if it differs from the last compute.
        # For multi_freq captures the modulation must come from the finest
        # period (the last block of 16 frames), which is what compute uses.
        if s.capture_style == "multi_freq":
            base = 16 * (len(s.periods) - 1)
        else:
            base = 0
        if len(s.frames) >= base + 16:
            def _to_gray(f):
                arr = np.asarray(f, dtype=np.float64)
                return arr.mean(axis=-1) if arr.ndim == 3 else arr
            frames_x = [_to_gray(f) for f in s.frames[base:base + 8]]
            frames_y = [_to_gray(f) for f in s.frames[base + 8:base + 16]]
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

        # Intersect with user-drawn mask if provided
        if body.mask_polygons:
            ih, iw = mask.shape
            user_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )
            mask = mask & user_mask

        height = frankot_chellappa(slope_x_src, slope_y_src, mask=mask)

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
            # A2: surface the slope branch this integration used. Frontend
            # uses this to confirm compute/heightmap branch consistency.
            "slope_method": slope_method,
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

        # Pick the first X-fringe frame at the finest period (this matches
        # s.freq, which represents the finest period in multi_freq mode).
        if s.capture_style == "multi_freq":
            base = 16 * (len(s.periods) - 1)
        else:
            base = 0
        frame = np.asarray(s.frames[base], dtype=np.float64)
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

        # Belt-and-suspenders: push the freshly-measured LUT to the iPad
        # immediately so subsequent captures use it even if the caller
        # skips capture-sequence's own sync step.
        try:
            await _sync_lut_to_ipad(s)
        except HTTPException:
            # iPad dropped or ack timed out — the LUT is still persisted
            # server-side and will be resent on the next capture call.
            pass

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

    @router.post("/deflectometry/check-display", dependencies=[Depends(_reject_hosted)])
    async def check_display():
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")

        async with s.lock:
            msg = {"type": "sanity", "pattern_id": 8000}
            await _push_and_wait(s, msg, timeout_s=5.0)
            frame = camera.get_frame()
            if frame is None:
                raise HTTPException(500, detail="Frame capture failed")
            # Restore centering pattern
            if s.ws is not None:
                await s.ws.send_json({"type": "centering"})

        gray = frame if frame.ndim == 2 else frame.mean(axis=2).astype(np.uint8)
        result = analyze_display_check(gray)
        return result

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
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        expected = 16 * len(s.periods) if s.capture_style == "multi_freq" else 16
        if len(s.frames) < expected:
            raise HTTPException(
                400,
                detail=f"Need {expected} frames (have {len(s.frames)})",
            )

        # For multi_freq, diagnostics inspect the finest-period block, which
        # is what /compute uses for modulation and the final wrapped phase.
        if s.capture_style == "multi_freq":
            base = 16 * (len(s.periods) - 1)
        else:
            base = 0

        out_dir = os.path.join(os.path.dirname(__file__), "..", "poc_output", "deflectometry")
        os.makedirs(out_dir, exist_ok=True)

        def _to_gray(f):
            arr = np.asarray(f, dtype=np.float64)
            return arr.mean(axis=-1) if arr.ndim == 3 else arr

        # Save raw frames as PNGs (from the finest-period block)
        frame_stats = []
        for i, f in enumerate(s.frames[base:base + 16]):
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

        frames_x = [_to_gray(f) for f in s.frames[base:base + 8]]
        frames_y = [_to_gray(f) for f in s.frames[base + 8:base + 16]]

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
        """Return the full DeflectometryResult envelope for the current run.

        Schema v2 (Phase 1): wraps the JSON-safe envelope — including all
        numeric grids — in a small export header for traceability.
        """
        import datetime
        s = _current()
        if s is None or s.last_envelope is None:
            raise HTTPException(400, detail="Run compute first")

        return {
            "schema_version": 2,
            "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "envelope": _envelope_to_json_safe(s.last_envelope),
        }

    @router.get("/deflectometry/profiles", dependencies=[Depends(_reject_hosted)])
    def list_profiles():
        from .config import load_config
        cfg = load_config()
        return cfg.get("deflectometry_profiles", [])

    @router.post("/deflectometry/profiles", dependencies=[Depends(_reject_hosted)])
    def save_profile(profile: DeflectometryProfile):
        from .config import load_config, save_config
        cfg = load_config()
        profiles = cfg.get("deflectometry_profiles", [])
        profiles = [p for p in profiles if p.get("name") != profile.name]
        profiles.append(profile.model_dump())
        save_config({"deflectometry_profiles": profiles,
                      "deflectometry_active_profile": profile.name})
        return profile.model_dump()

    @router.delete("/deflectometry/profiles/{name}", dependencies=[Depends(_reject_hosted)])
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

    @router.post("/deflectometry/profiles/load", dependencies=[Depends(_reject_hosted)])
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
        # Honesty milestone: persist user-asserted surface distance onto
        # the live session so subsequent /compute calls can pick it up
        # without requiring the frontend to thread it through every body.
        if s is not None:
            geom_blk = match.get("geometry") or {}
            raw = geom_blk.get("surface_distance_mm")
            if raw is not None:
                try:
                    val = float(raw)
                    if val > 0:
                        s.surface_distance_mm = val
                except (TypeError, ValueError):
                    pass
        save_config({"deflectometry_active_profile": body.name})
        return match

    # -------------------------------------------------------------------
    # CalibrationSession endpoints — Phase 3A Track A
    # -------------------------------------------------------------------

    @router.get("/deflectometry/calibrations", dependencies=[Depends(_reject_hosted)])
    def list_calibrations(rig_fingerprint: str | None = None):
        """List saved CalibrationSession summaries, newest first.

        Optional query param ``rig_fingerprint`` filters to sessions whose
        fingerprint matches.
        """
        return calibration_store.list_calibration_sessions(rig_fingerprint)

    @router.get("/deflectometry/calibrations/latest", dependencies=[Depends(_reject_hosted)])
    def latest_calibration(rig_fingerprint: str):
        """Return the newest complete-enough session for this rig, or 404."""
        session = calibration_store.latest_for_rig(rig_fingerprint)
        if session is None:
            raise HTTPException(404, detail="No complete CalibrationSession for this rig")
        return session

    @router.get("/deflectometry/calibrations/{session_id}", dependencies=[Depends(_reject_hosted)])
    def get_calibration(session_id: str):
        """Return the full CalibrationSession dict by id, or 404."""
        session = calibration_store.load_calibration_session(session_id)
        if session is None:
            raise HTTPException(404, detail=f"CalibrationSession {session_id!r} not found")
        return session

    @router.post("/deflectometry/calibrations", dependencies=[Depends(_reject_hosted)])
    def save_calibration(body: SaveCalibrationBody):
        """Build + persist a CalibrationSession from the supplied step results.

        If the live session has captured reference-flat phase arrays
        (``s.ref_phase_x/y``) and the wizard is saving a session that
        includes a ``reference_flat`` metadata dict, we also persist the
        arrays to ``data/reference_flat/{id}.npz`` so they survive a
        server restart and can be restored via /auto-rebind.
        """
        session = build_calibration_session(
            display_response=body.display_response,
            corner_check=body.corner_check,
            sphere_cal=body.sphere_cal,
            reference_flat=body.reference_flat,
            screen_shape=body.screen_shape,
            microscope_calibration=body.microscope_calibration,
            rig_fingerprint=body.rig_fingerprint,
            notes=body.notes,
        )
        calibration_store.save_calibration_session(session)
        # Persist ref-flat arrays under this new session id if the wizard
        # captured them during this run. Non-fatal if it fails — the cal
        # session is still usable, just without a ref subtract.
        s = _current()
        if (
            body.reference_flat is not None
            and s is not None
            and s.ref_phase_x is not None
            and s.ref_phase_y is not None
        ):
            try:
                calibration_store.save_reference_flat(
                    session["id"], s.ref_phase_x, s.ref_phase_y,
                )
            except Exception:
                import logging as _logging
                _logging.getLogger(__name__).exception(
                    "failed to persist reference_flat for session %s",
                    session["id"],
                )
        return session

    @router.delete("/deflectometry/calibrations/{session_id}", dependencies=[Depends(_reject_hosted)])
    def delete_calibration(session_id: str):
        """Delete a CalibrationSession by id. 404 if missing.

        Also removes the reference-flat ``.npz`` sidecar (if present) and
        unbinds the live session if it was pointing at this id.
        """
        removed = calibration_store.delete_calibration_session(session_id)
        if not removed:
            raise HTTPException(404, detail=f"CalibrationSession {session_id!r} not found")
        # Reference-flat sidecar is best-effort — absence is normal.
        try:
            calibration_store.delete_reference_flat(session_id)
        except Exception:
            pass
        # If the deleted session was bound to the live session, unbind it.
        s = _current()
        if s is not None and s.active_cal_session_id == session_id:
            s.active_cal_session_id = None
        return {"status": "deleted", "id": session_id}

    @router.get("/deflectometry/rig-fingerprint", dependencies=[Depends(_reject_hosted)])
    def get_current_rig_fingerprint(
        display_model: str = "",
        pixel_pitch_mm: float = 0.0962,
        pixels_per_mm: float | None = None,
        screen_distance_mm: float | None = None,
        microscope_px_per_mm: float | None = None,
    ):
        """Return a rig fingerprint for the caller's current rig inputs.

        Includes the active camera device_id if available; callers do not
        need to pass it. ``microscope_px_per_mm`` participates in the hash;
        pre-3-snapshot sessions saved without it will have different
        fingerprints than post-snapshot sessions — that's intentional, the
        old sessions had no way to warn about microscope cal drift.
        """
        try:
            info = camera.get_info() or {}
            camera_id = info.get("device_id") or info.get("serial")
        except Exception:
            camera_id = None
        fp = compute_rig_fingerprint(
            camera_id=camera_id,
            display_model=display_model,
            display_pixel_pitch_mm=pixel_pitch_mm,
            pixels_per_mm=pixels_per_mm,
            screen_distance_mm=screen_distance_mm,
            microscope_px_per_mm=microscope_px_per_mm,
        )
        return {"rig_fingerprint": fp}

    def _restore_session_state_from_cal(s: _Session, session: dict) -> dict:
        """Rebuild ``s.inverse_lut`` / ``s.cal_factor`` / ``s.ref_phase_x/y``
        from a persisted CalibrationSession envelope.

        Returns a dict of flags ``{"lut": bool, "cal_factor": bool,
        "reference_flat": bool}`` describing which fields were restored
        (useful for telemetry and UI diagnostics).
        """
        restored = {"lut": False, "cal_factor": False, "reference_flat": False}
        # 1) Rebuild display-response LUT from the observed/commanded samples.
        dr = session.get("display_response") or {}
        observed = dr.get("observed")
        commanded = dr.get("commanded")
        if observed is not None and commanded is not None:
            try:
                cmd_arr = np.asarray(commanded, dtype=np.float64)
                obs_arr = np.asarray(observed, dtype=np.float64)
                _fwd, inv = build_response_lut(cmd_arr, obs_arr)
                s.inverse_lut = inv
                restored["lut"] = True
            except Exception:
                import logging as _logging
                _logging.getLogger(__name__).exception(
                    "failed to rebuild inverse LUT for session %s",
                    session.get("id"),
                )
        # 2) Sphere cal → cal_factor (phase rad → mm).
        sphere = session.get("sphere_cal") or {}
        cf = sphere.get("cal_factor")
        if cf is not None:
            try:
                s.cal_factor = float(cf)
                restored["cal_factor"] = True
            except (TypeError, ValueError):
                pass
        # 3) Reference-flat npz sidecar.
        sid = session.get("id")
        if sid:
            ref = calibration_store.load_reference_flat(sid)
            if ref is not None:
                s.ref_phase_x, s.ref_phase_y = ref
                restored["reference_flat"] = True
        return restored

    @router.post("/deflectometry/calibrations/bind/{session_id}", dependencies=[Depends(_reject_hosted)])
    def bind_calibration_to_session(session_id: str):
        """Bind a saved CalibrationSession to the current live _Session.

        Creates a live session on the fly if none exists (the wizard may
        run before /start was ever called). Also restores derived runtime
        state (inverse LUT, cal_factor, ref_phase_x/y) so the live session
        behaves identically to one produced by the wizard end-to-end.
        Returns the bound session summary (same shape as
        status.active_cal_session).
        """
        session = calibration_store.load_calibration_session(session_id)
        if session is None:
            raise HTTPException(404, detail=f"CalibrationSession {session_id!r} not found")
        is_valid, missing = is_calibration_session_valid(session)
        if not is_valid:
            raise HTTPException(
                400,
                detail=(
                    f"CalibrationSession {session_id!r} is incomplete; "
                    f"missing: {', '.join(missing)}"
                ),
            )
        s = _current()
        if s is None:
            sid = uuid.uuid4().hex
            s = _Session(sid)
            state["session"] = s
        s.active_cal_session_id = session_id
        _restore_session_state_from_cal(s, session)
        return {
            "id": session.get("id"),
            "captured_at": session.get("captured_at"),
            "completeness": session.get("completeness"),
            "rig_fingerprint": session.get("rig_fingerprint"),
        }

    @router.post("/deflectometry/auto-rebind", dependencies=[Depends(_reject_hosted)])
    def auto_rebind(body: AutoRebindBody):
        """Find the newest complete CalibrationSession matching the supplied
        rig fingerprint and bind it to the live session.

        Returns::

            {"restored": bool, "session": summary_dict | None, "warnings": [...]}

        On match: rebuilds ``s.inverse_lut`` from
        ``session.display_response.observed/commanded``, sets ``s.cal_factor``
        from ``session.sphere_cal.cal_factor``, and loads
        ``s.ref_phase_x/y`` from the reference-flat .npz sidecar if present.

        If the saved session carries a microscope-cal snapshot and it differs
        from the caller-supplied ``microscope_px_per_mm`` by more than 0.5%,
        a drift warning is included (non-fatal — the bind still happens so
        the user can decide whether to trust or recalibrate).
        """
        session = calibration_store.latest_for_rig(body.rig_fingerprint)
        if session is None:
            return {"restored": False, "session": None, "warnings": []}
        s = _current()
        if s is None:
            sid = uuid.uuid4().hex
            s = _Session(sid)
            state["session"] = s
        s.active_cal_session_id = session.get("id")
        _restore_session_state_from_cal(s, session)
        warnings: list[str] = []
        saved_micro = (session.get("microscope_calibration") or {}).get("pixels_per_mm")
        if (
            body.microscope_px_per_mm is not None
            and saved_micro is not None
        ):
            try:
                a = float(saved_micro)
                b = float(body.microscope_px_per_mm)
                if a > 0 and b > 0:
                    # Relative drift threshold: 0.5%.
                    rel = abs(a - b) / max(a, b)
                    if rel > 0.005:
                        warnings.append(
                            "Microscope calibration changed since this "
                            f"session was saved ({a:.3f} vs {b:.3f} px/mm)"
                        )
            except (TypeError, ValueError):
                pass
        return {
            "restored": True,
            "session": {
                "id": session.get("id"),
                "captured_at": session.get("captured_at"),
                "completeness": session.get("completeness"),
                "rig_fingerprint": session.get("rig_fingerprint"),
            },
            "warnings": warnings,
        }

    # -------------------------------------------------------------------
    # ScreenShape endpoints — Phase 3B+4 Wave 1 Track B
    # -------------------------------------------------------------------

    @router.get("/deflectometry/screen-shape", dependencies=[Depends(_reject_hosted)])
    def get_screen_shape():
        """Return the active ScreenShape as a dict, or None if unset."""
        from . import screen_shape_store
        shape = screen_shape_store.load_screen_shape()
        if shape is None:
            return None
        return shape.as_dict()

    @router.post("/deflectometry/screen-shape", dependencies=[Depends(_reject_hosted)])
    def save_screen_shape_endpoint(body: ScreenShapeBody):
        """Persist a new ScreenShape. Replaces any existing active shape."""
        from . import screen_shape_store
        from .vision.screen_shape import ScreenShape
        try:
            shape = ScreenShape.from_dict(body.model_dump())
        except ValueError as e:
            raise HTTPException(400, detail=str(e))
        except Exception as e:
            raise HTTPException(400, detail=f"invalid screen shape: {e}")
        path = screen_shape_store.save_screen_shape(shape)
        return {"status": "ok", "path": path, "shape": shape.as_dict()}

    @router.delete("/deflectometry/screen-shape", dependencies=[Depends(_reject_hosted)])
    def delete_screen_shape_endpoint():
        """Remove the active ScreenShape (revert to flat default)."""
        from . import screen_shape_store
        removed = screen_shape_store.delete_screen_shape()
        return {"status": "deleted" if removed else "absent"}

    # -------------------------------------------------------------------
    # Ball calibration endpoints — Phase 3B Wave 2
    # -------------------------------------------------------------------

    def _lookup_envelope(s: _Session, envelope_id: str) -> dict:
        env = s._envelope_cache.get(envelope_id)
        if env is None:
            raise HTTPException(
                404,
                detail=(
                    f"Envelope {envelope_id!r} not found in session cache "
                    "(run /deflectometry/compute first, or the cache has "
                    "rolled over)."
                ),
            )
        return env

    @router.post(
        "/deflectometry/detect-ball", dependencies=[Depends(_reject_hosted)]
    )
    def detect_ball(body: DetectBallBody):
        """Run Hough-circle detection on the envelope's modulation map.

        Uses ``min(modulation_x, modulation_y)`` so both orientations must
        be strong where a pixel passes. Returns the top candidate plus a
        base64 PNG overlay for the wizard's confirmation step.
        """
        from .vision.ball_detection import (
            detect_ball_in_modulation,
            render_ball_overlay_png_b64,
        )

        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        env = _lookup_envelope(s, body.envelope_id)
        mod_x = np.asarray(env.get("modulation_x_grid"), dtype=np.float64)
        mod_y = np.asarray(env.get("modulation_y_grid"), dtype=np.float64)
        if mod_x.size == 0 or mod_y.size == 0 or mod_x.shape != mod_y.shape:
            raise HTTPException(
                400,
                detail="Envelope missing modulation grids or shape mismatch",
            )
        modulation = np.minimum(mod_x, mod_y)

        try:
            (cu, cv), radius, score = detect_ball_in_modulation(
                modulation,
                center_hint_px=body.center_hint_px,
                radius_hint_px=body.radius_hint_px,
                min_radius_px=body.min_radius_px,
                max_radius_px=body.max_radius_px,
            )
        except ValueError as e:
            raise HTTPException(400, detail=str(e))

        preview_b64 = render_ball_overlay_png_b64(modulation, (cu, cv), radius)
        return {
            "center_px": [cu, cv],
            "radius_px": radius,
            "score": score,
            "preview_png_b64": preview_b64,
        }

    @router.post(
        "/deflectometry/add-ball-cal-sample",
        dependencies=[Depends(_reject_hosted)],
    )
    def add_ball_cal_sample(body: BallSampleBody):
        """Stash a ball sample with the envelope's grids, ready for solve."""
        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        env = _lookup_envelope(s, body.envelope_id)

        # Extract arrays; tolerate missing grids (consistency may be absent
        # on fast-mode captures — the solver treats it as all-ones).
        try:
            phase_x = np.asarray(env["phase_x_grid"], dtype=np.float64)
            phase_y = np.asarray(env["phase_y_grid"], dtype=np.float64)
        except KeyError:
            raise HTTPException(
                400,
                detail=(
                    f"Envelope {body.envelope_id!r} missing phase grids"
                ),
            )

        periods = env.get("periods_used") or env.get("tuning", {}).get("periods")
        if not periods:
            raise HTTPException(
                400,
                detail="Envelope missing periods_used (cannot compute screen uv)",
            )
        period_fine = float(periods[-1])

        sample = {
            "envelope_id": body.envelope_id,
            "ball_diameter_mm": float(body.ball_diameter_mm),
            "ball_center_px": tuple(body.ball_center_px),
            "ball_radius_px": float(body.ball_radius_px),
            "ball_position_world_mm": (
                tuple(body.ball_position_world_mm)
                if body.ball_position_world_mm is not None
                else (0.0, 0.0, 0.0)
            ),
            "label": body.label,
            "phase_x_grid": phase_x,
            "phase_y_grid": phase_y,
            "modulation_grid": np.minimum(
                np.asarray(env.get("modulation_x_grid", np.ones_like(phase_x)),
                           dtype=np.float64),
                np.asarray(env.get("modulation_y_grid", np.ones_like(phase_y)),
                           dtype=np.float64),
            ),
            "phase_consistency_grid": np.asarray(
                env.get("phase_consistency_grid", np.ones_like(phase_x)),
                dtype=np.float64,
            ),
            "period_fine": period_fine,
        }
        s.ball_samples.append(sample)
        return {
            "count": len(s.ball_samples),
            "samples": _ball_sample_summaries(s),
        }

    def _ball_sample_summaries(s: _Session) -> list[dict]:
        """JSON-safe summary list (no giant grids)."""
        out = []
        for i, sample in enumerate(s.ball_samples):
            out.append({
                "index": i,
                "envelope_id": sample["envelope_id"],
                "ball_diameter_mm": sample["ball_diameter_mm"],
                "ball_center_px": list(sample["ball_center_px"]),
                "ball_radius_px": sample["ball_radius_px"],
                "ball_position_world_mm": list(sample["ball_position_world_mm"]),
                "label": sample.get("label", ""),
            })
        return out

    @router.get(
        "/deflectometry/ball-cal-samples",
        dependencies=[Depends(_reject_hosted)],
    )
    def list_ball_cal_samples():
        s = _current()
        if s is None:
            return {"count": 0, "samples": []}
        return {
            "count": len(s.ball_samples),
            "samples": _ball_sample_summaries(s),
        }

    @router.delete(
        "/deflectometry/ball-cal-samples/{index}",
        dependencies=[Depends(_reject_hosted)],
    )
    def delete_ball_cal_sample(index: int):
        s = _current()
        if s is None or not s.ball_samples:
            raise HTTPException(404, detail="No ball samples to remove")
        if index < 0 or index >= len(s.ball_samples):
            raise HTTPException(
                404, detail=f"Ball sample index {index} out of range"
            )
        removed = s.ball_samples.pop(index)
        return {
            "status": "deleted",
            "removed_envelope_id": removed["envelope_id"],
            "count": len(s.ball_samples),
        }

    @router.post(
        "/deflectometry/calibrate-screen-shape",
        dependencies=[Depends(_reject_hosted)],
    )
    def calibrate_screen_shape(body: CalibrateScreenShapeBody):
        """Run the Stage-1 + Stage-2 ball calibration solve.

        On success: saves the resulting ScreenShape via
        :func:`backend.screen_shape_store.save_screen_shape` and returns the
        serialized shape plus diagnostics. Does NOT bind to any active
        CalibrationSession — that is a separate wizard step.
        """
        from .vision.deflectometry_geometry import CameraModel, Pose
        from .vision.screen_shape_solver import solve_screen_shape
        from . import screen_shape_store

        s = _current()
        if s is None:
            raise HTTPException(400, detail="No active deflectometry session")
        if not s.ball_samples:
            raise HTTPException(400, detail="No ball samples stashed; add at least one.")

        # Build CameraModel from the request dict.
        try:
            cam = CameraModel(**body.camera_model)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, detail=f"invalid camera_model: {e}")
        try:
            cam_pose = Pose.from_dict(body.camera_pose)
        except Exception as e:
            raise HTTPException(400, detail=f"invalid camera_pose: {e}")

        if body.estimated_screen_rotation is not None:
            try:
                initial_pose = Pose.from_dict(body.estimated_screen_rotation)
            except Exception as e:
                raise HTTPException(
                    400, detail=f"invalid estimated_screen_rotation: {e}"
                )
            # Override translation z if estimated_screen_distance_mm was also
            # supplied (the rotation contains its own translation, but the
            # "distance" field is more common in simple cases — prefer the
            # explicit rotation pose as-is).
        else:
            # Default: no rotation, camera-looks-at-screen translation along z.
            initial_pose = Pose(
                rotation=__import__(
                    "scipy.spatial.transform", fromlist=["Rotation"]
                ).Rotation.identity(),
                translation=np.array(
                    [0.0, 0.0, float(body.estimated_screen_distance_mm)]
                ),
            )

        try:
            shape, diag = solve_screen_shape(
                s.ball_samples,
                camera_model=cam,
                camera_pose=cam_pose,
                screen_width_mm=body.screen_width_mm,
                screen_height_mm=body.screen_height_mm,
                initial_screen_pose=initial_pose,
                stage2_min_control_points=body.stage2_min_control_points,
                stage2_grid_size=body.stage2_grid_size,
                modulation_floor=body.modulation_floor,
                consistency_floor=body.consistency_floor,
            )
        except ValueError as e:
            raise HTTPException(400, detail=str(e))

        path = screen_shape_store.save_screen_shape(shape)
        return {
            "shape": shape.as_dict(),
            "fit_diagnostics": diag,
            "path": path,
            "warnings": diag.get("warnings", []),
        }

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
