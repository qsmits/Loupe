"""Tests for the image stitching feature (vision + HTTP API)."""

from __future__ import annotations

import numpy as np
import pytest
import cv2

from backend.vision.stitch import compute_overlap_px, register_pair, stitch_grid


# ---------------------------------------------------------------------------
# Pure vision tests
# ---------------------------------------------------------------------------


def _make_textured_image(h: int, w: int, seed: int = 42) -> np.ndarray:
    """Create a synthetic BGR image with gradients, noise, and shapes
    so phase correlation has features to lock onto.
    """
    rng = np.random.RandomState(seed)
    # Gradient base
    gx = np.tile(np.linspace(0, 200, w, dtype=np.float32), (h, 1))
    gy = np.tile(np.linspace(0, 200, h, dtype=np.float32), (w, 1)).T
    base = ((gx + gy) / 2).astype(np.uint8)
    img = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
    # Random noise
    noise = rng.randint(0, 30, (h, w, 3), dtype=np.uint8)
    img = cv2.add(img, noise)
    # Draw some shapes for texture
    cv2.circle(img, (w // 3, h // 3), 30, (255, 100, 50), 2)
    cv2.circle(img, (2 * w // 3, 2 * h // 3), 20, (50, 200, 100), 3)
    cv2.rectangle(img, (w // 4, h // 2), (w // 2, 3 * h // 4), (100, 100, 255), 2)
    cv2.line(img, (0, h // 2), (w, h // 3), (200, 200, 0), 1)
    return img


def test_compute_overlap_px():
    assert compute_overlap_px(640, 0.20) == 128
    assert compute_overlap_px(640, 0.50) == 320
    assert compute_overlap_px(100, 0.10) == 10
    # Edge case: very small overlap should be at least 1
    assert compute_overlap_px(10, 0.001) >= 1


def test_register_pair_identity():
    """Two identical images should give near-zero shift."""
    img = _make_textured_image(200, 300, seed=1)
    overlap = 80
    dx, dy = register_pair(img, img, "x", overlap)
    assert abs(dx) < 3.0, f"X shift too large for identity: {dx}"
    assert abs(dy) < 10.0, f"Y shift too large for identity: {dy}"


def test_register_pair_known_shift():
    """Create two tiles by cropping a larger image with known overlap.
    The detected shift should be close to zero (since the overlap exactly
    matches the expected overlap_px).
    """
    big = _make_textured_image(480, 640, seed=7)
    tile_w = 300
    overlap = 100
    step = tile_w - overlap  # 200

    tile_a = big[:480, 0:tile_w].copy()
    tile_b = big[:480, step:step + tile_w].copy()

    dx, dy = register_pair(tile_a, tile_b, "x", overlap)
    # The tiles were cropped with exactly `overlap` pixels of overlap,
    # so the shift correction should be near zero.
    assert abs(dx) < 5.0, f"X shift correction too large: {dx}"
    assert abs(dy) < 5.0, f"Y shift correction too large: {dy}"


def test_stitch_grid_2x1():
    """Two tiles side by side with known overlap. Verify output dimensions."""
    big = _make_textured_image(200, 400, seed=3)
    tile_w = 250
    overlap_frac = 100 / tile_w  # 100px overlap on a 250px tile
    step = tile_w - 100

    tile_a = big[:200, 0:tile_w].copy()
    tile_b = big[:200, step:step + tile_w].copy()

    tiles = {(0, 0): tile_a, (1, 0): tile_b}
    result = stitch_grid(tiles, (2, 1), overlap_frac)

    assert result.ndim == 3
    assert result.shape[2] == 3
    # Output width should be roughly tile_w + step = 400 (the big image width)
    # Allow some tolerance for sub-pixel alignment
    assert abs(result.shape[1] - 400) < 20, f"Width {result.shape[1]} not close to 400"
    assert abs(result.shape[0] - 200) < 10, f"Height {result.shape[0]} not close to 200"


def test_stitch_grid_2x2():
    """2x2 grid from a larger image."""
    big = _make_textured_image(400, 500, seed=5)
    tile_h, tile_w = 250, 300
    overlap_frac = 100 / tile_w  # ~0.333
    step_x = tile_w - compute_overlap_px(tile_w, overlap_frac)
    step_y = tile_h - compute_overlap_px(tile_h, overlap_frac)

    tiles = {}
    for r in range(2):
        for c in range(2):
            y0 = r * step_y
            x0 = c * step_x
            tiles[(c, r)] = big[y0:y0 + tile_h, x0:x0 + tile_w].copy()

    result = stitch_grid(tiles, (2, 2), overlap_frac)
    assert result.ndim == 3
    # Expected ~ 500 x 400
    assert abs(result.shape[1] - 500) < 30
    assert abs(result.shape[0] - 400) < 30


# ---------------------------------------------------------------------------
# HTTP API tests (use the regular `client` fixture from conftest.py)
# ---------------------------------------------------------------------------


def test_stitch_http_workflow(client):
    """Full workflow: start -> capture all tiles -> compute -> get result."""
    # Start a 2x1 session
    r = client.post("/stitch/start", json={"cols": 2, "rows": 1, "overlap_pct": 20})
    assert r.status_code == 200
    data = r.json()
    assert data["total_tiles"] == 2
    assert len(data["scan_order"]) == 2
    assert data["grid_shape"] == [2, 1]

    # Capture tile (0, 0)
    r = client.post("/stitch/capture", json={"col": 0, "row": 0})
    assert r.status_code == 200
    assert r.json()["captured_count"] == 1

    # Capture tile (1, 0)
    r = client.post("/stitch/capture", json={"col": 1, "row": 0})
    assert r.status_code == 200
    assert r.json()["captured_count"] == 2

    # Compute
    r = client.post("/stitch/compute")
    assert r.status_code == 200
    data = r.json()
    assert data["width"] > 0
    assert data["height"] > 0
    assert "result_url" in data

    # Get result PNG
    r = client.get("/stitch/result.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 100


def test_stitch_status(client):
    """Status endpoint tracks captures."""
    # Start
    client.post("/stitch/start", json={"cols": 2, "rows": 2})

    r = client.get("/stitch/status")
    assert r.status_code == 200
    data = r.json()
    assert data["total_tiles"] == 4
    assert data["captured"] == []
    assert data["has_result"] is False

    # Capture one tile
    client.post("/stitch/capture", json={"col": 0, "row": 0})

    r = client.get("/stitch/status")
    data = r.json()
    assert [0, 0] in data["captured"]
    assert data["has_result"] is False


def test_stitch_capture_out_of_bounds(client):
    """Capturing outside the grid returns 400."""
    client.post("/stitch/start", json={"cols": 2, "rows": 2})

    r = client.post("/stitch/capture", json={"col": 5, "row": 0})
    assert r.status_code == 400

    r = client.post("/stitch/capture", json={"col": 0, "row": 10})
    assert r.status_code == 400

    r = client.post("/stitch/capture", json={"col": -1, "row": 0})
    assert r.status_code == 400


def test_stitch_compute_incomplete(client):
    """Computing with missing tiles returns 400."""
    client.post("/stitch/start", json={"cols": 2, "rows": 2})
    client.post("/stitch/capture", json={"col": 0, "row": 0})

    r = client.post("/stitch/compute")
    assert r.status_code == 400
    assert "Not all tiles" in r.json()["detail"]


def test_stitch_reset(client):
    """Reset clears the session."""
    client.post("/stitch/start", json={"cols": 2, "rows": 1})
    client.post("/stitch/capture", json={"col": 0, "row": 0})

    r = client.post("/stitch/reset")
    assert r.status_code == 200

    r = client.get("/stitch/status")
    data = r.json()
    assert data["captured"] == []
    assert data["has_result"] is False


def test_stitch_result_404_before_compute(client):
    """Getting result before compute returns 404."""
    client.post("/stitch/start", json={"cols": 1, "rows": 1})

    r = client.get("/stitch/result.png")
    assert r.status_code == 404
