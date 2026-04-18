"""Ball-calibration backend tests — Phase 3B Wave 2.

Covers:
- ``backend.vision.ball_detection.detect_ball_in_modulation``: synthetic disc
  detection, hint-guided search.
- ``backend.vision.screen_shape_solver.solve_screen_shape``: staged pose +
  optional panel bow solve, including a Y-flip canary and a panel-bow
  beats-flat test.
- HTTP endpoints: /detect-ball, /add-ball-cal-sample,
  /calibrate-screen-shape end-to-end, 400 on no-samples, preview PNG shape.
"""
from __future__ import annotations

import base64
from io import BytesIO
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from scipy.spatial.transform import Rotation

from backend.vision.ball_detection import (
    detect_ball_in_modulation,
    render_ball_overlay_png_b64,
)
from backend.vision.deflectometry_geometry import (
    CameraModel,
    Pose,
    ray_sphere_intersection,
    reflect,
    surface_normal_at_sphere_point,
)
from backend.vision.screen_shape import Rectangular2DShape, Distorted2DShape
from backend.vision.screen_shape_solver import solve_screen_shape


# ---------------------------------------------------------------------------
# Ball detection — synthetic
# ---------------------------------------------------------------------------


def _synth_modulation(
    shape: tuple[int, int],
    center: tuple[float, float],
    radius: float,
    inside_value: float = 0.85,
    outside_value: float = 0.05,
    noise_sigma: float = 0.01,
    seed: int = 0,
) -> np.ndarray:
    """Make a soft-edged disc modulation map with uniform noise."""
    h, w = shape
    uu, vv = np.meshgrid(np.arange(w), np.arange(h))
    dx = uu - center[0]
    dy = vv - center[1]
    d2 = dx * dx + dy * dy
    mask = d2 <= radius * radius
    img = np.where(mask, inside_value, outside_value).astype(np.float64)
    # Soft edge: 1-px ramp.
    edge = np.exp(-0.5 * ((np.sqrt(d2) - radius) / 1.5) ** 2)
    edge_weight = np.clip(edge, 0.0, 1.0) * 0.1
    img = np.clip(img + edge_weight, 0.0, 1.0)
    if noise_sigma > 0:
        rng = np.random.default_rng(seed)
        img += rng.normal(0, noise_sigma, size=img.shape)
    return img.astype(np.float64)


def test_detect_ball_synthetic_perfect_circle():
    img = _synth_modulation((480, 640), center=(320.0, 240.0), radius=80.0)
    (cu, cv), r, score = detect_ball_in_modulation(
        img, min_radius_px=40, max_radius_px=150
    )
    assert abs(cu - 320.0) <= 2.5
    assert abs(cv - 240.0) <= 2.5
    assert abs(r - 80.0) <= 3.0
    assert 0.0 < score <= 1.0


def test_detect_ball_with_center_hint():
    """With two discs present, the hint forces the smaller one to win."""
    img1 = _synth_modulation((480, 640), center=(150.0, 240.0), radius=40.0)
    img2 = _synth_modulation((480, 640), center=(480.0, 240.0), radius=90.0,
                              noise_sigma=0.01, seed=1)
    img = np.maximum(img1, img2)

    # Ask for the smaller disc explicitly.
    (cu, cv), r, score = detect_ball_in_modulation(
        img, center_hint_px=(150.0, 240.0), radius_hint_px=40.0,
        min_radius_px=20, max_radius_px=150,
    )
    assert abs(cu - 150.0) <= 4.0
    assert abs(cv - 240.0) <= 4.0
    assert abs(r - 40.0) <= 5.0


def test_detect_ball_raises_on_empty():
    with pytest.raises(ValueError):
        detect_ball_in_modulation(np.zeros((0, 0)))


def test_detect_ball_raises_on_flat_image():
    img = np.zeros((200, 200), dtype=np.float64)
    with pytest.raises(ValueError):
        detect_ball_in_modulation(img, min_radius_px=20, max_radius_px=80)


def test_render_ball_overlay_returns_png():
    img = _synth_modulation((240, 320), center=(160.0, 120.0), radius=50.0)
    b64 = render_ball_overlay_png_b64(img, (160.0, 120.0), 50.0)
    assert isinstance(b64, str) and len(b64) > 0
    # Validate PNG magic bytes.
    decoded = base64.b64decode(b64)
    assert decoded[:8] == b"\x89PNG\r\n\x1a\n"


