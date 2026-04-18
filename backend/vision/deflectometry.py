"""Deflectometry computation primitives.

Pure functions for fringe generation, N-step phase shifting (generalized
from 4-step to support 8-step harmonic suppression), phase unwrapping,
statistics, and pseudocolor visualization. No state, no I/O beyond PNG
encoding for the visualization helper.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timezone

import cv2
import numpy as np


def generate_fringe_pattern(
    width: int, height: int, phase: float, freq: int, orientation: str,
    gamma: float = 1.0,
    inverse_lut: np.ndarray | None = None,
) -> np.ndarray:
    """Return an (H, W) uint8 sinusoidal fringe image.

    I(x, y) = 127 + 127 * cos(2π * freq * coord / extent + phase)

    orientation='x' → varies along axis 1 (width), producing vertical stripes.
    orientation='y' → varies along axis 0 (height), producing horizontal stripes.

    If gamma != 1.0, apply inverse gamma pre-correction so that a display
    with the given gamma curve produces linear sinusoidal light output:
      corrected = 255 * (v/255)^(1/gamma)

    NOTE on gamma in the live pipeline (audit, 2026-04):
    This function is NOT used by the live iPad capture path. The capture
    endpoints in ``backend.api_deflectometry`` send only the pattern
    parameters (freq, phase, orientation, gamma) over the WebSocket; the
    iPad client (``frontend/deflectometry-screen.html::renderPattern``)
    generates the pattern locally and applies the inverse-gamma there.
    Gamma is therefore applied exactly once in the live pipeline (on the
    iPad). The gamma/LUT branches below are exercised only by tests and
    standalone synthetic-frame callers (e.g. test_deflectometry_api.py,
    test_deflectometry_envelope.py); keep them for those callers.
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

    if inverse_lut is not None:
        idx = np.clip(np.round(wave).astype(int), 0, 255)
        wave = inverse_lut[idx].astype(np.float64)
    elif gamma != 1.0:
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


