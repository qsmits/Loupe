import pytest
from fastapi.testclient import TestClient

from tests.conftest import FakeCamera
from backend.session_store import SessionFrameStore
from backend.stream import CameraReader
from backend.api import make_router
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def _app_with_warning(warning: str | None):
    """Build a minimal FastAPI app that uses make_router with a specific startup_warning."""
    camera = FakeCamera()
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
    app.include_router(make_router(reader, frame_store, startup_warning=warning))
    return app


class TestStartupWarningEndpoint:

    def test_no_warning_returns_null(self):
        with TestClient(_app_with_warning(None)) as client:
            r = client.get("/camera/startup-warning")
        assert r.status_code == 200
        assert r.json() == {"warning": None}

    def test_warning_returned_on_first_call(self):
        msg = "Camera 'X' not found. Using 'Y'."
        with TestClient(_app_with_warning(msg)) as client:
            r = client.get("/camera/startup-warning")
        assert r.status_code == 200
        assert r.json() == {"warning": msg}

    def test_warning_cleared_after_first_call(self):
        """Pop semantics: second call returns null."""
        msg = "Camera 'X' not found. Using 'Y'."
        with TestClient(_app_with_warning(msg)) as client:
            r1 = client.get("/camera/startup-warning")
            r2 = client.get("/camera/startup-warning")
        assert r1.json() == {"warning": msg}
        assert r2.json() == {"warning": None}

    def test_existing_client_fixture_still_works(self, client):
        """The default client fixture (no warning) hits the endpoint without error."""
        r = client.get("/camera/startup-warning")
        assert r.status_code == 200
        assert r.json()["warning"] is None
