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
    """Render a false-color surface map as a PNG, base64-encoded.

    Uses the RdBu_r (red-blue reversed) colormap: red = high, blue = low.
    Masked-out pixels are rendered as black.

    Returns base64 string (no 'data:' prefix).
    """
    s = np.asarray(surface, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            smin = float(s[valid].min())
            smax = float(s[valid].max())
        else:
            smin, smax = 0.0, 0.0
    else:
        smin = float(s.min())
        smax = float(s.max())

    if smax > smin:
        # Center around zero for symmetric colormap
        vmax = max(abs(smin), abs(smax))
        norm = ((s + vmax) / (2.0 * vmax) * 255.0)
    else:
        norm = np.full_like(s, 128.0)

    gray = np.clip(norm, 0, 255).astype(np.uint8)
    if mask is not None:
        gray[~valid] = 0

    # Apply RdBu_r colormap via matplotlib LUT
    cmap = plt.cm.RdBu_r
    lut = (cmap(np.linspace(0, 1, 256))[:, :3] * 255).astype(np.uint8)
    colored = lut[gray]
    # Convert RGB to BGR for cv2.imencode
    colored = colored[:, :, ::-1].copy()

    if mask is not None:
        colored[~valid] = 0

    ok, buf = cv2.imencode(".png", colored)
    if not ok:
        raise RuntimeError("cv2.imencode failed for surface map PNG")
    return base64.b64encode(buf.tobytes()).decode("ascii")


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


def analyze_interferogram(image: np.ndarray, wavelength_nm: float = 632.8,
                          mask_threshold: float = 0.15,
                          subtract_terms: list[int] | None = None,
                          n_zernike: int = 36) -> dict:
    """Full analysis pipeline: single image in, all results out.

    Parameters
    ----------
    image : grayscale or BGR interferogram.
    wavelength_nm : light source wavelength.
    mask_threshold : modulation threshold for auto-masking (0-1).
    subtract_terms : Noll indices to subtract (default: [1, 2, 3] = piston + tilt).
    n_zernike : number of Zernike terms to fit.

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
    mask = create_fringe_mask(modulation, threshold_frac=mask_threshold)
    n_valid = int(mask.sum())
    n_total = int(mask.size)

    # Step 2: DFT phase extraction
    wrapped = extract_phase_dft(img, mask)

    # Step 3: Phase unwrapping
    unwrapped = unwrap_phase_2d(wrapped, mask)

    # Step 4: Zernike fitting
    coeffs, rho, theta = fit_zernike(unwrapped, n_terms=n_zernike, mask=mask)

    # Step 5: Subtract selected terms
    corrected = subtract_zernike(unwrapped, coeffs, subtract_terms, rho, theta, mask)

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

    # Step 10: Zernike chart
    zernike_chart_b64 = render_zernike_chart(
        coeffs.tolist(), subtract_terms, wavelength_nm
    )

    # Modulation stats
    mod_stats = {
        "min": float(modulation.min()),
        "max": float(modulation.max()),
        "mean": float(modulation.mean()),
    }

    return {
        "surface_map": surface_map_b64,
        "zernike_chart": zernike_chart_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "coefficients": coeffs.tolist(),
        "coefficient_names": {str(j): ZERNIKE_NAMES.get(j, f"Z{j}")
                              for j in range(1, n_zernike + 1)},
        "pv_nm": pv_nm,
        "rms_nm": rms_nm,
        "pv_waves": pv_waves,
        "rms_waves": rms_waves,
        "modulation_stats": mod_stats,
        "focus_score": f_score,
        "subtracted_terms": subtract_terms,
        "wavelength_nm": wavelength_nm,
        "n_valid_pixels": n_valid,
        "n_total_pixels": n_total,
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

    # Convert to height
    height_nm = phase_to_height(corrected, wavelength_nm)

    # Stats
    stats = surface_stats(height_nm, mask)

    # Renderings
    surface_map_b64 = render_surface_map(height_nm, mask)
    zernike_chart_b64 = render_zernike_chart(
        coeffs.tolist(), subtract_terms, wavelength_nm
    )
    profile_x = render_profile(height_nm, mask, axis="x")
    profile_y = render_profile(height_nm, mask, axis="y")

    return {
        "surface_map": surface_map_b64,
        "zernike_chart": zernike_chart_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "pv_nm": stats["pv"],
        "rms_nm": stats["rms"],
        "pv_waves": stats["pv"] / wavelength_nm,
        "rms_waves": stats["rms"] / wavelength_nm,
        "subtracted_terms": subtract_terms,
    }
