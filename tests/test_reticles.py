"""Tests for the reticle API endpoints."""

import json
import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def reticles_dir(tmp_path, monkeypatch):
    """Create a temporary reticles directory and patch the module constant."""
    metric = tmp_path / "thread-metric"
    metric.mkdir()
    (metric / "m3.json").write_text(json.dumps({
        "name": "M3 Thread",
        "description": "ISO metric M3",
        "elements": [{"type": "circle", "r": 1.5}],
    }))
    (metric / "m6.json").write_text(json.dumps({
        "name": "M6 Thread",
        "description": "ISO metric M6",
        "elements": [{"type": "circle", "r": 3.0}],
    }))

    circles = tmp_path / "circles"
    circles.mkdir()
    (circles / "rings.json").write_text(json.dumps({
        "name": "Concentric Rings",
        "elements": [{"type": "circle", "r": 10}],
    }))

    import backend.api_reticles as mod
    monkeypatch.setattr(mod, "RETICLES_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def client_with_reticles(reticles_dir, client):
    """Return the standard test client, but with the reticles dir patched."""
    return client


# ---------------------------------------------------------------------------
# GET /reticles  — list
# ---------------------------------------------------------------------------

def test_list_reticles_returns_categories(client_with_reticles):
    r = client_with_reticles.get("/reticles")
    assert r.status_code == 200
    data = r.json()
    assert "categories" in data
    cats = data["categories"]
    assert "thread-metric" in cats
    assert "circles" in cats


def test_list_reticles_category_entries(client_with_reticles):
    r = client_with_reticles.get("/reticles")
    cats = r.json()["categories"]
    names = {e["file"] for e in cats["thread-metric"]}
    assert "m3" in names
    assert "m6" in names


def test_list_reticles_entry_has_required_fields(client_with_reticles):
    r = client_with_reticles.get("/reticles")
    entry = r.json()["categories"]["thread-metric"][0]
    assert "file" in entry
    assert "name" in entry
    assert "description" in entry


# ---------------------------------------------------------------------------
# GET /reticles/{category}/{name}  — fetch one
# ---------------------------------------------------------------------------

def test_get_reticle_returns_content(client_with_reticles):
    r = client_with_reticles.get("/reticles/thread-metric/m3.json")
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "M3 Thread"
    assert "elements" in data


def test_get_reticle_without_extension(client_with_reticles):
    r = client_with_reticles.get("/reticles/thread-metric/m3")
    assert r.status_code == 200
    assert r.json()["name"] == "M3 Thread"


def test_get_reticle_missing_category_404(client_with_reticles):
    r = client_with_reticles.get("/reticles/nonexistent/m3.json")
    assert r.status_code == 404


def test_get_reticle_missing_file_404(client_with_reticles):
    r = client_with_reticles.get("/reticles/thread-metric/no-such-file.json")
    assert r.status_code == 404


def test_get_reticle_path_traversal_rejected(client_with_reticles):
    r = client_with_reticles.get("/reticles/../../../etc/passwd")
    assert r.status_code != 200


def test_get_reticle_dotdot_in_name_rejected(client_with_reticles):
    r = client_with_reticles.get("/reticles/thread-metric/../../etc/passwd")
    assert r.status_code != 200


def test_post_custom_not_allowed(client_with_reticles):
    """POST /reticles/custom is removed — server-side save is disabled."""
    body = {"name": "Test", "elements": [{"type": "circle", "r": 1}]}
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code in (404, 405)
