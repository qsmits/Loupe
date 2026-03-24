# app.js ES Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `frontend/app.js` (3,541 lines) into 10 native ES modules with identical runtime behavior and no build step.

**Architecture:** Each module is created as a new `.js` file with `export`/`import` statements. `app.js` remains untouched until all modules pass the smoke test, then `index.html` is switched from `<script src="app.js">` to `<script type="module" src="main.js">` and `app.js` is deleted. Since this is a refactor with no new logic, there are no backend tests to write — verification is done via a manual smoke-test checklist after switching to modules.

**Tech Stack:** Vanilla JS ES modules (browser-native, no bundler). FastAPI backend.

**Spec:** `docs/superpowers/specs/2026-03-24-app-js-module-split-design.md`

---

## File Structure

**Create (in order of dependency):**
1. `frontend/state.js` — state singleton, undo stack, TOOL_STATUS, TRANSIENT_TYPES
2. `frontend/math.js` — pure geometry helpers
3. `frontend/render.js` — canvas DOM refs, all draw functions, redraw, showStatus
4. `frontend/sidebar.js` — renderSidebar, camera info, tolerances, freeze UI
5. `frontend/annotations.js` — addAnnotation, deleteAnnotation, applyCalibration
6. `frontend/tools.js` — setTool, handleToolClick, snap logic, drag, select
7. `frontend/dxf.js` — DXF overlay load/align/deviation
8. `frontend/detect.js` — doFreeze, ensureFrozen, detect button handlers
9. `frontend/session.js` — saveSession, loadSession, exportAnnotatedImage, exportCsv
10. `frontend/main.js` — entry point, all event wiring, init

**Modify:**
- `frontend/index.html` — change `<script src="app.js">` to `<script type="module" src="main.js">`

**Delete (last step):**
- `frontend/app.js`

---

## Mechanical adjustments (apply throughout extraction)

The following changes are made during extraction. They appear repeatedly across tasks:

**A. `_originMode` → `state._originMode`**
`_originMode` is a bare `let` at line 2539. Add it to the `state` object in `state.js` and replace every reference in all extracted code.

**B. `_dxfOriginMode` → `state._dxfOriginMode`**
Same pattern — bare `let` at line 2547.

**C. `_noCamera` → `state._noCamera`**
Bare `let` at line 36. Add to `state` object.

**D. `showStatus(msg)` replaces `statusEl.textContent = "..."`**
Every inline `statusEl.textContent = someString` in extracted code becomes `showStatus(someString)`. `showStatus` is defined in `render.js` and imported by every module that shows status text.

**E. Delete-button wiring removed from `renderSidebar`**
Every `.del-btn` click listener currently inside `renderSidebar` is deleted. Main.js handles these via event delegation (see Task 10).

**F. `_deviationHitBoxes = []` → `_deviationHitBoxes.length = 0`**
In `drawDeviations`, the bare array reassignment would break the shared export reference. Change it to an in-place mutation.

---

## Task 1: state.js

**Files:**
- Create: `frontend/state.js`

- [ ] **Step 1: Create `frontend/state.js`**

```js
// ── State ──────────────────────────────────────────────────────────────────
export const state = {
  tool: "select",
  frozen: false,
  frozenBackground: null,   // HTMLImageElement set by doFreeze()
  frozenSize: null,          // { w, h } set by doFreeze()
  crosshair: false,
  calibration: null,
  annotations: [],
  selected: null,
  pendingPoints: [],
  pendingCenterCircle: null,
  pendingRefLine: null,
  pendingCircleRef: null,
  origin: null,
  dragState: null,
  snapTarget: null,
  mousePos: { x: 0, y: 0 },
  dxfAlignMode: false,
  dxfAlignStep: 0,
  dxfAlignPick: null,
  dxfAlignHover: null,
  showDeviations: false,
  tolerances: { warn: 0.10, fail: 0.25 },
  featureTolerances: {},
  nextId: 1,
  settings: {
    crosshairColor: "#ffffff",
    crosshairOpacity: 0.4,
    pixelFormat: "BayerRG8",
  },
  _originMode: false,       // was let _originMode (line 2539 in app.js)
  _dxfOriginMode: false,    // was let _dxfOriginMode (line 2547)
  _noCamera: false,         // was let _noCamera (line 36)
};

export const undoStack = [];
export const redoStack = [];
export const UNDO_LIMIT = 50;

export const _deviationHitBoxes = [];  // populated by drawDeviations, read by main.js

export function takeSnapshot() {
  return JSON.stringify({
    annotations: state.annotations,
    calibration: state.calibration,
    origin: state.origin,
  });
}

export function pushUndo() {
  if (undoStack.length >= UNDO_LIMIT) undoStack.shift();
  undoStack.push(takeSnapshot());
  redoStack.length = 0;
}

// ── TOOL_STATUS ─────────────────────────────────────────────────────────────
export const TOOL_STATUS = {
  "select":         "Select",
  "calibrate":      "Click — place two points or select a circle",
  "distance":       "Click — place point 1",
  "angle":          "Click — place point 1",
  "circle":         "Click — place point 1",
  "arc-fit":        "Click — place points (double-click to confirm)",
  "center-dist":    "Click — select a circle",
  "detect":         "Click — detect features",
  "perp-dist":      "Click — select a reference line",
  "para-dist":      "Click — select a reference line",
  "area":           "Click — place points (double-click to confirm)",
  "pt-circle-dist": "Click — select a circle to measure from",
  "intersect":      "Click — select a reference line",
  "slot-dist":      "Click — select a reference line",
  "arc-measure":    "Click — place 3 points on arc (double-click or 3rd click to confirm)",
};

// ── TRANSIENT_TYPES (moved from line 3062) ───────────────────────────────────
export const TRANSIENT_TYPES = new Set([
  "edges-overlay", "preprocessed-overlay", "dxf-overlay",
  "detected-circle", "detected-line",
  "detected-line-merged", "detected-arc-partial",
]);
```

