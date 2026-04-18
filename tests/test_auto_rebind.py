"""HTTP tests for /deflectometry/auto-rebind.

Exercises the on-restart "find latest matching cal session and restore
derived state" flow: LUT rebuild, cal_factor hydration, reference_flat
npz load, and microscope-calibration drift warnings.
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import calibration_store
from backend.main import create_app
from tests.conftest import FakeCamera


@pytest.fixture
def cal_client(tmp_path, monkeypatch):
    """Isolated TestClient with clean cal-session + ref-flat directories."""
    monkeypatch.setenv("DEFLECTOMETRY_CAL_DIR", str(tmp_path / "cal"))
    monkeypatch.setenv(
        "DEFLECTOMETRY_REF_FLAT_DIR", str(tmp_path / "reference_flat"),
    )
    camera = FakeCamera()
    app = create_app(camera)
    with TestClient(app) as c:
        yield c, app


def _complete_session_body(
    *,
    rig_fingerprint: str,
    microscope_px_per_mm: float | None = None,
    with_reference: bool = False,
) -> dict:
    body = {
        "rig_fingerprint": rig_fingerprint,
        "display_response": {
            "commanded": [0, 64, 128, 192, 255],
            "observed": [2.0, 20.0, 75.0, 175.0, 250.0],
        },
        "corner_check": {"status": "good", "corners_found": 4},
        "sphere_cal": {"cal_factor": 1.23e-3, "fitted_radius_mm": 12.5},
        "notes": "",
    }
    if microscope_px_per_mm is not None:
        body["microscope_calibration"] = {
            "pixels_per_mm": microscope_px_per_mm,
            "calibrated_at": None,
            "source": "microscope_mode_cal",
        }
    if with_reference:
        body["reference_flat"] = {
            "captured_at": "2026-04-18T00:00:00+00:00",
            "shape": [8, 8],
        }
    return body


def _live_session(app):
    """Pluck the internal _Session object out of the running app.

    Routers built by ``make_deflectometry_router`` hold their state in a
    closure-local dict; in tests we need to reach into that dict to verify
    the bind actually populated inverse_lut / cal_factor / ref_phase_*.
    """
    # Iterate every FastAPI route and fish out the closure-captured ``state``
    # dict of the deflectometry router's nested functions. Easiest: dig
    # into the /status endpoint's handler, which references `state` via its
    # closure. This is fragile to refactors but mirrors the pattern used
    # elsewhere in the codebase (see _reject_hosted + cal endpoints).
    for route in app.routes:
        endpoint = getattr(route, "endpoint", None)
        if endpoint is None:
            continue
        closure = getattr(endpoint, "__closure__", None)
        if not closure:
            continue
        for cell in closure:
            try:
                val = cell.cell_contents
            except ValueError:
                continue
            if isinstance(val, dict) and "session" in val and len(val) == 1:
                return val
    return None


# ---------------------------------------------------------------------------
# Auto-rebind: no match
# ---------------------------------------------------------------------------

def test_auto_rebind_no_match(cal_client):
    client, _ = cal_client
    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "no-such-rig",
        "microscope_px_per_mm": 25.0,
    })
    assert r.status_code == 200
    body = r.json()
    assert body == {"restored": False, "session": None, "warnings": []}


# ---------------------------------------------------------------------------
# Auto-rebind: happy path binds the latest match
# ---------------------------------------------------------------------------

def test_auto_rebind_binds_latest_match(cal_client):
    client, _ = cal_client
    save = client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(rig_fingerprint="fp-1"),
    ).json()
    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "fp-1",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["restored"] is True
    assert body["session"]["id"] == save["id"]
    assert body["warnings"] == []
    # /status reflects the binding.
    status = client.get("/deflectometry/status").json()
    assert status["active_cal_session"]["id"] == save["id"]


# ---------------------------------------------------------------------------
# Auto-rebind: restores derived runtime state
# ---------------------------------------------------------------------------

def test_auto_rebind_restores_inverse_lut(cal_client):
    client, app = cal_client
    save = client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(rig_fingerprint="fp-lut"),
    ).json()
    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "fp-lut",
    })
    assert r.status_code == 200
    assert r.json()["restored"] is True
    # /status exposes has_display_cal which reflects s.inverse_lut.
    status = client.get("/deflectometry/status").json()
    assert status["has_display_cal"] is True
    assert status["display_linearization"] == "lut"
    assert status["cal_factor"] == pytest.approx(1.23e-3)
    # Cross-check by reaching into the live session directly.
    state = _live_session(app)
    assert state is not None
    s = state["session"]
    assert s is not None
    assert s.inverse_lut is not None
    assert len(s.inverse_lut) == 256
    assert s.cal_factor == pytest.approx(1.23e-3)
    assert s.active_cal_session_id == save["id"]


def test_auto_rebind_loads_reference_flat(cal_client):
    client, app = cal_client
    saved = client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(rig_fingerprint="fp-ref", with_reference=True),
    ).json()
    # Seed the ref-flat npz sidecar on disk so auto-rebind can pick it up.
    ref_x = np.linspace(-1, 1, 16 * 20, dtype=np.float32).reshape(16, 20)
    ref_y = (ref_x * 0.5).astype(np.float32)
    calibration_store.save_reference_flat(saved["id"], ref_x, ref_y)
    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "fp-ref",
    })
    assert r.status_code == 200
    assert r.json()["restored"] is True
    state = _live_session(app)
    assert state is not None
    s = state["session"]
    assert s is not None
    assert s.ref_phase_x is not None
    assert s.ref_phase_y is not None
    np.testing.assert_array_equal(np.asarray(s.ref_phase_x), ref_x)
    np.testing.assert_array_equal(np.asarray(s.ref_phase_y), ref_y)
    # Surfaced by /status too.
    status = client.get("/deflectometry/status").json()
    assert status["has_reference"] is True


# ---------------------------------------------------------------------------
# Auto-rebind: microscope-cal drift warning
# ---------------------------------------------------------------------------

def test_auto_rebind_warns_on_microscope_mismatch(cal_client):
    client, _ = cal_client
    client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(
            rig_fingerprint="fp-drift", microscope_px_per_mm=1.0,
        ),
    )
    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "fp-drift",
        "microscope_px_per_mm": 1.1,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["restored"] is True
    assert body["warnings"], "expected a drift warning"
    assert "Microscope" in body["warnings"][0]
    assert "1.000" in body["warnings"][0]
    assert "1.100" in body["warnings"][0]


def test_auto_rebind_no_warning_when_microscope_matches(cal_client):
    client, _ = cal_client
    client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(
            rig_fingerprint="fp-match", microscope_px_per_mm=24.789,
        ),
    )
    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "fp-match",
        "microscope_px_per_mm": 24.800,  # 0.04% drift — under the 0.5% gate
    })
    assert r.status_code == 200
    assert r.json()["warnings"] == []


def test_auto_rebind_no_warning_when_saved_has_no_microscope(cal_client):
    """Legacy session without a microscope snapshot can't warn about drift."""
    client, _ = cal_client
    client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(rig_fingerprint="fp-legacy"),
    )
    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "fp-legacy",
        "microscope_px_per_mm": 25.0,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["restored"] is True
    assert body["warnings"] == []


