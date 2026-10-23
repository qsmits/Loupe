"""Sub-pixel refinement computes the image gradient once per detection call.

The detectors refine every contour/segment against the raw image. The full-
frame 5x5 Sobel must be computed once per call and shared, not once per
contour (that made detect_lines_contour take ~80 s on a 4000x3000 frame).
Results must be bit-identical to refining each contour independently.
"""
import time

import cv2
import numpy as np
import pytest

import backend.vision.subpixel as subpixel
from backend.vision import detection
from backend.vision.guided_inspection import inspect_features
from backend.vision.subpixel import _bilinear_sample, _parabola_from_gradient


# ── reference: the per-call refinement as it was before the shared gradient ──

def _reference_parabola(edge_xy, gray):
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    mag = np.hypot(gx, gy)
    refined, valid = _parabola_from_gradient(edge_xy, gx, gy, mag)
    h, w = gray.shape[:2]
    xi = np.clip(np.rint(edge_xy[:, 0]).astype(np.intp), 0, w - 1)
    yi = np.clip(np.rint(edge_xy[:, 1]).astype(np.intp), 0, h - 1)
    strength = mag[yi, xi]
    normals = np.column_stack([gx[yi, xi], gy[yi, xi]]) / np.maximum(strength[:, None], 1e-12)
    for shift in (-1, 1, -2, 2):
        pending = np.flatnonzero(~valid)
        if not len(pending):
            break
        candidate = edge_xy[pending] + shift * normals[pending]
        locations, found = _parabola_from_gradient(candidate, gx, gy, mag)
        refined[pending[found]] = locations[found]
        valid[pending[found]] = True
    return refined


def _reference_gaussian(edge_xy, gray):
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    theta = np.arctan2(gy, gx)
    xs, ys = edge_xy[:, 0], edge_xy[:, 1]
    h, w = gray.shape[:2]
    xi = np.clip(np.round(xs).astype(np.intp), 0, w - 1)
    yi = np.clip(np.round(ys).astype(np.intp), 0, h - 1)
    th = theta[yi, xi]
    cos_th, sin_th = np.cos(th), np.sin(th)
    offsets = np.array([-3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0])
    n = len(xs)
    samples = np.empty((7, n), dtype=np.float64)
    for i, off in enumerate(offsets):
        samples[i] = _bilinear_sample(gray, xs + off * cos_th, ys + off * sin_th)
    d2 = np.empty((5, n), dtype=np.float64)
    for i in range(5):
        d2[i] = samples[i + 2] - 2.0 * samples[i + 1] + samples[i]
    t_peak = np.zeros(n, dtype=np.float64)
    found = np.zeros(n, dtype=bool)
    for k in [1, 2, 0, 3]:
        left_off, right_off = float(k - 2), float(k - 1)
        a, b = d2[k], d2[k + 1]
        candidates = ((a * b) < 0.0) & ~found
        if not np.any(candidates):
            continue
        denom = b - a
        safe = np.abs(denom) > 1e-12
        t = np.where(safe, left_off + (-a / np.where(safe, denom, 1.0)), (left_off + right_off) / 2.0)
        t_peak = np.where(candidates, t, t_peak)
        found = found | candidates
    t_peak = np.clip(t_peak, -1.0, 1.0)
    return np.column_stack([xs + t_peak * cos_th, ys + t_peak * sin_th]).astype(np.float64)


def _reference_refine(edge_xy, gray, method="parabola", gradient=None):
    edge_xy = np.asarray(edge_xy, dtype=np.float64)
    if len(edge_xy) == 0:
        return np.empty((0, 2))
    return {"parabola": _reference_parabola, "gaussian": _reference_gaussian}[method](edge_xy, gray)


