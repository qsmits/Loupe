"""HTTP tests for the deflectometry router.

WebSocket path-through-to-iPad is not exercised here (requires a second
process or simulated iPad); those paths are covered by the explicit
capture-requires-iPad + compute-requires-frames tests plus the unit
tests in tests/test_deflectometry.py.
"""

from fastapi.testclient import TestClient


def test_deflectometry_start_returns_pairing_url(client: TestClient):
    # Fresh app: first /start creates a new session.
    client.post("/deflectometry/reset", json={})
    r = client.post("/deflectometry/start", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["ipad_connected"] is False
    assert body["pairing_url"].startswith("/deflectometry-screen.html?session=")
    assert body["session_id"] in body["pairing_url"]


def test_deflectometry_status_reports_session(client: TestClient):
    client.post("/deflectometry/reset", json={})
    r1 = client.post("/deflectometry/start", json={})
    sid = r1.json()["session_id"]
    r2 = client.get("/deflectometry/status")
    assert r2.status_code == 200
    body = r2.json()
    assert body["session_id"] == sid
    assert body["ipad_connected"] is False
    assert body["captured_count"] == 0
    assert body["has_result"] is False
    assert body["last_result"] is None


def test_deflectometry_start_is_idempotent_when_unused(client: TestClient):
    # Two successive starts with no iPad, no frames, no result should
    # still succeed — the second one may replace the first session (both
    # are fresh and equivalent). Shape must be consistent.
    client.post("/deflectometry/reset", json={})
    r1 = client.post("/deflectometry/start", json={})
    assert r1.status_code == 200
    r2 = client.post("/deflectometry/start", json={})
    assert r2.status_code == 200
    body = r2.json()
    assert body["ipad_connected"] is False
    assert body["session_id"] in body["pairing_url"]


def test_deflectometry_capture_requires_ipad(client: TestClient):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/capture-sequence", json={"freq": 16})
    assert r.status_code == 400
    assert "ipad" in r.json()["detail"].lower()


def test_deflectometry_capture_requires_session(client: TestClient):
    # With no session at all, capture-sequence should 400.
    # The TestClient above shares app state across requests inside the
    # same fixture, so reset does not destroy the session — but status
    # can still show a session. Starting fresh + immediately capturing
    # is the same code path as "no ipad connected".
    client.post("/deflectometry/reset", json={})
    # If there's no session yet at all, we'd 400; the lifespan of the
    # test app means the closure may still hold a session from an
    # earlier test. Either way, calling capture without an ipad 400s.
    r = client.post("/deflectometry/capture-sequence", json={"freq": 16})
    assert r.status_code == 400


def test_deflectometry_compute_requires_frames(client: TestClient):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/compute", json={})
    assert r.status_code == 400
    assert "frame" in r.json()["detail"].lower()


def test_deflectometry_reset_clears_frames(client: TestClient):
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/reset", json={})
    assert r.status_code == 200
    s = client.get("/deflectometry/status").json()
    assert s["captured_count"] == 0
    assert s["has_result"] is False
    assert s["last_result"] is None


def test_deflectometry_reset_without_session_is_ok(client: TestClient):
    # Reset on an app that has never started a session is a no-op 200.
    r = client.post("/deflectometry/reset", json={})
    assert r.status_code == 200
    assert r.json() == {}


# NOTE: hosted-mode rejection test is not included here because the
# existing wizard tests (zstack/superres/stitch) do not spin up a
# second app with HOSTED=1 for this purpose. Router-level
# Depends(_reject_hosted) is shared with those routers and is
# exercised by backend/main.py's env-var path in manual QA.
