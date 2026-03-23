# DXF Improvements Design

## Goal

Make the DXF overlay actually usable for part alignment: rotation follows the coordinate origin, point-pair alignment replaces trial-and-error anchor placement, scale auto-derives from calibration, and mirror controls handle upside-down parts.

**Architecture:** All changes are frontend-only. No backend changes required.

**Tech Stack:** Vanilla JS, Canvas 2D API

---

## Drawing Architecture Change (prerequisite for all issues)

The existing `drawDxfOverlay` uses arithmetic `tx`/`ty` functions that bypass the canvas transform matrix. Adding rotation, flipH, and flipV on top of these would require complex per-entity angle math. Instead, refactor `drawDxfOverlay` to use `ctx.translate`, `ctx.rotate`, and `ctx.scale` — this lets the canvas matrix handle all transforms, including arc angles, automatically.

### New `drawDxfOverlay`

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

### `dxfToCanvas` helper

Used outside of the draw function (for snap point collection and alignment mode):

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

---

## Issue 1: DXF Rotation Follows Coordinate Origin

The refactored `drawDxfOverlay` already reads `state.origin?.angle ?? 0` on every frame. No additional state changes are needed. The DXF rotates around `(offsetX, offsetY)` — the anchor point. This is correct: the user positions the anchor at the part reference point via point-pair alignment (Issue 2), and the coordinate origin rotation then pivots the DXF around that reference.

---

## Issue 2: Point-Pair Alignment Mode

### DXF snap point collection

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

Returns objects with both DXF coords (for reference) and canvas coords (for distance checks and display).

### State additions

Add to `state`:

```js
dxfAlignMode: false,      // true when alignment mode is active
dxfAlignStep: 0,          // 0 = waiting for DXF pick, 1 = waiting for image pick
dxfAlignPick: null,       // { canvas: {x,y} } of selected DXF snap point
dxfAlignHover: null,      // { canvas: {x,y} } of nearest DXF snap point (hover)
```

All four are reset on alignment mode exit (success or Escape).

### Entering alignment mode

**On DXF load** (in the `dxf-input` change handler, after the annotation is added):
```js
enterDxfAlignMode();
```

**Re-align button** in DXF panel:
```js
document.getElementById("btn-dxf-realign").addEventListener("click", enterDxfAlignMode);
```

