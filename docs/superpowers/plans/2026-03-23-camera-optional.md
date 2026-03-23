# Camera-Optional Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the app to start and be fully usable for image measurement when no camera hardware is present, with silent auto-detect fallback and a drag-and-drop image overlay.

**Architecture:** Backend adds a `NullCamera` class (no-op open/close, gray blank frames). `create_app()` checks for no-camera mode via param, env var, or config key, and wraps `reader.open()` in a try/except fallback. Frontend reads `no_camera` from `/camera/info`, hides camera controls, and shows a drag-and-drop overlay when no image is loaded.

**Tech Stack:** Python/FastAPI, pytest, Vanilla JS, HTML5 Canvas.

---

## File Structure

| File | Change |
|---|---|
| `backend/cameras/null.py` | **New** — `NullCamera` class |
| `backend/cameras/base.py` | Add `@property is_null → False` |
| `backend/stream.py` | Add delegating `@property is_null` to `CameraReader` |
| `backend/config.py` | Add `"no_camera": False` to `_DEFAULTS` |
| `backend/main.py` | `create_app(no_camera=False)` param; env var + config check; try/except fallback on `reader.open()` |
| `backend/api.py` | Inject `no_camera` in `/camera/info`; `[]` return for `/cameras`; 503 guards on 7 endpoints |
| `tests/test_cameras.py` | Add `NullCamera` unit tests |
| `tests/test_null_camera_api.py` | **New** — API-level tests for no-camera mode |
| `tests/test_main.py` | Add tests for new `create_app` no-camera paths |
| `frontend/index.html` | Add `#drop-overlay` div inside `#viewer` |
| `frontend/style.css` | `body.no-camera` hide rules; `#drop-overlay` styles |
| `frontend/app.js` | `_noCamera` flag; detection in `loadCameraInfo()`; overlay visibility; drag-and-drop |

---

## Task 1 — NullCamera class + BaseCamera `is_null` property

**Files:**
- Modify: `backend/cameras/base.py`
- Create: `backend/cameras/null.py`
- Modify: `tests/test_cameras.py`

- [ ] **Step 1: Write failing tests for `NullCamera` and `is_null`**

Add to `tests/test_cameras.py`:

```python
from backend.cameras.null import NullCamera


def test_null_camera_is_null():
    assert NullCamera().is_null is True


def test_base_camera_is_null_false():
    # FakeCamera (defined in this file) is a concrete BaseCamera — must return False
    class MinimalFake(BaseCamera):
        def open(self): pass
        def close(self): pass
        def get_frame(self): return np.zeros((480, 640, 3), dtype=np.uint8)
        def set_exposure(self, us): pass
        def set_gain(self, db): pass
        def get_info(self): return {}
        def set_pixel_format(self, fmt): pass
        def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_ratio(self, channel, value): pass
    assert MinimalFake().is_null is False


def test_null_camera_open_close_noop():
    cam = NullCamera()
    cam.open()   # must not raise
    cam.close()  # must not raise


def test_null_camera_get_frame_returns_gray_blank():
    cam = NullCamera()
    frame = cam.get_frame()
    assert frame.shape == (480, 640, 3)
    assert frame.dtype == np.uint8
    assert int(frame[0, 0, 0]) == 80  # gray value


def test_null_camera_get_info_returns_dict_with_no_camera_flag():
    info = NullCamera().get_info()
    assert info["no_camera"] is True
    assert "model" in info


def test_null_camera_control_methods_raise():
    cam = NullCamera()
    with pytest.raises(NotImplementedError):
        cam.set_exposure(1000)
    with pytest.raises(NotImplementedError):
        cam.set_gain(0)
    with pytest.raises(NotImplementedError):
        cam.set_pixel_format("Mono8")
    with pytest.raises(NotImplementedError):
        cam.get_white_balance()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/qsmits/Projects/MainDynamics/microscope
.venv/bin/pytest tests/test_cameras.py::test_null_camera_is_null -v
```

