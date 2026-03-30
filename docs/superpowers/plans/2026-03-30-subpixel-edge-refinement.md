# Sub-Pixel Edge Refinement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve measurement accuracy from ~5µm to ~1µm by adding gradient-based sub-pixel edge refinement with pluggable algorithms (parabola, gaussian) across guided inspection, manual measurement, and auto-detection.

**Architecture:** New `backend/vision/subpixel.py` module with a dispatch-based plugin interface. Parabola algorithm first (vectorized NumPy), then Gaussian. Integrates into three paths: guided inspection (always-on), manual measurement snap (click-to-edge), auto-detection (opt-in). Settings in General tab. Second pass adds Gaussian algorithm + gradient visualization overlay.

**Tech Stack:** NumPy (vectorized Sobel, bilinear interpolation, parabola fit), OpenCV (Sobel operator), scipy (not needed — vectorized closed-form instead), FastAPI (new endpoints), vanilla JS (settings UI, snap behavior)

**Spec:** `docs/superpowers/specs/2026-03-30-subpixel-edge-refinement-design.md`

---

## File Map

### New files
| File | Purpose |
|------|---------|
| `backend/vision/subpixel.py` | Core sub-pixel refinement: `refine_subpixel()`, `refine_single_point()`, `available_methods()` |
| `tests/test_subpixel.py` | Unit tests for refinement algorithms with synthetic edge images |

### Files to modify
| File | Changes |
|------|---------|
| `backend/vision/guided_inspection.py` | Add `subpixel` param, refine corridor points before fitting |
| `backend/vision/detection.py` | Add `subpixel` param to contour-based detectors, refine before algebraic fit |
| `backend/api_inspection.py` | Add `subpixel` field to request bodies, new `/refine-point` and `/subpixel-methods` endpoints |
| `backend/api_detection.py` | Add `subpixel` field to detection request bodies |
| `backend/config.py` | Add `subpixel_method` to `_DEFAULTS` |
| `frontend/index.html` | Settings dialog: sub-pixel dropdown in General tab. Detection panel: sub-pixel checkbox. |
| `frontend/main.js` | Wire settings dropdown, persist to config |
| `frontend/tools.js` | Sub-pixel snap in `handleToolClick` before point placement |
| `frontend/dxf.js` | Pass `subpixel` param in guided inspection request |
| `frontend/detect.js` | Pass `subpixel` param in detection requests when checkbox is on |
| `frontend/state.js` | Add `subpixelMethod` to `state.settings` |
| `frontend/render.js` | Diamond handle variant for snapped points |

---

## Phase 1: Core + Parabola + All Integration Points

### Task 1: Core sub-pixel module with parabola algorithm

**Files:**
- Create: `backend/vision/subpixel.py`
- Create: `tests/test_subpixel.py`

- [ ] **Step 1: Write failing tests for `refine_subpixel` with synthetic edge**

Create `tests/test_subpixel.py`:

