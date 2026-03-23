# Frontend UX / Quality of Life Design

**Date:** 2026-03-22

## Goal

Four independent UX improvements to `frontend/app.js`: undo/redo, snap-to-annotation, copy-to-clipboard, and richer CSV export.

---

## 1. Undo / Redo

### State

```js
const undoStack = [];  // array of serialized snapshots
const redoStack = [];
const UNDO_LIMIT = 50;
```

A snapshot captures the full annotation-related state needed to restore a consistent view:

```js
function takeSnapshot() {
  return JSON.stringify({
    annotations: state.annotations,
    calibration: state.calibration,
    origin: state.origin,
  });
}
```

Calibration and origin are included in the snapshot so that undoing past a calibration step or origin placement restores a fully consistent state (correct `measurementLabel` output and coordinate readout).

### Snapshot points

A snapshot is pushed to `undoStack` (and `redoStack` cleared) **before** any of these operations:

- `addAnnotation()` — standard annotation placement
- `deleteAnnotation()` — any deletion
- The `_originMode` mousedown block in `onMouseDown`, **before** the `state.annotations.filter(...)` call (since that filter also mutates the array)
- `applyCalibration()`, **before** the `state.annotations.filter(...)` call
- Drag end: in `onMouseUp`, **before** `state.dragState = null`, check `if (state.dragState !== null)` — if true, push snapshot then null the state

Cap: when `undoStack.length >= UNDO_LIMIT`, shift the oldest entry before pushing.

### Undo (Ctrl+Z)

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
```

### Redo (Ctrl+Y or Ctrl+Shift+Z)

```js
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

### Keyboard

Add to the existing `keydown` listener:
- `Ctrl+Z` (non-Mac) / `Meta+Z` (Mac) → `undo()`
- `Ctrl+Y` / `Meta+Y`, or `Ctrl+Shift+Z` / `Meta+Shift+Z` → `redo()`

---

## 2. Snap-to-Annotation

### Snap targets

Collected on demand from `state.annotations`:

| Type | Snap points |
|------|-------------|
| `distance`, `perp-dist`, `para-dist`, `parallelism` | `ann.a`, `ann.b` |
| `calibration` | `{x:ann.x1,y:ann.y1}`, `{x:ann.x2,y:ann.y2}` |
| `circle`, `arc-fit`, `detected-circle` | `{x:ann.cx, y:ann.cy}` |
| `origin` | `{x:ann.x, y:ann.y}` |
| `area` | all `ann.points` vertices |
| `center-dist` | excluded — uses circle hit-testing, not point snapping |

Overlay types (`edges-overlay`, `preprocessed-overlay`, `dxf-overlay`, `detected-line`) are excluded.

### `snapPoint(rawPt)` function

Returns `{ pt, snapped: bool }`. Iterates all snap targets; if any is within **8px** of `rawPt`, returns `{ pt: target, snapped: true }`. Otherwise `{ pt: rawPt, snapped: false }`.

Only active when `state.tool !== "select"` — snap is irrelevant in select mode.

### State

Add `snapTarget: null` to the `state` initializer (existing object at the top of `app.js`). Add `state.snapTarget = null` to `setTool()`.

### Integration

`snapPoint` is called in:
- `handleToolClick(pt)` — for all multi-click placement tools: `distance`, `angle`, `circle`, `perp-dist`, `para-dist`, `arc-fit`, `area`. Not called for `center-dist` (uses `snapToCircle` / `findSnapLine`) or `calibrate` (separate flow).
- `mousemove` handler — to update `state.snapTarget` for the rubber-band preview endpoint. For `arc-fit` and `area` (accumulation tools), snap applies to the rubber-band preview point only; confirmed points are snapped at click time via `handleToolClick`.

### Snap indicator

In `redraw()`, after all annotations are drawn: if `state.snapTarget` is non-null and the current tool is not `"select"`, draw an open circle (radius 6, 1.5px stroke, color `"#60a5fa"`) at `state.snapTarget`.

---

## 3. Copy Measurement to Clipboard

### Interaction

Clicking a sidebar row **that is already selected** copies its value. This avoids conflict with the existing single-click-to-select behaviour on unselected rows.

Implementation:
- The existing `click` listener on each row (line ~652) sets `state.selected`. After setting it, check if the clicked row's annotation id **was already** `state.selected` before the click — if so, copy.
- Capture `const wasSelected = state.selected` before updating `state.selected`, then compare.

Exclusions:
- Origin rows: `measurementLabel` returns `""` — no copy.
- The name `<input>` inside a row: its `click` already calls `e.stopPropagation()` — the row listener does not fire.
- The delete button inside a row: also has `stopPropagation()` — the row listener does not fire.

### What is copied

If `ann.name` is empty: copy `measurementLabel(ann)` — e.g. `"3.142 mm"`.
If `ann.name` is set: copy `"${ann.name}: ${measurementLabel(ann)}"` — e.g. `"bore diameter: 3.142 mm"`.

Uses `navigator.clipboard.writeText(...)`. On success: add class `copied` to the row for 600ms (CSS flash). On clipboard API error: silently no-op.

---

## 4. Richer CSV Export

### New columns

Prepend three columns to every row: `Name`, `Value`, `Unit`.

| Name | Value | Unit | (existing columns…) |
|------|-------|------|---------------------|

- **Name**: `ann.name` (empty string if not set) — existing field, already exported as `"name"` column; rename that column to `"Name"` for consistency.
- **Value** and **Unit**: produced by a new helper `formatCsvValue(ann)`.

### `formatCsvValue(ann)`

Reimplements the numeric extraction from the same calibration logic used by `measurementLabel` — does **not** parse the label string. Returns `{ value: string, unit: string }`.

| Annotation type | value | unit |
|-----------------|-------|------|
| `distance`, `perp-dist`, `para-dist` | calibrated distance | `"mm"` / `"µm"` / `"px"` |
| `angle` | angle in degrees | `"°"` |
| `circle`, `arc-fit`, `detected-circle` | diameter | `"mm"` / `"µm"` / `"px"` |
| `area` | area | `"mm²"` / `"µm²"` / `"px²"` |
| `center-dist` | center-to-center distance | `"mm"` / `"µm"` / `"px"` |
| `parallelism` | angle deviation | `"°"` |
| `calibration` | calibrated distance | `"mm"` / `"µm"` / `"px"` |
| `origin`, overlays | `""` | `""` (row skipped as today) |

The `value` string uses the same decimal precision as `measurementLabel` (`.toFixed(3)` for mm, `.toFixed(1)` for µm, `.toFixed(0)` for px).

### No breaking change

The old `"name"` column becomes `"Name"` (capitalised). All other existing columns follow unchanged.

---

## Files Changed

| File | Change |
|------|--------|
| `frontend/app.js` | `takeSnapshot`, `undo`, `redo`, `undoStack`, `redoStack`; `snapPoint()`; `state.snapTarget` init + clear; snap indicator in `redraw`; clipboard copy in sidebar row handler; `formatCsvValue()`; CSV header/rows |
| `frontend/style.css` | `.copied` flash animation (brief green background on sidebar row) |
