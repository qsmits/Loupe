# Phase 2 — DXF-Guided Inspection Design Spec

## Problem

The current inspection workflow is: run global detection (hundreds of noisy features)
→ match each to a DXF entity within 50px. This produces many false positives, ambiguous
matches, and no fallback when detection fails. The user has no control over what gets
measured.

Heidenhain-style inspection tools let the operator select a DXF feature, then place
points on the part to measure it directly. This is more intuitive, more reliable,
and works even when auto-detection fails.

## Solution

Replace the global detect-then-match pipeline with **DXF-guided inspection**:

1. **Corridor auto-detection**: For each DXF feature, search a ±15px corridor around
   its expected position in the image. Fit geometry to the edge points found. No global
   detection, no matching ambiguity.
2. **Manual point-pick fallback**: Click any DXF feature to measure it by placing
   points along the actual edge. Works for unmatched features or to override auto results.
3. **Compound feature support**: Clicking a polyline (slot, outline) enters point-pick
   for the whole group. Points auto-bucket to the nearest sub-segment.

---

## 1. Corridor Auto-Detection

### 1.1 How it works

When "Run Inspection" is clicked with a DXF loaded and aligned:

For **each DXF entity** (line, arc, circle, polyline_line, polyline_arc):

1. **Project** the entity from DXF-space to image-space using the current alignment
   transform (offset, scale, rotation, flip).
2. **Define a corridor** — a polygon ±`corridor_px` (default 15px) perpendicular to
   the feature. For a line: a rectangle. For an arc: an annular sector.
3. **Collect edge points** — from the Canny edge map (computed once for the whole frame),
   keep only edge pixels that fall within the corridor.
4. **Fit geometry** — least-squares line fit (for line entities) or algebraic circle fit
   (for arc/circle entities) through the collected edge points.
5. **Compute deviation** — perpendicular distance for lines, center + radius deviation
   for arcs/circles. Apply tolerance thresholds for pass/warn/fail.

### 1.2 Corridor geometry

**For line entities** (line, polyline_line):
- Project both endpoints to image-space: `P1 = dxfToImage(x1, y1)`, `P2 = dxfToImage(x2, y2)`
- Compute the normal vector (perpendicular to the line direction)
- The corridor is a rectangle: `P1 ± normal * corridor_px` to `P2 ± normal * corridor_px`
- Also extend slightly (10%) along the line direction to catch endpoints

**For arc entities** (arc, polyline_arc, circle):
- Project center to image-space, scale radius
- The corridor is an annular region: `r - corridor_px` to `r + corridor_px`
- For partial arcs, limit the angular range to `start_angle` to `end_angle` (with margin)
- For circles, the full 360° annulus

### 1.3 Edge point collection

- Run Canny once on the preprocessed frame (same preprocessing as current detection)
- For each entity's corridor, iterate edge pixels and collect those inside the polygon
- The corridor test is a simple point-in-polygon or distance check
- Minimum points required: 5 for lines, 8 for arcs (otherwise: unmatched)

### 1.4 Geometry fitting

**Lines**: Orthogonal distance regression (not ordinary least squares — OLS biases
toward vertical/horizontal). Use the eigenvector method: compute the centroid, then
the direction of minimum spread via eigendecomposition of the covariance matrix.

**Arcs/circles**: Algebraic circle fit (Kåsa method) — already implemented as
`_fit_circle_algebraic()` in `detection.py`.

### 1.5 Deviation computation

**Lines**: Perpendicular distance from the fitted line to the nominal DXF line
(midpoint-to-line distance). Plus angle error.

**Arcs**: Center distance (fitted vs nominal center) + radius deviation.

Same tolerance thresholds as current system (global + per-feature overrides).

---

## 2. Manual Point-Pick Mode

### 2.1 Entering point-pick mode

Three ways to enter:
- Click an **unmatched** feature in the inspection results table
- Click an **unmatched** feature directly on the canvas (dashed red DXF outline)
- Click any DXF feature to re-measure it (overrides auto result)

