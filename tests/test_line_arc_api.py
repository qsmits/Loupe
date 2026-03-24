from tests.conftest import *
import numpy as np
import cv2
import io


def _load_frame_with_line(client):
    """Load a frame with a horizontal white line into the frame store."""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.line(frame, (50, 240), (590, 240), (255, 255, 255), 2)
    ok, buf = cv2.imencode(".jpg", frame)
    r = client.post("/load-image", files={"file": ("test.jpg", io.BytesIO(buf.tobytes()), "image/jpeg")})
    assert r.status_code == 200


def test_detect_lines_merged_returns_list(client):
    _load_frame_with_line(client)
    r = client.post("/detect-lines-merged", json={})
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)


def test_detect_arcs_partial_returns_list(client):
    _load_frame_with_line(client)
    r = client.post("/detect-arcs-partial", json={})
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_detect_lines_merged_400_without_freeze(client):
    r = client.post("/detect-lines-merged", json={})
    assert r.status_code == 400


def test_match_dxf_lines_returns_results(client):
    _load_frame_with_line(client)
    detected = [{"x1": 50, "y1": 240, "x2": 590, "y2": 240, "length": 540.0}]
    dxf_line = {"type": "line", "x1": 0.0, "y1": 0.0, "x2": 54.0, "y2": 0.0, "handle": "X1"}
    r = client.post("/match-dxf-lines", json={
        "entities": [dxf_line],
        "lines": detected,
        "pixels_per_mm": 10.0,
        "tx": 50.0, "ty": 240.0, "angle_deg": 0.0,
        "tolerance_warn": 0.10, "tolerance_fail": 0.25,
    })
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert "matched" in data[0]


def test_match_dxf_arcs_returns_results(client):
    _load_frame_with_line(client)
    detected = [{"cx": 320.0, "cy": 240.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}]
    dxf_arc = {"type": "arc", "cx": 27.0, "cy": 0.0, "radius": 10.0,
               "start_angle": 0.0, "end_angle": 90.0, "handle": "Y1"}
    r = client.post("/match-dxf-arcs", json={
        "entities": [dxf_arc],
        "arcs": detected,
        "pixels_per_mm": 10.0,
        "tx": 50.0, "ty": 240.0, "angle_deg": 0.0,
        "tolerance_warn": 0.10, "tolerance_fail": 0.25,
    })
    assert r.status_code == 200
    assert len(r.json()) == 1
