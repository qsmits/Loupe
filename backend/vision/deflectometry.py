"""Deflectometry computation primitives.

Pure functions for fringe generation, N-step phase shifting (generalized
from 4-step to support 8-step harmonic suppression), phase unwrapping,
statistics, and pseudocolor visualization. No state, no I/O beyond PNG
encoding for the visualization helper.
"""

from __future__ import annotations

import base64

import cv2
import numpy as np


def generate_fringe_pattern(
    width: int, height: int, phase: float, freq: int, orientation: str,
    gamma: float = 1.0,
) -> np.ndarray:
    """Return an (H, W) uint8 sinusoidal fringe image.

    I(x, y) = 127 + 127 * cos(2π * freq * coord / extent + phase)

    orientation='x' → varies along axis 1 (width), producing vertical stripes.
    orientation='y' → varies along axis 0 (height), producing horizontal stripes.

    If gamma != 1.0, apply inverse gamma pre-correction so that a display
    with the given gamma curve produces linear sinusoidal light output:
      corrected = 255 * (v/255)^(1/gamma)
    """
    if orientation == "x":
        coord = np.arange(width, dtype=np.float64)
        extent = float(width)
        wave = 127.0 + 127.0 * np.cos(2.0 * np.pi * freq * coord / extent + phase)
    elif orientation == "y":
        coord = np.arange(height, dtype=np.float64)
        extent = float(height)
        wave = 127.0 + 127.0 * np.cos(2.0 * np.pi * freq * coord / extent + phase)
    else:
        raise ValueError(f"orientation must be 'x' or 'y', got {orientation!r}")

    if gamma != 1.0:
        inv_gamma = 1.0 / gamma
        wave_normalized = np.clip(wave / 255.0, 0.0, 1.0)
        wave = 255.0 * np.power(wave_normalized, inv_gamma)

    if orientation == "x":
        img = np.broadcast_to(wave[None, :], (height, width))
    else:
        img = np.broadcast_to(wave[:, None], (height, width))

    return np.clip(img, 0, 255).astype(np.uint8)


def compute_wrapped_phase(frames: list[np.ndarray]) -> np.ndarray:
    """N-step phase extraction using the generalized formula.

    φ = atan2(-Σ Iₖ·sin(2πk/N), Σ Iₖ·cos(2πk/N))

    Frames may be uint8 or float, 2D or 3D (H, W, C). 3D inputs are reduced
    to grayscale by mean over the channel axis. Output is float64 in [-π, π].

    Accepts any number of frames ≥ 3 (typically 4 or 8). The negated sin_sum
    preserves sign compatibility with the original 4-step formula
    atan2(I3 - I1, I0 - I2).
    """
    N = len(frames)
    if N < 3:
        raise ValueError(f"need at least 3 frames, got {N}")

    prepped: list[np.ndarray] = []
    for f in frames:
        arr = np.asarray(f, dtype=np.float64)
        if arr.ndim == 3:
            arr = arr.mean(axis=-1)
        prepped.append(arr)

    sin_sum = np.zeros_like(prepped[0])
    cos_sum = np.zeros_like(prepped[0])
    for k, img in enumerate(prepped):
        angle = 2.0 * np.pi * k / N
        sin_sum += img * np.sin(angle)
        cos_sum += img * np.cos(angle)

    return np.arctan2(-sin_sum, cos_sum)


def unwrap_phase(wrapped: np.ndarray, orientation: str) -> np.ndarray:
    """np.unwrap along the varying axis (x → axis=1, y → axis=0)."""
    if orientation == "x":
        axis = 1
    elif orientation == "y":
        axis = 0
    else:
        raise ValueError(f"orientation must be 'x' or 'y', got {orientation!r}")
    return np.unwrap(wrapped, axis=axis)


def remove_tilt(unwrapped: np.ndarray) -> np.ndarray:
    """Subtract the best-fit plane from a 2D phase map.

    Fits z = a*x + b*y + c via least-squares and returns the residual.
    This removes alignment tilt so the stats and colormap reflect actual
    surface shape rather than how well the part is levelled.
    """
    u = np.asarray(unwrapped, dtype=np.float64)
    h, w = u.shape
    yy, xx = np.mgrid[0:h, 0:w]
    # Build the (N, 3) design matrix [x, y, 1]
    A = np.column_stack([xx.ravel(), yy.ravel(), np.ones(h * w)])
    z = u.ravel()
    # Least-squares solve for [a, b, c]
    coeffs, _, _, _ = np.linalg.lstsq(A, z, rcond=None)
    plane = (coeffs[0] * xx + coeffs[1] * yy + coeffs[2])
    return u - plane


