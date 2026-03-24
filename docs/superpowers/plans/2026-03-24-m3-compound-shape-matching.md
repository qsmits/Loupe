# M3 — Compound Shape Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend DXF matching to LWPOLYLINE compound shapes (with bulge-encoded arcs), wire the frontend line/arc inspection pipeline, and add drag-to-translate for manual DXF alignment.

**Architecture:** The DXF parser decomposes LWPOLYLINE into `polyline_line`/`polyline_arc` sub-entities. The backend matching functions are extended to accept these types. The frontend gains an "Run inspection" button that calls `/match-dxf-lines` and `/match-dxf-arcs`, stores results on the `dxf-overlay` annotation, and `drawDeviations` renders the callouts.

**Tech Stack:** Python/ezdxf (backend), vanilla JS ES modules (frontend), pytest (tests)

---

## File Structure

| File | Change |
|------|--------|
| `backend/vision/dxf_parser.py` | Replace LWPOLYLINE `polyline` emission with per-segment `polyline_line`/`polyline_arc` decomposition |
| `backend/vision/line_arc_matching.py` | Extend type filters in `match_lines`/`match_arcs` to accept new types |
| `frontend/render.js` | Add `polyline_line`/`polyline_arc` to `drawDxfOverlay`; extend `drawDeviations` for line/arc callouts |
| `frontend/dxf.js` | Add "Run inspection" button handler; add drag-to-translate; reset inspection state on DXF load/clear |
| `frontend/state.js` | Add `dxfDragMode`, `dxfDragOrigin` fields |
| `frontend/index.html` | Add "Run inspection" and "Move DXF" buttons to DXF panel |
| `tests/test_dxf_parser.py` | Replace `test_parse_dxf_lwpolyline` test; add bulge decomposition tests |
| `tests/test_line_arc_matching.py` | Add tests for `polyline_line`/`polyline_arc` type acceptance |

---

### Task 1: LWPOLYLINE Bulge Parsing

**Files:**
- Modify: `backend/vision/dxf_parser.py`
- Modify: `tests/test_dxf_parser.py`

- [ ] **Step 1: Write failing tests**

In `tests/test_dxf_parser.py`, replace the existing `test_parse_dxf_lwpolyline` test (which checks for the old `polyline` type) and add the new bulge tests:

```python
import math
import os

def _make_dxf_bulge_polyline() -> bytes:
    """LWPOLYLINE with one 90° arc segment (bulge=tan(22.5°)≈0.4142) and one straight segment."""
    doc = ezdxf.new()
    msp = doc.modelspace()
    # Square with one rounded corner: (0,0) → (10,0) straight, (10,0) → (0,10) arc (90°, CCW)
    pts = [(0, 0, 0.0), (10, 0, 0.4142), (0, 10, 0.0)]
    msp.add_lwpolyline(pts, format="xyb", close=False)
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode()


def test_lwpolyline_straight_segment_emits_polyline_line():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    lines = [e for e in entities if e["type"] == "polyline_line"]
    # Segment (0,0)→(10,0) has bulge=0 → polyline_line
    assert any(
        e["x1"] == pytest.approx(0.0) and e["y1"] == pytest.approx(0.0) and
        e["x2"] == pytest.approx(10.0) and e["y2"] == pytest.approx(0.0)
        for e in lines
    )


def test_lwpolyline_bulge_segment_emits_polyline_arc():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    arcs = [e for e in entities if e["type"] == "polyline_arc"]
    assert len(arcs) == 1
    a = arcs[0]
    # 90° arc from (10,0) to (0,10): center at (0,0), r=10
    assert a["cx"] == pytest.approx(0.0, abs=0.1)
    assert a["cy"] == pytest.approx(0.0, abs=0.1)
    assert a["radius"] == pytest.approx(10.0, abs=0.1)


def test_lwpolyline_arc_has_parent_handle():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    arcs = [e for e in entities if e["type"] == "polyline_arc"]
    assert len(arcs) == 1
    assert arcs[0]["parent_handle"] is not None
    assert arcs[0]["segment_index"] == 1


def test_lwpolyline_line_has_parent_handle():
    entities = parse_dxf(_make_dxf_bulge_polyline())
    lines = [e for e in entities if e["type"] == "polyline_line"]
    assert len(lines) >= 1
    assert lines[0]["parent_handle"] is not None
    assert "segment_index" in lines[0]


def test_lwpolyline_closed_emits_n_segments():
    """Closed LWPOLYLINE with N vertices emits exactly N segments."""
    doc = ezdxf.new()
    msp = doc.modelspace()
    # Triangle, all straight
    msp.add_lwpolyline([(0,0), (10,0), (5,8)], close=True)
    buf = io.StringIO()
    doc.write(buf)
    entities = parse_dxf(buf.getvalue().encode())
    segs = [e for e in entities if e["type"] in ("polyline_line", "polyline_arc")]
    assert len(segs) == 3  # 3 vertices → 3 segments (last wraps back to first)


def test_lwpolyline_no_longer_emits_polyline_type():
    """After M3, parse_dxf should not emit the old 'polyline' type."""
    entities = parse_dxf(_make_dxf(lwpolyline=True))
    old_type = [e for e in entities if e["type"] == "polyline"]
    assert old_type == []


def test_vblock_dxf_has_polyline_arcs():
    """The demuth vblock.dxf file must produce polyline_arc entities for the 90° bulge segments."""
    dxf_path = os.path.join(os.path.dirname(__file__), "..", "demuth vblock.dxf")
    with open(dxf_path, "rb") as f:
        content = f.read()
    entities = parse_dxf(content)
    arcs = [e for e in entities if e["type"] == "polyline_arc"]
    # Two 90° arc segments (bulge=0.4142) in the V-profile LWPOLYLINE
    assert len(arcs) >= 2
    # Verify 90° arcs have the right radius (~10 mm based on the shape geometry)
    ninety_deg = [a for a in arcs if abs(a["radius"] - 10.0) < 1.0]
    assert len(ninety_deg) >= 2
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/bin/pytest tests/test_dxf_parser.py::test_lwpolyline_straight_segment_emits_polyline_line tests/test_dxf_parser.py::test_lwpolyline_bulge_segment_emits_polyline_arc tests/test_dxf_parser.py::test_lwpolyline_closed_emits_n_segments tests/test_dxf_parser.py::test_lwpolyline_no_longer_emits_polyline_type tests/test_dxf_parser.py::test_vblock_dxf_has_polyline_arcs -v 2>&1
```
Expected: FAIL (no `polyline_line`/`polyline_arc` types exist yet)

- [ ] **Step 3: Implement bulge parsing in `dxf_parser.py`**

Add the helper function and replace the LWPOLYLINE block:

```python
import math  # add to top-level imports if not already present

def _bulge_to_arc(x1: float, y1: float, x2: float, y2: float, bulge: float):
    """Convert a LWPOLYLINE bulge segment to arc parameters.
    Returns (cx, cy, r, start_angle_deg, end_angle_deg) or None if degenerate.
    Convention: CCW arc in DXF Y-up space (positive bulge = CCW).
    """
    dx, dy = x2 - x1, y2 - y1
    d = math.hypot(dx, dy)
    if d < 1e-10:
        return None
    theta = 4.0 * math.atan(abs(bulge))   # included angle of arc
    r = d / (2.0 * math.sin(theta / 2.0))
    h = r * math.cos(theta / 2.0)          # chord-midpoint to centre distance
    mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    # Left perpendicular to chord direction (CCW rotation of chord unit vector)
    perp_x, perp_y = -dy / d, dx / d
    sign = 1 if bulge > 0 else -1
    cx = mx + sign * h * perp_x
    cy = my + sign * h * perp_y
    start_deg = math.degrees(math.atan2(y1 - cy, x1 - cx))
    end_deg   = math.degrees(math.atan2(y2 - cy, x2 - cx))
    # Negative bulge → CW arc; swap to maintain CCW convention (matching ARC entities)
    if bulge < 0:
        start_deg, end_deg = end_deg, start_deg
    return cx, cy, r, start_deg, end_deg
```

Replace the `elif t == "LWPOLYLINE":` block in `parse_dxf`:

