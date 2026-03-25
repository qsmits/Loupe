# Annotation Management Overhaul — Design Spec

## Problem

The current annotation selection and management system has critical UX gaps that make
the app frustrating for real inspection work:

1. **Detected lines (merged) and arcs (partial) cannot be selected from the canvas** — no hit-testing exists for these types
2. **No multi-select** — can only work with one annotation at a time
3. **No way to bulk-delete false positive detections** — must delete one by one from sidebar
4. **No way to promote good detections to permanent measurements** — detections are transient and lost on re-run
5. **No way to clear and start fresh** without refreshing the browser
6. **Selection highlighting is inconsistent** — some types don't visually change when selected
7. **Sidebar ↔ canvas correlation is weak** — clicking a sidebar item highlights it but it's hard to spot in a dense field

## Solution

An annotation management overhaul covering: selection improvements, multi-select with
bulk operations, detection-to-measurement elevation, a right-click context menu, and
granular clear operations.

---

## 1. Selection Improvements

### 1.1 Hit-testing for all annotation types

Add hit-test support to `hitTestAnnotation()` in `tools.js` for types that currently
lack it:

| Type | Hit-test strategy | Threshold |
|------|------------------|-----------|
| `detected-line-merged` | Point-to-line-segment distance (same as `detected-line`) | 8px |
| `detected-arc-partial` | Distance from point to arc curve (check radius proximity AND angle within arc span) | 8px |
| `edges-overlay` | Not selectable (visual-only overlay) | — |
| `preprocessed-overlay` | Not selectable (visual-only overlay) | — |
| `dxf-overlay` | Not selectable from canvas (has its own drag mode) | — |

For `detected-line-merged`, the hit-test must apply the same `frameWidth`/`frameHeight`
scaling that the renderer uses, so canvas-space clicks map to annotation-space coordinates.

For `detected-arc-partial`, test: (a) distance from click to arc center is within
`r ± 8px`, AND (b) click angle (relative to center) falls within the arc's angular span.
Also apply frame scaling.

### 1.2 Consistent selection highlighting

Every selectable annotation type must render identically when selected:
- Stroke color: `#60a5fa` (blue)
- Stroke width: 2px (up from 1.5)
- Handle dots at key points (5px radius, white outline)

**Types that need fixing:**
- `arc-measure`: Currently uses `#e879f9` when selected. Change to `#60a5fa`. Add handles at p1, p2, p3.
- `detected-line-merged`: Already uses `#60a5fa` when selected. Add handles at endpoints.
- `detected-arc-partial`: Already uses `#60a5fa` when selected. Add handles at arc start and end points.
- `slot-dist`: No handles currently. Add handles at the midpoints of both lines.
- `intersect`: No handles. Add handle at the intersection point.

### 1.3 Sidebar ↔ canvas flash

When clicking a sidebar item, the corresponding canvas annotation briefly pulses to
make it visually obvious in a dense field:

- On selection via sidebar click, the annotation renders with a bright halo
  (`#60a5fa` at 0.5 alpha, 4px extra stroke width) for 400ms, then fades to normal
  selected state.
- Implementation: set `state._selectionFlashUntil = Date.now() + 400` on sidebar click.
  In the render loop, check if the flash is active and draw the halo. Use
  `requestAnimationFrame` to clear it after the timeout.

No flash when selecting via canvas click (the user already knows where it is).

---

## 2. Multi-Select

### 2.1 Selection state change

Change `state.selected` from a single ID to a `Set` of IDs:

```
// Before
state.selected = null;        // or a number

// After
state.selected = new Set();   // empty = nothing selected
```

All existing code that checks `state.selected === ann.id` must be updated to
`state.selected.has(ann.id)`. All code that sets `state.selected = id` must use
`state.selected = new Set([id])`.

The `sel` parameter passed to draw functions becomes `state.selected.has(ann.id)`.

