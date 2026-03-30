import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from tests.conftest import FakeCamera
from backend.main import create_app


# ── helpers ──────────────────────────────────────────────────────────────────

def _capturing_make_router(captured: dict):
    """Return a make_router wrapper that captures the startup_warning in `captured`."""
    from backend.api import make_router as real_make_router

    def wrapper(reader, frame_store, startup_warning=None, run_store=None):
        captured["warning"] = startup_warning
        return real_make_router(reader, frame_store, startup_warning=startup_warning, run_store=run_store)

    return wrapper


def _make_client(camera, startup_warning=None):
    """Build a TestClient from create_app, injecting camera + warning directly."""
    from backend.session_store import SessionFrameStore
    from backend.stream import CameraReader
    from backend.api import make_router
    from contextlib import asynccontextmanager
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    frame_store = SessionFrameStore()
    reader = CameraReader(camera)

    @asynccontextmanager
    async def lifespan(app):
        reader.open()
        try:
            yield
        finally:
            reader.close()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])
    app.include_router(make_router(reader, frame_store,
                                   startup_warning=startup_warning))
    return TestClient(app)


# ── startup fallback logic ────────────────────────────────────────────────────

class TestStartupFallback:
    """
    Test the camera-selection logic inside create_app.
    We patch at the module level used by main.py.
    """

    def test_no_aravis_uses_opencv_no_warning(self, tmp_path, monkeypatch):
        """When ARAVIS_AVAILABLE is False the OpenCV path is taken without a warning."""
        monkeypatch.setattr("backend.main.ARAVIS_AVAILABLE", False)
        monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")

        captured = {}
        monkeypatch.setattr("backend.main.make_router", _capturing_make_router(captured))

        fake_opencv = FakeCamera()
        monkeypatch.setattr("backend.main.OpenCVCamera", lambda index: fake_opencv)

        app = create_app()
        with TestClient(app):
            pass

        assert captured["warning"] is None

    def test_camera_id_none_uses_aravis_no_warning(self, tmp_path, monkeypatch):
        """camera_id=None → open first available Aravis camera; no warning."""
        monkeypatch.setattr("backend.main.ARAVIS_AVAILABLE", True)
        monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")

        captured = {}
        monkeypatch.setattr("backend.main.make_router", _capturing_make_router(captured))

        fake_aravis = FakeCamera()
        monkeypatch.setattr("backend.main.AravisCamera",
                            lambda device_id=None: fake_aravis)

        app = create_app()
        with TestClient(app):
            pass

        assert captured["warning"] is None

    def test_saved_camera_present_no_warning(self, tmp_path, monkeypatch):
        """Saved camera_id is in the available list → open it; no warning."""
        monkeypatch.setattr("backend.main.ARAVIS_AVAILABLE", True)
        path = tmp_path / "config.json"
        monkeypatch.setattr("backend.config.CONFIG_PATH", path)
        import json
        path.write_text(json.dumps({"camera_id": "Baumer-001", "version": 1}))

        captured = {}
        monkeypatch.setattr("backend.main.make_router", _capturing_make_router(captured))
        monkeypatch.setattr(
            "backend.main.list_aravis_cameras",
            lambda: [{"id": "Baumer-001", "vendor": "Baumer", "label": "Baumer — Baumer-001"}],
        )

        fake_aravis = FakeCamera()
        monkeypatch.setattr("backend.main.AravisCamera",
                            lambda device_id=None: fake_aravis)

        app = create_app()
        with TestClient(app):
            pass

        assert captured["warning"] is None

    def test_saved_camera_missing_fallback_to_other_aravis(self, tmp_path, monkeypatch):
        """Saved camera not in list but another Aravis camera is → use it with warning."""
        monkeypatch.setattr("backend.main.ARAVIS_AVAILABLE", True)
        path = tmp_path / "config.json"
        monkeypatch.setattr("backend.config.CONFIG_PATH", path)
        import json
        path.write_text(json.dumps({"camera_id": "Baumer-OLD", "version": 1}))

        captured = {}
        monkeypatch.setattr("backend.main.make_router", _capturing_make_router(captured))
        monkeypatch.setattr(
            "backend.main.list_aravis_cameras",
            lambda: [{"id": "Baumer-NEW", "vendor": "Baumer", "label": "Baumer — Baumer-NEW"}],
        )

        fake_aravis = FakeCamera()
        monkeypatch.setattr("backend.main.AravisCamera",
                            lambda device_id=None: fake_aravis)

        app = create_app()
        with TestClient(app):
            pass

        assert captured["warning"] == "Camera 'Baumer-OLD' not found. Using 'Baumer-NEW'."

    def test_saved_camera_missing_no_aravis_fallback_to_opencv(self, tmp_path, monkeypatch):
        """Saved camera not found and no Aravis cameras at all → OpenCV with warning."""
        monkeypatch.setattr("backend.main.ARAVIS_AVAILABLE", True)
        path = tmp_path / "config.json"
        monkeypatch.setattr("backend.config.CONFIG_PATH", path)
        import json
        path.write_text(json.dumps({"camera_id": "Baumer-OLD", "version": 1}))

        captured = {}
        monkeypatch.setattr("backend.main.make_router", _capturing_make_router(captured))
        monkeypatch.setattr("backend.main.list_aravis_cameras", lambda: [])

        fake_opencv = FakeCamera()
        monkeypatch.setattr("backend.main.OpenCVCamera", lambda index: fake_opencv)

        app = create_app()
        with TestClient(app):
            pass

        assert captured["warning"] == (
            "Camera 'Baumer-OLD' not found and no cameras available. Using OpenCV fallback."
        )

    def test_list_aravis_cameras_raises_treated_as_empty(self, tmp_path, monkeypatch):
        """If list_aravis_cameras() raises, treat as no cameras → OpenCV fallback."""
        monkeypatch.setattr("backend.main.ARAVIS_AVAILABLE", True)
        path = tmp_path / "config.json"
        monkeypatch.setattr("backend.config.CONFIG_PATH", path)
        import json
        path.write_text(json.dumps({"camera_id": "Baumer-OLD", "version": 1}))

        captured = {}
        monkeypatch.setattr("backend.main.make_router", _capturing_make_router(captured))
        monkeypatch.setattr(
            "backend.main.list_aravis_cameras",
            lambda: (_ for _ in ()).throw(RuntimeError("Aravis bus error")),
        )

        fake_opencv = FakeCamera()
        monkeypatch.setattr("backend.main.OpenCVCamera", lambda index: fake_opencv)

        app = create_app()
        with TestClient(app):
            pass

        assert "not found and no cameras available" in captured["warning"]


