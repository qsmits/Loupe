"""
Corridor-based guided inspection: per-feature edge detection and geometry fitting.

For each DXF entity, projects nominal geometry to image-space, defines a corridor
(perpendicular band for lines, annular ring for arcs/circles), collects Canny edge
pixels within the corridor using vectorized NumPy, then fits the appropriate geometry
and computes deviation from nominal.
"""
import math
import numpy as np
import cv2

from .detection import preprocess, fit_circle_algebraic
from .line_arc_matching import dxf_to_image_px, perp_dist_point_to_line

# Minimum edge points required for fitting
_MIN_POINTS_LINE = 5
_MIN_POINTS_ARC = 8


def _sample_points(pts: np.ndarray, max_n: int = 50) -> list:
    """Evenly sample up to max_n points from an Nx2 array for frontend visualization."""
    if len(pts) <= max_n:
        return pts.tolist()
    indices = np.linspace(0, len(pts) - 1, max_n, dtype=int)
    return pts[indices].tolist()


def _line_fit_endpoints(centroid, direction, pts):
    """Compute line fit endpoints by projecting points onto the fitted direction."""
    proj = (pts - centroid) @ direction
    t_min, t_max = float(proj.min()), float(proj.max())
    return {
        "type": "line",
        "x1": float(centroid[0] + t_min * direction[0]),
        "y1": float(centroid[1] + t_min * direction[1]),
        "x2": float(centroid[0] + t_max * direction[0]),
        "y2": float(centroid[1] + t_max * direction[1]),
    }


def _unmatched(entity: dict, reason: str) -> dict:
    """Return a result dict for an unmatched feature."""
    return {
        "handle": entity.get("handle"),
        "type": entity.get("type"),
        "parent_handle": entity.get("parent_handle"),
        "matched": False,
        "edge_point_count": 0,
        "edge_points_sample": [],
        "fit": None,
        "perp_dev_mm": None,
        "angle_error_deg": None,
        "center_dev_mm": None,
        "radius_dev_mm": None,
        "tolerance_warn": entity.get("tolerance_warn", 0.1),
        "tolerance_fail": entity.get("tolerance_fail", 0.25),
        "pass_fail": None,
        "reason": reason,
    }


def _pass_fail(dev_mm: float, tol_warn: float, tol_fail: float) -> str:
    """Classify deviation against tolerance thresholds."""
    if dev_mm <= tol_warn:
        return "pass"
    elif dev_mm <= tol_fail:
        return "warn"
    else:
        return "fail"