def compute_modulation(frames: list[np.ndarray]) -> np.ndarray:
    """Fringe modulation (contrast) map from N phase-shifted frames.

    Uses the generalized formula:
        modulation = (2/N) * sqrt((Σ Iₖ·sin(2πk/N))² + (Σ Iₖ·cos(2πk/N))²)

    For N=4 this reduces to sqrt((I3-I1)² + (I0-I2)²) / 2.

    High modulation = strong fringe signal = reliable phase.
    Low modulation = the reflected fringes are weak at that pixel (outside
    the iPad reflection, ambient light washing them out, clipped exposure).
    Returned as float64, same spatial shape as the input frames.
    """
    N = len(frames)
    if N < 3:
        raise ValueError(f"need at least 3 frames, got {N}")
    prepped = []
    for f in frames:
        arr = np.asarray(f, dtype=np.float64)
        if arr.ndim == 3:
            arr = arr.mean(axis=-1)
        prepped.append(arr)

    sin_sum = np.zeros_like(prepped[0])
    cos_sum = np.zeros_like(prepped[0])
    for k, img in enumerate(prepped):
        angle = 2.0 * np.pi * k / N
        sin_sum += img * np.sin(angle)
        cos_sum += img * np.cos(angle)

    return (2.0 / N) * np.sqrt(sin_sum ** 2 + cos_sum ** 2)


def create_modulation_mask(mod_x: np.ndarray, mod_y: np.ndarray, threshold_frac: float = 0.02) -> np.ndarray:
    """Create a boolean mask where True = valid part pixel.

    A pixel is valid if BOTH mod_x and mod_y exceed threshold_frac * max(respective_modulation).
    This naturally excludes non-specular background (anti-static mat, bare table, etc.)
    which scatters light and produces low fringe contrast.
    """
    thresh_x = threshold_frac * float(mod_x.max())
    thresh_y = threshold_frac * float(mod_y.max())
    return (mod_x > thresh_x) & (mod_y > thresh_y)


