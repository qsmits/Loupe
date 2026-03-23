# tests/test_align_dxf_api.py
import math
from tests.conftest import *


_DXF_3_CIRCLES = [
    {"type": "circle", "cx": 0.0, "cy": 0.0, "radius": 5.0},
    {"type": "circle", "cx": 20.0, "cy": 0.0, "radius": 5.0},
    {"type": "circle", "cx": 10.0, "cy": 15.0, "radius": 5.0},
]


def _dxf_to_detected(dxf_circles, ppm, tx, ty):
    """Build detected list with pure translation transform for test setup."""
    return [
        {"x": cx * ppm + tx, "y": -(cy * ppm) + ty, "radius": r * ppm}
        for cx, cy, r in dxf_circles
    ]


def test_align_dxf_returns_transform(client):
    ppm = 10.0
    detected = _dxf_to_detected(
        [(0, 0, 5), (20, 0, 5), (10, 15, 5)], ppm, tx=100.0, ty=80.0
    )
    r = client.post("/align-dxf", json={
        "entities": _DXF_3_CIRCLES,
        "circles": detected,
        "pixels_per_mm": ppm,
    })
    assert r.status_code == 200
    body = r.json()
    assert "tx" in body
    assert "angle_deg" in body
    assert body["confidence"] == "high"
    assert abs(body["tx"] - 100.0) < 2
    assert abs(body["ty"] - 80.0) < 2
    assert abs(body["angle_deg"]) < 2


def test_align_dxf_rejects_missing_pixels_per_mm(client):
    r = client.post("/align-dxf", json={
        "entities": _DXF_3_CIRCLES,
        "circles": [{"x": 50, "y": 50, "radius": 50}],
    })
    assert r.status_code == 422


def test_align_dxf_returns_400_when_fewer_than_2_dxf_circles(client):
    r = client.post("/align-dxf", json={
        "entities": [{"type": "circle", "cx": 0, "cy": 0, "radius": 5}],
        "circles": [{"x": 50, "y": 50, "radius": 50}],
        "pixels_per_mm": 10.0,
    })
    assert r.status_code == 400


def test_align_dxf_returns_400_when_no_dxf_circles(client):
    r = client.post("/align-dxf", json={
        "entities": [{"type": "line", "x1": 0, "y1": 0, "x2": 1, "y2": 1}],
        "circles": [{"x": 50, "y": 50, "radius": 50}],
        "pixels_per_mm": 10.0,
    })
    assert r.status_code == 400