def _irls_fit(
    design_matrix: np.ndarray,
    target: np.ndarray,
    max_iter: int = 50,
    tol: float = 1e-6,
    c1: float = 4.685,
    c2: float = 0.6745,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Iteratively reweighted least squares with Tukey bisquare weights.

    Solves a linear fit ``Phi @ c ≈ y`` that is robust to outliers. Outlier
    pixels (bright specks, dust, edge clipping, surface defects) receive
    shrinking weights across iterations and ultimately contribute little to
    the fitted coefficients, unlike plain LS where a single bright speck can
    drag the whole fit.

    Algorithm (adapted from Sandia OpenCSP's ``fit_slope_robust_ls``):

        1. Start with uniform weights w_i = 1.
        2. Solve the weighted normal equations (Φ^T W Φ) c = Φ^T W y.
        3. Compute residuals r = y - Φ c.
        4. Standardize residuals by the weighted hat-diagonal leverage and
           the MAD-based robust scale ``scale = median(|r_adj - median|)/c2``.
        5. Tukey bisquare weights: w = (1 - (r/(c1·scale))²)² for |r|<c1·scale,
           else 0.
        6. Iterate until ``max(|Δweights|) < tol`` or ``max_iter`` reached.

    Parameters
    ----------
    design_matrix : (N, k) array.
    target : (N,) array.
    max_iter : iteration cap (default 50).
    tol : convergence tolerance on max(|Δweights|) (default 1e-6).
    c1 : Tukey bisquare tuning constant (default 4.685, 95% Gaussian efficiency).
    c2 : MAD-to-σ conversion constant (default 0.6745).

    Returns
    -------
    coefficients : (k,) coefficient vector.
    weights : (N,) final weights in [0, 1]. 0 = outlier, 1 = inlier.
    standardized_residuals : (N,) residuals divided by (c1·scale). |r|<1 ⇒ inlier,
        |r|≥1 ⇒ outlier.
    """
    Phi = np.asarray(design_matrix, dtype=np.float64)
    y = np.asarray(target, dtype=np.float64).ravel()
    if Phi.ndim != 2 or Phi.shape[0] != y.shape[0]:
        raise ValueError(
            f"design_matrix shape {Phi.shape} incompatible with target shape {y.shape}"
        )

    N, k = Phi.shape
    weights = np.ones(N, dtype=np.float64)
    coeffs = np.zeros(k, dtype=np.float64)
    res_std = np.zeros(N, dtype=np.float64)

    for _ in range(max_iter):
        # Weighted least squares via sqrt-weight scaling (numerically stable).
        sw = np.sqrt(weights)
        Aw = Phi * sw[:, None]
        bw = y * sw
        AtA = Aw.T @ Aw
        Atb = Aw.T @ bw
        try:
            coeffs = np.linalg.solve(AtA, Atb)
        except np.linalg.LinAlgError:
            coeffs, *_ = np.linalg.lstsq(Aw, bw, rcond=None)

        residuals = y - Phi @ coeffs

        # Weighted hat-diagonal H_ii = w_i * phi_i^T (Phi^T W Phi)^{-1} phi_i
        # We standardize residuals by sqrt(1 - H_ii) so high-leverage points
        # don't masquerade as inliers just because the fit is pinned to them.
        try:
            AtA_inv = np.linalg.inv(AtA)
            hat_diag = weights * np.einsum("ij,jk,ik->i", Phi, AtA_inv, Phi)
        except np.linalg.LinAlgError:
            hat_diag = np.zeros(N, dtype=np.float64)

        one_minus_h = np.maximum(1.0 - hat_diag, 1e-10)
        res_adj = residuals / np.sqrt(one_minus_h)

        med = np.median(res_adj)
        scale = np.median(np.abs(res_adj - med)) / c2

        if scale < 1e-12:
            # Clean fit — all residuals essentially zero
            weights = np.ones(N, dtype=np.float64)
            res_std = np.zeros(N, dtype=np.float64)
            return coeffs, weights, res_std

        res_std = res_adj / (c1 * scale)
        new_weights = np.where(
            np.abs(res_std) < 1.0,
            (1.0 - res_std ** 2) ** 2,
            0.0,
        )

        if np.max(np.abs(new_weights - weights)) < tol:
            weights = new_weights
            break
        weights = new_weights

    return coeffs, weights, res_std


def remove_tilt(
    unwrapped: np.ndarray,
    return_residual_map: bool = False,
) -> np.ndarray | tuple[np.ndarray, np.ndarray]:
    """Subtract the best-fit plane (Tukey bisquare IRLS) from a 2D phase map.

    Fits z = a*x + b*y + c via robust iteratively-reweighted least squares
    and returns the residual. This removes alignment tilt so the stats and
    colormap reflect actual surface shape rather than how well the part is
    levelled.

    Pre-2026-04-18 this was plain ``np.linalg.lstsq`` — a single bright
    scratch, a dust speck, or an edge-clipping artifact could drag the plane
    fit off the true mean plane. The IRLS version downweights such outliers;
    surface features no longer bias the tilt correction.

    Parameters
    ----------
    unwrapped : 2D phase map.
    return_residual_map : if True, also return an (H, W) map of standardized
        residuals from the robust fit. |r| < 1 = pixel consistent with the
        plane (inlier); |r| ≥ 1 = outlier candidate (surface feature, dust,
        defect, edge artifact).

    Returns
    -------
    If ``return_residual_map`` is False (default): the (H, W) detrended map.
    If True: tuple ``(detrended, standardized_residual_map)``.
    """
    u = np.asarray(unwrapped, dtype=np.float64)
    h, w = u.shape
    yy, xx = np.mgrid[0:h, 0:w]
    A = np.column_stack([xx.ravel(), yy.ravel(), np.ones(h * w)])
    z = u.ravel()
    coeffs, _weights, res_std = _irls_fit(A, z)
    plane = (coeffs[0] * xx + coeffs[1] * yy + coeffs[2])
    detrended = u - plane
    if return_residual_map:
        return detrended, res_std.reshape(h, w)
    return detrended


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


def compute_quality_summary(
    dzdx: np.ndarray, dzdy: np.ndarray, mask: np.ndarray,
    mod_x: np.ndarray, mod_y: np.ndarray,
    frames_x: list[np.ndarray], frames_y: list[np.ndarray],
    curl_fair: float = 0.05, curl_poor: float = 0.2,
) -> dict:
    """Compute a quality summary for a deflectometry measurement.

    Returns dict with modulation_coverage, modulation_x_median,
    modulation_y_median, clipped_fraction, curl_rms, curl_max,
    mask_valid_frac, overall ('good'/'fair'/'poor'), and warnings list.
    """
    valid = mask.astype(bool)
    n_valid = int(valid.sum())
    n_total = int(mask.size)
    mask_valid_frac = n_valid / max(n_total, 1)

    # Modulation stats over valid region
    mod_x_median = float(np.median(mod_x[valid])) if n_valid > 0 else 0.0
    mod_y_median = float(np.median(mod_y[valid])) if n_valid > 0 else 0.0
    modulation_coverage = 100.0 * mask_valid_frac

    # Clipped pixel fraction: any frame pixel at 0 or 255 within mask
    clipped = np.zeros(mask.shape, dtype=bool)
    for f in frames_x + frames_y:
        arr = np.asarray(f)
        clipped |= (arr <= 0.5) | (arr >= 254.5)
    clipped_in_mask = clipped & valid
    clipped_fraction = 100.0 * float(clipped_in_mask.sum()) / max(n_valid, 1)

    # Curl residual
    curl = compute_curl_residual(dzdx, dzdy)
    if n_valid > 0:
        curl_valid = curl[valid]
        curl_rms = float(np.sqrt(np.mean(curl_valid**2)))
        curl_max = float(np.max(np.abs(curl_valid)))
    else:
        curl_rms = 0.0
        curl_max = 0.0

    # Warnings
    warnings = []
    if modulation_coverage < 50:
        warnings.append("Less than half the image has usable signal.")
    mod_max = max(mod_x_median, mod_y_median, 1e-10)
    mod_diff = abs(mod_x_median - mod_y_median) / mod_max
    if mod_diff > 0.2:
        low_axis = "Y" if mod_y_median < mod_x_median else "X"
        warnings.append(
            f"{low_axis} modulation is {mod_diff*100:.0f}% lower -- "
            f"check fringe contrast and display orientation."
        )
    if clipped_fraction > 5:
        warnings.append(
            f"{clipped_fraction:.0f}% of pixels are clipped -- "
            f"reduce exposure or display brightness."
        )
    if curl_rms > curl_fair:
        warnings.append(
            "Integration residual is elevated -- "
            "check surface map for artifacts."
        )

    # Overall — "good" additionally requires no warnings (conservative:
    # if any warning fired, the result shouldn't be labeled "good")
    if (modulation_coverage < 30 or curl_rms > curl_poor
            or clipped_fraction > 20):
        overall = "poor"
    elif (modulation_coverage >= 70 and curl_rms < curl_fair
            and clipped_fraction < 5 and not warnings):
        overall = "good"
    else:
        overall = "fair"

    return {
        "modulation_coverage": round(modulation_coverage, 1),
        "modulation_x_median": round(mod_x_median, 1),
        "modulation_y_median": round(mod_y_median, 1),
        "clipped_fraction": round(clipped_fraction, 1),
        "curl_rms": round(curl_rms, 4),
        "curl_max": round(curl_max, 4),
        "mask_valid_frac": round(mask_valid_frac, 3),
        "overall": overall,
        "warnings": warnings,
    }


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
    # Piecewise linear: neg lerps blue→white, pos lerps white→red
    r = np.where(norm >= 0, 255, np.clip((norm + 1) * 255, 0, 255)).astype(np.uint8)
    g = np.clip((1 - np.abs(norm)) * 255, 0, 255).astype(np.uint8)
    b = np.where(norm <= 0, 255, np.clip((1 - norm) * 255, 0, 255)).astype(np.uint8)
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

    The fit is robust to dust, edge clipping, and surface defects via
    Tukey bisquare IRLS. Pre-2026-04-18 this was plain least squares, where
    a single bright speck or edge artifact could drag ``cal_factor`` far
    from its true value.

    Returns
    -------
    dict with keys:
        cal_factor    : multiply any height map by this to get mm.
        cal_factor_um : same, but height map → µm.
        fitted_radius_mm : radius implied by the paraboloid fit (sanity check).
        residual_rms_um  : RMS of (measured − fitted paraboloid) in µm
                           (over ALL valid pixels, as before — kept for
                           backward compatibility).
        residual_rms_um_robust : RMS over inliers only (weight ≥ 0.5).
        outlier_fraction : 1 − mean(weights). 0 ⇒ perfect fit, 1 ⇒ all outliers.
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

    # Fit z = a*x² + b*y² + c*x + d*y + e via robust IRLS.
    # For a sphere a ≈ b, but we fit independently for robustness.
    A = np.column_stack([xv**2, yv**2, xv, yv, np.ones(len(xv))])
    coeffs, fit_weights, _res_std = _irls_fit(A, zv)
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

    # Robust residual: inliers only (weight ≥ 0.5 → |r_std| ≤ ~0.293)
    inlier_mask = fit_weights >= 0.5
    if inlier_mask.any():
        residual_rms_um_robust = float(np.sqrt(np.mean(residual[inlier_mask] ** 2)))
    else:
        residual_rms_um_robust = residual_rms_um

    outlier_fraction = float(1.0 - fit_weights.mean())

    # Paraboloid center in pixel coords: x0 = -c/(2a), y0 = -d/(2b)
    cx = -b_x / (2.0 * a_x) if abs(a_x) > 1e-15 else w / 2.0
    cy = -b_y / (2.0 * a_y) if abs(a_y) > 1e-15 else h / 2.0

    return {
        "cal_factor": float(cal_factor),
        "cal_factor_um": float(cal_factor * 1000.0),
        "fitted_radius_mm": float(fitted_radius_mm),
        "residual_rms_um": residual_rms_um,
        "residual_rms_um_robust": residual_rms_um_robust,
        "outlier_fraction": outlier_fraction,
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


def build_response_lut(commanded: np.ndarray, observed: np.ndarray,
                       n: int = 256) -> tuple[np.ndarray, np.ndarray]:
    """Build forward and inverse display response lookup tables.

    Parameters
    ----------
    commanded : 1D array of display values sent (0-255 scale).
    observed  : 1D array of camera intensities measured for each commanded value.
    n         : LUT size (default 256).

    Returns
    -------
    (forward_lut, inverse_lut) — both uint8 arrays of length *n*.
    forward_lut[cmd] = expected observed value for commanded value *cmd*.
    inverse_lut[desired] = commanded value needed to produce observed *desired*.
    """
    commanded = np.asarray(commanded, dtype=np.float64)
    observed = np.asarray(observed, dtype=np.float64)

    if len(commanded) != len(observed):
        raise ValueError(
            f"commanded and observed must have the same length, "
            f"got {len(commanded)} and {len(observed)}"
        )
    if np.all(observed == 0):
        raise ValueError(
            "All observed values are zero — check camera exposure "
            "and that the display is visible"
        )

    # Normalize both to 0-255 range
    if observed.max() > 0:
        observed = observed / observed.max() * 255.0

    # Sort by commanded value
    order = np.argsort(commanded)
    commanded = commanded[order]
    observed = observed[order]

    # Ensure monotonicity
    for i in range(1, len(observed)):
        if observed[i] < observed[i - 1]:
            observed[i] = observed[i - 1]

    # Interpolate forward LUT: commanded -> observed
    x_out = np.linspace(0, 255, n)
    forward = np.interp(x_out, commanded, observed)
    forward_lut = np.clip(np.round(forward), 0, 255).astype(np.uint8)

    # Interpolate inverse LUT: desired observed -> required commanded
    obs_unique, idx = np.unique(forward_lut, return_index=True)
    cmd_unique = x_out[idx]
    inverse = np.interp(x_out, obs_unique.astype(np.float64), cmd_unique)
    inverse_lut = np.clip(np.round(inverse), 0, 255).astype(np.uint8)

    return forward_lut, inverse_lut


def analyze_display_check(frame: np.ndarray) -> dict:
    """Analyze a captured sanity-check pattern to verify display setup.

    Detects 4 bright corner markers on a dark background.
    Returns coverage, rotation, crop, and status assessment.
    """
    if frame.ndim == 3:
        gray = frame.mean(axis=2).astype(np.uint8)
    else:
        gray = frame

    h, w = gray.shape

    # Threshold to find bright regions
    thresh_val = max(50, int(gray.max() * 0.5))
    _, binary = cv2.threshold(gray, thresh_val, 255, cv2.THRESH_BINARY)

    # Find contours
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Filter by area
    min_area = 10
    max_area = max(2000, h * w * 0.01)
    blobs = []
    for c in contours:
        area = cv2.contourArea(c)
        if min_area <= area <= max_area:
            M = cv2.moments(c)
            if M["m00"] > 0:
                cx = M["m10"] / M["m00"]
                cy = M["m01"] / M["m00"]
                blobs.append((cx, cy, area))

    # Assign blobs to quadrants
    mid_x, mid_y = w / 2, h / 2
    quadrants = {"tl": None, "tr": None, "bl": None, "br": None}
    for cx, cy, area in blobs:
        if cx < mid_x and cy < mid_y:
            if quadrants["tl"] is None or area > quadrants["tl"][2]:
                quadrants["tl"] = (cx, cy, area)
        elif cx >= mid_x and cy < mid_y:
            if quadrants["tr"] is None or area > quadrants["tr"][2]:
                quadrants["tr"] = (cx, cy, area)
        elif cx < mid_x and cy >= mid_y:
            if quadrants["bl"] is None or area > quadrants["bl"][2]:
                quadrants["bl"] = (cx, cy, area)
        else:
            if quadrants["br"] is None or area > quadrants["br"][2]:
                quadrants["br"] = (cx, cy, area)

    found = {k: v for k, v in quadrants.items() if v is not None}
    corners_found = len(found)

    warnings = []
    rotation_deg = 0.0
    coverage_fraction = 0.0
    bounding_rect = {"x": 0, "y": 0, "w": 0, "h": 0}
    crop = {"left": 0, "right": 0, "top": 0, "bottom": 0}

    if corners_found >= 2:
        xs = [v[0] for v in found.values()]
        ys = [v[1] for v in found.values()]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        bw = x_max - x_min
        bh = y_max - y_min
        bounding_rect = {
            "x": int(x_min), "y": int(y_min),
            "w": int(bw), "h": int(bh),
        }
        coverage_fraction = round((bw * bh) / (w * h), 3) if w * h > 0 else 0

        if "tl" in found and "tr" in found:
            dx = found["tr"][0] - found["tl"][0]
            dy = found["tr"][1] - found["tl"][1]
            rotation_deg = round(float(np.degrees(np.arctan2(dy, dx))), 2)
        elif "bl" in found and "br" in found:
            dx = found["br"][0] - found["bl"][0]
            dy = found["br"][1] - found["bl"][1]
            rotation_deg = round(float(np.degrees(np.arctan2(dy, dx))), 2)

    if corners_found < 4:
        missing = [k for k in ("tl", "tr", "bl", "br") if k not in found]
        side_names = {"tl": "top-left", "tr": "top-right", "bl": "bottom-left", "br": "bottom-right"}
        missing_str = ", ".join(side_names[k] for k in missing)
        warnings.append(f"Display edge not visible ({missing_str}) — check that browser is fullscreen")

    if abs(rotation_deg) > 2:
        warnings.append(f"Display appears rotated {rotation_deg:.1f}° — check mirror/iPad alignment")

    if corners_found >= 2 and coverage_fraction < 0.3:
        warnings.append(f"Mirror covers {coverage_fraction*100:.0f}% of display — consider repositioning")

    if corners_found == 4 and abs(rotation_deg) < 1 and not warnings:
        status = "good"
    elif corners_found >= 3 and abs(rotation_deg) < 3:
        status = "fair"
    else:
        status = "poor"

    return {
        "corners_found": corners_found,
        "corners_expected": 4,
        "all_visible": corners_found == 4,
        "rotation_deg": rotation_deg,
        "coverage_fraction": coverage_fraction,
        "bounding_rect": bounding_rect,
        "crop": crop,
        "status": status,
        "warnings": warnings,
    }


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


DEFLECTOMETRY_ORIGINS = ("capture", "averaged", "subtracted")

# ─── Multi-frequency phase unwrapping ───────────────────────────────────
#
# "capture_style" controls how many fringe periods a capture sequence
# records. "fast" records a single period (legacy 16 frames — 2 orientations
# × 8 phase shifts). "multi_freq" records len(periods) distinct periods
# (default 3), coarsest to finest, yielding len(periods) * 16 frames, used
# by ``cascade_unwrap`` to resolve 2π ambiguities that silently corrupt
# single-frequency unwraps on steep slopes or discontinuities.
CAPTURE_STYLES = ("fast", "multi_freq")
DEFAULT_MULTI_FREQ_PERIODS = (3, 12, 48)  # coarsest → finest, cycles/screen
DEFAULT_FAST_PERIOD = 16  # legacy single-freq fringe count
# Pixels whose per-period phase predictions disagree by more than this
# threshold are considered unreliable and dropped from the trusted mask.
# Tuned empirically against synthetic ramps + real-world noisy captures.
DEFAULT_CONSISTENCY_THRESHOLD = 0.7


def cascade_unwrap(
    wrapped_per_period: list[np.ndarray],
    periods: list[int],
) -> tuple[np.ndarray, np.ndarray]:
    """Multi-frequency cascade unwrap (Sofast-style, Sandia OpenCSP).

    Given wrapped phases captured at several fringe frequencies (periods),
    cascade from the coarsest (no π ambiguity across the screen) to the
    finest (accurate but ambiguous) to recover an absolute, unambiguous
    screen position per pixel.

    Units
    -----
    Unlike Sofast which works in [0, 1] screen-fraction units, this function
    works in **radians** scaled so that the full screen spans
    ``2π · periods[-1]``. Concretely, the output equals the unwrapped
    absolute phase at the finest period (i.e. what a hypothetical
    infinite-domain ``np.unwrap`` of the finest wrapped phase would produce
    anchored at an absolute reference). The conversion to screen fraction
    is ``x_frac = unwrapped / (2π · p_fine)``.

    Degenerate single-period case
    -----------------------------
    With a single period, the cascade has no coarser reference — its
    output is the wrapped phase lifted to ``[0, 2π)`` and scaled by
    ``p_fine / p``. It does NOT perform spatial unwrapping. Callers that
    want spatial unwrap for single-period captures should use
    :func:`unwrap_phase` (np.unwrap) directly. The live pipeline only
    invokes ``cascade_unwrap`` for ``capture_style="multi_freq"``.

    Parameters
    ----------
    wrapped_per_period : list of (H, W) wrapped-phase arrays in [-π, π], one
        per period. MUST be ordered coarsest → finest (i.e. periods[0] is the
        smallest fringe count, periods[-1] is the largest).
    periods : list of positive ints, same length as wrapped_per_period,
        cycles per screen.

    Returns
    -------
    unwrapped : (H, W) float64 — absolute screen position in radians,
        scaled to the finest period (multiply by screen_width / (2π·p_fine)
        to get pixel coordinates on the display).
    consistency : (H, W) float64 in [0, 1] — per-pixel phase agreement
        across periods. 1.0 = perfect agreement, 0.0 = complete disagreement.
        For a single period the array is all 1.0 (no cross-check possible).

    Raises
    ------
    ValueError
        If inputs are empty, have mismatched lengths, shapes disagree, or
        periods are not strictly ascending positive ints.

    Algorithm (Sofast image_processing.py::unwrap_phase, adapted):
        For each pixel, treating wrapped phases in fractional units:
            w_i = wrapped_i / (2π · p_i)   # fraction of screen at period i
            period 0 (coarsest): x_0 = w_0 mod 1
            period i > 0:
                f_i = 1 / p_i
                A   = x_{i-1} - f_i/2
                wa  = (A + f_i) mod f_i          # expected wrapped fraction
                x_i = A + ((w_i - wa + f_i) mod f_i)
        Final x_N is the unwrapped screen fraction; we return it scaled
        back to radians at the finest period: unwrapped = x_N · 2π · p_N.

    Consistency metric:
        For each period i > 0, compute the wrapped-phase residual between
        the refined estimate and the raw wrapped phase, taking the shorter
        arc modulo f_i. Per-pixel agreement = 1 − 2·|residual|/f_i,
        clamped to [0, 1]. Report the minimum across periods (worst case).
    """
    if not wrapped_per_period:
        raise ValueError("wrapped_per_period must be non-empty")
    if len(wrapped_per_period) != len(periods):
        raise ValueError(
            f"wrapped_per_period ({len(wrapped_per_period)}) and periods "
            f"({len(periods)}) must have the same length"
        )

    # Validate periods: strictly ascending positive ints.
    prev = 0
    for p in periods:
        if not isinstance(p, (int, np.integer)):
            raise ValueError(f"periods must be ints, got {type(p).__name__}")
        if p <= 0:
            raise ValueError(f"periods must be positive, got {p}")
        if p <= prev:
            raise ValueError(
                f"periods must be strictly ascending (coarsest → finest), "
                f"got {list(periods)}"
            )
        prev = p

    shape = wrapped_per_period[0].shape
    for i, w in enumerate(wrapped_per_period):
        if w.shape != shape:
            raise ValueError(
                f"wrapped_per_period[{i}].shape {w.shape} does not match "
                f"wrapped_per_period[0].shape {shape}"
            )

    # Convert each wrapped phase (radians, [-π, π]) to screen-fraction in [0, 1).
    #   fraction = (wrapped mod 2π) / (2π · p)
    fractions = []
    for w, p in zip(wrapped_per_period, periods):
        wf = np.mod(np.asarray(w, dtype=np.float64), 2.0 * np.pi) / (2.0 * np.pi * float(p))
        fractions.append(wf)

    # Cascade.
    x = np.copy(fractions[0])
    agreements: list[np.ndarray] = []
    for idx in range(1, len(periods)):
        p = float(periods[idx])
        f = 1.0 / p
        w_i = fractions[idx]

        # Prediction wa: coarse estimate x_{i-1} wrapped into [0, f) is what
        # we would EXPECT the fine-period wrapped phase to read if the coarse
        # estimate were perfect.
        wa_pred = np.mod(x, f)

        A = x - f / 2.0
        # Refined position: snap to w_i inside the half-cycle centred on the
        # coarse prediction. This is the Sofast formula.
        x = A + np.mod(w_i - np.mod(A + f, f) + f, f)

        # Consistency: shortest-arc distance between coarse prediction (wa_pred)
        # and measured fine wrapped fraction (w_i), both in [0, f).
        # Max shortest-arc is f/2 (antipodal across the period loop).
        diff = np.abs(wa_pred - w_i)
        diff = np.minimum(diff, f - diff)
        # Normalize: 0 → 1 (perfect), f/2 → 0 (maximum disagreement).
        agreement = np.clip(1.0 - 2.0 * diff / f, 0.0, 1.0)
        agreements.append(agreement)

    if agreements:
        # Per-pixel minimum (worst period's agreement).
        consistency = np.minimum.reduce(agreements)
    else:
        consistency = np.ones(shape, dtype=np.float64)

    # Scale back to radians at the finest period so the output lives in
    # the same frame as np.unwrap would produce.
    p_fine = float(periods[-1])
    unwrapped = x * (2.0 * np.pi * p_fine)

    return unwrapped.astype(np.float64), consistency.astype(np.float64)


def wrap_deflectometry_result(
    result: dict,
    *,
    origin: str = "capture",
    calibration_snapshot: dict | None = None,
    geometry: dict | None = None,
    source_ids: list[str] | None = None,
    aperture_recipe: dict | None = None,
    captured_at: str | None = None,
    tuning: dict | None = None,
    warnings: list[str] | None = None,
) -> dict:
    """Attach DeflectometryResult envelope fields to a deflectometry pipeline output dict.

    Mutates ``result`` in place and returns it. Additive: existing keys are
    preserved. Idempotent — calling twice keeps the original ``id`` while
    refreshing other envelope fields.
    """
    if origin not in DEFLECTOMETRY_ORIGINS:
        raise ValueError(
            f"origin must be one of {DEFLECTOMETRY_ORIGINS}, got {origin!r}"
        )

    if "id" not in result:
        result["id"] = uuid.uuid4().hex
    result["origin"] = origin
    result["source_ids"] = list(source_ids) if source_ids else []
    result["captured_at"] = captured_at or datetime.now(timezone.utc).isoformat()
    result["calibration_snapshot"] = calibration_snapshot
    result["geometry"] = geometry
    result["tuning"] = tuning
    result["aperture_recipe"] = aperture_recipe

    if warnings is not None:
        result["warnings"] = list(warnings)
    elif "warnings" not in result:
        quality = result.get("quality")
        if isinstance(quality, dict) and isinstance(quality.get("warnings"), list):
            result["warnings"] = list(quality["warnings"])
        else:
            result["warnings"] = []

    return result