```python
"""Tests for sub-pixel edge refinement."""
import numpy as np
import cv2
import pytest


def _make_vertical_edge(width=100, height=100, edge_x=50.3):
    """Create a synthetic image with a vertical edge at a known sub-pixel position.
    Left side is dark (30), right side is bright (220). The transition is a smooth
    step centered at edge_x."""
    img = np.zeros((height, width), dtype=np.uint8)
    for x in range(width):
        # Sigmoid-like transition: sharp but smooth
        val = 30 + 190 / (1 + np.exp(-(x - edge_x) * 3))
        img[:, x] = int(np.clip(val, 0, 255))
    return img


def _make_horizontal_edge(width=100, height=100, edge_y=40.7):
    """Horizontal edge at known sub-pixel position."""
    img = np.zeros((height, width), dtype=np.uint8)
    for y in range(height):
        val = 30 + 190 / (1 + np.exp(-(y - edge_y) * 3))
        img[y, :] = int(np.clip(val, 0, 255))
    return img


def _make_diagonal_edge(width=100, height=100, offset=50.3, angle_deg=30):
    """Diagonal edge at known position and angle."""
    img = np.zeros((height, width), dtype=np.uint8)
    angle_rad = np.radians(angle_deg)
    nx, ny = np.cos(angle_rad), np.sin(angle_rad)
    for y in range(height):
        for x in range(width):
            d = (x - width / 2) * nx + (y - height / 2) * ny - (offset - width / 2)
            val = 30 + 190 / (1 + np.exp(-d * 3))
            img[y, x] = int(np.clip(val, 0, 255))
    return img


def _make_circle_edge(width=200, height=200, cx=100.3, cy=99.7, r=50.0):
    """Synthetic circle at known sub-pixel center and radius."""
    img = np.zeros((height, width), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r
            val = 30 + 190 / (1 + np.exp(-d * 3))
            img[y, x] = int(np.clip(val, 0, 255))
    return img


def _get_canny_points(gray, low=50, high=150):
    """Get Canny edge points as Nx2 float64 array (x, y)."""
    edges = cv2.Canny(gray, low, high)
    yx = np.argwhere(edges > 0)
    if len(yx) == 0:
        return np.empty((0, 2), dtype=np.float64)
    return yx[:, ::-1].astype(np.float64)


class TestRefineSubpixelParabola:
    def test_vertical_edge_accuracy(self):
        from backend.vision.subpixel import refine_subpixel
        true_x = 50.3
        gray = _make_vertical_edge(edge_x=true_x)
        edge_xy = _get_canny_points(gray)
        assert len(edge_xy) > 10, "Should detect edge points"
        refined = refine_subpixel(edge_xy, gray, method="parabola")
        assert refined.shape == edge_xy.shape
        # Refined x coordinates should be closer to true_x than integer pixels
        mean_refined_x = refined[:, 0].mean()
        mean_raw_x = edge_xy[:, 0].mean()
        assert abs(mean_refined_x - true_x) < abs(mean_raw_x - true_x), \
            f"Refined {mean_refined_x:.3f} should be closer to {true_x} than raw {mean_raw_x:.3f}"
        assert abs(mean_refined_x - true_x) < 0.15, \
            f"Refined mean {mean_refined_x:.3f} should be within 0.15px of true {true_x}"

    def test_horizontal_edge_accuracy(self):
        from backend.vision.subpixel import refine_subpixel
        true_y = 40.7
        gray = _make_horizontal_edge(edge_y=true_y)
        edge_xy = _get_canny_points(gray)
        refined = refine_subpixel(edge_xy, gray, method="parabola")
        mean_refined_y = refined[:, 1].mean()
        assert abs(mean_refined_y - true_y) < 0.15

    def test_diagonal_edge_accuracy(self):
        from backend.vision.subpixel import refine_subpixel
        gray = _make_diagonal_edge(offset=50.3, angle_deg=30)
        edge_xy = _get_canny_points(gray)
        refined = refine_subpixel(edge_xy, gray, method="parabola")
        # Refined points should have lower scatter perpendicular to the edge
        angle_rad = np.radians(30)
        nx, ny = np.cos(angle_rad), np.sin(angle_rad)
        raw_perp = (edge_xy[:, 0] - 50) * nx + (edge_xy[:, 1] - 50) * ny
        ref_perp = (refined[:, 0] - 50) * nx + (refined[:, 1] - 50) * ny
        assert ref_perp.std() < raw_perp.std(), "Refined should have lower perpendicular scatter"

    def test_circle_edge_produces_better_fit(self):
        from backend.vision.subpixel import refine_subpixel
        from backend.vision.detection import fit_circle_algebraic
        true_cx, true_cy, true_r = 100.3, 99.7, 50.0
        gray = _make_circle_edge(cx=true_cx, cy=true_cy, r=true_r)
        edge_xy = _get_canny_points(gray)
        refined = refine_subpixel(edge_xy, gray, method="parabola")
        raw_cx, raw_cy, raw_r = fit_circle_algebraic(edge_xy.astype(np.float32))
        ref_cx, ref_cy, ref_r = fit_circle_algebraic(refined.astype(np.float32))
        raw_err = np.sqrt((raw_cx - true_cx)**2 + (raw_cy - true_cy)**2) + abs(raw_r - true_r)
        ref_err = np.sqrt((ref_cx - true_cx)**2 + (ref_cy - true_cy)**2) + abs(ref_r - true_r)
        assert ref_err < raw_err, f"Refined error {ref_err:.4f} should be less than raw {raw_err:.4f}"

    def test_none_returns_exact_input(self):
        from backend.vision.subpixel import refine_subpixel
        gray = _make_vertical_edge()
        edge_xy = _get_canny_points(gray)
        result = refine_subpixel(edge_xy, gray, method="none")
        np.testing.assert_array_equal(result, edge_xy)

    def test_clamp_within_one_pixel(self):
        from backend.vision.subpixel import refine_subpixel
        gray = _make_vertical_edge()
        edge_xy = _get_canny_points(gray)
        refined = refine_subpixel(edge_xy, gray, method="parabola")
        diff = np.abs(refined - edge_xy)
        assert diff.max() <= 1.0 + 1e-6, f"Max shift {diff.max():.3f} exceeds ±1.0px clamp"

    def test_empty_input(self):
        from backend.vision.subpixel import refine_subpixel
        gray = np.zeros((100, 100), dtype=np.uint8)
        edge_xy = np.empty((0, 2), dtype=np.float64)
        result = refine_subpixel(edge_xy, gray, method="parabola")
        assert result.shape == (0, 2)

    def test_border_points_handled(self):
        from backend.vision.subpixel import refine_subpixel
        gray = _make_vertical_edge(width=100, edge_x=2.5)  # Edge near left border
        edge_xy = _get_canny_points(gray)
        # Should not crash — border points are either skipped or handled gracefully
        refined = refine_subpixel(edge_xy, gray, method="parabola")
        assert refined.shape == edge_xy.shape


class TestRefineSinglePoint:
    def test_snaps_to_edge(self):
        from backend.vision.subpixel import refine_single_point
        true_x = 50.3
        gray = _make_vertical_edge(edge_x=true_x)
        # Click near the edge (not exactly on it)
        x, y, mag = refine_single_point((48.0, 50.0), gray, search_radius=10)
        assert abs(x - true_x) < 0.3, f"Snapped x={x:.2f}, expected ~{true_x}"
        assert mag > 0, "Magnitude should be positive at an edge"

    def test_no_edge_returns_low_magnitude(self):
        from backend.vision.subpixel import refine_single_point
        gray = np.full((100, 100), 128, dtype=np.uint8)  # Flat image
        x, y, mag = refine_single_point((50.0, 50.0), gray, search_radius=10)
        assert mag < 5, f"Flat area should have near-zero magnitude, got {mag}"


class TestAvailableMethods:
    def test_returns_list(self):
        from backend.vision.subpixel import available_methods
        methods = available_methods()
        assert isinstance(methods, list)
        assert "none" in methods
        assert "parabola" in methods
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_subpixel.py -v`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `backend/vision/subpixel.py`**

