"""Fringe analysis computation primitives.

Zernike polynomial fitting, DFT-based phase extraction, 2D phase unwrapping,
modulation-based auto-masking, focus quality scoring, surface statistics
(PV/RMS), false-color rendering, and the full analyze/reanalyze pipeline.
"""

from __future__ import annotations

import base64
import io
import math
from collections.abc import Callable

import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np
from scipy.ndimage import uniform_filter


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


# ── Fringe modulation, masking, DFT phase extraction, unwrapping ──────


def _find_carrier(image: np.ndarray) -> tuple[int, int, float]:
    """Find the carrier frequency peak in an interferogram.

    Returns (peak_y, peak_x, distance) in the fftshift coordinate system.
    The peak is always in the upper half-plane (or left half for
    horizontal fringes) to select the +1 order consistently.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
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
    # Keep margin small: the Hanning window confines DC leakage to a few
    # pixels, and real interferograms can have as few as 2-3 fringes (carrier
    # peak very close to DC).  dim//20 was too large — it masked the real
    # carrier on low-fringe-count images like gage blocks.
    dc_margin_y = max(3, h // 80)
    dc_margin_x = max(3, w // 80)
    mag_search = magnitude.copy()
    mag_search[cy - dc_margin_y:cy + dc_margin_y + 1,
               cx - dc_margin_x:cx + dc_margin_x + 1] = 0

    # Zero out the lower half-plane (and right half of center row) so we can
    # only ever find the +1 order peak.  This makes the result deterministic
    # regardless of noise — conjugate symmetry means the -1 order has
    # identical magnitude, so argmax tie-breaking could flip otherwise.
    mag_search[cy + 1:, :] = 0
    mag_search[cy, cx + 1:] = 0

    peak_idx = np.unravel_index(np.argmax(mag_search), mag_search.shape)
    py, px = peak_idx

    dist = math.sqrt((py - cy) ** 2 + (px - cx) ** 2)

    # Scale back to original coordinates
    py_orig = int(py * scale)
    px_orig = int(px * scale)
    dist_orig = dist * scale
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
    # When a mask is available, crop to its bounding box so fringes fill
    # the analysis region. Without cropping, non-fringe areas dilute the
    # carrier peak. Hard zeroing or modulation weighting don't work because
    # they introduce spectral leakage from the window shape itself.
    analysis_img = img
    crop_offset_y, crop_offset_x = 0, 0
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
                crop_offset_y, crop_offset_x = y0, x0
    ah, aw = analysis_img.shape
    img_c = analysis_img - analysis_img.mean()
    img_windowed = img_c * np.outer(np.hanning(ah), np.hanning(aw))
    F = np.fft.fftshift(np.fft.fft2(img_windowed))
    magnitude = np.abs(F)

    # Find carrier peak in the (possibly cropped) magnitude spectrum
    acy, acx = ah // 2, aw // 2
    dc_margin = max(3, min(ah, aw) // 80)
    mag_search = magnitude.copy()
    mag_search[acy - dc_margin:acy + dc_margin + 1, acx - dc_margin:acx + dc_margin + 1] = 0
    # Find the carrier peak in this spectrum
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
    dc_margin_full = max(3, min(h, w) // 80)
    dc_margin_px = float(np.sqrt((py - cy_full) ** 2 + (px - cx_full) ** 2) - dc_margin_full)
    dc_margin_px = max(0.0, dc_margin_px)

    # Alternate peaks: top 3 remaining peaks after masking carrier
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
        alternate_peaks.append({
            "y": alt_y, "x": alt_x,
            "distance_px": round(alt_dist, 1),
            "peak_ratio": round(alt_ratio, 2),
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
    py, px, dist = _find_carrier(img)
    # Convert peak position to spatial frequency (cycles/pixel)
    # In fftshift coords, center is (h//2, w//2)
    fy = (py - h // 2) / h  # cycles per pixel
    fx = (px - w // 2) / w

    # Step 2: complex demodulation — shift carrier to DC
    yy, xx = np.mgrid[0:h, 0:w]
    demod = img * np.exp(-2j * np.pi * (fy * yy + fx * xx))

    # Low-pass filter (envelope extraction)
    # Window size ~ 2x the fringe period for good locality
    fringe_period = h / max(dist, 1)
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


def rasterize_polygon_mask(polygons: list[dict], height: int, width: int
                           ) -> np.ndarray:
    """Rasterize polygon definitions into a boolean mask.

    Parameters
    ----------
    polygons : list of dicts with keys:
        - "vertices": list of (x, y) tuples in normalized (0-1) coords
        - "include": bool (True = include region, False = exclude/hole)
    height, width : image dimensions for rasterization.

    Returns
    -------
    Boolean mask (True = valid pixel). If no polygons given, returns all-True.
    """
    if not polygons:
        return np.ones((height, width), dtype=bool)

    mask = np.zeros((height, width), dtype=np.uint8)

    # Process include polygons first, then exclude
    for poly in polygons:
        pts = np.array(
            [(int(x * width), int(y * height)) for x, y in poly["vertices"]],
            dtype=np.int32,
        )
        if poly.get("include", True):
            cv2.fillPoly(mask, [pts], 1)

    for poly in polygons:
        pts = np.array(
            [(int(x * width), int(y * height)) for x, y in poly["vertices"]],
            dtype=np.int32,
        )
        if not poly.get("include", True):
            cv2.fillPoly(mask, [pts], 0)

    return mask.astype(bool)


def extract_phase_dft(image: np.ndarray, mask: np.ndarray | None = None,
                      carrier_override: tuple[int, int] | None = None,
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
        py, px, dist = _find_carrier(img)
    fy = (py - h // 2) / h  # cycles per pixel
    fx = (px - w // 2) / w

    # Step 3: complex demodulation — shift carrier to DC
    yy, xx = np.mgrid[0:h, 0:w]
    carrier = np.exp(-2j * np.pi * (fy * yy + fx * xx))
    demod = enhanced * carrier

    # Step 4: low-pass filter (envelope extraction)
    # Sigma ~2.5x the fringe period smooths inter-fringe noise well enough
    # to prevent phase unwrapping artifacts (the "clouds with hard lines"
    # pattern caused by 2π jump errors).  The trade-off is reduced spatial
    # resolution, but for optical flats / gage blocks that's acceptable.
    fringe_freq = math.sqrt(fy ** 2 + fx ** 2)
    fringe_period = 1.0 / max(fringe_freq, 1e-10)
    lp_sigma = max(fringe_period * 2.5, 5.0)
    demod_lp = (cv2.GaussianBlur(demod.real, (0, 0), lp_sigma) +
                1j * cv2.GaussianBlur(demod.imag, (0, 0), lp_sigma))

    # Step 5: extract wrapped phase
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


def unwrap_phase_2d(wrapped: np.ndarray, mask: np.ndarray | None = None,
                    quality: np.ndarray | None = None,
                    fringe_period_px: float | None = None,
                    ) -> tuple[np.ndarray, np.ndarray]:
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

    Returns
    -------
    tuple of (unwrapped, risk_mask):
        unwrapped : float64 array — unwrapped phase map.
        risk_mask : uint8 array — 0 = clean, 1 = 2π-jump corrected,
                    2 = edge contamination zone.
    """
    from scipy.ndimage import median_filter

    phase = wrapped.copy()

    if quality is not None:
        unwrapped = _quality_guided_unwrap(phase, quality, mask)
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
                        np.zeros(wrapped.shape, dtype=np.uint8))
        else:
            unwrapped = unwrap_phase(phase).astype(np.float64)

    # Risk mask: track which pixels needed correction or are suspect.
    risk_mask = np.zeros(wrapped.shape, dtype=np.uint8)

    # Post-unwrapping correction: detect pixels that differ from their local
    # median by ~2π (unwrapping jump errors) and snap them back.  This fixes
    # the "clouds with hard lines" artifact on noisy interferograms.
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

    return unwrapped, risk_mask


