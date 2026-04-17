"""DeflectometryResult envelope tests (Phase 0)."""

import json
import math

import numpy as np
import pytest

from backend.vision.deflectometry import (
    DEFLECTOMETRY_ORIGINS,
    wrap_deflectometry_result,
)
from backend.api_deflectometry import _envelope_to_json_safe


def _minimal_result() -> dict:
    return {
        "phase_x_png_b64": "",
        "phase_y_png_b64": "",
        "stats_x": {"pv": 0.0, "rms": 0.0, "mean": 0.0},
        "stats_y": {"pv": 0.0, "rms": 0.0, "mean": 0.0},
    }


def test_wrap_deflectometry_result_adds_envelope_fields():
    result = _minimal_result()
    wrap_deflectometry_result(result, origin="capture")

    for field in (
        "id", "origin", "source_ids", "captured_at",
        "calibration_snapshot", "geometry", "tuning",
        "aperture_recipe", "warnings",
    ):
        assert field in result, f"envelope field {field!r} missing"

    assert result["origin"] == "capture"
    assert result["source_ids"] == []
    assert result["warnings"] == []
    assert result["calibration_snapshot"] is None
    assert result["geometry"] is None
    assert result["tuning"] is None
    assert result["aperture_recipe"] is None
    assert result["captured_at"].endswith("+00:00")
    assert len(result["id"]) == 32
    assert all(c in "0123456789abcdef" for c in result["id"])


def test_wrap_deflectometry_result_preserves_existing_keys():
    result = _minimal_result()
    result["quality"] = {"overall": "good", "warnings": []}
    snapshot = dict(result)

    wrap_deflectometry_result(result, origin="capture")

    for k, v in snapshot.items():
        assert result[k] == v, f"key {k!r} clobbered by wrap"


def test_wrap_deflectometry_result_validates_origin():
    with pytest.raises(ValueError):
        wrap_deflectometry_result(_minimal_result(), origin="bogus")


def test_wrap_deflectometry_result_default_warnings_pulls_from_quality():
    result = _minimal_result()
    result["quality"] = {"overall": "fair", "warnings": ["low-modulation"]}
    wrap_deflectometry_result(result, origin="capture")
    assert result["warnings"] == ["low-modulation"]


def test_wrap_deflectometry_result_id_unique():
    a = _minimal_result()
    b = _minimal_result()
    wrap_deflectometry_result(a, origin="capture")
    wrap_deflectometry_result(b, origin="capture")
    assert a["id"] != b["id"]


def test_wrap_deflectometry_result_idempotent_id_preserved():
    result = _minimal_result()
    wrap_deflectometry_result(result, origin="capture")
    first_id = result["id"]
    first_captured_at = result["captured_at"]

    wrap_deflectometry_result(
        result, origin="averaged",
        calibration_snapshot={"cal_factor": 0.001},
    )
    assert result["id"] == first_id
    # other fields are refreshed
    assert result["origin"] == "averaged"
    assert result["calibration_snapshot"] == {"cal_factor": 0.001}
    # captured_at is regenerated unless caller passes one — no crash either way
    assert isinstance(result["captured_at"], str)
    del first_captured_at  # unused but documents behaviour


def test_known_origins_match_constant():
    assert "capture" in DEFLECTOMETRY_ORIGINS
    assert "averaged" in DEFLECTOMETRY_ORIGINS
    assert "subtracted" in DEFLECTOMETRY_ORIGINS


def test_wrap_deflectometry_result_known_origins_accepted():
    for o in DEFLECTOMETRY_ORIGINS:
        r = _minimal_result()
        wrap_deflectometry_result(r, origin=o)
        assert r["origin"] == o


def test_wrap_deflectometry_result_source_ids_copied_not_shared():
    result = _minimal_result()
    ids = ["abc", "def"]
    wrap_deflectometry_result(result, origin="averaged", source_ids=ids)
    result["source_ids"].append("xyz")
    assert ids == ["abc", "def"]