Note: `undo()` and `redo()` are NOT in state.js — they go in `main.js` (they call `renderSidebar` + `redraw`).

- [ ] **Step 2: Verify by inspection**

Open `frontend/state.js` and confirm:
- All properties from the original `state` object (app.js lines 2–30) are present
- `_originMode`, `_dxfOriginMode`, `_noCamera`, `frozenBackground`, `frozenSize` are new properties on `state`
- `pushUndo`, `takeSnapshot` match app.js lines 39–73
- `TOOL_STATUS` matches app.js lines 76–92 exactly
- `TRANSIENT_TYPES` matches app.js lines 3062–3066 exactly

- [ ] **Step 3: Commit**

```bash
git add frontend/state.js
git commit -m "refactor: extract state.js module"
```

---

## Task 2: math.js

**Files:**
- Create: `frontend/math.js`

- [ ] **Step 1: Create `frontend/math.js`**

Copy these functions verbatim from `app.js`, add `export` to each:

| Function | app.js lines |
|----------|-------------|
| `parseDistanceInput` | 694–703 |
| `fitCircle` | 705–717 |
| `fitCircleAlgebraic` | 718–757 |
| `polygonArea` | 759–767 |
| `distPointToSegment` | 2287–2296 |

File skeleton:
```js
// ── Math helpers ─────────────────────────────────────────────────────────────
export function parseDistanceInput(input) { /* copy from app.js:694 */ }
export function fitCircle(p1, p2, p3) { /* copy from app.js:705 */ }
export function fitCircleAlgebraic(points) { /* copy from app.js:718 */ }
export function polygonArea(pts) { /* copy from app.js:759 */ }
export function distPointToSegment(pt, a, b) { /* copy from app.js:2287 */ }
```

No imports needed. No mechanical adjustments.

- [ ] **Step 2: Verify by inspection**

Confirm each function body is identical to app.js. None of these functions reference `state`, `canvas`, `ctx`, or any DOM element — they are pure math.

- [ ] **Step 3: Commit**

```bash
git add frontend/math.js
git commit -m "refactor: extract math.js module"
```

---

## Task 3: render.js

**Files:**
- Create: `frontend/render.js`

This is the largest module (~1,000 lines). It owns the canvas context and all draw functions.

- [ ] **Step 1: Create `frontend/render.js` with the file skeleton**

```js
import { state, _deviationHitBoxes } from './state.js';
import { fitCircleAlgebraic } from './math.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
export const img       = document.getElementById("stream-img");
export const canvas    = document.getElementById("overlay-canvas");
export const ctx       = canvas.getContext("2d");
export const statusEl  = document.getElementById("status-text");
export const listEl    = document.getElementById("measurement-list");
export const cameraInfoEl = document.getElementById("camera-info");

// NEW: replaces all inline statusEl.textContent = "..." patterns in other modules
export function showStatus(msg) {
  statusEl.textContent = msg;
}

// ... (all functions below)
```

- [ ] **Step 2: Copy functions from app.js**

Copy these function bodies verbatim, adding `export` where noted:

| Function | app.js lines | Export? |
|----------|-------------|---------|
| `resizeCanvas` | 117–128 | yes |
| `measurementLabel` | 821–997 | yes |
| `redraw` | 1265–1333 | yes |
| `drawAnnotations` | 1335–1381 | yes |
| `drawArcMeasure` | 1382–1399 | yes (internal helper) |
| `drawLine` | 1400–1408 | yes |
| `drawHandle` | 1409–1418 | yes (internal helper) |
| `drawLabel` | 1419–1427 | yes (internal helper) |
| `drawDistance` | 1428–1434 | yes |
| `drawAngle` | 1435–1441 | yes |
| `drawCircle` | 1442–1454 | yes |
| `drawEdgesOverlay` | 1455–1460 | yes |
| `drawPreprocessedOverlay` | 1461–1466 | yes |
| `drawDxfOverlay` | 1467–1514 | yes |
| `dxfToCanvas` | 1515–1527 | yes |
| `drawDetectedCircle` | 1576–1587 | yes |
| `drawDetectedLine` | 1589–1603 | yes |
| `drawCalibration` | 1604–1629 | yes |
| `drawPerpDist` | 1630–1648 | yes |
| `drawParaDist` | 1649–1665 | yes |
| `drawParallelism` | 1666–1676 | yes |
| `drawPtCircleDist` | 1677–1711 | yes |
| `drawIntersect` | 1712–1748 | yes |
| `drawSlotDist` | 1749–1775 | yes |
| `drawArea` | 1776–1790 | yes |
| `drawAreaPreview` | 1791–1803 | yes |
| `drawOrigin` | 1804–1859 | yes |
| `drawPendingPoints` | 1860–2005 | yes |
| `drawCrosshair` | 2006–2022 | yes |
| `getLineEndpoints` | 2319–2334 | yes |
| `lineAngleDeg` | 360–363 | yes |
| `deviationColor` | 2664–2670 | yes |
| `matchDxfToDetected` | 2671–2712 | no (private helper for drawDeviations) |
| `drawDeviations` | 2713–2895 | yes |

- [ ] **Step 3: Apply mechanical adjustments in render.js**

In `drawDeviations` (copied from line 2713), change:
```js
// BEFORE (app.js line 2714):
_deviationHitBoxes = [];

// AFTER:
_deviationHitBoxes.length = 0;
```

In `redraw` and any other function that has `statusEl.textContent = "..."`, replace with `showStatus(...)`. (There should be none in the draw functions, but double-check.)

In `collectDxfSnapPoints` — this function calls `dxfToCanvas`, but belongs in `tools.js`, not render.js. Do NOT copy it here.

In `enterDxfAlignMode` / `exitDxfAlignMode` (lines 1556–1574) — these belong in `dxf.js`, not here. Do NOT copy them here.

- [ ] **Step 4: Verify by inspection**

- Every function that references `ctx` or `canvas` directly should be in this file
- `measurementLabel` is large (lines 821–997) — confirm the full body is included
- `drawDeviations` uses `_deviationHitBoxes.length = 0` (not `= []`)
- `dxfToCanvas` is exported (needed by tools.js via import)
- `matchDxfToDetected` is NOT exported (private)

- [ ] **Step 5: Commit**

```bash
git add frontend/render.js
git commit -m "refactor: extract render.js module"
```

---

## Task 4: sidebar.js

**Files:**
- Create: `frontend/sidebar.js`

- [ ] **Step 1: Create `frontend/sidebar.js` with skeleton**

```js
import { state } from './state.js';
import { redraw, showStatus, measurementLabel, canvas } from './render.js';
```

- [ ] **Step 2: Copy functions from app.js**

| Function | app.js lines | Export? | Notes |
|----------|-------------|---------|-------|
| `renderSidebar` | 1000–1069 | yes | Apply adjustment E below |
| `loadTolerances` | 1072–1086 | yes | |
| `loadUiConfig` | 1087–1101 | yes | |
| `updateCalibrationButton` | 1102–1116 | yes | |
| `loadCameraInfo` | 1118–1171 | yes | Apply adjustment C |
| `updateDropOverlay` | 1172–1177 | no (private) | |
| `updateFreezeUI` | 1178–1192 | yes | |
| `checkStartupWarning` | 1194–1208 | yes | Apply adjustment D |
| `loadCameraList` | 1210–1229 | yes | |
| `scaleText` | 1230–1237 | no (private) | |
| `updateCameraInfo` | 1239–1242 | yes | |
| `updateDxfControlsVisibility` | 2632–2653 | yes | |

- [ ] **Step 3: Apply mechanical adjustments in sidebar.js**

