# Line & Arc Detection Foundation (M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the detection pipeline so it produces reliable full lines and partial arcs, then expose those results through new API endpoints and DXF matching logic.

**Architecture:** Synthetic numpy test images committed to `tests/fixtures/detection/` with JSON sidecars serve as the CI test bed. `merge_line_segments` (Hough fallback) and `detect_lines_contour` (primary path) are added to `detection.py`; `detect_partial_arcs` is a fully independent code path — `detect_circles` and `_ARC_MIN_COVERAGE=160` are never touched. A new file `backend/vision/line_arc_matching.py` handles the DXF matching math, and four new API endpoints wire it into the app.

**Tech Stack:** Python 3.13, FastAPI, OpenCV, NumPy, pytest, httpx/TestClient, Vanilla JS (ES2022), Canvas 2D API.

---

## File map

| File | Change |
|------|--------|
| `tests/fixtures/detection/` | New directory: synthetic PNG images + JSON sidecars |
| `tests/fixtures/detection/gen_fixtures.py` | Generator script (run once to produce images) |
| `tests/test_detection_fixtures.py` | New: fixture-driven tests for all detection functions |
| `backend/vision/detection.py` | Add `merge_line_segments`, `detect_lines_contour`, `detect_partial_arcs` |
| `backend/vision/line_arc_matching.py` | New file: `match_lines`, `match_arcs` |
| `tests/test_line_arc_matching.py` | New: unit tests for matching math |
| `backend/api.py` | Add `DetectedLine`, `DetectedArc`, `MatchDxfLinesBody`, `MatchDxfArcsBody` models; add 4 new endpoints inside `make_router` |
| `tests/test_line_arc_api.py` | New: API tests for all 4 new endpoints |
| `frontend/app.js` | Add detect-lines-merged and detect-arcs-partial buttons, handlers, overlay rendering |
| `frontend/index.html` | Add two new detect buttons |

`detect_circles` in `detection.py` is never modified. `_ARC_MIN_COVERAGE = 160` is never touched.

---

## Task 1: Reference snapshot set (synthetic images + JSON sidecars)

**Files:**
- Create directory: `tests/fixtures/detection/`
- Create: `tests/fixtures/detection/gen_fixtures.py`
- Create: `tests/fixtures/detection/rect_edges.png` + `.json`
- Create: `tests/fixtures/detection/partial_arc.png` + `.json`
- Create: `tests/fixtures/detection/hough_fragments.png` + `.json`
- Create: `tests/test_detection_fixtures.py`

Three synthetic images are sufficient for CI (no real camera needed):
- **`rect_edges`** — white rectangle on black. 4 edges, 0 arcs.
- **`partial_arc`** — 90° arc, center (320,240), radius 100. 0 edges, 1 arc.
- **`hough_fragments`** — single long horizontal line drawn with gaps. 1 merged edge, 0 arcs.

JSON sidecar schema: `{"edges": [[x0, y0, x1, y1], ...], "arcs": [{"cx", "cy", "r", "start_deg", "end_deg"}, ...]}`

- [ ] **Step 1: Create the generator script**

Create `tests/fixtures/detection/gen_fixtures.py`:

```python
"""
Run once to regenerate fixture images.
Not a pytest test. Run: python tests/fixtures/detection/gen_fixtures.py
"""
import json, pathlib
import cv2, numpy as np

OUT = pathlib.Path(__file__).parent


def make_rect_edges():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.rectangle(frame, (200, 150), (440, 330), (255, 255, 255), 2)
    cv2.imwrite(str(OUT / "rect_edges.png"), frame)
    (OUT / "rect_edges.json").write_text(json.dumps({
        "edges": [[200,150,440,150],[440,150,440,330],[440,330,200,330],[200,330,200,150]],
        "arcs": [],
    }, indent=2))


def make_partial_arc():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.ellipse(frame, (320, 240), (100, 100), 0, 0, 90, (255, 255, 255), 2)
    cv2.imwrite(str(OUT / "partial_arc.png"), frame)
    (OUT / "partial_arc.json").write_text(json.dumps({
        "edges": [],
        "arcs": [{"cx": 320.0, "cy": 240.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}],
    }, indent=2))


def make_hough_fragments():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    for x1, y1, x2, y2 in [(80,240,200,240),(210,240,350,240),(360,240,560,240)]:
        cv2.line(frame, (x1,y1), (x2,y2), (255,255,255), 2)
    cv2.imwrite(str(OUT / "hough_fragments.png"), frame)
    (OUT / "hough_fragments.json").write_text(json.dumps({
        "edges": [[80, 240, 560, 240]],
        "arcs": [],
    }, indent=2))


if __name__ == "__main__":
    make_rect_edges(); make_partial_arc(); make_hough_fragments()
    print("Fixtures written to", OUT)
```

- [ ] **Step 2: Run the generator**

```bash
cd /Users/qsmits/Projects/MainDynamics/microscope && .venv/bin/python tests/fixtures/detection/gen_fixtures.py
```

Expected: 6 files created in `tests/fixtures/detection/`.

- [ ] **Step 3: Write fixture-driven tests**

Create `tests/test_detection_fixtures.py`:

```python
"""
Fixture-driven tests for M2. These fail until Tasks 2–4 complete.
Run: .venv/bin/pytest tests/test_detection_fixtures.py -v
"""
import json, pathlib
import cv2, numpy as np
import pytest

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "detection"
LINE_TOL_PX = 10
ARC_CENTER_TOL_PX = 5
ARC_RADIUS_TOL_FRAC = 0.05
ARC_SPAN_TOL_DEG = 10.0


def _load(name):
    img = cv2.imread(str(FIXTURES / f"{name}.png"))
    assert img is not None
    meta = json.loads((FIXTURES / f"{name}.json").read_text())
    return img, meta


def _line_matched(gt, detected_lines, tol=LINE_TOL_PX):
    gp1, gp2 = (gt[0], gt[1]), (gt[2], gt[3])
    for dl in detected_lines:
        dp1, dp2 = (dl["x1"], dl["y1"]), (dl["x2"], dl["y2"])
        fwd = np.hypot(gp1[0]-dp1[0],gp1[1]-dp1[1]) < tol and np.hypot(gp2[0]-dp2[0],gp2[1]-dp2[1]) < tol
        bwd = np.hypot(gp1[0]-dp2[0],gp1[1]-dp2[1]) < tol and np.hypot(gp2[0]-dp1[0],gp2[1]-dp1[1]) < tol
        if fwd or bwd: return True
    return False


def _arc_matched(gt, detected_arcs):
    for da in detected_arcs:
        dist = np.hypot(da["cx"]-gt["cx"], da["cy"]-gt["cy"])
        r_err = abs(da["r"]-gt["r"]) / (gt["r"]+1e-6)
        span_ok = (abs(da["start_deg"]-gt["start_deg"]) < ARC_SPAN_TOL_DEG and
                   abs(da["end_deg"]-gt["end_deg"]) < ARC_SPAN_TOL_DEG)
        if dist < ARC_CENTER_TOL_PX and r_err < ARC_RADIUS_TOL_FRAC and span_ok:
            return True
    return False


class TestRectEdgesContour:
    def test_detects_90pct_edges(self):
        from backend.vision.detection import detect_lines_contour
        img, meta = _load("rect_edges")
        lines = detect_lines_contour(img)
        matched = sum(1 for gt in meta["edges"] if _line_matched(gt, lines))
        assert matched >= len(meta["edges"]) * 0.9

    def test_no_duplicate_per_edge(self):
        from backend.vision.detection import detect_lines_contour
        img, meta = _load("rect_edges")
        lines = detect_lines_contour(img)
        for gt in meta["edges"]:
            count = sum(1 for dl in lines if _line_matched(gt, [dl]))
            assert count <= 1


class TestRectEdgesMerged:
    def test_detects_90pct_edges(self):
        from backend.vision.detection import merge_line_segments
        img, meta = _load("rect_edges")
        lines = merge_line_segments(img)
        matched = sum(1 for gt in meta["edges"] if _line_matched(gt, lines))
        assert matched >= len(meta["edges"]) * 0.9


class TestHoughFragmentsMerged:
    def test_single_edge_one_segment(self):
        from backend.vision.detection import merge_line_segments
        img, _ = _load("hough_fragments")
        assert len(merge_line_segments(img)) == 1

    def test_merged_matches_ground_truth(self):
        from backend.vision.detection import merge_line_segments
        img, meta = _load("hough_fragments")
        assert _line_matched(meta["edges"][0], merge_line_segments(img), tol=20)


class TestPartialArcFixture:
    def test_detects_arc(self):
        from backend.vision.detection import detect_partial_arcs
        img, _ = _load("partial_arc")
        assert len(detect_partial_arcs(img)) >= 1

    def test_arc_geometry_within_tolerance(self):
        from backend.vision.detection import detect_partial_arcs
        img, meta = _load("partial_arc")
        assert _arc_matched(meta["arcs"][0], detect_partial_arcs(img))
```

- [ ] **Step 4: Run to confirm they fail (expected)**

```bash
.venv/bin/pytest tests/test_detection_fixtures.py -v 2>&1 | head -20
```

Expected: `ImportError` — algorithms not yet implemented.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/detection/ tests/test_detection_fixtures.py
git commit -m "test: add synthetic reference snapshot set for M2 detection"
```

---

## Task 2: Hough fragment merging (`merge_line_segments`)

**Files:**
- Modify: `backend/vision/detection.py`
- Modify: `tests/test_detection.py`

Algorithm: run Hough, normalise angles to [0°, 180°), cluster by angle tolerance, sub-cluster by perpendicular distance from origin, project endpoints onto the cluster direction, merge consecutive points if gap ≤ `gap_tol_px`.

- [ ] **Step 1: Write failing tests**

Add to `tests/test_detection.py`:

```python
def test_merge_line_segments_returns_list_of_dicts():
    from backend.vision.detection import merge_line_segments
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.line(frame, (50, 240), (590, 240), (255, 255, 255), 2)
    lines = merge_line_segments(frame)
    assert isinstance(lines, list) and len(lines) >= 1
    for seg in lines:
        assert {"x1", "y1", "x2", "y2", "length"} <= seg.keys()


def test_merge_line_segments_gapped_line_single_output():
    from backend.vision.detection import merge_line_segments
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    for x1, x2 in [(80,200),(210,350),(360,560)]:
        cv2.line(frame, (x1,240), (x2,240), (255,255,255), 2)
    lines = merge_line_segments(frame)
    assert len(lines) == 1


def test_merge_line_segments_empty_frame():
    from backend.vision.detection import merge_line_segments
    assert merge_line_segments(np.zeros((480,640,3),dtype=np.uint8)) == []
```

- [ ] **Step 2: Run to confirm they fail**

```bash
.venv/bin/pytest tests/test_detection.py -k "merge_line_segments" -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `merge_line_segments` in `backend/vision/detection.py`**

Add constants after the circle constants:

```python
# ── Line merging constants ────────────────────────────────────────────────────
_MERGE_ANGLE_TOL_DEG   = 5.0
_MERGE_GAP_TOL_PX      = 15
_MERGE_PERP_TOL_PX     = 10
_MERGE_HOUGH_THRESHOLD = 30
_MERGE_MIN_LENGTH      = 20
_MERGE_MAX_GAP         = 8
```

