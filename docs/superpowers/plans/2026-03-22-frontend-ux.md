# Frontend UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add undo/redo, snap-to-annotation, copy-to-clipboard, and richer CSV export to the measurement app.

**Architecture:** All changes in `frontend/app.js` and `frontend/style.css`. Four independent features; each can be implemented and tested in isolation.

**Tech Stack:** Vanilla JS, HTML5 Canvas, Clipboard API

---

## Task 1 — Undo / Redo

### Current code to read first

- `state` initializer (lines 2–20): the single `const state = { ... }` object.
- `addAnnotation` (line 481–486).
- `deleteAnnotation` (line 488–503).
- `onMouseDown` (line 90–111): the `_originMode` block at lines 92–100.
- `applyCalibration` (line 505–519): the `state.annotations.filter(...)` call at line 507.
- `onMouseUp` (line 113–115): currently just `state.dragState = null`.
- `keydown` listener (line 118–154).

### Steps

- [ ] **1.1 — Add globals** after the `state` initializer (after line 20):

  ```js
  const undoStack = [];
  const redoStack = [];
  const UNDO_LIMIT = 50;
  ```

- [ ] **1.2 — Add `takeSnapshot()`** after the globals from 1.1:

  ```js
  function takeSnapshot() {
    return JSON.stringify({
      annotations: state.annotations,
      calibration: state.calibration,
      origin: state.origin,
    });
  }
  ```

- [ ] **1.3 — Add `undo()` and `redo()`** after `takeSnapshot()`:

  ```js
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(takeSnapshot());
    const snap = JSON.parse(undoStack.pop());
    state.annotations = snap.annotations;
    state.calibration = snap.calibration;
    state.origin = snap.origin;
    state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null;
    renderSidebar(); redraw();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(takeSnapshot());
    const snap = JSON.parse(redoStack.pop());
    state.annotations = snap.annotations;
    state.calibration = snap.calibration;
    state.origin = snap.origin;
    state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null;
    renderSidebar(); redraw();
  }
  ```

- [ ] **1.4 — Add a `pushUndo()` helper** to DRY out the cap-and-clear pattern. Place immediately after `redo()`:

  ```js
  function pushUndo() {
    if (undoStack.length >= UNDO_LIMIT) undoStack.shift();
    undoStack.push(takeSnapshot());
    redoStack.length = 0;
  }
  ```

- [ ] **1.5 — Snapshot before `addAnnotation`** (line 481). Change:

  ```js
  function addAnnotation(data) {
    const ann = { ...data, id: state.nextId++, name: data.name ?? "" };
  ```

  to:

  ```js
  function addAnnotation(data) {
    pushUndo();
    const ann = { ...data, id: state.nextId++, name: data.name ?? "" };
  ```

- [ ] **1.6 — Snapshot before `deleteAnnotation`** (line 488). Change:

  ```js
  function deleteAnnotation(id) {
    const ann = state.annotations.find(a => a.id === id);
  ```

  to:

  ```js
  function deleteAnnotation(id) {
    pushUndo();
    const ann = state.annotations.find(a => a.id === id);
  ```

- [ ] **1.7 — Snapshot in `_originMode` block** (line 92–99 in `onMouseDown`). Change:

  ```js
  if (_originMode) {
    // Remove any existing origin annotation
    state.annotations = state.annotations.filter(a => a.type !== "origin");
  ```

  to:

  ```js
  if (_originMode) {
    pushUndo();
    // Remove any existing origin annotation
    state.annotations = state.annotations.filter(a => a.type !== "origin");
  ```

- [ ] **1.8 — Snapshot in `applyCalibration`** (line 505–507). Change:

  ```js
  function applyCalibration(ann) {
    // Remove any existing calibration annotation
    state.annotations = state.annotations.filter(a => a.type !== "calibration");
  ```

  to:

  ```js
  function applyCalibration(ann) {
    pushUndo();
    // Remove any existing calibration annotation
    state.annotations = state.annotations.filter(a => a.type !== "calibration");
  ```

