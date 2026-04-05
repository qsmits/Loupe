"""Depth-from-focus (focus stacking) for manual Z-stacks.

Given a list of frames captured at uniform Z increments, this module:
  - Computes a focus measure per pixel per frame
  - Selects, for each pixel, the frame index where focus is maximal
  - Builds a height map (mm) from those indices
  - Builds an all-in-focus composite image by pulling each pixel from its
    best-focus frame

Focus measure: variance of the Laplacian on a small local window.  The
Laplacian is a standard sharpness measure (Pech-Pacheco et al., 2000 —
"Diatom autofocusing in brightfield microscopy: a comparative study"); we
smooth its absolute value with a box filter to turn it into a dense
per-pixel response while staying cheap.  This matches what the Keyence
VHX-series uses for its "depth-up" 3D mode.
"""

from __future__ import annotations

from typing import List, Tuple

import cv2
import numpy as np


def _focus_measure(gray: np.ndarray, window: int = 9) -> np.ndarray:
    """Return a per-pixel sharpness measure for a single grayscale frame.

    Higher value = more in focus.  Uses |Laplacian| box-filtered over a
    ``window`` x ``window`` neighbourhood to get a dense response.
    """
    lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    sq = lap * lap
    # Box filter is separable + O(1) per pixel regardless of window size.
    return cv2.boxFilter(sq, ddepth=cv2.CV_32F, ksize=(window, window))


def compute_focus_stack(
    frames: List[np.ndarray],
    z_step_mm: float,
    z0_mm: float = 0.0,
    focus_window: int = 9,
    smooth_ksize: int = 5,
) -> dict:
    """Run depth-from-focus on a list of frames captured at uniform Z step.

    Parameters
    ----------
    frames
        List of BGR (or grayscale) numpy arrays, all the same shape.  At least
        2 frames required; 3+ recommended.
    z_step_mm
        Z displacement between consecutive frames, in millimetres.  Frame 0
        is assumed to be at ``z0_mm``; frame i is at ``z0_mm + i * z_step_mm``.
    z0_mm
        Absolute Z of the first frame.  Usually 0.
    focus_window
        Size of the local window for the focus measure.
    smooth_ksize
        Median filter size applied to the raw index map.  Suppresses salt &
        pepper noise from regions with low contrast.

    Returns
    -------
    dict with keys:
        height_map : float32 HxW array of Z values in mm
        composite  : uint8 HxWx3 all-in-focus BGR image
        index_map  : int32 HxW array of best-focus frame indices
        min_z, max_z : floats (mm) — range actually present in height_map
        z_values   : list of Z values per frame (mm)
    """
    if len(frames) < 2:
        raise ValueError("Need at least 2 frames for a focus stack")

    shapes = {f.shape for f in frames}
    if len(shapes) != 1:
        raise ValueError(f"All frames must have identical shape; got {shapes}")

    h, w = frames[0].shape[:2]
    n = len(frames)

    # Normalise to BGR + grayscale
    bgr_frames: List[np.ndarray] = []
    gray_frames: List[np.ndarray] = []
    for f in frames:
        if f.ndim == 2:
            bgr = cv2.cvtColor(f, cv2.COLOR_GRAY2BGR)
            gray = f
        else:
            bgr = f
            gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        bgr_frames.append(bgr)
        gray_frames.append(gray)

    # Stack focus responses: shape (N, H, W)
    fm_stack = np.empty((n, h, w), dtype=np.float32)
    for i, g in enumerate(gray_frames):
        fm_stack[i] = _focus_measure(g, window=focus_window)

    # For each pixel, index of the frame with max focus response
    index_map = np.argmax(fm_stack, axis=0).astype(np.int32)
    # Per-pixel peak sharpness response — used as a confidence signal so the
    # 3D viewer can mask out pixels that were never truly in focus (holes,
    # textureless regions) instead of having them pinned to whichever frame
    # happened to have the largest noise spike.
    peak_focus = fm_stack.max(axis=0).astype(np.float32)
    # Per-pixel peak brightness across the stack.  Shipped alongside
    # peak_focus so the 3D viewer can interactively override confidence for
    # overexposed / specular regions (which have near-zero gradient so the
    # Laplacian confidence is misleadingly low for them).
    gray_stack = np.stack(gray_frames, axis=0)  # (N, H, W) uint8
    max_bright = gray_stack.max(axis=0).astype(np.float32)

    # Median-filter the index map to knock out isolated spikes.  Keep it small;
    # bigger windows blur feature edges in the final height map.
    if smooth_ksize and smooth_ksize >= 3:
        k = smooth_ksize if smooth_ksize % 2 == 1 else smooth_ksize + 1
        index_map = cv2.medianBlur(index_map.astype(np.uint8) if n <= 255 else index_map.astype(np.float32), k).astype(np.int32)

    # Build Z map in mm
    z_values = [z0_mm + i * z_step_mm for i in range(n)]
    z_arr = np.array(z_values, dtype=np.float32)
    height_map = z_arr[index_map]  # HxW float32

    # Build all-in-focus composite: for each pixel pull (y,x) from frame index_map[y,x]
    stack_bgr = np.stack(bgr_frames, axis=0)  # (N, H, W, 3)
    yy, xx = np.indices((h, w))
    composite = stack_bgr[index_map, yy, xx]  # HxWx3 uint8

    return {
        "height_map": height_map,
        "composite": composite,
        "index_map": index_map,
        "peak_focus": peak_focus,
        "max_brightness": max_bright,
        "min_z": float(height_map.min()),
        "max_z": float(height_map.max()),
        "z_values": z_values,
    }


