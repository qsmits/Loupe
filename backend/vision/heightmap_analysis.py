"""Height-map analysis: detrending, profile, roughness, filtering, PSD, bearing.

Subtracts stage tilt (plane mode) or tilt + lens curvature (poly2 mode) from
a depth-from-focus height map.  The current Mitutoyo + 0.5x C-mount optics
bow the height map visibly even on a flat part, so poly2 is what the user
actually runs in practice; plane is there for genuinely flat-optics setups.

Also provides ISO 25178-3 Gaussian S/L spatial filtering, ISO 25178-606
noise floor characterization, bearing ratio (Abbott-Firestone) curve, and
power spectral density (PSD) for height maps.

Kept intentionally free of app imports so all analysis features can reuse
these fits with a mask argument.
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


def compute_roughness_1d(z: np.ndarray) -> dict:
    """ISO 4287 1D roughness on an already-detrended profile.

    Rz here is reported as Rt (max peak-to-valley over the whole profile)
    rather than the true ten-point mean over sampling lengths — fine for
    small-part metrology where the profile is already a selected feature.
    Skewness/kurtosis use the plain moment definitions (no N/(N-1) bias
    correction — at our typical 100-1000 samples the difference is noise).
    """
    z = np.asarray(z, dtype=np.float64).reshape(-1)
    n = int(z.size)
    if n < 2:
        return {"Ra": 0.0, "Rq": 0.0, "Rp": 0.0, "Rv": 0.0, "Rt": 0.0,
                "Rz": 0.0, "Rsk": 0.0, "Rku": 0.0, "count": n}
    mu = float(z.mean())
    d = z - mu
    Ra = float(np.abs(d).mean())
    Rq = float(np.sqrt((d * d).mean()))
    Rp = float(d.max())
    Rv = float(-d.min())
    Rt = Rp + Rv
    sigma = Rq
    if sigma > 1e-15:
        Rsk = float((d ** 3).mean() / (sigma ** 3))
        Rku = float((d ** 4).mean() / (sigma ** 4) - 3.0)
    else:
        Rsk = 0.0
        Rku = 0.0
    return {
        "Ra": Ra, "Rq": Rq, "Rp": Rp, "Rv": Rv, "Rt": Rt,
        "Rz": Rt, "Rsk": Rsk, "Rku": Rku, "count": n,
    }


def compute_roughness_2d(z: np.ndarray) -> dict:
    """ISO 25178-2 areal roughness on an already-detrended HxW region.

    Returns height parameters Sa, Sq, Sp, Sv, Sz, Ssk, Sku.
    """
    z = np.asarray(z, dtype=np.float64)
    n = int(z.size)
    if n < 2:
        return {"Sa": 0.0, "Sq": 0.0, "Sp": 0.0, "Sv": 0.0, "Sz": 0.0,
                "Ssk": 0.0, "Sku": 0.0, "count": n}
    mu = float(z.mean())
    d = z - mu
    Sa = float(np.abs(d).mean())
    Sq = float(np.sqrt((d * d).mean()))
    Sp = float(d.max())
    Sv = float(-d.min())
    Sz = Sp + Sv
    if Sq > 1e-15:
        Ssk = float((d ** 3).mean() / (Sq ** 3))
        Sku = float((d ** 4).mean() / (Sq ** 4))
    else:
        Ssk = 0.0
        Sku = 0.0
    return {"Sa": Sa, "Sq": Sq, "Sp": Sp, "Sv": Sv, "Sz": Sz,
            "Ssk": Ssk, "Sku": Sku, "count": n}


# ── ISO 25178-3: Gaussian S-filter / L-filter ────────────────────────────────

def _gaussian_kernel_size(sigma_px: float) -> int:
    """Kernel size for OpenCV GaussianBlur — must be odd, >= 3."""
    k = max(3, int(2 * round(3 * sigma_px) + 1))
    if k % 2 == 0:
        k += 1
    return k


def gaussian_filter_surface(
    z: np.ndarray, cutoff_mm: float, spacing_mm: float
) -> np.ndarray:
    """ISO 25178-3 Gaussian filter on a 2D height map.

    The Gaussian transfer function at the cutoff wavelength λc is 50%,
    which corresponds to σ = λc / (2π × √(2 ln 2)) ≈ λc / 2.9477.
    ``spacing_mm`` is the lateral distance per pixel (1 / px_per_mm).
    """
    if cutoff_mm <= 0 or spacing_mm <= 0:
        return z.copy()
    sigma_mm = cutoff_mm / (2.0 * np.pi * np.sqrt(2.0 * np.log(2.0)))
    sigma_px = sigma_mm / spacing_mm
    if sigma_px < 0.5:
        return z.copy()
    k = _gaussian_kernel_size(sigma_px)
    z_f = z.astype(np.float64)
    return cv2.GaussianBlur(z_f, (k, k), sigma_px, sigma_px).astype(np.float32)


def gaussian_filter_profile(
    z: np.ndarray, cutoff_mm: float, spacing_mm: float
) -> np.ndarray:
    """ISO 25178-3 Gaussian filter on a 1D profile array."""
    if cutoff_mm <= 0 or spacing_mm <= 0:
        return z.copy()
    sigma_mm = cutoff_mm / (2.0 * np.pi * np.sqrt(2.0 * np.log(2.0)))
    sigma_px = sigma_mm / spacing_mm
    if sigma_px < 0.5:
        return z.copy()
    z_f = z.astype(np.float64).reshape(-1)
    k = _gaussian_kernel_size(sigma_px)
    # Use cv2.GaussianBlur on a 1×N "image"
    row = z_f.reshape(1, -1)
    out = cv2.GaussianBlur(row, (k, 1), sigma_px, 0).reshape(-1)
    # Also blur along the only axis
    out = cv2.GaussianBlur(out.reshape(-1, 1), (1, k), 0, sigma_px).reshape(-1)
    # Actually, for 1D we need a 1D blur. Let's use a direct approach:
    return _gauss_1d(z_f, sigma_px).astype(np.float32)


def _gauss_1d(z: np.ndarray, sigma_px: float) -> np.ndarray:
    """1D Gaussian filter via convolution."""
    k = _gaussian_kernel_size(sigma_px)
    half = k // 2
    x = np.arange(-half, half + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (x / sigma_px) ** 2)
    kernel /= kernel.sum()
    # Reflect-pad to handle boundaries
    padded = np.pad(z, half, mode="reflect")
    return np.convolve(padded, kernel, mode="valid")


def apply_sl_filter(
    z: np.ndarray, spacing_mm: float,
    s_cutoff_mm: float = 0.0, l_cutoff_mm: float = 0.0,
    is_profile: bool = False,
) -> np.ndarray:
    """Apply S-filter and/or L-filter per ISO 25178-3.

    S-filter (high-pass) removes wavelengths shorter than s_cutoff_mm — noise.
    L-filter (low-pass) removes wavelengths longer than l_cutoff_mm — waviness.
    The roughness band is what remains between S and L.

    For a profile (1D), set ``is_profile=True``.
    """
    z_out = np.asarray(z, dtype=np.float32).copy()
    if s_cutoff_mm > 0 and spacing_mm > 0:
        if is_profile:
            z_out = gaussian_filter_profile(z_out, s_cutoff_mm, spacing_mm)
        else:
            z_out = gaussian_filter_surface(z_out, s_cutoff_mm, spacing_mm)
    if l_cutoff_mm > 0 and spacing_mm > 0:
        if is_profile:
            smoothed = gaussian_filter_profile(z_out, l_cutoff_mm, spacing_mm)
        else:
            smoothed = gaussian_filter_surface(z_out, l_cutoff_mm, spacing_mm)
        z_out = z_out - smoothed + float(z_out.mean())
    return z_out


# ── Noise floor characterization ─────────────────────────────────────────────

def compute_noise_floor(z: np.ndarray) -> dict:
    """Compute measurement noise on a flat reference surface.

    Returns Sq (RMS noise) and peak-to-valley noise range.
    The input should be a detrended height map of a known-flat surface.
    """
    z = np.asarray(z, dtype=np.float64)
    mu = float(z.mean())
    d = z - mu
    Sq = float(np.sqrt((d * d).mean()))
    pv = float(d.max() - d.min())
    return {"Sq_noise": Sq, "pv_noise": pv, "count": int(z.size)}


# ── Bearing ratio curve (Abbott-Firestone / material ratio) ──────────────────

def compute_bearing_ratio(
    z: np.ndarray, n_levels: int = 256
) -> dict:
    """Abbott-Firestone / material ratio curve.

    Returns heights from top to bottom and the cumulative material ratio
    at each height (0 = no material above, 1 = all material above).
    Also returns Smr1, Smr2 (material ratios at the core roughness
    boundaries) using the ISO 13565-2 secant method.
    """
    z = np.asarray(z, dtype=np.float64).ravel()
    z_min, z_max = float(z.min()), float(z.max())
    if z_max - z_min < 1e-15:
        return {
            "heights": [z_min],
            "ratios": [1.0],
            "Smr1": 0.0,
            "Smr2": 1.0,
            "Spk": 0.0,
            "Sk": 0.0,
            "Svk": 0.0,
        }
    heights = np.linspace(z_max, z_min, n_levels)
    ratios = np.array([float(np.count_nonzero(z >= h) / z.size) for h in heights])

    # ISO 13565-2 secant method for Spk/Sk/Svk:
    # Find the 40% secant line that has the smallest slope (flattest part
    # of the bearing curve = core roughness). The secant spans 40% of the
    # material ratio axis.
    best_slope = np.inf
    best_i = 0
    window = max(1, int(0.4 * n_levels))
    for i in range(n_levels - window):
        dh = heights[i] - heights[i + window]
        dr = ratios[i + window] - ratios[i]
        if dr > 0:
            slope = abs(dh / dr)
            if slope < best_slope:
                best_slope = slope
                best_i = i
    # Core band
    smr1_idx = best_i
    smr2_idx = min(best_i + window, n_levels - 1)
    Smr1 = float(ratios[smr1_idx])
    Smr2 = float(ratios[smr2_idx])
    core_top = float(heights[smr1_idx])
    core_bot = float(heights[smr2_idx])
    Sk = core_top - core_bot
    # Peak height: area above Smr1 line
    Spk = float(heights[0]) - core_top
    # Valley depth: area below Smr2 line
    Svk = core_bot - float(heights[-1])

    return {
        "heights": [round(float(h), 9) for h in heights],
        "ratios": [round(float(r), 6) for r in ratios],
        "Smr1": round(Smr1, 6),
        "Smr2": round(Smr2, 6),
        "Spk": round(float(Spk), 9),
        "Sk": round(float(Sk), 9),
        "Svk": round(float(Svk), 9),
    }


# ── Power Spectral Density (PSD) ─────────────────────────────────────────────

def compute_psd_1d(z: np.ndarray, spacing_mm: float) -> dict:
    """1D power spectral density of a height profile.

    Returns spatial frequencies (1/mm) and PSD values (mm³).
    Uses a Hann window to reduce spectral leakage.
    """
    z = np.asarray(z, dtype=np.float64).ravel()
    n = len(z)
    if n < 4 or spacing_mm <= 0:
        return {"frequencies": [], "psd": [], "unit": "mm^3"}
    # Subtract mean, apply Hann window
    z_centered = z - z.mean()
    window = np.hanning(n)
    z_windowed = z_centered * window
    # Normalization: correct for windowing power loss
    win_power = float((window ** 2).mean())
    # FFT
    fft_vals = np.fft.rfft(z_windowed)
    freqs = np.fft.rfftfreq(n, d=spacing_mm)
    # PSD: |FFT|² × spacing / (N × win_power), one-sided so ×2 (except DC and Nyquist)
    psd = (np.abs(fft_vals) ** 2) * spacing_mm / (n * win_power)
    psd[1:-1] *= 2.0  # one-sided doubling
    # Skip DC
    freqs = freqs[1:]
    psd = psd[1:]
    return {
        "frequencies": [round(float(f), 6) for f in freqs],
        "psd": [float(p) for p in psd],
        "unit": "mm^3",
    }


def compute_psd_2d(z: np.ndarray, spacing_x_mm: float, spacing_y_mm: float = 0.0) -> dict:
    """2D (areal) power spectral density of a height map.

    Returns radially averaged PSD: spatial frequencies (1/mm) and PSD (mm⁴).
    """
    z = np.asarray(z, dtype=np.float64)
    h, w = z.shape
    if h < 4 or w < 4 or spacing_x_mm <= 0:
        return {"frequencies": [], "psd": [], "unit": "mm^4"}
    if spacing_y_mm <= 0:
        spacing_y_mm = spacing_x_mm
    z_centered = z - z.mean()
    # 2D Hann window
    wy = np.hanning(h).reshape(-1, 1)
    wx = np.hanning(w).reshape(1, -1)
    window = wy * wx
    z_windowed = z_centered * window
    win_power = float((window ** 2).mean())
    # 2D FFT
    fft_2d = np.fft.fft2(z_windowed)
    fft_shift = np.fft.fftshift(fft_2d)
    psd_2d = (np.abs(fft_shift) ** 2) * (spacing_x_mm * spacing_y_mm) / (h * w * win_power)
    # Frequency grids
    fy = np.fft.fftshift(np.fft.fftfreq(h, d=spacing_y_mm))
    fx = np.fft.fftshift(np.fft.fftfreq(w, d=spacing_x_mm))
    FX, FY = np.meshgrid(fx, fy)
    FR = np.sqrt(FX ** 2 + FY ** 2)
    # Radial averaging
    f_max = min(1.0 / (2 * spacing_x_mm), 1.0 / (2 * spacing_y_mm))
    n_bins = min(128, max(h, w) // 2)
    f_edges = np.linspace(0, f_max, n_bins + 1)
    f_centers = 0.5 * (f_edges[:-1] + f_edges[1:])
    psd_radial = np.zeros(n_bins)
    for i in range(n_bins):
        mask = (FR >= f_edges[i]) & (FR < f_edges[i + 1])
        if mask.any():
            psd_radial[i] = float(psd_2d[mask].mean())
    # Skip DC bin
    return {
        "frequencies": [round(float(f), 6) for f in f_centers[1:]],
        "psd": [float(p) for p in psd_radial[1:]],
        "unit": "mm^4",
    }


# ── ISO 25178-2: Spatial / texture parameters (Sal, Str, Std) ──────────────

def compute_texture_params(
    z: np.ndarray, spacing_mm: float
) -> dict:
    """ISO 25178-2 spatial texture parameters from the 2D autocorrelation.

    Parameters
    ----------
    z : 2D height map (already detrended).
    spacing_mm : lateral pixel spacing in mm.

    Returns
    -------
    dict with Sal, Str, Std (or None where undetermined).
      - Sal: fastest autocorrelation decay length to 0.2 (mm)
      - Str: texture aspect ratio (0 = directional, 1 = isotropic)
      - Std: dominant texture direction (degrees, 0–180)
    """
    z = np.asarray(z, dtype=np.float64)
    h, w = z.shape
    if h < 8 or w < 8 or spacing_mm <= 0:
        return {"Sal": None, "Str": None, "Std": None}

    z_centered = z - z.mean()

    # 2D autocorrelation via FFT (Wiener-Khinchin)
    fft2 = np.fft.fft2(z_centered)
    acf = np.fft.ifft2(np.abs(fft2) ** 2).real
    acf = np.fft.fftshift(acf)
    # Normalize so center (zero-lag) = 1.0
    center_val = acf[h // 2, w // 2]
    if center_val < 1e-15:
        return {"Sal": None, "Str": None, "Std": None}
    acf /= center_val

    # Build distance map from center (in mm)
    cy, cx = h // 2, w // 2
    ys, xs = np.indices((h, w), dtype=np.float64)
    dist_mm = np.sqrt(((xs - cx) * spacing_mm) ** 2 + ((ys - cy) * spacing_mm) ** 2)

    # Sal: shortest distance where ACF drops to <= 0.2
    # Search radially in all directions — find per-direction decay, take minimum
    threshold = 0.2
    n_angles = 180
    angles = np.linspace(0, np.pi, n_angles, endpoint=False)
    max_radius_px = min(cx, cy)
    decay_dists = []  # distance in mm where ACF first <= threshold, per angle

    for angle in angles:
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        for r in range(1, max_radius_px):
            px = int(round(cx + r * cos_a))
            py = int(round(cy + r * sin_a))
            if 0 <= px < w and 0 <= py < h:
                if acf[py, px] <= threshold:
                    decay_dists.append((r * spacing_mm, angle))
                    break

    if not decay_dists:
        return {"Sal": None, "Str": None, "Std": None}

    dists_only = [d for d, _ in decay_dists]
    Sal = float(min(dists_only))
    max_decay = float(max(dists_only))
    Str = float(Sal / max_decay) if max_decay > 0 else None

    # Std: dominant texture direction from the angular PSD
    # The direction with the slowest ACF decay (longest correlation) is the
    # texture direction.  This corresponds to the angle where the PSD is
    # strongest.
    slowest_angle = max(decay_dists, key=lambda x: x[0])[1]
    # Convert to degrees (0–180, measured from X axis)
    Std = float(np.degrees(slowest_angle)) % 180.0

    return {
        "Sal": round(Sal, 6),
        "Str": round(Str, 6) if Str is not None else None,
        "Std": round(Std, 2),
    }
