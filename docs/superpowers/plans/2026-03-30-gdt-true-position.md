# GD&T True Position — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add True Position (TP = 2 × radial deviation) calculation for circular features, displayed alongside existing center/radius deviations in the sidebar, CSV, and PDF reports.

**Architecture:** Backend adds `tp_dev_mm` and raw pixel deviations (`dx_px`, `dy_px`) to circle inspection results. Frontend maps these into state, displays TP in sidebar with a tooltip, and includes TP in CSV/PDF exports. The datum-frame X/Y decomposition is computed client-side using `state.origin.angle`.

**Tech Stack:** Python (backend computation), vanilla JS (frontend display)

**Spec:** `docs/superpowers/specs/2026-03-30-gdt-true-position-design.md`

---

## File Map

### Files to modify
| File | Changes |
|------|---------|
| `backend/vision/guided_inspection.py` | Add `tp_dev_mm`, `dx_px`, `dy_px` to circle result dict |
| `tests/test_guided_inspection.py` | Add TP-specific tests |
| `frontend/dxf.js` | Map new fields into `state.inspectionResults` |
| `frontend/sidebar.js` | Display TP for circle features in inspection table |
| `frontend/session.js` | Add TP to CSV and PDF exports |
| `frontend/events-inspection.js` | Map TP fields in manual point-pick results |

---

### Task 1: Backend — compute True Position + raw pixel deviations

**Files:**
- Modify: `backend/vision/guided_inspection.py`
- Modify: `tests/test_guided_inspection.py`

- [ ] **Step 1: Write failing tests for True Position**

Add to `tests/test_guided_inspection.py`:

```python
class TestTruePosition:
    def test_circle_has_tp_dev_mm(self):
        """Circle inspection results should include tp_dev_mm field."""
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=80)
        entity = {
            "handle": "C1", "type": "circle", "parent_handle": None,
            "cx": 0, "cy": 0, "radius": 80,
        }
        results = inspect_features(
            frame, [entity], pixels_per_mm=1.0,
            tx=300, ty=240, corridor_px=15,
            canny_low=30, canny_high=100,
        )
        r = results[0]
        assert "tp_dev_mm" in r
        assert r["tp_dev_mm"] is not None
        # TP = 2 × center deviation
        assert abs(r["tp_dev_mm"] - 2 * r["center_dev_mm"]) < 0.001

    def test_circle_has_dx_dy_px(self):
        """Circle results should include raw pixel deviations dx_px, dy_px."""
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=80)
        entity = {
            "handle": "C1", "type": "circle", "parent_handle": None,
            "cx": 0, "cy": 0, "radius": 80,
        }
        results = inspect_features(
            frame, [entity], pixels_per_mm=1.0,
            tx=300, ty=240, corridor_px=15,
            canny_low=30, canny_high=100,
        )
        r = results[0]
        assert "dx_px" in r
        assert "dy_px" in r
        # Verify: sqrt(dx² + dy²) ≈ center_dev_mm * ppm (ppm=1 here)
        import math
        radial = math.hypot(r["dx_px"], r["dy_px"])
        assert abs(radial - r["center_dev_mm"]) < 0.1

    def test_line_has_no_tp(self):
        """Line inspection results should have tp_dev_mm = None."""
        frame = _make_blank_frame(color=0)
        # Use _draw_horizontal_line helper (add to test file if not present):
        # def _draw_horizontal_line(frame, y, x1, x2, color=255, thickness=2):
        #     frame = frame.copy(); cv2.line(frame, (x1,y), (x2,y), (color,color,color), thickness); return frame
        frame = _draw_horizontal_line(frame, y=240, x1=100, x2=500)
        entity = {
            "handle": "L1", "type": "line", "parent_handle": None,
            "x1": -200, "y1": 0, "x2": 200, "y2": 0,
        }
        results = inspect_features(
            frame, [entity], pixels_per_mm=1.0,
            tx=300, ty=240, corridor_px=15,
            canny_low=30, canny_high=100,
        )
        r = results[0]
        assert r.get("tp_dev_mm") is None
        assert r.get("dx_px") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_guided_inspection.py::TestTruePosition -v`