- [ ] **1.9 — Snapshot on drag-end in `onMouseUp`** (line 113–115). Change:

  ```js
  function onMouseUp() {
    state.dragState = null;
  }
  ```

  to:

  ```js
  function onMouseUp() {
    if (state.dragState !== null) pushUndo();
    state.dragState = null;
  }
  ```

- [ ] **1.10 — Add keyboard shortcuts** to the existing `keydown` listener (line 118). Insert after the `Escape` block and before the `toolKeys` block:

  ```js
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (ctrlOrMeta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (ctrlOrMeta && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
  ```

  Insert these lines immediately before `const toolKeys = { ... }` at line 147. The guard at line 126 (`document.activeElement.closest("input, select, textarea, dialog") !== null`) already prevents shortcuts from firing while a label input is focused — no extra handling needed.

### Manual verification

1. Add two or three distance annotations. Press `Ctrl+Z` — last annotation disappears; press again — second disappears.
2. Press `Ctrl+Y` (or `Ctrl+Shift+Z`) to redo; annotations reappear one at a time.
3. Apply a calibration, then add an annotation, then undo past the calibration — confirm `measurementLabel` reverts to "px" output and the calibration row disappears from the sidebar.
4. Drag an annotation handle, release, then `Ctrl+Z` — annotation snaps back to pre-drag position.
5. Place an origin, undo — origin marker disappears and coordinate readout stops updating.
6. Click in a name input field and press `Ctrl+Z` — browser text undo fires, not the app undo.

---

## Task 2 — Snap-to-Annotation

### Current code to read first

- `state` initializer (lines 2–20).
- `setTool` (lines 37–47).
- `handleToolClick` (line 206 onward) — specifically the tool dispatch for `distance`, `angle`, `circle`, `arc-fit`, `area`, `perp-dist`, `para-dist`.
- `mousemove` handler (line 1101–1169) — specifically the rubber-band sections.
- `redraw` (lines 764–809) — the end of `drawAnnotations()` at line 809 is the insertion point for the snap indicator.

### Steps

- [ ] **2.1 — Add `snapTarget: null` to `state`** (line 13 area, after `dragState`):

  ```js
  dragState: null,     // { annotationId, handleKey, startX, startY }
  snapTarget: null,    // { x, y } canvas-coord of current snap target, or null
  ```

- [ ] **2.2 — Clear `snapTarget` in `setTool()`** (line 37). Add `state.snapTarget = null;` after the existing resets:

  ```js
  function setTool(name) {
    state.tool = name;
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    state.pendingRefLine = null;
    state.snapTarget = null;
    // ... rest unchanged
  ```

- [ ] **2.3 — Add `snapPoint(rawPt)` function.** Place immediately before `handleToolClick` (line 206):

  ```js
  // ── Snap-to-annotation ──────────────────────────────────────────────────
  const SNAP_RADIUS = 8;

  function snapPoint(rawPt) {
    if (state.tool === "select") return { pt: rawPt, snapped: false };
    const targets = [];
    state.annotations.forEach(ann => {
      if (["edges-overlay", "preprocessed-overlay", "dxf-overlay", "detected-line", "center-dist"].includes(ann.type)) return;
      if (["distance", "perp-dist", "para-dist", "parallelism"].includes(ann.type)) {
        targets.push(ann.a, ann.b);
      } else if (ann.type === "calibration") {
        if (ann.x1 !== undefined) {
          targets.push({ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 });
        }
      } else if (["circle", "arc-fit", "detected-circle"].includes(ann.type)) {
        targets.push({ x: ann.cx, y: ann.cy });
      } else if (ann.type === "origin") {
        targets.push({ x: ann.x, y: ann.y });
      } else if (ann.type === "area") {
        (ann.points || []).forEach(p => targets.push(p));
      }
    });
    for (const t of targets) {
      if (Math.hypot(t.x - rawPt.x, t.y - rawPt.y) <= SNAP_RADIUS) {
        return { pt: { x: t.x, y: t.y }, snapped: true };
      }
    }
    return { pt: rawPt, snapped: false };
  }
  ```

  Note: `arc-fit` annotations are stored with type `"circle"` after `fitCircleAlgebraic` resolves (see `dblclick` handler line 172). The snap targets cover the confirmed circle center correctly.