### 2.2 Rectangle drag-select

In Select mode (`state.tool === "select"`), mousedown on empty canvas (no annotation
hit) starts a selection rectangle:

1. `mousedown` on empty canvas: record `state._selectRect = { x1, y1, x2: x1, y2: y1 }`
2. `mousemove`: update `x2, y2`. Draw a dashed blue rectangle overlay.
3. `mouseup`: find all annotations whose geometry falls within the rectangle.
   Set `state.selected = new Set(matchingIds)`. Clear `state._selectRect`.

**Containment test per type:**
- Lines/distances: both endpoints inside rect
- Circles: center inside rect
- Arcs: center inside rect
- Area/polygon: centroid inside rect
- Origin: center inside rect

Apply frame-to-canvas scaling for detected types before testing containment.

If Shift is held during drag-select, ADD to existing selection instead of replacing.

### 2.3 Shift+click

- Click annotation without Shift: replace selection with just that annotation
- Shift+click annotation: toggle it in/out of the current selection set
- Click empty canvas without drag: clear selection

### 2.4 Bulk operations

With multiple annotations selected:

- **Delete** (Delete/Backspace): delete all selected. Push single undo state before
  the batch delete so Ctrl+Z restores all of them.
- **Elevate** (`E` key or context menu): elevate all selected detections. Non-detection
  types in the selection are ignored.
- Status bar shows count: "5 annotations selected" / "3 detections, 2 measurements selected"

---

## 3. Elevation — Detection to Measurement

### 3.1 Type mapping

| Source type | Target type | Geometry conversion |
|---|---|---|
| `detected-line-merged` | `distance` | `{a: {x: x1*sx, y: y1*sy}, b: {x: x2*sx, y: y2*sy}}`. Compute `frameWidth`/`frameHeight` scaling at elevation time so the measurement lives in canvas-space. |
| `detected-line` | `distance` | Same as above |
| `detected-arc-partial` | `arc-measure` | Reconstruct p1, p2, p3 from arc geometry: p1 at start angle, p3 at end angle, p2 at midpoint angle, all at radius distance from center. Scale cx/cy/r from frame-space to canvas-space. |
| `detected-circle` | `circle` | Convert `{x, y, radius}` to 3-point circle: p1 at 0°, p2 at 120°, p3 at 240° on the circle. Scale from frame-space. |

### 3.2 Elevation flow

1. User selects one or more detections
2. Presses `E` or right-click → "Elevate to measurement"
3. For each selected detection:
   a. Create a new annotation of the target type with converted geometry
   b. Remove the original detection annotation
   c. The new annotation gets a sequential ID and appears in the sidebar
4. New annotations are auto-selected after elevation
5. Status: "Elevated 3 detections to measurements"

### 3.3 Post-elevation editing

Elevated measurements are fully editable like any manual measurement:

- **Distance** (from line): drag endpoints to adjust line position/length
- **Circle** (from detected-circle): drag center or edge handle
- **Arc-measure** (from arc): drag p1/p3 to extend/shorten, drag p2 to adjust curvature.
  The arc re-fits through all 3 points on each drag.

---

## 4. Right-Click Context Menu

### 4.1 Structure

**Right-click on selected annotation(s):**

| Item | Shown when | Action |
|------|-----------|--------|
| Elevate to measurement | Any detection type in selection | Elevate selected detections |
| Delete | Always | Delete selected annotations |
| Rename | Single measurement selected | Focus the name input in sidebar |

**Right-click on empty canvas:**

| Item | Action |
|------|--------|
| Clear detections | Remove all detection-type annotations |
| Clear measurements | Remove all measurement-type annotations |
| Clear DXF overlay | Remove DXF + inspection results |
| Clear all | Remove everything (prompt: "Keep calibration and origin?") |

### 4.2 Implementation

