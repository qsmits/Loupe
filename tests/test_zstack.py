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
from backend.vision.heightmap_analysis import (
    compute_roughness_1d,
    compute_roughness_2d,
    detrend as detrend_height_map,
    fit_plane,
    fit_poly2,
    sample_profile,
)


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
    assert set(payload.keys()) == {"width", "height", "data", "confidence", "brightness", "z_step_mm", "frame_count"}
    assert isinstance(payload["width"], int) and payload["width"] > 0
    assert isinstance(payload["height"], int) and payload["height"] > 0
    assert payload["width"] <= 256 and payload["height"] <= 256
    assert len(payload["data"]) == payload["width"] * payload["height"]
    assert len(payload["confidence"]) == payload["width"] * payload["height"]
    assert all(0.0 <= v <= 1.0 for v in payload["confidence"][:16])
    assert payload["z_step_mm"] == pytest.approx(0.02, abs=1e-9)
    assert payload["frame_count"] == 4
    assert all(isinstance(v, (int, float)) for v in payload["data"][:8])

    # After reset, should 404
    r = client.post("/zstack/reset")
    assert r.status_code == 200
    r = client.get("/zstack/heightmap.raw")
    assert r.status_code == 404


def test_fit_plane_removes_tilt():
    h, w = 40, 60
    ys, xs = np.indices((h, w), dtype=np.float32)
    # Tilted plane plus a DC offset — no curvature, no noise.
    tilted = (0.03 * xs - 0.02 * ys + 5.0).astype(np.float32)
    out = detrend_height_map(tilted, "plane")
    # After removing the plane, the surface is flat to numerical precision
    # and the original DC offset is preserved (mean add-back).
    assert float(out.std()) < 1e-4
    assert float(out.mean()) == pytest.approx(float(tilted.mean()), abs=1e-4)


def test_fit_poly2_removes_curvature():
    h, w = 50, 70
    half = max(h, w) / 2.0
    ys, xs = np.indices((h, w), dtype=np.float32)
    nx = (xs - (w - 1) / 2.0) / half
    ny = (ys - (h - 1) / 2.0) / half
    # Bowl + mild tilt + constant — exactly what the current optics produce
    # on a flat part (spherical bias plus stage tilt).
    surface = (0.5 * (nx * nx + ny * ny) + 0.04 * nx - 0.01 * ny + 2.0).astype(np.float32)
    out = detrend_height_map(surface, "poly2")
    # Poly2 is a superset of the true generator → residual should be ~0.
    assert float(out.std()) < 1e-4
    # Plane fit alone should NOT flatten it (curvature remains)
    out_plane = detrend_height_map(surface, "plane")
    assert float(out_plane.std()) > 0.05


def test_detrend_none_is_copy():
    hm = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
    out = detrend_height_map(hm, "none")
    assert np.array_equal(out, hm)
    assert out is not hm  # must not alias


def test_heightmap_raw_detrend_param(client: TestClient):
    r = client.post("/zstack/start")
    assert r.status_code == 200
    for _ in range(4):
        assert client.post("/zstack/capture").status_code == 200
    r = client.post("/zstack/compute", json={"z_step_mm": 0.02})
    assert r.status_code == 200

    # Default (no param) matches explicit detrend=none
    r_default = client.get("/zstack/heightmap.raw")
    r_none = client.get("/zstack/heightmap.raw?detrend=none")
    assert r_default.status_code == 200
    assert r_none.status_code == 200
    assert r_default.json()["data"] == r_none.json()["data"]

    for mode in ("plane", "poly2"):
        r = client.get(f"/zstack/heightmap.raw?detrend={mode}")
        assert r.status_code == 200, f"{mode}: {r.text}"
        payload = r.json()
        expected_keys = {"width", "height", "data", "confidence", "brightness", "z_step_mm", "frame_count"}
        assert set(payload.keys()) == expected_keys
        assert len(payload["data"]) == payload["width"] * payload["height"]

    # Unknown mode → 400
    r = client.get("/zstack/heightmap.raw?detrend=bogus")
    assert r.status_code == 400


def test_heightmap_png_detrend_param(client: TestClient):
    r = client.post("/zstack/start")
    assert r.status_code == 200
    for _ in range(4):
        assert client.post("/zstack/capture").status_code == 200
    assert client.post("/zstack/compute", json={"z_step_mm": 0.02}).status_code == 200

    for mode in ("none", "plane", "poly2"):
        r = client.get(f"/zstack/heightmap.png?detrend={mode}")
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/png"
        assert len(r.content) > 0

    r = client.get("/zstack/heightmap.png?detrend=bogus")
    assert r.status_code == 400


