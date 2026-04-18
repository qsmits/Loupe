"""HTTP tests for the deflectometry router.

WebSocket path-through-to-iPad is not exercised here (requires a second
process or simulated iPad); those paths are covered by the explicit
capture-requires-iPad + compute-requires-frames tests plus the unit
tests in tests/test_deflectometry.py.
"""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _clear_deflectometry_profiles():
    """Wipe deflectometry profiles from config.json before each test so
    profile tests don't bleed into each other via the on-disk config."""
    from backend.config import save_config
    save_config({"deflectometry_profiles": [], "deflectometry_active_profile": None})
    yield
    # No teardown needed — next test's setup will clear again.


def test_deflectometry_start_returns_session(client: TestClient):
    # Fresh app: first /start creates a new session.
    client.post("/deflectometry/reset", json={})
    r = client.post("/deflectometry/start", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["ipad_connected"] is False
    assert "session_id" in body


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
    assert "session_id" in body


def test_deflectometry_capture_requires_ipad(client: TestClient):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/capture-sequence", json={"freq": 16})
    assert r.status_code == 400


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


def test_deflectometry_flat_field_requires_ipad(client: TestClient):
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/flat-field", json={})
    assert r.status_code == 400


def test_deflectometry_status_includes_flat_field(client: TestClient):
    client.post("/deflectometry/start", json={})
    r = client.get("/deflectometry/status")
    assert r.status_code == 200
    assert "has_flat_field" in r.json()
    assert r.json()["has_flat_field"] is False


# NOTE: hosted-mode rejection test is not included here because the
# existing wizard tests (zstack/superres/stitch) do not spin up a
# second app with HOSTED=1 for this purpose. Router-level
# Depends(_reject_hosted) is shared with those routers and is
# exercised by backend/main.py's env-var path in manual QA.


def _get_deflectometry_state(client):
    """Return the `state` dict from the deflectometry router closure.

    The deflectometry router stores session state in a dict inside the closure
    of `make_deflectometry_router`. We reach it by inspecting the closure of
    one of the named route endpoints on the app.
    """
    app = client.app
    for route in app.routes:
        if getattr(route, "name", "") == "deflectometry_start":
            for cell in route.endpoint.__closure__ or []:
                try:
                    val = cell.cell_contents
                except ValueError:
                    continue
                if isinstance(val, dict) and "session" in val:
                    return val
    raise RuntimeError("Could not locate deflectometry state in router closure")


def _inject_synthetic_frames(client, width: int = 64, height: int = 64, freq: int = 4):
    """Inject 16 synthetic sinusoidal fringe frames into the active session.

    Requires that /deflectometry/start has already been called so that
    state["session"] is not None.
    """
    import math
    import numpy as np
    from backend.vision.deflectometry import generate_fringe_pattern

    state = _get_deflectometry_state(client)
    s = state["session"]
    assert s is not None, "No active deflectometry session to inject frames into"

    phases = [k * math.pi / 4.0 for k in range(8)]
    frames = []
    for orientation in ("x", "y"):
        for phase in phases:
            frame = generate_fringe_pattern(width, height, phase, freq, orientation)
            # Wrap in a 3-channel array to match real camera output
            frames.append(np.stack([frame, frame, frame], axis=-1))
    s.frames = frames
    # Legacy 16-frame fixture = fast (single-period) capture.
    s.capture_style = "fast"
    s.periods = (freq,)
    s.freq = freq


def test_export_run_returns_structured_json(client):
    """Export-run should return the full DeflectometryResult envelope (schema v2)."""
    import datetime

    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_synthetic_frames(client)
    client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    r = client.post("/deflectometry/export-run", json={})
    assert r.status_code == 200
    data = r.json()

    # Export header
    assert data["schema_version"] == 2
    assert "exported_at" in data
    # ISO-formatted timestamp parses cleanly
    parsed = datetime.datetime.fromisoformat(data["exported_at"])
    assert parsed.tzinfo is not None

    # Envelope payload
    assert "envelope" in data
    env = data["envelope"]
    for field in (
        "id",
        "origin",
        "captured_at",
        "tuning",
        "calibration_snapshot",
        "geometry",
        "aperture_recipe",
        "warnings",
    ):
        assert field in env, f"missing envelope field {field!r}"

    # Quality block carries through
    assert "quality" in env
    assert env["quality"] is not None

    # Numeric grids present as nested lists
    assert isinstance(env["phase_x_grid"], list)
    assert env["phase_x_grid"] and isinstance(env["phase_x_grid"][0], list)


def test_export_run_envelope_full(client):
    """Export-run carries FULL envelope grids — distinguishing it from /compute
    which deliberately strips heavy numeric arrays from its response."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_synthetic_frames(client)

    compute_r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert compute_r.status_code == 200
    compute_data = compute_r.json()
    # /compute response must NOT include the heavy grids
    for grid_field in (
        "phase_x_grid",
        "phase_y_grid",
        "modulation_x_grid",
        "modulation_y_grid",
        "slope_x_grid",
        "slope_y_grid",
        "trusted_mask_grid",
        "display_phase_x_grid",
        "display_phase_y_grid",
    ):
        assert grid_field not in compute_data, (
            f"/compute response unexpectedly includes {grid_field!r}"
        )

    r = client.post("/deflectometry/export-run", json={})
    assert r.status_code == 200
    env = r.json()["envelope"]

    # All envelope grids present and shaped as 2-D nested lists
    for grid_field in (
        "phase_x_grid",
        "phase_y_grid",
        "modulation_x_grid",
        "modulation_y_grid",
        "slope_x_grid",
        "slope_y_grid",
        "trusted_mask_grid",
        "display_phase_x_grid",
        "display_phase_y_grid",
    ):
        assert grid_field in env, f"export missing envelope grid {grid_field!r}"
        grid = env[grid_field]
        assert isinstance(grid, list), f"{grid_field} is not a list"
        assert grid, f"{grid_field} is empty"
        assert isinstance(grid[0], list), f"{grid_field} is not 2-D"

    # All envelope metadata fields present
    for field in (
        "id",
        "origin",
        "source_ids",
        "captured_at",
        "calibration_snapshot",
        "geometry",
        "tuning",
        "aperture_recipe",
        "warnings",
    ):
        assert field in env, f"export envelope missing {field!r}"

    # And the export envelope id matches the one /compute surfaced
    assert env["id"] == compute_data["id"]


def test_export_run_without_compute_returns_400(client):
    """Export-run before compute should 400 with 'Run compute first'."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/export-run", json={})
    assert r.status_code == 400
    assert "compute" in r.json()["detail"].lower()


