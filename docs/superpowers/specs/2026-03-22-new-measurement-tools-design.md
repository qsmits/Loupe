# New Measurement Tools Design

**Date:** 2026-03-22

## Goal

Three new measurement annotation types: point-to-circle distance (`pt-circle-dist`), line intersection point (`intersect`), and slot width (`slot-dist`).

---

## 1. Point-to-Circle Distance (`pt-circle-dist`)

### Purpose

Measures the shortest gap between a free point and the edge of a circle — useful for clearance checks.

### Workflow

Tool key: **G**. Two-click:

1. **First click** — snap to a circle annotation. Call `snapToCircle(pt)` (existing function, 20px edge threshold, handles `"circle"` and `"detected-circle"`). If no circle is found, update status to `"Click a circle first"` and return without storing anything. If a circle is found, store `{ circleId: ann.id }` in a new `state.pendingCircleRef` field and update status to `"Now click a point to measure from"`.
2. **Second click** — free point (with snap-to-annotation applied via `snapPoint`). Create the annotation.

Status messages (in `TOOL_STATUS` map): `"pt-circle-dist": "Click a circle to measure from"`.

On `setTool()`, clear `state.pendingCircleRef = null` (add to state initializer and `setTool`).

### Data model

```js
{ type: "pt-circle-dist", circleId: <ann.id>, px: <x>, py: <y> }
```

### `getHandles`

```js
{ pt: { x: ann.px, y: ann.py } }
```

The free point is draggable; the circle reference is not. `handleDrag` with `handleKey === "pt"` updates `ann.px` and `ann.py`.

### Rendering (`drawPtCircleDist`)

At draw time, look up the referenced circle by `circleId` in `state.annotations`. If not found, render error state (see §Shared Error State).

For `detected-circle`, convert coordinates to canvas space using the same scaling as `snapToCircle` (`sx = canvas.width / ann.frameWidth`, `sy = canvas.height / ann.frameHeight`).

```
center = { x: circle.cx * sx, y: circle.cy * sy }   // (sx=sy=1 for "circle" type)
r = circle.r * sx
dist = Math.hypot(ann.px - center.x, ann.py - center.y)
gap = dist - r    // negative if point is inside circle
edgePt = center + (pt - center) / dist * r  // nearest point on circle edge
```

Draw a line from `{ann.px, ann.py}` to `edgePt` in the annotation color. Draw dimension label at the midpoint of that line using the same style as `drawDistance`.

### Measurement label

`"⊙ 3.142 mm"` (use calibration if available). Negative gap shown as `"⊙ −0.5 mm"` (point is inside the circle).

### Hit-test

Test within 8px of `{ann.px, ann.py}` or within 6px of the line from `edgePt` to `{ann.px, ann.py}`.

---

## 2. Line Intersection (`intersect`)

### Purpose

Find and mark where two line-like annotations meet — useful for implied corners not physically present in the image.

### Workflow

Tool key: **I**. Two-click:

1. **First click** — call `findSnapLine(pt)`. If none found, update status and return. Store `{ lineAId: ann.id }` in `state.pendingRefLine` (reuse existing field). Status: `"Now click a second line"`. `setTool()` clears `state.pendingRefLine = null`, so switching tools mid-click leaves no stale state.
2. **Second click** — call `findSnapLine(pt)` again. If the same annotation as the first click is returned, ignore the click and retain `state.pendingRefLine` so the user can click a different line. Otherwise create the annotation.

### Data model

```js
{ type: "intersect", lineAId: <id>, lineBId: <id> }
```

### `getHandles`

Returns `{}` — no draggable handles. The intersection point is derived from its references.

### Intersection math

Use `getLineEndpoints` to get `{a, b}` for each line (both treated as infinite).

**Parallel detection:** compute the normalised angle difference between the two lines using the same fold as `para-dist`:

```js
const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
let diff = Math.abs(dA - dB) % 180;
if (diff > 90) diff = 180 - diff;
// if diff < 1°, lines are parallel
```

