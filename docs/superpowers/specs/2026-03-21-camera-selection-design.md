# Camera Selection Design

## Goal

Add a camera selection dropdown to the settings dialog Camera tab, above the pixel format row. Switching cameras happens live (no server restart visible to the user). The selected camera is persisted in `config.json` so the correct camera is opened on server restart.

## Approach

A new `backend/config.py` module handles reading and writing `config.json`. `AravisCamera` gains an optional `device_id` parameter and a module-level `list_aravis_cameras()` function. `CameraReader` gets a `switch_camera()` method. Two new API endpoints expose listing and switching. The frontend populates the dropdown when the settings dialog opens and posts on change.

On the OpenCV fallback, camera selection is a no-op: the dropdown is disabled and shows "OpenCV Camera".

## Architecture

### `config.json` (project root)

Initial content:
```json
{"camera_id": null}
```

`null` means "first available Aravis camera". Any other value is an Aravis device ID string.

### `backend/config.py` (new file)

```python
import json
import pathlib

CONFIG_PATH = pathlib.Path(__file__).parent.parent / "config.json"
_DEFAULTS = {"camera_id": None}


def load_config() -> dict:
    """Return config dict. Missing keys fall back to defaults. File missing → all defaults."""
    if not CONFIG_PATH.exists():
        return dict(_DEFAULTS)
    try:
        data = json.loads(CONFIG_PATH.read_text())
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

### `backend/cameras/aravis.py` — changes

**`list_aravis_cameras()` — module-level function:**

Uses only Aravis enumeration-level API — no device is opened, so no handles are held that could prevent `AravisCamera.open()` from acquiring the camera. The enumeration-level functions available in Aravis GI are `get_device_id(i)` and `get_device_vendor(i)`. Model and serial are not available at enumeration level (they require opening the device); the display label is composed from vendor + device ID instead.

```python
def list_aravis_cameras() -> list[dict]:
    """
    Return list of available Aravis cameras as
    [{"id": str, "vendor": str, "label": str}, ...].
    Returns [] if Aravis is not available.
    'label' is a human-readable display string for the UI dropdown.
    """
    if not ARAVIS_AVAILABLE:
        return []
    Aravis.update_device_list()
    cameras = []
    for i in range(Aravis.get_n_devices()):
        device_id = Aravis.get_device_id(i)
        vendor = Aravis.get_device_vendor(i) or "Unknown"
        cameras.append({
            "id": device_id,
            "vendor": vendor,
            "label": f"{vendor} — {device_id}",
        })
    return cameras
```

**`AravisCamera.__init__` — accept optional `device_id`:**

```python
def __init__(self, device_id: str | None = None):
    if not ARAVIS_AVAILABLE:
        raise ImportError(
            "Aravis GI not available. Install aravis and set GST_PLUGIN_PATH."
        )
    self._device_id = device_id  # None → first available
    self._cam = None
    self._stream = None
```

**`AravisCamera.open()` — use `device_id`:**

```python
self._cam = Aravis.Camera.new(self._device_id)  # None → first available
```

**`AravisCamera.get_info()` — include `device_id`:**

Add `"device_id": self._device_id` to the returned dict (after `"pixel_format"`). This allows the frontend to pre-select the correct camera in the dropdown without scraping DOM elements.

**`OpenCVCamera.get_info()` — include `device_id`:**

Add `"device_id": "opencv-0"` to the returned dict.

**`FakeCamera.get_info()` in `tests/conftest.py` — include `device_id`:**

Add `"device_id": "fake-0"` to the returned dict.

### `backend/stream.py` — `CameraReader.switch_camera()`

```python
def switch_camera(self, new_camera: BaseCamera) -> None:
    """
    Live-swap the underlying camera. Stops the reader thread, closes the
    old camera, opens the new one, and restarts the thread.
    Uses _format_lock to prevent concurrent pixel-format changes and
    concurrent switch_camera calls.
    If the new camera fails to open, the old one is restored and an
    exception is raised.
    """
    with self._format_lock:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            if self._thread.is_alive():
                raise RuntimeError(
                    "Reader thread did not stop within 2 s; aborting camera switch."
                )
        old_camera = self._camera
        try:
            new_camera.open()
            old_camera.close()
            self._camera = new_camera
        except Exception as switch_err:
            # Restore old camera; log if restoration also fails
            import logging
            try:
                old_camera.open()
                self._camera = old_camera
            except Exception as restore_err:
                logging.getLogger(__name__).error(
                    "Camera switch failed and restoration also failed: %s", restore_err
                )
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
            raise switch_err
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
```

### `backend/api.py` — new endpoints (inside `make_router()`)

**Body model (module-level):**
```python
class CameraSelectBody(BaseModel):
    camera_id: str = Field(..., min_length=1)
```

`Field` requires `from pydantic import BaseModel, Field`.

Both endpoints are defined **inside `make_router(camera, frame_store)`** to capture the `camera` closure variable, consistent with every other endpoint in the file.

**`GET /cameras`:**
```python
@router.get("/cameras")
async def list_cameras():
    from .cameras.aravis import list_aravis_cameras
    cameras = await asyncio.to_thread(list_aravis_cameras)
    if not cameras:
        # OpenCV fallback — return a single non-selectable entry
        cameras = [{"id": "opencv-0", "vendor": "OpenCV", "label": "OpenCV Camera"}]
    return cameras