def _inspect_line(entity, edge_xy, ppm, tx, ty, angle_rad,
                  corridor_px, flip_h, flip_v, tol_warn, tol_fail):
    """Inspect a line/polyline_line entity against corridor-filtered edge pixels."""
    # Project endpoints to image space
    x1_px, y1_px = dxf_to_image_px(entity["x1"], entity["y1"], ppm, tx, ty,
                                     angle_rad, flip_h, flip_v)
    x2_px, y2_px = dxf_to_image_px(entity["x2"], entity["y2"], ppm, tx, ty,
                                     angle_rad, flip_h, flip_v)

    # Direction vector and perpendicular
    dx = x2_px - x1_px
    dy = y2_px - y1_px
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return _unmatched(entity, "degenerate line (zero length)")

    ux, uy = dx / length, dy / length  # unit along
    nx, ny = -uy, ux  # unit perpendicular

    # Project all edge points onto the line's local coordinate system
    rel_x = edge_xy[:, 0] - x1_px
    rel_y = edge_xy[:, 1] - y1_px

    along = rel_x * ux + rel_y * uy  # projection along line
    perp = rel_x * nx + rel_y * ny   # projection perpendicular

    # Corridor: ±corridor_px perpendicular, extended 10% along direction
    margin = 0.1 * length
    mask = (
        (along >= -margin) &
        (along <= length + margin) &
        (np.abs(perp) <= corridor_px)
    )
    corridor_pts = edge_xy[mask]

    if len(corridor_pts) < _MIN_POINTS_LINE:
        return _unmatched(entity, f"too few edge points ({len(corridor_pts)})")

    # Shadow-aware line fitting:
    # The corridor may contain two parallel edges: the real part edge and its shadow.
    # Strategy: find edge clusters, pick the one closest to the DXF nominal.

    # Compute signed perpendicular distance of each point from the NOMINAL line
    perp_signed = perp[mask]  # already computed — signed distance from nominal

    # Bin points by their signed perpendicular distance to find edge clusters
    # Use a histogram with 1px bins
    bin_edges = np.arange(-corridor_px, corridor_px + 1, 1.0)
    hist, _ = np.histogram(perp_signed, bins=bin_edges)

    # Find the peak closest to 0 (the nominal) — this is the real edge
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    # Smooth histogram slightly to merge adjacent bins
    if len(hist) >= 3:
        smoothed = np.convolve(hist, [0.25, 0.5, 0.25], mode='same')
    else:
        smoothed = hist.astype(float)

    # Find peak closest to zero with at least some points
    min_peak_height = max(3, len(corridor_pts) * 0.05)
    best_offset = 0
    best_score = -1
    for i, (center, count) in enumerate(zip(bin_centers, smoothed)):
        if count < min_peak_height:
            continue
        # Score: prefer high count and proximity to zero
        score = count / (1 + abs(center))
        if score > best_score:
            best_score = score
            best_offset = center

    # Filter to points near the best edge (within ±3px of the peak)
    edge_band = 3.0
    near_mask = np.abs(perp_signed - best_offset) < edge_band
    near_pts = corridor_pts[near_mask]

    if len(near_pts) < _MIN_POINTS_LINE:
        near_pts = corridor_pts  # fallback to all corridor points

    # Fit line via eigenvector method on the near-edge points
    centroid = near_pts.mean(axis=0)
    centered = near_pts - centroid
    cov = centered.T @ centered
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    direction = eigenvectors[:, 1]
    normal = eigenvectors[:, 0]

    # Final inlier filter (tight)
    residuals = np.abs(centered @ normal)
    inlier_threshold = min(2.0, corridor_px * 0.2)
    inlier_mask = residuals < inlier_threshold
    inlier_pts = near_pts[inlier_mask]

    if len(inlier_pts) < _MIN_POINTS_LINE:
        inlier_pts = near_pts

    # Second pass: refit on inliers only
    centroid = inlier_pts.mean(axis=0)
    centered = inlier_pts - centroid
    cov = centered.T @ centered
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    direction = eigenvectors[:, 1]

    # Deviation = perpendicular distance from fitted centroid to nominal line
    perp_dev_px = abs(
        (centroid[0] - x1_px) * nx + (centroid[1] - y1_px) * ny
    )
    perp_dev_mm = perp_dev_px / ppm

    # Angle error between fitted direction and nominal direction
    fit_angle = math.degrees(math.atan2(direction[1], direction[0])) % 180
    nom_angle = math.degrees(math.atan2(uy, ux)) % 180
    angle_err = abs(fit_angle - nom_angle)
    if angle_err > 90:
        angle_err = 180 - angle_err

    # Determine pass/fail from perpendicular deviation
    pf = _pass_fail(perp_dev_mm, tol_warn, tol_fail)

    return {
        "handle": entity.get("handle"),
        "type": entity.get("type"),
        "parent_handle": entity.get("parent_handle"),
        "matched": True,
        "edge_point_count": len(corridor_pts),
        "edge_points_sample": _sample_points(corridor_pts),
        "fit": _line_fit_endpoints(centroid, direction, inlier_pts),
        "perp_dev_mm": round(perp_dev_mm, 4),
        "angle_error_deg": round(angle_err, 2),
        "center_dev_mm": None,
        "radius_dev_mm": None,
        "tolerance_warn": tol_warn,
        "tolerance_fail": tol_fail,
        "pass_fail": pf,
        "reason": None,
    }


