import io
import math
import os
import pytest
import ezdxf
from backend.vision.dxf_parser import parse_dxf


def _make_dxf(**entities) -> bytes:
    """Helper: create valid DXF bytes with requested entities."""
    doc = ezdxf.new()
    msp = doc.modelspace()
    if entities.get("line"):
        msp.add_line((0, 0, 0), (100, 0, 0))
    if entities.get("circle"):
        msp.add_circle((50, 50, 0), radius=25)
    if entities.get("arc"):
        msp.add_arc((0, 0, 0), radius=30, start_angle=0, end_angle=90)
    if entities.get("lwpolyline"):
        msp.add_lwpolyline([(0, 0), (10, 0), (10, 10)], close=True)
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode()


def test_parse_dxf_line():
    entities = parse_dxf(_make_dxf(line=True))
    lines = [e for e in entities if e["type"] == "line"]
    assert len(lines) == 1
    assert lines[0]["x1"] == pytest.approx(0.0)
    assert lines[0]["x2"] == pytest.approx(100.0)
    assert lines[0]["y1"] == pytest.approx(0.0)
    assert lines[0]["y2"] == pytest.approx(0.0)


def test_parse_dxf_circle():
    entities = parse_dxf(_make_dxf(circle=True))
    circles = [e for e in entities if e["type"] == "circle"]
    assert len(circles) == 1
    assert circles[0]["cx"] == pytest.approx(50.0)
    assert circles[0]["cy"] == pytest.approx(50.0)
    assert circles[0]["radius"] == pytest.approx(25.0)


def test_parse_dxf_arc():
    entities = parse_dxf(_make_dxf(arc=True))
    arcs = [e for e in entities if e["type"] == "arc"]
    assert len(arcs) == 1
    assert arcs[0]["radius"] == pytest.approx(30.0)
    assert arcs[0]["start_angle"] == pytest.approx(0.0)
    assert arcs[0]["end_angle"] == pytest.approx(90.0)



def test_parse_dxf_empty_drawing():
    entities = parse_dxf(_make_dxf())
    assert entities == []


def test_parse_dxf_invalid_raises():
    with pytest.raises(ValueError):
        parse_dxf(b"this is not a dxf file")


def test_parse_dxf_circle_has_handle():
    entities = parse_dxf(_make_dxf(circle=True))
    circles = [e for e in entities if e["type"] == "circle"]
    assert "handle" in circles[0]
    h = circles[0]["handle"]
    assert h is None or (isinstance(h, str) and len(h) > 0)


def test_parse_dxf_line_has_handle():
    entities = parse_dxf(_make_dxf(line=True))
    lines = [e for e in entities if e["type"] == "line"]
    assert "handle" in lines[0]
    h = lines[0]["handle"]
    assert h is None or (isinstance(h, str) and len(h) > 0)


def test_parse_dxf_arc_has_handle():
    entities = parse_dxf(_make_dxf(arc=True))
    arcs = [e for e in entities if e["type"] == "arc"]
    assert "handle" in arcs[0]
    h = arcs[0]["handle"]
    assert h is None or (isinstance(h, str) and len(h) > 0)



def test_parse_dxf_handles_are_unique_across_entities():
    """Entities in a multi-entity DXF must have distinct non-None handles."""
    entities = parse_dxf(_make_dxf(line=True, circle=True, arc=True))
    handles = [e["handle"] for e in entities if e["handle"] is not None]
    assert len(handles) > 0
    assert len(handles) == len(set(handles))


def _make_dxf_bulge_polyline() -> bytes:
    """LWPOLYLINE with one 90° arc segment (bulge=tan(22.5°)≈0.4142) and one straight segment."""
    doc = ezdxf.new()
    msp = doc.modelspace()
    pts = [(0, 0, 0.0), (10, 0, 0.4142), (0, 10, 0.0)]
    msp.add_lwpolyline(pts, format="xyb", close=False)
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode()


def test_lwpolyline_straight_segment_emits_polyline_line():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    lines = [e for e in entities if e["type"] == "polyline_line"]
    assert any(
        e["x1"] == pytest.approx(0.0) and e["y1"] == pytest.approx(0.0) and
        e["x2"] == pytest.approx(10.0) and e["y2"] == pytest.approx(0.0)
        for e in lines
    )


def test_lwpolyline_bulge_segment_emits_polyline_arc():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    arcs = [e for e in entities if e["type"] == "polyline_arc"]
    assert len(arcs) == 1
    a = arcs[0]
    assert a["cx"] == pytest.approx(0.0, abs=0.1)
    assert a["cy"] == pytest.approx(0.0, abs=0.1)
    assert a["radius"] == pytest.approx(10.0, abs=0.1)


def test_lwpolyline_arc_has_parent_handle():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    arcs = [e for e in entities if e["type"] == "polyline_arc"]
    assert len(arcs) == 1
    assert arcs[0]["parent_handle"] is not None
    assert arcs[0]["segment_index"] == 1


def test_lwpolyline_line_has_parent_handle():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    lines = [e for e in entities if e["type"] == "polyline_line"]
    assert len(lines) >= 1
    assert lines[0]["parent_handle"] is not None
    assert "segment_index" in lines[0]


def test_lwpolyline_closed_emits_n_segments():
    """Closed LWPOLYLINE with N vertices emits exactly N segments."""
    doc = ezdxf.new()
    msp = doc.modelspace()
    msp.add_lwpolyline([(0,0), (10,0), (5,8)], close=True)
    buf = io.StringIO()
    doc.write(buf)
    entities = parse_dxf(buf.getvalue().encode())
    segs = [e for e in entities if e["type"] in ("polyline_line", "polyline_arc")]
    assert len(segs) == 3


def test_lwpolyline_no_longer_emits_polyline_type():
    """After M3, parse_dxf should not emit the old 'polyline' type."""
    entities = parse_dxf(_make_dxf(lwpolyline=True))
    old_type = [e for e in entities if e["type"] == "polyline"]
    assert old_type == []


def test_vblock_dxf_has_polyline_arcs():
    """The demuth vblock.dxf file must produce polyline_arc entities for the 90° bulge segments."""
    dxf_path = os.path.join(os.path.dirname(__file__), "..", "demuth vblock.dxf")
    with open(dxf_path, "rb") as f:
        content = f.read()
    entities = parse_dxf(content)
    arcs = [e for e in entities if e["type"] == "polyline_arc"]
    assert len(arcs) >= 2
    ninety_deg = [a for a in arcs if abs(a["radius"] - 10.0) < 1.0]
    assert len(ninety_deg) >= 2