def focus_quality(image: np.ndarray) -> float:
    """Compute a focus quality score (0-100) for fringe images.

    Uses fringe modulation (local contrast) rather than Laplacian variance,
    because fringe images are smooth sinusoidal patterns that inherently
    have low Laplacian variance even in perfect focus.  High modulation
    means well-resolved, high-contrast fringes.

    The score is based on the median modulation in the central 50% of the
    image (to avoid edge effects), mapped to 0–100 via a sigmoid.

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
    score = 100.0 / (1.0 + math.exp(-k * (median_mod - mid)))
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
        # Crop to mask bounding box with 5% padding to avoid huge black borders
        if valid.any():
            rows = np.any(valid, axis=1)
            cols = np.any(valid, axis=0)
            r0, r1 = np.argmax(rows), len(rows) - np.argmax(rows[::-1])
            c0, c1 = np.argmax(cols), len(cols) - np.argmax(cols[::-1])
            pad_r = max(2, int(0.05 * (r1 - r0)))
            pad_c = max(2, int(0.05 * (c1 - c0)))
            r0 = max(0, r0 - pad_r)
            r1 = min(s.shape[0], r1 + pad_r)
            c0 = max(0, c0 - pad_c)
            c1 = min(s.shape[1], c1 + pad_c)
            s = s[r0:r1, c0:c1]
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

    # Colormap background
    ax.imshow(s, cmap='RdBu_r', vmin=-vmax, vmax=vmax,
              interpolation='bilinear', aspect='equal')

    # Contour lines
    if smax > smin:
        n_levels = min(12, max(4, int((smax - smin) / (vmax * 0.1))))
        levels = np.linspace(smin, smax, n_levels + 2)[1:-1]
        ax.contour(s, levels=levels, colors='black', linewidths=0.6, alpha=0.4)

    canvas.draw()
    buf = io.BytesIO()
    fig.savefig(buf, format='png', facecolor='black', dpi=dpi, pad_inches=0)
    plt.close(fig)
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

    fig, ax = plt.subplots(figsize=(10, 3.5), dpi=100)
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

    plt.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor(), edgecolor="none")
    plt.close(fig)
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
                           mask: np.ndarray) -> dict:
    """Render confidence maps as base64 PNGs.
    Returns dict with 'unwrap_risk' and 'composite' keys (base64 PNG strings).
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

    return {
        "unwrap_risk": base64.b64encode(risk_buf.tobytes()).decode("ascii"),
        "composite": base64.b64encode(comp_buf.tobytes()).decode("ascii"),
    }


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
    cmap = plt.cm.inferno
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


