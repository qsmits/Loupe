"""Tests for the manual Z-stack (depth-from-focus) feature.

Synthesises a 5-frame stack where the left half of the image is sharpest
at frame index 1 and the right half is sharpest at frame index 3.  Verifies
that ``compute_focus_stack`` picks the correct index per region and that
the full HTTP workflow (start / capture / compute / composite / heightmap)
is wired up via the FastAPI test client.
"""

import io

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.vision.focus_stack import compute_focus_stack, colorize_height_map


def _make_textured(h: int, w: int, seed: int) -> np.ndarray:
    """A high-frequency texture that survives blurring into something measurable."""
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 256, size=(h, w), dtype=np.uint8)
    # Add some structured content so the Laplacian has a strong response
    cv2.rectangle(img, (10, 10), (w - 10, h - 10), 255, 1)
    for i in range(5, min(h, w) - 5, 8):
        cv2.line(img, (i, 0), (i, h - 1), 200, 1)
    return img


def _blur(img: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return img.copy()
    k = max(3, int(2 * round(3 * sigma) + 1))
    return cv2.GaussianBlur(img, (k, k), sigma)


def _make_stack(n_frames: int, h: int, w: int, peak_left: int, peak_right: int):
    """Build a stack where left half peaks sharpness at ``peak_left``
    and right half peaks at ``peak_right``.  Sharpness = low blur sigma."""
    base = _make_textured(h, w, seed=42)
    left = base[:, : w // 2]
    right = base[:, w // 2:]

    frames = []
    for i in range(n_frames):
        sigma_left = abs(i - peak_left) * 1.2
        sigma_right = abs(i - peak_right) * 1.2
        left_blur = _blur(left, sigma_left)
        right_blur = _blur(right, sigma_right)
        combined = np.hstack([left_blur, right_blur])
        # Convert to BGR
        frames.append(cv2.cvtColor(combined, cv2.COLOR_GRAY2BGR))
    return frames


def test_focus_stack_picks_correct_index_per_region():
    h, w = 80, 120
    n = 5
    peak_left, peak_right = 1, 3
    frames = _make_stack(n, h, w, peak_left, peak_right)

    result = compute_focus_stack(frames, z_step_mm=0.05, z0_mm=0.0)

    assert result["height_map"].shape == (h, w)
    assert result["composite"].shape == (h, w, 3)
    assert result["index_map"].shape == (h, w)

    idx = result["index_map"]
    # Inspect the middles of each half (avoid seam + borders, which get blurred
    # by both halves)
    left_region = idx[20:60, 10:40]
    right_region = idx[20:60, 80:110]

    # Majority of pixels in each region should land on the correct peak
    left_mode = int(np.bincount(left_region.ravel(), minlength=n).argmax())
    right_mode = int(np.bincount(right_region.ravel(), minlength=n).argmax())
    assert left_mode == peak_left, f"left region picked index {left_mode}, expected {peak_left}"
    assert right_mode == peak_right, f"right region picked index {right_mode}, expected {peak_right}"

    # Height values should match z_step * index
    assert result["min_z"] == pytest.approx(peak_left * 0.05, abs=1e-6)
    assert result["max_z"] == pytest.approx(peak_right * 0.05, abs=1e-6)


def test_focus_stack_requires_min_frames():
    frame = np.zeros((32, 32, 3), dtype=np.uint8)
    with pytest.raises(ValueError):
        compute_focus_stack([frame], z_step_mm=0.05)


def test_focus_stack_requires_uniform_shape():
    a = np.zeros((32, 32, 3), dtype=np.uint8)
    b = np.zeros((32, 48, 3), dtype=np.uint8)
    with pytest.raises(ValueError):
        compute_focus_stack([a, b], z_step_mm=0.05)


def test_colorize_height_map_shape():
    hm = np.linspace(0, 1, 40 * 60, dtype=np.float32).reshape(40, 60)
    viz = colorize_height_map(hm)
    assert viz.shape == (40, 60, 3)
    assert viz.dtype == np.uint8


def test_zstack_http_workflow(client: TestClient):
    # Start a fresh session
    r = client.post("/zstack/start")
    assert r.status_code == 200
    data = r.json()
    assert data["frame_count"] == 0

    # Too few frames → compute should 400
    r = client.post("/zstack/compute", json={"z_step_mm": 0.05})
    assert r.status_code == 400

    # Capture 4 frames (FakeCamera returns a solid colour, which is fine
    # for smoke-testing the pipeline even though focus is ambiguous)
    for i in range(4):
        r = client.post("/zstack/capture")
        assert r.status_code == 200
        assert r.json()["frame_count"] == i + 1

    r = client.post("/zstack/compute", json={"z_step_mm": 0.02, "z0_mm": 0.0})
    assert r.status_code == 200
    body = r.json()
    assert body["frame_count"] == 4
    assert body["width"] == 640
    assert body["height"] == 480
    assert body["composite_url"] == "/zstack/composite.png"

    r = client.get("/zstack/composite.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 0

    r = client.get("/zstack/heightmap.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"

    r = client.post("/zstack/reset")
    assert r.status_code == 200
    r = client.get("/zstack/composite.png")
    assert r.status_code == 404


def test_zstack_heightmap_raw(client: TestClient):
    # Rebuild a fresh session and run the full flow
    r = client.post("/zstack/start")
    assert r.status_code == 200
    for _ in range(4):
        r = client.post("/zstack/capture")
        assert r.status_code == 200
    r = client.post("/zstack/compute", json={"z_step_mm": 0.02, "z0_mm": 0.0})
    assert r.status_code == 200

    r = client.get("/zstack/heightmap.raw")
    assert r.status_code == 200
    payload = r.json()
    assert set(payload.keys()) == {"width", "height", "data", "z_step_mm", "frame_count"}
    assert isinstance(payload["width"], int) and payload["width"] > 0
    assert isinstance(payload["height"], int) and payload["height"] > 0
    assert payload["width"] <= 256 and payload["height"] <= 256
    assert len(payload["data"]) == payload["width"] * payload["height"]
    assert payload["z_step_mm"] == pytest.approx(0.02, abs=1e-9)
    assert payload["frame_count"] == 4
    assert all(isinstance(v, (int, float)) for v in payload["data"][:8])

    # After reset, should 404
    r = client.post("/zstack/reset")
    assert r.status_code == 200
    r = client.get("/zstack/heightmap.raw")
    assert r.status_code == 404
