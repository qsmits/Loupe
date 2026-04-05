"""
4-quadrant image-settings proposer and applier.

Inspired by the Keyence VHX-900 4-up comparison view: given a single frame,
produce four algorithmically chosen candidate post-processing variants
(balanced, high-contrast, shadow-detail, highlight-detail) so the user can
pick the best-looking one and apply it to the live stream.

The variant dicts use a stable schema:

    {
        "name":           str,    # short label, unique per variant
        "description":    str,    # one-line human description
        "gain":           float,  # linear multiplier on pixel values
        "exposure_scale": float,  # linear multiplier (combines with gain)
        "gamma":          float,  # LUT gamma, <1 lifts shadows, >1 compresses
        "contrast":       float,  # multiplier around mid-grey (1.0 = neutral)
        "saturation":     float,  # HSV S multiplier (1.0 = neutral)
        "clahe":          bool,   # apply CLAHE on L channel
        "unsharp":        float,  # unsharp-mask strength (0 = off)
    }

Everything runs on numpy/OpenCV; apply_variant should stay <50 ms on 1080p.
"""

from __future__ import annotations

import numpy as np
import cv2


# ── Analysis ───────────────────────────────────────────────────────────────

def _analyse(frame_bgr: np.ndarray) -> dict:
    """Compute basic luminance stats used to pick variant parameters."""
    if frame_bgr.ndim == 3:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    else:
        gray = frame_bgr
    mean = float(gray.mean())
    std = float(gray.std())
    p05, p50, p95 = np.percentile(gray, [5, 50, 95]).tolist()
    # clipping ratios (how much of the image is at the extremes)
    clip_low = float((gray <= 2).mean())
    clip_high = float((gray >= 253).mean())
    return {
        "mean":     mean,
        "std":      std,
        "p05":      float(p05),
        "p50":      float(p50),
        "p95":      float(p95),
        "clip_low": clip_low,
        "clip_high": clip_high,
    }


# ── Proposal ───────────────────────────────────────────────────────────────

_TARGET_MEAN = 128.0
_TARGET_STD = 60.0


def propose_four_variants(frame_bgr: np.ndarray) -> list[dict]:
    """
    Analyse ``frame_bgr`` and return exactly four candidate setting dicts.

    The parameters are derived from the input histogram rather than fixed
    constants — e.g. an under-exposed frame will get a larger exposure_scale
    and a lower gamma than a well-exposed one.
    """
    s = _analyse(frame_bgr)
    mean = max(1.0, s["mean"])         # avoid div-by-zero
    std = max(1.0, s["std"])

    # Variant 1 — Balanced: push toward target mean and stddev.
    exp_scale = float(np.clip(_TARGET_MEAN / mean, 0.4, 3.0))
    contrast = float(np.clip(_TARGET_STD / std, 0.6, 2.2))
    balanced = {
        "name": "Balanced",
        "description": f"Auto levels (exp×{exp_scale:.2f}, contrast×{contrast:.2f})",
        "gain": 1.0,
        "exposure_scale": exp_scale,
        "gamma": 1.0,
        "contrast": contrast,
        "saturation": 1.0,
        "clahe": False,
        "unsharp": 0.0,
    }

    # Variant 2 — High contrast edges: CLAHE + extra contrast + unsharp mask.
    hc_contrast = float(np.clip(contrast * 1.25, 0.8, 2.5))
    high_contrast = {
        "name": "High contrast edges",
        "description": f"CLAHE + unsharp (contrast×{hc_contrast:.2f})",
        "gain": 1.0,
        "exposure_scale": exp_scale,
        "gamma": 1.0,
        "contrast": hc_contrast,
        "saturation": 0.9,
        "clahe": True,
        "unsharp": 0.8,
    }

    # Variant 3 — Shadow detail: lift shadows via gamma<1, modest exposure.
    # The darker the image the stronger the lift.
    shadow_gamma = float(np.clip(0.45 + (mean / 255.0) * 0.35, 0.4, 0.85))
    shadow_exp = float(np.clip(exp_scale * 1.15, 0.5, 3.5))
    shadow = {
        "name": "Shadow detail",
        "description": f"Lift shadows (γ={shadow_gamma:.2f})",
        "gain": 1.0,
        "exposure_scale": shadow_exp,
        "gamma": shadow_gamma,
        "contrast": 1.0,
        "saturation": 1.05,
        "clahe": True,
        "unsharp": 0.2,
    }

    # Variant 4 — Highlight detail: compress highlights via gamma>1, reduce exposure.
    highlight_gamma = float(np.clip(1.25 + (1.0 - mean / 255.0) * 0.6, 1.15, 2.2))
    highlight_exp = float(np.clip(min(1.0, _TARGET_MEAN / mean) * 0.85, 0.35, 1.2))
    highlight = {
        "name": "Highlight detail",
        "description": f"Recover highlights (γ={highlight_gamma:.2f})",
        "gain": 1.0,
        "exposure_scale": highlight_exp,
        "gamma": highlight_gamma,
        "contrast": 1.05,
        "saturation": 1.0,
        "clahe": False,
        "unsharp": 0.3,
    }

    return [balanced, high_contrast, shadow, highlight]


