"""Sub-pixel edge refinement with pluggable algorithms."""

from __future__ import annotations

import numpy as np
import cv2

# ---------------------------------------------------------------------------
# Algorithm registry
# ---------------------------------------------------------------------------

_METHODS: dict[str, callable] = {}


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

def refine_subpixel(
    edge_xy: np.ndarray,
    gray: np.ndarray,
    method: str = "parabola",
) -> np.ndarray:
    """Refine edge pixel coordinates to sub-pixel accuracy.

    Parameters
    ----------
    edge_xy : (N, 2) array of integer edge coordinates (x, y).
    gray : uint8 grayscale image (raw, NOT preprocessed).
    method : algorithm name from the registry.

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

    return _METHODS[method](edge_xy, gray)


def refine_single_point(
    point: tuple[float, float],
    gray: np.ndarray,
    search_radius: int = 10,
    method: str = "parabola",
) -> tuple[float, float, float]:
    """Find the strongest gradient pixel near *point* and refine it.

    Returns (x, y, magnitude).
    """
    h, w = gray.shape[:2]
    px, py = int(round(point[0])), int(round(point[1]))

    # Compute Sobel on full frame
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    mag = np.sqrt(gx * gx + gy * gy)

    # Search window
    x0 = max(px - search_radius, 0)
    x1 = min(px + search_radius + 1, w)
    y0 = max(py - search_radius, 0)
    y1 = min(py + search_radius + 1, h)

    roi = mag[y0:y1, x0:x1]
    if roi.size == 0:
        return (float(point[0]), float(point[1]), 0.0)

    # Score each pixel by edge strength weighted against distance from click.
    # score = magnitude / (distance + 1) — strong nearby edges beat weak nearby
    # ones and strong distant ones. The +1 prevents division by zero at the
    # click position itself.
    roi_max = float(roi.max())
    if roi_max < 1.0:
        return (float(point[0]), float(point[1]), 0.0)

    # Only consider pixels with meaningful gradient (above 15% of max)
    ys, xs = np.where(roi >= roi_max * 0.15)
    if len(xs) == 0:
        return (float(point[0]), float(point[1]), 0.0)
    abs_xs = x0 + xs
    abs_ys = y0 + ys
    mags = mag[abs_ys, abs_xs]
    dists = np.sqrt((abs_xs - point[0]) ** 2 + (abs_ys - point[1]) ** 2)
    scores = mags / (dists + 1.0)
    best_idx = np.argmax(scores)
    best_x = int(abs_xs[best_idx])
    best_y = int(abs_ys[best_idx])
    best_mag = float(mag[best_y, best_x])

    # Refine that single point
    edge = np.array([[best_x, best_y]], dtype=np.float64)
    refined = refine_subpixel(edge, gray, method=method)
    return (float(refined[0, 0]), float(refined[0, 1]), best_mag)


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
def _refine_none(edge_xy: np.ndarray, gray: np.ndarray) -> np.ndarray:
    """Passthrough — returns a copy of the input."""
    return edge_xy.copy()


@_register("parabola")
def _refine_parabola(edge_xy: np.ndarray, gray: np.ndarray) -> np.ndarray:
    """Parabola-fit sub-pixel refinement along gradient direction."""
    # Sobel ksize=5 for smoother gradients
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    mag = np.sqrt(gx * gx + gy * gy)
    theta = np.arctan2(gy, gx)  # (h, w)

    xs = edge_xy[:, 0]
    ys = edge_xy[:, 1]

    # Integer coords for theta lookup (clamp to image)
    h, w = gray.shape[:2]
    xi = np.clip(np.round(xs).astype(np.intp), 0, w - 1)
    yi = np.clip(np.round(ys).astype(np.intp), 0, h - 1)

    th = theta[yi, xi]  # gradient direction per point
    cos_th = np.cos(th)
    sin_th = np.sin(th)

    # Sample 5 points along gradient at offsets -2, -1, 0, +1, +2
    offsets = np.array([-2.0, -1.0, 0.0, 1.0, 2.0])
    # samples shape: (5, N)
    samples = np.empty((5, len(xs)), dtype=np.float64)
    for i, off in enumerate(offsets):
        sx = xs + off * cos_th
        sy = ys + off * sin_th
        samples[i] = _bilinear_sample(mag, sx, sy)

    # Fit parabola to central 3 points (indices 1, 2, 3 → offsets -1, 0, +1)
    s_neg = samples[1]  # offset -1
    s_ctr = samples[2]  # offset  0
    s_pos = samples[3]  # offset +1

    a = (s_pos + s_neg - 2.0 * s_ctr) / 2.0
    b = (s_pos - s_neg) / 2.0

    # Peak offset
    safe = np.abs(a) > 1e-12
    a_safe = np.where(safe, a, 1.0)  # avoid division by zero
    t_peak = np.where(safe, -b / (2.0 * a_safe), 0.0)

    # Clamp to ±1.0
    t_peak = np.clip(t_peak, -1.0, 1.0)

    refined = np.column_stack([
        xs + t_peak * cos_th,
        ys + t_peak * sin_th,
    ])
    return refined.astype(np.float64)


@_register("gaussian")
def _refine_gaussian(edge_xy: np.ndarray, gray: np.ndarray) -> np.ndarray:
    """Gaussian (second-derivative zero-crossing) sub-pixel refinement.

    Samples 7 intensity values along the gradient direction and locates the
    zero-crossing of the second derivative (inflection point of the intensity
    profile), which corresponds to the true edge position.
    """
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    theta = np.arctan2(gy, gx)  # (h, w)

    xs = edge_xy[:, 0]
    ys = edge_xy[:, 1]

    h, w = gray.shape[:2]
    xi = np.clip(np.round(xs).astype(np.intp), 0, w - 1)
    yi = np.clip(np.round(ys).astype(np.intp), 0, h - 1)

    th = theta[yi, xi]
    cos_th = np.cos(th)
    sin_th = np.sin(th)

    # Sample 7 intensity points at offsets -3,-2,-1,0,+1,+2,+3
    offsets = np.array([-3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0])
    n = len(xs)
    samples = np.empty((7, n), dtype=np.float64)
    for i, off in enumerate(offsets):
        sx = xs + off * cos_th
        sy = ys + off * sin_th
        samples[i] = _bilinear_sample(gray, sx, sy)

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
