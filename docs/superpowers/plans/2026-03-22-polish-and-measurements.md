# Polish & Measurements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix arc-fit bugs, add circle preview, fix Clear All, add bidirectional selection highlight, add center-distance tool, add keyboard shortcuts, add help dialog, and make calibration a first-class deletable annotation.

**Architecture:** All changes are in three frontend files. The work has a strict dependency order:
- **Prerequisite** (`setTool()`) must land before Tasks 1 and 6, which both call it.
- **Task 5** (`snapToCircle()` helper) must land before Task 8 (Calibration as Annotation), which calls `snapToCircle()` for circle-edge snapping. Tasks 1–7 are otherwise independent of each other.

No backend changes.

**Tech Stack:** Vanilla JS (~1100-line `app.js`), HTML5 Canvas, CSS custom properties. No frontend test framework — verification is manual browser smoke tests plus backend pytest to confirm nothing regressed.

---

## File Structure

| File | Changes |
|------|---------|
| `frontend/app.js` | All logic: setTool(), deleteAnnotation(), applyCalibration(), arc-fit fixes, circle preview, clear-all fix, selection scroll, center-dist tool, keyboard shortcuts, calibration annotation flows |
| `frontend/index.html` | New buttons (Cdist, Help), updated `title` attributes on all tool buttons, help dialog HTML |
| `frontend/style.css` | Help dialog styles (reuse existing dialog CSS pattern) |

---

## Prerequisite: `setTool(name)` Helper

**Files:**
- Modify: `frontend/app.js:47-57` (tool-btn click handler), `frontend/app.js:92-108` (keydown handler)

> Features 1 and 6 both call `setTool()`. Do this first.

- [ ] **Step 1: Add the TOOL_STATUS map and setTool() function**

  Insert after line 20 (after the `state` object closes), before the DOM refs block:

  ```js
  // ── TOOL_STATUS map and setTool helper ─────────────────────────────────────
  const TOOL_STATUS = {
    "select":      "Select",
    "calibrate":   "Calibrate — click two points or a circle",
    "distance":    "Distance — click point 1",
    "angle":       "Angle — click point 1",
    "circle":      "Circle — click point 1",
    "arc-fit":     "Fit Arc — click points, double-click to confirm",
    "center-dist": "Center distance — click a circle to select it",
    "detect":      "Detect",
  };

  function setTool(name) {
    state.tool = name;
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    document.querySelectorAll(".tool-btn[data-tool]").forEach(b =>
      b.classList.toggle("active", b.dataset.tool === name));
    statusEl.textContent = TOOL_STATUS[name] ?? name;
    redraw();
  }
  ```

  Note: `statusEl` is declared on line 26 — the function body references it safely because `setTool` is only called after DOMContentLoaded.

- [ ] **Step 2: Add `pendingCenterCircle: null` to the state object**

  In the `state` object (lines 4-20), after `pendingPoints: [],` add:

  ```js
  pendingCenterCircle: null, // for center-dist tool: the first picked circle
  ```

- [ ] **Step 3: Replace the tool-btn click handler with a call to setTool()**

  Current code (lines 48-57):
  ```js
  document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.tool = btn.dataset.tool;
      state.pendingPoints = [];
      document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      canvas.style.cursor = state.tool === "select" ? "default" : "crosshair";
      redraw();
    });
  });
  ```

  Replace with:
  ```js
  document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => {
      setTool(btn.dataset.tool);
      canvas.style.cursor = state.tool === "select" ? "default" : "crosshair";
    });
  });
  ```

- [ ] **Step 4: Verify**

  Open `http://localhost:8000` in a browser. Click each tool button — the button highlights blue, the status bar text changes to match the TOOL_STATUS map entry. Click Distance, place one point, click Select — pending orange dot disappears. No console errors.

---

## Task 1: Arc-Fit Bug Fixes

**Files:**
- Modify: `frontend/app.js` — dblclick handler (~line 110), mousemove rubber-band (~line 641)

**Three bugs:** (a) tool stays in arc-fit after confirmation, (b) new circle is not selected/scrolled in sidebar, (c) rubber-band dotted line appears during arc-fit.