If parallel: sidebar shows `"∥ no intersection"`, nothing drawn on canvas.

**Intersection point:** parametric line-line intersection on the two infinite lines through `{a,b}` pairs.

**Off-screen handling:** compute intersection point. If it lies outside `[−canvas.width, 2*canvas.width] × [−canvas.height, 2*canvas.height]`, do not draw the crosshair on canvas but still show the coordinates in the sidebar as `"⊕ off-screen"` (plus the pixel coordinates if no calibration, or the user-frame coordinates if origin is set).

### Rendering

Draw a `+` crosshair (8px arms, 1.5px stroke) at the intersection point, in the annotation color. If origin is set, the sidebar shows the intersection coordinates in the user frame.

### Hit-test

8px radius around the computed intersection point. If the point is off-screen, hit-testing returns false (nothing to select on canvas).

### Sidebar label

`"⊕ X: 3.142 mm  Y: 1.200 mm"` if origin set; `"⊕ (412, 307) px"` if no origin; `"∥ no intersection"` if parallel.

---

## 3. Slot Width (`slot-dist`)

### Purpose

Measures the perpendicular distance between two parallel (or near-parallel) line annotations — the width of a slot, gap, or channel.

### Workflow

Tool key: **W**. Two-click using `findSnapLine`, same pattern as `intersect`. Reuse `state.pendingRefLine` for the first reference. `setTool()` clears `state.pendingRefLine = null` (same clearing already required for `intersect`).

### Data model

```js
{ type: "slot-dist", lineAId: <id>, lineBId: <id> }
```

### `getHandles`

Returns `{}` — no draggable handles.

### Rendering (`drawSlotDist`)

**Distance:** compute the perpendicular distance between the two infinite lines (standard point-to-line formula using one endpoint of line A and the direction of line B).

**Connector:** the visual connector is drawn as follows:
```
midA = midpoint of segment A endpoints
projA = foot of perpendicular from midA onto infinite line B
connector: midA → projA
label at midpoint of connector
```

**Non-parallel indicator:** compute angle difference using the same formula as §Intersection math. If `diff > 2°`, append `" (±N.N°)"` to the label. The 2° threshold is intentionally higher than the intersect parallel threshold (1°) because slot-dist is designed to handle slightly non-parallel slots and report the deviation rather than refusing to compute.

### Measurement label

`"⟺ 3.142 mm"` (use calibration if available). With non-parallel note: `"⟺ 3.142 mm (±1.5°)"`.

### Hit-test

Within 6px of the connector line segment.

---

## Shared: Reference-based annotations

`pt-circle-dist`, `intersect`, and `slot-dist` all reference other annotations by ID. Rules:

**Reference deletion:** deleting a referenced annotation does not cascade-delete dependents. Dependents detect the missing reference at draw time and render in error state.

**Error state rendering:**

| Type | Error rendering |
|------|----------------|
| `pt-circle-dist` | Dashed red circle (radius 6) centered at `{px, py}`; sidebar: `"⊙ ref deleted"` |
| `intersect` | Nothing drawn on canvas (no meaningful position to draw at); sidebar: `"⊕ ref deleted"` |
| `slot-dist` | Nothing drawn on canvas; sidebar: `"⟺ ref deleted"` |

In all cases: sidebar text is red, no measurement value shown.

**`deleteAnnotation` unchanged** — error state is handled entirely at draw time, not at deletion time.

## Files Changed

| File | Change |
|------|--------|
| `frontend/app.js` | 3 draw functions; `hitTestAnnotation`, `getHandles`, `handleDrag` branches; `handleToolClick` branches; `measurementLabel` branches; `state.pendingCircleRef` field; `TOOL_STATUS` entries |
| `frontend/index.html` | 3 toolbar buttons (G — Pt-Circle, I — Intersect, W — Slot); help table rows |
| `frontend/style.css` | No new styles needed |