def _inspect_arc_circle(entity, edge_xy, ppm, tx, ty, angle_rad,
                        corridor_px, flip_h, flip_v, tol_warn, tol_fail):
    """Inspect an arc/polyline_arc/circle entity against corridor-filtered edge pixels."""
    # Project center to image space, scale radius
    cx_px, cy_px = dxf_to_image_px(entity["cx"], entity["cy"], ppm, tx, ty,
                                     angle_rad, flip_h, flip_v)
    r_px = entity["radius"] * ppm

    if r_px < 1e-3:
        return _unmatched(entity, "degenerate arc (zero radius)")

    # Radial distances from all edge points to nominal center
    dx = edge_xy[:, 0] - cx_px
    dy = edge_xy[:, 1] - cy_px
    dists = np.sqrt(dx * dx + dy * dy)

    # Annular corridor: r ± corridor_px
    radial_mask = np.abs(dists - r_px) <= corridor_px

    # For partial arcs, apply angular bounds
    etype = entity.get("type", "")
    if etype in ("arc", "polyline_arc"):
        # Get angular bounds from entity
        start_deg = entity.get("start_angle", 0.0)
        end_deg = entity.get("end_angle", 360.0)

        # Angular margin proportional to corridor width
        ang_margin = corridor_px / r_px  # radians

        # Compute angles of edge points relative to center
        angles = np.arctan2(dy, dx)  # radians, [-pi, pi]

        # Normalize start/end to radians
        start_rad = math.radians(start_deg)
        end_rad = math.radians(end_deg)

        # Expand angular range by margin
        start_rad -= ang_margin
        end_rad += ang_margin

        # Check if point angle is within [start_rad, end_rad] (handling wraparound)
        # Normalize angles to [0, 2pi)
        angles_norm = angles % (2 * math.pi)
        start_norm = start_rad % (2 * math.pi)
        end_norm = end_rad % (2 * math.pi)

        if start_norm <= end_norm:
            angle_mask = (angles_norm >= start_norm) & (angles_norm <= end_norm)
        else:
            angle_mask = (angles_norm >= start_norm) | (angles_norm <= end_norm)

        mask = radial_mask & angle_mask
    else:
        # Full circle: no angular restriction
        mask = radial_mask

    corridor_pts = edge_xy[mask]

    if len(corridor_pts) < _MIN_POINTS_ARC:
        return _unmatched(entity, f"too few edge points ({len(corridor_pts)})")

    # Shadow-aware arc fitting: prefer points closest to the nominal radius
    # Compute signed radial offset from nominal (positive = outside, negative = inside)
    radial_offsets = dists[mask] - r_px

    # Histogram to find the dominant edge cluster nearest to 0
    bin_edges = np.arange(-corridor_px, corridor_px + 1, 1.0)
    hist, _ = np.histogram(radial_offsets, bins=bin_edges)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    if len(hist) >= 3:
        smoothed = np.convolve(hist, [0.25, 0.5, 0.25], mode='same')
    else:
        smoothed = hist.astype(float)

    min_peak_height = max(3, len(corridor_pts) * 0.05)
    best_offset = 0
    best_score = -1
    for center, count in zip(bin_centers, smoothed):
        if count < min_peak_height:
            continue
        score = count / (1 + abs(center))
        if score > best_score:
            best_score = score
            best_offset = center

    # Filter to points near the best edge
    near_mask = np.abs(radial_offsets - best_offset) < 3.0
    near_pts = corridor_pts[near_mask]
    if len(near_pts) < _MIN_POINTS_ARC:
        near_pts = corridor_pts

    # Fit circle to near-edge points
    try:
        fit_cx, fit_cy, fit_r = fit_circle_algebraic(near_pts)
    except (np.linalg.LinAlgError, ValueError):
        return _unmatched(entity, "circle fit failed")

    # Final inlier filter
    radial_residuals = np.abs(np.hypot(near_pts[:, 0] - fit_cx, near_pts[:, 1] - fit_cy) - fit_r)
    inlier_threshold = min(2.0, corridor_px * 0.2)
    inlier_mask = radial_residuals < inlier_threshold
    inlier_pts = near_pts[inlier_mask]

    if len(inlier_pts) >= _MIN_POINTS_ARC:
        # Second pass: refit on inliers only
        try:
            fit_cx, fit_cy, fit_r = fit_circle_algebraic(inlier_pts)
            corridor_pts = inlier_pts  # use inliers for edge_points_sample
        except (np.linalg.LinAlgError, ValueError):
            pass  # keep first-pass fit

    # Deviation: center distance + radius deviation
    center_dev_px = math.hypot(fit_cx - cx_px, fit_cy - cy_px)
    radius_dev_px = abs(fit_r - r_px)

    center_dev_mm = center_dev_px / ppm
    radius_dev_mm = radius_dev_px / ppm

    # Combined deviation for pass/fail (use the larger of the two)
    max_dev_mm = max(center_dev_mm, radius_dev_mm)
    pf = _pass_fail(max_dev_mm, tol_warn, tol_fail)

    fit_type = "circle" if etype == "circle" else "arc"

    return {
        "handle": entity.get("handle"),
        "type": entity.get("type"),
        "parent_handle": entity.get("parent_handle"),
        "matched": True,
        "edge_point_count": len(corridor_pts),
        "edge_points_sample": _sample_points(corridor_pts),
        "fit": {
            "type": fit_type,
            "cx": float(fit_cx),
            "cy": float(fit_cy),
            "r": float(fit_r),
        },
        "perp_dev_mm": None,
        "angle_error_deg": None,
        "center_dev_mm": round(center_dev_mm, 4),
        "radius_dev_mm": round(radius_dev_mm, 4),
        "tolerance_warn": tol_warn,
        "tolerance_fail": tol_fail,
        "pass_fail": pf,
        "reason": None,
    }


