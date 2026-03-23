import io

import ezdxf


def parse_dxf(content: bytes) -> list[dict]:
    """
    Parse DXF file bytes and return geometry entities as JSON-serialisable dicts.
    Supports: LINE, CIRCLE, ARC, LWPOLYLINE.
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
            if t == "LINE":
                s, e = entity.dxf.start, entity.dxf.end
                entities.append({
                    "type": "line",
                    "x1": float(s.x), "y1": float(s.y),
                    "x2": float(e.x), "y2": float(e.y),
                    "handle": handle,
                })
            elif t == "CIRCLE":
                c = entity.dxf.center
                entities.append({
                    "type": "circle",
                    "cx": float(c.x), "cy": float(c.y),
                    "radius": float(entity.dxf.radius),
                    "handle": handle,
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
                })
            elif t == "LWPOLYLINE":
                points = [{"x": float(p[0]), "y": float(p[1])}
                          for p in entity.get_points("xy")]
                entities.append({
                    "type": "polyline",
                    "points": points,
                    "closed": bool(entity.closed),
                    "handle": handle,
                })
        except Exception:
            continue  # skip malformed entities silently

    return entities
