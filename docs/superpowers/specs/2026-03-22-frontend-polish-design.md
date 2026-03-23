# Frontend Polish Design

**Date:** 2026-03-22

## Goal

Fix three small bugs in `frontend/app.js` introduced or surfaced during the origin rotation feature.

## Fixes

### 1. Origin arm hit-test

**Problem:** `hitTestAnnotation` for the `origin` type only tests a 10px radius around the center point. Clicking anywhere on the X or Y arm line body does not select the annotation.

**Fix:** In the `origin` case of `hitTestAnnotation`, additionally test proximity to the two arm line segments (origin → xTip, origin → yTip). Use `distPointToSegment` (already defined) with a 6px threshold. Note: `hitTestAnnotation(ann, pt)` takes annotation first, point second.

```js
if (ann.type === "origin") {
  const angle = ann.angle ?? 0;
  const axisLen = 30;
  const xTip = { x: ann.x + Math.cos(angle) * axisLen, y: ann.y + Math.sin(angle) * axisLen };
  const yTip = { x: ann.x + Math.sin(angle) * axisLen, y: ann.y - Math.cos(angle) * axisLen };
  const orig = { x: ann.x, y: ann.y };
  return dist(pt, orig) < 10
    || distPointToSegment(pt, orig, xTip) < 6
    || distPointToSegment(pt, orig, yTip) < 6;
}
```

Note: clicking exactly on the X-tip handle will be caught by `hitTestHandle` (which runs before `hitTestAnnotation` in the select flow) and initiate rotation drag — that is the correct behaviour.

### 2. X/Y label placement at rotation

**Problem:** `drawOrigin` places "X" and "Y" labels at a fixed `(+4, +4)` pixel offset from the tip. At angles past ~135° the labels drift back into the shaft.

**Fix:** Offset labels purely along the arm direction unit vector (no fixed-pixel addend):

```js
// X label: 8px beyond tip in X-axis direction
ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
// Y label: 8px beyond tip in Y-axis direction
ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);
```

`xcos/xsin` and `ycos/ysin` are already computed in `drawOrigin`. A pure directional offset keeps labels consistently beyond the arrowhead at all angles.

### 3. `ctx.font` and `ctx.fillStyle` leak in `drawOrigin`

**Problem:** `drawOrigin` sets `ctx.font = "bold 10px ui-monospace, monospace"` and `ctx.fillStyle = color` without a `ctx.save()`/`ctx.restore()` guard. Both values leak into subsequent draw calls in the same `redraw()` pass — `ctx.font` in particular is only set in `drawOrigin`, so no other function corrects it.

**Fix:** Wrap the label section with save/restore. The `drawHandle` call at the end of the function must remain outside the guard (it does not use `ctx.font`):

```js
ctx.save();
ctx.font = "bold 10px ui-monospace, monospace";
ctx.fillStyle = color;
ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);
ctx.restore();

// Axis handle dot — outside save/restore intentionally
drawHandle(xTip, sel ? "#60a5fa" : "#facc15");
```

## Files Changed

| File | Change |
|------|--------|
| `frontend/app.js` | `hitTestAnnotation` origin case; `drawOrigin` label offset; `drawOrigin` ctx.save/restore |

## Testing

- Place origin, click on arm body (not center dot, not axis handle) → annotation selects.
- Place origin, rotate to ~180° → X/Y labels remain beyond arrowheads, not overlapping shaft.
- Place origin, draw a distance annotation → distance label renders in normal (non-bold, non-monospace) font.
- Drag axis handle → rotation still works (handle hit-test is unaffected).
