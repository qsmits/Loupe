# Annotation Management Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overhaul annotation selection, multi-select, bulk operations, detection elevation, context menu, and granular clear — making the app usable for real inspection workflows.

**Architecture:** Migrate `state.selected` from a single ID to a `Set` of IDs, enabling multi-select. Add hit-testing for all detection types. Add rectangle drag-select, Shift+click, elevation (detection→measurement), right-click context menu, and a Clear dropdown menu. All changes are frontend-only.

**Tech Stack:** Vanilla JS ES modules, Canvas 2D API, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-25-annotation-management-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `frontend/state.js` | `selected` becomes `new Set()`. Add `_selectRect`, `_flashExpiry` transient fields. |
| `frontend/tools.js` | Add hit-test cases for `detected-line-merged`, `detected-arc-partial`. Rewrite `handleSelectDown` for Set + Shift+click. Add drag-rect initiation. Add `elevateAnnotation()` / `elevateSelected()`. |
| `frontend/render.js` | All draw functions: derive `sel` from Set. Add selection rect rendering. Add flash halo. Fix `arc-measure` selection color. Add handles to missing types. |
| `frontend/main.js` | Migrate all `state.selected` refs to Set API. Fix undo/redo. Wire `U` key. Wire Delete for Set. Add `contextmenu` handler. Add drag-rect mouse handlers. |
| `frontend/sidebar.js` | Use `state.selected.has()`. Multi-highlight. Flash trigger. Selection count in status. |
| `frontend/annotations.js` | Add `deleteSelected()`, `clearDetections()`, `clearMeasurements()`, `clearDxfOverlay()`, `clearAll()`. |
| `frontend/index.html` | Add `<div id="context-menu">`. Add "Clear ▾" dropdown in top bar. |
| `frontend/style.css` | Context menu styles. Multi-select sidebar styles. |
| `frontend/session.js` | Reset `state.selected` to `new Set()` on load. |

---

### Task 1: Migrate `state.selected` from ID to Set

**Files:**
- Modify: `frontend/state.js`
- Modify: `frontend/main.js`
- Modify: `frontend/tools.js`
- Modify: `frontend/render.js`
- Modify: `frontend/sidebar.js`
- Modify: `frontend/annotations.js`
- Modify: `frontend/session.js`

This is the foundational change. Every file that reads or writes `state.selected` must be updated. The app must work identically after this change (single-select still works, just backed by a Set).

- [ ] **Step 1: Update `state.js`**

In `frontend/state.js`, change line 9:
```js
// Before
selected: null,
// After
selected: new Set(),  // Set of annotation IDs; empty = nothing selected
```

Add transient fields after `_dxfOriginMode` (around line 37):
```js
_selectRect: null,    // { x1, y1, x2, y2 } during drag-select
_flashExpiry: 0,      // timestamp for sidebar→canvas flash effect
```

- [ ] **Step 2: Update `main.js` — undo/redo**

In `frontend/main.js`, find the undo function (line 25) and redo function (line 36). Both have:
```js
state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null;
```
Replace both with:
```js
state.selected = new Set(
  [...state.selected].filter(id => state.annotations.some(a => a.id === id))
);
```

- [ ] **Step 3: Update `main.js` — Delete key handler**

Find line 311:
```js
if ((e.key === "Delete" || e.key === "Backspace") && state.selected !== null) {
  deleteAnnotation(state.selected);
```
Replace with:
```js
if ((e.key === "Delete" || e.key === "Backspace") && state.selected.size > 0) {
  pushUndo();
  for (const id of [...state.selected]) {
    const ann = state.annotations.find(a => a.id === id);
    if (!ann) continue;
    // Special cleanup (same as deleteAnnotation)
    if (ann.type === "calibration") { state.calibration = null; }
    if (ann.type === "origin") { state.origin = null; }
    if (ann.type === "dxf-overlay") {
      const p = document.getElementById("dxf-panel"); if (p) p.style.display = "none";
    }
    state.annotations = state.annotations.filter(a => a.id !== id);
  }
  state.selected = new Set();
  renderSidebar();
  redraw();
```

**Refactor:** Extract the cleanup logic from `deleteAnnotation` into a shared `_cleanupAnnotation(ann)` helper in `annotations.js` that handles calibration, origin, and DXF panel cleanup. Then call it from both `deleteAnnotation(id)` and the bulk delete path. This avoids divergence (the existing `deleteAnnotation` also calls `updateCalibrationButton()` and clears `state.origin` + coord display — missing these causes bugs).

