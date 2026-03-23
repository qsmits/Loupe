# Video Microscope Tool — Design Spec

**Date:** 2026-03-21
**Status:** Approved

---

## Overview

A browser-based video microscope tool for industrial inspection and precision measurement. Streams live video from a USB3 industrial camera (Baumer VCXU-32C), displays it in a browser, and provides a canvas-based overlay for calibration and measurement. Designed to run locally on macOS and be accessible remotely over a LAN.

---

## Architecture

**FastAPI backend + MJPEG stream + HTML Canvas frontend.**

The Python backend captures frames from the camera and serves them as an MJPEG HTTP stream. The browser displays the stream under a transparent canvas element. All measurement interactions happen on the canvas. Detection tasks (edge detection, circle detection) are offloaded to the backend via REST calls and results are drawn back onto the canvas.

```
Browser
  └── <img src="/stream">     ← MJPEG stream
  └── <canvas>                ← measurement overlay (mouse events, annotations)
  └── toolbar + sidebar       ← tool selection, results list, camera controls

FastAPI backend
  └── /stream                 ← MJPEG generator
  └── /freeze                 ← capture current camera frame → stored server-side
  └── /snapshot               ← save current frame to snapshots/ dir
  └── /load-image             ← upload image file → stored server-side
  └── /detect-edges           ← Canny on stored frame → PNG overlay
  └── /detect-circles         ← Hough on stored frame → [{x, y, radius}]
  └── CameraManager           ← holds current BaseCamera instance
  └── FrameStore              ← holds the last frozen/loaded frame for detection
```

---

## Camera Abstraction

All camera access goes through a `BaseCamera` abstract class. This makes swapping or adding cameras a one-file change.

```python
class BaseCamera:
    def open(self) -> None: ...
    def close(self) -> None: ...
    def get_frame(self) -> np.ndarray: ...       # returns BGR numpy array
    def set_exposure(self, microseconds: float) -> None: ...
    def set_gain(self, db: float) -> None: ...
    def get_info(self) -> dict: ...              # model, serial, resolution
```

**Implementations:**
- `BaumerCamera` — uses Baumer neoAPI Python bindings (primary)
- `OpenCVCamera` — uses `cv2.VideoCapture` as a fallback/test camera

---

## Project Structure

```
microscope/
├── backend/
│   ├── main.py              # FastAPI app entry point
│   ├── api.py               # REST endpoints + MJPEG stream route
│   ├── stream.py            # MJPEG frame generator (async generator)
│   ├── cameras/
│   │   ├── base.py          # BaseCamera abstract class
│   │   ├── baumer.py        # BaumerCamera (neoAPI)
│   │   └── opencv.py        # OpenCVCamera (webcam fallback)
│   └── vision/
│       ├── calibration.py   # pixel-to-unit conversion math
│       └── detection.py     # Canny edge + Hough circle detection
├── frontend/
│   ├── index.html           # single-page app
│   ├── app.js               # canvas tools, measurement logic, UI state
│   └── style.css            # dark theme, toolbar/sidebar layout
├── snapshots/               # saved frames written here
└── requirements.txt
```

---

## Frontend UI

**Layout A:** horizontal toolbar across the top, live feed in the center, measurement sidebar on the right.

```
┌─────────────────────────────────────────────────────────────┐
│ [Select] [Calibrate] [Distance] [Angle] [Circle] [Detect]  [⊹] [❄] [📁] [📷] [🖼] │
├─────────────────────────────────────────────┬───────────────┤
│                                             │ Measurements  │
│          live MJPEG stream                  │ ① 1.24 mm    │
│          + canvas overlay                   │ ② 32.5°      │
│                                             │ ③ ⌀ 0.85mm   │
│                                             ├───────────────┤
│                                             │ Camera        │
│                                             │ Exp: 5000 µs  │
│                                             │ Gain: 0 dB    │
│                                             │ 1px = 0.82µm  │
└─────────────────────────────────────────────┴───────────────┘
```

---

## Measurement Tools

### Calibration
1. Select **Calibrate** tool
2. Click two points on the canvas
3. Enter the real-world distance (e.g. `1.000 mm`)
4. The px/mm ratio is stored in frontend state; all subsequent measurements convert automatically

### Distance
Click two points → canvas draws a line with the calibrated distance label.

### Angle
Click three points (vertex in the middle) → canvas draws two lines and labels the angle between them.

### Circle / Radius
Click three points on the circumference of the circle → frontend fits a circle through those three points (circumscribed circle math) → canvas draws the circle, labels diameter and radius. No need to find the center manually.

### Auto-detect: Edges
1. Freeze the frame (POST `/freeze`) — backend captures and stores current camera frame in `FrameStore`
2. POST `/detect-edges` with `{"threshold1": int, "threshold2": int}` → backend runs Canny on stored frame → returns PNG overlay → drawn on canvas