- [ ] **2.4 — Call `snapPoint` in `handleToolClick`** for qualifying tools. The qualifying tools are: `distance`, `angle`, `circle`, `perp-dist`, `para-dist`, `arc-fit`, `area`. Find the top of `handleToolClick` (line 206):

  ```js
  function handleToolClick(pt) {
    const tool = state.tool;
  ```

  Change to:

  ```js
  function handleToolClick(rawPt) {
    const { pt } = (state.tool !== "calibrate" && state.tool !== "center-dist")
      ? snapPoint(rawPt)
      : { pt: rawPt };
    const tool = state.tool;
  ```

- [ ] **2.5 — Update `snapTarget` in the `mousemove` handler** (line 1101). Add snap target tracking to all rubber-band branches. The three rubber-band sections are:

  **Branch A** — general rubber-band (line 1104–1129, tools other than arc-fit/perp-dist/para-dist/area):

  Inside the `if (state.pendingPoints.length > 0 && state.tool !== "select" ...)` block, before `redraw()`:

  ```js
  const { pt: snappedPt, snapped } = snapPoint(pt);
  state.snapTarget = snapped ? snappedPt : null;
  redraw();
  const last = state.pendingPoints[state.pendingPoints.length - 1];
  if (state.tool === "circle" && state.pendingPoints.length === 2) {
    // ... circle preview — replace `pt` argument with `snappedPt` in fitCircle call
    const preview = fitCircle(state.pendingPoints[0], state.pendingPoints[1], snappedPt);
    // ...
  } else {
    drawLine(last, snappedPt, "rgba(251,146,60,0.5)", 1);
  }
  ```

  **Branch B** — perp-dist/para-dist rubber-band (line 1132–1138):

  ```js
  if ((state.tool === "perp-dist" || state.tool === "para-dist")
      && state.pendingPoints.length === 1 && state.pendingRefLine) {
    const { pt: snappedPt, snapped } = snapPoint(pt);
    state.snapTarget = snapped ? snappedPt : null;
    redraw();
    const b = projectConstrained(snappedPt, state.pendingPoints[0], state.pendingRefLine,
                                 state.tool === "perp-dist");
    drawLine(state.pendingPoints[0], b, "rgba(251,146,60,0.5)", 1);
  }
  ```

  **Branch C** — area polygon preview (line 1141–1144):

  ```js
  if (state.tool === "area" && state.pendingPoints.length >= 1) {
    const { pt: snappedPt, snapped } = snapPoint(pt);
    state.snapTarget = snapped ? snappedPt : null;
    redraw();
    drawAreaPreview(state.pendingPoints, snappedPt);
  }
  ```

  When none of the rubber-band branches match and the tool is not "select", clear `snapTarget`:

  ```js
  if (state.tool === "select" || state.pendingPoints.length === 0) {
    state.snapTarget = null;
  }
  ```

  Add this at the very end of the `mousemove` handler body, just before the closing `}`  of the listener (before the coordinate readout HUD block is fine; or at the absolute end of the listener).

- [ ] **2.6 — Draw snap indicator in `redraw()`**. After the `drawAnnotations()` call (line 769) — specifically after the `drawAnnotations()` call but before `drawPendingPoints()`, OR after both, is acceptable. The clearest position is immediately after `drawAnnotations()`:

  ```js
  // Snap indicator
  if (state.snapTarget && state.tool !== "select") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(state.snapTarget.x, state.snapTarget.y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
  ```

