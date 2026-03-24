import math
import pytest
from backend.vision.line_arc_matching import match_lines, match_arcs


def test_match_lines_perfect_match():
    dxf_lines = [{"type": "line", "x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0, "handle": "A1"}]
    # Detected line at same position in pixels (ppm=10, shift=100px)
    detected = [{"x1": 100, "y1": 0, "x2": 200, "y2": 0, "length": 100.0}]
    ppm = 10.0
    results = match_lines(dxf_lines, detected, ppm, tx=100, ty=0, angle_deg=0)
    assert len(results) == 1
    r = results[0]
    assert r["matched"] is True
    assert r["perp_dev_mm"] == pytest.approx(0.0, abs=0.01)
    assert r["angle_error_deg"] == pytest.approx(0.0, abs=0.5)


def test_match_lines_no_match_returns_unmatched():
    dxf_lines = [{"type": "line", "x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0, "handle": "A1"}]
    detected = []
    results = match_lines(dxf_lines, detected, ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert results[0]["matched"] is False


def test_match_arcs_perfect_match():
    dxf_arcs = [{"type": "arc", "cx": 0.0, "cy": 0.0, "radius": 10.0,
                 "start_angle": 0.0, "end_angle": 90.0, "handle": "B1"}]
    ppm = 10.0
    # Detected arc at DXF position scaled to pixels
    detected = [{"cx": 0.0, "cy": 0.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}]
    results = match_arcs(dxf_arcs, detected, ppm, tx=0, ty=0, angle_deg=0)
    assert results[0]["matched"] is True
    assert results[0]["center_dev_mm"] == pytest.approx(0.0, abs=0.01)
    assert results[0]["radius_dev_mm"] == pytest.approx(0.0, abs=0.01)


def test_match_arcs_no_match():
    dxf_arcs = [{"type": "arc", "cx": 0.0, "cy": 0.0, "radius": 10.0,
                 "start_angle": 0.0, "end_angle": 90.0, "handle": "B1"}]
    results = match_arcs(dxf_arcs, [], ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert results[0]["matched"] is False


def test_match_lines_accepts_polyline_line_type():
    """match_lines must match entities with type 'polyline_line'."""
    entities = [{"type": "polyline_line", "x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0,
                 "handle": "142_s0", "parent_handle": "142", "segment_index": 0}]
    detected = [{"x1": 100, "y1": 0, "x2": 200, "y2": 0, "length": 100.0}]
    results = match_lines(entities, detected, ppm=10.0, tx=100, ty=0, angle_deg=0)
    assert len(results) == 1
    assert results[0]["matched"] is True
    assert results[0]["handle"] == "142_s0"


def test_match_arcs_accepts_polyline_arc_type():
    """match_arcs must match entities with type 'polyline_arc'."""
    entities = [{"type": "polyline_arc", "cx": 0.0, "cy": 0.0, "radius": 10.0,
                 "start_angle": 0.0, "end_angle": 90.0,
                 "handle": "142_s1", "parent_handle": "142", "segment_index": 1}]
    detected = [{"cx": 0.0, "cy": 0.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}]
    results = match_arcs(entities, detected, ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert len(results) == 1
    assert results[0]["matched"] is True
    assert results[0]["handle"] == "142_s1"


def test_match_lines_skips_non_line_types():
    """match_lines must ignore arc/circle entities (unchanged behaviour)."""
    entities = [{"type": "circle", "cx": 0, "cy": 0, "radius": 5, "handle": "X"}]
    results = match_lines(entities, [], ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert results == []