def analyze_interferogram(image: np.ndarray, wavelength_nm: float = 632.8,
                          mask_threshold: float = 0.15,
                          subtract_terms: list[int] | None = None,
                          n_zernike: int = 36,
                          use_full_mask: bool = False,
                          custom_mask: np.ndarray | None = None,
                          carrier_override: tuple[int, int] | None = None,
                          on_progress: Callable[[str, float, str], None] | None = None,
                          form_model: str = "zernike",
                          lens_k1: float = 0.0) -> dict:
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
    wrapped = extract_phase_dft(img, mask, carrier_override=carrier_override)
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

    # Step 3: Phase unwrapping
    unwrapped, unwrap_risk = unwrap_phase_2d(
        wrapped, mask, quality=modulation,
        fringe_period_px=carrier_info.get("fringe_period_px"))
    _progress("unwrap", 0.50, "Unwrapping phase...")

    # Confidence metrics (computed after unwrap, before form removal)
    confidence = compute_confidence(carrier_info, modulation, unwrap_risk, mask,
                                    threshold_frac=mask_threshold)
    confidence_maps = render_confidence_maps(modulation, unwrap_risk, mask)

    # Unwrap statistics
    valid_mask = mask.astype(bool) if mask is not None else np.ones(unwrapped.shape, dtype=bool)
    n_corrected = int(np.sum(unwrap_risk[valid_mask] == 1))
    n_edge_risk = int(np.sum(unwrap_risk[valid_mask] == 2))
    unwrap_stats = {
        "n_corrected": n_corrected,
        "n_edge_risk": n_edge_risk,
        "n_reliable": n_valid - n_corrected - n_edge_risk,
    }

    # Step 4: Zernike fitting
    coeffs, rho, theta = fit_zernike(unwrapped, n_terms=n_zernike, mask=mask)
    _progress("zernike", 0.70, "Fitting Zernike polynomials...")

    # Step 5: Form removal
    if form_model == "plane":
        corrected = _subtract_plane(unwrapped, mask)
        plane_coeffs = _fit_plane(unwrapped, mask)
    else:
        corrected = subtract_zernike(unwrapped, coeffs, subtract_terms, rho, theta, mask)
        if 2 in subtract_terms or 3 in subtract_terms:
            corrected = _subtract_plane(corrected, mask)
        plane_coeffs = None

    # Step 6: Convert to height
    height_nm = phase_to_height(corrected, wavelength_nm)

    # Step 7: Statistics
    stats = surface_stats(height_nm, mask)
    pv_nm = stats["pv"]
    rms_nm = stats["rms"]
    pv_waves = pv_nm / wavelength_nm
    rms_waves = rms_nm / wavelength_nm

    # Step 8: Focus quality
    f_score = focus_quality(image)

    _progress("render", 0.85, "Rendering results...")
    # Step 9: Renderings
    surface_map_b64 = render_surface_map(height_nm, mask)
    profile_x = render_profile(height_nm, mask, axis="x")
    profile_y = render_profile(height_nm, mask, axis="y")

    # Diagnostic images: FFT with carrier peak marked, modulation map
    fft_b64 = render_fft_image(img, carrier_info["peak_y"], carrier_info["peak_x"])
    mod_map_b64 = render_modulation_map(modulation, mask)

    # Step 10: PSF and MTF
    surface_waves = height_nm / wavelength_nm
    psf_b64 = render_psf(surface_waves, mask)
    mtf_data = render_mtf(surface_waves, mask)

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

    _progress("render", 1.0, "Complete")
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
        "pv_nm": pv_nm,
        "rms_nm": rms_nm,
        "pv_waves": pv_waves,
        "rms_waves": rms_waves,
        "strehl": float(np.exp(-(2.0 * np.pi * rms_waves) ** 2)),
        "modulation_stats": mod_stats,
        "focus_score": f_score,
        "subtracted_terms": subtract_terms,
        "wavelength_nm": wavelength_nm,
        "n_valid_pixels": n_valid,
        "n_total_pixels": n_total,
        "surface_height": int(img.shape[0]),
        "surface_width": int(img.shape[1]),
        "height_grid": [round(float(v), 2) for v in grid_out.ravel()],
        "mask_grid": [int(v) for v in grid_mask.ravel()],
        "grid_rows": grid_h,
        "grid_cols": grid_w,
        "carrier": carrier_info,
        "form_model": form_model,
        "plane_fit": plane_coeffs,
        "confidence": confidence,
        "confidence_maps": confidence_maps,
        "unwrap_stats": unwrap_stats,
        # Full-res mask for server-side caching (stripped by API before response)
        "_mask_full": [int(v) for v in mask.ravel()],
    }


