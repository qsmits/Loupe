# Tool Quirks Design

## Goal

Fix three specific usability issues with existing tools: missing origin placement preview, snap indicator not showing before first click (with Alt-bypass), and fit-arc not refining to the actual detected circle in the image.

---

## Issue 1: Origin Live Preview

**Problem:** When the user activates origin-placement mode (⊙ toolbar button), no visual feedback appears until after the click commits the origin. The user cannot see where the origin will land while moving the cursor.

**Fix:** Draw the full origin indicator at the cursor position during mousemove while origin-placement mode is active, at 50% opacity as a preview.

**Implementation detail:** Inside the mousemove handler, when `_originMode` is true, after calling `redraw()` (which draws any committed origin at full opacity), do:

```js
ctx.save();
ctx.globalAlpha = 0.5;
drawOrigin({ x: pt.x, y: pt.y, angle: state.origin?.angle ?? 0 }, false);
ctx.restore();
```

The preview uses the cursor position `pt` and the current origin angle (or 0 if no origin is set yet). `sel = false` so no selection handles are drawn.

---

## Issue 2: Snap Indicator Always Visible + Alt Bypass

### Problem A — Snap indicator not shown before first click

The snap indicator (blue open circle) is only computed inside the rubber-band branches of the mousemove handler (i.e., only after the first point of a measurement is placed). When hovering to place the *first* point, no indicator appears. The user cannot see whether their click will be pulled to a snap target.

**Fix:** Move snap-target computation to the top of the mousemove handler, before any rubber-band branching. This applies to **all** measurement tools including `arc-fit` and `area` (which are currently excluded from the main rubber-band branch and only compute snap when `pendingPoints.length >= 1`). In the zero-pending-points case these tools should also compute and display the snap indicator on every cursor move.

Implementation: before any branching, unconditionally compute:

```js
if (state.tool !== "select" && state.tool !== "calibrate" && state.tool !== "center-dist") {
  state.snapTarget = e.altKey ? null : snapPoint(rawPt, e.altKey);
  redraw();
}
```

Then proceed to the rubber-band branching as before. The rubber-band branches call `redraw()` themselves, which will also draw the indicator since `state.snapTarget` is already set.

### Problem B — Cannot place two close lines (snap pulls second onto first)

When placing a second Distance line very close to an existing one (e.g., measuring a slot width), the snap pulls the new line's endpoints onto the existing line, making it impossible to place the lines independently.

**Fix:** Add an `altKey` bypass. The `snapPoint()` function signature becomes:

```js
function snapPoint(rawPt, bypass = false) {
  if (bypass) return rawPt;
  // ... existing logic
}
```

All call sites pass the event's `altKey` as the second argument:

- In mousemove: `snapPoint(rawPt, e.altKey)` — also skip setting `state.snapTarget` if `bypass` is true (so the indicator disappears)
- In `handleToolClick`: `snapPoint(rawPt, e.altKey)`

When `altKey` is true: `snapPoint` returns `rawPt` unchanged, no snap indicator is drawn.

The help table (`index.html`) gains one row:

| `Alt + click` | Bypass snap (precision placement) |

---

## Issue 3: Fit-Arc Auto-Refinement to Detected Circle

**Problem:** Fit-arc fits a circle through the user's clicked points using least-squares, but the result often sits slightly beside the actual physical circle visible in the image because the clicked points aren't perfectly on the edge.

**Fix:** After the user double-clicks to confirm, commit the annotation immediately (so the UI is not blocked), then asynchronously refine it by querying the backend.

### Step 1 — Commit immediately (existing fast path)

`addAnnotation` is called with the fitted circle as usual. The annotation is visible right away.

### Step 2 — Async refinement

Fire a `fetch` to `/detect-circles` (POST) with the following body:

```json
{
  "dp": 1.2,
  "min_dist": 50,
  "param1": 100,
  "param2": 30,
  "min_radius": <floor(r_frame * 0.8)>,
  "max_radius": <ceil(r_frame * 1.2)>
}
```

Where `r_frame` is the fitted radius converted from canvas pixels to frame pixels:
`r_frame = fitted_r * (frameWidth / canvasWidth)` where `frameWidth = state.frozenSize?.w ?? canvas.width` and `canvasWidth = canvas.width` (matching the pattern used by the existing detect-circles button). If `state.frozenSize` is null (live feed, no frame captured yet), the scale factor is 1 and coordinates are treated as identical — acceptable since the backend will return a 400 and the fallback path will be taken anyway.

`param2 = 30` (lower than the sidebar default of 50) is used to increase sensitivity for this targeted search, since we already know the approximate size.

### Step 3 — Coordinate conversion for comparison

The backend returns circles in **frame pixel coordinates** (`x, y, radius` relative to the raw frame). The fitted center `(cx, cy)` is in **canvas coordinates**. Convert the fitted center to frame coordinates before comparison:

```js
const frameWidth = state.frozenSize?.w ?? canvas.width;
const scale = frameWidth / canvas.width;  // same scale used above
const cx_frame = cx * scale;
const cy_frame = cy * scale;
```

Among the returned circles, find the one with the smallest Euclidean distance from `(cx_frame, cy_frame)`. Accept it if that distance is `≤ r_frame` (i.e., within one fitted radius in frame space).

### Step 4 — Snap or fall back

If a match is found: mutate the committed annotation in-place:

```js
ann.cx = best.x / scale;  // back to canvas coords
ann.cy = best.y / scale;
ann.r  = best.radius / scale;
```

Then call `redraw()` and `renderSidebar()`. Show status: `"Snapped to detected circle"`.

If no match (no circles returned, no circle within threshold, network error, or 400 from the backend because no frame is stored): leave the annotation unchanged, show no status message.

### Notes

- A 400 response (no stored frame — camera is live and no frame has been captured yet) silently falls back to the fitted result. This is acceptable behavior.
- The `dblclick` handler already strips the last two phantom click points via `points.slice(0, -2)` before fitting. The refinement fetch is fired after `addAnnotation`, so it does not affect point stripping.

---

## Files Changed

| File | Change |
|---|---|
| `frontend/app.js` | Origin preview in mousemove; snap indicator computed before rubber-band branches with `redraw()` call; `snapPoint(rawPt, bypass)` signature; all call sites pass `e.altKey`; fit-arc dblclick handler fires async refinement after `addAnnotation` |
| `frontend/index.html` | Help table: add `Alt + click` row |
| `frontend/style.css` | No changes |
| `backend/` | No changes — uses existing `/detect-circles` endpoint |
