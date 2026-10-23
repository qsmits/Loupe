"""Sub-pixel edge refinement with pluggable algorithms."""

from __future__ import annotations

import numpy as np
import cv2

# ---------------------------------------------------------------------------
# Algorithm registry
# ---------------------------------------------------------------------------

_METHODS: dict[str, callable] = {}

# Minimum 5x5-Sobel gradient magnitude for a click snap. OpenCV's 5x5 Sobel
# answers a sharp unit step with 48 (the old 3x3 kernel: 4), so this is the
# old 3x3 floor of 20 rescaled: a 5-grey-level step. Mirrors
# frontend/subpixel-js.js SNAP_MIN_MAGNITUDE, with the same comparison
# (``magnitude <= SNAP_MIN_MAGNITUDE`` rejects).
SNAP_MIN_MAGNITUDE = 240


def _register(name: str):
    """Decorator to register a refinement algorithm."""
    def decorator(fn):
        _METHODS[name] = fn
        return fn
    return decorator


def available_methods() -> list[str]:
    """Return list of registered method names."""
    return list(_METHODS.keys())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def precompute_gradient(gray: np.ndarray):
    """Full-frame 5x5 Sobel (gx, gy, magnitude) to share across refine calls.

    A detector that refines many contours of one frame computes this once
    and passes it as ``gradient=`` to every refine_subpixel call; results
    are bit-identical to letting each call compute its own.
    """
    return _gradient_data(gray)


def refine_subpixel(
    edge_xy: np.ndarray,
    gray: np.ndarray,
    method: str = "parabola",
    gradient=None,
) -> np.ndarray:
    """Refine edge pixel coordinates to sub-pixel accuracy.

    Parameters
    ----------
    edge_xy : (N, 2) array of integer edge coordinates (x, y).
    gray : uint8 grayscale image (raw, NOT preprocessed).
    method : algorithm name from the registry.
    gradient : optional ``precompute_gradient(gray)`` result for this same
        image; computed here when omitted.

    Returns
    -------
    (N, 2) float64 array of refined coordinates.
    """
    if edge_xy is None or len(edge_xy) == 0:
        return np.empty((0, 2), dtype=np.float64).copy()

    edge_xy = np.asarray(edge_xy, dtype=np.float64)
    if edge_xy.ndim != 2 or edge_xy.shape[1] != 2:
        raise ValueError("edge_xy must be (N, 2)")

    if method not in _METHODS:
        raise ValueError(f"Unknown method '{method}'. Available: {available_methods()}")

    return _METHODS[method](edge_xy, gray, gradient)


