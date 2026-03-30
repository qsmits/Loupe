"""Tests for sub-pixel edge refinement."""

from __future__ import annotations

import numpy as np
import cv2
import pytest

from backend.vision.subpixel import (
    refine_subpixel,
    refine_single_point,
    available_methods,
)
from backend.vision.detection import fit_circle_algebraic


# ---------------------------------------------------------------------------
# Helpers — synthetic edge images
# ---------------------------------------------------------------------------

def _make_vertical_edge(width: int = 100, height: int = 100, edge_x: float = 50.3) -> np.ndarray:
    """Smooth sigmoid step at a known sub-pixel x position."""
    xs = np.arange(width, dtype=np.float64)[np.newaxis, :]  # (1, W)
    # Steep sigmoid so Canny can detect it
    img = 255.0 / (1.0 + np.exp(-(xs - edge_x) * 2.0))
    img = np.repeat(img, height, axis=0)
    return img.astype(np.uint8)


def _make_horizontal_edge(width: int = 100, height: int = 100, edge_y: float = 40.7) -> np.ndarray:
    """Smooth sigmoid step at a known sub-pixel y position."""
    ys = np.arange(height, dtype=np.float64)[:, np.newaxis]  # (H, 1)
    img = 255.0 / (1.0 + np.exp(-(ys - edge_y) * 2.0))
    img = np.repeat(img, width, axis=1)
    return img.astype(np.uint8)


def _make_diagonal_edge(
    width: int = 100, height: int = 100, offset: float = 50.3, angle_deg: float = 30,
) -> np.ndarray:
    """Diagonal sigmoid edge."""
    angle_rad = np.deg2rad(angle_deg)
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float64)
    dist = xs * np.cos(angle_rad) + ys * np.sin(angle_rad) - offset
    img = 255.0 / (1.0 + np.exp(-dist * 2.0))
    return img.astype(np.uint8)


def _make_circle_edge(
    width: int = 200, height: int = 200, cx: float = 100.3, cy: float = 99.7, r: float = 50.0,
) -> np.ndarray:
    """Circle with smooth sigmoid edge."""
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float64)
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2) - r
    img = 255.0 / (1.0 + np.exp(-dist * 2.0))
    return img.astype(np.uint8)


def _get_canny_points(gray: np.ndarray, low: int = 50, high: int = 150) -> np.ndarray:
    """Run Canny and return Nx2 float64 edge coordinates (x, y)."""
    edges = cv2.Canny(gray, low, high)
    ys, xs = np.nonzero(edges)
    return np.column_stack([xs, ys]).astype(np.float64)


# ---------------------------------------------------------------------------
# TestRefineSubpixelParabola
# ---------------------------------------------------------------------------

class TestRefineSubpixelParabola:
    def test_vertical_edge_accuracy(self):
        edge_x = 50.3
        gray = _make_vertical_edge(edge_x=edge_x)
        pts = _get_canny_points(gray)
        assert len(pts) > 0

        refined = refine_subpixel(pts, gray, method="parabola")
        assert refined.shape == pts.shape
        assert refined.dtype == np.float64

        # Median x should be close to true edge
        median_x = np.median(refined[:, 0])
        assert abs(median_x - edge_x) < 0.15, f"median_x={median_x}, expected ~{edge_x}"

    def test_horizontal_edge(self):
        edge_y = 40.7
        gray = _make_horizontal_edge(edge_y=edge_y)
        pts = _get_canny_points(gray)
        assert len(pts) > 0

        refined = refine_subpixel(pts, gray, method="parabola")
        median_y = np.median(refined[:, 1])
        assert abs(median_y - edge_y) < 0.15, f"median_y={median_y}, expected ~{edge_y}"

    def test_diagonal_edge_lower_scatter(self):
        gray = _make_diagonal_edge(offset=50.3, angle_deg=30)
        pts = _get_canny_points(gray)
        assert len(pts) > 0

        refined = refine_subpixel(pts, gray, method="parabola")
        # Scatter (std of distance to ideal line) should be small
        angle_rad = np.deg2rad(30)
        cos_a, sin_a = np.cos(angle_rad), np.sin(angle_rad)
        dists_raw = pts[:, 0] * cos_a + pts[:, 1] * sin_a - 50.3
        dists_ref = refined[:, 0] * cos_a + refined[:, 1] * sin_a - 50.3
        assert np.std(dists_ref) <= np.std(dists_raw) + 0.05

    def test_circle_better_fit(self):
        cx, cy, r = 100.3, 99.7, 50.0
        gray = _make_circle_edge(cx=cx, cy=cy, r=r)
        pts = _get_canny_points(gray)
        assert len(pts) > 10

        refined = refine_subpixel(pts, gray, method="parabola")

        # Fit circles to raw and refined
        raw_cx, raw_cy, raw_r = fit_circle_algebraic(pts)
        ref_cx, ref_cy, ref_r = fit_circle_algebraic(refined)

        # Refined should be at least as good
        raw_err = abs(raw_cx - cx) + abs(raw_cy - cy) + abs(raw_r - r)
        ref_err = abs(ref_cx - cx) + abs(ref_cy - cy) + abs(ref_r - r)
        assert ref_err <= raw_err + 0.5, f"ref_err={ref_err}, raw_err={raw_err}"

    def test_none_passthrough(self):
        gray = _make_vertical_edge()
        pts = _get_canny_points(gray)
        result = refine_subpixel(pts, gray, method="none")
        np.testing.assert_array_equal(result, pts)
        # Must be a copy
        assert result is not pts

    def test_clamp_within_one(self):
        gray = _make_vertical_edge(edge_x=50.3)
        pts = _get_canny_points(gray)
        refined = refine_subpixel(pts, gray, method="parabola")
        diff = np.abs(refined - pts)
        assert np.all(diff <= 1.0 + 1e-9), f"max shift = {diff.max()}"

    def test_empty_input(self):
        gray = _make_vertical_edge()
        empty = np.empty((0, 2), dtype=np.float64)
        result = refine_subpixel(empty, gray, method="parabola")
        assert result.shape == (0, 2)
        assert result.dtype == np.float64

    def test_border_points(self):
        """Edge points on image border should not crash."""
        gray = _make_vertical_edge(width=100, height=100, edge_x=1.0)
        pts = np.array([[0.0, 0.0], [99.0, 99.0], [0.0, 99.0], [99.0, 0.0]])
        result = refine_subpixel(pts, gray, method="parabola")
        assert result.shape == (4, 2)
        assert np.all(np.isfinite(result))


# ---------------------------------------------------------------------------
# TestRefineSinglePoint
# ---------------------------------------------------------------------------

class TestRefineSinglePoint:
    def test_snaps_to_edge(self):
        edge_x = 50.3
        gray = _make_vertical_edge(edge_x=edge_x)
        # Query near the edge
        x, y, mag = refine_single_point((48.0, 50.0), gray, search_radius=10)
        assert abs(x - edge_x) < 1.0
        assert mag > 0

    def test_low_magnitude_flat(self):
        # Uniform gray image — no edge
        gray = np.full((100, 100), 128, dtype=np.uint8)
        x, y, mag = refine_single_point((50.0, 50.0), gray, search_radius=10)
        assert mag < 10  # essentially no gradient


# ---------------------------------------------------------------------------
# TestAvailableMethods
# ---------------------------------------------------------------------------

class TestAvailableMethods:
    def test_returns_list(self):
        methods = available_methods()
        assert isinstance(methods, list)
        assert "none" in methods
        assert "parabola" in methods
