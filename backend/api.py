from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from .cameras.base import BaseCamera
from .config import load_config, save_config
from .session_store import SessionFrameStore
from .api_camera import make_camera_router
from .api_compare import make_compare_router
from .api_deflectometry import make_deflectometry_router
from .api_detection import make_detection_router
from .api_inspection import make_inspection_router, router as inspection_router
from .api_runs import make_runs_router
from .api_stitch import make_stitch_router
from .api_superres import make_superres_router
from .api_zstack import make_zstack_router
from .run_store import RunStore


class UiConfig(BaseModel):
    theme: str = Field(max_length=50, pattern=r"^[a-z0-9-]+$")
    subpixel_method: str = Field(default="parabola")


class TolerancesConfig(BaseModel):
    tolerance_warn: float = Field(gt=0)
    tolerance_fail: float = Field(gt=0)

    @model_validator(mode="after")
    def warn_lt_fail(self):
        if self.tolerance_warn >= self.tolerance_fail:
            raise ValueError("tolerance_warn must be less than tolerance_fail")
        return self


router = APIRouter()


@router.get("/config/ui")
def get_ui_config(request: Request):
    cfg = load_config()
    return {
        "theme":           cfg.get("theme",    "macos-dark"),
        "subpixel_method": cfg.get("subpixel_method", "parabola"),
        "hosted":          getattr(request.app.state, "hosted", False),
    }


@router.post("/config/ui")
def post_ui_config(body: UiConfig, request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Read-only in hosted mode")
    save_config({"theme": body.theme, "subpixel_method": body.subpixel_method})
    return {"theme": body.theme, "subpixel_method": body.subpixel_method}


@router.get("/config/tolerances")
def get_tolerances():
    cfg = load_config()
    return {
        "tolerance_warn": cfg.get("tolerance_warn", 0.10),
        "tolerance_fail": cfg.get("tolerance_fail", 0.25),
    }


@router.post("/config/tolerances")
def post_tolerances(body: TolerancesConfig, request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Read-only in hosted mode")
    save_config({"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail})
    return {"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail}


# Include the module-level inspection routes (align-dxf, export-dxf)
router.include_router(inspection_router)


def make_router(camera: BaseCamera, frame_store: SessionFrameStore, startup_warning: str | None = None, run_store: RunStore | None = None) -> APIRouter:
    composed = APIRouter()
    composed.include_router(make_camera_router(camera, frame_store, startup_warning))
    composed.include_router(make_compare_router(camera))
    composed.include_router(make_detection_router(frame_store))
    composed.include_router(make_inspection_router(frame_store))
    composed.include_router(make_zstack_router(camera))
    composed.include_router(make_stitch_router(camera))
    composed.include_router(make_superres_router(camera))
    composed.include_router(make_deflectometry_router(camera))
    if run_store:
        composed.include_router(make_runs_router(run_store))
    return composed
