"""Tests for synthetic gear profile generators.

These are invariant tests: we don't pin exact coordinates, we check
geometric properties that any correct implementation must satisfy
(tip/root radii, rotational symmetry, tooth thickness formulas, etc.).
"""
from __future__ import annotations

import math

import pytest

from backend.vision.gear_geometry import (
    generate_cycloidal_gear,
    generate_involute_gear,
)


# ── Helpers ──────────────────────────────────────────────────────────────


def _radii(points):
    return [math.hypot(x, y) for (x, y) in points]


def _signed_area(points):
    # Shoelace formula. Positive = CCW. Points must be closed.
    a = 0.0
    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        a += x0 * y1 - x1 * y0
    return 0.5 * a


def _pitch_crossings(points, r_pitch):
    """Return list of (theta, r) where the polyline crosses r = r_pitch.

    Linear interpolation between consecutive samples.
    """
    out = []
    for i in range(len(points) - 1):
        r0 = math.hypot(*points[i])
        r1 = math.hypot(*points[i + 1])
        if (r0 - r_pitch) * (r1 - r_pitch) < 0:
            # Interpolate.
            t = (r_pitch - r0) / (r1 - r0)
            x = points[i][0] + t * (points[i + 1][0] - points[i][0])
            y = points[i][1] + t * (points[i + 1][1] - points[i][1])
            out.append((math.atan2(y, x), math.hypot(x, y)))
    return out


def _normalize_angle(a):
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


def _tooth_widths_at_pitch(points, r_pitch, n_teeth):
    """Measure tooth angular width at the pitch circle for each tooth.

    Returns a list of n_teeth tooth widths (radians). A tooth width is the
    angular distance between a left-flank crossing (r rising) and the next
    right-flank crossing (r falling) of the same tooth.
    """
    # Collect crossings and classify by direction. We allow the pitch
    # radius to be hit exactly at the *end* of a segment (cycloidal
    # dedendums land precisely on r_pitch) using min < r_pitch <= max.
    ups = []  # r rising across r_pitch (left flank, entering tooth)
    downs = []  # r falling (right flank, exiting tooth)
    for i in range(len(points) - 1):
        r0 = math.hypot(*points[i])
        r1 = math.hypot(*points[i + 1])
        lo, hi = min(r0, r1), max(r0, r1)
        if not (lo < r_pitch <= hi):
            continue
        if hi == lo:
            continue  # degenerate
        t = (r_pitch - r0) / (r1 - r0)
        x = points[i][0] + t * (points[i + 1][0] - points[i][0])
        y = points[i][1] + t * (points[i + 1][1] - points[i][1])
        theta = math.atan2(y, x)
        if r1 > r0:
            ups.append(theta)
        else:
            downs.append(theta)

    assert len(ups) == n_teeth, f"expected {n_teeth} left-flank crossings, got {len(ups)}"
    assert len(downs) == n_teeth, f"expected {n_teeth} right-flank crossings, got {len(downs)}"

    # Pair each up with the next down (in CCW order).
    ups_sorted = sorted(ups)
    downs_sorted = sorted(downs)
    widths = []
    for up in ups_sorted:
        # Find the smallest down strictly greater than up, wrapping.
        candidates = [d for d in downs_sorted if d > up]
        if not candidates:
            down = downs_sorted[0] + 2 * math.pi
        else:
            down = min(candidates)
        widths.append(down - up)
    return widths


# ── Involute tests ───────────────────────────────────────────────────────


def test_involute_closed_polyline():
    pts = generate_involute_gear(n_teeth=17, module=1.0)
    assert pts[0] == pts[-1]
    assert len(pts) > 17 * 4  # at least a handful of samples per tooth


def test_involute_tip_and_root_radii():
    n, m = 17, 1.0
    pts = generate_involute_gear(n_teeth=n, module=m)
    rs = _radii(pts)
    r_pitch = n * m / 2.0
    r_tip = r_pitch + m * 1.0
    r_root = r_pitch - m * 1.25
    assert max(rs) == pytest.approx(r_tip, abs=1e-9)
    assert min(rs) == pytest.approx(r_root, abs=1e-6)


def test_involute_is_ccw():
    pts = generate_involute_gear(n_teeth=24, module=0.5)
    assert _signed_area(pts) > 0


def test_involute_tooth_thickness_at_pitch():
    n, m = 20, 1.0
    pts = generate_involute_gear(n_teeth=n, module=m, points_per_flank=80)
    r_pitch = n * m / 2.0
    widths = _tooth_widths_at_pitch(pts, r_pitch, n)
    expected = (math.pi * m / 2.0) / r_pitch  # tooth thickness arc → angle
    for w in widths:
        assert w == pytest.approx(expected, rel=1e-3)


def test_involute_n_fold_symmetry():
    n, m = 17, 1.0
    pts = generate_involute_gear(n_teeth=n, module=m)
    angle = 2.0 * math.pi / n
    c, s = math.cos(angle), math.sin(angle)
    rotated = {(round(c * x - s * y, 6), round(s * x + c * y, 6)) for (x, y) in pts}
    original = {(round(x, 6), round(y, 6)) for (x, y) in pts}
    assert rotated == original


