# tests/test_config_ui_api.py
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    app = create_app(no_camera=True)
    return TestClient(app)


def test_get_config_ui_returns_app_name_and_theme(client):
    resp = client.get("/config/ui")
    assert resp.status_code == 200
    data = resp.json()
    assert "app_name" in data
    assert "theme" in data


def test_get_config_ui_defaults(client):
    resp = client.get("/config/ui")
    data = resp.json()
    assert data["app_name"] == "Microscope"
    assert data["theme"] == "macos-dark"


def test_post_config_ui_accepts_valid_payload(client):
    resp = client.post("/config/ui", json={"app_name": "MyScope", "theme": "macos-dark"})
    assert resp.status_code == 200


def test_post_config_ui_rejects_missing_required_fields(client):
    # Pydantic should reject payloads missing required fields
    resp = client.post("/config/ui", json={"evil": "payload"})
    assert resp.status_code == 422


def test_post_then_get_round_trip(client):
    client.post("/config/ui", json={"app_name": "NewName", "theme": "macos-dark"})
    resp = client.get("/config/ui")
    assert resp.json()["app_name"] == "NewName"
