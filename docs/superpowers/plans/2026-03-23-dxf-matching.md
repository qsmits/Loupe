# DXF Matching & Deviation Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-align a loaded DXF overlay to detected circles using RANSAC, then display colour-coded deviation indicators for each matched nominal/detected circle pair.

**Architecture:** Pure-Python RANSAC alignment module in `backend/vision/alignment.py` (no CV dependencies); new `/align-dxf` and `/config/tolerances` endpoints follow existing API patterns; all deviation rendering is frontend-only using the existing canvas draw loop. DXF overlay annotation gains an `angle` field applied before the Y-flip in `dxfToCanvas()`.

**Tech Stack:** Python 3.13, NumPy, FastAPI/Pydantic; Vanilla JS (no framework), HTML5 Canvas.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/vision/alignment.py` | **Create** | RANSAC circle alignment: flip variants, hypothesis scoring, least-squares refinement |
| `backend/config.py` | **Modify** | Add `tolerance_warn` and `tolerance_fail` to `_DEFAULTS` |
| `backend/api.py` | **Modify** | Add `TolerancesConfig` model + `GET/POST /config/tolerances`; add `AlignDxfBody` model + `POST /align-dxf` |
| `frontend/index.html` | **Modify** | Add DXF controls group to Overlay dropdown (scale, flip, origin, realign, clear, rotation nudges); add Auto-align + Show deviations items; add Tolerances tab to Settings |
| `frontend/style.css` | **Modify** | Styles for rotation row, DXF controls group, deviation labels |
| `frontend/app.js` | **Modify** | `dxfToCanvas()` uses `ann.angle`; wire rotation nudges + undo; wire Auto-align; wire Show deviations; draw deviation overlay; load/save tolerances |
| `tests/test_alignment.py` | **Create** | Unit tests for alignment algorithm with known transforms |
| `tests/test_config_tolerances_api.py` | **Create** | API tests for tolerance config endpoints |
| `tests/test_align_dxf_api.py` | **Create** | API tests for `/align-dxf` endpoint |

---

## Task 1: RANSAC alignment module

**Files:**
- Create: `backend/vision/alignment.py`
- Create: `tests/test_alignment.py`

### Background

`dxf_circles` are `(cx_mm, cy_mm, r_mm)` tuples. `detected_circles` are `(cx_px, cy_px, r_px)` tuples. The algorithm scales DXF to pixels, tries 4 flip variants, runs pairwise RANSAC hypothesis scoring, then refines with closed-form least-squares (Procrustes).

**Coordinate convention:** rotation is applied in DXF-pixel space with Y still pointing up (before Y-flip). This matches how `dxfToCanvas()` applies `ann.angle`.

### Transform convention

Given DXF point `(x, y)` in pixels (after flip), the canvas position is:
```
cx = x_flipped * cos(angle) - y_flipped * sin(angle)    [+ tx]
cy = x_flipped * sin(angle) + y_flipped * cos(angle)    [* -1 for Y-flip, + ty]
```

Since the canvas Y-flip is applied *after* rotation in `dxfToCanvas()`, the backend works in DXF-pixel-Y-up space throughout and only needs to return `(tx, ty, angle_rad)` in that space.

---

- [ ] **Step 1: Write failing tests for `extract_dxf_circles`**

```python
# tests/test_alignment.py
import numpy as np
import pytest
from backend.vision.alignment import extract_dxf_circles, align_circles

def test_extract_dxf_circles_ignores_non_circles():
    entities = [
        {"type": "circle", "cx": 10.0, "cy": 20.0, "radius": 5.0},
        {"type": "line", "x1": 0, "y1": 0, "x2": 1, "y2": 1},
        {"type": "arc", "cx": 5.0, "cy": 5.0, "radius": 3.0},
    ]
    result = extract_dxf_circles(entities)
    assert len(result) == 1
    assert result[0] == (10.0, 20.0, 5.0)

def test_extract_dxf_circles_empty():
    assert extract_dxf_circles([]) == []

def test_extract_dxf_circles_no_circles():
    entities = [{"type": "line", "x1": 0, "y1": 0, "x2": 1, "y2": 1}]
    assert extract_dxf_circles(entities) == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/bin/pytest tests/test_alignment.py -v
```
Expected: `ModuleNotFoundError` or `ImportError`

- [ ] **Step 3: Implement `extract_dxf_circles` and module skeleton**

```python
# backend/vision/alignment.py
import math
import numpy as np