```js
// In annotations.js, add:
function _cleanupAnnotation(ann) {
  if (ann.type === "calibration") { state.calibration = null; updateCalibrationButton(); }
  if (ann.type === "origin") {
    state.origin = null;
    const coordEl = document.getElementById("coord-display");
    if (coordEl) coordEl.textContent = "";
  }
  if (ann.type === "dxf-overlay") {
    const p = document.getElementById("dxf-panel"); if (p) p.style.display = "none";
  }
}

// Then refactor deleteAnnotation to use it, and add:
export function deleteSelected() {
  if (state.selected.size === 0) return;
  pushUndo();
  for (const id of [...state.selected]) {
    const ann = state.annotations.find(a => a.id === id);
    if (ann) _cleanupAnnotation(ann);
    state.annotations = state.annotations.filter(a => a.id !== id);
  }
  state.selected = new Set();
  renderSidebar();
  redraw();
}
```

Update the Delete key handler in `main.js` to call `deleteSelected()` instead of inline logic:
```js
if ((e.key === "Delete" || e.key === "Backspace") && state.selected.size > 0) {
  deleteSelected();
```

- [ ] **Step 4: Update `main.js` — Escape handler and other `state.selected = null` sites**

Find the Escape handler (around line 315-337). Look for any `state.selected = null` and replace with `state.selected = new Set()`.

Also find the `btn-clear` handler (around line 539) which has `state.selected = null` — change to `state.selected = new Set()`.

Search the entire file for any remaining `state.selected = null` and replace all with `state.selected = new Set()`.

- [ ] **Step 5: Update `tools.js` — `handleSelectDown`**

Find `handleSelectDown` (line 355). Currently sets `state.selected = ann.id` on hit and `state.selected = null` on miss. Replace:
- Hit: `state.selected = new Set([ann.id])`
- Miss: `state.selected = new Set()`

Also update the handle-test section that checks `if (state.selected !== null)` — change to `if (state.selected.size === 1)`. Get the single selected ID with `[...state.selected][0]`.

- [ ] **Step 6: Update `render.js` — drawing dispatch**

In `drawAnnotations()` (line 303), the `sel` variable passed to draw functions is computed from `state.selected === ann.id`. Change every instance to `state.selected.has(ann.id)`.

Search for all occurrences of `state.selected` in render.js and update.

- [ ] **Step 7: Update `sidebar.js`**

In `renderSidebar()`, the selected check (around line 31) is `ann.id === state.selected`. Change to `state.selected.has(ann.id)`.

The sidebar click handler (around line 45) sets `state.selected = ann.id`. Change to `state.selected = new Set([ann.id])`.

The double-click copy check uses `state.selected === ann.id` — change to `state.selected.has(ann.id)`.

- [ ] **Step 8: Update `annotations.js`**

In `addAnnotation()` (line 10), `state.selected = ann.id` → `state.selected = new Set([ann.id])`.

In `deleteAnnotation()` (line 27), `if (state.selected === id) state.selected = null` → `state.selected.delete(id)`.

- [ ] **Step 9: Update `session.js`**

In `loadSession()` (around line 396), `state.selected = null` → `state.selected = new Set()`.

- [ ] **Step 10: Verify the app works identically**

Start the server: `NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000`

Test:
1. Create a distance measurement → it auto-selects (sidebar highlights, canvas shows blue)
2. Click another annotation → first deselects, second selects
3. Press Delete → selected annotation is removed
4. Undo (Ctrl+Z) → annotation comes back
5. Escape → deselects

- [ ] **Step 11: Commit**

```bash
git add frontend/state.js frontend/main.js frontend/tools.js frontend/render.js frontend/sidebar.js frontend/annotations.js frontend/session.js
git commit -m "refactor: migrate state.selected from single ID to Set for multi-select support"
```

---

### Task 2: Hit-Testing for Detection Types

**Files:**
- Modify: `frontend/tools.js` (hitTestAnnotation, around line 427)

- [ ] **Step 1: Add `detected-line-merged` hit-test**

In `hitTestAnnotation()`, find the end of the existing cases (around line 534). Add before the final `return false`:

```js
if (ann.type === "detected-line-merged") {
  const sx = ann.frameWidth ? canvas.width / ann.frameWidth : 1;
  const sy = ann.frameHeight ? canvas.height / ann.frameHeight : 1;
  const x1 = ann.x1 * sx, y1 = ann.y1 * sy, x2 = ann.x2 * sx, y2 = ann.y2 * sy;
  return distPointToSegment(pt, { x: x1, y: y1 }, { x: x2, y: y2 }) < 8;
}
```

Note: `distPointToSegment` is already used in this function for other line types. `canvas` must be imported from `render.js` — check if it's already imported at the top of tools.js.

- [ ] **Step 2: Add `detected-arc-partial` hit-test**