### Manual verification

1. Place a `distance` annotation. Switch to `distance` tool again; hover over one of the endpoints — a blue open circle (radius 6) appears. Click — the new annotation's first point snaps exactly to the existing endpoint.
2. Verify snap does not activate in `select` mode (no ring appears while hovering).
3. Verify `calibrate` and `center-dist` tools are unaffected by snap (no snap ring, no coordinate shift).
4. With `area` tool, hover near a previously placed distance annotation endpoint — ring appears; click to confirm the snap works.

---

## Task 3 — Copy Measurement to Clipboard

### Current code to read first

- `renderSidebar` (lines 606–659) — specifically the non-origin row click handler at lines 652–656:

  ```js
  row.addEventListener("click", () => {
    state.selected = ann.id;
    renderSidebar();
    redraw();
  });
  ```

- `measurementLabel` (lines 521–603) — returns `""` for `origin` and unknown types.
- `frontend/style.css` — `.measurement-item` and related rules (lines 110–158).

### Steps

- [ ] **3.1 — Modify the row click handler** in `renderSidebar` (lines 652–656). Replace:

  ```js
  row.addEventListener("click", () => {
    state.selected = ann.id;
    renderSidebar();
    redraw();
  });
  ```

  with:

  ```js
  row.addEventListener("click", () => {
    const wasSelected = state.selected === ann.id;
    state.selected = ann.id;
    renderSidebar();
    redraw();
    if (wasSelected) {
      const label = measurementLabel(ann);
      if (!label) return; // origin or unknown — nothing to copy
      const text = ann.name ? `${ann.name}: ${label}` : label;
      navigator.clipboard.writeText(text).then(() => {
        // Flash the newly re-rendered row
        const flashRow = listEl.querySelector(`.measurement-item[data-id="${ann.id}"]`);
        if (flashRow) {
          flashRow.classList.add("copied");
          setTimeout(() => flashRow.classList.remove("copied"), 600);
        }
      }).catch(() => { /* clipboard unavailable — silent no-op */ });
    }
  });
  ```

  Note: for the flash selector to work, add `data-id="${ann.id}"` to the row element. Find the line:

  ```js
  row.className = "measurement-item" + (ann.id === state.selected ? " selected" : "");
  row.innerHTML = `
  ```

  and add the data attribute to the `row` element after setting `className`:

  ```js
  row.className = "measurement-item" + (ann.id === state.selected ? " selected" : "");
  row.dataset.id = ann.id;
  row.innerHTML = `
  ```

- [ ] **3.2 — Add `.copied` flash CSS** to `frontend/style.css`. Append after the `.measurement-item .del-btn:hover` rule (line 158):

  ```css
  @keyframes copied-flash {
    0%   { background: rgba(34, 197, 94, 0.25); }
    100% { background: transparent; }
  }

  .measurement-item.copied {
    animation: copied-flash 0.6s ease-out forwards;
  }
  ```

### Manual verification

1. Add a distance annotation, name it "bore". Click its row to select it (no copy). Click it again — a brief green flash appears and the clipboard now contains `"bore: 3.142 mm"` (value will differ).
2. Add an annotation with no name. Double-click to copy — clipboard contains just the measurement label, e.g. `"3.142 mm"`.
3. Place an origin. Click its row twice — no flash, no clipboard write.
4. Click the delete button `✕` on a selected row — no flash, annotation is deleted (delete button has `stopPropagation`).
5. Click into the name input of a selected row — no flash (input click has `stopPropagation`).

---

## Task 4 — Richer CSV Export

### Current code to read first

- CSV export listener (lines 1673–1693):

  ```js
  document.getElementById("btn-export-csv").addEventListener("click", () => {
    const cal = state.calibration;
    const rows = [["#", "name", "type", "value"]];
    let i = 1;
    state.annotations.forEach(ann => {
      const val = measurementLabel(ann);
      if (!val) return;  // skip non-measurement overlays
      rows.push([i++, ann.name || "", ann.type, val]);
    });
    const csv = rows
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    // ... blob / download unchanged
  });
  ```