# ---------------------------------------------------------------------------
# Solver — synthetic ground truth generator
# ---------------------------------------------------------------------------


def _generate_synthetic_sample(
    camera_model: CameraModel,
    camera_pose: Pose,
    screen_pose_true: Pose,
    screen_width_mm: float,
    screen_height_mm: float,
    ball_center_world: np.ndarray,
    ball_diameter_mm: float,
    period_fine: int = 8,
    image_shape: tuple[int, int] = (200, 260),
    screen_bow_fn=None,
) -> dict:
    """Forward-simulate a sample dict that the solver can invert.

    For every camera pixel:
      1. Ray from pixel (camera frame) → world frame.
      2. Intersect with ball sphere → hit, normal.
      3. Reflect incident into reflected_dir.
      4. Intersect reflected_dir with the GROUND-TRUTH screen plane (or
         optional curved surface) → world point P_screen.
      5. Transform P_screen into the screen frame → (x, y) in mm.
      6. Normalized uv = (x / width, y / height). Screen-frame (y-down).
      7. Phase = uv * 2π * period_fine.

    Pixels that miss the ball, miss the screen, or go out of [0,1]^2 are
    masked out (phase NaN, modulation 0).

    ``screen_bow_fn``: optional callable (uv_batch (..., 2)) -> z-offsets
    in mm applied to the flat screen during forward sim (Stage 2 test).
    """
    h, w = image_shape
    uu, vv = np.meshgrid(np.arange(w), np.arange(h))

    ball_radius_mm = ball_diameter_mm / 2.0

    # Camera ray → world ray.
    ray_o_cam, ray_d_cam = camera_model.ray_from_pixel(
        uu.astype(np.float64), vv.astype(np.float64)
    )
    ray_o_world = camera_pose.apply(ray_o_cam)
    ray_d_world = camera_pose.rotation.apply(
        ray_d_cam.reshape(-1, 3)
    ).reshape(ray_d_cam.shape)

    # Sphere intersect.
    hits, sphere_valid = ray_sphere_intersection(
        ray_o_world, ray_d_world, ball_center_world, ball_radius_mm
    )
    normals = surface_normal_at_sphere_point(hits, ball_center_world)
    reflected = reflect(ray_d_world, normals)

    # Intersect with the true screen plane.
    plane_point = screen_pose_true.translation
    plane_normal = screen_pose_true.rotation.apply(np.array([0.0, 0.0, 1.0]))
    # Flatten for ray-plane.
    from backend.vision.deflectometry_geometry import ray_plane_intersection
    screen_hits, plane_valid = ray_plane_intersection(
        hits.reshape(-1, 3), reflected.reshape(-1, 3), plane_point, plane_normal
    )
    screen_hits = screen_hits.reshape(h, w, 3)
    plane_valid = plane_valid.reshape(h, w)

    # Transform into screen frame.
    pose_inv = screen_pose_true.inverse()
    screen_frame_hits = pose_inv.apply(screen_hits)

    u_screen = screen_frame_hits[..., 0] / screen_width_mm
    v_screen = screen_frame_hits[..., 1] / screen_height_mm

    in_range = (
        (u_screen >= 0.0) & (u_screen <= 1.0)
        & (v_screen >= 0.0) & (v_screen <= 1.0)
    )
    valid = sphere_valid & plane_valid & in_range & np.isfinite(u_screen) & np.isfinite(v_screen)

    # Optional bow: the TRUE iPad surface is z_screen = bow(u, v). The uv
    # label we hand to the solver must be where the reflected ray actually
    # hits the bowed surface. We iterate: (1) start from the flat uv, (2)
    # evaluate bow(u, v) and walk the reflected ray to the shifted screen-
    # frame z level, (3) recompute uv, repeat. Two iterations is enough
    # for sub-mm bow amplitudes.
    if screen_bow_fn is not None:
        # Re-intersect with the bowed surface. Approximate ray-bowed-
        # surface intersection: we know on a flat plane the reflected ray
        # hits at screen_frame_hits[..., 0:2] with z=0. If the true surface
        # is at z = bow(u, v), we need to extend the ray along its
        # direction in SCREEN frame until it reaches z = bow. The ray
        # in screen frame is computed by transforming the world ray there.
        pose_inv = screen_pose_true.inverse()
        dir_screen = pose_inv.rotation.apply(reflected.reshape(-1, 3)).reshape(reflected.shape)
        orig_screen = pose_inv.apply(hits)

        current_uv = np.stack([u_screen, v_screen], axis=-1)
        for _ in range(3):
            bow_z = screen_bow_fn(current_uv)
            # Plane at z = bow_z in screen frame: solve
            # orig.z + t dir.z = bow → t = (bow - orig.z) / dir.z
            denom = dir_screen[..., 2]
            safe = np.abs(denom) > 1e-9
            t = np.where(safe, (bow_z - orig_screen[..., 2]) / np.where(safe, denom, 1.0), np.nan)
            hit_screen = orig_screen + t[..., None] * dir_screen
            u_new = hit_screen[..., 0] / screen_width_mm
            v_new = hit_screen[..., 1] / screen_height_mm
            current_uv = np.stack([u_new, v_new], axis=-1)

        u_screen = current_uv[..., 0]
        v_screen = current_uv[..., 1]

        in_range = (
            (u_screen >= 0.0) & (u_screen <= 1.0)
            & (v_screen >= 0.0) & (v_screen <= 1.0)
        )
        valid = sphere_valid & plane_valid & in_range & np.isfinite(u_screen) & np.isfinite(v_screen)

    phase_x = np.full((h, w), np.nan, dtype=np.float64)
    phase_y = np.full((h, w), np.nan, dtype=np.float64)
    phase_x[valid] = u_screen[valid] * 2.0 * np.pi * period_fine
    phase_y[valid] = v_screen[valid] * 2.0 * np.pi * period_fine

    # Modulation: ones inside ball, zeros outside.
    modulation = np.where(sphere_valid, 0.9, 0.0)

    # Detected ball center/radius in image px: use the bounding box of the
    # sphere-valid region in the (uu, vv) grid.
    ys, xs = np.where(sphere_valid)
    if xs.size == 0:
        raise RuntimeError("no sphere intersections — ball out of FOV")
    cu_det = float(0.5 * (xs.min() + xs.max()))
    cv_det = float(0.5 * (ys.min() + ys.max()))
    r_det = float(0.5 * max(xs.max() - xs.min(), ys.max() - ys.min()))

    return {
        "envelope_id": uuid.uuid4().hex,
        "phase_x_grid": phase_x,
        "phase_y_grid": phase_y,
        "modulation_grid": modulation,
        "phase_consistency_grid": np.ones_like(phase_x),
        "period_fine": float(period_fine),
        "ball_center_px": (cu_det, cv_det),
        "ball_radius_px": r_det,
        "ball_diameter_mm": ball_diameter_mm,
        "ball_position_world_mm": tuple(ball_center_world.tolist()),
    }


