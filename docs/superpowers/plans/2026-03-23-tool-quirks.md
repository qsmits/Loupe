# Tool Quirks Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three usability issues: missing origin placement preview, snap indicator not visible before first click (plus Alt-bypass for snap), and fit-arc not refining to the actual detected circle.

**Architecture:** All changes in `frontend/app.js` except one row added to the help table in `frontend/index.html`. No backend changes — uses the existing `/detect-circles` endpoint.

**Tech Stack:** Vanilla JS, HTML5 Canvas

---

## Task 1 — Origin live preview

**File:** `frontend/app.js`

**Problem:** When `_originMode` is active, there is no visual feedback while moving the cursor — the origin indicator only appears after the click commits it.

**Fix:** After the existing `redraw()` call inside the `mousemove` handler, draw the full origin indicator at the cursor position at 50% opacity whenever `_originMode` is true.

- [ ] Open `frontend/app.js` and locate the `mousemove` handler (around line 1491). Identify the section near the bottom of the handler where `state.snapTarget` is cleared — specifically the block at lines 1565–1567:

```js
  if (state.tool === "select" || state.pendingPoints.length === 0) {
    state.snapTarget = null;
  }
```

- [ ] Insert the following block immediately **before** the `if (state.tool === "select" || ...)` guard at the bottom of the handler (after the coordinate readout HUD block), so it runs on every mousemove whenever origin mode is active:

**old_string:**
```js
  if (state.tool === "select" || state.pendingPoints.length === 0) {
    state.snapTarget = null;
  }
});
```

**new_string:**
```js
  if (_originMode) {
    redraw();
    ctx.save();
    ctx.globalAlpha = 0.5;
    drawOrigin({ x: pt.x, y: pt.y, angle: state.origin?.angle ?? 0 }, false);
    ctx.restore();
  }
  if (state.tool === "select" || state.pendingPoints.length === 0) {
    state.snapTarget = null;
  }
});
```

- [ ] Verify visually: activate the ⊙ toolbar button (origin mode), move the cursor over the canvas — a semi-transparent origin indicator should track the cursor. Click to commit — the indicator becomes full opacity and stops tracking.

---

## Task 2 — Snap indicator always visible + Alt bypass

This task has three sub-steps: (A) add the bypass parameter to `snapPoint`, (B) move snap computation to the top of `mousemove`, (C) update `handleToolClick` to pass `e.altKey`, and (D) add the help row.

### Step 2A — Add `bypass` parameter to `snapPoint`

**File:** `frontend/app.js`

- [ ] Locate `snapPoint` at around line 266:

```js
function snapPoint(rawPt) {
  if (state.tool === "select") return { pt: rawPt, snapped: false };
```

- [ ] Apply the following edit:

**old_string:**
```js
function snapPoint(rawPt) {
  if (state.tool === "select") return { pt: rawPt, snapped: false };
```

**new_string:**
```js
function snapPoint(rawPt, bypass = false) {
  if (bypass) return { pt: rawPt, snapped: false };
  if (state.tool === "select") return { pt: rawPt, snapped: false };
```

### Step 2B — Move snap computation to top of `mousemove` handler

**File:** `frontend/app.js`

The current handler computes `snapPoint` only inside rubber-band branches (i.e., only when `pendingPoints.length > 0`). The snap indicator therefore never appears before the first click. The fix is to compute it unconditionally for all relevant tools at the very top of the handler, before any branching.

- [ ] Locate the start of the `mousemove` handler (around line 1491):

```js
canvas.addEventListener("mousemove", e => {
  const pt = canvasPoint(e);
  if (state.dragState) { handleDrag(pt); return; }
  if (state.pendingPoints.length > 0 && state.tool !== "select"
```

- [ ] Insert the snap pre-computation block immediately after the `dragState` early-return line and before the rubber-band branching. Apply the following edit:

**old_string:**
```js
canvas.addEventListener("mousemove", e => {
  const pt = canvasPoint(e);
  if (state.dragState) { handleDrag(pt); return; }
  if (state.pendingPoints.length > 0 && state.tool !== "select"
      && state.tool !== "arc-fit"
      && state.tool !== "perp-dist"
      && state.tool !== "para-dist"
      && state.tool !== "area") {
    const { pt: snappedPt, snapped } = snapPoint(pt);
    state.snapTarget = snapped ? snappedPt : null;
    redraw();
```