def inspect_features(
    frame: np.ndarray,
    entities: list[dict],
    pixels_per_mm: float,
    tx: float = 0.0,
    ty: float = 0.0,
    angle_deg: float = 0.0,
    flip_h: bool = False,
    flip_v: bool = False,
    corridor_px: float = 20.0,
    canny_low: int = 50,
    canny_high: int = 150,
    tolerance_warn: float = 0.1,
    tolerance_fail: float = 0.25,
    feature_tolerances: dict | None = None,
    smoothing: int = 1,
) -> list[dict]:
    """
    Main entry point: preprocess frame, run Canny once, then inspect each entity.

    Parameters
    ----------
    frame : BGR image (numpy array)
    entities : list of DXF entity dicts with 'type', geometry fields, etc.
    pixels_per_mm : scale factor
    tx, ty : translation offset in pixels
    angle_deg : rotation in degrees
    flip_h, flip_v : horizontal/vertical flip
    corridor_px : half-width of the search corridor in pixels
    canny_low, canny_high : Canny edge detection thresholds
    tolerance_warn, tolerance_fail : deviation thresholds in mm
    feature_tolerances : per-feature tolerance overrides {handle: {warn, fail}}
    smoothing : preprocessing smoothing level

    Returns
    -------
    List of result dicts, one per entity.
    """
    gray = preprocess(frame, smoothing=smoothing)
    edges = cv2.Canny(gray, canny_low, canny_high)

    # Collect all edge pixel coordinates as (x, y) — note argwhere returns (row, col)
    edge_yx = np.argwhere(edges > 0)
    if len(edge_yx) == 0:
        return [_unmatched(e, "no edges in frame") for e in entities]
    edge_xy = edge_yx[:, ::-1].astype(np.float64)  # flip (y,x) -> (x,y)

    angle_rad = math.radians(angle_deg)
    results = []

    ft = feature_tolerances or {}

    for entity in entities:
        etype = entity.get("type", "")
        handle = entity.get("handle")
        per_feat = ft.get(handle, {}) if handle else {}
        tol_w = per_feat.get("warn", tolerance_warn)
        tol_f = per_feat.get("fail", tolerance_fail)

        if etype in ("line", "polyline_line"):
            result = _inspect_line(entity, edge_xy, pixels_per_mm, tx, ty,
                                   angle_rad, corridor_px, flip_h, flip_v,
                                   tol_w, tol_f)
        elif etype in ("arc", "polyline_arc", "circle"):
            result = _inspect_arc_circle(entity, edge_xy, pixels_per_mm, tx, ty,
                                         angle_rad, corridor_px, flip_h, flip_v,
                                         tol_w, tol_f)
        else:
            result = _unmatched(entity, f"unsupported entity type: {etype}")

        results.append(result)

    return results