```python
"""
Sub-pixel edge refinement for metrology-grade accuracy.

Pluggable algorithm architecture: each method refines integer-pixel Canny edge
locations to sub-pixel precision using gradient information from the source image.

IMPORTANT: The `gray` input must be raw grayscale (cv2.cvtColor BGR2GRAY),
NOT the preprocess() output. Bilateral filtering blurs edge gradients and
degrades sub-pixel precision. CLAHE is acceptable.
"""

import numpy as np
import cv2

# ── Algorithm registry ──────────────────────────────────────────────────────

_METHODS: dict[str, callable] = {}


def _register(name: str):
    """Decorator to register a refinement algorithm."""
    def decorator(fn):
        _METHODS[name] = fn
        return fn
    return decorator


def available_methods() -> list[str]:
    """Return list of supported method names."""
    return ["none"] + sorted(k for k in _METHODS if k != "none")


# ── Public API ──────────────────────────────────────────────────────────────

def refine_subpixel(
    edge_xy: np.ndarray,
    gray: np.ndarray,
    method: str = "parabola",
) -> np.ndarray:
    """Refine Nx2 integer edge coordinates to sub-pixel precision.

    Parameters
    ----------
    edge_xy : (N, 2) float64 array of (x, y) edge pixel coordinates
    gray : uint8 grayscale image (raw, NOT bilateral-filtered)
    method : algorithm name ("none", "parabola", etc.)

    Returns
    -------
    (N, 2) float64 array of refined coordinates
    """
    if method == "none" or len(edge_xy) == 0:
        return edge_xy.copy()

    if method not in _METHODS:
        raise ValueError(f"Unknown sub-pixel method: {method!r}. Available: {available_methods()}")

    # Compute Sobel gradient once (ksize=5 for smoother, more accurate gradients)
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    mag = np.sqrt(gx * gx + gy * gy)

    return _METHODS[method](edge_xy, gray, gx, gy, mag)


def refine_single_point(
    point: tuple[float, float],
    gray: np.ndarray,
    search_radius: int = 10,
    method: str = "parabola",
) -> tuple[float, float, float]:
    """Find and refine the strongest edge near a click point.

    Returns (x, y, magnitude). Low magnitude means no strong edge nearby.
    """
    px, py = int(round(point[0])), int(round(point[1]))
    h, w = gray.shape[:2]

    # Compute Sobel on full image (caller should cache for repeated clicks)
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    mag = np.sqrt(gx * gx + gy * gy)

    # Search window
    x0 = max(0, px - search_radius)
    y0 = max(0, py - search_radius)
    x1 = min(w, px + search_radius + 1)
    y1 = min(h, py + search_radius + 1)

    window_mag = mag[y0:y1, x0:x1]
    if window_mag.size == 0:
        return (point[0], point[1], 0.0)

    # Find strongest edge pixel in window
    local_idx = np.unravel_index(window_mag.argmax(), window_mag.shape)
    best_y = y0 + local_idx[0]
    best_x = x0 + local_idx[1]
    best_mag = float(mag[best_y, best_x])

    if best_mag < 1.0:
        return (point[0], point[1], best_mag)

    # Refine the single point
    edge_xy = np.array([[best_x, best_y]], dtype=np.float64)
    if method != "none" and method in _METHODS:
        refined = _METHODS[method](edge_xy, gray, gx, gy, mag)
        return (float(refined[0, 0]), float(refined[0, 1]), best_mag)

    return (float(best_x), float(best_y), best_mag)


# ── Parabola algorithm ──────────────────────────────────────────────────────

def _bilinear_sample(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear interpolation for arrays of (x, y) float coordinates."""
    h, w = img.shape[:2]
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    x1 = x0 + 1
    y1 = y0 + 1

    # Clamp to image bounds
    x0c = np.clip(x0, 0, w - 1)
    x1c = np.clip(x1, 0, w - 1)
    y0c = np.clip(y0, 0, h - 1)
    y1c = np.clip(y1, 0, h - 1)

    fx = x - x0
    fy = y - y0

    v00 = img[y0c, x0c].astype(np.float64)
    v01 = img[y0c, x1c].astype(np.float64)
    v10 = img[y1c, x0c].astype(np.float64)
    v11 = img[y1c, x1c].astype(np.float64)

    return v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + \
           v10 * (1 - fx) * fy + v11 * fx * fy


@_register("parabola")
def _refine_parabola(edge_xy, gray, gx, gy, mag):
    """Gradient-perpendicular parabola fit (industry standard for metrology)."""
    N = len(edge_xy)
    ex = edge_xy[:, 0]
    ey = edge_xy[:, 1]
    h, w = gray.shape[:2]

    # Gradient direction at each edge pixel (perpendicular to edge)
    ix = np.clip(ex.astype(int), 0, w - 1)
    iy = np.clip(ey.astype(int), 0, h - 1)
    theta = np.arctan2(gy[iy, ix], gx[iy, ix])

    cos_t = np.cos(theta)
    sin_t = np.sin(theta)

    # Sample 5 points along gradient direction at offsets -2, -1, 0, +1, +2
    offsets = np.array([-2, -1, 0, 1, 2], dtype=np.float64)
    samples = np.empty((N, 5), dtype=np.float64)

    for i, off in enumerate(offsets):
        sx = ex + off * cos_t
        sy = ey + off * sin_t
        samples[:, i] = _bilinear_sample(mag, sx, sy)

    # Fit parabola f(t) = at² + bt + c using the 3 central points (analytic)
    # For 3 points at t=-1, 0, +1: a = (s[-1] + s[1] - 2*s[0]) / 2, b = (s[1] - s[-1]) / 2
    s_m1 = samples[:, 1]  # offset -1
    s_0 = samples[:, 2]   # offset 0
    s_p1 = samples[:, 3]  # offset +1

    a = (s_m1 + s_p1 - 2 * s_0) / 2.0
    b = (s_p1 - s_m1) / 2.0

    # Peak location: t_peak = -b / (2a)
    # Guard against a ≈ 0 (flat gradient — no clear peak)
    with np.errstate(divide='ignore', invalid='ignore'):
        t_peak = np.where(np.abs(a) > 1e-10, -b / (2.0 * a), 0.0)

    # Clamp to ±1.0
    t_peak = np.clip(t_peak, -1.0, 1.0)

    # Refined positions
    refined = np.column_stack([
        ex + t_peak * cos_t,
        ey + t_peak * sin_t,
    ])

    return refined
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_subpixel.py -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/vision/subpixel.py tests/test_subpixel.py
git commit -m "feat: add sub-pixel edge refinement core with parabola algorithm"
```

