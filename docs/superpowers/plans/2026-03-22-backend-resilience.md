# Backend Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend survive a saved camera ID that is no longer available, and add config versioning.

**Architecture:** On startup, enumerate available Aravis cameras before opening; fall back gracefully with a warning passed to a new API endpoint. Config gains a version field with pass-through for unknown versions.

**Tech Stack:** Python, FastAPI, pytest

---

## Task 1 — Config versioning

**Files:** `backend/config.py`, `tests/test_config.py`

### Background

`_DEFAULTS` in `backend/config.py` currently only contains `{"camera_id": None}`. `load_config` merges the file contents over defaults, but does no version checking. We need to:

1. Add `"version": 1` to `_DEFAULTS` so every fresh config and every future write includes it.
2. Add a version check in `load_config`: v0 (no field) loads silently; v1 loads normally; v>1 logs a warning and passes all unknown keys through without stripping them.

### Steps

- [ ] **Read** `backend/config.py` to confirm current state before editing.

- [ ] **Write the failing tests** — append to `tests/test_config.py`:

```python
import logging


def test_config_defaults_include_version(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    result = load_config()
    assert result["version"] == 1


def test_config_save_writes_version(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    save_config({"camera_id": "Baumer-001"})
    on_disk = json.loads(path.read_text())
    assert on_disk["version"] == 1


def test_config_load_v0_no_warning(tmp_path, monkeypatch, caplog):
    """v0 file (no version field) loads silently with defaults filled in."""
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    path.write_text(json.dumps({"camera_id": "Baumer-001"}))
    with caplog.at_level(logging.WARNING, logger="backend.config"):
        result = load_config()
    assert result["version"] == 1
    assert result["camera_id"] == "Baumer-001"
    assert not caplog.records


def test_config_load_v1_loads_normally(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    path.write_text(json.dumps({"version": 1, "camera_id": "Baumer-001"}))
    result = load_config()
    assert result["version"] == 1
    assert result["camera_id"] == "Baumer-001"


def test_config_load_future_version_warns_and_passes_through(tmp_path, monkeypatch, caplog):
    """version > 1: log a warning, keep unknown keys, do not strip data."""
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    path.write_text(json.dumps({"version": 99, "camera_id": "Baumer-001", "new_field": "value"}))
    with caplog.at_level(logging.WARNING, logger="backend.config"):
        result = load_config()
    assert any("version" in r.message.lower() for r in caplog.records)
    assert result["version"] == 99
    assert result["new_field"] == "value"
    assert result["camera_id"] == "Baumer-001"
```

- [ ] **Run the new tests** to confirm they fail:

```
cd /Users/qsmits/Projects/MainDynamics/microscope && python -m pytest tests/test_config.py -v
```

- [ ] **Implement** — edit `backend/config.py`:

```python
import json
import logging
import pathlib

log = logging.getLogger(__name__)

CONFIG_PATH = pathlib.Path(__file__).parent.parent / "config.json"
_DEFAULTS = {"camera_id": None, "version": 1}


def load_config() -> dict:
    """Return config dict. Missing keys fall back to defaults. File missing → all defaults."""
    if not CONFIG_PATH.exists():
        return dict(_DEFAULTS)
    try:
        data = json.loads(CONFIG_PATH.read_text())
        version = data.get("version")
        if version is None:
            # v0 file — silent upgrade on next write; fill in defaults for missing keys
            return {**_DEFAULTS, **data}
        if version == 1:
            return {**_DEFAULTS, **data}
        # version > 1: unknown future format — warn and pass through all keys
        log.warning(
            "config.json has version %s which is newer than this software (version 1). "
            "Unknown fields will be preserved.",
            version,
        )
        return {**_DEFAULTS, **data}
    except Exception:
        return dict(_DEFAULTS)


def save_config(data: dict) -> None:
    """Merge data into existing config and write atomically via a temp file."""
    current = load_config()
    current.update(data)
    tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
    tmp.write_text(json.dumps(current, indent=2))
    tmp.replace(CONFIG_PATH)
```

