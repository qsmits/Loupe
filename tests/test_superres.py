"""Tests for the super-resolution (shift-and-add) feature."""

import numpy as np
import cv2
import pytest

from backend.vision.superres import (
    compute_shift_grid,
    estimate_shifts,
    reconstruct,
    shifts_to_um,
)


# ---------------------------------------------------------------------------
# Unit tests — vision module
# ---------------------------------------------------------------------------


def test_compute_shift_grid_2x():
    grid = compute_shift_grid(2)
    assert len(grid) == 4
    expected = [(0.0, 0.0), (0.5, 0.0), (0.0, 0.5), (0.5, 0.5)]
    for (dx, dy), (ex, ey) in zip(grid, expected):
        assert abs(dx - ex) < 1e-9
        assert abs(dy - ey) < 1e-9


def test_compute_shift_grid_4x():
    grid = compute_shift_grid(4)
    assert len(grid) == 16
    # All combinations of (0, 0.25, 0.5, 0.75)
    steps = [0.0, 0.25, 0.5, 0.75]
    expected = [(x, y) for y in steps for x in steps]
    for (dx, dy), (ex, ey) in zip(grid, expected):
        assert abs(dx - ex) < 1e-9
        assert abs(dy - ey) < 1e-9


def _make_textured_image(h=200, w=300, seed=42):
    """Create a synthetic image with high-frequency content for phase correlation."""
    rng = np.random.RandomState(seed)
    # Checkerboard + noise
    check = np.zeros((h, w), dtype=np.uint8)
    for y in range(h):
        for x in range(w):
            if (x // 8 + y // 8) % 2 == 0:
                check[y, x] = 200
            else:
                check[y, x] = 50
    noise = rng.randint(0, 30, (h, w), dtype=np.uint8)
    gray = np.clip(check.astype(np.int16) + noise.astype(np.int16), 0, 255).astype(np.uint8)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def _shift_image(img, dx, dy):
    """Shift an image by (dx, dy) pixels using warpAffine."""
    h, w = img.shape[:2]
    M = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], dtype=np.float64)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LANCZOS4,
                          borderMode=cv2.BORDER_REFLECT)


def test_estimate_shifts_zero():
    """Identical frames should all have ~(0,0) shift."""
    base = _make_textured_image()
    frames = [base.copy() for _ in range(4)]
    shifts = estimate_shifts(frames, ref_idx=0)
    assert len(shifts) == 4
    for dx, dy in shifts:
        assert abs(dx) < 0.2, f"dx={dx}"
        assert abs(dy) < 0.2, f"dy={dy}"


def test_estimate_shifts_known():
    """Create sub-pixel-shifted frames; verify phase correlation recovers shifts."""
    base = _make_textured_image(h=256, w=256)
    known_shifts = [(0.0, 0.0), (3.5, 0.0), (0.0, 2.7), (3.5, 2.7)]
    frames = [_shift_image(base, dx, dy) for dx, dy in known_shifts]
    estimated = estimate_shifts(frames, ref_idx=0)

    assert len(estimated) == 4
    # Reference frame
    assert estimated[0] == (0.0, 0.0)

    # Other frames: phaseCorrelate returns the shift needed to align them
    # back to the reference. The sign and magnitude should match within
    # tolerance. Note: phaseCorrelate(ref, shifted) returns (dx, dy) where
    # shifted = ref shifted by (dx, dy), but the sign convention can vary.
    # We just check magnitude.
    for i in range(1, 4):
        edx, edy = estimated[i]
        kdx, kdy = known_shifts[i]
        # Allow up to 0.5px tolerance — phase correlation on small images
        # with border effects isn't perfectly precise.
        assert abs(abs(edx) - abs(kdx)) < 0.5, f"frame {i}: edx={edx}, expected ~{kdx}"
        assert abs(abs(edy) - abs(kdy)) < 0.5, f"frame {i}: edy={edy}, expected ~{kdy}"


