"""Fringe analysis computation primitives.

Zernike polynomial fitting, DFT-based phase extraction, 2D phase unwrapping,
modulation-based auto-masking, focus quality scoring, surface statistics
(PV/RMS), false-color rendering, and the full analyze/reanalyze pipeline.
"""

from __future__ import annotations

import base64
import io
import math
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np

def _get_plt():
    """Lazy-import matplotlib.pyplot with Agg backend (thread-safe, no GUI)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


# ── Lens undistortion ─────────────────────────────────────────────────────

def undistort_frame(img: np.ndarray, lens_k1: float) -> np.ndarray:
    """Apply Brown-Conrady k1 radial undistortion.

    img : 2D grayscale or 3D color image (any dtype supported by cv2.remap).
    lens_k1 : normalized k1. Denormalized via k1_raw = lens_k1 / ((w²+h²)/4).
              Range typically [-0.8, 0.8] in normalized units.
    """
    if lens_k1 == 0.0:
        return img
    h, w = img.shape[:2]
    cx, cy = w / 2, h / 2
    diag_sq = (w * w + h * h) / 4
    k1_raw = lens_k1 / diag_sq
    f = max(w, h)
    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], dtype=np.float64)
    dist = np.array([k1_raw, 0, 0, 0, 0], dtype=np.float64)
    map1, map2 = cv2.initUndistortRectifyMap(K, dist, None, K, (w, h), cv2.CV_32FC1)
    return cv2.remap(img, map1, map2, cv2.INTER_LINEAR)


# ── Zernike polynomial names (Noll ordering, 1-indexed) ─────────────────

ZERNIKE_NAMES: dict[int, str] = {
    1: "Piston",
    2: "Tilt X",
    3: "Tilt Y",
    4: "Power (Defocus)",
    5: "Astigmatism 45",
    6: "Astigmatism 0",
    7: "Coma Y",
    8: "Coma X",
    9: "Trefoil Y",
    10: "Trefoil X",
    11: "Spherical",
    12: "2nd Astigmatism 0",
    13: "2nd Astigmatism 45",
    14: "2nd Coma X",
    15: "2nd Coma Y",
    16: "Tetrafoil X",
    17: "Tetrafoil Y",
    18: "2nd Trefoil Y",
    19: "2nd Trefoil X",
    20: "3rd Coma Y",
    21: "3rd Coma X",
    22: "2nd Spherical",
    23: "Pentafoil X",
    24: "Pentafoil Y",
    25: "3rd Astigmatism 45",
    26: "3rd Astigmatism 0",
    27: "3rd Trefoil Y",
    28: "3rd Trefoil X",
    29: "3rd Coma Y",
    30: "3rd Coma X",
    31: "3rd Spherical",
    32: "Hexafoil X",
    33: "Hexafoil Y",
    34: "4th Astigmatism 0",
    35: "4th Astigmatism 45",
    36: "4th Spherical",
}

# Mapping from common UI group names to Noll indices for the subtraction panel.
ZERNIKE_GROUPS: dict[str, list[int]] = {
    "Piston": [1],
    "Tilt": [2, 3],
    "Power": [4],
    "Astigmatism": [5, 6],
    "Coma": [7, 8],
    "Spherical": [11],
}


def zernike_noll_index(j: int) -> tuple[int, int]:
    """Convert Noll index j (1-based) to radial order n and azimuthal frequency m.

    Follows the Noll (1976) sequential ordering convention:
      j=1 → (0,0), j=2 → (1,1), j=3 → (1,-1), j=4 → (2,0), ...

    Returns (n, m) where n >= 0 and -n <= m <= n with n-|m| even.
    Sign convention: even j → m > 0 (cos term), odd j → m < 0 (sin term), m=0 is unique.
    Within each radial order n, |m| values are ordered 0 (if n even), then 1 or 2, 3 or 4, etc.
    """
    if j < 1:
        raise ValueError(f"Noll index must be >= 1, got {j}")
    # Find the radial order n: the n-th radial order spans j in [n(n+1)/2+1, (n+1)(n+2)/2]
    n = 0
    while (n + 1) * (n + 2) // 2 < j:
        n += 1
    # Build the full list of (j, m) pairs by enumerating from j=1 up to the target
    # Instead, enumerate the m values for this radial order n in Noll sequence order.
    # Within radial order n:
    #   if n is even: start with m_abs=0 (one term), then m_abs=2,4,...,n (two terms each)
    #   if n is odd: start with m_abs=1,3,...,n (two terms each)
    # For each pair at a given |m|, the sign depends on the running j index:
    #   even j → positive m, odd j → negative m
    running_j = n * (n + 1) // 2 + 1  # first j in this radial order
    if n % 2 == 0:
        m_abs_sequence = [0] + list(range(2, n + 1, 2))
    else:
        m_abs_sequence = list(range(1, n + 1, 2))

    for m_abs in m_abs_sequence:
        if m_abs == 0:
            if running_j == j:
                return (n, 0)
            running_j += 1
        else:
            # Two terms for this |m|
            for _ in range(2):
                if running_j == j:
                    m = m_abs if running_j % 2 == 0 else -m_abs
                    return (n, m)
                running_j += 1
    # Should never reach here for valid j
    raise RuntimeError(f"Failed to resolve Noll index j={j}")


def _radial_polynomial(n: int, m_abs: int, rho: np.ndarray) -> np.ndarray:
    """Compute the radial Zernike polynomial R_n^|m|(rho).

    Uses the explicit sum formula:
      R_n^m(rho) = sum_{s=0}^{(n-m)/2} (-1)^s * (n-s)! / (s! * ((n+m)/2-s)! * ((n-m)/2-s)!) * rho^(n-2s)
    """
    result = np.zeros_like(rho)
    for s in range((n - m_abs) // 2 + 1):
        num = ((-1) ** s) * math.factorial(n - s)
        den = (
            math.factorial(s)
            * math.factorial((n + m_abs) // 2 - s)
            * math.factorial((n - m_abs) // 2 - s)
        )
        result = result + (num / den) * rho ** (n - 2 * s)
    return result


def zernike_polynomial(j: int, rho: np.ndarray, theta: np.ndarray) -> np.ndarray:
    """Evaluate Zernike polynomial Z_j over normalized polar coordinates.

    Parameters
    ----------
    j : Noll index (1-based).
    rho : radial coordinate, normalized to [0, 1] over the aperture.
    theta : azimuthal angle in radians.

    Returns
    -------
    Z_j(rho, theta) as a float64 array with the same shape as rho.
    Normalization follows the Noll convention (orthonormal over the unit disk).
    """
    n, m = zernike_noll_index(j)
    m_abs = abs(m)
    R = _radial_polynomial(n, m_abs, rho)
    # Normalization factor
    if m == 0:
        norm = math.sqrt(n + 1.0)
    else:
        norm = math.sqrt(2.0 * (n + 1.0))
    if m > 0:
        return norm * R * np.cos(m_abs * theta)
    elif m < 0:
        return norm * R * np.sin(m_abs * theta)
    else:
        return norm * R


def zernike_basis(n_terms: int, rho: np.ndarray, theta: np.ndarray,
                  mask: np.ndarray | None = None) -> np.ndarray:
    """Build a Zernike basis matrix for fitting.

    Parameters
    ----------
    n_terms : number of Zernike terms (Noll j = 1..n_terms).
    rho : 2D array of normalized radial coordinates.
    theta : 2D array of azimuthal angles.
    mask : optional boolean mask; only True pixels are included.

    Returns
    -------
    Z : shape (n_valid_pixels, n_terms) basis matrix.
    """
    if mask is not None:
        valid = mask.ravel().astype(bool)
        rho_v = rho.ravel()[valid]
        theta_v = theta.ravel()[valid]
    else:
        rho_v = rho.ravel()
        theta_v = theta.ravel()
    n_px = rho_v.size
    Z = np.empty((n_px, n_terms), dtype=np.float64)
    for j in range(1, n_terms + 1):
        Z[:, j - 1] = zernike_polynomial(j, rho_v, theta_v)
    return Z


def _make_polar_coords(shape: tuple[int, int], mask: np.ndarray | None = None
                       ) -> tuple[np.ndarray, np.ndarray]:
    """Create normalized polar coordinates over the aperture.

    The aperture center is the image center. The normalization radius is
    the largest radius that fits within the masked region (if mask is given)
    or within the image rectangle (if no mask).
    """
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2.0, h / 2.0
    dx = (xx - cx).astype(np.float64)
    dy = (yy - cy).astype(np.float64)
    r = np.sqrt(dx ** 2 + dy ** 2)
    if mask is not None and mask.any():
        r_max = float(r[mask].max())
    else:
        r_max = float(r.max())
    if r_max < 1e-6:
        r_max = 1.0
    rho = r / r_max
    theta = np.arctan2(dy, dx)
    return rho, theta


def fit_zernike(surface: np.ndarray, n_terms: int = 36,
                mask: np.ndarray | None = None
                ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Least-squares fit of Zernike polynomials to a surface.

    Parameters
    ----------
    surface : 2D phase or height array.
    n_terms : number of Zernike terms to fit (default 36).
    mask : boolean mask (True = valid pixel).

    Returns
    -------
    coeffs : shape (n_terms,) array of Zernike coefficients.
    rho : 2D normalized radial coordinates (for reuse in subtract).
    theta : 2D azimuthal angles (for reuse in subtract).
    """
    rho, theta = _make_polar_coords(surface.shape, mask)
    Z = zernike_basis(n_terms, rho, theta, mask)
    if mask is not None:
        data = surface.ravel()[mask.ravel().astype(bool)]
    else:
        data = surface.ravel()
    # Least-squares solve
    coeffs, _, _, _ = np.linalg.lstsq(Z, data, rcond=None)
    return coeffs, rho, theta


def subtract_zernike(surface: np.ndarray, coeffs: np.ndarray,
                     terms_to_subtract: list[int],
                     rho: np.ndarray, theta: np.ndarray,
                     mask: np.ndarray | None = None) -> np.ndarray:
    """Reconstruct and subtract selected Zernike terms from a surface.

    Parameters
    ----------
    surface : 2D array (original unwrapped phase or height).
    coeffs : Zernike coefficients from fit_zernike.
    terms_to_subtract : list of Noll indices (1-based) to subtract.
    rho : normalized radial coordinates from fit_zernike.
    theta : azimuthal angles from fit_zernike.
    mask : boolean mask (True = valid).

    Returns
    -------
    Corrected surface with the selected terms removed.
    """
    correction = np.zeros(surface.shape, dtype=np.float64)
    for j in terms_to_subtract:
        if j < 1 or j > len(coeffs):
            continue
        Zj = zernike_polynomial(j, rho, theta)
        correction += coeffs[j - 1] * Zj
    result = surface.astype(np.float64) - correction
    if mask is not None:
        result[~mask.astype(bool)] = 0.0
    return result


# ── Plane subtraction (residual tilt on rectangular apertures) ────────


def _subtract_plane(surface: np.ndarray, mask: np.ndarray | None = None
                    ) -> np.ndarray:
    """Fit and subtract a least-squares plane from the surface.

    Zernike tilt terms (Z2, Z3) are defined on a circular domain.  When the
    aperture is rectangular (e.g. a user-drawn ROI), the circular fit can
    leave residual linear slope that dominates the color scale.  This
    function removes that residual by fitting ax + by + c directly to the
    valid pixels.
    """
    h, w = surface.shape
    yy, xx = np.mgrid[0:h, 0:w]
    if mask is not None:
        valid = mask.astype(bool)
        xs, ys, zs = xx[valid], yy[valid], surface[valid]
    else:
        xs, ys, zs = xx.ravel(), yy.ravel(), surface.ravel()

    if len(zs) < 3:
        return surface  # not enough points for a plane fit

    A = np.column_stack([xs, ys, np.ones(len(xs))])
    coeffs, _, _, _ = np.linalg.lstsq(A, zs, rcond=None)
    plane = coeffs[0] * xx + coeffs[1] * yy + coeffs[2]
    result = surface - plane
    if mask is not None:
        result[~valid] = 0.0
    return result


def _fit_plane(surface: np.ndarray, mask: np.ndarray | None = None) -> dict:
    """Fit a least-squares plane and return coefficients for diagnostics."""
    h, w = surface.shape
    yy, xx = np.mgrid[0:h, 0:w]
    if mask is not None:
        valid = mask.astype(bool)
        xs, ys, zs = xx[valid], yy[valid], surface[valid]
    else:
        xs, ys, zs = xx.ravel(), yy.ravel(), surface.ravel()

    if len(zs) < 3:
        return {"a": 0, "b": 0, "c": 0, "tilt_x_nm": 0, "tilt_y_nm": 0}

    A = np.column_stack([xs, ys, np.ones(len(xs))])
    coeffs, _, _, _ = np.linalg.lstsq(A, zs, rcond=None)
    return {
        "a": float(coeffs[0]),
        "b": float(coeffs[1]),
        "c": float(coeffs[2]),
        "tilt_x_nm": float(coeffs[0] * w),
        "tilt_y_nm": float(coeffs[1] * h),
    }


# ── M4.3: Low-order polynomial form removal (non-circular apertures) ──