def phase_stats(unwrapped: np.ndarray, mask: np.ndarray | None = None) -> dict:
    """Return {'pv', 'rms', 'mean'} as plain Python floats.

    pv  = peak-to-valley (ptp)
    rms = sqrt(mean((u - mean(u))**2))
    mean = mean(u)

    If mask is provided, compute stats only over pixels where mask is True.
    If no valid pixels, return pv=0, rms=0, mean=0.
    """
    u = np.asarray(unwrapped, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        u = u[valid]
        if u.size == 0:
            return {"pv": 0.0, "rms": 0.0, "mean": 0.0}
    mean = float(u.mean())
    pv = float(u.max() - u.min())
    rms = float(np.sqrt(np.mean((u - mean) ** 2)))
    return {"pv": pv, "rms": rms, "mean": mean}


def compute_slope_magnitude(dzdx: np.ndarray, dzdy: np.ndarray,
                            mask: np.ndarray | None = None) -> np.ndarray:
    """Slope magnitude sqrt(dzdx^2 + dzdy^2).

    Returns float64 array. Masked pixels are set to NaN if mask is provided.
    """
    mag = np.sqrt(dzdx**2 + dzdy**2).astype(np.float64)
    if mask is not None:
        mag[~mask.astype(bool)] = np.nan
    return mag


def compute_curl_residual(dzdx: np.ndarray, dzdy: np.ndarray,
                          mask: np.ndarray | None = None) -> np.ndarray:
    """Curl of the slope field: d(dzdx)/dy - d(dzdy)/dx.

    For a physically valid surface, curl should be near zero everywhere.
    Large curl indicates unwrap errors, noise, or non-physical artifacts.
    Uses np.gradient for finite differences.

    Returns float64 array. Masked pixels are set to NaN if mask is provided.
    """
    curl = (np.gradient(dzdx, axis=0) - np.gradient(dzdy, axis=1)).astype(np.float64)
    if mask is not None:
        curl[~mask.astype(bool)] = np.nan
    return curl


def pseudocolor_png_b64(unwrapped: np.ndarray, mask: np.ndarray | None = None) -> str:
    """Min/max normalize to [0,255] uint8, apply VIRIDIS, PNG-encode, base64.

    Returns a base64 string with no 'data:' prefix. Constant-valued inputs
    are rendered as an all-zero image (avoiding div-by-zero).

    If mask is provided, masked-out pixels are rendered as black (value 0).
    Normalization only considers masked-in pixels.
    """
    u = np.asarray(unwrapped, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            umin = float(u[valid].min())
            umax = float(u[valid].max())
        else:
            umin = 0.0
            umax = 0.0
    else:
        umin = float(u.min())
        umax = float(u.max())
    if umax > umin:
        norm = (u - umin) * (255.0 / (umax - umin))
    else:
        norm = np.zeros_like(u)
    gray = np.clip(norm, 0, 255).astype(np.uint8)
    if mask is not None:
        gray[~valid] = 0
    colored = cv2.applyColorMap(gray, cv2.COLORMAP_VIRIDIS)
    if mask is not None:
        colored[~valid] = 0
    ok, buf = cv2.imencode(".png", colored)
    if not ok:
        raise RuntimeError("cv2.imencode failed for PNG output")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def diverging_png_b64(data: np.ndarray, mask: np.ndarray | None = None) -> str:
    """Render a diverging colormap (blue-white-red) centered on zero.

    Useful for curl residual and other signed quantities where zero is
    the expected value. Symmetric range: ±max(|data|).

    Returns a base64 PNG string (no 'data:' prefix).
    """
    d = np.asarray(data, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            vmax = float(np.nanmax(np.abs(d[valid])))
        else:
            vmax = 1.0
    else:
        vmax = float(np.nanmax(np.abs(d)))
    if vmax < 1e-15:
        vmax = 1.0
    # Normalize to [-1, 1], then map to [0, 255]
    norm = np.clip(d / vmax, -1, 1)
    # Blue (negative) → White (zero) → Red (positive)
    r = np.clip((norm + 1) * 127.5, 0, 255).astype(np.uint8)
    g = np.clip((1 - np.abs(norm)) * 255, 0, 255).astype(np.uint8)
    b = np.clip((1 - norm) * 127.5, 0, 255).astype(np.uint8)
    colored = np.stack([b, g, r], axis=-1)  # BGR for cv2
    if mask is not None:
        colored[~valid] = 0
    ok, buf = cv2.imencode(".png", colored)
    if not ok:
        raise RuntimeError("cv2.imencode failed for PNG output")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def fit_sphere_calibration(
    height: np.ndarray,
    mask: np.ndarray | None,
    sphere_radius_mm: float,
    mm_per_px: float,
) -> dict:
    """Fit a paraboloid to a height map and derive the phase-to-mm scale factor.

    For a sphere of radius R, the sag is z = (x² + y²) / (2R).
    We fit z_meas = a*(x² + y²) + bx + cy + d to the valid pixels,
    then solve for the calibration factor k such that z_mm = k * z_meas.

    Parameters
    ----------
    height : 2D array from frankot_chellappa (units: phase-radians).
    mask : boolean mask (True = valid).
    sphere_radius_mm : known radius of the calibration sphere.
    mm_per_px : lateral calibration (1 / pixelsPerMm).

    Returns
    -------
    dict with keys:
        cal_factor    : multiply any height map by this to get mm.
        cal_factor_um : same, but height map → µm.
        fitted_radius_mm : radius implied by the paraboloid fit (sanity check).
        residual_rms_um  : RMS of (measured − fitted paraboloid) in µm.
        center_px        : (cx, cy) center of fitted paraboloid in pixel coords.
    """
    h, w = height.shape
    yy, xx = np.mgrid[0:h, 0:w]

    if mask is not None:
        valid = mask.astype(bool)
    else:
        valid = ~np.isnan(height)

    xv = xx[valid].astype(np.float64)
    yv = yy[valid].astype(np.float64)
    zv = height[valid].astype(np.float64)

    if zv.size < 6:
        raise ValueError("Too few valid pixels for sphere fit")

    # Fit z = a*x² + b*y² + c*x + d*y + e
    # For a sphere a ≈ b, but we fit independently for robustness.
    A = np.column_stack([xv**2, yv**2, xv, yv, np.ones(len(xv))])
    coeffs, _, _, _ = np.linalg.lstsq(A, zv, rcond=None)
    a_x, a_y, b_x, b_y, const = coeffs

    # Average curvature (should be nearly equal for a sphere)
    a_avg = (a_x + a_y) / 2.0

    if abs(a_avg) < 1e-15:
        raise ValueError("Paraboloid fit has zero curvature — is there a sphere in the field?")

    # Physical curvature: 1/(2R) in mm per mm²
    # Measured curvature: a_avg in phase-rad per px²
    # z_mm = k * z_phase_rad
    # k * a_avg [rad/px²] = (mm_per_px²) / (2R)
    # k = mm_per_px² / (2 * R * a_avg)
    cal_factor = (mm_per_px ** 2) / (2.0 * sphere_radius_mm * a_avg)

    # Fitted radius as sanity check (should match input)
    fitted_radius_mm = (mm_per_px ** 2) / (2.0 * abs(a_avg) * abs(cal_factor))

    # Residual
    z_fit = coeffs[0] * xv**2 + coeffs[1] * yv**2 + coeffs[2] * xv + coeffs[3] * yv + coeffs[4]
    residual = (zv - z_fit) * abs(cal_factor) * 1000.0  # → µm
    residual_rms_um = float(np.sqrt(np.mean(residual ** 2)))

    # Paraboloid center in pixel coords: x0 = -c/(2a), y0 = -d/(2b)
    cx = -b_x / (2.0 * a_x) if abs(a_x) > 1e-15 else w / 2.0
    cy = -b_y / (2.0 * a_y) if abs(a_y) > 1e-15 else h / 2.0

    return {
        "cal_factor": float(cal_factor),
        "cal_factor_um": float(cal_factor * 1000.0),
        "fitted_radius_mm": float(fitted_radius_mm),
        "residual_rms_um": residual_rms_um,
        "center_px": [float(cx), float(cy)],
        "curvature_x": float(a_x),
        "curvature_y": float(a_y),
    }


def find_optimal_smooth_sigma(
    frame: np.ndarray,
    fringe_freq: int,
    candidates: list[float] | None = None,
    target_suppression: float = 0.05,
) -> float:
    """Find the minimum Gaussian sigma that suppresses LCD pixel grid noise.

    Takes a single grayscale fringe frame, computes the 1D power spectrum
    perpendicular to the fringes, and finds the smallest sigma where the
    high-frequency energy (above 2× the fringe frequency) drops below
    `target_suppression` of its unsmoothed level.

    Parameters
    ----------
    frame : 2D float array — a single grayscale (optionally flat-field-corrected) fringe frame
    fringe_freq : the number of fringe cycles displayed (what the user set)
    candidates : sigma values to try, default [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]
    target_suppression : fraction of original noise band energy to target (0.05 = 95% suppression)

    Returns
    -------
    float — recommended sigma (0.0 if no smoothing needed)
    """
    from scipy.ndimage import gaussian_filter

    if candidates is None:
        candidates = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]

    # Use power spectrum along rows (perpendicular to vertical fringes)
    # Average over all rows for robustness
    def high_freq_energy(img, cutoff_bin):
        """Mean power above cutoff frequency, averaged across rows."""
        spectrum = np.abs(np.fft.rfft(img, axis=1)) ** 2
        return spectrum[:, cutoff_bin:].mean()

    h, w = frame.shape[:2]
    # The fringe frequency in the image corresponds to fringe_freq cycles across the width
    # High-frequency noise is anything above 2x the fringe frequency
    cutoff_bin = min(2 * fringe_freq, w // 2)

    # Baseline: energy in the noise band without smoothing
    baseline = high_freq_energy(frame, cutoff_bin)
    if baseline < 1e-10:
        return 0.0  # No high-frequency content to suppress

    for sigma in candidates:
        if sigma == 0.0:
            smoothed = frame
        else:
            smoothed = gaussian_filter(frame, sigma=sigma)
        energy = high_freq_energy(smoothed, cutoff_bin)
        if energy / baseline <= target_suppression:
            return sigma

    # If none achieved target, return the largest candidate
    return candidates[-1]


def frankot_chellappa(dzdx: np.ndarray, dzdy: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    """Integrate two slope fields into a height map via Frankot-Chellappa (1988).

    Uses the FFT-based Poisson solver:
      Z(wx,wy) = (-j*wx*Sx(wx,wy) - j*wy*Sy(wx,wy)) / (wx^2 + wy^2)
    where Sx, Sy are the DFTs of dzdx, dzdy.

    The DC component (wx=wy=0) is set to zero (arbitrary height offset).

    If mask is provided, fill masked-out pixels with the mean of valid pixels
    before integration (masked regions would otherwise inject high-frequency
    noise into the FFT). The mask is reapplied to the output.

    Returns a real-valued height map in the same units as the input slopes
    (radians for our phase maps -- physical calibration is a separate step).
    """
    h, w = dzdx.shape
    # Frequency grids
    wx = 2 * np.pi * np.fft.fftfreq(w)  # shape (w,)
    wy = 2 * np.pi * np.fft.fftfreq(h)  # shape (h,)
    WX, WY = np.meshgrid(wx, wy)

    # Fill masked pixels with mean to reduce FFT ringing
    if mask is not None:
        valid = mask.astype(bool)
        dx_filled = dzdx.copy()
        dy_filled = dzdy.copy()
        if valid.any():
            dx_filled[~valid] = dzdx[valid].mean()
            dy_filled[~valid] = dzdy[valid].mean()
        dzdx_work, dzdy_work = dx_filled, dy_filled
    else:
        dzdx_work, dzdy_work = dzdx, dzdy

    Sx = np.fft.fft2(dzdx_work)
    Sy = np.fft.fft2(dzdy_work)

    denom = WX**2 + WY**2
    denom[0, 0] = 1.0  # avoid div by zero at DC

    Z = (-1j * WX * Sx - 1j * WY * Sy) / denom
    Z[0, 0] = 0.0  # DC = arbitrary offset

    height = np.real(np.fft.ifft2(Z))

    if mask is not None:
        height[~valid] = np.nan

    return height
