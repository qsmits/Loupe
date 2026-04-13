"""Fringe analysis computation primitives.

Zernike polynomial fitting: Noll indexing, radial polynomial evaluation,
basis matrix construction, and least-squares coefficient fitting.
DFT-based phase extraction, 2D phase unwrapping, modulation-based
auto-masking, and focus quality scoring.

Surface statistics and false-color rendering are added in subsequent tasks.
"""

from __future__ import annotations

import math

import cv2
import numpy as np
from scipy.ndimage import uniform_filter


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


# ── Fringe modulation, masking, DFT phase extraction, unwrapping ──────


def compute_fringe_modulation(image: np.ndarray) -> np.ndarray:
    """Compute a local contrast (modulation) map for auto-masking.

    Uses a sliding-window approach: for each pixel, modulation is the
    local standard deviation within a 15x15 window, normalized by the
    local mean.  High modulation = fringes present = valid data.

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
    ksize = 15
    local_mean = uniform_filter(img, size=ksize)
    local_sq_mean = uniform_filter(img ** 2, size=ksize)
    local_var = np.maximum(local_sq_mean - local_mean ** 2, 0.0)
    local_std = np.sqrt(local_var)
    # Normalize: modulation = std / (mean + eps) clipped to [0, 1]
    modulation = local_std / (local_mean + 1e-6)
    return np.clip(modulation, 0.0, 1.0)


def create_fringe_mask(modulation: np.ndarray, threshold_frac: float = 0.15
                       ) -> np.ndarray:
    """Create a boolean mask from modulation map.

    Parameters
    ----------
    modulation : float64 modulation map from compute_fringe_modulation.
    threshold_frac : fraction of max modulation below which pixels are masked out.

    Returns
    -------
    Boolean mask: True = valid pixel with adequate fringe contrast.
    """
    thresh = threshold_frac * float(modulation.max()) if modulation.max() > 0 else 0.0
    return modulation > thresh


def extract_phase_dft(image: np.ndarray, mask: np.ndarray | None = None
                      ) -> np.ndarray:
    """Extract wrapped phase from an interferogram using 2D DFT sideband isolation.

    Pipeline:
    1. Window the image (Hann) to reduce spectral leakage
    2. 2D FFT
    3. Find the +1 order carrier peak (strongest off-center peak)
    4. Isolate the sideband with a Gaussian window
    5. Shift to origin, inverse FFT
    6. Extract wrapped phase: atan2(Im, Re)

    Parameters
    ----------
    image : 2D grayscale image (float64 or uint8).
    mask : optional boolean mask (True = valid). Masked-out pixels are set to
           the image mean before FFT to reduce ringing.

    Returns
    -------
    Wrapped phase map in [-pi, pi], same shape as input.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    h, w = img.shape

    # Fill masked pixels with mean to reduce spectral leakage
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            mean_val = img[valid].mean()
        else:
            mean_val = img.mean()
        img_work = img.copy()
        img_work[~valid] = mean_val
    else:
        img_work = img

    # Subtract DC and apply 2D Hann window
    img_work = img_work - img_work.mean()
    wy = np.hanning(h)
    wx = np.hanning(w)
    window = np.outer(wy, wx)
    img_windowed = img_work * window

    # 2D FFT
    F = np.fft.fft2(img_windowed)
    F_shifted = np.fft.fftshift(F)
    magnitude = np.abs(F_shifted)

    # Find the +1 order peak: strongest peak away from center
    cy, cx = h // 2, w // 2
    # Zero out the DC region (center +/-5% of image)
    dc_margin_y = max(3, h // 20)
    dc_margin_x = max(3, w // 20)
    mag_search = magnitude.copy()
    mag_search[cy - dc_margin_y:cy + dc_margin_y + 1,
               cx - dc_margin_x:cx + dc_margin_x + 1] = 0

    # Find peak location
    peak_idx = np.unravel_index(np.argmax(mag_search), mag_search.shape)
    py, px = peak_idx

    # Use only the peak in the upper half-plane (or left half for horizontal fringes)
    # to select the +1 order consistently.  If the peak is in the lower/right half,
    # use its conjugate.
    if py > cy or (py == cy and px > cx):
        py = h - py
        px = w - px

    # Gaussian window centered on the sideband peak
    yy, xx = np.mgrid[0:h, 0:w]
    # Window radius: ~1/3 of distance from peak to center
    dist_to_center = math.sqrt((py - cy) ** 2 + (px - cx) ** 2)
    sigma = max(dist_to_center / 3.0, 3.0)
    gauss = np.exp(-((yy - py) ** 2 + (xx - px) ** 2) / (2 * sigma ** 2))

    # Isolate sideband
    sideband = F_shifted * gauss

    # Shift sideband to origin
    shift_y = cy - py
    shift_x = cx - px
    sideband_shifted = np.roll(np.roll(sideband, int(shift_y), axis=0),
                               int(shift_x), axis=1)

    # Inverse FFT to get analytic signal
    analytic = np.fft.ifft2(np.fft.ifftshift(sideband_shifted))

    # Extract wrapped phase
    wrapped = np.angle(analytic)
    return wrapped.astype(np.float64)


def unwrap_phase_2d(wrapped: np.ndarray, mask: np.ndarray | None = None
                    ) -> np.ndarray:
    """Two-pass 2D spatial phase unwrapping.

    Unwraps along rows first (axis=1), then along columns (axis=0),
    using numpy.unwrap.  This approach handles most interferograms
    where the fringe density is moderate.

    Parameters
    ----------
    wrapped : 2D float64 array of wrapped phase in [-pi, pi].
    mask : optional boolean mask (True = valid).

    Returns
    -------
    Unwrapped phase map, float64.
    """
    # Two-pass unwrap: horizontal then vertical
    phase = wrapped.copy()
    if mask is not None:
        # Fill masked pixels with neighbor average to avoid discontinuities
        valid = mask.astype(bool)
        if valid.any():
            phase[~valid] = 0.0

    # Unwrap along rows
    unwrapped = np.unwrap(phase, axis=1)
    # Unwrap along columns
    unwrapped = np.unwrap(unwrapped, axis=0)

    if mask is not None:
        unwrapped[~valid] = 0.0

    return unwrapped


def focus_quality(image: np.ndarray) -> float:
    """Compute a focus quality score (0-100) based on image sharpness.

    Uses the variance of the Laplacian as a sharpness metric, mapped
    to [0, 100] via a sigmoid.

    Parameters
    ----------
    image : grayscale or BGR image.

    Returns
    -------
    Score from 0 (completely blurred) to 100 (very sharp).
    """
    img = np.asarray(image, dtype=np.uint8)
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    laplacian = cv2.Laplacian(img, cv2.CV_64F)
    variance = float(laplacian.var())
    # Sigmoid mapping: score = 100 / (1 + exp(-k*(var - mid)))
    # Tuned so that var~100 -> score~50, var~500 -> score~95
    k = 0.02
    mid = 150.0
    score = 100.0 / (1.0 + math.exp(-k * (variance - mid)))
    return round(score, 1)
