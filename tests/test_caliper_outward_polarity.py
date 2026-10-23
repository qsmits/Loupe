"""Caliper polarity is defined along a direction-independent OUTWARD normal.

"Outward" is evaluated in image space after the DXF -> image transform:
away from a circle/arc centre, away from a closed outline's interior, or away
from the drawing centre for a standalone line. Neither the direction in which
a CAD line was drawn, the vertex order of a closed polyline, nor an overlay
flip may change which brightness transition a polarity recipe selects.
"""
import io
import math

import cv2
import ezdxf
import numpy as np
import pytest
from scipy.special import erf

from backend.vision.dxf_parser import parse_dxf
from backend.vision.guided_inspection import inspect_features
from backend.vision.line_arc_matching import dxf_to_image_px
from tests.test_metrology_accuracy import bgr

SELECTIONS = ["unique", "closest", "first", "strongest"]


def polarity_scene():
    """Falling texture near nominal x=100.37, rising real edge 8 px right."""
    y, x = np.mgrid[:160, :200]
    image = 180 - 100*(1+erf((x-100.37)/np.sqrt(2)))/2 + 150*(1+erf((x-108.37)/np.sqrt(2)))/2
    return bgr(np.rint(image).astype(np.uint8))


@pytest.mark.parametrize("selection", SELECTIONS)
def test_line_direction_does_not_change_polarity_result(selection):
    frame = polarity_scene()
    results = []
    for ends in [((0, -5), (0, 5)), ((0, 5), (0, -5))]:
        entity = {"type": "line", "handle": "L", "x1": ends[0][0], "y1": ends[0][1],
                  "x2": ends[1][0], "y2": ends[1][1]}
        r = inspect_features(frame, [entity], 10, tx=100.37, ty=80, edge_method="caliper",
                             caliper={"polarity": "rising", "selection": selection})[0]
        assert r["matched"], r["reason"]
        results.append(r)
    for r in results:
        assert abs(r["perp_dev_mm"]) == pytest.approx(0.8, abs=0.01)
        assert r["pass_fail"] == "fail"
        # A lone line passes through the drawing centre: canonical orientation.
        assert r["sampling_quality"]["normal_rule"] == "canonical"


@pytest.mark.parametrize("flip_h,flip_v", [(True, False), (False, True), (True, True)])
def test_overlay_flips_do_not_change_polarity_result(flip_h, flip_v):
    frame = polarity_scene()
    entity = {"type": "line", "handle": "L", "x1": 0, "y1": -5, "x2": 0, "y2": 5}
    r = inspect_features(frame, [entity], 10, tx=100.37, ty=80, flip_h=flip_h, flip_v=flip_v,
                         edge_method="caliper", caliper={"polarity": "rising"})[0]
    assert r["matched"], r["reason"]
    assert abs(r["perp_dev_mm"]) == pytest.approx(0.8, abs=0.01)
    assert r["pass_fail"] == "fail"


# ── closed polyline loops, parsed from a real DXF ─────────────────────────────

def _polyline_entities(points, closed=True):
    """[(x, y, bulge), ...] -> entities via the production DXF parser."""
    doc = ezdxf.new()
    doc.modelspace().add_lwpolyline(points, format="xyb", close=closed)
    stream = io.StringIO()
    doc.write(stream)
    return parse_dxf(stream.getvalue().encode())["entities"]


def _reverse_polyline(points):
    """Reverse vertex order; a bulge belongs to the segment leaving its vertex."""
    n = len(points)
    return [(points[(-i) % n][0], points[(-i) % n][1], -points[(-i - 1) % n][2]) for i in range(n)]


