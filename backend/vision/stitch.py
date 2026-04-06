"""Image stitching for XY tile grids captured on a toolmaker's microscope.

Given a grid of overlapping tiles captured at known XY positions (via
micrometer handwheels), this module:
  - Registers adjacent tile pairs using phase correlation on overlap strips
  - Computes global tile positions via cumulative shifts
  - Blends tiles with linear ramp weights in overlap regions
  - Handles serpentine (boustrophedon) scan order

The workflow is analogous to the motorised-stage panorama modes found on
Keyence VHX and Olympus DSX instruments, but driven by manual micrometers.
"""

from __future__ import annotations

from typing import Dict, Tuple

import cv2
import numpy as np


def compute_overlap_px(sensor_width_px: int, overlap_frac: float) -> int:
    """Return the expected overlap in pixels given sensor width and fraction."""
    return max(1, int(round(sensor_width_px * overlap_frac)))


def register_pair(
    img_a: np.ndarray,
    img_b: np.ndarray,
    axis: str,
    overlap_px: int,
) -> Tuple[float, float]:
    """Register two adjacent tiles using phase correlation on the overlap strip.

    Parameters
    ----------
    img_a, img_b
        BGR uint8 images of identical shape.
    axis
        ``"x"`` for horizontal neighbours (img_b is to the right of img_a)
        or ``"y"`` for vertical neighbours (img_b is below img_a).
    overlap_px
        Expected overlap width in pixels along the given axis.

    Returns
    -------
    (shift_primary, shift_secondary)
        The sub-pixel correction to the expected overlap.
        For axis="x": shift_primary is the X correction, shift_secondary is Y.
        For axis="y": shift_primary is the Y correction, shift_secondary is X.
    """
    h, w = img_a.shape[:2]
    overlap_px = max(1, min(overlap_px, w if axis == "x" else h))

    if axis == "x":
        # Right strip of img_a, left strip of img_b
        strip_a = img_a[:, w - overlap_px:]
        strip_b = img_b[:, :overlap_px]
    elif axis == "y":
        # Bottom strip of img_a, top strip of img_b
        strip_a = img_a[h - overlap_px:, :]
        strip_b = img_b[:overlap_px, :]
    else:
        raise ValueError(f"axis must be 'x' or 'y', got {axis!r}")

    # Convert to float32 grayscale for phaseCorrelate
    if strip_a.ndim == 3:
        gray_a = cv2.cvtColor(strip_a, cv2.COLOR_BGR2GRAY).astype(np.float32)
    else:
        gray_a = strip_a.astype(np.float32)

    if strip_b.ndim == 3:
        gray_b = cv2.cvtColor(strip_b, cv2.COLOR_BGR2GRAY).astype(np.float32)
    else:
        gray_b = strip_b.astype(np.float32)

    # Apply a Hann window to reduce edge artefacts in the FFT
    hann = cv2.createHanningWindow(
        (gray_a.shape[1], gray_a.shape[0]), cv2.CV_32F
    )

    (dx, dy), _response = cv2.phaseCorrelate(gray_a, gray_b, hann)

    if axis == "x":
        return (dx, dy)
    else:
        return (dy, dx)


def _serpentine_order(cols: int, rows: int) -> list:
    """Return scan order as list of (col, row) in serpentine/boustrophedon order."""
    order = []
    for r in range(rows):
        if r % 2 == 0:
            for c in range(cols):
                order.append((c, r))
        else:
            for c in range(cols - 1, -1, -1):
                order.append((c, r))
    return order


