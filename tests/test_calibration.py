import math
import pytest
from backend.vision.calibration import (
    distance_px,
    px_to_mm,
    mm_to_px,
    angle_degrees,
    fit_circle_three_points,
)


def test_distance_px():
    assert distance_px((0, 0), (3, 4)) == pytest.approx(5.0)
    assert distance_px((1, 1), (1, 1)) == pytest.approx(0.0)


def test_px_to_mm():
    assert px_to_mm(1220.5, 1220.5) == pytest.approx(1.0)
    assert px_to_mm(0, 1220.5) == pytest.approx(0.0)


def test_mm_to_px():
    assert mm_to_px(1.0, 1220.5) == pytest.approx(1220.5)


def test_angle_degrees_right_angle():
    # p1=(1,0), vertex=(0,0), p3=(0,1) → 90°
    assert angle_degrees((1, 0), (0, 0), (0, 1)) == pytest.approx(90.0)


def test_angle_degrees_straight():
    # p1=(-1,0), vertex=(0,0), p3=(1,0) → 180°
    assert angle_degrees((-1, 0), (0, 0), (1, 0)) == pytest.approx(180.0)


def test_fit_circle_three_points_known():
    # Three points on a circle centered at (5, 5) with radius 5
    p1 = (10.0, 5.0)   # right
    p2 = (5.0, 10.0)   # top
    p3 = (0.0, 5.0)    # left
    cx, cy, r = fit_circle_three_points(p1, p2, p3)
    assert cx == pytest.approx(5.0, abs=1e-6)
    assert cy == pytest.approx(5.0, abs=1e-6)
    assert r == pytest.approx(5.0, abs=1e-6)


def test_fit_circle_collinear_raises():
    with pytest.raises(ValueError, match="collinear"):
        fit_circle_three_points((0, 0), (1, 1), (2, 2))