**`enterDxfAlignMode()`:**
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
```

Alignment mode takes priority over `_dxfOriginMode`. Both cannot be active simultaneously.

### Mousemove in alignment mode

At the top of the `onMouseMove` handler, before all other branches:

```js
if (state.dxfAlignMode) {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (ann) {
    const pts = collectDxfSnapPoints(ann);
    const SNAP_R = 12;  // slightly larger than annotation snap radius
    let best = null, bestD = Infinity;
    for (const p of pts) {
      const d = Math.hypot(rawPt.x - p.canvas.x, rawPt.y - p.canvas.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    state.dxfAlignHover = (bestD < SNAP_R) ? best : null;
    if (state.dxfAlignStep === 1) {
      // Rubber-band line from pick to cursor
    }
  }
  redraw();
  return;  // skip all other tool logic
}
```

### Click handling in alignment mode

At the top of `onMouseDown`, before all other branches:

```js
if (state.dxfAlignMode) {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) { exitDxfAlignMode(); return; }

  if (state.dxfAlignStep === 0) {
    // Step 1: pick DXF snap point
    const target = state.dxfAlignHover;
    if (!target) return;  // no snap point nearby, ignore click
    state.dxfAlignPick = target;
    state.dxfAlignStep = 1;
    showStatus("Click the image point to align to…");

  } else {
    // Step 2: pick image point (snap to annotation or precise)
    // snapPoint returns {pt, snapped}; bypass param added by the tool-quirks spec
    const imagePt = e.altKey ? rawPt : snapPoint(rawPt, false).pt;
    pushUndo();
    ann.offsetX += imagePt.x - state.dxfAlignPick.canvas.x;
    ann.offsetY += imagePt.y - state.dxfAlignPick.canvas.y;
    exitDxfAlignMode();
    showStatus("DXF aligned");
    redraw();
  }
  return;
}
```

### `exitDxfAlignMode()`

```js
function exitDxfAlignMode() {
  state.dxfAlignMode = false;
  state.dxfAlignStep = 0;
  state.dxfAlignPick = null;
  state.dxfAlignHover = null;
}
```

### Escape key

The existing Escape handler (which cancels active tools) gains:

```js
if (state.dxfAlignMode) { exitDxfAlignMode(); redraw(); return; }
```

### Draw indicators

In `redraw()`, after the main annotation drawing loop:

```js
// DXF alignment mode indicators
if (state.dxfAlignMode) {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (ann) {
    // Step 0: highlight nearest DXF snap point
    if (state.dxfAlignHover) {
      const p = state.dxfAlignHover.canvas;
      ctx.save();
      ctx.strokeStyle = "#facc15";  // yellow for DXF snap (distinct from annotation snap blue)
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Step 1: rubber-band line + selected pick marker
    if (state.dxfAlignStep === 1 && state.dxfAlignPick) {
      const p = state.dxfAlignPick.canvas;
      // Filled dot at pick
      ctx.save();
      ctx.fillStyle = "#facc15";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      // Rubber-band line to current cursor (use last known mouse position)
      ctx.strokeStyle = "rgba(250,204,21,0.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(state.mousePos.x, state.mousePos.y);  // last known mouse position
      ctx.stroke();
      ctx.restore();
    }
  }
}
```

`state.mousePos` must be initialised in the `state` object as `{ x: 0, y: 0 }` and kept updated by setting `state.mousePos = rawPt` at the top of `onMouseMove`. The rubber-band draw block should guard against a missing value: only draw the line if `state.dxfAlignPick && state.mousePos`.

---

## Issue 3: Scale Auto-Derives from Calibration

When `state.calibration` is non-null, auto-populate the DXF scale input with `state.calibration.pixelsPerMm`.

**On DXF load** (in the `dxf-input` change handler, when building the annotation):
```js
const autoScale = state.calibration?.pixelsPerMm;
const scale = autoScale ?? suggestedScale;  // suggestedScale from backend response
ann.scale = scale;
document.getElementById("dxf-scale").value = scale.toFixed(3);
ann.scaleManual = !autoScale;   // true if user set scale manually, false if auto-derived
```

**When calibration changes** (in `applyCalibration`, after setting `state.calibration`):
```js
const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
if (dxfAnn && !dxfAnn.scaleManual) {
  dxfAnn.scale = state.calibration.pixelsPerMm;
  document.getElementById("dxf-scale").value = dxfAnn.scale.toFixed(3);
  redraw();
}
```

**Manual override** (in the `dxf-scale` input handler):
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

---

## Issue 4: Mirror Controls

Add `flipH` and `flipV` boolean properties to the DXF annotation (defaulting to `false`). The refactored `drawDxfOverlay` already reads them.

**On DXF load**, initialise: `ann.flipH = false; ann.flipV = false`.

**Two toggle buttons** in the DXF panel:

```html
<button class="tool-btn" id="btn-dxf-flip-h">Flip H</button>
<button class="tool-btn" id="btn-dxf-flip-v">Flip V</button>
```

Click handlers:
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

Both `flipH` and `flipV` can be active simultaneously. Buttons show active state (`.tool-btn.active`) when the corresponding flip is on.

---

## DXF Panel UI (updated)

```
DXF Overlay
  Scale   [______] px/unit   (auto-filled from calibration if available)
  [Flip H]  [Flip V]
  [Re-align]
  [Set origin (click canvas)]   ← kept for direct anchor placement
  [Clear DXF]
```

The "Set origin" button continues to work as before (direct anchor click without snap). "Re-align" enters the two-step point-pair workflow.

---

## Session Persistence

`flipH`, `flipV`, and `scaleManual` are stored on the annotation object and serialised by the existing save/load mechanism. `dxfAlignMode` and related transient state are not persisted — alignment mode always starts fresh on load.

---

## Undo Integration

`pushUndo()` is called before:
- The alignment translation (Step 2 of alignment mode)
- Each flip toggle

`pushUndo()` is NOT called when scale is auto-updated from calibration (since the calibration change itself already pushed undo).

---

## Files Changed

| File | Change |
|---|---|
| `frontend/app.js` | Refactor `drawDxfOverlay` to use canvas transforms; add `dxfToCanvas` helper; add `collectDxfSnapPoints`; add `enterDxfAlignMode`/`exitDxfAlignMode`; add alignment mode mousemove/click branches; draw alignment indicators in `redraw()`; add `state.mousePos`; scale auto-derive from calibration; flip toggle handlers; flip/scaleManual fields on annotation |
| `frontend/index.html` | DXF panel: add Flip H, Flip V, Re-align buttons |
| `frontend/style.css` | No new styles needed — flip buttons reuse `.tool-btn` and `.tool-btn.active` |
| `backend/` | No changes |
