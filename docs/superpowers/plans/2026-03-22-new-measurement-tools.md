# New Measurement Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three reference-based measurement tools: point-to-circle distance, line intersection, and slot width.

**Architecture:** All changes in `frontend/app.js` and `frontend/index.html`. Each tool follows the established two-click annotation pattern. All three reference other annotations by ID and re-compute at draw time.

**Tech Stack:** Vanilla JS, HTML5 Canvas

---

## File Map

| File | What changes |
|------|-------------|
| `frontend/app.js` | State field `pendingCircleRef`; `TOOL_STATUS` entries; `toolKeys` entries; `handleToolClick` branches; three draw functions; `drawAnnotations` dispatch; `hitTestAnnotation` branches; `getHandles` branches; `handleDrag` branch; `measurementLabel` branches |
| `frontend/index.html` | Three toolbar `<button>` elements; three help table rows |

---

## Task 1 — Shared infrastructure

**Files:**
- Modify: `frontend/app.js` — state initializer (lines 1–20), `TOOL_STATUS` (lines 22–35), `setTool` (lines 37–47), `toolKeys` map (line 147)
- Modify: `frontend/index.html` — toolbar section (lines 11–38), help table (lines 216–229)

### Steps

- [ ] **Step 1.1 — Add `pendingCircleRef` to the state initializer**

Read lines 1–20 of `app.js` first. Then add `pendingCircleRef: null` immediately after `pendingCenterCircle: null` on line 10.

```js
// Before (lines 9-11):
  pendingCenterCircle: null,
  pendingRefLine: null,   // reference line for perp-dist / para-dist

// After:
  pendingCenterCircle: null,
  pendingRefLine: null,   // reference line for perp-dist / para-dist
  pendingCircleRef: null, // reference circle for pt-circle-dist
```

- [ ] **Step 1.2 — Clear `pendingCircleRef` in `setTool`**

Read lines 37–47 of `app.js` first. Then add the clear immediately after `state.pendingCenterCircle = null;`.

```js
// Before (lines 38-41):
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;

// After:
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;
  state.pendingCircleRef = null;
```

- [ ] **Step 1.3 — Add `TOOL_STATUS` entries for all three new tools**

Read lines 22–35 of `app.js` first. Then add three new entries to the `TOOL_STATUS` object, immediately before the closing `};`.

```js
// Add after  "area":   "Area — click points, double-click to confirm",
  "pt-circle-dist": "Pt-Circle — click a circle to measure from",
  "intersect":      "Intersect — click a reference line",
  "slot-dist":      "Slot — click a reference line",
```

- [ ] **Step 1.4 — Add keyboard shortcuts to `toolKeys`**

Read lines 147–153 of `app.js` first. Then add three new entries to the existing `toolKeys` object literal.

```js
// Before:
  const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                     o: "circle", f: "arc-fit", m: "center-dist", e: "detect",
                     p: "perp-dist", l: "para-dist", r: "area" };

// After:
  const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                     o: "circle", f: "arc-fit", m: "center-dist", e: "detect",
                     p: "perp-dist", l: "para-dist", r: "area",
                     g: "pt-circle-dist", i: "intersect", w: "slot-dist" };
```

- [ ] **Step 1.5 — Add three toolbar buttons to `index.html`**

Read lines 11–38 of `index.html` first. Then insert three new `<button>` elements immediately after the `<button data-tool="area">` button on line 21 (before the `<button data-tool="detect">` button).

```html
  <button class="tool-btn" data-tool="pt-circle-dist" title="Pt-Circle distance [G]">PtCirc</button>
  <button class="tool-btn" data-tool="intersect" title="Line intersection [I]">Isect</button>
  <button class="tool-btn" data-tool="slot-dist" title="Slot width [W]">Slot</button>
```

- [ ] **Step 1.6 — Add three help table rows to `index.html`**

Read lines 216–229 of `index.html` first. Then insert three new `<tr>` rows immediately after the `<tr><td>Area</td>…</tr>` row on line 227.

```html
        <tr><td>Pt-Circle</td><td>G</td><td>Click a circle, then click a free point — measures shortest gap to the circle edge</td></tr>
        <tr><td>Intersect</td><td>I</td><td>Click two line annotations — marks their mathematical intersection (even off-screen)</td></tr>
        <tr><td>Slot</td><td>W</td><td>Click two line annotations — measures perpendicular distance between the lines</td></tr>
```

