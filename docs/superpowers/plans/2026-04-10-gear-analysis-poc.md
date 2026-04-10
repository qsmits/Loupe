# Gear Analysis PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-button gear tooth width analysis — user picks tip circle + root circle annotations + types N, backend samples intensity along the computed PCD and returns per-tooth angular widths with sub-pixel flank crossings.

**Architecture:** New pure-Python module (`backend/vision/gear_analysis.py`) does the image math. New `POST /analyze-gear` endpoint in the existing detection router wires it to the frozen frame. New `frontend/gear.js` handles the click flow + result rendering. Other frontend files get minimal touches: one button, two state fields, one draw hook.

**Tech Stack:** Python 3 + numpy + OpenCV (already in `requirements.txt`); FastAPI endpoint (existing framework); vanilla JS ES modules (no build step).

**Spec:** `docs/superpowers/specs/2026-04-10-gear-analysis-poc-design.md`

---

## File Structure

**Backend:**
- **New:** `backend/vision/gear_analysis.py` — pure function `analyze_gear(gray, cx, cy, tip_r, root_r, n_teeth)`
- **New:** `tests/test_gear_analysis.py` — unit tests on synthetic gear image
- **Modify:** `backend/api_detection.py` — add `AnalyzeGearParams` model and `POST /analyze-gear` endpoint
- **Modify:** `tests/test_api.py` — add one integration test for the endpoint

**Frontend:**
- **New:** `frontend/gear.js` — click flow, POST, result storage
- **Modify:** `frontend/state.js` — add `gearPickMode` and `gearAnalysis` state fields
- **Modify:** `frontend/index.html` — add the button and the results panel container
- **Modify:** `frontend/main.js` — wire the button
- **Modify:** `frontend/sidebar.js` — render the results table
- **Modify:** `frontend/render.js` — add `drawGearAnalysis` hook

**No other files get touched.** Blast radius is deliberately contained.

---

## Task 1: Backend pure function — write failing test

**Files:**
- Create: `tests/test_gear_analysis.py`

- [ ] **Step 1: Create the test file with synthetic gear helper + four tests**

```python
# tests/test_gear_analysis.py
import numpy as np
import cv2
import pytest

from backend.vision.gear_analysis import analyze_gear


def make_synthetic_gear(size=400, cx=200, cy=200, tip_r=150, root_r=120, n=17, tooth_frac=0.5):
    """Render a backlit-style gear: dark silhouette on bright background.

    tooth_frac is the fraction of each angular step (360/n) that is occupied
    by material at the pitch circle. 0.5 gives tooth width = gap width.
    """
    img = np.full((size, size), 255, dtype=np.uint8)  # bright background
    cv2.circle(img, (cx, cy), root_r, 0, -1)  # dark root disc
    step = 360.0 / n
    for i in range(n):
        theta_center = i * step
        half_width_deg = step * tooth_frac / 2
        a1 = theta_center - half_width_deg
        a2 = theta_center + half_width_deg
        # Filled pie slice from center out to tip_r on this angular wedge
        cv2.ellipse(img, (cx, cy), (tip_r, tip_r), 0, a1, a2, 0, -1)
    return img


def test_synthetic_17_tooth_widths_within_tolerance():
    img = make_synthetic_gear(size=400, cx=200, cy=200, tip_r=150, root_r=120, n=17, tooth_frac=0.5)
    result = analyze_gear(img, cx=200, cy=200, tip_r=150, root_r=120, n_teeth=17)

    assert len(result["teeth"]) == 17

    step = 360.0 / 17  # ~21.176
    expected_width = step * 0.5  # ~10.588
    for tooth in result["teeth"]:
        assert abs(tooth["angular_width_deg"] - expected_width) < 0.1, (
            f"tooth {tooth['index']}: width {tooth['angular_width_deg']:.3f} "
            f"vs expected {expected_width:.3f}"
        )


def test_synthetic_17_tooth_centers_uniform_spacing():
    img = make_synthetic_gear(n=17)
    result = analyze_gear(img, cx=200, cy=200, tip_r=150, root_r=120, n_teeth=17)

    centers = sorted([t["center_angle_deg"] for t in result["teeth"]])
    expected_step = 360.0 / 17
    gaps = [(centers[(i + 1) % 17] - centers[i]) % 360 for i in range(17)]
    for g in gaps:
        assert abs(g - expected_step) < 0.1


def test_invalid_n_teeth_raises():
    img = np.zeros((100, 100), dtype=np.uint8)
    with pytest.raises(ValueError):
        analyze_gear(img, 50, 50, 40, 30, n_teeth=2)


def test_invalid_radii_raises():
    img = np.zeros((100, 100), dtype=np.uint8)
    with pytest.raises(ValueError):
        analyze_gear(img, 50, 50, 30, 40, n_teeth=17)
```

