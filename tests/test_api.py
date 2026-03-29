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


def test_list_cameras_returns_list(client):
    r = client.get("/cameras")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    assert "id" in data[0]
    assert "label" in data[0]


def test_select_camera_opencv_id_rejected(client):
    r = client.post("/camera/select", json={"camera_id": "opencv-0"})
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
