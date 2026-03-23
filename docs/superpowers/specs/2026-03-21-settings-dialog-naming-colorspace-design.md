# Design Spec: Settings Dialog, Named Measurements, Color Space & Camera Rename

**Date:** 2026-03-21
**Project:** MainDynamics Microscope
**Status:** Approved

---

## Overview

Four related improvements to the microscope app, delivered as a single cohesive change:

1. **Settings dialog** — tabbed modal for camera and display settings
2. **Named measurements** — editable labels in the sidebar list
3. **Pixel format / color space selection** — configurable at runtime via the settings dialog
4. **Rename `BaumerCamera` → `AravisCamera`** — reflect that the Aravis driver works with any GenICam-compatible camera

---

## 1. Rename BaumerCamera → AravisCamera

**Files affected:** `backend/cameras/baumer.py` → `backend/cameras/aravis.py`, `backend/cameras/__init__.py`, `backend/main.py`

- Rename the file from `baumer.py` to `aravis.py`
- Rename the class from `BaumerCamera` to `AravisCamera`
- Rename the export flag from `_ARAVIS_AVAILABLE` to `ARAVIS_AVAILABLE` (no leading underscore — it is used externally in `main.py`)
- Update `main.py` import: `from .cameras.aravis import AravisCamera, ARAVIS_AVAILABLE`
  - This line must update both the class name AND the flag spelling; missing either causes an `ImportError` at startup
- Delete `baumer.py`

---

## 2. Pixel Format Selection

### Backend: `AravisCamera.set_pixel_format()`

```python
def set_pixel_format(self, fmt: str) -> None:
    """Stop acquisition, set pixel format, restart acquisition.
    fmt is a GenICam string e.g. 'BayerRG8'.
    """
```

Supported format strings (matching what `get_frame()` already handles):
- `BayerRG8`
- `Mono8`
- `BGR8Packed`
- `RGB8Packed`

Implementation: call `self._cam.stop_acquisition()`, set the format via the device feature interface, re-push stream buffers (payload size may change), call `self._cam.start_acquisition()`.

`get_info()` is extended to include `pixel_format: str` — the current GenICam `PixelFormat` feature value read from the device.

### Backend: `CameraReader.set_pixel_format()`

`CameraReader` wraps the real camera and owns a background thread that calls `get_frame()` continuously. Calling `set_pixel_format()` directly on `AravisCamera` while the thread is running would race against the Aravis stream state.

`CameraReader` must expose its own `set_pixel_format()` that coordinates the thread:

```python
def set_pixel_format(self, fmt: str) -> None:
    # 1. Signal the reader thread to stop and wait for it
    self._stop.set()
    if self._thread is not None:
        self._thread.join(timeout=2)
    # 2. Delegate to the inner camera (no thread running — safe)
    self._camera.set_pixel_format(fmt)
    # 3. Restart the reader thread
    self._stop.clear()
    self._thread = threading.Thread(target=self._run, daemon=True)
    self._thread.start()
```

### Backend: `BaseCamera` contract

`BaseCamera` gains an abstract `set_pixel_format(fmt: str) -> None` method. `OpenCVCamera` provides a no-op implementation and `get_info()` returns `"pixel_format": "n/a"`. `AravisCamera` provides the full implementation.

### API endpoint

```
PUT /camera/pixel-format
Body: {"pixel_format": "BayerRG8"}    ← field is pixel_format, not format (avoids shadowing Python built-in)
Response: {"ok": true}
Errors: 400 if fmt is not one of the four supported strings
```

Pydantic model:

```python
class PixelFormatBody(BaseModel):
    pixel_format: str
```

The API endpoint calls `reader.set_pixel_format(body.pixel_format)`, where `reader` is the `CameraReader` instance.

### Stream stall during format change

Changing pixel format requires restarting the reader thread, during which the MJPEG `/stream` endpoint will stall briefly. Browsers hold the last-received frame on the `<img>` element during a stall, so the live view will freeze momentarily but not go blank. No frontend workaround is needed; the spec notes this is acceptable behaviour.

---

## 3. Settings Dialog (Frontend)

A `<dialog>` element (native HTML dialog API) triggered by a new **⚙** toolbar button.

### Structure

```
[ ⚙ Settings ]
┌─────────────────────────────────┐
│  [Camera]  [Display]       [×]  │  ← tab buttons + close
├─────────────────────────────────┤
│  Camera tab:                    │
│    Pixel format: [BayerRG8 ▾]   │
│    Model: VCXU-32C (read-only)  │
│    Serial: 700003540741         │
│                                 │
│  Display tab:                   │
│    Crosshair color:             │
│    ● ○ ○ ○ ○  (swatches)       │
│    Opacity: [────●────] 40%     │
│                                 │
│  [status line]                  │
└─────────────────────────────────┘
```

### Open / close behaviour

