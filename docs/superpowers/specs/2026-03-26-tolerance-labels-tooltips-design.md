# Phase 2.5 + 4.5 + 4.6 — Punch/Die Tolerances, Draggable Labels, Label Tooltips

## Problem

1. Deviation colors are always pass/warn/fail — no distinction between "reworkable" and "scrap"
2. Labels overlap features and land on the wrong side, with no way to move them
3. Hovering over a label shows nothing — the detail is only in the sidebar table

## Solution

### 1. Punch/Die Tolerance Tagging

**State:** `state.featureModes` — `{ [handle]: "punch" | "die" }`. Default is `"die"` (cavity).

**Signed deviations:** The backend `guided_inspection.py` currently returns `abs(perp_dev_mm)`.
Change to return the **signed** perpendicular deviation. The sign convention:
- For lines: positive = edge is on the "outside" of the nominal (material present), negative = "inside" (material missing)
- For arcs/circles: positive `radius_dev_mm` = larger than nominal, negative = smaller

**Color logic in the frontend renderer:**

```
deviation_sign = perp_dev_mm (signed) or radius_dev_mm (signed)
magnitude = abs(deviation)

if magnitude <= tolerance_warn:
    color = green (pass)
else:
    if mode == "die":
        # Cavity: undersized (negative radius, positive perp) = rework, oversized = scrap
        reworkable = (for arcs: deviation_sign < 0) or (for lines: feature-dependent)
    elif mode == "punch":
        # Outer: oversized (positive radius, positive perp) = rework, undersized = scrap
        reworkable = (for arcs: deviation_sign > 0) or (for lines: feature-dependent)

    color = amber if reworkable else red
```

**Note on line sign convention:** For lines, "which side" depends on the feature geometry.
The signed perpendicular deviation from `_inspect_line` uses the nominal line's normal
direction. Positive perp = one side, negative = the other. The Punch/Die interpretation
needs to know which side is "material" vs "void." For compound features (slots), the
inside of the slot is void and outside is material. We can derive this from the winding
order of the polyline, or let the user set it per-feature.

**Simplest approach for v1:** Store the sign, show it in the tooltip, but for the
amber/red coloring just use the **radius deviation sign for arcs** (unambiguous:
bigger = material added, smaller = material removed) and leave lines as pass/fail
only (no amber, just green/red). This avoids the line-sign ambiguity. Add full line
support later when we have real parts to test the sign convention.

**UI:** Right-click a guided result → "Set as Punch" / "Set as Die". The tolerance
popover (already exists) can also show the current mode as a toggle.

**Persistence:** `state.featureModes` is saved in the session (add to session v2 save/load).

---

### 2. Draggable Labels

**Label offset storage:** Each guided result object gets an optional `labelOffset`
field: `{ dx: number, dy: number }` in image-space pixels. When present, the label
is drawn at `(defaultPos.x + dx, defaultPos.y + dy)` instead of `defaultPos`.

**Hit-testing:** During rendering, store each label's bounding box in a module-level
array `_labelHitBoxes` (similar to the existing `_deviationHitBoxes`). Each entry:
`{ handle, x, y, w, h }`.

**Drag interaction:** In Select mode, `onMouseDown` checks `_labelHitBoxes` before
other hit-tests. If a label is hit:
- Start drag: `state._labelDrag = { handle, startX, startY, origDx, origDy }`
- `onMouseMove`: update the result's `labelOffset.dx/dy`
- `onMouseUp`: clear drag state

**Leader line:** When a label has a non-zero offset, draw a thin gray line from the
label anchor point to the feature's reference point (line midpoint or arc center).

**Reset:** Right-click on a label → "Reset label position" (clears `labelOffset`).

**Applies to:** Guided inspection result labels. Regular measurement labels (distance,
angle, etc.) can be added later with the same pattern.

---

### 3. Label Tooltips

**Trigger:** Mouse hovers over a deviation label for 300ms (shorter than typical 500ms
since the user is inspecting and wants quick info).

**Implementation:** A single `<div id="label-tooltip">` element, positioned near the
cursor (offset by 10px). Show on hover, hide on mouse-leave or click.

**Content:**
```
Feature: 105_s2 (polyline_line)
Group: 105 (8 segments)
Mode: Die

Nominal: line (10.0, 5.0) → (30.0, 5.0)
Measured: line (512.3, 401.1) → (762.8, 400.5)

Deviation: ⊥ 0.142 mm  ∠ 0.3°
Tolerance: warn ±0.10  fail ±0.25
Result: WARN (rework)
Source: auto
```

For arcs:
```
Feature: 142_s1 (polyline_arc)
Group: 142 (9 segments)
Mode: Die

Nominal: arc r=3.00mm
Measured: arc r=3.12mm  Δcenter=0.08mm

Deviation: Δc 0.080 mm  Δr 0.119 mm
Tolerance: warn ±0.10  fail ±0.25
Result: FAIL (scrap)
Source: manual
```

**Data source:** The guided result object already contains all this information.
The DXF entity (accessible via `ann.entities.find(e => e.handle === r.handle)`)
provides the nominal geometry.

---

## Files Changed

| File | Changes |
|------|---------|
| `frontend/state.js` | Add `featureModes: {}`. Add `_labelDrag: null`. |
| `frontend/render.js` | Signed deviation coloring (green/amber/red). Label offset rendering. Leader lines. `_labelHitBoxes` array. |
| `frontend/main.js` | Label drag handlers. Label tooltip hover logic. Right-click "Set as Punch/Die" and "Reset label". |
| `frontend/session.js` | Save/load `featureModes` in session v2. |
| `frontend/index.html` | Add `<div id="label-tooltip">` element. |
| `frontend/style.css` | Tooltip styles. |
| `backend/vision/guided_inspection.py` | Return signed `perp_dev_mm` and signed `radius_dev_mm`. |

---

## What's NOT in Scope

- Line-side Punch/Die interpretation (ambiguous without winding order — arcs only for v1)
- Tolerance band visualization on canvas (Phase 2.5.4 in roadmap — separate from coloring)
- Draggable labels for regular measurements (only guided inspection results for now)
- Tooltip for regular measurement labels (only guided results for now)