def test_sample_profile_horizontal():
    h, w = 20, 100
    # Linear gradient along X: z = 0.01 * x (mm).  A horizontal profile should
    # recover that gradient exactly under bilinear sampling.
    xs = np.arange(w, dtype=np.float32)
    hm = np.broadcast_to(0.01 * xs, (h, w)).astype(np.float32)
    prof = sample_profile(hm, (0.0, 10.0), (99.0, 10.0), samples=100)
    assert prof["z_mm"].shape == (100,)
    assert prof["length_px"] == pytest.approx(99.0, abs=1e-4)
    # First and last samples match the endpoints of the gradient.
    assert float(prof["z_mm"][0]) == pytest.approx(0.0, abs=1e-5)
    assert float(prof["z_mm"][-1]) == pytest.approx(0.99, abs=1e-5)
    # Monotonic
    diffs = np.diff(prof["z_mm"])
    assert float(diffs.min()) >= -1e-6


def test_sample_profile_step():
    h, w = 40, 100
    hm = np.zeros((h, w), dtype=np.float32)
    hm[:, 50:] = 1.0
    prof = sample_profile(hm, (0.0, 20.0), (99.0, 20.0), samples=200)
    z = prof["z_mm"]
    # Left end is on the low plateau, right end on the high plateau.
    assert float(z[0]) == pytest.approx(0.0, abs=1e-4)
    assert float(z[-1]) == pytest.approx(1.0, abs=1e-4)
    # The transition should live somewhere in the middle of the sample array.
    mid_idx = int(np.argmax(z > 0.5))
    assert 80 < mid_idx < 120


def _compute_for_profile(client: TestClient) -> None:
    assert client.post("/zstack/start").status_code == 200
    for _ in range(4):
        assert client.post("/zstack/capture").status_code == 200
    assert client.post("/zstack/compute", json={"z_step_mm": 0.02}).status_code == 200


