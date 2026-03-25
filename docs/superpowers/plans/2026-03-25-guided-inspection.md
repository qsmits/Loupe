# Phase 2 — DXF-Guided Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace global detect-then-match inspection with corridor-based per-feature detection and manual point-pick fallback.

**Architecture:** New `guided_inspection.py` backend module does per-feature corridor edge detection using Canny + geometry fitting. New `/inspect-guided` endpoint replaces the separate `/match-dxf-lines` + `/match-dxf-arcs` calls. Frontend rewrites "Run Inspection" to call the new API, adds point-pick mode for manual fallback, and renders fitted geometry + edge points.

**Tech Stack:** Python/NumPy/OpenCV (backend), vanilla JS ES modules (frontend), pytest (tests).

**Spec:** `docs/superpowers/specs/2026-03-25-guided-inspection-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `backend/vision/line_arc_matching.py` | Extract `_dxf_to_canvas_px` as public `dxf_to_image_px`. Extract `_perp_dist_point_to_line` as public. |
| `backend/vision/detection.py` | Rename `_preprocess` → `preprocess`, `_fit_circle_algebraic` → `fit_circle_algebraic` (public API). Update all internal callers. |
| `backend/vision/guided_inspection.py` | **NEW** — `inspect_features()`, corridor mask, edge collection, geometry fitting, deviation computation. |
| `backend/api.py` | New endpoint `/inspect-guided`, new endpoint `/fit-feature`, new Pydantic models. |
| `tests/test_guided_inspection.py` | **NEW** — tests for corridor detection, fitting, deviation computation. |
| `frontend/math.js` | Add `fitLine(points)` — least-squares line fit (eigenvector method). |
| `frontend/tools.js` | Add `hitTestDxfEntity(entity, pt, ann)` for click-to-select on projected DXF geometry. |
| `frontend/dxf.js` | Rewrite "Run Inspection" handler. Add point-pick mode handlers. |
| `frontend/render.js` | Draw fitted geometry, edge points, unmatched highlights, point-pick dots + live preview. |
| `frontend/state.js` | Add `inspectionPickTarget`, `inspectionPickPoints`, `inspectionPickFit`. |
| `frontend/main.js` | Wire Enter/Escape/click for point-pick mode. |
| `frontend/sidebar.js` | Clickable unmatched rows. Auto/manual badges. |

---

## PHASE A: Backend

### Task 1: Extract Shared Utility Functions

**Files:**
- Modify: `backend/vision/line_arc_matching.py`
- Modify: `backend/vision/detection.py`

- [ ] **Step 1: Make projection function public in line_arc_matching.py**

In `backend/vision/line_arc_matching.py`, rename `_dxf_to_canvas_px` to `dxf_to_image_px` (line 11). Update all callers in the same file (search for `_dxf_to_canvas_px`).

Also rename `_perp_dist_point_to_line` to `perp_dist_point_to_line` (line 21). Update callers.

- [ ] **Step 2: Make preprocessing functions public in detection.py**

In `backend/vision/detection.py`:
- Rename `_preprocess` to `preprocess` (line 42). Update ALL callers in the file (lines 61, 130, 215, 255, 351, 430, 498 approximately).
- Rename `_fit_circle_algebraic` to `fit_circle_algebraic` (line 93). Update ALL callers in the file.
- Also rename `_arc_angular_coverage` to `arc_angular_coverage` if it's used externally.

- [ ] **Step 3: Run existing tests**

```bash
python3 -m pytest tests/ -v --tb=short 2>&1 | tail -30
```
Expected: all existing tests pass (renames don't break anything since tests import the functions by module, not by name).

- [ ] **Step 4: Commit**

```bash
git add backend/vision/line_arc_matching.py backend/vision/detection.py
git commit -m "refactor: make shared utility functions public (dxf_to_image_px, preprocess, fit_circle_algebraic)"
```

---

### Task 2: Create guided_inspection.py — Core Algorithm

**Files:**
- Create: `backend/vision/guided_inspection.py`
- Create: `tests/test_guided_inspection.py`

This is the heart of Phase 2. The module takes a frame + DXF entities + alignment transform and returns per-feature inspection results.

- [ ] **Step 1: Write tests for corridor edge collection and line fitting**

Create `tests/test_guided_inspection.py`:

```python
"""Tests for DXF-guided corridor inspection."""
import numpy as np
import pytest


def _make_test_frame(width=200, height=200):
    """Create a test frame with a known vertical line at x=100."""
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:, :] = 128  # gray background
    frame[:, 98:102] = 255  # bright vertical line at x=100 (4px wide)
    return frame


def _make_arc_frame(width=200, height=200, cx=100, cy=100, r=50):
    """Create a test frame with a known circle arc."""
    import cv2
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:, :] = 128
    cv2.circle(frame, (cx, cy), r, (255, 255, 255), 2)
    return frame


def test_inspect_line_finds_edge_in_corridor():
    from backend.vision.guided_inspection import inspect_features
    frame = _make_test_frame()
    entities = [{"type": "line", "x1": 100, "y1": 0, "x2": 100, "y2": 200, "handle": "L1"}]
    # Identity transform: 1 px/mm, no offset/rotation
    results = inspect_features(frame, entities, pixels_per_mm=1.0,
                               tx=0, ty=0, angle_deg=0, corridor_px=15)
    assert len(results) == 1
    r = results[0]
    assert r["handle"] == "L1"
    assert r["matched"] is True
    assert r["edge_point_count"] > 5
    assert abs(r["perp_dev_mm"]) < 3.0  # within 3mm (pixels) of nominal


