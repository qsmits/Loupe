"""Phase-4 geometric slope solver + paraboloid fit + uncertainty propagation.

Bridges the `/deflectometry/compute` path to the Wave-1 geometry kernels in
``deflectometry_geometry.py``. Everything here is pure (numpy in, numpy out);
no HTTP, no session state. The caller in ``api_deflectometry.py`` is
responsible for turning a live ``_Session`` into the dict of geometry inputs
and then calling :func:`compute_geometric_slopes`.

Coordinate-frame guardrail
--------------------------

This module is the boundary where unwrapped phase (radians, finest-period
scaled) becomes normalized screen coords (u, v in [0, 1]) that feed the
``screen_shape.point_at`` callable. The Y-flip rule from ``CLAUDE.md`` still
applies: any Y-flip lives inside ``screen_shape.point_at`` — not here. See
:func:`phase_to_screen_uv` for the exact normalization used.
"""
from __future__ import annotations

from typing import Any

import numpy as np

from .deflectometry import _irls_fit
from .deflectometry_geometry import (
    CameraModel,
    Pose,
    slope_from_camera_pixel,
)
from .screen_shape import ScreenShape


def phase_to_screen_uv(
    phase_x: np.ndarray,
    phase_y: np.ndarray,
    freq: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert unwrapped phase (radians) to normalized screen coords in [0, 1].

    The ``cascade_unwrap`` output is "absolute phase at the finest period"
    (see its docstring): the full screen spans ``2π · freq`` radians. So the
    normalized screen fraction is ``phase / (2π · freq)``. We do NOT clamp to
    [0, 1] here — a well-behaved pixel will land in range; anything out of
    range is passed through so the caller (or the screen-shape callable) can
    decide whether to extrapolate or mark invalid.

    Note
    ----
    ``freq`` is the finest period used during capture (``s.periods[-1]`` for
    multi_freq, ``s.freq`` for fast). Phase-to-slope mode uses the same
    scaling.
    """
    denom = 2.0 * np.pi * float(freq)
    if denom == 0.0:
        raise ValueError("freq must be non-zero to normalize phase → screen coords")
    u = phase_x / denom
    v = phase_y / denom
    return u, v


def compute_geometric_slopes(
    phase_x: np.ndarray,
    phase_y: np.ndarray,
    trusted_mask: np.ndarray,
    *,
    camera_model: CameraModel,
    camera_pose: Pose,
    screen_shape: ScreenShape,
    screen_pose: Pose,
    surface_plane_point: np.ndarray,
    surface_plane_normal: np.ndarray,
    freq: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Compute per-pixel geometric slopes via the reflection chain.

    Uses :func:`slope_from_camera_pixel` for the core reflection math. All
    inputs are world-frame (camera ray is world-transformed inside the
    helper) and all outputs are world-frame mm-per-mm slopes.

    Parameters
    ----------
    phase_x, phase_y
        Unwrapped phase (radians, finest-period scaled), shape (H, W).
    trusted_mask
        Boolean (H, W). Pixels outside the mask come back NaN.
    camera_model, camera_pose
        From :func:`resolve_geometry_inputs`.
    screen_shape, screen_pose
        Screen shape maps (u, v) in [0, 1]² → screen-frame 3D mm.
        ``screen_pose`` is the pose of the screen frame in world; we
        compose it with the shape callable so the resulting callable maps
        (u, v) → world 3D mm.
    surface_plane_point, surface_plane_normal
        Assumed flat specimen plane (world frame).
    freq
        Finest fringe period used during capture (cycles across the full
        screen). Drives the phase→uv normalization.

    Returns
    -------
    slope_x_grid, slope_y_grid : (H, W) float64
        dz/dx and dz/dy in the world frame. NaN where the geometric chain
        failed (plane miss, bad screen coord, degenerate normal, or
        outside ``trusted_mask``).
    surface_hits_world : (H, W, 3) float64
        World-frame hit points on the specimen plane. NaN where invalid.
    valid_mask : (H, W) bool
        True where every step of the chain succeeded AND the input mask
        was true.
    """
    H, W = phase_x.shape
    if phase_y.shape != (H, W) or trusted_mask.shape != (H, W):
        raise ValueError(
            f"phase_x {phase_x.shape}, phase_y {phase_y.shape}, trusted_mask "
            f"{trusted_mask.shape} must all agree"
        )

    # Build the (H, W, 2) camera pixel grid.
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float64)
    camera_uv = np.stack([xs, ys], axis=-1)  # (H, W, 2), [u=x, v=y]

    # Phase → normalized screen coord.
    u_scr, v_scr = phase_to_screen_uv(phase_x, phase_y, freq=freq)
    screen_uv = np.stack([u_scr, v_scr], axis=-1)  # (H, W, 2)

    # Wrap the screen shape in a callable: (..., 2) → (..., 3) world points.
    # point_at handles arbitrary leading dims after we reshape.
    def screen_shape_to_world(uv: np.ndarray) -> np.ndarray:
        uv_flat = uv.reshape(-1, 2)
        screen_frame_pts = screen_shape.point_at(uv_flat)
        # point_at guarantees (N, 3). screen_pose.apply transforms screen-frame
        # points → world-frame points.
        world_flat = screen_pose.apply(screen_frame_pts)
        return world_flat.reshape(uv.shape[:-1] + (3,))

    slope_xy, surface_hits, chain_valid = slope_from_camera_pixel(
        camera_pixel_uv=camera_uv,
        camera_model=camera_model,
        camera_pose_in_world=camera_pose,
        screen_coord_xy=screen_uv,
        screen_shape_to_world=screen_shape_to_world,
        surface_plane_point=surface_plane_point,
        surface_plane_normal=surface_plane_normal,
    )

    mask_b = trusted_mask.astype(bool)
    valid = chain_valid & mask_b

    slope_x = np.where(valid, slope_xy[..., 0], np.nan)
    slope_y = np.where(valid, slope_xy[..., 1], np.nan)
    hits = np.where(valid[..., None], surface_hits, np.nan)
    return slope_x, slope_y, hits, valid