**Adjustment C** — rename `_noCamera` to `state._noCamera` in `loadCameraInfo` (line 1163):
```js
// BEFORE:
if (d.no_camera === true && !_noCamera) {
  _noCamera = true;
// AFTER:
if (d.no_camera === true && !state._noCamera) {
  state._noCamera = true;
```

**Adjustment D** — `checkStartupWarning` uses `statusEl.textContent` directly (line 1200, 1202). Replace with `showStatus`:
```js
// BEFORE (app.js 1200):
statusEl.textContent = d.warning;
// ...
statusEl.textContent = prev.text;

// AFTER:
showStatus(d.warning);
// ...
showStatus(prev.text);
```

**Adjustment E** — `renderSidebar` currently wires inline del-btn click listeners. Remove them entirely:
```js
// DELETE these lines from renderSidebar (they appear for each row type):
row.querySelector(".del-btn").addEventListener("click", e => {
  e.stopPropagation();
  deleteAnnotation(ann.id);
});
```
The `.del-btn` elements still get rendered with `data-id="${ann.id}"` — main.js will handle the clicks via event delegation.

**Adjustment D continued** — inside `renderSidebar`, the row click handler references `redraw()` directly. That's fine since render.js is imported. No other `statusEl.textContent` patterns should be present in sidebar.js; confirm none.

- [ ] **Step 4: Verify by inspection**

- `renderSidebar` does NOT call `deleteAnnotation` (those listeners are removed)
- `renderSidebar` row-click handler still calls `state.selected = ann.id; renderSidebar(); redraw()` — keep these
- `loadCameraInfo` uses `state._noCamera` not `_noCamera`
- No import from `annotations.js`

- [ ] **Step 5: Commit**

```bash
git add frontend/sidebar.js
git commit -m "refactor: extract sidebar.js module"
```

---

## Task 5: annotations.js

**Files:**
- Create: `frontend/annotations.js`

- [ ] **Step 1: Create `frontend/annotations.js` with skeleton**

```js
import { state, pushUndo } from './state.js';
import { redraw } from './render.js';
import { renderSidebar, updateCameraInfo, updateCalibrationButton } from './sidebar.js';
```

- [ ] **Step 2: Copy functions from app.js**

| Function | app.js lines | Export? |
|----------|-------------|---------|
| `addAnnotation` | 770–776 | yes |
| `deleteAnnotation` | 778–794 | yes |
| `applyCalibration` | 796–820 | yes |

- [ ] **Step 3: Verify `addAnnotation` does NOT call `redraw()`**

Look at app.js line 770–776. The function ends at line 776 — it only calls `renderSidebar()`. Do not add a `redraw()` call. Callers are responsible for redrawing.

- [ ] **Step 4: Verify `deleteAnnotation` DOM side-effects**

`deleteAnnotation` (line 783) directly calls `document.getElementById("dxf-panel")`. This is fine — it's a direct DOM access, not an import dependency. Keep it as-is.

- [ ] **Step 5: Commit**

```bash
git add frontend/annotations.js
git commit -m "refactor: extract annotations.js module"
```

---

## Task 6: tools.js

**Files:**
- Create: `frontend/tools.js`

- [ ] **Step 1: Create `frontend/tools.js` with skeleton**

```js
import { state, TOOL_STATUS, pushUndo } from './state.js';
import { redraw, canvas, ctx, showStatus, getLineEndpoints, lineAngleDeg, dxfToCanvas } from './render.js';
import { addAnnotation, applyCalibration } from './annotations.js';
import { fitCircle, fitCircleAlgebraic, parseDistanceInput, polygonArea, distPointToSegment } from './math.js';
import { renderSidebar } from './sidebar.js';
```

- [ ] **Step 2: Copy functions from app.js**

| Function | app.js lines | Export? | Notes |
|----------|-------------|---------|-------|
| `setTool` | 94–107 | yes | Apply D |
| `canvasPoint` | 141–144 | yes | |
| `findSnapLine` | 366–375 | yes | |
| `SNAP_RADIUS` constant | 378 | yes | `export const SNAP_RADIUS = 8;` |
| `snapPoint` | 380–407 | yes | |
| `handleToolClick` | 409–692 | yes | Apply D throughout |
| `handleSelectDown` | 2104–2133 | yes | |
| `hitTestHandle` | 2135–2142 | yes | |
| `getHandles` | 2144–2175 | yes | |
| `hitTestAnnotation` | 2176–2286 | yes | |
| `snapToCircle` | 2298–2316 | yes | |
| `projectConstrained` | 2338–2352 | yes | |
| `handleDrag` | 2354–2419 | yes | |
| `collectDxfSnapPoints` | 1542–1554 | yes | |

