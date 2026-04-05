"""
API endpoints for the Keyence-style 4-up image-settings comparison feature.

Exposes:
    POST /compare/propose  — grab current frame, return 4 variant dicts
                              plus base64 JPEG previews
    POST /compare/apply    — store a variant as the active stream profile
    POST /compare/clear    — clear the active profile
    GET  /compare/active   — inspect the currently active profile (or null)

The active profile is a module-level shared state (guarded by a lock) so that
the MJPEG generator in ``backend.stream`` can read it per frame without any
session coupling — the whole point of the feature is to tweak what the live
stream looks like.
"""

from __future__ import annotations

import base64
import threading
from typing import Optional

import cv2
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .vision.settings_proposer import propose_four_variants, apply_variant


# ── Shared state ───────────────────────────────────────────────────────────

_active_lock = threading.Lock()
_active_profile: Optional[dict] = None


def get_active_profile() -> Optional[dict]:
    """Thread-safe read. Returns a shallow copy (or None)."""
    with _active_lock:
        return dict(_active_profile) if _active_profile else None


def _set_active_profile(profile: Optional[dict]) -> None:
    global _active_profile
    with _active_lock:
        _active_profile = dict(profile) if profile else None


# ── Schemas ────────────────────────────────────────────────────────────────

class VariantBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    description: str = Field(default="", max_length=256)
    gain: float = Field(default=1.0, ge=0.0, le=16.0)
    exposure_scale: float = Field(default=1.0, ge=0.05, le=16.0)
    gamma: float = Field(default=1.0, ge=0.1, le=4.0)
    contrast: float = Field(default=1.0, ge=0.1, le=4.0)
    saturation: float = Field(default=1.0, ge=0.0, le=4.0)
    clahe: bool = False
    unsharp: float = Field(default=0.0, ge=0.0, le=4.0)


class ApplyBody(BaseModel):
    variant: VariantBody


# ── Router factory ─────────────────────────────────────────────────────────

def make_compare_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()

    @router.post("/compare/propose")
    async def compare_propose():
        frame = camera.get_frame()
        if frame is None or frame.size == 0:
            raise HTTPException(503, detail="No frame available")

        variants = propose_four_variants(frame)
        items = []
        for v in variants:
            preview = apply_variant(frame, v)
            # Resize preview for smaller payload — max 640 on long side.
            h, w = preview.shape[:2]
            long = max(h, w)
            if long > 640:
                scale = 640.0 / long
                preview = cv2.resize(
                    preview,
                    (int(round(w * scale)), int(round(h * scale))),
                    interpolation=cv2.INTER_AREA,
                )
            ok, buf = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                raise HTTPException(500, detail="Failed to encode preview")
            items.append({
                "variant": v,
                "preview_b64": base64.b64encode(buf.tobytes()).decode("ascii"),
            })
        return {"variants": items}

    @router.post("/compare/apply")
    async def compare_apply(body: ApplyBody):
        _set_active_profile(body.variant.model_dump())
        return {"ok": True, "active": get_active_profile()}

    @router.post("/compare/clear")
    async def compare_clear():
        _set_active_profile(None)
        return {"ok": True}

    @router.get("/compare/active")
    async def compare_active():
        return {"active": get_active_profile()}

    return router
