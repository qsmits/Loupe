# Inspection UX Polish (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the circle-based inspection workflow feel excellent by adding per-feature tolerance overrides keyed by DXF handle, making deviation callouts appear automatically after alignment, and cleaning up the measurement panel.

**Architecture:** The DXF handle is exposed by ezdxf as `entity.dxf.handle` (a hex string like `"1A2"`); adding it to every entity dict in `dxf_parser.py` gives every DXF circle a stable identity that survives DXF reloads. Per-feature tolerances live entirely in the frontend as `state.featureTolerances` (a JS object keyed by handle string), serialised into the session JSON alongside annotations — no new API endpoints needed. The always-on deviation display is a two-line change: set `state.showDeviations = true` in the alignment success path and update the button label; the existing `redraw()` that already follows alignment handles the repaint.

**Tech Stack:** Python 3.11, FastAPI, ezdxf, Vanilla JS (ES2022), Canvas 2D API, pytest, httpx/TestClient.

---

## Scope

Four deliverables, each independently shippable:

1. **DXF handle in parser** — backend, fully tested. Prerequisite for everything else.
2. **Per-feature tolerance config** — frontend-only, no new API, stored in session JSON.
3. **Always-on deviation display** — frontend-only, two-line change.
4. **Arc measurement tool** — stretch goal, entirely independent of 1–3. Defer to M2 if timeline is at risk.

---

## File map

| File | Change |
|------|--------|
| `backend/vision/dxf_parser.py` | Add `"handle"` key to every entity dict |
| `tests/test_dxf_parser.py` | Tests: handle is string or None; handles are unique across entities |
| `frontend/app.js` | Add `state.featureTolerances`; update `saveSession`/`loadSession`; update `deviationColor` to accept handle; update `drawDeviations` for handle-aware tolerance and hit-box tracking; update `matchDxfToDetected` to pass handle through; set `showDeviations = true` after alignment; per-feature popover open/close logic; mousedown hit-test for deviation labels |
| `frontend/index.html` | Add `#feature-tol-popover` div; update `#btn-show-deviations` initial label |
| `tests/test_arc_measurement.py` | (stretch) Pure-Python unit tests for circumscribed circle math and arc span angle |

No new Python files. No new API routes. Session version stays at `1` — `featureTolerances` is an optional key that defaults to `{}` on load, so old sessions load cleanly without bumping the version.

---

## Task 1: Add `handle` field to DXF parser

**Files:**
- Modify: `backend/vision/dxf_parser.py`
- Modify: `tests/test_dxf_parser.py`

### Background

ezdxf assigns every modelspace entity a DXF handle — a short hex string. Access it via `entity.dxf.handle`. Some synthetic or malformed entities may lack one; guard with `getattr(entity.dxf, "handle", None)`.

`parse_dxf` iterates `msp` and builds one dict per entity inside a `try/except` block. Add one line at the top of the loop body to read the handle, then add `"handle": handle` to each of the four entity dicts.

- [ ] **Step 1: Write failing tests**

Add to `tests/test_dxf_parser.py`:

```python
def test_parse_dxf_circle_has_handle():
    entities = parse_dxf(_make_dxf(circle=True))
    circles = [e for e in entities if e["type"] == "circle"]
    assert "handle" in circles[0]
    h = circles[0]["handle"]
    assert h is None or (isinstance(h, str) and len(h) > 0)


def test_parse_dxf_line_has_handle():
    entities = parse_dxf(_make_dxf(line=True))
    lines = [e for e in entities if e["type"] == "line"]
    assert "handle" in lines[0]


def test_parse_dxf_arc_has_handle():
    entities = parse_dxf(_make_dxf(arc=True))
    arcs = [e for e in entities if e["type"] == "arc"]
    assert "handle" in arcs[0]


def test_parse_dxf_polyline_has_handle():
    entities = parse_dxf(_make_dxf(lwpolyline=True))
    polys = [e for e in entities if e["type"] == "polyline"]
    assert "handle" in polys[0]


def test_parse_dxf_handles_are_unique_across_entities():
    """Entities in a multi-entity DXF must have distinct non-None handles."""
    entities = parse_dxf(_make_dxf(line=True, circle=True, arc=True))
    handles = [e["handle"] for e in entities if e["handle"] is not None]
    assert len(handles) == len(set(handles))
```

