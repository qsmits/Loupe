"""Shared polygon mask rasterization utilities.

Used by both fringe analysis and deflectometry for user-drawn part masks.
"""

import cv2
import numpy as np


def rasterize_polygon_mask(polygons: list[dict], height: int, width: int
                           ) -> np.ndarray:
    """Rasterize polygon definitions into a boolean mask.

    Parameters
    ----------
    polygons : list of dicts with keys:
        - "vertices": list of (x, y) tuples in normalized (0-1) coords
        - "include": bool (True = include region, False = exclude/hole)
    height, width : image dimensions for rasterization.

    Returns
    -------
    Boolean mask (True = valid pixel). If no polygons given, returns all-True.
    """
    if not polygons:
        return np.ones((height, width), dtype=bool)

    mask = np.zeros((height, width), dtype=np.uint8)

    # Process include polygons first, then exclude
    for poly in polygons:
        pts = np.array(
            [(int(x * width), int(y * height)) for x, y in poly["vertices"]],
            dtype=np.int32,
        )
        if poly.get("include", True):
            cv2.fillPoly(mask, [pts], 1)

    for poly in polygons:
        pts = np.array(
            [(int(x * width), int(y * height)) for x, y in poly["vertices"]],
            dtype=np.int32,
        )
        if not poly.get("include", True):
            cv2.fillPoly(mask, [pts], 0)

    return mask.astype(bool)