- [ ] **Step 1: Fix the dblclick handler**

  Current code (lines 110-124):
  ```js
  canvas.addEventListener("dblclick", () => {
    if (state.tool !== "arc-fit") return;
    if (state.pendingPoints.length < 3) {
      alert("Need at least 3 points. Keep clicking to add more, then double-click to confirm.");
      return;
    }
    const result = fitCircleAlgebraic(state.pendingPoints);
    if (!result) {
      alert("Could not fit a circle — points may be collinear or too close together.");
    } else {
      addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
    }
    state.pendingPoints = [];
    redraw();
  });
  ```

  Replace with:
  ```js
  canvas.addEventListener("dblclick", () => {
    if (state.tool !== "arc-fit") return;
    if (state.pendingPoints.length < 3) {
      alert("Need at least 3 points. Keep clicking to add more, then double-click to confirm.");
      return;
    }
    const result = fitCircleAlgebraic(state.pendingPoints);
    if (!result) {
      alert("Could not fit a circle — points may be collinear or too close together.");
      state.pendingPoints = [];
      redraw();
      return;
    }
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
    // addAnnotation already sets state.selected to the new id and calls renderSidebar()
    const newRow = listEl.querySelector(".measurement-item.selected");
    if (newRow) newRow.scrollIntoView({ block: "nearest" });
    setTool("select");
  });
  ```

  Note: `addAnnotation()` (line 273) already does `state.selected = ann.id` and `renderSidebar()`. So the scroll can happen immediately after it returns. `setTool("select")` clears `pendingPoints` and calls `redraw()`.

- [ ] **Step 2: Suppress rubber-band line during arc-fit**

  Current mousemove handler (lines 641-648):
  ```js
  canvas.addEventListener("mousemove", e => {
    if (state.pendingPoints.length > 0 && state.tool !== "select") {
      redraw();
      const pt = canvasPoint(e);
      const last = state.pendingPoints[state.pendingPoints.length - 1];
      drawLine(last, pt, "rgba(251,146,60,0.5)", 1);
    }
  });
  ```

  Replace with:
  ```js
  canvas.addEventListener("mousemove", e => {
    if (state.pendingPoints.length > 0 && state.tool !== "select" && state.tool !== "arc-fit") {
      redraw();
      const pt = canvasPoint(e);
      const last = state.pendingPoints[state.pendingPoints.length - 1];
      drawLine(last, pt, "rgba(251,146,60,0.5)", 1);
    }
  });
  ```

- [ ] **Step 3: Verify**

  Switch to Fit Arc tool. Click 4+ points on the canvas (each click places an orange dot; no dotted lines from dots to cursor). The dashed orange arc preview updates live. Double-click — the fitted circle appears, the tool automatically returns to Select, the new circle row is visible and highlighted in the sidebar.

---

## Task 2: Circle Tool Live Preview

**Files:**
- Modify: `frontend/app.js` — the second `mousemove` listener (lines 641-648, after Task 1 edit)

When 2 pending points exist in circle mode, compute `fitCircle(p1, p2, cursor)` and draw a dashed preview.

