"""Deflectometry computation primitives.

Pure functions for fringe generation, 4-step phase shifting, phase
unwrapping, statistics, and pseudocolor visualization. No state, no I/O
beyond PNG encoding for the visualization helper.
"""

from __future__ import annotations

import base64

import cv2
import numpy as np


def generate_fringe_pattern(
    width: int, height: int, phase: float, freq: int, orientation: str
) -> np.ndarray:
    """Return an (H, W) uint8 sinusoidal fringe image.

    I(x, y) = 127 + 127 * cos(2π * freq * coord / extent + phase)

    orientation='x' → varies along axis 1 (width), producing vertical stripes.
    orientation='y' → varies along axis 0 (height), producing horizontal stripes.
    """
    if orientation == "x":
        coord = np.arange(width, dtype=np.float64)
        extent = float(width)
        wave = 127.0 + 127.0 * np.cos(2.0 * np.pi * freq * coord / extent + phase)
        img = np.broadcast_to(wave[None, :], (height, width))
    elif orientation == "y":
        coord = np.arange(height, dtype=np.float64)
        extent = float(height)
        wave = 127.0 + 127.0 * np.cos(2.0 * np.pi * freq * coord / extent + phase)
        img = np.broadcast_to(wave[:, None], (height, width))
    else:
        raise ValueError(f"orientation must be 'x' or 'y', got {orientation!r}")

    return np.clip(img, 0, 255).astype(np.uint8)


def compute_wrapped_phase(frames4: list[np.ndarray]) -> np.ndarray:
    """4-step phase extraction: atan2(I3 - I1, I0 - I2).

    Frames may be uint8 or float, 2D or 3D (H, W, C). 3D inputs are reduced
    to grayscale by mean over the channel axis. Output is float64 in [-π, π].
    """
    if len(frames4) != 4:
        raise ValueError(f"expected 4 frames, got {len(frames4)}")

    prepped: list[np.ndarray] = []
    for f in frames4:
        arr = np.asarray(f, dtype=np.float64)
        if arr.ndim == 3:
            arr = arr.mean(axis=-1)
        prepped.append(arr)

    i0, i1, i2, i3 = prepped
    return np.arctan2(i3 - i1, i0 - i2)


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


def compute_modulation(frames4: list[np.ndarray]) -> np.ndarray:
    """Fringe modulation (contrast) map from 4-step frames.

    modulation = sqrt((I3 - I1)^2 + (I0 - I2)^2) / 2

    High modulation = strong fringe signal = reliable phase.
    Low modulation = the reflected fringes are weak at that pixel (outside
    the iPad reflection, ambient light washing them out, clipped exposure).
    Returned as float64, same spatial shape as the input frames.
    """
    if len(frames4) != 4:
        raise ValueError(f"expected 4 frames, got {len(frames4)}")
    prepped = []
    for f in frames4:
        arr = np.asarray(f, dtype=np.float64)
        if arr.ndim == 3:
            arr = arr.mean(axis=-1)
        prepped.append(arr)
    i0, i1, i2, i3 = prepped
    return np.sqrt((i3 - i1) ** 2 + (i0 - i2) ** 2) / 2.0


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