- `measurementLabel` (lines 521–603) — reference for precision rules and calibration logic.

### Steps

- [ ] **4.1 — Add `formatCsvValue(ann)` function** immediately before the CSV export listener (before line 1673):

  ```js
  // ── CSV value helper ────────────────────────────────────────────────────────
  function formatCsvValue(ann) {
    const cal = state.calibration;

    function distResult(px) {
      if (!cal) return { value: px.toFixed(1), unit: "px" };
      const mm = px / cal.pixelsPerMm;
      if (cal.displayUnit === "µm") return { value: (mm * 1000).toFixed(1), unit: "µm" };
      return { value: mm.toFixed(3), unit: "mm" };
    }

    function areaResult(px2) {
      if (!cal) return { value: px2.toFixed(1), unit: "px²" };
      const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
      if (cal.displayUnit === "µm") return { value: (mm2 * 1e6).toFixed(1), unit: "µm²" };
      return { value: mm2.toFixed(4), unit: "mm²" };
    }

    if (ann.type === "distance" || ann.type === "perp-dist" || ann.type === "para-dist") {
      return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
    }
    if (ann.type === "center-dist") {
      return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
    }
    if (ann.type === "angle") {
      const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
      const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
      const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
      return { value: deg.toFixed(2), unit: "°" };
    }
    if (ann.type === "circle") {
      return distResult(ann.r * 2);
    }
    if (ann.type === "arc-fit") {
      return distResult(ann.r * 2);
    }
    if (ann.type === "detected-circle") {
      const sx = canvas.width / ann.frameWidth;
      return distResult((ann.radius * sx) * 2);
    }
    if (ann.type === "area") {
      return areaResult(polygonArea(ann.points));
    }
    if (ann.type === "parallelism") {
      return { value: ann.angleDeg.toFixed(2), unit: "°" };
    }
    if (ann.type === "calibration") {
      let px;
      if (ann.x1 !== undefined) {
        px = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
      } else {
        px = ann.r * 2;
      }
      return distResult(px);
    }
    return { value: "", unit: "" };
  }
  ```

- [ ] **4.2 — Update the CSV export listener** (lines 1674–1693). Replace the rows array initializer and `forEach` body:

  ```js
  document.getElementById("btn-export-csv").addEventListener("click", () => {
    const rows = [["#", "Name", "Value", "Unit", "type", "label"]];
    let i = 1;
    state.annotations.forEach(ann => {
      const label = measurementLabel(ann);
      if (!label) return;  // skip origin / overlays
      const { value, unit } = formatCsvValue(ann);
      rows.push([i++, ann.name || "", value, unit, ann.type, label]);
    });
    const csv = rows
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `measurements_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
  ```

  Column layout: `#`, `Name`, `Value`, `Unit`, `type`, `label`.
  - `label` is the existing human-readable `measurementLabel(ann)` output (previously the `value` column), retained for human readability.
  - `type` is the annotation type string.
  - `Name` replaces the old lowercase `name` — capitalised per spec.

### Manual verification

1. Place a calibrated distance annotation (e.g. named "gap"). Export CSV. Open in a spreadsheet — verify columns: `#`, `Name`, `Value`, `Unit`, `type`, `label`. Confirm `Value` is a bare number (e.g. `3.142`), `Unit` is `mm` or `µm`, and `label` has the original formatted string.
2. Place an angle annotation — `Unit` column is `°`, `Value` is degrees to 2 dp.
3. Place an area annotation — `Unit` is `mm²` (or `µm²` / `px²`). Confirm `Value` is a bare number.
4. Place an origin — confirm it does not appear in the CSV.
5. Export without calibration — `Unit` is `px` for distances, `px²` for area.