**Manual verification (Task 1):**
- Open the app in a browser.
- Confirm all three buttons appear in the toolbar and are clickable.
- Press G, I, W — status bar should update to the correct prompt text.
- Press Escape after each — status should return to "Select".
- Open Help (?) — confirm the three rows appear in the tools table.

---

## Task 2 — Point-to-circle distance (`pt-circle-dist`)

**Files:**
- Modify: `frontend/app.js` — `handleToolClick`, `drawAnnotations`, new `drawPtCircleDist`, `hitTestAnnotation`, `getHandles`, `handleDrag`, `measurementLabel`

### Steps

- [ ] **Step 2.1 — Add `handleToolClick` branch for `pt-circle-dist`**

Read lines 206–402 of `app.js` first (the full `handleToolClick` body). Then insert the following block immediately before the closing `}` of `handleToolClick` (after the `center-dist` block, before the final `}`).

```js
  if (tool === "pt-circle-dist") {
    if (!state.pendingCircleRef) {
      // Step 1: snap to a circle
      const circle = snapToCircle(pt);
      if (!circle) {
        statusEl.textContent = "Click a circle first";
        return;
      }
      state.pendingCircleRef = { circleId: circle.id };
      statusEl.textContent = "Now click a point to measure from";
      redraw();
      return;
    }
    // Step 2: place the free point
    const { circleId } = state.pendingCircleRef;
    state.pendingCircleRef = null;
    addAnnotation({ type: "pt-circle-dist", circleId, px: pt.x, py: pt.y });
    setTool("select");
    return;
  }
```

- [ ] **Step 2.2 — Add `drawPtCircleDist` function**

Read lines 839–844 (`drawDistance`) and lines 1376–1393 (`snapToCircle`) of `app.js` first, to confirm the drawing helpers and `detected-circle` scaling pattern. Then insert the following new function immediately after `drawDistance` (after line 844).

```js
function drawPtCircleDist(ann, sel) {
  const circle = state.annotations.find(a => a.id === ann.circleId);
  if (!circle) {
    // Error state: dashed red circle at the free point
    ctx.save();
    ctx.beginPath();
    ctx.arc(ann.px, ann.py, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  let cx, cy, r;
  if (circle.type === "circle") {
    cx = circle.cx; cy = circle.cy; r = circle.r;
  } else {
    // detected-circle: scale from frame to canvas coords
    const sx = canvas.width / circle.frameWidth;
    const sy = canvas.height / circle.frameHeight;
    cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
  }
  const dist = Math.hypot(ann.px - cx, ann.py - cy);
  if (dist < 1e-6) return; // degenerate: point at center
  const edgePt = {
    x: cx + (ann.px - cx) / dist * r,
    y: cy + (ann.py - cy) / dist * r,
  };
  const color = sel ? "#60a5fa" : "#facc15";
  drawLine({ x: ann.px, y: ann.py }, edgePt, color, sel ? 2 : 1.5);
  if (sel) drawHandle({ x: ann.px, y: ann.py }, "#60a5fa");
  const mx = (ann.px + edgePt.x) / 2;
  const my = (ann.py + edgePt.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}
```

- [ ] **Step 2.3 — Register `pt-circle-dist` in `drawAnnotations`**

Read lines 789–809 of `app.js` first. Then add a dispatch entry immediately after the `para-dist` line inside `drawAnnotations`:

```js
// After:
    else if (ann.type === "para-dist")   drawParaDist(ann, sel);

// Insert:
    else if (ann.type === "pt-circle-dist") drawPtCircleDist(ann, sel);
```

- [ ] **Step 2.4 — Add `hitTestAnnotation` branch for `pt-circle-dist`**

Read lines 1319–1363 of `app.js` first. Then insert a new branch immediately before the final `return false;`.