- [ ] **Step 2: Run to confirm they fail**

```bash
.venv/bin/pytest tests/test_dxf_parser.py::test_parse_dxf_circle_has_handle -v
```

Expected: `FAILED` — `AssertionError: 'handle' not in dict`.

- [ ] **Step 3: Implement — update `backend/vision/dxf_parser.py`**

Inside the `for entity in msp:` loop, at the top of the `try:` block (before the `if t == "LINE":` chain), add:

```python
handle = getattr(entity.dxf, "handle", None)
```

Then add `"handle": handle,` to each entity dict:

```python
# LINE
entities.append({
    "type": "line",
    "x1": float(s.x), "y1": float(s.y),
    "x2": float(e.x), "y2": float(e.y),
    "handle": handle,
})

# CIRCLE
entities.append({
    "type": "circle",
    "cx": float(c.x), "cy": float(c.y),
    "radius": float(entity.dxf.radius),
    "handle": handle,
})

# ARC
entities.append({
    "type": "arc",
    "cx": float(c.x), "cy": float(c.y),
    "radius": float(entity.dxf.radius),
    "start_angle": float(entity.dxf.start_angle),
    "end_angle": float(entity.dxf.end_angle),
    "handle": handle,
})

# LWPOLYLINE
entities.append({
    "type": "polyline",
    "points": points,
    "closed": bool(entity.closed),
    "handle": handle,
})
```

- [ ] **Step 4: Run all parser tests**

```bash
.venv/bin/pytest tests/test_dxf_parser.py -v
```

Expected: all tests pass (pre-existing + 5 new).

- [ ] **Step 5: Run the full test suite**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all green. The `/load-dxf` API returns the extra `handle` key — additive, no existing tests break.

- [ ] **Step 6: Commit**

```bash
git add backend/vision/dxf_parser.py tests/test_dxf_parser.py
git commit -m "feat: add DXF entity handle to parsed entity dicts"
```

---

## Task 2: Wire handle through the frontend match/deviation path

**Files:**
- Modify: `frontend/app.js`

### Background

`matchDxfToDetected(ann)` maps each DXF circle entity to a detected circle and returns match objects consumed by `drawDeviations`. The entity's `handle` field (now present since Task 1) is not forwarded into the match object. Add it now so per-feature tolerance lookup can work in Task 3.

- [ ] **Step 1: Add `handle` to both return paths of `matchDxfToDetected`**

In `matchDxfToDetected`, the `.map(e => { ... })` callback returns in two places. Update both:

```js
// Unmatched path
if (!best) return { nominal, r_px, matched: false, handle: e.handle ?? null };

// Matched path
return {
  nominal, r_px,
  detected: best,
  matched: true,
  delta_xy_mm,
  delta_r_mm,
  color: deviationColor(Math.max(delta_xy_mm, delta_r_mm), e.handle ?? null),
  handle: e.handle ?? null,
};
```

Note: `deviationColor` still has its original one-parameter signature at this point; the second argument is silently ignored.

- [ ] **Step 2: Manual smoke test**

```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Load a DXF with at least two circles, run circle detection, align, click "Show deviations". Labels must look identical to before this change.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "refactor: forward DXF entity handle through matchDxfToDetected"
```

---

## Task 3: Per-feature tolerance storage and lookup

**Files:**
- Modify: `frontend/app.js`

### Background

`state.featureTolerances` is a plain JS object: `{ [handle: string]: { warn: number, fail: number } }`. When a handle appears as a key, its local tolerance pair overrides the global `state.tolerances`. When the handle is `null`, absent, or not in the map, the global tolerance applies.

`deviationColor(delta_mm, handle)` becomes the single lookup point.

- [ ] **Step 1: Add `featureTolerances` to the `state` object**

After the `tolerances` field, add:

```js
featureTolerances: {},   // { [dxfHandle]: { warn, fail } } — per-feature overrides
```