Expected: `ModuleNotFoundError` or `ImportError` (null.py doesn't exist yet).

- [ ] **Step 3: Add `is_null` property to `BaseCamera`**

In `backend/cameras/base.py`, add after the last `@abstractmethod` block (before the closing of the class):

```python
    @property
    def is_null(self) -> bool:
        """Return True if this is a NullCamera (no hardware). Default False."""
        return False
```

- [ ] **Step 4: Create `backend/cameras/null.py`**

```python
import numpy as np
from .base import BaseCamera


class NullCamera(BaseCamera):
    """Camera stub for camera-less operation. Returns gray blank frames."""

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def get_frame(self) -> np.ndarray:
        return np.full((480, 640, 3), 80, dtype=np.uint8)

    def get_info(self) -> dict[str, object]:
        return {"model": "None", "no_camera": True}

    @property
    def is_null(self) -> bool:
        return True

    def set_exposure(self, microseconds: float) -> None:
        raise NotImplementedError("No camera")

    def set_gain(self, db: float) -> None:
        raise NotImplementedError("No camera")

    def set_pixel_format(self, fmt: str) -> None:
        raise NotImplementedError("No camera")

    def get_white_balance(self) -> dict[str, float]:
        raise NotImplementedError("No camera")

    def set_white_balance_auto(self) -> dict[str, float]:
        raise NotImplementedError("No camera")

    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        raise NotImplementedError("No camera")
```

- [ ] **Step 5: Run the new tests**

```bash
.venv/bin/pytest tests/test_cameras.py -k "null_camera or is_null" -v
```

Expected: all 7 new tests PASS.

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all existing tests still PASS.

---

## Task 2 — `CameraReader.is_null` + config default

**Files:**
- Modify: `backend/stream.py`
- Modify: `backend/config.py`
- Modify: `tests/test_cameras.py`

- [ ] **Step 1: Write failing test for `CameraReader.is_null`**

Add to `tests/test_cameras.py`:

```python
from backend.cameras.null import NullCamera
from backend.stream import CameraReader


def test_camera_reader_is_null_false_for_real_camera():
    class MinimalFake(BaseCamera):
        def open(self): pass
        def close(self): pass
        def get_frame(self): return np.zeros((480, 640, 3), dtype=np.uint8)
        def set_exposure(self, us): pass
        def set_gain(self, db): pass
        def get_info(self): return {}
        def set_pixel_format(self, fmt): pass
        def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_ratio(self, ch, v): pass
    reader = CameraReader(MinimalFake())
    assert reader.is_null is False


def test_camera_reader_is_null_true_for_null_camera():
    reader = CameraReader(NullCamera())
    assert reader.is_null is True
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/bin/pytest tests/test_cameras.py::test_camera_reader_is_null_false_for_real_camera -v
```

Expected: `AttributeError: 'CameraReader' object has no attribute 'is_null'`.

- [ ] **Step 3: Add `is_null` property to `CameraReader` in `backend/stream.py`**

Add after `set_white_balance_ratio` (before `# ── Internal`):

```python
    @property
    def is_null(self) -> bool:
        return self._camera.is_null
```

- [ ] **Step 4: Add `"no_camera": False` default to `backend/config.py`**

Change line:
```python
_DEFAULTS = {"camera_id": None, "version": 1}
```
to:
```python
_DEFAULTS = {"camera_id": None, "version": 1, "no_camera": False}
```

- [ ] **Step 5: Run the new tests**

```bash
.venv/bin/pytest tests/test_cameras.py -k "camera_reader_is_null" -v
```

Expected: both tests PASS.

- [ ] **Step 6: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all tests PASS.

---

## Task 3 — `create_app` no-camera mode + auto-detect fallback

**Files:**
- Modify: `backend/main.py`
- Modify: `tests/test_main.py`

- [ ] **Step 1: Write failing tests for the new `create_app` paths**

Add to `tests/test_main.py`. Note: `FakeCamera` is already imported at the top of that file (`from tests.conftest import FakeCamera`), so the tests below can use it directly.

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/bin/pytest tests/test_main.py::TestNoCameraMode -v
```

Expected: multiple failures — `create_app()` doesn't accept `no_camera` param yet.

- [ ] **Step 3: Update `backend/main.py`**

Replace the entire file with:

```python
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
        or bool(os.environ.get("NO_CAMERA"))
    )

    if camera is None:
        from .config import load_config
        cfg = load_config()
        _no_camera = _no_camera or cfg.get("no_camera", False)

    if _no_camera:
        camera = NullCamera()
    elif camera is None:
        from .config import load_config
        cfg = load_config()
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
```

- [ ] **Step 4: Run the new tests**

```bash
.venv/bin/pytest tests/test_main.py::TestNoCameraMode -v
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all existing tests still PASS.