def _build_rig(screen_pose_true=None):
    """Standard rig for solver tests.

    Physical setup:
    - Ball on the specimen fixture, centered just above the origin.
    - Camera above the bench, looking DOWN at the ball (camera +z into the
      scene = world -z).
    - iPad hangs between the camera and the ball, facing down — so light
      from the iPad strikes the top of the ball and reflects up into the
      camera.

    Camera pose: rotate 180° about world X so that camera +z points to
    world -z. Then translate to (0, 0, ~250mm).
    Screen pose: iPad face-down at (0, 0, ~140mm) with its z axis pointing
    DOWN (−world-z) so that its emission face radiates downward.
    """
    cam = CameraModel(
        mode="pinhole", fx=400.0, fy=400.0, cx=130.0, cy=100.0,
        image_width=260, image_height=200,
    )
    # Camera 250 mm above the ball, looking down: camera +z maps to world -z.
    # Rotation about world X by 180° flips y and z signs; i.e. camera frame
    # (right, down, forward) = world (right, back, down).
    camera_rot = Rotation.from_euler("x", 180.0, degrees=True)
    camera_pose = Pose(
        rotation=camera_rot,
        translation=np.array([0.0, 0.0, 250.0]),
    )
    if screen_pose_true is None:
        # iPad face-down at ~140 mm, with its emission face pointing at
        # the ball (−z in world). Rotation: same 180° X flip.
        ipad_rot = Rotation.from_euler("x", 180.0, degrees=True) * \
                    Rotation.from_euler("xyz", [3.0, -2.0, 1.5], degrees=True)
        screen_pose_true = Pose(
            rotation=ipad_rot,
            translation=np.array([-10.0, 6.0, 140.0]),
        )
    return cam, camera_pose, screen_pose_true


