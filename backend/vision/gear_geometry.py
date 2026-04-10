"""Synthetic gear profile generators.

Produces closed polylines of ideal involute and cycloidal spur gears in
gear-local coordinates. Used to build a "fake DXF" of the ideal gear that
then flows through the existing DXF-guided inspection pipeline so we can
measure how much a real gear deviates from its textbook form.

Convention:
  - Origin at gear center.
  - Tooth 0 is centered on the positive x axis (polar angle 0).
  - Units match the module (usually mm, but the generators are unit-agnostic).
  - Polylines are returned closed: the first point equals the last.
  - Points are ordered counterclockwise.

Pure functions. No global state, no I/O.
"""
from __future__ import annotations

import math


def _inv(alpha: float) -> float:
    """Standard involute function inv(α) = tan(α) − α."""
    return math.tan(alpha) - alpha


def _rotate(points: list[tuple[float, float]], angle: float) -> list[tuple[float, float]]:
    c, s = math.cos(angle), math.sin(angle)
    return [(c * x - s * y, s * x + c * y) for (x, y) in points]


def generate_involute_gear(
    n_teeth: int,
    module: float,
    pressure_angle_deg: float = 20.0,
    addendum_coef: float = 1.0,
    dedendum_coef: float = 1.25,
    profile_shift: float = 0.0,
    points_per_flank: int = 30,
    points_per_tip: int = 10,
    points_per_root: int = 6,
) -> list[tuple[float, float]]:
    """Generate a closed polyline of an ideal involute spur gear.

    The gear is constructed by building one "tooth period" (one half of the
    root gap, one tooth, the other half of the root gap) then rotating that
    template around the center once per tooth.

    For r_root < r_base the involute is truncated at the base circle and
    extended radially down to the root circle. This is the simplest valid
    undercut-free connector and is good enough for inspection-overlay use.

    Args:
        n_teeth: tooth count (>= 6).
        module: module in length units. Pitch diameter = module * n_teeth.
        pressure_angle_deg: pressure angle in degrees (20 is standard).
        addendum_coef: addendum height in modules (1.0 standard).
        dedendum_coef: dedendum depth in modules (1.25 standard).
        profile_shift: x coefficient, shifts the tool relative to the blank.
        points_per_flank: samples along one involute flank.
        points_per_tip: samples along the tip arc connecting two flanks.
        points_per_root: samples along each half of the root gap arc.

    Returns:
        Closed polyline, list of (x, y) tuples.
    """
    if n_teeth < 6:
        raise ValueError(f"n_teeth must be >= 6, got {n_teeth}")
    if module <= 0:
        raise ValueError(f"module must be positive, got {module}")
    if not (5.0 <= pressure_angle_deg <= 35.0):
        raise ValueError(
            f"pressure_angle_deg out of range [5, 35]: {pressure_angle_deg}"
        )
    if points_per_flank < 4 or points_per_tip < 2 or points_per_root < 2:
        raise ValueError("points_per_* must be at least 4/2/2")

    alpha = math.radians(pressure_angle_deg)
    r_pitch = module * n_teeth / 2.0
    r_base = r_pitch * math.cos(alpha)
    r_tip = r_pitch + module * (addendum_coef + profile_shift)
    r_root = r_pitch - module * (dedendum_coef - profile_shift)
    if r_root <= 0:
        raise ValueError(
            f"root radius non-positive for n_teeth={n_teeth}, module={module}, "
            f"dedendum_coef={dedendum_coef}, profile_shift={profile_shift}"
        )
    if r_tip <= r_pitch:
        raise ValueError("r_tip must exceed r_pitch")

    # Half tooth thickness at the pitch circle (arc length / 2).
    s_pitch = (math.pi / 2.0 + 2.0 * profile_shift * math.tan(alpha)) * module
    half_tooth_angle_pitch = (s_pitch / 2.0) / r_pitch

    # The right flank of a tooth centered at polar angle 0 must pass through
    # (+half_tooth_angle_pitch, r_pitch). The right flank's polar angle at
    # radius r is: phase_right - inv(alpha_r), where alpha_r = acos(r_base/r).
    # Solving at r = r_pitch: phase_right = half_tooth_angle_pitch + inv(alpha).
    phase_right = half_tooth_angle_pitch + _inv(alpha)

    def involute_right(t: float) -> tuple[float, float]:
        """Right flank, t is the involute roll angle from the base circle."""
        r = r_base * math.sqrt(1.0 + t * t)
        theta = phase_right - (t - math.atan(t))
        return (r * math.cos(theta), r * math.sin(theta))

    def involute_left(t: float) -> tuple[float, float]:
        r = r_base * math.sqrt(1.0 + t * t)
        theta = -phase_right + (t - math.atan(t))
        return (r * math.cos(theta), r * math.sin(theta))

    # Involute t range from the lower flank end (r_base or r_root if > r_base)
    # up to the tip radius.
    r_flank_lo = max(r_root, r_base)
    t_lo = math.sqrt(max(0.0, (r_flank_lo / r_base) ** 2 - 1.0))
    t_hi = math.sqrt(max(0.0, (r_tip / r_base) ** 2 - 1.0))
    if t_hi <= t_lo:
        raise ValueError("degenerate gear: t_hi <= t_lo")

    # Build one tooth profile, counterclockwise, from the left-root-corner up
    # around the tooth and back down to the right-root-corner.
    tooth: list[tuple[float, float]] = []

    # If root is below base, add a radial stub on the left flank from root up to base.
    # The left flank at t=0 (r = r_base) has polar angle -phase_right.
    if r_root < r_base:
        theta_stub_left = -phase_right
        for i in range(points_per_root):
            frac = i / (points_per_root - 1)
            r = r_root + (r_base - r_root) * frac
            tooth.append((r * math.cos(theta_stub_left), r * math.sin(theta_stub_left)))

    # Left flank: t from t_lo (inside, near root/base) to t_hi (tip).
    for i in range(points_per_flank):
        frac = i / (points_per_flank - 1)
        t = t_lo + (t_hi - t_lo) * frac
        p = involute_left(t)
        # Avoid duplicating the last point of the stub.
        if tooth and _near(p, tooth[-1]):
            continue
        tooth.append(p)

    # Tip arc: sweep polar angle from the left-flank-at-tip to the right-flank-at-tip.
    theta_tip_left = -phase_right + (t_hi - math.atan(t_hi))
    theta_tip_right = phase_right - (t_hi - math.atan(t_hi))
    for i in range(1, points_per_tip):
        frac = i / (points_per_tip - 1)
        theta = theta_tip_left + (theta_tip_right - theta_tip_left) * frac
        tooth.append((r_tip * math.cos(theta), r_tip * math.sin(theta)))

    # Right flank: t from t_hi (tip) back down to t_lo.
    for i in range(1, points_per_flank):
        frac = i / (points_per_flank - 1)
        t = t_hi - (t_hi - t_lo) * frac
        p = involute_right(t)
        if tooth and _near(p, tooth[-1]):
            continue
        tooth.append(p)

    # Radial stub on the right flank from base down to root.
    if r_root < r_base:
        theta_stub_right = phase_right
        for i in range(1, points_per_root):
            frac = i / (points_per_root - 1)
            r = r_base - (r_base - r_root) * frac
            p = (r * math.cos(theta_stub_right), r * math.sin(theta_stub_right))
            if tooth and _near(p, tooth[-1]):
                continue
            tooth.append(p)

    # Root arc: from right-root of this tooth to left-root of next tooth.
    # Since the next tooth is the same template rotated by 2π/n, the root
    # arc spans the gap between phase_right and (2π/n - phase_right) at r_root.
    pitch_angle = 2.0 * math.pi / n_teeth
    theta_root_start = phase_right
    theta_root_end = pitch_angle - phase_right
    if theta_root_end <= theta_root_start:
        raise ValueError("teeth overlap at the root — check parameters")
    root_arc: list[tuple[float, float]] = []
    for i in range(1, points_per_root):
        frac = i / points_per_root  # stop before reaching the next tooth's start
        theta = theta_root_start + (theta_root_end - theta_root_start) * frac
        root_arc.append((r_root * math.cos(theta), r_root * math.sin(theta)))

    # One "period" = tooth + root_arc after it. Rotate-replicate n times.
    period = tooth + root_arc
    full: list[tuple[float, float]] = []
    for k in range(n_teeth):
        full.extend(_rotate(period, k * pitch_angle))
    # Close the polyline.
    full.append(full[0])
    return full