```js
if (ann.type === "detected-arc-partial") {
  const sx = ann.frameWidth ? canvas.width / ann.frameWidth : 1;
  const sy = ann.frameHeight ? canvas.height / ann.frameHeight : 1;
  const cx = ann.cx * sx, cy = ann.cy * sy, r = ann.r * sx;
  const dist = Math.hypot(pt.x - cx, pt.y - cy);
  if (Math.abs(dist - r) > 8) return false;
  // Check angle is within arc span
  let angle = Math.atan2(pt.y - cy, pt.x - cx) * 180 / Math.PI;
  let start = ann.start_deg, end = ann.end_deg;
  // Normalize to [0, 360)
  angle = ((angle % 360) + 360) % 360;
  start = ((start % 360) + 360) % 360;
  end = ((end % 360) + 360) % 360;
  if (start <= end) {
    return angle >= start && angle <= end;
  } else {
    return angle >= start || angle <= end;
  }
}
```

- [ ] **Step 3: Verify canvas is imported in tools.js**

Check the imports at the top of `frontend/tools.js`. If `canvas` is not imported from `render.js`, add it:
```js
import { canvas } from './render.js';
```

- [ ] **Step 4: Test manually**

Run detection on a frozen frame (or load a session with detections). Switch to Select mode (V or Escape). Click on a detected line (merged) — it should select. Click on a detected arc — it should select.

- [ ] **Step 5: Commit**

```bash
git add frontend/tools.js
git commit -m "feat: add canvas hit-testing for detected-line-merged and detected-arc-partial"
```

---

### Task 3: Consistent Selection Highlighting

**Files:**
- Modify: `frontend/render.js`

- [ ] **Step 1: Fix `arc-measure` selection color**

In `drawArcMeasure` (line 359), change:
```js
ctx.strokeStyle = sel ? "#e879f9" : "#bf5af2";
```
to:
```js
ctx.strokeStyle = sel ? "#60a5fa" : "#bf5af2";
```

Also change the center dot:
```js
ctx.fillStyle = sel ? "#60a5fa" : "#bf5af2";
```

- [ ] **Step 2: Add handles to `arc-measure` when selected**

After the center dot drawing in `drawArcMeasure`, add:
```js
if (sel) {
  drawHandle(ann.p1, "#60a5fa");
  drawHandle(ann.p2, "#60a5fa");
  drawHandle(ann.p3, "#60a5fa");
}
```

- [ ] **Step 3: Add handles to `detected-line-merged` when selected**

In the inline `detected-line-merged` rendering block (around line 321), after `ctx.stroke()` and before `drawLabel(...)`, add:
```js
if (sel) {
  drawHandle({ x: x1, y: y1 }, "#60a5fa");
  drawHandle({ x: x2, y: y2 }, "#60a5fa");
}
```
(The scaled `x1, y1, x2, y2` variables are already computed earlier in that block.)

- [ ] **Step 4: Add handles to `detected-arc-partial` when selected**

In the inline `detected-arc-partial` rendering block (around line 335), after `ctx.stroke()` and before `drawLabel(...)`, add:
```js
if (sel) {
  const sx = ann.frameWidth ? canvas.width / ann.frameWidth : 1;
  const sy = ann.frameHeight ? canvas.height / ann.frameHeight : 1;
  // Handle at arc start and end points
  const startRad = ann.start_deg * Math.PI / 180;
  const endRad = ann.end_deg * Math.PI / 180;
  drawHandle({ x: ann.cx * sx + ann.r * sx * Math.cos(startRad), y: ann.cy * sy + ann.r * sx * Math.sin(startRad) }, "#60a5fa");
  drawHandle({ x: ann.cx * sx + ann.r * sx * Math.cos(endRad), y: ann.cy * sy + ann.r * sx * Math.sin(endRad) }, "#60a5fa");
}
```

