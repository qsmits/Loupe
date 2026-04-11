import math

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .session_store import SessionFrameStore, get_session_id_dep, safe_error_detail
from .vision.alignment import extract_dxf_circles, align_circles


class DetectedCircle(BaseModel):
    x: float
    y: float
    radius: float


class AlignDxfBody(BaseModel):
    entities: list[dict] = Field(max_length=10000)
    circles: list[DetectedCircle] = Field(max_length=1000)
    pixels_per_mm: float = Field(gt=0, le=100000)


class AlignEdgesBody(BaseModel):
    entities: list[dict] = Field(max_length=10000)
    pixels_per_mm: float = Field(gt=0, le=100000)
    angle_range: float = Field(default=5.0, ge=0, le=30)
    smoothing: int = Field(default=2, ge=1, le=5)


class ExportDxfBody(BaseModel):
    annotations: list[dict] = Field(max_length=10000)
    pixels_per_mm: float = Field(gt=0, le=100000)
    origin_x: float = Field(default=0, ge=-1e6, le=1e6)
    origin_y: float = Field(default=0, ge=-1e6, le=1e6)


class InspectGuidedBody(BaseModel):
    entities: list[dict] = Field(max_length=10000)
    pixels_per_mm: float = Field(gt=0, le=100000)
    tx: float = Field(default=0.0, ge=-1e6, le=1e6)
    ty: float = Field(default=0.0, ge=-1e6, le=1e6)
    angle_deg: float = Field(default=0.0, ge=-360, le=360)
    flip_h: bool = False
    flip_v: bool = False
    corridor_px: float = Field(default=15.0, gt=0, le=200)
    tolerance_warn: float = Field(default=0.10, gt=0, le=100)
    tolerance_fail: float = Field(default=0.25, gt=0, le=100)
    feature_tolerances: dict = Field(default_factory=dict)
    smoothing: int = Field(default=1, ge=1, le=5)
    canny_low: int = Field(default=50, ge=0, le=255)
    canny_high: int = Field(default=130, ge=0, le=255)
    subpixel: str = Field(default="parabola", max_length=20)


class FitFeatureBody(BaseModel):
    entity: dict
    points: list[list[float]] = Field(max_length=1000)
    pixels_per_mm: float = Field(gt=0, le=100000)
    tx: float = Field(default=0.0, ge=-1e6, le=1e6)
    ty: float = Field(default=0.0, ge=-1e6, le=1e6)
    angle_deg: float = Field(default=0.0, ge=-360, le=360)
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0, le=100)
    tolerance_fail: float = Field(default=0.25, gt=0, le=100)
    subpixel: str = Field(default="parabola", max_length=20)


class RefinePointBody(BaseModel):
    x: float = Field(ge=-1e6, le=1e6)
    y: float = Field(ge=-1e6, le=1e6)
    search_radius: int = Field(default=10, ge=1, le=50)
    subpixel: str = Field(default="parabola", max_length=20)


class DetectGearTeethBody(BaseModel):
    """Inputs for /detect-gear-teeth.

    Finds the dominant harmonic of the pitch-circle intensity profile
    to estimate how many teeth the gear has. Caller supplies the fit
    tip/root circles and the frozen frame is loaded from the session
    store.
    """
    cx: float = Field(ge=-1e6, le=1e6)
    cy: float = Field(ge=-1e6, le=1e6)
    r_tip: float = Field(gt=0, le=1e6)
    r_root: float = Field(gt=0, le=1e6)
    k_min: int = Field(default=6, ge=2, le=299)
    k_max: int = Field(default=300, ge=3, le=1000)


class AutoPhaseGearBody(BaseModel):
    """Inputs for /auto-phase-gear.

    Detects the rotation needed to align a rotation=0 synthetic gear with
    the real gear in the frozen frame. Caller supplies the fit tip/root
    circles (same as /generate-gear-dxf) plus tooth count and profile.
    Returns rotation_deg (wrapped to [0, 360/n_teeth)) and snr.
    """
    cx: float = Field(ge=-1e6, le=1e6)
    cy: float = Field(ge=-1e6, le=1e6)
    r_tip: float = Field(gt=0, le=1e6)
    r_root: float = Field(gt=0, le=1e6)
    n_teeth: int = Field(ge=6, le=300)
    pixels_per_mm: float = Field(gt=0, le=100000)
    profile: str = Field(pattern="^(involute|cycloidal)$", default="cycloidal")
    addendum_coef: float = Field(default=1.0, ge=0.1, le=3.0)
    dedendum_coef: float | None = Field(default=None, ge=0.1, le=3.0)
    rolling_radius_coef: float = Field(default=0.5, ge=0.1, le=1.0)
    pressure_angle_deg: float = Field(default=20.0, ge=5.0, le=35.0)