Add after `detect_lines`:

```python
def merge_line_segments(
    frame: np.ndarray,
    threshold1: int = 50,
    threshold2: int = 130,
    hough_threshold: int = _MERGE_HOUGH_THRESHOLD,
    min_length: int = _MERGE_MIN_LENGTH,
    max_gap: int = _MERGE_MAX_GAP,
    angle_tol_deg: float = _MERGE_ANGLE_TOL_DEG,
    gap_tol_px: float = _MERGE_GAP_TOL_PX,
    perp_tol_px: float = _MERGE_PERP_TOL_PX,
) -> list[dict]:
    """
    Detect line segments via Hough, then merge collinear fragments.
    A single straight edge always produces at most one output segment.
    T-junctions/corners producing two segments from genuinely separate edges are correct.
    Returns list of {"x1", "y1", "x2", "y2", "length"} dicts.
    """
    gray = _preprocess(frame)
    edges = cv2.Canny(gray, threshold1, threshold2)
    raw = cv2.HoughLinesP(edges, 1, np.pi/180, hough_threshold,
                          minLineLength=min_length, maxLineGap=max_gap)
    if raw is None:
        return []

    segs = []
    for x1, y1, x2, y2 in raw[:, 0]:
        angle = float(np.degrees(np.arctan2(y2-y1, x2-x1)) % 180)
        segs.append((x1, y1, x2, y2, angle))
    segs.sort(key=lambda s: s[4])

    def _perp(x1, y1, x2, y2):
        dx, dy = x2-x1, y2-y1
        return abs(dy*x1 - dx*y1) / (np.hypot(dx, dy) + 1e-6)

    clusters = []
    cur = [segs[0]]
    for s in segs[1:]:
        if abs(s[4] - cur[0][4]) <= angle_tol_deg:
            cur.append(s)
        else:
            clusters.append(cur); cur = [s]
    clusters.append(cur)

    results = []
    for cluster in clusters:
        cluster.sort(key=lambda s: _perp(*s[:4]))
        sub_clusters = [[cluster[0]]]
        for s in cluster[1:]:
            if abs(_perp(*s[:4]) - _perp(*sub_clusters[-1][0][:4])) <= perp_tol_px:
                sub_clusters[-1].append(s)
            else:
                sub_clusters.append([s])

        for sub in sub_clusters:
            rx1, ry1, rx2, ry2 = sub[0][:4]
            rlen = np.hypot(rx2-rx1, ry2-ry1) + 1e-6
            ux, uy = (rx2-rx1)/rlen, (ry2-ry1)/rlen
            projs = []
            for x1, y1, x2, y2, _ in sub:
                projs += [(x1*ux+y1*uy, x1, y1), (x2*ux+y2*uy, x2, y2)]
            projs.sort()
            st, sx, sy = projs[0]
            pt, px, py = projs[0]
            for t, qx, qy in projs[1:]:
                if t - pt > gap_tol_px:
                    length = float(np.hypot(px-sx, py-sy))
                    if length >= min_length:
                        results.append({"x1":int(sx),"y1":int(sy),"x2":int(px),"y2":int(py),"length":round(length,1)})
                    st, sx, sy = t, qx, qy
                pt, px, py = t, qx, qy
            length = float(np.hypot(px-sx, py-sy))
            if length >= min_length:
                results.append({"x1":int(sx),"y1":int(sy),"x2":int(px),"y2":int(py),"length":round(length,1)})

    return results
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/pytest tests/test_detection.py -k "merge_line_segments" -v
.venv/bin/pytest tests/test_detection_fixtures.py::TestHoughFragmentsMerged tests/test_detection_fixtures.py::TestRectEdgesMerged -v
```

Expected: all pass.

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add backend/vision/detection.py tests/test_detection.py
git commit -m "feat: Hough fragment merging via merge_line_segments"
```

---

## Task 3: Contour-based edge tracing (`detect_lines_contour`)

**Files:**
- Modify: `backend/vision/detection.py`
- Modify: `tests/test_detection.py`

Algorithm: `_preprocess` + Canny → find contours → `cv2.approxPolyDP` (DP reduction) → emit consecutive vertex pairs as segments → NMS to remove duplicates.

- [ ] **Step 1: Write failing tests**

Add to `tests/test_detection.py`:

```python
def test_detect_lines_contour_returns_list():
    from backend.vision.detection import detect_lines_contour
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.line(frame, (50, 240), (590, 240), (255, 255, 255), 2)
    lines = detect_lines_contour(frame)
    assert isinstance(lines, list) and len(lines) >= 1
    for seg in lines:
        assert {"x1", "y1", "x2", "y2", "length"} <= seg.keys()


def test_detect_lines_contour_finds_rectangle_edges():
    from backend.vision.detection import detect_lines_contour
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.rectangle(frame, (200, 150), (440, 330), (255, 255, 255), 2)
    assert len(detect_lines_contour(frame)) >= 4


def test_detect_lines_contour_empty_frame():
    from backend.vision.detection import detect_lines_contour
    assert detect_lines_contour(np.zeros((480,640,3),dtype=np.uint8)) == []
```

- [ ] **Step 2: Run to confirm they fail**

```bash
.venv/bin/pytest tests/test_detection.py -k "detect_lines_contour" -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `detect_lines_contour` in `backend/vision/detection.py`**

Add constants after `_MERGE_*`:

```python
# ── Contour-based line detection ──────────────────────────────────────────────
_CONTOUR_DP_EPSILON = 0.02
_CONTOUR_MIN_LENGTH = 20
_CONTOUR_NMS_DIST   = 8
_CONTOUR_NMS_ANGLE  = 5.0
```