def refine_single_point(
    point: tuple[float, float],
    gray: np.ndarray,
    search_radius: int = 10,
    method: str = "parabola",
) -> tuple[float, float, float]:
    """Find the nearest qualified gradient ridge to *point* and refine it.

    Returns (x, y, magnitude).
    """
    if method not in _METHODS:
        raise ValueError(f"Unknown method '{method}'. Available: {available_methods()}")
    h, w = gray.shape[:2]
    px, py = int(round(point[0])), int(round(point[1]))
    x0, x1 = max(px - search_radius, 1), min(px + search_radius + 1, w - 1)
    y0, y1 = max(py - search_radius, 1), min(py + search_radius + 1, h - 1)
    if x0 >= x1 or y0 >= y1:
        return (float(point[0]), float(point[1]), 0.0)

    # Pad for the 5x5 derivative and interpolation. Compute gradients once on
    # this small region, rather than twice on the full camera frame per click.
    left, top = max(x0 - 5, 0), max(y0 - 5, 0)
    crop = gray[top:min(y1 + 5, h), left:min(x1 + 5, w)]
    gx, gy, mag = _gradient_data(crop)
    ys, xs = np.mgrid[y0 - top:y1 - top, x0 - left:x1 - left]
    candidates = np.column_stack([xs.ravel(), ys.ravel()]).astype(np.float64)
    refined, valid = _parabola_from_gradient(candidates, gx, gy, mag)
    strengths = mag[ys.ravel(), xs.ravel()]
    # Same gate as the browser: above the absolute floor AND at least 0.15 x
    # the strongest gradient in the window.
    valid &= (strengths > SNAP_MIN_MAGNITUDE) & (strengths >= float(strengths.max()) * 0.15)
    if not np.any(valid):
        return (float(point[0]), float(point[1]), 0.0)

    refined = refined[valid] + [left, top]
    strengths = strengths[valid]
    # Compare distance to actual ridges, never distance to their flanks.
    best = int(np.argmin(np.sum((refined - point) ** 2, axis=1)))
    selected = refined[best] - [left, top]
    if method == "none":
        selected = candidates[valid][best]
    elif method != "parabola":
        selected = refine_subpixel(selected[None, :], crop, method=method)[0]
    return (float(selected[0] + left), float(selected[1] + top), float(strengths[best]))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _bilinear_sample(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Sample *img* at float coordinates using bilinear interpolation (vectorized)."""
    h, w = img.shape[:2]
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)

    x0 = np.floor(x).astype(np.intp)
    y0 = np.floor(y).astype(np.intp)
    x1 = x0 + 1
    y1 = y0 + 1

    # Clamp
    x0c = np.clip(x0, 0, w - 1)
    x1c = np.clip(x1, 0, w - 1)
    y0c = np.clip(y0, 0, h - 1)
    y1c = np.clip(y1, 0, h - 1)

    wx = x - x0  # fractional part
    wy = y - y0

    img_f = img.astype(np.float64) if img.dtype != np.float64 else img

    val = (
        img_f[y0c, x0c] * (1 - wx) * (1 - wy)
        + img_f[y0c, x1c] * wx * (1 - wy)
        + img_f[y1c, x0c] * (1 - wx) * wy
        + img_f[y1c, x1c] * wx * wy
    )
    return val


# ---------------------------------------------------------------------------
# Algorithms
# ---------------------------------------------------------------------------

@_register("none")
def _refine_none(edge_xy: np.ndarray, gray: np.ndarray, gradient=None) -> np.ndarray:
    """Passthrough — returns a copy of the input."""
    return edge_xy.copy()


def _gradient_data(gray):
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    return gx, gy, np.hypot(gx, gy)


def _parabola_from_gradient(edge_xy, gx, gy, mag):
    """Refine only true local maxima; invalid peaks retain their input point."""
    xs, ys = edge_xy[:, 0], edge_xy[:, 1]
    h, w = mag.shape
    xi = np.clip(np.rint(xs).astype(np.intp), 0, w - 1)
    yi = np.clip(np.rint(ys).astype(np.intp), 0, h - 1)
    strength = np.hypot(gx[yi, xi], gy[yi, xi])
    nx = gx[yi, xi] / np.maximum(strength, 1e-12)
    ny = gy[yi, xi] / np.maximum(strength, 1e-12)
    sm = _bilinear_sample(mag, xs - nx, ys - ny)
    s0 = _bilinear_sample(mag, xs, ys)
    sp = _bilinear_sample(mag, xs + nx, ys + ny)
    curvature = sm + sp - 2 * s0
    offset = (sm - sp) / (2 * np.where(np.abs(curvature) > 1e-12, curvature, 1.0))
    valid = ((strength > 1) & (s0 >= sm) & (s0 >= sp) &
             (curvature < -1e-12) & (np.abs(offset) <= 0.6) &
             (xs >= 1) & (xs < w - 1) & (ys >= 1) & (ys < h - 1))
    offset = np.where(valid, offset, 0.0)
    return np.column_stack([xs + offset * nx, ys + offset * ny]), valid


@_register("parabola")
def _refine_parabola(edge_xy: np.ndarray, gray: np.ndarray, gradient=None) -> np.ndarray:
    """Locate a nearby gradient ridge, then fit its concave three-point peak."""
    gx, gy, mag = gradient if gradient is not None else _gradient_data(gray)
    refined, valid = _parabola_from_gradient(edge_xy, gx, gy, mag)
    # Preprocessing may displace a Canny candidate from the raw-image ridge.
    # Walk at most two pixels along its normal, preferring the nearest peak.
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


@_register("gaussian")
def _refine_gaussian(edge_xy: np.ndarray, gray: np.ndarray, gradient=None) -> np.ndarray:
    """Gaussian (second-derivative zero-crossing) sub-pixel refinement.

    Samples 7 intensity values along the gradient direction and locates the
    zero-crossing of the second derivative (inflection point of the intensity
    profile), which corresponds to the true edge position.
    """
    gx, gy, _ = gradient if gradient is not None else _gradient_data(gray)

    xs = edge_xy[:, 0]
    ys = edge_xy[:, 1]

    h, w = gray.shape[:2]
    xi = np.clip(np.round(xs).astype(np.intp), 0, w - 1)
    yi = np.clip(np.round(ys).astype(np.intp), 0, h - 1)

    th = np.arctan2(gy[yi, xi], gx[yi, xi])
    cos_th = np.cos(th)
    sin_th = np.sin(th)

    # Sample 7 intensity points at offsets -3,-2,-1,0,+1,+2,+3
    offsets = np.array([-3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0])
    n = len(xs)
    sample_x = xs[None, :] + offsets[:, None] * cos_th[None, :]
    sample_y = ys[None, :] + offsets[:, None] * sin_th[None, :]
    # Convert only the region the samples touch (bit-identical to sampling
    # the whole frame: the crop keeps every bilinear neighbour, and its edge
    # coincides with the image edge wherever clamping applies).
    left = int(np.clip(np.floor(sample_x.min()), 0, w - 1)) if n else 0
    top = int(np.clip(np.floor(sample_y.min()), 0, h - 1)) if n else 0
    right = int(np.clip(np.floor(sample_x.max()) + 2, left + 1, w)) if n else 1
    bottom = int(np.clip(np.floor(sample_y.max()) + 2, top + 1, h)) if n else 1
    region = gray[top:bottom, left:right].astype(np.float64)
    samples = _bilinear_sample(region, sample_x - left, sample_y - top)

    # Second derivative via finite differences: d2[i] = s[i+2] - 2*s[i+1] + s[i]
    # for i in 0..4, giving values at offsets -2,-1,0,+1,+2
    d2 = np.empty((5, n), dtype=np.float64)
    for i in range(5):
        d2[i] = samples[i + 2] - 2.0 * samples[i + 1] + samples[i]

    # d2 has indices 0..4, corresponding to offsets -2,-1,0,+1,+2.
    # Adjacent pairs (left_idx, right_idx) and their offset spans:
    #   pair 0: indices (0,1) → offsets (-2,-1), midpoint -1.5
    #   pair 1: indices (1,2) → offsets (-1, 0), midpoint -0.5
    #   pair 2: indices (2,3) → offsets ( 0,+1), midpoint +0.5
    #   pair 3: indices (3,4) → offsets (+1,+2), midpoint +1.5
    # Prefer pairs whose midpoint is closest to center (0):
    #   |midpoint|: pair1=0.5, pair2=0.5, pair0=1.5, pair3=1.5
    pair_order = [1, 2, 0, 3]  # left-element indices, ordered by midpoint closeness to 0

    t_peak = np.zeros(n, dtype=np.float64)
    found = np.zeros(n, dtype=bool)

    for k in pair_order:
        # Pair spans offsets (k-2) and (k-1)
        left_off = float(k - 2)
        right_off = float(k - 1)
        a = d2[k]
        b = d2[k + 1]
        sign_change = (a * b) < 0.0
        candidates = sign_change & ~found
        if not np.any(candidates):
            continue
        # Linear interpolation for zero crossing
        denom = b - a
        safe = np.abs(denom) > 1e-12
        t = np.where(safe, left_off + (-a / np.where(safe, denom, 1.0)), (left_off + right_off) / 2.0)
        t_peak = np.where(candidates, t, t_peak)
        found = found | candidates

    # Clamp to ±1.0
    t_peak = np.clip(t_peak, -1.0, 1.0)

    refined = np.column_stack([
        xs + t_peak * cos_th,
        ys + t_peak * sin_th,
    ])
    return refined.astype(np.float64)