Note: `sx`/`sy` are already computed earlier in the block — reuse them (move the `if (sel)` block to where they're in scope, or re-derive).

- [ ] **Step 5: Verify visually**

Select each annotation type and verify blue highlight + handles appear consistently.

- [ ] **Step 6: Commit**

```bash
git add frontend/render.js
git commit -m "feat: consistent blue selection highlighting and handles for all annotation types"
```

---

### Task 4: Sidebar ↔ Canvas Flash

**Files:**
- Modify: `frontend/sidebar.js`
- Modify: `frontend/render.js`

- [ ] **Step 1: Set flash expiry on sidebar click**

In `frontend/sidebar.js`, find the sidebar click handler (around line 45). After setting `state.selected`, add:
```js
state._flashExpiry = Date.now() + 400;
```

- [ ] **Step 2: Render flash halo in draw dispatch**

In `frontend/render.js`, in the `drawAnnotations()` function, find where `sel` is computed for each annotation. After drawing the annotation (after the draw function call), add a flash check:

```js
// At the top of drawAnnotations(), before the loop:
const flashActive = Date.now() < state._flashExpiry;

// Inside the loop, after each annotation is drawn:
if (sel && flashActive) {
  // Draw halo around the annotation's primary point
  const handles = getHandles ? null : null; // We'll use a simpler approach
  ctx.save();
  ctx.strokeStyle = "rgba(96, 165, 250, 0.5)";
  ctx.lineWidth = 6;
  ctx.setLineDash([]);
  // Re-stroke the same path with thick semi-transparent blue
  // This is simplest done by just re-calling the draw function
  // with extra lineWidth... but that's complex. Instead:
  // For the flash, just draw a circle around the annotation's center
  // This is good enough to draw attention.
  ctx.restore();
}
```

Actually, a simpler approach: after drawing each selected annotation during the flash period, draw a pulsing ring at the annotation's approximate center. Determine center per type:

```js
if (sel && flashActive) {
  let fx, fy;
  if (ann.a && ann.b) { fx = (ann.a.x + ann.b.x) / 2; fy = (ann.a.y + ann.b.y) / 2; }
  else if (ann.cx != null) { fx = ann.cx; fy = ann.cy; }
  else if (ann.vertex) { fx = ann.vertex.x; fy = ann.vertex.y; }
  else if (ann.x != null) { fx = ann.x; fy = ann.y; }
  if (fx != null) {
    // Apply frame scaling for detected types
    if (ann.frameWidth) {
      fx *= canvas.width / ann.frameWidth;
      fy *= canvas.height / ann.frameHeight;
    }
    ctx.save();
    ctx.strokeStyle = "rgba(96, 165, 250, 0.5)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(fx, fy, 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
```

Add a `requestAnimationFrame` call at the end of `drawAnnotations()` to trigger a redraw when the flash expires:
```js
if (flashActive) {
  requestAnimationFrame(() => redraw());
}
```

- [ ] **Step 3: Test manually**

Create several annotations. Click items in the sidebar — the canvas annotation should briefly pulse with a blue ring.

- [ ] **Step 4: Commit**

```bash
git add frontend/sidebar.js frontend/render.js
git commit -m "feat: flash halo on canvas when selecting annotation from sidebar"
```

---

### Task 5: Shift+Click and Drag-Select Rectangle

**Files:**
- Modify: `frontend/tools.js`
- Modify: `frontend/main.js`
- Modify: `frontend/render.js`

- [ ] **Step 1: Update `handleSelectDown` for Shift+click**

In `frontend/tools.js`, rewrite `handleSelectDown(pt, e)`:

```js
export function handleSelectDown(pt, e) {
  // Single-select: try drag handles first (only if exactly 1 selected)
  if (state.selected.size === 1) {
    const selId = [...state.selected][0];
    const ann = state.annotations.find(a => a.id === selId);
    if (ann) {
      const hk = hitTestHandle(ann, pt);
      if (hk) {
        state.dragState = { annotationId: ann.id, handleKey: hk, startX: pt.x, startY: pt.y };
        return;
      }
    }
  }

  // Hit-test all annotations (reverse order = top first)
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    if (hitTestAnnotation(ann, pt)) {
      if (e.shiftKey) {
        // Shift+click: toggle in/out of selection
        const newSet = new Set(state.selected);
        if (newSet.has(ann.id)) newSet.delete(ann.id);
        else newSet.add(ann.id);
        state.selected = newSet;
      } else {
        // Normal click: replace selection
        state.selected = new Set([ann.id]);
        // Start body drag
        state.dragState = { annotationId: ann.id, handleKey: "body", startX: pt.x, startY: pt.y };
      }
      renderSidebar();
      redraw();
      return;
    }
  }

  // Clicked empty space
  if (e.shiftKey) {
    // Shift+click on empty: do nothing (preserve selection)
    return;
  }
  // Start drag-select rectangle
  state._selectRect = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  state.selected = new Set();
  renderSidebar();
  redraw();
}
```

- [ ] **Step 2: Add drag-rect mousemove in `main.js`**

In the `mousemove` handler (around line 149), near the top (after DXF drag mode check, before the general drag check), add:

```js
if (state._selectRect) {
  const pt = canvasPoint(e);
  state._selectRect.x2 = pt.x;
  state._selectRect.y2 = pt.y;
  redraw();
  return;
}
```

- [ ] **Step 3: Add drag-rect mouseup in `main.js`**

In `onMouseUp()` (line 136), add before the existing dragState check:

```js
if (state._selectRect) {
  const r = state._selectRect;
  const minX = Math.min(r.x1, r.x2), maxX = Math.max(r.x1, r.x2);
  const minY = Math.min(r.y1, r.y2), maxY = Math.max(r.y1, r.y2);

  // Only select if the rectangle is at least 5px in both dimensions (avoid accidental clicks)
  if (maxX - minX > 5 && maxY - minY > 5) {
    const ids = [];
    for (const ann of state.annotations) {
      const cp = _annotationPrimaryPoint(ann);
      if (cp && cp.x >= minX && cp.x <= maxX && cp.y >= minY && cp.y <= maxY) {
        ids.push(ann.id);
      }
    }
    state.selected = new Set(ids);
    if (ids.length > 0) showStatus(`${ids.length} selected`);
  }
  state._selectRect = null;
  renderSidebar();
  redraw();
  return;
}
```

- [ ] **Step 4: Add `_annotationPrimaryPoint` helper in `main.js`**

```js
function _annotationPrimaryPoint(ann) {
  // Frame-scaled types
  if (ann.frameWidth) {
    const sx = canvas.width / ann.frameWidth;
    const sy = canvas.height / ann.frameHeight;
    if (ann.cx != null) return { x: ann.cx * sx, y: ann.cy * sy };
    if (ann.x1 != null) return { x: (ann.x1 + ann.x2) / 2 * sx, y: (ann.y1 + ann.y2) / 2 * sy };
    if (ann.x != null) return { x: ann.x * sx, y: ann.y * sy };
  }
  // Canvas-space types
  if (ann.a && ann.b) return { x: (ann.a.x + ann.b.x) / 2, y: (ann.a.y + ann.b.y) / 2 };
  if (ann.cx != null) return { x: ann.cx, y: ann.cy };
  if (ann.vertex) return { x: ann.vertex.x, y: ann.vertex.y };
  if (ann.x != null) return { x: ann.x, y: ann.y };
  if (ann.points) {
    const cx = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length;
    const cy = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length;
    return { x: cx, y: cy };
  }
  return null;
}
```

- [ ] **Step 5: Render the selection rectangle**

In `frontend/render.js`, in `drawAnnotations()`, after all annotations are drawn, add:

```js
// Draw selection rectangle if active
if (state._selectRect) {
  const r = state._selectRect;
  ctx.save();
  ctx.strokeStyle = "#60a5fa";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.fillStyle = "rgba(96, 165, 250, 0.1)";
  ctx.beginPath();
  ctx.rect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
```

- [ ] **Step 6: Test manually**

1. Enter Select mode. Drag on empty canvas → blue dashed rectangle appears
2. Release → annotations inside are selected (sidebar highlights multiple)
3. Shift+click an unselected annotation → added to selection
4. Shift+click a selected annotation → removed from selection
5. Click empty space → clears selection

- [ ] **Step 7: Commit**

```bash
git add frontend/tools.js frontend/main.js frontend/render.js
git commit -m "feat: Shift+click multi-select and rectangle drag-select"
```

---

### Task 6: Elevation — Detection to Measurement

**Files:**
- Modify: `frontend/annotations.js`
- Modify: `frontend/main.js`
- Modify: `frontend/render.js` (import `canvas` for scaling)

- [ ] **Step 1: Add elevation functions to `annotations.js`**

Add imports at the top of `annotations.js`:
```js
import { canvas } from './render.js';
```

Add after `applyCalibration`:

```js
// ── Detection → Measurement elevation ────────────────────────────────────────

const DETECTION_TYPES = new Set([
  "detected-circle", "detected-line", "detected-line-merged", "detected-arc-partial"
]);

export function isDetection(ann) {
  return DETECTION_TYPES.has(ann.type);
}

export function elevateAnnotation(id) {
  const ann = state.annotations.find(a => a.id === id);
  if (!ann || !isDetection(ann)) return null;

  const sx = ann.frameWidth ? canvas.width / ann.frameWidth : 1;
  const sy = ann.frameHeight ? canvas.height / ann.frameHeight : 1;

  let elevated;

  if (ann.type === "detected-line" || ann.type === "detected-line-merged") {
    elevated = {
      type: "distance",
      a: { x: ann.x1 * sx, y: ann.y1 * sy },
      b: { x: ann.x2 * sx, y: ann.y2 * sy },
    };
  } else if (ann.type === "detected-circle") {
    elevated = {
      type: "circle",
      cx: ann.x * sx,
      cy: ann.y * sy,
      r: ann.radius * sx,
    };
  } else if (ann.type === "detected-arc-partial") {
    const cx = ann.cx * sx, cy = ann.cy * sy, r = ann.r * sx;
    const startRad = ann.start_deg * Math.PI / 180;
    const endRad = ann.end_deg * Math.PI / 180;
    // Handle wrapping: if arc crosses 0°, the simple average is wrong
    let midDeg = (ann.start_deg + ann.end_deg) / 2;
    if (ann.end_deg < ann.start_deg) midDeg += 180;
    const midRad = midDeg * Math.PI / 180;
    const p1 = { x: cx + r * Math.cos(startRad), y: cy + r * Math.sin(startRad) };
    const p2 = { x: cx + r * Math.cos(midRad), y: cy + r * Math.sin(midRad) };
    const p3 = { x: cx + r * Math.cos(endRad), y: cy + r * Math.sin(endRad) };
    let spanDeg = ann.end_deg - ann.start_deg;
    if (spanDeg < 0) spanDeg += 360;
    const chordPx = Math.hypot(p3.x - p1.x, p3.y - p1.y);
    elevated = {
      type: "arc-measure",
      cx, cy, r, p1, p2, p3,
      span_deg: spanDeg,
      chord_px: chordPx,
    };
  }

  if (!elevated) return null;

  // Remove original detection
  state.annotations = state.annotations.filter(a => a.id !== id);
  state.selected.delete(id);

  // Add as new measurement
  elevated.id = state.nextId++;
  elevated.name = "";
  state.annotations.push(elevated);
  return elevated.id;
}

export function elevateSelected() {
  const toElevate = [...state.selected].filter(id => {
    const ann = state.annotations.find(a => a.id === id);
    return ann && isDetection(ann);
  });
  if (toElevate.length === 0) return;

  pushUndo();
  const newIds = [];
  for (const id of toElevate) {
    const newId = elevateAnnotation(id);
    if (newId != null) newIds.push(newId);
  }
  state.selected = new Set(newIds);
  renderSidebar();
  redraw();
  showStatus(`Elevated ${newIds.length} detection${newIds.length > 1 ? "s" : ""} to measurement${newIds.length > 1 ? "s" : ""}`);
}
```

- [ ] **Step 2: Wire `U` key in `main.js`**

In `frontend/main.js`, import `elevateSelected` from `annotations.js`:
```js
import { addAnnotation, deleteAnnotation, applyCalibration, elevateSelected } from './annotations.js';
```

In the keydown handler, add before the `toolKeys` check (around line 341):
```js
if (e.key === "u" && state.selected.size > 0) {
  elevateSelected();
  return;
}
```

- [ ] **Step 3: Import `showStatus` in `annotations.js`**

`showStatus` is in `render.js`. Add to the existing import:
```js
import { canvas, showStatus } from './render.js';
```

Check: `renderSidebar` is probably already imported. If not, add:
```js
import { renderSidebar } from './sidebar.js';
```

And `redraw` from render.js. Check existing imports and add what's needed.

- [ ] **Step 4: Test manually**

1. Run "Detect lines (merged)" on a frozen frame
2. Switch to Select mode, click a detected line → it selects
3. Press U → line converts to a distance measurement with length label in sidebar
4. Verify the measurement is editable (drag endpoints)
5. Test with detected arc → becomes arc-measure
6. Test bulk: drag-select multiple detections, press U → all elevated

- [ ] **Step 5: Commit**

```bash
git add frontend/annotations.js frontend/main.js
git commit -m "feat: elevate detections to measurements (U key or context menu)"
```

---

### Task 7: Right-Click Context Menu

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/style.css`
- Modify: `frontend/main.js`
- Modify: `frontend/annotations.js`

- [ ] **Step 1: Add context menu HTML**

In `frontend/index.html`, before the closing `</body>` tag, add:

```html
  <div id="context-menu" hidden></div>
```

- [ ] **Step 2: Add context menu CSS**

In `frontend/style.css`, add:

```css
/* ─── Context menu ───────────────────────────────── */
#context-menu {
  position: fixed;
  z-index: 1000;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 180px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
#context-menu[hidden] { display: none; }
.ctx-item {
  display: block;
  width: 100%;
  padding: 6px 14px;
  border: none;
  background: none;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.ctx-item:hover { background: var(--surface-3); }
.ctx-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}
```

- [ ] **Step 3: Add clear helper functions to `annotations.js`**

Add the `isDetection` function was already added in Task 6. Now add clear functions:

```js
const OVERLAY_TYPES = new Set(["edges-overlay", "preprocessed-overlay"]);

export function clearDetections() {
  pushUndo();
  state.annotations = state.annotations.filter(a =>
    !DETECTION_TYPES.has(a.type) && !OVERLAY_TYPES.has(a.type)
  );
  state.selected = new Set();
  renderSidebar();
  redraw();
  showStatus("Cleared detections");
}

const INFRASTRUCTURE_TYPES = new Set(["calibration", "origin"]);

export function clearMeasurements() {
  pushUndo();
  state.annotations = state.annotations.filter(a =>
    DETECTION_TYPES.has(a.type) || OVERLAY_TYPES.has(a.type) ||
    INFRASTRUCTURE_TYPES.has(a.type) || a.type === "dxf-overlay"
  );
  state.selected = new Set();
  renderSidebar();
  redraw();
  showStatus("Cleared measurements");
}

export function clearDxfOverlay() {
  pushUndo();
  state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
  state.inspectionResults = [];
  state.inspectionFrame = null;
  state.dxfFilename = null;
  const p = document.getElementById("dxf-panel");
  if (p) p.style.display = "none";
  state.selected = new Set();
  renderSidebar();
  redraw();
  showStatus("Cleared DXF overlay");
}

export function clearAll() {
  if (!confirm("Clear all annotations? Calibration and origin will be preserved.")) return;
  pushUndo();
  state.annotations = state.annotations.filter(a =>
    a.type === "calibration" || a.type === "origin"
  );
  state.inspectionResults = [];
  state.inspectionFrame = null;
  state.dxfFilename = null;
  const p = document.getElementById("dxf-panel");
  if (p) p.style.display = "none";
  state.selected = new Set();
  renderSidebar();
  redraw();
  showStatus("Cleared all annotations");
}
```

- [ ] **Step 4: Add context menu logic in `main.js`**

Import the new functions:
```js
import { ..., elevateSelected, isDetection, clearDetections, clearMeasurements, clearDxfOverlay, clearAll } from './annotations.js';
```

Add context menu handler:

```js
// ── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById("context-menu");

function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  for (const item of items) {
    if (item === "---") {
      const d = document.createElement("div");
      d.className = "ctx-divider";
      ctxMenu.appendChild(d);
    } else {
      const btn = document.createElement("button");
      btn.className = "ctx-item";
      btn.textContent = item.label;
      btn.addEventListener("click", () => { ctxMenu.hidden = true; item.action(); });
      ctxMenu.appendChild(btn);
    }
  }
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
  ctxMenu.hidden = false;
}