Add after `merge_line_segments`:

```python
def detect_lines_contour(
    frame: np.ndarray,
    threshold1: int = 50,
    threshold2: int = 130,
    dp_epsilon: float = _CONTOUR_DP_EPSILON,
    min_length_px: int = _CONTOUR_MIN_LENGTH,
    nms_dist_px: float = _CONTOUR_NMS_DIST,
    nms_angle_deg: float = _CONTOUR_NMS_ANGLE,
) -> list[dict]:
    """
    Detect straight segments via Douglas-Peucker contour approximation.
    Primary path. Does not use Hough. Each visible edge produces at most one segment.
    Returns list of {"x1", "y1", "x2", "y2", "length"} dicts.
    """
    gray = _preprocess(frame)
    edges = cv2.Canny(gray, threshold1, threshold2)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)

    candidates = []
    for cnt in contours:
        arc_len = cv2.arcLength(cnt, closed=False)
        if arc_len < min_length_px:
            continue
        approx = cv2.approxPolyDP(cnt, epsilon=dp_epsilon * arc_len, closed=False)
        pts = approx[:, 0, :]
        for i in range(len(pts) - 1):
            x1, y1 = int(pts[i][0]), int(pts[i][1])
            x2, y2 = int(pts[i+1][0]), int(pts[i+1][1])
            length = float(np.hypot(x2-x1, y2-y1))
            if length < min_length_px:
                continue
            angle = float(np.degrees(np.arctan2(y2-y1, x2-x1)) % 180)
            candidates.append((length, x1, y1, x2, y2, angle))

    candidates.sort(key=lambda c: c[0], reverse=True)
    kept = []
    for length, x1, y1, x2, y2, angle in candidates:
        mx, my = (x1+x2)/2.0, (y1+y2)/2.0
        suppressed = False
        for _, kx1, ky1, kx2, ky2, kangle in kept:
            kmx, kmy = (kx1+kx2)/2.0, (ky1+ky2)/2.0
            dist = np.hypot(mx-kmx, my-kmy)
            adiff = abs(angle - kangle)
            if adiff > 90: adiff = 180 - adiff
            if dist < nms_dist_px and adiff < nms_angle_deg:
                suppressed = True; break
        if not suppressed:
            kept.append((length, x1, y1, x2, y2, angle))

    return [{"x1":x1,"y1":y1,"x2":x2,"y2":y2,"length":round(length,1)}
            for length, x1, y1, x2, y2, _ in kept]
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/pytest tests/test_detection.py -k "detect_lines_contour" -v
.venv/bin/pytest tests/test_detection_fixtures.py::TestRectEdgesContour -v
```

Expected: all pass.

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

- [ ] **Step 6: Commit**

```bash
git add backend/vision/detection.py tests/test_detection.py
git commit -m "feat: contour-based edge tracing via detect_lines_contour"
```

---

## Task 4: Partial arc detection (`detect_partial_arcs`)

**Files:**
- Modify: `backend/vision/detection.py`
- Modify: `tests/test_detection.py`

This is a completely independent code path from `detect_circles`. `_ARC_MIN_COVERAGE=160` is never referenced here. Uses the existing `_fit_circle_algebraic` and `_arc_angular_coverage` helpers.

- [ ] **Step 1: Write failing tests**

Add to `tests/test_detection.py`:

```python
def test_detect_partial_arcs_returns_list():
    from backend.vision.detection import detect_partial_arcs
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.ellipse(frame, (320, 240), (100, 100), 0, 0, 90, (255, 255, 255), 2)
    arcs = detect_partial_arcs(frame)
    assert isinstance(arcs, list)


def test_detect_partial_arcs_finds_90deg_arc():
    from backend.vision.detection import detect_partial_arcs
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.ellipse(frame, (320, 240), (100, 100), 0, 0, 90, (255, 255, 255), 2)
    arcs = detect_partial_arcs(frame)
    assert len(arcs) >= 1
    a = arcs[0]
    assert {"cx", "cy", "r", "start_deg", "end_deg"} <= a.keys()
    assert abs(a["cx"] - 320) < 10
    assert abs(a["cy"] - 240) < 10
    assert abs(a["r"] - 100) < 10


def test_detect_partial_arcs_empty_frame():
    from backend.vision.detection import detect_partial_arcs
    assert detect_partial_arcs(np.zeros((480,640,3),dtype=np.uint8)) == []


def test_detect_partial_arcs_does_not_modify_circle_detection():
    """detect_circles on a full circle frame must return the same result before and after M2."""
    from backend.vision.detection import detect_circles, detect_partial_arcs
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.circle(frame, (320, 240), 100, (255, 255, 255), 2)
    circles_before = detect_circles(frame)
    detect_partial_arcs(frame)   # must not modify any shared state
    circles_after = detect_circles(frame)
    assert circles_before == circles_after
```

- [ ] **Step 2: Run to confirm they fail**

