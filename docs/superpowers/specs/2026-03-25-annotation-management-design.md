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
| `detected-line-merged` | Point-to-line-segment distance (same as `detected-line`). Must apply `canvas.width / ann.frameWidth` scaling to convert annotation coords to canvas-space before testing. | 8px |
| `detected-arc-partial` | (a) Distance from click to arc center is within `r ± 8px`, AND (b) click angle (relative to center) falls within the arc's angular span (`start_deg` to `end_deg`). Must apply frame-to-canvas scaling to `cx`, `cy`, `r`. | 8px |
| `edges-overlay` | Not selectable (visual-only overlay) | — |
| `preprocessed-overlay` | Not selectable (visual-only overlay) | — |
| `dxf-overlay` | Not selectable from canvas (has its own drag mode) | — |

### 1.2 Consistent selection highlighting

Every selectable annotation type must render identically when selected:
- Stroke color: `#60a5fa` (blue)
- Stroke width: 2px (up from 1.5)
- Handle dots at key points (5px radius, white outline)

**Types that need fixing:**
- `arc-measure`: Currently uses `#e879f9` when selected. Change to `#60a5fa`. Add handles at p1, p2, p3.
- `detected-line-merged`: Already uses `#60a5fa` when selected. Add handles at scaled endpoints.
- `detected-arc-partial`: Already uses `#60a5fa` when selected. Add handles at arc start and end points (computed from `cx`/`cy`/`r`/`start_deg`/`end_deg`).
- `slot-dist`: No handles currently. Add handles at the midpoints of both lines.
- `intersect`: No handles. Add handle at the intersection point.

### 1.3 Sidebar ↔ canvas flash

When clicking a sidebar item, the corresponding canvas annotation briefly pulses to
make it visually obvious in a dense field:

- On selection via sidebar click, the annotation renders with a bright halo
  (`#60a5fa` at 0.5 alpha, 4px extra stroke width) for 400ms, then fades to normal
  selected state.
- Implementation: set `state._flashExpiry = Date.now() + 400` on sidebar click.
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

**Migration checklist** (all sites that reference `state.selected`):

| Pattern | Old | New |
|---------|-----|-----|
| Check if anything selected | `state.selected !== null` | `state.selected.size > 0` |
| Check if specific ann selected | `state.selected === ann.id` | `state.selected.has(ann.id)` |
| Select one annotation | `state.selected = id` | `state.selected = new Set([id])` |
| Deselect all | `state.selected = null` | `state.selected = new Set()` |
| Pass to draw function | `state.selected === ann.id` | `state.selected.has(ann.id)` |

**Undo/redo restoration** (currently in `main.js` lines 25, 36): The current code does
`state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null`.
Replace with: filter the Set to retain only IDs that still exist in the restored
annotation list:
```js
state.selected = new Set(
  [...state.selected].filter(id => state.annotations.some(a => a.id === id))
);
```

**Session save/load**: `state.selected` is currently NOT serialized in sessions. Keep it
that way — selection is transient UI state, not part of the saved inspection. On session
load, `state.selected = new Set()` (already effectively happens since load sets it to null).

**Undo snapshots** (`takeSnapshot()` in `state.js`): Currently does not include `selected`.
Keep it that way — undo restores annotation data, not selection state.

**JSON.stringify safety**: A `Set` serializes to `{}` via `JSON.stringify`. Since we do
NOT serialize `selected` in sessions or snapshots, this is safe. But add a code comment
warning future developers: `// Note: Set — do NOT include in JSON.stringify output`.

### 2.2 Rectangle drag-select

In Select mode (`state.tool === "select"`), mousedown on empty canvas (no annotation
hit) starts a selection rectangle:

1. `mousedown` on empty canvas: record `state._selectRect = { x1, y1, x2: x1, y2: y1 }`
2. `mousemove`: update `x2, y2`. Draw a dashed blue rectangle overlay.
3. `mouseup`: find all annotations whose geometry falls within the rectangle.
   Set `state.selected = new Set(matchingIds)`. Clear `state._selectRect`.

**Containment test** — use a single default rule: the annotation's **primary point** must
be inside the rectangle. Primary point per type:

| Type | Primary point |
|------|--------------|
| `distance`, `center-dist`, `perp-dist`, `para-dist`, `parallelism`, `slot-dist` | Midpoint of (a, b) or equivalent endpoints |
| `circle`, `detected-circle` | Center (cx, cy) |
| `arc-measure`, `detected-arc-partial` | Center (cx, cy) |
| `detected-line`, `detected-line-merged` | Midpoint of (x1,y1)→(x2,y2) |
| `angle` | Vertex point |
| `area` | Centroid |
| `origin` | Center point |
| `calibration` | Midpoint |
| `pt-circle-dist` | The point (not the circle) |
| `intersect` | Intersection point |

Apply frame-to-canvas scaling for detected types before testing containment.

If Shift is held during drag-select, ADD to existing selection instead of replacing.

### 2.3 Shift+click

- Click annotation without Shift: replace selection with just that annotation
- Shift+click annotation: toggle it in/out of the current selection set
- Click empty canvas without drag: clear selection

### 2.4 Bulk operations

With multiple annotations selected:

- **Delete** (Delete/Backspace): Push single undo state, then delete all selected.
  The keyboard handler must check `state.selected.size > 0` (not truthiness, since
  an empty Set is truthy). Call a new `deleteSelected()` function that iterates the
  Set and removes each annotation.
- **Elevate** (context menu only — see Section 2.5 for key binding): elevate all
  selected detections. Non-detection types in the selection are ignored.
- Status bar shows count: "5 selected" / "3 detections, 2 measurements selected"

### 2.5 Elevation key binding

The `E` key is currently bound to the Detect tool (`e: "detect"` in `main.js`).
Reassign: **`U`** for elevation ("promote **U**p"). This avoids conflicts with existing
key bindings.

Alternatively, don't assign a key at all — the context menu is the primary interface.
The key binding is a convenience, not a requirement. Use `U` if we add one.

**Drag handles during multi-select**: Drag handles are only active when exactly one
annotation is selected. With 2+ selected, mousedown starts a drag-select rectangle
instead of handle interaction.

---

## 3. Elevation — Detection to Measurement

### 3.1 Type mapping

| Source type | Target type | Geometry conversion |
|---|---|---|
| `detected-line-merged` | `distance` | Scale endpoints: `a = {x: x1*sx, y: y1*sy}`, `b = {x: x2*sx, y: y2*sy}` where `sx = canvas.width / ann.frameWidth`, `sy = canvas.height / ann.frameHeight`. Note: `detected-line-merged` does NOT have a `length` field — compute it from the scaled endpoints. |
| `detected-line` | `distance` | Same as above. `detected-line` has `x1/y1/x2/y2` plus `length` and `frameWidth/frameHeight`. |
| `detected-arc-partial` | `arc-measure` | Scale center and radius: `cx *= sx`, `cy *= sy`, `r *= sx`. Reconstruct three points on the arc: p1 at `start_deg`, p3 at `end_deg`, p2 at midpoint angle `(start_deg + end_deg) / 2`, each at distance `r` from `(cx, cy)`. Compute `span_deg = end_deg - start_deg` (handle wrapping: if negative, add 360). Compute `chord_px = hypot(p3.x - p1.x, p3.y - p1.y)`. |
| `detected-circle` | `circle` | Scale directly: `cx *= sx`, `cy *= sy`, `r *= sx`. The `circle` annotation type uses `{cx, cy, r}` — no 3-point conversion needed. |

### 3.2 Elevation flow

1. User selects one or more detections
2. Right-click → "Elevate to measurement" (or presses `U`)
3. Push a single undo state
4. For each selected detection:
   a. Create a new annotation of the target type with converted geometry
   b. Remove the original detection annotation
   c. The new annotation gets a sequential ID and appears in the sidebar
5. New annotations are auto-selected after elevation
6. Status: "Elevated 3 detections to measurements"

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
| Clear all | Remove everything (with confirmation) |

### 4.2 Implementation

- A single `<div id="context-menu">` in `index.html`, hidden by default
- Positioned at `(e.clientX, e.clientY)` on the `contextmenu` event
- Dismissed on: click anywhere, Escape key, scroll, or right-click elsewhere
- Menu items are built dynamically based on what's under the cursor / what's selected
- Prevent the browser's default context menu on the canvas element
- Style: dark background matching the app's existing dropdown menus (`--surface-2`),
  same font and padding as the existing `.dropdown-item` buttons

### 4.3 Annotation type classification

For menu logic, annotations are classified as:

