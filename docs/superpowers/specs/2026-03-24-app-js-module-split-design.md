# app.js Module Split Design

**Date:** 2026-03-24
**Status:** Approved

## Context

`frontend/app.js` is a 3,541-line vanilla JS monolith with 47 section headers. It is the only JS file in the project. As the codebase grows toward M3 and M4, the file size makes navigation, review, and targeted edits increasingly painful. The goal is to split it into native ES modules — no build step, no framework — maintaining identical runtime behavior.

The project constraint is no build step: the frontend must remain deployable by dropping files onto a lab machine. Native ES modules (supported in all modern browsers) satisfy this without adding tooling.

---

## Module Boundaries

The split produces 10 files. The dependency graph is a strict DAG (no circular imports):

```
state.js        math.js
    │                │
    └──────┬─────────┘
           ▼
        render.js
           │
           ▼
     annotations.js
           │
      ┌────┴────────────┐
      ▼                 ▼
   sidebar.js    (also → render.js)
      │
      ├──────────────────────────────────┐
      ▼           ▼           ▼          ▼
   tools.js    dxf.js    detect.js  session.js
      │           │           │          │
      └───────────┴───────────┴──────────┘
                          ▼
                       main.js
```

(`sidebar.js` has a direct edge to `render.js` in addition to `annotations.js`.)

---

### `frontend/state.js` (~80 lines)

**Responsibility:** Central application state, undo stack, and shared flags.

**Exports:**
- `state` — the mutable singleton object. Four bare `let` module-level variables from app.js are folded into `state` as properties to make them accessible across modules without extra exports:
  - `state._originMode` (was `_originMode`, written by origin button handler in main.js, read in onMouseDown)
  - `state._dxfOriginMode` (was `_dxfOriginMode`, written by dxf.js, read in onMouseDown)
  - `state._noCamera` (was `_noCamera`, written by `loadCameraInfo` in sidebar.js, read by drag-drop handlers and `updateFreezeUI` in main.js)
  - `state.frozenBackground` (was already on state but must be explicitly documented; holds an `ImageBitmap` when frame is frozen)
  - All existing references are updated to the `state.*` form — a mechanical rename.
- `undoStack`, `redoStack` — arrays exported by reference
- `takeSnapshot()` — serializes current state to a string
- `pushUndo()` — pushes current snapshot onto `undoStack`, clears `redoStack`
- `TOOL_STATUS` — maps tool name → instructional string
- `TRANSIENT_TYPES` — Set of annotation types excluded from session JSON (currently defined near line 3062 in app.js; moved here)
- `_deviationHitBoxes` — array exported by reference; populated by `drawDeviations` in `render.js`, read in `main.js` for canvas click hit-testing

**Does NOT export `undo`/`redo`:** both functions call `renderSidebar()` and `redraw()`, so they belong in `main.js` where those are already imported.

**Imports:** none.

---

### `frontend/math.js` (~100 lines)

**Responsibility:** Pure geometry functions with no DOM or state dependencies.

**Exports:**
- `parseDistanceInput(str)` — parses "5.000 mm" or "200 µm" → `{value, unit}` or null
- `fitCircle(p1, p2, p3)` — circumscribed circle through exactly 3 points (existing name in app.js)
- `fitCircleAlgebraic(points)` — algebraic least-squares circle fit for N ≥ 3 points
- `polygonArea(pts)` — shoelace area of a polygon
- `lineAngleDeg(ann)` — returns the angle of a line-like annotation in degrees

**Imports:** none.

---

### `frontend/render.js` (~1000 lines)

**Responsibility:** Canvas rendering — all draw functions, `redraw`, canvas sizing, DOM element refs, and `showStatus`.

**New function `showStatus(msg)`:** Throughout app.js, status updates are inline `statusEl.textContent = "..."` calls scattered across many sections. During the split, these are all replaced by a `showStatus(msg)` helper defined in `render.js` and imported by other modules. This includes the call in `setTool` (line 104) and every `statusEl.textContent` assignment elsewhere.

Note: app.js already contains 9 calls to `showStatus(...)` (in `loadSession` and detect handlers) with no corresponding function definition — these are a pre-existing bug. The split fixes this by defining `showStatus` in `render.js`.

