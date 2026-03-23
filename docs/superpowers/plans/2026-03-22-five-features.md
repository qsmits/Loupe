# Five Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add snapshot browser, CSV export, preprocessed view, best-fit arc tool, and DXF overlay to the microscope inspection app.

**Architecture:** Five independent features layered onto the existing FastAPI backend + vanilla-JS frontend. Backend changes follow the existing pattern in `backend/api.py` (Pydantic models + route functions inside `make_router()`). Frontend changes follow existing patterns in `frontend/app.js` (tool hooks in `handleToolClick`, draw hooks in `redraw`, annotation lifecycle via `addAnnotation`). Tests use the `client` fixture from `tests/conftest.py` (FastAPI TestClient with FakeCamera).

**Tech Stack:** FastAPI, OpenCV, NumPy, ezdxf (new dep), vanilla JS, pytest + httpx

**Important:** This project has no git repository. Omit all git commands. Run all commands from the project root `/Users/qsmits/Projects/MainDynamics/microscope` with `.venv/bin/python` / `.venv/bin/pytest` / `.venv/bin/pip`.

---

## File Map

| File | Change |
|------|--------|
| `requirements.txt` | Add `ezdxf` |
| `backend/api.py` | Add `LoadSnapshotBody`, `GET /snapshots`, `POST /load-snapshot`, `POST /preprocessed-view`, `POST /load-dxf` |
| `backend/vision/detection.py` | Add `preprocessed_view()` |
| `backend/vision/dxf_parser.py` | New — `parse_dxf()` |
| `frontend/index.html` | Add snapshot panel, CSV button, DXF button+input, Fit Arc toolbar button, preprocessed button, DXF sidebar panel |
| `frontend/app.js` | All frontend logic for the 5 features |
| `frontend/style.css` | Snapshot list item styles |
| `tests/test_api.py` | New tests for 4 new endpoints |
| `tests/test_dxf_parser.py` | New — unit tests for `parse_dxf()` |
| `tests/test_detection.py` | Add test for `preprocessed_view()` |

---

## Task 1: Snapshot Browser

Users can see all saved snapshots in the sidebar and click one to load it into the viewer (same as the existing "load image" flow but for server-side files).

**Files:**
- Modify: `backend/api.py` (add `LoadSnapshotBody`, `GET /snapshots`, `POST /load-snapshot`)
- Modify: `frontend/index.html` (add snapshot panel to sidebar)
- Modify: `frontend/app.js` (add `loadSnapshotList()`, click handler, refresh after snapshot)
- Modify: `frontend/style.css` (snapshot list item styles)
- Modify: `tests/test_api.py` (5 new tests)

---

- [ ] **Step 1: Write failing tests**

Add to `tests/test_api.py`:

```python
def test_list_snapshots_empty(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api.SNAPSHOTS_DIR", tmp_path)
    r = client.get("/snapshots")
    assert r.status_code == 200
    assert r.json() == []


def test_list_snapshots_returns_files(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api.SNAPSHOTS_DIR", tmp_path)
    import numpy as np, cv2
    for name in ["20260101_120000.jpg", "20260102_130000.jpg"]:
        cv2.imwrite(str(tmp_path / name), np.full((10, 10, 3), 128, dtype=np.uint8))
    r = client.get("/snapshots")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 2
    assert all({"filename", "size_kb", "timestamp"} <= set(s.keys()) for s in data)


def test_load_snapshot(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api.SNAPSHOTS_DIR", tmp_path)
    import numpy as np, cv2
    cv2.imwrite(str(tmp_path / "test.jpg"), np.full((100, 100, 3), 128, dtype=np.uint8))
    r = client.post("/load-snapshot", json={"filename": "test.jpg"})
    assert r.status_code == 200
    assert {"width", "height"} <= set(r.json().keys())


def test_load_snapshot_path_traversal(client):
    r = client.post("/load-snapshot", json={"filename": "../etc/passwd"})
    assert r.status_code == 400


def test_load_snapshot_not_found(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api.SNAPSHOTS_DIR", tmp_path)
    r = client.post("/load-snapshot", json={"filename": "nonexistent.jpg"})
    assert r.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

```
.venv/bin/pytest tests/test_api.py::test_list_snapshots_empty tests/test_api.py::test_list_snapshots_returns_files tests/test_api.py::test_load_snapshot tests/test_api.py::test_load_snapshot_path_traversal tests/test_api.py::test_load_snapshot_not_found -v
```

Expected: 5 FAILs (endpoints don't exist yet).

- [ ] **Step 3: Add backend — `LoadSnapshotBody`, `GET /snapshots`, `POST /load-snapshot`**

In `backend/api.py`, add `LoadSnapshotBody` next to the other body models (before `make_router`):

```python
class LoadSnapshotBody(BaseModel):
    filename: str
