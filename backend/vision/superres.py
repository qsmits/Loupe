"""Super-resolution via shift-and-add for sub-pixel image reconstruction.

The user captures multiple frames at known sub-pixel shifts (using
micrometer handwheels) and we reconstruct a higher-resolution image.
Phase correlation estimates actual shifts regardless of micrometer
accuracy.
"""

from __future__ import annotations

from typing import List, Tuple

import cv2
import numpy as np


def compute_shift_grid(scale: int) -> List[Tuple[float, float]]:
    """Return the target fractional-pixel shift positions for a given scale.

    For scale=2: 4 positions (2x2 grid of 0.5-pixel steps).
    For scale=4: 16 positions (4x4 grid of 0.25-pixel steps).

    Returns a list of (dx_frac, dy_frac) tuples in LR pixel units.
    """
    step = 1.0 / scale
    positions = []
    for iy in range(scale):
        for ix in range(scale):
            positions.append((ix * step, iy * step))
    return positions


def estimate_shifts(
    frames: List[np.ndarray], ref_idx: int = 0
) -> List[Tuple[float, float]]:
    """Estimate sub-pixel shifts of each frame relative to frames[ref_idx].

    Uses cv2.phaseCorrelate on float32 grayscale images.
    Returns one (dx, dy) per frame; the reference frame gets (0.0, 0.0).
    """
    if not frames:
        return []

    def _to_gray_f32(img: np.ndarray) -> np.ndarray:
        if img.ndim == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        else:
            gray = img
        return gray.astype(np.float32)

    ref = _to_gray_f32(frames[ref_idx])
    # Apply a Hanning window for better phase correlation
    h, w = ref.shape[:2]
    hann = cv2.createHanningWindow((w, h), cv2.CV_32F)

    shifts: List[Tuple[float, float]] = []
    for i, frame in enumerate(frames):
        if i == ref_idx:
            shifts.append((0.0, 0.0))
            continue
        gray = _to_gray_f32(frame)
        (dx, dy), _response = cv2.phaseCorrelate(ref, gray, hann)
        shifts.append((float(dx), float(dy)))
    return shifts


def reconstruct(
    frames: List[np.ndarray],
    shifts: List[Tuple[float, float]],
    scale: int,
) -> np.ndarray:
    """Shift-and-add super-resolution reconstruction.

    For each frame:
      1. Resize to scale x using Lanczos interpolation.
      2. Shift by (dx * scale, dy * scale) using warpAffine.
      3. Accumulate into a sum buffer.
    Final output is the average, clipped to [0, 255] as uint8 BGR.
    """
    if not frames or not shifts:
        raise ValueError("Need at least one frame and matching shifts")
    if len(frames) != len(shifts):
        raise ValueError("frames and shifts must have the same length")

    h, w = frames[0].shape[:2]
    out_h, out_w = h * scale, w * scale

    accumulator = np.zeros((out_h, out_w, 3), dtype=np.float64)
    count = np.zeros((out_h, out_w, 1), dtype=np.float64)

    for frame, (dx, dy) in zip(frames, shifts):
        # Resize to HR dimensions
        upscaled = cv2.resize(frame, (out_w, out_h), interpolation=cv2.INTER_LANCZOS4)

        # Build translation matrix for sub-pixel shift on HR grid
        tx = dx * scale
        ty = dy * scale
        M = np.array([[1.0, 0.0, tx], [0.0, 1.0, ty]], dtype=np.float64)

        # Warp with Lanczos interpolation
        shifted = cv2.warpAffine(
            upscaled, M, (out_w, out_h),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_REFLECT,
        )

        # Build a mask to track where valid pixels land after the shift
        ones = np.ones((out_h, out_w, 1), dtype=np.float64)
        mask = cv2.warpAffine(
            ones, M, (out_w, out_h),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0.0,
        )
        if mask.ndim == 2:
            mask = mask[:, :, np.newaxis]

        accumulator += shifted.astype(np.float64) * mask
        count += mask

    # Average where we have contributions
    count3 = np.broadcast_to(count, accumulator.shape).copy()
    count3[count3 < 0.01] = 1.0  # avoid division by zero
    result = accumulator / count3
    # Zero out pixels with no contributions
    result[np.broadcast_to(count < 0.01, result.shape)] = 0.0

    return np.clip(result, 0, 255).astype(np.uint8)


def shifts_to_um(
    shift_grid: List[Tuple[float, float]], pixel_pitch_um: float
) -> List[Tuple[float, float]]:
    """Convert fractional pixel shifts to micrometers.

    Each shift in the grid is in LR pixel fractions; multiply by the
    pixel pitch to get physical units.
    """
    return [
        (round(dx * pixel_pitch_um, 3), round(dy * pixel_pitch_um, 3))
        for dx, dy in shift_grid
    ]
