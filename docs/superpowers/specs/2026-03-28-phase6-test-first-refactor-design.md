# Phase 6: Test-First Refactor

## Goal

Make the frontend codebase maintainable and safe to modify by: (1) purifying key functions so they can be tested without a browser, (2) writing tests that lock in behavior, (3) splitting oversized files into focused modules — in that order, so each step de-risks the next.

## Context

The codebase is ~7300 lines of frontend JS across 11 files. Two files dominate:
- `main.js` (1714 lines, 267 `state.` references, 0 exports) — a monolithic event handler dump
- `render.js` (1585 lines, 42 exports) — draws every annotation type, DXF overlay, HUD, labels, and houses `measurementLabel()`

Several high-value functions read global state unnecessarily, making them untestable without a browser. The backend has decent test coverage (2552 lines of tests); the frontend has zero.

### What this is NOT
- Not a TypeScript migration (codebase is too small to justify build tooling)
- Not a framework adoption (canvas rendering doesn't benefit from React/Vue)
- Not a full architectural rewrite — same modules, same responsibilities, just better boundaries

---

## Design

### 1. Function purification

Replace implicit global reads with explicit parameters. Each function becomes a pure function that takes input and returns output with no side effects.

#### `measurementLabel(ann)` → `measurementLabel(ann, ctx)`

Currently in `render.js`, reads 5 globals: `state.calibration`, `state.annotations`, `state.origin`, `imageWidth`, `canvas.width/height`.

New signature:
```js
export function measurementLabel(ann, ctx) {
  // ctx = { calibration, annotations, origin, imageWidth, canvasWidth, canvasHeight }
  // canvasWidth/canvasHeight = canvas.width/canvas.height (backing store pixels, not CSS pixels)
}
```

Callers (render.js, sidebar.js, session.js) assemble `ctx` from their existing imports — mechanical change.

**Note:** `measurementLabel` also calls `getLineEndpoints()` and `lineAngleDeg()` for `intersect` and `slot-dist` types. These are pure geometry helpers and must be co-extracted into `format.js` (see Section 3).

#### `formatCsvValue(ann)` → `formatCsvValue(ann, calibration, imageWidth)`

Currently in `session.js`, reads `state.calibration` and `imageWidth`. Add two parameters.

#### `imageToScreen(x, y)` / `screenToImage(x, y)` → add `vp` parameter

Currently in `viewport.js`, read module-level `viewport` object.

New pure signatures (exported for testing):
```js
export function imageToScreenPure(x, y, vp) { /* vp = { zoom, panX, panY } */ }
export function screenToImagePure(x, y, vp) { /* vp = { zoom, panX, panY } */ }
```

The existing `imageToScreen(x, y)` / `screenToImage(x, y)` signatures stay as thin wrappers that pass the module-level `viewport` object. This avoids touching dozens of call sites during the purification step — callers migrate naturally during later file splits.

```js
export function imageToScreen(x, y) { return imageToScreenPure(x, y, viewport); }
export function screenToImage(x, y) { return screenToImagePure(x, y, viewport); }
```

#### What stays impure

`canvasPoint()`, `fitToWindow()`, `clampPan()`, all annotation mutators, all DOM event handlers. These are inherently stateful and don't benefit from purification.

---

### 2. Test infrastructure

**Runner:** Node built-in test runner (`node --test`). Zero dependencies, ES module native, ships with Node 18+.

**Location:** `tests/frontend/`

**Test files:**

| File | Tests | Source functions |
|------|-------|-----------------|
| `test_math.js` | fitCircle, fitLine, fitCircleAlgebraic, polygonArea, distPointToSegment | `frontend/math.js` |
| `test_viewport.js` | imageToScreen, screenToImage with various zoom/pan | `frontend/viewport.js` |
| `test_measurement.js` | measurementLabel for every annotation type, calibrated + uncalibrated | `frontend/format.js` |
| `test_csv.js` | formatCsvValue for every annotation type | `frontend/session.js` |
| `test_session_roundtrip.js` | serialize → deserialize → compare state | `frontend/session.js` |

**Import strategy:** Direct ES module imports. Purified functions have no DOM dependency so no jsdom needed.

**Run command:** `node --test tests/frontend/` (add as npm script for convenience).

---

### 3. Early extraction: `format.js`

`measurementLabel` lives in `render.js`, which imports DOM globals (`canvas`) at module level. Importing `render.js` in Node would fail even after purifying the function.

**Solution:** Extract `measurementLabel` and its helper functions into `frontend/format.js` before writing tests. This is a prerequisite for testing, not part of the main file split.

**Functions to extract:**
- `measurementLabel(ann, ctx)` — the main formatting function
- `getLineEndpoints(ann)` — pure geometry, used by intersect/slot-dist types
- `lineAngleDeg(ann)` — pure geometry, used by intersect type
- Any type label constants/maps

`render.js` re-exports from `format.js` for backward compatibility during the transition:
```js
export { measurementLabel } from './format.js';
```

Callers can migrate imports at their own pace (or during the later render.js split).

---

### 4. File splits

After tests are green, split oversized files. Each split is purely mechanical (move code, update imports) with no behavioral changes. Tests validate each split.

#### `main.js` (1714 lines) → 5 files

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `main.js` | Entry point: imports handlers, wires event listeners, init | ~150 |
| `events-mouse.js` | mousedown/move/up dispatch, tool delegation, drag-select, pan | ~400 |
| `events-keyboard.js` | Keyboard shortcuts, tool switching | ~100 |
| `events-context-menu.js` | Right-click menu construction, all action handlers | ~350 |
| `events-inspection.js` | Point-pick mode, guided result interaction, label drag, tooltips | ~400 |
| `events-dxf.js` | DXF align clicks, DXF drag-to-translate, DXF entity selection | ~300 |

#### `render.js` (1585 lines) → 4 files

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `render.js` | Orchestrator: `redraw()`, `resizeCanvas()`, canvas setup | ~150 |
| `render-annotations.js` | Draw functions for all measurement + detection types | ~500 |
| `render-dxf.js` | DXF overlay, guided results, deviation coloring, feature numbers | ~500 |
| `render-hud.js` | Minimap, grid, zoom badge, crosshair | ~200 |

(`format.js` already extracted in step 3.)

#### `tools.js` (821 lines) → 2 files

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `tools.js` | Tool switching, `canvasPoint`, handle drag, snap | ~400 |
| `hit-test.js` | `hitTestAnnotation`, `hitTestDxfEntity`, proximity helpers | ~400 |

#### `api.py` (585 lines) → 4 files

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `api.py` | Router composition, `make_router()` assembles sub-routers, config endpoints, load/snapshot | ~100 |
| `api_camera.py` | stream, freeze, snapshot, exposure, gain, white balance, pixel format | ~150 |
| `api_detection.py` | detect-circles, detect-lines, detect-arcs, preprocessed-view | ~150 |
| `api_inspection.py` | inspect-guided, fit-feature, align-dxf, align-dxf-edges, export-dxf, load-dxf | ~200 |

FastAPI routers compose cleanly via `include_router()`. Config endpoints (`/config/ui`, `/config/tolerances`) and load/snapshot routes stay in the root `api.py` since they don't fit a clear sub-domain.

#### Files that don't split

`state.js` (107), `math.js` (108), `viewport.js` (63), `sidebar.js` (635), `session.js` (633), `dxf.js` (523), `detect.js` (228), `annotations.js` (294) — all under 700 lines with clear single responsibilities.

#### HTML and imports

All new files are ES modules imported by their parent module (e.g., `events-mouse.js` is imported by `main.js`). No new `<script>` tags needed in `index.html` — the existing `<script type="module" src="main.js">` entry point remains the only script tag.

---

## Execution order

Each step is independently shippable and gets its own commit.

| Step | What | Safety net |
|------|------|------------|
| 1 | Test infrastructure setup (runner, directory, npm script) | — |
| 2 | Extract `format.js` from `render.js` (measurementLabel + helpers) | Manual smoke test |
| 3 | Purify function signatures (measurementLabel, formatCsvValue, viewport transforms) | Manual smoke test |
| 4 | Write tests for all pure functions | Tests themselves |
| 5 | Split `main.js` → 5 event files | Frontend tests must pass |
| 6 | Split `render.js` → 3 render files | Frontend tests must pass |
| 7 | Split `tools.js` → tools + hit-test | Frontend tests must pass |
| 8 | Split `api.py` → 4 router files | Backend tests must pass |

**If we stop after step 4**, we still have purified functions and a test suite — already a significant maintainability win. Steps 5-8 are the structural payoff, made safe by step 4.

---

## What success looks like

- Every pure function has tests that run in <1 second with `node --test`
- No file exceeds ~500 lines
- `main.js` is a thin wiring file, not a 1700-line monolith
- New features touch 1-2 focused files instead of hunting through mega-files
- The same tests pass before and after every split — zero behavioral regressions