```

Inside `make_router()`, after the existing `POST /load-image` endpoint (around line 107), add:

```python
    @router.get("/snapshots")
    async def list_snapshots():
        if not SNAPSHOTS_DIR.exists():
            return []
        entries = []
        for p in sorted(SNAPSHOTS_DIR.glob("*.jpg"), key=lambda f: f.stat().st_mtime, reverse=True):
            entries.append({
                "filename": p.name,
                "size_kb": round(p.stat().st_size / 1024, 1),
                "timestamp": p.stem,
            })
        return entries

    @router.post("/load-snapshot")
    async def load_snapshot(body: LoadSnapshotBody):
        # Prevent path traversal: reject any filename containing a separator
        safe_name = pathlib.Path(body.filename).name
        if safe_name != body.filename:
            raise HTTPException(status_code=400, detail="Invalid filename")
        path = SNAPSHOTS_DIR / safe_name
        if not path.exists() or path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            raise HTTPException(status_code=404, detail="Snapshot not found")
        frame = cv2.imread(str(path))
        if frame is None:
            raise HTTPException(status_code=400, detail="Could not read image file")
        frame_store.store(frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}
```

- [ ] **Step 4: Run tests to verify they pass**

```
.venv/bin/pytest tests/test_api.py::test_list_snapshots_empty tests/test_api.py::test_list_snapshots_returns_files tests/test_api.py::test_load_snapshot tests/test_api.py::test_load_snapshot_path_traversal tests/test_api.py::test_load_snapshot_not_found -v
```

Expected: 5 PASSes.

- [ ] **Step 5: Add snapshot panel HTML**

In `frontend/index.html`, inside `<div id="sidebar">`, add a new section **before** `<div class="sidebar-section" id="detect-panel">`:

```html
    <div class="sidebar-section" id="snapshot-panel">
      <div class="sidebar-label">Snapshots <button id="btn-refresh-snapshots" class="tool-btn icon" style="font-size:10px;padding:1px 5px;margin-left:4px">↻</button></div>
      <div id="snapshot-list"></div>
    </div>
```

- [ ] **Step 6: Add snapshot list CSS**

In `frontend/style.css`, at the end of the file, add:

```css
.snapshot-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 4px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  gap: 6px;
}
.snapshot-item:hover { background: var(--border); }
.snapshot-name {
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.snapshot-size { color: var(--muted); flex-shrink: 0; }
```

- [ ] **Step 7: Add frontend JS**

In `frontend/app.js`, find the section near the bottom that contains `loadCameraInfo()` call (around line 502). Add the following **after** the `loadCameraInfo()` call:

```js
// ── Snapshot browser ────────────────────────────────────────────────────────
async function loadSnapshotList() {
  const listEl = document.getElementById("snapshot-list");
  try {
    const resp = await fetch("/snapshots");
    const snapshots = await resp.json();
    if (snapshots.length === 0) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:2px 0">No snapshots yet</div>';
      return;
    }
    listEl.innerHTML = snapshots.map(s =>
      `<div class="snapshot-item" data-filename="${s.filename}">
        <span class="snapshot-name">${s.timestamp}</span>
        <span class="snapshot-size">${s.size_kb}k</span>
      </div>`
    ).join("");
    listEl.querySelectorAll(".snapshot-item").forEach(el => {
      el.addEventListener("click", async () => {
        const filename = el.dataset.filename;
        const r = await fetch("/load-snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename }),
        });
        if (!r.ok) { alert(await r.text()); return; }
        const { width, height } = await r.json();
        state.frozenSize = { w: width, h: height };
        const frameBlob = await fetch("/frame").then(res => res.blob());
        const frameUrl = URL.createObjectURL(frameBlob);
        const loadedImg = new Image();
        loadedImg.onload = () => {
          URL.revokeObjectURL(frameUrl);
          state.frozenBackground = loadedImg;
          img.style.opacity = "0";
          state.frozen = true;
          document.getElementById("btn-freeze").classList.add("active");
          statusEl.textContent = `Snapshot: ${filename}`;
          statusEl.className = "status-line frozen";
          redraw();
        };
        loadedImg.src = frameUrl;
      });
    });
  } catch {
    listEl.innerHTML = '<div style="color:var(--muted);font-size:11px">Unavailable</div>';
  }
}