```python
elif t == "LWPOLYLINE":
    pts = list(entity.get_points("xyb"))   # (x, y, bulge) triples
    n = len(pts)
    if n < 2:
        continue
    is_closed = bool(entity.closed)
    # Iterate over segments; closed polyline wraps last→first
    seg_count = n if is_closed else n - 1
    for i in range(seg_count):
        x1, y1, bulge = pts[i]
        x2, y2, _ = pts[(i + 1) % n]
        seg_handle = f"{handle}_s{i}" if handle else None
        if abs(bulge) < 1e-9:
            entities.append({
                "type": "polyline_line",
                "x1": float(x1), "y1": float(y1),
                "x2": float(x2), "y2": float(y2),
                "handle": seg_handle,
                "parent_handle": handle,
                "segment_index": i,
            })
        else:
            arc = _bulge_to_arc(float(x1), float(y1), float(x2), float(y2), float(bulge))
            if arc is None:
                continue
            cx, cy, r, start_deg, end_deg = arc
            entities.append({
                "type": "polyline_arc",
                "cx": cx, "cy": cy, "radius": r,
                "start_angle": start_deg, "end_angle": end_deg,
                "handle": seg_handle,
                "parent_handle": handle,
                "segment_index": i,
            })
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
.venv/bin/pytest tests/test_dxf_parser.py -v 2>&1
```
Expected: all tests PASS. Note: `test_parse_dxf_lwpolyline` and `test_parse_dxf_polyline_has_handle` (old tests for the `polyline` type) will now fail — delete them; they test behaviour that no longer exists.

- [ ] **Step 5: Run full test suite to check regressions**

```bash
.venv/bin/pytest tests/ -v 2>&1
```
Expected: all pass. If `test_line_arc_api.py` or `test_align_dxf_api.py` fails because the API returns different entity types, that's expected — those tests may need minor updates to not filter on the old `polyline` type.

- [ ] **Step 6: Commit**

```bash
git add backend/vision/dxf_parser.py tests/test_dxf_parser.py
git commit -m "feat: decompose LWPOLYLINE bulge segments into polyline_line/polyline_arc"
```

---

### Task 2: Extend Backend Matching for Polyline Sub-Entities

**Files:**
- Modify: `backend/vision/line_arc_matching.py`
- Modify: `tests/test_line_arc_matching.py`

- [ ] **Step 1: Write failing tests**

Add to `tests/test_line_arc_matching.py`:

```python
def test_match_lines_accepts_polyline_line_type():
    """match_lines must match entities with type 'polyline_line'."""
    entities = [{"type": "polyline_line", "x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0,
                 "handle": "142_s0", "parent_handle": "142", "segment_index": 0}]
    detected = [{"x1": 100, "y1": 0, "x2": 200, "y2": 0, "length": 100.0}]
    results = match_lines(entities, detected, ppm=10.0, tx=100, ty=0, angle_deg=0)
    assert len(results) == 1
    assert results[0]["matched"] is True
    assert results[0]["handle"] == "142_s0"


def test_match_arcs_accepts_polyline_arc_type():
    """match_arcs must match entities with type 'polyline_arc'."""
    entities = [{"type": "polyline_arc", "cx": 0.0, "cy": 0.0, "radius": 10.0,
                 "start_angle": 0.0, "end_angle": 90.0,
                 "handle": "142_s1", "parent_handle": "142", "segment_index": 1}]
    detected = [{"cx": 0.0, "cy": 0.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}]
    results = match_arcs(entities, detected, ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert len(results) == 1
    assert results[0]["matched"] is True
    assert results[0]["handle"] == "142_s1"


def test_match_lines_skips_non_line_types():
    """match_lines must ignore arc/circle entities (unchanged behaviour)."""
    entities = [{"type": "circle", "cx": 0, "cy": 0, "radius": 5, "handle": "X"}]
    results = match_lines(entities, [], ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert results == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/bin/pytest tests/test_line_arc_matching.py::test_match_lines_accepts_polyline_line_type tests/test_line_arc_matching.py::test_match_arcs_accepts_polyline_arc_type -v 2>&1
```
Expected: FAIL

- [ ] **Step 3: Update type filters in `line_arc_matching.py`**

In `match_lines`, change:
```python
# Before:
if entity.get("type") != "line":
    continue
# After:
if entity.get("type") not in ("line", "polyline_line"):
    continue
```

In `match_arcs`, change:
```python
# Before:
if entity.get("type") != "arc":
    continue
# After:
if entity.get("type") not in ("arc", "polyline_arc"):
    continue
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/pytest tests/test_line_arc_matching.py -v 2>&1
```
Expected: all PASS

- [ ] **Step 5: Run full test suite**

