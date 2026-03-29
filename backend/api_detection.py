from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from .frame_store import FrameStore
from .vision import detection


class EdgeParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 150


class CircleParams(BaseModel):
    dp: float = 1.2
    min_dist: int = 50
    param1: int = 100
    param2: int = 50
    min_radius: int = 10
    max_radius: int = 500


class LineParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 130
    hough_threshold: int = 30
    min_length: int = 20
    max_gap: int = 8


class DetectedLine(BaseModel):
    x1: float; y1: float; x2: float; y2: float; length: float


class DetectedArc(BaseModel):
    cx: float; cy: float; r: float; start_deg: float; end_deg: float


class DetectLinesParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 130
    min_length: int = 80
    dp_epsilon: float = 0.012
    nms_dist: float = 20.0
    nms_angle: float = 10.0
    smoothing: int = 1


class DetectArcsParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 130
    min_span_deg: float = 50.0
    min_radius: int = 10
    max_radius: int = 500
    residual_tol: float = 0.05
    smoothing: int = 1


class MatchDxfLinesBody(BaseModel):
    entities: list[dict]
    lines: list[DetectedLine]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)

    @model_validator(mode="after")
    def warn_lt_fail(self) -> "MatchDxfLinesBody":
        if self.tolerance_warn >= self.tolerance_fail:
            raise ValueError("tolerance_warn must be less than tolerance_fail")
        return self


class MatchDxfArcsBody(BaseModel):
    entities: list[dict]
    arcs: list[DetectedArc]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)

    @model_validator(mode="after")
    def warn_lt_fail(self) -> "MatchDxfArcsBody":
        if self.tolerance_warn >= self.tolerance_fail:
            raise ValueError("tolerance_warn must be less than tolerance_fail")
        return self


def make_detection_router(frame_store: FrameStore) -> APIRouter:
    router = APIRouter()

    @router.post("/detect-edges")
    async def detect_edges_route(params: EdgeParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        png_bytes = detection.detect_edges(frame, params.threshold1, params.threshold2)
        return Response(content=png_bytes, media_type="image/png")

    @router.post("/detect-circles")
    async def detect_circles_route(params: CircleParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        circles = detection.detect_circles(
            frame, params.dp, params.min_dist, params.param1,
            params.param2, params.min_radius, params.max_radius
        )
        return circles

    @router.post("/detect-lines")
    async def detect_lines_route(params: LineParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        lines = detection.detect_lines(
            frame, params.threshold1, params.threshold2,
            params.hough_threshold, params.min_length, params.max_gap,
        )
        return lines

    @router.post("/detect-lines-merged")
    async def detect_lines_merged_route(params: DetectLinesParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        return detection.detect_lines_contour(
            frame, params.threshold1, params.threshold2,
            dp_epsilon=params.dp_epsilon, min_length_px=params.min_length,
            nms_dist_px=params.nms_dist, nms_angle_deg=params.nms_angle,
            smoothing=params.smoothing)

    @router.post("/detect-arcs-partial")
    async def detect_arcs_partial_route(params: DetectArcsParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        return detection.detect_partial_arcs(
            frame, params.threshold1, params.threshold2,
            min_radius=params.min_radius, max_radius=params.max_radius,
            min_span_deg=params.min_span_deg, residual_tol=params.residual_tol,
            smoothing=params.smoothing)

    @router.post("/preprocessed-view")
    async def preprocessed_view_route():
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        jpg_bytes = detection.preprocessed_view(frame)
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

    return router
