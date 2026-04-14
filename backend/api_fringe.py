"""HTTP API for fringe analysis mode.

Stateless per request: each analysis takes a single image and returns
complete results.  The /reanalyze endpoint accepts cached Zernike
coefficients for instant re-computation when toggling subtraction terms.
"""

from __future__ import annotations

import base64
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .vision.fringe import (
    analyze_interferogram,
    focus_quality,
    reanalyze,
    rasterize_polygon_mask,
)


_fringe_cache: dict = {}


def _reject_hosted(request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Fringe analysis is not available in hosted mode")


class MaskPolygon(BaseModel):
    vertices: list[tuple[float, float]]
    include: bool = True


class RoiRect(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


class AnalyzeBody(BaseModel):
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    mask_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    image_b64: Optional[str] = Field(default=None)
    roi: Optional[RoiRect] = Field(default=None)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)


class ReanalyzeBody(BaseModel):
    coefficients: list[float]
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    surface_height: int = Field(gt=0)
    surface_width: int = Field(gt=0)
    mask: Optional[list[int]] = Field(default=None)
    n_zernike: int = Field(default=36, ge=1, le=66)


class ReanalyzeCarrierBody(BaseModel):
    carrier_y: int
    carrier_x: int
    image_b64: Optional[str] = Field(default=None)
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    mask_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    mask_polygons: Optional[list[MaskPolygon]] = Field(default=None)


def make_fringe_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()

    @router.post("/fringe/analyze", dependencies=[Depends(_reject_hosted)])
    async def fringe_analyze(body: AnalyzeBody):
        """Run the full fringe analysis pipeline.

        Accepts either:
        - image_b64: base64-encoded image (drag-drop or file upload)
        - No image: uses the current frozen camera frame

        NOTE: analyze_interferogram can take >2s at full resolution.
        For production use, this should be wrapped in run_in_executor.
        """
        if body.image_b64:
            # Decode uploaded image
            try:
                img_bytes = base64.b64decode(body.image_b64)
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_GRAYSCALE)
                if image is None:
                    raise ValueError("Could not decode image")
            except Exception as e:
                raise HTTPException(400, detail=f"Invalid image: {e}")
        else:
            # Use camera frame
            frame = camera.get_frame()
            if frame is None:
                raise HTTPException(503, detail="Camera returned no frame")
            image = frame
            if image.ndim == 3:
                image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # Crop to ROI if specified (legacy rectangle mode)
        if body.roi and not body.mask_polygons:
            ih, iw = image.shape[:2]
            x0 = int(body.roi.x * iw)
            y0 = int(body.roi.y * ih)
            x1 = min(int((body.roi.x + body.roi.w) * iw), iw)
            y1 = min(int((body.roi.y + body.roi.h) * ih), ih)
            if x1 - x0 > 10 and y1 - y0 > 10:
                image = image[y0:y1, x0:x1]

        # Build polygon mask if provided
        custom_mask = None
        if body.mask_polygons:
            ih, iw = image.shape[:2]
            custom_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )

        _fringe_cache["last_image"] = image.copy()

        result = analyze_interferogram(
            image,
            wavelength_nm=body.wavelength_nm,
            mask_threshold=body.mask_threshold,
            subtract_terms=body.subtract_terms,
            n_zernike=body.n_zernike,
            use_full_mask=body.roi is not None and not body.mask_polygons,
            custom_mask=custom_mask,
        )
        return result

    @router.post("/fringe/reanalyze", dependencies=[Depends(_reject_hosted)])
    async def fringe_reanalyze(body: ReanalyzeBody):
        """Re-analyze with different Zernike subtraction (no FFT, fast)."""
        result = reanalyze(
            coefficients=body.coefficients,
            subtract_terms=body.subtract_terms,
            wavelength_nm=body.wavelength_nm,
            surface_shape=(body.surface_height, body.surface_width),
            mask_serialized=body.mask,
            n_zernike=body.n_zernike,
        )
        return result

    @router.get("/fringe/focus-quality", dependencies=[Depends(_reject_hosted)])
    async def fringe_focus_quality():
        """Return the focus quality score of the current camera frame."""
        frame = camera.get_frame()
        if frame is None:
            raise HTTPException(503, detail="Camera returned no frame")
        score = focus_quality(frame)
        return {"score": score}

    @router.post("/fringe/reanalyze-carrier", dependencies=[Depends(_reject_hosted)])
    async def fringe_reanalyze_carrier(body: ReanalyzeCarrierBody):
        """Re-analyze with a manually selected carrier peak."""
        if body.image_b64:
            try:
                img_bytes = base64.b64decode(body.image_b64)
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_GRAYSCALE)
                if image is None:
                    raise ValueError("Could not decode image")
            except Exception as e:
                raise HTTPException(400, detail=f"Invalid image: {e}")
        elif _fringe_cache.get("last_image") is not None:
            image = _fringe_cache["last_image"]
        else:
            raise HTTPException(400, detail="No cached image. Run /fringe/analyze first or provide image_b64.")

        custom_mask = None
        if body.mask_polygons:
            ih, iw = image.shape[:2]
            custom_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )

        result = analyze_interferogram(
            image,
            wavelength_nm=body.wavelength_nm,
            mask_threshold=body.mask_threshold,
            subtract_terms=body.subtract_terms,
            n_zernike=body.n_zernike,
            custom_mask=custom_mask,
            carrier_override=(body.carrier_y, body.carrier_x),
        )
        return result

    return router
