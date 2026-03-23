# Frontend Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three small bugs in the origin annotation: arm hit-test, label placement at rotation, and ctx.font/fillStyle leak.

**Architecture:** All changes in `frontend/app.js`. Three independent, surgical edits.

**Tech Stack:** Vanilla JS, HTML5 Canvas

---

## Task 1 — Origin arm hit-test

**File:** `frontend/app.js`

**Problem:** The `origin` case in `hitTestAnnotation` only tests a 10px radius around the center dot. Clicking anywhere on the X or Y arm shaft does not select the annotation.

**Fix:** Add segment-proximity tests for both arms using the existing `distPointToSegment` helper, with a 6px threshold. The tip handle is intentionally excluded — `hitTestHandle` catches that first and initiates rotation drag.

- [ ] Open `frontend/app.js` and locate the `hitTestAnnotation` function (around line 1319).

- [ ] Apply the following edit:

**old_string:**
```js
  if (ann.type === "origin") {
    return Math.hypot(pt.x - ann.x, pt.y - ann.y) < 10;
  }
```

**new_string:**
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

**Manual verification:**
- Place an origin annotation on the canvas.
- With the select tool active, click somewhere along the middle of the X arm shaft (not on the center dot, not on the yellow axis handle at the tip) — the annotation should become selected (highlighted blue).
- Repeat for the Y arm shaft.
- Click empty canvas — annotation deselects.
- Click the yellow axis handle at the X tip — this should initiate rotation drag (not body selection); drag slightly and confirm the origin rotates.

---

## Task 2 — Label direction offset

**File:** `frontend/app.js`

**Problem:** `drawOrigin` places the "X" and "Y" labels using a fixed `(+4, +4)` pixel offset from the tip. At angles past roughly 135° the labels drift back over the arm shaft because the fixed offset no longer points away from the origin.

**Fix:** Replace the fixed addend with a purely directional offset along the arm's unit vector (`xcos/xsin` for the X label, `ycos/ysin` for the Y label). Both variables are already computed earlier in `drawOrigin`.

- [ ] Locate the label section inside `drawOrigin` (around line 1088).

- [ ] Apply the following edit:

**old_string:**
```js
  // Axis labels
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + 4, xTip.y + 4);
  ctx.fillText("Y", yTip.x + 4, yTip.y + 4);
```

**new_string:**
```js
  // Axis labels
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
  ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);
```

**Manual verification:**
- Place an origin annotation at 0° (default) — "X" should appear to the right of the X arrowhead, "Y" above the Y arrowhead.
- Rotate the origin to roughly 90°, 135°, and 180° by dragging the axis handle. At every angle the labels should remain clearly beyond the arrowhead, never overlapping the arm shaft.
- Confirm labels move symmetrically as the annotation is rotated through a full 360°.

---

## Task 3 — ctx.save/restore wrap in drawOrigin

**File:** `frontend/app.js`

**Problem:** `drawOrigin` sets `ctx.font` and `ctx.fillStyle` without a `ctx.save()`/`ctx.restore()` guard. Both values leak into subsequent draw calls made by `redraw()` in the same frame. `ctx.font` in particular is never reset by any other draw function, so distance/angle labels rendered after an origin annotation inherit `"bold 10px ui-monospace, monospace"`.

**Fix:** Wrap the label block (the two `ctx.font`/`ctx.fillStyle`/`ctx.fillText` statements) in `ctx.save()`/`ctx.restore()`. The `drawHandle` call at the end must remain outside the guard — it does not use `ctx.font`.

Note: this edit also incorporates the directional offset from Task 2. Apply Task 2 first, then apply this edit — or apply them together by using the new_string below as the final state of the label block.

- [ ] Locate the label + handle section at the bottom of `drawOrigin` (around line 1087). After Task 2 has been applied it will read:

**old_string:**
```js
  // Axis labels
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
  ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);

  // Axis handle dot (drag target for rotation) — always visible
  drawHandle(xTip, sel ? "#60a5fa" : "#facc15");
```

**new_string:**
```js
  // Axis labels — wrapped in save/restore to prevent ctx.font and ctx.fillStyle leaking
  ctx.save();
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
  ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);
  ctx.restore();

  // Axis handle dot (drag target for rotation) — outside save/restore intentionally
  drawHandle(xTip, sel ? "#60a5fa" : "#facc15");
```

**Manual verification:**
- Place an origin annotation, then immediately place a distance annotation on the same canvas.
- The distance annotation's measurement label (rendered by `drawLabel`) should appear in the normal UI font (not bold monospace). Before this fix it would inherit `"bold 10px ui-monospace, monospace"`.
- The "X" / "Y" labels on the origin should still render correctly in bold monospace.
- `ctx.fillStyle` should also not leak: after placing the origin, draw a circle annotation and verify its label colour is the standard annotation colour, not the origin's `color` value.
