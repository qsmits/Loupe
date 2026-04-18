"""Unit tests for CalibrationSession envelope + disk-backed store.

Covers Phase 3A Track A: build_calibration_session, is_calibration_session_valid,
compute_rig_fingerprint, and the backend/calibration_store.py persistence API.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from backend import calibration_store
from backend.vision.deflectometry import (
    CALIBRATION_SESSION_SCHEMA_VERSION,
    build_calibration_session,
    compute_rig_fingerprint,
    is_calibration_session_valid,
)


@pytest.fixture
def cal_dir(tmp_path, monkeypatch):
    """Point DEFLECTOMETRY_CAL_DIR at a per-test tmp_path."""
    monkeypatch.setenv("DEFLECTOMETRY_CAL_DIR", str(tmp_path))
    # Colocate the ref-flat dir under tmp_path too so tests never touch
    # the repo's real data/reference_flat directory.
    monkeypatch.setenv(
        "DEFLECTOMETRY_REF_FLAT_DIR", str(tmp_path / "reference_flat"),
    )
    return tmp_path


# ---------------------------------------------------------------------------
# Envelope + validation
# ---------------------------------------------------------------------------

def test_build_calibration_session_minimum_valid():
    session = build_calibration_session(
        display_response={"ok": True},
        corner_check={"status": "good"},
        sphere_cal={"cal_factor": 0.001},
        rig_fingerprint="deadbeefcafebabe",
    )
    assert session["schema_version"] == CALIBRATION_SESSION_SCHEMA_VERSION
    assert isinstance(session["id"], str) and len(session["id"]) == 32
    assert session["rig_fingerprint"] == "deadbeefcafebabe"
    assert session["completeness"] == {
        "display": True, "corner": True, "sphere": True, "reference": False,
        "screen_shape": False, "microscope": False,
    }
    is_valid, missing = is_calibration_session_valid(session)
    assert is_valid is True
    assert missing == []


def test_build_calibration_session_missing_sphere_is_invalid():
    session = build_calibration_session(
        display_response={"ok": True},
        corner_check={"status": "good"},
        rig_fingerprint="deadbeefcafebabe",
    )
    is_valid, missing = is_calibration_session_valid(session)
    assert is_valid is False
    assert "sphere" in missing


def test_build_calibration_session_requires_reference_flag():
    session = build_calibration_session(
        display_response={"ok": True},
        corner_check={"status": "good"},
        sphere_cal={"cal_factor": 0.001},
        rig_fingerprint="fp",
    )
    # Default: reference not required → valid.
    assert is_calibration_session_valid(session)[0] is True
    # With require_reference: missing reference → invalid.
    is_valid, missing = is_calibration_session_valid(session, require_reference=True)
    assert is_valid is False
    assert "reference" in missing


def test_build_calibration_session_requires_rig_fingerprint():
    with pytest.raises(ValueError):
        build_calibration_session(rig_fingerprint="")


# ---------------------------------------------------------------------------
# Rig fingerprint
# ---------------------------------------------------------------------------

def test_rig_fingerprint_deterministic():
    kwargs = dict(
        camera_id="cam-1",
        display_model="iPad Pro 11",
        display_pixel_pitch_mm=0.0962,
        pixels_per_mm=25.0,
        screen_distance_mm=150.0,
    )
    a = compute_rig_fingerprint(**kwargs)
    b = compute_rig_fingerprint(**kwargs)
    assert a == b
    assert len(a) == 16

    # Different camera → different fingerprint.
    kwargs2 = dict(kwargs, camera_id="cam-2")
    assert compute_rig_fingerprint(**kwargs2) != a

    # Different display model → different fingerprint.
    kwargs3 = dict(kwargs, display_model="iPad Air")
    assert compute_rig_fingerprint(**kwargs3) != a


def test_rig_fingerprint_insensitive_to_tiny_float_drift():
    a = compute_rig_fingerprint(
        camera_id="cam-1",
        display_model="iPad",
        display_pixel_pitch_mm=0.0962,
        pixels_per_mm=25.0,
    )
    b = compute_rig_fingerprint(
        camera_id="cam-1",
        display_model="iPad",
        display_pixel_pitch_mm=0.09620001,
        pixels_per_mm=25.00001,
    )
    assert a == b


# ---------------------------------------------------------------------------
# Store: round-trip, listing, latest, delete, atomicity
# ---------------------------------------------------------------------------

def _make(rig="rig-A", **overrides) -> dict:
    """Build a full (complete) session with defaults."""
    kwargs = dict(
        display_response={"ok": True},
        corner_check={"status": "good"},
        sphere_cal={"cal_factor": 0.001},
        rig_fingerprint=rig,
    )
    kwargs.update(overrides)
    return build_calibration_session(**kwargs)


def test_save_and_load_round_trip(cal_dir):
    session = _make()
    calibration_store.save_calibration_session(session)

    loaded = calibration_store.load_calibration_session(session["id"])
    assert loaded == session


def test_load_missing_returns_none(cal_dir):
    assert calibration_store.load_calibration_session("nonexistent-id") is None


def test_list_sessions_filters_by_rig_fingerprint(cal_dir):
    a1 = _make(rig="rig-A")
    a2 = _make(rig="rig-A")
    b1 = _make(rig="rig-B")
    for s in (a1, a2, b1):
        calibration_store.save_calibration_session(s)

    all_sessions = calibration_store.list_calibration_sessions()
    assert len(all_sessions) == 3

    just_a = calibration_store.list_calibration_sessions(rig_fingerprint="rig-A")
    assert {s["id"] for s in just_a} == {a1["id"], a2["id"]}

    just_b = calibration_store.list_calibration_sessions(rig_fingerprint="rig-B")
    assert [s["id"] for s in just_b] == [b1["id"]]


def test_list_sessions_newest_first(cal_dir):
    s_old = _make(rig="rig-X")
    s_old["captured_at"] = "2024-01-01T00:00:00+00:00"
    s_mid = _make(rig="rig-X")
    s_mid["captured_at"] = "2025-06-15T12:00:00+00:00"
    s_new = _make(rig="rig-X")
    s_new["captured_at"] = "2026-04-18T08:00:00+00:00"

    # Save in scrambled order to rule out insertion-order coincidence.
    for s in (s_mid, s_old, s_new):
        calibration_store.save_calibration_session(s)

    listed = calibration_store.list_calibration_sessions()
    ids = [s["id"] for s in listed]
    assert ids == [s_new["id"], s_mid["id"], s_old["id"]]


def test_list_sessions_summary_shape(cal_dir):
    session = _make(rig="rig-Y")
    session["notes"] = "first cal of the day"
    calibration_store.save_calibration_session(session)

    listed = calibration_store.list_calibration_sessions()
    assert len(listed) == 1
    summary = listed[0]
    assert set(summary.keys()) == {
        "id", "rig_fingerprint", "captured_at", "completeness", "notes",
    }
    assert summary["notes"] == "first cal of the day"
    # Full envelope fields must NOT appear in the summary.
    assert "display_response" not in summary
    assert "sphere_cal" not in summary


def test_latest_for_rig_requires_completeness(cal_dir):
    # Incomplete session — only display_response.
    incomplete = build_calibration_session(
        display_response={"ok": True},
        rig_fingerprint="rig-Z",
    )
    incomplete["captured_at"] = "2026-04-18T10:00:00+00:00"
    calibration_store.save_calibration_session(incomplete)

    # Complete session, older timestamp.
    complete = _make(rig="rig-Z")
    complete["captured_at"] = "2026-04-17T10:00:00+00:00"
    calibration_store.save_calibration_session(complete)

    result = calibration_store.latest_for_rig("rig-Z")
    assert result is not None
    assert result["id"] == complete["id"]


def test_latest_for_rig_returns_none_when_no_complete(cal_dir):
    incomplete = build_calibration_session(
        display_response={"ok": True},
        rig_fingerprint="rig-E",
    )
    calibration_store.save_calibration_session(incomplete)
    assert calibration_store.latest_for_rig("rig-E") is None


def test_latest_for_rig_no_sessions(cal_dir):
    assert calibration_store.latest_for_rig("no-such-rig") is None


def test_delete_calibration_session(cal_dir):
    session = _make()
    calibration_store.save_calibration_session(session)
    assert calibration_store.load_calibration_session(session["id"]) is not None

    assert calibration_store.delete_calibration_session(session["id"]) is True
    assert calibration_store.load_calibration_session(session["id"]) is None

    # Idempotent: second delete returns False.
    assert calibration_store.delete_calibration_session(session["id"]) is False


def test_atomic_write_does_not_leak_tmp_file(cal_dir):
    session = _make()
    calibration_store.save_calibration_session(session)

    # No dotfile (.<id>.json.tmp) should survive the write.
    residual_tmps = [p for p in cal_dir.iterdir() if p.name.startswith(".")]
    assert residual_tmps == []

    # The final file exists and is valid JSON.
    final = cal_dir / f"{session['id']}.json"
    assert final.exists()
    parsed = json.loads(final.read_text())
    assert parsed["id"] == session["id"]


def test_save_session_without_id_raises(cal_dir):
    with pytest.raises(ValueError):
        calibration_store.save_calibration_session({"no_id": True})


def test_list_ignores_tmp_and_non_json(cal_dir):
    session = _make()
    calibration_store.save_calibration_session(session)
    # Drop a bogus .tmp and a non-JSON file alongside the real session.
    (cal_dir / ".something.tmp").write_text("junk")
    (cal_dir / "notes.txt").write_text("hello")

    listed = calibration_store.list_calibration_sessions()
    assert len(listed) == 1
    assert listed[0]["id"] == session["id"]


# ---------------------------------------------------------------------------
# Microscope calibration snapshot on the envelope
# ---------------------------------------------------------------------------

def test_build_calibration_session_includes_microscope_cal():
    micro = {
        "pixels_per_mm": 24.789,
        "calibrated_at": "2026-04-18T09:00:00+00:00",
        "source": "microscope_mode_cal",
    }
    session = build_calibration_session(
        display_response={"ok": True},
        corner_check={"status": "good"},
        sphere_cal={"cal_factor": 0.001},
        microscope_calibration=micro,
        rig_fingerprint="fp",
    )
    assert session["microscope_calibration"] == micro
    assert session["completeness"]["microscope"] is True


def test_build_calibration_session_no_microscope_cal_marks_incomplete():
    session = build_calibration_session(
        display_response={"ok": True},
        corner_check={"status": "good"},
        sphere_cal={"cal_factor": 0.001},
        rig_fingerprint="fp",
    )
    assert session["microscope_calibration"] is None
    assert session["completeness"]["microscope"] is False
    # But legacy sessions remain "valid" (is_calibration_session_valid
    # doesn't gate on microscope — backwards compatibility).
    assert is_calibration_session_valid(session)[0] is True


def test_build_calibration_session_microscope_zero_not_counted():
    # A dict with pixels_per_mm=0 or None shouldn't mark microscope complete.
    session = build_calibration_session(
        display_response={"ok": True},
        microscope_calibration={"pixels_per_mm": 0, "source": "x"},
        rig_fingerprint="fp",
    )
    assert session["completeness"]["microscope"] is False


# ---------------------------------------------------------------------------
# Rig fingerprint: microscope_px_per_mm participates in the hash
# ---------------------------------------------------------------------------

def test_rig_fingerprint_includes_microscope_cal():
    base = dict(
        camera_id="cam-1",
        display_model="iPad",
        display_pixel_pitch_mm=0.0962,
        pixels_per_mm=25.0,
    )
    fp_a = compute_rig_fingerprint(**base, microscope_px_per_mm=24.0)
    fp_b = compute_rig_fingerprint(**base, microscope_px_per_mm=25.0)
    fp_none = compute_rig_fingerprint(**base, microscope_px_per_mm=None)
    assert fp_a != fp_b
    assert fp_a != fp_none
    assert fp_b != fp_none


# ---------------------------------------------------------------------------
# Reference-flat npz persistence
# ---------------------------------------------------------------------------

def test_save_and_load_reference_flat_roundtrip(cal_dir):
    rng = np.random.default_rng(42)
    ref_x = rng.normal(size=(16, 20)).astype(np.float32)
    ref_y = rng.normal(size=(16, 20)).astype(np.float32)
    path = calibration_store.save_reference_flat("session-abc", ref_x, ref_y)
    assert path.endswith("session-abc.npz")
    loaded = calibration_store.load_reference_flat("session-abc")
    assert loaded is not None
    got_x, got_y = loaded
    np.testing.assert_array_equal(got_x, ref_x)
    np.testing.assert_array_equal(got_y, ref_y)


def test_load_reference_flat_missing_returns_none(cal_dir):
    assert calibration_store.load_reference_flat("doesnotexist") is None


def test_delete_reference_flat(cal_dir):
    ref = np.ones((4, 4), dtype=np.float32)
    calibration_store.save_reference_flat("to-delete", ref, ref)
    assert calibration_store.load_reference_flat("to-delete") is not None
    assert calibration_store.delete_reference_flat("to-delete") is True
    assert calibration_store.load_reference_flat("to-delete") is None
    # Idempotent: second delete returns False.
    assert calibration_store.delete_reference_flat("to-delete") is False


def test_save_reference_flat_rejects_shape_mismatch(cal_dir):
    a = np.zeros((5, 6), dtype=np.float32)
    b = np.zeros((5, 7), dtype=np.float32)
    with pytest.raises(ValueError):
        calibration_store.save_reference_flat("s", a, b)


def test_save_reference_flat_rejects_bad_session_id(cal_dir):
    a = np.zeros((3, 3), dtype=np.float32)
    with pytest.raises(ValueError):
        calibration_store.save_reference_flat("../evil", a, a)