- [ ] **Step 1: Extend the mousemove handler to draw circle preview**

  Replace the `canvas.addEventListener("mousemove", ...)` handler (after Task 1's edit) with:

  ```js
  canvas.addEventListener("mousemove", e => {
    const pt = canvasPoint(e);
    if (state.pendingPoints.length > 0 && state.tool !== "select" && state.tool !== "arc-fit") {
      redraw();
      const last = state.pendingPoints[state.pendingPoints.length - 1];
      // Circle preview: when 2 points placed, show the live circle through p1, p2, cursor
      if (state.tool === "circle" && state.pendingPoints.length === 2) {
        try {
          const preview = fitCircle(state.pendingPoints[0], state.pendingPoints[1], pt);
          ctx.save();
          ctx.beginPath();
          ctx.arc(preview.cx, preview.cy, preview.r, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(251,146,60,0.6)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        } catch {
          // collinear — no preview
        }
      } else {
        drawLine(last, pt, "rgba(251,146,60,0.5)", 1);
      }
    }
  });
  ```

- [ ] **Step 2: Verify**

  Switch to Circle tool. Click point 1 — rubber-band line appears from pt1 to cursor. Click point 2 — a dashed orange circle preview now follows the cursor, showing the circle that would be created. Click point 3 — circle is confirmed, preview disappears.

---

## Task 3: Clear All Excludes DXF + `deleteAnnotation()` Helper

**Files:**
- Modify: `frontend/app.js` — btn-clear handler (~line 1017), del-btn handler inside `renderSidebar` (~line 349), keydown Delete handler (~line 93)

- [ ] **Step 1: Add `deleteAnnotation(id)` helper**

  Insert after the `addAnnotation` function (after line 278):

  ```js
  function deleteAnnotation(id) {
    const ann = state.annotations.find(a => a.id === id);
    if (!ann) return;
    if (ann.type === "calibration") state.calibration = null;
    if (ann.type === "dxf-overlay") document.getElementById("dxf-panel").style.display = "none";
    state.annotations = state.annotations.filter(a => a.id !== id);
    if (state.selected === id) state.selected = null;
    renderSidebar();
    redraw();
  }
  ```

- [ ] **Step 2: Replace the del-btn handler in renderSidebar to use deleteAnnotation()**

  In `renderSidebar` (around line 349), find:
  ```js
  row.querySelector(".del-btn").addEventListener("click", e => {
    e.stopPropagation();
    state.annotations = state.annotations.filter(a => a.id !== ann.id);
    if (state.selected === ann.id) state.selected = null;
    renderSidebar();
    redraw();
  });
  ```

  Replace with:
  ```js
  row.querySelector(".del-btn").addEventListener("click", e => {
    e.stopPropagation();
    deleteAnnotation(ann.id);
  });
  ```

- [ ] **Step 3: Replace the keyboard Delete handler to use deleteAnnotation()**

  Current keydown Delete handler (lines 93-98):
  ```js
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected !== null) {
    state.annotations = state.annotations.filter(a => a.id !== state.selected);
    state.selected = null;
    renderSidebar();
    redraw();
  }
  ```

  Replace with:
  ```js
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected !== null) {
    deleteAnnotation(state.selected);
  }
  ```

- [ ] **Step 4: Fix btn-clear to preserve DXF annotations**

  Current btn-clear handler (lines 1018-1031):
  ```js
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (confirm("Clear all annotations?")) {
      state.annotations = [];
      state.selected = null;
      document.getElementById("dxf-panel").style.display = "none";
      if (_dxfOriginMode) {
        _dxfOriginMode = false;
        document.getElementById("btn-dxf-set-origin").classList.remove("active");
        statusEl.textContent = state.frozen ? "Frozen" : "Live";
      }
      renderSidebar();
      redraw();
    }
  });
  ```

  Replace with:
  ```js
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (confirm("Clear all annotations?")) {
      state.annotations = state.annotations.filter(a => a.type === "dxf-overlay");
      state.selected = null;
      state.calibration = null; // calibration annotation was filtered out above
      // DXF panel: keep visible (DXF overlay is preserved). Do NOT hide it.
      if (_dxfOriginMode) {
        _dxfOriginMode = false;
        document.getElementById("btn-dxf-set-origin").classList.remove("active");
        statusEl.textContent = state.frozen ? "Frozen" : "Live";
      }
      renderSidebar();
      redraw();
    }
  });
  ```

- [ ] **Step 5: Verify**

  Load a DXF overlay (the DXF panel appears). Set a calibration (e.g. two-point). Add a distance measurement. Click ✕ (Clear All) → confirm. DXF overlay stays on canvas; DXF panel stays visible. Distance annotation is removed from the sidebar. The scale display reverts to "Uncalibrated" (calibration was cleared). Now load DXF again and click the Clear DXF button → DXF disappears and panel hides. Check that deleting a single annotation via the ✕ button in the sidebar works correctly.

---

## Task 4: Bidirectional Selection Highlight (scroll-to)

**Files:**
- Modify: `frontend/app.js` — `handleSelectDown` (~line 724)

- [ ] **Step 1: Scroll sidebar to selected row after canvas click**

  In `handleSelectDown`, find the block where `hitTestAnnotation` succeeds (~line 739-745):
  ```js
  if (hitTestAnnotation(ann, pt)) {
    state.selected = ann.id;
    state.dragState = { annotationId: ann.id, handleKey: "body", startX: pt.x, startY: pt.y };
    renderSidebar();
    redraw();
    return;
  }
  ```

  Replace with:
  ```js
  if (hitTestAnnotation(ann, pt)) {
    state.selected = ann.id;
    state.dragState = { annotationId: ann.id, handleKey: "body", startX: pt.x, startY: pt.y };
    renderSidebar();
    const selRow = listEl.querySelector(".measurement-item.selected");
    if (selRow) selRow.scrollIntoView({ block: "nearest" });
    redraw();
    return;
  }
  ```

- [ ] **Step 2: Verify**

  Add several measurements. Scroll the sidebar down so the first one is out of view. Click it on the canvas — the sidebar scrolls so the highlighted row is visible.

---

## Task 5: Center Distance Tool

**Files:**
- Modify: `frontend/app.js` — `handleToolClick`, `drawAnnotations`, `measurementLabel`, `onMouseDown`
- Modify: `frontend/index.html` — add Cdist button

**Logic:** User activates center-dist, clicks near a circle's edge (snap ≤20px), that circle highlights, then clicks a second circle — annotation `{ type: "center-dist", a: center1, b: center2 }` is created.

- [ ] **Step 1: Add Cdist button to index.html**

  In `frontend/index.html`, the toolbar currently has:
  ```html
  <button class="tool-btn" data-tool="arc-fit">Fit Arc</button>
  <button class="tool-btn" data-tool="detect">Detect</button>
  ```

  Replace with:
  ```html
  <button class="tool-btn" data-tool="arc-fit">Fit Arc</button>
  <button class="tool-btn" data-tool="center-dist" title="Center distance [M]">Cdist</button>
  <button class="tool-btn" data-tool="detect">Detect</button>
  ```

- [ ] **Step 2: Add circle-snap helper function in app.js**

  Insert after `distPointToSegment` (after line 790):

  ```js
  // ── Circle snap ─────────────────────────────────────────────────────────────
  // Returns the circle annotation whose edge is closest to pt, if within 20px.
  // Handles both "circle" (canvas coords) and "detected-circle" (frame coords).
  function snapToCircle(pt) {
    let best = null, bestDist = 20;
    state.annotations.forEach(ann => {
      let cx, cy, r;
      if (ann.type === "circle") {
        cx = ann.cx; cy = ann.cy; r = ann.r;
      } else if (ann.type === "detected-circle") {
        const sx = canvas.width / ann.frameWidth;
        const sy = canvas.height / ann.frameHeight;
        cx = ann.x * sx; cy = ann.y * sy; r = ann.radius * sx;
      } else {
        return;
      }
      const edgeDist = Math.abs(Math.hypot(pt.x - cx, pt.y - cy) - r);
      if (edgeDist < bestDist) { bestDist = edgeDist; best = ann; }
    });
    return best;
  }
  ```

- [ ] **Step 3: Add center-dist handling in handleToolClick**

  In `handleToolClick`, after the `arc-fit` block (after line 204, before the closing `}`):

  ```js
  if (tool === "center-dist") {
    const circle = snapToCircle(pt);
    if (!circle) return; // no circle nearby — ignore click
    if (state.pendingCenterCircle === null) {
      // First pick: highlight this circle
      state.pendingCenterCircle = circle;
      statusEl.textContent = "Click a second circle";
      redraw();
    } else {
      // Second pick: create the annotation
      const a = (() => {
        if (state.pendingCenterCircle.type === "circle") {
          return { x: state.pendingCenterCircle.cx, y: state.pendingCenterCircle.cy };
        }
        const sx = canvas.width / state.pendingCenterCircle.frameWidth;
        const sy = canvas.height / state.pendingCenterCircle.frameHeight;
        return { x: state.pendingCenterCircle.x * sx, y: state.pendingCenterCircle.y * sy };
      })();
      const b = (() => {
        if (circle.type === "circle") {
          return { x: circle.cx, y: circle.cy };
        }
        const sx = canvas.width / circle.frameWidth;
        const sy = canvas.height / circle.frameHeight;
        return { x: circle.x * sx, y: circle.y * sy };
      })();
      state.pendingCenterCircle = null;
      addAnnotation({ type: "center-dist", a, b });
      setTool("select");
    }
    return;
  }
  ```

- [ ] **Step 4: Highlight pendingCenterCircle in drawAnnotations**

  In `drawAnnotations` (line 492), add rendering for `center-dist` and highlighted pending circle.

  Replace:
  ```js
  function drawAnnotations() {
    state.annotations.forEach(ann => {
      const sel = ann.id === state.selected;
      if (ann.type === "distance")        drawDistance(ann, sel);
      else if (ann.type === "angle")      drawAngle(ann, sel);
      else if (ann.type === "circle")     drawCircle(ann, sel);
      else if (ann.type === "edges-overlay")    drawEdgesOverlay(ann);
      else if (ann.type === "preprocessed-overlay") drawPreprocessedOverlay(ann);
      else if (ann.type === "dxf-overlay")      drawDxfOverlay(ann);
      else if (ann.type === "detected-circle") drawDetectedCircle(ann, sel);
      else if (ann.type === "detected-line")   drawDetectedLine(ann, sel);
    });
  }
  ```

  With:
  ```js
  function drawAnnotations() {
    state.annotations.forEach(ann => {
      const sel = ann.id === state.selected;
      const pendingHighlight = state.pendingCenterCircle && ann.id === state.pendingCenterCircle.id;
      if (ann.type === "distance")        drawDistance(ann, sel);
      else if (ann.type === "center-dist") drawDistance(ann, sel);
      else if (ann.type === "angle")      drawAngle(ann, sel);
      else if (ann.type === "circle")     drawCircle(ann, pendingHighlight || sel);
      else if (ann.type === "edges-overlay")    drawEdgesOverlay(ann);
      else if (ann.type === "preprocessed-overlay") drawPreprocessedOverlay(ann);
      else if (ann.type === "dxf-overlay")      drawDxfOverlay(ann);
      else if (ann.type === "detected-circle") drawDetectedCircle(ann, pendingHighlight || sel);
      else if (ann.type === "detected-line")   drawDetectedLine(ann, sel);
    });
  }
  ```

- [ ] **Step 5: Add "center-dist" to measurementLabel**

  In `measurementLabel` (line 280), after the `"distance"` branch and before the `"angle"` branch, add:

  ```js
  if (ann.type === "center-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  ```

- [ ] **Step 6: Reset pendingCenterCircle on Escape (in keydown handler)**

  In the existing Escape handler (around line 99):
  ```js
  if (e.key === "Escape") {
    state.pendingPoints = [];
    if (_dxfOriginMode) {
      ...
    }
    redraw();
  }
  ```

  Add `state.pendingCenterCircle = null;` after `state.pendingPoints = [];`:
  ```js
  if (e.key === "Escape") {
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    if (_dxfOriginMode) {
      ...
    }
    redraw();
  }
  ```

- [ ] **Step 7: Verify**

  Detect or draw two circles on the canvas. Switch to Cdist. Click near the edge of circle 1 — it highlights blue, status shows "Click a second circle". Click near circle 2 — a yellow line appears between the two centers with a distance label. The tool returns to Select. The measurement appears in the sidebar. Escape while first circle is selected — highlight clears, status resets.

---

## Task 6: Keyboard Shortcuts + Tooltip Updates

**Files:**
- Modify: `frontend/app.js` — keydown handler (~line 92)
- Modify: `frontend/index.html` — title attributes on all tool buttons

**Shortcuts map:**

| Key | Tool/Action |
|-----|-------------|
| V | select |
| C | calibrate |
| D | distance |
| A | angle |
| O | circle |
| F | arc-fit |
| M | center-dist |
| E | detect |
| Escape | setTool("select"), cancel pending, cancel center-dist pick |
| Delete/Backspace | delete selected annotation |
| ? | open help dialog (not blocked by input focus guard) |

- [ ] **Step 1: Expand the keydown handler**

  Replace the entire keydown handler (lines 92-108):
  ```js
  document.addEventListener("keydown", e => {
    // Help dialog shortcut — works even when an input is focused
    if (e.key === "?") {
      document.getElementById("help-dialog").showModal();
      return;
    }
    // All other shortcuts are blocked when an input/select/textarea/dialog is focused
    if (document.activeElement.closest("input, select, textarea, dialog") !== null) return;

    if ((e.key === "Delete" || e.key === "Backspace") && state.selected !== null) {
      deleteAnnotation(state.selected);
      return;
    }
    if (e.key === "Escape") {
      state.pendingPoints = [];
      state.pendingCenterCircle = null;
      if (_dxfOriginMode) {
        _dxfOriginMode = false;
        document.getElementById("btn-dxf-set-origin").classList.remove("active");
        statusEl.textContent = state.frozen ? "Frozen" : "Live";
      }
      setTool("select");
      canvas.style.cursor = "default";
      return;
    }
    const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                       o: "circle", f: "arc-fit", m: "center-dist", e: "detect" };
    const toolName = toolKeys[e.key.toLowerCase()];
    if (toolName) {
      setTool(toolName);
      canvas.style.cursor = toolName === "select" ? "default" : "crosshair";
    }
  });
  ```

  Note: `?` is the only shortcut that fires when focus is inside an input/dialog. All others (including `Delete`, `Backspace`, `Escape`, and tool keys) are blocked by the input-focus guard. The `_dxfOriginMode` cancel is preserved inside Escape. `setTool("select")` already calls `redraw()` so no explicit `redraw()` call is needed at the end of Escape.

- [ ] **Step 2: Update tooltip title attributes in index.html**

  Update the tool button `title` attributes. Current toolbar section:
  ```html
  <button class="tool-btn active" data-tool="select">Select</button>
  <button class="tool-btn" data-tool="calibrate">Calibrate</button>
  <button class="tool-btn" data-tool="distance">Distance</button>
  <button class="tool-btn" data-tool="angle">Angle</button>
  <button class="tool-btn" data-tool="circle">Circle</button>
  <button class="tool-btn" data-tool="arc-fit">Fit Arc</button>
  <button class="tool-btn" data-tool="center-dist" title="Center distance [M]">Cdist</button>
  <button class="tool-btn" data-tool="detect">Detect</button>
  ```

  Replace with:
  ```html
  <button class="tool-btn active" data-tool="select" title="Select [V]">Select</button>
  <button class="tool-btn" data-tool="calibrate" title="Calibrate [C]">Calibrate</button>
  <button class="tool-btn" data-tool="distance" title="Distance [D]">Distance</button>
  <button class="tool-btn" data-tool="angle" title="Angle [A]">Angle</button>
  <button class="tool-btn" data-tool="circle" title="Circle [O]">Circle</button>
  <button class="tool-btn" data-tool="arc-fit" title="Fit Arc [F]">Fit Arc</button>
  <button class="tool-btn" data-tool="center-dist" title="Center distance [M]">Cdist</button>
  <button class="tool-btn" data-tool="detect" title="Detect [E]">Detect</button>
  ```

- [ ] **Step 3: Verify**

  Press D — Distance button activates, status shows "Distance — click point 1". Click a point. Press Escape — returns to Select, pending dot disappears. Press Delete while a measurement is selected — measurement is removed. Press V — Select button activates. Hover any tool button — tooltip shows the shortcut key. Click in the label input field, then press D — should NOT switch tool.

---

## Task 7: Help Dialog

**Files:**
- Modify: `frontend/index.html` — add `<button id="btn-help">` and `<dialog id="help-dialog">`
- Modify: `frontend/style.css` — help dialog styles
- Modify: `frontend/app.js` — wire up btn-help and close button

- [ ] **Step 1: Add Help button to the toolbar in index.html**

  In the toolbar, just before the settings button:
  ```html
  <div class="toolbar-sep"></div>
  <button class="tool-btn icon" id="btn-settings" title="Settings">⚙</button>
  ```

  Replace with:
  ```html
  <div class="toolbar-sep"></div>
  <button class="tool-btn icon" id="btn-help" title="Help [?]">?</button>
  <button class="tool-btn icon" id="btn-settings" title="Settings">⚙</button>
  ```

- [ ] **Step 2: Add help dialog HTML in index.html**

  After the `</dialog>` that closes `#settings-dialog` (line 198), add:

  ```html
  <dialog id="help-dialog">
    <div id="help-header">
      <span id="help-title">Help</span>
      <button id="help-close">✕</button>
    </div>
    <div id="help-body">
      <div class="help-section-label">Tools</div>
      <table class="help-table">
        <thead><tr><th>Tool</th><th>Key</th><th>How to use</th></tr></thead>
        <tbody>
          <tr><td>Select</td><td>V</td><td>Click annotation to select; drag to move</td></tr>
          <tr><td>Calibrate</td><td>C</td><td>Click two points of known distance and enter value; or click a circle of known diameter</td></tr>
          <tr><td>Distance</td><td>D</td><td>Click two points</td></tr>
          <tr><td>Angle</td><td>A</td><td>Click three points (middle point is the vertex)</td></tr>
          <tr><td>Circle</td><td>O</td><td>Click three points on the circumference</td></tr>
          <tr><td>Fit Arc</td><td>F</td><td>Click ≥3 points on an arc or circle edge, double-click to confirm</td></tr>
          <tr><td>Center Dist</td><td>M</td><td>Click two circles to measure center-to-center distance</td></tr>
          <tr><td>Detect</td><td>E</td><td>Opens detection panel</td></tr>
        </tbody>
      </table>
      <div class="help-section-label" style="margin-top:12px">Keyboard Shortcuts</div>
      <table class="help-table">
        <thead><tr><th>Key</th><th>Action</th></tr></thead>
        <tbody>
          <tr><td>V</td><td>Select tool</td></tr>
          <tr><td>C</td><td>Calibrate tool</td></tr>
          <tr><td>D</td><td>Distance tool</td></tr>
          <tr><td>A</td><td>Angle tool</td></tr>
          <tr><td>O</td><td>Circle tool</td></tr>
          <tr><td>F</td><td>Fit Arc tool</td></tr>
          <tr><td>M</td><td>Center Dist tool</td></tr>
          <tr><td>E</td><td>Detect tool</td></tr>
          <tr><td>Escape</td><td>Back to Select / cancel</td></tr>
          <tr><td>Delete / Backspace</td><td>Delete selected annotation</td></tr>
          <tr><td>?</td><td>This help dialog</td></tr>
        </tbody>
      </table>
    </div>
  </dialog>
  ```

- [ ] **Step 3: Add help dialog styles to style.css**

  Append to `style.css`:

  ```css
  /* ── Help dialog ── */
  #help-dialog {
    width: 520px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }

  #help-dialog::backdrop {
    background: rgba(0,0,0,0.4);
  }

  #help-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  #help-title {
    font-weight: bold;
    font-size: 13px;
  }

  #help-close {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 4px;
  }

  #help-close:hover { background: var(--border); color: var(--text); }

  #help-body {
    padding: 12px;
    overflow-y: auto;
    max-height: 70vh;
  }

  .help-section-label {
    font-size: 11px;
    font-weight: bold;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .help-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .help-table th {
    text-align: left;
    color: var(--muted);
    font-weight: normal;
    padding: 3px 8px 6px 0;
    border-bottom: 1px solid var(--border);
  }

  .help-table td {
    padding: 4px 8px 4px 0;
    vertical-align: top;
    border-bottom: 1px solid rgba(51,65,85,0.5);
  }

  .help-table td:first-child {
    color: var(--accent);
    white-space: nowrap;
    width: 90px;
  }
  ```

- [ ] **Step 4: Wire up the help dialog in app.js**

  Find the settings dialog wiring in `app.js` (somewhere around line 667+ — the `loadCameraInfo()` / `loadSnapshotList()` area). After the settings dialog close button handler, add:

  ```js
  // ── Help dialog ─────────────────────────────────────────────────────────────
  document.getElementById("btn-help").addEventListener("click", () => {
    document.getElementById("help-dialog").showModal();
  });
  document.getElementById("help-close").addEventListener("click", () => {
    document.getElementById("help-dialog").close();
  });
  ```

  (The `?` keyboard shortcut that calls `showModal()` was already added in Task 6.)

- [ ] **Step 5: Verify**

  Click the `?` toolbar button — help dialog opens with a tools table and shortcuts table, styled to match the settings dialog. Press Escape — dialog closes. Press `?` key — dialog opens again. Press the ✕ button — closes. Open a label input, then press `?` — dialog still opens (? is not blocked by the input focus guard).

---

## Task 8: Calibration as Annotation

> **Depends on:** Task 5 must be completed first — Task 8 calls `snapToCircle()`, which is defined in Task 5.

**Files:**
- Modify: `frontend/app.js` — calibration flow in `handleToolClick`, `measurementLabel`, `drawAnnotations`, `renderSidebar` skip list
- Add helper: `applyCalibration(ann)` in `app.js`

This is the largest task. Read through it fully before starting.

- [ ] **Step 1: Simplify state.calibration fields**

  In the `state` object (line 9), the calibration comment currently says:
  ```js
  calibration: null,   // { pixelsPerMm, displayUnit, pointA, pointB, knownDistance }
  ```

  Update the comment to:
  ```js
  calibration: null,   // { pixelsPerMm, displayUnit }
  ```

  (No other code reads `pointA`, `pointB`, or `knownDistance` — they were only set, never consumed.)

- [ ] **Step 2: Add `applyCalibration(ann)` helper**

  Insert after `deleteAnnotation` (after its closing `}`):

  ```js
  function applyCalibration(ann) {
    // Remove any existing calibration annotation
    state.annotations = state.annotations.filter(a => a.type !== "calibration");
    // Compute pixelsPerMm
    let pixelDist;
    if (ann.x1 !== undefined) {
      pixelDist = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
    } else {
      pixelDist = ann.r * 2; // diameter
    }
    const knownMm = ann.unit === "µm" ? ann.knownValue / 1000 : ann.knownValue;
    state.calibration = { pixelsPerMm: pixelDist / knownMm, displayUnit: ann.unit };
    addAnnotation(ann);
    updateCameraInfo(); // refresh the scale display in the sidebar
  }
  ```

- [ ] **Step 3: Replace the calibrate tool handler in handleToolClick**

  The existing calibrate block (lines 130-153):
  ```js
  if (tool === "calibrate") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 2) {
      const [a, b] = state.pendingPoints;
      const dist = prompt("Distance between these two points (e.g. '1.000 mm' or '500 µm'):");
      if (dist) {
        const parsed = parseDistanceInput(dist);
        if (parsed) {
          const pxDist = Math.hypot(b.x - a.x, b.y - a.y);
          state.calibration = {
            pixelsPerMm: pxDist / parsed.mm,
            displayUnit: parsed.unit,
            pointA: a,
            pointB: b,
            knownDistance: parsed.value,
          };
          updateCameraInfo();
        }
      }
      state.pendingPoints = [];
    }
    redraw();
    return;
  }
  ```

  Replace with:
  ```js
  if (tool === "calibrate") {
    // First click: check if user clicked near a circle's edge (circle calibration)
    if (state.pendingPoints.length === 0) {
      const circle = snapToCircle(pt);
      if (circle) {
        // Circle calibration flow
        state.pendingCenterCircle = circle; // highlight it
        redraw();
        const dist = prompt("Enter known diameter (e.g. '5.000 mm' or '200 µm'):");
        state.pendingCenterCircle = null;
        if (dist) {
          const parsed = parseDistanceInput(dist);
          if (parsed) {
            let cx, cy, r;
            if (circle.type === "circle") {
              cx = circle.cx; cy = circle.cy; r = circle.r;
            } else {
              const sx = canvas.width / circle.frameWidth;
              const sy = canvas.height / circle.frameHeight;
              cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
            }
            applyCalibration({ type: "calibration", cx, cy, r, knownValue: parsed.value, unit: parsed.unit });
            setTool("select");
            canvas.style.cursor = "default";
          }
        }
        redraw();
        return;
      }
    }
    // Two-point calibration flow
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 2) {
      const [p1, p2] = state.pendingPoints;
      const dist = prompt("Distance between these two points (e.g. '1.000 mm' or '500 µm'):");
      state.pendingPoints = [];
      if (dist) {
        const parsed = parseDistanceInput(dist);
        if (parsed) {
          applyCalibration({ type: "calibration", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
                             knownValue: parsed.value, unit: parsed.unit });
          setTool("select");
          canvas.style.cursor = "default";
        }
      }
    }
    redraw();
    return;
  }
  ```

  Note: `snapToCircle()` was added in Task 5. If Task 5 hasn't been done yet, do Task 5 first.

- [ ] **Step 4: Add calibration rendering functions in app.js**

  Add two draw functions after `drawDetectedLine`:

  ```js
  function drawCalibration(ann, sel) {
    const color = sel ? "#60a5fa" : "#a78bfa";
    const tickLen = 6;
    if (ann.x1 !== undefined) {
      // Two-point: line with tick marks at each end
      drawLine({ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }, color, sel ? 2 : 1.5);
      // Tick marks perpendicular to the line
      const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1) + Math.PI / 2;
      const tx = Math.cos(angle) * tickLen, ty = Math.sin(angle) * tickLen;
      drawLine({ x: ann.x1 - tx, y: ann.y1 - ty }, { x: ann.x1 + tx, y: ann.y1 + ty }, color, sel ? 2 : 1.5);
      drawLine({ x: ann.x2 - tx, y: ann.y2 - ty }, { x: ann.x2 + tx, y: ann.y2 + ty }, color, sel ? 2 : 1.5);
      if (sel) { drawHandle({ x: ann.x1, y: ann.y1 }, "#60a5fa"); drawHandle({ x: ann.x2, y: ann.y2 }, "#60a5fa"); }
      const mx = (ann.x1 + ann.x2) / 2, my = (ann.y1 + ann.y2) / 2;
      drawLabel(measurementLabel(ann), mx + 4, my - 8);
    } else {
      // Circle: horizontal diameter line through center
      const x1 = ann.cx - ann.r, x2 = ann.cx + ann.r;
      drawLine({ x: x1, y: ann.cy }, { x: x2, y: ann.cy }, color, sel ? 2 : 1.5);
      // Tick marks at each end
      drawLine({ x: x1, y: ann.cy - tickLen }, { x: x1, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
      drawLine({ x: x2, y: ann.cy - tickLen }, { x: x2, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
      if (sel) { drawHandle({ x: x1, y: ann.cy }, "#60a5fa"); drawHandle({ x: x2, y: ann.cy }, "#60a5fa"); }
      drawLabel(measurementLabel(ann), ann.cx + 4, ann.cy - ann.r - 8);
    }
  }
  ```

- [ ] **Step 5: Add calibration to drawAnnotations dispatch**

  In `drawAnnotations`, add the calibration branch:
  ```js
  else if (ann.type === "calibration") drawCalibration(ann, sel);
  ```

  Place it after the `center-dist` branch (or after `circle` — order does not matter).

- [ ] **Step 6: Add calibration to measurementLabel**

  In `measurementLabel`, before the final `return "";`, add:

  ```js
  if (ann.type === "calibration") {
    const prefix = ann.x1 !== undefined ? "⟷" : "⌀";
    return `${prefix} ${ann.knownValue} ${ann.unit}`;
  }
  ```

- [ ] **Step 7: Confirm calibration is NOT in the renderSidebar skip list**

  Check line 331 in `renderSidebar`:
  ```js
  if (ann.type === "edges-overlay" || ann.type === "preprocessed-overlay" || ann.type === "dxf-overlay") return;
  ```

  This is correct — `"calibration"` is not in the skip list, so calibration annotations appear in the sidebar. No change needed.

- [ ] **Step 8: Run backend tests to confirm no regressions**

  ```
  .venv/bin/pytest tests/ -q
  ```

  Expected: all existing tests pass (the frontend changes don't touch any backend code).

- [ ] **Step 9: Full browser verification**

  **Two-point calibration:**
  - Switch to Calibrate. Click two points on a ruler in the image. Enter "1 mm". A purple scale-bar annotation appears in the sidebar labeled "⟷ 1 mm". All existing measurements update to show mm values. Delete the calibration annotation — measurements revert to pixels. Calibration is gone from the sidebar.

  **Circle calibration:**
  - With a detected or drawn circle visible, switch to Calibrate. Click near the circle's edge. The circle highlights. Enter the known diameter. A purple circle-diameter annotation appears labeled "⌀ X mm". Measurements update.

  **Uniqueness:** Calibrate again with a different value — the old calibration annotation is replaced by the new one (only one in the sidebar at a time).

  **Clear All:** After calibrating, click ✕ Clear All. Measurements and calibration annotation are cleared. Scale display reverts to "Uncalibrated".

---

## Final Verification

After all 8 tasks are complete:

- [ ] Run backend tests: `.venv/bin/pytest tests/ -q` — all pass
- [ ] Manual smoke test: Open the app. Use every tool (Select, Calibrate, Distance, Angle, Circle, Fit Arc, Cdist, Detect). Verify keyboard shortcuts work for each. Open help dialog with `?`. Verify all tooltips show shortcut keys. Load a DXF, click Clear All — DXF stays. Delete an annotation with the sidebar button. Delete with keyboard. Calibrate by circle and by two-point. Verify measurements update and calibration appears in sidebar.
