# Punch/Die Tolerances + Draggable Labels + Tooltips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Punch/Die tolerance coloring (green/amber/red), draggable deviation labels with leader lines, and hover tooltips with full feature detail.

**Architecture:** Backend returns signed deviations. Frontend interprets sign through Punch/Die mode. Labels store drag offsets on the result objects. A single `_labelHitBoxes` array replaces the role of `_deviationHitBoxes` for guided results. Tooltip is a positioned div shown on hover.

**Tech Stack:** Python (backend), vanilla JS (frontend).

**Spec:** `docs/superpowers/specs/2026-03-26-tolerance-labels-tooltips-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `backend/vision/guided_inspection.py` | Return signed `perp_dev_mm` and `radius_dev_mm` (remove `abs()`) |
| `frontend/state.js` | Add `featureModes: {}`, `_labelDrag: null`, `_labelHitBoxes: []` |
| `frontend/render.js` | Amber/red coloring, label offsets, leader lines, label hitbox recording, tooltip data prep |
| `frontend/main.js` | Label drag handlers, tooltip hover logic, Punch/Die context menu items, Reset label |
| `frontend/session.js` | Save/load `featureModes` |
| `frontend/index.html` | Add `<div id="label-tooltip">` |
| `frontend/style.css` | Tooltip styles using CSS variables |

---

### Task 1: Signed Deviations in Backend

**Files:**
- Modify: `backend/vision/guided_inspection.py`
- Modify: `tests/test_guided_inspection.py`

- [ ] **Step 1: Remove `abs()` from `_inspect_line` perpendicular deviation**

In `_inspect_line`, the line computing `perp_dev_px` uses `abs()`. Remove it so the sign is preserved. The sign relative to the nominal line's normal tells us which side the edge is on.

```python
# Before:
perp_dev_px = abs(
    (centroid[0] - x1_px) * nx + (centroid[1] - y1_px) * ny
)
# After:
perp_dev_px = (centroid[0] - x1_px) * nx + (centroid[1] - y1_px) * ny
```

- [ ] **Step 2: Remove `abs()` from `_inspect_arc_circle` radius deviation**

```python
# Before:
radius_dev_px = abs(fit_r - r_px)
# After:
radius_dev_px = fit_r - r_px  # positive = larger than nominal
```

Keep `center_dev_px` as `abs()` (distance is always positive — direction is the sign of radius).

- [ ] **Step 3: Update `_pass_fail` to use absolute value**

The `_pass_fail` function compares deviation to thresholds. It must use `abs(dev)`:

```python
def _pass_fail(dev_mm, tol_warn, tol_fail):
    d = abs(dev_mm)
    if d <= tol_warn:
        return "pass"
    elif d <= tol_fail:
        return "warn"
    return "fail"
```

- [ ] **Step 4: Same changes in `fit_manual_points`**

Apply the same `abs()` removal to the manual fitting path.

- [ ] **Step 5: Update tests**

Existing tests may assert exact deviation values — update them to accept signed values. The tolerance tests should still pass since `_pass_fail` uses `abs()`.

- [ ] **Step 6: Commit**

```bash
git add backend/vision/guided_inspection.py tests/test_guided_inspection.py
git commit -m "feat: return signed deviations from guided inspection (positive = oversize)"
```

---

### Task 2: Punch/Die State + Session Persistence

**Files:**
- Modify: `frontend/state.js`
- Modify: `frontend/session.js`

- [ ] **Step 1: Add state fields**

In `frontend/state.js`, add to the state object:
```js
featureModes: {},    // { [handle]: "punch" | "die" } — default is "die"
_labelDrag: null,    // { handle, startX, startY, origDx, origDy }
```

Add module-level export:
```js
export const _labelHitBoxes = [];  // populated by drawGuidedResults, used for drag + tooltip
```

- [ ] **Step 2: Save/load featureModes in session**

In `frontend/session.js`, in `saveSession()`, add after `featureTolerances`:
```js
featureModes: { ...state.featureModes },
```

In `loadSession()`, add after restoring `featureTolerances`:
```js
state.featureModes = (data.featureModes && typeof data.featureModes === "object")
  ? { ...data.featureModes }
  : {};