Expected: FAIL (KeyError or AssertionError on missing fields)

- [ ] **Step 3: Add TP fields to circle results in `guided_inspection.py`**

In `_inspect_arc_circle()`, after the existing `center_dev_mm` and `radius_dev_mm` computation (around lines 332-336), add:

```python
# True Position = 2 × radial deviation (diameter of deviation zone)
tp_dev_mm = 2.0 * center_dev_mm

# Raw pixel deviations for frontend datum-frame decomposition
dx_px = float(fit_cx - cx_px)
dy_px = float(fit_cy - cy_px)
```

Add to the return dict (around lines 364-380):
```python
"tp_dev_mm": round(tp_dev_mm, 4),
"dx_px": round(dx_px, 2),
"dy_px": round(dy_px, 2),
```

Also add to the `_unmatched()` return dict and the line result dict:
```python
"tp_dev_mm": None,
"dx_px": None,
"dy_px": None,
```

This ensures ALL result dicts have the same fields (consistent schema).

Check `_inspect_line()` return dict too — add the three fields as `None`.

In `fit_manual_points()` (around line 588), for the **circle branch** of the
return dict, add the same computation:
```python
tp_dev_mm = 2.0 * center_dev_mm
dx_px = float(fit_cx - cx_px)
dy_px = float(fit_cy - cy_px)
# Add to return dict:
"tp_dev_mm": round(tp_dev_mm, 4),
"dx_px": round(dx_px, 2),
"dy_px": round(dy_px, 2),
```

For the **line branch** (around line 533) and the `_unmatched()` helper,
add: `"tp_dev_mm": None, "dx_px": None, "dy_px": None`.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_guided_inspection.py -v`
Expected: All pass (existing + new TP tests)

- [ ] **Step 5: Commit**

```bash
git add backend/vision/guided_inspection.py tests/test_guided_inspection.py
git commit -m "feat: add True Position (tp_dev_mm) + raw pixel deviations to circle inspection results"
```

---

### Task 2: Frontend — map, display, and export True Position

**Files:**
- Modify: `frontend/dxf.js`
- Modify: `frontend/sidebar.js`
- Modify: `frontend/session.js`

- [ ] **Step 1: Map new fields in `dxf.js`**

In the inspection results `.map()` call (around line 456-467), add the new fields:

```js
state.inspectionResults = results.map(r => ({
    handle: r.handle,
    type: r.type,
    parent_handle: r.parent_handle,
    matched: r.matched,
    deviation_mm: r.perp_dev_mm ?? r.center_dev_mm ?? null,
    angle_error_deg: r.angle_error_deg ?? null,
    tolerance_warn: r.tolerance_warn ?? state.tolerances.warn,
    tolerance_fail: r.tolerance_fail ?? state.tolerances.fail,
    pass_fail: r.pass_fail,
    source: "auto",
    // True Position (circles only)
    tp_dev_mm: r.tp_dev_mm ?? null,
    dx_px: r.dx_px ?? null,
    dy_px: r.dy_px ?? null,
    center_dev_mm: r.center_dev_mm ?? null,
    radius_dev_mm: r.radius_dev_mm ?? null,
}));
```

Also add the same fields to the manual point-pick result mapping (search for
`source: "manual"` in dxf.js — there should be a similar mapping for
`/fit-feature` results).

- [ ] **Step 2: Display TP in sidebar inspection table**

In `frontend/sidebar.js`, in `renderInspectionTable()`, find where the
deviation text is formatted (around line 638). For circle features, show
TP alongside the existing deviation:

```js
let deviationText = "—";
if (r.matched && r.deviation_mm != null) {
    deviationText = r.deviation_mm.toFixed(4) + " mm";
    // Add TP for circle features
    if (r.tp_dev_mm != null) {
        deviationText += `  TP ⌀${r.tp_dev_mm.toFixed(4)}`;
    }
}
```

Add a tooltip on the deviation cell for circle features that explains TP
and shows the X/Y decomposition in the datum frame:

```js
// In the deviation cell rendering:
let deviationTitle = "";
if (r.tp_dev_mm != null && r.dx_px != null) {
    const angle = state.origin?.angle ?? 0;
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    const ppm = state.calibration?.pixelsPerMm || 1;
    const datumDx = (r.dx_px * cosA - r.dy_px * sinA) / ppm;
    // Y-axis flip: image Y is down, drawing Y is up
    const datumDy = -(r.dx_px * sinA + r.dy_px * cosA) / ppm;
    deviationTitle = `True Position: ⌀${r.tp_dev_mm.toFixed(4)} mm\n` +
        `Center deviation: ${r.deviation_mm.toFixed(4)} mm\n` +
        `Datum X: ${datumDx >= 0 ? "+" : ""}${datumDx.toFixed(4)} mm\n` +
        `Datum Y: ${datumDy >= 0 ? "+" : ""}${datumDy.toFixed(4)} mm`;
}
```

Apply as `title="..."` on the deviation `<td>` element.

- [ ] **Step 3: Add TP to CSV export**

In `frontend/session.js`, in `exportInspectionCsv()` (around line 121),
add `tp_dev_mm` to the CSV headers:

```js
const headers = [
    "part_name", "timestamp", "feature_id", "feature_type",
    "deviation_mm", "tp_dev_mm", "angle_error_deg",
    "tolerance_warn", "tolerance_fail", "result", "notes"
];
```

And in the data rows (around line 135):
```js
r.tp_dev_mm != null ? r.tp_dev_mm.toFixed(4) : "",
```

- [ ] **Step 4: Add TP to PDF export**

In `frontend/session.js`, in `exportInspectionPdf()`, in the detail row
rendering for inspection results, add TP to the deviation text for circle
features:

```js
let deviationText = r.matched && r.deviation_mm != null
    ? r.deviation_mm.toFixed(4) + " mm" : "—";
if (r.tp_dev_mm != null) {
    deviationText += `  TP ⌀${r.tp_dev_mm.toFixed(4)}`;
}
```

- [ ] **Step 5: Run all tests**

```bash
python3 -m pytest tests/test_guided_inspection.py -v
node --test tests/frontend/test_*.js
```

- [ ] **Step 6: Manual smoke test**

1. Load DXF with circles, calibrate, align, run inspection
2. Check sidebar: circle features show "0.0420 mm  TP ⌀0.0840"
3. Hover over deviation: tooltip shows datum X/Y decomposition
4. Export CSV: verify `tp_dev_mm` column exists with values for circles
5. Export PDF: verify TP shown in deviation column for circles

- [ ] **Step 7: Commit**

```bash
git add frontend/dxf.js frontend/sidebar.js frontend/session.js frontend/events-inspection.js
git commit -m "feat: display True Position in sidebar, CSV, and PDF for circle features"
```

---

## Final Verification

```bash
python3 -m pytest tests/ -q           # all backend tests
node --test tests/frontend/test_*.js  # all frontend tests
```

### Manual test checklist
- [ ] Circle features show TP ⌀ value in sidebar
- [ ] Line features show only perpendicular deviation (no TP)
- [ ] Hover tooltip shows datum X/Y decomposition
- [ ] CSV has `tp_dev_mm` column
- [ ] PDF shows TP alongside deviation for circles
- [ ] Unmatched features show "—" for TP
- [ ] Manual point-pick circle fit also returns TP

### Deferred to follow-up
- Sidebar toggle between center/radius view and TP view (inline display is sufficient for v1)
- Canvas overlay TP label on circle features (sidebar + tooltip covers initial needs)
- Separate TP tolerance field in per-feature popover (existing tolerance applies to combined check)
- CSV datum X/Y columns (tp_dev_mm column is sufficient for v1)
