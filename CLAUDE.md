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
- `backend/vision/dxf_parser.py` — DXF → JSON geometry with layer names. Supports LINE, CIRCLE, ARC, LWPOLYLINE (decomposed into `polyline_line`/`polyline_arc` with bulge handling).
- `backend/vision/dxf_export.py` — Measurements → DXF export for reverse engineering. Converts pixel annotations to mm-space DXF entities.
- `backend/vision/alignment.py` — Circle-based (RANSAC) and edge-based (template matching) DXF auto-alignment.
- `backend/api.py` — REST endpoints: `/stream` (MJPEG), `/freeze`, `/snapshot`, `/detect-*`, `/load-dxf`, `/export-dxf`, `/align-dxf`, `/align-dxf-edges`, `/cameras`, `/inspect-guided`, `/fit-feature`.
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
- `frontend/session.js` — Save/load sessions (v2 format with inspection results), CSV/PDF/DXF export, auto-save to localStorage.
- `frontend/sidebar.js` — Sidebar rendering, inspection result table, camera controls, tolerance config.
- `frontend/math.js` — Geometric helpers: `fitCircle`, `fitCircleAlgebraic`, `fitLine`, `polygonArea`, `distPointToSegment`.
- `frontend/calibration.js` — Calibration dialog flow.

### Key Features
- **14 measurement tools**: Select, Distance, Angle, Circle, Fit Arc, Arc Measure, Center Dist, Para Dist, Perp Dist, Area, Pt-Circle Dist, Line Intersect, Slot Distance, Pan.
- **Multi-select**: Set-based selection, Shift+click, rectangle drag-select, bulk delete/elevate.
- **Detection elevation**: Promote auto-detected features to editable measurements. Merge multiple line segments into one.
- **Right-click context menu**: Elevate, delete, rename, merge lines, group, convert arc→circle, Punch/Die toggle, clear operations.
- **Measurement grouping**: Named groups with uniform color, collapsible sidebar sections.
- **Zoom & pan**: Scroll-wheel zoom (frozen mode only), Pan tool (H key), middle-mouse pan, zoom badge with preset dropdown, minimap, measurement grid.
- **DXF auto-alignment**: Edge-based template matching (no circles required), with angle refinement and rotation bias penalty. Also supports circle-based RANSAC alignment.
- **DXF-guided inspection**: Corridor-based per-feature edge detection, manual point-pick with compound features, RANSAC inlier filtering, shadow-aware edge selection, Punch/Die tolerance tagging.
- **Draggable labels**: Deviation labels can be repositioned with leader lines. Hover tooltips with full feature detail.
- **Grouped inspection results**: Sidebar groups results by compound feature with collapsible headers, worst-case badges, Punch/Die indicators, numbered cross-references to canvas and PDF.
- **Session persistence**: Auto-save to localStorage (30s), restore prompt, beforeunload warning. Manual save/load as JSON (v2 format).
- **Sidebar**: Detections separated from measurements with elevate ↑ button, grouped inspection results with Punch/Die badges, resizable.
- **Export**: Annotated PNG, measurement CSV, inspection CSV, inspection PDF (jsPDF), **DXF export** (reverse engineering — measurements to DXF in mm).

### Coordinate frames — read this before touching DXF, overlays, or gear code

**Three frames coexist and they disagree about Y:**

1. **Image / canvas frame** — `x` right, `y` down. Pixel coords. Angles measured as `atan2(y - cy, x - cx)` sweep visually clockwise.
2. **DXF-math frame** — `x` right, `y` up. All DXF entity coords and gear-geometry generators (`generate_cycloidal_gear`, `generate_involute_gear`) live here. Rotations are applied as math-CCW: `x' = x·cosφ − y·sinφ, y' = x·sinφ + y·cosφ`.
3. **Image-sampling frame** — used by any code that does `cx + r·cos θ, cy + r·sin θ` to sample an image along a circle (`analyze_gear`, `gear_phase._sample_circle`). This is numerically the image frame, but the parameterization matches DXF-math angles, so it's a trap: same formula, opposite handedness.

**The Y-flip lives in exactly two places — and nowhere else:**
- `frontend/render-dxf.js::dxfToCanvas` — `cy = -yr * scale`
- `backend/vision/line_arc_matching.py::dxf_to_image_px` — `my = -(cx·sinφ + cy·cosφ) + ty`

Both take DXF-math coords and emit image/canvas coords. `inspect_features`, the DXF overlay renderer, and any alignment code that uses these helpers are in agreement.

**The trap:** if you write new code that rasterizes a DXF-generated polygon into an image buffer, or samples an image in a DXF-math-looking parameterization, you must Y-flip (or negate your rotation result) to stay consistent with (1) and (2). Rules of thumb:

- A DXF rotation `φ` (math-CCW) displays in the canvas as a **visual CW rotation** by `φ`. Equivalently: visual angle `= -dxf angle`.
- `analyze_gear` returns tooth angles in the **image frame** (already canvas-visual). You can plot them directly as `cx + r·cos α, cy + r·sin α`. You **cannot** feed them to `/generate-gear-dxf` as `rotation_deg` without negating — the DXF generator will rotate math-CCW and then the renderer will Y-flip, putting the tooth at visual angle `-α`.
- If you rasterize a synth DXF polygon to a mask for DFT/template matching (like `gear_phase.py` does), **Y-flip when you rasterize** — otherwise your algorithm operates in a frame the renderer doesn't use, and the rotation you compute will be mirrored by 2× the true angle when it reaches the canvas. This is an **incredibly recurring bug** in this codebase. See `gear_phase.estimate_gear_phase` docstring "Frame note" for the cautionary tale.
- Gears are mirror-symmetric about each tooth axis, which masks Y-flip sign bugs for a single tooth but not across rotations — the mismatch manifests as "works after a manual nudge within one pitch" instead of obviously failing.

When in doubt, render the output of your new code as a colored overlay on top of the real image alongside `analyze_gear` results (which are known correct). If the overlay and the analyze-gear markers don't agree, you have a frame mismatch, not a magnitude error.

### Testing
- `tests/conftest.py` provides a `FakeCamera` fixture used across all API tests.
- Tests use `httpx` async client against a real FastAPI test app (no mocking of the HTTP layer).
- `tests/test_guided_inspection.py` — corridor detection, fitting, tolerance thresholds, manual point fitting.
- Camera hardware is never required to run tests.

### Config
`config.json` at repo root stores runtime state: `camera_id`, `no_camera`, `version`, `tolerance_warn`, `tolerance_fail`. Managed by `backend/config.py`.

### Documentation
Working notes, design specs, plans, and roadmap live in `docs/` locally
but are gitignored — not part of the repo.