- A single `<div id="context-menu">` appended to `<body>`, hidden by default
- Positioned at `(e.clientX, e.clientY)` on the `contextmenu` event
- Dismissed on: click anywhere, Escape key, scroll, or right-click elsewhere
- Menu items are built dynamically based on what's under the cursor / what's selected
- Prevent the browser's default context menu on the canvas element

### 4.3 Annotation type classification

For menu logic, annotations are classified as:

**Detections** (transient, auto-generated):
`detected-circle`, `detected-line`, `detected-line-merged`, `detected-arc-partial`

**Overlays** (visual-only, not selectable):
`edges-overlay`, `preprocessed-overlay`

**Measurements** (permanent, user-created or elevated):
Everything else — `distance`, `angle`, `circle`, `arc-measure`, `area`,
`center-dist`, `perp-dist`, `para-dist`, `parallelism`, `pt-circle-dist`,
`intersect`, `slot-dist`, `calibration`, `origin`

---

## 5. Granular Clear Operations

### 5.1 Clear detections

Remove all annotations where type is in the Detections set (see 4.3 above),
plus `edges-overlay` and `preprocessed-overlay`.

Does NOT remove: measurements, DXF overlay, calibration, origin.

### 5.2 Clear measurements

Remove all annotations where type is in the Measurements set, EXCEPT
`calibration` and `origin` (these are infrastructure, not part measurements).

### 5.3 Clear DXF overlay

Remove `dxf-overlay` annotation. Reset `state.inspectionResults`,
`state.inspectionFrame`, `state.dxfFilename`. Hide the DXF panel.

Same as the current "Clear" button in the DXF controls, but now also accessible
from the context menu and the Clear sub-menu.

### 5.4 Clear all

Remove all annotations. Show confirmation dialog:
"Clear all annotations? Calibration and origin will be preserved."
With buttons: [Clear all] [Clear including calibration] [Cancel]

Default action preserves calibration and origin. The second button is for
true fresh-start (new magnification, different scope setup).

### 5.5 Clear menu in top bar

Add a "Clear ▾" dropdown button in the top bar (next to the existing menu buttons)
with the four options. This provides discoverability beyond the right-click menu.

---

## 6. Files Changed

| File | Changes |
|------|---------|
| `frontend/state.js` | `selected` becomes `Set`. Add `_selectRect`, `_selectionFlashUntil` transient fields. |
| `frontend/tools.js` | Add hit-testing for `detected-line-merged`, `detected-arc-partial`. Update `handleSelectDown` for multi-select (Shift). Add rectangle drag-select logic. Add `elevateDetection()` function. |
| `frontend/render.js` | Update all draw functions to accept `sel` as boolean from Set check. Add selection rectangle rendering. Add flash halo rendering. Fix inconsistent highlight colors. Add handles to arc-measure, slot-dist, intersect, detected types. |
| `frontend/main.js` | Update all `state.selected` references from ID to Set. Add `contextmenu` event handler. Wire `E` key for elevation. Add rectangle drag-select mouse handlers. |
| `frontend/sidebar.js` | Update selected check to use Set. Highlight multiple selected items. Add flash trigger on sidebar click. |
| `frontend/annotations.js` | Add `elevateAnnotation(id)` and `elevateSelected()` functions. Update `deleteAnnotation` for batch delete. |
| `frontend/session.js` | Serialize `state.selected` as array in save, restore as Set on load. |
| `frontend/index.html` | Add `<div id="context-menu">` element. Add "Clear ▾" dropdown in top bar. |
| `frontend/style.css` | Context menu styles. Multi-selected sidebar item styles. Flash animation keyframes. |

---

## 7. What's NOT in Scope

- Zoom/pan (separate feature, much larger scope)
- Click-to-select outside Select mode (CAD convention: use Escape first)
- Bulk drag-move (not needed for inspection)
- Annotation grouping/folders (Phase 4 of roadmap)
- Undo for bulk operations beyond single undo state (Ctrl+Z restores the batch)