- [ ] **Step 2: Update `deviationColor` to accept and use the handle**

Replace the existing `deviationColor` function:

```js
function deviationColor(delta_mm, handle = null) {
  const tol = (handle && state.featureTolerances[handle]) || state.tolerances;
  if (delta_mm <= tol.warn) return "#30d158";   // green
  if (delta_mm <= tol.fail) return "#ff9f0a";   // amber
  return "#ff453a";                              // red
}
```

- [ ] **Step 3: Update the `Δr` label gate in `drawDeviations`**

Replace:

```js
if (delta_r_mm > state.tolerances.warn) {
```

with:

```js
const tol = (m.handle && state.featureTolerances[m.handle]) || state.tolerances;
if (delta_r_mm > tol.warn) {
```

- [ ] **Step 4: Persist `featureTolerances` in `saveSession`**

Add `featureTolerances` to the session object:

```js
featureTolerances: { ...state.featureTolerances },
```

- [ ] **Step 5: Restore `featureTolerances` in `loadSession`**

After restoring `state.calibration` and `state.origin`:

```js
state.featureTolerances = (data.featureTolerances && typeof data.featureTolerances === "object")
  ? { ...data.featureTolerances }
  : {};
```

- [ ] **Step 6: Reset `featureTolerances` in the "Clear all annotations" handler**

After the annotations filter line, add:

```js
state.featureTolerances = {};
```

- [ ] **Step 7: Verify session round-trip manually**

1. Load DXF, run alignment, open deviations.
2. Console: get a handle via `state.annotations.find(a=>a.type==="dxf-overlay").entities.find(e=>e.type==="circle").handle`.
3. Set `state.featureTolerances["<handle>"] = { warn: 0.001, fail: 0.002 }`.
4. Call `redraw()` — confirm that circle turns red.
5. Save session, reload page, load session.
6. Confirm `state.featureTolerances` contains the override in console.

- [ ] **Step 8: Commit**

```bash
git add frontend/app.js
git commit -m "feat: per-feature tolerance storage keyed by DXF handle"
```

---

## Task 4: Per-feature tolerance UI — popover via deviation label click

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/index.html`

### Background

`drawDeviations` renders to canvas (not the DOM), so click detection requires hit-testing bounding boxes recorded during the last draw pass. Store them in a module-level array `_deviationHitBoxes`. The `onMouseDown` handler is the injection point — add a hit-test block at the very top, after `canvasPoint(e)`, before the `dxfAlignMode` guard.

- [ ] **Step 1: Declare `_deviationHitBoxes` at module scope**

Near the top of `app.js` (after the `state` object):

```js
let _deviationHitBoxes = [];   // populated each drawDeviations call; used for click hit-testing
```

- [ ] **Step 2: Reset and populate `_deviationHitBoxes` in `drawDeviations`**

At the very start of `drawDeviations(ann)`:

```js
_deviationHitBoxes = [];
```

After rendering each matched circle's deviation label, record the bounding box:

```js
const labelText = `\u0394 ${delta_xy_mm.toFixed(3)} mm`;
const textW = ctx.measureText(labelText).width;
_deviationHitBoxes.push({ handle: m.handle, x: labelX, y: det.cy - 10, w: textW, h: 14 });
```

- [ ] **Step 3: Add the popover HTML in `frontend/index.html`**

Immediately before `</body>`:

```html
<div id="feature-tol-popover" style="display:none; position:fixed; background:var(--surface-2,#2c2c2e); border:1px solid var(--border,#444); border-radius:8px; padding:10px; z-index:1000; font-size:12px; color:var(--text,#fff); min-width:180px;">
  <div style="margin-bottom:6px; font-weight:600;">Feature tolerance override</div>
  <label style="display:block; margin-bottom:4px;">
    Warn (mm): <input id="ftol-warn" type="number" step="0.01" min="0.001" style="width:70px; margin-left:4px;">
  </label>
  <label style="display:block; margin-bottom:8px;">
    Fail (mm): <input id="ftol-fail" type="number" step="0.01" min="0.001" style="width:70px; margin-left:4px;">
  </label>
  <div style="display:flex; gap:6px;">
    <button id="ftol-set" class="tool-btn" style="flex:1">Set</button>
    <button id="ftol-reset" class="tool-btn" style="flex:1">Reset</button>
    <button id="ftol-close" class="tool-btn" style="flex:1">&#x2715;</button>
  </div>
