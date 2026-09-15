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


def _extract_dim_specs(msp, entities: list[dict]) -> tuple[list[dict], int]:
    """Extract diameter/radius DIMENSION tolerances and associate each with
    the circle/arc it dimensions.

    Only diametric (dimtype 3) and radial (dimtype 4) dimensions carry a
    size spec; other dimension types are ignored entirely (not counted as
    unmatched). Tolerance is read from the dimension's EFFECTIVE dimstyle
    attributes via ``Dimension.override()`` (respects per-entity DSTYLE
    overrides, falling back to the assigned DIMSTYLE table entry) — if
    ``dimtol`` is off, the dimension has no tolerance and produces no spec.

    Association: contrary to the naive assumption that group code 10
    (``dxf.defpoint``) is "the" definition point on the circle, ezdxf's own
    renderers (``dim_radius.py``/``dim_diameter.py``) show that group code
    10 means the CENTER for radius dimensions and only one of two points on
    the circle for diameter dimensions. Group code 15 (``dxf.defpoint4``,
    ezdxf's ``point_on_circle``) is the point that actually lies on the
    circle for *both* dimension types, so that is what we test against
    candidate circle/arc entities.

    Nominal/limits are kept in the dimension's own basis (radius dims stay
    radius-valued, diameter dims stay diameter-valued) — doubling to a
    diameter basis happens later, once, in scoring.

    Guard against a spurious geometric match: ezdxf defaults an ABSENT group
    code 15 (defpoint4) to (0, 0, 0) rather than raising, so a dimension
    whose defpoint4 got stripped (hand-edited DXF, a lossy round-trip
    elsewhere in some toolchain) silently reads as "point on circle at the
    origin" — which coincidentally sits on the boundary of any unrelated
    circle/arc that happens to pass through the origin. Before trusting a
    geometric match, cross-check the dimension's own measured nominal
    against that candidate's actual size (2r for diameter-kind, r for
    radius-kind); a mismatch means the "match" was spurious, so it counts
    as unmatched rather than producing a spec on the wrong feature.
    """
    circle_like = [e for e in entities if e.get("type") in ("circle", "arc", "polyline_arc")]
    dim_specs: list[dict] = []
    unmatched = 0

    for dim in msp.query("DIMENSION"):
        try:
            dimtype = dim.dimtype  # ezdxf masks off the binary flag bits already
            if dimtype == 3:
                kind = "diameter"
            elif dimtype == 4:
                kind = "radius"
            else:
                continue  # not a size dimension we support

            ov = dim.override()
            if not ov.get("dimtol", 0):
                continue  # no tolerance on this dimension -> no spec

            upper = max(0.0, float(ov.get("dimtp", 0.0)))
            lower = min(0.0, -float(ov.get("dimtm", 0.0)))
            nominal = float(dim.get_measurement())

            point = dim.dxf.defpoint4  # point_on_circle for both RADIUS and DIAMETER dims
            px, py = float(point.x), float(point.y)

            best_c = None
            best_dist = None
            for c in circle_like:
                r = c["radius"]
                eps = max(1e-4 * r, 1e-6)
                d = abs(math.hypot(px - c["cx"], py - c["cy"]) - r)
                if d < eps and (best_dist is None or d < best_dist):
                    best_dist = d
                    best_c = c

            if best_c is None:
                unmatched += 1
                continue

            expected_size = 2.0 * best_c["radius"] if kind == "diameter" else best_c["radius"]
            size_tol = max(1e-3 * expected_size, 1e-6)
            if abs(nominal - expected_size) > size_tol:
                unmatched += 1
                continue

            dim_specs.append({
                "handle": best_c["handle"],
                "kind": kind,
                "nominal": nominal,
                "upper": upper,
                "lower": lower,
            })
        except Exception:
            continue  # skip malformed/unsupported dimensions silently

    return dim_specs, unmatched


def parse_dxf(content: bytes) -> dict:
    """
    Parse DXF file bytes and return geometry + dimension-tolerance specs.
    Supports: LINE, CIRCLE, ARC, LWPOLYLINE.
    LWPOLYLINE segments are decomposed into polyline_line (straight) and
    polyline_arc (bulge) entities.
    Diameter/radius DIMENSION tolerances -> dim_specs.
    Coordinates are in DXF units (typically mm).
    Raises ValueError if the file cannot be parsed.

    Returns a dict:
      {
        "entities": [...],           # JSON-serialisable entity dicts
        "dim_specs": [...],          # {handle, kind, nominal, upper, lower}
        "unmatched_dims": int,       # diametric/radial dims that couldn't be associated
      }
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

    dim_specs, unmatched_dims = _extract_dim_specs(msp, entities)

    return {
        "entities": entities,
        "dim_specs": dim_specs,
        "unmatched_dims": unmatched_dims,
    }