# ── no-camera mode ────────────────────────────────────────────────────────────

import os
from backend.cameras.null import NullCamera


class TestNoCameraMode:

    def test_no_camera_param_uses_null_camera(self, tmp_path, monkeypatch):
        """create_app(no_camera=True) uses NullCamera regardless of hardware."""
        monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
        app = create_app(no_camera=True)
        with TestClient(app) as c:
            r = c.get("/camera/info")
        assert r.status_code == 200
        assert r.json()["no_camera"] is True

    def test_no_camera_env_var_uses_null_camera(self, tmp_path, monkeypatch):
        """NO_CAMERA env var causes NullCamera to be used."""
        monkeypatch.setenv("NO_CAMERA", "1")
        monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
        app = create_app()
        with TestClient(app) as c:
            r = c.get("/camera/info")
        assert r.json()["no_camera"] is True

    def test_no_camera_config_key_uses_null_camera(self, tmp_path, monkeypatch):
        """config no_camera=True causes NullCamera to be used."""
        import json
        path = tmp_path / "config.json"
        path.write_text(json.dumps({"no_camera": True, "version": 1}))
        monkeypatch.setattr("backend.config.CONFIG_PATH", path)
        app = create_app()
        with TestClient(app) as c:
            r = c.get("/camera/info")
        assert r.json()["no_camera"] is True

    def test_camera_open_failure_falls_back_to_null(self, tmp_path, monkeypatch):
        """If the resolved camera fails to open, app falls back to NullCamera."""
        monkeypatch.setattr("backend.main.ARAVIS_AVAILABLE", False)
        monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")

        class FailingCamera(FakeCamera):
            def open(self):
                raise RuntimeError("No hardware")

        monkeypatch.setattr("backend.main.OpenCVCamera", lambda index: FailingCamera())
        app = create_app()
        with TestClient(app) as c:
            r = c.get("/camera/info")
        assert r.json()["no_camera"] is True

    def test_no_camera_param_overrides_injected_camera(self, tmp_path, monkeypatch):
        """no_camera=True takes precedence over an injected camera param."""
        monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
        app = create_app(camera=FakeCamera(), no_camera=True)
        with TestClient(app) as c:
            r = c.get("/camera/info")
        assert r.json()["no_camera"] is True