</div>
```

- [ ] **Step 4: Add popover logic in `app.js`**

Near the deviation toggle handler:

```js
// ── Per-feature tolerance popover ──────────────────────────────────────────
let _ftolActiveHandle = null;

function openFeatureTolPopover(handle, screenX, screenY) {
  _ftolActiveHandle = handle;
  const tol = state.featureTolerances[handle] || state.tolerances;
  document.getElementById("ftol-warn").value = tol.warn;
  document.getElementById("ftol-fail").value = tol.fail;
  const pop = document.getElementById("feature-tol-popover");
  pop.style.display = "block";
  pop.style.left = `${screenX + 8}px`;
  pop.style.top  = `${screenY - 20}px`;
}

function closeFeatureTolPopover() {
  document.getElementById("feature-tol-popover").style.display = "none";
  _ftolActiveHandle = null;
}

document.getElementById("ftol-set")?.addEventListener("click", () => {
  if (!_ftolActiveHandle) return;
  const warn = parseFloat(document.getElementById("ftol-warn").value);
  const fail = parseFloat(document.getElementById("ftol-fail").value);
  if (!isFinite(warn) || !isFinite(fail) || warn <= 0 || fail <= 0 || warn >= fail) {
    alert("warn must be a positive number less than fail");
    return;
  }
  state.featureTolerances[_ftolActiveHandle] = { warn, fail };
  closeFeatureTolPopover();
  redraw();
});

document.getElementById("ftol-reset")?.addEventListener("click", () => {
  if (!_ftolActiveHandle) return;
  delete state.featureTolerances[_ftolActiveHandle];
  closeFeatureTolPopover();
  redraw();
});

document.getElementById("ftol-close")?.addEventListener("click", closeFeatureTolPopover);
```

- [ ] **Step 5: Add hit-test to `onMouseDown`**

At the top of `onMouseDown`, after `const pt = canvasPoint(e);`, before the `dxfAlignMode` guard:

```js
// Hit-test deviation labels — open per-feature tolerance popover if clicked
if (state.showDeviations && _deviationHitBoxes.length) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (e.clientX - rect.left) * scaleX;
  const cy = (e.clientY - rect.top)  * scaleY;
  for (const box of _deviationHitBoxes) {
    if (box.handle && cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) {
      openFeatureTolPopover(box.handle, e.clientX, e.clientY);
      e.stopPropagation();
      return;
    }
  }
}
```

- [ ] **Step 6: Manual end-to-end test**

1. Load DXF, align, confirm deviations visible.
2. Click a deviation label — confirm popover opens pre-filled with global tolerances.
3. Enter `0.001` / `0.002`, click Set — confirm circle turns red.
4. Click label again, click Reset — reverts to global colour.
5. Save session, reload page, load session — confirm override survived.

- [ ] **Step 7: Commit**

```bash
git add frontend/app.js frontend/index.html
git commit -m "feat: per-feature tolerance popover via deviation label click"
```

---

## Task 5: Always-on deviation display after alignment

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/index.html`

### Background

The alignment success path currently only enables the button. We set `state.showDeviations = true` before the existing `redraw()` call that already follows alignment — no extra repaint needed.

- [ ] **Step 1: Update the alignment success path**

Replace the comment+`removeAttribute` block (around line 2729):

```js
// Auto-show deviation callouts now that alignment is complete
state.showDeviations = true;
const devBtn = document.getElementById("btn-show-deviations");
if (devBtn) {
  devBtn.removeAttribute("disabled");
  devBtn.textContent = "Deviations: on";
}
```

- [ ] **Step 2: Update the toggle click handler label strings**

```js
document.getElementById("btn-show-deviations").textContent =
  state.showDeviations ? "Deviations: on" : "Deviations: off";
```

