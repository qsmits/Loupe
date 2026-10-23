"""Detection/inspection routes are bounded by backend.compute_pool.vision_compute."""
import pytest

from backend import compute_pool
from backend.compute_pool import vision_compute

CIRCLES = {"dp": 1.2, "min_dist": 50, "param1": 100, "param2": 30,
           "min_radius": 10, "max_radius": 200}
DXF_ENT = [{"type": "LINE", "x1": 0, "y1": 0, "x2": 1, "y2": 0, "layer": "0"}]
INSPECT = {"entities": DXF_ENT, "pixels_per_mm": 10.0, "tx": 0, "ty": 0,
           "angle_deg": 0, "flip_h": False, "flip_v": False}

# (path, body) for every wrapped route
WRAPPED = [
    ("/detect-edges", {}),
    ("/detect-circles", CIRCLES),
    ("/detect-lines", {}),
    ("/detect-lines-merged", {}),
    ("/detect-arcs-partial", {}),
    ("/preprocessed-view", {}),
    ("/analyze-gear", {"cx": 320, "cy": 240, "tip_r": 100, "root_r": 80, "n_teeth": 12}),
    ("/align-dxf-edges", {"entities": DXF_ENT, "pixels_per_mm": 10.0}),
    ("/inspect-guided", INSPECT),
    ("/detect-gear-teeth", {"cx": 320, "cy": 240, "r_tip": 100, "r_root": 80}),
    ("/auto-phase-gear", {"cx": 320, "cy": 240, "r_tip": 100, "r_root": 80,
                          "n_teeth": 12, "pixels_per_mm": 10.0}),
    ("/gradient-overlay", None),
]


def _post(client, path, body):
    return client.post(path, json=body) if body is not None else client.post(path)


@pytest.mark.parametrize("path,body", WRAPPED)
def test_route_goes_through_vision_compute(client, monkeypatch, path, body):
    client.post("/freeze")
    calls = []
    real = vision_compute.run

    async def counting(fn, *a, **kw):
        calls.append(fn)
        return await real(fn, *a, **kw)

    monkeypatch.setattr(vision_compute, "run", counting)
    r = _post(client, path, body)
    assert r.status_code != 422, r.text  # test body must be valid
    assert len(calls) == 1


@pytest.mark.parametrize("path,body", [("/detect-circles", CIRCLES), ("/inspect-guided", INSPECT)])
def test_saturated_pool_returns_503(client, path, body):
    client.post("/freeze")
    slots = vision_compute._slots
    taken = 0
    try:
        while slots.acquire(blocking=False):
            taken += 1
        r = client.post(path, json=body)
        assert r.status_code == 503
        assert "Analysis capacity is busy" in r.json()["detail"]
        # pure-geometry route is not bounded
        r2 = client.post("/match-dxf-lines", json={
            "entities": [], "lines": [], "pixels_per_mm": 10.0, "tx": 0, "ty": 0,
            "angle_deg": 0, "flip_h": False, "flip_v": False})
        assert r2.status_code == 200
    finally:
        for _ in range(taken):
            slots.release()


def test_validation_happens_before_pool(client):
    client.post("/freeze")
    slots = vision_compute._slots
    taken = 0
    try:
        while slots.acquire(blocking=False):
            taken += 1
        r = client.post("/detect-edges", json={"threshold1": 999})
        assert r.status_code == 422
    finally:
        for _ in range(taken):
            slots.release()


@pytest.mark.parametrize("path,body", WRAPPED)
def test_worker_http_exception_propagates(client, path, body):
    # no /freeze for this session -> HTTPException raised inside the worker
    r = _post(client, path, body)
    assert r.status_code in (400, 404), (path, r.status_code, r.text)
    assert "No frame stored" in r.json()["detail"]