def test_inspect_line_no_edge_unmatched():
    from backend.vision.guided_inspection import inspect_features
    frame = np.full((200, 200, 3), 128, dtype=np.uint8)  # uniform gray, no edges
    entities = [{"type": "line", "x1": 100, "y1": 0, "x2": 100, "y2": 200, "handle": "L2"}]
    results = inspect_features(frame, entities, pixels_per_mm=1.0,
                               tx=0, ty=0, angle_deg=0, corridor_px=15)
    assert len(results) == 1
    assert results[0]["matched"] is False


def test_inspect_circle_finds_arc():
    from backend.vision.guided_inspection import inspect_features
    frame = _make_arc_frame(cx=100, cy=100, r=50)
    entities = [{"type": "circle", "cx": 100, "cy": 100, "radius": 50, "handle": "C1"}]
    results = inspect_features(frame, entities, pixels_per_mm=1.0,
                               tx=0, ty=0, angle_deg=0, corridor_px=15)
    assert len(results) == 1
    r = results[0]
    assert r["matched"] is True
    assert abs(r["center_dev_mm"]) < 5.0
    assert abs(r["radius_dev_mm"]) < 5.0


def test_inspect_with_transform():
    from backend.vision.guided_inspection import inspect_features
    # Line at x=150 in image, DXF says x=50mm with tx=100, ppm=1
    frame = _make_test_frame(width=300, height=200)
    frame[:, :] = 128
    frame[:, 148:152] = 255  # line at x=150
    entities = [{"type": "line", "x1": 50, "y1": 0, "x2": 50, "y2": 200, "handle": "L3"}]
    results = inspect_features(frame, entities, pixels_per_mm=1.0,
                               tx=100, ty=0, angle_deg=0, corridor_px=15)
    assert results[0]["matched"] is True


def test_tolerance_pass_warn_fail():
    from backend.vision.guided_inspection import inspect_features
    frame = _make_test_frame()
    # Line at x=100 in image, DXF says x=100 — should be very close
    entities = [{"type": "line", "x1": 100, "y1": 0, "x2": 100, "y2": 200, "handle": "L4"}]
    results = inspect_features(frame, entities, pixels_per_mm=1.0,
                               tx=0, ty=0, angle_deg=0, corridor_px=15,
                               tolerance_warn=0.5, tolerance_fail=2.0)
    r = results[0]
    assert r["matched"] is True
    assert r["pass_fail"] in ("pass", "warn", "fail")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest tests/test_guided_inspection.py -v 2>&1
```
Expected: ImportError (module doesn't exist yet)

- [ ] **Step 3: Implement `guided_inspection.py`**

Create `backend/vision/guided_inspection.py`:

```python
"""DXF-guided corridor inspection: per-feature edge detection and fitting."""
import math
import numpy as np
import cv2

from .detection import preprocess, fit_circle_algebraic
from .line_arc_matching import dxf_to_image_px, perp_dist_point_to_line


def inspect_features(
    frame: np.ndarray,
    entities: list[dict],
    pixels_per_mm: float,
    tx: float = 0, ty: float = 0,
    angle_deg: float = 0,
    flip_h: bool = False, flip_v: bool = False,
    corridor_px: float = 15,
    tolerance_warn: float = 0.10,
    tolerance_fail: float = 0.25,
    feature_tolerances: dict | None = None,
    smoothing: int = 1,
    canny_low: int = 50, canny_high: int = 130,
) -> list[dict]:
    """
    Run corridor-based inspection for each DXF entity.
    Returns one result dict per entity.
    """
    if feature_tolerances is None:
        feature_tolerances = {}

    # Preprocess and run Canny once for the whole frame
    gray = preprocess(frame, smoothing=smoothing)
    edges = cv2.Canny(gray, canny_low, canny_high)

    # Extract all edge pixel coordinates as (N, 2) array: [[y, x], ...]
    edge_yx = np.argwhere(edges > 0)  # shape (N, 2), columns are (row=y, col=x)
    if edge_yx.size == 0:
        return [_unmatched(e, "no edges in frame") for e in entities]
    edge_xy = edge_yx[:, ::-1].astype(np.float64)  # (N, 2) as (x, y)

    angle_rad = math.radians(angle_deg)
    ppm = pixels_per_mm

    results = []
    for entity in entities:
        etype = entity.get("type", "")
        handle = entity.get("handle")
        tol_w = feature_tolerances.get(handle, {}).get("warn", tolerance_warn)
        tol_f = feature_tolerances.get(handle, {}).get("fail", tolerance_fail)

        if etype in ("line", "polyline_line"):
            r = _inspect_line(entity, edge_xy, ppm, tx, ty, angle_rad,
                              flip_h, flip_v, corridor_px, tol_w, tol_f)
        elif etype in ("arc", "polyline_arc"):
            r = _inspect_arc(entity, edge_xy, ppm, tx, ty, angle_rad,
                             flip_h, flip_v, corridor_px, tol_w, tol_f)
        elif etype == "circle":
            r = _inspect_circle(entity, edge_xy, ppm, tx, ty, angle_rad,
                                flip_h, flip_v, corridor_px, tol_w, tol_f)
        else:
            r = _unmatched(entity, f"unsupported type: {etype}")
        results.append(r)

    return results


