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
.venv/bin/pytest tests/               # all backend tests
.venv/bin/pytest tests/test_api.py   # single file
.venv/bin/pytest -v                   # verbose
node --test tests/frontend/*.js       # all frontend tests (no build step)
```

## Architecture

**Stack:** FastAPI + Uvicorn backend, vanilla JS ES modules frontend (no build step, no framework). Frontend is served as static files from `/`.

### Camera Selection (main.py lifespan)
Priority order at startup:
1. `NO_CAMERA` env var or `config.json` `no_camera: true` → `NullCamera` (stub, returns blank frames)
2. `camera_id` starts with `"dc1394-"` → `Dc1394Camera` (legacy PGR IIDC/USB3 via libdc1394 ctypes)
3. `camera_id` starts with `"opencv-"` → `OpenCVCamera`
4. Aravis (GObject Introspection) available → `AravisCamera` (GigE/USB3 Vision; uses `device_id` from config or first found)
5. No Aravis + dc1394 available → first `Dc1394Camera`
6. Fallback → `OpenCVCamera` (index 1)
7. If open fails → `NullCamera` fallback with startup warning

**Baumer cameras require Aravis (GI), not neoapi or OpenCV.** The env var `GST_PLUGIN_PATH=/opt/homebrew/opt/aravis/lib/gstreamer-1.0` must be set (handled by `server.sh`).

**Legacy Point Grey USB3 cameras** (Grasshopper3 GS3-U3, Flea3 FL3-U3) are supported via a custom-patched `libdc1394` build at `/Users/qsmits/.local/libdc1394-usb/`. These cameras use the pre-USB3-Vision PGR Protocol and don't work with Aravis or Spinnaker 4.x on macOS. **Requires running the server with sudo** (`sudo ./server.sh start`) because macOS's IOKit blocks userspace USB interface claims for vendor-specific class devices. The library path can be overridden with the `DC1394_LIB_PATH` env var. Continuous streaming uses the multi-shot-255 re-arm trick (re-armed every 5 s by a background thread) because the standard IIDC iso_enable register does not engage free-run on this firmware.

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

### Frontend (ES modules; vendored Preact/htm shell, no build step)
- `frontend/main.js` — Entry point, event wiring, mouse/keyboard handlers, undo/redo, context menu, point-pick mode.
- `frontend/state.js` — Global `state` object, undo stack, `TRANSIENT_TYPES`, `DETECTION_TYPES`.
- `frontend/render.js` — Canvas rendering with viewport transform, all annotation draw functions, DXF overlay, guided inspection result rendering, measurement labels, HUD (crosshair, zoom badge).
- `frontend/viewport.js` — Zoom/pan state, `imageToScreen`/`screenToImage` transforms, `fitToWindow`, `clampPan`.
- `frontend/tools.js` — Tool switching, `canvasPoint` (viewport-aware), hit-testing for all annotation types + DXF entities, handle drag, `handleSelectDown` (multi-select, Shift+click, drag-select rectangle).
- `frontend/dxf.js` — DXF load/align/flip/rotate, "Run Inspection" handler (calls `/inspect-guided`), per-feature tolerance popover, drag-to-translate.
- `frontend/detect.js` — Detection button handlers with busy indicators, auto-freeze, arc deduplication, slider wiring.
- `frontend/annotations.js` — Add/delete/elevate annotations, merge lines, clear operations (detections/measurements/DXF/all), `deleteSelected`.
- `frontend/session.js` — Manual JSON session export/import (v3 format) and PNG/CSV/DXF export; day-to-day persistence now lives in the projects model below.
- `frontend/sidebar.js` — Sidebar rendering, inspection result table, camera controls, tolerance config.
- `frontend/math.js` — Geometric helpers: `fitCircle`, `fitCircleAlgebraic`, `fitLine`, `polygonArea`, `distPointToSegment`.
- `frontend/workspace.js` — Swap-on-activate workspace state for project tabs: `serializeWorkspace`/`restoreWorkspace`, the `STATE_FIELDS` swapped/transient/global classification, `state._epoch` staleness guard. See "Projects & tabs" below.
- `frontend/project-format.js` — Pure codecs: in-memory tab record ↔ workspace v4 (JSON) ↔ `.loupe` file (JSON + data-URL image); `migrateV3ToV4` for legacy session import.
- `frontend/projects-db.js` — The ONLY persistence layer: browser-local IndexedDB (`loupe` DB, `projects` store), with an in-memory fallback + `onStorageUnavailable`/`isPersistent` when IndexedDB is unavailable.
- `frontend/tab-manager.js` — Typed project tabs over the singleton engine: open/activate/close, swap-on-activate, singleton rules for deflectometry/fringe, ~2s dirty-poll autosave, per-tab `X-Session-ID`.
- `frontend/shell.js` — Preact/htm app bar (tab strip) and overlay layer: modal `showNotice`, `showToast`; re-renders on `workspace-changed`/`tool-changed`.
- `frontend/toolbar.js` — Flat row-2 microscopy toolbar (Preact): every tool as icon+text, contextual sub-mode segment, Calibrate/Origin/Undo/Redo.
- `frontend/home-screen.js` — Preact home screen: new-project type cards, IndexedDB-only recents grid, import drop zone.
- `frontend/project-io.js` — `.loupe` export/import, plain-image and v3-session import, legacy `microscope-autosave` migration offer, global `.loupe` drag-in.
- `frontend/vendor/` — Vendored `preact.mjs` + `htm.mjs` (plain ES module imports, no npm/bundler).
- Calibration flow lives in `tools.js` (`handleToolClick` calibrate branch) + `annotations.js` (`applyCalibration`, `recalibrateFromAnnotation`); pure scale math in `math.js::calibrationPixelsPerMm`.

### Key Features
- **13 tools on a flat row-2 toolbar** (`frontend/toolbar.js`, no flyouts/hidden tools): Select, Pan, Note, Distance, Angle, Circle, Best fit (circle/arc), Arc, Area, Shape (area-from-shape), Spline, Flatness, Point — plus dedicated Calibrate/Origin buttons and Undo/Redo. Contextual sub-mode segments (e.g. Circle → 3-point/Center+edge, Best fit → Circle/Arc) show inline for the active tool.
- **Multi-select**: Set-based selection, Shift+click, rectangle drag-select, bulk delete/elevate.
- **Detection elevation**: Promote auto-detected features to editable measurements. Merge multiple line segments into one.
- **Right-click context menu**: Elevate, delete, rename, merge lines, group, convert arc→circle, Punch/Die toggle, clear operations.
- **Measurement grouping**: Named groups with uniform color, collapsible sidebar sections.
- **Zoom & pan**: Scroll-wheel zoom (frozen mode only), Pan tool (H key), middle-mouse pan, zoom badge with preset dropdown, minimap, measurement grid.
- **DXF auto-alignment**: Edge-based template matching (no circles required), with angle refinement and rotation bias penalty. Also supports circle-based RANSAC alignment.
- **DXF-guided inspection**: Corridor-based per-feature edge detection, manual point-pick with compound features, RANSAC inlier filtering, shadow-aware edge selection, Punch/Die tolerance tagging.
- **Draggable labels**: Deviation labels can be repositioned with leader lines. Hover tooltips with full feature detail.
- **Grouped inspection results**: Sidebar groups results by compound feature with collapsible headers, worst-case badges, Punch/Die indicators, numbered cross-references to canvas and PDF.
- **Projects & persistence**: Autosave to browser-local IndexedDB every ~2s while dirty (plus flush on tab switch / `beforeunload`); `.loupe` export/import round-trips image + measurements + calibration + viewport; legacy v3 session JSON is still importable (adopted as a new project); the open-tab set is restored on refresh. See "Projects & tabs" below.
- **Sidebar**: Detections separated from measurements with elevate ↑ button, grouped inspection results with Punch/Die badges, resizable.
- **Export**: Annotated PNG, measurement CSV, inspection CSV, inspection PDF (jsPDF), **DXF export** (reverse engineering — measurements to DXF in mm).

### Projects & tabs
- **Typed projects**: `microscopy` is multi-tab (any number open at once); `deflectometry` and `fringe` are singleton types — only one tab of each may be open, and opening a second prompts "Close & open" (swap confirmation via `shell.js::showNotice`).
- **Swap-on-activate** (`frontend/workspace.js`): the app's singleton `state`/viewport/undo-redo stacks always describe the ACTIVE tab only. Switching tabs serializes the outgoing tab's workspace and restores the incoming one. Every key of `state` must be classified in `STATE_FIELDS` as `swapped` (travels with the tab), `transient` (reset on every restore), or `global` (untouched by tab switches) — enforced by the swap-completeness gate in `tests/frontend/test_workspace.js`. **A new `state` field added without classifying it there fails that test.**
- **`state._epoch` staleness rule**: `restoreWorkspace()` bumps `state._epoch` before anything else. Any async handler that captures `captureEpoch()` before an awaited server call must check `isStale(epoch)` before applying its result, so a slow response from a since-deactivated tab can't land in the wrong tab. Dropped results log `console.debug("[epoch] stale result dropped: <label>")`.
- **Per-tab server sessions**: `X-Session-ID` (`frontend/api.js`) is the active project's UUID, registered via `tab-manager.js`'s `setSessionIdProvider`. The server only holds transient, TTL'd per-session frames; if a frame has expired or the project was just restored from IndexedDB, `apiFetchFrame()` silently re-uploads the stored frame Blob via `/load-image` and retries once — no "No frame stored" error should ever reach the user.
- **Hard rule: no server-side project storage.** `frontend/projects-db.js` is the ONLY persistence layer (browser-local IndexedDB); the server never stores, lists, or has any notion of "a project". This is what keeps hosted multi-user instances from leaking data between users — the home screen's recents grid reads IndexedDB only.

### Coordinate frames — read this before touching DXF, overlays, or gear code

**Three frames coexist and they disagree about Y:**

1. **Image / canvas frame** — `x` right, `y` down. Pixel coords. Angles measured as `atan2(y - cy, x - cx)` sweep visually clockwise.
2. **DXF-math frame** — `x` right, `y` up. All DXF entity coords and gear-geometry generators (`generate_cycloidal_gear`, `generate_involute_gear`) live here. Rotations are applied as math-CCW: `x' = x·cosφ − y·sinφ, y' = x·sinφ + y·cosφ`.
3. **Image-sampling frame** — used by any code that does `cx + r·cos θ, cy + r·sin θ` to sample an image along a circle (`analyze_gear`, `gear_phase._sample_circle`). This is numerically the image frame, but the parameterization matches DXF-math angles, so it's a trap: same formula, opposite handedness.

**The Y-flip lives in exactly two places — and nowhere else:**
- `frontend/dxf-transform.js::dxfToCanvasPure` — `cy = -yr * scale` (re-exported as `render-dxf.js::dxfToCanvas`; `applyDxfCtm` builds its canvas transform from the same module, so the two cannot drift)
- `backend/vision/line_arc_matching.py::dxf_to_image_px` — `my = -(cx·sinφ + cy·cosφ) + ty`

Both take DXF-math coords and emit image/canvas coords. `inspect_features`, the DXF overlay renderer, and any alignment code that uses these helpers are in agreement.

**The trap:** if you write new code that rasterizes a DXF-generated polygon into an image buffer, or samples an image in a DXF-math-looking parameterization, you must Y-flip (or negate your rotation result) to stay consistent with (1) and (2). Rules of thumb:

- A DXF rotation `φ` (math-CCW) displays in the canvas as a **visual CCW rotation** by `φ`. Equivalently: visual angle `= -dxf angle`.
- `analyze_gear` returns tooth angles in the **image frame** (already canvas-visual). You can plot them directly as `cx + r·cos α, cy + r·sin α`. You **cannot** feed them to `/generate-gear-dxf` as `rotation_deg` without negating — the DXF generator will rotate math-CCW and then the renderer will Y-flip, putting the tooth at visual angle `-α`.
- If you rasterize a synth DXF polygon to a mask for DFT/template matching (like `gear_phase.py` does), **Y-flip when you rasterize** — otherwise your algorithm operates in a frame the renderer doesn't use, and the rotation you compute will be mirrored by 2× the true angle when it reaches the canvas. This is an **incredibly recurring bug** in this codebase. See `gear_phase.estimate_gear_phase` docstring "Frame note" for the cautionary tale.
- Gears are mirror-symmetric about each tooth axis, which masks Y-flip sign bugs for a single tooth but not across rotations — the mismatch manifests as "works after a manual nudge within one pitch" instead of obviously failing.

When in doubt, render the output of your new code as a colored overlay on top of the real image alongside `analyze_gear` results (which are known correct). If the overlay and the analyze-gear markers don't agree, you have a frame mismatch, not a magnitude error.

### Testing
- `tests/conftest.py` provides a `FakeCamera` fixture used across all API tests.
- Tests use `httpx` async client against a real FastAPI test app (no mocking of the HTTP layer).
- `tests/test_guided_inspection.py` — corridor detection, fitting, tolerance thresholds, manual point fitting.
- Camera hardware is never required to run tests.
- `node --test tests/frontend/*.js` — frontend unit tests via Node's built-in test runner (no build step): the workspace swap-completeness gate, project-format codecs, projects-db (IndexedDB + in-memory fallback), tab-manager lifecycle (open/activate/close, autosave, singleton rules), toolbar, home screen, and other DOM-stub-driven pure-logic suites. `frontend/main.js` itself is a plain wiring script with no exports and is not unit-tested — its DOM-coupled behavior is covered by manual verification instead.

### Config
`config.json` at repo root stores runtime state: `camera_id`, `no_camera`, `version`, `tolerance_warn`, `tolerance_fail`. Managed by `backend/config.py`.

### Documentation
Working notes, design specs, plans, and roadmap live in `docs/` locally
but are gitignored — not part of the repo.