- Opens via `dialogEl.showModal()`
- Closes via the × button (`dialogEl.close()`) or clicking the backdrop
- Backdrop click detection: listen on the `<dialog>` element itself; close only when `event.target === dialogEl` (the backdrop is not a separate DOM element — clicking inside the dialog content also bubbles to `<dialog>`, so the `target` check is required)

### Tab switching

Two content panels (`#settings-camera-panel`, `#settings-display-panel`). Active tab button gets an `active` class; inactive panel gets `display: none`. Default active tab: Camera.

### Dialog dimensions

Fixed width: `360px`. Height: auto. `z-index` above the canvas (use `z-index: 100`). Positioned via `::backdrop` / browser default centering.

### Crosshair color swatches

Five options:

| Label  | Hex       |
|--------|-----------|
| White  | `#ffffff` |
| Red    | `#ef4444` |
| Green  | `#22c55e` |
| Yellow | `#facc15` |
| Cyan   | `#22d3ee` |

Selected swatch highlighted with a ring (`outline: 2px solid #fff; outline-offset: 2px`). Default: white.

### Opacity slider

Range 0–100 (integer, display as `%`). The value stored in `state.settings.crosshairOpacity` is a float in `[0.0, 1.0]` — divide the slider value by 100 when storing, multiply by 100 when reading back to populate the slider. Default 40 (slider) / 0.4 (state).

### State additions

```js
state.settings = {
  crosshairColor: "#ffffff",      // hex string
  crosshairOpacity: 0.4,          // float 0.0–1.0
  pixelFormat: "BayerRG8",        // initialised from GET /camera/info
};
```

`pixelFormat` is initialised in `loadCameraInfo()` from `d.pixel_format`. If the field is absent (e.g. OpenCV fallback returns `"n/a"`), default to `"BayerRG8"` and disable the format dropdown.

### Pixel format change flow

1. User selects format in dropdown
2. Frontend sends `PUT /camera/pixel-format` with `{"pixel_format": "<value>"}`
3. While awaiting response, show "Applying…" in the dialog status line
4. On success, show "Done" briefly, update `state.settings.pixelFormat`
5. On error, show the error message and revert the dropdown to the previous value

---

## 4. `drawCrosshair()` update

Replace hardcoded `rgba(255,255,255,0.4)` with values from `state.settings`:

```js
function drawCrosshair() {
  if (!state.crosshair) return;
  const { crosshairColor, crosshairOpacity } = state.settings;
  // Convert hex color + separate opacity to rgba stroke style
  const r = parseInt(crosshairColor.slice(1, 3), 16);
  const g = parseInt(crosshairColor.slice(3, 5), 16);
  const b = parseInt(crosshairColor.slice(5, 7), 16);
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.strokeStyle = `rgba(${r},${g},${b},${crosshairOpacity})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, canvas.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
  ctx.setLineDash([]);
}
```

---

## 5. Named Measurements (Frontend)

### Data model

Each annotation gains an optional `name` field (string, default `""`):

```js
{ type: "distance", a, b, id: 1, name: "" }
```

### Sidebar rendering

Each measurement row:

```
① [___Label…__________]  1.234 mm  [✕]
```

- The circled number uses `String.fromCodePoint(9312 + i)`. This works for annotations 1–20 (U+2460–U+2473). Beyond 20 the symbol degrades to a parenthesised number — acceptable for current usage, noted here for future reference.
- The name `<input>` is always visible and editable; placeholder: `"Label…"`
- Measurement value shown to the right in muted text
- Delete button on the far right
- Changing the name input updates `ann.name` on the `input` event

### Canvas rendering

No change — canvas shows only the circled number, no labels. Names are sidebar-only.

### `addAnnotation()` change

```js
function addAnnotation(data) {
  const ann = { ...data, id: state.nextId++, name: data.name ?? "" };
  ...
}
```

---

## File Change Summary

| File | Change |
|------|--------|
| `backend/cameras/baumer.py` | Delete |
| `backend/cameras/aravis.py` | New — renamed class, `set_pixel_format()`, `get_info()` extended |
| `backend/cameras/base.py` | Add abstract `set_pixel_format()` |
| `backend/cameras/opencv.py` | No-op `set_pixel_format()`, add `pixel_format: "n/a"` to `get_info()` |
| `backend/cameras/__init__.py` | Update export |
| `backend/stream.py` | Add `CameraReader.set_pixel_format()` with thread stop/restart |
| `backend/api.py` | Add `PUT /camera/pixel-format` (`PixelFormatBody`), extend `GET /camera/info` |
| `backend/main.py` | Update import: `AravisCamera`, `ARAVIS_AVAILABLE` |
| `frontend/app.js` | Settings dialog logic, named measurements, crosshair settings, pixel format UI |
| `frontend/index.html` | Add ⚙ button, `<dialog>` element with two tab panels |
| `frontend/style.css` | Dialog styles (360px fixed width, z-index 100), tab styles, updated measurement row |

---

## Out of Scope

- Persisting settings across page reloads (localStorage) — can be added later
- Annotation export to JSON/CSV — separate feature
- Multiple camera support — not needed