**new_string:**
```js
canvas.addEventListener("mousemove", e => {
  const pt = canvasPoint(e);
  if (state.dragState) { handleDrag(pt); return; }
  const rawPt = pt;
  if (state.tool !== "select" && state.tool !== "calibrate" && state.tool !== "center-dist") {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
  }
  if (state.pendingPoints.length > 0 && state.tool !== "select"
      && state.tool !== "arc-fit"
      && state.tool !== "perp-dist"
      && state.tool !== "para-dist"
      && state.tool !== "area") {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
```

- [ ] In the perp-dist / para-dist rubber-band block (around line 1526), update the `snapPoint` call to pass `e.altKey`:

**old_string:**
```js
  if ((state.tool === "perp-dist" || state.tool === "para-dist")
      && state.pendingPoints.length === 1 && state.pendingRefLine) {
    const { pt: snappedPt, snapped } = snapPoint(pt);
    state.snapTarget = snapped ? snappedPt : null;
    redraw();
```

**new_string:**
```js
  if ((state.tool === "perp-dist" || state.tool === "para-dist")
      && state.pendingPoints.length === 1 && state.pendingRefLine) {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
```

- [ ] In the area polygon rubber-band block (around line 1536), update the `snapPoint` call to pass `e.altKey`:

**old_string:**
```js
  if (state.tool === "area" && state.pendingPoints.length >= 1) {
    const { pt: snappedPt, snapped } = snapPoint(pt);
    state.snapTarget = snapped ? snappedPt : null;
    redraw();
```

**new_string:**
```js
  if (state.tool === "area" && state.pendingPoints.length >= 1) {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
```

- [ ] Locate the tail guard at the bottom of the mousemove handler (around line 1565) and update it so it no longer zeroes out `snapTarget` when `pendingPoints.length === 0` — that guard is what currently prevents the snap indicator from showing before the first click. The `select` tool and `_originMode` are handled via the pre-computation block above and the origin preview block. Replace the guard to only suppress snap for the `select` tool:

**old_string:**
```js
  if (state.tool === "select" || state.pendingPoints.length === 0) {
    state.snapTarget = null;
  }
```

**new_string:**
```js
  if (_originMode) {
    redraw();
    ctx.save();
    ctx.globalAlpha = 0.5;
    drawOrigin({ x: pt.x, y: pt.y, angle: state.origin?.angle ?? 0 }, false);
    ctx.restore();
  }
  if (state.tool === "select") {
    state.snapTarget = null;
  }
```

> **Note:** If you already applied Task 1's edit (which inserted the `_originMode` block just before this guard), then in this step you only need to change the condition from `state.tool === "select" || state.pendingPoints.length === 0` to `state.tool === "select"` in the existing guard that follows the origin block. Apply whichever version of the edit matches the current file state.

### Step 2C — Pass `e.altKey` in `handleToolClick`

**File:** `frontend/app.js`

The `onMouseDown` handler calls `handleToolClick(pt)` — but it doesn't pass the event, so `handleToolClick` cannot see `e.altKey`. We need to thread the event through.

- [ ] In `onMouseDown`, change the call to pass the event:

**old_string:**
```js
  if (state.tool === "select") { handleSelectDown(pt, e); return; }
  handleToolClick(pt);
```

**new_string:**
```js
  if (state.tool === "select") { handleSelectDown(pt, e); return; }
  handleToolClick(pt, e);
```

- [ ] In `handleToolClick`, update the signature to accept the event and use `e.altKey` as the bypass:

**old_string:**
```js
function handleToolClick(rawPt) {
  const { pt } = (state.tool !== "calibrate" && state.tool !== "center-dist")
    ? snapPoint(rawPt)
    : { pt: rawPt };
```

**new_string:**
```js
function handleToolClick(rawPt, e = {}) {
  const { pt } = (state.tool !== "calibrate" && state.tool !== "center-dist")
    ? snapPoint(rawPt, e.altKey ?? false)
    : { pt: rawPt };
```

### Step 2D — Add Alt+click row to help table

**File:** `frontend/index.html`

- [ ] Locate the "Other Shortcuts" help table (around line 239–248):

```html
      <tbody>
        <tr><td>Escape</td><td>Back to Select / cancel</td></tr>
        <tr><td>Delete / Backspace</td><td>Delete selected annotation</td></tr>
        <tr><td>?</td><td>This help dialog</td></tr>
        <tr><td>⊙ (toolbar)</td><td>Click toolbar ⊙ then click canvas to set coordinate origin; hovering shows X/Y relative to origin</td></tr>
      </tbody>
```

- [ ] Add the `Alt + click` row after the `?` row and before the `⊙ (toolbar)` row:

**old_string:**
```html
        <tr><td>?</td><td>This help dialog</td></tr>
        <tr><td>⊙ (toolbar)</td><td>Click toolbar ⊙ then click canvas to set coordinate origin; hovering shows X/Y relative to origin</td></tr>
```

