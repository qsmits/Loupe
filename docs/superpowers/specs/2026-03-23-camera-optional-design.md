# Camera-Optional Mode Design

## Goal

Allow the app to start and be fully usable for image measurement when no camera hardware is present. Aravis/OpenCV unavailability or failure silently falls back to a no-camera mode; a `NO_CAMERA` environment variable and a config key also trigger it directly.

**Architecture:** Backend adds a `NullCamera` class and auto-detect fallback. Frontend reads a `no_camera` flag from `/camera/info` and conditionally hides camera controls and shows a drag-and-drop overlay.

**Tech Stack:** Python/FastAPI backend, Vanilla JS frontend.

---

## Backend

### NullCamera (`backend/cameras/null.py`)

Implements `BaseCamera`:

- `open()` — no-op
- `close()` — no-op
- `get_frame()` — returns a 640×480 gray blank (`np.full((480, 640, 3), 80, dtype=np.uint8)`)
- `get_info()` — returns `{"model": "None", "no_camera": True}` (does not raise)
- `set_exposure()`, `set_gain()`, `set_pixel_format()`, `get_white_balance()`, `set_white_balance_auto()`, `set_white_balance_ratio()` — all raise `NotImplementedError("No camera")`. These methods are all guarded by 503 checks in `api.py` (see below), so `NotImplementedError` is never reached via normal HTTP calls.
- `is_null` — `@property` returning `True`

`BaseCamera` gains a `@property is_null` returning `False` (consistent `@property` on both base and subclass, not a plain class attribute).

### `CameraReader` (`backend/stream.py`)

Add a delegating `@property`:

```python
@property
def is_null(self) -> bool:
    return self._camera.is_null
```

`api.py` uses `camera.is_null` rather than accessing `camera._camera` directly.

### Startup resolution in `main.py`

**`create_app` signature:**

```python
def create_app(camera: BaseCamera | None = None, no_camera: bool = False) -> FastAPI:
```

The existing `camera` param is preserved for test injection. If `no_camera=True` and `camera` is also passed, `no_camera=True` takes precedence and the passed camera is ignored.

**Activating no-camera mode:** `create_app()` checks, in order:
1. `no_camera=True` param, OR
2. `os.environ.get("NO_CAMERA")` is non-empty, OR
3. `config["no_camera"] == True`

Any of these causes `NullCamera` to be used immediately, skipping all camera detection.

**Usage:** `NO_CAMERA=1 uvicorn backend.main:app` — `create_app()` reads the env var at module import time, before the lifespan starts. No CLI flag is added (env var covers all use cases cleanly).

**Config key:** `no_camera: true` in `config.json` is a persistent setting for machines permanently without a camera. Setting `NO_CAMERA=1` as an env var does not auto-persist to config — they are independent mechanisms.

**Auto-detect fallback:** Inside the lifespan, wrap `reader.open()`:

```python
try:
    reader.open()
except Exception as e:
    log.warning("Camera failed to open: %s — falling back to no-camera mode.", e)
    # reader.open() raised inside _camera.open(), before _stop.clear() or
    # _thread.start() were reached. _stop is in its initial unset state and
    # _thread is None. No lock is needed — nothing is racing yet.
    reader._camera = NullCamera()
    reader.open()   # NullCamera.open() is a no-op; starts the reader thread
```

Auto-detect fallback does **not** write `no_camera: true` to `config.json`.

### Config (`backend/config.py`)

`_DEFAULTS` gains `"no_camera": False`. No other changes needed.

### API (`backend/api.py`)

**`/camera/info`** — merge `no_camera` into the response at the handler level:

```python
info = camera.get_info()
info["no_camera"] = camera.is_null
return info
```

Real cameras (`AravisCamera`, `OpenCVCamera`) do not need to add `no_camera` to their `get_info()`.

**`/cameras`** (camera list) — in no-camera mode, return `[]` immediately rather than enumerating Aravis devices and falling back to the OpenCV sentinel entry. Guard at the top of the handler:

```python
if camera.is_null:
    return []
```

**Camera-control endpoints** (`/camera/exposure`, `/camera/gain`, `/camera/pixel-format`, `/camera/white-balance/auto`, `/camera/white-balance/ratio`, `/camera/select`) — add an `is_null` guard at the very top of each handler, before any `asyncio.to_thread` call or `try/except` block:

```python
if camera.is_null:
    raise HTTPException(503, detail="No camera")
```

**`/snapshot`** — same 503 guard.

**`/stream`** — unchanged.

---

## Frontend

### Startup detection (`app.js`)

Add at the top of `app.js`, with the other module-level state variables:

```js
let _noCamera = false;
```

`loadCameraInfo()` already fetches `/camera/info` at startup. Add to that function, after receiving the response:

```js
if (data.no_camera === true && !_noCamera) {
    _noCamera = true;
    document.body.classList.add("no-camera");
    statusEl.textContent = "No camera — image only";
}
```

The `!_noCamera` guard ensures the flag is set only once (on first call). Subsequent calls to `loadCameraInfo()` — e.g. from the Settings refresh — do not re-evaluate it.

### Hidden elements (CSS)

When `body.no-camera`, hide via `display: none`:

- `#btn-snapshot` (📷 toolbar button)
- The "Camera" sidebar section (containing `#exp-slider`, `#gain-slider`, `#camera-info`)
- `button[data-tab="camera"]` (Camera tab button in Settings)
- `#settings-camera-panel` (explicitly hidden so it is not visible before any tab is clicked)

The ❄ freeze button, 📁 load button, all measurement tools, session save/load, DXF overlay, and detection panel remain fully functional.

### Drag-and-drop overlay

A new `<div id="drop-overlay">` is added inside `#viewer`:

```html
<div id="drop-overlay">
  <div class="drop-message">
    Drop an image here<br>
    <span>or click 📁 to load</span>
  </div>
</div>
```

**Visibility logic:**
- Shown when `_noCamera && !state.frozen`
- Hidden once an image is loaded (`state.frozen = true`)
- Never shown in camera mode

Visibility is updated wherever `state.frozen` changes.

**Drag-and-drop events** on `#viewer`:
- `dragover` — `e.preventDefault()`, add `.drag-active` to `#drop-overlay`
- `dragleave` — remove `.drag-active`
- `drop` — `e.preventDefault()`, take `e.dataTransfer.files[0]`, create a `FileReader` and load as data URL — same code path used by the existing `#file-input` change handler (the drop handler reuses that same logic)

Drag events are registered on `#viewer`, not on the overlay itself, so overlay `pointer-events` does not affect them.

**CSS:** `#drop-overlay` is `position: absolute; inset: 0`, centered flex, semi-transparent dark background, dashed border. `.drag-active` brightens the border and background slightly. When hidden, `pointer-events: none` so it does not block canvas interaction.

---

## Files Changed

| File | Change |
|---|---|
| `backend/cameras/null.py` | New: `NullCamera` class |
| `backend/cameras/base.py` | Add `@property is_null` returning `False` |
| `backend/stream.py` | Add delegating `@property is_null` to `CameraReader` |
| `backend/config.py` | Add `"no_camera": False` to `_DEFAULTS` |
| `backend/main.py` | `create_app(no_camera=False)` param; `NO_CAMERA` env var + config key check; try/except fallback on `reader.open()` |
| `backend/api.py` | `no_camera` field merged in `/camera/info`; 503 guards on camera-only endpoints and `/snapshot` |
| `frontend/app.js` | `_noCamera` flag; detection in `loadCameraInfo()`; drop-overlay visibility updates; drag-and-drop events |
| `frontend/index.html` | Add `#drop-overlay` div inside `#viewer` |
| `frontend/style.css` | `body.no-camera` hide rules; `#drop-overlay` and `.drag-active` styles |