def test_involute_mirror_symmetry_about_x():
    n, m = 17, 1.0
    pts = generate_involute_gear(n_teeth=n, module=m)
    mirrored = {(round(x, 6), round(-y, 6)) for (x, y) in pts}
    original = {(round(x, 6), round(y, 6)) for (x, y) in pts}
    assert mirrored == original


def test_involute_profile_shift_changes_tip_and_root():
    n, m = 20, 1.0
    r_pitch = n * m / 2.0
    pts = generate_involute_gear(n_teeth=n, module=m, profile_shift=0.3)
    rs = _radii(pts)
    r_tip = r_pitch + m * (1.0 + 0.3)
    r_root = r_pitch - m * (1.25 - 0.3)
    assert max(rs) == pytest.approx(r_tip, abs=1e-9)
    assert min(rs) == pytest.approx(r_root, abs=1e-6)


def test_involute_invalid_inputs():
    with pytest.raises(ValueError):
        generate_involute_gear(n_teeth=5, module=1.0)
    with pytest.raises(ValueError):
        generate_involute_gear(n_teeth=17, module=0.0)
    with pytest.raises(ValueError):
        generate_involute_gear(n_teeth=17, module=1.0, pressure_angle_deg=2.0)
    with pytest.raises(ValueError):
        generate_involute_gear(n_teeth=17, module=1.0, pressure_angle_deg=45.0)


# ── Cycloidal tests ──────────────────────────────────────────────────────


def test_cycloidal_closed_polyline():
    pts = generate_cycloidal_gear(n_teeth=17, module=1.0)
    assert pts[0] == pts[-1]
    assert len(pts) > 17 * 4


def test_cycloidal_tip_and_root_radii():
    n, m = 17, 1.0
    pts = generate_cycloidal_gear(n_teeth=n, module=m)
    rs = _radii(pts)
    r_pitch = n * m / 2.0
    r_tip = r_pitch + m * 1.0
    r_root = r_pitch - m * 1.25
    # Tip uses bisection, allow slightly looser tolerance than involute.
    assert max(rs) == pytest.approx(r_tip, abs=1e-4)
    assert min(rs) == pytest.approx(r_root, abs=1e-9)


def test_cycloidal_is_ccw():
    pts = generate_cycloidal_gear(n_teeth=24, module=0.5)
    assert _signed_area(pts) > 0


def test_cycloidal_tooth_thickness_at_pitch():
    n, m = 20, 1.0
    pts = generate_cycloidal_gear(n_teeth=n, module=m, points_per_flank=80)
    r_pitch = n * m / 2.0
    widths = _tooth_widths_at_pitch(pts, r_pitch, n)
    expected = (math.pi * m / 2.0) / r_pitch
    for w in widths:
        assert w == pytest.approx(expected, rel=1e-3)


def test_cycloidal_n_fold_symmetry():
    n, m = 17, 1.0
    pts = generate_cycloidal_gear(n_teeth=n, module=m)
    angle = 2.0 * math.pi / n
    c, s = math.cos(angle), math.sin(angle)
    rotated = {(round(c * x - s * y, 6), round(s * x + c * y, 6)) for (x, y) in pts}
    original = {(round(x, 6), round(y, 6)) for (x, y) in pts}
    assert rotated == original


def test_cycloidal_mirror_symmetry_about_x():
    n, m = 17, 1.0
    pts = generate_cycloidal_gear(n_teeth=n, module=m)
    mirrored = {(round(x, 6), round(-y, 6)) for (x, y) in pts}
    original = {(round(x, 6), round(y, 6)) for (x, y) in pts}
    assert mirrored == original


def test_cycloidal_dedendum_is_radial():
    """For default rolling_radius_coef=0.5, the dedendum must be a straight
    radial line segment. Verify by checking that at least one dedendum point
    sits exactly on the ±half_tooth_angle_pitch radial line."""
    n, m = 17, 1.0
    pts = generate_cycloidal_gear(n_teeth=n, module=m)
    r_pitch = n * m / 2.0
    r_root = r_pitch - m * 1.25
    half_ang = (math.pi * m / 2.0) / 2.0 / r_pitch

    # Point at (r_root, -half_ang) must appear in tooth 0's dedendum.
    target_x = r_root * math.cos(-half_ang)
    target_y = r_root * math.sin(-half_ang)
    assert any(
        abs(x - target_x) < 1e-9 and abs(y - target_y) < 1e-9 for (x, y) in pts
    )


def test_cycloidal_invalid_inputs():
    with pytest.raises(ValueError):
        generate_cycloidal_gear(n_teeth=5, module=1.0)
    with pytest.raises(ValueError):
        generate_cycloidal_gear(n_teeth=17, module=-1.0)
    with pytest.raises(ValueError):
        generate_cycloidal_gear(n_teeth=17, module=1.0, rolling_radius_coef=0.05)
    with pytest.raises(ValueError):
        generate_cycloidal_gear(n_teeth=17, module=1.0, rolling_radius_coef=1.5)
