# Origin Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a draggable axis handle to the coordinate origin so users can rotate the X/Y frame to align with their part.

**Architecture:** All changes in `frontend/app.js` only. The origin annotation gains an `angle` field (radians, default 0). `drawOrigin` is replaced with oriented axis arrows. `getHandles` gains an `axis` handle; `handleDrag` recomputes angle when it moves. The HUD applies a 2D rotation matrix before displaying coordinates.

**Tech Stack:** Vanilla JS, same file as all other annotation logic.

---

## File Map

| File | Lines | What changes |
|------|-------|-------------|
| `frontend/app.js` | ~1900 | Everything — angle field, drawOrigin, getHandles, handleDrag, HUD math |

---

## Task 1: State and data model — add `angle` to origin

**Files:**
- Modify: `frontend/app.js` (4 small sites)

- [ ] **Step 1: Add `angle: 0` to the annotation created in `onMouseDown`**

Find the `_originMode` block in `onMouseDown` (around line 92-100). It has:
```js
    addAnnotation({ type: "origin", x: pt.x, y: pt.y });
```
Change to:
```js
    addAnnotation({ type: "origin", x: pt.x, y: pt.y, angle: 0 });
```

- [ ] **Step 2: Sync `angle` into `state.origin` when the annotation is placed**

In the same `_originMode` block, the line:
```js
    state.origin = { x: pt.x, y: pt.y };
```
Change to:
```js
    state.origin = { x: pt.x, y: pt.y, angle: 0 };
```

- [ ] **Step 3: Sync `angle` in `handleDrag` for origin**

Find the `"origin"` branch in `handleDrag` (around line 1417):
```js
  else if (ann.type === "origin") {
    ann.x += dx; ann.y += dy;
    state.origin = { x: ann.x, y: ann.y };
  }
```
Change to:
```js
  else if (ann.type === "origin") {
    if (handleKey === "axis") {
      // Recompute angle from origin to current mouse position
      ann.angle = Math.atan2(pt.y - ann.y, pt.x - ann.x);
      state.origin = { x: ann.x, y: ann.y, angle: ann.angle };
    } else {
      // Move entire origin (center handle or body)
      ann.x += dx; ann.y += dy;
      state.origin = { x: ann.x, y: ann.y, angle: ann.angle };
    }
  }
```

- [ ] **Step 4: Verify the data model changes look correct**

Read the modified sections in `onMouseDown` (~line 92) and `handleDrag` (~line 1417) to confirm the changes are correct.

---

## Task 2: Visual — replace `drawOrigin` with oriented axis arrows

**Files:**
- Modify: `frontend/app.js` — `drawOrigin` and `getHandles` for origin

- [ ] **Step 1: Replace `drawOrigin` with an oriented version**

Find `drawOrigin` (around line 1037). Replace the entire function with:

```js
function drawOrigin(ann, sel) {
  const color = sel ? "#60a5fa" : "#facc15";
  const angle = ann.angle ?? 0;
  const axisLen = 30;
  // X-axis direction
  const xcos = Math.cos(angle), xsin = Math.sin(angle);
  // Y-axis direction: 90° CCW as seen on screen (canvas Y is down, so use (sin θ, -cos θ))
  const ycos = xsin, ysin = -xcos;

  // X axis arrow
  const xTip = { x: ann.x + xcos * axisLen, y: ann.y + xsin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, xTip, color, 1.5);
  // Arrowhead on X
  const ax = xcos * 6, ay = xsin * 6;
  const bx = -xsin * 3, by = xcos * 3;
  ctx.beginPath();
  ctx.moveTo(xTip.x, xTip.y);
  ctx.lineTo(xTip.x - ax + bx, xTip.y - ay + by);
  ctx.lineTo(xTip.x - ax - bx, xTip.y - ay - by);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Y axis arrow
  const yTip = { x: ann.x + ycos * axisLen, y: ann.y + ysin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, yTip, color, 1.5);
  // Arrowhead on Y
  const cx2 = ycos * 6, cy2 = ysin * 6;
  const dx2 = -ysin * 3, dy2 = ycos * 3;
  ctx.beginPath();
  ctx.moveTo(yTip.x, yTip.y);
  ctx.lineTo(yTip.x - cx2 + dx2, yTip.y - cy2 + dy2);
  ctx.lineTo(yTip.x - cx2 - dx2, yTip.y - cy2 - dy2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Small circle at origin
  ctx.beginPath();
  ctx.arc(ann.x, ann.y, 3, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Axis labels
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + 4, xTip.y + 4);
  ctx.fillText("Y", yTip.x + 4, yTip.y + 4);

  // Axis handle dot (drag target for rotation) — always visible
  drawHandle(xTip, sel ? "#60a5fa" : "#facc15");
}
```

- [ ] **Step 2: Update `getHandles` for origin to include the `axis` handle**

Find the origin case in `getHandles` (around line 1252):
```js
  if (ann.type === "origin") return { center: { x: ann.x, y: ann.y } };
```

Replace with:
```js
  if (ann.type === "origin") {
    const angle = ann.angle ?? 0;
    const axisLen = 30;
    return {
      center: { x: ann.x, y: ann.y },
      axis: {
        x: ann.x + Math.cos(angle) * axisLen,
        y: ann.y + Math.sin(angle) * axisLen,
      },
    };
  }
```

- [ ] **Step 3: Verify visual changes**

Read `drawOrigin` and the `getHandles` origin case to confirm they look correct.

---

## Task 3: HUD — apply rotation matrix to displayed coordinates

**Files:**
- Modify: `frontend/app.js` — `mousemove` HUD block

- [ ] **Step 1: Update the coordinate HUD to rotate coordinates**

Find the HUD block in the `mousemove` handler (around line 1099-1115):
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

Replace with:
```js
  // Coordinate readout HUD
  const coordEl = document.getElementById("coord-display");
  if (coordEl && state.origin) {
    const rawDx = pt.x - state.origin.x;
    const rawDy = pt.y - state.origin.y;
    // Project into user frame: dot with X unit (cos θ, sin θ) and Y unit (sin θ, -cos θ)
    // Y unit is 90° CCW on screen (canvas Y-down), so Y+ points up when angle=0
    const a = state.origin.angle ?? 0;
    const rx =  Math.cos(a) * rawDx + Math.sin(a) * rawDy;
    const ry =  Math.sin(a) * rawDx - Math.cos(a) * rawDy;
    if (!state.calibration) {
      coordEl.textContent = `X: ${rx.toFixed(0)} px  Y: ${ry.toFixed(0)} px`;
    } else {
      const ppm = state.calibration.pixelsPerMm;
      if (state.calibration.displayUnit === "µm") {
        coordEl.textContent =
          `X: ${(rx / ppm * 1000).toFixed(1)} µm  Y: ${(ry / ppm * 1000).toFixed(1)} µm`;
      } else {
        coordEl.textContent =
          `X: ${(rx / ppm).toFixed(3)} mm  Y: ${(ry / ppm).toFixed(3)} mm`;
      }
    }
  }
```

- [ ] **Step 2: Verify the HUD block looks correct**

Read those lines and confirm the rotation math is in place.

---

## Quick Reference

| What changes | Where |
|---|---|
| `addAnnotation(...)` — add `angle: 0` | `onMouseDown` `_originMode` block |
| `state.origin = ...` — add `angle: 0` | Same block |
| `handleDrag` origin — axis/center split | `handleDrag` origin branch |
| `drawOrigin` — oriented arrows + labels + handle | Replace entire function |
| `getHandles` origin — add `axis` handle | Origin case in `getHandles` |
| HUD math — apply rotation matrix | `mousemove` HUD block |