### Auto-detect: Circles
1. Freeze the frame (POST `/freeze`) if not already frozen
2. POST `/detect-circles` with `{"dp": float, "min_dist": int, "param1": int, "param2": int, "min_radius": int, "max_radius": int}` → returns `[{x, y, radius}]` → canvas draws each circle

If an image was loaded via `/load-image`, it is stored in `FrameStore` and used instead of a camera freeze.

### Select & Edit
A **Select** tool allows clicking on any existing annotation to select it. Selected annotations show drag handles:
- **Distance line**: drag either endpoint to reposition
- **Angle**: drag any of the three points
- **Circle**: drag the circle body to move it; drag the circumference to resize (radius changes, center stays fixed)

Measurements update live as handles are dragged. Selected annotations can be deleted with the Delete/Backspace key.

### Crosshair overlay
Toggle a persistent crosshair at canvas center. Always on top of other annotations.

### Freeze / Live toggle
Pressing **Freeze** calls POST `/freeze` (backend captures and stores the current camera frame in `FrameStore`) and simultaneously draws that frame onto the canvas, hiding the live MJPEG stream. All measurement tools and detection endpoints then operate on this stored frame. Pressing **Live** resumes the MJPEG stream underneath; annotations persist on the canvas.

### Load image
Upload a local image file → displayed in canvas area instead of the stream → all measurement tools work identically.

### Snapshot
Two distinct actions, both in the toolbar:
- **📷 Raw snapshot:** POST `/snapshot` → backend grabs the current camera frame (live or frozen), saves as timestamped JPEG to `snapshots/`, returns filename shown in sidebar.
- **🖼 Annotated export:** frontend saves the canvas (image + all drawn annotations) as a PNG using `canvas.toBlob()`, triggered client-side with no backend involvement. Downloaded to the user's browser downloads folder.

---

## Calibration State

Stored in the frontend (JavaScript). Format:

```js
calibration = {
  pixelsPerMm: 1220.5,   // always stored as px/mm regardless of user input unit
  displayUnit: "mm",     // display-only: "mm" or "µm"
  pointA: {x, y},        // canvas coordinates of calibration points
  pointB: {x, y},
  knownDistance: 1.0     // the distance the user entered, in displayUnit
}
```

`pixelsPerMm` is always the canonical value. When the user enters a distance in µm, the frontend divides by 1000 before storing. All measurement calculations use `pixelsPerMm`, then convert to `displayUnit` for display. If no calibration has been set, measurements are shown in pixels with no unit label.

Canvas coordinates used in calibration and measurements are in **canvas CSS pixels**. The canvas is sized to match the displayed stream dimensions (CSS `width`/`height` of the `<img>`), so coordinates are consistent regardless of camera native resolution. When sending coordinates to the backend (e.g. for future features), they must be scaled by `(nativeWidth / canvasWidth)` to get camera pixel coordinates.

---

## Backend API

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/stream` | — | MJPEG multipart stream |
| POST | `/freeze` | — | Capture current camera frame into FrameStore; returns `{"width": int, "height": int}` |
| POST | `/snapshot` | — | Save current camera frame to `snapshots/YYYYMMDD_HHMMSS.jpg`; returns `{"filename": str}` |
| POST | `/load-image` | multipart file | Store uploaded image in FrameStore for detection; returns `{"width": int, "height": int}` |
| POST | `/detect-edges` | `{"threshold1": int, "threshold2": int}` | Canny on FrameStore frame; returns PNG overlay as image/png |
| POST | `/detect-circles` | `{"dp": float, "min_dist": int, "param1": int, "param2": int, "min_radius": int, "max_radius": int}` | Hough circles on FrameStore frame; returns `[{"x": int, "y": int, "radius": int}]` |
| GET | `/camera/info` | — | Camera model, serial, resolution, current exposure/gain; polled once on page load |
| PUT | `/camera/exposure` | `{"value": float}` | Set exposure in microseconds |
| PUT | `/camera/gain` | `{"value": float}` | Set gain in dB |

---

## Dependencies

```
fastapi
uvicorn[standard]
opencv-python
numpy
python-multipart       # for file upload
neoapi                 # Baumer camera SDK — install from .whl provided in Baumer SDK download:
                       # pip install /path/to/neoapi-*.whl
```

FastAPI is configured with `CORSMiddleware(allow_origins=["*"])` to support LAN access from any browser without origin restrictions.

`GET /camera/info` is called once on page load to populate the sidebar camera section. It is not polled continuously; sidebar values update only when the user changes exposure or gain.

Frontend: vanilla HTML/CSS/JavaScript — no build step, no frameworks.

---

## Non-Goals (this version)

- XY stage integration (Nikon table readout — Centronics connectors, deferred)
- Multi-camera support (abstraction supports it, UI does not yet)
- Measurement persistence to disk (results shown in sidebar only, not saved to file)
- Stitching / tiled imaging
