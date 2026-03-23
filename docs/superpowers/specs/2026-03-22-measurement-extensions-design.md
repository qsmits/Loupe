# Measurement Extensions Design

**Date:** 2026-03-22
**Scope:** Four new measurement tools — perpendicular constrained distance, parallel constrained distance + parallelism measurement, polygon area, and coordinate readout with user-defined origin. All client-side (frontend only, no new backend endpoints).

---

## Goals

Add four measurement capabilities to the existing tool palette:

1. **Perp-dist** — draw a distance line constrained perpendicular to a reference line
2. **Para-dist** — draw a distance line constrained parallel to a reference line; when the second click lands on an existing line, report the angular deviation between the two lines instead
3. **Area** — define a polygon by clicking N≥3 points, double-click to confirm, report calibrated area
4. **Coordinate readout** — set a user-defined origin; live X/Y coordinates relative to that origin are shown in a HUD on mousemove

All changes are in `frontend/app.js`, `frontend/index.html`, and `frontend/style.css`.

---

## Keyboard shortcuts (no conflicts)

New shortcuts `P`, `L`, `R` are all unoccupied in the existing `toolKeys` map (`v c d a o f m e`).

| Key | Tool |
|-----|------|
| `P` | perp-dist |
| `L` | para-dist |
| `R` | area |

---

## Prerequisite: `getLineEndpoints(ann)` helper

A shared helper that returns `{ a: {x, y}, b: {x, y} }` in canvas coordinates for any line-like annotation. Required by perp-dist, para-dist, and the right-angle indicator renderer.

```js
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

A line annotation is "snappable as reference" if `getLineEndpoints` returns non-null and `distPointToSegment(pt, ep.a, ep.b) < 10`.

---

## Prerequisite: `setTool` extension

`setTool(name)` must reset `state.pendingRefLine` alongside the existing clears:

```js
function setTool(name) {
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;       // ← new
  // ... rest unchanged
}
```

**Escape handling:** pressing Escape always calls `setTool("select")` (the existing global keydown handler behaviour). There is no "partial Escape" that stays in the same tool — pressing Escape always exits to Select and clears all pending state including `pendingRefLine`. This is consistent with the rest of the tools.

---

## Prerequisite: `state` additions

```js
pendingRefLine: null,   // reference line annotation for perp-dist / para-dist
origin: null,           // { x, y } canvas-coordinate origin for coordinate readout
```

---

## Feature 1: Perpendicular Distance (`perp-dist`)

### Toolbar

New button `"Perp"` with `data-tool="perp-dist"`, placed after `para-dist`. Keyboard shortcut: `P`. Tooltip: `"Perp distance [P]"`.

### TOOL_STATUS entry

```js
"perp-dist": "Perp — click a reference line",
```

### Interaction

1. Activate → status set by `setTool`
2. Click near a snappable line annotation (within 10px of body) → store as `state.pendingRefLine`, redraw (reference line draws highlighted), update status to `"Perp — click start point"`
3. Click anywhere → `state.pendingPoints = [pt]`, update status to `"Perp — click end point"`
4. Mousemove with `pendingPoints.length === 1`: project cursor onto the perpendicular ray from `pendingPoints[0]`, draw constrained rubber-band line
5. Click → compute constrained `b`, call `addAnnotation`, call `setTool("select")`

The `handleToolClick` branch for `perp-dist` handles all three sub-steps by checking `pendingRefLine` and `pendingPoints.length`.

**Direction computation:**
```js
const ep = getLineEndpoints(state.pendingRefLine);
const dx = ep.b.x - ep.a.x, dy = ep.b.y - ep.a.y;
const len = Math.hypot(dx, dy);
// unit perpendicular vector (rotated 90°)
const perpX = -dy / len, perpY = dx / len;
const a = state.pendingPoints[0];
const t = (raw.x - a.x) * perpX + (raw.y - a.y) * perpY;
const b = { x: a.x + t * perpX, y: a.y + t * perpY };
```

### Annotation fields

```
{ type: "perp-dist", a: {x, y}, b: {x, y} }
```

Same `a/b` structure as `"distance"`. The reference line direction is recoverable from `a` and `b` themselves (since `a→b` is already the perpendicular direction), so no extra fields are needed.

### Dispatches

Add `"perp-dist"` alongside `"distance"` in:
- `drawAnnotations` → calls `drawDistance(ann, sel)` then adds right-angle indicator
- `measurementLabel` → same as distance branch with `"⊥ "` prefix
- `hitTestAnnotation` → distance branch
- `getHandles` → distance branch (`{ a, b }`)
- `handleDrag` → distance branch

### Right-angle indicator

The annotation stores `a` and `b`, and `a→b` is the constrained perpendicular direction. The right-angle indicator at `a` is drawn using the `a→b` unit vector to orient the square — no reference to the original reference line is needed:

```js
// unit vector along the perp-dist line
const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
const len = Math.hypot(dx, dy);
if (len > 0) {
  const ux = dx/len, uy = dy/len;   // along line
  const vx = -uy, vy = ux;          // perpendicular to line
  const s = 6;
  ctx.beginPath();
  ctx.moveTo(ann.a.x + ux*s, ann.a.y + uy*s);
  ctx.lineTo(ann.a.x + ux*s + vx*s, ann.a.y + uy*s + vy*s);
  ctx.lineTo(ann.a.x + vx*s, ann.a.y + vy*s);
  ctx.strokeStyle = sel ? "#60a5fa" : "#a78bfa";
  ctx.lineWidth = 1;
  ctx.stroke();
}
```

### `measurementLabel`

```js
if (ann.type === "perp-dist") {
  const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
  if (!cal) return `⊥ ${px.toFixed(1)} px`;
  const mm = px / cal.pixelsPerMm;
  return cal.displayUnit === "µm" ? `⊥ ${(mm*1000).toFixed(2)} µm`
                                   : `⊥ ${mm.toFixed(3)} mm`;
}
```

### `mousemove` handler

Add `"perp-dist"` and `"para-dist"` to the exclusion list in the existing mousemove rubber-band guard so the default single-segment rubber-band does not fire for these tools:

```js
if (state.pendingPoints.length > 0 && state.tool !== "select"
    && state.tool !== "arc-fit"
    && state.tool !== "perp-dist"   // ← new
    && state.tool !== "para-dist"   // ← new
    && state.tool !== "area") {     // ← new (handled below)
  // existing rubber-band logic
}
```

Then, in the same `mousemove` handler, add the constrained rubber-band for `perp-dist` (and analogously for `para-dist`):

```js
if ((state.tool === "perp-dist" || state.tool === "para-dist")
    && state.pendingPoints.length === 1 && state.pendingRefLine) {
  redraw();
  const b = projectConstrained(pt, state.pendingPoints[0], state.pendingRefLine,
                               state.tool === "perp-dist");
  drawLine(state.pendingPoints[0], b, "rgba(251,146,60,0.5)", 1);
}
```

Where `projectConstrained(rawPt, a, refAnn, perp)` computes the constrained endpoint using the direction logic described above (perpendicular if `perp === true`, parallel otherwise).

And the polygon preview for `area`:

```js
if (state.tool === "area" && state.pendingPoints.length >= 1) {
  redraw();
  drawAreaPreview(state.pendingPoints, pt);
}
```

`drawAreaPreview(pts, cursor)` draws a closed polygon connecting `[...pts, cursor]` with the same fill/stroke style as the confirmed area annotation, at slightly reduced opacity.

---

## Feature 2: Parallel Distance + Parallelism Measurement (`para-dist`)

### Toolbar

New button `"Para"` with `data-tool="para-dist"`, placed before `perp-dist`. Keyboard shortcut: `L`. Tooltip: `"Para distance [L]"`.

### TOOL_STATUS entry

```js
"para-dist": "Para — click a reference line",
```

### Interaction — dual mode

Uses `state.pendingRefLine` (same field as perp-dist; only one tool is active at a time so no collision).

1. Activate → status: `"Para — click a reference line"`
2. Click near a snappable line → store as `state.pendingRefLine`, highlight, status: `"Para — click a line to measure parallelism, or a free point to draw a parallel line"`
3. **Mode A — parallelism measurement:** if the next click is within 10px of a *different* snappable line annotation:
   - Compute acute angle between the two lines ([0°, 90°])
   - `a` = midpoint of reference line, `b` = midpoint of clicked line
   - `addAnnotation({ type: "parallelism", a, b, angleDeg })`
   - `setTool("select")`
4. **Mode B — parallel constraint:** if the next click is not near any line:
   - `state.pendingPoints = [pt]`, status: `"Para — click end point"`
   - Mousemove shows constrained rubber-band (parallel direction)
   - Click → compute constrained `b` (parallel), `addAnnotation({ type: "para-dist", a, b })`, `setTool("select")`

**Angle computation:**
```js
function lineAngleDeg(ann) {
  const ep = getLineEndpoints(ann);
  return Math.atan2(ep.b.y - ep.a.y, ep.b.x - ep.a.x) * 180 / Math.PI;
}
let diff = Math.abs(lineAngleDeg(refAnn) - lineAngleDeg(clickedAnn)) % 180;
if (diff > 90) diff = 180 - diff;
const angleDeg = diff; // acute angle in [0°, 90°]
```

### Annotation fields

**Para-dist (Mode B):**
```
{ type: "para-dist", a: {x, y}, b: {x, y} }
```

**Parallelism (Mode A):**
```
{ type: "parallelism", a: {x, y}, b: {x, y}, angleDeg: number }
```
`a` and `b` are the midpoints of the two reference lines (used as visual endpoints of the annotation).

### Rendering

**`para-dist`:** Call `drawDistance(ann, sel)`. Additionally draw two short parallel tick marks on the line body to indicate the constraint:
```js
// two ticks centered on the line, 4px apart
const mx = (ann.a.x+ann.b.x)/2, my = (ann.a.y+ann.b.y)/2;
const dx = ann.b.x-ann.a.x, dy = ann.b.y-ann.a.y;
const len = Math.hypot(dx, dy);
const ux = dx/len, uy = dy/len;
const vx = -uy*5, vy = ux*5;  // perpendicular, 5px half-length
[-2, 2].forEach(offset => {
  const cx = mx + ux*offset, cy = my + uy*offset;
  drawLine({x: cx-vx, y: cy-vy}, {x: cx+vx, y: cy+vy},
           sel ? "#60a5fa" : "#a78bfa", 1.5);
});
```

**`parallelism`:** Dedicated `drawParallelism(ann, sel)` function. Draw a **dashed** line from `a` to `b` (using `ctx.setLineDash([4, 4])`), then restore `setLineDash([])`. Color and lineWidth same as `drawDistance`. Label at midpoint.

### `measurementLabel`

```js
if (ann.type === "para-dist") {
  const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
  if (!cal) return `∥ ${px.toFixed(1)} px`;
  const mm = px / cal.pixelsPerMm;
  return cal.displayUnit === "µm" ? `∥ ${(mm*1000).toFixed(2)} µm`
                                   : `∥ ${mm.toFixed(3)} mm`;
}
if (ann.type === "parallelism") {
  return `∥ ${ann.angleDeg.toFixed(2)}°`;  // two decimal places, consistent with angle tool
}
```

### Dispatches

- `"para-dist"`: alongside `"distance"` in `hitTestAnnotation`, `getHandles`, `handleDrag`; alongside `"distance"` in `drawAnnotations` with added tick marks
- `"parallelism"`: separate `drawParallelism` in `drawAnnotations`; alongside `"distance"` in `hitTestAnnotation` (`distPointToSegment < 8`) and `getHandles` (`{ a, b }`); alongside `"distance"` in `handleDrag`

---

## Feature 3: Area (`area`)

### Toolbar

New button `"Area"` with `data-tool="area"`, placed after `perp-dist`. Keyboard shortcut: `R`. Tooltip: `"Area [R]"`.

### TOOL_STATUS entry

```js
"area": "Area — click points, double-click to confirm",
```

### Interaction

1. Each click adds a point to `state.pendingPoints` (no debounce — same pattern as arc-fit after the recent fix)
2. Mousemove: `drawAreaPreview(state.pendingPoints, pt)` shows current polygon + edge to cursor
3. Double-click confirms: strip confirmation dblclick points with `slice(0, -2)`, check `length >= 3`, call `addAnnotation`, call `setTool("select")`

### `dblclick` handler extension

The existing handler guards with `if (state.tool !== "arc-fit") return`. Extend to cover both tools:

```js
canvas.addEventListener("dblclick", () => {
  if (state.tool !== "arc-fit" && state.tool !== "area") return;

  const points = state.pendingPoints.slice(0, -2);
  if (state.tool === "arc-fit") {
    if (points.length < 3) { alert("Need at least 3 points..."); return; }
    const result = fitCircleAlgebraic(points);
    if (!result) { alert("Could not fit a circle..."); state.pendingPoints = []; redraw(); return; }
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
  } else {
    // area
    if (points.length < 3) { alert("Need at least 3 points to define an area."); return; }
    addAnnotation({ type: "area", points });
  }
  const newRow = listEl.querySelector(".measurement-item.selected");
  if (newRow) newRow.scrollIntoView({ block: "nearest" });
  setTool("select");
});
```

### Annotation fields

```
{ type: "area", points: [{x, y}, …] }
```

### Area computation (shoelace formula)

```js
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