```js
  if (ann.type === "pt-circle-dist") {
    // Hit the free point
    if (Math.hypot(pt.x - ann.px, pt.y - ann.py) < 8) return true;
    // Hit the line from point to circle edge (re-derive edgePt)
    const circle = state.annotations.find(a => a.id === ann.circleId);
    if (!circle) return false;
    let cx, cy, r;
    if (circle.type === "circle") {
      cx = circle.cx; cy = circle.cy; r = circle.r;
    } else {
      const sx = canvas.width / circle.frameWidth;
      const sy = canvas.height / circle.frameHeight;
      cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
    }
    const dist = Math.hypot(ann.px - cx, ann.py - cy);
    if (dist < 1e-6) return false;
    const edgePt = {
      x: cx + (ann.px - cx) / dist * r,
      y: cy + (ann.py - cy) / dist * r,
    };
    return distPointToSegment(pt, { x: ann.px, y: ann.py }, edgePt) < 6;
  }
```

- [ ] **Step 2.5 — Add `getHandles` branch for `pt-circle-dist`**

Read lines 1290–1317 of `app.js` first. Then insert a new branch immediately before `return {};` at line 1316.

```js
  if (ann.type === "pt-circle-dist") return { pt: { x: ann.px, y: ann.py } };
```

- [ ] **Step 2.6 — Add `handleDrag` branch for `pt-circle-dist`**

Read lines 1432–1494 of `app.js` first. Then insert a new branch inside `handleDrag`, before the final `renderSidebar(); redraw();` calls.

```js
  else if (ann.type === "pt-circle-dist") {
    // Only the free point is draggable; circle reference is fixed
    ann.px += dx; ann.py += dy;
  }
```

- [ ] **Step 2.7 — Add `measurementLabel` branch for `pt-circle-dist`**

Read lines 521–603 of `app.js` first. Then insert a new branch immediately before the final `if (ann.type === "origin") return "";` line.

```js
  if (ann.type === "pt-circle-dist") {
    const circle = state.annotations.find(a => a.id === ann.circleId);
    if (!circle) return "⊙ ref deleted";
    let cx, cy, r;
    if (circle.type === "circle") {
      cx = circle.cx; cy = circle.cy; r = circle.r;
    } else {
      const sx = canvas.width / circle.frameWidth;
      const sy = canvas.height / circle.frameHeight;
      cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
    }
    const dist = Math.hypot(ann.px - cx, ann.py - cy);
    const gapPx = dist - r;
    const cal = state.calibration;
    if (!cal) return `⊙ ${gapPx.toFixed(1)} px`;
    const mm = gapPx / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⊙ ${(mm * 1000).toFixed(2)} µm`
      : `⊙ ${mm.toFixed(3)} mm`;
  }
```

Note: negative values (point inside circle) render naturally as `"⊙ −0.xxx mm"` because `gapPx` is negative.

**Manual verification (Task 2):**
- Draw a circle annotation (tool O).
- Press G, click the circle edge — status should say "Now click a point to measure from".
- Click somewhere nearby — annotation should appear with a yellow line from the point to the nearest circle edge and a label "⊙ N px" or "⊙ N mm".
- Select the annotation; drag the free point handle — line and label should update live.
- Delete the circle — the `pt-circle-dist` annotation should show a dashed red circle at the free point; sidebar should show "⊙ ref deleted".
- Confirm pressing G with no circles in the scene shows "Click a circle first" in the status bar.

---

## Task 3 — Line intersection (`intersect`)

**Files:**
- Modify: `frontend/app.js` — `handleToolClick`, `drawAnnotations`, new `drawIntersect`, `hitTestAnnotation`, `getHandles`, `measurementLabel`

### Steps

- [ ] **Step 3.1 — Add `handleToolClick` branch for `intersect`**

Read lines 206–402 of `app.js` first. Then insert the following block immediately before the closing `}` of `handleToolClick` (after the `pt-circle-dist` block added in Task 2).

```js
  if (tool === "intersect") {
    const snapped = findSnapLine(pt);
    if (!state.pendingRefLine) {
      // Step 1: pick first line
      if (!snapped) return; // no line nearby — ignore click
      state.pendingRefLine = snapped;
      statusEl.textContent = "Now click a second line";
      redraw();
      return;
    }
    // Step 2: pick second line
    if (!snapped) return; // no line nearby — ignore click
    if (snapped.id === state.pendingRefLine.id) return; // same line — keep waiting
    const lineAId = state.pendingRefLine.id;
    const lineBId = snapped.id;
    state.pendingRefLine = null;
    addAnnotation({ type: "intersect", lineAId, lineBId });
    setTool("select");
    return;
  }
