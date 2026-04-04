"""
Export measurement annotations as a DXF file.
Converts pixel-space annotations to mm using calibration.
"""
import io
import math
import ezdxf


def export_annotations_dxf(
    annotations: list[dict],
    pixels_per_mm: float,
    origin_x: float = 0,
    origin_y: float = 0,
) -> bytes:
    """
    Convert measurement annotations to a DXF file.

    Parameters
    ----------
    annotations : list of annotation dicts (from frontend state)
    pixels_per_mm : calibration scale
    origin_x, origin_y : origin position in pixels (subtracted before scaling)

    Returns
    -------
    DXF file content as bytes.
    """
    doc = ezdxf.new()
    msp = doc.modelspace()

    for ann in annotations:
        atype = ann.get("type", "")

        if atype == "distance":
            # LINE from a to b
            a = ann.get("a", {})
            b = ann.get("b", {})
            x1 = (a.get("x", 0) - origin_x) / pixels_per_mm
            y1 = -(a.get("y", 0) - origin_y) / pixels_per_mm  # flip Y (canvas Y-down → DXF Y-up)
            x2 = (b.get("x", 0) - origin_x) / pixels_per_mm
            y2 = -(b.get("y", 0) - origin_y) / pixels_per_mm
            msp.add_line((x1, y1), (x2, y2))

        elif atype == "circle":
            cx = (ann.get("cx", 0) - origin_x) / pixels_per_mm
            cy = -(ann.get("cy", 0) - origin_y) / pixels_per_mm
            r = ann.get("r", 0) / pixels_per_mm
            if r > 0:
                msp.add_circle((cx, cy), r)

        elif atype == "arc-measure":
            cx = (ann.get("cx", 0) - origin_x) / pixels_per_mm
            cy = -(ann.get("cy", 0) - origin_y) / pixels_per_mm
            r = ann.get("r", 0) / pixels_per_mm
            if r > 0:
                # Compute start/end angles from p1 and p3
                p1 = ann.get("p1", {})
                p3 = ann.get("p3", {})
                p1x = (p1.get("x", 0) - origin_x) / pixels_per_mm
                p1y = -(p1.get("y", 0) - origin_y) / pixels_per_mm
                p3x = (p3.get("x", 0) - origin_x) / pixels_per_mm
                p3y = -(p3.get("y", 0) - origin_y) / pixels_per_mm
                start_deg = math.degrees(math.atan2(p1y - cy, p1x - cx))
                end_deg = math.degrees(math.atan2(p3y - cy, p3x - cx))
                msp.add_arc((cx, cy), r, start_deg, end_deg)

        elif atype == "center-dist":
            # LINE between two circle centers
            a = ann.get("a", {})
            b = ann.get("b", {})
            x1 = (a.get("x", 0) - origin_x) / pixels_per_mm
            y1 = -(a.get("y", 0) - origin_y) / pixels_per_mm
            x2 = (b.get("x", 0) - origin_x) / pixels_per_mm
            y2 = -(b.get("y", 0) - origin_y) / pixels_per_mm
            msp.add_line((x1, y1), (x2, y2))

        elif atype in ("perp-dist", "para-dist", "parallelism", "slot-dist"):
            # LINE from a to b
            a = ann.get("a", {})
            b = ann.get("b", {})
            if a and b:
                x1 = (a.get("x", 0) - origin_x) / pixels_per_mm
                y1 = -(a.get("y", 0) - origin_y) / pixels_per_mm
                x2 = (b.get("x", 0) - origin_x) / pixels_per_mm
                y2 = -(b.get("y", 0) - origin_y) / pixels_per_mm
                msp.add_line((x1, y1), (x2, y2))

        elif atype == "area":
            # LWPOLYLINE from points
            points = ann.get("points", [])
            if len(points) >= 3:
                pts = [
                    ((p.get("x", 0) - origin_x) / pixels_per_mm,
                     -(p.get("y", 0) - origin_y) / pixels_per_mm)
                    for p in points
                ]
                msp.add_lwpolyline(pts, close=True)

        elif atype == "spline":
            # SPLINE through fit points (Catmull-Rom interpolation preserved)
            points = ann.get("points", [])
            if len(points) >= 2:
                fit_pts = [
                    ((p.get("x", 0) - origin_x) / pixels_per_mm,
                     -(p.get("y", 0) - origin_y) / pixels_per_mm)
                    for p in points
                ]
                msp.add_spline(fit_points=fit_pts)

    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")