loadSnapshotList();
document.getElementById("btn-refresh-snapshots").addEventListener("click", loadSnapshotList);
```

Then find the existing `btn-snapshot` click handler (it ends with `setTimeout(() => { statusEl.textContent = prev; }, 2000);`) and add `loadSnapshotList();` on a new line **after** that closing `});`:

The handler currently ends like:
```js
  setTimeout(() => { statusEl.textContent = prev; }, 2000);
});
```

Change it to:
```js
  setTimeout(() => { statusEl.textContent = prev; }, 2000);
  loadSnapshotList();
});
```

- [ ] **Step 8: Verify full test suite still passes**

```
.venv/bin/pytest tests/ -q
```

Expected: all tests pass.

---

## Task 2: Measurement Export to CSV

A toolbar button downloads all measurements as a CSV file. No backend needed — all annotation data is client-side.

**Files:**
- Modify: `frontend/index.html` (add CSV button to toolbar)
- Modify: `frontend/app.js` (add CSV export handler)

No new tests — this is pure client-side UI with no backend surface.

---

- [ ] **Step 1: Add CSV button to toolbar HTML**

In `frontend/index.html`, find the toolbar export button:
```html
  <button class="tool-btn icon" id="btn-export" title="Export annotated image">🖼</button>
```

Add the CSV button **immediately after** it:
```html
  <button class="tool-btn icon" id="btn-export-csv" title="Export measurements as CSV">⬇CSV</button>
