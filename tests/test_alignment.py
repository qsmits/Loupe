# tests/test_alignment.py
import math
import numpy as np
import pytest
from backend.vision.alignment import extract_dxf_circles, align_circles, _score_transform


def test_extract_dxf_circles_ignores_non_circles():
    entities = [
        {"type": "circle", "cx": 10.0, "cy": 20.0, "radius": 5.0},
        {"type": "line", "x1": 0, "y1": 0, "x2": 1, "y2": 1},
        {"type": "arc", "cx": 5.0, "cy": 5.0, "radius": 3.0},
    ]
    result = extract_dxf_circles(entities)
    assert len(result) == 1
    assert result[0] == (10.0, 20.0, 5.0)


def test_extract_dxf_circles_empty():
    assert extract_dxf_circles([]) == []


def test_extract_dxf_circles_no_circles():
    entities = [{"type": "line", "x1": 0, "y1": 0, "x2": 1, "y2": 1}]
    assert extract_dxf_circles(entities) == []


def test_score_transform_never_matches_one_detection_twice():
    # Two DXF circles both land near the SINGLE detected circle under the
    # identity transform (mapping is mx=dx, my=-dy). A detection must not be
    # counted as an inlier for more than one DXF circle.
    detected = [(100.0, 100.0, 10.0)]
    dxf = [(100.0, -100.0, 10.0), (103.0, -103.0, 10.0)]  # → (100,100) and (103,103)
    inliers = _score_transform(dxf, detected, 0.0, 0.0, 0.0)
    matched_detections = [j for _, j in inliers]
    assert len(matched_detections) == len(set(matched_detections)), \
        "a detected circle was claimed by more than one DXF circle"
    assert len(inliers) <= len(detected)


def test_score_transform_assigns_distinct_detections_one_to_one():
    # Two DXF circles, two distinct detections — each DXF circle should match
    # its own nearest detection, giving two inliers with distinct indices.
    detected = [(100.0, 100.0, 10.0), (200.0, 100.0, 10.0)]
    dxf = [(100.0, -100.0, 10.0), (200.0, -100.0, 10.0)]  # → (100,100) and (200,100)
    inliers = _score_transform(dxf, detected, 0.0, 0.0, 0.0)
    assert len(inliers) == 2
    assert {j for _, j in inliers} == {0, 1}


def test_align_circles_pure_translation():
    # DXF has 3 circles at known mm positions, calibration = 10 px/mm
    # Detected circles are the DXF positions scaled to px, shifted by (50, 30)
    ppm = 10.0
    dxf = [(0.0, 0.0, 5.0), (20.0, 0.0, 5.0), (10.0, 15.0, 5.0)]
    detected = [
        (0*ppm + 50, -(0*ppm) + 30, 5*ppm),    # flip Y: cy = -(y*ppm) + ty
        (20*ppm + 50, -(0*ppm) + 30, 5*ppm),
        (10*ppm + 50, -(15*ppm) + 30, 5*ppm),
    ]
    result = align_circles(dxf, detected, pixels_per_mm=ppm)
    assert result["confidence"] == "high"
    assert result["inlier_count"] == 3  # all 3 should match with correct Y-flip handling
    assert result["flip_h"] is False
    assert result["flip_v"] is False
    assert abs(result["tx"] - 50) < 5
    assert abs(result["ty"] - 30) < 5
    assert abs(result["angle_deg"]) < 2


def test_align_circles_returns_error_with_fewer_than_2_dxf_circles():
    result = align_circles([(5.0, 5.0, 3.0)], [(50, 50, 30)], pixels_per_mm=10.0)
    assert result["error"] == "insufficient_dxf_circles"


def test_align_circles_with_rotation():
    ppm = 10.0
    angle = math.radians(30)
    dxf = [(10.0, 0.0, 4.0), (-10.0, 0.0, 4.0), (0.0, 15.0, 6.0)]
    # Apply rotation + translation in DXF-px-Y-up space, then Y-flip for canvas
    tx, ty = 200.0, 150.0
    detected = []
    for cx_mm, cy_mm, r_mm in dxf:
        cx_px = cx_mm * ppm
        cy_px = cy_mm * ppm
        rx = cx_px * math.cos(angle) - cy_px * math.sin(angle)
        ry = cx_px * math.sin(angle) + cy_px * math.cos(angle)
        # Canvas Y-flip: canvas_y = -ry + ty
        detected.append((rx + tx, -ry + ty, r_mm * ppm))
    result = align_circles(dxf, detected, pixels_per_mm=ppm)
    assert result["confidence"] in ("high", "low")
    assert result["inlier_count"] >= 2
    assert abs(result["angle_deg"] - 30) < 3


def test_align_circles_with_flip_h():
    """flip_h: DXF X axis is mirrored. Backend must detect this."""
    ppm = 10.0
    # Use asymmetric radii so the flip is unambiguous
    dxf = [(10.0, 0.0, 3.0), (-10.0, 0.0, 5.0), (0.0, 15.0, 6.0)]
    tx, ty = 200.0, 150.0
    # Apply flipH to DXF coords, then no rotation, then canvas Y-flip
    detected = []
    for cx_mm, cy_mm, r_mm in dxf:
        # flipH: negate x
        x_f = -cx_mm
        y_f = cy_mm
        # canvas: (x_f * ppm + tx, -(y_f * ppm) + ty)
        detected.append((x_f * ppm + tx, -(y_f * ppm) + ty, r_mm * ppm))
    result = align_circles(dxf, detected, pixels_per_mm=ppm)
    assert result["confidence"] in ("high", "low")
    assert result["inlier_count"] >= 2
    assert result["flip_h"] is True
    assert result["flip_v"] is False
