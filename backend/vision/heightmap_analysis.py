"""Height-map detrending: plane fit and 2nd-order polynomial fit.

Subtracts stage tilt (plane mode) or tilt + lens curvature (poly2 mode) from
a depth-from-focus height map.  The current Mitutoyo + 0.5x C-mount optics
bow the height map visibly even on a flat part, so poly2 is what the user
actually runs in practice; plane is there for genuinely flat-optics setups.

Kept intentionally free of app imports so Phase 2 (profile extraction) and
Phase 3 (roughness) can reuse these fits with a mask argument.
"""

from __future__ import annotations

import cv2
import numpy as np


def _coord_grids(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    # Normalize to [-1, 1] on the longest side — keeps A^T A well-conditioned
    # for poly2 regardless of image aspect or absolute pixel size.
    half = max(w, h) / 2.0
    ys, xs = np.indices((h, w), dtype=np.float32)
    xs = (xs - (w - 1) / 2.0) / half
    ys = (ys - (h - 1) / 2.0) / half
    return xs, ys


def _solve(A: np.ndarray, z: np.ndarray) -> np.ndarray:
    coeffs, *_ = np.linalg.lstsq(A, z, rcond=None)
    return coeffs


def fit_plane(height_map: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    h, w = height_map.shape
    xs, ys = _coord_grids(h, w)
    ones = np.ones_like(xs)
    # Full-resolution design matrix used to evaluate the fit across every pixel.
    A_full = np.stack([xs, ys, ones], axis=-1).reshape(-1, 3)
    if mask is None:
        A = A_full
        z = height_map.reshape(-1).astype(np.float32)
    else:
        m = mask.reshape(-1).astype(bool)
        A = A_full[m]
        z = height_map.reshape(-1).astype(np.float32)[m]
    coeffs = _solve(A, z)
    fit = (A_full @ coeffs).reshape(h, w).astype(np.float32)
    return fit


def fit_poly2(height_map: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    h, w = height_map.shape
    xs, ys = _coord_grids(h, w)
    ones = np.ones_like(xs)
    A_full = np.stack([xs * xs, ys * ys, xs * ys, xs, ys, ones], axis=-1).reshape(-1, 6)
    if mask is None:
        A = A_full
        z = height_map.reshape(-1).astype(np.float32)
    else:
        m = mask.reshape(-1).astype(bool)
        A = A_full[m]
        z = height_map.reshape(-1).astype(np.float32)[m]
    coeffs = _solve(A, z)
    fit = (A_full @ coeffs).reshape(h, w).astype(np.float32)
    return fit


def detrend(height_map: np.ndarray, mode: str, mask: np.ndarray | None = None) -> np.ndarray:
    """Subtract a plane or poly2 fit from ``height_map``.

    Returns a new array; the input is never mutated.  The original mean is
    added back so absolute Z numbers stay in the same ballpark as the input
    (useful for colourmap consistency and so downstream mm readouts don't
    flip sign).  Mode 'none' returns a copy unchanged.
    """
    if mode == "none" or mode is None:
        return height_map.astype(np.float32, copy=True)
    if mode == "plane":
        fit = fit_plane(height_map, mask)
    elif mode == "poly2":
        fit = fit_poly2(height_map, mask)
    else:
        raise ValueError(f"Unknown detrend mode: {mode}")
    original_mean = float(height_map.mean())
    return (height_map.astype(np.float32) - fit + original_mean).astype(np.float32)


def sample_profile(
    height_map: np.ndarray,
    p0: tuple[float, float],
    p1: tuple[float, float],
    samples: int | None = None,
) -> dict:
    h, w = height_map.shape
    # Clamp endpoints so cv2.remap never falls off the edge; a click on the
    # extreme right/bottom pixel is still valid.
    x0 = float(np.clip(p0[0], 0.0, w - 1))
    y0 = float(np.clip(p0[1], 0.0, h - 1))
    x1 = float(np.clip(p1[0], 0.0, w - 1))
    y1 = float(np.clip(p1[1], 0.0, h - 1))
    length_px = float(np.hypot(x1 - x0, y1 - y0))
    if samples is None:
        # One sample per pixel of line length keeps the profile at native
        # resolution without over- or under-sampling.
        samples = max(2, int(round(length_px)) + 1)
    samples = max(2, int(samples))

    t = np.linspace(0.0, 1.0, samples, dtype=np.float32)
    xs = (x0 + (x1 - x0) * t).astype(np.float32)
    ys = (y0 + (y1 - y0) * t).astype(np.float32)

    # cv2.remap expects map shape (H_out, W_out) float32; use (1, samples) so
    # output is a 1xN row of bilinear-interpolated heights.
    map_x = xs.reshape(1, -1)
    map_y = ys.reshape(1, -1)
    src = height_map.astype(np.float32)
    z = cv2.remap(src, map_x, map_y, interpolation=cv2.INTER_LINEAR,
                  borderMode=cv2.BORDER_REPLICATE).reshape(-1)

    return {
        "t": t,
        "x_px": xs,
        "y_px": ys,
        "z_mm": z.astype(np.float32),
        "length_px": length_px,
    }