function hideContextMenu() { ctxMenu.hidden = true; }

document.addEventListener("click", hideContextMenu);
document.addEventListener("keydown", e => { if (e.key === "Escape") hideContextMenu(); });

canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  const pt = canvasPoint(e);

  // Check if right-clicked on a selected annotation
  if (state.selected.size > 0) {
    const items = [];
    const hasDetections = [...state.selected].some(id => {
      const ann = state.annotations.find(a => a.id === id);
      return ann && isDetection(ann);
    });
    if (hasDetections) {
      items.push({ label: "Elevate to measurement", action: elevateSelected });
    }
    items.push({ label: `Delete (${state.selected.size})`, action: () => {
      pushUndo();
      for (const id of [...state.selected]) {
        const ann = state.annotations.find(a => a.id === id);
        if (!ann) continue;
        if (ann.type === "calibration") state.calibration = null;
        if (ann.type === "origin") state.origin = null;
        if (ann.type === "dxf-overlay") {
          const p = document.getElementById("dxf-panel"); if (p) p.style.display = "none";
        }
        state.annotations = state.annotations.filter(a => a.id !== id);
      }
      state.selected = new Set();
      renderSidebar();
      redraw();
    }});
    if (state.selected.size === 1) {
      const ann = state.annotations.find(a => a.id === [...state.selected][0]);
      if (ann && !isDetection(ann)) {
        items.push({ label: "Rename", action: () => {
          const row = document.querySelector(`.measurement-item[data-id="${ann.id}"]`);
          if (row) row.querySelector(".measurement-name")?.focus();
        }});
      }
    }
    showContextMenu(e.clientX, e.clientY, items);
    return;
  }

  // Right-click on empty canvas
  showContextMenu(e.clientX, e.clientY, [
    { label: "Clear detections", action: clearDetections },
    { label: "Clear measurements", action: clearMeasurements },
    { label: "Clear DXF overlay", action: clearDxfOverlay },
    "---",
    { label: "Clear all", action: clearAll },
  ]);
});
```

- [ ] **Step 5: Test manually**

1. Right-click empty canvas → shows Clear menu
2. Click "Clear detections" → only detections removed
3. Run detection, select a detected line, right-click → shows "Elevate" + "Delete"
4. Click "Elevate" → converts to measurement
5. Select a measurement, right-click → shows "Delete" + "Rename"

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/style.css frontend/main.js frontend/annotations.js
git commit -m "feat: right-click context menu with elevate, delete, rename, and clear operations"
```

