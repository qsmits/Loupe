"""Unit + API tests for ScreenShape data model and disk-backed store.

Covers Phase 3B+4 Wave 1 Track B: the pluggable representation of the iPad's
geometric shape (Rectangular2D / Distorted2D) used by the geometric slope
solver and ball cal.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import screen_shape_store
from backend.vision.screen_shape import (
    SCREEN_SHAPE_SCHEMA_VERSION,
    Distorted2DShape,
    Rectangular2DShape,
    ScreenShape,
)


# iPad Pro 11" active area, used throughout.
W = 218.0
H = 291.0


# ---------------------------------------------------------------------------
# Rectangular2DShape
# ---------------------------------------------------------------------------

def test_rectangular_2d_point_at_corners():
    shape = Rectangular2DShape(width_mm=W, height_mm=H)
    np.testing.assert_allclose(shape.point_at(np.array([0.0, 0.0])), [0.0, 0.0, 0.0])
    np.testing.assert_allclose(shape.point_at(np.array([1.0, 1.0])), [W, H, 0.0])
    np.testing.assert_allclose(
        shape.point_at(np.array([0.5, 0.5])), [W / 2, H / 2, 0.0]
    )


def test_rectangular_2d_point_at_batch():
    shape = Rectangular2DShape(width_mm=W, height_mm=H)
    uv = np.array([[0.0, 0.0], [1.0, 1.0], [0.5, 0.25]])
    out = shape.point_at(uv)
    assert out.shape == (3, 3)
    np.testing.assert_allclose(out[0], [0.0, 0.0, 0.0])
    np.testing.assert_allclose(out[1], [W, H, 0.0])
    np.testing.assert_allclose(out[2], [W * 0.5, H * 0.25, 0.0])


def test_rectangular_2d_serialization_roundtrip():
    shape = Rectangular2DShape(width_mm=W, height_mm=H)
    d = shape.as_dict()
    assert d["kind"] == "rectangular_2d"
    assert d["schema_version"] == SCREEN_SHAPE_SCHEMA_VERSION
    assert d["width_mm"] == W
    assert d["height_mm"] == H

    restored = ScreenShape.from_dict(d)
    assert isinstance(restored, Rectangular2DShape)
    np.testing.assert_allclose(
        restored.point_at(np.array([0.3, 0.7])),
        shape.point_at(np.array([0.3, 0.7])),
    )


# ---------------------------------------------------------------------------
# Distorted2DShape
# ---------------------------------------------------------------------------

def _flat_control_points(width: float, height: float) -> tuple[np.ndarray, np.ndarray]:
    """4 corners with their flat (x, y, 0) values — the identity fit."""
    uv = np.array([
        [0.0, 0.0],
        [1.0, 0.0],
        [0.0, 1.0],
        [1.0, 1.0],
    ], dtype=np.float64)
    xyz = np.array([
        [0.0,   0.0,    0.0],
        [width, 0.0,    0.0],
        [0.0,   height, 0.0],
        [width, height, 0.0],
    ], dtype=np.float64)
    return uv, xyz


def test_distorted_2d_identity_fit():
    uv, xyz = _flat_control_points(W, H)
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
    )
    # Interior point: should be exactly flat (x = u*W, y = v*H, z = 0).
    p = shape.point_at(np.array([0.3, 0.7]))
    np.testing.assert_allclose(p, [0.3 * W, 0.7 * H, 0.0], atol=1e-9)


def test_distorted_2d_panel_bow_fit():
    # Synthetic bow: z = -0.01 * (u - 0.5)**2 on a 5×5 grid.
    u = np.linspace(0, 1, 5)
    v = np.linspace(0, 1, 5)
    UU, VV = np.meshgrid(u, v)
    uv = np.column_stack([UU.ravel(), VV.ravel()])
    z = -0.01 * (uv[:, 0] - 0.5) ** 2
    xyz = np.column_stack([uv[:, 0] * W, uv[:, 1] * H, z])
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
    )
    # Center point — sample at (0.5, 0.5). z at center = 0 exactly (grid hits it).
    p_center = shape.point_at(np.array([0.5, 0.5]))
    assert abs(p_center[2] - 0.0) < 1e-9
    # Off-center interior point — bow should pick up.
    p_off = shape.point_at(np.array([0.2, 0.5]))
    # z at (u=0.2) = -0.01 * 0.09 = -9e-4. With linear interp across the grid
    # it should be close but not necessarily exact.
    assert abs(p_off[2] - (-0.01 * (0.2 - 0.5) ** 2)) < 5e-4


def test_distorted_2d_extrapolation_via_nearest():
    uv, xyz = _flat_control_points(W, H)
    # Shrink the hull so we can query outside it. Only corners of a
    # sub-square [0.2, 0.8] × [0.2, 0.8].
    uv = np.array([
        [0.2, 0.2],
        [0.8, 0.2],
        [0.2, 0.8],
        [0.8, 0.8],
    ], dtype=np.float64)
    xyz = np.array([
        [0.2 * W, 0.2 * H, 0.0],
        [0.8 * W, 0.2 * H, 0.0],
        [0.2 * W, 0.8 * H, 0.0],
        [0.8 * W, 0.8 * H, 0.0],
    ], dtype=np.float64)
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
    )
    # Query outside the hull (u=0.05 is < 0.2).
    out, conf = shape.point_at(np.array([0.05, 0.05]), return_confidence=True)
    # Finite, no NaN — nearest-neighbor fallback fired.
    assert np.all(np.isfinite(out))
    assert conf == 0.0
    # Nearest corner is (0.2, 0.2) → (0.2W, 0.2H, 0) → that's what we should get.
    np.testing.assert_allclose(out, [0.2 * W, 0.2 * H, 0.0])


def test_distorted_2d_return_confidence_flag():
    uv, xyz = _flat_control_points(W, H)
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
    )
    # Single-point form
    r = shape.point_at(np.array([0.3, 0.7]), return_confidence=True)
    assert isinstance(r, tuple) and len(r) == 2
    pt, conf = r
    assert pt.shape == (3,)
    assert conf in (0.0, 1.0)
    # Batch form
    r2 = shape.point_at(np.array([[0.3, 0.7], [0.1, 0.1]]), return_confidence=True)
    pts, confs = r2
    assert pts.shape == (2, 3)
    assert confs.shape == (2,)


def test_distorted_2d_serialization_roundtrip():
    u = np.linspace(0, 1, 3)
    v = np.linspace(0, 1, 3)
    UU, VV = np.meshgrid(u, v)
    uv = np.column_stack([UU.ravel(), VV.ravel()])
    xyz = np.column_stack([uv[:, 0] * W, uv[:, 1] * H, np.zeros(len(uv))])
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
        residual_rms_mm=0.012, calibrated_at="2026-04-18T10:00:00+00:00",
    )
    d = shape.as_dict()
    # Verify it's JSON-safe.
    round_tripped = json.loads(json.dumps(d))
    restored = ScreenShape.from_dict(round_tripped)
    assert isinstance(restored, Distorted2DShape)
    assert restored.residual_rms_mm == 0.012
    assert restored.calibrated_at == "2026-04-18T10:00:00+00:00"
    # Same point_at results on an interior probe.
    q = np.array([0.4, 0.6])
    np.testing.assert_allclose(restored.point_at(q), shape.point_at(q))


def test_distorted_2d_insufficient_control_points_falls_back():
    # Only 3 points — 2D Delaunay needs 4. Shape silently falls back to flat.
    uv = np.array([[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]], dtype=np.float64)
    xyz = np.array([
        [0.0, 0.0, 0.0],
        [W, 0.0, 0.0],
        [0.5 * W, H, 0.0],
    ], dtype=np.float64)
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
    )
    # Behaves like Rectangular2D.
    flat = Rectangular2DShape(width_mm=W, height_mm=H)
    p_shape = shape.point_at(np.array([0.3, 0.7]))
    p_flat = flat.point_at(np.array([0.3, 0.7]))
    np.testing.assert_allclose(p_shape, p_flat)


def test_screen_shape_from_dict_dispatches_on_kind():
    with pytest.raises(ValueError):
        ScreenShape.from_dict({"kind": "bogus", "width_mm": 10.0, "height_mm": 10.0})


# ---------------------------------------------------------------------------
# Disk-backed store
# ---------------------------------------------------------------------------

@pytest.fixture
def shape_path(tmp_path, monkeypatch):
    p = tmp_path / "shape.json"
    monkeypatch.setenv("DEFLECTOMETRY_SCREEN_SHAPE_PATH", str(p))
    return p


def test_save_and_load_screen_shape(shape_path):
    uv, xyz = _flat_control_points(W, H)
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
        residual_rms_mm=0.02, calibrated_at="2026-04-18T12:00:00+00:00",
    )
    written = screen_shape_store.save_screen_shape(shape)
    assert written == str(shape_path)
    assert shape_path.exists()

    loaded = screen_shape_store.load_screen_shape()
    assert isinstance(loaded, Distorted2DShape)
    assert loaded.width_mm == W
    assert loaded.height_mm == H
    assert loaded.residual_rms_mm == 0.02
    assert loaded.calibrated_at == "2026-04-18T12:00:00+00:00"
    np.testing.assert_allclose(loaded.control_uv, uv)
    np.testing.assert_allclose(loaded.control_xyz_mm, xyz)


def test_load_missing_screen_shape_returns_none(shape_path):
    # shape_path does not exist yet.
    assert screen_shape_store.load_screen_shape() is None


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------

@pytest.fixture
def api_shape_path(tmp_path, monkeypatch):
    p = tmp_path / "shape.json"
    monkeypatch.setenv("DEFLECTOMETRY_SCREEN_SHAPE_PATH", str(p))
    return p


def test_api_post_screen_shape_accepts_rectangular(
    client: TestClient, api_shape_path
):
    body = Rectangular2DShape(width_mm=W, height_mm=H).as_dict()
    r = client.post("/deflectometry/screen-shape", json=body)
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["status"] == "ok"
    assert result["shape"]["kind"] == "rectangular_2d"
    assert api_shape_path.exists()


def test_api_post_screen_shape_accepts_distorted(
    client: TestClient, api_shape_path
):
    uv, xyz = _flat_control_points(W, H)
    shape = Distorted2DShape(
        width_mm=W, height_mm=H, control_uv=uv, control_xyz_mm=xyz,
    )
    r = client.post("/deflectometry/screen-shape", json=shape.as_dict())
    assert r.status_code == 200, r.text

    r2 = client.get("/deflectometry/screen-shape")
    assert r2.status_code == 200
    data = r2.json()
    assert data is not None
    assert data["kind"] == "distorted_2d"
    assert data["width_mm"] == W
    assert len(data["control_uv"]) == 4


def test_api_delete_screen_shape_removes_file(
    client: TestClient, api_shape_path
):
    body = Rectangular2DShape(width_mm=W, height_mm=H).as_dict()
    r = client.post("/deflectometry/screen-shape", json=body)
    assert r.status_code == 200
    assert api_shape_path.exists()

    rd = client.delete("/deflectometry/screen-shape")
    assert rd.status_code == 200
    assert rd.json()["status"] == "deleted"
    assert not api_shape_path.exists()

    # GET after delete returns null.
    rg = client.get("/deflectometry/screen-shape")
    assert rg.status_code == 200
    assert rg.json() is None


def test_api_post_screen_shape_rejects_invalid_kind(
    client: TestClient, api_shape_path
):
    # Missing required fields → Pydantic 422.
    r = client.post("/deflectometry/screen-shape", json={"kind": "bogus"})
    assert r.status_code in (400, 422)
    # Has required fields but unknown kind → ScreenShape.from_dict → 400.
    r2 = client.post(
        "/deflectometry/screen-shape",
        json={"kind": "not_a_real_kind", "width_mm": 100.0, "height_mm": 200.0},
    )
    assert r2.status_code in (400, 422)