**new_string:**
```html
        <tr><td>?</td><td>This help dialog</td></tr>
        <tr><td>Alt + click</td><td>Bypass snap (precision placement)</td></tr>
        <tr><td>⊙ (toolbar)</td><td>Click toolbar ⊙ then click canvas to set coordinate origin; hovering shows X/Y relative to origin</td></tr>
```

- [ ] Verify visually: open the help dialog (`?`) — the "Other Shortcuts" table now shows `Alt + click | Bypass snap (precision placement)`.

- [ ] Verify snap behavior: select the Distance tool and hover over the canvas with no pending points — the blue open-circle snap indicator should appear near existing annotation endpoints. Hold Alt while hovering — the indicator should disappear. Hold Alt while clicking — the point should land exactly at the raw cursor position, ignoring snap.

---

## Task 3 — Fit-arc async refinement to detected circle

**File:** `frontend/app.js`

**Problem:** Fit-arc computes a circle through clicked points using least-squares. Because clicks are not perfectly on the edge, the result often sits slightly off the visible physical circle. The backend already detects circles via Hough transform — we can query it after committing the annotation and silently refine the result in-place.

**Fix:** After the `addAnnotation` call in the dblclick handler, fire an async `fetch` to `/detect-circles`. If the response returns a circle whose center is within one fitted radius of the fitted center, mutate the committed annotation and call `redraw()` + `renderSidebar()`.

- [ ] Locate the dblclick handler (around line 214). Find the `arc-fit` branch that calls `addAnnotation`:

```js
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
  } else {
    // area
```

- [ ] Apply the following edit to capture the annotation reference and fire the async refinement immediately after `addAnnotation`. The refinement is entirely async and does not block the `setTool("select")` call that follows:

**old_string:**
```js
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
  } else {
    // area
```

**new_string:**
```js
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
    // Async refinement: snap the committed annotation to the nearest detected circle
    (async () => {
      const ann = state.annotations[state.annotations.length - 1];
      if (!ann) return;
      const frameWidth = state.frozenSize?.w ?? canvas.width;
      const scale = frameWidth / canvas.width;
      const r_frame = result.r * scale;
      try {
        const resp = await fetch("/detect-circles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dp: 1.2,
            min_dist: 50,
            param1: 100,
            param2: 30,
            min_radius: Math.floor(r_frame * 0.8),
            max_radius: Math.ceil(r_frame * 1.2)
          })
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const circles = data.circles;
        if (!circles || circles.length === 0) return;
        const cx_frame = result.cx * scale;
        const cy_frame = result.cy * scale;
        let best = null;
        let bestDist = Infinity;
        for (const c of circles) {
          const d = Math.hypot(c.x - cx_frame, c.y - cy_frame);
          if (d < bestDist) { bestDist = d; best = c; }
        }
        if (!best || bestDist > r_frame) return;
        ann.cx = best.x / scale;
        ann.cy = best.y / scale;
        ann.r  = best.radius / scale;
        redraw();
        renderSidebar();
        statusEl.textContent = "Snapped to detected circle";
      } catch {
        // Network error or parse failure — leave annotation unchanged
      }
    })();
  } else {
    // area
```

- [ ] Verify the structure: the dblclick handler should now read: `fitCircleAlgebraic` → `addAnnotation` → async IIFE (fires and returns immediately) → `newRow` scroll logic → `setTool("select")`. The async IIFE must not wrap or delay the synchronous lines that follow it.

- [ ] Verify visually: with a captured frame (frozen image), use arc-fit to place 3+ points on a visible circle and double-click. The fitted circle should appear immediately. Within a short moment it should silently snap to the detected circle center if the backend finds one within the radius threshold. The status bar should read "Snapped to detected circle". On a live (unfrozen) feed, the annotation should remain as-is with no error message.

---

## Ordering note

Tasks 1, 2, and 3 are fully independent and can be applied in any order. However, Task 2 contains internal ordering dependencies: Step 2A (add `bypass` param) must be done before Step 2C (update call sites), and Step 2B (mousemove rewrite) should be done before verifying snap behavior. Step 2D (HTML) is independent of Steps 2A–2C.

If Tasks 1 and 2 are applied in sequence, note that the `_originMode` block and the tail guard edit overlap: Task 1 inserts the `_originMode` block before the tail guard, and Task 2B modifies the tail guard. When applying both, first apply Task 1 (inserting the block), then in Task 2B only change the condition in the existing guard from `state.tool === "select" || state.pendingPoints.length === 0` to `state.tool === "select"` — do not re-insert the `_originMode` block.
