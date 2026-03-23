import logging
import os
import pathlib
from contextlib import asynccontextmanager

log = logging.getLogger(__name__)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .cameras.base import BaseCamera
from .cameras.aravis import AravisCamera, ARAVIS_AVAILABLE, list_aravis_cameras
from .cameras.null import NullCamera
from .cameras.opencv import OpenCVCamera
from .frame_store import FrameStore
from .stream import CameraReader
from .api import make_router

FRONTEND_DIR = pathlib.Path(__file__).parent.parent / "frontend"


def create_app(camera: BaseCamera | None = None, no_camera: bool = False) -> FastAPI:
    frame_store = FrameStore()
    startup_warning: str | None = None

    # Determine whether to run in no-camera mode
    _no_camera = (
        no_camera
        or os.environ.get("NO_CAMERA", "").lower() in ("1", "true", "yes")
    )

    if camera is None:
        from .config import load_config
        cfg = load_config()
        _no_camera = _no_camera or cfg.get("no_camera", False)
    else:
        cfg = {}

    if _no_camera:
        camera = NullCamera()
    elif camera is None:
        camera_id = cfg.get("camera_id")

        if not ARAVIS_AVAILABLE:
            log.warning("Aravis not found — falling back to OpenCV camera (index 1)")
            camera = OpenCVCamera(index=1)
        elif camera_id is None:
            camera = AravisCamera(device_id=None)
        else:
            try:
                available = list_aravis_cameras()
            except Exception as e:
                log.warning("Failed to enumerate Aravis cameras: %s. Treating as no cameras available.", e)
                available = []
            ids = [c["id"] for c in available]
            if camera_id in ids:
                camera = AravisCamera(device_id=camera_id)
            elif available:
                fallback_id = available[0]["id"]
                startup_warning = f"Camera '{camera_id}' not found. Using '{fallback_id}'."
                log.warning(startup_warning)
                camera = AravisCamera(device_id=fallback_id)
            else:
                startup_warning = (
                    f"Camera '{camera_id}' not found and no cameras available. "
                    "Using OpenCV fallback."
                )
                log.warning(startup_warning)
                camera = OpenCVCamera(index=1)

    reader = CameraReader(camera)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            reader.open()
        except Exception as e:
            log.warning("Camera failed to open: %s — falling back to no-camera mode.", e)
            # reader.open() raised inside _camera.open(), before the background
            # thread was started. _thread is None, no lock is needed.
            reader._camera = NullCamera()
            reader.open()
        try:
            yield
        finally:
            reader.close()

    app = FastAPI(title="Video Microscope", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(make_router(reader, frame_store, startup_warning=startup_warning))

    if FRONTEND_DIR.exists():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:create_app", host="0.0.0.0", port=8000,
                reload=False, factory=True)
