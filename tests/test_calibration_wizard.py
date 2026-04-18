"""HTTP tests for Phase 3A Track E calibration wizard flow.

The wizard itself is frontend JS; here we exercise the backend pipeline
it drives: rig-fingerprint -> save CalibrationSession -> bind -> /status.

We cannot drive /calibrate-display, /check-display, or
/calibrate-sphere end-to-end without an iPad + real fringe frames, so
these tests feed canned step results into the save endpoint and assert
the composite flow works. The real endpoints are covered elsewhere.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from tests.conftest import FakeCamera


@pytest.fixture
def cal_client(tmp_path, monkeypatch):
    """TestClient with an isolated on-disk CalibrationSession store."""
    monkeypatch.setenv("DEFLECTOMETRY_CAL_DIR", str(tmp_path))
    camera = FakeCamera()
    app = create_app(camera)
    with TestClient(app) as c:
        yield c


def _canned_display_response() -> dict:
    """Shape of what /deflectometry/calibrate-display returns."""
    return {
        "status": "ok",
        "n_steps": 12,
        "commanded": [0, 23, 46, 69, 92, 115, 139, 162, 185, 208, 231, 255],
        "observed": [2.1, 8.3, 18.4, 32.0, 50.1, 71.9, 97.2, 125.8, 157.6, 192.4, 223.0, 252.1],
        "max_deviation_from_gamma": 4.2,
    }


def _canned_corner_check() -> dict:
    """Shape of what /deflectometry/check-display returns when good."""
    return {
        "status": "good",
        "corners_found": 4,
        "rotation_deg": 0.15,
        "coverage_fraction": 0.62,
        "warnings": [],
    }


def _canned_sphere_cal() -> dict:
    """Shape of what /deflectometry/calibrate-sphere returns."""
    return {
        "cal_factor": 1.23e-3,
        "cal_factor_um": 1.23,
        "fitted_radius_mm": 12.48,
        "residual_rms_um": 0.41,
        "residual_rms_um_robust": 0.38,
        "outlier_fraction": 0.07,
        "center_px": [320.4, 240.6],
        "sphere_diameter_mm": 25.0,
        "capture_style": "multi_freq",
    }


def _canned_reference_flat() -> dict:
    """Small metadata dict — big arrays stay on the live _Session."""
    return {
        "captured_at": "2026-04-18T12:00:00+00:00",
        "capture_style": "multi_freq",
        "periods": [3, 12, 48],
    }


# ---------------------------------------------------------------------------
# 1) Wizard end-to-end: save + bind + /status
# ---------------------------------------------------------------------------

def test_wizard_end_to_end_builds_valid_session(cal_client: TestClient):
    """Simulate the wizard's POSTs: fingerprint -> save -> bind -> status."""
    # 1) fetch rig fingerprint
    fp_r = cal_client.get("/deflectometry/rig-fingerprint", params={
        "display_model": "iPad Air 1 (264 ppi)",
        "pixel_pitch_mm": 0.0962,
        "pixels_per_mm": 25.0,
    })
    assert fp_r.status_code == 200
    fp = fp_r.json()["rig_fingerprint"]
    assert isinstance(fp, str) and len(fp) == 16

    # 2) save CalibrationSession with the 4 step results
    save_r = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": fp,
        "display_response": _canned_display_response(),
        "corner_check": _canned_corner_check(),
        "sphere_cal": _canned_sphere_cal(),
        "reference_flat": _canned_reference_flat(),
        "notes": "bench test run",
    })
    assert save_r.status_code == 200
    saved = save_r.json()
    assert saved["completeness"] == {
        "display": True, "corner": True, "sphere": True, "reference": True,
    }
    assert saved["notes"] == "bench test run"
    assert saved["rig_fingerprint"] == fp
    sid = saved["id"]

    # 3) bind it as the active session
    bind_r = cal_client.post(f"/deflectometry/calibrations/bind/{sid}")
    assert bind_r.status_code == 200
    bound = bind_r.json()
    assert bound["id"] == sid

    # 4) /status reflects the active cal session
    status_r = cal_client.get("/deflectometry/status")
    assert status_r.status_code == 200
    status = status_r.json()
    assert status["active_cal_session"] is not None
    assert status["active_cal_session"]["id"] == sid
    assert status["active_cal_session"]["rig_fingerprint"] == fp
    comp = status["active_cal_session"]["completeness"]
    assert comp["display"] is True
    assert comp["corner"] is True
    assert comp["sphere"] is True


def test_wizard_flow_without_reference_flat_is_valid(cal_client: TestClient):
    """Reference flat is optional — skipping it should still produce a
    bindable session (gating only checks display + corner + sphere)."""
    fp = cal_client.get("/deflectometry/rig-fingerprint", params={
        "display_model": "iPad Pro 11",
        "pixel_pitch_mm": 0.0846,
        "pixels_per_mm": 25.0,
    }).json()["rig_fingerprint"]

    saved = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": fp,
        "display_response": _canned_display_response(),
        "corner_check": _canned_corner_check(),
        "sphere_cal": _canned_sphere_cal(),
        "reference_flat": None,
        "notes": "",
    }).json()
    assert saved["completeness"]["reference"] is False

    bind_r = cal_client.post(f"/deflectometry/calibrations/bind/{saved['id']}")
    assert bind_r.status_code == 200

    status = cal_client.get("/deflectometry/status").json()
    assert status["active_cal_session"]["id"] == saved["id"]