def _poly_basis(shape: tuple[int, int], degree: int,
                mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Build a 2D polynomial design matrix of total degree ``degree``.

    Basis: {x^i * y^j for i+j <= degree}. Coordinates are normalized to
    the aperture's bounding box so powers stay numerically stable (large
    pixel indices would otherwise produce conditioning problems on the
    lstsq solve).

    Returns (A, xs_grid, ys_grid, exponents) where ``A`` is the design
    matrix over the *masked* pixels, and the grids/exponents are suitable
    for reconstructing the fitted surface over the full shape.
    """
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    # Normalize to roughly [-1, 1] on the longer axis; keeps basis well-conditioned.
    half = max(h, w) / 2.0
    xs_grid = (xx - (w - 1) / 2.0) / half
    ys_grid = (yy - (h - 1) / 2.0) / half

    # Enumerate exponents (i, j) with i + j <= degree.
    exponents = [(i, j) for total in range(degree + 1)
                 for i in range(total + 1)
                 for j in range(total + 1) if i + j == total]

    if mask is not None:
        valid = mask.astype(bool)
        xs_v = xs_grid[valid]
        ys_v = ys_grid[valid]
    else:
        xs_v = xs_grid.ravel()
        ys_v = ys_grid.ravel()

    cols = [xs_v ** i * ys_v ** j for (i, j) in exponents]
    A = np.column_stack(cols) if cols else np.zeros((xs_v.size, 0))
    return A, xs_grid, ys_grid, np.asarray(exponents, dtype=int)


def _subtract_poly(surface: np.ndarray, mask: np.ndarray | None,
                   degree: int) -> np.ndarray:
    """Fit and subtract a 2D polynomial of total degree ``degree``.

    ``degree=1`` reduces to plane subtraction; ``degree=2`` captures
    defocus + astigmatism over non-circular apertures; ``degree=3`` adds
    coma-like aberrations. Pixels outside the mask are zeroed.
    """
    if mask is not None:
        valid = mask.astype(bool)
        if valid.sum() < 3:
            return surface
    A, xs_grid, ys_grid, exponents = _poly_basis(surface.shape, degree, mask)
    if A.shape[0] == 0 or A.shape[1] == 0:
        return surface

    if mask is not None:
        data = surface[valid]
    else:
        data = surface.ravel()

    coeffs, _, _, _ = np.linalg.lstsq(A, data, rcond=None)

    # Reconstruct the fitted surface across the full shape for subtraction.
    fitted = np.zeros(surface.shape, dtype=np.float64)
    for k, (i, j) in enumerate(exponents):
        fitted += coeffs[k] * (xs_grid ** i) * (ys_grid ** j)
    result = surface.astype(np.float64) - fitted
    if mask is not None:
        result[~valid] = 0.0
    return result


# ── Fringe modulation, masking, DFT phase extraction, unwrapping ──────


def _dominant_brightness_bbox(image: np.ndarray) -> tuple[int, int, int, int] | None:
    """Return a dominant illuminated component bbox, if one is unambiguous.

    This is used only for carrier detection. It helps when the useful fringe
    patch occupies a small part of a larger frame, where aperture/lighting
    gradients can otherwise dominate the lowest FFT bins. Ordinary full-field
    fringes produce many similar Otsu components, so they intentionally do not
    trigger this crop.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    h, w = img.shape
    if h < 32 or w < 32 or img.max() <= 0:
        return None

    img_u8 = np.clip(img / max(img.max(), 1) * 255, 0, 255).astype(np.uint8)
    _, bright_mask = cv2.threshold(img_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    cleaned = cv2.morphologyEx(bright_mask, cv2.MORPH_OPEN, kernel)
    n_labels, _, stats, _ = cv2.connectedComponentsWithStats(
        (cleaned > 0).astype(np.uint8), 8
    )
    if n_labels <= 1:
        return None

    areas = stats[1:, cv2.CC_STAT_AREA].astype(np.int64)
    order = np.argsort(areas)[::-1]
    best_label = int(order[0] + 1)
    best_area = int(areas[order[0]])
    second_area = int(areas[order[1]]) if len(order) > 1 else 0

    # Ignore tiny bright specks; they are usually dust/glare, not the aperture.
    if best_area < 0.01 * h * w:
        return None
    # Only crop when there is one clear illuminated target. Repeating bright
    # fringe bands should not be mistaken for a part aperture.
    if second_area > 0 and best_area / max(second_area, 1) < 5.0:
        return None

    x = int(stats[best_label, cv2.CC_STAT_LEFT])
    y = int(stats[best_label, cv2.CC_STAT_TOP])
    bw = int(stats[best_label, cv2.CC_STAT_WIDTH])
    bh = int(stats[best_label, cv2.CC_STAT_HEIGHT])
    if bw < 32 or bh < 32:
        return None
    # Reject thin outlines/text/edges; the carrier crop is meant for filled
    # illuminated regions.
    if best_area / max(bw * bh, 1) < 0.35:
        return None
    # A small component clipped by the image border is commonly a lighting
    # gradient tail, not a stable analysis aperture.
    touches_border = x <= 0 or y <= 0 or (x + bw) >= w or (y + bh) >= h
    if touches_border and (bw * bh) < 0.25 * h * w:
        return None
    # If it nearly fills the frame, cropping adds no value and can distort
    # diagnostics.
    if (bw * bh) > 0.85 * h * w:
        return None

    pad_y = max(4, int(0.05 * bh))
    pad_x = max(4, int(0.05 * bw))
    y0 = max(0, y - pad_y)
    y1 = min(h, y + bh + pad_y)
    x0 = max(0, x - pad_x)
    x1 = min(w, x + bw + pad_x)
    return y0, y1, x0, x1


def _subpixel_peak_offset(m_minus: float, m_zero: float, m_plus: float) -> float:
    """Parabolic-interpolation offset of a discrete peak.

    Given three magnitudes around a local maximum (m_minus < m_zero >= m_plus),
    fits a parabola and returns the fractional offset of the true peak from
    the discrete index. Result is in (-1, 1); clamped if degenerate.
    """
    denom = m_minus - 2.0 * m_zero + m_plus
    if denom >= -1e-12:  # not a strict maximum (or numerically flat)
        return 0.0
    offset = 0.5 * (m_minus - m_plus) / denom
    if offset < -1.0 or offset > 1.0:
        return 0.0
    return offset


def _paraboloid_subpixel_offset(magnitude: np.ndarray, py: int, px: int,
                                h: int, w: int, cy: int = 0, cx: int = 0,
                                radius: int = 2,
                                ) -> tuple[float, float, bool]:
    """M2.2: 2-D paraboloid fit over an annular neighborhood of an FFT peak.

    Fits ``m(dy, dx) = a + b·dy + c·dx + d·dy² + e·dx² + f·dy·dx`` on
    log-magnitudes within a (2·radius+1)² window centered on the integer
    peak, restricted to the same half-plane as the +1 order selection
    (`y > cy`, or `y == cy && x > cx`). Returns the vertex offset
    ``(dy*, dx*)`` of the fitted paraboloid.

    Returns
    -------
    (dy_offset, dx_offset, used) : floats in ≈ (-1, 1) and a success flag.
        When fewer than 8 usable bins are present, falls back to
        ``used=False`` and the caller should use the 1-D parabolic fit.
    """
    ys = []
    xs = []
    mags = []
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            y = py + dy
            x = px + dx
            if y < 0 or y >= h or x < 0 or x >= w:
                continue
            # NOTE: we intentionally include neighbors on both sides of the
            # peak, even when the peak sits on the central row/column. A
            # half-plane restriction (to avoid the conjugate lobe) biases the
            # paraboloid fit asymmetrically and produces spurious sub-pixel
            # offsets perpendicular to the carrier for horizontal/vertical
            # fringes. The conjugate peak is always at (2cy-py, 2cx-px),
            # which for any nontrivial carrier is well outside a ±2-bin
            # window around the primary peak.
            val = float(magnitude[y, x])
            if val <= 0:
                continue
            ys.append(dy)
            xs.append(dx)
            mags.append(val)

    if len(mags) < 8:
        return 0.0, 0.0, False

    dy_arr = np.asarray(ys, dtype=np.float64)
    dx_arr = np.asarray(xs, dtype=np.float64)
    # Log-magnitude so Gaussian-like peaks land on a true paraboloid.
    log_mag = np.log(np.asarray(mags, dtype=np.float64) + 1e-12)

    A = np.column_stack([
        np.ones_like(dy_arr),
        dy_arr,
        dx_arr,
        dy_arr ** 2,
        dx_arr ** 2,
        dy_arr * dx_arr,
    ])
    coeffs, *_ = np.linalg.lstsq(A, log_mag, rcond=None)
    _, b, c, d, e, f = coeffs
    # Vertex of `a + b·y + c·x + d·y² + e·x² + f·y·x`:
    #   grad = [b + 2d·y + f·x, c + 2e·x + f·y] = 0
    #   → [[2d, f], [f, 2e]] · [y*, x*] = [-b, -c]
    H = np.array([[2.0 * d, f], [f, 2.0 * e]], dtype=np.float64)
    det = H[0, 0] * H[1, 1] - H[0, 1] * H[1, 0]
    # Require a concave-down maximum: both diagonal curvatures negative,
    # positive determinant. Otherwise the solve returns a saddle or runaway.
    if det <= 0 or d >= 0 or e >= 0:
        return 0.0, 0.0, False
    try:
        offset = np.linalg.solve(H, np.array([-b, -c]))
    except np.linalg.LinAlgError:
        return 0.0, 0.0, False
    dy_star = float(offset[0])
    dx_star = float(offset[1])
    # Sanity clamp; a paraboloid vertex more than 1.5 bins from the discrete
    # peak is almost always a bad fit (sparse annulus, adjacent side-lobe).
    if not (abs(dy_star) <= 1.5 and abs(dx_star) <= 1.5):
        return 0.0, 0.0, False
    return dy_star, dx_star, True


def _find_carrier(image: np.ndarray, *,
                  dc_margin_override: int | None = None,
                  dc_cutoff_cycles: float | None = 1.5,
                  ) -> tuple[float, float, float]:
    """Find the carrier frequency peak in an interferogram with sub-pixel precision.

    Returns (peak_y, peak_x, distance) in the fftshift coordinate system.
    Coordinates are floats (parabolic-interpolated for sub-FFT-bin accuracy).

    The peak is always in the lower half-plane (or right half for horizontal
    fringes) to select the +1 order — i.e. the surface-bearing sideband for
    images of the form `cos(2π·(fy·y + fx·x) + surface)` with `fy>0` or `fx>0`.
    The conjugate sideband, in the upper-left quadrant, would give a recovered
    surface phase with the wrong sign.

    Parameters
    ----------
    dc_margin_override : optional integer in [0, 32]. When provided, overrides
        the hard-coded ``dc_margin_y/x = 2`` neighborhood that suppresses the
        DC peak before argmax. Useful for very-low-fringe-count captures where
        the carrier sits adjacent to the default DC mask. ``None`` keeps the
        legacy default of 2.
    dc_cutoff_cycles : optional float. M2.1 exponential DC high-pass cutoff in
        FFT-bin units (i.e. ``ρ_cutoff`` such that the suppression factor is
        ``1 - exp(-(ρ / ρ_cutoff)²)``). Default 1.5 gives a soft ramp that
        matches the existing hard dc_margin=2 sensitivity without the sharp
        cliff that causes spectral ringing on clean data. Interaction with
        ``dc_margin_override``: the hard zero (legacy behavior) is applied
        first, then the smooth ramp multiplies the remaining magnitudes. This
        preserves explicit user widening while still smoothing the transition.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    orig_h, orig_w = img.shape

    bbox = _dominant_brightness_bbox(img)
    crop_h, crop_w = orig_h, orig_w
    if bbox is not None:
        y0, y1, x0, x1 = bbox
        img = img[y0:y1, x0:x1]
        crop_h, crop_w = img.shape

    h, w = img.shape

    # Downsample large images for speed (carrier detection doesn't need full res)
    scale = 1
    if max(h, w) > 1024:
        scale = max(h, w) / 1024
        img = cv2.resize(img, (int(w / scale), int(h / scale)),
                         interpolation=cv2.INTER_AREA)
        h, w = img.shape

    img = img - img.mean()
    wy = np.hanning(h)
    wx = np.hanning(w)
    img_windowed = img * np.outer(wy, wx)

    F = np.fft.fft2(img_windowed)
    F_shifted = np.fft.fftshift(F)
    magnitude = np.abs(F_shifted)

    cy, cx = h // 2, w // 2
    # Keep the DC margin fixed in FFT-bin coordinates. Real interferograms can
    # have as few as 3-5 fringes across the field, so any image-size-scaled
    # margin can mask the true carrier on high-resolution captures.
    # M2.5: dc_margin_override widens the DC rejection on very-low-fringe-count
    # captures. None keeps the legacy default of 2.
    if dc_margin_override is not None:
        dc_margin_y = int(dc_margin_override)
        dc_margin_x = int(dc_margin_override)
    else:
        dc_margin_y = 2
        dc_margin_x = 2
    mag_search = magnitude.copy()
    mag_search[cy - dc_margin_y:cy + dc_margin_y + 1,
               cx - dc_margin_x:cx + dc_margin_x + 1] = 0

    # M2.1: smooth exponential DC high-pass `a(ρ) = 1 - exp(-(ρ/ρ_cutoff)²)`
    # applied on top of the hard zero. The hard zero stays so that
    # dc_margin_override still has bite; the ramp tames the cliff that caused
    # ringing in surface maps from otherwise-clean data. `ρ` is in FFT bins
    # measured from the DC center in this (possibly cropped/downsampled)
    # frame; the cutoff is in the same units so a single scalar works across
    # image sizes.
    if dc_cutoff_cycles is not None and dc_cutoff_cycles > 0:
        yy_m, xx_m = np.mgrid[0:h, 0:w]
        rho = np.sqrt((yy_m - cy) ** 2 + (xx_m - cx) ** 2)
        dc_ramp = 1.0 - np.exp(-(rho / float(dc_cutoff_cycles)) ** 2)
        mag_search = mag_search * dc_ramp

    # Zero out the upper half-plane (and left half of center row) so we can
    # only ever find the +1 order peak — the surface-bearing sideband for
    # `cos(+carrier + surface)`. Conjugate symmetry means the −1 order has
    # identical magnitude in the upper-left, so without this constraint
    # argmax tie-breaking could flip and globally invert the recovered
    # surface phase.
    mag_search[:cy, :] = 0
    mag_search[cy, :cx] = 0

    peak_idx = np.unravel_index(np.argmax(mag_search), mag_search.shape)
    py, px = int(peak_idx[0]), int(peak_idx[1])
    peak_val = float(mag_search[py, px])

    dist = math.sqrt((py - cy) ** 2 + (px - cx) ** 2)
    if dist <= 6 and peak_val > 0:
        # Very-low-frequency peaks are often residual aperture/illumination
        # structure. If a slightly higher-frequency carrier is nearly as strong,
        # prefer it; if not, keep the low-frequency result so genuine 3-5 fringe
        # interferograms still work.
        retry_margin_y = 6
        retry_margin_x = 6
        mag_retry = magnitude.copy()
        mag_retry[cy - retry_margin_y:cy + retry_margin_y + 1,
                  cx - retry_margin_x:cx + retry_margin_x + 1] = 0
        mag_retry[:cy, :] = 0
        mag_retry[cy, :cx] = 0
        retry_idx = np.unravel_index(np.argmax(mag_retry), mag_retry.shape)
        rpy, rpx = int(retry_idx[0]), int(retry_idx[1])
        retry_val = float(mag_retry[rpy, rpx])
        retry_dist = math.sqrt((rpy - cy) ** 2 + (rpx - cx) ** 2)
        if retry_dist > dist and retry_val >= 0.70 * peak_val:
            py, px = rpy, rpx
            dist = retry_dist

    # Sub-pixel refinement.
    # M2.2: prefer a 2-D paraboloid fit over an annulus of ±2 bins around the
    # integer peak (log-magnitude makes Gaussian-like peaks fit well). Fall
    # back to the 1-D parabolic interpolation when the annulus is too sparse.
    # Using `magnitude` (not `mag_search`) so the zeroed half-plane / DC ramp
    # doesn't bias the fit; the peak itself is in the kept half-plane by
    # construction, so neighbors on the zeroed side just get excluded below.
    py_f = float(py)
    px_f = float(px)

    dy_off, dx_off, used_paraboloid = _paraboloid_subpixel_offset(
        magnitude, py, px, h, w, cy, cx,
    )
    if used_paraboloid:
        py_f += dy_off
        px_f += dx_off
    else:
        if 0 < py < h - 1:
            py_f += _subpixel_peak_offset(
                float(magnitude[py - 1, px]),
                float(magnitude[py, px]),
                float(magnitude[py + 1, px]),
            )
        if 0 < px < w - 1:
            px_f += _subpixel_peak_offset(
                float(magnitude[py, px - 1]),
                float(magnitude[py, px]),
                float(magnitude[py, px + 1]),
            )

    # Map the detected frequency back to the original fftshift coordinate
    # system. Cycles/pixel are invariant under uniform downsampling, so the
    # downsample factor is intentionally absent here. Cropping is different: a
    # frequency measured over a smaller field must be scaled back by the crop
    # ratio to express it as a full-frame FFT-bin offset.
    off_y = (py_f - cy) * (orig_h / max(crop_h, 1))
    off_x = (px_f - cx) * (orig_w / max(crop_w, 1))
    py_orig = float(orig_h // 2) + off_y
    px_orig = float(orig_w // 2) + off_x
    dist_orig = math.sqrt(off_y ** 2 + off_x ** 2)
    return py_orig, px_orig, dist_orig


def _analyze_carrier(image: np.ndarray, mask: np.ndarray | None = None) -> dict:
    """Analyze carrier frequency and return diagnostic information.

    Parameters
    ----------
    image : 2D float64 image.
    mask : optional boolean mask (True = valid fringe region). When provided,
           the image is cropped to the mask bounding box (+5% padding) before
           FFT so fringes fill the analysis region, improving peak_ratio for
           partial-coverage images.

    Returns dict with keys:
    - peak_y, peak_x: carrier peak position in fftshift coords
    - distance_px: distance from DC in pixels
    - fringe_period_px: fringe period in pixels
    - fringe_angle_deg: fringe orientation in degrees (0-180)
    - peak_ratio: ratio of carrier peak to secondary peak (confidence metric)
    - fx_cpp, fy_cpp: carrier frequency in cycles per pixel
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    h, w = img.shape

    py, px, dist = _find_carrier(img)

    # Frequency in cycles per pixel
    fy = (py - h // 2) / h
    fx = (px - w // 2) / w
    fringe_freq = math.sqrt(fy**2 + fx**2)
    fringe_period = 1.0 / fringe_freq if fringe_freq > 1e-10 else float("inf")
    fringe_angle = (math.degrees(math.atan2(fy, fx)) + 90.0) % 180.0

    # Peak ratio: carrier peak magnitude vs secondary peak (confidence).
    # When a mask or one clear bright part/aperture is available, crop to that
    # region so fringes fill the analysis image. Hard zeroing or modulation
    # weighting don't work because they introduce spectral leakage from the
    # window shape itself.
    analysis_img = img
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            rows = np.any(valid, axis=1)
            cols = np.any(valid, axis=0)
            y0, y1 = np.where(rows)[0][[0, -1]]
            x0, x1 = np.where(cols)[0][[0, -1]]
            # Pad by 5% to avoid cutting fringes at the boundary
            pad_y = max(4, int(0.05 * (y1 - y0)))
            pad_x = max(4, int(0.05 * (x1 - x0)))
            y0 = max(0, y0 - pad_y)
            y1 = min(h - 1, y1 + pad_y)
            x0 = max(0, x0 - pad_x)
            x1 = min(w - 1, x1 + pad_x)
            cropped = img[y0:y1 + 1, x0:x1 + 1]
            # Only use crop if it's meaningfully smaller than the full image
            if cropped.size < img.size * 0.8:
                analysis_img = cropped
    else:
        bbox = _dominant_brightness_bbox(img)
        if bbox is not None:
            y0, y1, x0, x1 = bbox
            analysis_img = img[y0:y1, x0:x1]
    ah, aw = analysis_img.shape
    img_c = analysis_img - analysis_img.mean()
    img_windowed = img_c * np.outer(np.hanning(ah), np.hanning(aw))
    F = np.fft.fftshift(np.fft.fft2(img_windowed))
    magnitude = np.abs(F)

    # Find carrier peak in the (possibly cropped) magnitude spectrum
    acy, acx = ah // 2, aw // 2
    dc_margin = 2
    mag_search = magnitude.copy()
    mag_search[acy - dc_margin:acy + dc_margin + 1, acx - dc_margin:acx + dc_margin + 1] = 0

    # Score the same carrier selected by _find_carrier(), expressed in the
    # diagnostic crop's FFT coordinates. This keeps displayed diagnostics
    # aligned with the carrier used for modulation and phase extraction.
    expected_y = int(round(acy + fy * ah))
    expected_x = int(round(acx + fx * aw))
    if 0 <= expected_y < ah and 0 <= expected_x < aw:
        r_local = 5
        y0 = max(0, expected_y - r_local)
        y1 = min(ah, expected_y + r_local + 1)
        x0 = max(0, expected_x - r_local)
        x1 = min(aw, expected_x + r_local + 1)
        local = mag_search[y0:y1, x0:x1]
        local_idx = np.unravel_index(np.argmax(local), local.shape)
        apy = int(y0 + local_idx[0])
        apx = int(x0 + local_idx[1])
    else:
        a_peak_idx = np.unravel_index(np.argmax(mag_search), mag_search.shape)
        apy, apx = int(a_peak_idx[0]), int(a_peak_idx[1])
    carrier_peak_val = magnitude[apy, apx]

    # Mask carrier and conjugate (±5px neighborhood)
    r = 5
    y_lo, y_hi = max(0, apy - r), min(ah, apy + r + 1)
    x_lo, x_hi = max(0, apx - r), min(aw, apx + r + 1)
    mag_search[y_lo:y_hi, x_lo:x_hi] = 0
    conj_y, conj_x = 2 * acy - apy, 2 * acx - apx
    cy_lo, cy_hi = max(0, conj_y - r), min(ah, conj_y + r + 1)
    cx_lo, cx_hi = max(0, conj_x - r), min(aw, conj_x + r + 1)
    mag_search[cy_lo:cy_hi, cx_lo:cx_hi] = 0

    secondary_peak_val = mag_search.max()
    peak_ratio = carrier_peak_val / max(secondary_peak_val, 1e-10)

    # SNR: carrier peak vs noise floor (median of non-DC, non-carrier region)
    noise_floor = float(np.median(mag_search[mag_search > 0])) if np.any(mag_search > 0) else 1e-10
    snr_db = float(10 * np.log10(max(carrier_peak_val / max(noise_floor, 1e-10), 1e-10)))

    # DC margin: distance from carrier peak to DC mask boundary (full-image coords)
    cy_full, cx_full = h // 2, w // 2
    dc_margin_full = 2
    dc_margin_px = float(np.sqrt((py - cy_full) ** 2 + (px - cx_full) ** 2) - dc_margin_full)
    dc_margin_px = max(0.0, dc_margin_px)

    # Alternate peaks: top 3 remaining peaks after masking carrier.
    # Each entry carries the same frequency-derived fields as the chosen
    # peak, expressed in the diagnostic crop's (ah, aw) coord system so the
    # UI can display alternates identically to the primary carrier.
    alternate_peaks = []
    for _ in range(3):
        if not np.any(mag_search > 0):
            break
        alt_idx = np.unravel_index(np.argmax(mag_search), mag_search.shape)
        alt_y, alt_x = int(alt_idx[0]), int(alt_idx[1])
        alt_val = float(mag_search[alt_y, alt_x])
        if alt_val <= 0:
            break
        alt_dist = float(np.sqrt((alt_y - acy) ** 2 + (alt_x - acx) ** 2))
        alt_ratio = carrier_peak_val / max(alt_val, 1e-10)
        # Frequency in cycles/pixel in the crop's FFT coord system.
        alt_fx = (alt_x - acx) / max(aw, 1)
        alt_fy = (alt_y - acy) / max(ah, 1)
        alt_freq = math.sqrt(alt_fx ** 2 + alt_fy ** 2)
        alt_period = 1.0 / alt_freq if alt_freq > 1e-10 else float("inf")
        alt_angle = (math.degrees(math.atan2(alt_fy, alt_fx)) + 90.0) % 180.0
        alternate_peaks.append({
            "y": alt_y, "x": alt_x,
            "distance_px": round(alt_dist, 1),
            "peak_ratio": round(alt_ratio, 2),
            "fx_cpp": float(alt_fx),
            "fy_cpp": float(alt_fy),
            "fringe_period_px": float(alt_period),
            "fringe_angle_deg": float(alt_angle),
            "magnitude": round(alt_val, 2),
        })
        ay_lo, ay_hi = max(0, alt_y - 5), min(ah, alt_y + 6)
        ax_lo, ax_hi = max(0, alt_x - 5), min(aw, alt_x + 6)
        mag_search[ay_lo:ay_hi, ax_lo:ax_hi] = 0

    return {
        "peak_y": int(py),
        "peak_x": int(px),
        "distance_px": float(dist),
        "fringe_period_px": float(fringe_period),
        "fringe_angle_deg": float(fringe_angle),
        "peak_ratio": float(peak_ratio),
        "fx_cpp": float(fx),
        "fy_cpp": float(fy),
        "snr_db": round(snr_db, 1),
        "dc_margin_px": round(dc_margin_px, 1),
        "alternate_peaks": alternate_peaks,
    }


def compute_confidence(carrier_info: dict, modulation: np.ndarray,
                       risk_mask: np.ndarray, mask: np.ndarray,
                       threshold_frac: float = 0.15) -> dict:
    """Compute per-stage confidence scores (0–100) from pipeline data.

    Parameters
    ----------
    carrier_info : dict
        Output of ``_analyze_carrier()``, must contain ``"peak_ratio"``.
    modulation : 2-D float ndarray
        Fringe modulation map (values in [0, 1]).
    risk_mask : 2-D uint8 ndarray
        Unwrap risk/correction mask (0 = reliable, non-zero = corrected).
    mask : 2-D bool ndarray
        Valid-pixel mask (True where pixel should be included).
    threshold_frac : float
        Fraction of median modulation used as the coverage threshold.

    Returns
    -------
    dict with keys ``carrier``, ``modulation``, ``unwrap``, ``overall``
    (all floats rounded to one decimal, in [0, 100]).
    """
    # Carrier confidence: normalize peak_ratio to 0–100.
    # Thresholds are lenient because high-contrast fringes produce strong
    # harmonics (2f, 3f) that lower the ratio even on excellent data.
    # A peak_ratio of 2–3 is perfectly usable; the bandpass filter around
    # the carrier already rejects harmonic content.
    pr = carrier_info.get("peak_ratio", 0)
    if pr >= 5:
        carrier_score = 100.0
    elif pr >= 3:
        carrier_score = 70 + (pr - 3) * 15  # 70–100 linear over 3–5
    elif pr >= 1.5:
        carrier_score = 30 + (pr - 1.5) * (40 / 1.5)  # 30–70 linear over 1.5–3
    else:
        carrier_score = max(0, pr * 20)  # 0–30 linear over 0–1.5

    # Modulation score: enough high-modulation pixels for reliable fitting?
    # We need sufficient absolute pixel count, not a high fraction of the
    # mask — partial-coverage images can give excellent results from a small
    # region.  Score based on the number of good-modulation pixels, with
    # 5000 pixels as "fully confident" (plenty for 37-term Zernike fit).
    valid = mask.astype(bool)
    n_valid = int(np.sum(valid))
    if n_valid > 0:
        median_mod = float(np.median(modulation[valid]))
        thresh = threshold_frac * max(median_mod, 0.1)
        n_good_mod = int(np.sum(modulation[valid] > thresh))
        mod_coverage_pct = 100.0 * n_good_mod / n_valid
        # Score: 100 at ≥5000 good pixels, linear ramp below
        min_pixels = 5000
        mod_score = min(100.0, 100.0 * n_good_mod / min_pixels)
    else:
        mod_coverage_pct = 0.0
        n_good_mod = 0
        mod_score = 0.0

    # Unwrap confidence: % of valid pixels that are reliable (risk == 0)
    if n_valid > 0:
        n_reliable = int(np.sum((risk_mask[valid] == 0)))
        unwrap_score = 100.0 * n_reliable / n_valid
    else:
        unwrap_score = 0.0

    # Overall: weakest link
    overall = min(carrier_score, mod_score, unwrap_score)

    return {
        "carrier": round(carrier_score, 1),
        "modulation": round(mod_score, 1),
        "modulation_coverage_pct": round(mod_coverage_pct, 1),
        "modulation_good_pixels": n_good_mod,
        "unwrap": round(unwrap_score, 1),
        "overall": round(overall, 1),
    }


def compute_fringe_modulation(image: np.ndarray) -> np.ndarray:
    """Compute a carrier-aware modulation map for auto-masking.

    Two-step approach:
    1. Detect the carrier frequency from the FFT.
    2. Bandpass around the carrier using a complex demodulation:
       multiply by exp(-j * carrier), low-pass, take amplitude.
    This measures local fringe amplitude, which is high where fringes
    are present and low in the background / edges.

    Parameters
    ----------
    image : 2D grayscale float64 or uint8 image.

    Returns
    -------
    Modulation map as float64, same shape as input.  Values in [0, 1].
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    h, w = img.shape

    # Step 1: find carrier frequency
    py, px, _ = _find_carrier(img)
    # Convert peak position to spatial frequency (cycles/pixel)
    # In fftshift coords, center is (h//2, w//2)
    fy = (py - h // 2) / h  # cycles per pixel
    fx = (px - w // 2) / w

    # Step 2: complex demodulation — shift carrier to DC
    yy, xx = np.mgrid[0:h, 0:w]
    demod = img * np.exp(-2j * np.pi * (fy * yy + fx * xx))

    # Low-pass filter (envelope extraction)
    # Window size ~2x the true fringe period for good locality. Compute this
    # from cycles/pixel, not from the FFT distance in pixels; h/dist is only
    # correct for square images with a purely vertical carrier.
    fringe_freq = math.sqrt(fy ** 2 + fx ** 2)
    fringe_period = 1.0 / max(fringe_freq, 1e-10)
    from scipy.ndimage import uniform_filter
    ksize = max(5, int(fringe_period * 2)) | 1  # odd
    ksize = min(ksize, 61)  # cap for efficiency
    envelope = np.abs(uniform_filter(demod.real, size=ksize) +
                      1j * uniform_filter(demod.imag, size=ksize))

    # Normalize to [0, 1]
    emax = envelope.max()
    if emax > 0:
        envelope = envelope / emax
    return np.clip(envelope, 0.0, 1.0)


def create_fringe_mask(image: np.ndarray, modulation: np.ndarray,
                       threshold_frac: float = 0.15) -> np.ndarray:
    """Create a boolean mask combining brightness and modulation.

    For real interferograms the fringe region is the illuminated aperture.
    We use a two-stage approach:
    1. Brightness mask via Otsu thresholding (finds the lit area).
    2. Morphological cleanup: close small holes, erode edges slightly
       to avoid rim artifacts.
    3. Within the bright region, reject pixels where fringe modulation
       is below threshold_frac of the median modulation in that region.

    Parameters
    ----------
    image : 2D grayscale float64 image.
    modulation : float64 modulation map from compute_fringe_modulation.
    threshold_frac : modulation rejection threshold within the bright
        region, as fraction of the median modulation there.

    Returns
    -------
    Boolean mask: True = valid pixel with adequate fringe contrast.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)

    # Step 1: Otsu brightness threshold to find illuminated aperture
    img_u8 = np.clip(img / max(img.max(), 1) * 255, 0, 255).astype(np.uint8)
    _, bright_mask = cv2.threshold(img_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = bright_mask > 0

    # Step 2: morphological cleanup — close gaps, then erode edges
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    bright_closed = cv2.morphologyEx(bright.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
    # Erode by ~5px to pull away from the rim
    kernel_erode = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    bright_eroded = cv2.erode(bright_closed, kernel_erode)
    aperture = bright_eroded > 0

    # Step 3: within the aperture, reject low-modulation pixels
    if aperture.any() and modulation[aperture].size > 0:
        median_mod = float(np.median(modulation[aperture]))
        if median_mod > 0:
            mod_thresh = threshold_frac * median_mod
            mask = aperture & (modulation >= mod_thresh)
        else:
            mask = aperture
    else:
        mask = aperture

    return mask


from backend.vision.mask_utils import rasterize_polygon_mask  # noqa: F401


def extract_phase_dft(image: np.ndarray, mask: np.ndarray | None = None,
                      carrier_override: tuple[float, float] | None = None,
                      *,
                      lpf_sigma_frac: float | None = None,
                      dc_margin_override: int | None = None,
                      dc_cutoff_cycles: float | None = 1.5,
                      anisotropic_lpf: bool = True,
                      ) -> np.ndarray:
    """Extract wrapped phase via spatial-domain complex demodulation.

    Pipeline:
    1. Background subtraction (Gaussian blur) to enhance fringe contrast
    2. Detect carrier frequency via _find_carrier
    3. Multiply by conjugate carrier exp(-j*carrier) to shift fringes to DC
    4. Low-pass filter (Gaussian) to extract the envelope/phase
    5. Extract wrapped phase: atan2(Im, Re)

    This approach handles aperture boundaries naturally and works well
    on low-contrast real-world interferograms where FFT sideband isolation
    struggles with weak carrier peaks.

    Parameters
    ----------
    image : 2D grayscale image (float64 or uint8).
    mask : optional boolean mask (True = valid). Masked-out pixels are zeroed
           after background subtraction.

    Returns
    -------
    Wrapped phase map in [-pi, pi], same shape as input.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    h, w = img.shape

    # Step 1: background subtraction to enhance fringe contrast
    bg_sigma = max(50, h // 20)
    background = cv2.GaussianBlur(img, (0, 0), bg_sigma)
    enhanced = img - background
    if mask is not None:
        enhanced[~mask.astype(bool)] = 0

    # Step 2: find carrier frequency (use raw image, not background-subtracted,
    # so the peak selection is consistent with compute_fringe_modulation and
    # doesn't flip sign depending on subtle background subtraction differences)
    if carrier_override is not None:
        py, px = carrier_override
        dist = math.sqrt((py - h // 2) ** 2 + (px - w // 2) ** 2)
    else:
        py, px, dist = _find_carrier(img, dc_margin_override=dc_margin_override,
                                     dc_cutoff_cycles=dc_cutoff_cycles)
    fy = (py - h // 2) / h  # cycles per pixel
    fx = (px - w // 2) / w

    # Step 3: complex demodulation — shift carrier to DC
    yy, xx = np.mgrid[0:h, 0:w]
    carrier = np.exp(-2j * np.pi * (fy * yy + fx * xx))
    demod = enhanced * carrier

    # Step 4: low-pass filter (envelope extraction)
    # Image-space σ ~2.5x the fringe period smooths inter-fringe noise well
    # enough to prevent phase-unwrap artifacts (the "clouds with hard lines"
    # 2π-jump pattern). M2.5 ``lpf_sigma_frac`` overrides this scalar; ``None``
    # keeps the legacy 2.5× default.
    fringe_freq = math.sqrt(fy ** 2 + fx ** 2)
    fringe_period = 1.0 / max(fringe_freq, 1e-10)
    sigma_frac = 2.5 if lpf_sigma_frac is None else float(lpf_sigma_frac)
    lp_sigma = max(fringe_period * sigma_frac, 5.0)

    if anisotropic_lpf and fringe_freq > 1e-10:
        # M2.6: anisotropic Gaussian aligned with the fringe direction.
        # The low-pass is applied to the demodulated signal in image space.
        # The useful content sits at DC; leftover from demodulation
        # (−2·carrier term, harmonics) sits at multiples of the carrier
        # along the carrier direction.
        #
        # σ in image-space: smaller σ ⇒ less blur ⇒ wider frequency passband.
        # We want a tight frequency passband across fringes (to suppress the
        # −2·carrier lobe) and a loose passband along fringes (to preserve
        # along-fringe detail).
        #
        # Pragmatic sigmas (image space, in pixels):
        #   σ_along  = 0.71 · sigma_frac · fringe_period_px  (small image σ
        #              ⇒ wide frequency passband ⇒ "loose")
        #   σ_across = 1.41 · sigma_frac · fringe_period_px  (large image σ
        #              ⇒ narrow frequency passband ⇒ "tight")
        # The geometric mean equals the legacy isotropic σ (= sigma_frac ·
        # fringe_period), so the M2.5 scalar knob still controls overall
        # blur strength. We deviate from the spec's 4:1 anisotropy in favor
        # of a 2:1 ratio: the spec-literal ratio kills surface detail wider
        # than ~1.5 fringe periods (e.g. broad bumps), which broke an
        # existing physical-units regression. 2:1 still suppresses the
        # cross-fringe harmonic lobe noticeably while preserving wide
        # surface features.
        sig_along_img = max(fringe_period * sigma_frac * 0.7071, 2.0)
        sig_across_img = max(fringe_period * sigma_frac * 1.4142, 5.0)
        # Convert image-space σ → frequency-space σ. For a normalized FFT grid
        # of cycles/pixel, the Fourier pair of a Gaussian with image σ_i has
        # frequency σ_f = 1 / (2π · σ_i).
        sig_along_f = 1.0 / (2.0 * math.pi * sig_along_img)
        sig_across_f = 1.0 / (2.0 * math.pi * sig_across_img)

        # Carrier direction in cycles/pixel. `_find_carrier` uses atan2(fy, fx)
        # throughout the rest of the pipeline — match it here so rotation-sign
        # stays consistent with the frame note in CLAUDE.md.
        theta = math.atan2(fy, fx)
        ct, st = math.cos(theta), math.sin(theta)

        # Build fftshift-centered frequency grids in cycles/pixel (matches the
        # coordinate system used to express fy, fx above).
        fy_axis = (np.arange(h) - (h // 2)) / h
        fx_axis = (np.arange(w) - (w // 2)) / w
        fy_grid, fx_grid = np.meshgrid(fy_axis, fx_axis, indexing='ij')

        # Rotate so u' is along the carrier (across fringes) and v' is
        # perpendicular (along fringes).
        u_across = ct * fx_grid + st * fy_grid
        v_along = -st * fx_grid + ct * fy_grid

        lpf_shifted = np.exp(
            -0.5 * (u_across / sig_across_f) ** 2
            - 0.5 * (v_along / sig_along_f) ** 2
        )
        lpf = np.fft.ifftshift(lpf_shifted)

        D = np.fft.fft2(demod)
        demod_lp = np.fft.ifft2(D * lpf)
    else:
        demod_lp = (cv2.GaussianBlur(demod.real, (0, 0), lp_sigma) +
                    1j * cv2.GaussianBlur(demod.imag, (0, 0), lp_sigma))

    # Step 5: extract wrapped phase
    # Note: np.angle() is amplitude-insensitive (phase of z doesn't depend
    # on |z|), so envelope normalization is unnecessary here. Illumination
    # gradients affect the input amplitude before demodulation but cannot
    # be corrected by post-hoc envelope division.
    wrapped = np.angle(demod_lp)
    return wrapped.astype(np.float64)


def _quality_guided_unwrap(wrapped: np.ndarray, quality: np.ndarray,
                           mask: np.ndarray | None = None) -> np.ndarray:
    """Quality-guided 2D phase unwrapping (Goldstein/Zebker approach).

    Unwraps from highest-quality pixels outward using a max-heap, so errors
    in weak-fringe regions don't propagate into the solution.

    Parameters
    ----------
    wrapped : 2D float64 wrapped phase in [-pi, pi].
    quality : 2D float64 quality map (higher = more reliable). Typically
              the fringe modulation map.
    mask : optional boolean mask (True = valid).

    Returns
    -------
    Unwrapped phase, float64. Masked pixels are set to 0.
    """
    import heapq

    h, w = wrapped.shape
    if mask is None:
        mask = np.ones((h, w), dtype=bool)
    valid = mask.astype(bool)

    unwrapped = np.zeros((h, w), dtype=np.float64)
    visited = np.zeros((h, w), dtype=bool)

    if not valid.any():
        return unwrapped

    # Seed: highest-quality valid pixel
    q_masked = quality.copy()
    q_masked[~valid] = -1
    seed = np.unravel_index(np.argmax(q_masked), q_masked.shape)
    unwrapped[seed] = wrapped[seed]
    visited[seed] = True

    # Heap-based flood fill from seed outward, prioritized by edge quality.
    # Each heap entry: (-quality, neighbor_y, neighbor_x, source_y, source_x)
    # Negative quality because heapq is a min-heap.
    heap: list[tuple[float, int, int, int, int]] = []
    TWO_PI = 2.0 * np.pi
    sy, sx = int(seed[0]), int(seed[1])
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        ny, nx = sy + dy, sx + dx
        if 0 <= ny < h and 0 <= nx < w and valid[ny, nx]:
            eq = min(quality[sy, sx], quality[ny, nx])
            heapq.heappush(heap, (-eq, ny, nx, sy, sx))

    while heap:
        neg_q, ny, nx, fy, fx = heapq.heappop(heap)
        if visited[ny, nx]:
            continue
        # Unwrap relative to the already-visited source pixel
        diff = wrapped[ny, nx] - wrapped[fy, fx]
        unwrapped[ny, nx] = unwrapped[fy, fx] + diff - TWO_PI * round(diff / TWO_PI)
        visited[ny, nx] = True
        # Push unvisited valid neighbors
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            my, mx = ny + dy, nx + dx
            if 0 <= my < h and 0 <= mx < w and valid[my, mx] and not visited[my, mx]:
                eq = min(quality[ny, nx], quality[my, mx])
                heapq.heappush(heap, (-eq, my, mx, ny, nx))

    unwrapped[~valid] = 0.0
    return unwrapped


def _phase_consistency(wrapped: np.ndarray) -> np.ndarray:
    """M2.3: local phase-gradient consistency in [0, 1].

    Computes the wrapped-phase gradient at every pixel, then measures the
    variance of the gradient components in a 3×3 neighborhood. Low variance
    (smooth phase locally) → high consistency (near 1). High variance
    (discontinuities) → low consistency (near 0).

    The raw wrapped-phase gradient has ±2π jumps at 2π-wrap boundaries, which
    this function absorbs by re-wrapping each difference into [-π, π] before
    measuring variance.
    """
    # Wrap-aware differences so 2π cliffs don't masquerade as discontinuity.
    dy = np.angle(np.exp(1j * np.diff(wrapped, axis=0, prepend=wrapped[:1])))
    dx = np.angle(np.exp(1j * np.diff(wrapped, axis=1, prepend=wrapped[:, :1])))
    # Local mean & squared mean → variance in a 3×3 window.
    kernel = (1.0 / 9.0) * np.ones((3, 3), dtype=np.float64)
    dy2 = dy * dy
    dx2 = dx * dx
    m_dy = cv2.filter2D(dy, -1, kernel, borderType=cv2.BORDER_REFLECT)
    m_dx = cv2.filter2D(dx, -1, kernel, borderType=cv2.BORDER_REFLECT)
    m_dy2 = cv2.filter2D(dy2, -1, kernel, borderType=cv2.BORDER_REFLECT)
    m_dx2 = cv2.filter2D(dx2, -1, kernel, borderType=cv2.BORDER_REFLECT)
    var = (m_dy2 - m_dy * m_dy) + (m_dx2 - m_dx * m_dx)
    var = np.clip(var, 0.0, None)
    # Map variance → consistency in [0, 1]. `exp(-var)` gives 1 when var=0
    # (perfectly smooth) and decays monotonically. Wrapped-phase gradients
    # sit in [-π, π] so the 3×3 variance never exceeds 2π² ≈ 20; `exp(-var)`
    # naturally falls into [exp(-20), 1] ⊂ [0, 1].
    return np.exp(-var)


def unwrap_phase_2d(wrapped: np.ndarray, mask: np.ndarray | None = None,
                    quality: np.ndarray | None = None,
                    fringe_period_px: float | None = None,
                    correct_2pi_jumps: bool = True,
                    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """2D spatial phase unwrapping using skimage's algorithm.

    Uses scikit-image's unwrap_phase which implements a proper 2D
    unwrapping algorithm that handles complex wrap topologies
    (closed-contour isophase lines) that simple row/column unwrapping
    cannot.

    When a quality map is provided, uses a quality-guided Goldstein/Zebker
    approach that propagates from high-confidence pixels first, preventing
    error propagation from weak-fringe regions.

    Parameters
    ----------
    wrapped : 2D float64 array of wrapped phase in [-pi, pi].
    mask : optional boolean mask (True = valid).
    quality : optional 2D float64 quality map (higher = more reliable).
              When provided, uses quality-guided unwrapping instead of
              skimage's raster-order algorithm.
    fringe_period_px : optional fringe period in pixels. When provided
              together with a mask, marks pixels near mask edges (within
              one fringe period) as edge-contamination in the risk mask.
    correct_2pi_jumps : when True (default), apply a 9x9 median-filter
              based correction that snaps pixels deviating by ~2π from
              their local median back onto the surface. This fixes
              "clouds with hard lines" unwrap glitches but will silently
              destroy real physical steps of magnitude ≥ λ/4 (~158 nm
              at 632.8 nm), rounding them to the nearest 2π. Set to
              False for step measurements (e.g., gage-block validation).

    Returns
    -------
    tuple of (unwrapped, risk_mask, quality_map):
        unwrapped : float64 array — unwrapped phase map.
        risk_mask : uint8 array — 0 = clean, 1 = 2π-jump corrected,
                    2 = edge contamination zone.
        quality_map : float64 array in [0, 1] — hybrid quality metric used
                    for seed selection (M2.3). When `quality` is not
                    provided, returns the phase-consistency map alone (so
                    callers can still visualize where unwrapping was
                    likely reliable). When `quality` IS provided,
                    returns ``quality * phase_consistency(wrapped)``.
    """
    from scipy.ndimage import median_filter

    phase = wrapped.copy()

    # M2.3: hybrid quality = modulation × phase-consistency. This biases the
    # quality-guided unwrap to seed from well-modulated AND phase-smooth
    # pixels, reducing seed picks on edges / discontinuities.
    phase_consistency = _phase_consistency(phase)
    if quality is not None:
        q = np.asarray(quality, dtype=np.float64)
        q_norm = q / max(float(q.max()), 1e-10)
        quality_map = np.clip(q_norm, 0.0, 1.0) * phase_consistency
    else:
        quality_map = phase_consistency

    if quality is not None:
        unwrapped = _quality_guided_unwrap(phase, quality_map, mask)
    else:
        from skimage.restoration import unwrap_phase

        if mask is not None:
            valid = mask.astype(bool)
            if valid.any():
                phase_ma = np.ma.array(phase, mask=~valid)
                unwrapped_ma = unwrap_phase(phase_ma)
                if np.ma.isMaskedArray(unwrapped_ma):
                    unwrapped = np.asarray(unwrapped_ma.filled(0.0), dtype=np.float64)
                else:
                    unwrapped = np.asarray(unwrapped_ma, dtype=np.float64)
            else:
                return (np.zeros_like(phase, dtype=np.float64),
                        np.zeros(wrapped.shape, dtype=np.uint8),
                        np.zeros(wrapped.shape, dtype=np.float64))
        else:
            unwrapped = unwrap_phase(phase).astype(np.float64)

    # Risk mask: track which pixels needed correction or are suspect.
    risk_mask = np.zeros(wrapped.shape, dtype=np.uint8)

    # Post-unwrapping correction: detect pixels that differ from their local
    # median by ~2π (unwrapping jump errors) and snap them back.  This fixes
    # the "clouds with hard lines" artifact on noisy interferograms — but
    # silently destroys real physical steps ≥ λ/4. Skip when the caller is
    # measuring a true stepped surface (e.g., gage-block validation).
    if correct_2pi_jumps:
        med = median_filter(unwrapped, size=9)
        jump_diff = unwrapped - med
        jump_pixels = np.abs(jump_diff) > np.pi
        unwrapped -= 2.0 * np.pi * np.round(jump_diff / (2.0 * np.pi))
        risk_mask[jump_pixels] = 1

    # Edge contamination detection: pixels near mask boundary within one
    # fringe period are suspect because they mix valid/invalid data.
    if fringe_period_px and fringe_period_px > 1 and mask is not None:
        kernel_size = max(3, int(fringe_period_px))
        kernel = np.ones((kernel_size, kernel_size), dtype=np.uint8)
        eroded = cv2.erode(mask.astype(np.uint8), kernel)
        edge_zone = mask.astype(bool) & ~eroded.astype(bool)
        risk_mask[edge_zone & (risk_mask == 0)] = 2

    if mask is not None:
        valid = mask.astype(bool)
        unwrapped[~valid] = 0.0

    return unwrapped, risk_mask, quality_map


def focus_quality(image: np.ndarray) -> float:
    """Compute a focus quality score (0-100) for fringe images.

    Uses fringe modulation (local contrast) as the primary signal because
    fringe images are smooth sinusoidal patterns that can have low Laplacian
    variance even in perfect focus. High modulation means well-resolved,
    high-contrast fringes.

    For setup/preview images that do not contain a meaningful fringe carrier,
    a Laplacian edge-sharpness fallback can lift the score. The returned value
    is therefore a practical live focus score, not a pure fringe-quality score.

    Parameters
    ----------
    image : grayscale or BGR image.

    Returns
    -------
    Score from 0 (no visible fringes) to 100 (excellent fringe contrast).
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    mod = compute_fringe_modulation(img)
    # Use the central 50% to avoid edge artifacts
    h, w = mod.shape
    y0, y1 = h // 4, 3 * h // 4
    x0, x1 = w // 4, 3 * w // 4
    central = mod[y0:y1, x0:x1]
    median_mod = float(np.median(central))
    # Sigmoid mapping: modulation of ~0.15 → score ~50, ~0.4 → ~95
    k = 15.0
    mid = 0.15
    modulation_score = 100.0 / (1.0 + math.exp(-k * (median_mod - mid)))

    # Fallback for non-fringe focus checks and setup images: a sharp edge can
    # be well-focused even when the carrier-aware modulation estimate is not
    # meaningful. Keep fringe modulation as the primary signal, but let a strong
    # Laplacian focus response lift the score for ordinary preview content.
    img_u8 = np.clip(img / max(img.max(), 1) * 255, 0, 255).astype(np.uint8)
    lap_var = float(cv2.Laplacian(img_u8, cv2.CV_64F).var())
    edge_score = 100.0 * (1.0 - math.exp(-lap_var / 1000.0))
    score = max(modulation_score, edge_score)
    return round(score, 1)


# ── Surface analysis, rendering, full pipeline ──────────────────────────


def phase_to_height(phase: np.ndarray, wavelength_nm: float) -> np.ndarray:
    """Convert phase (radians) to physical height (nanometers).

    For a double-pass interferometer (reflection):
      height = phase * lambda / (4 * pi)

    Parameters
    ----------
    phase : unwrapped phase in radians.
    wavelength_nm : light source wavelength in nanometers.

    Returns
    -------
    Height map in nanometers.
    """
    return phase * wavelength_nm / (4.0 * np.pi)


def surface_stats(surface: np.ndarray, mask: np.ndarray | None = None
                  ) -> dict:
    """Compute PV (peak-to-valley) and RMS of a surface.

    Parameters
    ----------
    surface : 2D height or phase array.
    mask : boolean mask (True = valid).

    Returns
    -------
    {"pv": float, "rms": float, "mean": float} in the same units as input.
    """
    s = np.asarray(surface, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        s = s[valid]
        if s.size == 0:
            return {"pv": 0.0, "rms": 0.0, "mean": 0.0}
    mean = float(s.mean())
    pv = float(s.max() - s.min())
    rms = float(np.sqrt(np.mean((s - mean) ** 2)))
    return {"pv": pv, "rms": rms, "mean": mean}


def render_surface_map(surface: np.ndarray, mask: np.ndarray | None = None
                       ) -> str:
    """Render a false-color surface map with contour lines as a PNG, base64-encoded.

    Uses the RdBu_r (red-blue reversed) colormap: red = high, blue = low.
    Masked-out pixels are rendered as black.  Semi-transparent contour lines
    are overlaid to show iso-height curves.

    Returns base64 string (no 'data:' prefix).
    """
    from matplotlib.figure import Figure
    from matplotlib.backends.backend_agg import FigureCanvasAgg

    s = np.asarray(surface, dtype=np.float64).copy()
    if mask is not None:
        valid = mask.astype(bool)
        s[~valid] = np.nan
        if valid.any():
            smin = float(np.nanmin(s))
            smax = float(np.nanmax(s))
        else:
            smin, smax = 0.0, 0.0
    else:
        smin = float(s.min())
        smax = float(s.max())

    vmax = max(abs(smin), abs(smax)) if smax > smin else 1.0

    h, w = s.shape
    dpi = 100
    fig = Figure(figsize=(w / dpi, h / dpi), dpi=dpi, facecolor='black')
    canvas = FigureCanvasAgg(fig)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()

    # Colormap background.
    # NOTE: interpolation='nearest' is load-bearing for polygon masks. With
    # bilinear interpolation, matplotlib's resampling blends finite values
    # into NaN cells, leaking surface color outside the user-drawn polygon
    # (Task 0 regression). Nearest-neighbor preserves the mask boundary.
    ax.imshow(s, cmap='RdBu_r', vmin=-vmax, vmax=vmax,
              interpolation='nearest', aspect='equal')

    # Contour lines
    if smax > smin:
        n_levels = min(12, max(4, int((smax - smin) / (vmax * 0.1))))
        levels = np.linspace(smin, smax, n_levels + 2)[1:-1]
        ax.contour(s, levels=levels, colors='black', linewidths=0.6, alpha=0.4)

    canvas.draw()
    buf = io.BytesIO()
    fig.savefig(buf, format='png', facecolor='black', dpi=dpi, pad_inches=0)
    _get_plt().close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode('ascii')


def render_profile(surface: np.ndarray, mask: np.ndarray | None = None,
                   axis: str = "x") -> dict:
    """Extract a cross-section profile through the center of the surface.

    Parameters
    ----------
    surface : 2D array.
    mask : boolean mask.
    axis : "x" for horizontal profile (row at center), "y" for vertical.

    Returns
    -------
    JSON-serializable dict with keys:
      "positions": list of pixel positions along the axis
      "values": list of height/phase values (None for masked pixels)
      "axis": "x" or "y"
    """
    h, w = surface.shape
    if axis == "x":
        row = h // 2
        profile = surface[row, :]
        mask_row = mask[row, :] if mask is not None else np.ones(w, dtype=bool)
        positions = list(range(w))
    else:
        col = w // 2
        profile = surface[:, col]
        mask_row = mask[:, col] if mask is not None else np.ones(h, dtype=bool)
        positions = list(range(h))

    values = []
    for val, m in zip(profile, mask_row):
        values.append(float(val) if m else None)

    return {"positions": positions, "values": values, "axis": axis}


def render_zernike_chart(coefficients: list[float],
                         subtracted_terms: list[int],
                         wavelength_nm: float) -> str:
    """Render a bar chart of Zernike coefficients as a PNG, base64-encoded.

    Bars are colored: blue for included terms, gray for subtracted terms.
    Values are shown in both waves (lambda) and nm.

    Returns base64 string (no 'data:' prefix).
    """
    n_terms = len(coefficients)
    indices = list(range(1, n_terms + 1))

    # Convert coefficients to waves (1 wave = 2*pi radians)
    coeff_waves = [c / (2 * np.pi) for c in coefficients]

    colors = []
    for j in indices:
        if j in subtracted_terms:
            colors.append("#666666")  # gray for subtracted
        else:
            colors.append("#4a9eff")  # blue for active

    _plt = _get_plt()
    fig, ax = _plt.subplots(figsize=(10, 3.5), dpi=100)
    fig.patch.set_facecolor("#1c1c1e")
    ax.set_facecolor("#1c1c1e")

    ax.bar(indices, coeff_waves, color=colors, edgecolor="none", width=0.7)
    ax.set_xlabel("Zernike term (Noll index)", color="#e8e8e8", fontsize=9)
    ax.set_ylabel("Coefficient (waves)", color="#e8e8e8", fontsize=9)
    ax.set_title("Zernike Coefficients", color="#e8e8e8", fontsize=11)
    ax.tick_params(colors="#ababab", labelsize=8)
    ax.spines["bottom"].set_color("#3a3a3c")
    ax.spines["left"].set_color("#3a3a3c")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.axhline(y=0, color="#3a3a3c", linewidth=0.5)

    # Add term names as x-tick labels when there are 15 or fewer terms
    if n_terms <= 15:
        labels = [ZERNIKE_NAMES.get(j, str(j)) for j in indices]
        ax.set_xticks(indices)
        ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    else:
        ax.set_xticks(indices[::3])

    _plt.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor(), edgecolor="none")
    _plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("ascii")


def render_fft_image(image: np.ndarray, peak_y: int, peak_x: int,
                    size: int = 256) -> str:
    """Render the FFT magnitude as a log-scaled PNG with carrier peak marked.

    Parameters
    ----------
    image : 2D grayscale image (the original interferogram).
    peak_y, peak_x : detected carrier peak in fftshift coordinates.
    size : output image size (square).

    Returns
    -------
    Base64-encoded PNG string.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)

    # Compute FFT
    img_windowed = (img - img.mean()) * np.outer(np.hanning(img.shape[0]),
                                                  np.hanning(img.shape[1]))
    F = np.fft.fftshift(np.fft.fft2(img_windowed))
    magnitude = np.abs(F)

    # Log scale
    log_mag = np.log1p(magnitude)
    log_mag = log_mag / max(log_mag.max(), 1e-10)

    # Resize to output size
    display = cv2.resize(log_mag, (size, size), interpolation=cv2.INTER_AREA)

    # Convert to color
    display_u8 = np.clip(display * 255, 0, 255).astype(np.uint8)
    colored = cv2.applyColorMap(display_u8, cv2.COLORMAP_INFERNO)

    # Mark peak position (scale to display coords)
    h, w = img.shape
    px_disp = int(peak_x / w * size)
    py_disp = int(peak_y / h * size)
    cv2.drawMarker(colored, (px_disp, py_disp), (0, 255, 0),
                   cv2.MARKER_CROSS, 15, 2)
    # Also mark the conjugate (-1 order)
    cx, cy = size // 2, size // 2
    conj_x = 2 * cx - px_disp
    conj_y = 2 * cy - py_disp
    cv2.drawMarker(colored, (conj_x, conj_y), (0, 180, 0),
                   cv2.MARKER_CROSS, 10, 1)

    _, buf = cv2.imencode(".png", colored)
    return base64.b64encode(buf.tobytes()).decode("ascii")


def render_modulation_map(modulation: np.ndarray,
                          mask: np.ndarray | None = None) -> str:
    """Render the fringe modulation map as a false-color PNG.

    Green = high modulation (reliable phase), red = low modulation.
    Masked pixels shown as dark gray.

    Parameters
    ----------
    modulation : 2D float64 modulation map in [0, 1].
    mask : optional boolean mask (True = valid).

    Returns
    -------
    Base64-encoded PNG string.
    """
    h, w = modulation.shape
    rgb = np.zeros((h, w, 3), dtype=np.uint8)

    mod_clipped = np.clip(modulation, 0, 1)
    # BGR format for OpenCV: index 0=B, 1=G, 2=R
    rgb[:, :, 2] = np.clip((1.0 - mod_clipped) * 255, 0, 255).astype(np.uint8)  # Red channel
    rgb[:, :, 1] = np.clip(mod_clipped * 255, 0, 255).astype(np.uint8)           # Green channel
    rgb[:, :, 0] = 30  # slight blue for visibility

    if mask is not None:
        rgb[~mask.astype(bool)] = [40, 40, 40]  # dark gray for masked

    # Resize if very large
    max_dim = 512
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        new_h, new_w = max(1, int(h * scale)), max(1, int(w * scale))
        rgb = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_AREA)

    _, buf = cv2.imencode(".png", rgb)
    return base64.b64encode(buf.tobytes()).decode("ascii")


def render_confidence_maps(modulation: np.ndarray, risk_mask: np.ndarray,
                           mask: np.ndarray,
                           quality_map: np.ndarray | None = None) -> dict:
    """Render confidence maps as base64 PNGs.
    Returns dict with 'unwrap_risk', 'composite', and (M2.3) 'quality' keys.
    """
    h, w = modulation.shape

    # Unwrap risk map: red=corrected, orange=edge contamination
    risk_rgb = np.zeros((h, w, 3), dtype=np.uint8)
    risk_rgb[risk_mask == 1] = [0, 0, 255]   # Red (BGR)
    risk_rgb[risk_mask == 2] = [0, 128, 255]  # Orange (BGR)
    if mask is not None:
        risk_rgb[~mask.astype(bool)] = [40, 40, 40]

    # Confidence composite: green=good, yellow=fair, red=poor
    valid = mask.astype(bool) if mask is not None else np.ones((h, w), dtype=bool)
    median_mod = float(np.median(modulation[valid])) if valid.any() else 0.01
    mod_norm = np.clip(modulation / max(median_mod, 0.01), 0, 1)
    risk_factor = np.ones((h, w), dtype=np.float32)
    risk_factor[risk_mask == 1] = 0.0
    risk_factor[risk_mask == 2] = 0.3
    quality = mod_norm * risk_factor

    composite_rgb = np.zeros((h, w, 3), dtype=np.uint8)
    composite_rgb[:, :, 1] = np.clip(quality * 255, 0, 255).astype(np.uint8)  # Green channel
    composite_rgb[:, :, 2] = np.clip((1.0 - quality) * 255, 0, 255).astype(np.uint8)  # Red channel
    composite_rgb[:, :, 0] = 30  # Slight blue
    if mask is not None:
        composite_rgb[~valid] = [40, 40, 40]

    # Resize if large
    max_dim = 512
    def _resize(img):
        if max(img.shape[:2]) > max_dim:
            scale = max_dim / max(img.shape[:2])
            new_h, new_w = max(1, int(img.shape[0] * scale)), max(1, int(img.shape[1] * scale))
            return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        return img

    _, risk_buf = cv2.imencode(".png", _resize(risk_rgb))
    _, comp_buf = cv2.imencode(".png", _resize(composite_rgb))

    out = {
        "unwrap_risk": base64.b64encode(risk_buf.tobytes()).decode("ascii"),
        "composite": base64.b64encode(comp_buf.tobytes()).decode("ascii"),
    }
    # M2.3: optional hybrid quality map overlay (used for seed selection in
    # the quality-guided unwrap). Same BGR convention as the composite
    # above; brighter green = more reliable phase gradient.
    if quality_map is not None:
        qm = np.clip(np.asarray(quality_map, dtype=np.float32), 0.0, 1.0)
        q_rgb = np.zeros((h, w, 3), dtype=np.uint8)
        q_rgb[:, :, 1] = (qm * 255).astype(np.uint8)
        q_rgb[:, :, 2] = ((1.0 - qm) * 255).astype(np.uint8)
        q_rgb[:, :, 0] = 30
        if mask is not None:
            q_rgb[~valid] = [40, 40, 40]
        _, q_buf = cv2.imencode(".png", _resize(q_rgb))
        out["quality"] = base64.b64encode(q_buf.tobytes()).decode("ascii")
    return out


def render_psf(surface_waves: np.ndarray, mask: np.ndarray | None = None) -> str:
    """Compute and render the PSF from a wavefront error map.

    Parameters
    ----------
    surface_waves : 2D wavefront error in waves (not nm).
    mask : boolean mask (True = valid). Defines the pupil.

    Returns
    -------
    Base64-encoded PNG image of the PSF (log scale, inferno colormap).
    """
    h, w = surface_waves.shape
    # Build pupil: circular mask x complex phase
    if mask is not None:
        pupil = mask.astype(np.float64)
    else:
        pupil = np.ones((h, w), dtype=np.float64)

    # Zero-pad to at least 512x512 for decent PSF resolution
    pad = max(512, h, w)
    padded = np.zeros((pad, pad), dtype=np.complex128)
    y0 = (pad - h) // 2
    x0 = (pad - w) // 2
    phase = 2.0 * np.pi * surface_waves
    padded[y0:y0+h, x0:x0+w] = pupil * np.exp(1j * phase)

    # PSF = |FFT(pupil)|^2
    psf = np.abs(np.fft.fftshift(np.fft.fft2(padded))) ** 2
    psf /= max(psf.max(), 1e-30)  # normalize to [0, 1]

    # Log scale for display (dynamic range ~4 decades)
    psf_log = np.log10(psf + 1e-6)
    psf_log = np.clip((psf_log + 6) / 6, 0, 1)  # map [-6, 0] to [0, 1]

    # Crop to center (show ~1/4 of the padded field)
    crop = pad // 4
    cy, cx = pad // 2, pad // 2
    psf_crop = psf_log[cy-crop:cy+crop, cx-crop:cx+crop]

    # Render with inferno colormap
    gray = (psf_crop * 255).astype(np.uint8)
    cmap = _get_plt().cm.inferno
    lut = (cmap(np.linspace(0, 1, 256))[:, :3] * 255).astype(np.uint8)
    colored = lut[gray]
    colored_bgr = colored[:, :, ::-1].copy()

    ok, buf = cv2.imencode(".png", colored_bgr)
    if not ok:
        raise RuntimeError("PSF encoding failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def render_mtf(surface_waves: np.ndarray, mask: np.ndarray | None = None) -> dict:
    """Compute the MTF from a wavefront error map.

    Returns a dict with 'freq' (normalized, 0-1) and 'mtf' (contrast, 0-1)
    arrays, plus 'mtf_diff' for the diffraction-limited MTF.
    """
    h, w = surface_waves.shape
    if mask is not None:
        pupil = mask.astype(np.float64)
    else:
        pupil = np.ones((h, w), dtype=np.float64)

    pad = max(512, h, w)

    # Aberrated PSF
    padded = np.zeros((pad, pad), dtype=np.complex128)
    y0 = (pad - h) // 2
    x0 = (pad - w) // 2
    phase = 2.0 * np.pi * surface_waves
    padded[y0:y0+h, x0:x0+w] = pupil * np.exp(1j * phase)
    psf = np.abs(np.fft.fftshift(np.fft.fft2(padded))) ** 2

    # Diffraction-limited PSF (no aberrations)
    padded_diff = np.zeros((pad, pad), dtype=np.complex128)
    padded_diff[y0:y0+h, x0:x0+w] = pupil
    psf_diff = np.abs(np.fft.fftshift(np.fft.fft2(padded_diff))) ** 2

    # MTF = |FFT(PSF)| (OTF modulus)
    otf = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(psf)))
    otf_diff = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(psf_diff)))
    mtf_2d = np.abs(otf)
    mtf_diff_2d = np.abs(otf_diff)

    # Normalize
    mtf_2d /= max(mtf_2d.max(), 1e-30)
    mtf_diff_2d /= max(mtf_diff_2d.max(), 1e-30)

    # Radial average
    cy, cx = pad // 2, pad // 2
    y, x = np.ogrid[:pad, :pad]
    r = np.sqrt((x - cx)**2 + (y - cy)**2).astype(int)
    max_r = pad // 2

    mtf_radial = np.zeros(max_r)
    mtf_diff_radial = np.zeros(max_r)

    for ri in range(max_r):
        ring = r == ri
        if ring.any():
            mtf_radial[ri] = mtf_2d[ring].mean()
            mtf_diff_radial[ri] = mtf_diff_2d[ring].mean()

    # Trim to where diffraction limit drops to ~0
    cutoff = max_r
    for i in range(max_r - 1, 0, -1):
        if mtf_diff_radial[i] > 0.01:
            cutoff = min(i + 10, max_r)
            break

    freq = np.linspace(0, 1, cutoff)
    return {
        "freq": [round(float(f), 4) for f in freq],
        "mtf": [round(float(v), 4) for v in mtf_radial[:cutoff] / max(mtf_radial[0], 1e-30)],
        "mtf_diff": [round(float(v), 4) for v in mtf_diff_radial[:cutoff] / max(mtf_diff_radial[0], 1e-30)],
    }


WAVEFRONT_ORIGINS = ("capture", "average", "subtracted", "reconstruction")


def wrap_wavefront_result(
    result: dict,
    *,
    origin: str = "capture",
    calibration: dict | None = None,
    source_ids: list[str] | None = None,
    aperture_recipe: dict | None = None,
    captured_at: str | None = None,
) -> dict:
    """Attach WavefrontResult envelope fields to an analyze_interferogram dict.

    Mutates `result` in place and returns it. Stage-1 migration: adds
    envelope fields alongside the existing analyze keys without removing
    anything. `raw_height_grid_nm` / `raw_mask_grid` alias the existing
    `height_grid` / `mask_grid` by reference until M1.3 separates raw from
    display-space grids.

    Parameters
    ----------
    result: dict returned by `analyze_interferogram`.
    origin: provenance tag from `WAVEFRONT_ORIGINS`.
    calibration: snapshot of the calibration state used for this result
        (dict from the request, forwarded verbatim). None if uncalibrated.
    source_ids: contributing WavefrontResult ids (empty for `capture`;
        populated for `average` and `subtracted`).
    aperture_recipe: optional geometry recipe used to build the analysis
        mask (M1.4 formalizes the shape; accepts any dict for now).
    captured_at: ISO-8601 UTC timestamp. Defaults to "now".
    """
    if origin not in WAVEFRONT_ORIGINS:
        raise ValueError(f"origin must be one of {WAVEFRONT_ORIGINS}, got {origin!r}")

    result["id"] = uuid.uuid4().hex
    result["origin"] = origin
    result["source_ids"] = list(source_ids) if source_ids else []
    result["captured_at"] = captured_at or datetime.now(timezone.utc).isoformat()
    result["calibration_snapshot"] = calibration
    result.setdefault("warnings", [])
    result["aperture_recipe"] = aperture_recipe

    # M1.3: analyze_interferogram now populates raw_height_grid_nm with a
    # real pre-form-removal grid. Only fall back to the stage-1 alias when
    # the caller (e.g. a unit test handing us a minimal dict) hasn't
    # populated it yet. raw_mask_grid still aliases mask_grid — masks are
    # frame-shared.
    if "raw_height_grid_nm" not in result and "height_grid" in result:
        result["raw_height_grid_nm"] = result["height_grid"]
    if "raw_mask_grid" not in result and "mask_grid" in result:
        result["raw_mask_grid"] = result["mask_grid"]

    return result


def analyze_interferogram(image: np.ndarray, wavelength_nm: float = 632.8,
                          mask_threshold: float = 0.15,
                          subtract_terms: list[int] | None = None,
                          n_zernike: int = 36,
                          use_full_mask: bool = False,
                          custom_mask: np.ndarray | None = None,
                          carrier_override: tuple[float, float] | None = None,
                          on_progress: Callable[[str, float, str], None] | None = None,
                          form_model: str = "zernike",
                          lens_k1: float = 0.0,
                          correct_2pi_jumps: bool = True,
                          lpf_sigma_frac: float | None = None,
                          dc_margin_override: int | None = None,
                          dc_cutoff_cycles: float | None = 1.5) -> dict:
    """Full analysis pipeline: single image in, all results out.

    Parameters
    ----------
    image : grayscale or BGR interferogram.
    wavelength_nm : light source wavelength.
    mask_threshold : modulation threshold for auto-masking (0-1).
    subtract_terms : Noll indices to subtract (default: [1, 2, 3] = piston + tilt).
    n_zernike : number of Zernike terms to fit.
    use_full_mask : when True, skip auto-masking and treat every pixel as
        valid.  Use this when the caller already cropped to an ROI — Otsu
        thresholding inside a user-selected region often picks up rim
        artifacts that the user explicitly wanted to exclude.
    custom_mask : optional boolean mask to use instead of auto-masking.
        When provided, overrides both use_full_mask and the auto-masking
        logic.  Intended for polygon-based ROI selection from the UI.
    on_progress : optional callback ``(stage, progress, message)`` called at
        each pipeline stage; ``progress`` is in [0, 1].
    correct_2pi_jumps : forwarded to ``unwrap_phase_2d``. Default True
        preserves the legacy median-filter cleanup. Set False when the
        sample has true physical steps (≥ λ/4) that the cleanup would
        round away — e.g., gage-block validation.

    Returns
    -------
    Dict with keys: surface_map, zernike_chart, profile_x, profile_y,
    coefficients, pv_nm, rms_nm, pv_waves, rms_waves, modulation_stats,
    focus_score, subtracted_terms, wavelength_nm, n_valid_pixels, n_total_pixels.

    Performance: at 1024x1024 this pipeline takes >2s. API callers must
    run this via run_in_executor() to avoid blocking the event loop.
    """
    if subtract_terms is None:
        subtract_terms = [1, 2, 3]  # Piston + Tilt X + Tilt Y

    def _progress(stage: str, progress: float, message: str) -> None:
        if on_progress is not None:
            on_progress(stage, progress, message)

    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)

    if lens_k1:
        img = undistort_frame(img, lens_k1)

    _progress("carrier", 0.0, "Detecting carrier...")
    # Step 1: Modulation & mask
    modulation = compute_fringe_modulation(img)
    if custom_mask is not None:
        # Intersect the user-drawn region with modulation filtering so
        # non-fringe pixels inside the polygon don't drag down coverage.
        user_region = custom_mask.astype(bool)
        auto_mask = create_fringe_mask(img, modulation, threshold_frac=mask_threshold)
        mask = user_region & auto_mask
        # Fall back to the raw polygon if intersection is too aggressive
        # (e.g. threshold_frac too high for this image)
        if mask.sum() < 0.05 * user_region.sum():
            mask = user_region
    elif use_full_mask:
        mask = np.ones(img.shape, dtype=bool)
    else:
        mask = create_fringe_mask(img, modulation, threshold_frac=mask_threshold)
    n_valid = int(mask.sum())
    n_total = int(mask.size)

    # Step 2: DFT phase extraction
    wrapped = extract_phase_dft(img, mask, carrier_override=carrier_override,
                                lpf_sigma_frac=lpf_sigma_frac,
                                dc_margin_override=dc_margin_override,
                                dc_cutoff_cycles=dc_cutoff_cycles)
    _progress("phase", 0.25, "Extracting phase...")

    # Step 2b: Carrier analysis (needed for fringe_period_px before unwrap)
    if carrier_override is not None:
        carrier_info = _analyze_carrier(img, mask)
        carrier_info["peak_y"] = carrier_override[0]
        carrier_info["peak_x"] = carrier_override[1]
        fy = (carrier_override[0] - img.shape[0] // 2) / max(img.shape[0], 1)
        fx = (carrier_override[1] - img.shape[1] // 2) / max(img.shape[1], 1)
        fringe_freq = math.sqrt(fx**2 + fy**2)
        carrier_info["fringe_period_px"] = 1.0 / fringe_freq if fringe_freq > 1e-10 else float("inf")
        carrier_info["fringe_angle_deg"] = (math.degrees(math.atan2(fy, fx)) + 90.0) % 180.0
        carrier_info["distance_px"] = math.sqrt((carrier_override[0] - img.shape[0] // 2)**2 +
                                                 (carrier_override[1] - img.shape[1] // 2)**2)
        carrier_info["fx_cpp"] = fx
        carrier_info["fy_cpp"] = fy
    else:
        carrier_info = _analyze_carrier(img, mask)

    # M1.5: build a nested diagnostics envelope alongside the existing flat
    # keys. Consumers that already read the flat layout (e.g. compute_confidence,
    # legacy UI) keep working; newer UI reads the `chosen`/`candidates`/
    # `confidence` sub-dicts. `override` signals a manual carrier pick.
    carrier_info["chosen"] = {
        "y": carrier_info["peak_y"],
        "x": carrier_info["peak_x"],
        "distance_px": carrier_info["distance_px"],
        "fringe_period_px": carrier_info["fringe_period_px"],
        "fringe_angle_deg": carrier_info["fringe_angle_deg"],
        "fx_cpp": carrier_info["fx_cpp"],
        "fy_cpp": carrier_info["fy_cpp"],
    }
    carrier_info["candidates"] = list(carrier_info.get("alternate_peaks", []))
    carrier_info["confidence"] = {
        "peak_ratio": carrier_info["peak_ratio"],
        "snr_db": carrier_info["snr_db"],
        "dc_margin_px": carrier_info["dc_margin_px"],
    }
    carrier_info["override"] = carrier_override is not None

    # Step 3: Phase unwrapping
    unwrapped, unwrap_risk, quality_map = unwrap_phase_2d(
        wrapped, mask, quality=modulation,
        fringe_period_px=carrier_info.get("fringe_period_px"),
        correct_2pi_jumps=correct_2pi_jumps)
    _progress("unwrap", 0.50, "Unwrapping phase...")

    # Confidence metrics (computed after unwrap, before form removal)
    confidence = compute_confidence(carrier_info, modulation, unwrap_risk, mask,
                                    threshold_frac=mask_threshold)

    # Unwrap statistics
    valid_mask = mask.astype(bool) if mask is not None else np.ones(unwrapped.shape, dtype=bool)
    n_corrected = int(np.sum(unwrap_risk[valid_mask] == 1))
    n_edge_risk = int(np.sum(unwrap_risk[valid_mask] == 2))
    unwrap_stats = {
        "n_corrected": n_corrected,
        "n_edge_risk": n_edge_risk,
        "n_reliable": n_valid - n_corrected - n_edge_risk,
    }

    # M1.6: trusted-area mask — subset of the analysis mask that is both
    # well-modulated (>= mask_threshold) AND unwrap-reliable (risk == 0).
    # Computed on the *full-frame* arrays before cropping so the fraction
    # reflects the full valid aperture. The grid serialization below uses
    # the cropped work_mask domain to match mask_grid's geometry.
    _valid_full = mask.astype(bool) if mask is not None else np.ones(unwrapped.shape, dtype=bool)
    trusted_mask_full = (
        _valid_full
        & (modulation >= mask_threshold)
        & (unwrap_risk == 0)
    )
    _n_valid_full = int(_valid_full.sum())
    _n_trusted_full = int(trusted_mask_full.sum())
    trusted_area_pct = round(100.0 * _n_trusted_full / max(_n_valid_full, 1), 1)
    unwrap_stats["trusted_area_pct"] = trusted_area_pct

    # Work in the cropped aperture domain for fitting, rendering, cached masks,
    # and reanalysis. Keeping these in one coordinate system prevents Zernike
    # coefficients fitted on full-frame coordinates from being reconstructed
    # later on a cropped mask with a different center/radius.
    work_unwrapped = unwrapped
    work_mask = mask
    work_modulation = modulation
    work_risk = unwrap_risk
    work_quality = quality_map
    if mask is not None and mask.any():
        rows_any = np.any(mask, axis=1)
        cols_any = np.any(mask, axis=0)
        r0 = int(np.argmax(rows_any))
        r1 = int(len(rows_any) - np.argmax(rows_any[::-1]))
        c0 = int(np.argmax(cols_any))
        c1 = int(len(cols_any) - np.argmax(cols_any[::-1]))
        pad_r = max(2, int(0.05 * (r1 - r0)))
        pad_c = max(2, int(0.05 * (c1 - c0)))
        r0 = max(0, r0 - pad_r)
        r1 = min(unwrapped.shape[0], r1 + pad_r)
        c0 = max(0, c0 - pad_c)
        c1 = min(unwrapped.shape[1], c1 + pad_c)
        work_unwrapped = unwrapped[r0:r1, c0:c1]
        work_mask = mask[r0:r1, c0:c1]
        work_modulation = modulation[r0:r1, c0:c1]
        work_risk = unwrap_risk[r0:r1, c0:c1]
        work_quality = quality_map[r0:r1, c0:c1]

    # Step 4: Zernike fitting
    coeffs, rho, theta = fit_zernike(work_unwrapped, n_terms=n_zernike, mask=work_mask)
    _progress("zernike", 0.70, "Fitting Zernike polynomials...")

    # M4.2: Per-term Zernike normalization weights + actual RMS contributions.
    # For each term j, `zernike_norm_weights[j-1]` is the RMS of Z_j(ρ, θ)
    # over the *current aperture*, i.e. the RMS contribution to the surface
    # (in phase units) per unit coefficient. `zernike_rms_nm[j-1]` is the
    # actual RMS contribution at the fitted magnitude, converted to nm.
    #
    # NOTE: Zernike polynomials are orthonormal on the unit disk, so for a
    # clean circular aperture each `norm_weight` is ≈ 1. For non-circular
    # apertures these deviate and the RMS contribution is aperture-dependent,
    # which is exactly what the UI surfaces in the table.
    _zern_norm_weights = [0.0] * n_zernike
    _zern_rms_nm = [0.0] * n_zernike
    _aperture_valid = (work_mask.astype(bool) if work_mask is not None
                       else np.ones(work_unwrapped.shape, dtype=bool))
    _n_aperture = int(_aperture_valid.sum())
    if _n_aperture > 0:
        for _j in range(1, n_zernike + 1):
            _Zj = zernike_polynomial(_j, rho, theta)
            _vals = _Zj[_aperture_valid]
            _norm = float(np.sqrt(np.mean(_vals * _vals)))
            _zern_norm_weights[_j - 1] = _norm
            # Per-term RMS in phase radians, then convert to nm.
            _rms_phase = abs(float(coeffs[_j - 1])) * _norm
            _zern_rms_nm[_j - 1] = float(phase_to_height(
                np.asarray([_rms_phase]), wavelength_nm)[0])

    # Capture the raw (pre-form-removal) heightmap so downstream reanalysis
    # has access to the full surface — including any tilt/curvature that
    # form removal is about to subtract. M1.3: raw vs display grid separation.
    raw_height_nm_full = phase_to_height(work_unwrapped, wavelength_nm)

    # Step 5: Form removal
    plane_fit_residual_nm = 0.0
    effective_subtract_terms = list(subtract_terms)
    if form_model == "plane":
        corrected = _subtract_plane(work_unwrapped, work_mask)
        plane_coeffs = _fit_plane(work_unwrapped, work_mask)
        # M4.3: for non-Zernike form removal, subtracted_terms is semantically
        # meaningless — the UI surfaces `form_model` instead.
        effective_subtract_terms = []
    elif form_model == "poly2":
        corrected = _subtract_poly(work_unwrapped, work_mask, degree=2)
        plane_coeffs = _fit_plane(work_unwrapped, work_mask)
        effective_subtract_terms = []
    elif form_model == "poly3":
        corrected = _subtract_poly(work_unwrapped, work_mask, degree=3)
        plane_coeffs = _fit_plane(work_unwrapped, work_mask)
        effective_subtract_terms = []
    else:
        corrected = subtract_zernike(work_unwrapped, coeffs, subtract_terms,
                                     rho, theta, work_mask)
        plane_coeffs = None
        if 2 in subtract_terms or 3 in subtract_terms:
            # M2.4: Zernike tilt (terms 2 & 3) is defined on the unit disk,
            # so for non-circular apertures it doesn't fully capture the bulk
            # slope. An explicit least-squares plane fit on the already-tilt-
            # corrected phase mops up the residual. This was the legacy
            # behavior too (`_subtract_plane` call); M2.4 adds the diagnostic
            # that quantifies HOW MUCH slope the plane fit removed beyond
            # Zernike, so we can detect when the aperture is hurting the
            # Zernike decomposition.
            before_plane = corrected.copy()
            corrected = _subtract_plane(corrected, work_mask)
            # Report the PV of the additional plane (in nm) that was peeled
            # off on top of Zernike tilt. Circular apertures: ≈ 0 nm
            # because Zernike already captured the tilt. Non-circular:
            # meaningfully > 0.
            delta = before_plane - corrected
            delta_height = phase_to_height(delta, wavelength_nm)
            if work_mask is not None and work_mask.any():
                d_vals = delta_height[work_mask.astype(bool)]
            else:
                d_vals = delta_height
            if d_vals.size:
                plane_fit_residual_nm = float(d_vals.max() - d_vals.min())

    # Step 6: Convert to height
    height_nm = phase_to_height(corrected, wavelength_nm)

    # Step 7: Statistics
    stats = surface_stats(height_nm, work_mask)
    pv_nm = stats["pv"]
    rms_nm = stats["rms"]
    pv_waves = pv_nm / wavelength_nm
    rms_waves = rms_nm / wavelength_nm

    # Step 8: Focus quality
    f_score = focus_quality(image)

    _progress("render", 0.85, "Rendering results...")
    # Step 9: Renderings
    surface_map_b64 = render_surface_map(height_nm, work_mask)
    profile_x = render_profile(height_nm, work_mask, axis="x")
    profile_y = render_profile(height_nm, work_mask, axis="y")

    # Diagnostic images. Modulation/confidence maps use the same cropped domain
    # as the surface map so overlay toggles do not change image geometry.
    fft_b64 = render_fft_image(img, carrier_info["peak_y"], carrier_info["peak_x"])
    mod_map_b64 = render_modulation_map(work_modulation, work_mask)
    confidence_maps = render_confidence_maps(work_modulation, work_risk, work_mask,
                                             quality_map=work_quality)

    # Step 10: PSF and MTF
    surface_waves = height_nm / wavelength_nm
    psf_b64 = render_psf(surface_waves, work_mask)
    mtf_data = render_mtf(surface_waves, work_mask)

    # Step 11: Zernike chart
    zernike_chart_b64 = render_zernike_chart(
        coeffs.tolist(), subtract_terms, wavelength_nm
    )

    # Modulation stats
    mod_stats = {
        "min": float(modulation.min()),
        "max": float(modulation.max()),
        "mean": float(modulation.mean()),
    }

    # Downsample height grid for client-side measurements (max 256x256)
    # Uses cropped data so grid coordinates match the surface map image
    max_grid = 256
    gh, gw = height_nm.shape
    if gh > max_grid or gw > max_grid:
        scale_factor = min(max_grid / gh, max_grid / gw)
        grid_h = max(1, int(gh * scale_factor))
        grid_w = max(1, int(gw * scale_factor))
        grid = cv2.resize(height_nm.astype(np.float32), (grid_w, grid_h),
                          interpolation=cv2.INTER_AREA)
        raw_grid = cv2.resize(raw_height_nm_full.astype(np.float32), (grid_w, grid_h),
                              interpolation=cv2.INTER_AREA)
        if work_mask is not None:
            mask_resized = cv2.resize(work_mask.astype(np.uint8), (grid_w, grid_h),
                                      interpolation=cv2.INTER_NEAREST)
            grid_mask = (mask_resized > 0)
        else:
            grid_mask = np.ones((grid_h, grid_w), dtype=bool)
    else:
        grid = height_nm.astype(np.float32)
        raw_grid = raw_height_nm_full.astype(np.float32)
        grid_h, grid_w = gh, gw
        grid_mask = work_mask if work_mask is not None else np.ones((grid_h, grid_w), dtype=bool)

    # Set masked pixels to 0 in the grid
    grid_out = grid.copy()
    grid_out[~grid_mask] = 0.0
    raw_grid_out = raw_grid.copy()
    raw_grid_out[~grid_mask] = 0.0

    # M1.6: build trusted_mask on the cropped work domain so it shares
    # geometry with mask_grid, then downsample with INTER_NEAREST to the
    # same grid shape.
    trusted_work = (
        work_mask.astype(bool)
        & (work_modulation >= mask_threshold)
        & (work_risk == 0)
    )
    if trusted_work.shape != (grid_h, grid_w):
        trusted_resized = cv2.resize(trusted_work.astype(np.uint8), (grid_w, grid_h),
                                     interpolation=cv2.INTER_NEAREST)
        trusted_grid = (trusted_resized > 0)
    else:
        trusted_grid = trusted_work
    # Trusted is always a subset of grid_mask at the grid resolution too.
    trusted_grid = trusted_grid & grid_mask

    _progress("render", 1.0, "Complete")
    # Build the display height grid once and alias it from both
    # `height_grid` (legacy) and `display_height_grid_nm` (M1.3). Callers that
    # mutate one see it reflected in the other — intentional, matches the
    # stage-1 alias contract.
    height_grid_list = [round(float(v), 2) for v in grid_out.ravel()]
    raw_height_grid_list = [round(float(v), 2) for v in raw_grid_out.ravel()]

    # M2.3: expose the hybrid quality map as a downsampled 2-D list that shares
    # mask_grid's geometry. Used by the UI as an optional overlay alongside
    # modulation and confidence maps.
    if work_quality is not None:
        q_src = np.asarray(work_quality, dtype=np.float32)
        if q_src.shape != (grid_h, grid_w):
            quality_resized = cv2.resize(q_src, (grid_w, grid_h),
                                         interpolation=cv2.INTER_AREA)
        else:
            quality_resized = q_src
        quality_resized = np.clip(quality_resized, 0.0, 1.0)
        quality_resized[~grid_mask] = 0.0
        quality_grid_list = [round(float(v), 4) for v in quality_resized.ravel()]
    else:
        quality_grid_list = [0.0] * (grid_h * grid_w)

    # P2b fix: expose a numeric modulation grid matching (grid_rows, grid_cols)
    # so register_captures can use it as the primary correlation source.
    # Windowed fringe contrast is rich in surface-independent structure that
    # makes registration robust for smooth flats where the height grid is
    # near-featureless.
    mod_src = np.asarray(work_modulation, dtype=np.float32)
    if mod_src.shape != (grid_h, grid_w):
        mod_resized = cv2.resize(mod_src, (grid_w, grid_h),
                                 interpolation=cv2.INTER_AREA)
    else:
        mod_resized = mod_src
    mod_resized = np.clip(mod_resized, 0.0, 1.0)
    # Zero out pixels outside the mask so correlation isn't pulled around by
    # noisy background values.
    mod_resized = mod_resized.copy()
    mod_resized[~grid_mask] = 0.0
    modulation_grid_list = [round(float(v), 3) for v in mod_resized.ravel()]

    return {
        "surface_map": surface_map_b64,
        "zernike_chart": zernike_chart_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "psf": psf_b64,
        "mtf": mtf_data,
        "fft_image": fft_b64,
        "modulation_map": mod_map_b64,
        "coefficients": coeffs.tolist(),
        "coefficient_names": {str(j): ZERNIKE_NAMES.get(j, f"Z{j}")
                              for j in range(1, n_zernike + 1)},
        # M4.2: per-Zernike-term normalization weights (RMS of Z_j over the
        # current aperture) and actual RMS contributions in nm. Length n_zernike.
        "zernike_norm_weights": _zern_norm_weights,
        "zernike_rms_nm": _zern_rms_nm,
        "pv_nm": pv_nm,
        "rms_nm": rms_nm,
        "pv_waves": pv_waves,
        "rms_waves": rms_waves,
        "strehl": float(np.exp(-(2.0 * np.pi * rms_waves) ** 2)),
        "modulation_stats": mod_stats,
        "focus_score": f_score,
        "subtracted_terms": effective_subtract_terms,
        "wavelength_nm": wavelength_nm,
        "n_valid_pixels": n_valid,
        "n_total_pixels": n_total,
        "surface_height": int(height_nm.shape[0]),
        "surface_width": int(height_nm.shape[1]),
        "image_height": int(img.shape[0]),
        "image_width": int(img.shape[1]),
        "height_grid": height_grid_list,
        "display_height_grid_nm": height_grid_list,
        "raw_height_grid_nm": raw_height_grid_list,
        "mask_grid": [int(v) for v in grid_mask.ravel()],
        "trusted_mask_grid": [int(v) for v in trusted_grid.ravel()],
        "trusted_area_pct": trusted_area_pct,
        "grid_rows": grid_h,
        "grid_cols": grid_w,
        "carrier": carrier_info,
        "form_model": form_model,
        "plane_fit": plane_coeffs,
        # M2.4: PV (nm) of the additional plane subtracted on top of Zernike
        # tilt. ≈ 0 for circular apertures (Zernike tilt already captured
        # the slope); meaningfully > 0 for non-circular apertures, where
        # the Zernike basis leaves some tilt residual.
        "plane_fit_residual_nm": float(plane_fit_residual_nm),
        "confidence": confidence,
        "confidence_maps": confidence_maps,
        "unwrap_stats": unwrap_stats,
        # M2.3: hybrid quality map (modulation × phase-consistency) used for
        # unwrap seed selection. Downsampled to mask_grid resolution.
        "quality_map": quality_grid_list,
        # P2b: numeric modulation grid at mask_grid resolution for
        # registration (primary correlation source when available).
        "modulation_grid": modulation_grid_list,
        # Cropped mask for server-side caching (stripped by API before response)
        "_mask_full": [int(v) for v in work_mask.ravel()],
    }


# ── M3.5: Sub-pixel registration for wavefront subtraction ──────────────


def _cross_correlate_fft(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """2-D phase cross-correlation via FFT, centered at (rows//2, cols//2).

    Phase correlation (normalized cross-power spectrum) produces a
    delta-like peak regardless of the spectral content of the inputs —
    giving a strong peak-to-sidelobe ratio even for smooth surfaces where
    plain cross-correlation has a broad main lobe.

    Returns the real correlation surface (same shape as the inputs).
    Peak location minus the center gives the shift to apply to ``b`` so
    that it aligns with ``a``.
    """
    af = np.fft.fft2(a)
    bf = np.fft.fft2(b)
    cross = af * np.conj(bf)
    # Phase correlation: divide by magnitude to whiten the cross-spectrum.
    magnitude = np.abs(cross)
    cross_normalized = cross / np.where(magnitude < 1e-12, 1.0, magnitude)
    corr = np.fft.ifft2(cross_normalized).real
    return np.fft.fftshift(corr)


def _parabolic_1d(m_minus: float, m_zero: float, m_plus: float) -> float:
    """Parabolic fit offset, unconstrained by maximum check."""
    denom = m_minus - 2.0 * m_zero + m_plus
    if abs(denom) < 1e-12:
        return 0.0
    offset = 0.5 * (m_minus - m_plus) / denom
    if not np.isfinite(offset):
        return 0.0
    # Clamp to the usual parabolic-fit domain.
    if offset < -1.0:
        return -1.0
    if offset > 1.0:
        return 1.0
    return float(offset)


def _correlation_peak_with_confidence(
    corr: np.ndarray,
) -> tuple[float, float, float]:
    """Find the correlation peak, sub-pixel refine, and compute confidence.

    Returns ``(dy, dx, confidence)`` where ``dy, dx`` are in correlation-
    centered coordinates (peak − center; positive dy means b should shift
    down relative to a) and ``confidence`` is peak-to-sidelobe ratio.
    """
    h, w = corr.shape
    cy, cx = h // 2, w // 2
    peak_flat = int(np.argmax(corr))
    py, px = divmod(peak_flat, w)
    peak_val = float(corr[py, px])

    # Sub-pixel refinement via two 1-D parabolic fits (axis-aligned is
    # enough for shift estimation; paraboloid buys nothing in practice).
    dy_off = 0.0
    dx_off = 0.0
    if 0 < py < h - 1:
        dy_off = _parabolic_1d(
            float(corr[py - 1, px]),
            float(corr[py, px]),
            float(corr[py + 1, px]),
        )
    if 0 < px < w - 1:
        dx_off = _parabolic_1d(
            float(corr[py, px - 1]),
            float(corr[py, px]),
            float(corr[py, px + 1]),
        )

    dy = float(py + dy_off - cy)
    dx = float(px + dx_off - cx)

    # Peak-to-sidelobe ratio. Exclude a box around the peak large enough
    # that we're measuring the *noise floor* of the correlation surface,
    # not the skirt of the main lobe. For smooth (well-correlated) inputs
    # the autocorrelation width scales with the grid, so a 5x5 exclusion
    # lands inside the main lobe and gives a meaningless ratio. Use
    # max(5, min(h, w) // 8).
    box = max(5, min(h, w) // 8)
    masked = corr.copy()
    y0 = max(0, py - box)
    y1 = min(h, py + box + 1)
    x0 = max(0, px - box)
    x1 = min(w, px + box + 1)
    masked[y0:y1, x0:x1] = -np.inf
    if np.isfinite(masked).any():
        sidelobe = float(np.max(masked))
    else:
        sidelobe = 0.0
    # If sidelobe is negative (normal for zero-mean inputs), use abs so
    # the ratio is meaningful. Guard against near-zero denominators.
    confidence = peak_val / max(abs(sidelobe), 1e-10)
    return dy, dx, float(confidence)


def _cross_correlate_with_mask(
    grid_a: np.ndarray,
    mask_a: np.ndarray,
    grid_b: np.ndarray,
    mask_b: np.ndarray,
) -> tuple[float, float, float]:
    """Zero-mean cross-correlation on masked grids; returns (dy, dx, conf).

    If either input has ~no variance after masking (e.g. a perfectly flat
    surface), the cross-correlation is uninformative; return zero shift
    with zero confidence so the caller can fall through to ``method=none``.
    """
    a = grid_a.astype(np.float64, copy=True)
    b = grid_b.astype(np.float64, copy=True)
    ma = mask_a.astype(bool)
    mb = mask_b.astype(bool)
    a[~ma] = 0.0
    b[~mb] = 0.0
    if ma.any():
        a_mean = float(a[ma].mean())
        a -= a_mean
        a[~ma] = 0.0
    if mb.any():
        b_mean = float(b[mb].mean())
        b -= b_mean
        b[~mb] = 0.0
    # Guard: featureless inputs have no cross-correlation signal.
    if float(np.abs(a).sum()) < 1e-6 or float(np.abs(b).sum()) < 1e-6:
        return 0.0, 0.0, 0.0
    corr = _cross_correlate_fft(a, b)
    return _correlation_peak_with_confidence(corr)


def register_captures(
    measurement: dict,
    reference: dict,
    *,
    hosted: bool = False,
) -> dict:
    """Estimate sub-pixel (dy, dx) shift of reference relative to measurement.

    The detected shift is the translation that, when applied to the
    reference, aligns it with the measurement: ``reference_shifted(y, x)
    ≈ measurement(y, x)`` over the overlap region.

    Primary path: "modulation" cross-correlation (only used if both inputs
    expose a numeric ``modulation_grid``; since ``analyze_interferogram``
    currently stores the modulation map as a base64 PNG, the primary path
    typically falls back to the raw-intensity path — see below).

    Fallback: cross-correlation on the ``display_height_grid_nm`` arrays
    themselves ("raw_intensity" method). This is the path actually used
    in the current codebase.

    Low-confidence fallback: if neither path yields confidence ≥ 3.0,
    returns ``method='none'`` with a warning.

    Hosted mode: when ``hosted=True`` and either grid side > 512, both
    grids are downsampled with ``cv2.INTER_AREA`` before correlation; the
    resulting shift is scaled back up to the original grid coordinates
    and ``downsampled=True`` in the result.

    Returns
    -------
    dict with keys ``dy``, ``dx`` (floats in grid units),
    ``confidence`` (peak-to-sidelobe ratio of the chosen method),
    ``method`` (``"modulation" | "raw_intensity" | "none"``),
    ``warning`` (``str | None``),
    ``downsampled`` (``bool``).
    """
    mh = int(measurement["grid_rows"])
    mw = int(measurement["grid_cols"])
    rh = int(reference["grid_rows"])
    rw = int(reference["grid_cols"])
    if mh != rh or mw != rw:
        raise ValueError(
            f"Grid shapes differ: M={mh}x{mw} vs R={rh}x{rw}"
        )

    m_disp = np.asarray(measurement["display_height_grid_nm"],
                        dtype=np.float64).reshape(mh, mw)
    r_disp = np.asarray(reference["display_height_grid_nm"],
                        dtype=np.float64).reshape(mh, mw)
    m_mask = np.asarray(measurement["mask_grid"],
                        dtype=np.uint8).reshape(mh, mw).astype(bool)
    r_mask = np.asarray(reference["mask_grid"],
                        dtype=np.uint8).reshape(mh, mw).astype(bool)

    # Modulation maps as numpy arrays (optional). The stock pipeline stores
    # modulation_map only as a base64 PNG; tests and future code may stash
    # a raw float grid under "modulation_grid". Use it when present.
    m_mod = measurement.get("modulation_grid")
    r_mod = reference.get("modulation_grid")
    has_modulation = (
        m_mod is not None
        and r_mod is not None
    )
    if has_modulation:
        try:
            m_mod_arr = np.asarray(m_mod, dtype=np.float64).reshape(mh, mw)
            r_mod_arr = np.asarray(r_mod, dtype=np.float64).reshape(mh, mw)
        except Exception:
            has_modulation = False

    # Hosted-mode downsample decision.
    downsampled = False
    scale = 1.0
    if hosted and max(mh, mw) > 512:
        scale = 512.0 / float(max(mh, mw))
        new_h = max(2, int(round(mh * scale)))
        new_w = max(2, int(round(mw * scale)))
        m_disp = cv2.resize(m_disp.astype(np.float32), (new_w, new_h),
                            interpolation=cv2.INTER_AREA).astype(np.float64)
        r_disp = cv2.resize(r_disp.astype(np.float32), (new_w, new_h),
                            interpolation=cv2.INTER_AREA).astype(np.float64)
        m_mask = cv2.resize(m_mask.astype(np.uint8), (new_w, new_h),
                            interpolation=cv2.INTER_NEAREST).astype(bool)
        r_mask = cv2.resize(r_mask.astype(np.uint8), (new_w, new_h),
                            interpolation=cv2.INTER_NEAREST).astype(bool)
        if has_modulation:
            m_mod_arr = cv2.resize(
                m_mod_arr.astype(np.float32), (new_w, new_h),
                interpolation=cv2.INTER_AREA,
            ).astype(np.float64)
            r_mod_arr = cv2.resize(
                r_mod_arr.astype(np.float32), (new_w, new_h),
                interpolation=cv2.INTER_AREA,
            ).astype(np.float64)
        downsampled = True

    # Try primary path if modulation available.
    primary_dy = primary_dx = 0.0
    primary_conf = 0.0
    primary_ok = False
    if has_modulation:
        try:
            primary_dy, primary_dx, primary_conf = _cross_correlate_with_mask(
                m_mod_arr, m_mask, r_mod_arr, r_mask,
            )
            primary_ok = True
        except Exception:
            primary_ok = False

    # If primary is high-confidence, take it.
    if primary_ok and primary_conf >= 3.0:
        dy, dx, conf = primary_dy, primary_dx, primary_conf
        method = "modulation"
        warning = None
    else:
        # Raw-intensity (display grid) path.
        try:
            raw_dy, raw_dx, raw_conf = _cross_correlate_with_mask(
                m_disp, m_mask, r_disp, r_mask,
            )
        except Exception:
            raw_dy = raw_dx = 0.0
            raw_conf = 0.0

        if raw_conf >= 3.0:
            dy, dx, conf = raw_dy, raw_dx, raw_conf
            method = "raw_intensity"
            warning = None
        else:
            # Pick whichever method gave the highest confidence to report,
            # but label as "none" and warn.
            if primary_ok and primary_conf >= raw_conf:
                dy, dx, conf = primary_dy, primary_dx, primary_conf
            else:
                dy, dx, conf = raw_dy, raw_dx, raw_conf
            method = "none"
            warning = (
                "Low confidence registration — results may show "
                "residual fringes."
            )

    # Scale shifts back to original coordinates when downsampled.
    if downsampled and scale > 0:
        dy /= scale
        dx /= scale

    return {
        "dy": float(dy),
        "dx": float(dx),
        "confidence": float(conf),
        "method": method,
        "warning": warning,
        "downsampled": bool(downsampled),
    }


def _fourier_shift_2d(grid: np.ndarray, dy: float, dx: float) -> np.ndarray:
    """Sub-pixel Fourier shift of a 2-D float array by (dy, dx).

    Uses ``scipy.ndimage.fourier_shift``; positive ``dy`` shifts content
    toward larger row indices (i.e. downward).
    """
    try:
        from scipy.ndimage import fourier_shift  # lazy
    except ImportError:
        # Hand-rolled fallback via phase-ramp multiplication.
        h, w = grid.shape
        fy = np.fft.fftfreq(h).reshape(-1, 1)
        fx = np.fft.fftfreq(w).reshape(1, -1)
        ramp = np.exp(-1j * 2.0 * np.pi * (dy * fy + dx * fx))
        shifted = np.fft.ifft2(np.fft.fft2(grid) * ramp).real
        return shifted.astype(grid.dtype, copy=False)

    spec = np.fft.fft2(grid.astype(np.float64))
    shifted_spec = fourier_shift(spec, shift=(dy, dx))
    shifted = np.fft.ifft2(shifted_spec).real
    return shifted.astype(grid.dtype, copy=False)


def _integer_shift_mask(mask: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Explicit integer-index mask shift with zero-fill (NO np.roll).

    Shifts ``mask`` by ``dy`` rows and ``dx`` cols; regions exposed at
    the edges are filled with zero (not wrapped).
    """
    h, w = mask.shape
    out = np.zeros_like(mask)
    # Clamp shift magnitudes to grid dims — anything larger means the
    # shifted mask would be entirely zero, which the slicing handles.
    if abs(dy) >= h or abs(dx) >= w:
        return out

    # Source and destination row ranges.
    if dy >= 0:
        src_y0, src_y1 = 0, h - dy
        dst_y0, dst_y1 = dy, h
    else:
        src_y0, src_y1 = -dy, h
        dst_y0, dst_y1 = 0, h + dy

    if dx >= 0:
        src_x0, src_x1 = 0, w - dx
        dst_x0, dst_x1 = dx, w
    else:
        src_x0, src_x1 = -dx, w
        dst_x0, dst_x1 = 0, w + dx

    out[dst_y0:dst_y1, dst_x0:dst_x1] = mask[src_y0:src_y1, src_x0:src_x1]
    return out


def subtract_wavefronts(
    measurement: dict,
    reference: dict,
    *,
    wavelength_nm: float | None = None,
    register: bool = True,
    hosted: bool = False,
) -> dict:
    """Wavefront subtraction with optional sub-pixel registration (M3.5).

    Both inputs are full :func:`analyze_interferogram` result dicts (post
    :func:`wrap_wavefront_result`).  Returns a new WavefrontResult-shaped
    dict with ``origin='subtracted'`` and ``source_ids`` set to
    ``[measurement['id'], reference['id']]``.

    When ``register=True`` (default) the reference grids are shifted by
    the detected sub-pixel offset before subtraction. The height grids
    are shifted via :func:`scipy.ndimage.fourier_shift`; the boolean
    masks are shifted by the rounded integer offset with explicit
    zero-fill slicing (NOT ``np.roll``) to avoid wrap-around.

    When ``register=False`` the behavior matches M3.4 (pixel-aligned).

    Display grid = measurement − reference_shifted; mask is the
    element-wise AND of both masks; raw grid is differenced similarly.
    Stats (PV/RMS/Strehl, Zernike) are recomputed on the residual.

    Compatibility issues (wavelength mismatch, calibration mismatch, low
    overlap, low registration confidence, residual-RMS amplification)
    are appended to the returned ``warnings`` list — they do NOT raise.

    Raises
    ------
    ValueError
        If the two inputs have mismatched ``grid_rows``/``grid_cols``.
    """
    # ── Shape gate ────────────────────────────────────────────────────
    mh = int(measurement["grid_rows"])
    mw = int(measurement["grid_cols"])
    rh = int(reference["grid_rows"])
    rw = int(reference["grid_cols"])
    if mh != rh or mw != rw:
        raise ValueError(
            f"Grid shapes differ: M={mh}x{mw} vs R={rh}x{rw}"
        )

    warnings_list: list[str] = []

    # ── Wavelength resolution + mismatch warning ─────────────────────
    m_wl = float(measurement["wavelength_nm"])
    r_wl = float(reference["wavelength_nm"])
    eff_wl = float(wavelength_nm) if wavelength_nm is not None else m_wl
    if abs(r_wl - eff_wl) > 1e-9:
        warnings_list.append(
            f"Wavelength mismatch: measurement {eff_wl} nm vs reference "
            f"{r_wl} nm — results may be biased."
        )

    # ── Calibration mismatch warning ──────────────────────────────────
    m_cal = measurement.get("calibration_snapshot") or {}
    r_cal = reference.get("calibration_snapshot") or {}
    m_mmpx = m_cal.get("mm_per_pixel") if isinstance(m_cal, dict) else None
    r_mmpx = r_cal.get("mm_per_pixel") if isinstance(r_cal, dict) else None
    try:
        m_mmpx_f = float(m_mmpx) if m_mmpx is not None else 0.0
        r_mmpx_f = float(r_mmpx) if r_mmpx is not None else 0.0
    except (TypeError, ValueError):
        m_mmpx_f = r_mmpx_f = 0.0
    if m_mmpx_f > 0 and r_mmpx_f > 0:
        denom = max(m_mmpx_f, 1e-12)
        if abs(m_mmpx_f - r_mmpx_f) / denom > 0.01:
            warnings_list.append(
                "Calibration mm_per_pixel differs — spatial scales "
                "inconsistent."
            )

    # ── Reshape grids ────────────────────────────────────────────────
    m_disp = np.asarray(measurement["display_height_grid_nm"],
                        dtype=np.float32).reshape(mh, mw)
    r_disp = np.asarray(reference["display_height_grid_nm"],
                        dtype=np.float32).reshape(mh, mw)
    m_raw = np.asarray(measurement["raw_height_grid_nm"],
                       dtype=np.float32).reshape(mh, mw)
    r_raw_arr = np.asarray(reference["raw_height_grid_nm"],
                           dtype=np.float32).reshape(mh, mw)
    m_mask = np.asarray(measurement["mask_grid"],
                        dtype=np.uint8).reshape(mh, mw).astype(bool)
    r_mask = np.asarray(reference["mask_grid"],
                        dtype=np.uint8).reshape(mh, mw).astype(bool)

    # ── M3.5: Registration (optional) ────────────────────────────────
    if register:
        reg_info = register_captures(measurement, reference, hosted=hosted)
        dy = float(reg_info["dy"])
        dx = float(reg_info["dx"])
        # When registration confidence is too low (method='none'), the
        # detected shift is unreliable garbage — applying it would
        # silently corrupt the mask and amplify residuals. Skip the
        # shift entirely and just warn; the warning below still surfaces
        # the low-confidence diagnostic to the UI.
        if reg_info.get("method") == "none":
            dy = 0.0
            dx = 0.0
        # Shift the reference grids to align with the measurement.
        # Fourier shift on heights; explicit integer-index slicing on masks.
        if abs(dy) > 1e-6 or abs(dx) > 1e-6:
            r_disp = _fourier_shift_2d(r_disp.astype(np.float64),
                                       dy, dx).astype(np.float32)
            r_raw_arr = _fourier_shift_2d(r_raw_arr.astype(np.float64),
                                          dy, dx).astype(np.float32)
            dy_int = int(round(dy))
            dx_int = int(round(dx))
            r_mask = _integer_shift_mask(r_mask, dy_int, dx_int)
        warnings_list.append(
            f"Registered with method={reg_info['method']}, "
            f"confidence={reg_info['confidence']:.2f}, "
            f"dy={dy:.2f}px, dx={dx:.2f}px."
        )
        if reg_info.get("warning"):
            warnings_list.append(reg_info["warning"])
    else:
        reg_info = {"method": "disabled"}

    r_raw = r_raw_arr

    combined_mask = m_mask & r_mask

    m_valid = int(m_mask.sum())
    combined_valid = int(combined_mask.sum())
    if m_valid > 0:
        overlap_frac = combined_valid / m_valid
        if overlap_frac < 0.30:
            pct = round(100.0 * overlap_frac, 1)
            warnings_list.append(
                f"Low overlap: only {pct}% of measurement pixels valid "
                "after masking."
            )

    # ── Raw-domain difference ────────────────────────────────────────
    # P1b fix: subtract on the *raw* grids so differential tilt / low-
    # order form between measurement and reference is preserved (each
    # input had its own form removed independently, so differencing the
    # display grids silently cancels tilt mismatches that the reference
    # is supposed to reveal). After differencing on raw grids, we re-apply
    # the measurement's form-removal recipe to produce the display grid.
    raw_diff = (m_raw - r_raw).astype(np.float32)
    raw_diff[~combined_mask] = 0.0

    # Re-apply form removal in the difference domain. Use the measurement's
    # form_model + subtracted_terms (defaulting to zernike + [1,2,3] when
    # absent — matches analyze_interferogram defaults).
    form_model = measurement.get("form_model") or "zernike"
    subtract_terms = list(
        measurement.get("subtracted_terms")
        if measurement.get("subtracted_terms") is not None
        else [1, 2, 3]
    )
    raw_diff_f64 = raw_diff.astype(np.float64)
    if combined_mask.any():
        if form_model == "plane":
            display_diff_f64 = _subtract_plane(raw_diff_f64, combined_mask)
        elif form_model == "poly2":
            display_diff_f64 = _subtract_poly(raw_diff_f64, combined_mask,
                                              degree=2)
        elif form_model == "poly3":
            display_diff_f64 = _subtract_poly(raw_diff_f64, combined_mask,
                                              degree=3)
        else:
            # Zernike path: fit on the raw difference, then subtract the
            # chosen terms. Match analyze_interferogram's n_terms from the
            # measurement's coefficients length (fall back to 36).
            n_terms_fit = max(1, len(measurement.get("coefficients") or []) or 36)
            n_terms_fit = min(n_terms_fit, 66)
            try:
                fit_coeffs, fit_rho, fit_theta = fit_zernike(
                    raw_diff_f64, n_terms=n_terms_fit, mask=combined_mask,
                )
                display_diff_f64 = subtract_zernike(
                    raw_diff_f64, fit_coeffs, subtract_terms,
                    fit_rho, fit_theta, combined_mask,
                )
            except Exception:
                display_diff_f64 = raw_diff_f64.copy()
                display_diff_f64[~combined_mask] = 0.0
            # Mop up residual plane when Zernike tilt terms are requested
            # (mirrors analyze_interferogram behavior for non-circular
            # apertures).
            if 2 in subtract_terms or 3 in subtract_terms:
                display_diff_f64 = _subtract_plane(display_diff_f64,
                                                   combined_mask)
    else:
        display_diff_f64 = raw_diff_f64.copy()
    display_diff = display_diff_f64.astype(np.float32)
    display_diff[~combined_mask] = 0.0

    # ── Stats on the valid residual ──────────────────────────────────
    stats = surface_stats(display_diff, combined_mask)
    pv_nm = stats["pv"]
    rms_nm = stats["rms"]
    pv_waves = pv_nm / eff_wl if eff_wl > 0 else 0.0
    rms_waves = rms_nm / eff_wl if eff_wl > 0 else 0.0
    strehl = float(np.exp(-(2.0 * np.pi * rms_waves) ** 2))

    # ── Residual RMS sanity check (M3.5) ─────────────────────────────
    # If the subtraction *amplified* the residual vs the measurement's
    # own RMS, something is wrong with the reference — warn.
    if combined_mask.any():
        m_disp_stats = surface_stats(m_disp, combined_mask)
        m_rms = m_disp_stats["rms"]
        if m_rms > 1e-6 and rms_nm > m_rms * 1.1:
            warnings_list.append(
                "Residual RMS exceeds measurement RMS — subtraction may "
                "have amplified rather than reduced error. Consider "
                "checking the reference."
            )

    # ── Renderings ───────────────────────────────────────────────────
    surf_h = int(measurement.get("surface_height", mh))
    surf_w = int(measurement.get("surface_width", mw))
    if surf_h != mh or surf_w != mw:
        full_surface = cv2.resize(display_diff, (surf_w, surf_h),
                                  interpolation=cv2.INTER_LINEAR)
        full_mask = cv2.resize(combined_mask.astype(np.uint8),
                               (surf_w, surf_h),
                               interpolation=cv2.INTER_NEAREST).astype(bool)
    else:
        full_surface = display_diff
        full_mask = combined_mask
    surface_map_b64 = render_surface_map(full_surface, full_mask)
    profile_x = render_profile(full_surface, full_mask, axis="x")
    profile_y = render_profile(full_surface, full_mask, axis="y")

    # PSF/MTF on the residual surface — matches the call sites used by
    # analyze_interferogram (same render_psf/render_mtf with surface waves
    # and the full-resolution mask).
    surface_waves = full_surface / eff_wl if eff_wl > 0 else full_surface * 0.0
    psf_b64 = render_psf(surface_waves, full_mask)
    mtf_data = render_mtf(surface_waves, full_mask)

    # ── Zernike refit on the residual (so the chart still works) ──
    n_zernike = max(1, len(measurement.get("coefficients") or []) or 36)
    n_zernike = min(n_zernike, 66)
    if combined_mask.any():
        try:
            coeffs, _rho, _theta = fit_zernike(
                display_diff.astype(np.float64), n_terms=n_zernike,
                mask=combined_mask
            )
            coeffs_list = coeffs.tolist()
        except Exception:
            coeffs_list = [0.0] * n_zernike
    else:
        coeffs_list = [0.0] * n_zernike
    coefficient_names = {str(j): ZERNIKE_NAMES.get(j, f"Z{j}")
                         for j in range(1, n_zernike + 1)}

    # ── Assemble result ──────────────────────────────────────────────
    n_total = int(combined_mask.size)
    height_grid_list = [round(float(v), 2) for v in display_diff.ravel()]
    raw_height_grid_list = [round(float(v), 2) for v in raw_diff.ravel()]
    mask_list = [int(v) for v in combined_mask.ravel().astype(np.uint8)]

    result: dict = {
        "surface_map": surface_map_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "psf": psf_b64,
        "mtf": mtf_data,
        "zernike_chart": "",
        "coefficients": coeffs_list,
        "coefficient_names": coefficient_names,
        "pv_nm": pv_nm,
        "rms_nm": rms_nm,
        "pv_waves": pv_waves,
        "rms_waves": rms_waves,
        "strehl": strehl,
        "subtracted_terms": list(measurement.get("subtracted_terms") or []),
        "wavelength_nm": eff_wl,
        "n_valid_pixels": combined_valid,
        "n_total_pixels": n_total,
        "surface_height": surf_h,
        "surface_width": surf_w,
        "height_grid": height_grid_list,
        "display_height_grid_nm": height_grid_list,
        "raw_height_grid_nm": raw_height_grid_list,
        "mask_grid": mask_list,
        "raw_mask_grid": mask_list,
        "grid_rows": mh,
        "grid_cols": mw,
    }

    wrap_wavefront_result(
        result,
        origin="subtracted",
        calibration=measurement.get("calibration_snapshot"),
        source_ids=[measurement["id"], reference["id"]],
        aperture_recipe=measurement.get("aperture_recipe"),
    )
    # Attach registration info for API consumers.
    result["registration"] = reg_info
    # Merge subtraction-specific warnings with whatever wrap defaulted to.
    existing = result.get("warnings") or []
    result["warnings"] = list(existing) + warnings_list
    return result


def average_wavefronts(
    results: list[dict],
    *,
    wavelength_nm: float | None = None,
    rejection: str = "none",
    rejection_threshold: float = 3.0,
) -> dict:
    """Per-pixel average of multiple WavefrontResults with optional outlier rejection.

    Inputs: list of result dicts (>= 2). All must share grid_rows/grid_cols.
    Output: new WavefrontResult with origin='average', source_ids=[r.id for r in results],
    display_height_grid_nm = per-pixel (robust) mean, raw_height_grid_nm similarly,
    mask_grid = intersection of input mask_grids AND pixels with at least 2 valid
    contributors after rejection. Stats (PV/RMS/Strehl) recomputed on the averaged
    display grid. Zernike coefficients refit. Surface map and profiles rendered.

    Rejection methods:
        - "none"  : simple per-pixel mean of valid layers (np.nanmean).
        - "sigma" : per-pixel mean/std on valid layers; drop layers further than
                    ``rejection_threshold * std``; re-average survivors.
        - "mad"   : per-pixel median + MAD (×1.4826); drop layers further than
                    ``rejection_threshold * MAD``; mean-average survivors.

    Raises
    ------
    ValueError
        If fewer than 2 inputs are supplied, or grid shapes differ.
    """
    # ── Input gating ─────────────────────────────────────────────────
    if not isinstance(results, (list, tuple)) or len(results) < 2:
        raise ValueError("Need at least 2 results to average.")

    # Shape check: all grids same (grid_rows, grid_cols).
    gh0 = int(results[0]["grid_rows"])
    gw0 = int(results[0]["grid_cols"])
    for r in results[1:]:
        if int(r["grid_rows"]) != gh0 or int(r["grid_cols"]) != gw0:
            raise ValueError(
                f"Grid shapes differ: expected {gh0}x{gw0}, got "
                f"{int(r['grid_rows'])}x{int(r['grid_cols'])}"
            )

    if rejection not in ("none", "sigma", "mad"):
        raise ValueError(
            f"rejection must be 'none', 'sigma' or 'mad'; got {rejection!r}"
        )

    warnings_list: list[str] = []
    n = len(results)

    # ── Wavelength resolution + mismatch warning ─────────────────────
    wls = [float(r["wavelength_nm"]) for r in results]
    eff_wl = float(wavelength_nm) if wavelength_nm is not None else wls[0]
    wl_spread = max(wls) - min(wls)
    if wl_spread > 0.1:
        warnings_list.append(
            f"Wavelength mismatch: inputs span {min(wls):.2f}–{max(wls):.2f} nm "
            f"(using {eff_wl:.2f} nm) — results may be biased."
        )

    # ── Calibration mismatch warning ─────────────────────────────────
    mmpx_vals: list[float] = []
    for r in results:
        cal = r.get("calibration_snapshot") or {}
        v = cal.get("mm_per_pixel") if isinstance(cal, dict) else None
        try:
            mmpx_vals.append(float(v) if v is not None else 0.0)
        except (TypeError, ValueError):
            mmpx_vals.append(0.0)
    nonzero = [v for v in mmpx_vals if v > 0]
    if len(nonzero) == len(mmpx_vals) and len(nonzero) >= 2:
        lo, hi = min(nonzero), max(nonzero)
        if lo > 0 and (hi - lo) / lo > 0.01:
            warnings_list.append(
                "Calibration mm_per_pixel differs across inputs — spatial "
                "scales inconsistent."
            )

    # ── Stack grids and masks ────────────────────────────────────────
    disp_stack = np.empty((n, gh0, gw0), dtype=np.float32)
    raw_stack = np.empty((n, gh0, gw0), dtype=np.float32)
    mask_stack = np.empty((n, gh0, gw0), dtype=bool)
    for i, r in enumerate(results):
        disp_stack[i] = np.asarray(
            r["display_height_grid_nm"], dtype=np.float32
        ).reshape(gh0, gw0)
        raw_stack[i] = np.asarray(
            r["raw_height_grid_nm"], dtype=np.float32
        ).reshape(gh0, gw0)
        mask_stack[i] = np.asarray(
            r["mask_grid"], dtype=np.uint8
        ).reshape(gh0, gw0).astype(bool)

    # Per-pixel count of valid inputs (before rejection).
    n_valid_per_pixel = mask_stack.sum(axis=0)  # shape (gh0, gw0)

    # Mask-as-NaN views for averaging.
    disp_nan = disp_stack.astype(np.float32).copy()
    raw_nan = raw_stack.astype(np.float32).copy()
    invalid = ~mask_stack
    disp_nan[invalid] = np.nan
    raw_nan[invalid] = np.nan

    # ── Rejection ────────────────────────────────────────────────────
    # ``surviving`` is a boolean stack (n, gh0, gw0) of pixels that
    # survive rejection; starts equal to mask_stack and is tightened
    # below.
    surviving = mask_stack.copy()

    if rejection == "sigma":
        with np.errstate(invalid="ignore"):
            mu = np.nanmean(disp_nan, axis=0)          # (gh0, gw0)
            sd = np.nanstd(disp_nan, axis=0)           # (gh0, gw0)
        # Wherever sd is 0 or NaN, do not reject anyone.
        sd_safe = np.where(np.isfinite(sd) & (sd > 0), sd, np.inf)
        thresh = rejection_threshold * sd_safe
        dev = np.abs(disp_nan - mu[None, :, :])
        reject = np.isfinite(dev) & (dev > thresh[None, :, :])
        surviving &= ~reject
    elif rejection == "mad":
        with np.errstate(invalid="ignore"):
            med = np.nanmedian(disp_nan, axis=0)       # (gh0, gw0)
            mad = np.nanmedian(
                np.abs(disp_nan - med[None, :, :]), axis=0
            )
        mad_sigma = 1.4826 * mad
        mad_safe = np.where(np.isfinite(mad_sigma) & (mad_sigma > 0),
                            mad_sigma, np.inf)
        thresh = rejection_threshold * mad_safe
        dev = np.abs(disp_nan - med[None, :, :])
        reject = np.isfinite(dev) & (dev > thresh[None, :, :])
        surviving &= ~reject
    # else "none": no further masking.

    # Rejection stats per layer (how many pixels the layer lost).
    rejected_mask_stack = mask_stack & ~surviving
    n_rejected_per_layer: list[int] = [
        int(rejected_mask_stack[i].sum()) for i in range(n)
    ]

    # Apply surviving mask back to the NaN stacks.
    disp_surv = disp_stack.astype(np.float32).copy()
    raw_surv = raw_stack.astype(np.float32).copy()
    disp_surv[~surviving] = np.nan
    raw_surv[~surviving] = np.nan

    n_surviving_per_pixel = surviving.sum(axis=0)

    # Per-pixel mean.
    with np.errstate(invalid="ignore", divide="ignore"):
        display_mean = np.nanmean(disp_surv, axis=0)
        raw_mean = np.nanmean(raw_surv, axis=0)

    # Final output mask: >= 2 valid contributors before AND after rejection.
    combined_mask = (n_valid_per_pixel >= 2) & (n_surviving_per_pixel >= 2)

    display_out = np.where(combined_mask, display_mean, 0.0).astype(np.float32)
    raw_out = np.where(combined_mask, raw_mean, 0.0).astype(np.float32)
    # Replace NaN sentinels (from pixels that fell out entirely) with 0.
    display_out = np.nan_to_num(display_out, nan=0.0, posinf=0.0, neginf=0.0)
    raw_out = np.nan_to_num(raw_out, nan=0.0, posinf=0.0, neginf=0.0)

    # ── Stats on averaged display grid ───────────────────────────────
    stats = surface_stats(display_out, combined_mask)
    pv_nm = stats["pv"]
    rms_nm = stats["rms"]
    pv_waves = pv_nm / eff_wl if eff_wl > 0 else 0.0
    rms_waves = rms_nm / eff_wl if eff_wl > 0 else 0.0
    strehl = float(np.exp(-(2.0 * np.pi * rms_waves) ** 2))

    # ── Renderings ───────────────────────────────────────────────────
    surf_h = int(results[0].get("surface_height", gh0))
    surf_w = int(results[0].get("surface_width", gw0))
    if surf_h != gh0 or surf_w != gw0:
        full_surface = cv2.resize(display_out, (surf_w, surf_h),
                                  interpolation=cv2.INTER_LINEAR)
        full_mask = cv2.resize(combined_mask.astype(np.uint8),
                               (surf_w, surf_h),
                               interpolation=cv2.INTER_NEAREST).astype(bool)
    else:
        full_surface = display_out
        full_mask = combined_mask
    surface_map_b64 = render_surface_map(full_surface, full_mask)
    profile_x = render_profile(full_surface, full_mask, axis="x")
    profile_y = render_profile(full_surface, full_mask, axis="y")

    # PSF/MTF on the averaged surface — matches analyze_interferogram's
    # call signature (surface in waves + full-resolution mask).
    surface_waves = full_surface / eff_wl if eff_wl > 0 else full_surface * 0.0
    psf_b64 = render_psf(surface_waves, full_mask)
    mtf_data = render_mtf(surface_waves, full_mask)

    # ── Zernike refit on the averaged display grid ──────────────────
    first_coeffs = results[0].get("coefficients") or []
    n_zernike = max(1, len(first_coeffs) or 36)
    n_zernike = min(n_zernike, 66)
    if combined_mask.any():
        try:
            coeffs, _rho, _theta = fit_zernike(
                display_out.astype(np.float64), n_terms=n_zernike,
                mask=combined_mask,
            )
            coeffs_list = coeffs.tolist()
        except Exception:
            coeffs_list = [0.0] * n_zernike
    else:
        coeffs_list = [0.0] * n_zernike
    coefficient_names = {str(j): ZERNIKE_NAMES.get(j, f"Z{j}")
                         for j in range(1, n_zernike + 1)}

    # ── Assemble result ──────────────────────────────────────────────
    n_total = int(combined_mask.size)
    combined_valid = int(combined_mask.sum())
    height_grid_list = [round(float(v), 2) for v in display_out.ravel()]
    raw_height_grid_list = [round(float(v), 2) for v in raw_out.ravel()]
    mask_list = [int(v) for v in combined_mask.ravel().astype(np.uint8)]

    result: dict = {
        "surface_map": surface_map_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "psf": psf_b64,
        "mtf": mtf_data,
        "zernike_chart": "",
        "coefficients": coeffs_list,
        "coefficient_names": coefficient_names,
        "pv_nm": pv_nm,
        "rms_nm": rms_nm,
        "pv_waves": pv_waves,
        "rms_waves": rms_waves,
        "strehl": strehl,
        "subtracted_terms": list(results[0].get("subtracted_terms") or []),
        "wavelength_nm": eff_wl,
        "n_valid_pixels": combined_valid,
        "n_total_pixels": n_total,
        "surface_height": surf_h,
        "surface_width": surf_w,
        "height_grid": height_grid_list,
        "display_height_grid_nm": height_grid_list,
        "raw_height_grid_nm": raw_height_grid_list,
        "mask_grid": mask_list,
        "raw_mask_grid": mask_list,
        "grid_rows": gh0,
        "grid_cols": gw0,
        "rejection_method": rejection,
        "rejection_threshold": float(rejection_threshold),
        "rejection_stats": {
            "n_rejected_per_layer": n_rejected_per_layer,
            "n_inputs": n,
        },
    }

    wrap_wavefront_result(
        result,
        origin="average",
        calibration=results[0].get("calibration_snapshot"),
        source_ids=[r["id"] for r in results],
        aperture_recipe=results[0].get("aperture_recipe"),
    )
    existing = result.get("warnings") or []
    result["warnings"] = list(existing) + warnings_list
    return result


def reanalyze(coefficients: list[float], subtract_terms: list[int],
              wavelength_nm: float, surface_shape: tuple[int, int],
              mask_serialized: list[int] | None = None,
              n_zernike: int = 36,
              form_model: str = "zernike",
              raw_height_grid_nm: list[float] | None = None,
              raw_grid_rows: int | None = None,
              raw_grid_cols: int | None = None) -> dict:
    """Re-analyze with different Zernike subtraction without redoing FFT.

    Two paths:

    1. **Full-fidelity (preferred)** — when ``raw_height_grid_nm``,
       ``raw_grid_rows`` and ``raw_grid_cols`` are all provided, refit
       Zernike on the cached raw heightmap and subtract the requested
       terms directly. Surface detail at spatial frequencies higher than
       ``n_zernike`` is preserved.

    2. **Legacy coefficient path** — when the raw grid is not supplied,
       reconstruct the surface from the fit coefficients alone. Surface
       detail above the ``n_zernike`` cutoff is lost, so PV/RMS may differ
       slightly from a full ``analyze_interferogram`` call.

    Parameters
    ----------
    coefficients : Zernike coefficients from a previous analyze call.
    subtract_terms : Noll indices to subtract.
    wavelength_nm : wavelength for height conversion.
    surface_shape : (height, width) of the original surface.
    mask_serialized : flat list of 0/1 values, same length as h*w
        (legacy path) or raw_grid_rows*raw_grid_cols (raw-grid path).
    n_zernike : number of Zernike terms.
    form_model : "zernike" or "plane".
    raw_height_grid_nm : cached pre-form-removal heightmap as a flat list
        of floats (from a prior analyze response's ``raw_height_grid_nm``).
    raw_grid_rows, raw_grid_cols : shape of the raw grid.

    Returns
    -------
    Dict with: surface_map, zernike_chart, profile_x, profile_y,
    pv_nm, rms_nm, pv_waves, rms_waves, subtracted_terms,
    height_grid, display_height_grid_nm, raw_height_grid_nm (when the
    raw-grid path was used), grid_rows, grid_cols.
    """
    use_raw_grid = (raw_height_grid_nm is not None
                    and raw_grid_rows is not None
                    and raw_grid_cols is not None)

    if use_raw_grid:
        # Full-fidelity path: operate on the cached raw heightmap, refit
        # Zernike at its native resolution, and subtract the requested
        # terms directly. The raw grid is already in nanometers, so no
        # wavelength conversion is needed.
        rh, rw = int(raw_grid_rows), int(raw_grid_cols)
        raw_height_nm = np.array(raw_height_grid_nm, dtype=np.float64).reshape(rh, rw)

        if mask_serialized is not None:
            mask = np.array(mask_serialized, dtype=bool).reshape(rh, rw)
        else:
            mask = np.ones((rh, rw), dtype=bool)

        # Refit Zernike on the raw heightmap so subtract_zernike operates
        # on up-to-date coefficients (the ones passed in were fit on the
        # full-res cropped surface; the downsampled grid may differ
        # slightly).
        fit_coeffs, rho, theta = fit_zernike(raw_height_nm, n_terms=n_zernike, mask=mask)

        if form_model == "plane":
            corrected = _subtract_plane(raw_height_nm, mask)
            plane_coeffs = _fit_plane(raw_height_nm, mask)
        elif form_model == "poly2":
            corrected = _subtract_poly(raw_height_nm, mask, degree=2)
            plane_coeffs = _fit_plane(raw_height_nm, mask)
        elif form_model == "poly3":
            corrected = _subtract_poly(raw_height_nm, mask, degree=3)
            plane_coeffs = _fit_plane(raw_height_nm, mask)
        else:
            corrected = subtract_zernike(raw_height_nm, fit_coeffs, subtract_terms,
                                         rho, theta, mask)
            if 2 in subtract_terms or 3 in subtract_terms:
                corrected = _subtract_plane(corrected, mask)
            plane_coeffs = None

        # `corrected` is already in nm (the raw grid is height, not phase).
        height_nm = corrected

        coeffs_out = fit_coeffs
    else:
        # Legacy path: reconstruct from fit coefficients alone.
        h, w = surface_shape
        coeffs = np.array(coefficients[:n_zernike], dtype=np.float64)

        # Reconstruct mask
        if mask_serialized is not None:
            mask = np.array(mask_serialized, dtype=bool).reshape(h, w)
        else:
            mask = np.ones((h, w), dtype=bool)

        rho, theta = _make_polar_coords((h, w), mask)

        # Reconstruct full surface from all coefficients
        full_surface = np.zeros((h, w), dtype=np.float64)
        for j in range(1, min(len(coeffs) + 1, n_zernike + 1)):
            Zj = zernike_polynomial(j, rho, theta)
            full_surface += coeffs[j - 1] * Zj

        # Form removal
        if form_model == "plane":
            corrected = _subtract_plane(full_surface, mask)
            plane_coeffs = _fit_plane(full_surface, mask)
        elif form_model == "poly2":
            corrected = _subtract_poly(full_surface, mask, degree=2)
            plane_coeffs = _fit_plane(full_surface, mask)
        elif form_model == "poly3":
            corrected = _subtract_poly(full_surface, mask, degree=3)
            plane_coeffs = _fit_plane(full_surface, mask)
        else:
            corrected = subtract_zernike(full_surface, coeffs, subtract_terms,
                                         rho, theta, mask)
            if 2 in subtract_terms or 3 in subtract_terms:
                corrected = _subtract_plane(corrected, mask)
            plane_coeffs = None

        # Convert to height
        height_nm = phase_to_height(corrected, wavelength_nm)
        coeffs_out = coeffs

    # Stats
    stats = surface_stats(height_nm, mask)
    rms_waves = stats["rms"] / wavelength_nm

    # Renderings
    surface_map_b64 = render_surface_map(height_nm, mask)
    zernike_chart_b64 = render_zernike_chart(
        coeffs_out.tolist(), subtract_terms, wavelength_nm
    )
    profile_x = render_profile(height_nm, mask, axis="x")
    profile_y = render_profile(height_nm, mask, axis="y")

    # PSF and MTF
    surface_waves = height_nm / wavelength_nm
    psf_b64 = render_psf(surface_waves, mask)
    mtf_data = render_mtf(surface_waves, mask)

    # Downsample height grid for client-side measurements (max 256x256)
    # Matches the algorithm used by analyze_interferogram so the Step tool
    # and 3D view see the refreshed surface after re-subtraction.
    max_grid = 256
    gh, gw = height_nm.shape
    if gh > max_grid or gw > max_grid:
        scale_factor = min(max_grid / gh, max_grid / gw)
        grid_h = max(1, int(gh * scale_factor))
        grid_w = max(1, int(gw * scale_factor))
        grid = cv2.resize(height_nm.astype(np.float32), (grid_w, grid_h),
                          interpolation=cv2.INTER_AREA)
        if mask is not None:
            mask_resized = cv2.resize(mask.astype(np.uint8), (grid_w, grid_h),
                                      interpolation=cv2.INTER_NEAREST)
            grid_mask = (mask_resized > 0)
        else:
            grid_mask = np.ones((grid_h, grid_w), dtype=bool)
    else:
        grid = height_nm.astype(np.float32)
        grid_h, grid_w = gh, gw
        grid_mask = mask if mask is not None else np.ones((grid_h, grid_w), dtype=bool)

    # Set masked pixels to 0 in the grid
    grid_out = grid.copy()
    grid_out[~grid_mask] = 0.0

    # Display grid — shared between `height_grid` (legacy) and
    # `display_height_grid_nm` (M1.3) by reference, matching analyze.
    height_grid_list = [round(float(v), 2) for v in grid_out.ravel()]

    response = {
        "surface_map": surface_map_b64,
        "zernike_chart": zernike_chart_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "psf": psf_b64,
        "mtf": mtf_data,
        "pv_nm": stats["pv"],
        "rms_nm": stats["rms"],
        "pv_waves": stats["pv"] / wavelength_nm,
        "rms_waves": rms_waves,
        "strehl": float(np.exp(-(2.0 * np.pi * rms_waves) ** 2)),
        # M4.3: only Zernike form-removal carries meaningful subtracted_terms.
        "subtracted_terms": subtract_terms if form_model == "zernike" else [],
        "form_model": form_model,
        "plane_fit": plane_coeffs,
        "height_grid": height_grid_list,
        "display_height_grid_nm": height_grid_list,
        "mask_grid": [int(v) for v in grid_mask.ravel()],
        "grid_rows": grid_h,
        "grid_cols": grid_w,
    }

    if use_raw_grid:
        # Echo the raw grid back unchanged so the frontend can keep using
        # it for subsequent reanalyze calls without a round-trip.
        response["raw_height_grid_nm"] = list(raw_height_grid_nm)

    return response
