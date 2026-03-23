# Polish & Measurements Design

**Date:** 2026-03-22
**Scope:** Bug fixes, UI polish, new measurement types, calibration improvements — all client-side (frontend only, no new backend endpoints).

---

## Goals

Fix several interaction bugs, improve the measurement workflow, add keyboard shortcuts, add a help dialog, and make calibration a visible, deletable annotation. All changes are in `frontend/app.js`, `frontend/index.html`, and `frontend/style.css`.

---

## Prerequisite: `setTool(name)` helper

**Must be implemented first, before Features 1 and 6.**

Extract the existing tool-switching logic (currently inline in the `.tool-btn` click handler) into a reusable `setTool(name)` function:

```js
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

Replace all direct `state.tool = ...` + button class mutations with calls to `setTool()`. Features 1 and 6 both depend on this.

---

## Feature 1: Arc-fit Bug Fixes

**Problems:**
1. After double-click confirmation, the tool stays in `arc-fit` mode — the user must manually switch back to Select.
2. The new circle annotation is not visually highlighted or scrolled to in the sidebar after creation.
3. The mousemove rubber-band line (cursor → last pending point) renders for `arc-fit`, producing a distracting dotted line from the last collected point.

**Fix:**
- After `dblclick` confirmation in `arc-fit` mode: call `setTool("select")`, set `state.selected` to the new annotation's id, call `renderSidebar()`, scroll the new sidebar row into view, and call `redraw()`. The new circle immediately appears selected in both canvas and sidebar.
- In the `mousemove` handler, suppress the rubber-band line when `state.tool === "arc-fit"`. (The `center-dist` tool also does not use `state.pendingPoints`, so the rubber-band will naturally not appear for it.)

---

## Feature 2: Circle Tool Live Preview

**Problem:** The 3-point circle tool shows two straight rubber-band lines while collecting points, with no preview of the resulting circle.

**Fix:** When `state.tool === "circle"` and `state.pendingPoints.length === 2`, the `mousemove` handler computes `fitCircle(p1, p2, mousePos)` and draws a dashed circle preview (same style as arc-fit preview: dashed orange, `rgba(251,146,60,0.6)`). If the three points are collinear, no preview is drawn. The preview disappears after the 3rd click confirms the circle.

---

## Feature 3: Clear All Excludes DXF

**Problem:** The `btn-clear` ("✕") button removes DXF overlay annotations along with measurements.

**Fix:** Change `btn-clear` to keep only DXF overlay annotations: `state.annotations = state.annotations.filter(a => a.type === "dxf-overlay")`. The DXF overlay persists until explicitly removed via the "Clear DXF" button in the DXF panel.

Because the DXF annotation is preserved, **do not hide `#dxf-panel`** in this handler (unlike the existing code). The DXF panel should remain visible if a DXF overlay exists.

Also: if `_dxfOriginMode` is active when Clear All is clicked, cancel origin mode (already implemented — preserve this).

Because calibration is now an annotation, clearing all annotations also clears calibration. After the filter, set `state.calibration = null` if no calibration annotation remains.

---

## Feature 4: Bidirectional Selection Highlight

**Problem:** Clicking a canvas annotation sets `state.selected` and highlights the canvas item, but the sidebar does not scroll to show the selected row.

**Fix:** In `handleSelectDown` (and any other place that sets `state.selected` from a canvas interaction), after `renderSidebar()` is called, find the matching sidebar row and call `el.scrollIntoView({ block: "nearest" })`.

The reverse direction (sidebar → canvas) already works correctly.

---

## Feature 5: Center Distance Tool

**New toolbar button:** `"Cdist"` with `data-tool="center-dist"`, placed after the `arc-fit` button. Keyboard shortcut: `M`. Tooltip: `"Center distance [M]"`.

**Interaction:**
1. Activate tool. Status bar shows: `"Click a circle to select it"`.
2. User clicks near a circle's circumference (within ±20px of the circle's edge radius). The app finds the circle annotation (`type: "circle"` or `"detected-circle"`) whose edge is closest to the click. That circle is highlighted (drawn in selection color) and stored as `state.pendingCenterCircle`. Status bar: `"Click a second circle"`.
3. User clicks near a second circle's circumference. The app creates an annotation.
4. Escape cancels the pending first selection and resets to step 1.