def _outline_image_pts(entities, ppm, tx, ty, angle_deg=0.0):
    pts = []
    for e in sorted(entities, key=lambda e: e["segment_index"]):
        if e["type"] == "polyline_line":
            pts.append((e["x1"], e["y1"]))
        else:
            sweep = (e["end_angle"] - e["start_angle"]) % 360
            a = np.radians(e["start_angle"] + np.linspace(0, sweep, 64))
            arc = [(e["cx"] + e["radius"]*math.cos(t), e["cy"] + e["radius"]*math.sin(t)) for t in a]
            # Orient the arc so it continues from the previous vertex.
            if pts and math.dist(arc[-1], pts[-1]) < math.dist(arc[0], pts[-1]):
                arc = arc[::-1]
            pts.extend(arc)
    return np.array([dxf_to_image_px(px, py, ppm, tx, ty, math.radians(angle_deg)) for px, py in pts])


def _loop_frame(entities, inside, outside, shape=(240, 320), ppm=10, tx=160.37, ty=120.81):
    h, w = shape
    mask = np.zeros((h*8, w*8), np.uint8)
    poly = np.rint((_outline_image_pts(entities, ppm, tx, ty) + 0.5) * 8 - 0.5).astype(np.int32)
    cv2.fillPoly(mask, [poly], 255)
    frac = cv2.resize(mask.astype(float)/255, (w, h), interpolation=cv2.INTER_AREA)
    image = cv2.GaussianBlur(outside + (inside-outside)*frac, (0, 0), 1.0)
    return bgr(np.clip(np.rint(image), 0, 255).astype(np.uint8))


RECTANGLE = [(-6, -4, 0), (6, -4, 0), (6, 4, 0), (-6, 4, 0)]
# Rounded top-right corner: a 90 degree CCW bulge from (6, 2) to (4, 4).
ROUNDED = [(-6, -4, 0), (6, -4, 0), (6, 2, math.tan(math.radians(90) / 4)), (4, 4, 0), (-6, 4, 0)]


@pytest.mark.parametrize("outline", [RECTANGLE, ROUNDED], ids=["rectangle", "rounded"])
@pytest.mark.parametrize("order", ["ccw", "cw"])
def test_closed_outline_falling_matches_every_side(outline, order):
    points = outline if order == "ccw" else _reverse_polyline(outline)
    entities = _polyline_entities(points)
    assert all(e.get("parent_handle") for e in entities)
    frame = _loop_frame(entities, inside=200, outside=50)
    results = inspect_features(frame, entities, 10, tx=160.37, ty=120.81, edge_method="caliper",
                               caliper={"polarity": "falling"})
    for r in results:
        assert r["matched"], (r["handle"], r["reason"])
        assert r["sampling_quality"]["normal_rule"] == "loop"
        if r["perp_dev_mm"] is not None:
            assert abs(r["perp_dev_mm"]) < 0.02
        else:
            assert abs(r["radius_dev_mm"]) < 0.03
    # Wrong polarity finds nothing on any side, in either vertex order.
    wrong = inspect_features(frame, entities, 10, tx=160.37, ty=120.81, edge_method="caliper",
                             caliper={"polarity": "rising"})
    assert not any(r["matched"] for r in wrong)


@pytest.mark.parametrize("order", ["ccw", "cw"])
def test_closed_hole_in_brighter_material_is_rising(order):
    points = RECTANGLE if order == "ccw" else _reverse_polyline(RECTANGLE)
    entities = _polyline_entities(points)
    frame = _loop_frame(entities, inside=40, outside=210)
    results = inspect_features(frame, entities, 10, tx=160.37, ty=120.81, edge_method="caliper",
                               caliper={"polarity": "rising"})
    assert all(r["matched"] for r in results), [r["reason"] for r in results]
    assert all(abs(r["perp_dev_mm"]) < 0.02 for r in results)


def test_flipped_closed_outline_keeps_outward_polarity():
    entities = _polyline_entities(RECTANGLE)
    frame = _loop_frame(entities, inside=200, outside=50)
    for flip_h, flip_v in [(True, False), (False, True)]:
        results = inspect_features(frame, entities, 10, tx=160.37, ty=120.81, flip_h=flip_h,
                                   flip_v=flip_v, edge_method="caliper",
                                   caliper={"polarity": "falling"})
        assert all(r["matched"] for r in results), [r["reason"] for r in results]