```bash
.venv/bin/pytest tests/test_detection.py -k "detect_partial_arcs" -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `detect_partial_arcs` in `backend/vision/detection.py`**

Add constants after `_CONTOUR_*`:

```python
# ── Partial arc detection constants ───────────────────────────────────────────
_ARC_PARTIAL_MIN_SPAN_DEG  = 45.0
_ARC_PARTIAL_MAX_SPAN_DEG  = 340.0   # suppress near-full circles
_ARC_PARTIAL_RESIDUAL_TOL  = 0.08    # looser than _ARC_MAX_RESIDUAL=0.06
_ARC_PARTIAL_NMS_CENTER_PX = 10
_ARC_PARTIAL_NMS_R_RATIO   = 0.10
```

Add after `detect_lines_contour`:

```python
def detect_partial_arcs(
    frame: np.ndarray,
    threshold1: int = 50,
    threshold2: int = 130,
    min_radius: int = 8,
    max_radius: int = 500,
    min_span_deg: float = _ARC_PARTIAL_MIN_SPAN_DEG,
    residual_tol: float = _ARC_PARTIAL_RESIDUAL_TOL,
) -> list[dict]:
    """
    Detect partial arcs (arc segments subtending >= min_span_deg degrees).

    Entirely independent of detect_circles. _ARC_MIN_COVERAGE=160 is not used here.
    Returns list of {"cx", "cy", "r", "start_deg", "end_deg"} dicts (image pixels / degrees).
    """
    gray = _preprocess(frame)
    edges = cv2.Canny(gray, threshold1, threshold2)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_CLOSE_KERNEL_SMALL,) * 2)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, k)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)

    candidates = []  # (coverage, cx, cy, r, start_deg, end_deg)
    for cnt in contours:
        pts = cnt[:, 0, :].astype(np.float32)
        if len(pts) < 8:
            continue
        try:
            fcx, fcy, fr = _fit_circle_algebraic(pts)
        except (np.linalg.LinAlgError, ValueError):
            continue
        if not (min_radius <= fr <= max_radius):
            continue
        residuals = np.abs(np.hypot(pts[:, 0] - fcx, pts[:, 1] - fcy) - fr)
        if np.mean(residuals) / (fr + 1e-6) > residual_tol:
            continue
        coverage = _arc_angular_coverage(pts, fcx, fcy)
        if coverage < min_span_deg or coverage >= _ARC_PARTIAL_MAX_SPAN_DEG:
            continue
        # Compute start/end angles from point angular extent
        angles = np.degrees(np.arctan2(pts[:, 1] - fcy, pts[:, 0] - fcx)) % 360
        start_deg = float(np.min(angles))
        end_deg   = float(np.max(angles))
        candidates.append((coverage, float(fcx), float(fcy), float(fr), start_deg, end_deg))

    # NMS: suppress lower-coverage arcs near higher-coverage ones
    candidates.sort(key=lambda c: c[0], reverse=True)
    kept = []
    for cov, cx, cy, r, s, e in candidates:
        suppressed = False
        for _, kcx, kcy, kr, _, _ in kept:
            if (np.hypot(cx-kcx, cy-kcy) < _ARC_PARTIAL_NMS_CENTER_PX and
                    abs(r-kr)/(max(r,kr)+1e-6) < _ARC_PARTIAL_NMS_R_RATIO):
                suppressed = True; break
        if not suppressed:
            kept.append((cov, cx, cy, r, s, e))

    return [{"cx": cx, "cy": cy, "r": r, "start_deg": s, "end_deg": e}
            for _, cx, cy, r, s, e in kept]
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/pytest tests/test_detection.py -k "detect_partial_arcs" -v
.venv/bin/pytest tests/test_detection_fixtures.py::TestPartialArcFixture -v
```

Expected: all pass.

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

- [ ] **Step 6: Commit**

```bash
git add backend/vision/detection.py tests/test_detection.py
git commit -m "feat: partial arc detection via detect_partial_arcs (independent of detect_circles)"
```

---

## Task 5: DXF matching logic (`line_arc_matching.py`)

**Files:**
- Create: `backend/vision/line_arc_matching.py`
- Create: `tests/test_line_arc_matching.py`

### Background

**Line deviation:** perpendicular distance from the DXF segment's midpoint to the detected segment's infinite line. Valid because longitudinal shifts appear as deviations on adjacent intersecting features. Angular error (degrees) reported separately.

**Arc deviation:** center distance (mm) + radius difference (mm). Both use `pixels_per_mm` for conversion.

- [ ] **Step 1: Write failing tests**

Create `tests/test_line_arc_matching.py`:

```python
import math
import pytest
from backend.vision.line_arc_matching import match_lines, match_arcs