**Annotation type:** `"center-dist"` with fields `{ a: {x, y}, b: {x, y} }` — same structure as `"distance"` — where `a` and `b` are the centers of the two selected circles. This allows `measurementLabel` and `drawAnnotations` to handle `"center-dist"` with zero extra code by treating it identically to `"distance"`.

Add `"center-dist"` to the `drawAnnotations` dispatch: `else if (ann.type === "center-dist") drawDistance(ann, sel)` (reuses the existing draw function).

Add `"center-dist"` to `measurementLabel`: return the same pixel/calibrated distance as the `"distance"` branch.

**Snapping:** For each candidate circle, compute `|distance(click, circle_center) - circle_radius|`. Pick the circle with the smallest value if it is ≤ 20px. Considers both `"circle"` and `"detected-circle"` types. If no circle is within 20px, ignore the click.

**Coordinate scaling for `detected-circle`:** `detected-circle` annotations store geometry in frame-pixel coordinates (`ann.x`, `ann.y`, `ann.radius`, `ann.frameWidth`, `ann.frameHeight`). Before applying the snap formula, convert to canvas coordinates using the same scale factors used in `drawDetectedCircle`: `sx = canvas.width / ann.frameWidth`, `sy = canvas.height / ann.frameHeight`. Use `cx = ann.x * sx`, `cy = ann.y * sy`, `r = ann.radius * sx` for the distance calculation. For `"circle"` annotations, `cx`, `cy`, `r` are already in canvas coordinates.

**State:** Add `state.pendingCenterCircle` (null or an annotation object) for the first-picked circle. Reset to null after annotation is created or on Escape/tool-switch.

---

## Feature 6: Keyboard Shortcuts + Tooltips

Add a `keydown` listener in `app.js` (merged into the existing Escape handler). Shortcuts are ignored when `document.activeElement` is an `<input>`, `<select>`, `<textarea>`, or `<dialog>`.

| Key | Action |
|-----|--------|
| `V` | Switch to Select tool |
| `C` | Switch to Calibrate tool |
| `D` | Switch to Distance tool |
| `A` | Switch to Angle tool |
| `O` | Switch to Circle tool |
| `F` | Switch to Fit Arc tool |
| `M` | Switch to Center Dist tool |
| `E` | Switch to Detect tool |
| `Escape` | Switch to Select tool; cancel pending points; cancel pending center-dist pick |
| `Delete` / `Backspace` | Delete the currently selected annotation (same as clicking its delete button) |
| `?` | Open help dialog |

**Tooltip updates** in `index.html`: add `[X]` shortcut notation to all tool button `title` attributes, e.g. `title="Select [V]"`, `title="Distance [D]"`, `title="Help [?]"`.

**Tool switching:** Switching tools via keyboard calls `setTool(name)` (defined in the Prerequisite section above). The `?` shortcut check should use `e.key === "?"` (which fires when Shift+/ is pressed) and is not blocked by the input-focus guard — the help dialog can be opened from anywhere. The input-focus guard applies to all other tool shortcuts.

**Input focus guard:** Use `document.activeElement.closest("input, select, textarea, dialog") !== null` — checking `closest()` rather than `tagName` directly, because when a dialog is open, focus is typically on an element *inside* the dialog (a button or input), not on the `<dialog>` itself.

---

## Feature 7: Help Dialog

A `<dialog id="help-dialog">` styled consistently with the existing `#settings-dialog`. Opened by:
- A `?` toolbar button (`id="btn-help"`, `title="Help [?]"`), placed at the end of the toolbar before the settings button.
- The `?` keyboard shortcut.

Closed by Escape or a `✕` close button inside the dialog.

**Content** (static HTML, no tabs):

### Tools
| Tool | Key | How to use |
|------|-----|-----------|
| Select | V | Click annotation to select; drag to move |
| Calibrate | C | Click two points of known distance and enter value; or click a circle of known diameter |
| Distance | D | Click two points |
| Angle | A | Click three points (middle point is the vertex) |
| Circle | O | Click three points on the circumference |
| Fit Arc | F | Click ≥ 3 points on an arc or circle edge, double-click to confirm |
| Center Dist | M | Click two circles to measure center-to-center distance |
| Detect | E | Opens detection panel |

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| V | Select tool |
| C | Calibrate tool |
| D | Distance tool |
| A | Angle tool |
| O | Circle tool |
| F | Fit Arc tool |
| M | Center Dist tool |
| E | Detect tool |
| Escape | Back to Select / cancel |
| Delete / Backspace | Delete selected annotation |
| ? | This help dialog |