- [ ] **Step 3: Apply mechanical adjustments in tools.js**

**Adjustment A** — in `handleToolClick` and `handleSelectDown`, there may be references to `_originMode` or `_dxfOriginMode`. Replace:
- `_originMode` → `state._originMode`
- `_dxfOriginMode` → `state._dxfOriginMode`

**Adjustment D** — in `setTool` (line 104):
```js
// BEFORE:
statusEl.textContent = TOOL_STATUS[name] ?? name;
// AFTER:
showStatus(TOOL_STATUS[name] ?? name);
```

Also replace any `statusEl.textContent = "..."` in `handleToolClick` (lines 548, 555, 573, 593, 611, 641, 645, 660, 678):
```js
// Example: line 548
statusEl.textContent = "Perp — click start point";
// becomes:
showStatus("Perp — click start point");
```

- [ ] **Step 4: Verify**

- `handleDrag` calls `renderSidebar()` and `redraw()` — both imported
- `collectDxfSnapPoints` calls `dxfToCanvas` — imported from render.js (already in the import line above)

- [ ] **Step 5: Commit**

```bash
git add frontend/tools.js
git commit -m "refactor: extract tools.js module"
```

---

## Task 7: dxf.js

**Files:**
- Create: `frontend/dxf.js`

- [ ] **Step 1: Create `frontend/dxf.js` with skeleton**

```js
import { state } from './state.js';
import { redraw, canvas, showStatus } from './render.js';
import { addAnnotation } from './annotations.js';
import { renderSidebar, updateDxfControlsVisibility } from './sidebar.js';
```

- [ ] **Step 2: Copy functions from app.js**

| Function / Section | app.js lines | Export? | Notes |
|-------------------|-------------|---------|-------|
| `enterDxfAlignMode` | 1556–1566 | yes | Apply B, D |
| `exitDxfAlignMode` | 1568–1574 | yes | Apply D |
| `getDetectedCirclesForAlignment` | 2654–2662 | no (private) | |
| `openFeatureTolPopover` | 2899–2909 | yes | |
| `closeFeatureTolPopover` | 2910–2935 | no (private, called from popover buttons) | |

- [ ] **Step 3: Create `initDxfHandlers()` from inline event listeners**

Extract all DXF-related `addEventListener` calls from app.js into a single exported function. Copy these sections verbatim into the function body, applying adjustments B and D:

| Section | app.js lines |
|---------|-------------|
| btn-load-dxf click | 2549–2551 |
| dxf-input change (load DXF file) | 2553–2590 |
| dxf-scale input | 2592–2601 |
| btn-dxf-set-origin click | 2603–2612 |
| Canvas click for dxf origin placement | 2614–2631 (part of larger onMouseDown? check) |
| btn-dxf-flip-h click | ~2635+ |
| btn-dxf-flip-v click | |
| btn-dxf-rotate click | |
| btn-align-dxf click | |
| btn-deviations click | |
| Per-feature tolerance popover buttons (ftol-set, ftol-reset, ftol-close) | 2937–2961 |

```js
export function initDxfHandlers() {
  document.getElementById("btn-load-dxf").addEventListener("click", () => {
    // copy from app.js:2549
  });
  document.getElementById("dxf-input").addEventListener("change", async e => {
    // copy from app.js:2553
  });
  // ... all other DXF handlers
}
```

- [ ] **Step 4: Apply mechanical adjustments in dxf.js**

**Adjustment B** — in `enterDxfAlignMode` (line 1561):
```js
// BEFORE:
if (_dxfOriginMode) {
  _dxfOriginMode = false;
// AFTER:
if (state._dxfOriginMode) {
  state._dxfOriginMode = false;
```

**Adjustment B** — in `initDxfHandlers` for btn-dxf-set-origin:
```js
// BEFORE (app.js ~2604):
_dxfOriginMode = true;
// AFTER:
state._dxfOriginMode = true;
```

**Adjustment D** — in `enterDxfAlignMode` (line 1565):
```js
// BEFORE:
statusEl.textContent = "Click a DXF feature to anchor…";
// AFTER:
showStatus("Click a DXF feature to anchor…");
```

**Adjustment D** — in `exitDxfAlignMode` (line 1573):
```js
// BEFORE:
statusEl.textContent = state.frozen ? "Frozen" : "Live";
// AFTER:
showStatus(state.frozen ? "Frozen" : "Live");
```

- [ ] **Step 5: Commit**

```bash
git add frontend/dxf.js
git commit -m "refactor: extract dxf.js module"
```

---

