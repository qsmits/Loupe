from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .session_store import SessionFrameStore, get_session_id_dep
from .vision.alignment import extract_dxf_circles, align_circles


class DetectedCircle(BaseModel):
    x: float
    y: float
    radius: float


class AlignDxfBody(BaseModel):
    entities: list[dict]
    circles: list[DetectedCircle]
    pixels_per_mm: float = Field(gt=0)


class AlignEdgesBody(BaseModel):
    entities: list[dict]
    pixels_per_mm: float = Field(gt=0)
    angle_range: float = Field(default=5.0, ge=0, le=30)
    smoothing: int = Field(default=2, ge=1, le=3)


class ExportDxfBody(BaseModel):
    annotations: list[dict]
    pixels_per_mm: float = Field(gt=0)
    origin_x: float = 0
    origin_y: float = 0


class InspectGuidedBody(BaseModel):
    entities: list[dict]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    corridor_px: float = Field(default=15.0, gt=0)
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)
    feature_tolerances: dict = Field(default_factory=dict)
    smoothing: int = Field(default=1, ge=1, le=3)
    canny_low: int = Field(default=50, ge=0, le=255)
    canny_high: int = Field(default=130, ge=0, le=255)
    subpixel: str = Field(default="parabola")


class FitFeatureBody(BaseModel):
    entity: dict
    points: list[list[float]]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)
    subpixel: str = Field(default="parabola")


class RefinePointBody(BaseModel):
    x: float
    y: float
    search_radius: int = Field(default=10, ge=1, le=50)
    subpixel: str = Field(default="parabola")


# Module-level router for endpoints that don't need frame_store or camera
router = APIRouter()


@router.post("/align-dxf")
def align_dxf_route(body: AlignDxfBody):
    dxf_circles = extract_dxf_circles(body.entities)
    if len(dxf_circles) < 2:
        raise HTTPException(
            status_code=400,
            detail="At least 2 DXF circles required for alignment",
        )
    detected = [(c.x, c.y, c.radius) for c in body.circles]
    result = align_circles(dxf_circles, detected, body.pixels_per_mm)
    return result


@router.post("/export-dxf")
def export_dxf_route(body: ExportDxfBody):
    from .vision.dxf_export import export_annotations_dxf
    dxf_bytes = export_annotations_dxf(
        body.annotations, body.pixels_per_mm,
        body.origin_x, body.origin_y,
    )
    return Response(
        content=dxf_bytes,
        media_type="application/dxf",
        headers={"Content-Disposition": "attachment; filename=measurements.dxf"},
    )


def make_inspection_router(frame_store: SessionFrameStore) -> APIRouter:
    insp_router = APIRouter()

    @insp_router.post("/align-dxf-edges")
    async def align_dxf_edges_route(body: AlignEdgesBody, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        from .vision.alignment import align_dxf_edges
        result = align_dxf_edges(
            frame, body.entities, body.pixels_per_mm,
            angle_range=body.angle_range,
            smoothing=body.smoothing,
        )
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("reason", "Alignment failed"))
        return result

    @insp_router.post("/inspect-guided")
    async def inspect_guided_route(body: InspectGuidedBody, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        from .vision.guided_inspection import inspect_features
        return inspect_features(
            frame, body.entities, body.pixels_per_mm,
            body.tx, body.ty, body.angle_deg, body.flip_h, body.flip_v,
            corridor_px=body.corridor_px,
            tolerance_warn=body.tolerance_warn,
            tolerance_fail=body.tolerance_fail,
            feature_tolerances=body.feature_tolerances,
            smoothing=body.smoothing,
            canny_low=body.canny_low,
            canny_high=body.canny_high,
            subpixel=body.subpixel,
        )

    @insp_router.post("/fit-feature")
    async def fit_feature_route(body: FitFeatureBody):
        from .vision.guided_inspection import fit_manual_points
        return fit_manual_points(
            body.entity, body.points, body.pixels_per_mm,
            body.tx, body.ty, body.angle_deg, body.flip_h, body.flip_v,
            body.tolerance_warn, body.tolerance_fail,
        )

    @insp_router.post("/load-dxf")
    async def load_dxf_route(file: UploadFile = File(...)):
        content = await file.read()
        try:
            from .vision.dxf_parser import parse_dxf
            entities = parse_dxf(content)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return entities

    @insp_router.post("/refine-point")
    async def refine_point(body: RefinePointBody, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=404, detail="No frame stored")
        import cv2
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        from .vision.subpixel import refine_single_point
        x, y, magnitude = refine_single_point(
            (body.x, body.y), gray,
            search_radius=body.search_radius, method=body.subpixel)
        return {"x": x, "y": y, "magnitude": magnitude}

    @insp_router.get("/subpixel-methods")
    async def get_subpixel_methods():
        from .vision.subpixel import available_methods
        return available_methods()

    @insp_router.post("/gradient-overlay")
    async def gradient_overlay(session_id: str = Depends(get_session_id_dep)):
        import numpy as np
        import cv2
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=404, detail="No frame stored")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
        gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
        mag = np.sqrt(gx * gx + gy * gy)
        mag_norm = cv2.normalize(mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        colored = cv2.applyColorMap(mag_norm, cv2.COLORMAP_VIRIDIS)
        ok, buf = cv2.imencode(".jpg", colored, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            raise HTTPException(500, detail="Failed to encode gradient overlay")
        return Response(content=buf.tobytes(), media_type="image/jpeg")

    return insp_router