def _unmatched(entity, reason=""):
    return {
        "handle": entity.get("handle"),
        "type": entity.get("type"),
        "parent_handle": entity.get("parent_handle"),
        "matched": False,
        "edge_point_count": 0,
        "edge_points_sample": [],
        "fit": None,
        "perp_dev_mm": None,
        "angle_error_deg": None,
        "center_dev_mm": None,
        "radius_dev_mm": None,
        "tolerance_warn": None,
        "tolerance_fail": None,
        "pass_fail": None,
        "reason": reason,
    }


def _sample_points(pts, max_n=50):
    """Evenly sample up to max_n points from an array."""
    if len(pts) <= max_n:
        return pts.tolist()
    idx = np.linspace(0, len(pts) - 1, max_n, dtype=int)
    return pts[idx].tolist()


def _inspect_line(entity, edge_xy, ppm, tx, ty, angle_rad, flip_h, flip_v,
                  corridor_px, tol_w, tol_f):
    """Corridor-based line inspection."""
    # Project DXF line endpoints to image space
    x1i, y1i = dxf_to_image_px(entity["x1"], entity["y1"], ppm, tx, ty, angle_rad, flip_h, flip_v)
    x2i, y2i = dxf_to_image_px(entity["x2"], entity["y2"], ppm, tx, ty, angle_rad, flip_h, flip_v)

    # Line direction and normal
    dx, dy = x2i - x1i, y2i - y1i
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return _unmatched(entity, "degenerate line")

    ux, uy = dx / length, dy / length  # unit direction
    nx, ny = -uy, ux  # unit normal

    # Corridor test (vectorized): project each edge point onto line
    # along = dot(pt - P1, direction), perp = dot(pt - P1, normal)
    rel = edge_xy - np.array([x1i, y1i])
    along = rel[:, 0] * ux + rel[:, 1] * uy
    perp = rel[:, 0] * nx + rel[:, 1] * ny

    # Keep points within corridor: |perp| < corridor_px, -margin < along < length + margin
    margin = length * 0.1
    mask = (np.abs(perp) < corridor_px) & (along > -margin) & (along < length + margin)
    corridor_pts = edge_xy[mask]

    if len(corridor_pts) < 5:
        return _unmatched(entity, f"insufficient edge points ({len(corridor_pts)} < 5)")

    # Fit line using eigenvector method (orthogonal distance regression)
    centroid = corridor_pts.mean(axis=0)
    centered = corridor_pts - centroid
    cov = centered.T @ centered
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    direction = eigenvectors[:, 1]  # eigenvector with largest eigenvalue = line direction

    # Fitted line: centroid + t * direction
    fit_angle = math.degrees(math.atan2(direction[1], direction[0])) % 180
    # Extend fitted line to cover the corridor extent
    proj = centered @ direction
    t_min, t_max = proj.min(), proj.max()
    p1_fit = centroid + t_min * direction
    p2_fit = centroid + t_max * direction

    # Perpendicular deviation: distance from fitted line midpoint to nominal line
    fit_mid = centroid
    perp_dev_px = perp_dist_point_to_line(fit_mid[0], fit_mid[1], x1i, y1i, x2i, y2i)
    perp_dev_mm = perp_dev_px / ppm

    # Angle error
    nom_angle = math.degrees(math.atan2(y2i - y1i, x2i - x1i)) % 180
    angle_err = abs(fit_angle - nom_angle)
    if angle_err > 90:
        angle_err = 180 - angle_err

    dev = perp_dev_mm
    pass_fail = "fail" if dev > tol_f else ("warn" if dev > tol_w else "pass")

    return {
        "handle": entity.get("handle"),
        "type": entity.get("type"),
        "parent_handle": entity.get("parent_handle"),
        "matched": True,
        "edge_point_count": len(corridor_pts),
        "edge_points_sample": _sample_points(corridor_pts),
        "fit": {"type": "line", "x1": float(p1_fit[0]), "y1": float(p1_fit[1]),
                "x2": float(p2_fit[0]), "y2": float(p2_fit[1])},
        "perp_dev_mm": round(perp_dev_mm, 4),
        "angle_error_deg": round(angle_err, 2),
        "center_dev_mm": None,
        "radius_dev_mm": None,
        "tolerance_warn": tol_w,
        "tolerance_fail": tol_f,
        "pass_fail": pass_fail,
        "reason": None,
    }


def _inspect_arc(entity, edge_xy, ppm, tx, ty, angle_rad, flip_h, flip_v,
                 corridor_px, tol_w, tol_f):
    """Corridor-based arc inspection."""
    cxi, cyi = dxf_to_image_px(entity["cx"], entity["cy"], ppm, tx, ty, angle_rad, flip_h, flip_v)
    ri = entity["radius"] * ppm

    # Angular bounds (with margin)
    start_deg = entity.get("start_angle", 0)
    end_deg = entity.get("end_angle", 360)
    margin_deg = math.degrees(corridor_px / (ri + 1e-6))

    return _inspect_circular(entity, edge_xy, cxi, cyi, ri,
                             start_deg - margin_deg, end_deg + margin_deg,
                             ppm, corridor_px, tol_w, tol_f)


def _inspect_circle(entity, edge_xy, ppm, tx, ty, angle_rad, flip_h, flip_v,
                    corridor_px, tol_w, tol_f):
    """Corridor-based circle inspection (full 360°)."""
    cxi, cyi = dxf_to_image_px(entity["cx"], entity["cy"], ppm, tx, ty, angle_rad, flip_h, flip_v)
    ri = entity["radius"] * ppm
    return _inspect_circular(entity, edge_xy, cxi, cyi, ri,
                             0, 360, ppm, corridor_px, tol_w, tol_f)


