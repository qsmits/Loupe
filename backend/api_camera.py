import asyncio
import datetime
import pathlib

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .config import save_config
from .frame_store import FrameStore
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


class CameraSelectBody(BaseModel):
    camera_id: str = Field(..., min_length=1)


class LoadSnapshotBody(BaseModel):
    filename: str = Field(..., min_length=1, pattern=r'^[\w\-]+\.(jpg|jpeg|png)$')


def make_camera_router(camera: BaseCamera, frame_store: FrameStore, startup_warning: str | None = None) -> APIRouter:
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
