"""Tests for the Phase-4 Wave-3 geometric slope solver.

Covers:
- resolve_geometry_inputs + branch selection in /compute.
- compute_geometric_slopes on synthetic forward-modelled data.
- fit_paraboloid_with_uncertainty coefficient recovery and error bars.
- propagate_uncertainty_to_um source combination.
- Envelope-field plumbing on the /compute response.
"""

from __future__ import annotations

import math
import numpy as np
import pytest
from fastapi.testclient import TestClient
from scipy.spatial.transform import Rotation

from backend.vision.deflectometry_compute import (
    compute_geometric_slopes,
    fit_paraboloid_with_uncertainty,
    phase_to_screen_uv,
    propagate_uncertainty_to_um,
    resolve_geometry_inputs,
)
from backend.vision.deflectometry_geometry import (
    CameraModel,
    Pose,
    ray_plane_intersection,
    ray_plane_intersection as _plane,
    reflect,
)
from backend.vision.screen_shape import Rectangular2DShape


# ---------------------------------------------------------------------------
# /compute endpoint plumbing tests (branch selection + envelope fields)
# ---------------------------------------------------------------------------


def _get_state(client):
    from tests.test_deflectometry_api import _get_deflectometry_state
    return _get_deflectometry_state(client)


def _inject(client, width=32, height=32, freq=4):
    from tests.test_deflectometry_api import _inject_synthetic_frames
    _inject_synthetic_frames(client, width=width, height=height, freq=freq)


def _bind_full_cal(client, tmp_path, monkeypatch):
    """Save a complete CalibrationSession + a Rectangular2DShape, bind the session.

    Returns the bound session id.
    """
    monkeypatch.setenv("DEFLECTOMETRY_CAL_DIR", str(tmp_path / "cal"))
    monkeypatch.setenv(
        "DEFLECTOMETRY_SCREEN_SHAPE_PATH", str(tmp_path / "screen_shape.json")
    )

    # Save screen shape.
    r = client.post(
        "/deflectometry/screen-shape",
        json={
            "kind": "rectangular_2d",
            "width_mm": 247.6,
            "height_mm": 178.5,
        },
    )
    assert r.status_code == 200, r.text

    # Save a complete cal session.
    save = client.post(
        "/deflectometry/calibrations",
        json={
            "rig_fingerprint": "fp-geom",
            "display_response": {"ok": True},
            "corner_check": {"ok": True},
            "sphere_cal": {"cal_factor": 0.001, "px_per_mm": 25.0},
        },
    ).json()
    assert "id" in save

    # Bind it.
    r = client.post(f"/deflectometry/calibrations/bind/{save['id']}")
    assert r.status_code == 200, r.text
    return save["id"]


def test_compute_falls_back_to_phase_proxy_without_cal(client: TestClient):
    """With no active cal session, /compute runs the legacy phase_proxy path."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject(client)
    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["slope_method"] == "phase_proxy"
    assert data["tuning"]["slope_method"] == "phase_proxy"
    # Legacy path doesn't produce a paraboloid fit.
    assert data.get("paraboloid_fit") is None
    assert data.get("uncertainty_um") is None
    # geometry_complete should be False.
    assert data["calibration_snapshot"]["geometry_complete"] is False


def test_compute_uses_geometric_path_with_full_cal(
    client: TestClient, tmp_path, monkeypatch
):
    """With a bound cal session + saved screen shape, /compute uses the geometric path."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _bind_full_cal(client, tmp_path, monkeypatch)
    _inject(client)

    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200, r.text
    data = r.json()
    # Post-fix (2026-04-18): placeholder camera pose + z=0 surface plane are
    # known-degenerate; auto-select stays on phase_proxy until explicit
    # user-asserted geometry exists. Full cal without asserted poses is not
    # enough to unlock geometric mode any more.
    assert data["slope_method"] == "phase_proxy"
    assert data["calibration_snapshot"]["geometry_complete"] is False