---

### Task 8: Clear Menu in Top Bar

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/main.js`

- [ ] **Step 1: Add Clear dropdown to `index.html`**

In `frontend/index.html`, find the top bar menu groups. After the last `</div>` of the existing menu groups (before `<div class="top-bar-right">`), add:

```html
    <div class="menu-group">
      <button class="menu-btn" id="btn-menu-clear">Clear ▾</button>
      <div class="dropdown" id="dropdown-clear" hidden>
        <button class="dropdown-item" id="btn-clear-detections">Clear detections</button>
        <button class="dropdown-item" id="btn-clear-measurements">Clear measurements</button>
        <button class="dropdown-item" id="btn-clear-dxf">Clear DXF overlay</button>
        <div class="dropdown-divider"></div>
        <button class="dropdown-item" id="btn-clear-all">Clear all</button>
      </div>
    </div>
```

- [ ] **Step 2: Wire dropdown toggle in `main.js`**

The existing dropdown toggle logic in `main.js` should handle this automatically if it follows the same pattern as other menu groups. Verify: search for `btn-menu-measure` or `dropdown-measure` in main.js to see how existing dropdowns are toggled. The Clear dropdown should follow the same pattern.

If the dropdown toggle is generic (based on `.menu-btn` + sibling `.dropdown`), it may work automatically. If not, add the toggle handler matching the existing pattern.

**Important:** Update the `closeAllDropdowns()` function (around line 42 of main.js) to include `"dropdown-clear"` in its list of dropdown IDs. Currently it lists `["dropdown-measure","dropdown-detect","dropdown-overlay"]`. Without this, the Clear dropdown won't close when other dropdowns open.

- [ ] **Step 3: Wire button click handlers**

```js
document.getElementById("btn-clear-detections")?.addEventListener("click", clearDetections);
document.getElementById("btn-clear-measurements")?.addEventListener("click", clearMeasurements);
document.getElementById("btn-clear-dxf")?.addEventListener("click", clearDxfOverlay);
document.getElementById("btn-clear-all")?.addEventListener("click", clearAll);
```

- [ ] **Step 4: Test manually**

Click "Clear ▾" in the top bar → dropdown shows 4 options. Test each one.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/main.js
git commit -m "feat: add Clear dropdown menu in top bar"
```