# ---------------------------------------------------------------------------
# Paraboloid fit with 1σ uncertainties
# ---------------------------------------------------------------------------


def fit_paraboloid_with_uncertainty(
    slope_x_grid: np.ndarray,
    slope_y_grid: np.ndarray,
    mask: np.ndarray,
    pixels_per_mm: float,
) -> dict:
    """Fit the paraboloid ``z = F + D x + A x² + E y + C x y + B y²`` to slopes.

    The surface gradient gives two equations per pixel:

        dz/dx = D + 2 A x + C y
        dz/dy = E + C x + 2 B y

    We stack both rows per pixel into a joint linear system and solve with
    Tukey bisquare IRLS (``_irls_fit`` from the Phase-2 deflectometry module).
    Uncertainties come from the weighted covariance
    ``σ² (Φᵀ W Φ)⁻¹`` where ``σ²`` is the robust MAD-based residual variance
    over inliers.

    Coordinates are in mm: a pixel at column ``j`` and row ``i`` maps to
    ``x = j / pixels_per_mm, y = i / pixels_per_mm``. This matches the
    world-frame interpretation of the slope grids.

    Parameters
    ----------
    slope_x_grid, slope_y_grid : (H, W) float64 arrays of dz/dx and dz/dy.
        NaN where invalid.
    mask : (H, W) bool.
    pixels_per_mm : lateral calibration.

    Returns
    -------
    dict with:
        ``coefficients``: {F, D, A, E, C, B}
        ``coefficient_uncertainties_1sigma``: same keys, all ≥ 0.
        ``outlier_fraction``: 1 − mean(weights) over stacked residuals.
        ``residual_rms_mm``: robust RMS of slope residuals (inlier-only).
        ``pv_mm``, ``rms_mm``: peak-to-valley and RMS of the fitted
            paraboloid over the masked region (mm).
        ``fit_n``: number of paired slope observations used (≤ 2 · valid-px).

    Notes
    -----
    - F is NOT identifiable from slopes alone (adds a constant z offset);
      we solve for it as the mean residual height across the masked region
      AFTER the slope coefficients are fit, so pv_mm / rms_mm are
      meaningful. Its uncertainty reflects that post-hoc estimate.
    - If fewer than 6 valid paired observations exist, raises ValueError.
    """
    if slope_x_grid.shape != slope_y_grid.shape or slope_x_grid.shape != mask.shape:
        raise ValueError(
            f"shape mismatch: slope_x {slope_x_grid.shape}, "
            f"slope_y {slope_y_grid.shape}, mask {mask.shape}"
        )
    if pixels_per_mm <= 0:
        raise ValueError(f"pixels_per_mm must be positive, got {pixels_per_mm}")

    H, W = slope_x_grid.shape
    yy, xx = np.mgrid[0:H, 0:W]
    x_mm = xx.astype(np.float64) / float(pixels_per_mm)
    y_mm = yy.astype(np.float64) / float(pixels_per_mm)

    valid = mask.astype(bool) & np.isfinite(slope_x_grid) & np.isfinite(slope_y_grid)
    n_valid = int(valid.sum())
    if n_valid < 6:
        raise ValueError(
            f"need at least 6 valid pixels to fit paraboloid, have {n_valid}"
        )

    xv = x_mm[valid]
    yv = y_mm[valid]
    sx = slope_x_grid[valid]
    sy = slope_y_grid[valid]

    # Design matrix columns: [F, D, A, E, C, B] = 6 coeffs; slope equations
    # don't see F at all, but we include it for coefficient-dict consistency
    # and zero-weight it in the slope system.
    # For dz/dx = D + 2 A x + C y:
    #   row = [F=0, D=1, A=2x, E=0, C=y, B=0]
    # For dz/dy = E + C x + 2 B y:
    #   row = [F=0, D=0, A=0, E=1, C=x, B=2y]
    n = xv.size
    zeros = np.zeros(n)
    ones = np.ones(n)
    row_dzdx = np.column_stack([zeros, ones, 2.0 * xv, zeros, yv, zeros])
    row_dzdy = np.column_stack([zeros, zeros, zeros, ones, xv, 2.0 * yv])
    Phi = np.vstack([row_dzdx, row_dzdy])  # (2n, 6)
    y_target = np.concatenate([sx, sy])  # (2n,)

    # F column is all zeros → singular if we solve directly. Drop F from the
    # slope system, recover D, A, E, C, B, then back out F separately.
    Phi_slopes = Phi[:, 1:]  # (2n, 5): [D, A, E, C, B]

    coeffs5, weights, _res_std = _irls_fit(Phi_slopes, y_target)
    D_c, A_c, E_c, C_c, B_c = coeffs5

    # Residuals in slope units (mm/mm):
    residuals = y_target - Phi_slopes @ coeffs5
    inliers = weights >= 0.5
    if inliers.any():
        res_in = residuals[inliers]
        # Use a plain RMS of inlier residuals for reporting; for uncertainty
        # we use MAD-based robust scale.
        residual_rms_mm = float(np.sqrt(np.mean(res_in ** 2)))
        scale = float(np.median(np.abs(res_in - np.median(res_in))) / 0.6745)
    else:
        residual_rms_mm = float(np.sqrt(np.mean(residuals ** 2)))
        scale = residual_rms_mm
    if scale < 1e-15:
        scale = 1e-15
    sigma2 = scale ** 2

    # Weighted covariance of the slope coefficients: σ² (Φᵀ W Φ)⁻¹
    sw = np.sqrt(weights)
    Phi_w = Phi_slopes * sw[:, None]
    AtA = Phi_w.T @ Phi_w
    try:
        cov5 = sigma2 * np.linalg.inv(AtA)
    except np.linalg.LinAlgError:
        cov5 = np.full((5, 5), np.nan)
    diag5 = np.maximum(np.diag(cov5), 0.0)
    sig_D, sig_A, sig_E, sig_C, sig_B = np.sqrt(diag5)

    # Recover F from the raw height values implied by slope integration? We
    # only have slopes, so use the simplest identifiable anchor: set F so the
    # fitted surface has zero mean over the mask. That matches the
    # "arbitrary height offset" convention from frankot_chellappa.
    # Evaluate the (partial) paraboloid at every valid pixel …
    z_noF = (
        D_c * xv + A_c * xv ** 2
        + E_c * yv + C_c * xv * yv
        + B_c * yv ** 2
    )
    F_c = float(-np.mean(z_noF))
    # Uncertainty in F from the linear combination Var(F) = Var(mean(z_noF));
    # we approximate by propagating the coefficient covariance through the
    # mean-of-basis-over-mask row vector.
    mean_basis = np.array([
        np.mean(xv),
        np.mean(xv ** 2),
        np.mean(yv),
        np.mean(xv * yv),
        np.mean(yv ** 2),
    ])
    try:
        var_F = float(mean_basis @ cov5 @ mean_basis)
        if not np.isfinite(var_F) or var_F < 0:
            var_F = 0.0
        sig_F = float(np.sqrt(var_F))
    except Exception:
        sig_F = float("nan")

    # pv / rms of fitted surface over the mask.
    z_fit = (
        F_c + D_c * xv + A_c * xv ** 2
        + E_c * yv + C_c * xv * yv
        + B_c * yv ** 2
    )
    pv_mm = float(z_fit.max() - z_fit.min()) if z_fit.size else 0.0
    mean_z = float(z_fit.mean()) if z_fit.size else 0.0
    rms_mm = float(np.sqrt(np.mean((z_fit - mean_z) ** 2))) if z_fit.size else 0.0

    outlier_fraction = float(1.0 - weights.mean()) if weights.size else 0.0

    return {
        "coefficients": {
            "F": F_c, "D": float(D_c), "A": float(A_c),
            "E": float(E_c), "C": float(C_c), "B": float(B_c),
        },
        "coefficient_uncertainties_1sigma": {
            "F": sig_F, "D": float(sig_D), "A": float(sig_A),
            "E": float(sig_E), "C": float(sig_C), "B": float(sig_B),
        },
        "outlier_fraction": outlier_fraction,
        "residual_rms_mm": residual_rms_mm,
        "pv_mm": pv_mm,
        "rms_mm": rms_mm,
        "fit_n": int(2 * n),
    }