```

- [ ] **Step 2: Add CSV export JS**

In `frontend/app.js`, find the existing `btn-export` handler block. Add the following immediately after the closing `});` of that handler:

```js
// ── CSV export ──────────────────────────────────────────────────────────────
document.getElementById("btn-export-csv").addEventListener("click", () => {
  const cal = state.calibration;
  const unit = cal ? cal.displayUnit : "px";
  const rows = [["#", "name", "type", `value (${unit})`]];
  let i = 1;
  state.annotations.forEach(ann => {
    const val = measurementLabel(ann);
    if (!val) return;  // skip non-measurement overlays
    rows.push([i++, ann.name || "", ann.type, val]);
  });
  const csv = rows
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `measurements_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
```

- [ ] **Step 3: Verify full test suite still passes**

```
.venv/bin/pytest tests/ -q
```

Expected: all tests pass (no new backend surface).

---

## Task 3: Preprocessed View

Replace "edge detection as decorative overlay" with "show what the detector sees" — a button that returns the CLAHE+bilateral processed grayscale as a semi-transparent overlay. This is diagnostic: it shows why detection works or fails.

**Files:**
- Modify: `backend/vision/detection.py` (add `preprocessed_view()`)
- Modify: `backend/api.py` (add `POST /preprocessed-view`)
- Modify: `frontend/index.html` (add "Show preprocessed" button to detect panel)
- Modify: `frontend/app.js` (handler + draw function + redraw hook + sidebar filter)
- Modify: `tests/test_detection.py` (add 1 test)
- Modify: `tests/test_api.py` (add 2 tests)

---

- [ ] **Step 1: Write failing tests**

Add to `tests/test_detection.py`:

```python
def test_preprocessed_view_returns_jpeg_bytes():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    from backend.vision.detection import preprocessed_view
    result = preprocessed_view(frame)
    assert isinstance(result, bytes)
    assert result[:2] == b"\xff\xd8"  # JPEG magic bytes
```

Add to `tests/test_api.py`:

```python
def test_preprocessed_view_requires_freeze(client):
    r = client.post("/preprocessed-view")
    assert r.status_code == 400


def test_preprocessed_view_after_freeze(client):
    client.post("/freeze")
    r = client.post("/preprocessed-view")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/jpeg")
    assert len(r.content) > 0
```

- [ ] **Step 2: Run tests to verify they fail**

```
.venv/bin/pytest tests/test_detection.py::test_preprocessed_view_returns_jpeg_bytes tests/test_api.py::test_preprocessed_view_requires_freeze tests/test_api.py::test_preprocessed_view_after_freeze -v
```

Expected: 3 FAILs.

- [ ] **Step 3: Add `preprocessed_view()` to `backend/vision/detection.py`**

Add this function at the end of `backend/vision/detection.py`:

```python
def preprocessed_view(frame: np.ndarray) -> bytes:
    """
    Return the CLAHE+bilateral preprocessed grayscale image as JPEG bytes.
    Useful for diagnosing why detection succeeds or fails on a given frame.
    """
    gray = _preprocess(frame)
    ok, buf = cv2.imencode(".jpg", gray, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise RuntimeError("Failed to encode preprocessed image")
    return buf.tobytes()
```

- [ ] **Step 4: Add `POST /preprocessed-view` to `backend/api.py`**

Inside `make_router()`, after the `POST /detect-lines` endpoint, add:

```python
    @router.post("/preprocessed-view")
    async def preprocessed_view_route():
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        jpg_bytes = detection.preprocessed_view(frame)
        return Response(content=jpg_bytes, media_type="image/jpeg")
```

- [ ] **Step 5: Run tests to verify they pass**

```
.venv/bin/pytest tests/test_detection.py::test_preprocessed_view_returns_jpeg_bytes tests/test_api.py::test_preprocessed_view_requires_freeze tests/test_api.py::test_preprocessed_view_after_freeze -v
```

Expected: 3 PASSes.

- [ ] **Step 6: Add "Show preprocessed" button to HTML**

In `frontend/index.html`, in the detect panel, find:
```html
      <button class="tool-btn detect-action-btn" id="btn-run-edges">Run edge detect</button>
```

Add the preprocessed button **immediately after** it:
```html
      <button class="tool-btn detect-action-btn" id="btn-show-preprocessed">Show preprocessed</button>
```

- [ ] **Step 7: Add frontend JS**

In `frontend/app.js`, find the `btn-run-edges` handler. Add the following immediately **after** its closing `});`:

```js
document.getElementById("btn-show-preprocessed").addEventListener("click", async () => {
  await ensureFrozen();
  const r = await fetch("/preprocessed-view", { method: "POST" });
  if (!r.ok) { alert(await r.text()); return; }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const ppImg = new Image();
  ppImg.onload = () => {
    URL.revokeObjectURL(url);
    state.annotations = state.annotations.filter(a => a.type !== "preprocessed-overlay");
    addAnnotation({ type: "preprocessed-overlay", image: ppImg });
    redraw();
  };
  ppImg.src = url;
});
```

In `frontend/app.js`, find the `redraw()` function's annotation dispatch. It currently has:
```js
    else if (ann.type === "edges-overlay")    drawEdgesOverlay(ann);
```

Add the preprocessed case immediately after it:
```js
    else if (ann.type === "preprocessed-overlay") drawPreprocessedOverlay(ann);
```

Add the draw function near `drawEdgesOverlay`:
```js
function drawPreprocessedOverlay(ann) {
  ctx.globalAlpha = 0.75;
  ctx.drawImage(ann.image, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1.0;
}
```

In the sidebar filter line (currently):
```js
    if (ann.type === "edges-overlay") return;
```

Change to:
```js
    if (ann.type === "edges-overlay" || ann.type === "preprocessed-overlay") return;
```

- [ ] **Step 8: Verify full test suite still passes**

```
.venv/bin/pytest tests/ -q
```

Expected: all tests pass.

---

## Task 4: Best-fit Arc Tool (N-point least-squares)

A new toolbar tool "Fit Arc": user clicks ≥3 points on any arc or circle edge, then double-clicks to confirm. A least-squares algebraic circle fit produces the best-fit circle, added as a standard `"circle"` annotation with full calibration support. Works for partial arcs where the 3-point circumscribed-circle tool is too noise-sensitive.

**Files:**
- Modify: `frontend/index.html` (add "Fit Arc" toolbar button)
- Modify: `frontend/app.js` (algebraic fit function, tool click handler, dblclick handler, preview in redraw)

No backend changes. No backend tests. Pure client-side geometry.

---

- [ ] **Step 1: Add "Fit Arc" button to HTML toolbar**

In `frontend/index.html`, find the toolbar buttons. The circle tool button is:
```html
  <button class="tool-btn" data-tool="circle">Circle</button>
```

Add the Fit Arc button **immediately after** it:
```html
  <button class="tool-btn" data-tool="arc-fit">Fit Arc</button>
```

- [ ] **Step 2: Add `fitCircleAlgebraic()` to `frontend/app.js`**

In `frontend/app.js`, find the existing `fitCircle` function (the 3-point circumscribed circle). Add the following **immediately after** it:

```js
// ── Algebraic least-squares circle fit (N ≥ 3 points) ─────────────────────
// Minimises Σ(x²+y²+Dx+Ey+F)² — linear system solved by Cramer's rule.
// Returns {cx, cy, r} or null if the fit is degenerate.
function fitCircleAlgebraic(points) {
  if (points.length < 3) return null;
  let sx=0, sy=0, sx2=0, sy2=0, sxy=0, sx3=0, sy3=0, sx2y=0, sxy2=0;
  const n = points.length;
  for (const {x, y} of points) {
    sx+=x; sy+=y; sx2+=x*x; sy2+=y*y; sxy+=x*y;
    sx3+=x*x*x; sy3+=y*y*y; sx2y+=x*x*y; sxy2+=x*y*y;
  }
  const M = [[sx2,sxy,sx],[sxy,sy2,sy],[sx,sy,n]];
  const b = [-(sx3+sxy2), -(sx2y+sy3), -(sx2+sy2)];
  function det3(m) {
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
          -m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
          +m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  }
  const d = det3(M);
  if (Math.abs(d) < 1e-6) return null;
  const sub = (col, bv) => M.map((row, i) => row.map((v, j) => j === col ? bv[i] : v));
  const D = det3(sub(0, b)) / d;
  const E = det3(sub(1, b)) / d;
  const F = det3(sub(2, b)) / d;
  const cx = -D / 2, cy = -E / 2;
  const r = Math.sqrt(Math.max(0, cx*cx + cy*cy - F));
  if (!isFinite(r) || r <= 0) return null;
  return { cx, cy, r };
}
```

- [ ] **Step 3: Add arc-fit click handling in `handleToolClick`**

In `frontend/app.js`, find `handleToolClick`. The current last tool handler is the `circle` block ending with `return;`. Add the following **after** it (before the closing `}` of `handleToolClick`):

```js
  if (tool === "arc-fit") {
    state.pendingPoints.push(pt);
    redraw();
    return;
  }
```

- [ ] **Step 4: Add dblclick confirmation handler**

In `frontend/app.js`, find the keyboard handler (`document.addEventListener("keydown", ...)`). Add the following **immediately after** it:

```js
canvas.addEventListener("dblclick", () => {
  if (state.tool !== "arc-fit") return;
  if (state.pendingPoints.length < 3) {
    alert("Need at least 3 points. Keep clicking to add more, then double-click to confirm.");
    return;
  }
  const result = fitCircleAlgebraic(state.pendingPoints);
  if (!result) {
    alert("Could not fit a circle — points may be collinear or too close together.");
  } else {
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
  }
  state.pendingPoints = [];
  redraw();
});
```

- [ ] **Step 5: Add live preview in `redraw()`**

In `frontend/app.js`, find the `redraw()` function. Near the end of it, after the `drawPendingPoints()` call, add:

```js
  // Arc-fit preview: show current best-fit circle while collecting points
  if (state.tool === "arc-fit" && state.pendingPoints.length >= 3) {
    const fit = fitCircleAlgebraic(state.pendingPoints);
    if (fit) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(fit.cx, fit.cy, fit.r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(251,146,60,0.6)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
```

- [ ] **Step 6: Verify full test suite still passes**

```
.venv/bin/pytest tests/ -q
```

Expected: all tests pass.

---

## Task 5: DXF Overlay

Load a DXF file, render its geometry (lines, circles, arcs, polylines) as a dashed cyan overlay on the frozen frame. User sets scale (px per DXF unit) and clicks to place the DXF origin. Useful for comparing machined parts against CAD drawings.

**Files:**
- Modify: `requirements.txt` (add `ezdxf`)
- Create: `backend/vision/dxf_parser.py`
- Create: `tests/test_dxf_parser.py`
- Modify: `backend/api.py` (add `POST /load-dxf`)
- Modify: `tests/test_api.py` (2 new tests)
- Modify: `frontend/index.html` (DXF toolbar button+input, sidebar DXF panel)
- Modify: `frontend/app.js` (load handler, draw function, origin-set mode, redraw hook, sidebar filter)

---

- [ ] **Step 1: Install ezdxf and add to requirements**

```
.venv/bin/pip install ezdxf
```

Add `ezdxf` to `requirements.txt` (add on a new line at the end).

- [ ] **Step 2: Write failing tests for `parse_dxf()`**

Create `tests/test_dxf_parser.py`:

```python
import io
import pytest
import ezdxf
from backend.vision.dxf_parser import parse_dxf


def _make_dxf(**entities) -> bytes:
    """Helper: create valid DXF bytes with requested entities."""
    doc = ezdxf.new()
    msp = doc.modelspace()
    if entities.get("line"):
        msp.add_line((0, 0, 0), (100, 0, 0))
    if entities.get("circle"):
        msp.add_circle((50, 50, 0), radius=25)
    if entities.get("arc"):
        msp.add_arc((0, 0, 0), radius=30, start_angle=0, end_angle=90)
    if entities.get("lwpolyline"):
        msp.add_lwpolyline([(0, 0), (10, 0), (10, 10)], close=True)
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode()


def test_parse_dxf_line():
    entities = parse_dxf(_make_dxf(line=True))
    lines = [e for e in entities if e["type"] == "line"]
    assert len(lines) == 1
    assert lines[0]["x1"] == pytest.approx(0.0)
    assert lines[0]["x2"] == pytest.approx(100.0)
    assert lines[0]["y1"] == pytest.approx(0.0)
    assert lines[0]["y2"] == pytest.approx(0.0)


def test_parse_dxf_circle():
    entities = parse_dxf(_make_dxf(circle=True))
    circles = [e for e in entities if e["type"] == "circle"]
    assert len(circles) == 1
    assert circles[0]["cx"] == pytest.approx(50.0)
    assert circles[0]["cy"] == pytest.approx(50.0)
    assert circles[0]["radius"] == pytest.approx(25.0)


def test_parse_dxf_arc():
    entities = parse_dxf(_make_dxf(arc=True))
    arcs = [e for e in entities if e["type"] == "arc"]
    assert len(arcs) == 1
    assert arcs[0]["radius"] == pytest.approx(30.0)
    assert arcs[0]["start_angle"] == pytest.approx(0.0)
    assert arcs[0]["end_angle"] == pytest.approx(90.0)


def test_parse_dxf_lwpolyline():
    entities = parse_dxf(_make_dxf(lwpolyline=True))
    polys = [e for e in entities if e["type"] == "polyline"]
    assert len(polys) == 1
    assert polys[0]["closed"] is True
    assert len(polys[0]["points"]) == 3


def test_parse_dxf_empty_drawing():
    entities = parse_dxf(_make_dxf())
    assert entities == []


def test_parse_dxf_invalid_raises():
    with pytest.raises(ValueError):
        parse_dxf(b"this is not a dxf file")
```

- [ ] **Step 3: Run tests to verify they fail**

```
.venv/bin/pytest tests/test_dxf_parser.py -v
```

Expected: 6 FAILs (module doesn't exist yet).

- [ ] **Step 4: Create `backend/vision/dxf_parser.py`**

```python
import io

import ezdxf


def parse_dxf(content: bytes) -> list[dict]:
    """
    Parse DXF file bytes and return geometry entities as JSON-serialisable dicts.
    Supports: LINE, CIRCLE, ARC, LWPOLYLINE.
    Coordinates are in DXF units (typically mm).
    Raises ValueError if the file cannot be parsed.
    """
    try:
        text = content.decode("utf-8", errors="replace")
        doc = ezdxf.read(io.StringIO(text))
    except Exception as exc:
        raise ValueError(f"Could not parse DXF: {exc}") from exc

    msp = doc.modelspace()
    entities = []

    for entity in msp:
        t = entity.dxftype()
        try:
            if t == "LINE":
                s, e = entity.dxf.start, entity.dxf.end
                entities.append({
                    "type": "line",
                    "x1": float(s.x), "y1": float(s.y),
                    "x2": float(e.x), "y2": float(e.y),
                })
            elif t == "CIRCLE":
                c = entity.dxf.center
                entities.append({
                    "type": "circle",
                    "cx": float(c.x), "cy": float(c.y),
                    "radius": float(entity.dxf.radius),
                })
            elif t == "ARC":
                c = entity.dxf.center
                entities.append({
                    "type": "arc",
                    "cx": float(c.x), "cy": float(c.y),
                    "radius": float(entity.dxf.radius),
                    "start_angle": float(entity.dxf.start_angle),
                    "end_angle": float(entity.dxf.end_angle),
                })
            elif t == "LWPOLYLINE":
                points = [{"x": float(p[0]), "y": float(p[1])}
                          for p in entity.get_points("xy")]
                entities.append({
                    "type": "polyline",
                    "points": points,
                    "closed": bool(entity.closed),
                })
        except Exception:
            continue  # skip malformed entities silently

    return entities
```

- [ ] **Step 5: Run dxf_parser tests to verify they pass**

```
.venv/bin/pytest tests/test_dxf_parser.py -v
```

Expected: 6 PASSes.

- [ ] **Step 6: Write failing API tests for `/load-dxf`**

Add to `tests/test_api.py`:

```python
def test_load_dxf_returns_entities(client):
    import ezdxf, io
    doc = ezdxf.new()
    doc.modelspace().add_line((0, 0, 0), (100, 0, 0))
    buf = io.StringIO()
    doc.write(buf)
    dxf_bytes = buf.getvalue().encode()
    r = client.post(
        "/load-dxf",
        files={"file": ("test.dxf", dxf_bytes, "application/octet-stream")},
    )
    assert r.status_code == 200
    entities = r.json()
    assert isinstance(entities, list)
    lines = [e for e in entities if e["type"] == "line"]
    assert len(lines) == 1


def test_load_dxf_invalid_file(client):
    r = client.post(
        "/load-dxf",
        files={"file": ("bad.dxf", b"not a dxf file", "application/octet-stream")},
    )
    assert r.status_code == 400
```

- [ ] **Step 7: Run API DXF tests to verify they fail**

```
.venv/bin/pytest tests/test_api.py::test_load_dxf_returns_entities tests/test_api.py::test_load_dxf_invalid_file -v
```

Expected: 2 FAILs.

- [ ] **Step 8: Add `POST /load-dxf` to `backend/api.py`**

Inside `make_router()`, after the `POST /preprocessed-view` endpoint, add:

```python
    @router.post("/load-dxf")
    async def load_dxf_route(file: UploadFile = File(...)):
        content = await file.read()
        try:
            from .vision.dxf_parser import parse_dxf
            entities = parse_dxf(content)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return entities
```

- [ ] **Step 9: Run API DXF tests to verify they pass**

```
.venv/bin/pytest tests/test_api.py::test_load_dxf_returns_entities tests/test_api.py::test_load_dxf_invalid_file -v
```

Expected: 2 PASSes.

- [ ] **Step 10: Add DXF toolbar button + file input + DXF sidebar panel to HTML**

In `frontend/index.html`, find the toolbar. After the `btn-snapshot` button add:

```html
  <input type="file" id="dxf-input" accept=".dxf" style="display:none">
  <button class="tool-btn icon" id="btn-load-dxf" title="Load DXF overlay">DXF</button>
```

In the sidebar, add a new section **after** `<div class="sidebar-section" id="detect-panel">` and before `<div class="status-line"`:

```html
    <div class="sidebar-section" id="dxf-panel" style="display:none">
      <div class="sidebar-label">DXF Overlay</div>
      <div class="camera-row">
        <label for="dxf-scale">Scale</label>
        <input type="number" id="dxf-scale" value="1" step="0.1" min="0.01"
               style="width:70px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:11px">
        <span style="font-size:10px;color:var(--muted)">px/unit</span>
      </div>
      <button class="tool-btn detect-action-btn" id="btn-dxf-set-origin">Set origin (click canvas)</button>
      <button class="tool-btn detect-action-btn" id="btn-dxf-clear">Clear DXF</button>
    </div>
```

- [ ] **Step 11: Add DXF frontend JS**

In `frontend/app.js`, find the section with the snapshot browser code added in Task 1. Add the following DXF block **after** the snapshot browser section:

```js
// ── DXF Overlay ─────────────────────────────────────────────────────────────
let _dxfOriginMode = false;

document.getElementById("btn-load-dxf").addEventListener("click", () => {
  document.getElementById("dxf-input").click();
});

document.getElementById("dxf-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);
  const r = await fetch("/load-dxf", { method: "POST", body: formData });
  if (!r.ok) { alert("Could not load DXF: " + await r.text()); e.target.value = ""; return; }
  const entities = await r.json();
  // Default scale: use calibration (px/mm) if available, otherwise 1 px/unit
  const cal = state.calibration;
  const scale = cal ? cal.pixelsPerMm : 1;
  document.getElementById("dxf-scale").value = scale.toFixed(3);
  state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
  addAnnotation({
    type: "dxf-overlay",
    entities,
    offsetX: canvas.width / 2,
    offsetY: canvas.height / 2,
    scale,
  });
  document.getElementById("dxf-panel").style.display = "";
  redraw();
  e.target.value = "";
});

document.getElementById("dxf-scale").addEventListener("input", e => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (ann) { ann.scale = parseFloat(e.target.value) || 1; redraw(); }
});

document.getElementById("btn-dxf-set-origin").addEventListener("click", () => {
  _dxfOriginMode = true;
  document.getElementById("btn-dxf-set-origin").classList.add("active");
  statusEl.textContent = "Click canvas to place DXF origin";
});

document.getElementById("btn-dxf-clear").addEventListener("click", () => {
  state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
  document.getElementById("dxf-panel").style.display = "none";
  redraw();
});
```

- [ ] **Step 12: Hook DXF origin click into `onMouseDown`**

In `frontend/app.js`, find `onMouseDown`:

```js
function onMouseDown(e) {
  const pt = canvasPoint(e);
  if (state.tool === "select") { handleSelectDown(pt, e); return; }
  handleToolClick(pt);
}
```

Change it to:

```js
function onMouseDown(e) {
  const pt = canvasPoint(e);
  if (_dxfOriginMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) { ann.offsetX = pt.x; ann.offsetY = pt.y; redraw(); }
    _dxfOriginMode = false;
    document.getElementById("btn-dxf-set-origin").classList.remove("active");
    statusEl.textContent = state.frozen ? "Frozen" : "Live";
    return;
  }
  if (state.tool === "select") { handleSelectDown(pt, e); return; }
  handleToolClick(pt);
}
```

- [ ] **Step 13: Add `drawDxfOverlay()` and hook into `redraw()`**

In `frontend/app.js`, add the following draw function near `drawEdgesOverlay`:

```js
function drawDxfOverlay(ann) {
  const { entities, offsetX, offsetY, scale } = ann;
  // tx/ty: DXF coords → canvas coords. Y is flipped (DXF Y-up, canvas Y-down).
  const tx = x => offsetX + x * scale;
  const ty = y => offsetY - y * scale;
  ctx.save();
  ctx.strokeStyle = "#00d4ff";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 3]);
  for (const en of entities) {
    ctx.beginPath();
    if (en.type === "line") {
      ctx.moveTo(tx(en.x1), ty(en.y1));
      ctx.lineTo(tx(en.x2), ty(en.y2));
    } else if (en.type === "circle") {
      ctx.arc(tx(en.cx), ty(en.cy), en.radius * scale, 0, Math.PI * 2);
    } else if (en.type === "arc") {
      // DXF arcs are CCW, angles in degrees from +X axis (Y-up).
      // After Y-flip: swap start/end and negate to get CW canvas arc.
      const sr = en.start_angle * Math.PI / 180;
      const er = en.end_angle * Math.PI / 180;
      ctx.arc(tx(en.cx), ty(en.cy), en.radius * scale, -er, -sr, false);
    } else if (en.type === "polyline") {
      if (en.points.length < 2) continue;
      ctx.moveTo(tx(en.points[0].x), ty(en.points[0].y));
      for (let i = 1; i < en.points.length; i++) {
        ctx.lineTo(tx(en.points[i].x), ty(en.points[i].y));
      }
      if (en.closed) ctx.closePath();
    }
    ctx.stroke();
  }
  ctx.restore();
}
```

In the `redraw()` annotation dispatch, add after the `preprocessed-overlay` line:

```js
    else if (ann.type === "dxf-overlay")      drawDxfOverlay(ann);
```

In the sidebar filter, extend the exclusion:

```js
    if (ann.type === "edges-overlay" || ann.type === "preprocessed-overlay" || ann.type === "dxf-overlay") return;
```

- [ ] **Step 14: Run full test suite**

```
.venv/bin/pytest tests/ -q
```

Expected: all tests pass.

- [ ] **Step 15: Run visual sanity check with snapshots**

```
.venv/bin/python tests/run_visual.py
```

Expected: processes all snapshots, outputs files to `tests/output/` without errors.

---

## Final Verification

- [ ] **Run entire test suite one last time**

```
.venv/bin/pytest tests/ -v
```

Expected: all tests pass, no warnings about unimplemented features.

- [ ] **Confirm new endpoint list**

```
.venv/bin/python -c "
from backend.main import create_app
from tests.conftest import FakeCamera
app = create_app(FakeCamera())
routes = sorted(r.path for r in app.routes)
for r in routes: print(r)
"
```

Expected output includes: `/snapshots`, `/load-snapshot`, `/preprocessed-view`, `/load-dxf`.
