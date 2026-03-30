# GD&T: True Position

## Goal

Add True Position calculation for circular features (holes, pins, bosses),
the most commonly used GD&T callout in precision machining. Show the position
deviation as a diameter, compare against a cylindrical tolerance zone, and
display results in the standard GD&T format engineers expect.

## Context

We already measure circle centers via guided inspection (`center_dev_mm` in
the inspection results). True Position is a GD&T formalization of this: it
expresses the deviation as a diameter (not a radius), references it to a
datum coordinate system, and uses a cylindrical tolerance zone (not a
rectangular one).

The key difference from what we already do:
- Current: `center_dev_mm = 0.042` → "center is 0.042mm from nominal"
- True Position: `TP = ⌀0.084` → "center is within a ⌀0.084mm zone" (2x the distance)

True Position = 2 × √(Δx² + Δy²), where Δx and Δy are deviations in the
datum coordinate system.

## Design

### 1. Datum reference frame

True Position requires a datum system — a defined coordinate system from
which positions are measured. We already have this:

- **Origin** (`state.origin`): defines the (0,0) point and rotation angle
- **DXF alignment**: the DXF is aligned to the part, so DXF nominal
  coordinates serve as the datum positions

The datum reference frame is: origin position + origin rotation + calibration
scale. All three are already established before inspection runs.

**No changes needed** to the datum system. The existing origin + alignment
is sufficient for 2D True Position.

### 2. True Position calculation

**Backend** (`guided_inspection.py`): For circle features, add one field:

```python
# Already computed:
center_dev_mm = math.hypot(dx_px, dy_px) / ppm

# New: True Position = 2 × radial deviation
tp_dev_mm = 2.0 * center_dev_mm

# Add to result dict:
"tp_dev_mm": round(tp_dev_mm, 4),
# Also add raw pixel deviations for frontend datum decomposition:
"dx_px": round(float(dx_px), 2),
"dy_px": round(float(dy_px), 2),
```

**Frontend** (datum decomposition): The origin angle (`state.origin.angle`)
lives in the frontend and is not sent to the backend. The X/Y decomposition
into the datum frame is computed client-side when displaying results:

```js
// In sidebar.js or the inspection result mapping:
const angle = state.origin?.angle ?? 0;
const cos_a = Math.cos(-angle);
const sin_a = Math.sin(-angle);
const ppm = state.calibration.pixelsPerMm;
const datum_dx = (r.dx_px * cos_a - r.dy_px * sin_a) / ppm;
const datum_dy = (r.dx_px * sin_a + r.dy_px * cos_a) / ppm;
```

This keeps the backend origin-agnostic (it computes pixel deviations; the
frontend applies the coordinate system) and avoids adding origin_angle to
the API request body.

### 3. True Position tolerance

**Always compute TP for circles** and include it in the results. The frontend
decides how to display it. The existing `center_dev_mm` and `radius_dev_mm`
fields remain unchanged for backward compatibility.

**Pass/fail logic for circles (unchanged):** The existing logic uses
`max(center_dev_mm, abs(radius_dev_mm))` against tolerance thresholds. TP
does not replace this — it's an additional metric. A circle can pass TP but
fail on radius deviation (e.g., center is perfect but diameter is wrong).
This is correct GD&T behavior: True Position and size are independent
callouts on a drawing.

**TP-specific tolerance:** For users who want to set a TP tolerance (common
in GD&T drawings), the per-feature tolerance popover could offer a "TP
tolerance" field that applies only to `tp_dev_mm`. For the initial
implementation, the existing tolerance applies to the combined
`max(center, radius)` check — TP is displayed alongside but doesn't change
the pass/fail logic. Adding a separate TP tolerance field is a follow-up.

### 4. Frontend display

**Inspection sidebar** (`sidebar.js`):
For circle features, show both deviation formats:
- Current: "Center: 0.042mm, Radius: -0.003mm"
- New: "TP: ⌀0.084mm (X: +0.030, Y: +0.030)" — with toggle to switch views

**Canvas overlay** (`render-dxf.js`):
For circle features with TP results, show the TP value as a label: "TP ⌀0.084".
Tolerance zone visualization (dashed circle) and deviation arrow are deferred
to a follow-up — the label is sufficient for initial release.

**Frontend result mapping** (`dxf.js`):
Add `tp_dev_mm: r.tp_dev_mm ?? null, dx_px: r.dx_px ?? 0, dy_px: r.dy_px ?? 0`
to the inspection results mapping.

**CSV export** (`session.js`):
Add a `tp_dev_mm` column to the inspection CSV for circle features.

**PDF report** (`session.js`):
Include TP deviation in the results table for circle features. Format:
`TP ⌀0.084 mm` alongside the existing deviation columns.

### 5. GD&T callout format

In engineering drawings, True Position is called out as:

```
⌖ ⌀0.10 (A)(B)
```

Where ⌖ is the True Position symbol, ⌀0.10 is the tolerance zone diameter,
and (A)(B) are datum references.

We don't need to parse GD&T callouts from the DXF (that would require PMI
data, which DXF files don't contain). Instead, the user sets the tolerance
value via the existing per-feature tolerance popover, and we display the
result in the standard format.

**Feature tolerance popover enhancement:**
For circle features, add a "True Position" label and show the tolerance as
a diameter value: "TP tolerance: ⌀___mm". This makes it clear that the
tolerance applies to the cylindrical zone, not the linear deviation.

### 6. API changes

**`/inspect-guided` response**: Add `tp_dev_mm`, `dx_px`, `dy_px`
fields to circle feature results. Existing fields (`center_dev_mm`,
`radius_dev_mm`) remain unchanged for backward compatibility.

**Implementation order note:** This spec should land before Run Storage + SPC
(Spec 3), which includes `tp_dev_mm` in its database schema.

**No new endpoints needed.** TP is computed as part of the existing inspection
pipeline.

## What this does NOT include

- Datum feature detection (user defines datum via origin placement)
- Material condition modifiers (MMC, LMC — advanced GD&T concept)
- 3D True Position (Z-axis — we're 2D only)
- Other GD&T callouts (concentricity, runout, profile)
- GD&T callout parsing from DXF/STEP files
- Bonus tolerance (TP tolerance adjusted by actual feature size)