```bash
.venv/bin/pytest tests/ -v 2>&1
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add backend/vision/line_arc_matching.py tests/test_line_arc_matching.py
git commit -m "feat: extend match_lines/match_arcs to accept polyline sub-entity types"
```

---

### Task 3: DXF Overlay Rendering for Polyline Sub-Entities

**Files:**
- Modify: `frontend/render.js` (the `drawDxfOverlay` function, lines ~433–457)

This is a frontend-only change; there are no backend tests. Verification is by loading `demuth vblock.dxf` and visually confirming the two arc segments render correctly.

- [ ] **Step 1: Locate the entity rendering loop in `drawDxfOverlay`**

Open `frontend/render.js`. Find `drawDxfOverlay` (around line 414). The `for (const en of entities)` loop currently handles `line`, `circle`, `arc`, `polyline`. Add two new cases.

- [ ] **Step 2: Add `polyline_line` and `polyline_arc` cases**

Inside the `for (const en of entities)` loop, after the `polyline` case (or replacing it if preferred — keep `polyline` for backward-compat with old sessions):

```js
} else if (en.type === "polyline_line") {
  ctx.moveTo(en.x1, en.y1);
  ctx.lineTo(en.x2, en.y2);
} else if (en.type === "polyline_arc") {
  const sr = en.start_angle * Math.PI / 180;
  const er = en.end_angle * Math.PI / 180;
  // Same winding logic as the 'arc' case: CCW normally, flip when exactly one of flipH/flipV is set
  ctx.arc(en.cx, en.cy, en.radius, sr, er, flipH !== flipV);
}
```

Keep the existing `polyline` case unchanged (backward-compat for old saved sessions).

- [ ] **Step 3: Verify manually**

Start the server: `./server.sh start`
Open the app, freeze a frame, load `demuth vblock.dxf`. The two curved corners of the V-profile must render as arcs, not straight diagonal lines.

- [ ] **Step 4: Commit**

```bash
git add frontend/render.js
git commit -m "feat: render polyline_line and polyline_arc entities in DXF overlay"
```

---

### Task 4: Inspection Trigger — Run Inspection Button

**Files:**
- Modify: `frontend/dxf.js`
- Modify: `frontend/state.js` (add `dxfDragMode`, `dxfDragOrigin`)
- Modify: `frontend/index.html`

This wires the "Run inspection" button that calls `/match-dxf-lines` and `/match-dxf-arcs` and stores results on `ann.lineMatchResults`/`ann.arcMatchResults`.

- [ ] **Step 1: Add new state fields to `frontend/state.js`**

In the `state` object, add after `dxfAlignHover`:
```js
dxfDragMode: false,
dxfDragOrigin: null,  // { mouseX, mouseY, annOffsetX, annOffsetY }
```

- [ ] **Step 2: Add "Run inspection" button to `frontend/index.html`**

Find the DXF controls section (search for `id="dxf-controls-group"`). After the `<button id="btn-show-deviations" ...>` line, add:

```html
          <div class="dropdown-divider"></div>
          <button class="dropdown-item" id="btn-run-inspection" disabled>Run inspection</button>
          <button class="dropdown-item" id="btn-dxf-move" disabled>Move DXF</button>
```

Insert these two lines inside `#dxf-controls-group`, after the `<button id="btn-show-deviations"...>` line and before the closing `</div>` of the group.

- [ ] **Step 3: Wire "Run inspection" in `frontend/dxf.js`**

Add the following inside `initDxfHandlers()`. Place it after the existing `btn-auto-align` handler block:

```js
// btn-run-inspection: call /match-dxf-lines and /match-dxf-arcs, store on ann
document.getElementById("btn-run-inspection")?.addEventListener("click", async () => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) { showStatus("Calibrate first"); return; }

  const ppm    = cal.pixelsPerMm;
  const tx     = ann.offsetX;
  const ty     = ann.offsetY;
  const angle  = ann.angle ?? 0;
  const flip_h = ann.flipH ?? false;
  const flip_v = ann.flipV ?? false;

  // detected-line-merged and detected-arc-partial store coordinates in the same
  // pixel space as the canvas (backend returns canvas-sized coordinates for these
  // types — no frameWidth scaling needed, unlike detected-circle/detected-line).
  const detectedLines = state.annotations
    .filter(a => a.type === "detected-line-merged")
    .map(a => ({
      x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2,
      length: Math.hypot(a.x2 - a.x1, a.y2 - a.y1),
    }));

  const detectedArcs = state.annotations
    .filter(a => a.type === "detected-arc-partial")
    .map(a => ({
      cx: a.cx, cy: a.cy, r: a.r,
      start_deg: a.start_deg, end_deg: a.end_deg,
    }));

  const lineEntities = ann.entities.filter(e =>
    e.type === "line" || e.type === "polyline_line");
  const arcEntities  = ann.entities.filter(e =>
    e.type === "arc"  || e.type === "polyline_arc");

  const tol = state.tolerances;

  try {
    const [lineRes, arcRes] = await Promise.all([
      fetch("/match-dxf-lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entities: lineEntities,
          lines: detectedLines,
          pixels_per_mm: ppm,
          tx, ty, angle_deg: angle, flip_h, flip_v,
          tolerance_warn: tol.warn,
          tolerance_fail: tol.fail,
        }),
      }),
      fetch("/match-dxf-arcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entities: arcEntities,
          arcs: detectedArcs,
          pixels_per_mm: ppm,
          tx, ty, angle_deg: angle, flip_h, flip_v,
          tolerance_warn: tol.warn,
          tolerance_fail: tol.fail,
        }),
      }),
    ]);

    if (!lineRes.ok || !arcRes.ok) {
      showStatus("Inspection failed — check console");
      return;
    }

    ann.lineMatchResults = await lineRes.json();
    ann.arcMatchResults  = await arcRes.json();

    redraw();
    showStatus(`Inspection complete — ${ann.lineMatchResults.length} lines, ${ann.arcMatchResults.length} arcs`);
  } catch (err) {
    showStatus("Inspection error: " + err.message);
  }
});
```

- [ ] **Step 4: Enable "Run inspection" button when DXF is loaded**

In `updateDxfControlsVisibility` (in `sidebar.js`), the button must be enabled when a `dxf-overlay` annotation exists. Find the existing pattern (e.g., `btn-auto-align` is enabled there) and add:

```js
const inspBtn = document.getElementById("btn-run-inspection");
if (inspBtn) inspBtn.disabled = !ann;
const moveBtn = document.getElementById("btn-dxf-move");
if (moveBtn) moveBtn.disabled = !ann;
```

- [ ] **Step 5: Reset match results when DXF is cleared or reloaded**

In the `btn-dxf-clear` handler in `dxf.js`, after filtering out the dxf-overlay annotation, add:
```js
// Clear stale inspection state
state.inspectionResults = [];
state.inspectionFrame = null;
state.dxfFilename = null;
```

In the `dxf-input change` handler, before `addAnnotation(...)`, add:
```js
state.inspectionResults = [];
state.inspectionFrame = null;
state.dxfFilename = file.name.replace(/\.dxf$/i, "");
```

These fields are also needed by M4. Add them to `frontend/state.js` now (in the `state` object, after `featureTolerances`):

```js
inspectionResults: [],   // populated by "Run inspection"; persisted in session v2
inspectionFrame: null,   // base64 JPEG of composited camera+overlay at inspection time
dxfFilename: null,       // set from DXF filename on load; cleared on DXF clear
```

- [ ] **Step 6: Verify manually**

1. Load a DXF, detect lines and arcs, click "Run inspection"
2. Check browser console — no errors
3. Check that `ann.lineMatchResults` / `ann.arcMatchResults` are populated (add a `console.log` temporarily if needed)

- [ ] **Step 7: Commit**

```bash
git add frontend/dxf.js frontend/state.js frontend/index.html frontend/sidebar.js
git commit -m "feat: add Run Inspection button wiring match-dxf-lines and match-dxf-arcs"
```

---

### Task 5: Drag-to-Translate

**Files:**
- Modify: `frontend/dxf.js` (add drag mode button + canvas drag handler)
- Modify: `frontend/main.js` (integrate drag into mouse event handlers)

- [ ] **Step 1: Wire "Move DXF" button toggle in `dxf.js`**

Inside `initDxfHandlers()`, add after the inspection button handler:

```js
// btn-dxf-move: toggle drag-to-translate mode
document.getElementById("btn-dxf-move")?.addEventListener("click", () => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  state.dxfDragMode = !state.dxfDragMode;
  state.dxfDragOrigin = null;
  document.getElementById("btn-dxf-move")?.classList.toggle("active", state.dxfDragMode);
  showStatus(state.dxfDragMode ? "Drag to reposition DXF overlay" : (state.frozen ? "Frozen" : "Live"));
});
```

- [ ] **Step 2: Add Escape key to exit drag mode**

In `frontend/main.js`, find the existing `keydown` handler (search for `"Escape"`). Add:

```js
if (e.key === "Escape") {
  // ... existing escape handling ...
  if (state.dxfDragMode) {
    state.dxfDragMode = false;
    state.dxfDragOrigin = null;
    document.getElementById("btn-dxf-move")?.classList.remove("active");
    showStatus(state.frozen ? "Frozen" : "Live");
  }
}
```

- [ ] **Step 3: Add drag logic to `onMouseDown` in `main.js`**

Find `function onMouseDown(e)`. At the top of the function (before any other handling), add:

```js
if (state.dxfDragMode) {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (ann) {
    const pt = canvasPoint(e);
    state.dxfDragOrigin = {
      mouseX: pt.x, mouseY: pt.y,
      annOffsetX: ann.offsetX, annOffsetY: ann.offsetY,
    };
  }
  return;  // consume event — don't fall through to tool handlers
}
```

- [ ] **Step 4: Add drag motion to `onMouseMove` in `main.js`**

Find `function onMouseMove(e)` (or wherever `mousemove` is handled). Add at the top:

```js
if (state.dxfDragMode && state.dxfDragOrigin) {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (ann) {
    const pt = canvasPoint(e);
    ann.offsetX = state.dxfDragOrigin.annOffsetX + (pt.x - state.dxfDragOrigin.mouseX);
    ann.offsetY = state.dxfDragOrigin.annOffsetY + (pt.y - state.dxfDragOrigin.mouseY);
    redraw();
  }
  return;
}
```

- [ ] **Step 5: Clear drag origin on `onMouseUp`**

Find `function onMouseUp(e)`. Add:

```js
if (state.dxfDragMode) {
  state.dxfDragOrigin = null;
  return;
}
```

- [ ] **Step 6: Verify manually**

1. Load a DXF, click "Move DXF" button (button activates)
2. Drag the canvas — the DXF overlay shifts with the mouse
3. Release — overlay stays at new position
4. Press Escape — drag mode deactivates, button un-highlights

- [ ] **Step 7: Commit**

```bash
git add frontend/dxf.js frontend/main.js frontend/state.js
git commit -m "feat: add drag-to-translate for DXF overlay (Move DXF button)"
```

---

### Task 6: Extend `drawDeviations` for Line and Arc Callouts

**Files:**
- Modify: `frontend/render.js` (the `drawDeviations` function, lines ~867–925)

- [ ] **Step 1: Read the existing `drawDeviations` function**

Open `frontend/render.js` at line ~867. The function currently calls `matchDxfToDetected(ann)` for circles and renders callouts. We'll add two new loops after the existing circle loop.

Also read `dxfToCanvas(x, y, ann)` at line ~462 — you'll use it to convert DXF coordinates to canvas pixels.

- [ ] **Step 2: Add line deviation callouts**

After the closing `}` of the existing circle loop in `drawDeviations`, add:

```js
// ── Line deviation callouts ────────────────────────────────────────────────
for (const r of (ann.lineMatchResults ?? [])) {
  // Find the DXF entity for this result to get its nominal position
  const en = ann.entities?.find(e => e.handle === r.handle);
  if (!en) continue;
  const mx_mm = (en.x1 + en.x2) / 2;
  const my_mm = (en.y1 + en.y2) / 2;
  const nominal = dxfToCanvas(mx_mm, my_mm, ann);

  const tol = (r.handle && state.featureTolerances[r.handle]) || state.tolerances;
  const color = r.pass_fail === "fail" ? "#ff453a"
    : r.pass_fail === "warn" ? "#ff9f0a"
    : r.pass_fail === "pass" ? "#32d74b"
    : "#636366";

  ctx.save();
  ctx.fillStyle = color;
  ctx.font = "10px ui-monospace, monospace";

  if (!r.matched) {
    ctx.fillStyle = "#636366";
    ctx.fillText("not detected", nominal.x + 4, nominal.y);
  } else {
    const label = en.parent_handle
      ? `P${en.parent_handle}-s${en.segment_index ?? ""}`
      : (r.handle ?? "");
    const devText = `⊥ ${r.perp_dev_mm?.toFixed(3)} mm`;
    const angText = r.angle_error_deg != null ? `  ∠ ${r.angle_error_deg.toFixed(1)}°` : "";
    const text = `${devText}${angText}`;
    ctx.fillText(text, nominal.x + 4, nominal.y - 4);
    const textW = ctx.measureText(text).width;
    _deviationHitBoxes.push({ handle: r.handle, x: nominal.x + 4, y: nominal.y - 14, w: textW, h: 14 });

    // Small crosshair at nominal midpoint
    ctx.strokeStyle = "#0a84ff";
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(nominal.x - 5, nominal.y); ctx.lineTo(nominal.x + 5, nominal.y);
    ctx.moveTo(nominal.x, nominal.y - 5); ctx.lineTo(nominal.x, nominal.y + 5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ── Arc deviation callouts ─────────────────────────────────────────────────
for (const r of (ann.arcMatchResults ?? [])) {
  const en = ann.entities?.find(e => e.handle === r.handle);
  if (!en) continue;
  const nominal = dxfToCanvas(en.cx, en.cy, ann);
  const r_px = (en.radius ?? 0) * (ann.scale ?? 1);

  const tol = (r.handle && state.featureTolerances[r.handle]) || state.tolerances;
  const dev = Math.max(r.center_dev_mm ?? 0, r.radius_dev_mm ?? 0);
  const color = r.pass_fail === "fail" ? "#ff453a"
    : r.pass_fail === "warn" ? "#ff9f0a"
    : r.pass_fail === "pass" ? "#32d74b"
    : "#636366";

  ctx.save();
  if (!r.matched) {
    ctx.strokeStyle = "#636366";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(nominal.x, nominal.y, r_px, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#636366";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("not detected", nominal.x + r_px + 4, nominal.y);
  } else {
    // Nominal arc dashed
    ctx.strokeStyle = "#0a84ff";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(nominal.x, nominal.y, r_px, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.font = "10px ui-monospace, monospace";
    const labelX = nominal.x + r_px + 4;
    const label = en.parent_handle
      ? `P${en.parent_handle}-s${en.segment_index ?? ""}`
      : (r.handle ?? "");
    const devText = `Δ ${r.center_dev_mm?.toFixed(3)} mm  Δr ${r.radius_dev_mm?.toFixed(3)} mm`;
    ctx.fillText(devText, labelX, nominal.y);
    const textW = ctx.measureText(devText).width;
    _deviationHitBoxes.push({ handle: r.handle, x: labelX, y: nominal.y - 10, w: textW, h: 14 });
  }
  ctx.restore();
}
```

- [ ] **Step 3: Verify manually**

1. Load DXF, detect lines and arcs, run inspection
2. `state.showDeviations` should be `true` (set by auto-align); if not, click "Deviations: on"
3. Line entities should show `⊥ X.XXX mm` callouts near their midpoints
4. Arc entities should show `Δ X.XXX mm  Δr X.XXX mm` callouts near their centre
5. Unmatched features should show "not detected" in grey

- [ ] **Step 4: Run full test suite (no regressions)**

```bash
.venv/bin/pytest tests/ -v 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add frontend/render.js
git commit -m "feat: extend drawDeviations with line and arc deviation callouts"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
.venv/bin/pytest tests/ -v 2>&1
```
Expected: all pass

- [ ] **Step 2: End-to-end smoke test with `demuth vblock.dxf`**

1. Start server: `./server.sh start`
2. Open app, freeze a live or snapshot frame
3. Load `demuth vblock.dxf` — the two curved arc segments in the V profile must render as arcs
4. Auto-align (requires circles in the image) OR drag-to-translate to position the DXF
5. Detect lines merged + detect arcs partial
6. Click "Run inspection" — callouts appear for matched lines and arcs
7. Save and reload session — DXF overlay reloads but `lineMatchResults`/`arcMatchResults` are not persisted (they are runtime-only; re-run inspection after loading)

Note: Session persistence of inspection results is M4 scope.

- [ ] **Step 3: Commit if any last-minute fixes needed**

```bash
git add -p
git commit -m "fix: <description>"
```
