# tests/test_config_tolerances_api.py
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    app = create_app(no_camera=True)
    return TestClient(app)


def test_get_tolerances_returns_defaults(client):
    r = client.get("/config/tolerances")
    assert r.status_code == 200
    body = r.json()
    assert body["tolerance_warn"] == pytest.approx(0.10)
    assert body["tolerance_fail"] == pytest.approx(0.25)


def test_post_tolerances_accepts_valid(client):
    r = client.post("/config/tolerances",
                    json={"tolerance_warn": 0.05, "tolerance_fail": 0.20})
    assert r.status_code == 200
    body = r.json()
    assert body["tolerance_warn"] == pytest.approx(0.05)
    assert body["tolerance_fail"] == pytest.approx(0.20)


def test_post_tolerances_rejects_warn_gte_fail(client):
    r = client.post("/config/tolerances",
                    json={"tolerance_warn": 0.30, "tolerance_fail": 0.20})
    assert r.status_code == 422


def test_post_tolerances_rejects_nonpositive(client):
    r = client.post("/config/tolerances",
                    json={"tolerance_warn": 0.0, "tolerance_fail": 0.20})
    assert r.status_code == 422


def test_tolerances_round_trip(client, tmp_path, monkeypatch):
    import backend.config as cfg
    monkeypatch.setattr(cfg, "CONFIG_PATH", tmp_path / "config.json")
    client.post("/config/tolerances",
                json={"tolerance_warn": 0.08, "tolerance_fail": 0.30})
    r = client.get("/config/tolerances")
    assert r.json()["tolerance_warn"] == pytest.approx(0.08)