def generate_cycloidal_gear(
    n_teeth: int,
    module: float,
    rolling_radius_coef: float = 0.5,
    addendum_coef: float = 1.0,
    dedendum_coef: float = 1.25,
    points_per_flank: int = 30,
    points_per_tip: int = 10,
    points_per_root: int = 6,
) -> list[tuple[float, float]]:
    """Generate a closed polyline of an ideal cycloidal spur gear.

    Classical watchmaking convention:
      * Addendum flank (above PCD) = epicycloid traced by a point on a
        rolling circle of radius r_c rolling on the OUTSIDE of the pitch
        circle.
      * Dedendum flank (below PCD) = radial line from PCD down to root.
        This is the correct limit of the hypocycloid when the rolling
        circle has radius = pitch_radius/2, and it's a close approximation
        (and the standard watchmaking simplification) when it doesn't.
      * Tip is a simple circular arc at r_tip connecting the two addendum
        epicycloids.
      * Root is a simple circular arc at r_root between teeth.

    Args:
        n_teeth: tooth count (>= 6).
        module: module (pitch diameter = module * n_teeth).
        rolling_radius_coef: rolling circle radius as a fraction of the
            pitch radius. 0.5 → dedendum exactly radial (default).
        addendum_coef: addendum height in modules (1.0 standard).
        dedendum_coef: dedendum depth in modules (1.25 standard).
        points_per_flank: samples along one addendum epicycloid flank.
        points_per_tip: samples along the tip arc.
        points_per_root: samples along each root gap arc.

    Returns:
        Closed polyline, list of (x, y) tuples.
    """
    if n_teeth < 6:
        raise ValueError(f"n_teeth must be >= 6, got {n_teeth}")
    if module <= 0:
        raise ValueError(f"module must be positive, got {module}")
    if not (0.1 <= rolling_radius_coef <= 1.0):
        raise ValueError(
            f"rolling_radius_coef out of range [0.1, 1.0]: {rolling_radius_coef}"
        )
    if points_per_flank < 4 or points_per_tip < 2 or points_per_root < 2:
        raise ValueError("points_per_* must be at least 4/2/2")

    r_pitch = module * n_teeth / 2.0
    r_tip = r_pitch + module * addendum_coef
    r_root = r_pitch - module * dedendum_coef
    if r_root <= 0:
        raise ValueError(
            f"root radius non-positive for n_teeth={n_teeth}, module={module}"
        )
    r_c = rolling_radius_coef * r_pitch

    # Tooth thickness at the pitch circle = half the circular pitch.
    s_pitch = math.pi * module / 2.0
    half_tooth_angle_pitch = (s_pitch / 2.0) / r_pitch

    # ── Epicycloid (addendum, above PCD) ────────────────────────────────
    # A point initially in contact at (r_pitch, 0) on the pitch circle.
    # As the rolling circle rolls CCW by angle phi around the pitch circle,
    # the tracing point moves along:
    #   x(phi) = (R + r_c) cos(phi) − r_c cos(((R + r_c) / r_c) phi)
    #   y(phi) = (R + r_c) sin(phi) − r_c sin(((R + r_c) / r_c) phi)
    # with R = r_pitch. The point leaves the pitch circle and traces an arch
    # that reaches maximum radius R + 2 r_c at phi = pi*r_c/(R+r_c).
    def epicycloid(phi: float) -> tuple[float, float]:
        k = (r_pitch + r_c) / r_c
        x = (r_pitch + r_c) * math.cos(phi) - r_c * math.cos(k * phi)
        y = (r_pitch + r_c) * math.sin(phi) - r_c * math.sin(k * phi)
        return (x, y)

    # Find phi_tip such that |epicycloid(phi_tip)| == r_tip (bisection).
    # The curve radius grows monotonically with phi on [0, phi_max] where
    # phi_max = pi*r_c/(r_pitch+r_c). Cap phi_tip at that.
    phi_max = math.pi * r_c / (r_pitch + r_c)

    def curve_r(phi: float) -> float:
        x, y = epicycloid(phi)
        return math.hypot(x, y)

    # Bisect for phi_tip.
    if curve_r(phi_max) < r_tip:
        # Addendum is too tall for this rolling circle — fall back to phi_max.
        phi_tip = phi_max
    else:
        lo, hi = 0.0, phi_max
        for _ in range(60):
            mid = (lo + hi) / 2.0
            if curve_r(mid) < r_tip:
                lo = mid
            else:
                hi = mid
        phi_tip = (lo + hi) / 2.0

    # The right flank's epicycloid, in its natural frame, starts at
    # (r_pitch, 0) and curves upward (+y) as phi increases. We want that
    # starting point to sit at polar angle +half_tooth_angle_pitch on the
    # pitch circle, so rotate the natural epicycloid by +half_tooth_angle_pitch.
    # But we also want the curve to sweep INWARD toward the tooth center
    # (−θ direction) as it rises toward the tip. The natural epicycloid
    # sweeps outward (+θ direction), so we mirror it (negate y) before rotating.

    def addendum_right(phi: float) -> tuple[float, float]:
        x, y = epicycloid(phi)
        # Mirror y so the curve sweeps toward the tooth center (negative θ).
        y = -y
        # Rotate by +half_tooth_angle_pitch so (r_pitch, 0) in the natural
        # frame lands on (+half_tooth_angle_pitch) on the pitch circle.
        c, s = math.cos(half_tooth_angle_pitch), math.sin(half_tooth_angle_pitch)
        return (c * x - s * y, s * x + c * y)

    def addendum_left(phi: float) -> tuple[float, float]:
        # Mirror of the right flank across the x axis.
        x, y = addendum_right(phi)
        return (x, -y)

    # ── Build one tooth ─────────────────────────────────────────────────
    # Counterclockwise order from the left-root-corner.
    tooth: list[tuple[float, float]] = []

    # Left radial dedendum: from (r_root, -half_tooth_angle_pitch) up to
    # (r_pitch, -half_tooth_angle_pitch).
    theta_left_ded = -half_tooth_angle_pitch
    for i in range(points_per_root):
        frac = i / (points_per_root - 1)
        r = r_root + (r_pitch - r_root) * frac
        tooth.append((r * math.cos(theta_left_ded), r * math.sin(theta_left_ded)))

    # Left addendum: epicycloid from phi=0 (at pitch) to phi=phi_tip.
    for i in range(1, points_per_flank):
        frac = i / (points_per_flank - 1)
        phi = phi_tip * frac
        p = addendum_left(phi)
        if _near(p, tooth[-1]):
            continue
        tooth.append(p)

    # Tip arc from the end of left addendum to the end of the right addendum.
    # Both endpoints lie on r_tip; sweep polar angle between them.
    left_tip_pt = tooth[-1]
    theta_tip_left = math.atan2(left_tip_pt[1], left_tip_pt[0])
    theta_tip_right = -theta_tip_left  # by symmetry
    for i in range(1, points_per_tip):
        frac = i / (points_per_tip - 1)
        theta = theta_tip_left + (theta_tip_right - theta_tip_left) * frac
        tooth.append((r_tip * math.cos(theta), r_tip * math.sin(theta)))

    # Right addendum: epicycloid from phi=phi_tip back down to phi=0.
    for i in range(1, points_per_flank):
        frac = i / (points_per_flank - 1)
        phi = phi_tip * (1.0 - frac)
        p = addendum_right(phi)
        if _near(p, tooth[-1]):
            continue
        tooth.append(p)

    # Right radial dedendum: from (r_pitch, +half_tooth_angle_pitch) down to
    # (r_root, +half_tooth_angle_pitch).
    theta_right_ded = +half_tooth_angle_pitch
    for i in range(1, points_per_root):
        frac = i / (points_per_root - 1)
        r = r_pitch - (r_pitch - r_root) * frac
        p = (r * math.cos(theta_right_ded), r * math.sin(theta_right_ded))
        if _near(p, tooth[-1]):
            continue
        tooth.append(p)

    # Root arc between teeth at r_root, from +half_tooth_angle_pitch
    # to (2π/n − half_tooth_angle_pitch).
    pitch_angle = 2.0 * math.pi / n_teeth
    theta_root_start = half_tooth_angle_pitch
    theta_root_end = pitch_angle - half_tooth_angle_pitch
    if theta_root_end <= theta_root_start:
        raise ValueError("teeth overlap at the root — check parameters")
    root_arc: list[tuple[float, float]] = []
    for i in range(1, points_per_root):
        frac = i / points_per_root
        theta = theta_root_start + (theta_root_end - theta_root_start) * frac
        root_arc.append((r_root * math.cos(theta), r_root * math.sin(theta)))

    period = tooth + root_arc
    full: list[tuple[float, float]] = []
    for k in range(n_teeth):
        full.extend(_rotate(period, k * pitch_angle))
    full.append(full[0])
    return full


def _near(a: tuple[float, float], b: tuple[float, float], tol: float = 1e-9) -> bool:
    return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol
