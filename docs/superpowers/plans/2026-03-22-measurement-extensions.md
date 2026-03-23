# Measurement Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four new measurement tools to the microscope app: perpendicular constrained distance, parallel constrained distance + parallelism measurement, polygon area, and coordinate readout with user-defined origin.

**Architecture:** All changes are purely client-side, scattered across the three frontend files. Each new tool follows the same pattern as existing tools: a `handleToolClick` branch, a `drawXxx` function, entries in `measurementLabel`, `hitTestAnnotation`, `getHandles`, and `handleDrag`. The coordinate readout is a one-shot mode (like the existing `_dxfOriginMode`) rather than a toolbar tool.

**Tech Stack:** Vanilla JS (ES2020), HTML5 Canvas, no build step. Open `http://localhost:5000` in browser to test — requires the Python backend running (`python server.py`).

---

## File Map

| File | Lines | What changes |
|------|-------|-------------|
| `frontend/app.js` | ~1270 | All logic: state additions, helpers, tool branches, draw functions, mousemove, keydown, btn-clear, deleteAnnotation, renderSidebar |
| `frontend/index.html` | ~236 | Toolbar buttons (Para, Perp, Area, ⊙), `coord-display` div, help dialog rows |
| `frontend/style.css` | ~413 | `#coord-display` styles |

---

## Task 1: Foundation — state additions, `setTool` extension, `getLineEndpoints`, `btn-clear`

**Files:**
- Modify: `frontend/app.js:2-18` (state object)
- Modify: `frontend/app.js:32-41` (setTool)
- Modify: `frontend/app.js:20-30` (TOOL_STATUS map)
- Modify: `frontend/app.js:1229-1245` (btn-clear handler)

- [ ] **Step 1: Add `pendingRefLine` and `origin` to the state object**

In `app.js` at lines 9-10, after `pendingCenterCircle: null,`, add two new fields:

```js
// Before (lines 9-10):
  pendingCenterCircle: null,
  dragState: null,

// After:
  pendingCenterCircle: null,
  pendingRefLine: null,   // reference line for perp-dist / para-dist
  origin: null,           // { x, y } canvas-coord origin for coordinate readout
  dragState: null,
```

- [ ] **Step 2: Extend `setTool` to clear `pendingRefLine`**

In `app.js` at line 34-35, after `state.pendingCenterCircle = null;`, add the new clear:

```js
// Before (lines 33-35):
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;

// After:
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;
```

- [ ] **Step 3: Add new entries to `TOOL_STATUS`**

In `app.js` at lines 21-30, add new tool status strings after the existing entries:

```js
const TOOL_STATUS = {
  "select":      "Select",
  "calibrate":   "Calibrate — click two points or a circle",
  "distance":    "Distance — click point 1",
  "angle":       "Angle — click point 1",
  "circle":      "Circle — click point 1",
  "arc-fit":     "Fit Arc — click points, double-click to confirm",
  "center-dist": "Center distance — click a circle to select it",
  "detect":      "Detect",
  "perp-dist":   "Perp — click a reference line",
  "para-dist":   "Para — click a reference line",
  "area":        "Area — click points, double-click to confirm",
};
```

- [ ] **Step 4: Add `getLineEndpoints` helper**

After `snapToCircle` (after line 992), add:

```js
// ── Line endpoint helper ─────────────────────────────────────────────────────
// Returns { a: {x,y}, b: {x,y} } in canvas coords for any line-like annotation.
function getLineEndpoints(ann) {
  if (ann.type === "distance" || ann.type === "perp-dist" ||
      ann.type === "para-dist" || ann.type === "parallelism") {
    return { a: ann.a, b: ann.b };
  }
  if (ann.type === "calibration" && ann.x1 !== undefined) {
    return { a: { x: ann.x1, y: ann.y1 }, b: { x: ann.x2, y: ann.y2 } };
  }
  if (ann.type === "detected-line") {
    const sx = canvas.width  / ann.frameWidth;
    const sy = canvas.height / ann.frameHeight;
    return { a: { x: ann.x1 * sx, y: ann.y1 * sy },
             b: { x: ann.x2 * sx, y: ann.y2 * sy } };
  }
  return null;
}
```

- [ ] **Step 5: Add `projectConstrained` helper** (directly after `getLineEndpoints`)

```js
// Projects rawPt onto the ray from a in the direction perpendicular (perp=true)
// or parallel (perp=false) to refAnn. Returns the snapped endpoint { x, y }.
function projectConstrained(rawPt, a, refAnn, perp) {
  const ep = getLineEndpoints(refAnn);
  const rdx = ep.b.x - ep.a.x, rdy = ep.b.y - ep.a.y;
  const len = Math.hypot(rdx, rdy);
  if (len < 1e-10) return rawPt;
  // unit parallel vector of reference line
  const px = rdx / len, py = rdy / len;
  // unit direction we want to constrain b along:
  // if perp=true → use the perpendicular (-py, px); if false → use parallel (px, py)
  const ux = perp ? -py : px;
  const uy = perp ? px  : py;
  const t = (rawPt.x - a.x) * ux + (rawPt.y - a.y) * uy;
  return { x: a.x + t * ux, y: a.y + t * uy };
}
```

- [ ] **Step 6: Extend `btn-clear` handler with new resets**

In `app.js` around line 1233-1235, the existing clear handler resets `pendingPoints` and `pendingCenterCircle`. Add resets for `pendingRefLine`, `origin`, and `_originMode`:

```js
// Before (lines 1232-1241):
    state.selected = null;
    state.calibration = null;
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    / DXF panel: ...
    if (_dxfOriginMode) {
      _dxfOriginMode = false;
      document.getElementById("btn-dxf-set-origin").classList.remove("active");
      statusEl.textContent = state.frozen ? "Frozen" : "Live";
    }

// After:
    state.selected = null;
    state.calibration = null;
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    state.pendingRefLine = null;
    state.origin = null;
    if (_dxfOriginMode) {
      _dxfOriginMode = false;
      document.getElementById("btn-dxf-set-origin").classList.remove("active");
      statusEl.textContent = state.frozen ? "Frozen" : "Live";
    }
    if (typeof _originMode !== "undefined" && _originMode) {
      _originMode = false;
      document.getElementById("btn-set-origin").classList.remove("active");
    }
    const coordEl = document.getElementById("coord-display");
    if (coordEl) coordEl.textContent = "";
```

Note: `_originMode` is declared in Task 6, but `btn-clear` runs after page load so the reference is safe. The `typeof` guard prevents a ReferenceError if Task 6 hasn't run yet during development.

- [ ] **Step 7: Verify foundation compiles**

Open the browser dev console. There should be no new errors. The existing tools should all still work. The new state fields exist (`console.log(state.pendingRefLine, state.origin)` shows null).

- [ ] **Step 8: Commit**

```bash
git add frontend/app.js
git commit -m "feat: add foundation for measurement extensions (state, setTool, helpers)"
```

---

## Task 2: HTML + CSS scaffolding

**Files:**
- Modify: `frontend/index.html` — toolbar buttons, coord-display div, help dialog rows
- Modify: `frontend/style.css` — coord-display styles

- [ ] **Step 1: Add toolbar buttons in `index.html`**

The current toolbar (lines 11-34) has tools in this order: select, calibrate, distance, angle, circle, arc-fit, center-dist, detect. Add three new tool buttons after `center-dist` and before `detect`:

```html
<!-- After the center-dist button (line 18) and before detect: -->
<button class="tool-btn" data-tool="para-dist" title="Para distance [L]">Para</button>
<button class="tool-btn" data-tool="perp-dist" title="Perp distance [P]">Perp</button>
<button class="tool-btn" data-tool="area" title="Area [R]">Area</button>
```

Also add the origin icon button in the icon group, after `btn-crosshair` (line 21):

```html
<!-- After btn-crosshair: -->
<button class="tool-btn icon" id="btn-set-origin" title="Set coordinate origin">⊙</button>
```

- [ ] **Step 2: Add `coord-display` div inside `#viewer` in `index.html`**

Inside `<div id="viewer">` (lines 37-40), add the coord HUD div after `#overlay-canvas`:

```html
<div id="viewer">
  <img id="stream-img" src="/stream" alt="camera stream">
  <canvas id="overlay-canvas"></canvas>
  <div id="coord-display"></div>
</div>
```

- [ ] **Step 3: Add help dialog rows**

In the help dialog's Tools table `<tbody>` (around lines 211-220), add three rows after the existing Center Dist row:

```html
<tr><td>Para</td><td>L</td><td>Click a reference line, then two points (parallel constraint) or a second line (shows parallelism angle)</td></tr>
<tr><td>Perp</td><td>P</td><td>Click a reference line, then two points; line is constrained perpendicular to it</td></tr>
<tr><td>Area</td><td>R</td><td>Click ≥3 points to define a polygon, double-click to confirm</td></tr>
```

Also add one row to the Other Shortcuts table `<tbody>`:

```html
<tr><td>⊙ (toolbar)</td><td>Click toolbar ⊙ then click canvas to set coordinate origin; hovering shows X/Y relative to origin</td></tr>
```

- [ ] **Step 4: Add `#coord-display` styles to `style.css`**

Append after the last rule in `style.css` (after line 412):

```css
/* ── Coordinate HUD ── */
#coord-display {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.55);
  color: #e2e8f0;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  padding: 3px 7px;
  border-radius: 4px;
  pointer-events: none;
  white-space: pre;
}
#coord-display:empty { display: none; }
```

- [ ] **Step 5: Verify layout in browser**

Open `http://localhost:5000`. The toolbar should now show Para, Perp, Area buttons and a ⊙ icon. No JS errors. Clicking new buttons shows their names as status (since TOOL_STATUS already has them from Task 1). The coord-display doesn't show yet (empty).

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: add HTML/CSS scaffolding for measurement extensions"
```

---

## Task 3: Perpendicular distance tool (`perp-dist`)

**Files:**
- Modify: `frontend/app.js` — handleToolClick, mousemove, drawAnnotations, new draw functions, measurementLabel, hitTestAnnotation, getHandles, handleDrag

- [ ] **Step 1: Add `drawPerpDist` function**

After `drawCalibration` (after line 783), add:

```js
function drawPerpDist(ann, sel) {
  drawDistance(ann, sel);
  // Right-angle indicator at ann.a, oriented along ann.a→ann.b
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;   // unit along line
    const vx = -uy, vy = ux;              // perpendicular to line
    const s = 6;
    ctx.beginPath();
    ctx.moveTo(ann.a.x + ux * s, ann.a.y + uy * s);
    ctx.lineTo(ann.a.x + ux * s + vx * s, ann.a.y + uy * s + vy * s);
    ctx.lineTo(ann.a.x + vx * s, ann.a.y + vy * s);
    ctx.strokeStyle = sel ? "#60a5fa" : "#a78bfa";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
```

- [ ] **Step 2: Add `perp-dist` to `drawAnnotations` dispatch**

In `drawAnnotations` (lines 611-626), add after the `"center-dist"` line:

```js
else if (ann.type === "perp-dist")   drawPerpDist(ann, sel);
```

- [ ] **Step 3: Add `perp-dist` to `measurementLabel`**

In `measurementLabel` (lines 390-446), add before the `return ""` at line 445:

```js
if (ann.type === "perp-dist") {
  const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
  if (!cal) return `⊥ ${px.toFixed(1)} px`;
  const mm = px / cal.pixelsPerMm;
  return cal.displayUnit === "µm" ? `⊥ ${(mm * 1000).toFixed(2)} µm`
                                  : `⊥ ${mm.toFixed(3)} mm`;
}
```

- [ ] **Step 4: Add `perp-dist` to `hitTestAnnotation`, `getHandles`, `handleDrag`**

In `hitTestAnnotation` (line 942), extend the `"distance"` condition:

```js
// Before:
  if (ann.type === "distance" || ann.type === "center-dist") {
// After:
  if (ann.type === "distance" || ann.type === "center-dist" || ann.type === "perp-dist") {
```

In `getHandles` (line 931), extend the first condition:

```js
// Before:
  if (ann.type === "distance" || ann.type === "center-dist") return { a: ann.a, b: ann.b };
// After:
  if (ann.type === "distance" || ann.type === "center-dist" || ann.type === "perp-dist") return { a: ann.a, b: ann.b };
```

In `handleDrag` (line 1005), extend the first condition:

```js
// Before:
  if (ann.type === "distance" || ann.type === "center-dist") {
// After:
  if (ann.type === "distance" || ann.type === "center-dist" || ann.type === "perp-dist") {
```

- [ ] **Step 5: Add `findSnapLine` helper** (place before `handleToolClick`, around line 159)

```js
// Returns the first line-like annotation whose body is within 10px of pt, or null.
function findSnapLine(pt) {
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    const ep = getLineEndpoints(ann);
    if (!ep) continue;
    if (distPointToSegment(pt, ep.a, ep.b) < 10) return ann;
  }
  return null;
}
```

- [ ] **Step 6: Add `perp-dist` branch in `handleToolClick`**

After the `arc-fit` block (after line 253) and before the `center-dist` block, add:

```js
  if (tool === "perp-dist") {
    if (!state.pendingRefLine) {
      // Step 1: pick reference line
      const refAnn = findSnapLine(pt);
      if (!refAnn) return; // no line nearby — ignore click
      state.pendingRefLine = refAnn;
      statusEl.textContent = "Perp — click start point";
      redraw();
      return;
    }
    if (state.pendingPoints.length === 0) {
      // Step 2: place start point
      state.pendingPoints = [pt];
      statusEl.textContent = "Perp — click end point";
      redraw();
      return;
    }
    // Step 3: place end point (constrained perpendicular)
    const a = state.pendingPoints[0];
    const b = projectConstrained(pt, a, state.pendingRefLine, true);
    addAnnotation({ type: "perp-dist", a, b });
    setTool("select");
    return;
  }
```

- [ ] **Step 7: Add constrained rubber-band to `mousemove` handler**

In the `mousemove` handler (lines 789-814), the existing rubber-band guard is:
```js
if (state.pendingPoints.length > 0 && state.tool !== "select" && state.tool !== "arc-fit") {
```

Change it to also exclude the new tools:
```js
if (state.pendingPoints.length > 0 && state.tool !== "select"
    && state.tool !== "arc-fit"
    && state.tool !== "perp-dist"
    && state.tool !== "para-dist"
    && state.tool !== "area") {
```

Then, after the existing rubber-band `if` block (after line 813, before `});`), add:

```js
  // Constrained rubber-band for perp-dist and para-dist
  if ((state.tool === "perp-dist" || state.tool === "para-dist")
      && state.pendingPoints.length === 1 && state.pendingRefLine) {
    redraw();
    const b = projectConstrained(pt, state.pendingPoints[0], state.pendingRefLine,
                                 state.tool === "perp-dist");
    drawLine(state.pendingPoints[0], b, "rgba(251,146,60,0.5)", 1);
  }
```

- [ ] **Step 8: Verify perp-dist works in browser**

1. Draw a `distance` annotation (two clicks).
2. Switch to Perp tool (button or keyboard `P` — keyboard shortcut added in Task 7).
3. Click near the distance line — it should highlight (draw in selection color).
4. Click a start point somewhere.
5. Move mouse — a rubber-band line should appear, constrained perpendicular to the reference.
6. Click end point — annotation created with ⊥ label and right-angle indicator.
7. Annotation appears in sidebar with ⊥ prefix.
8. Clicking the annotation selects it; drag handles work.

- [ ] **Step 9: Commit**

```bash
git add frontend/app.js
git commit -m "feat: add perp-dist tool with constrained perpendicular distance measurement"
```

---

## Task 4: Parallel distance + parallelism measurement tool (`para-dist`)

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add `drawParaDist` and `drawParallelism` functions**

After `drawPerpDist`, add:

```js
function drawParaDist(ann, sel) {
  drawDistance(ann, sel);
  // Two parallel tick marks on the line body (4px apart)
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;
    const vx = -uy * 5, vy = ux * 5; // perpendicular, 5px half-length
    [-2, 2].forEach(offset => {
      const cx = mx + ux * offset, cy = my + uy * offset;
      drawLine({ x: cx - vx, y: cy - vy }, { x: cx + vx, y: cy + vy },
               sel ? "#60a5fa" : "#a78bfa", 1.5);
    });
  }
}

function drawParallelism(ann, sel) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  drawLine(ann.a, ann.b, sel ? "#60a5fa" : "#facc15", sel ? 2 : 1.5);
  ctx.setLineDash([]);
  ctx.restore();
  if (sel) { drawHandle(ann.a, "#60a5fa"); drawHandle(ann.b, "#60a5fa"); }
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}
```

- [ ] **Step 2: Add `lineAngleDeg` helper** (place near `findSnapLine`)

```js
// Returns the angle of a line annotation in degrees (-180..180).
function lineAngleDeg(ann) {
  const ep = getLineEndpoints(ann);
  // atan2(dy, dx) gives the angle of the vector ep.a→ep.b
  return Math.atan2(ep.b.y - ep.a.y, ep.b.x - ep.a.x) * 180 / Math.PI;
}
```

- [ ] **Step 3: Add `para-dist` and `parallelism` to `drawAnnotations`**

In `drawAnnotations`, after the `"perp-dist"` line added in Task 3, add:

```js
else if (ann.type === "para-dist")   drawParaDist(ann, sel);
else if (ann.type === "parallelism") drawParallelism(ann, sel);
```

- [ ] **Step 4: Add `para-dist` and `parallelism` to `measurementLabel`**

Before `return ""` in `measurementLabel`, add:

```js
if (ann.type === "para-dist") {
  const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
  if (!cal) return `∥ ${px.toFixed(1)} px`;
  const mm = px / cal.pixelsPerMm;
  return cal.displayUnit === "µm" ? `∥ ${(mm * 1000).toFixed(2)} µm`
                                  : `∥ ${mm.toFixed(3)} mm`;
}
if (ann.type === "parallelism") {
  return `∥ ${ann.angleDeg.toFixed(2)}°`;
}
```

- [ ] **Step 5: Add `para-dist` and `parallelism` to `hitTestAnnotation`, `getHandles`, `handleDrag`**

In `hitTestAnnotation`, extend the `"distance"` condition to include `"para-dist"` and `"parallelism"`:

```js
  if (ann.type === "distance" || ann.type === "center-dist" ||
      ann.type === "perp-dist" || ann.type === "para-dist" ||
      ann.type === "parallelism") {
    return distPointToSegment(pt, ann.a, ann.b) < 8;
  }
```

In `getHandles`, extend the first condition:

```js
  if (ann.type === "distance" || ann.type === "center-dist" ||
      ann.type === "perp-dist" || ann.type === "para-dist" ||
      ann.type === "parallelism") return { a: ann.a, b: ann.b };
```

In `handleDrag`, extend the first condition:

```js
  if (ann.type === "distance" || ann.type === "center-dist" ||
      ann.type === "perp-dist" || ann.type === "para-dist" ||
      ann.type === "parallelism") {
```

- [ ] **Step 6: Add `para-dist` branch in `handleToolClick`**

After the `perp-dist` block, add:

```js
  if (tool === "para-dist") {
    if (!state.pendingRefLine) {
      // Step 1: pick reference line
      const refAnn = findSnapLine(pt);
      if (!refAnn) return;
      state.pendingRefLine = refAnn;
      statusEl.textContent = "Para — click a line to measure parallelism, or a free point to draw a parallel line";
      redraw();
      return;
    }
    // Step 2: check if this click is on a different line (Mode A — parallelism)
    const clickedLine = findSnapLine(pt);
    if (clickedLine && clickedLine.id !== state.pendingRefLine.id) {
      const epRef = getLineEndpoints(state.pendingRefLine);
      const epOther = getLineEndpoints(clickedLine);
      let diff = Math.abs(lineAngleDeg(state.pendingRefLine) - lineAngleDeg(clickedLine)) % 180;
      if (diff > 90) diff = 180 - diff;
      // a and b are midpoints of the two reference lines
      const a = { x: (epRef.a.x + epRef.b.x) / 2, y: (epRef.a.y + epRef.b.y) / 2 };
      const b = { x: (epOther.a.x + epOther.b.x) / 2, y: (epOther.a.y + epOther.b.y) / 2 };
      addAnnotation({ type: "parallelism", a, b, angleDeg: diff });
      setTool("select");
      return;
    }
    if (state.pendingPoints.length === 0) {
      // Step 2 (Mode B): free point — start parallel constraint
      state.pendingPoints = [pt];
      statusEl.textContent = "Para — click end point";
      redraw();
      return;
    }
    // Step 3 (Mode B): place end point (constrained parallel)
    const a = state.pendingPoints[0];
    const b = projectConstrained(pt, a, state.pendingRefLine, false);
    addAnnotation({ type: "para-dist", a, b });
    setTool("select");
    return;
  }
```

- [ ] **Step 7: Verify para-dist works in browser**

Mode A (parallelism):
1. Draw two `distance` annotations at an angle to each other.
2. Switch to Para tool.
3. Click near the first line — it highlights.
4. Click near the second line — a dashed annotation is created showing the angle in degrees.

Mode B (parallel constraint):
1. Switch to Para tool, click a reference line.
2. Click a free point (not near any line).
3. Mousemove — rubber-band line appears, constrained parallel to reference.
4. Click end point — annotation created with ∥ label and tick marks.

- [ ] **Step 8: Commit**

```bash
git add frontend/app.js
git commit -m "feat: add para-dist and parallelism tools"
```

---

## Task 5: Area measurement tool (`area`)

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add `polygonArea` helper** (place near other geometry helpers, after `fitCircleAlgebraic`)

```js
// Shoelace formula — returns area in pixels²
function polygonArea(pts) {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(s) / 2;
}
```

- [ ] **Step 2: Add `drawArea` and `drawAreaPreview` functions**

After `drawParallelism`, add:

```js
function drawArea(ann, sel) {
  ctx.beginPath();
  ann.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = sel ? "rgba(96,165,250,0.12)" : "rgba(251,146,60,0.12)";
  ctx.fill();
  ctx.strokeStyle = sel ? "#60a5fa" : "rgba(251,146,60,0.7)";
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.stroke();
  if (sel) ann.points.forEach(p => drawHandle(p, "#60a5fa"));
  const cx = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length;
  const cy = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length;
  drawLabel(measurementLabel(ann), cx + 4, cy);
}

function drawAreaPreview(pts, cursor) {
  if (pts.length === 0) return;
  const all = [...pts, cursor];
  ctx.beginPath();
  all.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = "rgba(251,146,60,0.08)";
  ctx.fill();
  ctx.strokeStyle = "rgba(251,146,60,0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
}
```

- [ ] **Step 3: Add `"area"` to `drawAnnotations`**

```js
else if (ann.type === "area") drawArea(ann, sel);
```

- [ ] **Step 4: Add `"area"` to `measurementLabel`**

Before `return ""`:

```js
if (ann.type === "area") {
  const px2 = polygonArea(ann.points);
  if (!cal) return `□ ${px2.toFixed(1)} px²`;
  const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
  return cal.displayUnit === "µm"
    ? `□ ${(mm2 * 1e6).toFixed(2)} µm²`
    : `□ ${mm2.toFixed(4)} mm²`;
}
```

- [ ] **Step 5: Add `"area"` to `hitTestAnnotation`**

After the calibration block, before `return false;`, add:

```js
  if (ann.type === "area") {
    // Check proximity to any edge
    const n = ann.points.length;
    for (let i = 0; i < n; i++) {
      if (distPointToSegment(pt, ann.points[i], ann.points[(i + 1) % n]) < 8) return true;
    }
    // Ray-casting point-in-polygon
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ann.points[i].x, yi = ann.points[i].y;
      const xj = ann.points[j].x, yj = ann.points[j].y;
      if ((yi > pt.y) !== (yj > pt.y) &&
          pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
```

- [ ] **Step 6: Add `"area"` to `getHandles`**

In `getHandles`, before `return {}`:

```js
  if (ann.type === "area") {
    const handles = {};
    ann.points.forEach((p, i) => { handles[`v${i}`] = p; });
    return handles;
  }
```

- [ ] **Step 7: Add `"area"` to `handleDrag`**

After the `calibration` block in `handleDrag`:

```js
  else if (ann.type === "area") {
    if (handleKey === "body") {
      ann.points.forEach(p => { p.x += dx; p.y += dy; });
    } else if (handleKey.startsWith("v")) {
      const i = parseInt(handleKey.slice(1));
      ann.points[i].x += dx; ann.points[i].y += dy;
    }
  }
```

- [ ] **Step 8: Add `area` branch to `handleToolClick`**

After the `arc-fit` block:

```js
  if (tool === "area") {
    state.pendingPoints.push(pt);
    redraw();
    return;
  }
```

- [ ] **Step 9: Extend `dblclick` handler to cover `area`**

The current handler (lines 136-157) guards with `if (state.tool !== "arc-fit") return;`. Replace it with:

```js
canvas.addEventListener("dblclick", () => {
  if (state.tool !== "arc-fit" && state.tool !== "area") return;

  const points = state.pendingPoints.slice(0, -2);
  if (state.tool === "arc-fit") {
    if (points.length < 3) {
      alert("Need at least 3 points. Keep clicking to add more, then double-click to confirm.");
      return;
    }
    const result = fitCircleAlgebraic(points);
    if (!result) {
      alert("Could not fit a circle — points may be collinear or too close together.");
      state.pendingPoints = [];
      redraw();
      return;
    }
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
  } else {
    // area
    if (points.length < 3) {
      alert("Need at least 3 points to define an area.");
      return;
    }
    addAnnotation({ type: "area", points });
  }
  const newRow = listEl.querySelector(".measurement-item.selected");
  if (newRow) newRow.scrollIntoView({ block: "nearest" });
  setTool("select");
});
```

- [ ] **Step 10: Add area preview to `mousemove` handler**

After the perp/para rubber-band block added in Task 3, add:

```js
  // Area polygon preview
  if (state.tool === "area" && state.pendingPoints.length >= 1) {
    redraw();
    drawAreaPreview(state.pendingPoints, pt);
  }
```

- [ ] **Step 11: Verify area tool in browser**

1. Switch to Area tool.
2. Click 4 points in a rough square — each click shows an orange dot.
3. Mouse movement shows a closing polygon preview.
4. Double-click — area annotation created with □ label.
5. Annotation appears in sidebar with □ prefix and area value.
6. Drag handles: vertex handles move individual points; body drag moves whole polygon.
7. Select and Delete removes it.

- [ ] **Step 12: Commit**

```bash
git add frontend/app.js
git commit -m "feat: add area measurement tool with polygon drawing and shoelace formula"
```

---

## Task 6: Coordinate readout with user-defined origin

**Files:**
- Modify: `frontend/app.js` — origin mode, drawOrigin, mousemove HUD, deleteAnnotation, renderSidebar

- [ ] **Step 1: Add `_originMode` flag and `btn-set-origin` click handler**

Near the end of `app.js`, after the DXF section (around line 1173 where `_dxfOriginMode` is declared), add:

```js
// ── Coordinate origin ────────────────────────────────────────────────────────
let _originMode = false;

document.getElementById("btn-set-origin").addEventListener("click", () => {
  _originMode = !_originMode;
  document.getElementById("btn-set-origin").classList.toggle("active", _originMode);
});
```

- [ ] **Step 2: Handle origin placement in `onMouseDown`**

In `onMouseDown` (line 84), before the `_dxfOriginMode` check, add:

```js
  if (_originMode) {
    // Remove any existing origin annotation
    state.annotations = state.annotations.filter(a => a.type !== "origin");
    state.origin = { x: pt.x, y: pt.y };
    addAnnotation({ type: "origin", x: pt.x, y: pt.y });
    _originMode = false;
    document.getElementById("btn-set-origin").classList.remove("active");
    return;
  }
```

- [ ] **Step 3: Add `drawOrigin` function**

After `drawAreaPreview`, add:

```js
function drawOrigin(ann, sel) {
  const color = sel ? "#60a5fa" : "#facc15";
  const s = 8;
  drawLine({ x: ann.x - s, y: ann.y }, { x: ann.x + s, y: ann.y }, color, 1);
  drawLine({ x: ann.x, y: ann.y - s }, { x: ann.x, y: ann.y + s }, color, 1);
  ctx.beginPath();
  ctx.arc(ann.x, ann.y, 3, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}
```

- [ ] **Step 4: Add `"origin"` to `drawAnnotations`**

```js
else if (ann.type === "origin") drawOrigin(ann, sel);
```

- [ ] **Step 5: Add `"origin"` to `hitTestAnnotation`**

```js
  if (ann.type === "origin") {
    return Math.hypot(pt.x - ann.x, pt.y - ann.y) < 10;
  }
```

- [ ] **Step 6: Add `"origin"` to `getHandles`**

```js
  if (ann.type === "origin") return { center: { x: ann.x, y: ann.y } };
```

- [ ] **Step 7: Add `"origin"` to `handleDrag`**

After the `area` block:

```js
  else if (ann.type === "origin") {
    ann.x += dx; ann.y += dy;
    state.origin = { x: ann.x, y: ann.y };
  }
```

- [ ] **Step 8: Add `"origin"` side effect to `deleteAnnotation`**

In `deleteAnnotation` (lines 362-372), after `if (ann.type === "dxf-overlay") ...`, add:

```js
  if (ann.type === "origin") {
    state.origin = null;
    const coordEl = document.getElementById("coord-display");
    if (coordEl) coordEl.textContent = "";
  }
```

- [ ] **Step 9: Handle origin in `renderSidebar`**

The origin annotation should appear in the sidebar (deletable) but without a circled number and with no value label. In `renderSidebar`, inside the `forEach` loop before the `number` and `i++` lines, add a special case:

```js
    // Origin annotation: shows in sidebar without a measurement number
    if (ann.type === "origin") {
      const row = document.createElement("div");
      row.className = "measurement-item" + (ann.id === state.selected ? " selected" : "");
      row.innerHTML = `
        <span class="measurement-number">⊙</span>
        <span class="measurement-name" style="flex:1;font-size:12px;color:var(--muted)">Origin</span>
        <button class="del-btn" data-id="${ann.id}">✕</button>`;
      row.addEventListener("click", e => {
        if (e.target.classList.contains("del-btn")) return;
        state.selected = ann.id;
        renderSidebar();
        redraw();
      });
      row.querySelector(".del-btn").addEventListener("click", e => {
        e.stopPropagation();
        deleteAnnotation(ann.id);
      });
      listEl.appendChild(row);
      return; // skip i++
    }
```

Place this before the existing `const number = ...` line.

- [ ] **Step 10: Add coordinate HUD update to `mousemove` handler**

At the end of the `mousemove` handler (before the final `});`), add:

```js
  // Coordinate readout HUD
  const coordEl = document.getElementById("coord-display");
  if (coordEl && state.origin) {
    const ddx = pt.x - state.origin.x;
    const ddy = pt.y - state.origin.y;
    if (!state.calibration) {
      coordEl.textContent = `X: ${ddx.toFixed(0)} px  Y: ${ddy.toFixed(0)} px`;
    } else {
      const ppm = state.calibration.pixelsPerMm;
      if (state.calibration.displayUnit === "µm") {
        coordEl.textContent =
          `X: ${(ddx / ppm * 1000).toFixed(1)} µm  Y: ${(ddy / ppm * 1000).toFixed(1)} µm`;
      } else {
        coordEl.textContent =
          `X: ${(ddx / ppm).toFixed(3)} mm  Y: ${(ddy / ppm).toFixed(3)} mm`;
      }
    }
  }
```

- [ ] **Step 11: Add `mouseleave` handler on canvas to clear HUD**

After the `mousemove` handler:

```js
canvas.addEventListener("mouseleave", () => {
  const coordEl = document.getElementById("coord-display");
  if (coordEl) coordEl.textContent = "";
});
```

- [ ] **Step 12: Add `"origin"` to `measurementLabel` (returns empty string)**

Before `return ""` in `measurementLabel`:

```js
  if (ann.type === "origin") return "";
```

- [ ] **Step 13: Verify coordinate readout in browser**

1. Click the ⊙ toolbar button — it highlights.
2. Click somewhere on the canvas — a small crosshair marker appears at the click point.
3. The ⊙ button deactivates.
4. Origin annotation appears in sidebar as "⊙ Origin" with a delete button.
5. Hovering over the canvas shows the coord HUD in the bottom-left: `X: 123 px  Y: 45 px`.
6. If calibrated: shows mm or µm values.
7. Dragging the origin marker updates `state.origin` and the HUD updates on next mousemove.
8. Clicking sidebar delete removes origin and clears HUD.
9. The ⊙ button can re-enter origin mode to replace the existing origin.

- [ ] **Step 14: Commit**

```bash
git add frontend/app.js
git commit -m "feat: add coordinate readout with user-defined origin and live HUD"
```

---

## Task 7: Keyboard shortcuts (P, L, R) + `getLineEndpoints` coverage in `center-dist`

**Files:**
- Modify: `frontend/app.js` — keydown handler

- [ ] **Step 1: Add keyboard shortcuts to the `keydown` handler**

The existing keydown handler (lines 103-134) has a `toolKeys` map. Extend it:

```js
// Current toolKeys (around line 108):
const toolKeys = { v:"select", c:"calibrate", d:"distance", a:"angle",
                   o:"circle", f:"arc-fit", m:"center-dist", e:"detect" };

// Add new shortcuts:
const toolKeys = { v:"select", c:"calibrate", d:"distance", a:"angle",
                   o:"circle", f:"arc-fit", m:"center-dist", e:"detect",
                   p:"perp-dist", l:"para-dist", r:"area" };
```

Note: the spec says use **lowercase** `p`, `l`, `r` as the toolKeys map keys (these match `e.key.toLowerCase()`). Check the existing handler to confirm it does `e.key.toLowerCase()` — if it uses `e.key` directly, add `.toLowerCase()` to the lookup.

- [ ] **Step 2: Verify keyboard shortcuts work**

1. Press `P` — switches to Perp tool (status shows "Perp — click a reference line").
2. Press `L` — switches to Para tool.
3. Press `R` — switches to Area tool.
4. Press `Escape` — returns to Select.
5. Shortcuts don't fire when typing in a sidebar label input (existing input-focus guard).

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: add keyboard shortcuts P/L/R for perp-dist, para-dist, and area tools"
```

---

## Task 8: Final integration check

- [ ] **Step 1: Full walkthrough**

Test all four features together:

1. **Perp-dist**: Draw a distance line, use Perp tool, confirm perpendicular constraint and right-angle indicator.
2. **Para-dist Mode A**: Draw two non-parallel lines, use Para tool, click first then second line — parallelism angle shown.
3. **Para-dist Mode B**: Draw a line, use Para tool, click line then free point — parallel constraint with tick marks.
4. **Area**: Draw a polygon, confirm area label updates when calibrated.
5. **Origin + calibrated readout**: Calibrate with a known distance, set origin, hover — shows mm values.
6. **Delete all**: Click ✕ Clear button — all annotations gone except DXF overlay. All state resets correctly (pendingRefLine, origin, _originMode).
7. **Escape**: Partway through perp-dist (reference line selected, no point yet) — Escape returns to Select and clears pendingRefLine.

- [ ] **Step 2: Check sidebar CSV export includes new types**

Click ⬇CSV. Verify the downloaded CSV contains rows for perp-dist (⊥ prefix), para-dist (∥ prefix), parallelism (∥ angle), area (□ prefix). Origin annotation produces an empty label row — verify it's excluded from CSV (the existing CSV code skips annotations where `measurementLabel` returns `""`).

Check the CSV export code to confirm this is the case. If `measurementLabel("") === ""` rows are included with an empty value that's fine; if they need to be filtered, add `if (!label) return;` to the CSV row generation.

- [ ] **Step 3: Final commit with any fixes**

```bash
git add frontend/app.js frontend/index.html frontend/style.css
git commit -m "fix: address any issues found in final integration check"
```

---

## Quick Reference — New Annotation Types

| Type | Fields | Label prefix | Color |
|------|--------|--------------|-------|
| `perp-dist` | `a, b` | `⊥` | same as distance (yellow) |
| `para-dist` | `a, b` | `∥` | same as distance (yellow) + tick marks |
| `parallelism` | `a, b, angleDeg` | `∥ X.XX°` | dashed yellow |
| `area` | `points[]` | `□` | orange fill |
| `origin` | `x, y` | `""` | yellow crosshair |