```

- [ ] **Step 3.2 — Add `drawIntersect` function**

Read lines 188–191 (`lineAngleDeg`), 1397–1412 (`getLineEndpoints`), and 811–818 (`drawLine`) of `app.js` first. Then insert the following new function after `drawPtCircleDist` (added in Task 2).

The parametric intersection uses the standard infinite-line formula. Given line A through points `a1`, `a2` and line B through `b1`, `b2`:

```
dx_a = a2.x - a1.x,  dy_a = a2.y - a1.y
dx_b = b2.x - b1.x,  dy_b = b2.y - b1.y
denom = dx_a * dy_b - dy_a * dx_b
t = ((b1.x - a1.x) * dy_b - (b1.y - a1.y) * dx_b) / denom
ix = a1.x + t * dx_a
iy = a1.y + t * dy_a
```

Full function to insert:

```js
function drawIntersect(ann, sel) {
  const annA = state.annotations.find(a => a.id === ann.lineAId);
  const annB = state.annotations.find(a => a.id === ann.lineBId);
  if (!annA || !annB) return; // error state: nothing drawn on canvas

  const epA = getLineEndpoints(annA);
  const epB = getLineEndpoints(annB);

  // Parallel detection
  const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
  let diff = Math.abs(dA - dB) % 180;
  if (diff > 90) diff = 180 - diff;
  if (diff < 1) return; // parallel — nothing drawn; sidebar handles label

  // Parametric intersection of two infinite lines
  const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
  const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
  const denom = dx_a * dy_b - dy_a * dx_b;
  if (Math.abs(denom) < 1e-10) return; // degenerate

  const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
  const ix = epA.a.x + t * dx_a;
  const iy = epA.a.y + t * dy_a;

  // Off-screen guard: do not draw crosshair if point is far outside canvas
  const margin = Math.max(canvas.width, canvas.height);
  if (ix < -margin || ix > canvas.width + margin ||
      iy < -margin || iy > canvas.height + margin) return;

  // Draw crosshair: 8px arms
  const color = sel ? "#60a5fa" : "#f97316";
  const ARM = 8;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.moveTo(ix - ARM, iy); ctx.lineTo(ix + ARM, iy);
  ctx.moveTo(ix, iy - ARM); ctx.lineTo(ix, iy + ARM);
  ctx.stroke();
}
```

- [ ] **Step 3.3 — Register `intersect` in `drawAnnotations`**

Read lines 789–809 of `app.js` first. Then add a dispatch entry immediately after the `pt-circle-dist` line added in Task 2.

```js
    else if (ann.type === "intersect")      drawIntersect(ann, sel);
```

- [ ] **Step 3.4 — Add `hitTestAnnotation` branch for `intersect`**

Read lines 1319–1363 of `app.js` first. Then insert a new branch immediately before the `pt-circle-dist` branch added in Task 2.

```js
  if (ann.type === "intersect") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return false;
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let diff = Math.abs(dA - dB) % 180;
    if (diff > 90) diff = 180 - diff;
    if (diff < 1) return false; // parallel
    const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const denom = dx_a * dy_b - dy_a * dx_b;
    if (Math.abs(denom) < 1e-10) return false;
    const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
    const ix = epA.a.x + t * dx_a;
    const iy = epA.a.y + t * dy_a;
    // Off-screen intersections are not selectable
    if (ix < 0 || ix > canvas.width || iy < 0 || iy > canvas.height) return false;
    return Math.hypot(pt.x - ix, pt.y - iy) < 8;
  }
```

- [ ] **Step 3.5 — Add `getHandles` branch for `intersect`**

Read lines 1290–1317 of `app.js` first. Then insert immediately before `return {};` at line 1316:

```js
  if (ann.type === "intersect") return {};