# ---------------------------------------------------------------------------
# µm uncertainty propagation
# ---------------------------------------------------------------------------


def propagate_uncertainty_to_um(
    fit_result: dict,
    cal_factor_uncertainty: float | None = None,
    geometric_pose_uncertainty: dict | None = None,
) -> dict:
    """Back-of-envelope µm uncertainty for pv and rms.

    The uncertainty sources are combined in quadrature (RSS):

    1. **Fit coefficient uncertainty** — propagated through pv / rms by
       taking the paraboloid's sensitivity to its dominant curvature terms
       (A, B) and the linear terms (D, E). We approximate the propagated
       height uncertainty as the fit's ``residual_rms_mm`` (slope units)
       multiplied by a characteristic half-span ``L`` extracted from
       ``pv_mm``. This is deliberately crude — the goal is an honest ±µm,
       not a perfect one.

    2. **Sphere cal_factor uncertainty** — fractional. If provided,
       contributes ``cal_factor_uncertainty · pv_mm`` in linear terms (and
       similarly for RMS).

    3. **Screen pose uncertainty** — dict with optional
       ``lateral_mm``/``axial_mm`` keys. Lateral screen-pose error couples
       to height error through the local slope magnitude; we take the
       fit's mean |slope| (approximated as max(|D|, |E|)) as a rough
       proxy.

    Parameters
    ----------
    fit_result : dict from :func:`fit_paraboloid_with_uncertainty`.
    cal_factor_uncertainty : fractional 1σ uncertainty in ``cal_factor``
        (e.g. 0.02 for ±2%). None → treated as 0.
    geometric_pose_uncertainty : optional dict with ``lateral_mm`` /
        ``axial_mm`` keys (1σ per-axis pose error in mm). None or missing
        keys → treated as 0.

    Returns
    -------
    {"pv_uncertainty_um": float, "rms_uncertainty_um": float,
     "components_um": {"fit", "cal_factor", "pose"}}  — for debuggability.
    """
    coef = fit_result["coefficients"]
    sig = fit_result["coefficient_uncertainties_1sigma"]
    pv_mm = float(fit_result.get("pv_mm", 0.0))
    rms_mm = float(fit_result.get("rms_mm", 0.0))
    res_mm = float(fit_result.get("residual_rms_mm", 0.0))

    # 1. Fit term: convert slope-space residual to height-space via a
    # characteristic length. Use sqrt(pv_mm / (|A|+|B|+1e-9)) as a rough
    # half-span proxy; fall back to pv_mm if curvature is tiny.
    A_abs = abs(float(coef.get("A", 0.0))) + abs(float(coef.get("B", 0.0)))
    if A_abs > 1e-9:
        L = float(np.sqrt(max(pv_mm / A_abs, 0.0)))
    else:
        L = max(pv_mm, rms_mm, 1.0)
    fit_sigma_mm = res_mm * L + abs(float(sig.get("F", 0.0)))

    # 2. Cal-factor term (only meaningful if a sphere_cal is bound).
    if cal_factor_uncertainty is None:
        cal_sigma_pv_mm = 0.0
        cal_sigma_rms_mm = 0.0
    else:
        cf = float(cal_factor_uncertainty)
        cal_sigma_pv_mm = abs(cf) * pv_mm
        cal_sigma_rms_mm = abs(cf) * rms_mm

    # 3. Pose term: lateral pose error · mean |slope|. We use the linear
    # coefficients D, E as a crude mean-slope surrogate.
    if geometric_pose_uncertainty:
        lat = float(geometric_pose_uncertainty.get("lateral_mm", 0.0))
        axi = float(geometric_pose_uncertainty.get("axial_mm", 0.0))
    else:
        lat = 0.0
        axi = 0.0
    mean_abs_slope = 0.5 * (
        abs(float(coef.get("D", 0.0))) + abs(float(coef.get("E", 0.0)))
    )
    pose_sigma_mm = lat * mean_abs_slope + axi * 0.5  # axi contributes ~0.5x directly

    # RSS in mm, then → µm.
    pv_rss_mm = float(np.sqrt(
        fit_sigma_mm ** 2 + cal_sigma_pv_mm ** 2 + pose_sigma_mm ** 2
    ))
    rms_rss_mm = float(np.sqrt(
        fit_sigma_mm ** 2 + cal_sigma_rms_mm ** 2 + pose_sigma_mm ** 2
    ))

    return {
        "pv_uncertainty_um": pv_rss_mm * 1000.0,
        "rms_uncertainty_um": rms_rss_mm * 1000.0,
        "components_um": {
            "fit": fit_sigma_mm * 1000.0,
            "cal_factor_pv": cal_sigma_pv_mm * 1000.0,
            "cal_factor_rms": cal_sigma_rms_mm * 1000.0,
            "pose": pose_sigma_mm * 1000.0,
        },
    }