def test_match_lines_perfect_match():
    dxf_lines = [{"type": "line", "x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0, "handle": "A1"}]
    # Detected line at same position in pixels (ppm=10, shift=100px)
    detected = [{"x1": 100, "y1": 0, "x2": 200, "y2": 0, "length": 100.0}]
    ppm = 10.0
    results = match_lines(dxf_lines, detected, ppm, tx=100, ty=0, angle_deg=0)
    assert len(results) == 1
    r = results[0]
    assert r["matched"] is True
    assert r["perp_dev_mm"] == pytest.approx(0.0, abs=0.01)
    assert r["angle_error_deg"] == pytest.approx(0.0, abs=0.5)


def test_match_lines_no_match_returns_unmatched():
    dxf_lines = [{"type": "line", "x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0, "handle": "A1"}]
    detected = []
    results = match_lines(dxf_lines, detected, ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert results[0]["matched"] is False


def test_match_arcs_perfect_match():
    dxf_arcs = [{"type": "arc", "cx": 0.0, "cy": 0.0, "radius": 10.0,
                 "start_angle": 0.0, "end_angle": 90.0, "handle": "B1"}]
    ppm = 10.0
    # Detected arc at DXF position scaled to pixels
    detected = [{"cx": 0.0, "cy": 0.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}]
    results = match_arcs(dxf_arcs, detected, ppm, tx=0, ty=0, angle_deg=0)
    assert results[0]["matched"] is True
    assert results[0]["center_dev_mm"] == pytest.approx(0.0, abs=0.01)
    assert results[0]["radius_dev_mm"] == pytest.approx(0.0, abs=0.01)


def test_match_arcs_no_match():
    dxf_arcs = [{"type": "arc", "cx": 0.0, "cy": 0.0, "radius": 10.0,
                 "start_angle": 0.0, "end_angle": 90.0, "handle": "B1"}]
    results = match_arcs(dxf_arcs, [], ppm=10.0, tx=0, ty=0, angle_deg=0)
    assert results[0]["matched"] is False
```

- [ ] **Step 2: Run to confirm they fail**

```bash
.venv/bin/pytest tests/test_line_arc_matching.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `backend/vision/line_arc_matching.py`**

Create new file:

```python
"""
DXF line and arc matching against detected segments.

All DXF coordinates are in mm. Detected segments are in image pixels.
The alignment transform (tx, ty, angle_deg) maps DXF pixel coordinates
to canvas pixel coordinates (same convention as alignment.py).
"""
import math
import numpy as np


def _dxf_to_canvas_px(x_mm, y_mm, ppm, tx, ty, angle_rad, flip_h=False, flip_v=False):
    """Convert a DXF point (mm, Y-up) to canvas pixels (Y-down) via the alignment transform."""
    cx = x_mm * ppm * (-1 if flip_h else 1)
    cy = y_mm * ppm * (-1 if flip_v else 1)
    cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
    mx = cx * cos_a - cy * sin_a + tx
    my = -(cx * sin_a + cy * cos_a) + ty
    return mx, my


def _perp_dist_point_to_line(px, py, x1, y1, x2, y2):
    """Perpendicular distance from point (px,py) to the infinite line through (x1,y1)-(x2,y2)."""
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return math.hypot(px - x1, py - y1)
    return abs(dy * (x1 - px) - dx * (y1 - py)) / length


def _angle_diff_deg(a1, a2):
    """Smallest angle difference in degrees between two line angles (both in [0,180))."""
    diff = abs(a1 - a2) % 180
    return min(diff, 180 - diff)


def match_lines(dxf_lines, detected_lines, ppm, tx=0.0, ty=0.0, angle_deg=0.0,
                flip_h=False, flip_v=False, max_dist_px=50.0):
    """
    Match DXF LINE entities to detected line segments.

    Returns list of dicts, one per DXF line:
      {"handle", "matched": bool,
       "perp_dev_mm": float,  "angle_error_deg": float,
       "pass_fail": "pass"|"warn"|"fail"|None}
    pass_fail is None when matched=False; tolerance thresholds are applied by the caller.
    """
    angle_rad = math.radians(angle_deg)
    results = []

    for entity in dxf_lines:
        if entity.get("type") != "line":
            continue
        # Transform DXF midpoint to canvas pixels
        mx_mm = (entity["x1"] + entity["x2"]) / 2.0
        my_mm = (entity["y1"] + entity["y2"]) / 2.0
        mx_px, my_px = _dxf_to_canvas_px(mx_mm, my_mm, ppm, tx, ty, angle_rad, flip_h, flip_v)

        # DXF line angle in canvas space
        ex1_px, ey1_px = _dxf_to_canvas_px(entity["x1"], entity["y1"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        ex2_px, ey2_px = _dxf_to_canvas_px(entity["x2"], entity["y2"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        dxf_angle = math.degrees(math.atan2(ey2_px - ey1_px, ex2_px - ex1_px)) % 180

        # Find best matching detected line: closest by perpendicular distance + angle
        best = None
        best_dist = float("inf")
        for dl in detected_lines:
            perp = _perp_dist_point_to_line(mx_px, my_px, dl["x1"], dl["y1"], dl["x2"], dl["y2"])
            if perp > max_dist_px:
                continue
            det_angle = math.degrees(math.atan2(dl["y2"]-dl["y1"], dl["x2"]-dl["x1"])) % 180
            angle_err = _angle_diff_deg(dxf_angle, det_angle)
            if perp < best_dist:
                best_dist = perp
                best = (dl, perp, angle_err)

        if best is None:
            results.append({"handle": entity.get("handle"), "matched": False,
                            "perp_dev_mm": None, "angle_error_deg": None, "pass_fail": None})
        else:
            dl, perp, angle_err = best
            results.append({
                "handle": entity.get("handle"),
                "matched": True,
                "perp_dev_mm": round(perp / ppm, 4),
                "angle_error_deg": round(angle_err, 2),
                "pass_fail": None,  # caller sets based on tolerance
            })

    return results


def match_arcs(dxf_arcs, detected_arcs, ppm, tx=0.0, ty=0.0, angle_deg=0.0,
               flip_h=False, flip_v=False, max_center_dist_px=50.0):
    """
    Match DXF ARC entities to detected partial arcs.

    Returns list of dicts, one per DXF arc:
      {"handle", "matched": bool,
       "center_dev_mm": float, "radius_dev_mm": float,
       "pass_fail": "pass"|"warn"|"fail"|None}
    """
    angle_rad = math.radians(angle_deg)
    results = []

    for entity in dxf_arcs:
        if entity.get("type") != "arc":
            continue
        ecx_px, ecy_px = _dxf_to_canvas_px(entity["cx"], entity["cy"], ppm, tx, ty, angle_rad, flip_h, flip_v)
        er_px = entity["radius"] * ppm

        best = None
        best_dist = float("inf")
        for da in detected_arcs:
            dist = math.hypot(da["cx"] - ecx_px, da["cy"] - ecy_px)
            if dist > max_center_dist_px:
                continue
            if dist < best_dist:
                best_dist = dist
                best = da

        if best is None:
            results.append({"handle": entity.get("handle"), "matched": False,
                            "center_dev_mm": None, "radius_dev_mm": None, "pass_fail": None})
        else:
            results.append({
                "handle": entity.get("handle"),
                "matched": True,
                "center_dev_mm": round(best_dist / ppm, 4),
                "radius_dev_mm": round(abs(best["r"] - er_px) / ppm, 4),
                "pass_fail": None,
            })

    return results
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/pytest tests/test_line_arc_matching.py -v
```

Expected: all 4 pass.

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

- [ ] **Step 6: Commit**

```bash
git add backend/vision/line_arc_matching.py tests/test_line_arc_matching.py
git commit -m "feat: DXF line and arc matching logic in line_arc_matching.py"
```

---

## Task 6: New API endpoints

**Files:**
- Modify: `backend/api.py`
- Create: `tests/test_line_arc_api.py`

Four new endpoints inside `make_router`:
- `POST /detect-lines-merged` — runs `detect_lines_contour` (primary) on the stored frame
- `POST /detect-arcs-partial` — runs `detect_partial_arcs` on the stored frame
- `POST /match-dxf-lines` — takes detected lines + DXF entities + transform, returns per-line deviations with pass/fail
- `POST /match-dxf-arcs` — takes detected arcs + DXF entities + transform, returns per-arc deviations with pass/fail

- [ ] **Step 1: Write failing API tests**

Create `tests/test_line_arc_api.py`:

```python
from tests.conftest import *
import numpy as np
import cv2


def _frame_with_line(client):
    """Freeze a frame with a horizontal white line."""
    import io
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.line(frame, (50, 240), (590, 240), (255, 255, 255), 2)
    ok, buf = cv2.imencode(".jpg", frame)
    r = client.post("/load-image", files={"file": ("test.jpg", io.BytesIO(buf.tobytes()), "image/jpeg")})
    assert r.status_code == 200


def test_detect_lines_merged_returns_list(client):
    _frame_with_line(client)
    r = client.post("/detect-lines-merged", json={})
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)


def test_detect_arcs_partial_returns_list(client):
    _frame_with_line(client)
    r = client.post("/detect-arcs-partial", json={})
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_detect_lines_merged_404_without_freeze(client):
    r = client.post("/detect-lines-merged", json={})
    assert r.status_code == 400


def test_match_dxf_lines_returns_results(client):
    _frame_with_line(client)
    detected = [{"x1": 50, "y1": 240, "x2": 590, "y2": 240, "length": 540.0}]
    dxf_line = {"type": "line", "x1": 0.0, "y1": 0.0, "x2": 54.0, "y2": 0.0, "handle": "X1"}
    r = client.post("/match-dxf-lines", json={
        "entities": [dxf_line],
        "lines": detected,
        "pixels_per_mm": 10.0,
        "tx": 50.0, "ty": 240.0, "angle_deg": 0.0,
        "tolerance_warn": 0.10, "tolerance_fail": 0.25,
    })
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert "matched" in data[0]


def test_match_dxf_arcs_returns_results(client):
    _frame_with_line(client)
    detected = [{"cx": 320.0, "cy": 240.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}]
    dxf_arc = {"type": "arc", "cx": 27.0, "cy": 0.0, "radius": 10.0,
               "start_angle": 0.0, "end_angle": 90.0, "handle": "Y1"}
    r = client.post("/match-dxf-arcs", json={
        "entities": [dxf_arc],
        "arcs": detected,
        "pixels_per_mm": 10.0,
        "tx": 50.0, "ty": 240.0, "angle_deg": 0.0,
        "tolerance_warn": 0.10, "tolerance_fail": 0.25,
    })
    assert r.status_code == 200
    assert len(r.json()) == 1
```

- [ ] **Step 2: Run to confirm they fail**

```bash
.venv/bin/pytest tests/test_line_arc_api.py -v
```

Expected: `404` or `422` on all endpoints (not yet defined).

- [ ] **Step 3: Add Pydantic models and endpoints to `backend/api.py`**

Add models after `AlignDxfBody`:

```python
class DetectedLine(BaseModel):
    x1: float; y1: float; x2: float; y2: float; length: float


class DetectedArc(BaseModel):
    cx: float; cy: float; r: float; start_deg: float; end_deg: float


class DetectLinesParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 130


class DetectArcsParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 130
    min_span_deg: float = 45.0


class MatchDxfLinesBody(BaseModel):
    entities: list[dict]
    lines: list[DetectedLine]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)


class MatchDxfArcsBody(BaseModel):
    entities: list[dict]
    arcs: list[DetectedArc]
    pixels_per_mm: float = Field(gt=0)
    tx: float = 0.0
    ty: float = 0.0
    angle_deg: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    tolerance_warn: float = Field(default=0.10, gt=0)
    tolerance_fail: float = Field(default=0.25, gt=0)
```

Add inside `make_router` (after `/detect-lines`):

```python
    @router.post("/detect-lines-merged")
    async def detect_lines_merged_route(params: DetectLinesParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        return detection.detect_lines_contour(frame, params.threshold1, params.threshold2)

    @router.post("/detect-arcs-partial")
    async def detect_arcs_partial_route(params: DetectArcsParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        return detection.detect_partial_arcs(frame, params.threshold1, params.threshold2,
                                              min_span_deg=params.min_span_deg)

    @router.post("/match-dxf-lines")
    def match_dxf_lines_route(body: MatchDxfLinesBody):
        from .vision.line_arc_matching import match_lines
        results = match_lines(
            body.entities, [l.model_dump() for l in body.lines],
            body.pixels_per_mm, body.tx, body.ty, body.angle_deg,
            body.flip_h, body.flip_v,
        )
        for r in results:
            if r["matched"] and r["perp_dev_mm"] is not None:
                dev = r["perp_dev_mm"]
                r["pass_fail"] = "fail" if dev > body.tolerance_fail else (
                    "warn" if dev > body.tolerance_warn else "pass")
        return results

    @router.post("/match-dxf-arcs")
    def match_dxf_arcs_route(body: MatchDxfArcsBody):
        from .vision.line_arc_matching import match_arcs
        results = match_arcs(
            body.entities, [a.model_dump() for a in body.arcs],
            body.pixels_per_mm, body.tx, body.ty, body.angle_deg,
            body.flip_h, body.flip_v,
        )
        for r in results:
            if r["matched"]:
                dev = max(r["center_dev_mm"] or 0, r["radius_dev_mm"] or 0)
                r["pass_fail"] = "fail" if dev > body.tolerance_fail else (
                    "warn" if dev > body.tolerance_warn else "pass")
        return results
```

- [ ] **Step 4: Run API tests**

```bash
.venv/bin/pytest tests/test_line_arc_api.py -v
```

Expected: all pass.

- [ ] **Step 5: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

- [ ] **Step 6: Commit**

```bash
git add backend/api.py tests/test_line_arc_api.py
git commit -m "feat: add detect-lines-merged, detect-arcs-partial, match-dxf-lines, match-dxf-arcs API endpoints"
```

---

## Task 7: Frontend integration

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/index.html`

Add two new "Detect" buttons (alongside the existing line/circle detect buttons), fetch the new endpoints, and render detected lines and partial arcs as overlays on the canvas. Pass/fail coloring uses the same `deviationColor` function from M1.

- [ ] **Step 1: Add buttons in `frontend/index.html`**

Near the existing "Detect lines" and "Detect circles" buttons in the Detect panel, add:

```html
<button class="tool-btn" id="btn-detect-lines-merged">Detect lines (merged)</button>
<button class="tool-btn" id="btn-detect-arcs-partial">Detect partial arcs</button>
```

- [ ] **Step 2: Add fetch handlers and overlay rendering in `frontend/app.js`**

Add after the existing `detect_lines` handler:

```js
// ── Detect lines (merged/contour) ──────────────────────────────────────────
document.getElementById("btn-detect-lines-merged")?.addEventListener("click", async () => {
  const r = await fetch("/detect-lines-merged", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  if (!r.ok) { showStatus("Freeze a frame first"); return; }
  const lines = await r.json();
  state.annotations = state.annotations.filter(a => a.type !== "detected-line-merged");
  lines.forEach(l => addAnnotation({ type: "detected-line-merged",
    x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 }));
  redraw();
});

// ── Detect partial arcs ─────────────────────────────────────────────────────
document.getElementById("btn-detect-arcs-partial")?.addEventListener("click", async () => {
  const r = await fetch("/detect-arcs-partial", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  if (!r.ok) { showStatus("Freeze a frame first"); return; }
  const arcs = await r.json();
  state.annotations = state.annotations.filter(a => a.type !== "detected-arc-partial");
  arcs.forEach(a => addAnnotation({ type: "detected-arc-partial",
    cx: a.cx, cy: a.cy, r: a.r, start_deg: a.start_deg, end_deg: a.end_deg }));
  redraw();
});
```

Add rendering in the `redraw()` dispatch (follow the existing `detected-line` pattern):

```js
else if (ann.type === "detected-line-merged") {
  ctx.save();
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ann.x1, ann.y1);
  ctx.lineTo(ann.x2, ann.y2);
  ctx.stroke();
  ctx.restore();
}
else if (ann.type === "detected-arc-partial") {
  ctx.save();
  ctx.strokeStyle = "#ffd60a";
  ctx.lineWidth = 1.5;
  const a1 = ann.start_deg * Math.PI / 180;
  const a2 = ann.end_deg   * Math.PI / 180;
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, a1, a2);
  ctx.stroke();
  ctx.restore();
}
```

Add both new types to `TRANSIENT_TYPES` (the set of annotation types excluded from session save):

```js
"detected-line-merged", "detected-arc-partial",
```

- [ ] **Step 3: Manual smoke test**

```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

1. Load a snapshot with visible edges.
2. Click "Detect lines (merged)" — blue lines appear on edges.
3. Click "Detect partial arcs" — yellow arcs appear on arc features.

- [ ] **Step 4: Run full suite**

```bash
.venv/bin/pytest tests/ -v
```

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/index.html
git commit -m "feat: frontend detect-lines-merged and detect-arcs-partial buttons and overlay rendering"
```

---

## Final verification

```bash
.venv/bin/pytest tests/ -v
```

All tests must pass. Specifically verify:

- `tests/test_detection_fixtures.py` — all fixture-driven tests pass.
- `tests/test_detection.py` — all detection unit tests pass including new ones.
- `tests/test_line_arc_matching.py` — all matching unit tests pass.
- `tests/test_line_arc_api.py` — all API endpoint tests pass.
- `tests/test_alignment.py` — alignment tests unchanged.
- `tests/test_align_dxf_api.py` — alignment API unchanged.

## M2 success criteria checklist

- [ ] Reference snapshot set committed in `tests/fixtures/detection/` with JSON sidecars.
- [ ] On the reference set: no single clearly visible edge produces more than one output segment; ≥90% of annotated edges detected.
- [ ] Partial arcs with span ≥45° are detected with center within 5px, radius within 5%, span within 10°.
- [ ] `detect_circles` and `_ARC_MIN_COVERAGE=160` are completely untouched.
- [ ] DXF line features show perpendicular deviation in mm and angular error in degrees with pass/fail via `/match-dxf-lines`.
- [ ] DXF arc features show center and radius deviation in mm with pass/fail via `/match-dxf-arcs`.
- [ ] All existing tests pass.
