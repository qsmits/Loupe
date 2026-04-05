"""Tests for the 4-up compare settings proposer and its API."""

import base64

import cv2
import numpy as np
import pytest

from backend.vision.settings_proposer import (
    propose_four_variants,
    apply_variant,
)


def _mean_luma(frame_bgr: np.ndarray) -> float:
    return float(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).mean())


def _synthetic(mean: int, size=(240, 320)) -> np.ndarray:
    """Dark/bright textured frame with a simple sinusoidal pattern for contrast."""
    h, w = size
    yy, xx = np.mgrid[0:h, 0:w]
    pattern = (np.sin(xx / 20.0) * np.cos(yy / 20.0) * 20).astype(np.int16)
    frame = np.clip(pattern + mean, 0, 255).astype(np.uint8)
    return cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)


# ── Proposer: variant shape ────────────────────────────────────────────────

def test_propose_returns_four_named_variants():
    frame = _synthetic(128)
    variants = propose_four_variants(frame)
    assert len(variants) == 4
    names = [v["name"] for v in variants]
    assert names == ["Balanced", "High contrast edges", "Shadow detail", "Highlight detail"]
    required_keys = {
        "name", "description", "gain", "exposure_scale",
        "gamma", "contrast", "saturation", "clahe", "unsharp",
    }
    for v in variants:
        assert required_keys.issubset(v.keys())


# ── Under-exposed: shadow variant should lift and use gamma < 1 ───────────

def test_underexposed_shadow_variant_lifts_luminance():
    dark = _synthetic(40)
    variants = propose_four_variants(dark)
    shadow = next(v for v in variants if v["name"] == "Shadow detail")
    assert shadow["gamma"] < 1.0

    out = apply_variant(dark, shadow)
    assert _mean_luma(out) > _mean_luma(dark) + 10  # meaningfully brighter


# ── Over-exposed: highlight variant should pull luminance down ────────────

def test_overexposed_highlight_variant_compresses_luminance():
    bright = _synthetic(220)
    variants = propose_four_variants(bright)
    hl = next(v for v in variants if v["name"] == "Highlight detail")
    assert hl["gamma"] > 1.0

    out = apply_variant(bright, hl)
    assert _mean_luma(out) < _mean_luma(bright) - 5  # meaningfully darker


# ── apply_variant is pure (doesn't mutate input) ───────────────────────────

def test_apply_variant_does_not_mutate_input():
    frame = _synthetic(128)
    before = frame.copy()
    apply_variant(frame, {"gamma": 0.5, "clahe": True, "unsharp": 0.5})
    assert np.array_equal(before, frame)


def test_apply_variant_handles_empty_variant():
    frame = _synthetic(128)
    out = apply_variant(frame, {})
    assert out.shape == frame.shape


# ── API endpoints (uses the FakeCamera fixture from conftest.py) ───────────

def test_compare_propose_endpoint(client):
    r = client.post("/compare/propose")
    assert r.status_code == 200
    body = r.json()
    assert len(body["variants"]) == 4
    for item in body["variants"]:
        # JPEG magic bytes after base64 decode
        raw = base64.b64decode(item["preview_b64"])
        assert raw[:3] == b"\xff\xd8\xff"
        assert "variant" in item and "name" in item["variant"]


def test_compare_apply_and_clear(client):
    propose = client.post("/compare/propose").json()
    variant = propose["variants"][2]["variant"]  # Shadow detail

    r = client.post("/compare/apply", json={"variant": variant})
    assert r.status_code == 200
    assert r.json()["active"]["name"] == "Shadow detail"

    r = client.get("/compare/active")
    assert r.json()["active"] is not None

    r = client.post("/compare/clear")
    assert r.status_code == 200
    r = client.get("/compare/active")
    assert r.json()["active"] is None


def test_compare_apply_rejects_bad_variant(client):
    r = client.post("/compare/apply", json={"variant": {"name": "", "gamma": -1}})
    assert r.status_code == 422