def extract_dxf_circles(entities: list[dict]) -> list[tuple]:
    """Return list of (cx_mm, cy_mm, r_mm) from DXF entities (circles only)."""
    return [
        (float(e["cx"]), float(e["cy"]), float(e["radius"]))
        for e in entities
        if e.get("type") == "circle"
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
.venv/bin/pytest tests/test_alignment.py -v
```
Expected: 3 PASS

- [ ] **Step 5: Write failing tests for `align_circles` — pure translation case**

```python
def test_align_circles_pure_translation():
    # DXF has 3 circles at known mm positions, calibration = 10 px/mm
    # Detected circles are the DXF positions scaled to px, shifted by (50, 30)
    ppm = 10.0
    dxf = [(0.0, 0.0, 5.0), (20.0, 0.0, 5.0), (10.0, 15.0, 5.0)]
    detected = [
        (0*ppm + 50, -(0*ppm) + 30, 5*ppm),    # flip Y: cy = -(y*ppm) + ty
        (20*ppm + 50, -(0*ppm) + 30, 5*ppm),
        (10*ppm + 50, -(15*ppm) + 30, 5*ppm),
    ]
    result = align_circles(dxf, detected, pixels_per_mm=ppm)
    assert result["confidence"] in ("high", "low")
    assert result["inlier_count"] >= 2
    assert abs(result["tx"] - 50) < 5
    assert abs(result["ty"] - 30) < 5
    assert abs(result["angle_deg"]) < 2

def test_align_circles_returns_error_with_fewer_than_2_dxf_circles():
    result = align_circles([(5.0, 5.0, 3.0)], [(50, 50, 30)], pixels_per_mm=10.0)
    assert result["error"] == "insufficient_dxf_circles"

def test_align_circles_with_rotation():
    ppm = 10.0
    angle = math.radians(30)
    dxf = [(10.0, 0.0, 4.0), (-10.0, 0.0, 4.0), (0.0, 15.0, 6.0)]
    # Apply rotation + translation in DXF-px-Y-up space, then Y-flip for canvas
    tx, ty = 200.0, 150.0
    detected = []
    for cx_mm, cy_mm, r_mm in dxf:
        cx_px = cx_mm * ppm
        cy_px = cy_mm * ppm
        rx = cx_px * math.cos(angle) - cy_px * math.sin(angle)
        ry = cx_px * math.sin(angle) + cy_px * math.cos(angle)
        # Canvas Y-flip: canvas_y = -ry + ty
        detected.append((rx + tx, -ry + ty, r_mm * ppm))
    result = align_circles(dxf, detected, pixels_per_mm=ppm)
    assert result["confidence"] in ("high", "low")
    assert result["inlier_count"] >= 2
    assert abs(result["angle_deg"] - 30) < 3
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
.venv/bin/pytest tests/test_alignment.py::test_align_circles_pure_translation -v
```
Expected: FAIL — `align_circles` not defined

- [ ] **Step 7: Implement `align_circles`**

```python
def _apply_flip(pts: np.ndarray, flip_h: bool, flip_v: bool) -> np.ndarray:
    result = pts.copy()
    if flip_h:
        result[:, 0] *= -1
    if flip_v:
        result[:, 1] *= -1
    return result


def _compute_transform(p1, p2, q1, q2):
    """Compute (tx, ty, angle_rad) mapping p1→q1, p2→q2 (all 2D numpy arrays)."""
    dp = p2 - p1
    dq = q2 - q1
    angle = math.atan2(float(dq[1]), float(dq[0])) - math.atan2(float(dp[1]), float(dp[0]))
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    rp1 = np.array([p1[0]*cos_a - p1[1]*sin_a, p1[0]*sin_a + p1[1]*cos_a])
    tx = float(q1[0] - rp1[0])
    ty = float(q1[1] - rp1[1])
    return tx, ty, angle


def _score_transform(dxf_px, detected_px, tx, ty, angle, inlier_dist_fn):
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    inliers = []
    for i, (dx, dy, dr) in enumerate(dxf_px):
        mx = dx * cos_a - dy * sin_a + tx
        my = dx * sin_a + dy * cos_a + ty
        for j, (ex, ey, er) in enumerate(detected_px):
            if abs(dr - er) / (max(dr, er) + 1e-6) > 0.3:
                continue
            threshold = max(10.0, 0.15 * dr)
            if math.hypot(mx - ex, my - ey) < threshold:
                inliers.append((i, j))
                break
    return inliers


def _refine_transform(dxf_px, detected_px, inliers):
    """Closed-form least-squares (Procrustes) over inlier pairs."""
    if len(inliers) < 2:
        return None
    src = np.array([[dxf_px[i][0], dxf_px[i][1]] for i, _ in inliers], dtype=float)
    dst = np.array([[detected_px[j][0], detected_px[j][1]] for _, j in inliers], dtype=float)
    src_c = src.mean(axis=0)
    dst_c = dst.mean(axis=0)
    src_n = src - src_c
    dst_n = dst - dst_c
    H = src_n.T @ dst_n
    U, _, Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    # Ensure proper rotation (det=1)
    if np.linalg.det(R) < 0:
        Vt[-1, :] *= -1
        R = Vt.T @ U.T
    angle = math.atan2(float(R[1, 0]), float(R[0, 0]))
    t = dst_c - R @ src_c
    return float(t[0]), float(t[1]), angle


def align_circles(
    dxf_circles: list[tuple],
    detected_circles: list[tuple],
    pixels_per_mm: float,
) -> dict:
    """
    Find the best-fit rigid transform mapping DXF circles onto detected circles.

    dxf_circles: list of (cx_mm, cy_mm, r_mm)
    detected_circles: list of (cx_px, cy_px, r_px) in canvas coordinates
      (Y-down, origin top-left)
    pixels_per_mm: calibration scale

    Returns dict with keys:
      tx, ty, angle_deg, scale, flip_h, flip_v,
      inlier_count, total_dxf_circles, confidence
    OR on error:
      error: str
    """
    if len(dxf_circles) < 2:
        return {"error": "insufficient_dxf_circles"}

    # Scale DXF to pixels (Y still pointing up — canvas Y-flip applied later)
    dxf_px = [(cx * pixels_per_mm, cy * pixels_per_mm, r * pixels_per_mm)
               for cx, cy, r in dxf_circles]
    det_px = list(detected_circles)

    best_score = -1
    best_result = None

    for flip_h in (False, True):
        for flip_v in (False, True):
            flipped = [
                ((-cx if flip_h else cx), (-cy if flip_v else cy), r)
                for cx, cy, r in dxf_px
            ]
            n = len(flipped)
            m = len(det_px)
            for i in range(n):
                for j in range(i + 1, n):
                    for a in range(m):
                        for b in range(m):
                            if a == b:
                                continue
                            # Check radius ratio compatibility
                            r_dxf = sorted([flipped[i][2], flipped[j][2]])
                            r_det = sorted([det_px[a][2], det_px[b][2]])
                            ratio_dxf = r_dxf[0] / (r_dxf[1] + 1e-6)
                            ratio_det = r_det[0] / (r_det[1] + 1e-6)
                            if abs(ratio_dxf - ratio_det) > 0.3:
                                continue
                            p1 = np.array([flipped[i][0], flipped[i][1]])
                            p2 = np.array([flipped[j][0], flipped[j][1]])
                            q1 = np.array([det_px[a][0], det_px[a][1]])
                            q2 = np.array([det_px[b][0], det_px[b][1]])
                            tx, ty, angle = _compute_transform(p1, p2, q1, q2)
                            inliers = _score_transform(
                                flipped, det_px, tx, ty, angle,
                                lambda r: max(10.0, 0.15 * r)
                            )
                            if len(inliers) > best_score:
                                best_score = len(inliers)
                                best_result = (tx, ty, angle, flip_h, flip_v, flipped, inliers)

    if best_result is None or best_score < 2:
        confidence = "failed"
        tx, ty, angle_rad = 0.0, 0.0, 0.0
        flip_h = flip_v = False
        inlier_count = 0
    else:
        tx, ty, angle_rad, flip_h, flip_v, flipped, inliers = best_result
        refined = _refine_transform(flipped, det_px, inliers)
        if refined:
            tx, ty, angle_rad = refined
            inliers = _score_transform(flipped, det_px, tx, ty, angle_rad,
                                       lambda r: max(10.0, 0.15 * r))
        inlier_count = len(inliers)
        total = len(dxf_circles)
        if inlier_count >= max(2, total * 0.5):
            confidence = "high"
        elif inlier_count >= 2:
            confidence = "low"
        else:
            confidence = "failed"

    return {
        "tx": tx,
        "ty": ty,
        "angle_deg": math.degrees(angle_rad),
        "scale": pixels_per_mm,
        "flip_h": flip_h,
        "flip_v": flip_v,
        "inlier_count": inlier_count,
        "total_dxf_circles": len(dxf_circles),
        "confidence": confidence,
    }
```

- [ ] **Step 8: Run all alignment tests**

```bash
.venv/bin/pytest tests/test_alignment.py -v
```
Expected: all PASS

- [ ] **Step 9: Commit**

```bash
git add backend/vision/alignment.py tests/test_alignment.py
git commit -m "feat: add RANSAC circle alignment module"
```

---

## Task 2: Tolerances config endpoints

**Files:**
- Modify: `backend/config.py` (line 8 — `_DEFAULTS`)
- Modify: `backend/api.py` (after line 93)
- Create: `tests/test_config_tolerances_api.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_config_tolerances_api.py
import pytest
from tests.conftest import *   # imports client fixture

def test_get_tolerances_returns_defaults(client):
    r = client.get("/config/tolerances")
    assert r.status_code == 200
    body = r.json()
    assert body["tolerance_warn"] == pytest.approx(0.10)
    assert body["tolerance_fail"] == pytest.approx(0.25)

def test_post_tolerances_accepts_valid(client):
    r = client.post("/config/tolerances",
                    json={"tolerance_warn": 0.05, "tolerance_fail": 0.20})
    assert r.status_code == 200
    body = r.json()
    assert body["tolerance_warn"] == pytest.approx(0.05)
    assert body["tolerance_fail"] == pytest.approx(0.20)

def test_post_tolerances_rejects_warn_gte_fail(client):
    r = client.post("/config/tolerances",
                    json={"tolerance_warn": 0.30, "tolerance_fail": 0.20})
    assert r.status_code == 422

def test_post_tolerances_rejects_nonpositive(client):
    r = client.post("/config/tolerances",
                    json={"tolerance_warn": 0.0, "tolerance_fail": 0.20})
    assert r.status_code == 422

def test_tolerances_round_trip(client, tmp_path, monkeypatch):
    import backend.config as cfg
    monkeypatch.setattr(cfg, "CONFIG_PATH", tmp_path / "config.json")
    client.post("/config/tolerances",
                json={"tolerance_warn": 0.08, "tolerance_fail": 0.30})
    r = client.get("/config/tolerances")
    assert r.json()["tolerance_warn"] == pytest.approx(0.08)
```

- [ ] **Step 2: Run to verify they fail**

```bash
.venv/bin/pytest tests/test_config_tolerances_api.py -v
```
Expected: FAIL — 404 on endpoints

- [ ] **Step 3: Add defaults to `backend/config.py`**

Change line 8 from:
```python
_DEFAULTS = {"camera_id": None, "version": 1, "no_camera": False, "app_name": "Microscope", "theme": "macos-dark"}
```
To:
```python
_DEFAULTS = {"camera_id": None, "version": 1, "no_camera": False, "app_name": "Microscope", "theme": "macos-dark", "tolerance_warn": 0.10, "tolerance_fail": 0.25}
```

- [ ] **Step 4: Add `TolerancesConfig` model and endpoints to `backend/api.py`**

After the `UiConfig` class (line 75), add:

```python
class TolerancesConfig(BaseModel):
    tolerance_warn: float = Field(gt=0)
    tolerance_fail: float = Field(gt=0)

    @model_validator(mode="after")
    def warn_lt_fail(self):
        if self.tolerance_warn >= self.tolerance_fail:
            raise ValueError("tolerance_warn must be less than tolerance_fail")
        return self
```

Also add to the imports at line 9: `from pydantic import BaseModel, Field, model_validator`

After the `/config/ui` handlers (after line 93), add:

```python
@router.get("/config/tolerances")
def get_tolerances():
    cfg = load_config()
    return {
        "tolerance_warn": cfg.get("tolerance_warn", 0.10),
        "tolerance_fail": cfg.get("tolerance_fail", 0.25),
    }


@router.post("/config/tolerances")
def post_tolerances(body: TolerancesConfig):
    save_config({"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail})
    return {"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail}
```

- [ ] **Step 5: Run tests**

```bash
.venv/bin/pytest tests/test_config_tolerances_api.py -v
```
Expected: all PASS

- [ ] **Step 6: Run full suite to confirm no regressions**

```bash
.venv/bin/pytest tests/ -v
```
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add backend/config.py backend/api.py tests/test_config_tolerances_api.py
git commit -m "feat: add tolerances config endpoints"
```

---

## Task 3: `/align-dxf` endpoint

**Files:**
- Modify: `backend/api.py`
- Create: `tests/test_align_dxf_api.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_align_dxf_api.py
import math
from tests.conftest import *

_DXF_3_CIRCLES = [
    {"type": "circle", "cx": 0.0, "cy": 0.0, "radius": 5.0},
    {"type": "circle", "cx": 20.0, "cy": 0.0, "radius": 5.0},
    {"type": "circle", "cx": 10.0, "cy": 15.0, "radius": 5.0},
]

def _dxf_to_detected(dxf_circles, ppm, tx, ty):
    """Build detected list with pure translation transform for test setup."""
    return [
        {"x": cx * ppm + tx, "y": -(cy * ppm) + ty, "radius": r * ppm}
        for cx, cy, r in dxf_circles
    ]

def test_align_dxf_returns_transform(client):
    ppm = 10.0
    detected = _dxf_to_detected(
        [(0, 0, 5), (20, 0, 5), (10, 15, 5)], ppm, tx=100.0, ty=80.0
    )
    r = client.post("/align-dxf", json={
        "entities": _DXF_3_CIRCLES,
        "circles": detected,
        "pixels_per_mm": ppm,
    })
    assert r.status_code == 200
    body = r.json()
    assert "tx" in body
    assert "angle_deg" in body
    assert body["confidence"] in ("high", "low", "failed")

def test_align_dxf_rejects_missing_pixels_per_mm(client):
    r = client.post("/align-dxf", json={
        "entities": _DXF_3_CIRCLES,
        "circles": [{"x": 50, "y": 50, "radius": 50}],
    })
    assert r.status_code == 422

def test_align_dxf_returns_400_when_fewer_than_2_dxf_circles(client):
    r = client.post("/align-dxf", json={
        "entities": [{"type": "circle", "cx": 0, "cy": 0, "radius": 5}],
        "circles": [{"x": 50, "y": 50, "radius": 50}],
        "pixels_per_mm": 10.0,
    })
    assert r.status_code == 400

def test_align_dxf_returns_400_when_no_dxf_circles(client):
    r = client.post("/align-dxf", json={
        "entities": [{"type": "line", "x1": 0, "y1": 0, "x2": 1, "y2": 1}],
        "circles": [{"x": 50, "y": 50, "radius": 50}],
        "pixels_per_mm": 10.0,
    })
    assert r.status_code == 400
```

- [ ] **Step 2: Run to verify they fail**

```bash
.venv/bin/pytest tests/test_align_dxf_api.py -v
```
Expected: FAIL — 404 on endpoint

- [ ] **Step 3: Add `AlignDxfBody` model and endpoint to `backend/api.py`**

After the `TolerancesConfig` class, add:

```python
class DetectedCircle(BaseModel):
    x: float
    y: float
    radius: float


class AlignDxfBody(BaseModel):
    entities: list[dict]
    circles: list[DetectedCircle]
    pixels_per_mm: float = Field(gt=0)
```

Also add the import at top of file:
```python
from .vision.alignment import extract_dxf_circles, align_circles
```

After the `/config/tolerances` handlers, add:

```python
@router.post("/align-dxf")
def align_dxf_route(body: AlignDxfBody):
    dxf_circles = extract_dxf_circles(body.entities)
    if len(dxf_circles) < 2:
        raise HTTPException(
            status_code=400,
            detail="At least 2 DXF circles required for alignment",
        )
    detected = [(c.x, c.y, c.radius) for c in body.circles]
    result = align_circles(dxf_circles, detected, body.pixels_per_mm)
    if result.get("error") == "insufficient_dxf_circles":
        raise HTTPException(status_code=400, detail="At least 2 DXF circles required for alignment")
    return result
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/pytest tests/test_align_dxf_api.py -v
```
Expected: all PASS

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add backend/api.py tests/test_align_dxf_api.py
git commit -m "feat: add /align-dxf endpoint"
```

---

## Task 4: HTML — DXF controls, rotation row, Auto-align, Tolerances tab

**Files:**
- Modify: `frontend/index.html`

### What to add

**A. DXF controls group in the Overlay dropdown** (hidden by default, shown when DXF is loaded via JS):

Add after the `btn-set-origin` button in `#dropdown-overlay` (after line 100):

```html
        <div class="dropdown-divider"></div>
        <div id="dxf-controls-group" hidden>
          <div class="dropdown-section-label">DXF overlay</div>
          <div class="dxf-row">
            <label class="dxf-label">Scale</label>
            <input type="number" id="dxf-scale" class="dxf-input" step="0.001" min="0.001" value="1.000" />
            <span class="dxf-unit">px/mm</span>
          </div>
          <div class="dxf-row">
            <label class="dxf-label">Rotation</label>
            <span id="dxf-angle-display" class="dxf-value">0.0°</span>
            <button class="dxf-nudge" id="btn-dxf-rot-m5">−5°</button>
            <button class="dxf-nudge" id="btn-dxf-rot-m1">−1°</button>
            <button class="dxf-nudge" id="btn-dxf-rot-p1">+1°</button>
            <button class="dxf-nudge" id="btn-dxf-rot-p5">+5°</button>
          </div>
          <div class="dxf-row">
            <button class="dxf-btn" id="btn-dxf-flip-h">Flip H</button>
            <button class="dxf-btn" id="btn-dxf-flip-v">Flip V</button>
          </div>
          <div class="dxf-row">
            <button class="dxf-btn" id="btn-dxf-set-origin">Set origin</button>
            <button class="dxf-btn" id="btn-dxf-realign">Realign</button>
            <button class="dxf-btn danger" id="btn-dxf-clear">Clear</button>
          </div>
          <div class="dropdown-divider"></div>
          <button class="dropdown-item" id="btn-auto-align" disabled title="At least 2 DXF circles required">Auto-align</button>
          <button class="dropdown-item" id="btn-show-deviations" disabled>Show deviations</button>
          <div id="align-status" class="dxf-status" hidden></div>
        </div>
```

Note: `<input type="file" id="dxf-input" accept=".dxf" hidden>` already exists at `frontend/index.html:316` — do not add it again.

**B. Tolerances tab in Settings dialog:**

In the `dialog-tabs` div (after line 193), add:
```html
        <button class="settings-tab" data-tab="tolerances">Tolerances</button>
```

After the `settings-display-panel` div (after line 265), add:

```html
      <div class="settings-panel" id="settings-tolerances-panel">
        <div class="settings-row">
          <label class="settings-label" for="tol-warn-input">Warn above (mm)</label>
          <input type="number" id="tol-warn-input" class="settings-input" step="0.01" min="0.001" value="0.10" />
        </div>
        <div class="settings-row">
          <label class="settings-label" for="tol-fail-input">Fail above (mm)</label>
          <input type="number" id="tol-fail-input" class="settings-input" step="0.01" min="0.001" value="0.25" />
        </div>
        <button class="settings-save-btn" id="btn-save-tolerances">Save</button>
        <div id="tolerances-status" class="settings-status"></div>
      </div>
```

- [ ] **Step 1: Add DXF controls group and dxf-input to HTML**

Edit `frontend/index.html` as described above — add the `#dxf-controls-group` div inside `#dropdown-overlay` after `btn-set-origin`, and add `<input type="file" id="dxf-input" accept=".dxf" hidden>` alongside the other hidden inputs (search for `session-file-input` to find their location).

- [ ] **Step 2: Add Tolerances tab to Settings**

Edit `frontend/index.html` as described — add the tab button and panel.

- [ ] **Step 3: Verify the page loads without JS errors**

Start the server in no-camera mode:
```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```
Open `http://localhost:8000`. Check browser console for errors. Settings → Tolerances tab should appear.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html
git commit -m "feat: add DXF controls, rotation row, Tolerances tab to HTML"
```

---

## Task 5: CSS for new elements + `dxfToCanvas()` rotation + DXF controls wiring

**Files:**
- Modify: `frontend/style.css`
- Modify: `frontend/app.js`

### CSS additions

Add to `frontend/style.css` (find the existing `.dropdown` section):

```css
.dropdown-section-label {
  padding: 4px 12px 2px;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.dropdown-divider { height: 1px; background: var(--border); margin: 4px 0; }
.dxf-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 10px;
}
.dxf-label { font-size: 10px; color: var(--text-secondary); width: 52px; flex-shrink: 0; }
.dxf-value { font-size: 10px; color: var(--text); width: 40px; text-align: right; }
.dxf-input { width: 72px; font-size: 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); padding: 2px 4px; }
.dxf-unit  { font-size: 9px; color: var(--muted); }
.dxf-nudge { font-size: 9px; padding: 2px 5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); cursor: pointer; }
.dxf-nudge:hover { background: var(--border); }
.dxf-btn   { font-size: 10px; padding: 3px 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); cursor: pointer; }
.dxf-btn:hover { background: var(--border); }
.dxf-btn.danger { color: var(--danger); }
.dxf-btn.danger:hover { background: var(--danger); color: #fff; }
.dxf-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.dxf-status { font-size: 10px; padding: 4px 12px; color: var(--text-secondary); }
```

### `dxfToCanvas()` change

The existing function (app.js line 1407) uses `state.origin?.angle` for rotation. The DXF overlay rotation (`ann.angle`) must be applied before the Y-flip, in DXF coordinate space. Replace the function body:

```js
function dxfToCanvas(x, y, ann) {
  const { offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  const originAngle = state.origin?.angle ?? 0;

  // 1. Apply DXF overlay rotation in DXF space (Y-up), before flip
  const cosA = Math.cos(annAngle * Math.PI / 180);
  const sinA = Math.sin(annAngle * Math.PI / 180);
  const xr = x * cosA - y * sinA;
  const yr = x * sinA + y * cosA;

  // 2. Flip
  const xf = flipH ? -xr : xr;
  const yf = flipV ? -yr : yr;

  // 3. Scale + Y-flip (DXF Y-up → canvas Y-down)
  let cx = xf * scale;
  let cy = -yf * scale;

  // 4. Apply canvas/origin rotation (existing behaviour)
  if (originAngle) {
    const cos2 = Math.cos(originAngle), sin2 = Math.sin(originAngle);
    [cx, cy] = [cx * cos2 - cy * sin2, cx * sin2 + cy * cos2];
  }

  return { x: offsetX + cx, y: offsetY + cy };
}
```

### DXF controls wiring in app.js

Find the `// ── DXF Overlay` section (around line 2401). Replace/add the wiring:

```js
// Show/hide DXF controls group when overlay is loaded/cleared
function updateDxfControlsVisibility() {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  const group = document.getElementById("dxf-controls-group");
  if (group) group.hidden = !ann;
  // Sync angle display
  if (ann) {
    const display = document.getElementById("dxf-angle-display");
    if (display) display.textContent = `${(ann.angle ?? 0).toFixed(1)}°`;
    const scaleInput = document.getElementById("dxf-scale");
    if (scaleInput) scaleInput.value = (ann.scale ?? 1).toFixed(3);
    const fH = document.getElementById("btn-dxf-flip-h");
    if (fH) fH.classList.toggle("active", ann.flipH ?? false);
    const fV = document.getElementById("btn-dxf-flip-v");
    if (fV) fV.classList.toggle("active", ann.flipV ?? false);
  }
}

// Rotation nudge buttons
[-5, -1, 1, 5].forEach(delta => {
  const id = `btn-dxf-rot-${delta < 0 ? "m" : "p"}${Math.abs(delta)}`;
  document.getElementById(id)?.addEventListener("click", () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    pushUndo();
    ann.angle = ((ann.angle ?? 0) + delta + 360) % 360;
    updateDxfControlsVisibility();
    redraw();
  });
});
```

Also update `loadDxf` (where annotation is created) to include `angle: 0`, and call `updateDxfControlsVisibility()` after loading or clearing DXF. Update session save so `angle` is included (it will be automatically since the whole annotation object is serialised).

- [ ] **Step 1: Add CSS to `frontend/style.css`**

- [ ] **Step 2: Replace `dxfToCanvas()` in `frontend/app.js`**

- [ ] **Step 3: Add `updateDxfControlsVisibility()` and rotation wiring in `frontend/app.js`**

Find the existing DXF overlay section (search for `// ── DXF Overlay`). Add the new functions and call `updateDxfControlsVisibility()` at the end of the DXF load handler and the DXF clear handler.

Also add `angle: 0` to the annotation created in the `dxf-input` change handler:
```js
addAnnotation({
  type: "dxf-overlay",
  entities,
  offsetX: canvas.width / 2,
  offsetY: canvas.height / 2,
  scale,
  angle: 0,      // ← add this
  flipH: false,
  flipV: false,
});
```

- [ ] **Step 4: Manually verify**

Start the server, load a DXF. The DXF controls group should appear in Overlay menu. Clicking ±1° / ±5° should visually rotate the overlay. Undo (Ctrl+Z) should reverse a nudge.

- [ ] **Step 5: Commit**

```bash
git add frontend/style.css frontend/app.js
git commit -m "feat: DXF overlay rotation support with nudge buttons"
```

---

## Task 6: Auto-align wiring

**Files:**
- Modify: `frontend/app.js`

The Auto-align button (`#btn-auto-align`) calls `/align-dxf`. It first ensures detected circles exist (auto-running `/detect-circles` if not), then posts the entities + detected circles + calibration, then applies the returned transform to the DXF overlay annotation.

### Coordinate note

Detected circles in `state.annotations` are stored with coordinates relative to `frameWidth`/`frameHeight`. Before sending to the backend they must be converted to canvas pixels:

```js
function getDetectedCirclesForAlignment() {
  return state.annotations
    .filter(a => a.type === "detected-circle")
    .map(a => ({
      x: a.x * (canvas.width / a.frameWidth),
      y: a.y * (canvas.height / a.frameHeight),
      radius: a.radius * (canvas.width / a.frameWidth),
    }));
}
```

### Auto-align handler

```js
document.getElementById("btn-auto-align")?.addEventListener("click", async () => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;

  const statusEl2 = document.getElementById("align-status");
  function setStatus(msg, isError = false) {
    if (!statusEl2) return;
    statusEl2.textContent = msg;
    statusEl2.style.color = isError ? "var(--danger)" : "var(--text-secondary)";
    statusEl2.hidden = !msg;
  }

  // Ensure we have detected circles
  let circles = getDetectedCirclesForAlignment();
  if (circles.length === 0) {
    // Auto-freeze and detect
    if (!state.frozen) {
      await fetch("/freeze", { method: "POST" });
      state.frozen = true;
      updateFreezeUI();
    }
    setStatus("Running circle detection…");
    const r = await fetch("/detect-circles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_radius: 8, max_radius: 500 }),
    });
    if (!r.ok) { setStatus("Detection failed", true); return; }
    const detected = await r.json();
    if (detected.length === 0) {
      setStatus("No circles detected — run detection manually first", true);
      return;
    }
    // Store detected circles as annotations (reuse existing detection handler logic)
    const info = await fetch("/camera/info").then(r => r.json()); // GET /camera/info returns {width, height, ...} — see backend/api.py:230
    pushUndo();
    state.annotations = state.annotations.filter(a => a.type !== "detected-circle");
    detected.forEach(c => addAnnotation({
      type: "detected-circle", x: c.x, y: c.y, radius: c.radius,
      frameWidth: info.width, frameHeight: info.height,
    }));
    circles = getDetectedCirclesForAlignment();
    redraw();
  }

  const cal = state.calibration;
  if (!cal?.pixelsPerMm) { setStatus("Calibration required for alignment", true); return; }

  setStatus("Aligning…");
  try {
    const r = await fetch("/align-dxf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entities: ann.entities,
        circles,
        pixels_per_mm: cal.pixelsPerMm,
      }),
    });
    if (!r.ok) {
      const err = await r.json();
      setStatus(err.detail ?? "Alignment failed", true);
      return;
    }
    const result = await r.json();
    pushUndo();
    ann.tx = result.tx;         // stored for reference
    ann.ty = result.ty;
    ann.offsetX = result.tx;
    ann.offsetY = result.ty;
    ann.angle = result.angle_deg;
    ann.flipH = result.flip_h;
    ann.flipV = result.flip_v;
    updateDxfControlsVisibility();

    // Enable Show deviations now that we have an alignment
    document.getElementById("btn-show-deviations")?.removeAttribute("disabled");

    if (result.confidence === "high") {
      setStatus(`Aligned — ${result.inlier_count}/${result.total_dxf_circles} features matched`);
    } else if (result.confidence === "low") {
      setStatus(`⚠ Low confidence — only ${result.inlier_count}/${result.total_dxf_circles} matched`, true);
    } else {
      setStatus("⚠ Alignment failed — result unreliable", true);
    }
    redraw();
  } catch (err) {
    setStatus("Network error: " + err.message, true);
  }
});
```

Also update `updateDxfControlsVisibility()` to enable/disable `#btn-auto-align` based on whether the DXF has >= 2 circle entities:

```js
const dxfCircleCount = ann?.entities?.filter(e => e.type === "circle").length ?? 0;
const autoAlignBtn = document.getElementById("btn-auto-align");
if (autoAlignBtn) {
  autoAlignBtn.disabled = dxfCircleCount < 2;
  autoAlignBtn.title = dxfCircleCount < 2 ? "At least 2 DXF circles required" : "";
}
```

- [ ] **Step 1: Add `getDetectedCirclesForAlignment()` helper near the DXF section**

- [ ] **Step 2: Add the auto-align event listener**

- [ ] **Step 3: Update `updateDxfControlsVisibility()` to enable/disable the button**

- [ ] **Step 4: Manually verify**

Load a DXF with circles. Run circle detection on an image. Click Auto-align. The overlay should shift/rotate to match. The align-status div should show the match count.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js
git commit -m "feat: wire Auto-align button to /align-dxf"
```

---

## Task 7: Deviation display

**Files:**
- Modify: `frontend/app.js`

### State

Add to `state` object (near top of app.js, in the state initialisation block):

```js
showDeviations: false,
tolerances: { warn: 0.10, fail: 0.25 },
```

### Deviation colour helper

```js
function deviationColor(delta_mm) {
  const { warn, fail } = state.tolerances;
  if (delta_mm <= warn) return "#30d158";   // --success
  if (delta_mm <= fail) return "#ff9f0a";   // --warning
  return "#ff453a";                          // --danger
}
```

### Matching logic

```js
function matchDxfToDetected(ann) {
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) return [];
  const ppm = cal.pixelsPerMm;

  const detected = state.annotations
    .filter(a => a.type === "detected-circle")
    .map(a => ({
      cx: a.x * (canvas.width / a.frameWidth),
      cy: a.y * (canvas.height / a.frameHeight),
      r:  a.radius * (canvas.width / a.frameWidth),
    }));

  return ann.entities
    .filter(e => e.type === "circle")
    .map(e => {
      const nominal = dxfToCanvas(e.cx, e.cy, ann);
      const r_px = e.radius * ann.scale;
      const threshold = Math.max(10, 0.5 * r_px);
      let best = null, bestDist = Infinity;
      for (const d of detected) {
        const dist = Math.hypot(d.cx - nominal.x, d.cy - nominal.y);
        if (dist < threshold && dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      if (!best) return { nominal, r_px, matched: false };
      const delta_xy_mm = bestDist / ppm;
      const delta_r_mm  = Math.abs(best.r - r_px) / ppm;
      return {
        nominal, r_px,
        detected: best,
        matched: true,
        delta_xy_mm,
        delta_r_mm,
        color: deviationColor(Math.max(delta_xy_mm, delta_r_mm)),
      };
    });
}
```

### Drawing deviations

Add a `drawDeviations(ann)` function called from `redraw()` after `drawDxfOverlay(ann)` when `state.showDeviations` is true:

```js
function drawDeviations(ann) {
  const matches = matchDxfToDetected(ann);
  for (const m of matches) {
    if (!m.matched) {
      // Unmatched: muted dashed circle + crosshair at nominal
      ctx.save();
      ctx.strokeStyle = "#636366";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(m.nominal.x, m.nominal.y, m.r_px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(m.nominal.x - 5, m.nominal.y); ctx.lineTo(m.nominal.x + 5, m.nominal.y);
      ctx.moveTo(m.nominal.x, m.nominal.y - 5); ctx.lineTo(m.nominal.x, m.nominal.y + 5);
      ctx.stroke();
      ctx.fillStyle = "#636366";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText("not detected", m.nominal.x + m.r_px + 4, m.nominal.y);
      ctx.restore();
    } else {
      const { nominal, r_px, detected: det, delta_xy_mm, delta_r_mm, color } = m;
      ctx.save();
      // Nominal circle (dashed blue)
      ctx.strokeStyle = "#0a84ff";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(nominal.x, nominal.y, r_px, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(nominal.x - 5, nominal.y); ctx.lineTo(nominal.x + 5, nominal.y);
      ctx.moveTo(nominal.x, nominal.y - 5); ctx.lineTo(nominal.x, nominal.y + 5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Detected circle (solid, colour-coded)
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(det.cx, det.cy, det.r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(det.cx, det.cy, 2.5, 0, Math.PI * 2); ctx.fill();
      // Labels
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = color;
      const labelX = det.cx + det.r + 4;
      ctx.fillText(`Δ ${delta_xy_mm.toFixed(3)} mm`, labelX, det.cy);
      if (delta_r_mm > state.tolerances.warn) {
        ctx.fillText(`Δr ${delta_r_mm.toFixed(3)} mm`, labelX, det.cy + 13);
      }
      ctx.restore();
    }
  }
}
```

In `redraw()`, find where `drawDxfOverlay(ann)` is called (around line 1285) and add after it:

```js
if (state.showDeviations) drawDeviations(ann);
```

### Show deviations toggle

```js
document.getElementById("btn-show-deviations")?.addEventListener("click", () => {
  state.showDeviations = !state.showDeviations;
  document.getElementById("btn-show-deviations").textContent =
    state.showDeviations ? "Hide deviations" : "Show deviations";
  redraw();
});
```

- [ ] **Step 1: Add `showDeviations` and `tolerances` to `state`**

- [ ] **Step 2: Add `deviationColor()`, `matchDxfToDetected()`, `drawDeviations()` helper functions**

- [ ] **Step 3: Call `drawDeviations()` from `redraw()`**

- [ ] **Step 4: Wire Show deviations toggle button**

- [ ] **Step 5: Manually verify**

Load a DXF with circles. Run circle detection. Auto-align. Click "Show deviations". Matched features should show a dashed blue nominal circle and a solid coloured detected circle with a Δ label. Unmatched DXF circles should appear in muted grey.

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js
git commit -m "feat: deviation display overlay"
```

---

## Task 8: Tolerances — load at startup, save from Settings

**Files:**
- Modify: `frontend/app.js`

### Load at startup

In the startup `init()` function (or wherever `loadUiConfig()` is called), add a `loadTolerances()` call:

```js
async function loadTolerances() {
  try {
    const r = await fetch("/config/tolerances");
    if (!r.ok) return;
    const cfg = await r.json();
    state.tolerances.warn = cfg.tolerance_warn;
    state.tolerances.fail = cfg.tolerance_fail;
    const warnInput = document.getElementById("tol-warn-input");
    const failInput = document.getElementById("tol-fail-input");
    if (warnInput) warnInput.value = cfg.tolerance_warn;
    if (failInput) failInput.value = cfg.tolerance_fail;
  } catch (_) {}
}
```

Call `loadTolerances()` alongside `loadUiConfig()` at startup.

### Save from Settings

```js
document.getElementById("btn-save-tolerances")?.addEventListener("click", async () => {
  const warn = parseFloat(document.getElementById("tol-warn-input")?.value);
  const fail = parseFloat(document.getElementById("tol-fail-input")?.value);
  const statusEl3 = document.getElementById("tolerances-status");
  if (!isFinite(warn) || !isFinite(fail) || warn <= 0 || fail <= 0 || warn >= fail) {
    if (statusEl3) { statusEl3.textContent = "Warn must be > 0 and < Fail"; statusEl3.style.color = "var(--danger)"; }
    return;
  }
  try {
    const r = await fetch("/config/tolerances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tolerance_warn: warn, tolerance_fail: fail }),
    });
    if (r.ok) {
      state.tolerances.warn = warn;
      state.tolerances.fail = fail;
      if (statusEl3) { statusEl3.textContent = "Saved"; statusEl3.style.color = "var(--success)"; }
      if (state.showDeviations) redraw();
    } else {
      if (statusEl3) { statusEl3.textContent = "Save failed"; statusEl3.style.color = "var(--danger)"; }
    }
  } catch (err) {
    if (statusEl3) { statusEl3.textContent = "Error: " + err.message; statusEl3.style.color = "var(--danger)"; }
  }
});
```

Also wire the Tolerances tab in the Settings tab switcher — find where the existing tab buttons are wired (search for `settings-tab` or `data-tab`) and confirm the existing generic tab wiring picks up the new tab automatically. If a manual list is used, add `"tolerances"` to it.

- [ ] **Step 1: Add `loadTolerances()` and call at startup**

- [ ] **Step 2: Add Save button handler for tolerances**

- [ ] **Step 3: Confirm the Tolerances tab is wired in the tab switcher**

- [ ] **Step 4: Manually verify end-to-end**

Open Settings → Tolerances. Change warn to 0.05 and fail to 0.15. Click Save. Open a deviation view — colours should update to reflect new thresholds. Reload the page — thresholds should persist.

- [ ] **Step 5: Run full test suite**

```bash
.venv/bin/pytest tests/ -v
```
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js
git commit -m "feat: load and save deviation tolerances from Settings"
```