def busy_frame(h=480, w=640, seed=3):
    """~40 rectangles and circles: dozens of contours per detector."""
    rng = np.random.default_rng(seed)
    mask = np.zeros((h * 4, w * 4), np.uint8)
    for i in range(16):
        x0, y0 = 20 + (i % 4) * 150, 20 + (i // 4) * 110
        cv2.rectangle(mask, (x0 * 4, y0 * 4), ((x0 + 90) * 4, (y0 + 60) * 4), 255, -1)
    for j in range(24):
        cx, cy = 45.37 + (j % 6) * 100, 40.81 + (j // 6) * 115
        cv2.circle(mask, (int(cx * 4), int(cy * 4)), int((12 + 4 * (j % 3)) * 4), 0 if j % 2 else 255, -1)
    for k in range(10):  # thin partial arcs for detect_partial_arcs
        cv2.ellipse(mask, ((95 + (k % 5) * 125) * 4, (95 + (k // 5) * 230) * 4), (160, 160),
                    0, 36 * k, 36 * k + 100, 128, 8)
    image = cv2.resize(mask, (w, h), interpolation=cv2.INTER_AREA).astype(float) * 0.6 + 50
    image = cv2.GaussianBlur(image, (0, 0), 1.5) + rng.normal(0, 3, image.shape)
    return cv2.cvtColor(np.clip(image, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)


DETECTORS = {
    "lines": lambda f, m: detection.detect_lines_contour(f, subpixel=m, min_length_px=30),
    "circles": lambda f, m: detection.detect_circles(f, min_radius=8, max_radius=200, subpixel=m),
    "arcs": lambda f, m: detection.detect_partial_arcs(f, threshold1=50, threshold2=130, subpixel=m),
}


class _CountingCv2:
    def __init__(self, real):
        self._real, self.sobel_calls = real, 0

    def __getattr__(self, name):
        return getattr(self._real, name)

    def Sobel(self, *args, **kwargs):
        self.sobel_calls += 1
        return self._real.Sobel(*args, **kwargs)


@pytest.mark.parametrize("method", ["parabola", "gaussian"])
@pytest.mark.parametrize("name", list(DETECTORS))
def test_gradient_computed_once_per_detection_call(monkeypatch, name, method):
    frame = busy_frame()
    calls = {"gradient": 0, "refine": 0}
    real_gradient, real_refine = subpixel._gradient_data, subpixel.refine_subpixel

    def counting_gradient(gray):
        calls["gradient"] += 1
        return real_gradient(gray)

    def counting_refine(*args, **kwargs):
        calls["refine"] += 1
        return real_refine(*args, **kwargs)

    counting_cv2 = _CountingCv2(cv2)
    monkeypatch.setattr(subpixel, "_gradient_data", counting_gradient)
    monkeypatch.setattr(subpixel, "refine_subpixel", counting_refine)
    monkeypatch.setattr(subpixel, "cv2", counting_cv2)
    DETECTORS[name](frame, method)
    assert calls["refine"] > 10, "scene must exercise many contours"
    assert calls["gradient"] == 1
    assert counting_cv2.sobel_calls == 2  # gx and gy, once each


@pytest.mark.parametrize("method", ["parabola", "gaussian"])
@pytest.mark.parametrize("name", list(DETECTORS))
def test_shared_gradient_results_are_bit_identical(monkeypatch, name, method):
    frame = busy_frame()
    shared = DETECTORS[name](frame, method)
    monkeypatch.setattr(subpixel, "refine_subpixel", _reference_refine)
    per_call = DETECTORS[name](frame, method)
    assert len(shared) > 0
    assert shared == per_call


def test_guided_contour_path_shares_one_gradient(monkeypatch):
    frame = busy_frame()
    entities = [{"type": "circle", "handle": f"C{j}", "cx": (45.37 + (j % 6) * 100) / 10,
                 "cy": -(40.81 + (j // 6) * 115) / 10, "radius": (12 + 4 * (j % 3)) / 10}
                for j in range(24)]
    calls = {"gradient": 0}
    real_gradient = subpixel._gradient_data

    def counting_gradient(gray):
        calls["gradient"] += 1
        return real_gradient(gray)

    monkeypatch.setattr(subpixel, "_gradient_data", counting_gradient)
    shared = inspect_features(frame, entities, 10)
    assert calls["gradient"] == 1
    assert sum(r["matched"] for r in shared) > 10
    monkeypatch.setattr(subpixel, "refine_subpixel", _reference_refine)
    assert inspect_features(frame, entities, 10) == shared


def test_detectors_are_fast_on_a_large_busy_frame():
    """2000x1500 with ~100 contours: each detector well under 3 s."""
    rng = np.random.default_rng(5)
    h, w = 1500, 2000
    mask = np.zeros((h * 2, w * 2), np.uint8)
    for i in range(40):
        x0, y0 = 40 + (i % 8) * 240, 40 + (i // 8) * 290
        cv2.rectangle(mask, (x0 * 2, y0 * 2), ((x0 + 150) * 2, (y0 + 100) * 2), 255, -1)
    for j in range(60):
        cx, cy = 80 + (j % 10) * 190, 200 + (j // 10) * 220
        cv2.circle(mask, (cx * 2, cy * 2), (15 + 5 * (j % 3)) * 2, 0 if j % 2 else 255, -1)
    image = cv2.resize(mask, (w, h), interpolation=cv2.INTER_AREA).astype(float) * 0.6 + 50
    image = cv2.GaussianBlur(image, (0, 0), 1.5) + rng.normal(0, 3, image.shape)
    frame = cv2.cvtColor(np.clip(image, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    for name, run in DETECTORS.items():
        start = time.perf_counter()
        run(frame, "parabola")
        elapsed = time.perf_counter() - start
        assert elapsed < 3.0, f"{name} took {elapsed:.2f} s"