# ---------------------------------------------------------------------------
# Geometry-input resolution for the live session
# ---------------------------------------------------------------------------


# Default screen distance (iPad hanging over the bench) when no screen-shape
# calibration is present. Matches the profile default.
_DEFAULT_SCREEN_DISTANCE_MM = 250.0

# Default iPad physical dimensions (iPad Pro 11, active area ~247.6 × 178.5 mm).
# Used only when the stored screen shape doesn't specify its own.
_DEFAULT_SCREEN_W_MM = 247.6
_DEFAULT_SCREEN_H_MM = 178.5


def _camera_image_shape(session: Any) -> tuple[int, int]:
    """Best-effort (H, W) of the session's captured frames, else (480, 640)."""
    frames = getattr(session, "frames", None) or []
    for f in frames:
        arr = np.asarray(f)
        if arr.ndim >= 2:
            return int(arr.shape[0]), int(arr.shape[1])
    # Fall back to a conservative default.
    return 480, 640


def resolve_geometry_inputs(
    session: Any,
    *,
    pixels_per_mm: float | None = None,
    screen_distance_mm: float | None = None,
) -> dict:
    """Assemble the geometry inputs for the Phase-4 slope solver.

    Reads the live session's bound CalibrationSession (if any), the saved
    ScreenShape (if any), and falls back to placeholder identities/defaults
    for camera_pose, screen_pose, and surface_plane. This keeps the geometric
    path usable before Wave-2 delivers a proper camera+screen pose calibration.

    Parameters
    ----------
    session : live ``_Session`` instance. May be None.
    pixels_per_mm : lateral cal; if not supplied, taken from the bound
        CalibrationSession's ``sphere_cal`` if present, else None.
    screen_distance_mm : iPad-over-specimen distance (mm); defaults to
        ``_DEFAULT_SCREEN_DISTANCE_MM`` when not supplied.

    Returns
    -------
    dict with:
        camera_model : CameraModel | None
        camera_pose : Pose | None (identity placeholder)
        screen_shape : ScreenShape | None
        screen_pose : Pose | None
        surface_plane : {"point": (3,) ndarray, "normal": (3,) ndarray}
        surface_distance_mm : float | None
        screen_distance_mm : float | None
        geometry_complete : bool
        notes : list[str] — what placeholders were used
    """
    notes: list[str] = []

    # --- load bound cal session if any ---
    cal_session = None
    if session is not None and getattr(session, "active_cal_session_id", None):
        from .. import calibration_store
        cal_session = calibration_store.load_calibration_session(
            session.active_cal_session_id
        )

    sphere_cal = (cal_session or {}).get("sphere_cal") if cal_session else None

    # --- pixels_per_mm: prefer explicit arg, then sphere cal, then None ---
    ppm = pixels_per_mm
    if ppm is None and sphere_cal:
        # Some rigs store px_per_mm inside the sphere_cal dict. Be lenient.
        raw = sphere_cal.get("px_per_mm") or sphere_cal.get("pixels_per_mm")
        if raw:
            try:
                ppm = float(raw)
            except (TypeError, ValueError):
                ppm = None

    # --- camera model (telecentric; pinhole left for Wave-2) ---
    H, W = _camera_image_shape(session)
    camera_model: CameraModel | None = None
    if ppm is not None and ppm > 0:
        camera_model = CameraModel.telecentric_from_pixels_per_mm(
            pixels_per_mm=float(ppm),
            image_width=W,
            image_height=H,
        )
    else:
        notes.append("no pixels_per_mm; camera_model unavailable")

    # --- camera pose placeholder (identity) ---
    camera_pose = Pose.identity()
    notes.append("camera_pose: identity placeholder (Wave-2 will calibrate)")

    # --- screen shape from disk, or placeholder ---
    from .. import screen_shape_store
    screen_shape = screen_shape_store.load_screen_shape()
    if screen_shape is None:
        # Fall back to a flat-iPad rectangle at profile-default dimensions.
        from .screen_shape import Rectangular2DShape
        screen_shape = Rectangular2DShape(
            width_mm=_DEFAULT_SCREEN_W_MM,
            height_mm=_DEFAULT_SCREEN_H_MM,
        )
        notes.append("screen_shape: default Rectangular2DShape placeholder")

    # --- screen pose: translate by (0, 0, screen_distance_mm) in world ---
    sd = float(
        screen_distance_mm
        if screen_distance_mm is not None
        else _DEFAULT_SCREEN_DISTANCE_MM
    )
    # The iPad hangs above the specimen on +z (world up) and the screen
    # frame has z "out of screen" toward the operator's face. For this
    # placeholder we assume the screen surface sits at z=sd with no rotation
    # — this is the identity-rotation case. Wave-2 will replace this with a
    # calibrated pose from the ball-cal routine.
    screen_pose = Pose(
        rotation=Pose.identity().rotation,
        translation=np.array([0.0, 0.0, sd], dtype=np.float64),
    )
    notes.append(f"screen_pose: identity + z={sd}mm placeholder")

    # --- specimen plane: z=0, normal +z ---
    surface_plane = {
        "point": np.zeros(3, dtype=np.float64),
        "normal": np.array([0.0, 0.0, 1.0], dtype=np.float64),
    }
    notes.append("surface_plane: z=0, normal=+z placeholder")

    geometry_complete = bool(
        camera_model is not None
        and screen_shape is not None
        and cal_session is not None
        and sphere_cal is not None
    )

    return {
        "camera_model": camera_model,
        "camera_pose": camera_pose,
        "screen_shape": screen_shape,
        "screen_pose": screen_pose,
        "surface_plane": surface_plane,
        "surface_distance_mm": 0.0 if geometry_complete else None,
        "screen_distance_mm": sd,
        "pixels_per_mm": ppm,
        "geometry_complete": geometry_complete,
        "notes": notes,
    }