def _linear_ramp_1d(length: int, overlap: int) -> np.ndarray:
    """Create a 1D linear ramp weight array.

    Weight is 0 at the edges, ramps to 1 over ``overlap`` pixels,
    stays at 1 in the middle, ramps back down.
    """
    w = np.ones(length, dtype=np.float32)
    ramp = min(overlap, length // 2)
    if ramp > 0:
        w[:ramp] = np.linspace(0, 1, ramp, endpoint=False, dtype=np.float32)
        w[-ramp:] = np.linspace(1, 0, ramp, endpoint=False, dtype=np.float32)
    return w


def stitch_grid(
    tiles: Dict[Tuple[int, int], np.ndarray],
    grid_shape: Tuple[int, int],
    overlap_frac: float,
) -> np.ndarray:
    """Stitch a grid of tiles into a seamless panorama.

    Parameters
    ----------
    tiles
        Dict mapping ``(col, row)`` to BGR uint8 ndarray.  All tiles must
        have the same shape.
    grid_shape
        ``(cols, rows)`` — dimensions of the grid.
    overlap_frac
        Fractional overlap (e.g., 0.20 for 20%).

    Returns
    -------
    np.ndarray
        Stitched BGR uint8 image.
    """
    cols, rows = grid_shape

    sample = next(iter(tiles.values()))
    tile_h, tile_w = sample.shape[:2]

    overlap_x = compute_overlap_px(tile_w, overlap_frac)
    overlap_y = compute_overlap_px(tile_h, overlap_frac)

    step_x = tile_w - overlap_x  # nominal horizontal step
    step_y = tile_h - overlap_y  # nominal vertical step

    # Compute pairwise registration corrections
    x_shifts: Dict[Tuple[int, int], Tuple[float, float]] = {}
    y_shifts: Dict[Tuple[int, int], Tuple[float, float]] = {}

    for r in range(rows):
        for c in range(cols):
            if (c, r) not in tiles:
                continue
            # Horizontal neighbour (B is to the right)
            if c + 1 < cols and (c + 1, r) in tiles:
                try:
                    dx, dy = register_pair(
                        tiles[(c, r)], tiles[(c + 1, r)], "x", overlap_x
                    )
                    x_shifts[(c, r)] = (dx, dy)
                except Exception:
                    x_shifts[(c, r)] = (0.0, 0.0)
            # Vertical neighbour (B is below)
            if r + 1 < rows and (c, r + 1) in tiles:
                try:
                    dy, dx = register_pair(
                        tiles[(c, r)], tiles[(c, r + 1)], "y", overlap_y
                    )
                    y_shifts[(c, r)] = (dy, dx)
                except Exception:
                    y_shifts[(c, r)] = (0.0, 0.0)

    # Compute global positions for each tile.
    positions: Dict[Tuple[int, int], Tuple[float, float]] = {}
    positions[(0, 0)] = (0.0, 0.0)

    # Row 0: accumulate horizontal shifts
    for c in range(1, cols):
        prev_x, prev_y = positions[(c - 1, 0)]
        dx_corr, dy_corr = x_shifts.get((c - 1, 0), (0.0, 0.0))
        positions[(c, 0)] = (prev_x + step_x + dx_corr, prev_y + dy_corr)

    # Subsequent rows: anchor from row above, then fill horizontally
    for r in range(1, rows):
        anchor_c = 0
        for c in range(cols):
            if (c, r - 1) in y_shifts:
                anchor_c = c
                break

        above_x, above_y = positions[(anchor_c, r - 1)]
        dy_corr, dx_corr = y_shifts.get((anchor_c, r - 1), (0.0, 0.0))
        positions[(anchor_c, r)] = (above_x + dx_corr, above_y + step_y + dy_corr)

        for c in range(anchor_c + 1, cols):
            prev_x, prev_y = positions[(c - 1, r)]
            dx_c, dy_c = x_shifts.get((c - 1, r), (0.0, 0.0))
            positions[(c, r)] = (prev_x + step_x + dx_c, prev_y + dy_c)

        for c in range(anchor_c - 1, -1, -1):
            next_x, next_y = positions[(c + 1, r)]
            dx_c, dy_c = x_shifts.get((c, r), (0.0, 0.0))
            positions[(c, r)] = (next_x - step_x - dx_c, next_y - dy_c)

    # Shift so minimum position is at (0, 0)
    min_x = min(p[0] for p in positions.values())
    min_y = min(p[1] for p in positions.values())
    for key in positions:
        px, py = positions[key]
        positions[key] = (px - min_x, py - min_y)

    # Compute canvas size
    max_x = max(positions[k][0] + tile_w for k in positions)
    max_y = max(positions[k][1] + tile_h for k in positions)
    canvas_w = int(np.ceil(max_x))
    canvas_h = int(np.ceil(max_y))

    # Build output with sub-pixel-accurate placement and linear-ramp blending.
    # Use warpAffine to handle the fractional-pixel positions so seams
    # don't jitter by ±1px.
    canvas = np.zeros((canvas_h, canvas_w, 3), dtype=np.float64)
    weight_sum = np.zeros((canvas_h, canvas_w), dtype=np.float64)

    for (c, r), tile in tiles.items():
        if (c, r) not in positions:
            continue
        px, py = positions[(c, r)]

        # Per-pixel weight: linear ramp from edges
        ramp_x = _linear_ramp_1d(tile_w, overlap_x)
        ramp_y = _linear_ramp_1d(tile_h, overlap_y)
        weight = (ramp_y[:, None] * ramp_x[None, :]).astype(np.float64)

        # Use warpAffine for sub-pixel translation placement
        M = np.float64([[1, 0, px], [0, 1, py]])
        tile_placed = cv2.warpAffine(
            tile.astype(np.float64), M, (canvas_w, canvas_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT, borderValue=0,
        )
        weight_placed = cv2.warpAffine(
            weight, M, (canvas_w, canvas_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT, borderValue=0,
        )

        canvas += tile_placed * weight_placed[:, :, None]
        weight_sum += weight_placed

    # Normalise
    mask = weight_sum > 0
    for ch in range(3):
        canvas[:, :, ch][mask] /= weight_sum[mask]

    return np.clip(canvas, 0, 255).astype(np.uint8)