### `drawArea(ann, sel)`

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
```

**`drawAreaPreview(pts, cursor)`** — called from `mousemove`. Draws `[...pts, cursor]` as a closed polygon with `rgba(251,146,60,0.08)` fill and `rgba(251,146,60,0.4)` stroke, no label.

`drawPendingPoints` already draws orange dots for all `pendingPoints` entries — area pending vertices should also show as dots, so this requires no change.

### `measurementLabel`

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

### `hitTestAnnotation`

Point-in-polygon test (ray casting) for `"body"` hit. Also check proximity to each edge (`distPointToSegment < 8`) for edge clicks. If either passes, return true.

### `getHandles`

```js
if (ann.type === "area") {
  const handles = {};
  ann.points.forEach((p, i) => { handles[`v${i}`] = p; });
  return handles;
}
```

`"body"` is set by `handleSelectDown` (implicit from body hit test) — it is not returned by `getHandles`. This is consistent with the existing pattern for all annotation types.

### `handleDrag`

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

### `drawAnnotations` dispatch

```js
else if (ann.type === "area") drawArea(ann, sel);
```

---

## Feature 4: Coordinate Readout

### Toolbar

New icon button `id="btn-set-origin"`, `title="Set coordinate origin"`, symbol `⊙`, placed in the icon group (near `btn-crosshair`). Not a `data-tool` button — a mode toggle like `btn-dxf-set-origin`.

### State additions (already listed in Prerequisite section)

`state.origin = null` — set to `{ x, y }` in canvas coordinates when origin is placed.

### `_originMode` flag

```js
let _originMode = false;