def reanalyze(coefficients: list[float], subtract_terms: list[int],
              wavelength_nm: float, surface_shape: tuple[int, int],
              mask_serialized: list[int] | None = None,
              n_zernike: int = 36,
              form_model: str = "zernike") -> dict:
    """Re-analyze with different Zernike subtraction without redoing FFT.

    This is the fast path: reconstruct the surface from Zernike coefficients,
    subtract the requested terms, recompute stats and renderings.

    Note: this reconstructs from the Zernike model only. Surface detail at
    spatial frequencies higher than the n_zernike terms is excluded, so
    PV/RMS may differ slightly from a full analyze_interferogram call.

    Parameters
    ----------
    coefficients : Zernike coefficients from a previous analyze call.
    subtract_terms : Noll indices to subtract.
    wavelength_nm : wavelength for height conversion.
    surface_shape : (height, width) of the original surface.
    mask_serialized : flat list of 0/1 values, same length as h*w.
    n_zernike : number of Zernike terms.

    Returns
    -------
    Dict with: surface_map, zernike_chart, profile_x, profile_y,
    pv_nm, rms_nm, pv_waves, rms_waves, subtracted_terms.
    """
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
    else:
        corrected = subtract_zernike(full_surface, coeffs, subtract_terms,
                                     rho, theta, mask)
        if 2 in subtract_terms or 3 in subtract_terms:
            corrected = _subtract_plane(corrected, mask)
        plane_coeffs = None

    # Convert to height
    height_nm = phase_to_height(corrected, wavelength_nm)

    # Stats
    stats = surface_stats(height_nm, mask)
    rms_waves = stats["rms"] / wavelength_nm

    # Renderings
    surface_map_b64 = render_surface_map(height_nm, mask)
    zernike_chart_b64 = render_zernike_chart(
        coeffs.tolist(), subtract_terms, wavelength_nm
    )
    profile_x = render_profile(height_nm, mask, axis="x")
    profile_y = render_profile(height_nm, mask, axis="y")

    # PSF and MTF
    surface_waves = height_nm / wavelength_nm
    psf_b64 = render_psf(surface_waves, mask)
    mtf_data = render_mtf(surface_waves, mask)

    return {
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
        "subtracted_terms": subtract_terms,
        "form_model": form_model,
        "plane_fit": plane_coeffs,
    }