---

### Task 2: Config + API endpoints

**Files:**
- Modify: `backend/config.py` — add `subpixel_method` to `_DEFAULTS`
- Modify: `backend/api_inspection.py` — add `subpixel` to request bodies, new endpoints
- Modify: `backend/api_detection.py` — add `subpixel` to detection request bodies

- [ ] **Step 1: Add `subpixel_method` to config defaults and UI config endpoint**

In `backend/config.py`, add to `_DEFAULTS` dict (line 8):
```python
_DEFAULTS = {
    ...,
    "subpixel_method": "parabola",
}
```

In `backend/api.py`, add `subpixel_method` to `UiConfig` model (line 12):
```python
class UiConfig(BaseModel):
    app_name: str = Field(min_length=1, max_length=100)
    theme: str = Field(max_length=50, pattern=r"^[a-z0-9-]+$")
    subpixel_method: str = Field(default="parabola")
```

Update `get_ui_config()` (line 32) to include `subpixel_method` in response:
```python
"subpixel_method": cfg.get("subpixel_method", "parabola"),
```

Update `post_ui_config()` (line 41) to save it:
```python
save_config({"app_name": body.app_name, "theme": body.theme, "subpixel_method": body.subpixel_method})
```

- [ ] **Step 2: Add `subpixel` field to `InspectGuidedBody` and `FitFeatureBody`**

In `backend/api_inspection.py`, add to `InspectGuidedBody` (around line 49):
```python
    subpixel: str = Field(default="parabola")
```

Add to `FitFeatureBody` (around line 62):
```python
    subpixel: str = Field(default="parabola")
```

- [ ] **Step 3: Add `/refine-point` endpoint**

In `backend/api_inspection.py`, inside `make_inspection_router()`, add:

```python
class RefinePointBody(BaseModel):
    x: float
    y: float
    search_radius: int = Field(default=10, ge=1, le=50)
    subpixel: str = Field(default="parabola")

@router.post("/refine-point")
async def refine_point(body: RefinePointBody):
    frame = frame_store.get()
    if frame is None:
        raise HTTPException(status_code=404, detail="No frame stored")
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    from ..vision.subpixel import refine_single_point
    x, y, magnitude = refine_single_point(
        (body.x, body.y), gray,
        search_radius=body.search_radius,
        method=body.subpixel,
    )
    return {"x": x, "y": y, "magnitude": magnitude}
```

- [ ] **Step 4: Add `/subpixel-methods` endpoint**

In `backend/api_inspection.py`, inside `make_inspection_router()`:

```python
@router.get("/subpixel-methods")
async def get_subpixel_methods():
    from ..vision.subpixel import available_methods
    return available_methods()
```

- [ ] **Step 5: Add `subpixel` field to detection request bodies**

In `backend/api_detection.py`, add `subpixel: str = Field(default="none")` to the Pydantic models for:
- `DetectLinesParams` (or equivalent model used by `/detect-lines-merged`)
- `DetectArcsParams` (used by `/detect-arcs-partial`)
- `CircleParams` (used by `/detect-circles`)

Pass through to the detection functions (wired in Task 4).

- [ ] **Step 6: Run tests**

Run: `python3 -m pytest tests/ -v -k "not test_detect_lines_contour_returns and not test_detect_lines_contour_finds and not test_detects_90pct and not test_vblock"`
Expected: All pass (excluding pre-existing failures)

