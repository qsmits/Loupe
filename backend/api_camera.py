import asyncio
import datetime
import pathlib
import uuid

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .config import save_config
from .session_store import safe_error_detail
from .session_store import SessionFrameStore, get_session_id_dep
from .stream import mjpeg_generator, BOUNDARY

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


class GammaBody(BaseModel):
    value: float = Field(ge=0.1, le=4.0)


class RoiBody(BaseModel):
    offset_x: int = Field(ge=0)
    offset_y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class CameraSelectBody(BaseModel):
    camera_id: str = Field(..., min_length=1)


class LoadSnapshotBody(BaseModel):
    filename: str = Field(..., min_length=1, pattern=r'^[\w\-]+\.(jpg|jpeg|png)$')


MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


def make_camera_router(camera: BaseCamera, frame_store: SessionFrameStore, startup_warning: str | None = None) -> APIRouter:
    router = APIRouter()
    _warning = [startup_warning]   # mutable container for pop semantics

    @router.post("/session/new")
    async def create_session():
        """Issue a server-generated session token."""
        return {"session_id": str(uuid.uuid4())}

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
    async def freeze(session_id: str = Depends(get_session_id_dep)):
        frame = camera.get_frame()
        frame_store.store(session_id, frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.get("/frame")
    async def get_frame(session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=404, detail="No frame stored")
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to encode frame")
        return Response(content=buf.tobytes(), media_type="image/jpeg")

    @router.post("/snapshot")
    async def snapshot(request: Request):
        if getattr(request.app.state, "hosted", False):
            raise HTTPException(403, detail="Not allowed in hosted mode")
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
    async def load_image(session_id: str = Depends(get_session_id_dep), file: UploadFile = File(...)):
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image too large (max 20 MB)")
        arr = np.frombuffer(data, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="Cannot decode image")
        frame_store.store(session_id, frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.post("/update-frame")
    async def update_frame(session_id: str = Depends(get_session_id_dep), file: UploadFile = File(...)):
        """Replace the stored frame with a browser-corrected image (lens/perspective correction)."""
        if frame_store.get(session_id) is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image too large (max 20 MB)")
        arr = np.frombuffer(data, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="Cannot decode image")
        frame_store.store(session_id, frame)
        return {"ok": True}

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
    async def load_snapshot(body: LoadSnapshotBody, request: Request, session_id: str = Depends(get_session_id_dep)):
        if getattr(request.app.state, "hosted", False):
            raise HTTPException(403, detail="Not allowed in hosted mode")
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
        frame_store.store(session_id, frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

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
    async def auto_white_balance(request: Request):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        try:
            ratios = await asyncio.to_thread(camera.set_white_balance_auto)
        except Exception as e:
            raise HTTPException(400, detail=safe_error_detail(request, e, "White balance failed"))
        return ratios

    @router.put("/camera/white-balance/ratio")
    async def set_wb_ratio(body: WhiteBalanceRatioBody, request: Request):
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
            raise HTTPException(400, detail=safe_error_detail(request, e, "White balance ratio failed"))
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
    async def select_camera(body: CameraSelectBody, request: Request):
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
            raise HTTPException(400, detail=safe_error_detail(request, e, "Camera switch failed"))
        await asyncio.to_thread(save_config, {"camera_id": body.camera_id})
        return {"ok": True}

    @router.put("/camera/gamma")
    async def set_gamma(body: GammaBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        await asyncio.to_thread(camera.set_gamma, body.value)
        return {"ok": True}

    @router.post("/camera/auto-exposure")
    async def auto_exposure():
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        exposure = await asyncio.to_thread(camera.set_auto_exposure)
        return {"exposure": exposure}

    @router.put("/camera/roi")
    async def set_roi(body: RoiBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        # Snap to valid increments
        info = camera.get_info()
        w_inc = info.get("roi_width_inc", 4)
        h_inc = info.get("roi_height_inc", 4)
        width = max(w_inc, round(body.width / w_inc) * w_inc)
        height = max(h_inc, round(body.height / h_inc) * h_inc)
        offset_x = round(body.offset_x / w_inc) * w_inc
        offset_y = round(body.offset_y / h_inc) * h_inc
        sw = info.get("sensor_width", info["width"])
        sh = info.get("sensor_height", info["height"])
        offset_x = min(offset_x, max(0, sw - width))
        offset_y = min(offset_y, max(0, sh - height))
        await asyncio.to_thread(camera.set_roi, offset_x, offset_y, width, height)
        return {"offset_x": offset_x, "offset_y": offset_y, "width": width, "height": height}

    @router.post("/camera/roi/reset")
    async def reset_roi():
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        await asyncio.to_thread(camera.reset_roi)
        return {"ok": True}

    @router.delete("/session")
    async def delete_session(session_id: str = Depends(get_session_id_dep)):
        frame_store.clear(session_id)
        return {"ok": True}

    return router