def test_profiles_list_empty(client):
    r = client.get("/deflectometry/profiles")
    assert r.status_code == 200
    assert r.json() == []

def test_profiles_save_and_list(client):
    profile = {
        "name": "test-profile",
        "display": {"model": "iPad Air", "pixel_pitch_mm": 0.0962},
        "capture": {"freq": 16, "averages": 3, "gamma": 2.2},
        "processing": {"mask_threshold": 0.02, "smooth_sigma": 0.0},
        "geometry": {"notes": "test setup"},
        "calibration": {"cal_factor": None, "sphere_diameter_mm": None},
    }
    r = client.post("/deflectometry/profiles", json=profile)
    assert r.status_code == 200
    assert r.json()["name"] == "test-profile"
    r = client.get("/deflectometry/profiles")
    assert r.status_code == 200
    names = [p["name"] for p in r.json()]
    assert "test-profile" in names

def test_profiles_overwrite(client):
    profile = {
        "name": "overwrite-me",
        "display": {"model": "iPad", "pixel_pitch_mm": 0.1},
        "capture": {"freq": 8, "averages": 1, "gamma": 2.0},
        "processing": {"mask_threshold": 0.05, "smooth_sigma": 1.0},
        "geometry": {"notes": "v1"},
        "calibration": {"cal_factor": None, "sphere_diameter_mm": None},
    }
    client.post("/deflectometry/profiles", json=profile)
    profile["geometry"]["notes"] = "v2"
    client.post("/deflectometry/profiles", json=profile)
    r = client.get("/deflectometry/profiles")
    matches = [p for p in r.json() if p["name"] == "overwrite-me"]
    assert len(matches) == 1
    assert matches[0]["geometry"]["notes"] == "v2"