- [ ] **Step 7: Commit**

```bash
git add backend/config.py backend/api_inspection.py backend/api_detection.py
git commit -m "feat: add sub-pixel API endpoints and config"
```

---

### Task 3: Guided inspection integration

**Files:**
- Modify: `backend/vision/guided_inspection.py` — add `subpixel` parameter, refine edges
- Modify: `backend/api_inspection.py` — pass `subpixel` through to `inspect_features()`

- [ ] **Step 1: Add `subpixel` parameter to `inspect_features()`**

Add `subpixel: str = "parabola"` parameter to the function signature (line 389).

- [ ] **Step 2: Pass `subpixel` and `raw_gray` into per-feature inspection functions**

Sub-pixel refinement must happen **per-corridor** (after corridor masking, before RANSAC), not on the full-frame edge array. This avoids refining 50K+ edge pixels when only a few hundred per corridor are needed.

Compute raw grayscale once in `inspect_features()` after line 411:
```python
raw_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if subpixel != "none" else None
```

Pass `subpixel` and `raw_gray` as additional parameters to `_inspect_line()` and `_inspect_arc_circle()` at lines 433 and 437.

Inside `_inspect_line()`, after the corridor mask produces `corridor_pts` (around line 120), add:
```python
if subpixel != "none" and raw_gray is not None:
    from .subpixel import refine_subpixel
    corridor_pts = refine_subpixel(corridor_pts, raw_gray, method=subpixel)
```

Same pattern inside `_inspect_arc_circle()` after its corridor mask produces `corridor_pts`.

- [ ] **Step 3: Pass `subpixel` from API to `inspect_features()`**

In `backend/api_inspection.py`, the `/inspect-guided` handler calls `inspect_features()`. Add `subpixel=body.subpixel` to that call.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_guided_inspection.py -v`
Expected: All pass (deviations may shift slightly but pass/fail unchanged)

- [ ] **Step 5: Commit**

```bash
git add backend/vision/guided_inspection.py backend/api_inspection.py
git commit -m "feat: sub-pixel refinement in guided inspection (on by default)"
```

---

### Task 4: Auto-detection integration (two-phase)

**Files:**
- Modify: `backend/vision/detection.py` — add `subpixel` to contour-based detectors

- [ ] **Step 1: Add `subpixel` parameter to `detect_lines_contour()`**

Add `subpixel: str = "none"` to the function signature (line 345).

When `subpixel != "none"`, after contour extraction and before the Douglas-Peucker / line fitting loop, compute raw grayscale and refine contour points:

```python
raw_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if subpixel != "none" else None

# In the contour loop, before fitting:
if raw_gray is not None:
    from .subpixel import refine_subpixel
    cnt_xy = cnt[:, 0, :].astype(np.float64)
    cnt_xy = refine_subpixel(cnt_xy, raw_gray, method=subpixel)
    # Use refined points for Douglas-Peucker and endpoint extraction
```

Note: Douglas-Peucker (`cv2.approxPolyDP`) requires integer OpenCV contour format. The approach: run Douglas-Peucker on the original integer contour to identify segment boundaries, then refine the contour points belonging to each segment before computing final endpoints.

- [ ] **Step 2: Add `subpixel` to `detect_circles()` and `detect_partial_arcs()`**

Add `subpixel: str = "none"` parameter to both functions.

**`detect_partial_arcs()`**: Straightforward — add refinement before
`fit_circle_algebraic(pts)` at line 444:
```python
if subpixel != "none":
    raw_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    pts_f64 = refine_subpixel(pts.astype(np.float64), raw_gray, method=subpixel)
    pts = pts_f64.astype(np.float32)
```

**`detect_circles()`**: More complex — `fit_circle_algebraic` is called inside
a nested `_try_contour()` closure at line 161. Pass `raw_gray` and `subpixel`
into the closure. The `minEnclosingCircle` path (line 155) does not use
algebraic fitting, so sub-pixel does not apply there. Only refine the contour
points before `fit_circle_algebraic`:
```python
# Inside _try_contour(), before fit_circle_algebraic:
if raw_gray is not None:
    pts_f64 = refine_subpixel(pts.astype(np.float64), raw_gray, method=subpixel)
    pts = pts_f64.astype(np.float32)
fcx, fcy, fr = fit_circle_algebraic(pts)
```

- [ ] **Step 3: Wire `subpixel` parameter through API endpoints**

In `backend/api_detection.py`, pass `subpixel=params.subpixel` to:
- `detection.detect_lines_contour()` in the `/detect-lines-merged` handler
- `detection.detect_circles()` in the `/detect-circles` handler
- `detection.detect_partial_arcs()` in the `/detect-arcs-partial` handler

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_detection.py tests/test_subpixel.py -v`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add backend/vision/detection.py backend/api_detection.py
git commit -m "feat: opt-in sub-pixel refinement in auto-detection (two-phase)"
```

---

### Task 5: Frontend — settings, snap, and detection checkbox

**Files:**
- Modify: `frontend/state.js` — add `subpixelMethod`
- Modify: `frontend/index.html` — settings dropdown, detection checkbox
- Modify: `frontend/main.js` — wire settings, persist to config
- Modify: `frontend/tools.js` — sub-pixel snap in `handleToolClick`
- Modify: `frontend/dxf.js` — pass `subpixel` in inspection requests
- Modify: `frontend/detect.js` — pass `subpixel` in detection requests

- [ ] **Step 1: Add `subpixelMethod` to state**

In `frontend/state.js`, add to `state.settings` (around line 43):
```js
subpixelMethod: "parabola",
```

- [ ] **Step 2: Add settings UI in General tab**

In `frontend/index.html`, in the General settings panel (after the app name row), add:

```html
<div class="settings-row">
  <label class="settings-label">Sub-pixel method</label>
  <select id="subpixel-method-select" class="settings-select">
    <option value="none">None (pixel-level)</option>
    <option value="parabola" selected>Parabola (default)</option>
  </select>