- [ ] **Step 3: Update the initial button label in `frontend/index.html`**

```html
<button class="dropdown-item" id="btn-show-deviations" disabled>Deviations: off</button>
```

- [ ] **Step 4: Manual test**

1. Load DXF, run detection, click Auto-align.
2. Confirm deviation callouts appear immediately.
3. Click "Deviations: on" — callouts disappear, label becomes "Deviations: off".
4. Click again — callouts reappear, label becomes "Deviations: on".

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/index.html
git commit -m "feat: deviation callouts appear automatically after alignment"
```

---

## Task 6: Measurement panel cleanup

**Files:**
- Modify: `frontend/app.js`

This task has no failing-test cycle — it is pure label/copy polish.

- [ ] **Step 1: Normalise `TOOL_STATUS` entries**

All entries should use imperative mood with an em-dash separator. Review all entries and confirm they follow the pattern `"Tool Name — imperative instruction"`. Make any wording corrections needed.

- [ ] **Step 2: Confirm `dxf-overlay` annotations produce no sidebar row**

Locate `renderSidebar` and confirm `dxf-overlay` annotations are already skipped (they are in `TRANSIENT_TYPES`). Add an inline comment if there is none:

```js
// dxf-overlay, edges-overlay, detected-* are transient and do not appear in the sidebar
```

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "polish: measurement panel label cleanup and sidebar comment"
```

---

## Task 7 (stretch): Arc measurement tool

> **Defer if Task 1–6 timeline is at risk.** Completely independent of Tasks 1–6.

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/index.html`
- Create: `tests/test_arc_measurement.py`

### Background

The new `"arc"` tool lets the user click three points (two endpoints + one on-arc midpoint). Computes radius, center, span angle (degrees), and chord length using the circumscribed circle formula. `snapPoint` signature: `snapPoint(rawPt, bypass = false)` returning `{ pt, snapped }`.

- [ ] **Step 1: Write and pass pure-math unit tests**

Create `tests/test_arc_measurement.py`:

```python
import math
import pytest


def circumscribed_circle(p1, p2, p3):
    """Return (cx, cy, r) of the circle through three 2D points, or None if collinear."""
    ax, ay = p1; bx, by = p2; cx, cy = p3
    D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(D) < 1e-10:
        return None
    ux = ((ax**2+ay**2)*(by-cy) + (bx**2+by**2)*(cy-ay) + (cx**2+cy**2)*(ay-by)) / D
    uy = ((ax**2+ay**2)*(cx-bx) + (bx**2+by**2)*(ax-cx) + (cx**2+cy**2)*(bx-ax)) / D
    return ux, uy, math.hypot(ax - ux, ay - uy)


def arc_span_deg(cx, cy, p1, p2):
    """Smaller angle in degrees subtended at (cx,cy) between p1 and p2."""
    a1 = math.atan2(p1[1] - cy, p1[0] - cx)
    a2 = math.atan2(p2[1] - cy, p2[0] - cx)
    diff = abs(a2 - a1) % (2 * math.pi)
    if diff > math.pi:
        diff = 2 * math.pi - diff
    return math.degrees(diff)


def test_unit_circle():
    result = circumscribed_circle((1, 0), (0, 1), (-1, 0))
    assert result is not None
    cx, cy, r = result
    assert cx == pytest.approx(0.0, abs=1e-6)
    assert cy == pytest.approx(0.0, abs=1e-6)
    assert r  == pytest.approx(1.0, abs=1e-6)


def test_collinear_returns_none():
    assert circumscribed_circle((0, 0), (1, 0), (2, 0)) is None


def test_span_90_degrees():
    assert arc_span_deg(0, 0, (1, 0), (0, 1)) == pytest.approx(90.0, abs=1e-6)


def test_span_180_degrees():
    assert arc_span_deg(0, 0, (1, 0), (-1, 0)) == pytest.approx(180.0, abs=1e-6)
