import asyncio
import datetime
import pathlib

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator

from .cameras.base import BaseCamera
from .config import load_config, save_config
from .frame_store import FrameStore
from .stream import mjpeg_generator, BOUNDARY
from .vision import detection
from .vision.alignment import extract_dxf_circles, align_circles

SNAPSHOTS_DIR = pathlib.Path(__file__).parent.parent / "snapshots"

_SUPPORTED_PIXEL_FORMATS = frozenset({"BayerRG8", "Mono8", "BGR8Packed", "RGB8Packed"})

_VALID_WB_CHANNELS = frozenset({"Red", "Green", "Blue"})
WB_RATIO_MIN = 0.5
WB_RATIO_MAX = 2.5


class ExposureBody(BaseModel):
    value: float


class GainBody(BaseModel):
    value: float


class PixelFormatBody(BaseModel):
    pixel_format: str


class WhiteBalanceRatioBody(BaseModel):
    channel: str
    value: float


class CameraSelectBody(BaseModel):
    camera_id: str = Field(..., min_length=1)


class LoadSnapshotBody(BaseModel):
    filename: str = Field(..., min_length=1, pattern=r'^[\w\-]+\.(jpg|jpeg|png)$')


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


class UiConfig(BaseModel):
    app_name: str = Field(min_length=1, max_length=100)
    theme: str = Field(max_length=50, pattern=r"^[a-z0-9-]+$")


class TolerancesConfig(BaseModel):
    tolerance_warn: float = Field(gt=0)
    tolerance_fail: float = Field(gt=0)

    @model_validator(mode="after")
    def warn_lt_fail(self):
        if self.tolerance_warn >= self.tolerance_fail:
            raise ValueError("tolerance_warn must be less than tolerance_fail")
        return self


class DetectedCircle(BaseModel):
    x: float
    y: float
    radius: float


class AlignDxfBody(BaseModel):
    entities: list[dict]
    circles: list[DetectedCircle]
    pixels_per_mm: float = Field(gt=0)


class DetectedLine(BaseModel):
    x1: float; y1: float; x2: float; y2: float; length: float


class DetectedArc(BaseModel):
    cx: float; cy: float; r: float; start_deg: float; end_deg: float


class DetectLinesParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 130


class DetectArcsParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 130
    min_span_deg: float = 45.0


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


router = APIRouter()


@router.get("/config/ui")
def get_ui_config():
    cfg = load_config()
    return {
        "app_name": cfg.get("app_name", "Microscope"),
        "theme":    cfg.get("theme",    "macos-dark"),
    }


@router.post("/config/ui")
def post_ui_config(body: UiConfig):
    save_config({"app_name": body.app_name, "theme": body.theme})
    return {"app_name": body.app_name, "theme": body.theme}


@router.get("/config/tolerances")
def get_tolerances():
    cfg = load_config()
    return {
        "tolerance_warn": cfg.get("tolerance_warn", 0.10),
        "tolerance_fail": cfg.get("tolerance_fail", 0.25),
    }