---

### Task 9: Status Bar Selection Count

**Files:**
- Modify: `frontend/sidebar.js`

- [ ] **Step 1: Show selection count in status bar**

In `frontend/sidebar.js`, update the `renderSidebar()` function. After rendering all items, add:

```js
// Update status bar with selection count
if (state.selected.size > 1) {
  const detCount = [...state.selected].filter(id => {
    const ann = state.annotations.find(a => a.id === id);
    return ann && DETECTION_TYPES.has(ann.type);
  }).length;
  const measCount = state.selected.size - detCount;
  let msg = `${state.selected.size} selected`;
  if (detCount > 0 && measCount > 0) msg = `${detCount} detection${detCount > 1 ? "s" : ""}, ${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
  showStatus(msg);
}
```

For the detection type check, do NOT import from annotations.js (that would create a circular import since annotations.js imports from sidebar.js). Instead, either:
- Export `DETECTION_TYPES` from `state.js` (alongside `TRANSIENT_TYPES`), or
- Inline the check: `["detected-circle","detected-line","detected-line-merged","detected-arc-partial"].includes(ann.type)`

The simplest and cleanest option: add `export const DETECTION_TYPES = new Set(["detected-circle", "detected-line", "detected-line-merged", "detected-arc-partial"]);` to `state.js` and import it in both `annotations.js` and `sidebar.js`.

Note: `showStatus` must be imported from render.js if not already.

- [ ] **Step 2: Commit**

```bash
git add frontend/sidebar.js
git commit -m "feat: show selection count and type breakdown in status bar"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Full workflow test**

1. Freeze a frame, run all 4 detection types
2. Switch to Select mode
3. Click a detected line → selects (blue highlight + handles)
4. Shift+click a detected arc → both selected
5. Drag-select a region of false positives → all inside selected
6. Press Delete → all deleted, sidebar updates
7. Undo → they come back
8. Select good detections, press U → elevated to measurements with labels
9. Clear detections → remaining noise gone, elevated measurements stay
10. Right-click → context menu works
11. Clear menu in top bar works
12. Save session → measurements preserved, detections not
13. Load session → measurements restore correctly

- [ ] **Step 2: Commit any fixes**

```bash
git add -p
git commit -m "fix: <description>"
```