def test_envelope_round_trip_json():
    grid = np.array([[1.0, 2.0], [float("nan"), 4.0]], dtype=np.float64)
    mask = np.array([[True, True], [False, True]], dtype=bool)
    env = {
        "phase_x_png_b64": "abc",
        "phase_x_grid": grid,
        "trusted_mask_grid": mask,
        "stats_x": {"pv": 3.0, "rms": float("nan"), "mean": 1.0},
    }
    wrap_deflectometry_result(
        env, origin="capture",
        calibration_snapshot={"cal_factor": 0.001, "freq": 16},
        geometry={"screen_pose": None},
        tuning={"freq": 16, "smooth_sigma": 0.0,
                "mask_threshold": 0.02, "capture_style": "single_freq"},
        aperture_recipe={"mask_threshold": 0.02, "polygons": None},
    )

    safe = _envelope_to_json_safe(env)
    blob = json.dumps(safe)
    loaded = json.loads(blob)

    assert loaded["id"] == env["id"]
    assert loaded["origin"] == "capture"
    assert loaded["calibration_snapshot"] == {"cal_factor": 0.001, "freq": 16}
    assert loaded["tuning"]["freq"] == 16
    assert loaded["aperture_recipe"]["mask_threshold"] == 0.02

    # Float grid: NaN preserved as None, other floats intact
    assert loaded["phase_x_grid"][0] == [1.0, 2.0]
    assert loaded["phase_x_grid"][1][0] is None
    assert loaded["phase_x_grid"][1][1] == 4.0

    # Bool mask: 0/1 ints
    assert loaded["trusted_mask_grid"] == [[1, 1], [0, 1]]

    # NaN in nested float
    assert loaded["stats_x"]["rms"] is None
    assert loaded["stats_x"]["pv"] == 3.0


# ── HTTP-level tests ────────────────────────────────────────────────────


def _get_deflectometry_state(client):
    """Reach into the router closure to grab the session state dict."""
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
    from backend.vision.deflectometry import generate_fringe_pattern

    state = _get_deflectometry_state(client)
    s = state["session"]
    assert s is not None, "No active deflectometry session"

    phases = [k * math.pi / 4.0 for k in range(8)]
    frames = []
    for orientation in ("x", "y"):
        for phase in phases:
            f = generate_fringe_pattern(width, height, phase, freq, orientation)
            frames.append(np.stack([f, f, f], axis=-1))
    s.frames = frames


def test_compute_endpoint_returns_envelope_metadata(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_synthetic_frames(client)

    r = client.post("/deflectometry/compute", json={
        "mask_threshold": 0.02, "smooth_sigma": 0.5,
    })
    assert r.status_code == 200, r.text
    data = r.json()

    # Envelope metadata
    for field in ("id", "origin", "source_ids", "captured_at",
                  "calibration_snapshot", "geometry", "tuning",
                  "aperture_recipe", "warnings"):
        assert field in data, f"missing envelope field {field!r}"

    assert data["origin"] == "capture"
    assert data["source_ids"] == []
    assert isinstance(data["warnings"], list)
    assert isinstance(data["calibration_snapshot"], dict)
    assert "cal_factor" in data["calibration_snapshot"]
    assert "has_flat_field" in data["calibration_snapshot"]
    assert isinstance(data["geometry"], dict)
    assert data["geometry"]["screen_pose"] is None
    assert isinstance(data["tuning"], dict)
    assert data["tuning"]["smooth_sigma"] == 0.5
    assert data["tuning"]["mask_threshold"] == 0.02
    assert data["tuning"]["capture_style"] == "single_freq"
    assert isinstance(data["aperture_recipe"], dict)
    assert data["aperture_recipe"]["mask_threshold"] == 0.02

    # Legacy fields still present (no regressions)
    for field in ("phase_x_png_b64", "phase_y_png_b64", "slope_mag_png_b64",
                  "curl_png_b64", "stats_x", "stats_y", "stats_slope_mag",
                  "stats_curl", "has_reference", "mask_valid_frac",
                  "cal_factor", "quality"):
        assert field in data, f"legacy field {field!r} dropped"

    # Numeric grids must NOT bloat the /compute response
    for grid_field in ("phase_x_grid", "phase_y_grid", "modulation_x_grid",
                       "modulation_y_grid", "trusted_mask_grid"):
        assert grid_field not in data, \
            f"{grid_field!r} leaked into /compute response"


def test_get_result_endpoint_returns_grids(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_synthetic_frames(client, width=32, height=32)

    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200, r.text
    rid = r.json()["id"]

    r2 = client.get(f"/deflectometry/result/{rid}")
    assert r2.status_code == 200, r2.text
    full = r2.json()

    assert full["id"] == rid
    assert full["origin"] == "capture"

    # Grids present and shaped 32x32
    for grid_field in ("phase_x_grid", "phase_y_grid", "modulation_x_grid",
                       "modulation_y_grid", "slope_x_grid", "slope_y_grid",
                       "trusted_mask_grid", "display_phase_x_grid",
                       "display_phase_y_grid"):
        assert grid_field in full, f"missing grid {grid_field!r}"
        g = full[grid_field]
        assert isinstance(g, list)
        assert len(g) == 32
        assert len(g[0]) == 32

    # Mask is integer 0/1
    assert all(v in (0, 1) for v in full["trusted_mask_grid"][0])


def test_get_result_endpoint_unknown_id_404s(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.get("/deflectometry/result/0123456789abcdef0123456789abcdef")
    assert r.status_code == 404