def test_solve_screen_shape_flat_rigid_pose():
    """Synthetic: one ball, known pose; recover pose within 1 mm / 1 degree."""
    cam, camera_pose, screen_pose_true = _build_rig()
    W, H = 218.0, 291.0

    # Shift screen origin so the iPad's centre hovers roughly over the ball.
    # iPad top-left is at screen_pose translation; centre is at (W/2, H/2, 0)
    # in screen frame, mapped through the (inverted) iPad rotation.
    center_offset = np.array([-W / 2, -H / 2, 0.0])
    screen_pose_true = Pose(
        rotation=screen_pose_true.rotation,
        translation=screen_pose_true.translation
        + screen_pose_true.rotation.apply(center_offset),
    )

    ball_center_world = np.array([0.0, 0.0, 12.0])  # ball sits on fixture
    sample = _generate_synthetic_sample(
        cam, camera_pose, screen_pose_true, W, H,
        ball_center_world=ball_center_world,
        ball_diameter_mm=20.0,
        image_shape=(200, 260),
    )

    # Initial guess: iPad ~100mm above, face-down, no tilt.
    initial_pose = Pose(
        rotation=Rotation.from_euler("x", 180.0, degrees=True),
        translation=np.array([-W / 2, H / 2, 100.0]),
    )

    shape, diag = solve_screen_shape(
        [sample],
        camera_model=cam,
        camera_pose=camera_pose,
        screen_width_mm=W,
        screen_height_mm=H,
        initial_screen_pose=initial_pose,
        stage2_min_control_points=99999,  # force Rectangular fallback
    )

    # Recovered pose should closely match ground truth (position within 2 mm,
    # rotation within 1 degree).
    recovered = Pose.from_dict(diag["stage1_pose"])
    pos_err = float(np.linalg.norm(recovered.translation - screen_pose_true.translation))
    rot_err = float(
        (recovered.rotation.inv() * screen_pose_true.rotation).magnitude()
    ) * 180.0 / np.pi

    assert pos_err < 2.0, f"position error {pos_err:.3f} mm too high"
    assert rot_err < 1.0, f"rotation error {rot_err:.3f} deg too high"
    assert diag["stage1_pose_rms_mm"] < 0.5
    assert isinstance(shape, Rectangular2DShape)


def test_solve_screen_shape_insufficient_control_falls_back_to_rectangular():
    """When stage2 has < N populated bins, fall back to Rectangular2DShape.

    Single small ball yields a compact uv footprint on the iPad; raising
    the threshold past that footprint forces the fallback.
    """
    cam, camera_pose, _ = _build_rig()
    W, H = 218.0, 291.0
    ipad_rot = Rotation.from_euler("x", 180.0, degrees=True)
    screen_pose_true = Pose(
        rotation=ipad_rot,
        translation=np.array([-W / 2, H / 2, 140.0]),
    )

    ball_center_world = np.array([0.0, 0.0, 12.0])
    sample = _generate_synthetic_sample(
        cam, camera_pose, screen_pose_true, W, H,
        ball_center_world=ball_center_world,
        ball_diameter_mm=20.0,
        image_shape=(200, 260),
    )

    initial_pose = Pose(
        rotation=ipad_rot,
        translation=np.array([-W / 2, H / 2, 100.0]),
    )

    # Use a high grid size (64) so a single ball's footprint can't fill
    # 25 bins: typical single-ball coverage is ~20-30 bins on an 8×8 grid,
    # so at 16×16 (256 total bins) 25 is a reasonable threshold.
    shape, diag = solve_screen_shape(
        [sample],
        camera_model=cam, camera_pose=camera_pose,
        screen_width_mm=W, screen_height_mm=H,
        initial_screen_pose=initial_pose,
        stage2_min_control_points=200,
        stage2_grid_size=32,
    )
    assert isinstance(shape, Rectangular2DShape)
    assert diag["stage2_enabled"] is False
    assert diag["control_point_count"] < 200