# ---------------------------------------------------------------------------
# Auto-rebind picks the newest match
# ---------------------------------------------------------------------------

def test_auto_rebind_picks_newest_match(cal_client):
    client, _ = cal_client
    first = client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(rig_fingerprint="fp-multi"),
    ).json()
    second = client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(rig_fingerprint="fp-multi"),
    ).json()
    # Force a definite ordering (ISO strings sort lexicographically).
    first_on_disk = calibration_store.load_calibration_session(first["id"])
    first_on_disk["captured_at"] = "2026-04-17T00:00:00+00:00"
    calibration_store.save_calibration_session(first_on_disk)
    second_on_disk = calibration_store.load_calibration_session(second["id"])
    second_on_disk["captured_at"] = "2026-04-18T00:00:00+00:00"
    calibration_store.save_calibration_session(second_on_disk)

    r = client.post("/deflectometry/auto-rebind", json={
        "rig_fingerprint": "fp-multi",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["restored"] is True
    assert body["session"]["id"] == second["id"]


# ---------------------------------------------------------------------------
# Delete cleans up the reference_flat .npz sidecar too
# ---------------------------------------------------------------------------

def test_delete_calibration_removes_reference_flat_sidecar(cal_client):
    client, _ = cal_client
    saved = client.post(
        "/deflectometry/calibrations",
        json=_complete_session_body(rig_fingerprint="fp-del", with_reference=True),
    ).json()
    ref = np.ones((4, 4), dtype=np.float32)
    calibration_store.save_reference_flat(saved["id"], ref, ref)
    assert calibration_store.load_reference_flat(saved["id"]) is not None
    client.delete(f"/deflectometry/calibrations/{saved['id']}")
    assert calibration_store.load_reference_flat(saved["id"]) is None