document.getElementById("btn-set-origin").addEventListener("click", () => {
  _originMode = !_originMode;
  document.getElementById("btn-set-origin").classList.toggle("active", _originMode);
});
```

In `onMouseDown`, before the `_dxfOriginMode` check and before `handleToolClick`:

```js
if (_originMode) {
  state.annotations = state.annotations.filter(a => a.type !== "origin");
  state.origin = { x: pt.x, y: pt.y };
  addAnnotation({ type: "origin", x: pt.x, y: pt.y });
  _originMode = false;
  document.getElementById("btn-set-origin").classList.remove("active");
  return;
}
```

### Origin annotation

```
{ type: "origin", x, y }
```

Only one origin annotation can exist at a time (enforced by filtering in the above handler).

**`renderSidebar`:** The origin annotation is **not** added to the type skip list — it renders as a sidebar row so the user can delete it. However, it is **not counted** in the numbered measurement index (`i`): add a check `if (ann.type === "origin") { /* render row without number, skip i++ */ }`. The row shows a fixed symbol (e.g. `"⊙"`) instead of a circled number.

**`deleteAnnotation`:** Add origin side effect:

```js
if (ann.type === "origin") {
  state.origin = null;
  document.getElementById("coord-display").textContent = "";
}
```

Place this alongside the existing `if (ann.type === "calibration")` check.

**`btn-clear`:** Add to the clear handler:
```js
state.pendingRefLine = null;
state.origin = null;
_originMode = false;
document.getElementById("btn-set-origin").classList.remove("active");
document.getElementById("coord-display").textContent = "";
```
The `btn-clear` filter `state.annotations.filter(a => a.type === "dxf-overlay")` already removes origin annotations.

### Canvas rendering

`drawOrigin(ann, sel)`:
```js
function drawOrigin(ann, sel) {
  const color = sel ? "#60a5fa" : "#facc15";
  const s = 8;
  drawLine({x: ann.x - s, y: ann.y}, {x: ann.x + s, y: ann.y}, color, 1);
  drawLine({x: ann.x, y: ann.y - s}, {x: ann.x, y: ann.y + s}, color, 1);
  // small circle at centre
  ctx.beginPath();
  ctx.arc(ann.x, ann.y, 3, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}
```

`drawAnnotations` dispatch: `else if (ann.type === "origin") drawOrigin(ann, sel);`

`hitTestAnnotation` for `"origin"`: `Math.hypot(pt.x - ann.x, pt.y - ann.y) < 10`

`getHandles` for `"origin"`: `return { center: { x: ann.x, y: ann.y } };`

`handleDrag` for `"origin"`: `ann.x += dx; ann.y += dy; state.origin = { x: ann.x, y: ann.y };`

`measurementLabel` for `"origin"`: return `""` — origin is a reference, not a measurement. It appears in the sidebar but not in CSV export (empty label row is excluded from CSV).

### Coordinate HUD

Add inside `#viewer` in `index.html`:
```html
<div id="coord-display"></div>
```

**CSS:**
```css
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

**`mousemove` update** (inside the existing canvas `mousemove` handler):
```js
if (state.origin) {
  const dx = pt.x - state.origin.x;
  const dy = pt.y - state.origin.y;
  const coordEl = document.getElementById("coord-display");
  if (!state.calibration) {
    coordEl.textContent = `X: ${dx.toFixed(0)} px  Y: ${dy.toFixed(0)} px`;
  } else {
    const ppm = state.calibration.pixelsPerMm;
    if (state.calibration.displayUnit === "µm") {
      coordEl.textContent =
        `X: ${(dx/ppm*1000).toFixed(1)} µm  Y: ${(dy/ppm*1000).toFixed(1)} µm`;
    } else {
      coordEl.textContent =
        `X: ${(dx/ppm).toFixed(3)} mm  Y: ${(dy/ppm).toFixed(3)} mm`;
    }
  }
}
```

**`mouseleave`** on canvas: `document.getElementById("coord-display").textContent = "";`

---

## Help dialog additions

Add three rows to the Tools table:

| Tool | Key | How to use |
|------|-----|------------|
| Perp | P | Click a reference line, then two points; line is constrained perpendicular |
| Para | L | Click a reference line, then two points (parallel) or a second line (shows parallelism angle) |
| Area | R | Click ≥3 points to define a polygon, double-click to confirm |

Add one row to Other Shortcuts:

| Key | Action |
|-----|--------|
| ⊙ (toolbar) | Click to set coordinate origin; hover shows X/Y relative to origin |

---

## Files Changed

| File | Changes |
|------|---------|
| `frontend/app.js` | All logic: new tools, helpers, origin mode, HUD update, dblclick extension, mousemove extension |
| `frontend/index.html` | New toolbar buttons (Para, Perp, Area, ⊙); updated help dialog; `coord-display` div in `#viewer` |
| `frontend/style.css` | `#coord-display` styles |

No backend changes. No new tests required.