def _inspect_circular(entity, edge_xy, cxi, cyi, ri,
                      start_deg, end_deg,
                      ppm, corridor_px, tol_w, tol_f):
    """Shared logic for arc and circle corridor inspection."""
    # Radial distance from each edge point to the nominal center
    rel = edge_xy - np.array([cxi, cyi])
    dists = np.hypot(rel[:, 0], rel[:, 1])

    # Corridor: radial distance within [r - corridor, r + corridor]
    radial_mask = (dists > ri - corridor_px) & (dists < ri + corridor_px)

    # Angular bounds (for partial arcs)
    if not (start_deg <= 0 and end_deg >= 360):
        angles = np.degrees(np.arctan2(rel[:, 1], rel[:, 0])) % 360
        s = start_deg % 360
        e = end_deg % 360
        if s <= e:
            angle_mask = (angles >= s) & (angles <= e)
        else:
            angle_mask = (angles >= s) | (angles <= e)
        mask = radial_mask & angle_mask
    else:
        mask = radial_mask

    corridor_pts = edge_xy[mask]
    min_pts = 8

    if len(corridor_pts) < min_pts:
        return _unmatched(entity, f"insufficient edge points ({len(corridor_pts)} < {min_pts})")

    # Fit circle
    try:
        fcx, fcy, fr = fit_circle_algebraic(corridor_pts)
    except (np.linalg.LinAlgError, ValueError):
        return _unmatched(entity, "circle fit failed")

    center_dev_px = math.hypot(fcx - cxi, fcy - cyi)
    radius_dev_px = abs(fr - ri)
    center_dev_mm = center_dev_px / ppm
    radius_dev_mm = radius_dev_px / ppm

    dev = max(center_dev_mm, radius_dev_mm)
    pass_fail = "fail" if dev > tol_f else ("warn" if dev > tol_w else "pass")

    fit_type = "circle" if entity.get("type") == "circle" else "arc"

    return {
        "handle": entity.get("handle"),
        "type": entity.get("type"),
        "parent_handle": entity.get("parent_handle"),
        "matched": True,
        "edge_point_count": len(corridor_pts),
        "edge_points_sample": _sample_points(corridor_pts),
        "fit": {"type": fit_type, "cx": float(fcx), "cy": float(fcy), "r": float(fr)},
        "perp_dev_mm": None,
        "angle_error_deg": None,
        "center_dev_mm": round(center_dev_mm, 4),
        "radius_dev_mm": round(radius_dev_mm, 4),
        "tolerance_warn": tol_w,
        "tolerance_fail": tol_f,
        "pass_fail": pass_fail,
        "reason": None,
    }
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest tests/test_guided_inspection.py -v 2>&1
```
Expected: all pass

- [ ] **Step 5: Run full test suite**

```bash
python3 -m pytest tests/ -v --tb=short 2>&1 | tail -30
```
Expected: all pass (the renames in Task 1 should not break anything)

- [ ] **Step 6: Commit**

```bash
git add backend/vision/guided_inspection.py tests/test_guided_inspection.py
git commit -m "feat: corridor-based guided inspection with per-feature edge detection and fitting"
```

---

### Task 3: API Endpoints

**Files:**
- Modify: `backend/api.py`

- [ ] **Step 1: Add Pydantic model for /inspect-guided**

```python
class InspectGuidedBody(BaseModel):
    entities: list[dict]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    corridor_px: float = Field(default=15.0, gt=0)
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)
    feature_tolerances: dict = Field(default_factory=dict)
    smoothing: int = Field(default=1, ge=1, le=3)

class FitFeatureBody(BaseModel):
    entity: dict
    points: list[list[float]]  # [[x, y], ...]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)
```

- [ ] **Step 2: Add /inspect-guided endpoint**

```python
@router.post("/inspect-guided")
async def inspect_guided_route(body: InspectGuidedBody):
    frame = frame_store.get()
    if frame is None:
        raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
    from .vision.guided_inspection import inspect_features
    return inspect_features(
        frame, body.entities, body.pixels_per_mm,
        body.tx, body.ty, body.angle_deg, body.flip_h, body.flip_v,
        corridor_px=body.corridor_px,
        tolerance_warn=body.tolerance_warn,
        tolerance_fail=body.tolerance_fail,
        feature_tolerances=body.feature_tolerances,
        smoothing=body.smoothing,
    )
```

- [ ] **Step 3: Add /fit-feature endpoint**

```python
@router.post("/fit-feature")
async def fit_feature_route(body: FitFeatureBody):
    from .vision.guided_inspection import fit_manual_points
    return fit_manual_points(
        body.entity, body.points, body.pixels_per_mm,
        body.tx, body.ty, body.angle_deg, body.flip_h, body.flip_v,
        body.tolerance_warn, body.tolerance_fail,
    )