class GenerateGearBody(BaseModel):
    """Inputs for /generate-gear-dxf.

    Produces an ideal gear polyline (closed) and serialises it as DXF
    entities in the same shape /load-dxf returns for LWPOLYLINE segments,
    so the result can be loaded directly into the DXF overlay and pushed
    through /inspect-guided.
    """
    n_teeth: int = Field(ge=6, le=300)
    profile: str = Field(pattern="^(involute|cycloidal)$")
    module: float = Field(gt=0, le=1e5)
    cx: float = Field(ge=-1e6, le=1e6)
    cy: float = Field(ge=-1e6, le=1e6)
    addendum_coef: float = Field(default=1.0, ge=0.1, le=3.0)
    dedendum_coef: float = Field(default=1.25, ge=0.1, le=3.0)
    # Cycloidal only.
    rolling_radius_coef: float = Field(default=0.5, ge=0.1, le=1.0)
    # Involute only.
    pressure_angle_deg: float = Field(default=20.0, ge=5.0, le=35.0)
    profile_shift: float = Field(default=0.0, ge=-1.0, le=1.0)
    rotation_deg: float = Field(default=0.0, ge=-360.0, le=360.0)
    layer: str = Field(default="GEAR", max_length=64)
    # Sampling density. Defaults match the generator defaults; the UI can
    # dial these down if inspection performance becomes a concern.
    points_per_flank: int = Field(default=30, ge=4, le=200)
    points_per_tip: int = Field(default=10, ge=2, le=100)
    points_per_root: int = Field(default=6, ge=2, le=100)


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


@router.post("/generate-gear-dxf")
def generate_gear_dxf_route(body: GenerateGearBody):
    """Generate an ideal gear and return it as DXF entities.

    The gear_geometry generators produce closed polylines in gear-local
    coordinates; we rotate by rotation_deg, translate to (cx, cy), then
    emit one polyline_line dict per segment. All segments share a single
    parent_handle so /inspect-guided groups them as one compound feature.
    """
    from .vision.gear_geometry import (
        generate_cycloidal_gear,
        generate_involute_gear,
    )
    try:
        if body.profile == "cycloidal":
            poly, period_length, period_regions = generate_cycloidal_gear(
                n_teeth=body.n_teeth,
                module=body.module,
                rolling_radius_coef=body.rolling_radius_coef,
                addendum_coef=body.addendum_coef,
                dedendum_coef=body.dedendum_coef,
                points_per_flank=body.points_per_flank,
                points_per_tip=body.points_per_tip,
                points_per_root=body.points_per_root,
                return_regions=True,
            )
        else:  # involute
            poly, period_length, period_regions = generate_involute_gear(
                n_teeth=body.n_teeth,
                module=body.module,
                pressure_angle_deg=body.pressure_angle_deg,
                addendum_coef=body.addendum_coef,
                dedendum_coef=body.dedendum_coef,
                profile_shift=body.profile_shift,
                points_per_flank=body.points_per_flank,
                points_per_tip=body.points_per_tip,
                points_per_root=body.points_per_root,
                return_regions=True,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"gear: {exc}") from exc

    phi = math.radians(body.rotation_deg)
    c, s = math.cos(phi), math.sin(phi)
    # Rotate in gear-local frame, then translate to the world center.
    world = [
        (body.cx + c * x - s * y, body.cy + s * x + c * y)
        for (x, y) in poly
    ]

    parent = f"gear_{body.profile}_N{body.n_teeth}"
    entities: list[dict] = []
    # generate_*_gear returns a closed polyline (first == last), so we
    # emit N-1 segments between consecutive points. The period repeats every
    # `period_length` segments, and segment labels within the period are
    # identical for every tooth — so tooth_index = i // period_length and
    # region = period_regions[i % period_length].
    for i in range(len(world) - 1):
        x1, y1 = world[i]
        x2, y2 = world[i + 1]
        tooth_idx = i // period_length
        region = period_regions[i % period_length]
        entities.append({
            "type": "polyline_line",
            "x1": float(x1), "y1": float(y1),
            "x2": float(x2), "y2": float(y2),
            "handle": f"{parent}_s{i}",
            "parent_handle": parent,
            "segment_index": i,
            "tooth_index": tooth_idx,
            "region": region,
            "layer": body.layer,
        })
    return entities


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
    async def load_dxf_route(file: UploadFile = File(...), request: Request = None):
        # Limit DXF file size (text-based, can be huge)
        content = await file.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024:
            raise HTTPException(413, detail="DXF file too large (max 10MB)")
        try:
            from .vision.dxf_parser import parse_dxf
            entities = parse_dxf(content)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=safe_error_detail(request, exc, "Invalid DXF file"))
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

    @insp_router.post("/detect-gear-teeth")
    async def detect_gear_teeth_route(body: DetectGearTeethBody, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        from .vision.gear_phase import estimate_gear_tooth_count
        try:
            n_teeth, snr = estimate_gear_tooth_count(
                frame,
                cx=body.cx, cy=body.cy,
                r_tip=body.r_tip, r_root=body.r_root,
                k_min=body.k_min, k_max=body.k_max,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"gear teeth: {exc}") from exc
        return {"n_teeth": n_teeth, "snr": snr}

    @insp_router.post("/auto-phase-gear")
    async def auto_phase_gear_route(body: AutoPhaseGearBody, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        from .vision.gear_phase import estimate_gear_phase
        try:
            rotation_deg, snr = estimate_gear_phase(
                frame,
                cx=body.cx, cy=body.cy,
                r_tip=body.r_tip, r_root=body.r_root,
                n_teeth=body.n_teeth,
                pixels_per_mm=body.pixels_per_mm,
                profile=body.profile,
                addendum_coef=body.addendum_coef,
                dedendum_coef=body.dedendum_coef,
                rolling_radius_coef=body.rolling_radius_coef,
                pressure_angle_deg=body.pressure_angle_deg,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"gear phase: {exc}") from exc
        return {"rotation_deg": rotation_deg, "snr": snr}

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
