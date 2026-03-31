"""
Fixture-driven tests for M2. These fail until Tasks 2-4 complete.
Run: .venv/bin/pytest tests/test_detection_fixtures.py -v
"""
import json, pathlib
import cv2, numpy as np
import pytest

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "detection"
LINE_TOL_PX = 10
ARC_CENTER_TOL_PX = 5
ARC_RADIUS_TOL_FRAC = 0.05
ARC_SPAN_TOL_DEG = 10.0


def _load(name):
    img = cv2.imread(str(FIXTURES / f"{name}.png"))
    assert img is not None
    meta = json.loads((FIXTURES / f"{name}.json").read_text())
    return img, meta


def _line_matched(gt, detected_lines, tol=LINE_TOL_PX):
    gp1, gp2 = (gt[0], gt[1]), (gt[2], gt[3])
    for dl in detected_lines:
        dp1, dp2 = (dl["x1"], dl["y1"]), (dl["x2"], dl["y2"])
        fwd = np.hypot(gp1[0]-dp1[0],gp1[1]-dp1[1]) < tol and np.hypot(gp2[0]-dp2[0],gp2[1]-dp2[1]) < tol
        bwd = np.hypot(gp1[0]-dp2[0],gp1[1]-dp2[1]) < tol and np.hypot(gp2[0]-dp1[0],gp2[1]-dp1[1]) < tol
        if fwd or bwd: return True
    return False


def _arc_matched(gt, detected_arcs):
    for da in detected_arcs:
        dist = np.hypot(da["cx"]-gt["cx"], da["cy"]-gt["cy"])
        r_err = abs(da["r"]-gt["r"]) / (gt["r"]+1e-6)
        span_ok = (abs(da["start_deg"]-gt["start_deg"]) < ARC_SPAN_TOL_DEG and
                   abs(da["end_deg"]-gt["end_deg"]) < ARC_SPAN_TOL_DEG)
        if dist < ARC_CENTER_TOL_PX and r_err < ARC_RADIUS_TOL_FRAC and span_ok:
            return True
    return False


class TestRectEdgesContour:
    def test_detects_90pct_edges(self):
        from backend.vision.detection import detect_lines_contour
        img, meta = _load("rect_edges")
        lines = detect_lines_contour(img, min_edge_density=0)
        matched = sum(1 for gt in meta["edges"] if _line_matched(gt, lines))
        assert matched >= len(meta["edges"]) * 0.9

    def test_no_duplicate_per_edge(self):
        from backend.vision.detection import detect_lines_contour
        img, meta = _load("rect_edges")
        lines = detect_lines_contour(img)
        for gt in meta["edges"]:
            count = sum(1 for dl in lines if _line_matched(gt, [dl]))
            assert count <= 1


class TestRectEdgesMerged:
    def test_detects_90pct_edges(self):
        from backend.vision.detection import merge_line_segments
        img, meta = _load("rect_edges")
        lines = merge_line_segments(img)
        matched = sum(1 for gt in meta["edges"] if _line_matched(gt, lines))
        assert matched >= len(meta["edges"]) * 0.9


class TestHoughFragmentsMerged:
    def test_single_edge_one_segment(self):
        from backend.vision.detection import merge_line_segments
        img, _ = _load("hough_fragments")
        assert len(merge_line_segments(img)) == 1

    def test_merged_matches_ground_truth(self):
        from backend.vision.detection import merge_line_segments
        img, meta = _load("hough_fragments")
        assert _line_matched(meta["edges"][0], merge_line_segments(img), tol=20)


class TestPartialArcFixture:
    def test_detects_arc(self):
        from backend.vision.detection import detect_partial_arcs
        img, _ = _load("partial_arc")
        assert len(detect_partial_arcs(img)) >= 1

    def test_arc_geometry_within_tolerance(self):
        from backend.vision.detection import detect_partial_arcs
        img, meta = _load("partial_arc")
        assert _arc_matched(meta["arcs"][0], detect_partial_arcs(img))