**Detections** (transient, auto-generated):
`detected-circle`, `detected-line`, `detected-line-merged`, `detected-arc-partial`

**Overlays** (visual-only, not selectable, not clearable individually):
`edges-overlay`, `preprocessed-overlay`

**Measurements** (permanent, user-created or elevated):
`distance`, `angle`, `circle`, `arc-measure`, `area`, `center-dist`, `perp-dist`,
`para-dist`, `parallelism`, `pt-circle-dist`, `intersect`, `slot-dist`

**Infrastructure** (preserved across clears unless explicitly cleared):
`calibration`, `origin`

**DXF** (has its own clear path):
`dxf-overlay`

---

## 5. Granular Clear Operations

### 5.1 Clear detections

Remove all annotations where type is in the Detections or Overlays sets.

Does NOT remove: measurements, DXF overlay, calibration, origin.

### 5.2 Clear measurements

Remove all annotations where type is in the Measurements set.
Does NOT remove: calibration, origin, detections, DXF overlay.

### 5.3 Clear DXF overlay

Remove `dxf-overlay` annotation. Reset `state.inspectionResults`,
`state.inspectionFrame`, `state.dxfFilename`. Hide the DXF panel.

Same as the current "Clear" button in the DXF controls, but now also accessible
from the context menu and the Clear sub-menu.

### 5.4 Clear all

Remove all annotations (detections + measurements + overlays + DXF).
Reset `state.inspectionResults`, `state.inspectionFrame`, `state.dxfFilename`.

Use a simple `confirm()` dialog: "Clear all annotations? Calibration and origin
will be preserved." [OK] / [Cancel].

Calibration and origin are preserved by default. To clear those too, the user can
delete them individually (select + delete) or use the existing calibration/origin
buttons to reset them.

### 5.5 Clear menu in top bar

Add a "Clear ▾" dropdown button in the top bar (next to the existing menu buttons)
with the four options:
- Clear detections
- Clear measurements
- Clear DXF overlay
- Clear all

This provides discoverability beyond the right-click menu.

---

## 6. Files Changed

| File | Changes |
|------|---------|
| `frontend/state.js` | `selected` becomes `Set()`. Add `_selectRect`, `_flashExpiry` transient fields. Add comment warning about Set serialization. |
| `frontend/tools.js` | Add hit-testing for `detected-line-merged` (with frame scaling), `detected-arc-partial` (with frame scaling + angle check). Update `handleSelectDown` for multi-select (Shift+click, drag-rect initiation). Drag handles only active when exactly 1 selected. Add `elevateAnnotation(id)` and `elevateSelected()` functions. |
| `frontend/render.js` | Update all draw functions: `sel` derived from `state.selected.has(ann.id)`. Add selection rectangle rendering. Add flash halo rendering. Fix `arc-measure` selection color to `#60a5fa`. Add handles to `arc-measure`, `slot-dist`, `intersect`, `detected-line-merged`, `detected-arc-partial`. |
| `frontend/main.js` | Update all `state.selected` references (see migration checklist in 2.1). Fix undo/redo restoration to filter Set. Add `contextmenu` event handler. Wire `U` key for elevation. Add Delete key handler for `state.selected.size > 0`. Add rectangle drag-select mouse handlers in Select mode. |
| `frontend/sidebar.js` | Update selected check to use `state.selected.has()`. Highlight multiple selected items. Set `state._flashExpiry` on sidebar click. Show selection count in status area. |
| `frontend/annotations.js` | Add `deleteSelected()` for batch delete. Add `clearDetections()`, `clearMeasurements()`, `clearAll()`. Update `deleteAnnotation` if needed. |
| `frontend/session.js` | Ensure `state.selected` is reset to `new Set()` on load (not null). No serialization of selection state. |
| `frontend/index.html` | Add `<div id="context-menu">` element. Add "Clear ▾" dropdown in top bar with 4 items. |
| `frontend/style.css` | Context menu styles (matching existing dropdown theme). Multi-selected sidebar item styles. |

---

## 7. What's NOT in Scope

- Zoom/pan (separate feature, much larger scope)
- Click-to-select outside Select mode (CAD convention: use Escape first)
- Bulk drag-move (not needed for inspection)
- Annotation grouping/folders (Phase 4 of roadmap)
- Custom modal dialogs (use browser `confirm()` for Clear all)
- `arc-fit` tool changes (it creates `arc-measure` annotations which are already measurement-type)