@router.post("/config/tolerances")
def post_tolerances(body: TolerancesConfig):
    save_config({"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail})
    return {"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail}


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


def make_router(camera: BaseCamera, frame_store: FrameStore, startup_warning: str | None = None) -> APIRouter:
    router = APIRouter()
    _warning = [startup_warning]   # mutable container for pop semantics

    @router.get("/camera/startup-warning")
    async def get_startup_warning():
        value = _warning[0]
        _warning[0] = None
        return {"warning": value}

    @router.get("/stream")
    async def stream():
        return StreamingResponse(
            mjpeg_generator(camera),
            media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}",
        )

    @router.post("/freeze")
    async def freeze():
        frame = camera.get_frame()
        frame_store.store(frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.get("/frame")
    async def get_frame():
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=404, detail="No frame stored")
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to encode frame")
        return Response(content=buf.tobytes(), media_type="image/jpeg")

    @router.post("/snapshot")
    async def snapshot():
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        frame = camera.get_frame()
        SNAPSHOTS_DIR.mkdir(exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{ts}.jpg"
        path = SNAPSHOTS_DIR / filename
        cv2.imwrite(str(path), frame)
        return {"filename": filename}

    @router.post("/load-image")
    async def load_image(file: UploadFile = File(...)):
        data = await file.read()
        arr = np.frombuffer(data, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="Cannot decode image")
        frame_store.store(frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.get("/snapshots")
    async def list_snapshots():
        if not SNAPSHOTS_DIR.exists():
            return []
        entries = []
        for p in sorted(SNAPSHOTS_DIR.glob("*.jpg"), key=lambda f: f.stat().st_mtime, reverse=True):
            entries.append({
                "filename": p.name,
                "size_kb": round(p.stat().st_size / 1024, 1),
                "timestamp": p.stem,
            })
        return entries

    @router.post("/load-snapshot")
    async def load_snapshot(body: LoadSnapshotBody):
        # Prevent path traversal: reject any filename containing a separator
        safe_name = pathlib.Path(body.filename).name
        if safe_name != body.filename:
            raise HTTPException(status_code=400, detail="Invalid filename")
        path = SNAPSHOTS_DIR / safe_name
        if not path.exists() or path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            raise HTTPException(status_code=404, detail="Snapshot not found")
        frame = cv2.imread(str(path))
        if frame is None:
            raise HTTPException(status_code=400, detail="Could not read image file")
        frame_store.store(frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

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
        return detection.detect_lines_contour(frame, params.threshold1, params.threshold2)

    @router.post("/detect-arcs-partial")
    async def detect_arcs_partial_route(params: DetectArcsParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        return detection.detect_partial_arcs(frame, params.threshold1, params.threshold2,
                                              min_span_deg=params.min_span_deg)

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

    @router.post("/preprocessed-view")
    async def preprocessed_view_route():
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        jpg_bytes = detection.preprocessed_view(frame)
        return Response(content=jpg_bytes, media_type="image/jpeg")

    @router.post("/load-dxf")
    async def load_dxf_route(file: UploadFile = File(...)):
        content = await file.read()
        try:
            from .vision.dxf_parser import parse_dxf
            entities = parse_dxf(content)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return entities

    @router.get("/camera/info")
    async def camera_info():
        info = camera.get_info()
        info["no_camera"] = camera.is_null
        return info

    @router.put("/camera/exposure")
    async def set_exposure(body: ExposureBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        camera.set_exposure(body.value)
        return {"ok": True}

    @router.put("/camera/gain")
    async def set_gain(body: GainBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        camera.set_gain(body.value)
        return {"ok": True}

    @router.put("/camera/pixel-format")
    async def set_pixel_format(body: PixelFormatBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        if body.pixel_format not in _SUPPORTED_PIXEL_FORMATS:
            raise HTTPException(status_code=400, detail=f"Unsupported format: {body.pixel_format}")
        camera.set_pixel_format(body.pixel_format)
        return {"ok": True}

    @router.post("/camera/white-balance/auto")
    async def auto_white_balance():
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        try:
            ratios = await asyncio.to_thread(camera.set_white_balance_auto)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        return ratios

    @router.put("/camera/white-balance/ratio")
    async def set_wb_ratio(body: WhiteBalanceRatioBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        if body.channel not in _VALID_WB_CHANNELS:
            raise HTTPException(status_code=400,
                detail=f"Invalid channel: {body.channel}")
        if not (WB_RATIO_MIN <= body.value <= WB_RATIO_MAX):
            raise HTTPException(status_code=400,
                detail=f"Value must be between {WB_RATIO_MIN} and {WB_RATIO_MAX}")
        try:
            camera.set_white_balance_ratio(body.channel, body.value)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True}

    @router.get("/cameras")
    async def list_cameras():
        if camera.is_null:
            return []
        from .cameras.aravis import list_aravis_cameras
        cameras = await asyncio.to_thread(list_aravis_cameras)
        if not cameras:
            # OpenCV fallback — return a single non-selectable entry
            cameras = [{"id": "opencv-0", "vendor": "OpenCV", "label": "OpenCV Camera"}]
        return cameras

    @router.post("/camera/select")
    async def select_camera(body: CameraSelectBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        if body.camera_id == "opencv-0":
            raise HTTPException(status_code=400,
                detail="Camera selection is not supported on the OpenCV fallback.")
        from .cameras.aravis import AravisCamera
        try:
            new_cam = AravisCamera(device_id=body.camera_id)
            await asyncio.to_thread(camera.switch_camera, new_cam)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        await asyncio.to_thread(save_config, {"camera_id": body.camera_id})
        return {"ok": True}

    return router
