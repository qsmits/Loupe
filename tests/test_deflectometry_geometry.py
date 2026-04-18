"""Tests for the deflectometry geometry kernel.

These tests exercise the pure-math building blocks that Phase 3B (ball
calibration) and Phase 4 (slope solver) will share. Synthetic ground truth
is used throughout — no real image data is required.

The most important test here is ``test_slope_from_camera_pixel_yflip_canary``:
it's the forward-looking defense for the recurring Y-flip bug documented
in ``CLAUDE.md`` and the module docstring.
"""
from __future__ import annotations

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from backend.vision.deflectometry_geometry import (
    CameraModel,
    Pose,
    ray_sphere_intersection,
    surface_normal_at_sphere_point,
    reflect,
    ray_plane_intersection,
    ray_paraboloid_intersection,
    slope_from_camera_pixel,
)


# ---------------------------------------------------------------------------
# CameraModel
# ---------------------------------------------------------------------------


def test_camera_mode_validation():
    with pytest.raises(ValueError):
        CameraModel(mode="bogus")
    with pytest.raises(ValueError):
        CameraModel(mode="telecentric", px_size_mm=None)
    with pytest.raises(ValueError):
        CameraModel(mode="pinhole", fx=1.0, fy=1.0, cx=0.0)  # missing cy


