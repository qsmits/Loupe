# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Start/stop the server:**
```bash
./server.sh start       # starts uvicorn on localhost:8000, sets GST_PLUGIN_PATH for Aravis
./server.sh stop
./server.sh restart
./server.sh status
```

**Run without a camera:**
```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

**Run tests:**
```bash
.venv/bin/pytest tests/               # all tests
.venv/bin/pytest tests/test_api.py   # single file
.venv/bin/pytest -v                   # verbose
```

## Architecture

**Stack:** FastAPI + Uvicorn backend, vanilla JS ES modules frontend (no build step, no framework). Frontend is served as static files from `/`.

### Camera Selection (main.py lifespan)
Priority order at startup:
1. `NO_CAMERA` env var or `config.json` `no_camera: true` → `NullCamera` (stub, returns blank frames)
2. Aravis (GObject Introspection) available → `AravisCamera` (GigE/USB3 Vision; uses `device_id` from config or first found)
3. Fallback → `OpenCVCamera` (index 1)
4. If open fails → `NullCamera` fallback with startup warning

**Baumer cameras require Aravis (GI), not neoapi or OpenCV.** The env var `GST_PLUGIN_PATH=/opt/homebrew/opt/aravis/lib/gstreamer-1.0` must be set (handled by `server.sh`).

### Backend Modules
- `backend/cameras/` — `BaseCamera` abstract class + `AravisCamera`, `OpenCVCamera`, `NullCamera` implementations. `CameraReader` in `stream.py` wraps any camera in a background thread (solves macOS AVFoundation thread-safety).
- `backend/vision/detection.py` — Canny edge detection, Hough circle/line detection, contour-based line detection with perpendicular NMS, partial arc detection with line-vs-arc discrimination. Configurable smoothing for textured surfaces.
- `backend/vision/guided_inspection.py` — DXF-guided corridor inspection: per-feature edge detection within ±15px corridors, RANSAC-like inlier filtering, shadow-aware edge selection, line/arc fitting with deviation computation.
- `backend/vision/line_arc_matching.py` — Legacy DXF↔detected feature matching (nearest-neighbor). Shared utility functions: `dxf_to_image_px` (coordinate projection), `perp_dist_point_to_line`.
- `backend/vision/calibration.py` — Pixel↔mm conversion math.
- `backend/vision/dxf_parser.py` — DXF → JSON geometry. Supports LINE, CIRCLE, ARC, LWPOLYLINE (decomposed into `polyline_line`/`polyline_arc` with bulge handling).
- `backend/api.py` — REST endpoints: `/stream` (MJPEG), `/freeze`, `/snapshot`, `/detect-*`, `/load-dxf`, `/cameras`, `/inspect-guided`, `/fit-feature`, `/match-dxf-lines`, `/match-dxf-arcs`.
- `backend/frame_store.py` — Thread-safe single-frame store for the "freeze" feature.
- `backend/config.py` — Atomic JSON config load/save with version-aware migration.

### Frontend (ES modules, no framework)
- `frontend/main.js` — Entry point, event wiring, mouse/keyboard handlers, undo/redo, context menu, point-pick mode.
- `frontend/state.js` — Global `state` object, undo stack, `TRANSIENT_TYPES`, `DETECTION_TYPES`.
- `frontend/render.js` — Canvas rendering with viewport transform, all annotation draw functions, DXF overlay, guided inspection result rendering, measurement labels, HUD (crosshair, zoom badge).
- `frontend/viewport.js` — Zoom/pan state, `imageToScreen`/`screenToImage` transforms, `fitToWindow`, `clampPan`.
- `frontend/tools.js` — Tool switching, `canvasPoint` (viewport-aware), hit-testing for all annotation types + DXF entities, handle drag, `handleSelectDown` (multi-select, Shift+click, drag-select rectangle).
- `frontend/dxf.js` — DXF load/align/flip/rotate, "Run Inspection" handler (calls `/inspect-guided`), per-feature tolerance popover, drag-to-translate.
- `frontend/detect.js` — Detection button handlers with busy indicators, auto-freeze, arc deduplication, slider wiring.
- `frontend/annotations.js` — Add/delete/elevate annotations, merge lines, clear operations (detections/measurements/DXF/all), `deleteSelected`.
- `frontend/session.js` — Save/load sessions (v2 format with inspection results), CSV/PDF export, auto-save to localStorage.
- `frontend/sidebar.js` — Sidebar rendering, inspection result table, camera controls, tolerance config.
- `frontend/math.js` — Geometric helpers: `fitCircle`, `fitCircleAlgebraic`, `fitLine`, `polygonArea`, `distPointToSegment`.
- `frontend/calibration.js` — Calibration dialog flow.

### Key Features
- **12 measurement tools**: Select, Distance, Angle, Circle, Fit Arc, Arc Measure, Center Dist, Para Dist, Perp Dist, Area, Pt-Circle Dist, Line Intersect, Slot Distance, Pan.
- **Multi-select**: Set-based selection, Shift+click, rectangle drag-select, bulk delete/elevate.
- **Detection elevation**: Promote auto-detected features to editable measurements. Merge multiple line segments into one.
- **Right-click context menu**: Elevate, delete, rename, merge lines, convert arc→circle, clear operations.
- **Zoom & pan**: Scroll-wheel zoom (0.5x–10x, frozen mode only), Pan tool (H key), middle-mouse pan, zoom badge, fit-to-window (0), 1:1 (1).
- **DXF-guided inspection**: Corridor-based per-feature edge detection, manual point-pick fallback with live preview, compound feature support (Shift+click to build groups), RANSAC inlier filtering, shadow-aware edge selection.
- **Session persistence**: Auto-save to localStorage (30s), restore prompt, beforeunload warning. Manual save/load as JSON (v2 format).
- **Export**: Annotated PNG, measurement CSV, inspection CSV, inspection PDF (jsPDF).

### Testing
- `tests/conftest.py` provides a `FakeCamera` fixture used across all API tests.
- Tests use `httpx` async client against a real FastAPI test app (no mocking of the HTTP layer).
- `tests/test_guided_inspection.py` — corridor detection, fitting, tolerance thresholds, manual point fitting.
- Camera hardware is never required to run tests.

### Config
`config.json` at repo root stores runtime state: `camera_id`, `no_camera`, `version`, `tolerance_warn`, `tolerance_fail`. Managed by `backend/config.py`.

### Documentation
- `docs/roadmap.md` — Product roadmap with completed and planned phases.
- `docs/superpowers/specs/` — Design specs for major features.
- `docs/superpowers/plans/` — Implementation plans for major features.