def fit_manual_points(
    entity: dict,
    points: list[list[float]],
    pixels_per_mm: float,
    tx: float = 0.0,
    ty: float = 0.0,
    angle_deg: float = 0.0,
    flip_h: bool = False,
    flip_v: bool = False,
    tolerance_warn: float = 0.1,
    tolerance_fail: float = 0.25,
) -> dict:
    """
    Fit geometry to user-provided points (manual point-pick) instead of
    corridor-collected edge points. Same fitting logic as inspect functions.

    Parameters
    ----------
    entity : DXF entity dict
    points : list of [x, y] pixel coordinates from user clicks
    pixels_per_mm : scale factor
    tx, ty, angle_deg, flip_h, flip_v : alignment transform
    tolerance_warn, tolerance_fail : deviation thresholds in mm

    Returns
    -------
    Result dict with fit geometry and deviation.
    """
    angle_rad = math.radians(angle_deg)
    etype = entity.get("type", "")
    tol_w = entity.get("tolerance_warn", tolerance_warn)
    tol_f = entity.get("tolerance_fail", tolerance_fail)
    pts = np.array(points, dtype=np.float64)

    if etype in ("line", "polyline_line"):
        if len(pts) < _MIN_POINTS_LINE:
            return _unmatched(entity, f"need at least {_MIN_POINTS_LINE} points, got {len(pts)}")

        # Project nominal endpoints
        x1_px, y1_px = dxf_to_image_px(entity["x1"], entity["y1"], pixels_per_mm,
                                         tx, ty, angle_rad, flip_h, flip_v)
        x2_px, y2_px = dxf_to_image_px(entity["x2"], entity["y2"], pixels_per_mm,
                                         tx, ty, angle_rad, flip_h, flip_v)

        dx = x2_px - x1_px
        dy = y2_px - y1_px
        length = math.hypot(dx, dy)
        if length < 1e-6:
            return _unmatched(entity, "degenerate line (zero length)")

        ux, uy = dx / length, dy / length
        nx, ny = -uy, ux

        # Eigenvector line fit
        centroid = pts.mean(axis=0)
        centered = pts - centroid
        cov = centered.T @ centered
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        direction = eigenvectors[:, 1]

        perp_dev_px = abs((centroid[0] - x1_px) * nx + (centroid[1] - y1_px) * ny)
        perp_dev_mm = perp_dev_px / pixels_per_mm

        fit_angle = math.degrees(math.atan2(direction[1], direction[0])) % 180
        nom_angle = math.degrees(math.atan2(uy, ux)) % 180
        angle_err = abs(fit_angle - nom_angle)
        if angle_err > 90:
            angle_err = 180 - angle_err

        pf = _pass_fail(perp_dev_mm, tol_w, tol_f)

        return {
            "handle": entity.get("handle"),
            "type": entity.get("type"),
            "parent_handle": entity.get("parent_handle"),
            "matched": True,
            "edge_point_count": len(pts),
            "edge_points_sample": _sample_points(pts),
            "fit": _line_fit_endpoints(centroid, direction, pts),
            "perp_dev_mm": round(perp_dev_mm, 4),
            "angle_error_deg": round(angle_err, 2),
            "center_dev_mm": None,
            "radius_dev_mm": None,
            "tolerance_warn": tol_w,
            "tolerance_fail": tol_f,
            "pass_fail": pf,
            "reason": None,
        }

    elif etype in ("arc", "polyline_arc", "circle"):
        if len(pts) < _MIN_POINTS_ARC:
            return _unmatched(entity, f"need at least {_MIN_POINTS_ARC} points, got {len(pts)}")

        cx_px, cy_px = dxf_to_image_px(entity["cx"], entity["cy"], pixels_per_mm,
                                         tx, ty, angle_rad, flip_h, flip_v)
        r_px = entity["radius"] * pixels_per_mm

        try:
            fit_cx, fit_cy, fit_r = fit_circle_algebraic(pts)
        except (np.linalg.LinAlgError, ValueError):
            return _unmatched(entity, "circle fit failed")

        center_dev_px = math.hypot(fit_cx - cx_px, fit_cy - cy_px)
        radius_dev_px = abs(fit_r - r_px)
        center_dev_mm = center_dev_px / pixels_per_mm
        radius_dev_mm = radius_dev_px / pixels_per_mm

        max_dev_mm = max(center_dev_mm, radius_dev_mm)
        pf = _pass_fail(max_dev_mm, tol_w, tol_f)

        fit_type = "circle" if etype == "circle" else "arc"

        return {
            "handle": entity.get("handle"),
            "type": entity.get("type"),
            "parent_handle": entity.get("parent_handle"),
            "matched": True,
            "edge_point_count": len(pts),
            "edge_points_sample": _sample_points(pts),
            "fit": {
                "type": fit_type,
                "cx": float(fit_cx),
                "cy": float(fit_cy),
                "r": float(fit_r),
            },
            "perp_dev_mm": None,
            "angle_error_deg": None,
            "center_dev_mm": round(center_dev_mm, 4),
            "radius_dev_mm": round(radius_dev_mm, 4),
            "tolerance_warn": tol_w,
            "tolerance_fail": tol_f,
            "pass_fail": pf,
            "reason": None,
        }

    else:
        return _unmatched(entity, f"unsupported entity type: {etype}")
