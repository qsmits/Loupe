"""Raw-image calipers: projected profiles, polarity, and fractional edge peaks."""
from dataclasses import dataclass
import math
from typing import Optional

import numpy as np
from scipy.ndimage import gaussian_filter1d

from .line_arc_matching import dxf_to_image_px
from .subpixel import _bilinear_sample


@dataclass
class CaliperEdges:
    points: np.ndarray
    normals: np.ndarray
    strengths: np.ndarray
    indices: np.ndarray
    requested: int
    ambiguous: int
    outside: int

    def diagnostics(self):
        return {"sampling_method": "caliper", "caliper_count": self.requested,
                "usable_calipers": len(self.points), "ambiguous_calipers": self.ambiguous,
                "outside_calipers": self.outside,
                "sampling_coverage": len(self.points) / max(1, self.requested)}


@dataclass
class OutwardReference:
    """What "outward" means for one entity, in image pixels.

    ``loop`` is the closed outline (vertex ring) the entity belongs to, if
    any; ``centroid`` is the drawing centre (mean of every entity's anchor
    points). Both are evaluated after the DXF -> image transform, so CAD
    direction, vertex order and overlay flips cannot change the result.
    """
    loop: Optional[np.ndarray] = None
    centroid: Optional[np.ndarray] = None


_LINE_TYPES = ("line", "polyline_line")
_ARC_TYPES = ("circle", "arc", "polyline_arc")


def _segment_path_mm(entity, ppm):
    """DXF-math points along a polyline segment (arcs sampled CCW)."""
    if entity["type"] == "polyline_line":
        return [(float(entity["x1"]), float(entity["y1"])), (float(entity["x2"]), float(entity["y2"]))]
    start, radius = float(entity["start_angle"]), float(entity["radius"])
    sweep = (float(entity["end_angle"]) - start) % 360 or 360
    # Keep the chord sagitta well under the 1 px inside/outside probe; an even
    # step count puts a ring vertex exactly on the arc's mid-sweep point.
    radius_px = max(radius * ppm, 1e-6)
    steps = int(min(2000, max(8, math.ceil(math.radians(sweep) / math.sqrt(1.0 / radius_px)))))
    steps += steps % 2
    angles = np.radians(start + np.linspace(0.0, sweep, steps + 1))
    return [(float(entity["cx"]) + radius * math.cos(a), float(entity["cy"]) + radius * math.sin(a))
            for a in angles]


def _closed_ring_mm(segments, ppm):
    """Chain sibling polyline segments; return the closed vertex ring or None."""
    paths = [_segment_path_mm(e, ppm) for e in segments]
    span = np.ptp(np.array([p for path in paths for p in path]), axis=0).max()
    tol = 1e-6 * max(1.0, float(span))
    chain = list(paths[0])
    for k, path in enumerate(paths[1:]):
        if k == 0 and min(math.dist(path[0], chain[-1]), math.dist(path[-1], chain[-1])) > tol:
            chain.reverse()  # the first segment (an arc) may be stored CCW-reversed
        if math.dist(path[0], chain[-1]) <= tol:
            chain.extend(path[1:])
        elif math.dist(path[-1], chain[-1]) <= tol:
            chain.extend(path[-2::-1])
        else:
            return None
    if len(chain) < 4 or math.dist(chain[0], chain[-1]) > tol:
        return None
    return chain[:-1]


def outward_references(entities, ppm, tx, ty, angle_rad, flip_h=False, flip_v=False):
    """Per-entity OutwardReference list for one inspection request.

    Closed outlines come from polyline segments sharing ``parent_handle``
    (the parser emits one segment per LWPOLYLINE edge, ordered by
    ``segment_index``); the loop counts only when every sibling is present
    and the chain closes. Everything else uses the drawing centre.
    """
    def to_image(points):
        return np.array([dxf_to_image_px(x, y, ppm, tx, ty, angle_rad, flip_h, flip_v)
                         for x, y in points], dtype=float).reshape(-1, 2)

    anchors = []
    groups = {}
    for index, e in enumerate(entities):
        try:
            if e.get("type") in _LINE_TYPES:
                anchors.extend([(float(e["x1"]), float(e["y1"])), (float(e["x2"]), float(e["y2"]))])
            elif e.get("type") in _ARC_TYPES:
                anchors.append((float(e["cx"]), float(e["cy"])))
        except (KeyError, TypeError, ValueError):
            continue
        if e.get("type") in ("polyline_line", "polyline_arc") and e.get("parent_handle"):
            groups.setdefault(e["parent_handle"], []).append(index)
    centroid = to_image(anchors).mean(axis=0) if anchors else None
    if centroid is not None and not np.isfinite(centroid).all():
        centroid = None
    references = [OutwardReference(centroid=centroid) for _ in entities]
    for members in groups.values():
        ordered = sorted(members, key=lambda i: (entities[i].get("segment_index", i), i))
        try:
            ring = _closed_ring_mm([entities[i] for i in ordered], ppm)
        except (KeyError, TypeError, ValueError):
            ring = None
        if ring is None:
            continue
        loop = to_image(ring)
        for i in members:
            references[i] = OutwardReference(loop=loop, centroid=centroid)
    return references


