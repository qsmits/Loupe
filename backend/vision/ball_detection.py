"""Ball detection for deflectometry calibration.

Phase 3B Wave 2. G20 precision balls are placed on the specimen fixture and
imaged while the iPad displays fringes. Where the ball is in frame, the
specular reflection of the iPad produces a high-modulation (high fringe
contrast) region. Outside the ball, modulation collapses — either the
surface is diffuse (low contrast) or out of focus. So the modulation map
is a natural mask for the ball silhouette.

This module is a pure function wrapper around ``cv2.HoughCircles`` tuned
for that use case. Inputs are the modulation grid (or any scalar map where
the ball is bright); outputs are (center_xy, radius, score).

No I/O, no side effects. Testable with synthetic inputs.
"""
from __future__ import annotations

import numpy as np
import cv2


def _normalize_to_uint8(img: np.ndarray) -> np.ndarray:
    """Normalize an arbitrary float image to uint8 in [0, 255].

    NaN values are treated as 0. If the input is already uint8, it's returned
    unchanged. Input with max == min (constant image) is returned as zeros.
    """
    arr = np.asarray(img)
    if arr.dtype == np.uint8:
        return arr
    a = arr.astype(np.float64, copy=True)
    a[~np.isfinite(a)] = 0.0
    lo, hi = float(a.min()), float(a.max())
    if hi <= lo:
        return np.zeros(a.shape, dtype=np.uint8)
    scaled = (a - lo) / (hi - lo) * 255.0
    return np.clip(scaled, 0, 255).astype(np.uint8)


