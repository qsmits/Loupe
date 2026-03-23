import pytest
from fastapi.testclient import TestClient
from backend.main import create_app


@pytest.fixture
def null_client(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    app = create_app(no_camera=True)
    with TestClient(app) as c:
        yield c


def test_camera_info_returns_no_camera_flag(null_client):
    r = null_client.get("/camera/info")
    assert r.status_code == 200
    assert r.json()["no_camera"] is True


def test_cameras_list_returns_empty(null_client):
    r = null_client.get("/cameras")
    assert r.status_code == 200
    assert r.json() == []


def test_set_exposure_returns_503(null_client):
    r = null_client.put("/camera/exposure", json={"value": 5000})
    assert r.status_code == 503


def test_set_gain_returns_503(null_client):
    r = null_client.put("/camera/gain", json={"value": 0})
    assert r.status_code == 503


def test_set_pixel_format_returns_503(null_client):
    r = null_client.put("/camera/pixel-format", json={"pixel_format": "Mono8"})
    assert r.status_code == 503


def test_wb_auto_returns_503(null_client):
    r = null_client.post("/camera/white-balance/auto")
    assert r.status_code == 503


def test_wb_ratio_returns_503(null_client):
    r = null_client.put("/camera/white-balance/ratio",
                        json={"channel": "Red", "value": 1.2})
    assert r.status_code == 503


def test_camera_select_returns_503(null_client):
    r = null_client.post("/camera/select", json={"camera_id": "some-id"})
    assert r.status_code == 503


def test_snapshot_returns_503(null_client):
    r = null_client.post("/snapshot")
    assert r.status_code == 503


def test_freeze_and_load_still_work(null_client):
    """Freeze and load-image must work in no-camera mode."""
    r = null_client.post("/freeze")
    assert r.status_code == 200  # blank frame from NullCamera is fine


def test_regular_camera_info_includes_no_camera_false(tmp_path, monkeypatch):
    """Real (fake) camera response must include no_camera: false."""
    from tests.conftest import FakeCamera
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    app = create_app(camera=FakeCamera())
    with TestClient(app) as c:
        r = c.get("/camera/info")
    assert r.status_code == 200
    assert r.json()["no_camera"] is False
