"""Tests for corridor-based guided inspection."""
import math
import numpy as np
import cv2
import pytest

from backend.vision.guided_inspection import inspect_features, fit_manual_points


def _make_blank_frame(w=640, h=480, color=128):
    """Create a uniform gray BGR frame."""
    return np.full((h, w, 3), color, dtype=np.uint8)


def _draw_vertical_line(frame, x, y_start=50, y_end=430, color=255, thickness=2):
    """Draw a vertical white line on a dark frame."""
    frame = frame.copy()
    cv2.line(frame, (x, y_start), (x, y_end), (color, color, color), thickness)
    return frame


def _draw_circle(frame, cx, cy, r, color=255, thickness=2):
    """Draw a white circle on a dark frame."""
    frame = frame.copy()
    cv2.circle(frame, (cx, cy), r, (color, color, color), thickness)
    return frame


class TestInspectLine:
    def test_finds_edge_in_corridor(self):
        """A vertical line at x=100 in the image should be matched by a DXF line at x=100."""
        frame = _make_blank_frame(color=0)
        frame = _draw_vertical_line(frame, x=100)

        entity = {
            "handle": "L1",
            "type": "line",
            "parent_handle": None,
            # DXF coords in mm; with ppm=1, tx=0, ty=0, they map directly to pixels
            # For Y: dxf_to_image_px flips Y, so y1_mm=430 -> y_px = -430 + ty
            # With ppm=1, tx=100, ty=240: x_mm=0 -> x_px=100, y_mm=0 -> y_px=240
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["edge_point_count"] >= 5
        # Deviation should be small (line is exactly at expected position)
        assert r["perp_dev_mm"] is not None
        assert r["perp_dev_mm"] < 5.0  # generous threshold for edge detection jitter

    def test_no_edge_unmatched(self):
        """A uniform gray frame should produce no edges, so the entity is unmatched."""
        frame = _make_blank_frame(color=128)

        entity = {
            "handle": "L2",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -100,
            "x2": 0, "y2": 100,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is False
        assert r["reason"] is not None


class TestInspectCircle:
    def test_finds_arc(self):
        """A drawn circle should be matched by a DXF circle at the same position."""
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=80)

        entity = {
            "handle": "C1",
            "type": "circle",
            "parent_handle": None,
            # With ppm=1, tx=300, ty=240: cx_mm=0 -> 300px, cy_mm=0 -> 240px
            "cx": 0, "cy": 0,
            "radius": 80,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["edge_point_count"] >= 8
        assert r["center_dev_mm"] is not None
        assert r["center_dev_mm"] < 5.0
        assert r["radius_dev_mm"] is not None
        assert r["radius_dev_mm"] < 5.0


class TestInspectWithTransform:
    def test_line_with_translation(self):
        """Line at x=150 in image, DXF says x=50mm with tx=100 (50*1+100=150)."""
        frame = _make_blank_frame(color=0)
        frame = _draw_vertical_line(frame, x=150)

        entity = {
            "handle": "L3",
            "type": "line",
            "parent_handle": None,
            "x1": 50, "y1": -190,
            "x2": 50, "y2": 190,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["perp_dev_mm"] < 5.0


class TestTolerancePassWarnFail:
    def test_thresholds(self):
        """Verify pass/warn/fail classification based on deviation thresholds."""
        frame = _make_blank_frame(color=0)
        # Line at x=100, DXF also at x=100 => ~0 deviation => pass
        frame = _draw_vertical_line(frame, x=100)

        entity_pass = {
            "handle": "LP",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
            "tolerance_warn": 10.0,
            "tolerance_fail": 20.0,
        }

        results = inspect_features(
            frame, [entity_pass],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
            canny_low=30, canny_high=100,
            tolerance_warn=10.0,
            tolerance_fail=20.0,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["pass_fail"] == "pass"
        assert r["tolerance_warn"] == 10.0
        assert r["tolerance_fail"] == 20.0

        # Now use very tight tolerance so the same small deviation triggers warn/fail
        entity_tight = {
            "handle": "LT",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
            "tolerance_warn": 0.0001,
            "tolerance_fail": 0.0002,
        }

        results_tight = inspect_features(
            frame, [entity_tight],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
            canny_low=30, canny_high=100,
            tolerance_warn=0.0001,
            tolerance_fail=0.0002,
        )

        r2 = results_tight[0]
        if r2["matched"]:
            # With extremely tight tolerances, any deviation should be warn or fail
            assert r2["pass_fail"] in ("warn", "fail")


class TestFitManualPointsLine:
    def test_fit_line(self):
        """Manual points along a vertical line should produce a valid fit."""
        entity = {
            "handle": "ML1",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -100,
            "x2": 0, "y2": 100,
        }

        # Points roughly along x=100 (the projected nominal line with tx=100)
        points = [[100.0 + i * 0.1, float(50 + i * 10)] for i in range(10)]

        result = fit_manual_points(
            entity, points,
            pixels_per_mm=1.0,
            tx=100, ty=240,
            tolerance_warn=5.0,
            tolerance_fail=10.0,
        )

        assert result["matched"] is True
        assert result["fit"]["type"] == "line"
        assert result["perp_dev_mm"] is not None
        assert result["pass_fail"] in ("pass", "warn", "fail")

    def test_too_few_points(self):
        """Fewer than 5 points should return unmatched."""
        entity = {
            "handle": "ML2",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -100,
            "x2": 0, "y2": 100,
        }

        result = fit_manual_points(
            entity, [[100, 100]],  # only 1 point — need at least 2
            pixels_per_mm=1.0,
        )

        assert result["matched"] is False
        assert "at least" in result["reason"]


class TestFitManualPointsCircle:
    def test_fit_circle(self):
        """Manual points on a circle should produce a valid fit."""
        entity = {
            "handle": "MC1",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 50,
        }

        # Generate points on a circle centered at (300, 240) with r=50
        angles = np.linspace(0, 2 * math.pi, 20, endpoint=False)
        points = [[300 + 50 * math.cos(a), 240 + 50 * math.sin(a)] for a in angles]

        result = fit_manual_points(
            entity, points,
            pixels_per_mm=1.0,
            tx=300, ty=240,
            tolerance_warn=5.0,
            tolerance_fail=10.0,
        )

        assert result["matched"] is True
        assert result["fit"]["type"] == "circle"
        assert result["center_dev_mm"] is not None
        assert result["center_dev_mm"] < 2.0
        assert result["radius_dev_mm"] is not None
        assert result["radius_dev_mm"] < 2.0

    def test_too_few_points(self):
        """Fewer than 8 points should return unmatched."""
        entity = {
            "handle": "MC2",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 50,
        }

        result = fit_manual_points(
            entity, [[100, 100], [110, 110]],  # only 2 points — need at least 3 for arc
            pixels_per_mm=1.0,
        )

        assert result["matched"] is False
        assert "at least" in result["reason"]