---

## Task 4 — API guards for no-camera mode

**Files:**
- Modify: `backend/api.py`
- Create: `tests/test_null_camera_api.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_null_camera_api.py`:

```python
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app


@pytest.fixture
def null_client(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    app = create_app(no_camera=True)
    with TestClient(app) as c:
        yield c


def test_camera_info_returns_no_camera_flag(null_client):
    r = null_client.get("/camera/info")
    assert r.status_code == 200
    assert r.json()["no_camera"] is True


def test_cameras_list_returns_empty(null_client):
    r = null_client.get("/cameras")
    assert r.status_code == 200
    assert r.json() == []


def test_set_exposure_returns_503(null_client):
    r = null_client.put("/camera/exposure", json={"value": 5000})
    assert r.status_code == 503


def test_set_gain_returns_503(null_client):
    r = null_client.put("/camera/gain", json={"value": 0})
    assert r.status_code == 503


def test_set_pixel_format_returns_503(null_client):
    r = null_client.put("/camera/pixel-format", json={"pixel_format": "Mono8"})
    assert r.status_code == 503


def test_wb_auto_returns_503(null_client):
    r = null_client.post("/camera/white-balance/auto")
    assert r.status_code == 503


def test_wb_ratio_returns_503(null_client):
    r = null_client.put("/camera/white-balance/ratio",
                        json={"channel": "Red", "value": 1.2})
    assert r.status_code == 503


def test_camera_select_returns_503(null_client):
    r = null_client.post("/camera/select", json={"camera_id": "some-id"})
    assert r.status_code == 503


def test_snapshot_returns_503(null_client):
    r = null_client.post("/snapshot")
    assert r.status_code == 503


def test_freeze_and_load_still_work(null_client):
    """Freeze and load-image must work in no-camera mode."""
    r = null_client.post("/freeze")
    assert r.status_code == 200  # blank frame from NullCamera is fine


def test_regular_camera_info_includes_no_camera_false(tmp_path, monkeypatch):
    """Real (fake) camera response must include no_camera: false."""
    from tests.conftest import FakeCamera
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    app = create_app(camera=FakeCamera())
    with TestClient(app) as c:
        r = c.get("/camera/info")
    assert r.status_code == 200
    assert r.json()["no_camera"] is False
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/bin/pytest tests/test_null_camera_api.py -v
```

Expected: most tests fail — guards not yet added.

- [ ] **Step 3: Update `backend/api.py`**

**`/camera/info` handler** — replace:
```python
    @router.get("/camera/info")
    async def camera_info():
        return camera.get_info()
```
with:
```python
    @router.get("/camera/info")
    async def camera_info():
        info = camera.get_info()
        info["no_camera"] = camera.is_null
        return info
```

**`/cameras` handler** — add guard at the top:
```python
    @router.get("/cameras")
    async def list_cameras():
        if camera.is_null:
            return []
        from .cameras.aravis import list_aravis_cameras
        cameras = await asyncio.to_thread(list_aravis_cameras)
        if not cameras:
            cameras = [{"id": "opencv-0", "vendor": "OpenCV", "label": "OpenCV Camera"}]
        return cameras
```

