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
    # Build a small directory tree:
    #   <tmp>/thread-metric/m3.json
    #   <tmp>/thread-metric/m6.json
    #   <tmp>/circles/rings.json
    #   <tmp>/custom/          (empty, will be written to)
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

    custom = tmp_path / "custom"
    custom.mkdir()

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
    # custom is empty, may be omitted or present as empty list
    # either is acceptable


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
    # description is optional — present when in JSON
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


def test_get_reticle_missing_category_404(client_with_reticles):
    r = client_with_reticles.get("/reticles/nonexistent/m3.json")
    assert r.status_code == 404


def test_get_reticle_missing_file_404(client_with_reticles):
    r = client_with_reticles.get("/reticles/thread-metric/no-such-file.json")
    assert r.status_code == 404


def test_get_reticle_path_traversal_rejected(client_with_reticles):
    r = client_with_reticles.get("/reticles/../../../etc/passwd")
    # FastAPI may return 404 or 422; what matters is it is NOT 200
    assert r.status_code != 200


def test_get_reticle_dotdot_in_name_rejected(client_with_reticles):
    r = client_with_reticles.get("/reticles/thread-metric/../../etc/passwd")
    assert r.status_code != 200


# ---------------------------------------------------------------------------
# POST /reticles/custom  — save
# ---------------------------------------------------------------------------

def test_save_custom_reticle(client_with_reticles, reticles_dir):
    body = {
        "name": "My Custom Grid",
        "elements": [{"type": "grid", "spacing": 5}],
    }
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code == 200
    data = r.json()
    assert "file" in data
    # file field is the slug (stem, no extension); .json is appended on disk
    saved = reticles_dir / "custom" / f"{data['file']}.json"
    assert saved.exists()
    content = json.loads(saved.read_text())
    assert content["name"] == "My Custom Grid"
    assert content["elements"] == body["elements"]


def test_save_custom_reticle_slug_filename(client_with_reticles, reticles_dir):
    body = {
        "name": "Hello World! 123",
        "elements": [{"type": "circle", "r": 1}],
    }
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code == 200
    slug = r.json()["file"]
    # file field is the slug (stem, no extension): lowercase, hyphens only
    assert not slug.endswith(".json")
    assert slug == slug.lower()
    assert " " not in slug
    assert "!" not in slug


def test_save_custom_reticle_missing_name_422(client_with_reticles):
    body = {"elements": [{"type": "circle", "r": 1}]}
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code == 422


def test_save_custom_reticle_missing_elements_422(client_with_reticles):
    body = {"name": "Test"}
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code == 422


def test_save_custom_reticle_empty_elements_422(client_with_reticles):
    body = {"name": "Test", "elements": []}
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code == 422


def test_save_custom_reticle_name_too_long_422(client_with_reticles):
    body = {"name": "x" * 101, "elements": [{"type": "circle", "r": 1}]}
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code == 422


def test_save_custom_reticle_shows_in_list(client_with_reticles):
    body = {"name": "New Reticle", "elements": [{"type": "dot"}]}
    client_with_reticles.post("/reticles/custom", json=body)
    r = client_with_reticles.get("/reticles")
    cats = r.json()["categories"]
    assert "custom" in cats
    files = {e["file"] for e in cats["custom"]}
    assert any("new-reticle" in f for f in files)


def test_save_custom_reticle_body_traversal_safe_slug(client_with_reticles, reticles_dir):
    """POST with a path-traversal name should produce a safe slug, not escape reticles/custom/."""
    body = {
        "name": "../../etc/evil",
        "elements": [{"type": "dot"}],
    }
    r = client_with_reticles.post("/reticles/custom", json=body)
    assert r.status_code == 200
    slug = r.json()["file"]
    # The slug must not contain path separators or dots that could escape the directory
    assert ".." not in slug
    assert "/" not in slug
    assert "\\" not in slug
    # The file must land inside reticles/custom/, not outside
    saved = reticles_dir / "custom" / f"{slug}.json"
    assert saved.exists()
