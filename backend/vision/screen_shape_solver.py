"""Screen-shape solver — ball calibration back-end for Phase 3B.

Given a set of G20 ball observations, back-solve:

1. the iPad's 3D pose in the world frame (6 DoF — Stage 1), and
2. optionally, its per-pixel panel bow as a :class:`Distorted2DShape` (Stage 2).

The inputs are N "ball samples". Each sample is a fully-captured
deflectometry envelope for one ball placement, containing:

- ``phase_x_grid``, ``phase_y_grid`` — unwrapped phase in radians, already
  scaled to the finest period used during capture (see
  :func:`backend.vision.deflectometry.cascade_unwrap`).
- ``modulation_grid`` — per-pixel modulation, used as a quality gate.
- ``phase_consistency_grid`` — per-pixel multi-freq consistency score, used
  as an additional quality gate (optional; if absent assumed all-1).
- ball metadata: detected center/radius in pixel coords, physical diameter,
  and world-frame 3D position of the ball center.

Per-pixel conversion:

- Screen normalized coordinate ``u = phase_x / (2π · period_fine)`` and
  ``v = phase_y / (2π · period_fine)``, each in [0, 1) on a flat iPad.
- Camera pixel → ray in the camera frame (via :class:`CameraModel`).
- Camera pose transforms ray → world frame.
- Ray–sphere intersect with the ball geometry → world hit.
- Reflect about the ball surface normal → reflected world ray.
- Observation: reflected ray at world origin ``P_hit`` with direction
  ``d_refl`` is known to strike the screen at normalized coord (u, v).
  Unknown: the screen's 3D pose (Stage 1), panel bow (Stage 2).

Stage 1 — flat iPad, 6 DoF rigid pose:

- Parameterize pose as (tx, ty, tz, rx, ry, rz) where (rx, ry, rz) is a
  scaled-axis rotation vector (``scipy.spatial.transform.Rotation.from_rotvec``).
- Residual per observation: after ray-plane intersect with the screen plane
  (plane through ``T.translation`` with normal ``R @ [0,0,1]``), transform
  the hit into the screen frame via ``T.inverse()`` and compare to the
  known screen-frame point ``(u*W, v*H, 0)``. The z-component residual is
  automatically zero by construction (we intersect with the plane), so
  only the in-plane (x, y) residuals are minimised.
- scipy.optimize.least_squares with Levenberg-Marquardt.

Stage 2 — panel bow:

- With ``screen_pose`` fixed from Stage 1, compute per-observation residuals
  in the screen frame: delta = observed_world_hit_in_screen_frame −
  predicted_flat_point. That delta is interpreted as a 3D offset of the
  true iPad surface from the flat plane at normalized (u, v).
- Bin the (u, v) domain into a sparse grid, average the deltas within each
  bin → control points. Fit :class:`Distorted2DShape` by passing
  ``control_xyz_mm = (u*W + dx, v*H + dy, dz)``.

If fewer than ``stage2_min_control_points`` bins are populated, Stage 2 is
skipped and :class:`Rectangular2DShape` is returned instead.

Coordinate-frame notes
======================

See ``backend.vision.deflectometry_geometry`` for the full coordinate-frame
doc. This solver lives in the world frame throughout. The normalized screen
(u, v) grid follows the iPad pixel-frame convention: ``u`` right, ``v``
down. ``Rectangular2DShape.point_at((u, v)) = (u*W, v*H, 0)`` in the screen
frame — no Y-flip inside the shape object.

The Y-flip trap lives in the **caller's** choice of screen uv: if phase_y
is produced from horizontal fringes that increase downward on the iPad
(y-down), then ``v = phase_y / (2π p)`` is already in the y-down frame —
this matches ``Rectangular2DShape`` convention. If the caller's phase
convention is y-up, they must flip v := 1 - v before handing samples to
this solver. See ``test_solve_screen_shape_yflip_canary`` for the guard.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

from .deflectometry_geometry import (
    CameraModel,
    Pose,
    ray_plane_intersection,
    ray_sphere_intersection,
    reflect,
    surface_normal_at_sphere_point,
)
from .screen_shape import Distorted2DShape, Rectangular2DShape, ScreenShape


# Default quality gates for per-pixel observations inside a detected ball.
DEFAULT_MODULATION_FLOOR = 0.02          # absolute modulation (0..1)
DEFAULT_CONSISTENCY_FLOOR = 0.6          # multi-freq consistency score
DEFAULT_MAX_PIXELS_PER_BALL = 2500       # subsample cap for solver cost
DEFAULT_STAGE2_GRID_SIZE = 16            # bins per axis in (u, v) for bow fit


@dataclass
class _Observation:
    """One solver constraint (a single validated camera pixel).

    Lives in the world frame end-to-end. ``screen_uv`` is in [0, 1]^2.
    """
    world_hit: np.ndarray             # (3,) — reflected-ray origin (world)
    world_dir: np.ndarray             # (3,) — reflected-ray direction (world, unit)
    screen_uv: np.ndarray             # (2,) — normalized screen coord


def _pose_from_params(x: np.ndarray) -> Pose:
    """Unpack (tx, ty, tz, rx, ry, rz) → Pose (rotvec parameterization)."""
    return Pose(
        rotation=Rotation.from_rotvec(x[3:6]),
        translation=np.asarray(x[0:3], dtype=np.float64),
    )


def _pose_to_params(pose: Pose) -> np.ndarray:
    """Inverse of :func:`_pose_from_params`."""
    return np.concatenate(
        [np.asarray(pose.translation, dtype=np.float64).reshape(3),
         pose.rotation.as_rotvec()]
    )


def _build_observations(
    samples: list[dict],
    camera_model: CameraModel,
    camera_pose: Pose,
    modulation_floor: float,
    consistency_floor: float,
    max_pixels_per_ball: int,
) -> tuple[list[_Observation], list[int]]:
    """Reduce raw sample dicts to a flat list of per-pixel observations.

    Returns
    -------
    observations : flat list of _Observation for the solver.
    per_sample_counts : list of ints with the per-sample contribution count,
        in the same order as ``samples`` (zero for dropped samples).
    """
    all_obs: list[_Observation] = []
    per_sample_counts: list[int] = []
    rng = np.random.default_rng(seed=12345)

    for s in samples:
        phase_x = np.asarray(s["phase_x_grid"], dtype=np.float64)
        phase_y = np.asarray(s["phase_y_grid"], dtype=np.float64)
        h, w = phase_x.shape
        if phase_y.shape != phase_x.shape:
            raise ValueError(
                f"phase_x and phase_y shape mismatch in sample {s.get('envelope_id', '?')!r}"
            )

        mod = np.asarray(
            s.get("modulation_grid", np.ones_like(phase_x)), dtype=np.float64
        )
        cons = np.asarray(
            s.get(
                "phase_consistency_grid", np.ones_like(phase_x)
            ),
            dtype=np.float64,
        )

        period_fine = float(s["period_fine"])
        cu_b, cv_b = s["ball_center_px"]
        r_b = float(s["ball_radius_px"])
        ball_center_world = np.asarray(
            s.get("ball_position_world_mm", (0.0, 0.0, 0.0)),
            dtype=np.float64,
        ).reshape(3)
        ball_radius_mm = float(s["ball_diameter_mm"]) / 2.0

        # Build a mask over pixels inside the detected ball with adequate
        # modulation + consistency. Leave a 3-pixel safety margin off the
        # silhouette edge to avoid grazing reflections.
        uu, vv = np.meshgrid(np.arange(w), np.arange(h))
        dx = uu - cu_b
        dy = vv - cv_b
        inside = (dx * dx + dy * dy) <= (r_b - 3.0) ** 2
        good = inside & (mod >= modulation_floor) & (cons >= consistency_floor)
        good &= np.isfinite(phase_x) & np.isfinite(phase_y)

        coords = np.argwhere(good)
        if coords.size == 0:
            per_sample_counts.append(0)
            continue

        # Cap per-sample pixel count (solver cost control).
        if coords.shape[0] > max_pixels_per_ball:
            idx = rng.choice(coords.shape[0], max_pixels_per_ball, replace=False)
            coords = coords[idx]

        # (v, u) → camera-frame ray.
        v_arr = coords[:, 0].astype(np.float64)
        u_arr = coords[:, 1].astype(np.float64)
        ray_o_cam, ray_d_cam = camera_model.ray_from_pixel(u_arr, v_arr)
        ray_o_world = camera_pose.apply(ray_o_cam)
        ray_d_world = camera_pose.rotation.apply(ray_d_cam)

        # Intersect with ball sphere.
        hits, valid = ray_sphere_intersection(
            ray_o_world, ray_d_world, ball_center_world, ball_radius_mm
        )
        if not valid.any():
            per_sample_counts.append(0)
            continue

        hits = hits[valid]
        ray_d_world = ray_d_world[valid]
        v_arr = v_arr[valid]
        u_arr = u_arr[valid]

        normals = surface_normal_at_sphere_point(hits, ball_center_world)
        reflected = reflect(ray_d_world, normals)

        # Extract screen uv from phase. Screen normalized coord in [0, 1]:
        #   u = phase / (2π · period_fine). Values outside [0, 1] drop.
        phi_x = phase_x[v_arr.astype(int), u_arr.astype(int)]
        phi_y = phase_y[v_arr.astype(int), u_arr.astype(int)]
        u_screen = phi_x / (2.0 * np.pi * period_fine)
        v_screen = phi_y / (2.0 * np.pi * period_fine)

        in_range = (
            np.isfinite(u_screen) & np.isfinite(v_screen)
            & (u_screen >= 0.0) & (u_screen <= 1.0)
            & (v_screen >= 0.0) & (v_screen <= 1.0)
        )
        if not in_range.any():
            per_sample_counts.append(0)
            continue

        hits = hits[in_range]
        reflected = reflected[in_range]
        u_screen = u_screen[in_range]
        v_screen = v_screen[in_range]

        kept = 0
        for i in range(hits.shape[0]):
            all_obs.append(
                _Observation(
                    world_hit=hits[i],
                    world_dir=reflected[i],
                    screen_uv=np.array([u_screen[i], v_screen[i]], dtype=np.float64),
                )
            )
            kept += 1
        per_sample_counts.append(kept)

    return all_obs, per_sample_counts


def _residuals_stage1(
    params: np.ndarray,
    observations: list[_Observation],
    screen_width_mm: float,
    screen_height_mm: float,
) -> np.ndarray:
    """Stage-1 residuals: per-observation in-plane error in screen frame (mm).

    Returns a flat vector of length ``2 * N`` (x, y residuals per observation).
    """
    pose = _pose_from_params(params)
    plane_point = pose.translation
    plane_normal = pose.rotation.apply(np.array([0.0, 0.0, 1.0]))

    N = len(observations)
    out = np.zeros(2 * N, dtype=np.float64)

    # Pre-stack for vectorized intersect.
    origins = np.stack([o.world_hit for o in observations], axis=0)
    dirs = np.stack([o.world_dir for o in observations], axis=0)
    hits, valid = ray_plane_intersection(
        origins, dirs, plane_point, plane_normal
    )

    # For invalid hits, use a large but finite penalty to keep LM happy.
    pose_inv = pose.inverse()
    screen_hits = pose_inv.apply(np.where(valid[:, None], hits, plane_point))

    # Expected points in screen frame.
    uv = np.stack([o.screen_uv for o in observations], axis=0)
    expected = np.stack(
        [uv[:, 0] * screen_width_mm, uv[:, 1] * screen_height_mm], axis=-1
    )
    diff = screen_hits[:, :2] - expected

    # Penalize invalid hits with a soft but informative residual so the
    # solver is nudged away from poses that produce parallel / behind-plane
    # configurations.
    penalty_mask = ~valid
    if penalty_mask.any():
        diff[penalty_mask] = 10.0 * max(screen_width_mm, screen_height_mm)

    out[0::2] = diff[:, 0]
    out[1::2] = diff[:, 1]
    return out


def _solve_stage1(
    observations: list[_Observation],
    screen_width_mm: float,
    screen_height_mm: float,
    initial_pose: Pose,
    max_nfev: int = 400,
) -> tuple[Pose, dict]:
    """Stage 1: rigid-body pose solve via Levenberg-Marquardt."""
    x0 = _pose_to_params(initial_pose)
    result = least_squares(
        _residuals_stage1,
        x0,
        args=(observations, screen_width_mm, screen_height_mm),
        method="lm",
        max_nfev=max_nfev,
        xtol=1e-10,
        ftol=1e-10,
    )
    pose = _pose_from_params(result.x)
    residuals = _residuals_stage1(
        result.x, observations, screen_width_mm, screen_height_mm
    )
    # 2D residual per observation (x, y in screen frame).
    per_obs_mag = np.hypot(residuals[0::2], residuals[1::2])
    rms = float(np.sqrt(np.mean(per_obs_mag ** 2))) if per_obs_mag.size > 0 else 0.0

    diag = {
        "rms_mm": rms,
        "nfev": int(result.nfev),
        "n_observations": len(observations),
        "optimality": float(result.optimality),
        "status": int(result.status),
        "message": str(result.message),
    }
    return pose, diag


def _solve_stage2(
    observations: list[_Observation],
    screen_pose: Pose,
    screen_width_mm: float,
    screen_height_mm: float,
    stage2_grid_size: int,
    stage2_min_control_points: int,
) -> tuple[ScreenShape, dict]:
    """Stage 2: panel-bow fit over the (u, v) domain.

    For each observation, ray-plane intersect with the Stage-1 plane, then
    transform into the screen frame. Bin into a ``grid_size × grid_size``
    grid on (u, v); average deltas per bin; fit :class:`Distorted2DShape`
    with those bin centres as control points.

    If fewer than ``stage2_min_control_points`` bins are populated, return
    a :class:`Rectangular2DShape` (caller can flag this in diagnostics).
    """
    plane_point = screen_pose.translation
    plane_normal = screen_pose.rotation.apply(np.array([0.0, 0.0, 1.0]))
    pose_inv = screen_pose.inverse()

    origins = np.stack([o.world_hit for o in observations], axis=0)
    dirs = np.stack([o.world_dir for o in observations], axis=0)
    uv = np.stack([o.screen_uv for o in observations], axis=0)

    hits, valid = ray_plane_intersection(
        origins, dirs, plane_point, plane_normal
    )
    keep = valid & np.isfinite(hits).all(axis=-1)
    hits = hits[keep]
    uv = uv[keep]

    if hits.shape[0] == 0:
        rect = Rectangular2DShape(width_mm=screen_width_mm, height_mm=screen_height_mm)
        return rect, {
            "stage2_enabled": False,
            "stage2_reason": "no valid hits after stage 1",
            "control_point_count": 0,
            "stage2_residual_rms_mm": None,
        }

    # Observed screen-frame 3D points.
    observed_screen = pose_inv.apply(hits)
    predicted_flat_xy = np.stack(
        [uv[:, 0] * screen_width_mm, uv[:, 1] * screen_height_mm], axis=-1
    )

    # Delta in screen frame. Predicted z is 0 for flat; observed z is
    # whatever the plane intersection returned (should be ~0 by construction,
    # but we propagate it faithfully).
    dx = observed_screen[:, 0] - predicted_flat_xy[:, 0]
    dy = observed_screen[:, 1] - predicted_flat_xy[:, 1]
    dz = observed_screen[:, 2]

    # Bin into a regular grid. We need enough samples per bin to average
    # out noise; we also need enough populated bins for LinearNDInterp's
    # Delaunay triangulation.
    G = int(stage2_grid_size)
    ui = np.clip((uv[:, 0] * G).astype(int), 0, G - 1)
    vi = np.clip((uv[:, 1] * G).astype(int), 0, G - 1)
    bin_id = vi * G + ui

    # Aggregate per bin.
    bins: dict[int, list[int]] = {}
    for i, bid in enumerate(bin_id):
        bins.setdefault(int(bid), []).append(i)

    control_uv: list[np.ndarray] = []
    control_xyz: list[np.ndarray] = []
    for bid, idxs in bins.items():
        idxs_arr = np.asarray(idxs, dtype=np.int64)
        u_c = float(np.mean(uv[idxs_arr, 0]))
        v_c = float(np.mean(uv[idxs_arr, 1]))
        control_uv.append(np.array([u_c, v_c], dtype=np.float64))
        x_c = float(np.mean(predicted_flat_xy[idxs_arr, 0] + dx[idxs_arr]))
        y_c = float(np.mean(predicted_flat_xy[idxs_arr, 1] + dy[idxs_arr]))
        z_c = float(np.mean(dz[idxs_arr]))
        control_xyz.append(np.array([x_c, y_c, z_c], dtype=np.float64))

    n_ctrl = len(control_uv)
    if n_ctrl < stage2_min_control_points:
        rect = Rectangular2DShape(
            width_mm=screen_width_mm, height_mm=screen_height_mm
        )
        return rect, {
            "stage2_enabled": False,
            "stage2_reason": (
                f"only {n_ctrl} control points, need ≥{stage2_min_control_points}"
            ),
            "control_point_count": n_ctrl,
            "stage2_residual_rms_mm": None,
        }

    control_uv_arr = np.stack(control_uv, axis=0)
    control_xyz_arr = np.stack(control_xyz, axis=0)

    # Anchor the convex hull of control points to the four screen corners
    # using the flat-screen prediction there (z=0). Without these anchors
    # LinearNDInterpolator falls back to nearest-neighbour for any uv
    # outside the bin-centroid hull — which includes every observation
    # along the domain edges. The corner anchors introduce at most
    # ``2 px`` of extrapolation error while keeping residuals meaningful.
    corners = np.array(
        [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], dtype=np.float64
    )
    corner_xyz = np.stack(
        [corners[:, 0] * screen_width_mm,
         corners[:, 1] * screen_height_mm,
         np.zeros(4)],
        axis=-1,
    )
    control_uv_arr = np.concatenate([control_uv_arr, corners], axis=0)
    control_xyz_arr = np.concatenate([control_xyz_arr, corner_xyz], axis=0)

    # Coverage fraction = populated bins / total bins.
    coverage_fraction = float(n_ctrl) / float(G * G)

    # Build shape and evaluate residuals at the original observations.
    shape = Distorted2DShape(
        width_mm=screen_width_mm,
        height_mm=screen_height_mm,
        control_uv=control_uv_arr,
        control_xyz_mm=control_xyz_arr,
        calibrated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    predicted_distorted = shape.point_at(uv)
    residual_3d = predicted_distorted - observed_screen
    rms = float(np.sqrt(np.mean(np.sum(residual_3d ** 2, axis=-1))))
    shape.residual_rms_mm = rms

    return shape, {
        "stage2_enabled": True,
        "control_point_count": n_ctrl,
        "stage2_residual_rms_mm": rms,
        "coverage_fraction": coverage_fraction,
    }


def solve_screen_shape(
    samples: list[dict],
    camera_model: CameraModel,
    camera_pose: Pose,
    screen_width_mm: float,
    screen_height_mm: float,
    initial_screen_pose: Pose,
    *,
    stage2_min_control_points: int = 25,
    stage2_grid_size: int = DEFAULT_STAGE2_GRID_SIZE,
    modulation_floor: float = DEFAULT_MODULATION_FLOOR,
    consistency_floor: float = DEFAULT_CONSISTENCY_FLOOR,
    max_pixels_per_ball: int = DEFAULT_MAX_PIXELS_PER_BALL,
) -> tuple[ScreenShape, dict]:
    """Staged ball-calibration solve.

    Parameters
    ----------
    samples : list of dicts with the following required keys:

        - ``envelope_id`` (str) — id of the source compute envelope.
        - ``phase_x_grid``, ``phase_y_grid`` (ndarray, (H, W) float) —
          unwrapped phase, in radians, scaled to the finest period.
        - ``modulation_grid`` (ndarray) — per-pixel fringe modulation.
          Optional (defaults to all-1s); used as a per-pixel quality gate.
        - ``phase_consistency_grid`` (ndarray) — multi-freq consistency.
          Optional (defaults to all-1s); used as a per-pixel quality gate.
        - ``period_fine`` (float) — finest fringe period (periods[-1]) used
          for the capture. Phase-to-uv conversion: ``u = phase_x / (2π p)``.
        - ``ball_center_px`` ((u, v) tuple) — detected ball center in pixels.
        - ``ball_radius_px`` (float) — detected ball radius in pixels.
        - ``ball_diameter_mm`` (float) — physical ball diameter (G20 class).
        - ``ball_position_world_mm`` ((x, y, z) tuple, optional) — ball
          center in the world frame. Defaults to (0, 0, 0) (specimen origin).

    camera_model, camera_pose : camera intrinsics + pose in world frame.
    screen_width_mm, screen_height_mm : iPad physical dimensions.
    initial_screen_pose : initial guess for the screen pose in world frame.
        Typical: ``Pose(identity rotation, translation=(0, 0, D))`` where
        ``D`` is the user-supplied estimated iPad distance.
    stage2_min_control_points : if fewer bins are populated after Stage 1,
        return a :class:`Rectangular2DShape` (flat panel) instead of fitting
        a :class:`Distorted2DShape`.
    stage2_grid_size : number of bins per axis in the (u, v) aggregation.
    modulation_floor, consistency_floor : per-pixel quality gates.
    max_pixels_per_ball : cap on per-ball pixel count to keep solver cost
        bounded.

    Returns
    -------
    shape : the fitted :class:`Rectangular2DShape` or :class:`Distorted2DShape`.
    diagnostics : dict with fields::

        stage1_pose: Pose.as_dict()
        stage1_pose_rms_mm: float
        stage1_nfev: int
        stage2_enabled: bool
        stage2_residual_rms_mm: float | None
        control_point_count: int
        coverage_fraction: float (0..1, fraction of stage2 bins populated)
        observation_count: int
        per_sample_observation_counts: list[int]
        warnings: list[str]
    """
    if not samples:
        raise ValueError("solve_screen_shape requires ≥1 sample")

    observations, per_sample_counts = _build_observations(
        samples,
        camera_model=camera_model,
        camera_pose=camera_pose,
        modulation_floor=modulation_floor,
        consistency_floor=consistency_floor,
        max_pixels_per_ball=max_pixels_per_ball,
    )
    if not observations:
        raise ValueError(
            "No usable per-pixel observations across samples — check "
            "ball detection, phase unwrapping, and quality floors."
        )

    warnings: list[str] = []
    if len(observations) < 50:
        warnings.append(
            f"only {len(observations)} observations; solver may be fragile"
        )

    # --- Stage 1 -----------------------------------------------------------
    screen_pose, stage1_diag = _solve_stage1(
        observations,
        screen_width_mm=screen_width_mm,
        screen_height_mm=screen_height_mm,
        initial_pose=initial_screen_pose,
    )

    # --- Stage 2 -----------------------------------------------------------
    shape, stage2_diag = _solve_stage2(
        observations,
        screen_pose=screen_pose,
        screen_width_mm=screen_width_mm,
        screen_height_mm=screen_height_mm,
        stage2_grid_size=stage2_grid_size,
        stage2_min_control_points=stage2_min_control_points,
    )

    # Coverage fraction: if Stage 2 ran, it recorded it; otherwise estimate
    # from populated bins of the aborted fit.
    coverage_fraction = stage2_diag.get(
        "coverage_fraction",
        float(stage2_diag.get("control_point_count", 0)) / float(stage2_grid_size ** 2),
    )

    diagnostics = {
        "stage1_pose": screen_pose.as_dict(),
        "stage1_pose_rms_mm": stage1_diag["rms_mm"],
        "stage1_nfev": stage1_diag["nfev"],
        "stage1_status": stage1_diag["status"],
        "stage1_message": stage1_diag["message"],
        "stage2_enabled": stage2_diag["stage2_enabled"],
        "stage2_residual_rms_mm": stage2_diag.get("stage2_residual_rms_mm"),
        "control_point_count": stage2_diag["control_point_count"],
        "coverage_fraction": coverage_fraction,
        "observation_count": len(observations),
        "per_sample_observation_counts": per_sample_counts,
        "warnings": warnings,
    }
    if "stage2_reason" in stage2_diag:
        diagnostics["stage2_reason"] = stage2_diag["stage2_reason"]

    return shape, diagnostics