- [ ] **Run all config tests** to confirm they pass:

```
cd /Users/qsmits/Projects/MainDynamics/microscope && python -m pytest tests/test_config.py -v
```

  Expected: all tests green, including the three pre-existing ones. The existing `test_config_load_defaults_when_missing` will need its assertion updated to reflect the new default:

  **Update** `test_config_load_defaults_when_missing` in `tests/test_config.py`:

  Change:
  ```python
  assert result == {"camera_id": None}
  ```
  To:
  ```python
  assert result == {"camera_id": None, "version": 1}
  ```

- [ ] **Manual verification:** Start the server, confirm `config.json` contains `"version": 1` after any camera selection. Also confirm that manually editing `config.json` to `"version": 99` and restarting produces a warning log line without crashing.

---

## Task 2 — Camera startup fallback

**Files:** `backend/main.py`, `tests/test_main.py` (new file)

### Background

`create_app` currently passes `cfg.get("camera_id")` directly to `AravisCamera`. If that device is absent, Aravis raises inside `lifespan.open()` and crashes the server. We need a decision tree that:

1. Skips the check entirely when `ARAVIS_AVAILABLE` is `False` (unchanged path).
2. Skips the check when `camera_id` is `None` (first run — open whatever is first, no warning).
3. When `camera_id` is set: enumerate available cameras; use the saved one if present; fall back to the first available Aravis camera with a warning; fall back to OpenCV if no Aravis cameras are found, with a different warning.

The produced `startup_warning` string (or `None`) is passed into `make_router` as a new parameter.

### Steps

- [ ] **Read** `backend/main.py` to confirm current state before editing.

- [ ] **Write the failing tests** — create `tests/test_main.py`:

```python
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from tests.conftest import FakeCamera
from backend.main import create_app


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_client(camera, startup_warning=None):
    """Build a TestClient from create_app, injecting camera + warning directly."""
    from backend.frame_store import FrameStore
    from backend.stream import CameraReader
    from backend.api import make_router
    from contextlib import asynccontextmanager
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    frame_store = FrameStore()
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

        real_make_router = __import__("backend.api", fromlist=["make_router"]).make_router

        def capturing_make_router(reader, frame_store, startup_warning=None):
            captured["warning"] = startup_warning
            return real_make_router(reader, frame_store, startup_warning=startup_warning)

        monkeypatch.setattr("backend.main.make_router", capturing_make_router)

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
        real_make_router = __import__("backend.api", fromlist=["make_router"]).make_router

        def capturing_make_router(reader, frame_store, startup_warning=None):
            captured["warning"] = startup_warning
            return real_make_router(reader, frame_store, startup_warning=startup_warning)

        monkeypatch.setattr("backend.main.make_router", capturing_make_router)

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
        real_make_router = __import__("backend.api", fromlist=["make_router"]).make_router

        def capturing_make_router(reader, frame_store, startup_warning=None):
            captured["warning"] = startup_warning
            return real_make_router(reader, frame_store, startup_warning=startup_warning)

        monkeypatch.setattr("backend.main.make_router", capturing_make_router)
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
        real_make_router = __import__("backend.api", fromlist=["make_router"]).make_router

        def capturing_make_router(reader, frame_store, startup_warning=None):
            captured["warning"] = startup_warning
            return real_make_router(reader, frame_store, startup_warning=startup_warning)

        monkeypatch.setattr("backend.main.make_router", capturing_make_router)
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
        real_make_router = __import__("backend.api", fromlist=["make_router"]).make_router

        def capturing_make_router(reader, frame_store, startup_warning=None):
            captured["warning"] = startup_warning
            return real_make_router(reader, frame_store, startup_warning=startup_warning)

        monkeypatch.setattr("backend.main.make_router", capturing_make_router)
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
        real_make_router = __import__("backend.api", fromlist=["make_router"]).make_router

        def capturing_make_router(reader, frame_store, startup_warning=None):
            captured["warning"] = startup_warning
            return real_make_router(reader, frame_store, startup_warning=startup_warning)

        monkeypatch.setattr("backend.main.make_router", capturing_make_router)
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
```