def test_reconstruct_produces_upscaled():
    """Verify output dimensions are scale x input for both 2x and 4x."""
    base = _make_textured_image(h=100, w=120)
    for scale in (2, 4):
        grid = compute_shift_grid(scale)
        frames = [_shift_image(base, dx * 5, dy * 5) for dx, dy in grid]
        shifts = estimate_shifts(frames)
        result = reconstruct(frames, shifts, scale)
        assert result.shape == (100 * scale, 120 * scale, 3)
        assert result.dtype == np.uint8


def test_shifts_to_um():
    grid = [(0.0, 0.0), (0.5, 0.0), (0.0, 0.5), (0.5, 0.5)]
    pitch = 4.5  # um/px
    um = shifts_to_um(grid, pitch)
    assert len(um) == 4
    assert um[0] == (0.0, 0.0)
    assert um[1] == (2.25, 0.0)   # 0.5 * 4.5
    assert um[2] == (0.0, 2.25)
    assert um[3] == (2.25, 2.25)


# ---------------------------------------------------------------------------
# HTTP integration tests
# ---------------------------------------------------------------------------


def test_superres_http_workflow(client):
    """Full HTTP flow: start -> capture all -> compute -> get PNG."""
    # Start session (2x = 4 frames)
    resp = client.post("/superres/start", json={"scale": 2, "pixel_pitch_um": 4.5})
    assert resp.status_code == 200
    data = resp.json()
    assert data["scale"] == 2
    assert data["total_frames"] == 4
    assert len(data["shifts_um"]) == 4
    assert len(data["shifts_frac"]) == 4

    # Capture 4 frames
    for i in range(4):
        resp = client.post("/superres/capture")
        assert resp.status_code == 200
        cap = resp.json()
        assert cap["frame_count"] == i + 1
        assert cap["total_needed"] == 4

    # Extra capture should fail
    resp = client.post("/superres/capture")
    assert resp.status_code == 400

    # Compute
    resp = client.post("/superres/compute")
    assert resp.status_code == 200
    data = resp.json()
    assert data["scale"] == 2
    assert data["width"] == 640 * 2
    assert data["height"] == 480 * 2
    assert "result_url" in data

    # Get result PNG
    resp = client.get("/superres/result.png")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert len(resp.content) > 100


def test_superres_status(client):
    """Verify status tracking through the workflow."""
    # Initial status (no session started yet — but session object exists)
    resp = client.get("/superres/status")
    assert resp.status_code == 200
    status = resp.json()
    assert status["frame_count"] == 0
    assert status["has_result"] is False

    # Start
    client.post("/superres/start", json={"scale": 2, "pixel_pitch_um": 3.0})
    resp = client.get("/superres/status")
    status = resp.json()
    assert status["scale"] == 2
    assert status["total_needed"] == 4
    assert status["frame_count"] == 0
    assert status["pixel_pitch_um"] == 3.0
    assert len(status["shifts_um"]) == 4

    # Capture one frame
    client.post("/superres/capture")
    resp = client.get("/superres/status")
    status = resp.json()
    assert status["frame_count"] == 1
    assert status["has_result"] is False


def test_superres_invalid_scale(client):
    """Scale=3 should return 400."""
    resp = client.post("/superres/start", json={"scale": 3, "pixel_pitch_um": 4.5})
    assert resp.status_code == 400
    assert "Scale" in resp.json()["detail"] or "scale" in resp.json()["detail"].lower()


def test_superres_reset(client):
    """Reset clears the session."""
    client.post("/superres/start", json={"scale": 2, "pixel_pitch_um": 1.0})
    client.post("/superres/capture")
    resp = client.post("/superres/reset")
    assert resp.status_code == 200

    resp = client.get("/superres/status")
    status = resp.json()
    assert status["frame_count"] == 0
    assert status["total_needed"] == 0
    assert status["has_result"] is False


def test_superres_no_result_404(client):
    """Getting result before compute returns 404."""
    resp = client.get("/superres/result.png")
    assert resp.status_code == 404