```

This is explicit and documents intent; the existing fallthrough `return {}` would also work but the explicit guard makes the code self-documenting.

- [ ] **Step 3.6 — Add `measurementLabel` branch for `intersect`**

Read lines 521–603 of `app.js` first. Then insert a new branch immediately before the `pt-circle-dist` branch added in Task 2.

```js
  if (ann.type === "intersect") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "⊕ ref deleted";
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let diff = Math.abs(dA - dB) % 180;
    if (diff > 90) diff = 180 - diff;
    if (diff < 1) return "∥ no intersection";
    const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const denom = dx_a * dy_b - dy_a * dx_b;
    if (Math.abs(denom) < 1e-10) return "∥ no intersection";
    const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
    const ix = epA.a.x + t * dx_a;
    const iy = epA.a.y + t * dy_a;
    // Off-screen: show coordinates but mark as off-screen
    const margin = Math.max(canvas.width, canvas.height);
    const offScreen = ix < -margin || ix > canvas.width + margin ||
                      iy < -margin || iy > canvas.height + margin;
    const cal = state.calibration;
    const org = state.origin;
    if (org) {
      // Convert to user-frame coordinates using origin and rotation angle
      const cosA = Math.cos(-(org.angle ?? 0)), sinA = Math.sin(-(org.angle ?? 0));
      const rx = ix - org.x, ry = iy - org.y;
      const ux = rx * cosA - ry * sinA;
      const uy = rx * sinA + ry * cosA;
      if (cal) {
        const xVal = ux / cal.pixelsPerMm;
        const yVal = uy / cal.pixelsPerMm;
        const unit = cal.displayUnit === "µm" ? "µm" : "mm";
        const scale = cal.displayUnit === "µm" ? 1000 : 1;
        const xStr = (xVal * scale).toFixed(cal.displayUnit === "µm" ? 2 : 3);
        const yStr = (yVal * scale).toFixed(cal.displayUnit === "µm" ? 2 : 3);
        return offScreen
          ? `⊕ off-screen  X: ${xStr} ${unit}  Y: ${yStr} ${unit}`
          : `⊕ X: ${xStr} ${unit}  Y: ${yStr} ${unit}`;
      }
      return offScreen
        ? `⊕ off-screen  X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`
        : `⊕ X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`;
    }
    return offScreen
      ? `⊕ off-screen  (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`
      : `⊕ (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`;
  }
```

**Manual verification (Task 3):**
- Draw two `distance` annotations that cross (tool D).
- Press I, click the first line — status should say "Now click a second line".
- Click the same line again — status should not change (duplicate guard).
- Click the second line — annotation is created; a small orange `+` crosshair should appear at the intersection.
- Sidebar should show `"⊕ (X, Y) px"`.
- Draw two parallel lines; repeat — sidebar should show `"∥ no intersection"`, no crosshair drawn.
- Extend lines so they would intersect far off-screen — sidebar should show `"⊕ off-screen (X, Y) px"`, no crosshair drawn.
- Delete one referenced line — sidebar should show `"⊕ ref deleted"`.
- Set an origin (⊙ button) and re-verify sidebar shows user-frame coordinates.

---

## Task 4 — Slot width (`slot-dist`)

**Files:**
- Modify: `frontend/app.js` — `handleToolClick`, `drawAnnotations`, new `drawSlotDist`, `hitTestAnnotation`, `getHandles`, `measurementLabel`

### Steps

- [ ] **Step 4.1 — Add `handleToolClick` branch for `slot-dist`**

Read lines 206–402 of `app.js` first. Then insert the following block immediately before the closing `}` of `handleToolClick` (after the `intersect` block added in Task 3).

```js
  if (tool === "slot-dist") {
    const snapped = findSnapLine(pt);
    if (!state.pendingRefLine) {
      // Step 1: pick first line
      if (!snapped) return; // no line nearby — ignore click
      state.pendingRefLine = snapped;
      statusEl.textContent = "Now click a second line";
      redraw();
      return;
    }
    // Step 2: pick second line
    if (!snapped) return; // no line nearby — ignore click
    if (snapped.id === state.pendingRefLine.id) return; // same line — keep waiting
    const lineAId = state.pendingRefLine.id;
    const lineBId = snapped.id;
    state.pendingRefLine = null;
    addAnnotation({ type: "slot-dist", lineAId, lineBId });
    setTool("select");
    return;
  }
