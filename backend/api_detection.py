from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from .session_store import SessionFrameStore, get_session_id_dep
from .vision import detection


class EdgeParams(BaseModel):
    threshold1: int = Field(default=50, ge=0, le=255)
    threshold2: int = Field(default=150, ge=0, le=255)
    surface_mode: str = Field(default="edm", pattern=r"^(edm|lathe|print)$")


class CircleParams(BaseModel):
    dp: float = Field(default=1.2, ge=0.5, le=10.0)
    min_dist: int = Field(default=50, ge=1, le=5000)
    param1: int = Field(default=100, ge=1, le=500)
    param2: int = Field(default=50, ge=1, le=500)
    min_radius: int = Field(default=10, ge=1, le=5000)
    max_radius: int = Field(default=500, ge=1, le=5000)
    subpixel: str = Field(default="none", max_length=20)
    surface_mode: str = Field(default="edm", pattern=r"^(edm|lathe|print)$")


class LineParams(BaseModel):
    threshold1: int = Field(default=50, ge=0, le=255)
    threshold2: int = Field(default=130, ge=0, le=255)
    hough_threshold: int = Field(default=30, ge=1, le=500)
    min_length: int = Field(default=20, ge=1, le=5000)
    max_gap: int = Field(default=8, ge=1, le=500)
    surface_mode: str = Field(default="edm", pattern=r"^(edm|lathe|print)$")


class DetectedLine(BaseModel):
    x1: float; y1: float; x2: float; y2: float; length: float


class DetectedArc(BaseModel):
    cx: float; cy: float; r: float; start_deg: float; end_deg: float


class DetectLinesParams(BaseModel):
    threshold1: int = Field(default=50, ge=0, le=255)
    threshold2: int = Field(default=130, ge=0, le=255)
    min_length: int = Field(default=80, ge=1, le=5000)
    dp_epsilon: float = Field(default=0.012, ge=0.001, le=1.0)
    nms_dist: float = Field(default=20.0, ge=1.0, le=500.0)
    nms_angle: float = Field(default=10.0, ge=0.5, le=90.0)
    smoothing: int = Field(default=1, ge=1, le=5)
    subpixel: str = Field(default="none", max_length=20)
    surface_mode: str = Field(default="edm", pattern=r"^(edm|lathe|print)$")


class DetectArcsParams(BaseModel):
    threshold1: int = Field(default=50, ge=0, le=255)
    threshold2: int = Field(default=130, ge=0, le=255)
    min_span_deg: float = Field(default=50.0, ge=5.0, le=360.0)
    min_radius: int = Field(default=10, ge=1, le=5000)
    max_radius: int = Field(default=500, ge=1, le=5000)
    residual_tol: float = Field(default=0.05, ge=0.001, le=1.0)
    smoothing: int = Field(default=1, ge=1, le=5)
    subpixel: str = Field(default="none", max_length=20)
    surface_mode: str = Field(default="edm", pattern=r"^(edm|lathe|print)$")


class PreprocessedViewParams(BaseModel):
    surface_mode: str = Field(default="edm", pattern=r"^(edm|lathe|print)$")


class MatchDxfLinesBody(BaseModel):
    entities: list[dict] = Field(max_length=10000)
    lines: list[DetectedLine] = Field(max_length=10000)
    pixels_per_mm: float = Field(gt=0, le=100000)
    tx: float = Field(default=0.0, ge=-1e6, le=1e6)
    ty: float = Field(default=0.0, ge=-1e6, le=1e6)
    angle_deg: float = Field(default=0.0, ge=-360, le=360)
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0, le=100)
    tolerance_fail: float = Field(default=0.25, gt=0, le=100)

    @model_validator(mode="after")
    def warn_lt_fail(self) -> "MatchDxfLinesBody":
        if self.tolerance_warn >= self.tolerance_fail:
            raise ValueError("tolerance_warn must be less than tolerance_fail")
        return self


class MatchDxfArcsBody(BaseModel):
    entities: list[dict] = Field(max_length=10000)
    arcs: list[DetectedArc] = Field(max_length=10000)
    pixels_per_mm: float = Field(gt=0, le=100000)
    tx: float = Field(default=0.0, ge=-1e6, le=1e6)
    ty: float = Field(default=0.0, ge=-1e6, le=1e6)
    angle_deg: float = Field(default=0.0, ge=-360, le=360)
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0, le=100)
    tolerance_fail: float = Field(default=0.25, gt=0, le=100)

    @model_validator(mode="after")
    def warn_lt_fail(self) -> "MatchDxfArcsBody":
        if self.tolerance_warn >= self.tolerance_fail:
            raise ValueError("tolerance_warn must be less than tolerance_fail")
        return self