def colorize_height_map(height_map: np.ndarray) -> np.ndarray:
    """Return a uint8 HxWx3 BGR visualisation of a height map.

    Uses OpenCV's built-in VIRIDIS colormap to stay dependency-free
    (no matplotlib required).  Values are normalised to the actual range
    present in ``height_map``.
    """
    hmin = float(height_map.min())
    hmax = float(height_map.max())
    if hmax - hmin < 1e-9:
        norm = np.zeros(height_map.shape, dtype=np.uint8)
    else:
        norm = ((height_map - hmin) / (hmax - hmin) * 255.0).astype(np.uint8)
    return cv2.applyColorMap(norm, cv2.COLORMAP_VIRIDIS)


def downsample_float_map(arr: np.ndarray, max_side: int = 256) -> np.ndarray:
    """Downsample any 2D float array to at most ``max_side`` on the longest edge.

    Shared helper for both the focus-index map and the per-pixel confidence
    map.  Uses ``cv2.INTER_AREA`` (appropriate for shrinking).  Returns float32.
    """
    h, w = arr.shape[:2]
    longest = max(h, w)
    if longest <= max_side:
        return arr.astype(np.float32)
    scale = max_side / float(longest)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return cv2.resize(arr.astype(np.float32), (new_w, new_h), interpolation=cv2.INTER_AREA)


def downsample_index_map(index_map: np.ndarray, max_side: int = 256) -> np.ndarray:
    """Downsample a raw focus-index map to at most ``max_side`` on the longest edge.

    Used by the 3D viewer endpoint to keep JSON payloads small while preserving
    the surface shape.  Uses ``cv2.INTER_AREA`` which averages pixel neighbourhoods
    and is appropriate for shrinking.  Returns a float32 array.
    """
    h, w = index_map.shape[:2]
    longest = max(h, w)
    if longest <= max_side:
        return index_map.astype(np.float32)
    scale = max_side / float(longest)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    src = index_map.astype(np.float32)
    return cv2.resize(src, (new_w, new_h), interpolation=cv2.INTER_AREA)


def encode_png(image_bgr: np.ndarray) -> bytes:
    """Encode a BGR image to PNG bytes."""
    ok, buf = cv2.imencode(".png", image_bgr)
    if not ok:
        raise RuntimeError("PNG encode failed")
    return buf.tobytes()