- [ ] **Run** the new tests to confirm they fail:

```
cd /Users/qsmits/Projects/MainDynamics/microscope && python -m pytest tests/test_main.py -v
```

- [ ] **Implement** — replace the `create_app` function in `backend/main.py`. Also add `list_aravis_cameras` to the imports so it is patchable at the `backend.main` module level:

```python
import logging
import pathlib
from contextlib import asynccontextmanager

log = logging.getLogger(__name__)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .cameras.base import BaseCamera
from .cameras.aravis import AravisCamera, ARAVIS_AVAILABLE, list_aravis_cameras
from .cameras.opencv import OpenCVCamera
from .frame_store import FrameStore
from .stream import CameraReader
from .api import make_router

FRONTEND_DIR = pathlib.Path(__file__).parent.parent / "frontend"


def create_app(camera: BaseCamera | None = None) -> FastAPI:
    frame_store = FrameStore()
    startup_warning: str | None = None

    if camera is None:
        from .config import load_config
        cfg = load_config()
        camera_id = cfg.get("camera_id")

        if not ARAVIS_AVAILABLE:
            log.warning("Aravis not found — falling back to OpenCV camera (index 1)")
            camera = OpenCVCamera(index=1)
        elif camera_id is None:
            # First run or no saved preference — open first available; no warning
            camera = AravisCamera(device_id=None)
        else:
            try:
                available = list_aravis_cameras()
            except Exception:
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
        reader.open()   # opens underlying camera + starts reader thread
        try:
            yield
        finally:
            reader.close()  # stops thread + closes underlying camera

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
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=False)
```

- [ ] **Run** the new tests to confirm they pass:

```
cd /Users/qsmits/Projects/MainDynamics/microscope && python -m pytest tests/test_main.py -v
```

- [ ] **Manual verification:** Start the server with `config.json` containing a non-existent `camera_id`. Confirm the server starts (no crash) and a warning appears in the log. Confirm the server also starts normally when `config.json` has a valid or absent `camera_id`.

---

## Task 3 — Startup warning API endpoint

**Files:** `backend/api.py`, `tests/test_api_warning.py` (new file)

### Background

`make_router` needs a new `startup_warning: str | None = None` parameter. The endpoint `GET /camera/startup-warning` returns `{"warning": <value>}`. After the first call it clears the value (pop semantics) using a mutable list as a closure variable, so subsequent calls return `{"warning": null}`.

### Steps

- [ ] **Read** `backend/api.py` to confirm current state before editing.

- [ ] **Write the failing tests** — create `tests/test_api_warning.py`:

```python
import pytest
from fastapi.testclient import TestClient

from tests.conftest import FakeCamera
from backend.main import create_app
from backend.frame_store import FrameStore
from backend.stream import CameraReader
from backend.api import make_router
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def _app_with_warning(warning: str | None):
    """Build a minimal FastAPI app that uses make_router with a specific startup_warning."""
    camera = FakeCamera()
    frame_store = FrameStore()
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
```

- [ ] **Run** the new tests to confirm they fail:

```
cd /Users/qsmits/Projects/MainDynamics/microscope && python -m pytest tests/test_api_warning.py -v
```

- [ ] **Implement** — edit `backend/api.py`. Change the `make_router` signature and add the new endpoint. Only two changes are needed:

  1. Update the function signature:
     ```python
     # Before:
     def make_router(camera: BaseCamera, frame_store: FrameStore) -> APIRouter:
     # After:
     def make_router(camera: BaseCamera, frame_store: FrameStore, startup_warning: str | None = None) -> APIRouter:
     ```

  2. Add the new endpoint immediately after `router = APIRouter()`:
     ```python
     _warning = [startup_warning]   # mutable container for pop semantics

     @router.get("/camera/startup-warning")
     async def get_startup_warning():
         value = _warning[0]
         _warning[0] = None
         return {"warning": value}
     ```

  The full updated top of `make_router` after both changes:

  ```python
  def make_router(
      camera: BaseCamera,
      frame_store: FrameStore,
      startup_warning: str | None = None,
  ) -> APIRouter:
      router = APIRouter()
      _warning = [startup_warning]   # mutable container for pop semantics

      @router.get("/camera/startup-warning")
      async def get_startup_warning():
          value = _warning[0]
          _warning[0] = None
          return {"warning": value}

      @router.get("/stream")
      # ... rest of router unchanged
  ```