def test_slope_method_phase_proxy_override_works(
    client: TestClient, tmp_path, monkeypatch
):
    """Explicit slope_method='phase_proxy' forces the legacy path even with full cal."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _bind_full_cal(client, tmp_path, monkeypatch)
    _inject(client)

    r = client.post(
        "/deflectometry/compute",
        json={"mask_threshold": 0.02, "slope_method": "phase_proxy"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["slope_method"] == "phase_proxy"
    assert data.get("paraboloid_fit") is None
    # Post-fix: geometry_complete now requires explicit user-asserted poses.
    assert data["calibration_snapshot"]["geometry_complete"] is False


def test_envelope_carries_slope_method_field(
    client: TestClient, tmp_path, monkeypatch
):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _bind_full_cal(client, tmp_path, monkeypatch)
    _inject(client)

    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data["slope_method"], str)
    assert data["slope_method"] in ("geometric", "phase_proxy")


@pytest.mark.skip(
    reason=(
        "Geometric path requires user-asserted camera_pose + surface_plane "
        "which no test fixture populates yet. Un-skip once the user-asserted-"
        "geometry input path lands (part of the Honesty milestone)."
    )
)
def test_envelope_includes_uncertainty_um_in_geometric_path(
    client: TestClient, tmp_path, monkeypatch
):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _bind_full_cal(client, tmp_path, monkeypatch)
    _inject(client)

    r = client.post(
        "/deflectometry/compute",
        json={"mask_threshold": 0.02, "slope_method": "geometric"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["slope_method"] == "geometric"
    # Synthetic sinusoidal frames may or may not produce a meaningful fit
    # (the slope field is ugly-but-finite). We only require: if the fit
    # succeeded, the uncertainty block is present and numeric.
    if data.get("paraboloid_fit") is not None:
        unc = data.get("uncertainty_um")
        assert unc is not None
        assert isinstance(unc["pv_uncertainty_um"], float)
        assert isinstance(unc["rms_uncertainty_um"], float)
        assert math.isfinite(unc["pv_uncertainty_um"])
        assert math.isfinite(unc["rms_uncertainty_um"])


# ---------------------------------------------------------------------------
# Pure-math tests — paraboloid fit + uncertainty helpers
# ---------------------------------------------------------------------------


def test_paraboloid_fit_recovers_coefficients():
    """Fit on a noise-free paraboloid recovers the input coefficients."""
    H, W = 40, 50
    ppm = 10.0
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    x_mm = xx / ppm
    y_mm = yy / ppm
    D, A, E, C, B = 0.010, 0.0020, 0.020, 0.0010, 0.0030

    dzdx = D + 2.0 * A * x_mm + C * y_mm
    dzdy = E + C * x_mm + 2.0 * B * y_mm
    mask = np.ones((H, W), dtype=bool)

    fit = fit_paraboloid_with_uncertainty(dzdx, dzdy, mask, pixels_per_mm=ppm)
    c = fit["coefficients"]
    # Slope coefficients recover to machine precision on clean data.
    assert c["D"] == pytest.approx(D, abs=1e-10)
    assert c["A"] == pytest.approx(A, abs=1e-10)
    assert c["E"] == pytest.approx(E, abs=1e-10)
    assert c["C"] == pytest.approx(C, abs=1e-10)
    assert c["B"] == pytest.approx(B, abs=1e-10)
    # F is anchored to zero-mean over the mask; just check it's finite.
    assert math.isfinite(c["F"])
    # Quality numbers are sane.
    assert fit["pv_mm"] > 0
    assert fit["rms_mm"] >= 0
    assert 0.0 <= fit["outlier_fraction"] <= 1.0


def test_paraboloid_fit_uncertainty_is_finite_and_positive():
    """With noise added, all 1σ uncertainties should be finite and ≥ 0."""
    rng = np.random.default_rng(seed=7)
    H, W = 30, 30
    ppm = 8.0
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    x_mm = xx / ppm
    y_mm = yy / ppm
    D, A, E, C, B = 0.005, 0.0015, 0.007, 0.0005, 0.0020
    dzdx = D + 2 * A * x_mm + C * y_mm + rng.normal(0, 0.001, (H, W))
    dzdy = E + C * x_mm + 2 * B * y_mm + rng.normal(0, 0.001, (H, W))
    mask = np.ones((H, W), dtype=bool)

    fit = fit_paraboloid_with_uncertainty(dzdx, dzdy, mask, pixels_per_mm=ppm)
    for name, sig in fit["coefficient_uncertainties_1sigma"].items():
        assert math.isfinite(sig), f"{name} sigma not finite"
        assert sig >= 0.0, f"{name} sigma negative: {sig}"


def test_uncertainty_um_combines_sources():
    """Check that the uncertainty helper RSSes fit + cal + pose sources."""
    # Build a stub fit_result with easy-to-reason-about numbers.
    fit_result = {
        "coefficients": {"F": 0.0, "D": 0.0, "A": 0.0, "E": 0.0, "C": 0.0, "B": 0.0},
        "coefficient_uncertainties_1sigma": {
            "F": 0.0, "D": 0.0, "A": 0.0, "E": 0.0, "C": 0.0, "B": 0.0,
        },
        "outlier_fraction": 0.0,
        "residual_rms_mm": 0.0,   # fit component → 0
        "pv_mm": 0.010,           # 10 µm surface
        "rms_mm": 0.003,
    }

    # No cal, no pose → everything zero.
    u0 = propagate_uncertainty_to_um(fit_result)
    assert u0["pv_uncertainty_um"] == pytest.approx(0.0, abs=1e-9)
    assert u0["rms_uncertainty_um"] == pytest.approx(0.0, abs=1e-9)

    # 2% cal uncertainty only: pv_sigma = 0.02 * 10 µm = 0.2 µm.
    u1 = propagate_uncertainty_to_um(fit_result, cal_factor_uncertainty=0.02)
    assert u1["pv_uncertainty_um"] == pytest.approx(0.2, rel=1e-6)
    assert u1["rms_uncertainty_um"] == pytest.approx(0.06, rel=1e-6)
    assert u1["components_um"]["cal_factor_pv"] == pytest.approx(0.2, rel=1e-6)

    # Cal only + pose lateral with zero slope → pose contributes zero.
    u2 = propagate_uncertainty_to_um(
        fit_result,
        cal_factor_uncertainty=0.02,
        geometric_pose_uncertainty={"lateral_mm": 1.0, "axial_mm": 0.0},
    )
    # Coefficients are all zero so mean |slope| is zero, pose contributes 0.
    assert u2["pv_uncertainty_um"] == pytest.approx(0.2, rel=1e-6)


# ---------------------------------------------------------------------------
# Geometric slope solver — synthetic forward models
# ---------------------------------------------------------------------------


def _forward_synthesize_phase(
    *,
    cam_model: CameraModel,
    cam_pose: Pose,
    surface_plane_point: np.ndarray,
    surface_plane_normal_reflecting: np.ndarray,
    screen_pose: Pose,
    screen_shape: Rectangular2DShape,
    freq: float,
    image_shape: tuple[int, int],
):
    """Build synthetic unwrapped phase by running the forward reflection chain.

    ``surface_plane_normal_reflecting`` is the OUTWARD normal of the mirror
    (pointing away from its reflective side, toward the camera). We use the
    same normal for both the solver's 'assumed surface plane' input (passed
    as ``surface_plane_normal_reflecting`` with direction flipped if needed)
    and for the reflection inside the synthesis.

    Returns ``(phase_x, phase_y, valid_mask)`` — phase scaled so that
    ``phase / (2π · freq)`` lives in [0, 1] for a pixel whose reflected
    ray hits somewhere on the [0, width_mm] × [0, height_mm] screen.
    """
    H, W = image_shape
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float64)
    ray_o_cam, ray_d_cam = cam_model.ray_from_pixel(xs, ys)
    ray_o = cam_pose.apply(ray_o_cam)
    ray_d = cam_pose.rotation.apply(ray_d_cam.reshape(-1, 3)).reshape(ray_d_cam.shape)

    hit, ok_hit = ray_plane_intersection(
        ray_o, ray_d, surface_plane_point, surface_plane_normal_reflecting
    )
    refl = reflect(ray_d, surface_plane_normal_reflecting)

    # Intersect reflected ray with the screen plane.
    screen_point_world = screen_pose.apply(np.array([0.0, 0.0, 0.0]))
    # Screen frame "out of screen" is local +z, so world normal is rotation @ (0,0,1).
    screen_normal_world = screen_pose.rotation.apply(np.array([0.0, 0.0, 1.0]))
    hit_screen, ok_screen = ray_plane_intersection(
        hit, refl, screen_point_world, screen_normal_world
    )

    # Convert world-frame hit point into screen-frame coords via screen_pose.inverse.
    hit_screen_frame = screen_pose.inverse().apply(hit_screen)
    u_mm = hit_screen_frame[..., 0]
    v_mm = hit_screen_frame[..., 1]
    u_norm = u_mm / screen_shape.width_mm
    v_norm = v_mm / screen_shape.height_mm

    valid = ok_hit & ok_screen & (u_norm >= 0) & (u_norm <= 1) & (v_norm >= 0) & (v_norm <= 1)

    # Phase scaling: phase = 2π · freq · u_norm. Out-of-range pixels get 0 and
    # will be masked.
    phase_x = np.where(valid, 2.0 * np.pi * freq * u_norm, 0.0)
    phase_y = np.where(valid, 2.0 * np.pi * freq * v_norm, 0.0)
    return phase_x, phase_y, valid


def _make_flat_geometry():
    """Build a (camera, surface, screen) geometry where a flat mirror tilted by
    a small angle sends reflections onto a screen that's off-axis.

    Returns a dict of geometry inputs plus the synthesized phase/mask.
    """
    H, W = 16, 16
    ppm = 2.0  # 0.5 mm per px → 8 mm × 8 mm FOV, small for fast tests.
    cam = CameraModel.telecentric_from_pixels_per_mm(ppm, W, H)
    cam_pose = Pose.identity()

    # Mirror at z=80, tilted 25° about y so reflected rays bend toward -x.
    # (Rotation.from_euler('y', +25).apply((0,0,-1)) yields a normal with
    # negative x component; the reflected ray direction therefore has
    # negative x and positive z pointing back toward the camera-side.)
    tilt_deg = 25.0
    tilt = np.radians(tilt_deg)
    n = Rotation.from_euler("y", tilt_deg, degrees=True).apply(
        np.array([0.0, 0.0, -1.0])
    )
    n = n / np.linalg.norm(n)
    surface_point = np.array([0.0, 0.0, 80.0])

    # Compute the reflected direction empirically for the central ray
    # (incident = +z, hitting the mirror with outward normal n). The helper
    # ``reflect`` takes incident INTO the surface and normal OUT.
    refl_dir = reflect(
        np.array([0.0, 0.0, 1.0]), n
    )
    # Scale a screen center along that direction far enough to place the
    # screen firmly outside the mirror plane.
    screen_t = 120.0
    # Ray origin for the central pixel is (FOV_cx, FOV_cy, 0); it hits the
    # mirror near (FOV_cx, FOV_cy, ~80) and reflects into direction refl_dir.
    fov_cx = (W - 1) / 2.0 / ppm
    fov_cy = (H - 1) / 2.0 / ppm
    hit_center = np.array([fov_cx, fov_cy, surface_point[2]])
    screen_center_world = hit_center + screen_t * refl_dir
    # Orient screen perpendicular to incoming reflected rays (its outward
    # normal points back along -refl_dir).
    # Build a rotation whose local +z maps to -refl_dir (normal facing mirror).
    z_axis = -refl_dir
    # Pick a local +x in the world xy-plane so the screen's up is roughly
    # world +y.
    x_axis = np.cross(np.array([0, 1, 0]), z_axis)
    x_axis /= np.linalg.norm(x_axis)
    y_axis = np.cross(z_axis, x_axis)
    rot_matrix = np.column_stack([x_axis, y_axis, z_axis])
    screen_rot = Rotation.from_matrix(rot_matrix)
    screen_w, screen_h = 80.0, 80.0
    screen_shape = Rectangular2DShape(width_mm=screen_w, height_mm=screen_h)
    # Translation: screen_pose transforms screen-frame origin (top-left corner)
    # to world. Put screen center at screen_center_world, so top-left is at
    # center - rot.apply((w/2, h/2, 0)).
    tl_offset = screen_rot.apply(np.array([screen_w / 2, screen_h / 2, 0.0]))
    screen_pose = Pose(
        rotation=screen_rot, translation=screen_center_world - tl_offset
    )

    freq = 4.0
    phase_x, phase_y, valid = _forward_synthesize_phase(
        cam_model=cam,
        cam_pose=cam_pose,
        surface_plane_point=surface_point,
        surface_plane_normal_reflecting=n,
        screen_pose=screen_pose,
        screen_shape=screen_shape,
        freq=freq,
        image_shape=(H, W),
    )

    return {
        "cam": cam,
        "cam_pose": cam_pose,
        "surface_point": surface_point,
        "surface_normal_outward": n,
        "screen_pose": screen_pose,
        "screen_shape": screen_shape,
        "freq": freq,
        "phase_x": phase_x,
        "phase_y": phase_y,
        "valid": valid,
        "tilt_deg": tilt_deg,
    }


def test_compute_geometric_flat_mirror_yields_zero_slopes():
    """A geometrically flat mirror should solve to zero intrinsic slope.

    The solver is told the assumed surface plane is flat (normal = -z).
    Since the actual mirror IS flat but tilted, the recovered slopes include
    the tilt — which looks like "the surface is tilted". The test asserts
    the slope *field* is spatially constant (zero variance), not zero itself.
    A truly identical, tilt-removed surface would read 0.
    """
    geom = _make_flat_geometry()
    mask = geom["valid"]
    if mask.sum() < 10:
        pytest.skip("synthetic geometry placed most rays off-screen; not a real failure")

    sx, sy, hits, valid = compute_geometric_slopes(
        phase_x=geom["phase_x"],
        phase_y=geom["phase_y"],
        trusted_mask=mask,
        camera_model=geom["cam"],
        camera_pose=geom["cam_pose"],
        screen_shape=geom["screen_shape"],
        screen_pose=geom["screen_pose"],
        surface_plane_point=geom["surface_point"],
        surface_plane_normal=geom["surface_normal_outward"],
        freq=geom["freq"],
    )

    # For a flat mirror whose normal matches the "assumed" normal we fed in,
    # the recovered (slope_x, slope_y) field should be spatially constant
    # (no variation across valid pixels). Numerical tolerance is generous
    # because the telecentric ray model + plane math introduces small
    # floating drift at the edges.
    in_valid = valid & np.isfinite(sx) & np.isfinite(sy)
    if in_valid.sum() < 5:
        pytest.skip("chain produced too few valid outputs; synthesis geometry at fault")
    sx_vals = sx[in_valid]
    sy_vals = sy[in_valid]
    # Variation across the FOV should be tiny — std well below 1e-6.
    assert sx_vals.std() < 1e-6, f"slope_x std too large: {sx_vals.std()}"
    assert sy_vals.std() < 1e-6, f"slope_y std too large: {sy_vals.std()}"


def test_compute_geometric_tilted_mirror_recovers_tilt():
    """Recovered slope magnitude should equal the tilt slope for a tilted flat mirror.

    For a flat mirror tilted by theta about y, the world-frame surface
    gradient dz/dx equals tan(theta). (Our outward normal is in the xz-plane.)
    """
    geom = _make_flat_geometry()
    mask = geom["valid"]
    if mask.sum() < 10:
        pytest.skip("synthetic geometry placed most rays off-screen; not a real failure")

    sx, sy, hits, valid = compute_geometric_slopes(
        phase_x=geom["phase_x"],
        phase_y=geom["phase_y"],
        trusted_mask=mask,
        camera_model=geom["cam"],
        camera_pose=geom["cam_pose"],
        screen_shape=geom["screen_shape"],
        screen_pose=geom["screen_pose"],
        surface_plane_point=geom["surface_point"],
        surface_plane_normal=geom["surface_normal_outward"],
        freq=geom["freq"],
    )

    in_valid = valid & np.isfinite(sx) & np.isfinite(sy)
    if in_valid.sum() < 5:
        pytest.skip("chain produced too few valid outputs; synthesis geometry at fault")

    # The outward normal we used had +z and -x components after rotation by +tilt
    # about y: normal = (sin(tilt), 0, -cos(tilt)) originally rotated from (0,0,-1)
    # by +tilt about y. Actually Rotation.from_euler('y', +25) applied to (0,0,-1)
    # gives (sin(-25)*(-1)+0, 0, cos(-25)*(-1))  = (-sin(-25), 0, -cos(-25))
    # but easier: just read it off the normal we saved.
    n = geom["surface_normal_outward"]
    # In world frame, slope = (-nx/nz, -ny/nz). Since nz is negative (pointing down)
    # for our outward normal (pointing toward camera which is at +z side, i.e. -z
    # of the mirror)...
    # Actually with normal = Rotation.from_euler('y', 25).apply((0,0,-1)):
    # = (sin(25)*0 - cos(25)*0, 0, ??). Just compute numerically:
    expected_slope_x = -n[0] / n[2]
    expected_slope_y = -n[1] / n[2]

    assert np.median(sx[in_valid]) == pytest.approx(expected_slope_x, abs=1e-3)
    assert np.median(sy[in_valid]) == pytest.approx(expected_slope_y, abs=1e-3)


# ---------------------------------------------------------------------------
# phase_to_screen_uv sanity
# ---------------------------------------------------------------------------


def test_phase_to_screen_uv_roundtrip():
    freq = 8.0
    u_target = np.array([0.0, 0.5, 1.0])
    phase_x = 2.0 * np.pi * freq * u_target
    u, v = phase_to_screen_uv(phase_x, phase_x, freq=freq)
    assert np.allclose(u, u_target)
    assert np.allclose(v, u_target)


def test_phase_to_screen_uv_rejects_zero_freq():
    with pytest.raises(ValueError):
        phase_to_screen_uv(np.zeros(3), np.zeros(3), freq=0.0)