## Task 8: detect.js

**Files:**
- Create: `frontend/detect.js`

- [ ] **Step 1: Create `frontend/detect.js` with skeleton**

```js
import { state } from './state.js';
import { redraw, showStatus, img, canvas } from './render.js';
import { addAnnotation } from './annotations.js';
import { updateFreezeUI } from './sidebar.js';
```

- [ ] **Step 2: Copy `doFreeze` and `ensureFrozen`**

Copy from app.js lines 2424–2449. Export both:

```js
export async function ensureFrozen() { /* copy app.js:2424 */ }
export async function doFreeze() { /* copy app.js:2428 */ }
```

Note: `doFreeze` calls `updateFreezeUI()` and `resizeCanvas()`. Both are imported (updateFreezeUI from sidebar.js, resizeCanvas from render.js — add `resizeCanvas` to the render.js import).

- [ ] **Step 3: Create `initDetectHandlers()` from inline event listeners**

Extract these addEventListener sections into a single exported function:

| Section | app.js lines |
|---------|-------------|
| Slider input handlers | 3226–3231 |
| btn-run-edges click | 3233–3254 |
| btn-show-preprocessed click | 3256–3271 |
| btn-run-circles click | 3273–3318 |
| btn-run-lines click (if present) | ~3318 |
| btn-detect-lines-merged click | 3320–3329 |
| btn-detect-arcs-partial click | 3332–3341 |

```js
export function initDetectHandlers() {
  ["canny-low","canny-high","hough-p2","circle-min-r","circle-max-r",
   "line-sensitivity","line-min-length"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      document.getElementById(id + "-val").textContent = el.value;
    });
  });

  document.getElementById("btn-run-edges").addEventListener("click", async () => {
    // copy from app.js:3233
  });
  // ... all other detect handlers
}
```

- [ ] **Step 4: Apply adjustment D**

