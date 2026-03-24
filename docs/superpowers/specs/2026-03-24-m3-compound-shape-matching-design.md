# M3 — Compound Shape Matching Design

**Date:** 2026-03-24
**Status:** Approved

## Context

M2 delivered circle, line, and partial-arc detection plus backend matching endpoints (`/match-dxf-lines`, `/match-dxf-arcs`) for those entity types. However, the frontend does not yet call those endpoints, and `drawDeviations` is circles-only. M3 completes the line/arc deviation pipeline and extends coverage to compound shapes: LWPOLYLINE entities from DXF (with and without arc segments encoded as bulge values). The primary real-world case is Fusion 360 exports where slots, pockets, and profiled outlines are emitted as LWPOLYLINE with bulge-encoded arcs.

The RANSAC design sub-task from the roadmap is resolved: use **option (b)** — circle-only RANSAC alignment retained, plus drag-to-translate for manual positioning of parts without circles. Heterogeneous RANSAC is deferred.

---

## Scope

1. **LWPOLYLINE bulge parsing** — decompose LWPOLYLINE entities into per-segment `polyline_line` and `polyline_arc` sub-entities in `dxf_parser.py`. Fixes the current bug where arc-encoded segments render as straight lines.
2. **Backend type filter extension** — `match_lines` and `match_arcs` in `line_arc_matching.py` currently accept only exact types `"line"` and `"arc"`. Extend to also accept `"polyline_line"` and `"polyline_arc"` respectively.
3. **DXF overlay rendering** — canvas renders `polyline_arc` segments as arcs (not lines). `polyline_line` segments already render correctly as lines.
4. **Line/arc match result storage** — `ann.lineMatchResults` and `ann.arcMatchResults` fields on the `dxf-overlay` annotation store results from `/match-dxf-lines` and `/match-dxf-arcs`.
5. **Inspection trigger** — a "Run inspection" button calls `/match-dxf-lines` and `/match-dxf-arcs`, stores results on the annotation, then redraws. Requires a DXF overlay and a frozen frame with detected lines/arcs.
6. **`drawDeviations` extension** — extended to render line and arc deviation callouts from `ann.lineMatchResults`/`ann.arcMatchResults`, in addition to the existing circle callouts.
7. **Per-segment deviation callouts** — each `polyline_line`/`polyline_arc` sub-entity gets its own callout. Callouts from the same parent LWPOLYLINE are labelled with a segment suffix.
8. **Drag-to-translate** — a "Move DXF" button activates a mode that shifts `ann.offsetX`/`ann.offsetY` on the `dxf-overlay` annotation. Allows manual coarse alignment for parts without circles.
9. **Backward compatibility** — sessions saved before M3 may contain `polyline` type entities (the old pre-decomposition format). These are rendered as straight-line polylines (no arc segments) to avoid breakage.

---

## Architecture

### DXF Parser (`backend/vision/dxf_parser.py`)

LWPOLYLINE processing replaces the current `polyline` entity emission.

**Bulge-to-arc conversion** (per segment from vertex `i` to vertex `i+1`, wrapping on closed polylines):

```
θ = 4 × arctan(|bulge|)          # included angle of the arc
d = chord_length(P_i, P_{i+1})
r = d / (2 × sin(θ/2))
h = r × cos(θ/2)                  # distance from chord midpoint to arc centre
centre = chord_midpoint + h × perpendicular_unit × sign(bulge)
  # positive bulge → CCW in DXF Y-up → centre is to the left of the chord direction
start_angle = atan2(P_i.y - cy, P_i.x - cx)   # degrees, DXF convention
end_angle   = atan2(P_{i+1}.y - cy, P_{i+1}.x - cx)
```

For `sign(bulge) < 0` (clockwise arc in DXF Y-up space), swap `start_angle` and `end_angle` so the arc always sweeps CCW — consistent with ARC entities in ezdxf.