**Exports:**
- DOM refs: `img`, `canvas`, `ctx`, `statusEl`, `listEl`, `cameraInfoEl`
- `resizeCanvas()` — repositions and resizes overlay canvas to match image
- `redraw()` — clears canvas, calls `drawAnnotations`, `drawPendingPoints`, snap indicator, arc-fit preview (inline in `redraw`), crosshair, DXF alignment indicators
- `drawAnnotations()` — dispatches to per-type draw functions
- `showStatus(msg)` — sets `statusEl.textContent`
- `measurementLabel(ann)` — formats an annotation into a human-readable label string; used internally by draw functions and also imported by `sidebar.js` and `session.js`
- `drawLine`, `drawHandle`, `drawLabel` — internal canvas helpers (exported so `dxf.js` can use them for DXF entity rendering if needed)
- Per-annotation draw functions: `drawDistance`, `drawAngle`, `drawCircle`, `drawArcMeasure`, `drawPerpDist`, `drawParaDist`, `drawParallelism`, `drawArea`, `drawPtCircleDist`, `drawIntersect`, `drawSlotDist`, `drawCalibration`, `drawOrigin`, `drawCrosshair`, `drawPendingPoints`
- `drawEdgesOverlay`, `drawPreprocessedOverlay`, `drawDetectedCircle`, `drawDetectedLine` — draw functions for detection overlays
- `drawAreaPreview(points, previewPt)` — draws the in-progress area polygon preview during point collection; called from the `mousemove` handler in `main.js`
- `dxfToCanvas(dxfX, dxfY, ann)` — converts DXF coordinates to canvas coordinates given a DXF overlay annotation; used by `collectDxfSnapPoints` in `tools.js` and match logic in `dxf.js`
- `drawDxfOverlay(ann, sel)` — renders DXF entity overlays (lines, arcs, circles) including deviation callouts
- `drawDeviations(ann)` — renders per-feature deviation callouts; populates `_deviationHitBoxes` (imported from `state.js`)
- `deviationColor(delta_mm, handle)` — returns CSS color string for a deviation value

**Imports:** `state`, `_deviationHitBoxes` from `state.js`; `fitCircleAlgebraic` from `math.js`.

**Note:** `render.js` does not import from `annotations.js`, `dxf.js`, `detect.js`, or `sidebar.js`. It reads `state.annotations` directly. This keeps the DAG acyclic.

---

### `frontend/annotations.js` (~230 lines)

**Responsibility:** Mutation of the annotations list with undo integration.

**Exports:**
- `addAnnotation(data)` — pushes undo snapshot, assigns next ID, appends to `state.annotations`, sets `state.selected`, calls `renderSidebar()`. Does **not** call `redraw()` — callers are responsible for that, matching the existing app.js behavior.
- `deleteAnnotation(id)` — pushes undo, removes from list, cleans up side-effects (nulls calibration, hides dxf-panel, clears origin); calls `renderSidebar()` and `redraw()`.
- `applyCalibration(ann)` — pushes undo, recomputes `state.calibration`, auto-updates DXF scale input, calls `addAnnotation`, then calls `updateCameraInfo()` and `updateCalibrationButton()`.

**Imports:** `state`, `pushUndo` from `state.js`; `redraw` from `render.js`; `renderSidebar`, `updateCameraInfo`, `updateCalibrationButton` from `sidebar.js`.

**Cycle note:** `annotations.js` imports `renderSidebar` from `sidebar.js`. `sidebar.js` does NOT import from `annotations.js`. This is safe because all `.del-btn` click handlers are moved out of `renderSidebar` and wired via event delegation in `main.js` (see main.js section). `renderSidebar` retains its inline row-click handler (for selection + redraw) which only calls `state`, `renderSidebar` itself, and `redraw` — no reference to `deleteAnnotation`.

---

### `frontend/sidebar.js` (~300 lines)

**Responsibility:** Sidebar DOM rendering, camera info, calibration button, and tolerances UI.

**Exports:**
- `renderSidebar()` — rebuilds `#measurement-list` DOM from `state.annotations`. Row-click handlers for selection are inline (they only reference `state`, `renderSidebar`, and `redraw`). Delete buttons (`data-id="…"`) are rendered without inline click listeners — wired via event delegation in `main.js`.
- `updateCameraInfo()` — refreshes the calibration scale display in the sidebar
- `loadCameraInfo()` — fetches `/cameras/info`, populates the camera info panel, sets `_noCamera` flag
- `loadCameraList()` — fetches `/cameras`, populates the camera-select dropdown
- `loadTolerances()` — fetches `/config/tolerances`, populates `state.tolerances`
- `loadUiConfig()` — fetches `/config/ui`, applies settings to `state.settings`
- `updateCalibrationButton()` — toggles active state of the calibration button
- `updateDxfControlsVisibility()` — shows/hides DXF-specific panel controls
- `updateFreezeUI()` — updates the freeze/live button label and icon
- `checkStartupWarning()` — checks if `NO_CAMERA` is set and shows the warning banner

**Imports:** `state` from `state.js`; `redraw`, `showStatus`, `measurementLabel` from `render.js`.

**No import from `annotations.js`.**

---

### `frontend/tools.js` (~500 lines)

**Responsibility:** Tool switching, tool click handling, snap logic, and canvas mouse-event helpers.