def test_profile_endpoint(client: TestClient):
    _compute_for_profile(client)
    r = client.post("/zstack/profile", json={
        "x0": 10.0, "y0": 10.0, "x1": 200.0, "y1": 150.0,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("length_px", "length_mm", "samples", "distances", "distances_unit",
                "z_mm", "x_px", "y_px", "z_min_mm", "z_max_mm", "detrend"):
        assert key in body
    n = body["samples"]
    assert n >= 2
    assert len(body["distances"]) == n
    assert len(body["z_mm"]) == n
    assert len(body["x_px"]) == n
    assert len(body["y_px"]) == n
    assert body["distances_unit"] == "px"
    assert body["length_mm"] is None
    assert body["detrend"] == "none"


def test_profile_endpoint_with_detrend(client: TestClient):
    _compute_for_profile(client)
    r_none = client.post("/zstack/profile", json={
        "x0": 5.0, "y0": 5.0, "x1": 300.0, "y1": 200.0, "detrend": "none",
    })
    r_plane = client.post("/zstack/profile", json={
        "x0": 5.0, "y0": 5.0, "x1": 300.0, "y1": 200.0, "detrend": "plane",
    })
    assert r_none.status_code == 200
    assert r_plane.status_code == 200
    assert r_plane.json()["detrend"] == "plane"
    # FakeCamera frames are uniform so detrend may not change values at all;
    # just assert both responses have matching sample counts and the plane
    # response is well-formed.
    assert r_plane.json()["samples"] == r_none.json()["samples"]


def test_profile_endpoint_calibrated(client: TestClient):
    _compute_for_profile(client)
    r = client.post("/zstack/profile", json={
        "x0": 0.0, "y0": 0.0, "x1": 100.0, "y1": 0.0,
        "px_per_mm": 100.0,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["distances_unit"] == "mm"
    assert body["length_mm"] == pytest.approx(1.0, abs=1e-6)
    # First sample at 0 mm, last sample at length_mm.
    assert body["distances"][0] == pytest.approx(0.0, abs=1e-6)
    assert body["distances"][-1] == pytest.approx(1.0, abs=1e-4)


def test_profile_endpoint_invalid_detrend(client: TestClient):
    _compute_for_profile(client)
    r = client.post("/zstack/profile", json={
        "x0": 0.0, "y0": 0.0, "x1": 10.0, "y1": 10.0, "detrend": "bogus",
    })
    assert r.status_code == 400


def test_profile_endpoint_requires_result(client: TestClient):
    # Fresh session, nothing computed yet.
    assert client.post("/zstack/reset").status_code == 200
    r = client.post("/zstack/profile", json={
        "x0": 0.0, "y0": 0.0, "x1": 10.0, "y1": 10.0,
    })
    assert r.status_code == 404


# ---- Phase 3: roughness ----


def test_compute_roughness_1d_flat_is_zero():
    z = np.full(200, 1.234, dtype=np.float32)
    r = compute_roughness_1d(z)
    assert r["Ra"] == pytest.approx(0.0, abs=1e-12)
    assert r["Rq"] == pytest.approx(0.0, abs=1e-12)
    assert r["Rz"] == pytest.approx(0.0, abs=1e-12)
    assert r["Rp"] == pytest.approx(0.0, abs=1e-12)
    assert r["Rv"] == pytest.approx(0.0, abs=1e-12)
    assert r["count"] == 200


def test_compute_roughness_1d_sinusoid():
    # Analytic truth: Ra = 2A/pi, Rq = A/sqrt(2) for a pure sine wave.
    A = 0.01
    x = np.linspace(0.0, 20.0 * np.pi, 5000)
    z = A * np.sin(x)
    r = compute_roughness_1d(z)
    assert r["Ra"] == pytest.approx(2.0 * A / np.pi, rel=0.05)
    assert r["Rq"] == pytest.approx(A / np.sqrt(2.0), rel=0.05)
    assert r["Rp"] == pytest.approx(A, rel=0.05)
    assert r["Rv"] == pytest.approx(A, rel=0.05)


def test_compute_roughness_1d_step():
    h = 0.5
    z = np.concatenate([np.zeros(100), np.full(100, h)])
    r = compute_roughness_1d(z)
    assert r["Rt"] == pytest.approx(h, abs=1e-9)
    assert r["Ra"] == pytest.approx(h / 2.0, abs=1e-9)
    assert r["Rq"] == pytest.approx(h / 2.0, abs=1e-9)


def test_compute_roughness_2d_flat_is_zero():
    z = np.full((50, 60), 2.5, dtype=np.float32)
    r = compute_roughness_2d(z)
    assert r["Sa"] == pytest.approx(0.0, abs=1e-12)
    assert r["Sq"] == pytest.approx(0.0, abs=1e-12)
    assert r["Sz"] == pytest.approx(0.0, abs=1e-12)
    assert r["count"] == 50 * 60


def test_compute_roughness_2d_tilted_without_detrend():
    # A pure tilt has nonzero Sa if you don't detrend it first — this is
    # exactly why detrend_scope exists at the HTTP boundary.
    h, w = 40, 60
    ys, xs = np.indices((h, w), dtype=np.float32)
    tilted = 0.01 * xs + 0.005 * ys
    r = compute_roughness_2d(tilted)
    assert r["Sa"] > 0.01
    assert r["Sq"] > 0.01


def test_profile_endpoint_includes_roughness(client: TestClient):
    _compute_for_profile(client)
    r = client.post("/zstack/profile", json={
        "x0": 10.0, "y0": 10.0, "x1": 200.0, "y1": 150.0,
    })
    assert r.status_code == 200
    body = r.json()
    assert "roughness" in body
    rough = body["roughness"]
    for key in ("Ra", "Rq", "Rp", "Rv", "Rt", "Rz", "Rsk", "Rku", "count"):
        assert key in rough
    assert rough["count"] == body["samples"]


def _compute_for_area(client: TestClient) -> None:
    assert client.post("/zstack/start").status_code == 200
    for _ in range(4):
        assert client.post("/zstack/capture").status_code == 200
    assert client.post("/zstack/compute", json={"z_step_mm": 0.02}).status_code == 200


def test_area_roughness_endpoint(client: TestClient):
    _compute_for_area(client)
    r = client.post("/zstack/area-roughness", json={
        "x0": 50.0, "y0": 40.0, "x1": 300.0, "y1": 260.0,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("x0", "y0", "x1", "y1", "width_px", "height_px",
                "detrend", "detrend_scope", "Sa", "Sq", "Sp", "Sv", "Sz",
                "count", "z_min_mm", "z_max_mm"):
        assert key in body
    assert body["width_px"] == 250
    assert body["height_px"] == 220
    assert body["detrend"] == "none"
    assert body["detrend_scope"] == "roi"


def test_area_roughness_detrend_roi_vs_global(client: TestClient):
    _compute_for_area(client)
    for scope in ("roi", "global"):
        for mode in ("none", "plane", "poly2"):
            r = client.post("/zstack/area-roughness", json={
                "x0": 20.0, "y0": 20.0, "x1": 400.0, "y1": 300.0,
                "detrend": mode, "detrend_scope": scope,
            })
            assert r.status_code == 200, f"{scope}/{mode}: {r.text}"


def test_area_roughness_invalid_detrend(client: TestClient):
    _compute_for_area(client)
    r = client.post("/zstack/area-roughness", json={
        "x0": 0.0, "y0": 0.0, "x1": 100.0, "y1": 100.0, "detrend": "bogus",
    })
    assert r.status_code == 400
    r = client.post("/zstack/area-roughness", json={
        "x0": 0.0, "y0": 0.0, "x1": 100.0, "y1": 100.0, "detrend_scope": "bogus",
    })
    assert r.status_code == 400


def test_area_roughness_degenerate_rect(client: TestClient):
    _compute_for_area(client)
    # 1x1 pixel
    r = client.post("/zstack/area-roughness", json={
        "x0": 10.0, "y0": 10.0, "x1": 10.5, "y1": 10.5,
    })
    assert r.status_code == 400
    # negative / zero
    r = client.post("/zstack/area-roughness", json={
        "x0": 20.0, "y0": 20.0, "x1": 20.0, "y1": 20.0,
    })
    assert r.status_code == 400


def test_area_roughness_requires_result(client: TestClient):
    assert client.post("/zstack/reset").status_code == 200
    r = client.post("/zstack/area-roughness", json={
        "x0": 0.0, "y0": 0.0, "x1": 100.0, "y1": 100.0,
    })
    assert r.status_code == 404
