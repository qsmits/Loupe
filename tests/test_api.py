import pytest


def test_camera_info(client):
    r = client.get("/camera/info")
    assert r.status_code == 200
    data = r.json()
    assert data["model"] == "FakeCamera"
    assert data["width"] == 640
    assert data["height"] == 480


def test_freeze(client):
    r = client.post("/freeze")
    assert r.status_code == 200
    data = r.json()
    assert data["width"] == 640
    assert data["height"] == 480


def test_snapshot_saves_file(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api_camera.SNAPSHOTS_DIR", tmp_path)
    r = client.post("/snapshot")
    assert r.status_code == 200
    filename = r.json()["filename"]
    assert (tmp_path / filename).exists()


def test_detect_edges_requires_freeze_first(client):
    # No freeze yet → 400
    r = client.post("/detect-edges", json={"threshold1": 50, "threshold2": 150})
    assert r.status_code == 400


def test_detect_edges_after_freeze(client):
    client.post("/freeze")
    r = client.post("/detect-edges", json={"threshold1": 50, "threshold2": 150})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_detect_circles_after_freeze(client):
    client.post("/freeze")
    r = client.post("/detect-circles", json={
        "dp": 1.2, "min_dist": 50, "param1": 100,
        "param2": 30, "min_radius": 10, "max_radius": 200
    })
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_detect_circles_requires_freeze_first(client):
    # No freeze yet → 400
    r = client.post("/detect-circles", json={
        "dp": 1.2, "min_dist": 50, "param1": 100,
        "param2": 30, "min_radius": 10, "max_radius": 200
    })
    assert r.status_code == 400


def test_set_exposure(client):
    r = client.put("/camera/exposure", json={"value": 10000.0})
    assert r.status_code == 200


def test_set_gain(client):
    r = client.put("/camera/gain", json={"value": 3.0})
    assert r.status_code == 200


def test_camera_info_includes_device_id(client):
    r = client.get("/camera/info")
    assert r.status_code == 200
    assert "device_id" in r.json()


def test_camera_info_includes_pixel_format(client):
    r = client.get("/camera/info")
    assert r.status_code == 200
    assert "pixel_format" in r.json()


def test_set_pixel_format(client):
    r = client.put("/camera/pixel-format", json={"pixel_format": "BayerRG8"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_set_pixel_format_invalid(client):
    r = client.put("/camera/pixel-format", json={"pixel_format": "NotAFormat"})
    assert r.status_code == 400


def test_camera_info_includes_wb_fields(client):
    r = client.get("/camera/info")
    assert r.status_code == 200
    data = r.json()
    assert "wb_red" in data
    assert "wb_green" in data
    assert "wb_blue" in data
    assert isinstance(data["wb_red"], float)


def test_auto_white_balance(client):
    r = client.post("/camera/white-balance/auto")
    assert r.status_code == 200
    data = r.json()
    assert "red" in data
    assert "green" in data
    assert "blue" in data


def test_set_white_balance_ratio(client):
    r = client.put("/camera/white-balance/ratio",
                   json={"channel": "Red", "value": 1.2})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_set_white_balance_ratio_invalid_channel(client):
    r = client.put("/camera/white-balance/ratio",
                   json={"channel": "Ultraviolet", "value": 1.0})
    assert r.status_code == 400


def test_set_white_balance_ratio_out_of_range(client):
    r = client.put("/camera/white-balance/ratio",
                   json={"channel": "Red", "value": 99.0})
    assert r.status_code == 400


def test_list_cameras_returns_list(client, monkeypatch):
    # Stub out hardware probing — list_aravis_cameras requires GI, list_opencv_cameras
    # opens VideoCapture devices which wakes hardware (including iPhone Continuity Camera).
    monkeypatch.setattr("backend.cameras.aravis.list_aravis_cameras", lambda: [])
    monkeypatch.setattr("backend.cameras.opencv.list_opencv_cameras", lambda: [
        {"id": "opencv-0", "vendor": "Webcam", "label": "Webcam 1"},
    ])
    r = client.get("/cameras")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    assert "id" in data[0]
    assert "label" in data[0]


def test_select_camera_opencv_nonexistent_rejected(client):
    # Index 99 will never open; switch_camera raises → 400
    r = client.post("/camera/select", json={"camera_id": "opencv-99"})
    assert r.status_code == 400


def test_select_camera_aravis_unavailable(client):
    # In the test environment Aravis is unavailable, so AravisCamera.__init__
    # raises ImportError — the endpoint catches all exceptions as 400.
    r = client.post("/camera/select", json={"camera_id": "Aravis-USB0-fake"})
    assert r.status_code == 400


def test_list_snapshots_dir_not_exist(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api_camera.SNAPSHOTS_DIR", tmp_path / "nonexistent")
    r = client.get("/snapshots")
    assert r.status_code == 200
    assert r.json() == []


def test_list_snapshots_empty(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api_camera.SNAPSHOTS_DIR", tmp_path)
    r = client.get("/snapshots")
    assert r.status_code == 200
    assert r.json() == []


def test_list_snapshots_returns_files(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api_camera.SNAPSHOTS_DIR", tmp_path)
    import numpy as np, cv2
    for name in ["20260101_120000.jpg", "20260102_130000.jpg"]:
        cv2.imwrite(str(tmp_path / name), np.full((10, 10, 3), 128, dtype=np.uint8))
    r = client.get("/snapshots")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 2
    assert all({"filename", "size_kb", "timestamp"} <= set(s.keys()) for s in data)


def test_load_snapshot(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api_camera.SNAPSHOTS_DIR", tmp_path)
    import numpy as np, cv2
    cv2.imwrite(str(tmp_path / "test.jpg"), np.full((100, 100, 3), 128, dtype=np.uint8))
    r = client.post("/load-snapshot", json={"filename": "test.jpg"})
    assert r.status_code == 200
    assert {"width", "height"} <= set(r.json().keys())
    frame_r = client.get("/frame")
    assert frame_r.status_code == 200


def test_load_snapshot_path_traversal(client):
    r = client.post("/load-snapshot", json={"filename": "../etc/passwd"})
    assert r.status_code in (400, 422)


def test_load_snapshot_not_found(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api_camera.SNAPSHOTS_DIR", tmp_path)
    r = client.post("/load-snapshot", json={"filename": "nonexistent.jpg"})
    assert r.status_code == 404


def test_preprocessed_view_requires_freeze(client):
    r = client.post("/preprocessed-view")
    assert r.status_code == 400


def test_preprocessed_view_after_freeze(client):
    client.post("/freeze")
    r = client.post("/preprocessed-view")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/jpeg")
    assert len(r.content) > 0


def test_load_dxf_returns_entities(client):
    import ezdxf, io
    doc = ezdxf.new()
    doc.modelspace().add_line((0, 0, 0), (100, 0, 0))
    buf = io.StringIO()
    doc.write(buf)
    dxf_bytes = buf.getvalue().encode()
    r = client.post(
        "/load-dxf",
        files={"file": ("test.dxf", dxf_bytes, "application/octet-stream")},
    )
    assert r.status_code == 200
    entities = r.json()
    assert isinstance(entities, list)
    lines = [e for e in entities if e["type"] == "line"]
    assert len(lines) == 1


def test_load_dxf_invalid_file(client):
    r = client.post(
        "/load-dxf",
        files={"file": ("bad.dxf", b"not a dxf file", "application/octet-stream")},
    )
    assert r.status_code == 400


# --- Gear analysis ---


def test_analyze_gear_requires_freeze_first(client):
    r = client.post("/analyze-gear", json={
        "cx": 320, "cy": 240, "tip_r": 100, "root_r": 80, "n_teeth": 17,
    })
    assert r.status_code == 400
    assert "freeze" in r.json()["detail"].lower()


def test_analyze_gear_after_freeze_returns_shape(client):
    client.post("/freeze")
    r = client.post("/analyze-gear", json={
        "cx": 320, "cy": 240, "tip_r": 100, "root_r": 80, "n_teeth": 17,
    })
    assert r.status_code == 200
    body = r.json()
    assert "pcd_radius_px" in body
    assert "teeth" in body
    assert isinstance(body["teeth"], list)


def test_analyze_gear_rejects_bad_radii(client):
    client.post("/freeze")
    r = client.post("/analyze-gear", json={
        "cx": 320, "cy": 240, "tip_r": 50, "root_r": 80, "n_teeth": 17,
    })
    assert r.status_code == 422


# --- /generate-gear-dxf: synthetic ideal gear → DXF entities ---
#
# These tests document the contract: the endpoint emits the same entity
# dict shape as /load-dxf produces for an LWPOLYLINE (i.e. a sequence of
# polyline_line segments sharing a parent_handle), so the result can be
# loaded directly into the existing DXF overlay and pushed through
# /inspect-guided without any special-case handling on either side.


def _gear_req(**overrides):
    body = {
        "n_teeth": 17,
        "profile": "cycloidal",
        "module": 1.0,
        "cx": 100.0,
        "cy": 50.0,
    }
    body.update(overrides)
    return body


def test_generate_gear_dxf_cycloidal_returns_entities(client):
    r = client.post("/generate-gear-dxf", json=_gear_req())
    assert r.status_code == 200, r.text
    entities = r.json()
    assert isinstance(entities, list)
    assert len(entities) > 17 * 4  # at least a handful of segments per tooth


def test_generate_gear_dxf_involute_returns_entities(client):
    r = client.post("/generate-gear-dxf", json=_gear_req(profile="involute", n_teeth=20))
    assert r.status_code == 200, r.text
    entities = r.json()
    assert len(entities) > 20 * 4


def test_generate_gear_dxf_emits_polyline_lines_only(client):
    r = client.post("/generate-gear-dxf", json=_gear_req())
    assert r.status_code == 200
    entities = r.json()
    assert all(e["type"] == "polyline_line" for e in entities)
    for e in entities:
        assert {"x1", "y1", "x2", "y2"} <= set(e)


def test_generate_gear_dxf_segments_share_parent_handle(client):
    # The existing /inspect-guided pipeline groups segments into compound
    # features via parent_handle. A generated gear must be ONE compound
    # feature so deviation results are aggregated per gear, not per tiny
    # polyline segment.
    r = client.post("/generate-gear-dxf", json=_gear_req())
    entities = r.json()
    parents = {e.get("parent_handle") for e in entities}
    assert len(parents) == 1
    assert next(iter(parents)) is not None


def test_generate_gear_dxf_segments_have_unique_handles(client):
    # parse_dxf gives each polyline segment a distinct handle suffix; we
    # match the same convention so frontend hit-testing and toleranced
    # selection by handle still work.
    r = client.post("/generate-gear-dxf", json=_gear_req())
    entities = r.json()
    handles = [e["handle"] for e in entities]
    assert len(handles) == len(set(handles))
    assert all(h is not None for h in handles)


def test_generate_gear_dxf_segments_indexed_sequentially(client):
    r = client.post("/generate-gear-dxf", json=_gear_req())
    entities = r.json()
    for i, e in enumerate(entities):
        assert e["segment_index"] == i


def test_generate_gear_dxf_segments_have_tooth_index_and_region(client):
    # Per-tooth aggregation in the sidebar needs each segment to carry its
    # tooth_index (0..N-1) and region ("flank"/"tip"/"root") so the frontend
    # can group deviations by tooth and show a single worst-case number per
    # tooth with drill-down.
    n = 17
    r = client.post("/generate-gear-dxf", json=_gear_req(n_teeth=n))
    entities = r.json()
    # Every entity carries both fields.
    for e in entities:
        assert "tooth_index" in e
        assert "region" in e
        assert 0 <= e["tooth_index"] < n
        assert e["region"] in {"flank", "tip", "root"}
    # All N tooth indices should appear.
    indices = {e["tooth_index"] for e in entities}
    assert indices == set(range(n))
    # Each tooth gets the same number of segments (deterministic period).
    from collections import Counter
    counts = Counter(e["tooth_index"] for e in entities)
    assert len(set(counts.values())) == 1, (
        f"tooth segment counts differ: {counts}"
    )
    # Each tooth includes at least one segment of each region.
    per_tooth_regions: dict[int, set[str]] = {i: set() for i in range(n)}
    for e in entities:
        per_tooth_regions[e["tooth_index"]].add(e["region"])
    for t, regs in per_tooth_regions.items():
        assert {"flank", "tip", "root"} <= regs, (
            f"tooth {t} missing regions: {regs}"
        )


def test_generate_gear_dxf_involute_has_tooth_index_and_region(client):
    # Same contract as above for involute. The two generators have different
    # internal structures (stubs vs. radial dedendums) so we verify both.
    n = 20
    r = client.post("/generate-gear-dxf",
                    json=_gear_req(profile="involute", n_teeth=n))
    entities = r.json()
    for e in entities:
        assert e["region"] in {"flank", "tip", "root"}
    assert {e["tooth_index"] for e in entities} == set(range(n))


def test_generate_gear_dxf_translates_to_center(client):
    # The generator produces vertices in gear-local coords (origin at the
    # gear center); the endpoint must translate them to (cx, cy) so they
    # live in the DXF world frame.
    import math
    cx, cy = 500.0, -200.0
    n, m = 17, 2.0
    r = client.post("/generate-gear-dxf",
                    json=_gear_req(cx=cx, cy=cy, module=m, n_teeth=n))
    entities = r.json()
    # Collect all unique vertices.
    pts = set()
    for e in entities:
        pts.add((round(e["x1"], 6), round(e["y1"], 6)))
        pts.add((round(e["x2"], 6), round(e["y2"], 6)))
    # Max radius about (cx, cy) should match r_tip = r_pitch + module.
    r_pitch = n * m / 2.0
    r_tip = r_pitch + m * 1.0
    max_r = max(math.hypot(x - cx, y - cy) for (x, y) in pts)
    assert max_r == pytest.approx(r_tip, abs=1e-3)


def test_generate_gear_dxf_applies_rotation(client):
    # rotation_deg=90 puts the first tooth (default on +x axis) at +y,
    # so the max-y vertex of the output should be near the tip radius.
    import math
    n, m = 17, 1.0
    cx, cy = 0.0, 0.0
    r_tip = n * m / 2.0 + m
    r0 = client.post("/generate-gear-dxf",
                     json=_gear_req(n_teeth=n, module=m, cx=cx, cy=cy,
                                    rotation_deg=0.0))
    r90 = client.post("/generate-gear-dxf",
                      json=_gear_req(n_teeth=n, module=m, cx=cx, cy=cy,
                                     rotation_deg=90.0))
    e0 = r0.json()
    e90 = r90.json()

    def max_x(ents):
        return max(max(e["x1"], e["x2"]) for e in ents)

    def max_y(ents):
        return max(max(e["y1"], e["y2"]) for e in ents)

    # At rotation 0, tooth 0 center is on +x → max_x == r_tip.
    # At rotation 90, the same tooth center sits on +y → max_y == r_tip.
    assert max_x(e0) == pytest.approx(r_tip, abs=1e-3)
    assert max_y(e90) == pytest.approx(r_tip, abs=1e-3)


def test_generate_gear_dxf_includes_layer(client):
    r = client.post("/generate-gear-dxf", json=_gear_req(layer="IDEAL_GEAR"))
    entities = r.json()
    assert all(e["layer"] == "IDEAL_GEAR" for e in entities)


def test_generate_gear_dxf_rejects_bad_profile(client):
    r = client.post("/generate-gear-dxf", json=_gear_req(profile="bogus"))
    assert r.status_code == 422


def test_generate_gear_dxf_rejects_bad_n_teeth(client):
    r = client.post("/generate-gear-dxf", json=_gear_req(n_teeth=3))
    assert r.status_code == 422


def test_generate_gear_dxf_rejects_non_positive_module(client):
    r = client.post("/generate-gear-dxf", json=_gear_req(module=0))
    assert r.status_code == 422


def test_generate_gear_dxf_surfaces_generator_error(client):
    # A pathological combo (dedendum_coef large enough to drive r_root ≤ 0
    # for this tooth count) bubbles out of the pure generator as
    # ValueError — the endpoint should translate that into a 400, not 500.
    # n=6, module=1.0, dedendum=3.0 → r_pitch=3, r_root=0.
    r = client.post("/generate-gear-dxf",
                    json=_gear_req(n_teeth=6, module=1.0, dedendum_coef=3.0))
    assert r.status_code == 400
    assert "root" in r.json()["detail"].lower() or "gear" in r.json()["detail"].lower()
