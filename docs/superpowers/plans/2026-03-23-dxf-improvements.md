# DXF Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DXF overlay usable for part alignment — rotation follows the coordinate origin, point-pair alignment replaces trial-and-error anchor placement, scale auto-derives from calibration, and mirror controls handle upside-down parts.

**Dependency:** This plan must be implemented AFTER `docs/superpowers/plans/2026-03-23-tool-quirks.md`. That plan updates `snapPoint` to accept a `bypass` parameter and return `{pt, snapped}`. Task 4 (point-pair alignment) depends on that new signature.

**Architecture:** All changes are frontend-only. No backend changes.

**Tech Stack:** Vanilla JS, Canvas 2D API.

---

## File Map

| File | What changes |
|------|-------------|
| `frontend/app.js` | Refactor `drawDxfOverlay`; add `dxfToCanvas`, `collectDxfSnapPoints`, `enterDxfAlignMode`, `exitDxfAlignMode`; add alignment mode branches in `onMouseDown`, `onMouseMove`, Escape handler, `redraw()`; scale auto-derive in `applyCalibration` and DXF load handler; flip toggle handlers; state additions |
| `frontend/index.html` | DXF panel: add Flip H, Flip V, Re-align buttons |

---

## Task 1: Add alignment and flip state fields to `state` object

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add new fields to the `state` object**

The `state` object is at line 2 of `frontend/app.js`. Add five new fields inside the object literal, after the existing `snapTarget` field:

```js
mousePos: { x: 0, y: 0 },   // last known canvas mouse position (for rubber-band)
dxfAlignMode: false,          // true when alignment mode is active
dxfAlignStep: 0,              // 0 = waiting for DXF pick, 1 = waiting for image pick
dxfAlignPick: null,           // { canvas: {x,y} } of selected DXF snap point
dxfAlignHover: null,          // { canvas: {x,y} } of nearest DXF snap point under cursor
```

These fields are transient — they are not included in `takeSnapshot()` and therefore not serialised to undo/redo state.

---

## Task 2: Add HTML buttons to the DXF panel

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Insert Flip H, Flip V, and Re-align buttons into the DXF panel**

Find the DXF panel section in `frontend/index.html` (around line 122). The current content is:

```html
      <button class="tool-btn detect-action-btn" id="btn-dxf-set-origin">Set origin (click canvas)</button>
      <button class="tool-btn detect-action-btn" id="btn-dxf-clear">Clear DXF</button>
```

Replace with:

```html
      <div class="camera-row" style="gap:4px">
        <button class="tool-btn" id="btn-dxf-flip-h">Flip H</button>
        <button class="tool-btn" id="btn-dxf-flip-v">Flip V</button>
        <button class="tool-btn" id="btn-dxf-realign">Re-align</button>
      </div>
      <button class="tool-btn detect-action-btn" id="btn-dxf-set-origin">Set origin (click canvas)</button>
      <button class="tool-btn detect-action-btn" id="btn-dxf-clear">Clear DXF</button>
```

No new CSS is needed — `btn-dxf-flip-h` and `btn-dxf-flip-v` reuse `.tool-btn` and `.tool-btn.active` styles that already exist.

---

## Task 3: Refactor `drawDxfOverlay` to use canvas transforms + add `dxfToCanvas` helper

**Files:**
- Modify: `frontend/app.js`

This is the prerequisite for all features. The existing `drawDxfOverlay` (lines 1167–1200) uses arithmetic `tx`/`ty` functions. Replace it with a transform-based approach so rotation, flipH, and flipV are handled by the canvas matrix.

- [ ] **Step 1: Replace `drawDxfOverlay` (lines 1167–1200)**

Replace the entire existing `drawDxfOverlay` function body with:

```js
function drawDxfOverlay(ann) {
  const { entities, offsetX, offsetY, scale, flipH = false, flipV = false } = ann;
  const angle = state.origin?.angle ?? 0;

  ctx.save();
  ctx.strokeStyle = "#00d4ff";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 3]);

  // Build transform: translate to anchor → rotate → flip → scale+Y-flip
  ctx.translate(offsetX, offsetY);
  if (angle) ctx.rotate(angle);
  if (flipH) ctx.scale(-1, 1);
  if (flipV) ctx.scale(1, -1);
  ctx.scale(scale, -scale);   // DXF Y-up → canvas Y-down

  for (const en of entities) {
    ctx.beginPath();
    if (en.type === "line") {
      ctx.moveTo(en.x1, en.y1);
      ctx.lineTo(en.x2, en.y2);
    } else if (en.type === "circle") {
      ctx.arc(en.cx, en.cy, en.radius, 0, Math.PI * 2);
    } else if (en.type === "arc") {
      const sr = en.start_angle * Math.PI / 180;
      const er = en.end_angle * Math.PI / 180;
      // DXF arcs are CCW. The base transform (scale(s,-s)) is LEFT-handed,
      // so anticlockwise=false renders CCW visually — correct for DXF.
      // Each additional reflection (flipH or flipV, but not both) flips the
      // handedness back to RIGHT-handed, which inverts the visual winding.
      // Compensate by flipping anticlockwise when exactly one flip is active.
      ctx.arc(en.cx, en.cy, en.radius, sr, er, flipH !== flipV);
    } else if (en.type === "polyline") {
      if (en.points.length < 2) continue;
      ctx.moveTo(en.points[0].x, en.points[0].y);
      for (let i = 1; i < en.points.length; i++) {
        ctx.lineTo(en.points[i].x, en.points[i].y);
      }
      if (en.closed) ctx.closePath();
    }
    ctx.stroke();
  }

  ctx.restore();
}
```

Key differences from the old function:
- No `tx`/`ty` arithmetic helpers — the canvas transform matrix does all coordinate mapping.
- Reads `state.origin?.angle ?? 0` for rotation (Issue 1 is handled here, no separate task needed).
- Reads `ann.flipH` and `ann.flipV` (both default `false` — no change to DXF files without flip fields).
- Arc anticlockwise flag: `flipH !== flipV` (true when exactly one flip is active, compensating for handedness change).
- Note that `en.radius` is used directly (not `en.radius * scale`) because the canvas transform already applies `scale`.

- [ ] **Step 2: Add `dxfToCanvas` helper function immediately after `drawDxfOverlay`**

Insert this function directly after the closing `}` of `drawDxfOverlay`:

```js
function dxfToCanvas(x, y, ann) {
  const { offsetX, offsetY, scale, flipH = false, flipV = false } = ann;
  const angle = state.origin?.angle ?? 0;
  const xf = flipH ? -x : x;
  const yf = flipV ? -y : y;
  let cx = xf * scale;
  let cy = -yf * scale;           // Y-flip
  if (angle) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    [cx, cy] = [cx * cos - cy * sin, cx * sin + cy * cos];
  }
  return { x: offsetX + cx, y: offsetY + cy };
}
```

This function mirrors the canvas transform matrix math in plain arithmetic. It is used outside a draw context — specifically in `collectDxfSnapPoints` and the alignment mode click/hover logic — where `ctx.translate`/`ctx.rotate`/`ctx.scale` cannot be used.

---

## Task 4: Point-pair alignment mode

**Files:**
- Modify: `frontend/app.js`

**Dependency:** Requires Task 3 (`dxfToCanvas` must exist). Also requires the tool-quirks plan to be implemented so `snapPoint` accepts a `bypass` parameter and returns `{pt, snapped}`.

- [ ] **Step 1: Add `collectDxfSnapPoints` function**

Insert immediately after `dxfToCanvas`:

```js
function collectDxfSnapPoints(ann) {
  const pts = [];
  for (const en of ann.entities) {
    if (en.type === "line") {
      pts.push({ x: en.x1, y: en.y1 }, { x: en.x2, y: en.y2 });
    } else if (en.type === "circle" || en.type === "arc") {
      pts.push({ x: en.cx, y: en.cy });
    } else if (en.type === "polyline") {
      for (const p of en.points) pts.push({ x: p.x, y: p.y });
    }
  }
  return pts.map(p => ({ dxf: p, canvas: dxfToCanvas(p.x, p.y, ann) }));
}
```

Each returned object has `dxf` (raw DXF coords) and `canvas` (screen coords for distance checks and rendering).

- [ ] **Step 2: Add `enterDxfAlignMode` and `exitDxfAlignMode` functions**

Insert these two functions immediately after `collectDxfSnapPoints`:

```js
function enterDxfAlignMode() {
  state.dxfAlignMode = true;
  state.dxfAlignStep = 0;
  state.dxfAlignPick = null;
  state.dxfAlignHover = null;
  if (_dxfOriginMode) {
    _dxfOriginMode = false;
    document.getElementById("btn-dxf-set-origin").classList.remove("active");
  }
  showStatus("Click a DXF feature to anchor…");
}

function exitDxfAlignMode() {
  state.dxfAlignMode = false;
  state.dxfAlignStep = 0;
  state.dxfAlignPick = null;
  state.dxfAlignHover = null;
}
```

`enterDxfAlignMode` deactivates `_dxfOriginMode` if it was active — the two modes cannot coexist.

`showStatus` is the helper used elsewhere to update the status bar; use it in the same way as other places in the file (e.g., search for existing `showStatus(` calls to confirm the exact function name; if it does not exist, write directly to `statusEl.textContent` as the existing code does in the `_dxfOriginMode` handler).

- [ ] **Step 3: Add mousemove branch for alignment mode**

In the `canvas.addEventListener("mousemove", ...)` handler (around line 1491), add a new branch at the very top of the callback — before the `if (state.dragState)` check. Insert it right after `const pt = canvasPoint(e);`:

```js
  state.mousePos = pt;   // always update for rubber-band line

  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      const pts = collectDxfSnapPoints(ann);
      const SNAP_R = 12;
      let best = null, bestD = Infinity;
      for (const p of pts) {
        const d = Math.hypot(pt.x - p.canvas.x, pt.y - p.canvas.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      state.dxfAlignHover = (bestD < SNAP_R) ? best : null;
    }
    redraw();
    return;   // skip all other mousemove tool logic
  }
```

The `return` ensures alignment mode intercepts all mouse movement and no other tool logic fires.

- [ ] **Step 4: Add click branch for alignment mode in `onMouseDown`**

In `onMouseDown` (line 137), add a new branch at the very top — before the `if (_originMode)` check. Insert it right after `const pt = canvasPoint(e);`:

```js
  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) { exitDxfAlignMode(); return; }

    if (state.dxfAlignStep === 0) {
      // Step 1: pick DXF snap point
      const target = state.dxfAlignHover;
      if (!target) return;   // no snap point nearby — ignore click
      state.dxfAlignPick = target;
      state.dxfAlignStep = 1;
      statusEl.textContent = "Click the image point to align to…";

    } else {
      // Step 2: pick image point (use Alt to bypass snapping)
      const imagePt = e.altKey ? pt : snapPoint(pt, false).pt;
      pushUndo();
      ann.offsetX += imagePt.x - state.dxfAlignPick.canvas.x;
      ann.offsetY += imagePt.y - state.dxfAlignPick.canvas.y;
      exitDxfAlignMode();
      statusEl.textContent = "DXF aligned";
      redraw();
    }
    return;
  }
```

The `snapPoint(pt, false)` call uses the `bypass=false` signature added by the tool-quirks plan. It returns `{pt, snapped}`. Only `.pt` is needed here. `e.altKey` allows the user to bypass snapping for a precise pixel placement.