</div>
```

In the detection panel (Advanced Detection section), add before the buttons:
```html
<div class="detect-row">
  <label class="detect-label" title="Refine edge positions to sub-pixel accuracy before fitting">Sub-pixel</label>
  <input type="checkbox" id="detect-subpixel" />
</div>
```

- [ ] **Step 3: Wire settings dropdown**

In `frontend/main.js`, in the settings dialog wiring section:

```js
// Sub-pixel method dropdown
const subpixelSelect = document.getElementById("subpixel-method-select");
if (subpixelSelect) {
  // Populate from server
  fetch("/subpixel-methods").then(r => r.json()).then(methods => {
    subpixelSelect.innerHTML = methods.map(m =>
      `<option value="${m}"${m === state.settings.subpixelMethod ? " selected" : ""}>${
        m === "none" ? "None (pixel-level)" :
        m === "parabola" ? "Parabola (default)" :
        m === "gaussian" ? "Gaussian (soft edges)" : m
      }</option>`
    ).join("");
  });
  subpixelSelect.addEventListener("change", () => {
    state.settings.subpixelMethod = subpixelSelect.value;
    fetch("/config/ui", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subpixel_method: subpixelSelect.value }),
    });
  });
}
```

Also in `loadUiConfig()` (sidebar.js or main.js — wherever UI config is loaded), set `state.settings.subpixelMethod` from the server config response.

- [ ] **Step 4: Sub-pixel snap in `handleToolClick`**

In `frontend/tools.js`, modify `handleToolClick` (line 101) to become `async`:

```js
export async function handleToolClick(rawPt, e = {}) {
  const { pt: snappedPt } = (state.tool !== "calibrate" && state.tool !== "center-dist")
    ? snapPoint(rawPt, e.altKey ?? false)
    : { pt: rawPt };

  let pt = snappedPt;

  // Sub-pixel edge snap (when frozen, not Alt-held, not select/pan tool)
  if (state.frozen && !e.altKey &&
      state.settings.subpixelMethod !== "none" &&
      state.tool !== "select" && state.tool !== "pan") {
    try {
      const resp = await fetch("/refine-point", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x: pt.x, y: pt.y,
          search_radius: 10,
          subpixel: state.settings.subpixelMethod,
        }),
      });
      if (resp.ok) {
        const refined = await resp.json();
        if (refined.magnitude > 20) {  // Strong edge threshold
          pt = { x: refined.x, y: refined.y, snapped: true };
        }
      }
    } catch { /* network error — use unrefined point */ }
  }

  // ... rest of handleToolClick continues with pt
```

**IMPORTANT: Update the caller in `events-mouse.js`.**

At line 226, `handleToolClick(pt, e)` must become `await handleToolClick(pt, e)`. The `onMouseDown` handler must become async. Since `e.preventDefault()` is called BEFORE the `handleToolClick` call (it's in the early-return paths), making it async does not break event prevention.

```js
// In events-mouse.js, the mousedown handler (line ~29):
canvas.addEventListener("mousedown", async (e) => {
  // ... existing early-return logic (preventDefault already called) ...
  await handleToolClick(pt, e);  // line ~226
});
```

Also update the inspection point-pick path (line ~189) which returns before reaching handleToolClick — no change needed there.

- [ ] **Step 5: Pass `subpixel` in guided inspection requests**

In `frontend/dxf.js`, where "Run Inspection" calls `/inspect-guided`, add to the request body:
```js
subpixel: state.settings.subpixelMethod,
```

Also add to `/fit-feature` requests (manual point-pick).

- [ ] **Step 6: Pass `subpixel` in detection requests when checkbox is on**

In `frontend/detect.js`, for the detection request handlers:

```js
const subpixel = document.getElementById("detect-subpixel")?.checked
  ? state.settings.subpixelMethod : "none";