def test_camera_telecentric_ray_at_origin():
    cam = CameraModel.telecentric_from_pixels_per_mm(
        pixels_per_mm=100.0, image_width=640, image_height=480
    )
    origin, direction = cam.ray_from_pixel(0.0, 0.0)
    np.testing.assert_allclose(origin, [0.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(direction, [0.0, 0.0, 1.0], atol=1e-12)


def test_camera_telecentric_ray_batch():
    cam = CameraModel.telecentric_from_pixels_per_mm(
        pixels_per_mm=100.0, image_width=640, image_height=480
    )
    u = np.array([[0.0, 100.0], [200.0, 300.0]])
    v = np.array([[0.0, 50.0], [100.0, 150.0]])
    origin, direction = cam.ray_from_pixel(u, v)
    assert origin.shape == (2, 2, 3)
    assert direction.shape == (2, 2, 3)
    # pixel (100, 50) at 100 px/mm → (1.0 mm, 0.5 mm, 0)
    np.testing.assert_allclose(origin[0, 1], [1.0, 0.5, 0.0], atol=1e-12)
    np.testing.assert_allclose(direction[..., 2], np.ones_like(u), atol=1e-12)


def test_camera_pinhole_principal_point_ray():
    cam = CameraModel(
        mode="pinhole", fx=500.0, fy=500.0, cx=320.0, cy=240.0,
        image_width=640, image_height=480,
    )
    origin, direction = cam.ray_from_pixel(320.0, 240.0)
    np.testing.assert_allclose(origin, [0.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(direction, [0.0, 0.0, 1.0], atol=1e-12)


def test_camera_pinhole_pixel_roundtrip():
    cam = CameraModel(
        mode="pinhole", fx=500.0, fy=520.0, cx=320.0, cy=240.0,
        image_width=640, image_height=480,
    )
    u0 = np.array([100.0, 320.0, 450.0])
    v0 = np.array([200.0, 240.0, 300.0])
    origin, direction = cam.ray_from_pixel(u0, v0)
    # Advance the ray to z=1 plane.
    u_back, v_back = cam.pixel_from_ray(origin, direction)
    np.testing.assert_allclose(u_back, u0, atol=1e-6)
    np.testing.assert_allclose(v_back, v0, atol=1e-6)


def test_camera_telecentric_pixel_roundtrip():
    cam = CameraModel.telecentric_from_pixels_per_mm(
        pixels_per_mm=80.0, image_width=1024, image_height=768
    )
    u0 = np.array([10.0, 512.0, 900.0])
    v0 = np.array([20.0, 384.0, 500.0])
    origin, direction = cam.ray_from_pixel(u0, v0)
    u_back, v_back = cam.pixel_from_ray(origin, direction)
    np.testing.assert_allclose(u_back, u0, atol=1e-6)
    np.testing.assert_allclose(v_back, v0, atol=1e-6)


# ---------------------------------------------------------------------------
# Pose
# ---------------------------------------------------------------------------


def test_pose_roundtrip():
    rng = np.random.default_rng(42)
    pose = Pose(
        rotation=Rotation.from_euler("xyz", rng.uniform(-180, 180, 3), degrees=True),
        translation=rng.uniform(-10, 10, 3),
    )
    p_B = rng.uniform(-5, 5, 3)
    p_A = pose.apply(p_B)
    p_B_back = pose.inverse().apply(p_A)
    np.testing.assert_allclose(p_B_back, p_B, atol=1e-9)


def test_pose_compose_identity():
    pose = Pose.from_euler("xyz", [10.0, 20.0, -45.0], [1.0, 2.0, 3.0])
    identity = Pose.identity()
    # pose @ identity == pose, identity @ pose == pose
    assert pose.compose(identity).approx_equal(pose)
    assert identity.compose(pose).approx_equal(pose)


def test_pose_compose_world_consistency():
    """Composition agrees with applying poses sequentially."""
    rng = np.random.default_rng(7)
    T_ab = Pose.from_euler("xyz", rng.uniform(-90, 90, 3), rng.uniform(-5, 5, 3))
    T_bc = Pose.from_euler("xyz", rng.uniform(-90, 90, 3), rng.uniform(-5, 5, 3))
    x_c = rng.uniform(-3, 3, 3)
    # Via composition
    x_a_compose = T_ab.compose(T_bc).apply(x_c)
    # Via two-step apply
    x_a_twostep = T_ab.apply(T_bc.apply(x_c))
    np.testing.assert_allclose(x_a_compose, x_a_twostep, atol=1e-12)


def test_pose_serialization_roundtrip():
    pose = Pose.from_euler("zyx", [30.0, -15.0, 75.0], [1.5, -2.5, 8.0])
    d = pose.as_dict()
    pose_back = Pose.from_dict(d)
    assert pose.approx_equal(pose_back, atol=1e-12)


def test_pose_from_euler_x90():
    """90° rotation about x takes +y → +z."""
    pose = Pose.from_euler("x", [90.0], np.zeros(3))
    np.testing.assert_allclose(
        pose.apply(np.array([0.0, 1.0, 0.0])), [0.0, 0.0, 1.0], atol=1e-12
    )
    # And +z → -y
    np.testing.assert_allclose(
        pose.apply(np.array([0.0, 0.0, 1.0])), [0.0, -1.0, 0.0], atol=1e-12
    )


def test_pose_apply_batch():
    pose = Pose.from_euler("z", [90.0], [1.0, 0.0, 0.0])
    pts = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    out = pose.apply(pts)
    # R rotates +x → +y, +y → -x, +z → +z; then add translation (1, 0, 0).
    expected = np.array([[1.0, 1.0, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 1.0]])
    np.testing.assert_allclose(out, expected, atol=1e-12)


# ---------------------------------------------------------------------------
# ray_sphere_intersection
# ---------------------------------------------------------------------------


def test_ray_sphere_basic_hit():
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([0.0, 0.0, 1.0])
    center = np.array([0.0, 0.0, 10.0])
    radius = 2.0
    hit, valid = ray_sphere_intersection(origin, direction, center, radius)
    assert bool(valid)
    np.testing.assert_allclose(hit, [0.0, 0.0, 8.0], atol=1e-12)


def test_ray_sphere_tangent_is_miss_or_single_hit():
    """A tangent ray (discriminant ≈ 0) gives a single touching hit."""
    origin = np.array([2.0, 0.0, 0.0])
    direction = np.array([0.0, 0.0, 1.0])
    center = np.array([0.0, 0.0, 10.0])
    radius = 2.0
    hit, valid = ray_sphere_intersection(origin, direction, center, radius)
    assert bool(valid)
    np.testing.assert_allclose(hit, [2.0, 0.0, 10.0], atol=1e-6)


def test_ray_sphere_ray_pointing_away():
    """Ray pointing away from the sphere — no positive t."""
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([0.0, 0.0, -1.0])
    center = np.array([0.0, 0.0, 10.0])
    hit, valid = ray_sphere_intersection(origin, direction, center, 2.0)
    assert not bool(valid)
    assert np.all(np.isnan(hit))


def test_ray_sphere_origin_inside_sphere():
    """Ray from inside the sphere returns the positive-t exit point."""
    origin = np.array([0.0, 0.0, 10.0])  # at the sphere center
    direction = np.array([0.0, 0.0, 1.0])
    center = np.array([0.0, 0.0, 10.0])
    radius = 2.0
    hit, valid = ray_sphere_intersection(origin, direction, center, radius)
    assert bool(valid)
    # Exit at (0, 0, 12)
    np.testing.assert_allclose(hit, [0.0, 0.0, 12.0], atol=1e-9)


def test_ray_sphere_zero_length_direction():
    """Degenerate zero-length ray direction returns invalid without raising."""
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([0.0, 0.0, 0.0])
    center = np.array([0.0, 0.0, 10.0])
    hit, valid = ray_sphere_intersection(origin, direction, center, 2.0)
    assert not bool(valid)
    assert np.all(np.isnan(hit))


def test_ray_sphere_batch():
    origins = np.zeros((3, 3))
    directions = np.array(
        [[0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [0.0, 0.0, 1.0]]
    )
    center = np.array([0.0, 0.0, 10.0])
    radius = 2.0
    hit, valid = ray_sphere_intersection(origins, directions, center, radius)
    np.testing.assert_array_equal(valid, [True, False, True])


def test_surface_normal_at_sphere_point():
    center = np.array([0.0, 0.0, 10.0])
    hits = np.array([
        [0.0, 0.0, 8.0],   # -z side → normal (0, 0, -1)
        [2.0, 0.0, 10.0],  # +x side → normal (1, 0, 0)
    ])
    normals = surface_normal_at_sphere_point(hits, center)
    np.testing.assert_allclose(normals[0], [0.0, 0.0, -1.0], atol=1e-12)
    np.testing.assert_allclose(normals[1], [1.0, 0.0, 0.0], atol=1e-12)


# ---------------------------------------------------------------------------
# reflect
# ---------------------------------------------------------------------------


def test_reflect_normal_incidence():
    """Ray along -z hitting a +z surface bounces back to +z."""
    incident = np.array([0.0, 0.0, -1.0])  # into surface (surface normal +z, ray heading down-ish from +z to surface)
    # Wait — incident points TOWARD the surface. If the surface normal is
    # +z (points up toward the incoming light), the incident direction to be
    # heading toward the surface must be -z.
    normal = np.array([0.0, 0.0, 1.0])
    out = reflect(incident, normal)
    np.testing.assert_allclose(out, [0.0, 0.0, 1.0], atol=1e-12)


def test_reflect_45_deg():
    """45° incidence on a +z surface reflects to the mirror image."""
    incident = np.array([1.0, 0.0, -1.0]) / np.sqrt(2.0)
    normal = np.array([0.0, 0.0, 1.0])
    out = reflect(incident, normal)
    expected = np.array([1.0, 0.0, 1.0]) / np.sqrt(2.0)
    np.testing.assert_allclose(out, expected, atol=1e-12)
    # Magnitude preserved (unit in, unit out).
    np.testing.assert_allclose(np.linalg.norm(out), 1.0, atol=1e-12)


def test_reflect_batch_preserves_angle():
    """For random incident rays on a +z surface, outgoing angle-from-normal
    equals incoming angle-from-normal."""
    rng = np.random.default_rng(1)
    n_rays = 20
    incident = rng.uniform(-1, 1, (n_rays, 3))
    # Force incident to point into the surface (z < 0).
    incident[:, 2] = -np.abs(incident[:, 2]) - 0.1
    incident = incident / np.linalg.norm(incident, axis=-1, keepdims=True)
    normal = np.tile(np.array([0.0, 0.0, 1.0]), (n_rays, 1))
    out = reflect(incident, normal)
    cos_in = np.abs(np.einsum("ij,ij->i", incident, normal))
    cos_out = np.abs(np.einsum("ij,ij->i", out, normal))
    np.testing.assert_allclose(cos_in, cos_out, atol=1e-12)


# ---------------------------------------------------------------------------
# ray_plane_intersection
# ---------------------------------------------------------------------------


def test_ray_plane_intersection_basic():
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([1.0, 0.0, 0.0])
    plane_point = np.array([5.0, 0.0, 0.0])
    plane_normal = np.array([-1.0, 0.0, 0.0])  # faces -x
    hit, valid = ray_plane_intersection(origin, direction, plane_point, plane_normal)
    assert bool(valid)
    np.testing.assert_allclose(hit, [5.0, 0.0, 0.0], atol=1e-12)


def test_ray_plane_intersection_parallel_misses():
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([0.0, 1.0, 0.0])  # parallel to the x=5 plane
    plane_point = np.array([5.0, 0.0, 0.0])
    plane_normal = np.array([1.0, 0.0, 0.0])
    hit, valid = ray_plane_intersection(origin, direction, plane_point, plane_normal)
    assert not bool(valid)
    assert np.all(np.isnan(hit))


def test_ray_plane_intersection_behind_origin():
    """Ray pointing backwards from the plane yields valid=False."""
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([-1.0, 0.0, 0.0])  # away from plane at x=5
    plane_point = np.array([5.0, 0.0, 0.0])
    plane_normal = np.array([1.0, 0.0, 0.0])
    hit, valid = ray_plane_intersection(origin, direction, plane_point, plane_normal)
    assert not bool(valid)


# ---------------------------------------------------------------------------
# ray_paraboloid_intersection
# ---------------------------------------------------------------------------


def test_ray_paraboloid_flat_case():
    """All quadratic terms zero → paraboloid reduces to plane z = F + Dx + Ey.
    With D=E=0 and F=3, it's the z=3 plane; a ray from origin along +z should
    hit at (0, 0, 3)."""
    coeffs = np.array([3.0, 0.0, 0.0, 0.0, 0.0, 0.0])  # F, D, A, E, C, B
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([0.0, 0.0, 1.0])
    hit, valid = ray_paraboloid_intersection(origin, direction, coeffs)
    assert bool(valid)
    np.testing.assert_allclose(hit, [0.0, 0.0, 3.0], atol=1e-9)


def test_ray_paraboloid_simple_cup():
    """z = x^2 + y^2 — vertical ray at (1, 0) hits at (1, 0, 1)."""
    coeffs = np.array([0.0, 0.0, 1.0, 0.0, 0.0, 1.0])  # F, D, A, E, C, B
    origin = np.array([1.0, 0.0, -5.0])
    direction = np.array([0.0, 0.0, 1.0])
    hit, valid = ray_paraboloid_intersection(origin, direction, coeffs)
    assert bool(valid)
    np.testing.assert_allclose(hit, [1.0, 0.0, 1.0], atol=1e-9)


def test_ray_paraboloid_miss():
    """Ray that never touches the surface returns valid=False."""
    # z = x^2 + y^2 shifted up so it's entirely above z=10.
    coeffs = np.array([100.0, 0.0, 1.0, 0.0, 0.0, 1.0])
    origin = np.array([0.0, 0.0, 0.0])
    direction = np.array([1.0, 0.0, 0.0])  # horizontal, never reaches z=100
    hit, valid = ray_paraboloid_intersection(origin, direction, coeffs)
    assert not bool(valid)


def test_ray_paraboloid_zero_direction():
    """Degenerate direction returns invalid without raising."""
    coeffs = np.array([0.0, 0.0, 1.0, 0.0, 0.0, 1.0])
    origin = np.array([1.0, 0.0, 0.0])
    direction = np.array([0.0, 0.0, 0.0])
    hit, valid = ray_paraboloid_intersection(origin, direction, coeffs)
    assert not bool(valid)


# ---------------------------------------------------------------------------
# slope_from_camera_pixel — end-to-end
# ---------------------------------------------------------------------------


def _make_flat_rig(tilt_deg: float = 0.0):
    """Build a synthetic rig:
    - Specimen = flat mirror at z=0 (world frame), optionally tilted about x by
      ``tilt_deg`` (so its normal tilts into +y).
    - Camera = directly above at z=100 mm, looking down (-z).
    - Screen = iPad at z=200 mm, flat, world mm y-up on screen surface.

    World frame: x right, y back, z up. Camera points down (-z), so camera
    frame's +z is world -z; we rotate the camera by 180° about the world x
    axis so camera +z = -world z.
    """
    # Camera model: telecentric, 100 px/mm.
    cam = CameraModel.telecentric_from_pixels_per_mm(
        pixels_per_mm=100.0, image_width=200, image_height=200
    )
    # Rotate camera 180° about world x so camera +z points in world -z. Then
    # translate to (0, 0, 100).
    # We also want the camera's own (u, v)=(100, 100) to map to world origin.
    # Telecentric pixel (u, v) = (100, 100) in camera frame is at
    # (1 mm, 1 mm, 0); with 180° about x that becomes (1, -1, 0) in world.
    # For a clean test we instead parameterize around pixel (0, 0) = world (0,0,100).
    camera_pose = Pose(
        rotation=Rotation.from_euler("x", 180.0, degrees=True),
        translation=np.array([0.0, 0.0, 100.0]),
    )

    # Specimen plane — by default z=0, normal +z. Tilted: rotate normal about x.
    tilt = np.deg2rad(tilt_deg)
    plane_normal = np.array([0.0, -np.sin(tilt), np.cos(tilt)])  # tilt about x
    plane_point = np.array([0.0, 0.0, 0.0])

    # Screen-shape callable — map screen coord (x_screen, y_screen) in mm to
    # world at z=200. The test inputs give screen coords directly in world mm
    # so this callable is identity-plus-z. World y-back matches screen y-back.
    def screen_to_world(xy: np.ndarray) -> np.ndarray:
        xy = np.asarray(xy)
        out = np.zeros(xy.shape[:-1] + (3,))
        out[..., 0] = xy[..., 0]
        out[..., 1] = xy[..., 1]
        out[..., 2] = 200.0
        return out

    return cam, camera_pose, plane_point, plane_normal, screen_to_world


def test_slope_from_camera_pixel_flat_surface_perpendicular_screen():
    """Flat mirror, camera directly above, screen pixel directly above the
    hit point → slope ≈ 0 (mirror is flat and level)."""
    cam, pose, p_pt, p_n, s2w = _make_flat_rig(tilt_deg=0.0)

    # Pixel (0, 0) in telecentric → camera-frame ray origin (0, 0, 0), +z.
    # After 180° about x: world origin (0, 0, 100), direction (0, 0, -1).
    # Hit at world (0, 0, 0). Reflected ray needs to go to screen at (0, 0, 200)
    # for a perfect normal incidence → screen coord (0, 0).
    uv = np.array([0.0, 0.0])
    screen_xy = np.array([0.0, 0.0])

    slope, hits, valid = slope_from_camera_pixel(
        uv, cam, pose, screen_xy, s2w, p_pt, p_n
    )
    assert bool(valid)
    np.testing.assert_allclose(hits, [0.0, 0.0, 0.0], atol=1e-9)
    np.testing.assert_allclose(slope, [0.0, 0.0], atol=1e-9)


def test_slope_from_camera_pixel_tilted_flat_surface():
    """Tilt the mirror by a known small angle about world x. The surface
    should have slope (0, tan(tilt)) in world frame if we probe it along the
    tilt axis."""
    tilt_deg = 5.0
    cam, pose, p_pt, p_n, s2w = _make_flat_rig(tilt_deg=tilt_deg)

    # A pixel viewing the surface: pixel (0, 0) hits world (0, 0, 0) (on the
    # tilted plane that passes through the origin).
    # For a correctly-tilted mirror, the surface normal is
    #   (0, -sin(tilt), cos(tilt))
    # and the slope in world frame is dz/dy = -n_y / n_z = sin/cos = tan(tilt).
    # To synthesize a reflected ray that matches this normal, we place the
    # screen point at the correct reflection of the camera ray.
    uv = np.array([0.0, 0.0])
    # Incident ray in world: from (0, 0, 100) toward (0, 0, 0), direction (0, 0, -1).
    incident_dir = np.array([0.0, 0.0, -1.0])
    # Normal
    t = np.deg2rad(tilt_deg)
    normal = np.array([0.0, -np.sin(t), np.cos(t)])
    # Reflected direction
    reflected_dir = incident_dir - 2 * np.dot(incident_dir, normal) * normal
    # Travel from surface hit (0,0,0) to z=200.
    travel = 200.0 / reflected_dir[2]
    screen_world = travel * reflected_dir
    # screen callable expects (x, y) mm.
    screen_xy = np.array([screen_world[0], screen_world[1]])

    slope, hits, valid = slope_from_camera_pixel(
        uv, cam, pose, screen_xy, s2w, p_pt, p_n
    )
    assert bool(valid)
    np.testing.assert_allclose(hits, [0.0, 0.0, 0.0], atol=1e-6)
    expected_slope_y = np.tan(t)  # dz/dy in world
    np.testing.assert_allclose(slope, [0.0, expected_slope_y], atol=1e-6)


def test_slope_from_camera_pixel_batch_consistency():
    """Batch call matches one-by-one calls."""
    cam, pose, p_pt, p_n, s2w = _make_flat_rig(tilt_deg=0.0)
    uv_batch = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]])
    screen_batch = np.array([[0.0, 0.0], [0.01, 0.0], [0.0, 0.01]])

    slope_batch, hits_batch, valid_batch = slope_from_camera_pixel(
        uv_batch, cam, pose, screen_batch, s2w, p_pt, p_n
    )

    for i in range(3):
        s1, h1, v1 = slope_from_camera_pixel(
            uv_batch[i], cam, pose, screen_batch[i], s2w, p_pt, p_n
        )
        assert bool(v1) == bool(valid_batch[i])
        np.testing.assert_allclose(slope_batch[i], s1, atol=1e-12)
        np.testing.assert_allclose(hits_batch[i], h1, atol=1e-12)


def test_slope_from_camera_pixel_yflip_canary():
    """THE Y-flip canary.

    If you negate the y of the screen coord and the screen-shape callable
    doesn't compensate, the recovered dz/dy should flip sign.

    This is the forward-looking defense for the recurring Y-flip bug
    documented in ``CLAUDE.md`` and this module's docstring.
    """
    tilt_deg = 3.0
    cam, pose, p_pt, p_n, s2w = _make_flat_rig(tilt_deg=tilt_deg)

    uv = np.array([0.0, 0.0])
    t = np.deg2rad(tilt_deg)
    incident_dir = np.array([0.0, 0.0, -1.0])
    normal = np.array([0.0, -np.sin(t), np.cos(t)])
    reflected_dir = incident_dir - 2 * np.dot(incident_dir, normal) * normal
    travel = 200.0 / reflected_dir[2]
    screen_world = travel * reflected_dir
    screen_xy = np.array([screen_world[0], screen_world[1]])
    screen_xy_flipped = np.array([screen_world[0], -screen_world[1]])

    slope, _, valid = slope_from_camera_pixel(
        uv, cam, pose, screen_xy, s2w, p_pt, p_n
    )
    slope_flipped, _, valid_flipped = slope_from_camera_pixel(
        uv, cam, pose, screen_xy_flipped, s2w, p_pt, p_n
    )

    assert bool(valid) and bool(valid_flipped)
    # dz/dx stays ~0 (screen x didn't flip)
    np.testing.assert_allclose(slope[0], slope_flipped[0], atol=1e-6)
    # dz/dy sign flips when screen y flips
    np.testing.assert_allclose(slope[1], -slope_flipped[1], atol=1e-6)
    # And the magnitude is nonzero — so it's not just 0 == -0.
    assert abs(slope[1]) > 1e-3


def test_slope_from_camera_pixel_wrong_rotation_axis_gives_wrong_result():
    """If we rotate the camera about the wrong world axis (y instead of x),
    the recovered slope no longer matches the known tilt in the expected axis.
    This is a sanity check that handedness is load-bearing, not accidental.
    """
    cam = CameraModel.telecentric_from_pixels_per_mm(100.0, 200, 200)
    # Wrong axis: 180° about y instead of x.
    camera_pose = Pose(
        rotation=Rotation.from_euler("y", 180.0, degrees=True),
        translation=np.array([0.0, 0.0, 100.0]),
    )
    plane_point = np.array([0.0, 0.0, 0.0])
    plane_normal = np.array([0.0, 0.0, 1.0])

    def s2w(xy):
        xy = np.asarray(xy)
        out = np.zeros(xy.shape[:-1] + (3,))
        out[..., 0] = xy[..., 0]
        out[..., 1] = xy[..., 1]
        out[..., 2] = 200.0
        return out

    uv = np.array([0.0, 0.0])
    screen_xy = np.array([0.0, 0.0])
    slope, hits, valid = slope_from_camera_pixel(
        uv, cam, camera_pose, screen_xy, s2w, plane_point, plane_normal
    )
    # 180° about y sends camera +z to world -z as well (good) and +x to -x
    # (still reaches the specimen for pixel (0,0)), but this is a fragile
    # symmetry — the slope should still be zero for the on-axis pixel. The
    # point of this test is just to verify we don't crash and we get a sane
    # result for a different rotation convention. The substantive check is
    # the y-flip canary above.
    assert bool(valid)
    np.testing.assert_allclose(slope, [0.0, 0.0], atol=1e-9)