```

```bash
.venv/bin/pytest tests/test_arc_measurement.py -v
```

Expected: all 4 pass immediately (pure Python math).

- [ ] **Step 2: Add `"arc"` to TOOL_STATUS and keyboard shortcut in `app.js`**

In `TOOL_STATUS`, add:

```js
"arc": "Arc — click endpoint 1",
```

In the keyboard shortcut map, add `a: "arc"` (check `"a"` is not taken; use `"q"` if it is).

- [ ] **Step 3: Add helper functions in `app.js`**

Add after the existing `fitCircle` function:

```js
function circumscribedCircle(p1, p2, p3) {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-10) return null;
  const ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / D;
  const uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / D;
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}

function arcSpanDeg(cx, cy, p1, p2) {
  const a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const a2 = Math.atan2(p2.y - cy, p2.x - cx);
  let diff = Math.abs(a2 - a1) % (2 * Math.PI);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff * 180 / Math.PI;
}
```

- [ ] **Step 4: Add the `"arc"` branch in `handleToolClick`**

```js
if (tool === "arc") {
  state.pendingPoints.push({ ...pt });
  if (state.pendingPoints.length === 3) {
    const [p1, p2, p3] = state.pendingPoints;
    const fit = circumscribedCircle(p1, p2, p3);
    if (!fit) {
      showStatus("Points are collinear — cannot fit arc");
      state.pendingPoints = [];
      redraw();
      return;
    }
    const spanDeg = arcSpanDeg(fit.cx, fit.cy, p1, p3);
    const chordPx  = Math.hypot(p3.x - p1.x, p3.y - p1.y);
    pushUndo();
    addAnnotation({ type: "arc", cx: fit.cx, cy: fit.cy, r: fit.r,
                    p1: { ...p1 }, p3: { ...p3 }, spanDeg, chordPx });
    state.pendingPoints = [];
    setTool("select");
  }
  redraw();
  return;
}
```

- [ ] **Step 5: Add `drawArc` render function and wire into `redraw` dispatch**

```js
function drawArc(ann, sel) {
  const { cx, cy, r, p1, p3 } = ann;
  const a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const a3 = Math.atan2(p3.y - cy, p3.x - cx);
  ctx.save();
  ctx.strokeStyle = sel ? "#fff" : "#00c8ff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, a1, a3);
  ctx.stroke();
  ctx.setLineDash([]);
  [p1, p3].forEach(p => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  });
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
  ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
  ctx.stroke();
  ctx.restore();
}
```

Wire into the `redraw()` dispatch:

```js
else if (ann.type === "arc") drawArc(ann, pendingHighlight || sel);
```

- [ ] **Step 6: Add "Arc" tool button in `frontend/index.html`**

Adjacent to the existing "Fit Arc" button:

```html
<button class="tool-btn" data-tool="arc" title="Arc (a)">Arc</button>
```

- [ ] **Step 7: Add arc measurements to `renderSidebar`**

For `ann.type === "arc"`, show radius, span angle, and chord length using the same pattern as the `"circle"` sidebar entry (pixel-to-mm conversion via `state.calibration`).

- [ ] **Step 8: Run full test suite**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add frontend/app.js frontend/index.html tests/test_arc_measurement.py
git commit -m "feat: arc measurement tool (radius, span angle, chord length)"
```

---

## Final verification

```bash
.venv/bin/pytest tests/ -v
```

All tests must pass. Specifically verify:

- `tests/test_dxf_parser.py` — all tests pass including the 5 new handle tests.
- `tests/test_config_tolerances_api.py` — global tolerance API unchanged.
- `tests/test_align_dxf_api.py` — alignment API unchanged.

## M1 success criteria checklist

- [ ] Every entity returned by `parse_dxf` has a `"handle"` key (string or `None`).
- [ ] `state.featureTolerances` is saved and restored in session JSON. Old sessions load cleanly.
- [ ] Setting a per-feature tolerance changes the deviation colour for that feature only.
- [ ] Clicking Reset removes the override and reverts to global-tolerance colour.
- [ ] After Auto-align succeeds, deviation callouts are visible immediately without any button click.
- [ ] The Deviations on/off toggle continues to work after auto-enable.
- [ ] All existing tests pass.