```

- [ ] **Step 4.2 — Add `drawSlotDist` function**

Read lines 188–191 (`lineAngleDeg`), 1397–1412 (`getLineEndpoints`), and 830–837 (`drawLabel`) of `app.js` first. Then insert the following new function after `drawIntersect` (added in Task 3).

The perpendicular distance between two infinite lines is computed as: take `midA` (midpoint of line A segment), project it onto the infinite line through line B's two endpoints using a standard foot-of-perpendicular formula.

Foot of perpendicular from point P onto infinite line through `b1`, `b2`:
```
dx = b2.x - b1.x, dy = b2.y - b1.y
t = ((P.x - b1.x)*dx + (P.y - b1.y)*dy) / (dx*dx + dy*dy)
foot = { x: b1.x + t*dx, y: b1.y + t*dy }
```

Full function to insert:

```js
function drawSlotDist(ann, sel) {
  const annA = state.annotations.find(a => a.id === ann.lineAId);
  const annB = state.annotations.find(a => a.id === ann.lineBId);
  if (!annA || !annB) return; // error state: nothing drawn on canvas

  const epA = getLineEndpoints(annA);
  const epB = getLineEndpoints(annB);

  // midpoint of segment A
  const midA = {
    x: (epA.a.x + epA.b.x) / 2,
    y: (epA.a.y + epA.b.y) / 2,
  };

  // Foot of perpendicular from midA onto infinite line B
  const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
  const lenSqB = dx_b * dx_b + dy_b * dy_b;
  if (lenSqB < 1e-10) return; // degenerate line B
  const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
  const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };

  const color = sel ? "#60a5fa" : "#a78bfa";
  drawLine(midA, projA, color, sel ? 2 : 1.5);

  const mx = (midA.x + projA.x) / 2;
  const my = (midA.y + projA.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}
```

- [ ] **Step 4.3 — Register `slot-dist` in `drawAnnotations`**

Read lines 789–809 of `app.js` first. Then add a dispatch entry immediately after the `intersect` line added in Task 3.

```js
    else if (ann.type === "slot-dist")      drawSlotDist(ann, sel);
```

- [ ] **Step 4.4 — Add `hitTestAnnotation` branch for `slot-dist`**

Read lines 1319–1363 of `app.js` first. Then insert a new branch immediately before the `intersect` branch added in Task 3.

```js
  if (ann.type === "slot-dist") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return false;
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const midA = {
      x: (epA.a.x + epA.b.x) / 2,
      y: (epA.a.y + epA.b.y) / 2,
    };
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const lenSqB = dx_b * dx_b + dy_b * dy_b;
    if (lenSqB < 1e-10) return false;
    const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
    const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };
    return distPointToSegment(pt, midA, projA) < 6;
  }
```

- [ ] **Step 4.5 — Add `getHandles` branch for `slot-dist`**

Read lines 1290–1317 of `app.js` first. Then insert immediately before the `intersect` branch added in Task 3 (or alongside it).

```js
  if (ann.type === "slot-dist") return {};
```

- [ ] **Step 4.6 — Add `measurementLabel` branch for `slot-dist`**

Read lines 521–603 of `app.js` first. Then insert a new branch immediately before the `intersect` branch added in Task 3.

```js
  if (ann.type === "slot-dist") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "⟺ ref deleted";
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    // midA → projA gives the perpendicular distance
    const midA = {
      x: (epA.a.x + epA.b.x) / 2,
      y: (epA.a.y + epA.b.y) / 2,
    };
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const lenSqB = dx_b * dx_b + dy_b * dy_b;
    if (lenSqB < 1e-10) return "⟺ 0 px";
    const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
    const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };
    const gapPx = Math.hypot(midA.x - projA.x, midA.y - projA.y);
    // Non-parallel angle deviation
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let angleDiff = Math.abs(dA - dB) % 180;
    if (angleDiff > 90) angleDiff = 180 - angleDiff;
    const angSuffix = angleDiff > 2 ? ` (±${angleDiff.toFixed(1)}°)` : "";
    const cal = state.calibration;
    if (!cal) return `⟺ ${gapPx.toFixed(1)} px${angSuffix}`;
    const mm = gapPx / cal.pixelsPerMm;
    const valStr = cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
    return `⟺ ${valStr}${angSuffix}`;
  }
```

**Manual verification (Task 4):**
- Draw two roughly parallel line annotations (tool D).
- Press W, click the first line — status should say "Now click a second line".
- Click the same line again — status should not change (duplicate guard).
- Click the second line — annotation created; a purple connector line should appear from the midpoint of line A perpendicular to line B, with a label "⟺ N px" or "⟺ N mm".
- Make the lines non-parallel (> 2° difference): label should include `(±N.N°)` suffix.
- Delete one referenced line — sidebar should show "⟺ ref deleted", nothing drawn on canvas.
- Verify calibrated measurement: apply a calibration, re-measure — label should show mm/µm value.