- [ ] **Step 2: Run to confirm it fails (module doesn't exist yet)**

Run: `.venv/bin/pytest tests/test_gear_analysis.py -v`
Expected: all four tests FAIL with `ModuleNotFoundError: No module named 'backend.vision.gear_analysis'`

---

## Task 2: Backend pure function — implement

**Files:**
- Create: `backend/vision/gear_analysis.py`

- [ ] **Step 1: Create `gear_analysis.py` with the full algorithm**

```python
# backend/vision/gear_analysis.py
"""Gear tooth width analysis via PCD intensity sampling.

Given a grayscale image of a backlit gear, its center, tip radius, root radius,
and tooth count, find the angular position of each tooth's left and right flank
where they cross the pitch circle diameter, with sub-pixel precision.

Pure function. No global state. No I/O.
"""
from __future__ import annotations

import numpy as np
import cv2


def analyze_gear(
    gray: np.ndarray,
    cx: float,
    cy: float,
    tip_r: float,
    root_r: float,
    n_teeth: int,
) -> dict:
    """Analyze a backlit gear and return per-tooth angular widths.

    Args:
        gray: 2-D uint8 grayscale image.
        cx, cy: gear center in image pixel coords.
        tip_r, root_r: tip (addendum) and root (dedendum) circle radii in px.
        n_teeth: expected number of teeth (6..300).

    Returns:
        dict with:
            pcd_radius_px: float
            teeth: list of per-tooth entries sorted by center angle, each:
                index: int (1-based)
                l_angle_deg: float in [0, 360)
                r_angle_deg: float in [0, 360)
                center_angle_deg: float in [0, 360)
                angular_width_deg: float (positive, wrap-safe)
            material_is_dark: bool  (polarity used)

    Raises:
        ValueError: if inputs are out of range or image is not 2-D.
    """
    if gray.ndim != 2:
        raise ValueError("gray must be a 2-D array")
    if not (6 <= n_teeth <= 300):
        raise ValueError(f"n_teeth out of range [6, 300]: {n_teeth}")
    if tip_r <= root_r:
        raise ValueError(f"tip_r ({tip_r}) must be greater than root_r ({root_r})")
    if tip_r <= 0 or root_r <= 0:
        raise ValueError("radii must be positive")

    pcd_r = (tip_r + root_r) / 2.0
    K = 7200  # 0.05 deg per sample

    # Sample image along PCD circle with bilinear interpolation.
    angles = np.linspace(0.0, 2 * np.pi, K, endpoint=False)
    xs = (cx + pcd_r * np.cos(angles)).astype(np.float32).reshape(1, K)
    ys = (cy + pcd_r * np.sin(angles)).astype(np.float32).reshape(1, K)
    profile = cv2.remap(
        gray, xs, ys,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    ).astype(np.float32).flatten()

    # Smooth with a 5-tap boxcar, circular.
    padded = np.concatenate([profile[-2:], profile, profile[:2]])
    kernel = np.ones(5, dtype=np.float32) / 5.0
    smoothed = np.convolve(padded, kernel, mode="valid")
    assert smoothed.shape == (K,)

    # Otsu threshold on the smoothed profile.
    smoothed_u8 = np.clip(smoothed, 0, 255).astype(np.uint8)
    otsu_t, _ = cv2.threshold(
        smoothed_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )
    otsu_t = float(otsu_t)

    # Find contiguous True runs in a boolean circular profile.
    def find_runs(binary: np.ndarray) -> list[tuple[int, int]]:
        """Return (start_idx, end_idx_exclusive) pairs; wrap-around merged."""
        runs: list[tuple[int, int]] = []
        in_run = False
        start = 0
        for i in range(K):
            if binary[i] and not in_run:
                in_run = True
                start = i
            elif not binary[i] and in_run:
                in_run = False
                runs.append((start, i))
        if in_run:
            runs.append((start, K))
        # Merge wrap-around if both ends are active.
        if len(runs) >= 2 and runs[0][0] == 0 and runs[-1][1] == K:
            first = runs.pop(0)
            last = runs.pop(-1)
            # Merged run from last[0] through first[1] (wrapped); store with
            # end > K so the span is positive and unambiguous.
            runs.append((last[0], first[1] + K))
        return runs

    def run_length(r: tuple[int, int]) -> int:
        return r[1] - r[0]

    def run_center_mod(r: tuple[int, int]) -> float:
        return ((r[0] + r[1]) / 2.0) % K

    def score_polarity(runs: list[tuple[int, int]]) -> float:
        if len(runs) < n_teeth:
            return float("inf")
        top = sorted(runs, key=run_length, reverse=True)[:n_teeth]
        top.sort(key=run_center_mod)
        centers = [run_center_mod(r) for r in top]
        gaps = []
        for i in range(n_teeth):
            g = (centers[(i + 1) % n_teeth] - centers[i]) % K
            gaps.append(g)
        return float(np.std(gaps))

    binary_dark = smoothed < otsu_t
    binary_light = smoothed >= otsu_t
    runs_dark = find_runs(binary_dark)
    runs_light = find_runs(binary_light)

    score_dark = score_polarity(runs_dark)
    score_light = score_polarity(runs_light)

    if score_dark == float("inf") and score_light == float("inf"):
        return {
            "pcd_radius_px": float(pcd_r),
            "teeth": [],
            "material_is_dark": True,
            "error": (
                f"Could not find {n_teeth} teeth "
                f"(found {max(len(runs_dark), len(runs_light))})"
            ),
        }

    if score_dark <= score_light:
        chosen = runs_dark
        material_is_dark = True
    else:
        chosen = runs_light
        material_is_dark = False

    top = sorted(chosen, key=run_length, reverse=True)[:n_teeth]
    top.sort(key=run_center_mod)

    def subpix_crossing(k_before: int, k_after: int, threshold: float) -> float:
        """Linear-interpolate a sub-pixel index where profile crosses threshold."""
        v0 = float(profile[k_before % K])
        v1 = float(profile[k_after % K])
        if v1 == v0:
            return float(k_before)
        frac = (threshold - v0) / (v1 - v0)
        return k_before + frac

    teeth = []
    for idx, (start, end) in enumerate(top):
        # L edge: profile crosses threshold between index (start-1) and start.
        l_frac = subpix_crossing(start - 1, start, otsu_t)
        # R edge: profile crosses threshold between index (end-1) and end.
        r_frac = subpix_crossing(end - 1, end, otsu_t)

        l_angle = (2 * np.pi * l_frac / K) % (2 * np.pi)
        r_angle = (2 * np.pi * r_frac / K) % (2 * np.pi)

        width = r_angle - l_angle
        if width < 0:
            width += 2 * np.pi

        center_angle = (l_angle + width / 2.0) % (2 * np.pi)

        teeth.append({
            "index": idx + 1,
            "l_angle_deg": float(np.degrees(l_angle)),
            "r_angle_deg": float(np.degrees(r_angle)),
            "center_angle_deg": float(np.degrees(center_angle)),
            "angular_width_deg": float(np.degrees(width)),
        })

    return {
        "pcd_radius_px": float(pcd_r),
        "teeth": teeth,
        "material_is_dark": material_is_dark,
    }
```

- [ ] **Step 2: Run all four tests and confirm they pass**

Run: `.venv/bin/pytest tests/test_gear_analysis.py -v`
Expected: 4 PASSED.

- [ ] **Step 3: Commit**

```bash
git add backend/vision/gear_analysis.py tests/test_gear_analysis.py
git commit -m "feat: gear tooth width analysis via PCD sampling

Adds backend/vision/gear_analysis.py with a pure analyze_gear() function
that samples image intensity along the computed pitch circle, finds N
tooth-material runs via Otsu thresholding with automatic polarity
selection, and locates L/R flank crossings with sub-pixel linear
interpolation.

Validated on a synthetic 17-tooth gear: angular widths within 0.1 deg
of ground truth, tooth centers uniformly spaced within 0.1 deg.

Part of the gear analysis PoC (see docs/superpowers/specs/2026-04-10-
gear-analysis-poc-design.md)."
```

---

## Task 3: Backend API endpoint — write failing test

**Files:**
- Modify: `tests/test_api.py` (append new tests at end of file)

- [ ] **Step 1: Append two tests to `tests/test_api.py`**

Append exactly these tests at the end of the file (preserve everything already there):

```python
# --- Gear analysis ---

def test_analyze_gear_requires_freeze_first(client):
    r = client.post("/analyze-gear", json={
        "cx": 200, "cy": 200, "tip_r": 150, "root_r": 120, "n_teeth": 17,
    })
    assert r.status_code == 400
    assert "freeze" in r.json()["detail"].lower()


def test_analyze_gear_after_freeze_returns_shape(client):
    client.post("/freeze")
    # FakeCamera returns a solid gray frame, so the algorithm will not find
    # 17 teeth — we're only checking request/response plumbing here. The
    # algorithm correctness is verified in test_gear_analysis.py.
    r = client.post("/analyze-gear", json={
        "cx": 320, "cy": 240, "tip_r": 100, "root_r": 80, "n_teeth": 17,
    })
    assert r.status_code == 200
    body = r.json()
    assert "pcd_radius_px" in body
    assert "teeth" in body
    assert isinstance(body["teeth"], list)


def test_analyze_gear_rejects_bad_radii(client):
    client.post("/freeze")
    r = client.post("/analyze-gear", json={
        "cx": 320, "cy": 240, "tip_r": 50, "root_r": 80, "n_teeth": 17,
    })
    assert r.status_code == 422  # pydantic validation
```

- [ ] **Step 2: Run and confirm the first test fails with 404 (endpoint doesn't exist yet)**

Run: `.venv/bin/pytest tests/test_api.py::test_analyze_gear_requires_freeze_first -v`
Expected: FAIL — status code is 404, not 400. Endpoint not registered.

---

## Task 4: Backend API endpoint — implement

**Files:**
- Modify: `backend/api_detection.py`

- [ ] **Step 1: Add the Pydantic model near the other Body models**

Open `backend/api_detection.py`. Find the line after `MatchDxfArcsBody` class definition ends (around line 107, just before `def make_detection_router`). Insert this new class:

```python
class AnalyzeGearBody(BaseModel):
    cx: float = Field(ge=0, le=100000)
    cy: float = Field(ge=0, le=100000)
    tip_r: float = Field(gt=0, le=100000)
    root_r: float = Field(gt=0, le=100000)
    n_teeth: int = Field(ge=6, le=300)

    @model_validator(mode="after")
    def tip_gt_root(self) -> "AnalyzeGearBody":
        if self.tip_r <= self.root_r:
            raise ValueError("tip_r must be greater than root_r")
        return self
```

- [ ] **Step 2: Add the route inside `make_detection_router`**

Inside `make_detection_router()`, after the `/match-dxf-arcs` route and before the `return router` statement, add:

```python
    @router.post("/analyze-gear")
    async def analyze_gear_route(body: AnalyzeGearBody, session_id: str = Depends(get_session_id_dep)):
        import cv2
        from .vision.gear_analysis import analyze_gear

        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        if frame.ndim == 3:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        else:
            gray = frame
        return analyze_gear(
            gray,
            cx=body.cx, cy=body.cy,
            tip_r=body.tip_r, root_r=body.root_r,
            n_teeth=body.n_teeth,
        )
```

- [ ] **Step 3: Run all three new endpoint tests and confirm pass**

Run: `.venv/bin/pytest tests/test_api.py -k analyze_gear -v`
Expected: 3 PASSED.

- [ ] **Step 4: Run the full test suite to confirm nothing else regressed**

Run: `.venv/bin/pytest tests/ -q`
Expected: all tests pass (no regressions). If any pre-existing tests were already failing, they should still be failing in the same way — no new failures from your changes.

- [ ] **Step 5: Commit**

```bash
git add backend/api_detection.py tests/test_api.py
git commit -m "feat: /analyze-gear endpoint wired to gear_analysis module

Adds POST /analyze-gear to the detection router. Takes center + tip/root
radii + tooth count, pulls the frozen frame from frame_store, converts
to grayscale, and returns per-tooth angular widths from the pure
gear_analysis.analyze_gear() function.

Part of the gear analysis PoC."
```

---

## Task 5: Frontend state + HTML button

**Files:**
- Modify: `frontend/state.js`
- Modify: `frontend/index.html`

- [ ] **Step 1: Add state fields in `frontend/state.js`**

Open `frontend/state.js` and find the `state` object definition (the top-level `export const state = { ... }`). Add these two fields alongside the other top-level state properties (order inside the object doesn't matter, keep them together and add a short comment):

```js
  // Gear analysis PoC
  gearPickMode: null,      // null | "pick-tip" | "pick-root"
  gearPickBuffer: null,    // { tipCircle?: {...}, rootCircle?: {...} }
  gearAnalysis: null,      // null | { pcd_radius_px, teeth: [...], material_is_dark, cx, cy }
```

If the file has a `resetState()` or `clearAll()` function, add the same three fields there set back to `null`. If there's no such function, skip this part — we don't need it for the PoC.

- [ ] **Step 2: Add the button and results panel container in `frontend/index.html`**

Find the sidebar in `frontend/index.html`. Look for where other sidebar buttons live (e.g. the "Analyze Z-Stack" button from the z-stack feature, or "Run Inspection"). Add a new button **immediately after** that group, using the same button styling classes used by its neighbors:

```html
      <button id="analyze-gear-btn" class="sidebar-btn" type="button">Analyze Gear</button>
      <div id="gear-results-panel" class="sidebar-section" style="display:none">
        <div class="sidebar-section-header">Gear Analysis</div>
        <div id="gear-results-body"></div>
      </div>
```

If the existing sidebar buttons use a different class name than `sidebar-btn`, match whatever they use. The important thing is the three IDs: `analyze-gear-btn`, `gear-results-panel`, `gear-results-body`.

- [ ] **Step 3: Reload the app in the browser and verify the button appears**

Run the app:
```bash
./server.sh restart
```

Open http://localhost:8000 and confirm: the "Analyze Gear" button is visible in the sidebar. Clicking it does nothing yet — that's expected (we haven't wired it).

- [ ] **Step 4: Commit**

```bash
git add frontend/state.js frontend/index.html
git commit -m "feat: gear analysis button + state scaffolding

Adds the 'Analyze Gear' button to the sidebar and three state fields
(gearPickMode, gearPickBuffer, gearAnalysis) for the upcoming
click-flow. Button is not wired yet.

Part of the gear analysis PoC."
```

---

## Task 6: Frontend click flow

**Files:**
- Create: `frontend/gear.js`
- Modify: `frontend/main.js`

- [ ] **Step 1: Create `frontend/gear.js`**

```js
// frontend/gear.js
// Gear analysis click flow + POST. Rendering lives in render.js and sidebar.js.
import { state } from "./state.js";
import { redraw } from "./render.js";

// Called when the user clicks the "Analyze Gear" button.
export function startGearAnalysis() {
  state.gearPickMode = "pick-tip";
  state.gearPickBuffer = {};
  showStatus("Click the TIP circle annotation");
}

// Called from main.js mouse-down handler when a gear pick mode is active and
// the user has clicked somewhere in the canvas. `hit` is the annotation that
// was hit-tested under the click, or null.
export function handleGearPickClick(hit) {
  if (!state.gearPickMode) return false;

  // Must be a circle annotation. Accept "circle" and "fit-circle" annotation types.
  if (!hit || (hit.type !== "circle" && hit.type !== "fit-circle")) {
    showStatus("That is not a circle annotation — click a fitted circle");
    return true; // consumed the click (don't let other tools handle it)
  }

  if (state.gearPickMode === "pick-tip") {
    state.gearPickBuffer.tipCircle = hit;
    state.gearPickMode = "pick-root";
    showStatus("Now click the ROOT circle annotation");
    redraw();
    return true;
  }

  if (state.gearPickMode === "pick-root") {
    if (hit === state.gearPickBuffer.tipCircle) {
      showStatus("Pick a different circle for the root");
      return true;
    }
    state.gearPickBuffer.rootCircle = hit;
    state.gearPickMode = null;
    promptForToothCountAndRun();
    return true;
  }

  return false;
}

function promptForToothCountAndRun() {
  const nStr = window.prompt("How many teeth on this gear?", "17");
  if (!nStr) {
    state.gearPickBuffer = null;
    showStatus("Gear analysis cancelled");
    return;
  }
  const n = parseInt(nStr, 10);
  if (!Number.isFinite(n) || n < 6 || n > 300) {
    showStatus("Tooth count must be between 6 and 300");
    state.gearPickBuffer = null;
    return;
  }

  const { tipCircle, rootCircle } = state.gearPickBuffer;
  // Both circles have cx, cy, r. Use the tip circle's center as the gear center.
  const cx = tipCircle.cx;
  const cy = tipCircle.cy;
  const tip_r = tipCircle.r;
  const root_r = rootCircle.r;

  if (tip_r <= root_r) {
    showStatus("The first circle must be the tip (outer) circle — try again");
    state.gearPickBuffer = null;
    return;
  }

  showStatus("Analyzing gear…");

  fetch("/analyze-gear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cx, cy, tip_r, root_r, n_teeth: n }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((result) => {
      state.gearAnalysis = { ...result, cx, cy };
      state.gearPickBuffer = null;
      showStatus(`Gear analysis complete: ${result.teeth.length} teeth`);
      renderGearResultsPanel();
      redraw();
    })
    .catch((err) => {
      console.error(err);
      showStatus(`Gear analysis failed: ${err.message}`);
      state.gearPickBuffer = null;
    });
}

function showStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
  else console.log("[gear]", msg);
}

// Render the results table into the sidebar panel.
export function renderGearResultsPanel() {
  const panel = document.getElementById("gear-results-panel");
  const body = document.getElementById("gear-results-body");
  if (!panel || !body) return;
  if (!state.gearAnalysis) {
    panel.style.display = "none";
    body.replaceChildren();
    return;
  }
  panel.style.display = "";

  const teeth = state.gearAnalysis.teeth.slice();
  const bestWidth = teeth.length
    ? Math.max(...teeth.map((t) => t.angular_width_deg))
    : 0;

  // Calibration for Δµm at PCD. Read from window.state if present,
  // otherwise omit the µm column.
  const pcdRadiusPx = state.gearAnalysis.pcd_radius_px;
  const pxPerMm = (state.calibration && state.calibration.pixelsPerMm) || null;

  const table = document.createElement("table");
  table.className = "gear-results-table";

  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  ["#", "Width °", "Δ° vs best", pxPerMm ? "Δµm @ PCD" : ""].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const sorted = teeth.slice().sort((a, b) => a.index - b.index);
  for (const t of sorted) {
    const row = document.createElement("tr");

    const idxTd = document.createElement("td");
    idxTd.textContent = `T${t.index}`;
    row.appendChild(idxTd);

    const wTd = document.createElement("td");
    wTd.textContent = t.angular_width_deg.toFixed(3);
    row.appendChild(wTd);

    const dDegTd = document.createElement("td");
    const dDeg = t.angular_width_deg - bestWidth;
    dDegTd.textContent = dDeg.toFixed(3);
    row.appendChild(dDegTd);

    if (pxPerMm) {
      const dUmTd = document.createElement("td");
      // Δµm at PCD = (Δ° in radians) * pcd_r_px / pxPerMm * 1000
      const dUm = (dDeg * Math.PI / 180) * pcdRadiusPx / pxPerMm * 1000;
      dUmTd.textContent = dUm.toFixed(1);
      row.appendChild(dUmTd);
    } else {
      row.appendChild(document.createElement("td"));
    }

    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  body.replaceChildren(table);
}
```

- [ ] **Step 2: Wire the button in `frontend/main.js`**

Open `frontend/main.js`. At the top, add an import:

```js
import { startGearAnalysis, handleGearPickClick } from "./gear.js";
```

Find the block where other sidebar buttons are wired (look for `document.getElementById(` + `addEventListener("click"` patterns, e.g. for the Z-Stack or Run Inspection buttons). Add:

```js
document.getElementById("analyze-gear-btn")?.addEventListener("click", () => {
  startGearAnalysis();
});
```

Find the canvas mousedown handler. It will be a function that reads `state.tool` and dispatches based on tool. At the very top of the handler, **before** any other tool dispatch, insert a gear-pick-mode check:

```js
// Gear pick mode short-circuits any tool dispatch
if (state.gearPickMode) {
  const pt = canvasPoint(e);  // existing helper that converts event to image coords
  const hit = hitTestAnnotation(pt);  // existing hit-test helper
  if (handleGearPickClick(hit)) {
    e.preventDefault();
    return;
  }
}
```

If the names differ in main.js, match whatever the existing handler uses — the intent is: get the click point in image coords, run the existing hit-test to find an annotation under it, pass the result to `handleGearPickClick`, and bail out of the rest of the handler if it returned true.

- [ ] **Step 3: Restart the server and walk through the click flow manually**

```bash
./server.sh restart
```

In the browser:
1. Freeze a frame (any frame — a dummy is fine for smoke-testing the click flow).
2. Fit two circles anywhere in the image (use the Circle tool). Make one bigger than the other.
3. Click "Analyze Gear". Status bar should read "Click the TIP circle annotation".
4. Click the larger circle. Status bar should flip to "Now click the ROOT circle annotation".
5. Click the smaller circle. A `prompt()` dialog appears asking for tooth count.
6. Enter 17 (or cancel and verify the status bar says "cancelled").

If entering 17 makes a POST to `/analyze-gear` and the status bar updates with a result or error, the click flow is working. (On a non-gear image the algorithm will usually return an error — that's fine, we're testing the UX plumbing.)

- [ ] **Step 4: Commit**

```bash
git add frontend/gear.js frontend/main.js
git commit -m "feat: gear analysis click flow + POST wiring

Adds frontend/gear.js with the pick-tip -> pick-root -> prompt-N -> POST
flow. The POST goes to /analyze-gear and stores the result in
state.gearAnalysis. Rendering of the overlay and results panel comes
in the next commit.

Part of the gear analysis PoC."
```

---

## Task 7: Frontend overlay rendering + sidebar wiring

**Files:**
- Modify: `frontend/render.js`
- Modify: `frontend/sidebar.js`

- [ ] **Step 1: Add `drawGearAnalysis()` in `frontend/render.js`**

Open `frontend/render.js`. Near the top, add an import for the state (it's almost certainly already imported — skip if so):

```js
import { state } from "./state.js";
```

Add this function anywhere in the file (keep it near other draw helpers if you can):

```js
export function drawGearAnalysis(ctx) {
  const ga = state.gearAnalysis;
  if (!ga || !ga.teeth || ga.teeth.length === 0) return;

  const cx = ga.cx;
  const cy = ga.cy;
  const r = ga.pcd_radius_px;

  ctx.save();

  // PCD circle (dashed, cyan).
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Per-tooth L->R arcs on the PCD (solid, yellow).
  ctx.strokeStyle = "#ffeb3b";
  ctx.lineWidth = 3;
  for (const t of ga.teeth) {
    const lRad = (t.l_angle_deg * Math.PI) / 180;
    const rRad = (t.r_angle_deg * Math.PI) / 180;
    ctx.beginPath();
    // Canvas arc() follows the angle direction; positive angular width.
    // If r_angle < l_angle (wrap), use anti-direction trick.
    let startA = lRad;
    let endA = rRad;
    if (endA < startA) endA += Math.PI * 2;
    ctx.arc(cx, cy, r, startA, endA, false);
    ctx.stroke();
  }

  // Tooth index labels at the center angle, slightly outside PCD.
  ctx.fillStyle = "#ffeb3b";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const labelR = r * 1.12;
  for (const t of ga.teeth) {
    const cRad = (t.center_angle_deg * Math.PI) / 180;
    const lx = cx + labelR * Math.cos(cRad);
    const ly = cy + labelR * Math.sin(cRad);
    ctx.fillText(`T${t.index}`, lx, ly);
  }

  ctx.restore();
}
```

Now wire it into the main draw sequence. Find the main `redraw()` or equivalent function in render.js that iterates annotations. **After** all annotations are drawn but **before** any HUD/overlay layer (if present), call `drawGearAnalysis(ctx)`. The gear overlay should sit on top of annotations but under the HUD. If there's no HUD, just add it as the last draw call in the canvas-coord transformed block (before any `ctx.restore()` that pops the viewport transform).

- [ ] **Step 2: Hook the sidebar to re-render on analysis changes**

Open `frontend/sidebar.js`. At the top, add the import (if not already present):

```js
import { renderGearResultsPanel } from "./gear.js";
```

Find the main sidebar render function (probably `renderSidebar()` or similar). At the end of that function, add:

```js
renderGearResultsPanel();
```

This makes the gear results panel re-render whenever the sidebar re-renders, so opening/closing other sections doesn't wipe it.

Also add a minimal style for the table — either in `frontend/style.css` or as a one-line `<style>` block you can skip entirely if the existing `.sidebar-section` styles are already good enough. **For the PoC, skip styling.** Ugly is fine.

- [ ] **Step 3: Restart and verify the overlay appears**

```bash
./server.sh restart
```

In the browser, run the full flow with any frozen frame + two fitted circles + N=17. Even if the algorithm returns an error on a non-gear image, you should see: PCD dashed cyan circle drawn on the canvas, and (if any teeth came back) yellow arc segments + T1..TN labels.

- [ ] **Step 4: Commit**

```bash
git add frontend/render.js frontend/sidebar.js
git commit -m "feat: gear analysis canvas overlay + results table

Adds drawGearAnalysis() which renders the PCD as a dashed cyan circle,
each tooth's L->R flank span as a solid yellow arc on the PCD, and
labels each tooth at its center angle. Sidebar re-renders pull in the
results table.

Part of the gear analysis PoC."
```

---

## Task 8: Smoke test against the current gear

**Files:** none (manual test against running app)

- [ ] **Step 1: Load the gear frame**

The user has a 17-tooth watch gear under the scope right now with the tip and root circles already fitted and N=17 annotated. Make sure the server is running and the frame is frozen.

```bash
./server.sh status
```

- [ ] **Step 2: Run the full flow**

In the browser:
1. Click "Analyze Gear"
2. Click the tip circle
3. Click the root circle
4. Enter 17
5. Observe the overlay + results table

- [ ] **Step 3: Check acceptance values**

Compare the auto-measured angular widths for the clean reference teeth against the manual values from the session:

| Tooth | Manual ° | Auto ° | Δ |
|-------|----------|--------|---|
| T3    | 9.93     |        |   |
| T5    | 9.38     |        |   |
| T11   | 9.07     |        |   |
| T13   | 9.37     |        |   |

**Pass:** all four within ±0.1°.
**Soft pass:** all four offset by approximately the same amount (systematic PCD-approximation bias — note it in the commit message when marking the PoC green).
**Fail:** ordering disagrees with the manual run on any clean tooth.

Note: the PoC numbers teeth starting from whichever tooth is closest to angle 0°. The user numbered them visually. The tooth numbering WILL be offset — that's expected. Match up teeth by their position, not by the numeric index.

- [ ] **Step 4: Record result**

Write the result as a new commit on top of the previous one, using one of these two messages:

**If pass:**
```bash
git commit --allow-empty -m "test: gear analysis PoC acceptance — PASS

Auto-measured angular widths on T3/T5/T11/T13 landed within 0.1 deg of
the manual values from the 2026-04-10 session. PoC is green — ready
for feedback before deciding on V2 scope."
```

**If soft pass or fail:** don't commit empty. Instead, write a brief status note at `docs/superpowers/plans/2026-04-10-gear-analysis-poc-status.md` describing what you saw, which teeth were off, and by how much. Do not attempt to hack around the algorithm — the point of the PoC is to learn where it breaks so the V2 spec can address the real failure modes.

---

## Self-Review Notes

- **Spec coverage:** every "In scope" bullet from the spec maps to a task:
  - Sidebar Analyze Gear button → Task 5
  - Click flow tip→root→N→Go → Task 6
  - `POST /analyze-gear` endpoint → Task 4
  - PCD sampling + sub-pixel flank crossings → Task 2
  - Canvas overlay (PCD + per-tooth arcs) → Task 7
  - Sidebar results panel with deviations → Task 6 (data) + Task 7 (rendering hook)
- **Placeholders:** none. Every code block contains the actual implementation an engineer can paste.
- **Type consistency:** `analyze_gear(gray, cx, cy, tip_r, root_r, n_teeth)` has identical argument names in the pure function, the test, the endpoint body model, and the frontend POST body.
- **No scope creep:** no tests for `drawGearAnalysis` (frontend has no test harness in this repo), no CSV export, no tolerance bands, no auto-PCD-override.
