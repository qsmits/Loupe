# DXF Matching & Deviation Display Design

## Goal

Automatically align a loaded DXF overlay to the detected circles in the camera image, then display visual deviation indicators showing how far each detected feature is from its DXF nominal position.

**Tech stack:** Vanilla JS + HTML5 frontend (no build step). Python/FastAPI backend with NumPy for the alignment algorithm.

---

## Overview

The feature adds three capabilities on top of the existing DXF overlay:

1. **Rotation support** — extend the existing overlay transform to include an angle, with manual nudge controls
2. **Auto-alignment** — a new backend endpoint that uses RANSAC to find the best-fit (translation + rotation + flip) mapping DXF circles onto detected circles
3. **Deviation display** — a frontend-only toggle that draws matched nominal/detected circle pairs with colour-coded deviation labels

---

## Layout & UI Changes

### Overlay menu additions

The existing `Overlay ▾` dropdown gains two new items below the current DXF controls:

- **Auto-align** — enabled whenever a DXF overlay is loaded and at least 2 DXF circles are present. If no detected circles exist when clicked, the app automatically runs circle detection first (freezing the frame if needed), then proceeds with alignment. If auto-detection finds zero circles, an inline error message is shown: "No circles detected — run detection manually first." If the DXF has fewer than 2 circles, the button is disabled with tooltip "At least 2 DXF circles required".
- **Show deviations** — toggle; only enabled after a successful alignment. When re-alignment is run while this toggle is on, the deviation view redraws immediately with the new alignment result without requiring the user to re-toggle.

### DXF controls panel

A rotation row is added below the existing scale/flip controls:

- Rotation readout showing current angle in degrees (e.g. `12.4°`)
- `−1°` / `+1°` nudge buttons and a `−5°` / `+5°` pair for coarser adjustment
- Each nudge is individually recorded to the undo stack via the existing `pushUndo()` mechanism
- The existing point-to-point realign button remains for manual fallback

### Settings dialog — new Tolerances tab

A new **Tolerances** tab is added as the last tab in the Settings dialog. Contains two fields:

| Field | Default | Description |
|---|---|---|
| Warn threshold | 0.10 mm | Deviations above this are shown orange |
| Fail threshold | 0.25 mm | Deviations above this are shown red |

Both values are saved to `config.json` and loaded at startup.

---

## Alignment Algorithm (`backend/vision/alignment.py`)

### Endpoint

`POST /align-dxf`

**Request body:**
```json
{
  "entities": [...],
  "circles": [{"x": 120, "y": 340, "radius": 45}, ...],
  "pixels_per_mm": 23.8
}
```

`entities` is the raw DXF entity list (as returned by `/load-dxf`). The backend filters to circles only server-side — the frontend sends the full entity list without pre-filtering. `pixels_per_mm` is required; the scale-free case (no calibration) is out of scope for this iteration and returns HTTP 400 if omitted.

**Response — success:**
```json
{
  "tx": 214.5,
  "ty": 189.2,
  "angle_deg": -17.3,
  "scale": 23.8,
  "flip_h": false,
  "flip_v": true,
  "inlier_count": 8,
  "total_dxf_circles": 11,
  "confidence": "high"
}
```

`confidence` is `"high"` (inlier_count ≥ 50% of total_dxf_circles), `"low"` (≥ 2 inliers but < 50%), or `"failed"` (< 2 inliers). The frontend applies the result in all cases but shows an inline warning banner for `"low"` and `"failed"`.

**Response — input errors (HTTP 400):**
- Fewer than 2 DXF circles found in `entities`: `{"detail": "At least 2 DXF circles required for alignment"}`
- `pixels_per_mm` missing or zero: `{"detail": "Calibration required for alignment"}`

### Algorithm steps

1. Filter `entities` to type `"circle"`. If fewer than 2 remain, return HTTP 400.
2. Scale DXF circle centres to pixels using `pixels_per_mm`. Rotation is applied around the DXF file coordinate origin (0, 0), which is the natural pivot for all entity coordinates.
3. For each of the 4 flip variants (`none`, `flipH`, `flipV`, `both`):
   a. Apply the flip to DXF circle centres.
   b. For each pair of DXF circles, for each pair of detected circles whose radius ratio is compatible (within 30%), compute the candidate transform (tx, ty, angle) that maps the DXF pair onto the detected pair.
   c. Score the candidate: count how many DXF circles land within `max(10px, 0.15 × r_dxf_px)` of a detected circle. This is the alignment inlier threshold — intentionally tight to avoid false matches during the search phase.
   d. Track the highest-scoring transform for this flip variant.