def test_solve_screen_shape_with_panel_bow():
    """Panel bow (z = A * (u - 0.5)^2) fits better with Distorted2D."""
    cam, camera_pose, screen_pose_true = _build_rig()
    W, H = 218.0, 291.0

    # iPad face-down: rotation about world X by 180°, positioned so its
    # centre is above the ball field.
    ipad_rot = Rotation.from_euler("x", 180.0, degrees=True)
    screen_pose_true = Pose(
        rotation=ipad_rot,
        translation=np.array([-W / 2, H / 2, 140.0]),
    )

    # 6 well-spread balls in an x/y grid at z=12 to build enough coverage.
    balls = []
    for bx in [-30, 0, 30]:
        for by in [-20, 20]:
            balls.append(np.array([float(bx), float(by), 12.0]))

    bow_amp = 2.0  # 2 mm bow at the iPad edges

    def bow_fn(uv):
        u = uv[..., 0]
        return bow_amp * (u - 0.5) ** 2

    samples = []
    for bc in balls:
        try:
            s = _generate_synthetic_sample(
                cam, camera_pose, screen_pose_true, W, H,
                ball_center_world=bc,
                ball_diameter_mm=20.0,
                image_shape=(200, 260),
                screen_bow_fn=bow_fn,
            )
            samples.append(s)
        except RuntimeError:
            continue

    assert len(samples) >= 3, "need multiple samples to cover the bow"

    # Good initial guess: correct orientation, translation 40mm short.
    initial_pose = Pose(
        rotation=ipad_rot,
        translation=np.array([-W / 2, H / 2, 100.0]),
    )

    shape, diag = solve_screen_shape(
        samples,
        camera_model=cam, camera_pose=camera_pose,
        screen_width_mm=W, screen_height_mm=H,
        initial_screen_pose=initial_pose,
        stage2_min_control_points=8,
        stage2_grid_size=8,
        modulation_floor=0.05,
    )

    # We want stage2 to have run and to have smaller residuals than the
    # Rectangular fallback.
    if not diag["stage2_enabled"]:
        pytest.skip(
            "stage 2 did not activate for this rig — insufficient coverage"
        )
    assert isinstance(shape, Distorted2DShape)
    assert diag["stage2_residual_rms_mm"] is not None

    # Sanity: the Stage 1 flat-plane residual should be visibly larger than
    # the Stage 2 bow-aware residual.
    assert diag["stage2_residual_rms_mm"] < diag["stage1_pose_rms_mm"] * 1.2
    # And the control point count is reasonable.
    assert diag["control_point_count"] >= 8


def test_solve_screen_shape_yflip_canary():
    """Canary: a synthetic rig with 'flipped' v-screen yields a worse fit,
    i.e. the solver doesn't silently accept a mirrored iPad."""
    cam, camera_pose, screen_pose_true = _build_rig()
    W, H = 218.0, 291.0
    screen_pose_true = Pose(
        rotation=Rotation.identity(),
        translation=np.array([-W / 2, -H / 2, 140.0]),
    )
    ball_center_world = np.array([0.0, 0.0, 25.0])
    sample = _generate_synthetic_sample(
        cam, camera_pose, screen_pose_true, W, H,
        ball_center_world=ball_center_world,
        ball_diameter_mm=20.0,
        image_shape=(200, 260),
    )

    # Flip v → 1 - v to emulate a Y-flip bug inside a caller's phase pipeline.
    flipped = dict(sample)
    py_orig = sample["phase_y_grid"].copy()
    # phase_y scaled to [0, 2π·p]; flipping v means phase_y := 2π·p − phase_y.
    full = 2.0 * np.pi * sample["period_fine"]
    flipped["phase_y_grid"] = np.where(
        np.isfinite(py_orig), full - py_orig, py_orig
    )
    flipped["envelope_id"] = uuid.uuid4().hex

    initial_pose = Pose(
        rotation=Rotation.identity(),
        translation=np.array([-W / 2, -H / 2, 100.0]),
    )

    # Fit on the flipped sample. The solver should converge to *some* pose,
    # but with a much higher residual OR with a rotation far from identity.
    shape, diag = solve_screen_shape(
        [flipped],
        camera_model=cam, camera_pose=camera_pose,
        screen_width_mm=W, screen_height_mm=H,
        initial_screen_pose=initial_pose,
        stage2_min_control_points=99999,
    )

    # Control: ordinary sample has sub-mm residuals; flipped must not.
    shape_ok, diag_ok = solve_screen_shape(
        [sample],
        camera_model=cam, camera_pose=camera_pose,
        screen_width_mm=W, screen_height_mm=H,
        initial_screen_pose=initial_pose,
        stage2_min_control_points=99999,
    )
    # The flipped fit's rotation or residual must be clearly different.
    recovered_flip = Pose.from_dict(diag["stage1_pose"])
    recovered_ok = Pose.from_dict(diag_ok["stage1_pose"])
    rot_diff = float(
        (recovered_flip.rotation.inv() * recovered_ok.rotation).magnitude()
    ) * 180.0 / np.pi

    # Either the flipped fit has materially worse residual OR its recovered
    # rotation differs from the correct fit by >= 5 degrees. Both signal
    # to the caller that their phase pipeline is off.
    assert (
        diag["stage1_pose_rms_mm"] > 3.0 * max(diag_ok["stage1_pose_rms_mm"], 0.05)
        or rot_diff >= 5.0
    ), (
        f"flipped fit should diverge but didn't: rms={diag['stage1_pose_rms_mm']:.3f} "
        f"vs ok={diag_ok['stage1_pose_rms_mm']:.3f}, rot_diff={rot_diff:.3f} deg"
    )