class AnalyzeGearBody(BaseModel):
    cx: float = Field(ge=0, le=100000)
    cy: float = Field(ge=0, le=100000)
    tip_r: float = Field(gt=0, le=100000)
    root_r: float = Field(gt=0, le=100000)
    n_teeth: int = Field(ge=6, le=300)

    @model_validator(mode="after")
    def tip_gt_root(self) -> "AnalyzeGearBody":
        if self.tip_r <= self.root_r:
            raise ValueError("tip_r must be greater than root_r")
        return self


def make_detection_router(frame_store: SessionFrameStore) -> APIRouter:
    router = APIRouter()

    @router.post("/detect-edges")
    async def detect_edges_route(params: EdgeParams, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        png_bytes = detection.detect_edges(frame, params.threshold1, params.threshold2,
                                           surface_mode=params.surface_mode)
        return Response(content=png_bytes, media_type="image/png")

    @router.post("/detect-circles")
    async def detect_circles_route(params: CircleParams, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        circles = detection.detect_circles(
            frame, params.dp, params.min_dist, params.param1,
            params.param2, params.min_radius, params.max_radius,
            subpixel=params.subpixel, surface_mode=params.surface_mode,
        )
        return circles

    @router.post("/detect-lines")
    async def detect_lines_route(params: LineParams, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        lines = detection.detect_lines(
            frame, params.threshold1, params.threshold2,
            params.hough_threshold, params.min_length, params.max_gap,
            surface_mode=params.surface_mode,
        )
        return lines

    @router.post("/detect-lines-merged")
    async def detect_lines_merged_route(params: DetectLinesParams, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        return detection.detect_lines_contour(
            frame, params.threshold1, params.threshold2,
            dp_epsilon=params.dp_epsilon, min_length_px=params.min_length,
            nms_dist_px=params.nms_dist, nms_angle_deg=params.nms_angle,
            smoothing=params.smoothing, subpixel=params.subpixel,
            surface_mode=params.surface_mode)

    @router.post("/detect-arcs-partial")
    async def detect_arcs_partial_route(params: DetectArcsParams, session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        return detection.detect_partial_arcs(
            frame, params.threshold1, params.threshold2,
            min_radius=params.min_radius, max_radius=params.max_radius,
            min_span_deg=params.min_span_deg, residual_tol=params.residual_tol,
            smoothing=params.smoothing, subpixel=params.subpixel,
            surface_mode=params.surface_mode)

    @router.post("/preprocessed-view")
    async def preprocessed_view_route(params: PreprocessedViewParams = PreprocessedViewParams(), session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        jpg_bytes = detection.preprocessed_view(frame, surface_mode=params.surface_mode)
        return Response(content=jpg_bytes, media_type="image/jpeg")

    @router.post("/match-dxf-lines")
    def match_dxf_lines_route(body: MatchDxfLinesBody):
        from .vision.line_arc_matching import match_lines
        results = match_lines(
            body.entities, [l.model_dump() for l in body.lines],
            body.pixels_per_mm, body.tx, body.ty, body.angle_deg,
            body.flip_h, body.flip_v,
        )
        for r in results:
            if r["matched"] and r["perp_dev_mm"] is not None:
                dev = r["perp_dev_mm"]
                r["pass_fail"] = "fail" if dev > body.tolerance_fail else (
                    "warn" if dev > body.tolerance_warn else "pass")
        return results

    @router.post("/match-dxf-arcs")
    def match_dxf_arcs_route(body: MatchDxfArcsBody):
        from .vision.line_arc_matching import match_arcs
        results = match_arcs(
            body.entities, [a.model_dump() for a in body.arcs],
            body.pixels_per_mm, body.tx, body.ty, body.angle_deg,
            body.flip_h, body.flip_v,
        )
        for r in results:
            if r["matched"]:
                dev = max(r["center_dev_mm"] or 0, r["radius_dev_mm"] or 0)
                r["pass_fail"] = "fail" if dev > body.tolerance_fail else (
                    "warn" if dev > body.tolerance_warn else "pass")
        return results

    @router.post("/analyze-gear")
    async def analyze_gear_route(body: AnalyzeGearBody, session_id: str = Depends(get_session_id_dep)):
        import cv2
        from .vision.gear_analysis import analyze_gear

        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        if frame.ndim == 3:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        else:
            gray = frame
        return analyze_gear(
            gray,
            cx=body.cx, cy=body.cy,
            tip_r=body.tip_r, root_r=body.root_r,
            n_teeth=body.n_teeth,
        )

    return router