4. Pick the best transform across all 4 flip variants.
5. Refine with one round of least-squares over all inliers.
6. Return the result with `inlier_count`, `total_dxf_circles`, and `confidence`.

**Complexity:** O(n² · m²) where n = DXF circles, m = detected circles. For n ≤ 20 and m ≤ 50 this is well under one second on CPU.

---

## Deviation Display (frontend only)

After alignment, the "Show deviations" toggle triggers a matching pass and redraws. This uses a looser proximity tolerance than the alignment inlier threshold (see below) so that features slightly outside the tight RANSAC window are still shown to the user rather than silently omitted.

### Matching

For each DXF circle (transformed to canvas coordinates):
- Find the nearest detected circle whose centre is within `max(10px, 0.5 × r_dxf_px)`. This looser threshold (vs the alignment's 0.15×) is intentional: the alignment needs tight inliers for a correct transform; the deviation display should show all plausible matches so the user can see what was found.
- If a match is found: compute Δxy (centre distance in mm) and Δr (radius difference in mm).
- If no match: mark as undetected.

### Visual indicators

Each DXF circle is drawn in one of three states:

**Matched — within tolerance:**
- Dashed blue circle at the DXF nominal position with a crosshair at its centre
- Solid green circle at the detected position with a filled dot at its centre
- Label: `Δ 0.04 mm` in green, positioned outside the detected circle
- If Δr also exceeds `tolerance_warn`: a separate `Δr 0.xx mm` line is shown below the Δxy label. The same `tolerance_warn` threshold used for colour is used for this label visibility condition.

**Matched — warn or fail:**
- Same as above but circle stroke and label are orange (warn) or red (fail)
- Colour is determined by `max(Δxy, Δr)`

**Unmatched:**
- Dashed grey circle at DXF nominal position with crosshair, muted
- Label: `not detected` in muted grey

### Colour thresholds

| Condition | Colour |
|---|---|
| Δ ≤ `tolerance_warn` | `--success` (#30d158) |
| `tolerance_warn` < Δ ≤ `tolerance_fail` | `--warning` (#ff9f0a) |
| Δ > `tolerance_fail` | `--danger` (#ff453a) |
| Not detected | `--muted` (#636366) |

---

## Configuration (`config.json`)

Two new keys added to `_DEFAULTS` in `backend/config.py`:

```json
{
  "tolerance_warn": 0.10,
  "tolerance_fail": 0.25
}
```

Exposed via `GET /config/tolerances` and `POST /config/tolerances` following the same pattern as `/config/ui`.

---

## Transform Representation

The `dxf-overlay` annotation gains an `angle` field (degrees, default 0). The `dxfToCanvas()` function is updated to apply rotation around the DXF coordinate origin (0, 0) — before the Y-flip — consistent with how the alignment algorithm applies rotation. This means rotating the overlay rotates it around the DXF file's own origin, which is the natural centre of the coordinate system in all DXF files.

The `angle` field is included when the annotation is serialised for session save/load (JSON). Rotation nudge operations push to the undo stack individually via the existing `pushUndo()` mechanism.

---

## Files Changed

| File | Change |
|---|---|
| `backend/vision/alignment.py` | New — RANSAC circle alignment algorithm |
| `backend/config.py` | Add `tolerance_warn` and `tolerance_fail` to `_DEFAULTS` |
| `backend/api.py` | Add `POST /align-dxf`; add `GET /config/tolerances` + `POST /config/tolerances` |
| `frontend/index.html` | Add Tolerances tab to Settings dialog; add Auto-align + Show deviations to Overlay menu; add rotation row to DXF controls |
| `frontend/style.css` | Styles for Tolerances tab, deviation labels |
| `frontend/app.js` | Rotation in `dxfToCanvas()`; wire up auto-align; deviation matching + drawing; load/save tolerances; session serialisation includes `angle` field |
| `tests/test_alignment.py` | New — unit tests for alignment algorithm with known circle sets and transforms |

---

## Out of Scope

- Deviation reporting (CSV / PDF export) — future iteration
- Matching non-circle features (lines, arcs) to detected edges
- Per-feature tolerance overrides
- Auto-alignment without calibration (scale-free case)