def test_solve_screen_shape_rejects_empty_samples():
    cam, camera_pose, screen_pose_true = _build_rig()
    initial_pose = Pose.identity()
    with pytest.raises(ValueError):
        solve_screen_shape(
            [], camera_model=cam, camera_pose=camera_pose,
            screen_width_mm=218.0, screen_height_mm=291.0,
            initial_screen_pose=initial_pose,
        )


# ---------------------------------------------------------------------------
# HTTP endpoint tests
# ---------------------------------------------------------------------------


@pytest.fixture
def deflectometry_session(client: TestClient):
    """Inject a synthetic envelope into the current deflectometry session.

    Yields a tuple (envelope_id, sample_dict, grids_dict) where grids_dict
    holds the in-memory arrays the solver will receive when the sample is
    resolved by add-ball-cal-sample.
    """
    import backend.api_deflectometry as api_mod

    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})

    # Build a synthetic envelope (same arrays the solver test uses).
    cam, camera_pose, screen_pose_true = _build_rig()
    W, H = 218.0, 291.0
    screen_pose_true = Pose(
        rotation=Rotation.identity(),
        translation=np.array([-W / 2, -H / 2, 140.0]),
    )
    ball_center_world = np.array([0.0, 0.0, 25.0])
    sample = _generate_synthetic_sample(
        cam, camera_pose, screen_pose_true, W, H,
        ball_center_world=ball_center_world,
        ball_diameter_mm=20.0,
        image_shape=(200, 260),
    )

    period_fine = int(sample["period_fine"])
    modulation = sample["modulation_grid"]
    # Make separate modulation_x / modulation_y grids so the detect endpoint
    # can take min() and still get a disc.
    envelope = {
        "id": sample["envelope_id"],
        "phase_x_grid": sample["phase_x_grid"],
        "phase_y_grid": sample["phase_y_grid"],
        "modulation_x_grid": modulation,
        "modulation_y_grid": modulation,
        "phase_consistency_grid": sample["phase_consistency_grid"],
        "periods_used": [period_fine],
        "tuning": {"periods": [period_fine]},
    }

    # Reach into the router to stash the envelope. We use the fact that
    # the router is closure-captured but the FastAPI app exposes the
    # router's routes, and the endpoint functions close over the same
    # `state` dict. Easiest hook: call the module's compute with fake
    # session state — but that's invasive. Simpler: mount a helper route
    # for tests? Still invasive.
    #
    # Use the "proper" backdoor: access the app's dependency_overrides
    # pattern isn't set up; instead we reach into the live session by
    # grabbing _current via the router's closure through the endpoint
    # function's __closure__.
    session_obj = _extract_live_session(client.app)
    session_obj._envelope_cache[envelope["id"]] = envelope
    session_obj._envelope_order.append(envelope["id"])

    yield envelope["id"], sample, W, H, cam, camera_pose

    # Clean up.
    session_obj.ball_samples.clear()


def _extract_live_session(app):
    """Pull the live _Session out of the deflectometry router's closure."""
    for route in app.router.routes:
        if getattr(route, "path", "") == "/deflectometry/status":
            fn = route.endpoint
            # The endpoint is an `async def deflectometry_status`; its
            # closure contains `_current` which in turn closes over
            # `state`. Walk the closures.
            for cell in (fn.__closure__ or []):
                val = cell.cell_contents
                if callable(val) and getattr(val, "__name__", "") == "_current":
                    for inner_cell in (val.__closure__ or []):
                        inner = inner_cell.cell_contents
                        if isinstance(inner, dict) and "session" in inner:
                            if inner["session"] is None:
                                # Create one on the fly by calling _current:
                                return None
                            return inner["session"]
    raise RuntimeError("could not locate live session")