def test_wizard_refuses_to_bind_incomplete_session(cal_client: TestClient):
    """An incomplete session (e.g. user closed the wizard at step 2)
    must not be bindable — capture gating relies on this."""
    fp = cal_client.get("/deflectometry/rig-fingerprint", params={
        "display_model": "x",
        "pixel_pitch_mm": 0.1,
        "pixels_per_mm": 10.0,
    }).json()["rig_fingerprint"]

    saved = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": fp,
        "display_response": _canned_display_response(),
        "corner_check": _canned_corner_check(),
        # sphere_cal missing
    }).json()
    assert saved["completeness"]["sphere"] is False

    bind_r = cal_client.post(f"/deflectometry/calibrations/bind/{saved['id']}")
    assert bind_r.status_code == 400
    assert "sphere" in bind_r.json()["detail"].lower()


# ---------------------------------------------------------------------------
# 2) save_calibration integration — persistence survives retrieval
# ---------------------------------------------------------------------------

def test_save_calibration_integration(cal_client: TestClient):
    """Save -> retrieve by id -> list -> bind roundtrip must preserve
    every field the wizard stored."""
    body = {
        "rig_fingerprint": "rig-xyz",
        "display_response": _canned_display_response(),
        "corner_check": _canned_corner_check(),
        "sphere_cal": _canned_sphere_cal(),
        "reference_flat": _canned_reference_flat(),
        "notes": "integration smoke test",
    }
    saved = cal_client.post("/deflectometry/calibrations", json=body).json()
    sid = saved["id"]

    # Retrieve full envelope — all 4 step results come back verbatim.
    got = cal_client.get(f"/deflectometry/calibrations/{sid}").json()
    assert got["display_response"] == _canned_display_response()
    assert got["corner_check"] == _canned_corner_check()
    assert got["sphere_cal"] == _canned_sphere_cal()
    assert got["reference_flat"] == _canned_reference_flat()
    assert got["notes"] == "integration smoke test"

    # Summary view is a strict subset.
    listed = cal_client.get("/deflectometry/calibrations").json()
    assert any(s["id"] == sid for s in listed)
    summary = next(s for s in listed if s["id"] == sid)
    assert summary["rig_fingerprint"] == "rig-xyz"
    assert summary["completeness"]["display"] is True
    assert "display_response" not in summary  # summaries are slim

    # Bind integrates cleanly with the live session.
    bound = cal_client.post(f"/deflectometry/calibrations/bind/{sid}").json()
    assert bound["id"] == sid


# ---------------------------------------------------------------------------
# 3) Status-field contract (drives frontend gating)
# ---------------------------------------------------------------------------

def test_status_active_cal_session_shape_unbound(cal_client: TestClient):
    """Before any bind, /status.active_cal_session is null — frontend
    banner must show."""
    status = cal_client.get("/deflectometry/status").json()
    assert status["active_cal_session"] is None
    assert "display_linearization" in status


def test_status_active_cal_session_shape_bound(cal_client: TestClient):
    """After bind, /status.active_cal_session exposes id + completeness
    + rig_fingerprint + captured_at — exactly what the frontend reads
    to decide whether capture is allowed."""
    fp = cal_client.get("/deflectometry/rig-fingerprint", params={
        "display_model": "iPad",
        "pixel_pitch_mm": 0.0962,
        "pixels_per_mm": 25.0,
    }).json()["rig_fingerprint"]

    saved = cal_client.post("/deflectometry/calibrations", json={
        "rig_fingerprint": fp,
        "display_response": _canned_display_response(),
        "corner_check": _canned_corner_check(),
        "sphere_cal": _canned_sphere_cal(),
    }).json()
    cal_client.post(f"/deflectometry/calibrations/bind/{saved['id']}")

    summary = cal_client.get("/deflectometry/status").json()["active_cal_session"]
    assert summary is not None
    assert set(summary.keys()) == {"id", "captured_at", "completeness", "rig_fingerprint"}
    assert summary["completeness"]["display"] is True
    assert summary["completeness"]["corner"] is True
    assert summary["completeness"]["sphere"] is True


def test_wizard_rebind_replaces_active_session(cal_client: TestClient):
    """Re-calibration replaces the active session (user picks 'Swap
    calibration' or 'Re-calibrate' from the badge menu)."""
    fp = cal_client.get("/deflectometry/rig-fingerprint", params={
        "display_model": "iPad",
        "pixel_pitch_mm": 0.0962,
        "pixels_per_mm": 25.0,
    }).json()["rig_fingerprint"]

    def _save() -> str:
        return cal_client.post("/deflectometry/calibrations", json={
            "rig_fingerprint": fp,
            "display_response": _canned_display_response(),
            "corner_check": _canned_corner_check(),
            "sphere_cal": _canned_sphere_cal(),
        }).json()["id"]

    first = _save()
    cal_client.post(f"/deflectometry/calibrations/bind/{first}")
    second = _save()
    cal_client.post(f"/deflectometry/calibrations/bind/{second}")

    active = cal_client.get("/deflectometry/status").json()["active_cal_session"]
    assert active["id"] == second
    assert first != second