```

- [ ] **Step 4: Add `fit_manual_points` to guided_inspection.py**

```python
def fit_manual_points(entity, points, ppm, tx, ty, angle_deg, flip_h, flip_v,
                      tol_w, tol_f):
    """Fit geometry to user-placed points and compute deviation from DXF nominal."""
    pts = np.array(points, dtype=np.float64)
    if len(pts) < 2:
        return _unmatched(entity, "need at least 2 points")

    angle_rad = math.radians(angle_deg)
    etype = entity.get("type", "")

    if etype in ("line", "polyline_line"):
        if len(pts) < 2:
            return _unmatched(entity, "need at least 2 points for line")
        # Project nominal line
        x1i, y1i = dxf_to_image_px(entity["x1"], entity["y1"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        x2i, y2i = dxf_to_image_px(entity["x2"], entity["y2"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        # Fit line
        centroid = pts.mean(axis=0)
        centered = pts - centroid
        cov = centered.T @ centered
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        direction = eigenvectors[:, 1]
        fit_angle = math.degrees(math.atan2(direction[1], direction[0])) % 180
        proj = centered @ direction
        p1_fit = centroid + proj.min() * direction
        p2_fit = centroid + proj.max() * direction
        perp_dev_px = perp_dist_point_to_line(centroid[0], centroid[1], x1i, y1i, x2i, y2i)
        perp_dev_mm = perp_dev_px / ppm
        nom_angle = math.degrees(math.atan2(y2i - y1i, x2i - x1i)) % 180
        angle_err = abs(fit_angle - nom_angle)
        if angle_err > 90: angle_err = 180 - angle_err
        dev = perp_dev_mm
        pass_fail = "fail" if dev > tol_f else ("warn" if dev > tol_w else "pass")
        return {
            "handle": entity.get("handle"), "type": etype,
            "parent_handle": entity.get("parent_handle"),
            "matched": True, "edge_point_count": len(pts),
            "edge_points_sample": pts.tolist(),
            "fit": {"type": "line", "x1": float(p1_fit[0]), "y1": float(p1_fit[1]),
                    "x2": float(p2_fit[0]), "y2": float(p2_fit[1])},
            "perp_dev_mm": round(perp_dev_mm, 4), "angle_error_deg": round(angle_err, 2),
            "center_dev_mm": None, "radius_dev_mm": None,
            "tolerance_warn": tol_w, "tolerance_fail": tol_f,
            "pass_fail": pass_fail, "reason": None, "source": "manual",
        }

    elif etype in ("arc", "polyline_arc", "circle"):
        if len(pts) < 3:
            return _unmatched(entity, "need at least 3 points for arc/circle")
        cxi, cyi = dxf_to_image_px(entity["cx"], entity["cy"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        ri = entity["radius"] * ppm
        try:
            fcx, fcy, fr = fit_circle_algebraic(pts)
        except (np.linalg.LinAlgError, ValueError):
            return _unmatched(entity, "circle fit failed")
        center_dev_mm = math.hypot(fcx - cxi, fcy - cyi) / ppm
        radius_dev_mm = abs(fr - ri) / ppm
        dev = max(center_dev_mm, radius_dev_mm)
        pass_fail = "fail" if dev > tol_f else ("warn" if dev > tol_w else "pass")
        return {
            "handle": entity.get("handle"), "type": etype,
            "parent_handle": entity.get("parent_handle"),
            "matched": True, "edge_point_count": len(pts),
            "edge_points_sample": pts.tolist(),
            "fit": {"type": "arc" if etype != "circle" else "circle",
                    "cx": float(fcx), "cy": float(fcy), "r": float(fr)},
            "perp_dev_mm": None, "angle_error_deg": None,
            "center_dev_mm": round(center_dev_mm, 4), "radius_dev_mm": round(radius_dev_mm, 4),
            "tolerance_warn": tol_w, "tolerance_fail": tol_f,
            "pass_fail": pass_fail, "reason": None, "source": "manual",
        }

    return _unmatched(entity, f"unsupported type: {etype}")
```

- [ ] **Step 5: Commit**

```bash
git add backend/api.py backend/vision/guided_inspection.py
git commit -m "feat: add /inspect-guided and /fit-feature API endpoints"
```

---

## PHASE B: Frontend — Guided Inspection

### Task 4: Client-Side Line Fitting

**Files:**
- Modify: `frontend/math.js`

- [ ] **Step 1: Add fitLine function**

In `frontend/math.js`, add:

```js
/**
 * Least-squares line fit through N points (eigenvector method).
 * Returns { cx, cy, dx, dy, x1, y1, x2, y2 } where (cx,cy) is centroid,
 * (dx,dy) is unit direction, and (x1,y1)-(x2,y2) spans the point cloud.
 */
export function fitLine(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  // Eigenvector of [[sxx, sxy], [sxy, syy]] with largest eigenvalue
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(theta), dy = Math.sin(theta);
  // Project points onto direction to find extent
  let tMin = Infinity, tMax = -Infinity;
  for (const p of points) {
    const t = (p.x - cx) * dx + (p.y - cy) * dy;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  return {
    cx, cy, dx, dy,
    x1: cx + tMin * dx, y1: cy + tMin * dy,
    x2: cx + tMax * dx, y2: cy + tMax * dy,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/math.js
git commit -m "feat: add fitLine() for client-side least-squares line fitting"
```

---

### Task 5: DXF Feature Hit-Testing

**Files:**
- Modify: `frontend/tools.js`

- [ ] **Step 1: Add hitTestDxfEntity function**

In `frontend/tools.js`, import `dxfToCanvas` from render.js (check if already imported).
Import `viewport` from viewport.js (should already be imported).

Add:

```js
/**
 * Hit-test a DXF entity by projecting it to image-space and checking distance.
 * Returns the entity if hit, null otherwise.
 * If the entity has a parent_handle, also checks compound group members.
 */
export function hitTestDxfEntity(pt, ann) {
  if (!ann || !ann.entities) return null;
  const threshold = 10 / viewport.zoom;
  let bestEntity = null;
  let bestDist = threshold;

  for (const en of ann.entities) {
    let dist = Infinity;
    if (en.type === "line" || en.type === "polyline_line") {
      const p1 = dxfToCanvas(en.x1, en.y1, ann);
      const p2 = dxfToCanvas(en.x2, en.y2, ann);
      dist = distPointToSegment(pt, p1, p2);
    } else if (en.type === "circle") {
      const c = dxfToCanvas(en.cx, en.cy, ann);
      const r = en.radius * ann.scale;
      dist = Math.abs(Math.hypot(pt.x - c.x, pt.y - c.y) - r);
    } else if (en.type === "arc" || en.type === "polyline_arc") {
      const c = dxfToCanvas(en.cx, en.cy, ann);
      const r = en.radius * ann.scale;
      const d = Math.hypot(pt.x - c.x, pt.y - c.y);
      if (Math.abs(d - r) < threshold) {
        // Check angular bounds
        let angle = Math.atan2(pt.y - c.y, pt.x - c.x) * 180 / Math.PI;
        angle = ((angle % 360) + 360) % 360;
        let s = ((en.start_angle % 360) + 360) % 360;
        let e = ((en.end_angle % 360) + 360) % 360;
        const inRange = s <= e ? (angle >= s && angle <= e) : (angle >= s || angle <= e);
        if (inRange) dist = Math.abs(d - r);
      }
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestEntity = en;
    }
  }
  return bestEntity;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/tools.js
git commit -m "feat: add hitTestDxfEntity for click-to-select on projected DXF features"
```

---

### Task 6: Rewrite "Run Inspection" to Use Guided API

**Files:**
- Modify: `frontend/dxf.js`
- Modify: `frontend/state.js`

- [ ] **Step 1: Add new state fields**

In `frontend/state.js`, add after `dxfFilename`:
```js
inspectionPickTarget: null,   // DXF entity (or parent_handle) being manually measured
inspectionPickPoints: [],     // [{x, y}, ...] placed by user during point-pick
inspectionPickFit: null,      // live fit result (client-side computed)
```

- [ ] **Step 2: Rewrite the inspection handler in dxf.js**

Replace the `btn-run-inspection` click handler (the one that calls `/match-dxf-lines` and `/match-dxf-arcs`) with a new handler that calls `/inspect-guided`:

```js
document.getElementById("btn-run-inspection")?.addEventListener("click", async () => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) { showStatus("Calibrate first"); return; }

  const btnEl = document.getElementById("btn-run-inspection");
  const origText = btnEl?.textContent;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Inspecting…"; }
  document.body.style.cursor = "progress";
  canvas.style.cursor = "progress";

  try {
    const resp = await fetch("/inspect-guided", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entities: ann.entities.filter(e =>
          ["line", "polyline_line", "arc", "polyline_arc", "circle"].includes(e.type)),
        pixels_per_mm: cal.pixelsPerMm,
        tx: ann.offsetX,
        ty: ann.offsetY,
        angle_deg: ann.angle ?? 0,
        flip_h: ann.flipH ?? false,
        flip_v: ann.flipV ?? false,
        corridor_px: 15,
        tolerance_warn: state.tolerances.warn,
        tolerance_fail: state.tolerances.fail,
        feature_tolerances: state.featureTolerances,
      }),
    });

    if (!resp.ok) {
      const d = await resp.json().catch(() => null);
      showStatus(d?.detail || "Inspection failed");
      return;
    }

    const results = await resp.json();
    ann.guidedResults = results;  // store on annotation for rendering

    // Populate state.inspectionResults for session persistence
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
      source: r.source ?? "auto",
    }));

    // Capture inspection frame
    try {
      const offscreen = document.createElement("canvas");
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
      const octx = offscreen.getContext("2d");
      octx.drawImage(img, 0, 0, offscreen.width, offscreen.height);
      octx.drawImage(canvas, 0, 0);
      state.inspectionFrame = offscreen.toDataURL("image/jpeg", 0.85);
    } catch (_) { state.inspectionFrame = null; }

    const matched = results.filter(r => r.matched).length;
    const total = results.length;
    showStatus(`Inspection complete — ${matched}/${total} features matched`);

    renderInspectionTable();
    updateExportButtons();
    redraw();
  } catch (err) {
    showStatus("Inspection error: " + err.message);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = origText; }
    document.body.style.cursor = "";
    canvas.style.cursor = "";
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add frontend/dxf.js frontend/state.js
git commit -m "feat: rewrite Run Inspection to use /inspect-guided corridor-based API"
```

---

### Task 7: Render Guided Inspection Results

**Files:**
- Modify: `frontend/render.js`

- [ ] **Step 1: Add guided results rendering**

In `render.js`, find `drawDeviations(ann)`. This currently renders circle/line/arc deviation callouts using `ann.lineMatchResults` and `ann.arcMatchResults`. Add a new function `drawGuidedResults(ann)` that renders the new guided inspection results:

```js
export function drawGuidedResults(ann) {
  const results = ann.guidedResults;
  if (!results || results.length === 0) return;

  for (const r of results) {
    if (r.matched && r.fit) {
      // Draw fitted geometry (solid, color-coded)
      const color = r.pass_fail === "fail" ? "#ff453a"
        : r.pass_fail === "warn" ? "#ff9f0a"
        : "#32d74b";

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = pw(2);

      if (r.fit.type === "line") {
        ctx.beginPath();
        ctx.moveTo(r.fit.x1, r.fit.y1);
        ctx.lineTo(r.fit.x2, r.fit.y2);
        ctx.stroke();
        // Deviation label at midpoint
        const mx = (r.fit.x1 + r.fit.x2) / 2;
        const my = (r.fit.y1 + r.fit.y2) / 2;
        const text = `⊥ ${r.perp_dev_mm?.toFixed(3)} mm`;
        drawLabel(text, mx + pw(5), my - pw(5));
      } else if (r.fit.type === "arc" || r.fit.type === "circle") {
        ctx.beginPath();
        ctx.arc(r.fit.cx, r.fit.cy, r.fit.r, 0, Math.PI * 2);
        ctx.stroke();
        const text = `Δ ${(r.center_dev_mm ?? 0).toFixed(3)} Δr ${(r.radius_dev_mm ?? 0).toFixed(3)}`;
        drawLabel(text, r.fit.cx + r.fit.r + pw(5), r.fit.cy);
      }
      ctx.restore();

      // Draw edge points (subtle gray dots)
      if (r.edge_points_sample) {
        ctx.save();
        ctx.fillStyle = "rgba(150, 150, 150, 0.5)";
        for (const [x, y] of r.edge_points_sample) {
          ctx.beginPath();
          ctx.arc(x, y, pw(1.5), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    } else {
      // Unmatched: draw DXF feature in dashed red
      // The DXF overlay already draws it in cyan — we'll overlay a red dashed version
      // This is handled by checking r.matched in the DXF rendering pass
    }
  }
}
```

- [ ] **Step 2: Call drawGuidedResults from the annotation dispatch**

In `drawAnnotations()`, where `dxf-overlay` is handled, add:

```js
else if (ann.type === "dxf-overlay") {
  drawDxfOverlay(ann);
  if (state.showDeviations) drawDeviations(ann);
  if (ann.guidedResults) drawGuidedResults(ann);  // NEW
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/render.js
git commit -m "feat: render guided inspection results (fitted geometry, edge points, deviation callouts)"
```

---

### Task 8: Point-Pick Mode

**Files:**
- Modify: `frontend/main.js`
- Modify: `frontend/dxf.js`
- Modify: `frontend/render.js`

This is the manual fallback — click a DXF feature, place points, fit geometry.

- [ ] **Step 1: Add point-pick mouse handling in main.js**

In `onMouseDown`, after the pan check and before the dxfDragMode check, add:

```js
// Point-pick mode: add a point for manual inspection
if (state.inspectionPickTarget) {
  const pt = canvasPoint(e);
  state.inspectionPickPoints.push(pt);
  // Client-side live fit
  _updatePickFit();
  redraw();
  return;
}
```

Add the helper:
```js
function _updatePickFit() {
  const pts = state.inspectionPickPoints;
  const target = state.inspectionPickTarget;
  if (!target) return;
  const etype = target.type || (target.entities ? "compound" : "");
  if (etype === "line" || etype === "polyline_line") {
    if (pts.length >= 2) {
      state.inspectionPickFit = fitLine(pts);
    }
  } else if (etype === "arc" || etype === "polyline_arc" || etype === "circle") {
    if (pts.length >= 3) {
      const result = fitCircleAlgebraic(pts);
      if (result) state.inspectionPickFit = { type: "circle", cx: result.cx, cy: result.cy, r: result.r };
    }
  }
}
```

Import `fitLine` from math.js and `fitCircleAlgebraic` from math.js.

- [ ] **Step 2: Add Enter to finalize and Escape to cancel**

In the keydown handler, add:

```js
// Point-pick finalization
if (e.key === "Enter" && state.inspectionPickTarget) {
  _finalizePickInspection();
  return;
}
```

In the Escape handler, add:
```js
if (state.inspectionPickTarget) {
  state.inspectionPickTarget = null;
  state.inspectionPickPoints = [];
  state.inspectionPickFit = null;
  showStatus("Point-pick cancelled");
  redraw();
}
```

- [ ] **Step 3: Add `_finalizePickInspection` function**

```js
async function _finalizePickInspection() {
  const target = state.inspectionPickTarget;
  const pts = state.inspectionPickPoints;
  if (!target || pts.length < 2) {
    showStatus("Need at least 2 points");
    return;
  }
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) return;

  try {
    const resp = await fetch("/fit-feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: target,
        points: pts.map(p => [p.x, p.y]),
        pixels_per_mm: cal.pixelsPerMm,
        tx: ann.offsetX, ty: ann.offsetY,
        angle_deg: ann.angle ?? 0,
        flip_h: ann.flipH ?? false, flip_v: ann.flipV ?? false,
        tolerance_warn: state.tolerances.warn,
        tolerance_fail: state.tolerances.fail,
      }),
    });
    if (!resp.ok) { showStatus("Fit failed"); return; }
    const result = await resp.json();

    // Replace or add to guided results
    if (ann.guidedResults) {
      const idx = ann.guidedResults.findIndex(r => r.handle === target.handle);
      if (idx >= 0) ann.guidedResults[idx] = result;
      else ann.guidedResults.push(result);
    }

    // Update state.inspectionResults
    const sIdx = state.inspectionResults.findIndex(r => r.handle === target.handle);
    const sr = {
      handle: result.handle, type: result.type, parent_handle: result.parent_handle,
      matched: result.matched, deviation_mm: result.perp_dev_mm ?? result.center_dev_mm,
      angle_error_deg: result.angle_error_deg, tolerance_warn: result.tolerance_warn,
      tolerance_fail: result.tolerance_fail, pass_fail: result.pass_fail, source: "manual",
    };
    if (sIdx >= 0) state.inspectionResults[sIdx] = sr;
    else state.inspectionResults.push(sr);

    showStatus(`Manual measurement: ${result.pass_fail?.toUpperCase()}`);
  } catch (err) {
    showStatus("Fit error: " + err.message);
  }

  state.inspectionPickTarget = null;
  state.inspectionPickPoints = [];
  state.inspectionPickFit = null;
  renderInspectionTable();
  redraw();
}
```

- [ ] **Step 4: Add double-click to finalize**

In main.js, add a dblclick handler on the canvas:
```js
canvas.addEventListener("dblclick", e => {
  if (state.inspectionPickTarget) {
    e.preventDefault();
    _finalizePickInspection();
  }
});
```

- [ ] **Step 5: Add point-pick rendering in render.js**

In `redraw()`, inside the viewport transform (after drawing annotations), add:

```js
// Point-pick mode rendering
if (state.inspectionPickTarget) {
  // Draw placed points as orange dots
  ctx.save();
  ctx.fillStyle = "#fb923c";
  for (const p of state.inspectionPickPoints) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, pw(4), 0, Math.PI * 2);
    ctx.fill();
  }
  // Draw live fit preview
  if (state.inspectionPickFit) {
    ctx.strokeStyle = "rgba(50, 215, 75, 0.7)";
    ctx.lineWidth = pw(1.5);
    ctx.setLineDash([pw(4), pw(4)]);
    const f = state.inspectionPickFit;
    if (f.x1 != null) {
      ctx.beginPath();
      ctx.moveTo(f.x1, f.y1);
      ctx.lineTo(f.x2, f.y2);
      ctx.stroke();
    } else if (f.cx != null) {
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, f.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
}
```

- [ ] **Step 6: Enter point-pick mode from DXF click**

In `main.js` `onMouseDown`, add a check for clicking DXF features when the tool is "select" and inspection results exist:

```js
// After the select tool dispatch, before handleToolClick:
if (state.tool === "select") {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (ann && ann.guidedResults) {
    const entity = hitTestDxfEntity(pt, ann);
    if (entity) {
      // Enter point-pick mode for this feature (or its compound group)
      state.inspectionPickTarget = entity;
      state.inspectionPickPoints = [];
      state.inspectionPickFit = null;
      showStatus("Click points along the edge. Double-click or Enter to finish.");
      redraw();
      return;
    }
  }
  handleSelectDown(pt, e);
  return;
}
```

Import `hitTestDxfEntity` from tools.js.

- [ ] **Step 7: Commit**

```bash
git add frontend/main.js frontend/dxf.js frontend/render.js frontend/state.js
git commit -m "feat: point-pick mode for manual DXF feature measurement"
```

---

### Task 9: Sidebar Integration

**Files:**
- Modify: `frontend/sidebar.js`

- [ ] **Step 1: Make unmatched rows clickable**

In `renderInspectionTable()` (in sidebar.js), update the row rendering. For unmatched features, add a click handler that enters point-pick mode:

After creating each `<tr>`, add:
```js
if (!r.matched) {
  tr.style.cursor = "pointer";
  tr.title = "Click to measure manually";
  tr.addEventListener("click", () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    const entity = ann.entities.find(e => e.handle === r.handle);
    if (!entity) return;
    state.inspectionPickTarget = entity;
    state.inspectionPickPoints = [];
    state.inspectionPickFit = null;
    showStatus("Click points along the edge. Double-click or Enter to finish.");
    redraw();
  });
}
```

- [ ] **Step 2: Add auto/manual badge**

In the row HTML, after the pass/fail badge, add:
```js
const sourceText = r.source === "manual" ? "M" : "A";
const sourceClass = r.source === "manual" ? "badge-manual" : "badge-auto";
```
Add a small badge span in the row.

- [ ] **Step 3: Add CSS for manual badge**

In `frontend/style.css`:
```css
.badge-manual { color: var(--text-secondary); font-size: 8px; font-weight: 600; }
.badge-auto { color: var(--muted); font-size: 8px; }
```

- [ ] **Step 4: Commit**

```bash
git add frontend/sidebar.js frontend/style.css
git commit -m "feat: clickable unmatched rows and auto/manual badges in inspection table"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Backend test**

```bash
python3 -m pytest tests/test_guided_inspection.py tests/ -v --tb=short 2>&1 | tail -30
```

- [ ] **Step 2: Full workflow test**

1. Freeze frame, load DXF, auto-align
2. Click "Run Inspection" → should call `/inspect-guided` (check network tab)
3. Matched features show fitted geometry (green/amber/red lines/arcs) + edge points (gray dots)
4. Unmatched features show in sidebar as clickable
5. Click an unmatched DXF feature on canvas → enters point-pick mode
6. Click 3-5 points along the edge → orange dots + live fit preview (dashed green)
7. Double-click or Enter → finalizes, shows deviation
8. Check inspection table for auto/manual badges

- [ ] **Step 3: Commit any fixes**

```bash
git add -p
git commit -m "fix: <description>"
```
