import io
import math

import ezdxf


def _bulge_to_arc(x1: float, y1: float, x2: float, y2: float, bulge: float):
    """Convert a LWPOLYLINE bulge segment to arc parameters."""
    dx, dy = x2 - x1, y2 - y1
    d = math.hypot(dx, dy)
    if d < 1e-10:
        return None
    theta = 4.0 * math.atan(abs(bulge))
    r = d / (2.0 * math.sin(theta / 2.0))
    h = r * math.cos(theta / 2.0)
    mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    perp_x, perp_y = -dy / d, dx / d
    sign = 1 if bulge > 0 else -1
    cx = mx + sign * h * perp_x
    cy = my + sign * h * perp_y
    start_deg = math.degrees(math.atan2(y1 - cy, x1 - cx))
    end_deg   = math.degrees(math.atan2(y2 - cy, x2 - cx))
    if bulge < 0:
        start_deg, end_deg = end_deg, start_deg
    return cx, cy, r, start_deg, end_deg


def parse_dxf(content: bytes) -> list[dict]:
    """
    Parse DXF file bytes and return geometry entities as JSON-serialisable dicts.
    Supports: LINE, CIRCLE, ARC, LWPOLYLINE.
    LWPOLYLINE segments are decomposed into polyline_line (straight) and
    polyline_arc (bulge) entities.
    Coordinates are in DXF units (typically mm).
    Raises ValueError if the file cannot be parsed.
    """
    try:
        text = content.decode("utf-8", errors="replace")
        doc = ezdxf.read(io.StringIO(text))
    except Exception as exc:
        raise ValueError(f"Could not parse DXF: {exc}") from exc

    msp = doc.modelspace()
    entities = []

    for entity in msp:
        t = entity.dxftype()
        try:
            handle = getattr(entity.dxf, "handle", None)
            layer = getattr(entity.dxf, "layer", "0")
            if t == "LINE":
                s, e = entity.dxf.start, entity.dxf.end
                entities.append({
                    "type": "line",
                    "x1": float(s.x), "y1": float(s.y),
                    "x2": float(e.x), "y2": float(e.y),
                    "handle": handle,
                    "layer": layer,
                })
            elif t == "CIRCLE":
                c = entity.dxf.center
                entities.append({
                    "type": "circle",
                    "cx": float(c.x), "cy": float(c.y),
                    "radius": float(entity.dxf.radius),
                    "handle": handle,
                    "layer": layer,
                })
            elif t == "ARC":
                c = entity.dxf.center
                entities.append({
                    "type": "arc",
                    "cx": float(c.x), "cy": float(c.y),
                    "radius": float(entity.dxf.radius),
                    "start_angle": float(entity.dxf.start_angle),
                    "end_angle": float(entity.dxf.end_angle),
                    "handle": handle,
                    "layer": layer,
                })
            elif t == "LWPOLYLINE":
                pts = list(entity.get_points("xyb"))
                n = len(pts)
                if n < 2:
                    continue
                is_closed = bool(entity.closed)
                seg_count = n if is_closed else n - 1
                for i in range(seg_count):
                    x1, y1, bulge = pts[i]
                    x2, y2, _ = pts[(i + 1) % n]
                    seg_handle = f"{handle}_s{i}" if handle else None
                    if abs(bulge) < 1e-9:
                        entities.append({
                            "type": "polyline_line",
                            "x1": float(x1), "y1": float(y1),
                            "x2": float(x2), "y2": float(y2),
                            "handle": seg_handle,
                            "parent_handle": handle,
                            "segment_index": i,
                            "layer": layer,
                        })
                    else:
                        arc = _bulge_to_arc(float(x1), float(y1), float(x2), float(y2), float(bulge))
                        if arc is None:
                            continue
                        cx, cy, r, start_deg, end_deg = arc
                        entities.append({
                            "type": "polyline_arc",
                            "cx": cx, "cy": cy, "radius": r,
                            "start_angle": start_deg, "end_angle": end_deg,
                            "handle": seg_handle,
                            "parent_handle": handle,
                            "segment_index": i,
                            "layer": layer,
                        })
        except Exception:
            continue  # skip malformed entities silently

    return entities