**Exports:**
- `setTool(name)` — updates `state.tool`, clears pending state, updates tool-strip active classes, calls `showStatus`
- `handleToolClick(rawPt, e)` — dispatches to per-tool logic; calls `addAnnotation`, `redraw`, `snapPoint`
- `handleSelectDown(pt, e)` — handles mouse-down in select mode; hit-tests annotation handles and bodies, sets `state.dragState`, calls `renderSidebar`/`redraw`
- `hitTestHandle(ann, pt)` — returns the handle key if `pt` is within grab radius of an annotation handle
- `hitTestAnnotation(ann, pt)` — returns true if `pt` is within click distance of an annotation
- `getHandles(ann)` — returns the draggable handle points for an annotation (e.g. endpoints, center)
- `snapPoint(rawPt, bypass)` — returns `{pt, label}` with optional snap; reads `state.annotations`
- `findSnapLine(pt)` — finds nearest line annotation for angular snap
- `snapToCircle(pt)` — finds nearest circle annotation within snap radius
- `getLineEndpoints(ann)` — returns `{a, b}` endpoint pair in canvas coords for any line-like annotation
- `projectConstrained(rawPt, a, refAnn, perp)` — projects rawPt perpendicular or parallel to a reference annotation
- `canvasPoint(e)` — converts a mouse event to canvas coordinates
- `collectDxfSnapPoints(ann)` — returns array of DXF snap points for alignment mode

**Imports:** `state`, `TOOL_STATUS` from `state.js`; `redraw`, `canvas`, `ctx`, `showStatus` from `render.js`; `addAnnotation`, `applyCalibration` from `annotations.js`; `fitCircle`, `fitCircleAlgebraic`, `parseDistanceInput`, `polygonArea` from `math.js`.

---

### `frontend/dxf.js` (~420 lines)

**Responsibility:** DXF overlay load, transform controls, manual alignment, RANSAC auto-align, per-feature tolerance popover.

**Exports:**
- `enterDxfAlignMode()`, `exitDxfAlignMode()` — manage `state.dxfAlignMode`; write `state._dxfOriginMode`
- `initDxfHandlers()` — wires all DXF-related event listeners (btn-load-dxf, dxf-input change, dxf-scale, btn-dxf-set-origin, flip/rotate buttons, btn-align-dxf, etc.); called once from `main.js`
- `openFeatureTolPopover(handle, screenX, screenY)` — shows the per-feature tolerance popover (name matches existing app.js function at line 2899)

**Imports:** `state` from `state.js`; `redraw`, `canvas`, `showStatus` from `render.js`; `addAnnotation` from `annotations.js`; `renderSidebar`, `updateDxfControlsVisibility` from `sidebar.js`.

---

### `frontend/detect.js` (~200 lines)

**Responsibility:** Detection fetch handlers for edges, preprocessed view, circles, lines (merged), and partial arcs.

**Exports:**
- `doFreeze()` — captures the current stream frame into `state.frozenBackground` and sets `state.frozen = true`; exported so `main.js` can call it from the freeze toggle handler
- `ensureFrozen()` — freezes the current frame if not already frozen; returns a promise
- `initDetectHandlers()` — wires all detect button event listeners (btn-run-edges, btn-show-preprocessed, btn-run-circles, btn-run-lines, btn-detect-lines-merged, btn-detect-arcs-partial, plus slider input handlers); called once from `main.js`

**Imports:** `state` from `state.js`; `redraw`, `showStatus`, `img`, `canvas` from `render.js`; `addAnnotation` from `annotations.js`.

---

### `frontend/session.js` (~220 lines)

**Responsibility:** Session persistence and export.

The annotated image export and CSV export are currently inline `addEventListener` callbacks in app.js. During the split, they are extracted into named functions. This is the only other new named function addition besides `showStatus`.

**Exports:**
- `saveSession()` — serializes non-transient annotations + calibration + featureTolerances to JSON and triggers download
- `loadSession(raw)` — parses and validates session JSON, restores `state`, calls `renderSidebar()` + `redraw()`
- `exportAnnotatedImage()` — extracted from the inline `btn-export` handler; composites canvas overlay onto stream image and downloads as PNG
- `exportCsv()` — extracted from the inline `btn-export-csv` handler; builds CSV from current measurements using `measurementLabel` and `formatCsvValue`, and downloads. `formatCsvValue` is an internal helper (not exported).

**Imports:** `state`, `TRANSIENT_TYPES` from `state.js`; `redraw`, `canvas`, `img`, `showStatus`, `measurementLabel` from `render.js`; `renderSidebar` from `sidebar.js`.

---

### `frontend/main.js` (~400 lines)

**Responsibility:** Entry point. Imports all modules, wires all top-level event listeners, and runs init.

