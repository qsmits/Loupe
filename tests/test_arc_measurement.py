"""
Pure-math tests for 3-point arc circumscribed circle computation.
No browser/JS needed — tests the Python equivalent of the circumscribed circle formula.
"""
import math
import pytest


def circumscribed_circle(x1, y1, x2, y2, x3, y3):
    """
    Compute circumscribed circle for 3 non-collinear points.
    Returns (cx, cy, r) or raises ValueError for collinear points.
    """
    ax, ay = x2 - x1, y2 - y1
    bx, by = x3 - x1, y3 - y1
    D = 2 * (ax * by - ay * bx)
    if abs(D) < 1e-10:
        raise ValueError("Collinear points — no unique circle")
    ux = (by * (ax**2 + ay**2) - ay * (bx**2 + by**2)) / D
    uy = (ax * (bx**2 + by**2) - bx * (ax**2 + ay**2)) / D
    cx, cy = x1 + ux, y1 + uy
    r = math.hypot(ux, uy)
    return cx, cy, r


def test_equilateral_triangle():
    """3 points of an equilateral triangle inscribed in unit circle."""
    pts = [(math.cos(math.radians(a)), math.sin(math.radians(a))) for a in [0, 120, 240]]
    cx, cy, r = circumscribed_circle(*pts[0], *pts[1], *pts[2])
    assert cx == pytest.approx(0.0, abs=1e-9)
    assert cy == pytest.approx(0.0, abs=1e-9)
    assert r  == pytest.approx(1.0, abs=1e-9)


def test_right_angle_triangle():
    """Right-angle inscribed in semicircle: hypotenuse = diameter."""
    cx, cy, r = circumscribed_circle(0, 0, 2, 0, 0, 2)
    assert cx == pytest.approx(1.0, abs=1e-9)
    assert cy == pytest.approx(1.0, abs=1e-9)
    assert r  == pytest.approx(math.sqrt(2), abs=1e-9)


def test_collinear_raises():
    with pytest.raises(ValueError):
        circumscribed_circle(0, 0, 1, 0, 2, 0)


def test_span_angle():
    """Span angle between two points on a unit circle centered at origin."""
    import math
    p1 = (1, 0)  # 0°
    p3 = (0, 1)  # 90°
    cx, cy = 0, 0
    a1 = math.degrees(math.atan2(p1[1] - cy, p1[0] - cx))
    a3 = math.degrees(math.atan2(p3[1] - cy, p3[0] - cx))
    span = abs(a3 - a1) % 360
    if span > 180: span = 360 - span
    assert span == pytest.approx(90.0, abs=1e-9)