In the detect handlers, replace any `showStatus(...)` calls (these already use `showStatus` in app.js at lines 3323, 3335 — they're already using the pattern, just need the function to actually exist now).

- [ ] **Step 5: Commit**

```bash
git add frontend/detect.js
git commit -m "refactor: extract detect.js module"
```

---

## Task 9: session.js

**Files:**
- Create: `frontend/session.js`

- [ ] **Step 1: Create `frontend/session.js` with skeleton**

```js
import { state, TRANSIENT_TYPES } from './state.js';
import { redraw, canvas, img, showStatus, measurementLabel } from './render.js';
import { renderSidebar } from './sidebar.js';
import { addAnnotation } from './annotations.js';
```

- [ ] **Step 2: Copy `saveSession` and `loadSession`**

| Function | app.js lines | Export? |
|----------|-------------|---------|
| `saveSession` | 3068–3089 | yes |
| `loadSession` | 3094–3188 | yes |

- [ ] **Step 3: Extract `exportAnnotatedImage` from inline handler**

The btn-export handler (app.js lines 2938–2960) is an inline callback. Extract it into a named function:

```js
export function exportAnnotatedImage() {
  let sourceCanvas;
  if (state.frozen) {
    sourceCanvas = canvas;
  } else {
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = canvas.width;
    sourceCanvas.height = canvas.height;
    const sctx = sourceCanvas.getContext("2d");
    sctx.drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);
    sctx.drawImage(canvas, 0, 0);
  }
  sourceCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `microscope_${new Date().toISOString().replace(/[:.]/g,"-")}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
```

- [ ] **Step 4: Extract `exportCsv` from inline handler**

Copy `formatCsvValue` (app.js lines 2963–3038) as a private helper (no export), then extract the btn-export-csv handler (lines 3040–3059) into:

```js
export function exportCsv() {
  const rows = [["#", "Name", "Value", "Unit", "type", "label"]];
  let i = 1;
  state.annotations.forEach(ann => {
    const label = measurementLabel(ann);
    if (!label) return;
    const { value, unit } = formatCsvValue(ann);
    rows.push([i++, ann.name || "", value, unit, ann.type, label]);
  });
  const csv = rows
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `measurements_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 5: Apply adjustment D in `loadSession`**

`loadSession` already calls `showStatus(...)` (app.js lines 3099+). These calls currently fail at runtime because `showStatus` was never defined in app.js. After import, they will work correctly.

- [ ] **Step 6: Commit**

```bash
git add frontend/session.js
git commit -m "refactor: extract session.js module"
```

---

## Task 10: main.js

**Files:**
- Create: `frontend/main.js`

This is the entry point. It wires all remaining event listeners and runs init.

- [ ] **Step 1: Create `frontend/main.js` with all imports**

```js
import { state, undoStack, redoStack, takeSnapshot, _deviationHitBoxes } from './state.js';
import { canvas, img, showStatus, redraw, resizeCanvas } from './render.js';
import { renderSidebar, loadCameraInfo, loadUiConfig, loadTolerances,
         updateCalibrationButton, checkStartupWarning, updateFreezeUI,
         loadCameraList } from './sidebar.js';
import { addAnnotation, deleteAnnotation } from './annotations.js';
import { setTool, handleToolClick, handleSelectDown, handleDrag,
         canvasPoint, snapPoint, collectDxfSnapPoints } from './tools.js';
import { enterDxfAlignMode, exitDxfAlignMode, initDxfHandlers } from './dxf.js';
import { doFreeze, initDetectHandlers } from './detect.js';
import { saveSession, loadSession, exportAnnotatedImage, exportCsv } from './session.js';
```

- [ ] **Step 2: Define `undo` and `redo` locally**

```js
function undo() {
  if (!undoStack.length) return;
  redoStack.push(takeSnapshot());
  const snap = JSON.parse(undoStack.pop());
  state.annotations = snap.annotations;
  state.calibration = snap.calibration;
  state.origin = snap.origin;
  state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null;
  renderSidebar(); redraw();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(takeSnapshot());
  const snap = JSON.parse(redoStack.pop());
  state.annotations = snap.annotations;
  state.calibration = snap.calibration;
  state.origin = snap.origin;
  state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null;
  renderSidebar(); redraw();
}
```

- [ ] **Step 3: Wire canvas mouse events**

Copy `onMouseDown` (app.js lines 146–205) and `onMouseUp` (206–209) with these adjustments:

**Adjustment A/B** — in onMouseDown: replace `_originMode` → `state._originMode` and `_dxfOriginMode` → `state._dxfOriginMode`:
```js
// BEFORE (app.js ~179):
if (_dxfOriginMode) {
// AFTER:
if (state._dxfOriginMode) {
```

**Adjustment D** — any `statusEl.textContent = "..."` in onMouseDown:
```js
// Line 157:
statusEl.textContent = "Click the image point to align to…";
// becomes:
showStatus("Click the image point to align to…");
// Line 164:
showStatus("DXF aligned");
// Line 184:
showStatus(state.frozen ? "Frozen" : "Live");
```

Also copy the `mousemove` handler from app.js (around lines 284–360 — the section between keyboard and snap-to-annotation).

```js
canvas.addEventListener("mousedown", onMouseDown);
canvas.addEventListener("mouseup", onMouseUp);
// mousemove:
canvas.addEventListener("mousemove", e => { /* copy from app.js */ });
```

- [ ] **Step 4: Wire keyboard handler**

Copy the `document.addEventListener("keydown", ...)` from app.js lines 236–283. Apply adjustments:

**Adjustment A/B** — replace `_originMode` → `state._originMode`, `_dxfOriginMode` → `state._dxfOriginMode`:
```js
// Lines 255–264:
if (state._dxfOriginMode) {
  state._dxfOriginMode = false;
  document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
  showStatus(state.frozen ? "Frozen" : "Live");
}
// ...
if (state._originMode) {
  state._originMode = false;
  document.getElementById("btn-set-origin").classList.remove("active");
}
```

**Adjustment D** — line 258: `statusEl.textContent` → `showStatus(...)`.

- [ ] **Step 5: Wire dropdown helpers and deviation hit-test**

Copy `closeAllDropdowns` and `toggleDropdown` (app.js lines 212–233) — these are used by main.js handlers and can be local functions (no need to export).

Wire canvas click for deviation hit-test using `_deviationHitBoxes` (copy from app.js section around "canvas.addEventListener('click'..." in the DXF overlay section).

- [ ] **Step 6: Wire all remaining event listeners**

Copy these sections from app.js verbatim (applying adjustments A/B/D as needed):

| Section | app.js lines |
|---------|-------------|
| Init (tool strip buttons, camera section collapse) | 2023–2046 |
| ResizeObserver + image load | 130–132 (currently top-level, move to end of main.js) |
| Dropdown menu wiring | 2047–2099 |
| Overflow popup | 2080–2099 |
| Close dropdowns on click-outside | 2100–2103 |
| Freeze button | 2451–2462 |
| Load image file input | 2464–2492 |
| Drag-and-drop (apply C: `_noCamera` → `state._noCamera`) | 2494–2537 |
| Coordinate origin button | 2538–2545 (apply A: `_originMode` → `state._originMode`) |
| Session save button | 3091 |
| Session load file input | 3171–3189 |
| Clear all annotations | 3190–3218 |
| btn-export PNG | 2938–2960 (now calls `exportAnnotatedImage()`) |
| btn-export-csv | 3040–3059 (now calls `exportCsv()`) |
| Crosshair toggle | 3343–3348 |
| Calibration button | 3350–3351 |
| Help dialog | 3353–3359 |
| Settings dialog | 3361–3476 |
| White balance | 3477–3518 |
| Camera selection | 3519–3541 |

- [ ] **Step 7: Add event delegation for delete buttons**

```js
document.getElementById("measurement-list").addEventListener("click", e => {
  const btn = e.target.closest(".del-btn");
  if (!btn) return;
  e.stopPropagation();
  const id = parseInt(btn.dataset.id, 10);
  deleteAnnotation(id);
});
```

- [ ] **Step 8: Add init sequence at end of file**

```js
// ── Init ────────────────────────────────────────────────────────────────────
initDxfHandlers();
initDetectHandlers();

new ResizeObserver(resizeCanvas).observe(img);
img.addEventListener("load", resizeCanvas);
window.addEventListener("resize", resizeCanvas);

document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});
document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.tool === state.tool);
});
// camera section collapse (copy from app.js:2035–2042)

