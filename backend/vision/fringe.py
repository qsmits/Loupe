"""Fringe analysis computation primitives.

Zernike polynomial fitting, DFT-based phase extraction, 2D phase unwrapping,
modulation-based auto-masking, focus quality scoring, surface statistics
(PV/RMS), false-color rendering, and the full analyze/reanalyze pipeline.
"""

from __future__ import annotations

import base64
import io
import math

import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
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


def extract_phase_dft(image: np.ndarray, mask: np.ndarray | None = None
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

    Unwraps from highest-quality pixels outward, so errors in weak-fringe
    regions don't propagate into the solution.

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

    # Build edge list: each edge connects two adjacent valid pixels.
    # Edge quality = min(quality[a], quality[b]).
    # 4-connected neighbors.
    edges = []
    for dy, dx in [(0, 1), (1, 0), (0, -1), (-1, 0)]:
        for y in range(max(0, -dy), min(h, h - dy)):
            for x in range(max(0, -dx), min(w, w - dx)):
                ny, nx = y + dy, x + dx
                if valid[y, x] and valid[ny, nx]:
                    eq = min(quality[y, x], quality[ny, nx])
                    edges.append((eq, y, x, ny, nx))

    # Sort descending by quality (process best edges first)
    edges.sort(key=lambda e: -e[0])

    # Unwrap: process edges from highest quality to lowest.
    # For each edge, if exactly one endpoint is visited, unwrap the other.
    # Multiple passes needed since an edge may have neither endpoint visited
    # on the first encounter.
    changed = True
    while changed:
        changed = False
        remaining = []
        for eq, y1, x1, y2, x2 in edges:
            v1 = visited[y1, x1]
            v2 = visited[y2, x2]
            if v1 and not v2:
                diff = wrapped[y2, x2] - wrapped[y1, x1]
                unwrapped[y2, x2] = unwrapped[y1, x1] + diff - 2 * np.pi * round(diff / (2 * np.pi))
                visited[y2, x2] = True
                changed = True
            elif v2 and not v1:
                diff = wrapped[y1, x1] - wrapped[y2, x2]
                unwrapped[y1, x1] = unwrapped[y2, x2] + diff - 2 * np.pi * round(diff / (2 * np.pi))
                visited[y1, x1] = True
                changed = True
            elif not v1 and not v2:
                remaining.append((eq, y1, x1, y2, x2))
            # both visited: skip (already consistent)
        edges = remaining

    unwrapped[~valid] = 0.0
    return unwrapped


def unwrap_phase_2d(wrapped: np.ndarray, mask: np.ndarray | None = None,
                    quality: np.ndarray | None = None) -> np.ndarray:
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

    Returns
    -------
    Unwrapped phase map, float64.
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
                phase[~valid] = 0.0

        unwrapped = unwrap_phase(phase).astype(np.float64)

        if mask is not None:
            unwrapped[~valid] = 0.0

    # Post-unwrapping correction: detect pixels that differ from their local
    # median by ~2π (unwrapping jump errors) and snap them back.  This fixes
    # the "clouds with hard lines" artifact on noisy interferograms.
    med = median_filter(unwrapped, size=9)
    unwrapped -= 2.0 * np.pi * np.round((unwrapped - med) / (2.0 * np.pi))

    if mask is not None:
        valid = mask.astype(bool)
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
                          use_full_mask: bool = False) -> dict:
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

    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)

    # Step 1: Modulation & mask
    modulation = compute_fringe_modulation(img)
    if use_full_mask:
        mask = np.ones(img.shape, dtype=bool)
    else:
        mask = create_fringe_mask(img, modulation, threshold_frac=mask_threshold)
    n_valid = int(mask.sum())
    n_total = int(mask.size)

    # Step 2: DFT phase extraction
    wrapped = extract_phase_dft(img, mask)

    # Step 3: Phase unwrapping
    unwrapped = unwrap_phase_2d(wrapped, mask, quality=modulation)

    # Step 4: Zernike fitting
    coeffs, rho, theta = fit_zernike(unwrapped, n_terms=n_zernike, mask=mask)

    # Step 5: Subtract selected terms
    corrected = subtract_zernike(unwrapped, coeffs, subtract_terms, rho, theta, mask)

    # Step 5b: If tilt terms were subtracted, also remove any residual
    # linear tilt via direct plane fit.  Zernike tilt (Z2/Z3) is defined on
    # a circular domain; on rectangular apertures the fit can leave residual
    # slope that dominates the color scale and obscures real topography.
    if 2 in subtract_terms or 3 in subtract_terms:
        corrected = _subtract_plane(corrected, mask)

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

    # Step 9: Renderings
    surface_map_b64 = render_surface_map(height_nm, mask)
    profile_x = render_profile(height_nm, mask, axis="x")
    profile_y = render_profile(height_nm, mask, axis="y")

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

    return {
        "surface_map": surface_map_b64,
        "zernike_chart": zernike_chart_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "psf": psf_b64,
        "mtf": mtf_data,
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
    }


def reanalyze(coefficients: list[float], subtract_terms: list[int],
              wavelength_nm: float, surface_shape: tuple[int, int],
              mask_serialized: list[int] | None = None,
              n_zernike: int = 36) -> dict:
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

    # Subtract selected terms
    corrected = subtract_zernike(full_surface, coeffs, subtract_terms,
                                 rho, theta, mask)

    # Residual plane subtraction (same as analyze_interferogram)
    if 2 in subtract_terms or 3 in subtract_terms:
        corrected = _subtract_plane(corrected, mask)

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
    }