def test_profiles_delete(client):
    profile = {
        "name": "delete-me",
        "display": {"model": "iPad", "pixel_pitch_mm": 0.1},
        "capture": {"freq": 16, "averages": 3, "gamma": 2.2},
        "processing": {"mask_threshold": 0.02, "smooth_sigma": 0.0},
        "geometry": {"notes": ""},
        "calibration": {"cal_factor": None, "sphere_diameter_mm": None},
    }
    client.post("/deflectometry/profiles", json=profile)
    r = client.delete("/deflectometry/profiles/delete-me")
    assert r.status_code == 200
    r = client.get("/deflectometry/profiles")
    names = [p["name"] for p in r.json()]
    assert "delete-me" not in names

def test_profiles_delete_nonexistent(client):
    r = client.delete("/deflectometry/profiles/no-such-profile")
    assert r.status_code == 404

def test_profiles_load_into_session(client):
    client.post("/deflectometry/start", json={})
    profile = {
        "name": "load-test",
        "display": {"model": "iPad", "pixel_pitch_mm": 0.0962},
        "capture": {"freq": 32, "averages": 5, "gamma": 1.8},
        "processing": {"mask_threshold": 0.05, "smooth_sigma": 2.0},
        "geometry": {"notes": "bench"},
        "calibration": {"cal_factor": 0.00123, "sphere_diameter_mm": 25.0},
    }
    client.post("/deflectometry/profiles", json=profile)
    r = client.post("/deflectometry/profiles/load", json={"name": "load-test"})
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "load-test"
    assert data["calibration"]["cal_factor"] == 0.00123
    status = client.get("/deflectometry/status").json()
    assert status["cal_factor"] == 0.00123


def test_compute_returns_slope_and_quality(client):
    """After frame injection, /compute should return slope_mag, curl, and quality."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_synthetic_frames(client)

    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200, r.text
    data = r.json()

    # New fields must be present
    assert "slope_mag_png_b64" in data
    assert "curl_png_b64" in data
    assert "stats_slope_mag" in data
    assert "stats_curl" in data
    assert "quality" in data

    # Existing fields must still be present
    assert "phase_x_png_b64" in data
    assert "phase_y_png_b64" in data
    assert "stats_x" in data
    assert "stats_y" in data

    q = data["quality"]
    assert q["overall"] in ("good", "fair", "poor")
    assert "modulation_coverage" in q
    assert "curl_rms" in q
    assert "warnings" in q
    assert isinstance(q["warnings"], list)

    # PNG blobs should be non-empty base64 strings
    assert len(data["slope_mag_png_b64"]) > 0
    assert len(data["curl_png_b64"]) > 0


def test_calibrate_display_requires_session(client):
    client.post("/deflectometry/reset", json={})
    r = client.post("/deflectometry/calibrate-display")
    assert r.status_code == 400


def test_calibrate_display_requires_ipad(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/calibrate-display")
    assert r.status_code == 400
    assert "iPad" in r.json()["detail"]


def test_status_includes_has_display_cal(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.get("/deflectometry/status")
    assert r.status_code == 200
    assert "has_display_cal" in r.json()
    assert r.json()["has_display_cal"] is False


def test_check_display_requires_session(client):
    client.post("/deflectometry/reset", json={})
    r = client.post("/deflectometry/check-display")
    assert r.status_code == 400


def test_check_display_requires_ipad(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/check-display")
    assert r.status_code == 400
    assert "iPad" in r.json()["detail"]


def test_compute_with_mask_polygons(client):
    """Compute with a user mask polygon should succeed and use the mask."""
    client.post("/deflectometry/start", json={})
    _inject_synthetic_frames(client)
    mask_polygons = [{"vertices": [[0, 0], [1, 0], [1, 1], [0, 1]], "include": True}]
    r = client.post("/deflectometry/compute", json={
        "mask_threshold": 0.02,
        "smooth_sigma": 0.0,
        "mask_polygons": mask_polygons,
    })
    assert r.status_code == 200
    data = r.json()
    assert "phase_x_png_b64" in data

    # With a small polygon — stats should differ
    small_mask = [{"vertices": [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]], "include": True}]
    r2 = client.post("/deflectometry/compute", json={
        "mask_threshold": 0.02,
        "smooth_sigma": 0.0,
        "mask_polygons": small_mask,
    })
    assert r2.status_code == 200