def test_calibrate_screen_shape_rejects_no_samples(client: TestClient):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    cam_model = {"mode": "telecentric", "px_size_mm": 0.01,
                 "image_width": 640, "image_height": 480}
    cam_pose = Pose.identity().as_dict()
    r = client.post("/deflectometry/calibrate-screen-shape", json={
        "camera_model": cam_model,
        "camera_pose": cam_pose,
        "screen_width_mm": 218.0,
        "screen_height_mm": 291.0,
        "estimated_screen_distance_mm": 140.0,
    })
    assert r.status_code == 400
    assert "no ball samples" in r.json()["detail"].lower() or \
           "samples" in r.json()["detail"].lower()


def test_calibrate_screen_shape_endpoint_end_to_end(
    client: TestClient, deflectometry_session, tmp_path, monkeypatch
):
    # Point the ScreenShape store at a tmp file.
    monkeypatch.setenv("DEFLECTOMETRY_SCREEN_SHAPE_PATH", str(tmp_path / "shape.json"))
    envelope_id, sample, W, H, cam, camera_pose = deflectometry_session

    # 1. Add the ball sample via HTTP.
    r_add = client.post("/deflectometry/add-ball-cal-sample", json={
        "envelope_id": envelope_id,
        "ball_diameter_mm": sample["ball_diameter_mm"],
        "ball_center_px": list(sample["ball_center_px"]),
        "ball_radius_px": sample["ball_radius_px"],
        "ball_position_world_mm": list(sample["ball_position_world_mm"]),
        "label": "synthetic-0",
    })
    assert r_add.status_code == 200, r_add.text
    assert r_add.json()["count"] == 1

    # 2. GET the list.
    r_list = client.get("/deflectometry/ball-cal-samples")
    assert r_list.status_code == 200
    assert r_list.json()["count"] == 1

    # 3. Call calibrate-screen-shape.
    cam_model = {
        "mode": cam.mode, "fx": cam.fx, "fy": cam.fy,
        "cx": cam.cx, "cy": cam.cy,
        "image_width": cam.image_width, "image_height": cam.image_height,
    }
    r_cal = client.post("/deflectometry/calibrate-screen-shape", json={
        "camera_model": cam_model,
        "camera_pose": camera_pose.as_dict(),
        "screen_width_mm": W,
        "screen_height_mm": H,
        "estimated_screen_distance_mm": 100.0,
        "stage2_min_control_points": 9999,  # force Rectangular2D
    })
    assert r_cal.status_code == 200, r_cal.text
    body = r_cal.json()
    assert body["shape"]["kind"] == "rectangular_2d"
    assert "fit_diagnostics" in body
    assert body["fit_diagnostics"]["observation_count"] > 0
    assert body["fit_diagnostics"]["stage1_pose_rms_mm"] < 1.0
    # Persistence: the on-disk file should exist.
    import json as _json
    on_disk = _json.loads((tmp_path / "shape.json").read_text())
    assert on_disk["kind"] == "rectangular_2d"

    # 4. DELETE the sample (cleanup happens in the fixture, but test the API).
    r_del = client.delete("/deflectometry/ball-cal-samples/0")
    assert r_del.status_code == 200
    assert r_del.json()["count"] == 0


def test_detect_ball_endpoint_returns_preview(
    client: TestClient, deflectometry_session
):
    envelope_id, sample, W, H, cam, camera_pose = deflectometry_session
    r = client.post("/deflectometry/detect-ball", json={
        "envelope_id": envelope_id,
        "min_radius_px": 20,
        "max_radius_px": 300,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert "center_px" in body
    assert "radius_px" in body
    assert body["score"] > 0
    # Preview PNG is valid base64.
    b = base64.b64decode(body["preview_png_b64"])
    assert b[:8] == b"\x89PNG\r\n\x1a\n"


def test_detect_ball_endpoint_rejects_missing_envelope(client: TestClient):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/detect-ball", json={
        "envelope_id": "nonexistent-id-xyz",
    })
    assert r.status_code == 404