```

Same for `autoSave()`.

- [ ] **Step 3: Commit**

```bash
git add frontend/state.js frontend/session.js
git commit -m "feat: add featureModes state and session persistence for Punch/Die"
```

---

### Task 3: Amber/Red Coloring in Renderer

**Files:**
- Modify: `frontend/render.js`

- [ ] **Step 1: Update `drawGuidedResults` color logic**

Replace the simple pass/warn/fail coloring with Punch/Die-aware coloring:

```js
function _deviationColor(r) {
  const magnitude = Math.abs(r.perp_dev_mm ?? r.radius_dev_mm ?? 0);
  const tol_w = r.tolerance_warn ?? state.tolerances.warn;
  const tol_f = r.tolerance_fail ?? state.tolerances.fail;

  if (magnitude <= tol_w) return "#32d74b";  // green — pass

  // For arcs/circles: sign of radius_dev tells us oversize vs undersize
  const mode = state.featureModes[r.handle] || "die";
  const radiusDev = r.radius_dev_mm;

  if (radiusDev != null) {
    // Arc/circle: positive radius_dev = larger than nominal
    const reworkable = (mode === "die" && radiusDev < 0)   // die: smaller = rework (enlarge hole)
                    || (mode === "punch" && radiusDev > 0); // punch: larger = rework (reduce shaft)
    return reworkable ? "#ff9f0a" : "#ff453a";  // amber or red
  }

  // Lines: for now, just use pass/fail (sign interpretation is ambiguous without winding order)
  return magnitude <= tol_f ? "#ff9f0a" : "#ff453a";
}
```

Replace the existing `const color = r.pass_fail === "fail" ? ...` with `const color = _deviationColor(r)`.

- [ ] **Step 2: Commit**

```bash
git add frontend/render.js
git commit -m "feat: Punch/Die-aware amber/red deviation coloring for arcs"
```

---

### Task 4: Draggable Labels with Leader Lines

**Files:**
- Modify: `frontend/render.js`
- Modify: `frontend/main.js`
- Modify: `frontend/state.js` (already has `_labelDrag` and `_labelHitBoxes`)

- [ ] **Step 1: Record label hitboxes during rendering**

In `drawGuidedResults`, after drawing each label, record its bounding box in `_labelHitBoxes`. Clear the array at the start of the function (same pattern as `_deviationHitBoxes`).

```js
// At start of drawGuidedResults:
_labelHitBoxes.length = 0;