loadCameraInfo();
loadUiConfig();
loadTolerances();
updateCalibrationButton();
checkStartupWarning();
resizeCanvas();
updateFreezeUI();
```

- [ ] **Step 9: Commit**

```bash
git add frontend/main.js
git commit -m "refactor: extract main.js entry point"
```

---

## Task 11: Switch index.html and smoke test

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Switch the script tag in `frontend/index.html`**

Find line 387:
```html
<script src="app.js"></script>
```

Replace with:
```html
<script type="module" src="main.js"></script>
```

- [ ] **Step 2: Start the server without a camera**

```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000` in the browser.

- [ ] **Step 3: Check the browser console for errors**

Open DevTools → Console. There should be zero errors. If there are `ReferenceError` or `SyntaxError` messages, fix them before proceeding. Common issues:
- Missing `export` on a function that is imported elsewhere
- A variable still referencing `_originMode` instead of `state._originMode`
- `showStatus` still undefined (means render.js isn't imported somewhere)

- [ ] **Step 4: Run the smoke-test checklist**

Work through this list in the browser:

- [ ] Tool switching: click Select → Distance → Circle → Calibrate in tool strip; status text updates
- [ ] Keyboard shortcuts: press `v` (select), `d` (distance), `c` (calibrate) — tools switch
- [ ] Calibration — 2-point: click Calibrate tool, click two points on canvas, enter a distance in the prompt
- [ ] Calibration — check it appears in the sidebar
- [ ] Distance annotation: place two points, measurement appears in sidebar with a label
- [ ] Delete annotation: click ✕ on sidebar row, annotation disappears
- [ ] Undo / redo: Ctrl+Z undoes delete, Ctrl+Shift+Z redoes
- [ ] Session save: Ctrl+S triggers a JSON download
- [ ] Session load: File → Load Session, pick the downloaded file, annotations restore
- [ ] DXF load: click Load DXF, pick a DXF file, overlay appears on canvas
- [ ] DXF scale slider: changes scale, overlay updates
- [ ] RANSAC auto-align (btn-align-dxf): runs without error
- [ ] Deviation callouts: after alignment, toggle Show Deviations button, callouts appear
- [ ] Per-feature tolerance popover: click a deviation callout, popover opens; set a tolerance, click Set
- [ ] Detect circles: click Menu → Detect, click Run Circles, circles appear as overlays
- [ ] Detect lines (merged): click Detect Lines, lines appear
- [ ] Detect partial arcs: click Detect Arcs, arcs appear
- [ ] Export PNG: click Export PNG, image downloads
- [ ] Export CSV: click Export CSV, CSV downloads with correct columns

- [ ] **Step 5: Run backend tests to confirm no regressions**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all tests pass (no backend changes were made).

- [ ] **Step 6: Commit index.html change**

```bash
git add frontend/index.html
git commit -m "refactor: switch to ES module entry point (main.js)"
```

---

## Task 12: Delete app.js

**Files:**
- Delete: `frontend/app.js`

- [ ] **Step 1: Delete `app.js`**

```bash
git rm frontend/app.js
```

- [ ] **Step 2: Reload the browser and re-run smoke test**

Confirm the app still works correctly without app.js on disk.

- [ ] **Step 3: Final commit**

```bash
git commit -m "refactor: delete monolithic app.js (replaced by ES modules)"
```