- [ ] **Step 5: Add Escape key branch for alignment mode**

In the `keydown` handler (around line 181), the existing `if (e.key === "Escape")` block cancels active tools. Add a new check at the very top of the `Escape` block, before `state.pendingPoints = []`:

```js
    if (state.dxfAlignMode) { exitDxfAlignMode(); redraw(); return; }
```

- [ ] **Step 6: Add alignment mode visual indicators to `redraw()`**

In `redraw()` (line 1040), after the call to `drawCrosshair()` at the end of the function body, insert:

```js
  // DXF alignment mode indicators
  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      // Yellow open circle on nearest DXF snap point (hover target)
      if (state.dxfAlignHover) {
        const p = state.dxfAlignHover.canvas;
        ctx.save();
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      // Step 1: filled pick dot + rubber-band line to cursor
      if (state.dxfAlignStep === 1 && state.dxfAlignPick) {
        const p = state.dxfAlignPick.canvas;
        ctx.save();
        ctx.fillStyle = "#facc15";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        if (state.mousePos) {
          ctx.strokeStyle = "rgba(250,204,21,0.6)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(state.mousePos.x, state.mousePos.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }
    }
  }
```

The yellow colour (`#facc15`) is distinct from the annotation snap indicator blue (`#60a5fa`).

- [ ] **Step 7: Register Re-align button handler**

In the DXF overlay section of `frontend/app.js` (around line 2107, near the other DXF button handlers), add:

```js
document.getElementById("btn-dxf-realign").addEventListener("click", enterDxfAlignMode);
```

- [ ] **Step 8: Call `enterDxfAlignMode` after DXF loads**

In the `dxf-input` change handler (around line 2072), after the `addAnnotation(...)` call and before `redraw()`, add:

```js
    enterDxfAlignMode();
```

---

## Task 5: Scale auto-derives from calibration

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Initialise `scaleManual` and `flipH`/`flipV` fields in the DXF load handler**

In the `dxf-input` change handler (around line 2082–2092), the existing code already reads `state.calibration` to pick a default scale. Update it so the annotation tracks whether the scale was set manually:

Find the existing block:
```js
    const cal = state.calibration;
    const scale = cal ? cal.pixelsPerMm : 1;
    document.getElementById("dxf-scale").value = scale.toFixed(3);
    state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
    addAnnotation({
      type: "dxf-overlay",
      entities,
      offsetX: canvas.width / 2,
      offsetY: canvas.height / 2,
      scale,
    });
```

Replace with:
```js
    const cal = state.calibration;
    const autoScale = cal?.pixelsPerMm;
    const scale = autoScale ?? 1;
    document.getElementById("dxf-scale").value = scale.toFixed(3);
    state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
    addAnnotation({
      type: "dxf-overlay",
      entities,
      offsetX: canvas.width / 2,
      offsetY: canvas.height / 2,
      scale,
      scaleManual: !autoScale,   // false = auto from calibration; true = user override
      flipH: false,
      flipV: false,
    });
```

`flipH` and `flipV` are initialised here so Task 6's draw code always has defined values.

- [ ] **Step 2: Update the `dxf-scale` input handler to set `scaleManual = true`**

Find the existing input handler (around line 2102–2105):

```js
document.getElementById("dxf-scale").addEventListener("input", e => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (ann) { ann.scale = parseFloat(e.target.value) || 1; redraw(); }
});
```

Replace with:
```js
document.getElementById("dxf-scale").addEventListener("input", e => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const v = parseFloat(e.target.value);
  if (isFinite(v) && v > 0) {
    ann.scale = v;
    ann.scaleManual = true;   // lock out further auto-updates
    redraw();
  }
});
```

- [ ] **Step 3: Auto-update DXF scale when calibration changes**

In `applyCalibration` (line 652), after the line `state.calibration = { pixelsPerMm: pixelDist / knownMm, displayUnit: ann.unit };`, add:

```js
  // Auto-update DXF scale if it was not manually overridden
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (dxfAnn && !dxfAnn.scaleManual) {
    dxfAnn.scale = state.calibration.pixelsPerMm;
    document.getElementById("dxf-scale").value = dxfAnn.scale.toFixed(3);
  }
```

No `pushUndo()` here — `applyCalibration` already calls `pushUndo()` at its own start; a second push would create a spurious undo entry.

No `redraw()` here either — `applyCalibration` is called from the calibration workflow which calls `redraw()` (or `addAnnotation` does via the existing flow) after this function returns.

---

## Task 6: Mirror controls (Flip H / Flip V buttons)

**Files:**
- Modify: `frontend/app.js`

**Dependency:** Requires Task 2 (HTML buttons must exist) and Task 3 (`flipH`/`flipV` are read by the refactored `drawDxfOverlay`). Also requires Task 5 Step 1 to have initialised `flipH` and `flipV` on the annotation object.

- [ ] **Step 1: Register Flip H and Flip V click handlers**

In the DXF overlay section of `frontend/app.js` (around line 2107, near the other DXF button handlers), add:

```js
["flip-h", "flip-v"].forEach(id => {
  document.getElementById(`btn-dxf-${id}`).addEventListener("click", () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    pushUndo();
    const key = id === "flip-h" ? "flipH" : "flipV";
    ann[key] = !ann[key];
    document.getElementById(`btn-dxf-${id}`).classList.toggle("active", ann[key]);
    redraw();
  });
});
```

Both `flipH` and `flipV` can be active simultaneously. The `.active` class is toggled with the boolean value so it stays in sync with the annotation state.

---

## Task 7: Verify visual correctness manually

> No automated test suite exists. Manually verify the following in the browser after implementation.

- [ ] **Check 1:** Load a DXF file with lines, circles, arcs, and polylines. Verify the overlay draws correctly (same position as before the refactor). Scale the overlay with the scale input and confirm it responds.

- [ ] **Check 2:** Set a coordinate origin, then rotate it via the drag handle. Verify the DXF overlay rotates around its anchor point with the origin.

- [ ] **Check 3:** Click a DXF snap point in alignment mode (step 0 — yellow circle appears on hover). Click an image point (step 1 — rubber-band line draws to cursor). Verify the DXF anchor jumps so the picked DXF point lands on the picked image point.

- [ ] **Check 4:** Press Escape during step 0 and step 1. Verify alignment mode exits without moving the DXF.

- [ ] **Check 5:** Apply a calibration with a known pixel-per-mm value. Load a DXF and verify the scale input is pre-filled. Edit the scale input manually. Apply a new calibration and verify the scale does NOT auto-update (since `scaleManual` is now true).

- [ ] **Check 6:** Load a DXF, click Flip H. Verify the overlay mirrors horizontally. Click Flip V. Verify both axes are flipped. Verify the Flip H and Flip V buttons show the `.active` style. Undo each flip and verify it reverses.

---

## Notes

- **Issue 1 (rotation follows origin):** This is fully covered by the `drawDxfOverlay` refactor in Task 3. The new `drawDxfOverlay` reads `state.origin?.angle ?? 0` and applies it as a `ctx.rotate(angle)`. No separate task is needed.

- **Session persistence:** `flipH`, `flipV`, and `scaleManual` are plain fields on the annotation object and are included in `takeSnapshot()` automatically via `JSON.stringify({ annotations: state.annotations, ... })`. No changes to `takeSnapshot` or `undo`/`redo` are needed.

- **`dxfAlignMode` and related fields are transient:** They are not added to `takeSnapshot()`. Alignment mode always starts fresh after an undo/redo.

- **`showStatus` vs `statusEl.textContent`:** Search `frontend/app.js` for `showStatus` before using it. If no such helper exists, write directly to `statusEl.textContent` as the existing code does in the `_dxfOriginMode` handler.