def _inside(point, polygon):
    """Even-odd point-in-polygon test (image pixels)."""
    x, y = point
    xs, ys = polygon[:, 0], polygon[:, 1]
    xn, yn = np.roll(xs, -1), np.roll(ys, -1)
    crosses = (ys > y) != (yn > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        x_cross = xs + (y - ys) * (xn - xs) / (yn - ys)
    return bool(np.count_nonzero(crosses & (x < x_cross)) % 2)


def _outward_sign(point, normal, reference, is_line):
    """+1 if ``normal`` already points outward from ``point``, else -1."""
    if reference is not None and reference.loop is not None:
        plus, minus = _inside(point + normal, reference.loop), _inside(point - normal, reference.loop)
        if plus != minus:
            return (1 if minus else -1), "loop"
    if not is_line:
        return 1, "radial"
    if reference is not None and reference.centroid is not None:
        side = float(np.dot(point - reference.centroid, normal))
        if abs(side) > 1.0:
            return (1 if side > 0 else -1), "centroid"
    # Degenerate: the line passes through the drawing centre.
    if abs(normal[1]) > 1e-6:
        return (1 if normal[1] > 0 else -1), "canonical"
    return (1 if normal[0] > 0 else -1), "canonical"


# Profile sampling step along the normal (px).
_STEP = 0.5
# Bilinear profile samples per processing chunk (bounds temporaries to
# roughly 100 MB regardless of corridor/width/caliper count).
_CHUNK_SAMPLES = 1_000_000
# Per-request cap on profile samples (calipers x offsets x across-width
# samples, summed over all caliper entities). Measured throughput is
# 14-25M samples/s, so the cap is about 8-14 s of sampling in the worst case
# (a realistic 400-circle request at corridor 40, width 11 is ~58M, 2-4 s).
# It bounds time only; memory is bounded by chunking. A request above it is
# declined up front (see request_caliper_samples).
MAX_CALIPER_SAMPLES = 200_000_000


def float_frame(gray):
    """The float64 view of a frame used for caliper sampling (no copy if
    already float64). Convert once per request and pass it down."""
    return gray if gray.dtype == np.float64 else gray.astype(np.float64)


def _profile_grid(corridor_px, width, sigma):
    extent = math.ceil((corridor_px + 4 * sigma) / _STEP) * _STEP
    offsets = np.arange(-extent, extent + _STEP / 2, _STEP)
    across = np.linspace(-width / 2, width / 2, max(1, math.ceil(width) + 1)) if width else np.array([0.0])
    return offsets, across


def samples_per_caliper(corridor_px, width, sigma):
    """Bilinear samples one caliper profile costs."""
    offsets, across = _profile_grid(corridor_px, width, sigma)
    return len(offsets) * len(across)


def _caliper_count_and_width_limit(entity, ppm, spacing):
    """Caliper count and width limit; independent of the pose (rigid)."""
    kind = entity.get("type")
    if kind in _LINE_TYPES:
        length = math.hypot(entity["x2"] - entity["x1"], entity["y2"] - entity["y1"]) * ppm
        if length < 1e-6:
            raise ValueError("degenerate line (zero length)")
        return min(2000, max(5, int(length / spacing) + 1)), length / 10
    if kind in _ARC_TYPES:
        radius = entity["radius"] * ppm
        if radius < 1e-3:
            raise ValueError("degenerate arc (zero radius)")
        start = entity.get("start_angle", 0) if kind != "circle" else 0
        end = entity.get("end_angle", 360) if kind != "circle" else 360
        sweep = (end - start) % 360 or 360
        return min(2000, max(8, int(math.radians(sweep) * radius / spacing))), math.sqrt(radius)
    raise ValueError(f"unsupported entity type: {kind}")


def request_caliper_samples(entities, ppm, corridor_px, options):
    """Total profile samples an inspection request would take.

    Mirrors caliper_geometry's caliper count and the guided path's width
    clamp (min(width, width_limit)); entities that cannot be sampled
    (unsupported or degenerate) cost nothing.
    """
    spacing = options.get("spacing", 5)
    total = 0
    for e in entities:
        if not 1 <= spacing <= 50:
            break
        try:
            count, width_limit = _caliper_count_and_width_limit(e, ppm, spacing)
        except (KeyError, TypeError, ValueError):
            continue
        width = min(options.get("width", 5), width_limit)
        total += count * samples_per_caliper(corridor_px, width, options.get("sigma", 1))
    return total


def nominal_calipers(entity, ppm, tx, ty, angle_rad, flip_h=False, flip_v=False, spacing=5,
                     reference=None):
    """Sample nominal geometry; normals point OUTWARD (see caliper_geometry)."""
    return caliper_geometry(entity, ppm, tx, ty, angle_rad, flip_h, flip_v, spacing, reference)[:3]


def caliper_geometry(entity, ppm, tx, ty, angle_rad, flip_h=False, flip_v=False, spacing=5,
                     reference=None):
    """Caliper centres, unit OUTWARD normals, width limit and the normal rule.

    Points are transformed to the image first and normals are built there,
    so flips and DXF's Y-up convention cannot change which image-frame arc
    sector is sampled or which way "outward" points:

    - circle/arc/polyline_arc: away from the centre ("radial");
    - segments of a closed polyline (reference.loop): away from the
      loop interior, by a point-in-polygon test 1 px either side of the
      segment midpoint ("loop") -- a concave arc of a closed outline
      therefore points toward its own centre;
    - standalone lines and open polylines: away from the drawing centre
      reference.centroid ("centroid"), or, if the line passes within
      1 px of it, the canonical normal with positive image y (positive x
      for a horizontal normal) ("canonical").
    """
    kind = entity.get("type")
    # Count and width limit come from the pose-independent helper so the
    # request budget (request_caliper_samples) counts exactly these calipers.
    count, width_limit = _caliper_count_and_width_limit(entity, ppm, spacing)
    if kind in _LINE_TYPES:
        ends = np.array([dxf_to_image_px(entity[f"x{i}"], entity[f"y{i}"], ppm,
                                       tx, ty, angle_rad, flip_h, flip_v) for i in (1, 2)])
        delta = ends[1] - ends[0]
        length = float(np.linalg.norm(delta))
        if length < 1e-6:
            raise ValueError("degenerate line (zero length)")
        centers = ends[0] + np.linspace(0.05, 0.95, count)[:, None] * delta
        normal = np.array([-delta[1], delta[0]]) / length
        sign, rule = _outward_sign(ends.mean(axis=0), normal, reference, is_line=True)
        return centers, np.tile(sign * normal, (count, 1)), width_limit, rule
    if kind in _ARC_TYPES:
        radius = entity["radius"] * ppm
        start = entity.get("start_angle", 0) if kind != "circle" else 0
        end = entity.get("end_angle", 360) if kind != "circle" else 360
        sweep = (end - start) % 360 or 360
        fractions = np.arange(count) / count if sweep == 360 else np.linspace(0.05, 0.95, count)
        angles = np.deg2rad(start + fractions * sweep)
        center = np.array(dxf_to_image_px(entity["cx"], entity["cy"], ppm, tx, ty,
                                         angle_rad, flip_h, flip_v))
        centers = np.array([dxf_to_image_px(entity["cx"] + entity["radius"] * math.cos(a),
                                           entity["cy"] + entity["radius"] * math.sin(a),
                                           ppm, tx, ty, angle_rad, flip_h, flip_v) for a in angles])
        rule = "radial"
        if kind == "polyline_arc" and reference is not None and reference.loop is not None:
            a = math.radians(start + sweep / 2)
            mid = np.array(dxf_to_image_px(entity["cx"] + entity["radius"] * math.cos(a),
                                           entity["cy"] + entity["radius"] * math.sin(a),
                                           ppm, tx, ty, angle_rad, flip_h, flip_v))
            sign, rule = _outward_sign(mid, (mid - center) / radius, reference, is_line=False)
        else:
            sign = 1
        return centers, sign * (centers - center) / radius, width_limit, rule
    raise ValueError(f"unsupported entity type: {kind}")


def sample_caliper_edges(gray, centers, normals, corridor_px=15, width=5, sigma=1,
                         min_contrast=20, polarity="any", selection="unique", chunk_calipers=None):
    """Average intensity across caliper width, then localize derivative peaks.

    Polarity is brightness change along the supplied normal (the OUTWARD
    normal from caliper_geometry for inspection), independent of nominal
    proximity or Punch/Die tolerance semantics. Unknown polarity and
    multiple peaks yield an ambiguous caliper by default. Explicit first,
    closest, or strongest selection is available for known measurement
    recipes; "first" is the first qualifying edge met walking along the
    normal from the inner end (-corridor) of the search range.

    ``gray`` may be uint8 or float64; pass the float64 frame (see
    float_frame) to avoid a per-call conversion. Calipers are processed in
    chunks (``chunk_calipers``, default: at most 256 and about
    _CHUNK_SAMPLES profile samples per chunk) so memory stays bounded;
    chunking does not change any result.
    """
    if polarity not in ("any", "rising", "falling") or selection not in ("unique", "first", "strongest", "closest"):
        raise ValueError("invalid caliper polarity or edge selection")
    if not (0 <= width <= 21 and 0.3 <= sigma <= 5 and 0 < corridor_px <= 200 and 0 < min_contrast <= 255):
        raise ValueError("invalid caliper sampling parameters")
    centers, normals = np.asarray(centers, dtype=float), np.asarray(normals, dtype=float)
    if (centers.ndim != 2 or centers.shape[1] != 2 or centers.shape != normals.shape or
            not np.isfinite(centers).all() or not np.isfinite(normals).all()):
        raise ValueError("caliper centers and normals must be finite Nx2 arrays")
    gray = float_frame(gray)
    offsets, across = _profile_grid(corridor_px, width, sigma)
    if chunk_calipers is None:
        chunk_calipers = max(1, min(256, _CHUNK_SAMPLES // (len(offsets) * len(across))))
    tangents = np.column_stack([-normals[:, 1], normals[:, 0]])
    h, w = gray.shape[:2]
    flank = max(2, round(3 * sigma / _STEP))
    points, selected_normals, strengths, selected_indices = [], [], [], []
    ambiguous = outside = 0
    for begin in range(0, len(centers), int(chunk_calipers)):
        stop = min(begin + int(chunk_calipers), len(centers))
        c, n, t = centers[begin:stop], normals[begin:stop], tangents[begin:stop]
        coords = (c[:, None, None, :] + offsets[None, :, None, None] * n[:, None, None, :] +
                  across[None, None, :, None] * t[:, None, None, :])
        inside = ((coords[..., 0] >= 0) & (coords[..., 0] <= w - 1) &
                  (coords[..., 1] >= 0) & (coords[..., 1] <= h - 1)).all(axis=(1, 2))
        outside += int((~inside).sum())
        if not inside.any():
            continue
        profiles = _bilinear_sample(gray, coords[inside, ..., 0], coords[inside, ..., 1]).mean(axis=2)
        del coords
        derivative = gaussian_filter1d(profiles, sigma / _STEP, order=1, axis=1, mode="nearest") / _STEP
        scores = np.abs(derivative) if polarity == "any" else derivative * (1 if polarity == "rising" else -1)
        for row, index in enumerate(np.flatnonzero(inside) + begin):
            values = scores[row]
            peak = ((values[1:-1] >= values[:-2]) & (values[1:-1] > values[2:]) &
                    (values[1:-1] >= max(2.0, float(values.max()) * 0.15)))
            candidates = []
            for k in np.flatnonzero(peak) + 1:
                curvature = values[k-1] + values[k+1] - 2 * values[k]
                if curvature >= -1e-12:
                    continue
                vertex = (values[k-1] - values[k+1]) / (2 * curvature)
                location = offsets[k] + _STEP * vertex
                if abs(vertex) > 0.6 or abs(location) > corridor_px:
                    continue
                contrast = abs(profiles[row, min(k+flank, len(offsets)-1)] - profiles[row, max(k-flank, 0)])
                if contrast >= min_contrast:
                    candidates.append((location, values[k]))
            if not candidates:
                continue
            if len(candidates) > 1 and selection == "unique":
                ambiguous += 1
                continue
            if selection == "strongest":
                location, strength = max(candidates, key=lambda p: p[1])
            elif selection == "closest":
                location, strength = min(candidates, key=lambda p: abs(p[0]))
            else:
                location, strength = candidates[0]
            points.append(centers[index] + location * normals[index])
            selected_normals.append(normals[index])
            strengths.append(strength)
            selected_indices.append(index)
    return CaliperEdges(np.asarray(points).reshape(-1, 2), np.asarray(selected_normals).reshape(-1, 2),
                        np.asarray(strengths), np.asarray(selected_indices, dtype=int),
                        len(centers), ambiguous, outside)