**`/snapshot` handler** — add guard as the first line of the function body:
```python
    @router.post("/snapshot")
    async def snapshot():
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        frame = camera.get_frame()
        ...
```

**`/camera/exposure` handler** — add guard:
```python
    @router.put("/camera/exposure")
    async def set_exposure(body: ExposureBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        camera.set_exposure(body.value)
        return {"ok": True}
```

**`/camera/gain` handler** — add guard:
```python
    @router.put("/camera/gain")
    async def set_gain(body: GainBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        camera.set_gain(body.value)
        return {"ok": True}
```

**`/camera/pixel-format` handler** — add guard before the format check:
```python
    @router.put("/camera/pixel-format")
    async def set_pixel_format(body: PixelFormatBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        if body.pixel_format not in _SUPPORTED_PIXEL_FORMATS:
            raise HTTPException(status_code=400, detail=f"Unsupported format: {body.pixel_format}")
        camera.set_pixel_format(body.pixel_format)
        return {"ok": True}
```

**`/camera/white-balance/auto` handler** — add guard before `asyncio.to_thread`:
```python
    @router.post("/camera/white-balance/auto")
    async def auto_white_balance():
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        try:
            ratios = await asyncio.to_thread(camera.set_white_balance_auto)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        return ratios
```

**`/camera/white-balance/ratio` handler** — add guard before channel validation:
```python
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
```

**`/camera/select` handler** — add guard before the `opencv-0` check:
```python
    @router.post("/camera/select")
    async def select_camera(body: CameraSelectBody):
        if camera.is_null:
            raise HTTPException(503, detail="No camera")
        if body.camera_id == "opencv-0":
            raise HTTPException(status_code=400,
                detail="Camera selection is not supported on the OpenCV fallback.")
        ...
```

- [ ] **Step 4: Run the new tests**

```bash
.venv/bin/pytest tests/test_null_camera_api.py -v
```

Expected: all 11 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all tests PASS.

---

## Task 5 — Frontend: no-camera detection + CSS hide rules

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/style.css`
- Modify: `frontend/app.js`

No automated tests for the frontend — verify visually.

- [ ] **Step 1: Add `#drop-overlay` to `frontend/index.html`**

Inside `<div id="viewer">`, after `<div id="coord-display"></div>`:

```html
    <div id="drop-overlay">
      <div class="drop-message">
        Drop an image here<br>
        <span>or click 📁 to load</span>
      </div>
    </div>
```

The `#viewer` section should now look like:
```html
  <div id="viewer">
    <img id="stream-img" src="/stream" alt="camera stream">
    <canvas id="overlay-canvas"></canvas>
    <div id="coord-display"></div>
    <div id="drop-overlay">
      <div class="drop-message">
        Drop an image here<br>
        <span>or click 📁 to load</span>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add CSS rules to `frontend/style.css`**

Append to the end of `style.css`:

```css
/* ── No-camera mode ────────────────────────────────────────────────────── */
body.no-camera #btn-snapshot { display: none; }
body.no-camera .sidebar-section:has(#exp-slider) { display: none; }
body.no-camera button[data-tab="camera"] { display: none; }
body.no-camera #settings-camera-panel { display: none; }

/* Drop overlay */
#drop-overlay {
  display: none;
  position: absolute;
  inset: 0;
  pointer-events: none;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  border: 2px dashed var(--border);
  z-index: 10;
}
#drop-overlay.visible {
  display: flex;
  pointer-events: auto;
}
#drop-overlay.drag-active {
  border-color: var(--accent, #60a5fa);
  background: rgba(0, 0, 0, 0.7);
}
.drop-message {
  text-align: center;
  color: var(--text);
  font-size: 16px;
  line-height: 1.8;
  pointer-events: none;
}
.drop-message span {
  font-size: 13px;
  color: var(--muted);
}
```

- [ ] **Step 3: Add `_noCamera` flag and detection to `frontend/app.js`**

At the very top of `app.js`, just after the `const state = { ... }` block (around line 30), add:

```js
let _noCamera = false;
```

In `loadCameraInfo()` (around line 996), at the end of the `try` block (just before `} catch`), add:

```js
    if (d.no_camera === true && !_noCamera) {
      _noCamera = true;
      document.body.classList.add("no-camera");
      statusEl.textContent = "No camera — image only";
    }
