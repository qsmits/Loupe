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


def phase_stats(unwrapped: np.ndarray) -> dict:
    """Return {'pv', 'rms', 'mean'} as plain Python floats.

    pv  = peak-to-valley (ptp)
    rms = sqrt(mean((u - mean(u))**2))
    mean = mean(u)
    """
    u = np.asarray(unwrapped, dtype=np.float64)
    mean = float(u.mean())
    pv = float(u.max() - u.min())
    rms = float(np.sqrt(np.mean((u - mean) ** 2)))
    return {"pv": pv, "rms": rms, "mean": mean}


def pseudocolor_png_b64(unwrapped: np.ndarray) -> str:
    """Min/max normalize to [0,255] uint8, apply VIRIDIS, PNG-encode, base64.

    Returns a base64 string with no 'data:' prefix. Constant-valued inputs
    are rendered as an all-zero image (avoiding div-by-zero).
    """
    u = np.asarray(unwrapped, dtype=np.float64)
    umin = float(u.min())
    umax = float(u.max())
    if umax > umin:
        norm = (u - umin) * (255.0 / (umax - umin))
    else:
        norm = np.zeros_like(u)
    gray = np.clip(norm, 0, 255).astype(np.uint8)
    colored = cv2.applyColorMap(gray, cv2.COLORMAP_VIRIDIS)
    ok, buf = cv2.imencode(".png", colored)
    if not ok:
        raise RuntimeError("cv2.imencode failed for PNG output")
    return base64.b64encode(buf.tobytes()).decode("ascii")
