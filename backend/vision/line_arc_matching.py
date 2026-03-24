"""
DXF line and arc matching against detected segments.

All DXF coordinates are in mm. Detected segments are in image pixels.
The alignment transform (tx, ty, angle_deg) maps DXF pixel coordinates
to canvas pixel coordinates (same convention as alignment.py).
"""
import math


def _dxf_to_canvas_px(x_mm, y_mm, ppm, tx, ty, angle_rad, flip_h=False, flip_v=False):
    """Convert a DXF point (mm, Y-up) to canvas pixels (Y-down) via the alignment transform."""
    cx = x_mm * ppm * (-1 if flip_h else 1)
    cy = y_mm * ppm * (-1 if flip_v else 1)
    cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
    mx = cx * cos_a - cy * sin_a + tx
    my = -(cx * sin_a + cy * cos_a) + ty
    return mx, my


def _perp_dist_point_to_line(px, py, x1, y1, x2, y2):
    """Perpendicular distance from point (px,py) to the infinite line through (x1,y1)-(x2,y2)."""
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return math.hypot(px - x1, py - y1)
    return abs(dy * (x1 - px) - dx * (y1 - py)) / length


def _angle_diff_deg(a1, a2):
    """Smallest angle difference in degrees between two line angles (both in [0,180))."""
    diff = abs(a1 - a2) % 180
    return min(diff, 180 - diff)


def match_lines(dxf_lines, detected_lines, ppm, tx=0.0, ty=0.0, angle_deg=0.0,
                flip_h=False, flip_v=False, max_dist_px=50.0):
    """
    Match DXF LINE entities to detected line segments.

    Returns list of dicts, one per DXF line:
      {"handle", "matched": bool,
       "perp_dev_mm": float,  "angle_error_deg": float,
       "pass_fail": "pass"|"warn"|"fail"|None}

    pass_fail is None when matched=False; tolerance thresholds are applied by the caller.
    """
    angle_rad = math.radians(angle_deg)
    results = []

    for entity in dxf_lines:
        if entity.get("type") != "line":
            continue
        # Transform DXF midpoint to canvas pixels
        mx_mm = (entity["x1"] + entity["x2"]) / 2.0
        my_mm = (entity["y1"] + entity["y2"]) / 2.0
        mx_px, my_px = _dxf_to_canvas_px(mx_mm, my_mm, ppm, tx, ty, angle_rad, flip_h, flip_v)

        # DXF line angle in canvas space
        ex1_px, ey1_px = _dxf_to_canvas_px(entity["x1"], entity["y1"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        ex2_px, ey2_px = _dxf_to_canvas_px(entity["x2"], entity["y2"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        dxf_angle = math.degrees(math.atan2(ey2_px - ey1_px, ex2_px - ex1_px)) % 180

        # Find best matching detected line: closest by perpendicular distance + angle
        best = None
        best_dist = float("inf")
        for dl in detected_lines:
            perp = _perp_dist_point_to_line(mx_px, my_px, dl["x1"], dl["y1"], dl["x2"], dl["y2"])
            if perp > max_dist_px:
                continue
            det_angle = math.degrees(math.atan2(dl["y2"]-dl["y1"], dl["x2"]-dl["x1"])) % 180
            angle_err = _angle_diff_deg(dxf_angle, det_angle)
            if perp < best_dist:
                best_dist = perp
                best = (dl, perp, angle_err)

        if best is None:
            results.append({"handle": entity.get("handle"), "matched": False,
                            "perp_dev_mm": None, "angle_error_deg": None, "pass_fail": None})
        else:
            dl, perp, angle_err = best
            results.append({
                "handle": entity.get("handle"),
                "matched": True,
                "perp_dev_mm": round(perp / ppm, 4),
                "angle_error_deg": round(angle_err, 2),
                "pass_fail": None,  # caller sets based on tolerance
            })

    return results


def match_arcs(dxf_arcs, detected_arcs, ppm, tx=0.0, ty=0.0, angle_deg=0.0,
               flip_h=False, flip_v=False, max_center_dist_px=50.0):
    """
    Match DXF ARC entities to detected partial arcs.

    Returns list of dicts, one per DXF arc:
      {"handle", "matched": bool,
       "center_dev_mm": float, "radius_dev_mm": float,
       "pass_fail": "pass"|"warn"|"fail"|None}
    """
    angle_rad = math.radians(angle_deg)
    results = []

    for entity in dxf_arcs:
        if entity.get("type") != "arc":
            continue
        ecx_px, ecy_px = _dxf_to_canvas_px(entity["cx"], entity["cy"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        er_px = entity["radius"] * ppm

        best = None
        best_dist = float("inf")
        for da in detected_arcs:
            dist = math.hypot(da["cx"] - ecx_px, da["cy"] - ecy_px)
            if dist > max_center_dist_px:
                continue
            if dist < best_dist:
                best_dist = dist
                best = da

        if best is None:
            results.append({"handle": entity.get("handle"), "matched": False,
                            "center_dev_mm": None, "radius_dev_mm": None, "pass_fail": None})
        else:
            results.append({
                "handle": entity.get("handle"),
                "matched": True,
                "center_dev_mm": round(best_dist / ppm, 4),
                "radius_dev_mm": round(abs(best["r"] - er_px) / ppm, 4),
                "pass_fail": None,
            })

    return results