```

Add `subpixel` to the JSON body of `/detect-lines-merged`, `/detect-circles`, and `/detect-arcs-partial` requests.

- [ ] **Step 7: Manual smoke test**

- Load an image, freeze, place a distance measurement near an edge → point should snap to the edge
- Hold Alt and click → point should place at raw click position
- Run guided inspection → should work with sub-pixel on
- Check settings dialog → dropdown should show methods

- [ ] **Step 8: Commit**

```bash
git add frontend/state.js frontend/index.html frontend/main.js frontend/tools.js frontend/dxf.js frontend/detect.js
git commit -m "feat: sub-pixel snap in measurement tools + settings UI + detection checkbox"
```

---

### Task 6: Visual feedback (diamond handles)

**Files:**
- Modify: `frontend/render.js` — diamond handle variant
- Modify: `frontend/render-annotations.js` — check `snapped` flag on points

- [ ] **Step 1: Add `drawDiamondHandle` to `render.js`**

Next to the existing `drawHandle` function:

```js
export function drawDiamondHandle(pt, color) {
  const s = pw(4);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = pw(1);
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - s);
  ctx.lineTo(pt.x + s, pt.y);
  ctx.lineTo(pt.x, pt.y + s);
  ctx.lineTo(pt.x - s, pt.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
```

- [ ] **Step 2: Use diamond handle for snapped points in annotation drawing**

In `render-annotations.js`, where handles are drawn for selected annotations (e.g., in `drawDistance`), check if the point has `snapped: true`:

```js
// Instead of: drawHandle(ann.a, "#60a5fa");
// Use:
(ann.a.snapped ? drawDiamondHandle : drawHandle)(ann.a, "#60a5fa");
```

Apply to all measurement draw functions that show handles: `drawDistance`, `drawAngle`, `drawCircle`, `drawArcMeasure`, `drawPerpDist`, `drawParaDist`, `drawCalibration`.

- [ ] **Step 3: Commit**

```bash
git add frontend/render.js frontend/render-annotations.js
git commit -m "feat: diamond handle markers for sub-pixel snapped points"
```

---

## Phase 2: Gaussian Algorithm + Gradient Visualization

### Task 7: Gaussian algorithm

**Files:**
- Modify: `backend/vision/subpixel.py` — add `_refine_gaussian`
- Modify: `tests/test_subpixel.py` — add Gaussian-specific tests

- [ ] **Step 1: Write Gaussian-specific tests**

Add to `tests/test_subpixel.py`:

```python
class TestRefineSubpixelGaussian:
    def test_vertical_edge_accuracy(self):
        from backend.vision.subpixel import refine_subpixel
        true_x = 50.3
        gray = _make_vertical_edge(edge_x=true_x)
        edge_xy = _get_canny_points(gray)
        refined = refine_subpixel(edge_xy, gray, method="gaussian")
        mean_refined_x = refined[:, 0].mean()
        assert abs(mean_refined_x - true_x) < 0.2

    def test_soft_edge_better_than_parabola(self):
        """Gaussian should outperform parabola on a blurred (soft) edge."""
        from backend.vision.subpixel import refine_subpixel
        true_x = 50.3
        # Create a very soft edge (low sigmoid steepness)
        img = np.zeros((100, 100), dtype=np.uint8)
        for x in range(100):
            val = 30 + 190 / (1 + np.exp(-(x - true_x) * 0.8))  # shallow slope
            img[:, x] = int(np.clip(val, 0, 255))
        edge_xy = _get_canny_points(img, low=20, high=60)
        if len(edge_xy) < 5:
            pytest.skip("Not enough edge points on soft edge")
        ref_para = refine_subpixel(edge_xy, img, method="parabola")
        ref_gauss = refine_subpixel(edge_xy, img, method="gaussian")
        err_para = abs(ref_para[:, 0].mean() - true_x)
        err_gauss = abs(ref_gauss[:, 0].mean() - true_x)
        # Gaussian should be at least as good (may not always beat parabola)
        assert err_gauss < err_para + 0.1

    def test_available_methods_includes_gaussian(self):
        from backend.vision.subpixel import available_methods
        assert "gaussian" in available_methods()
```

- [ ] **Step 2: Implement Gaussian algorithm**

Add to `backend/vision/subpixel.py`:

```python
@_register("gaussian")
def _refine_gaussian(edge_xy, gray, gx, gy, mag):
    """Second-derivative zero-crossing on intensity profile.
    Better for soft/blurred edges than parabola."""
    N = len(edge_xy)
    ex = edge_xy[:, 0]
    ey = edge_xy[:, 1]
    h, w = gray.shape[:2]

    # Gradient direction at each edge pixel
    ix = np.clip(ex.astype(int), 0, w - 1)
    iy = np.clip(ey.astype(int), 0, h - 1)
    theta = np.arctan2(gy[iy, ix], gx[iy, ix])
    cos_t = np.cos(theta)
    sin_t = np.sin(theta)

    # Sample 7 points along gradient direction
    offsets = np.array([-3, -2, -1, 0, 1, 2, 3], dtype=np.float64)
    samples = np.empty((N, 7), dtype=np.float64)
    gray_f = gray.astype(np.float64)

    for i, off in enumerate(offsets):
        sx = ex + off * cos_t
        sy = ey + off * sin_t
        samples[:, i] = _bilinear_sample(gray_f, sx, sy)

    # Second derivative via finite differences: d2[i] = s[i+1] - 2*s[i] + s[i-1]
    # Compute at offsets -2, -1, 0, +1, +2 (using samples 0..6)
    d2 = np.empty((N, 5), dtype=np.float64)
    for i in range(5):
        d2[:, i] = samples[:, i + 2] - 2 * samples[:, i + 1] + samples[:, i]

    # Find zero-crossing of second derivative near center
    # Look for sign change between adjacent d2 values around the center (index 2)
    t_peak = np.zeros(N, dtype=np.float64)
    for j in range(4):  # check between d2[:,j] and d2[:,j+1]
        offset_base = j - 2  # maps to offset range -2..+2
        sign_change = (d2[:, j] * d2[:, j + 1]) < 0
        # Linear interpolation for zero crossing
        denom = d2[:, j + 1] - d2[:, j]
        safe_denom = np.where(np.abs(denom) > 1e-10, denom, 1.0)
        t_cross = offset_base + (-d2[:, j] / safe_denom)
        # Only use this crossing if it's the one closest to center
        closer = np.abs(t_cross) < np.abs(t_peak)
        use = sign_change & (closer | (t_peak == 0))
        t_peak = np.where(use, t_cross, t_peak)

    # Clamp to ±1.0
    t_peak = np.clip(t_peak, -1.0, 1.0)

    refined = np.column_stack([
        ex + t_peak * cos_t,
        ey + t_peak * sin_t,
    ])
    return refined
```

- [ ] **Step 3: Run tests**

Run: `python3 -m pytest tests/test_subpixel.py -v`
Expected: All pass

- [ ] **Step 4: Update frontend dropdown**

The `/subpixel-methods` endpoint already returns all registered methods dynamically. No code change needed — the dropdown auto-populates. Verify it shows "Gaussian (soft edges)" option.

- [ ] **Step 5: Commit**

```bash
git add backend/vision/subpixel.py tests/test_subpixel.py
git commit -m "feat: add Gaussian sub-pixel algorithm (second-derivative zero-crossing)"
```

---

### Task 8: Gradient visualization overlay

**Files:**
- Modify: `backend/api_inspection.py` — new `/gradient-overlay` endpoint
- Modify: `frontend/index.html` — checkbox in overlay menu
- Modify: `frontend/main.js` — wire toggle
- Modify: `frontend/state.js` — add overlay state
- Modify: `frontend/render.js` — draw gradient overlay

- [ ] **Step 1: Backend endpoint**

In `backend/api_inspection.py`, inside `make_inspection_router()`:

```python
@router.post("/gradient-overlay")
async def gradient_overlay():
    import numpy as np  # api_inspection.py may not import numpy at top level
    frame = frame_store.get()
    if frame is None:
        raise HTTPException(status_code=404, detail="No frame stored")
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=5)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=5)
    mag = np.sqrt(gx * gx + gy * gy)
    # Normalize to 0-255 and apply colormap
    mag_norm = cv2.normalize(mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    colored = cv2.applyColorMap(mag_norm, cv2.COLORMAP_VIRIDIS)
    # Encode as JPEG
    ok, buf = cv2.imencode(".jpg", colored, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise HTTPException(500, detail="Failed to encode gradient overlay")
    return Response(content=buf.tobytes(), media_type="image/jpeg")
```

- [ ] **Step 2: Frontend overlay toggle**

Add checkbox in the Overlay dropdown menu (`frontend/index.html`), alongside the grid toggle:

```html
<label class="dropdown-item">
  <input type="checkbox" id="btn-gradient-overlay" /> Gradient overlay
</label>
```

In `frontend/state.js`, add: `showGradientOverlay: false`

In `frontend/main.js`, wire the checkbox:

```js
document.getElementById("btn-gradient-overlay")?.addEventListener("change", async (e) => {
  state.showGradientOverlay = e.target.checked;
  if (e.target.checked && state.frozen && !state._gradientOverlayImg) {
    const resp = await fetch("/gradient-overlay", { method: "POST" });
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { state._gradientOverlayImg = img; URL.revokeObjectURL(url); redraw(); };
      img.src = url;
    }
  }
  redraw();
});
```

- [ ] **Step 3: Draw gradient overlay in redraw**

In `frontend/render.js`, inside the `redraw()` function, after drawing the frozen background (line 182) and before annotations:

```js
if (state.showGradientOverlay && state._gradientOverlayImg) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.drawImage(state._gradientOverlayImg, 0, 0,
    imageWidth || canvas.width, imageHeight || canvas.height);
  ctx.restore();
}
```

Clear overlay on unfreeze: in the unfreeze handler, add `state._gradientOverlayImg = null;`

- [ ] **Step 4: Manual smoke test**

- Freeze image → toggle "Gradient overlay" → should see green/yellow heatmap over the image
- Edges should be bright, flat areas dark
- Unfreeze → overlay disappears
- Toggle off → overlay disappears

- [ ] **Step 5: Commit**

```bash
git add backend/api_inspection.py frontend/index.html frontend/main.js frontend/state.js frontend/render.js
git commit -m "feat: gradient magnitude visualization overlay"
```

---

## Final Verification

After all 8 tasks:

```bash
python3 -m pytest tests/test_subpixel.py -v    # sub-pixel unit tests
python3 -m pytest tests/ -v                     # all backend tests
node --test tests/frontend/test_*.js            # all frontend tests
```

### Manual test checklist
- [ ] Guided inspection with sub-pixel (default) produces tighter deviations than without
- [ ] Manual measurement snap works: click near edge → snaps, Alt+click → raw position
- [ ] Diamond handles appear on snapped points
- [ ] Settings dialog shows sub-pixel method dropdown in General tab
- [ ] Detection checkbox works: sub-pixel off by default, on when checked
- [ ] Gradient overlay shows edge strength heatmap
- [ ] Gaussian algorithm available in dropdown after Task 7
- [ ] Mitutoyo reference scale: repeatability test shows improvement