# ── Application ────────────────────────────────────────────────────────────

_GAMMA_LUT_CACHE: dict[float, np.ndarray] = {}


def _gamma_lut(gamma: float) -> np.ndarray:
    key = round(float(gamma), 3)
    lut = _GAMMA_LUT_CACHE.get(key)
    if lut is None:
        inv = 1.0 / max(1e-6, key)
        lut = np.clip(((np.arange(256) / 255.0) ** inv) * 255.0, 0, 255).astype(np.uint8)
        _GAMMA_LUT_CACHE[key] = lut
    return lut


def apply_variant(frame_bgr: np.ndarray, variant: dict) -> np.ndarray:
    """
    Apply a variant dict to a BGR frame. Pure function: does not mutate input.

    Order of operations: gain/exposure → contrast → CLAHE → gamma →
    saturation → unsharp. This mirrors typical ISP pipelines.
    """
    if frame_bgr is None or frame_bgr.size == 0:
        return frame_bgr

    v = variant or {}
    gain = float(v.get("gain", 1.0))
    exp_scale = float(v.get("exposure_scale", 1.0))
    contrast = float(v.get("contrast", 1.0))
    gamma = float(v.get("gamma", 1.0))
    saturation = float(v.get("saturation", 1.0))
    clahe_on = bool(v.get("clahe", False))
    unsharp = float(v.get("unsharp", 0.0))

    out = frame_bgr
    linear = gain * exp_scale
    if abs(linear - 1.0) > 1e-3:
        out = cv2.convertScaleAbs(out, alpha=linear, beta=0.0)
    else:
        out = out.copy()

    if abs(contrast - 1.0) > 1e-3:
        # Contrast around mid-grey (128).
        beta = 128.0 * (1.0 - contrast)
        out = cv2.convertScaleAbs(out, alpha=contrast, beta=beta)

    if clahe_on:
        # Apply CLAHE on L-channel of LAB — preserves colour.
        lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        l = clahe.apply(l)
        lab = cv2.merge((l, a, b))
        out = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    if abs(gamma - 1.0) > 1e-3:
        out = cv2.LUT(out, _gamma_lut(gamma))

    if abs(saturation - 1.0) > 1e-3 and out.ndim == 3:
        hsv = cv2.cvtColor(out, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[..., 1] = np.clip(hsv[..., 1] * saturation, 0, 255)
        out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    if unsharp > 1e-3:
        blur = cv2.GaussianBlur(out, (0, 0), sigmaX=1.2)
        out = cv2.addWeighted(out, 1.0 + unsharp, blur, -unsharp, 0)

    return out