```

**`POST /camera/select`:**
```python
@router.post("/camera/select")
async def select_camera(body: CameraSelectBody):
    if body.camera_id == "opencv-0":
        raise HTTPException(status_code=400,
            detail="Camera selection is not supported on the OpenCV fallback.")
    from .cameras.aravis import AravisCamera
    from .config import save_config
    new_cam = AravisCamera(device_id=body.camera_id)
    try:
        await asyncio.to_thread(camera.switch_camera, new_cam)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    save_config({"camera_id": body.camera_id})
    return {"ok": True}
```

`asyncio.to_thread` is used because `switch_camera` blocks during camera open.

### `backend/main.py` — read config on startup (inside `create_app()`)

The config read belongs inside `create_app()` in the branch where no camera is provided (i.e. the non-test path), so the test fixture that passes `FakeCamera` directly is unaffected:

```python
from .config import load_config

def create_app(camera: BaseCamera | None = None):
    if camera is None:
        cfg = load_config()
        if ARAVIS_AVAILABLE:
            camera = AravisCamera(device_id=cfg.get("camera_id"))
        else:
            camera = OpenCVCamera(index=1)
    ...
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cameras` | List available cameras |
| `POST` | `/camera/select` | Switch to a camera by ID, persist to config |

### `GET /cameras` response
```json
[
  {"id": "Aravis-USB0-700003540741", "vendor": "Baumer", "label": "Baumer — Aravis-USB0-700003540741"}
]
```

### `POST /camera/select` body + response
```json
{"camera_id": "Aravis-USB0-700003540741"}
```
Response: `{"ok": true}` or HTTP 400 with detail.

## Frontend

### HTML (`frontend/index.html`)

Above the pixel format row, inside `#settings-camera-panel`:

```html
<div class="settings-row">
  <label for="camera-select">Camera</label>
  <select id="camera-select">
    <option value="">Loading…</option>
  </select>
</div>
```

### JavaScript (`frontend/app.js`)

**`loadCameraList()`** — called from the settings open handler (alongside the existing `loadCameraInfo()` call). Uses `d.device_id` from the already-loaded camera info to pre-select the current camera — no DOM scraping needed.

```js
async function loadCameraList() {
  const sel = document.getElementById("camera-select");
  try {
    const [camerasResp, infoResp] = await Promise.all([
      fetch("/cameras"),
      fetch("/camera/info"),
    ]);
    const cameras = await camerasResp.json();
    const info = await infoResp.json();
    const currentId = info.device_id ?? "";
    sel.innerHTML = cameras.map(c =>
      `<option value="${c.id}"${c.id === currentId ? " selected" : ""}>${c.label}</option>`
    ).join("");
    sel.disabled = cameras.length <= 1 && cameras[0]?.id === "opencv-0";
  } catch {
    sel.innerHTML = "<option>Unavailable</option>";
    sel.disabled = true;
  }
}
```

**Change handler:**

```js
document.getElementById("camera-select").addEventListener("change", async e => {
  const camera_id = e.target.value;
  if (!camera_id) return;
  fmtStatusEl.textContent = "Switching…";
  try {
    const r = await fetch("/camera/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_id }),
    });
    if (!r.ok) throw new Error(await r.text());
    await loadCameraInfo();
    fmtStatusEl.textContent = "Done";
    setTimeout(() => { fmtStatusEl.textContent = ""; }, 2000);
  } catch (err) {
    fmtStatusEl.textContent = `Error: ${err.message}`;
  }
});
```

After a successful switch, `loadCameraInfo()` refreshes the model/serial/pixel-format/WB fields.

## Files changed

| File | Change |
|------|--------|
| `config.json` | New — persists `camera_id` |
| `backend/config.py` | New — `load_config()`, `save_config()` |
| `backend/cameras/aravis.py` | `list_aravis_cameras()` function; `__init__` accepts `device_id`; `open()` passes `device_id`; `get_info()` includes `device_id` |
| `backend/cameras/opencv.py` | `get_info()` includes `"device_id": "opencv-0"` |
| `backend/main.py` | Read config inside `create_app()`; pass `device_id` to `AravisCamera` |
| `backend/stream.py` | `CameraReader.switch_camera()` |
| `backend/api.py` | `Field` import; `CameraSelectBody`; `GET /cameras`; `POST /camera/select` (both inside `make_router()`) |
| `tests/conftest.py` | `FakeCamera.get_info()` gains `"device_id": "fake-0"` |
| `tests/test_api.py` | Tests for `GET /cameras` and `POST /camera/select` |
| `frontend/index.html` | Camera dropdown above pixel format row |
| `frontend/app.js` | `loadCameraList()`; change handler; call `loadCameraList()` on settings open |

## Testing

All tests in `tests/` (no hardware required):

- `test_list_cameras_returns_list` — `GET /cameras` returns a list with at least one entry (FakeCamera → OpenCV fallback path returns `[{"id": "opencv-0", ...}]`)
- `test_select_camera_opencv_id_rejected` — `POST /camera/select` with `"opencv-0"` returns 400
- `test_select_camera_aravis_unavailable` — `POST /camera/select` with any non-`opencv-0` ID; since Aravis is unavailable in the test environment, `AravisCamera.__init__` raises `ImportError` which propagates as 400. Test verifies 400 status — the failure mode (ImportError as 400) is explicitly documented and expected.
- `test_config_load_defaults_when_missing` — `load_config()` returns defaults when file absent
- `test_config_save_and_load` — round-trip write/read preserves values
- `test_config_load_merges_defaults` — partial config file gets missing keys filled in from `_DEFAULTS`
- `test_camera_info_includes_device_id` — `GET /camera/info` response includes `device_id` field

No automated tests for `list_aravis_cameras()` or `CameraReader.switch_camera()` (require hardware).