---

## Feature 8: Calibration as Annotation

### Overview

Calibration is stored as a `"calibration"` annotation in `state.annotations`. It appears in the measurements sidebar with a label showing the reference measurement (e.g. `"10.00 mm"`). Deleting it (via the sidebar delete button or `Delete` key when selected) removes `state.calibration` and reverts all measurements to pixels. Only one calibration annotation can exist at a time — creating a new calibration replaces the previous one.

`state.calibration` is simplified to `{ pixelsPerMm, displayUnit }` only — remove the legacy fields `pointA`, `pointB`, `knownDistance` that are no longer needed. These fields are not read anywhere except the old calibration-creation code which will be replaced.

### `deleteAnnotation(id)` helper

Introduce a `deleteAnnotation(id)` function used by the sidebar delete button and the keyboard `Delete` handler:

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

Replace the inline removal code in `renderSidebar`'s delete-button handler and the keyboard `Delete` handler with calls to this function.

**Do NOT replace `btn-clear`'s annotation filtering with `deleteAnnotation`.** `btn-clear` performs a batch filter and has its own logic (preserving DXF, handling origin mode, clearing calibration). Leave it as a separate handler.

### Annotation fields

**Two-point calibration:**
```
{ type: "calibration", x1, y1, x2, y2, knownValue, unit }
```

**Circle calibration:**
```
{ type: "calibration", cx, cy, r, knownValue, unit }
```

`knownValue` is the user-entered distance/diameter. `unit` is `"mm"` or `"µm"`.

### Rendering

- **Two-point:** Draw a line from `(x1,y1)` to `(x2,y2)` with tick marks at each end (like a scale bar). Label shows `"⟷ 10.00 mm"` centered above the line. When selected: blue color.
- **Circle:** Draw a horizontal diameter line through `(cx, cy)` with length `2r`. Label shows `"⌀ 10.00 mm"` above the line. When selected: blue color.

### `applyCalibration(ann)` helper

Introduce a shared helper that derives `state.calibration` from a calibration annotation and adds it to `state.annotations` (replacing any previous calibration):

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

Both two-point and circle calibration flows call `applyCalibration()`. After `applyCalibration` returns, always call `setTool("select")`.

### Two-point calibration flow (updated)

The calibrate tool uses `state.pendingPoints`. After the second point is placed, open a prompt for the known distance and unit. On confirm, call `applyCalibration({ type: "calibration", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, knownValue, unit })`. After `applyCalibration` returns, call `setTool("select")` to exit calibrate mode.

**State machine:** Calibrate mode first click → push to `pendingPoints`. If a circle is within ±20px of the click (same snap as center-dist), discard the pending-point approach and switch to the circle calibration flow instead (clear `pendingPoints`, highlight the circle, prompt for diameter). If no circle is near, proceed with point-collection as before. The second click always completes the two-point flow.

### Circle calibration flow (new)

While in Calibrate mode, if the first click lands within ±20px of an existing circle's edge: clear any pending points, highlight that circle, and open the calibration prompt (`"Enter known diameter:"`). On confirm, call `applyCalibration({ type: "calibration", cx, cy, r, knownValue, unit })`. On cancel, do nothing (user can try again). Use the same coordinate scaling for `detected-circle` as described in Feature 5.

### measurementLabel

Add `"calibration"` type: returns the label string `"⟷ {knownValue} {unit}"` (two-point, detected by presence of `ann.x1`) or `"⌀ {knownValue} {unit}"` (circle). Use `ann.knownValue` and `ann.unit` directly — do not compute from `state.calibration`, which may have rounding differences. This label appears in the sidebar and in CSV export (intentional — the calibration reference is useful context in an exported measurements file).

### `renderSidebar` skip list

The `"calibration"` annotation type is **not** in the skip list — it should render in the sidebar like any other measurement. The skip list currently contains `"edges-overlay"`, `"preprocessed-overlay"`, `"dxf-overlay"` and remains unchanged.

---

## Files Changed

| File | Changes |
|------|---------|
| `frontend/app.js` | All logic for features 1–8 |
| `frontend/index.html` | New buttons (Cdist, Help), updated tooltips, help dialog HTML, updated calibration prompt |
| `frontend/style.css` | Help dialog styles (minimal — reuse existing dialog styles) |

No backend changes. No new tests required (all changes are frontend JS with no backend surface). Existing backend tests remain unaffected.