### 2.2 The interaction

1. The selected DXF feature highlights (bright blue pulsing outline)
2. Status bar: "Click points along the edge. Double-click or Enter to finish."
3. Each left-click adds a point (small orange dot on canvas)
4. After minimum points (2 for lines, 3 for arcs), a **live fit preview** appears:
   - Thin green/amber/red line or arc showing the current fit
   - Deviation value updates in real-time
5. Double-click or Enter → finalize
6. Escape → cancel (feature stays as-is)

### 2.3 Compound features (slots, outlines)

When the user clicks a **compound feature** (a polyline with multiple segments):
- All segments of the polyline highlight together
- The user clicks points anywhere along the compound outline
- Each point is auto-assigned to the nearest sub-segment:
  - Project the click point to DXF-space
  - For each sub-segment, compute the minimum distance from the point to that segment
  - Assign to the nearest segment
- After finishing, each sub-segment gets its own fit from its bucket of points
- Sub-segments with insufficient points stay unmatched (user can add more points)

### 2.4 Point-to-segment assignment

For **line segments**: perpendicular distance from the point to the line segment
(clamped to segment endpoints).

For **arc segments**: distance from the point to the arc curve (radial distance
from center minus radius, but only if the point's angle falls within the arc span).

Both computed in image-space using the projected DXF geometry.

---

## 3. New Backend Endpoint

### 3.1 `POST /inspect-guided`

Replaces the separate `/match-dxf-lines` and `/match-dxf-arcs` calls.

**Request:**
```json
{
  "entities": [...],
  "pixels_per_mm": 12.5,
  "tx": 500, "ty": 400,
  "angle_deg": 0,
  "flip_h": false, "flip_v": false,
  "corridor_px": 15,
  "tolerance_warn": 0.10,
  "tolerance_fail": 0.25,
  "feature_tolerances": { "handle": { "warn": 0.05, "fail": 0.15 } }
}
```

**Response:**
```json
[
  {
    "handle": "ABC_s0",
    "type": "polyline_line",
    "parent_handle": "ABC",
    "matched": true,
    "edge_point_count": 47,
    "edge_points_sample": [[x,y], ...],
    "fit": { "type": "line", "x1": 510, "y1": 200, "x2": 510, "y2": 600 },
    "perp_dev_mm": 0.032,
    "angle_error_deg": 0.1,
    "tolerance_warn": 0.10,
    "tolerance_fail": 0.25,
    "pass_fail": "pass"
  },
  {
    "handle": "ABC_s1",
    "type": "polyline_arc",
    "parent_handle": "ABC",
    "matched": true,
    "edge_point_count": 23,
    "edge_points_sample": [[x,y], ...],
    "fit": { "type": "arc", "cx": 520, "cy": 190, "r": 30 },
    "center_dev_mm": 0.018,
    "radius_dev_mm": 0.045,
    "tolerance_warn": 0.10,
    "tolerance_fail": 0.25,
    "pass_fail": "pass"
  },
  {
    "handle": "DEF",
    "type": "circle",
    "matched": false,
    "edge_point_count": 3,
    "edge_points_sample": [],
    "fit": null,
    "reason": "insufficient edge points (3 < 8)"
  }
]
```

`edge_points_sample` returns up to 50 evenly-spaced points from the corridor for
visualization (not all edge pixels — that could be thousands).

### 3.2 `POST /fit-feature`

For manual point-pick: takes user-placed points + DXF entity, returns the fit.

**Request:**
```json
{
  "entity": { "type": "polyline_line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, ... },
  "points": [[510, 200], [510, 300], [511, 400], [510, 500]],
  "pixels_per_mm": 12.5,
  "tx": 500, "ty": 400,
  "angle_deg": 0,
  "flip_h": false, "flip_v": false,
  "tolerance_warn": 0.10,
  "tolerance_fail": 0.25
}
```

**Response:** Same structure as one element of `/inspect-guided` response.

---

## 4. Frontend Changes

### 4.1 "Run Inspection" button — new behavior

When DXF is loaded:
1. Calls `/inspect-guided` instead of the current detect+match pipeline
2. Populates `state.inspectionResults` from the response
3. Renders: DXF nominal (dashed cyan), fitted geometry (solid color-coded),
   edge points (subtle dots), deviation callouts
4. Unmatched features rendered with dashed red outline + "click to measure" hint

When no DXF: existing detect buttons work as before (unchanged).

### 4.2 New visual elements on canvas

| Element | Color | When shown |
|---------|-------|------------|
| DXF nominal | Dashed cyan | Always (when DXF loaded) |
| Fitted geometry (pass) | Solid green | After inspection |
| Fitted geometry (warn) | Solid amber | After inspection |
| Fitted geometry (fail) | Solid red | After inspection |
| Edge points | Small gray dots | After inspection (subtle) |
| Unmatched feature | Dashed red | After inspection |
| Point-pick points | Orange dots | During manual point-pick |
| Live fit preview | Thin dashed green | During point-pick (2+ points) |

### 4.3 Point-pick mode state

New state fields:
```js
inspectionPickTarget: null,  // DXF entity (or parent_handle for compound) being measured
inspectionPickPoints: [],    // [{x, y}, ...] placed by user
inspectionPickFit: null,     // live fit result from backend
```

### 4.4 Compound feature selection on canvas

When clicking a DXF feature in the overlay:
- If the entity has a `parent_handle`, select ALL entities with that same `parent_handle`
- Highlight all segments of the compound feature
- Point-pick mode captures points for the entire group

### 4.5 Inspection results table update

The sidebar inspection table (from M4) shows per-feature results. Add:
- **Clickable rows** for unmatched features → enters point-pick mode
- **"Re-measure"** option in context menu for any feature → enters point-pick mode
- **Status column** shows "auto" or "manual" to indicate measurement source

---

## 5. Files Changed

| File | Changes |
|------|---------|
| `backend/api.py` | New endpoints: `/inspect-guided`, `/fit-feature`. New Pydantic models. |
| `backend/vision/guided_inspection.py` | **NEW** — corridor detection, edge collection, geometry fitting, deviation computation |
| `backend/vision/detection.py` | Extract `_preprocess` for reuse. May share Canny edge computation. |
| `frontend/dxf.js` | Rewrite "Run Inspection" handler to call `/inspect-guided`. Add point-pick mode handlers. |
| `frontend/render.js` | Draw fitted geometry, edge points, unmatched highlights, point-pick dots + live preview. |
| `frontend/state.js` | Add `inspectionPickTarget`, `inspectionPickPoints`, `inspectionPickFit` fields. |
| `frontend/tools.js` | Add DXF feature click-to-select for point-pick (hit-test on projected DXF geometry). |
| `frontend/sidebar.js` | Clickable unmatched rows in inspection table. "Auto"/"Manual" badges. |
| `frontend/main.js` | Wire Enter/Escape for point-pick mode. |
| `frontend/index.html` | No structural changes expected. |

---

## 6. Migration / Backward Compatibility

- The old `/match-dxf-lines` and `/match-dxf-arcs` endpoints stay in place (not removed)
- The old "detect globally then match" workflow still works via the detect buttons
- Session format doesn't change — `inspectionResults` stores the same structure
- The new `/inspect-guided` endpoint is additive

---

## 7. What's NOT in Scope

- Spline/NURBS DXF features (only line, arc, circle, polyline segments)
- Adaptive corridor width (fixed ±15px for now; could auto-adjust based on calibration)
- Profile tolerance / GD&T (see Phase 2.5 in roadmap)
- Undo within point-pick mode (Escape to cancel and start over)
- Automatic re-inspection when DXF is dragged (manual re-run required)
- Sub-pixel edge refinement (Phase 3 scope)