```

- [ ] **Step 4: Add overlay visibility helper and update frozen state transitions**

Add a helper function near the other utility functions (e.g., after `loadCameraInfo`):

```js
function updateDropOverlay() {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) return;
  overlay.classList.toggle("visible", _noCamera && !state.frozen);
}
```

Call `updateDropOverlay()` in every place where `state.frozen` changes:

1. After `state.frozen = true` in the freeze button handler (around line 1837):
   ```js
   state.frozen = true;
   document.getElementById("btn-freeze").classList.add("active");
   updateDropOverlay();
   ```

2. After `state.frozen = true` in the `#file-input` change handler (around line 2239):
   ```js
   state.frozen = true;
   document.getElementById("btn-freeze").classList.add("active");
   updateDropOverlay();
   ```

3. After `state.frozen = false` in the unfreeze path (around line 2200):
   ```js
   state.frozen = false;
   state.frozenBackground = null;
   updateDropOverlay();
   ```

4. At the end of `loadCameraInfo()` after setting `_noCamera = true`:
   ```js
   updateDropOverlay();
   ```

5. After `state.frozen = true` in the load-snapshot handler (wherever it sets frozen).

- [ ] **Step 5: Add drag-and-drop event handlers to `frontend/app.js`**

Add after the `#file-input` change handler (around line 2247):

```js
// ── Drag-and-drop image load (no-camera mode) ────────────────────────────
const viewerEl = document.getElementById("viewer");
const dropOverlayEl = document.getElementById("drop-overlay");

viewerEl.addEventListener("dragover", e => {
  if (!_noCamera) return;
  e.preventDefault();
  dropOverlayEl.classList.add("drag-active");
});

viewerEl.addEventListener("dragleave", e => {
  dropOverlayEl.classList.remove("drag-active");
});

viewerEl.addEventListener("drop", async e => {
  if (!_noCamera) return;
  e.preventDefault();
  dropOverlayEl.classList.remove("drag-active");
  const file = e.dataTransfer.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  const r = await fetch("/load-image", { method: "POST", body: formData });
  if (!r.ok) { alert("Could not load image"); return; }
  const { width, height } = await r.json();
  state.frozenSize = { w: width, h: height };

  const url = URL.createObjectURL(file);
  const loadedImg = new Image();
  loadedImg.onload = () => {
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    document.getElementById("btn-freeze").classList.add("active");
    statusEl.textContent = "Loaded image";
    statusEl.className = "status-line frozen";
    updateDropOverlay();
    redraw();
  };
  loadedImg.src = url;
});
```

- [ ] **Step 6: Visual verification**

Start the server with `NO_CAMERA=1`:

```bash
NO_CAMERA=1 .venv/bin/uvicorn backend.main:app --port 8000
```

Open `http://localhost:8000` and verify:
- Status bar shows "No camera — image only"
- 📷 snapshot button is absent from the toolbar
- "Camera" sidebar section (exposure/gain) is hidden
- "Camera" tab in Settings is hidden
- A semi-transparent overlay with "Drop an image here / or click 📁 to load" fills the viewer
- Dragging an image file over the viewer highlights the overlay border
- Dropping the image loads it and the overlay disappears
- All measurement tools work on the loaded image
- Clicking 📁 also loads an image and the overlay disappears

- [ ] **Step 7: Run full backend test suite one final time**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all tests PASS.