**Defines `undo()` and `redo()`** locally (not exported), since they need `renderSidebar` and `redraw` which are available here. Keyboard handler (Ctrl+Z / Ctrl+Y) calls them directly.

**Wires:**
- Tool strip buttons (`#tool-strip .strip-btn[data-tool]`) → `setTool`
- Undo/redo keyboard shortcuts → local `undo`/`redo`
- Canvas `mousedown` / `mouseup` / `mousemove` — reads `state._dxfOriginMode`, `state._originMode`, `state.dxfAlignMode` and dispatches to `handleToolClick`, DXF alignment logic, origin placement
- Canvas click → deviation hit-test using `_deviationHitBoxes`
- Event delegation on `#measurement-list` for `.del-btn` clicks → `deleteAnnotation`
- Freeze/live toggle button → freeze fetch + `updateFreezeUI`
- Load image (file input, drag-drop) → `img.src` update
- Save session → `saveSession`; load session (file input) → `loadSession`
- Clear button → clear annotations
- Export PNG → `exportAnnotatedImage`; Export CSV → `exportCsv`
- `initDxfHandlers()` from `dxf.js`
- `initDetectHandlers()` from `detect.js`
- Settings dialog open/close, camera settings (white balance, pixel format, camera select) → `loadCameraInfo`, `loadCameraList`
- Help dialog open/close
- Dropdown menu wiring (`btn-menu-measure`, `btn-menu-detect`, `btn-menu-overlay`)
- Overflow popup
- Coordinate origin button → `state._originMode` toggle
- Camera section collapse/expand
- Init sequence: wire `new ResizeObserver(resizeCanvas).observe(img)`, `img.addEventListener("load", resizeCanvas)`, `window.addEventListener("resize", resizeCanvas)`, then call `loadCameraInfo()`, `loadUiConfig()`, `loadTolerances()`, `updateCalibrationButton()`, `checkStartupWarning()`, `resizeCanvas()`, `updateFreezeUI()`

**`index.html` change:** `<script src="app.js">` → `<script type="module" src="main.js">`

**Module evaluation order:** `<script type="module">` is automatically deferred by browsers — module bodies execute after the DOM is fully parsed. No `DOMContentLoaded` guard is needed.

**Imports:** all modules.

---

## Migration Strategy

The split is purely mechanical — no logic changes, no new features. The only adjustments are:

1. `showStatus(msg)` — new thin wrapper around `statusEl.textContent = msg` replacing every inline `statusEl.textContent = ...` use (including in `setTool`). Also fixes a pre-existing bug: app.js already calls `showStatus(...)` in 9 places (loadSession, detect handlers) with no definition.
2. `exportAnnotatedImage()`, `exportCsv()` — extracted from inline `addEventListener` callbacks into named functions.
3. `renderSidebar` delete-button wiring — moved from inline per-row `addEventListener` to event delegation on `#measurement-list` in `main.js`. Observable behavior is identical.
4. `undo`/`redo` moved to `main.js` — where they are already invoked from keyboard handlers.
5. `_originMode`, `_dxfOriginMode`, `_noCamera` become `state._originMode`, `state._dxfOriginMode`, `state._noCamera` — mechanical rename.
6. `TRANSIENT_TYPES` moves from line 3062 to `state.js` — mechanical move.
7. `_deviationHitBoxes` reset in `drawDeviations` — change `_deviationHitBoxes = []` (bare reassignment that would break the shared array reference) to `_deviationHitBoxes.length = 0; _deviationHitBoxes.splice(0)` (in-place mutation) so all importers see the updated array through the shared reference.

**Steps:**
1. Create all new module files with correct imports/exports.
2. Change `index.html`: `<script src="app.js">` → `<script type="module" src="main.js">`.
3. Keep `app.js` on disk. Run smoke-test checklist.
4. Delete `app.js` only after all smoke tests pass.

**Rollback:** Revert `index.html` to `<script src="app.js">` and delete the new module files. Or `git revert` the commit.

**Smoke-test checklist:**
- Tool switching works (select, distance, circle, calibrate, arc-fit, etc.)
- Calibration: 2-point flow and circle flow
- Distance / angle / circle: add, select, delete via sidebar button
- Undo / redo with Ctrl+Z / Ctrl+Y
- Session save → reload restores annotations and calibration
- DXF load → RANSAC auto-align → deviation callouts visible
- Per-feature tolerance popover opens and saves
- Detect circles → detected circles appear on overlay
- Detect lines (merged) and partial arcs → appear on overlay
- Export PNG, Export CSV

---

## Non-Goals

- No new features are added during the split.
- No logic changes beyond the six mechanical adjustments listed in the migration section.
- No TypeScript, no build step, no linting configuration changes.
- No frontend unit tests added (out of scope).
- No SolidJS or framework migration (deferred until after M4).