def detect_ball_in_modulation(
    modulation: np.ndarray,
    center_hint_px: tuple[float, float] | None = None,
    radius_hint_px: float | None = None,
    min_radius_px: int = 30,
    max_radius_px: int = 400,
) -> tuple[tuple[float, float], float, float]:
    """Detect the best-fit ball silhouette in a modulation map.

    Parameters
    ----------
    modulation : (H, W) float or uint8. The fringe-contrast map. Bright
        regions correspond to high-quality specular reflections (the ball).
    center_hint_px : (u, v) pixel hint, or None. When provided, the Hough
        search is restricted to a window of side ~2.5 × radius_hint_px
        around the hint. This lets the caller disambiguate between multiple
        bright features (a bigger blob elsewhere in frame doesn't win).
    radius_hint_px : approximate radius hint in px, or None. Used to narrow
        the min/max radius search band around the hint (±40%). When None,
        the full [min_radius_px, max_radius_px] band is searched.
    min_radius_px, max_radius_px : absolute bounds on search radius.

    Returns
    -------
    center_xy : (u, v) — detected center in pixels, floats.
    radius : detected radius in pixels.
    score : Hough accumulator peak score for this circle (arbitrary
        units — higher is stronger). With OpenCV's HoughGradient,
        ``cv2.HoughCircles`` returns circles ranked by accumulator; we
        surface the top candidate and assign its relative ranking as a
        score in [0, 1] (1 = top; 0 = none).

    Raises
    ------
    ValueError if the input is empty or no circle is found.

    Notes
    -----
    ``cv2.HoughCircles`` has idiosyncratic parameter sensitivity. The
    defaults here (``param2`` in the 30–60 range depending on hint
    availability) are tuned for fringe-modulation maps. If the caller's
    ball is very small (< 30 px) or very large (> 400 px), pass explicit
    ``min_radius_px`` / ``max_radius_px``.
    """
    mod = np.asarray(modulation)
    if mod.size == 0 or mod.ndim != 2:
        raise ValueError(
            f"modulation must be a 2D non-empty array, got shape {mod.shape}"
        )

    img_u8 = _normalize_to_uint8(mod)
    h, w = img_u8.shape

    # Restrict radius band if we have a hint.
    if radius_hint_px is not None and radius_hint_px > 0:
        r_min = max(int(radius_hint_px * 0.6), min_radius_px)
        r_max = min(int(radius_hint_px * 1.4) + 1, max_radius_px)
        if r_max <= r_min:
            r_max = r_min + 1
    else:
        r_min = int(min_radius_px)
        r_max = int(max_radius_px)

    # Restrict search region if we have a center hint.
    if center_hint_px is not None:
        cu, cv = float(center_hint_px[0]), float(center_hint_px[1])
        # Window half-size: ~2.5× the maximum expected radius. Generous
        # enough that a slightly-off hint still finds the true center.
        win = int(max(r_max, 60) * 2.5)
        u0 = max(0, int(round(cu - win)))
        u1 = min(w, int(round(cu + win)))
        v0 = max(0, int(round(cv - win)))
        v1 = min(h, int(round(cv + win)))
        if u1 <= u0 or v1 <= v0:
            raise ValueError(
                f"center_hint_px {center_hint_px!r} produced empty search window"
            )
        sub = img_u8[v0:v1, u0:u1]
        dx, dy = u0, v0
    else:
        sub = img_u8
        dx, dy = 0, 0

    # A light Gaussian blur stabilises Hough — fringe-pattern texture
    # inside the ball would otherwise add edge noise.
    blurred = cv2.GaussianBlur(sub, (9, 9), 2.0)

    # Two-stage detection: try a strict param2, fall back if nothing found.
    found = None
    for param2 in (50, 35, 22, 12):
        circles = cv2.HoughCircles(
            blurred,
            method=cv2.HOUGH_GRADIENT,
            dp=1.2,
            minDist=max(r_min, 20),
            param1=100,
            param2=param2,
            minRadius=r_min,
            maxRadius=r_max,
        )
        if circles is not None and len(circles[0]) > 0:
            found = circles[0]
            break

    if found is None:
        raise ValueError(
            f"No circles detected (radius band [{r_min}, {r_max}])"
        )

    # OpenCV sorts by accumulator strength already; take the top candidate.
    # If a center hint was supplied, prefer the candidate closest to the
    # hint (in the cropped frame), breaking ties by accumulator rank.
    top_idx = 0
    if center_hint_px is not None:
        cu_local = float(center_hint_px[0]) - dx
        cv_local = float(center_hint_px[1]) - dy
        dists = np.hypot(found[:, 0] - cu_local, found[:, 1] - cv_local)
        top_idx = int(np.argmin(dists))

    cu_local, cv_local, r_local = found[top_idx]
    cu_global = float(cu_local) + dx
    cv_global = float(cv_local) + dy
    radius = float(r_local)

    # Score: position in the accumulator ranking. Top candidate → 1,
    # others decay as 1 / (1 + rank).
    score = 1.0 / (1.0 + top_idx)

    return (cu_global, cv_global), radius, float(score)


def render_ball_overlay_png_b64(
    background: np.ndarray,
    center_xy: tuple[float, float],
    radius_px: float,
) -> str:
    """Render a preview PNG with a green circle overlaid on the background.

    Returns base64-encoded PNG. Intended for the wizard's confirmation UI.
    Accepts any 2D or 3D (H, W, C) background image.
    """
    import base64

    arr = np.asarray(background)
    if arr.ndim == 2:
        img = cv2.cvtColor(_normalize_to_uint8(arr), cv2.COLOR_GRAY2BGR)
    else:
        if arr.dtype != np.uint8:
            img = _normalize_to_uint8(arr.mean(axis=-1))
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        else:
            img = arr.copy()
            if img.shape[-1] == 3:
                # Assume input is RGB-ish — convert to BGR for cv2 drawing.
                img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

    cu, cv = int(round(center_xy[0])), int(round(center_xy[1]))
    r = int(round(radius_px))
    cv2.circle(img, (cu, cv), r, (0, 255, 0), 2)
    cv2.drawMarker(img, (cu, cv), (0, 255, 0), cv2.MARKER_CROSS, 14, 2)

    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")