def test_open_polyline_uses_drawing_centre():
    # Same rectangle, but the polyline is open (three sides) plus a lone circle
    # in the middle: lines face away from the drawing centre.
    entities = _polyline_entities(RECTANGLE, closed=False)
    entities.append({"type": "circle", "handle": "C", "cx": 0, "cy": 0, "radius": 1.5})
    frame = _loop_frame(_polyline_entities(RECTANGLE), inside=200, outside=50)
    results = inspect_features(frame, entities, 10, tx=160.37, ty=120.81, edge_method="caliper",
                               caliper={"polarity": "falling"})
    lines = [r for r in results if r["type"] == "polyline_line"]
    assert len(lines) == 3
    for r in lines:
        assert r["matched"], r["reason"]
        assert r["sampling_quality"]["normal_rule"] == "centroid"


@pytest.mark.parametrize("reverse", [False, True])
def test_standalone_line_faces_away_from_drawing_centre(reverse):
    # A circle sits to the RIGHT of the line, so outward is -x (the canonical
    # rule would pick +x). Going -x: rising step at x=100.37 (80 -> 200),
    # falling step at x=108.37 (180 -> 80).
    y, x = np.mgrid[:160, :200]
    image = 200 - 120*(1+erf((x-100.37)/np.sqrt(2)))/2 + 100*(1+erf((x-108.37)/np.sqrt(2)))/2
    frame = bgr(np.rint(image).astype(np.uint8))
    a, b = (0, -5), (0, 5)
    if reverse:
        a, b = b, a
    entities = [{"type": "line", "handle": "L", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]},
                {"type": "circle", "handle": "C", "cx": 5, "cy": 0, "radius": 1}]
    for polarity, expected in [("falling", 0.8), ("rising", 0.0)]:
        r = inspect_features(frame, entities, 10, tx=100.37, ty=80, edge_method="caliper",
                             caliper={"polarity": polarity})[0]
        assert r["matched"], r["reason"]
        assert r["sampling_quality"]["normal_rule"] == "centroid"
        assert abs(r["perp_dev_mm"]) == pytest.approx(expected, abs=0.01)


def test_per_entity_polarity_override_uses_outward_normal():
    y, x = np.mgrid[:160, :200]
    image = 200 - 120*(1+erf((x-100.37)/np.sqrt(2)))/2 + 100*(1+erf((x-108.37)/np.sqrt(2)))/2
    frame = bgr(np.rint(image).astype(np.uint8))
    for a, b in [((0, -5), (0, 5)), ((0, 5), (0, -5))]:
        entities = [{"type": "line", "handle": "L", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1],
                     "edge_polarity": "rising"},
                    {"type": "circle", "handle": "C", "cx": 5, "cy": 0, "radius": 1}]
        # Recipe "falling" would select x=108.37; the override selects the
        # rising step at x=100.37 going outward (-x).
        r = inspect_features(frame, entities, 10, tx=100.37, ty=80, edge_method="caliper",
                             caliper={"polarity": "falling"})[0]
        assert r["matched"], r["reason"]
        assert abs(r["perp_dev_mm"]) == pytest.approx(0.0, abs=0.01)
        assert r["sampling_quality"]["polarity"] == "rising"


def test_circle_and_arc_report_radial_rule():
    y, x = np.mgrid[:240, :320]
    image = 127.5 * (1 + erf((np.hypot(x-160.37, y-120.81)-65.37) / (np.sqrt(2)*1.5)))
    frame = bgr(np.rint(image).astype(np.uint8))
    for entity in [{"type": "circle", "handle": "C", "cx": 0, "cy": 0, "radius": 6.537},
                   {"type": "arc", "handle": "A", "cx": 0, "cy": 0, "radius": 6.537,
                    "start_angle": 20, "end_angle": 150}]:
        r = inspect_features(frame, [entity], 10, tx=160.37, ty=120.81, edge_method="caliper",
                             caliper={"polarity": "rising"})[0]
        assert r["matched"], r["reason"]
        assert r["sampling_quality"]["normal_rule"] == "radial"
