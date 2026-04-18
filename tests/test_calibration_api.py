"""HTTP tests for the CalibrationSession REST endpoints.

Covers Phase 3A Track A: /deflectometry/calibrations [GET/POST/DELETE],
/deflectometry/calibrations/{id}, /deflectometry/calibrations/latest,
/deflectometry/rig-fingerprint, /deflectometry/calibrations/bind/{id}.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from tests.conftest import FakeCamera


@pytest.fixture
def cal_client(tmp_path, monkeypatch):
    """A TestClient with DEFLECTOMETRY_CAL_DIR isolated to tmp_path.

    We cannot reuse the default `client` fixture because pytest tmp env-var
    setup needs to happen before the app starts, and we want a clean empty
    cal directory per test.
    """
    monkeypatch.setenv("DEFLECTOMETRY_CAL_DIR", str(tmp_path))
    camera = FakeCamera()
    app = create_app(camera)
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# POST /deflectometry/calibrations
# ---------------------------------------------------------------------------

def test_save_calibration_endpoint(cal_client: TestClient):
    body = {
        "rig_fingerprint": "fp-test-1",
        "display_response": {"ok": True},
        "corner_check": {"status": "good"},
        "sphere_cal": {"cal_factor": 0.001},
        "notes": "bench cal",
    }
    r = cal_client.post("/deflectometry/calibrations", json=body)
    assert r.status_code == 200
    saved = r.json()
    assert "id" in saved and len(saved["id"]) == 32
    assert saved["rig_fingerprint"] == "fp-test-1"
    assert saved["completeness"] == {
        "display": True, "corner": True, "sphere": True, "reference": False,
        "screen_shape": False, "microscope": False,
    }
    assert saved["notes"] == "bench cal"


def test_save_calibration_allows_partial(cal_client: TestClient):
    body = {"rig_fingerprint": "fp", "display_response": {"ok": True}}
    r = cal_client.post("/deflectometry/calibrations", json=body)
    assert r.status_code == 200
    saved = r.json()
    assert saved["completeness"]["display"] is True
    assert saved["completeness"]["sphere"] is False


def test_save_calibration_requires_rig_fingerprint(cal_client: TestClient):
    r = cal_client.post("/deflectometry/calibrations", json={})
    # Pydantic-validation 422 or ValueError-bubble 500 is acceptable; reject
    # should NOT be a silent 200.
    assert r.status_code in (400, 422, 500)


# ---------------------------------------------------------------------------
# GET /deflectometry/calibrations
# ---------------------------------------------------------------------------

def test_list_calibrations_empty(cal_client: TestClient):
    r = cal_client.get("/deflectometry/calibrations")
    assert r.status_code == 200
    assert r.json() == []


def test_list_calibrations_endpoint(cal_client: TestClient):
    # Save two sessions.
    for i in range(2):
        cal_client.post("/deflectometry/calibrations", json={
            "rig_fingerprint": f"fp-{i}",
            "display_response": {"ok": True},
            "corner_check": {"ok": True},
            "sphere_cal": {"cal_factor": 0.001},
        })
    r = cal_client.get("/deflectometry/calibrations")
    assert r.status_code == 200
    listed = r.json()
    assert isinstance(listed, list)
    assert len(listed) == 2
    # Summary shape, not full envelope.
    assert set(listed[0].keys()) == {
        "id", "rig_fingerprint", "captured_at", "completeness", "notes",
    }


def test_list_calibrations_filters_by_fingerprint(cal_client: TestClient):
    cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "rig-A",
        "display_response": {"ok": True},
    })
    cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "rig-B",
        "display_response": {"ok": True},
    })
    r = cal_client.get("/deflectometry/calibrations", params={"rig_fingerprint": "rig-A"})
    assert r.status_code == 200
    listed = r.json()
    assert len(listed) == 1
    assert listed[0]["rig_fingerprint"] == "rig-A"


# ---------------------------------------------------------------------------
# GET /deflectometry/calibrations/{id}
# ---------------------------------------------------------------------------

def test_get_calibration_404(cal_client: TestClient):
    r = cal_client.get("/deflectometry/calibrations/doesnotexist")
    assert r.status_code == 404


def test_get_calibration_returns_full_envelope(cal_client: TestClient):
    save = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "fp",
        "display_response": {"ok": True},
        "sphere_cal": {"cal_factor": 0.002},
    }).json()
    r = cal_client.get(f"/deflectometry/calibrations/{save['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == save["id"]
    # Full envelope — sphere_cal is present.
    assert body["sphere_cal"] == {"cal_factor": 0.002}


# ---------------------------------------------------------------------------
# GET /deflectometry/calibrations/latest
# ---------------------------------------------------------------------------

def test_latest_calibration_endpoint(cal_client: TestClient):
    # No sessions yet → 404.
    r = cal_client.get("/deflectometry/calibrations/latest", params={"rig_fingerprint": "fp"})
    assert r.status_code == 404

    # Save a complete session; latest should return it.
    save = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "fp",
        "display_response": {"ok": True},
        "corner_check": {"ok": True},
        "sphere_cal": {"cal_factor": 0.001},
    }).json()
    r = cal_client.get("/deflectometry/calibrations/latest", params={"rig_fingerprint": "fp"})
    assert r.status_code == 200
    assert r.json()["id"] == save["id"]


# ---------------------------------------------------------------------------
# DELETE /deflectometry/calibrations/{id}
# ---------------------------------------------------------------------------

def test_delete_calibration_endpoint(cal_client: TestClient):
    save = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "fp",
        "display_response": {"ok": True},
    }).json()
    r = cal_client.delete(f"/deflectometry/calibrations/{save['id']}")
    assert r.status_code == 200
    # 404 on second delete.
    r2 = cal_client.delete(f"/deflectometry/calibrations/{save['id']}")
    assert r2.status_code == 404


# ---------------------------------------------------------------------------
# GET /deflectometry/rig-fingerprint
# ---------------------------------------------------------------------------

def test_rig_fingerprint_endpoint(cal_client: TestClient):
    r = cal_client.get("/deflectometry/rig-fingerprint", params={
        "display_model": "iPad Pro 11",
        "pixel_pitch_mm": 0.0962,
        "pixels_per_mm": 25.0,
    })
    assert r.status_code == 200
    body = r.json()
    assert "rig_fingerprint" in body
    assert isinstance(body["rig_fingerprint"], str)
    assert len(body["rig_fingerprint"]) == 16


def test_rig_fingerprint_stable_across_calls(cal_client: TestClient):
    params = {
        "display_model": "iPad",
        "pixel_pitch_mm": 0.0962,
        "pixels_per_mm": 25.0,
    }
    a = cal_client.get("/deflectometry/rig-fingerprint", params=params).json()
    b = cal_client.get("/deflectometry/rig-fingerprint", params=params).json()
    assert a["rig_fingerprint"] == b["rig_fingerprint"]


# ---------------------------------------------------------------------------
# POST /deflectometry/calibrations/bind/{id}
# ---------------------------------------------------------------------------

def test_bind_calibration_to_session_updates_status(cal_client: TestClient):
    # Save a complete cal.
    save = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "fp-bind",
        "display_response": {"ok": True},
        "corner_check": {"ok": True},
        "sphere_cal": {"cal_factor": 0.001},
    }).json()

    # Bind it to the live session.
    r = cal_client.post(f"/deflectometry/calibrations/bind/{save['id']}")
    assert r.status_code == 200
    bound = r.json()
    assert bound["id"] == save["id"]

    # /status reflects the bound cal session.
    status = cal_client.get("/deflectometry/status").json()
    assert status["active_cal_session"] is not None
    assert status["active_cal_session"]["id"] == save["id"]
    assert status["active_cal_session"]["rig_fingerprint"] == "fp-bind"
    assert status["active_cal_session"]["completeness"]["display"] is True


def test_bind_calibration_404_for_unknown_id(cal_client: TestClient):
    r = cal_client.post("/deflectometry/calibrations/bind/notreal")
    assert r.status_code == 404


def test_bind_calibration_rejects_incomplete_session(cal_client: TestClient):
    # Only display_response — incomplete.
    save = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "fp",
        "display_response": {"ok": True},
    }).json()
    r = cal_client.post(f"/deflectometry/calibrations/bind/{save['id']}")
    assert r.status_code == 400
    assert "missing" in r.json()["detail"].lower()


def test_delete_bound_cal_unbinds_from_status(cal_client: TestClient):
    save = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": "fp-del",
        "display_response": {"ok": True},
        "corner_check": {"ok": True},
        "sphere_cal": {"cal_factor": 0.001},
    }).json()
    cal_client.post(f"/deflectometry/calibrations/bind/{save['id']}")
    # Sanity: bound.
    assert cal_client.get("/deflectometry/status").json()["active_cal_session"] is not None
    # Delete it → status clears.
    cal_client.delete(f"/deflectometry/calibrations/{save['id']}")
    status = cal_client.get("/deflectometry/status").json()
    assert status["active_cal_session"] is None


def test_status_without_bound_cal(cal_client: TestClient):
    status = cal_client.get("/deflectometry/status").json()
    assert "active_cal_session" in status
    assert status["active_cal_session"] is None