- [ ] **Run** all tests to confirm no regressions:

```
cd /Users/qsmits/Projects/MainDynamics/microscope && python -m pytest tests/test_config.py tests/test_api_warning.py -v
```

- [ ] **Manual verification:** Start the server with a missing `camera_id` in config. Open a browser to `http://localhost:8000/camera/startup-warning` — the warning message appears. Refresh — it returns `{"warning": null}`. Restart the server with a valid/absent `camera_id` — first call also returns `{"warning": null}`.

---

## Task 4 — Frontend warning display

**Files:** `frontend/app.js`

### Background

After the initial `loadCameraInfo()` call on page load succeeds, we fetch `/camera/startup-warning`. If the returned `warning` is non-null, we display it in the `#status-line` element for 8 seconds then revert to the normal "Live" or "Frozen" status text. No persistent UI changes.

`statusEl` is already defined as `document.getElementById("status-line")` near the top of `app.js`.

### Steps

- [ ] **Read** the relevant section of `frontend/app.js` — specifically the `// ── Init ───` block around line 1193 and the `loadCameraInfo` function around line 662.

- [ ] **Implement** — add a new async function `checkStartupWarning` immediately after `loadCameraInfo` (around line 690, before the camera-list functions), then call it in the init block after `loadCameraInfo()`:

  Add this function after the closing `}` of `loadCameraInfo`:

  ```javascript
  // ── Startup warning ────────────────────────────────────────────────────────
  async function checkStartupWarning() {
    try {
      const r = await fetch("/camera/startup-warning");
      const d = await r.json();
      if (d.warning) {
        const prev = { text: statusEl.textContent, className: statusEl.className };
        statusEl.textContent = d.warning;
        statusEl.className = "status-line warning";
        setTimeout(() => {
          statusEl.textContent = prev.text;
          statusEl.className = prev.className;
        }, 8000);
      }
    } catch (_) {
      // Non-fatal: silently ignore network or parse errors
    }
  }
  ```

  Update the init block (around line 1193):

  ```javascript
  // ── Init ───────────────────────────────────────────────────────────────────
  loadCameraInfo();
  checkStartupWarning();
  resizeCanvas();
  ```

  Note: `checkStartupWarning()` is called after `loadCameraInfo()` but does not need to `await` it — both are fire-and-forget at init time, matching the existing pattern for `loadCameraInfo()`.

- [ ] **Manual verification steps:**

  1. Edit `config.json` to set `"camera_id"` to a device ID that does not exist on the current machine (e.g. `"Baumer-GHOST-999"`).
  2. Start (or restart) the backend server.
  3. Open `http://localhost:8000` in a browser.
  4. Confirm the `#status-line` element briefly shows the warning text (e.g. "Camera 'Baumer-GHOST-999' not found and no cameras available. Using OpenCV fallback.") in place of "Live".
  5. Confirm after 8 seconds the status line reverts to "Live" (or "Frozen" if a frame was frozen during that time).
  6. Confirm that refreshing the page does NOT show the warning again (pop semantics confirmed end-to-end).
  7. Restore `config.json` to a valid or absent `camera_id` and confirm the status line shows "Live" immediately with no warning.

---

## Full test run

After all tasks are complete, run the full test suite to confirm no regressions:

```
cd /Users/qsmits/Projects/MainDynamics/microscope && python -m pytest tests/test_config.py tests/test_main.py tests/test_api_warning.py -v
```