// After each drawLabel call, record the hitbox:
const labelText = `⊥ ${r.perp_dev_mm?.toFixed(3)} mm`;
const labelW = ctx.measureText(labelText).width + pw(4);
const labelH = pw(16);
_labelHitBoxes.push({
  handle: r.handle,
  x: labelX, y: labelY - pw(13),
  w: labelW, h: labelH,
  refX: featureRefX, refY: featureRefY,  // for leader line
});
```

- [ ] **Step 2: Apply label offset if present**

When computing label position, check for a stored offset on the result:
```js
const offset = r.labelOffset || { dx: 0, dy: 0 };
const finalLabelX = defaultLabelX + offset.dx;
const finalLabelY = defaultLabelY + offset.dy;
```

If offset is non-zero, draw a leader line:
```js
if (offset.dx !== 0 || offset.dy !== 0) {
  ctx.save();
  ctx.strokeStyle = "rgba(150, 150, 150, 0.5)";
  ctx.lineWidth = pw(0.5);
  ctx.beginPath();
  ctx.moveTo(finalLabelX, finalLabelY);
  ctx.lineTo(featureRefX, featureRefY);
  ctx.stroke();
  ctx.restore();
}
```

- [ ] **Step 3: Add label drag handling in main.js**

Import `_labelHitBoxes` from state.js.

In `onMouseDown`, BEFORE other hit-tests (but after minimap and pan checks):

```js
// Label drag
if (state.tool === "select" && !e.shiftKey) {
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  for (const box of _labelHitBoxes) {
    // Convert screen click to canvas internal coords for hitbox comparison
    const cx = (e.clientX - rect.left) * dpr;
    const cy = (e.clientY - rect.top) * dpr;
    if (cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) {
      const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
      const result = dxfAnn?.guidedResults?.find(r => r.handle === box.handle);
      if (result) {
        const offset = result.labelOffset || { dx: 0, dy: 0 };
        state._labelDrag = { handle: box.handle, startX: pt.x, startY: pt.y,
                             origDx: offset.dx, origDy: offset.dy };
        return;
      }
    }
  }
}
```

In `mousemove`:
```js
if (state._labelDrag) {
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  const result = dxfAnn?.guidedResults?.find(r => r.handle === state._labelDrag.handle);
  if (result) {
    result.labelOffset = {
      dx: state._labelDrag.origDx + (pt.x - state._labelDrag.startX),
      dy: state._labelDrag.origDy + (pt.y - state._labelDrag.startY),
    };
    redraw();
  }
  return;
}
```

In `onMouseUp`:
```js
if (state._labelDrag) {
  state._labelDrag = null;
  return;
}
```

- [ ] **Step 4: Add "Reset label position" to context menu**

In the guided result right-click handler, add:
```js
if (hitResult.labelOffset) {
  items.push({ label: "Reset label position", action: () => {
    delete hitResult.labelOffset;
    redraw();
  }});
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/render.js frontend/main.js
git commit -m "feat: draggable deviation labels with leader lines"
```

---

### Task 5: Punch/Die Context Menu + Tolerance Popover Integration

**Files:**
- Modify: `frontend/main.js`

- [ ] **Step 1: Add Punch/Die toggle to guided result context menu**

In the right-click handler for guided results (the `_hitTestGuidedResult` section), add:

```js
const currentMode = state.featureModes[hitResult.handle] || "die";
items.push("---");
items.push({
  label: currentMode === "die" ? "Set as Punch" : "Set as Die",
  action: () => {
    state.featureModes[hitResult.handle] = currentMode === "die" ? "punch" : "die";
    redraw();
    showStatus(`Feature ${hitResult.handle}: ${state.featureModes[hitResult.handle]}`);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add frontend/main.js
git commit -m "feat: Punch/Die toggle in guided result context menu"
```

---

### Task 6: Label Tooltips

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/style.css`
- Modify: `frontend/main.js`

- [ ] **Step 1: Add tooltip HTML**

In `frontend/index.html`, before `</body>`:
```html
<div id="label-tooltip" hidden></div>
```

- [ ] **Step 2: Add tooltip CSS**

```css
#label-tooltip {
  position: fixed;
  z-index: 1001;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  color: var(--text);
  line-height: 1.5;
  max-width: 300px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  pointer-events: none;
  white-space: pre-line;
}
#label-tooltip[hidden] { display: none; }
```

- [ ] **Step 3: Add tooltip hover logic in main.js**

In the `mousemove` handler, after other checks, add tooltip logic:

```js
// Label tooltip on hover
const tooltip = document.getElementById("label-tooltip");
if (tooltip && _labelHitBoxes.length > 0) {
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  const cx = (e.clientX - rect.left) * dpr;
  const cy = (e.clientY - rect.top) * dpr;
  let hoveredLabel = null;
  for (const box of _labelHitBoxes) {
    if (cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) {
      hoveredLabel = box;
      break;
    }
  }
  if (hoveredLabel) {
    const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
    const r = dxfAnn?.guidedResults?.find(res => res.handle === hoveredLabel.handle);
    const entity = dxfAnn?.entities?.find(en => en.handle === hoveredLabel.handle);
    if (r) {
      const mode = state.featureModes[r.handle] || "die";
      const lines = [];
      lines.push(`Feature: ${r.handle} (${r.type})`);
      if (r.parent_handle) lines.push(`Group: ${r.parent_handle}`);
      lines.push(`Mode: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
      lines.push("");
      if (r.perp_dev_mm != null) {
        lines.push(`Deviation: ⊥ ${r.perp_dev_mm.toFixed(4)} mm`);
        if (r.angle_error_deg != null) lines.push(`Angle error: ${r.angle_error_deg.toFixed(2)}°`);
      }
      if (r.center_dev_mm != null) lines.push(`Center dev: ${r.center_dev_mm.toFixed(4)} mm`);
      if (r.radius_dev_mm != null) lines.push(`Radius dev: ${r.radius_dev_mm.toFixed(4)} mm`);
      lines.push(`Tolerance: warn ±${r.tolerance_warn}  fail ±${r.tolerance_fail}`);
      lines.push(`Result: ${r.pass_fail?.toUpperCase() ?? "?"}`);
      lines.push(`Source: ${r.source ?? "auto"}`);
      tooltip.textContent = lines.join("\n");
      tooltip.style.left = (e.clientX + 12) + "px";
      tooltip.style.top = (e.clientY - 10) + "px";
      tooltip.hidden = false;
    }
  } else {
    tooltip.hidden = true;
  }
}
```

Also hide tooltip on mousedown and on canvas leave:
```js
canvas.addEventListener("mouseleave", () => {
  document.getElementById("label-tooltip")?.hidden = true;
});
```

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/style.css frontend/main.js
git commit -m "feat: hover tooltips on deviation labels with full feature detail"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Test Punch/Die coloring**
1. Run inspection on V-block
2. Right-click an arc result → "Set as Punch"
3. If the arc's radius is smaller than nominal → should turn red (scrap for punch)
4. Right-click → "Set as Die" → should turn amber (rework for die)

- [ ] **Step 2: Test draggable labels**
1. In Select mode, click and drag a deviation label → it moves
2. A gray leader line connects the label to the feature
3. Right-click the label → "Reset label position" → returns to default

- [ ] **Step 3: Test tooltips**
1. Hover over a deviation label → tooltip appears with full detail
2. Move away → tooltip disappears
3. Check it shows feature handle, mode, deviation, tolerance, result, source

- [ ] **Step 4: Test session persistence**
1. Set some features to Punch, drag some labels
2. Save session → reload → Punch/Die modes and label positions persist