**Output entities** — for each segment of a LWPOLYLINE:

```python
# straight segment (bulge == 0)
{
    "type": "polyline_line",
    "x1": float, "y1": float, "x2": float, "y2": float,
    "handle": "<parent_handle>_s<i>",
    "parent_handle": "<lwpolyline_handle>",
    "segment_index": i,
}

# arc segment (bulge != 0)
{
    "type": "polyline_arc",
    "cx": float, "cy": float, "radius": float,
    "start_angle": float, "end_angle": float,   # degrees, DXF Y-up convention
    "handle": "<parent_handle>_s<i>",
    "parent_handle": "<lwpolyline_handle>",
    "segment_index": i,
}
```

The top-level `polyline` entity type is no longer emitted for new DXF loads. A closed LWPOLYLINE with N vertices emits exactly N segments (last vertex connects back to first). POINT entities are silently skipped.

### Backend Matching (`backend/vision/line_arc_matching.py`)

`match_lines`: change type filter from `entity.get("type") != "line"` to accept `"line"` or `"polyline_line"`.
`match_arcs`: change type filter from `entity.get("type") != "arc"` to accept `"arc"` or `"polyline_arc"`.

No other changes. The `handle` field on sub-entities is the synthetic `<parent>_s<i>` string — tolerances and results reference this directly.

### Line/Arc Match Result Storage

Match results are stored on the `dxf-overlay` annotation object:

```js
ann.lineMatchResults = [
  { handle, matched, perp_dev_mm, angle_error_deg, pass_fail }, ...
]
ann.arcMatchResults = [
  { handle, matched, center_dev_mm, radius_dev_mm, pass_fail }, ...
]
```

These fields are set (or replaced) each time the user runs inspection. They persist on the annotation for the lifetime of the session. `drawDeviations` reads them directly from `ann`.

### Inspection Trigger (`frontend/dxf.js` or `frontend/detect.js`)

A new "Run inspection" button in the DXF panel:

1. Find `ann` = `state.annotations.find(a => a.type === "dxf-overlay")`
2. Collect detected lines from `state.annotations` (type `"detected-line-merged"`)
3. Collect detected arcs from `state.annotations` (type `"detected-arc-partial"`)
4. Call `/match-dxf-lines` with `ann.entities` (line+polyline_line), detected lines, `ann.scale`, `ann.offsetX`, `ann.offsetY`, `ann.angle ?? 0`, `ann.flipH ?? false`, `ann.flipV ?? false`, plus tolerances
5. Call `/match-dxf-arcs` with `ann.entities` (arc+polyline_arc), detected arcs, same alignment params
6. Store results on `ann.lineMatchResults` and `ann.arcMatchResults`
7. Call `redraw()`

Button is disabled if no DXF overlay or no frozen frame. Both calls can be made in parallel (`Promise.all`).

Note: the detected line/arc annotations store pixel coordinates relative to `frameWidth`/`frameHeight`. Before sending to the backend, coordinates must be scaled to canvas pixels: `x_canvas = x_stored × (canvas.width / frameWidth)`.

### Frontend Rendering (`frontend/render.js`)

**DXF overlay loop** — extend the entity-type switch to handle:
- `polyline_line` → drawn identically to `line` (straight `moveTo`/`lineTo`)
- `polyline_arc` → drawn as a canvas `arc()` call inside the same DXF transform context as all other entities. No explicit angle negation: the `ctx.scale(s, -s)` Y-flip already in the transform context handles DXF Y-up → canvas Y-down conversion, consistent with how existing `arc` entities are rendered.

**`drawDeviations(ann)` extension** — after the existing circle loop, add two new loops:

*Line deviations* — for each result in `ann.lineMatchResults ?? []`:
- Find the corresponding entity in `ann.entities` by handle to get the nominal midpoint
- Convert nominal midpoint to canvas coords via `dxfToCanvas()`
- Draw: a short perpendicular tick at the nominal midpoint (dashed), a label showing `⊥ {perp_dev_mm} mm` and `∠ {angle_error_deg}°`, colour-coded by pass_fail
- Push to `_deviationHitBoxes`

*Arc deviations* — for each result in `ann.arcMatchResults ?? []`:
- Find entity by handle, get nominal centre
- Convert to canvas coords
- Draw: dashed circle at nominal size, label showing `Δ {center_dev_mm} mm  Δr {radius_dev_mm} mm`, colour-coded by pass_fail
- Push to `_deviationHitBoxes`

Callout label for `polyline_line`/`polyline_arc` sub-entities uses `parent_handle` to build a readable prefix (e.g. `P142-s1`) if the entity has a `parent_handle` field.

### Drag-to-Translate (`frontend/dxf.js`)

**"Move DXF" button** (new, in the DXF controls panel):
- Clicking toggles `state.dxfDragMode = true/false`
- While active: `mousedown` on the canvas sets `state.dxfDragOrigin = { mouseX, mouseY, annOffsetX: ann.offsetX, annOffsetY: ann.offsetY }`
- `mousemove` (while drag active): `ann.offsetX = dxfDragOrigin.annOffsetX + (mouseX - dxfDragOrigin.mouseX)` (same for Y); call `redraw()`
- `mouseup`: clear `state.dxfDragOrigin`
- Escape key or button re-click exits drag mode
- Button disabled if no DXF overlay loaded

The drag reads and writes `ann.offsetX`/`ann.offsetY` directly on the `dxf-overlay` annotation. This is identical to the existing pattern used in `dxf.js` after `align-dxf` (lines 235–236).

---

## Data Flow

```
User loads DXF
  → /load-dxf → parse_dxf()
  → LWPOLYLINE with bulge → polyline_line + polyline_arc sub-entities emitted
  → Frontend stores entities in ann.entities (dxf-overlay annotation)
  → render.js draws all entities in overlay (arcs rendered correctly)

User aligns (circles present)
  → /align-dxf → align_circles() → ann.offsetX, ann.offsetY, ann.angle, ann.flipH, ann.flipV set

User drag-translates (no circles, or fine-tuning)
  → mousedown/move → ann.offsetX/ann.offsetY updated directly → redraw()

User detects + runs inspection
  → /detect-lines-merged → detected-line-merged annotations in state
  → /detect-arcs-partial → detected-arc-partial annotations in state
  → "Run inspection" button →
      /match-dxf-lines (line+polyline_line entities) → ann.lineMatchResults
      /match-dxf-arcs  (arc+polyline_arc entities)  → ann.arcMatchResults
  → redraw() → drawDeviations(ann) renders circle + line + arc callouts
```

---

## Testing

- Unit test: `parse_dxf` on `demuth vblock.dxf` emits `polyline_arc` sub-entities for the two bulge=0.4142 vertices.
- Unit test: bulge-to-arc math for a known bulge/chord produces correct `cx`, `cy`, `r`, `start_angle`, `end_angle`.
- Unit test: closed LWPOLYLINE with N vertices emits exactly N sub-entities.
- Unit test: `match_lines` accepts `polyline_line` entities and returns results with the synthetic handle.
- Unit test: `match_arcs` accepts `polyline_arc` entities and returns results.
- Unit test: a session containing old-format `polyline` entities loads without error.
- Existing tests must continue to pass.

---

## Success Criteria

- Loading `demuth vblock.dxf` renders the two 90° arc segments correctly in the DXF overlay (not as straight lines).
- After running inspection, all LWPOLYLINE segments (line and arc) produce per-segment deviation callouts.
- Drag-to-translate shifts the DXF overlay in real-time; the new position is used by subsequent inspect runs.
- Line and arc deviation callouts appear alongside circle callouts when `showDeviations` is on.
- All existing tests pass.
