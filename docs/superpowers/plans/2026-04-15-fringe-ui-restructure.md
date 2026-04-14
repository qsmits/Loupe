# Fringe UI Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize fringe mode: top bar for settings/export, left panel for capture workflow only, subtraction pills in results area, SSE progress reporting, and split fringe.js (~2500 lines) into 5 focused modules.

**Architecture:** Backend gains an `on_progress` callback in `analyze_interferogram` and a new SSE streaming endpoint. Frontend splits `fringe.js` into coordinator + 4 sub-modules, moves settings/export to top bar dropdowns, replaces Zernike checkboxes with toggle pills in the results area.

**Tech Stack:** FastAPI `StreamingResponse` (SSE), vanilla JS ES modules, existing CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-04-15-fringe-ui-restructure-design.md`

**Important codebase context:**
- `fringe.js` uses a module-level state object `fr` and a `$()` DOM helper. All extracted modules must import `fr` from `fringe.js`.
- The app runs on master — each task must leave the app functional. Run `./server.sh restart` after frontend changes to verify.
- Tests: `.venv/bin/pytest tests/ -v` — backend only, no frontend test framework.
- `CLAUDE.md` has full architecture docs. Read it before starting.

---

## File Structure

| File | Role | Status |
|------|------|--------|
| `backend/vision/fringe.py` | Add `on_progress` callback to `analyze_interferogram` | Modify |
| `backend/api_fringe.py` | Add `POST /fringe/analyze-stream` SSE endpoint | Modify |
| `tests/test_fringe.py` | Tests for progress callback + SSE endpoint | Modify |
| `frontend/modes.js` | Add `fringe-only` class toggling | Modify |
| `frontend/index.html` | Add fringe-only Settings + Export dropdowns in top bar | Modify |
| `frontend/style.css` | Subtraction pills, progress bar, fringe-only visibility | Modify |
| `frontend/fringe.js` | Slim to coordinator: state, init, imports | Modify (major) |
| `frontend/fringe-measure.js` | Surface map measurement tools (extracted) | Create |
| `frontend/fringe-progress.js` | SSE streaming client + progress bar UI | Create |
| `frontend/fringe-panel.js` | Left panel template + capture workflow | Create |
| `frontend/fringe-results.js` | Results rendering + subtraction pills | Create |

---

### Task 1: Backend — progress callback + SSE endpoint

**Files:**
- Modify: `backend/vision/fringe.py` (lines 1241-1420, `analyze_interferogram`)
- Modify: `backend/api_fringe.py` (add streaming endpoint)
- Modify: `tests/test_fringe.py` (add tests)

**Context:** `analyze_interferogram()` in `backend/vision/fringe.py:1241` runs 11 sequential steps (modulation, DFT phase, unwrap, Zernike fit, subtract, height conversion, stats, focus, renderings, PSF/MTF, Zernike chart). Each step is a natural progress boundary. The SSE endpoint will wrap this with a `StreamingResponse`.

- [ ] **Step 1: Write test for progress callback**

Add to `tests/test_fringe.py`:

```python
class TestProgressCallback:
    def test_progress_callback_receives_all_stages(self):
        """on_progress callback receives carrier, phase, unwrap, zernike, render stages."""
        import numpy as np
        from backend.vision.fringe import analyze_interferogram

        # Create a simple fringe pattern
        y, x = np.mgrid[0:128, 0:128]
        image = (128 + 127 * np.sin(2 * np.pi * x / 20)).astype(np.uint8)

        stages_received = []

        def on_progress(stage, progress, message):
            stages_received.append((stage, progress, message))

        result = analyze_interferogram(image, on_progress=on_progress)

        # Should receive all 5 stages
        stage_names = [s[0] for s in stages_received]
        assert "carrier" in stage_names
        assert "phase" in stage_names
        assert "unwrap" in stage_names
        assert "zernike" in stage_names
        assert "render" in stage_names

        # Progress values should be monotonically increasing
        progress_values = [s[1] for s in stages_received]
        for i in range(1, len(progress_values)):
            assert progress_values[i] >= progress_values[i - 1]

        # Last progress should be 1.0
        assert progress_values[-1] == 1.0

        # Result should still be valid
        assert "surface_map" in result
        assert "coefficients" in result

    def test_no_callback_still_works(self):
        """analyze_interferogram works without on_progress (backwards compat)."""
        import numpy as np
        from backend.vision.fringe import analyze_interferogram

        y, x = np.mgrid[0:128, 0:128]
        image = (128 + 127 * np.sin(2 * np.pi * x / 20)).astype(np.uint8)

        result = analyze_interferogram(image)
        assert "surface_map" in result
        assert "coefficients" in result
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestProgressCallback -v`
Expected: FAIL — `on_progress` is not a parameter of `analyze_interferogram`

- [ ] **Step 3: Add `on_progress` callback to `analyze_interferogram`**

In `backend/vision/fringe.py`, modify the function signature at line 1241:

```python
def analyze_interferogram(image: np.ndarray, wavelength_nm: float = 632.8,
                          mask_threshold: float = 0.15,
                          subtract_terms: list[int] | None = None,
                          n_zernike: int = 36,
                          use_full_mask: bool = False,
                          custom_mask: np.ndarray | None = None,
                          carrier_override: tuple[int, int] | None = None,
                          on_progress: callable | None = None) -> dict:
```

Add a helper inside the function body, right after the docstring:

```python
    def _progress(stage: str, progress: float, message: str):
        if on_progress is not None:
            on_progress(stage, progress, message)
```

Insert progress calls at the natural boundaries in the existing pipeline:

```python
    # Before Step 1 (modulation & mask):
    _progress("carrier", 0.0, "Detecting carrier...")

    # After Step 2 (DFT phase extraction), before Step 3:
    _progress("phase", 0.25, "Extracting phase...")

    # After Step 3 (unwrapping), before Step 4:
    _progress("unwrap", 0.50, "Unwrapping phase...")

    # After Step 4 (Zernike fitting), before Step 5:
    _progress("zernike", 0.70, "Fitting Zernike polynomials...")

    # After Step 7 (statistics), before Step 9 (renderings):
    _progress("render", 0.85, "Rendering results...")

    # At the very end, just before the return statement:
    _progress("render", 1.0, "Complete")
```

The exact insertion points relative to existing comments in `analyze_interferogram`:
- `_progress("carrier", 0.0, ...)` → before `# Step 1: Modulation & mask`
- `_progress("phase", 0.25, ...)` → after `wrapped = extract_phase_dft(...)` (line ~1293)
- `_progress("unwrap", 0.50, ...)` → after `unwrapped = unwrap_phase_2d(...)` (line ~1296)
- `_progress("zernike", 0.70, ...)` → after `coeffs, rho, theta = fit_zernike(...)` (line ~1299)
- `_progress("render", 0.85, ...)` → before `# Step 9: Renderings` (line ~1324)
- `_progress("render", 1.0, ...)` → just before the `return {` statement

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_fringe.py::TestProgressCallback -v`
Expected: PASS (both tests)

- [ ] **Step 5: Write test for SSE streaming endpoint**

Add to `tests/test_fringe.py`:

```python
import json

class TestAnalyzeStream:
    @pytest.mark.anyio
    async def test_stream_returns_progress_events(self, client):
        """POST /fringe/analyze-stream returns SSE events with progress."""
        import numpy as np
        import cv2
        import base64

        # Create test fringe image
        y, x = np.mgrid[0:128, 0:128]
        image = (128 + 127 * np.sin(2 * np.pi * x / 20)).astype(np.uint8)
        _, buf = cv2.imencode(".png", image)
        b64 = base64.b64encode(buf).decode()

        response = await client.post(
            "/fringe/analyze-stream",
            json={"image_b64": b64, "wavelength_nm": 632.8},
        )
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        # Parse SSE events
        events = []
        for line in response.text.split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))

        # Should have progress events + done event
        assert len(events) >= 2
        stage_names = [e["stage"] for e in events]
        assert "done" in stage_names

        # The done event should contain the full result
        done_event = [e for e in events if e["stage"] == "done"][0]
        assert "result" in done_event
        assert "surface_map" in done_event["result"]
        assert "coefficients" in done_event["result"]

    @pytest.mark.anyio
    async def test_stream_error_returns_error_event(self, client):
        """POST /fringe/analyze-stream with bad image returns error event."""
        response = await client.post(
            "/fringe/analyze-stream",
            json={"image_b64": "not-valid-base64!!!"},
        )
        assert response.status_code == 200

        events = []
        for line in response.text.split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))

        assert any(e["stage"] == "error" for e in events)
```

- [ ] **Step 6: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestAnalyzeStream -v`
Expected: FAIL — 404, endpoint doesn't exist

- [ ] **Step 7: Implement SSE streaming endpoint**

In `backend/api_fringe.py`, add imports at the top:

```python
import asyncio
import json
from starlette.responses import StreamingResponse
```

Inside `make_fringe_router()`, add the new endpoint after the existing `/fringe/analyze`:

```python
    @router.post("/fringe/analyze-stream", dependencies=[Depends(_reject_hosted)])
    async def fringe_analyze_stream(body: AnalyzeBody):
        """Run fringe analysis with SSE progress streaming.

        Returns text/event-stream with JSON events:
          {"stage": "carrier", "progress": 0.0, "message": "Detecting carrier..."}
          ...
          {"stage": "done", "progress": 1.0, "result": {...}}
        or on error:
          {"stage": "error", "message": "..."}
        """
        # Decode image (same logic as /fringe/analyze)
        if body.image_b64:
            try:
                img_bytes = base64.b64decode(body.image_b64)
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_GRAYSCALE)
                if image is None:
                    raise ValueError("Could not decode image")
            except Exception as e:
                async def error_stream():
                    yield f"data: {json.dumps({'stage': 'error', 'message': str(e)})}\n\n"
                return StreamingResponse(error_stream(), media_type="text/event-stream")
        else:
            frame = camera.get_frame()
            if frame is None:
                async def error_stream():
                    yield f"data: {json.dumps({'stage': 'error', 'message': 'Camera returned no frame'})}\n\n"
                return StreamingResponse(error_stream(), media_type="text/event-stream")
            image = frame
            if image.ndim == 3:
                image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # Crop to ROI if specified
        if body.roi and not body.mask_polygons:
            ih, iw = image.shape[:2]
            x0 = int(body.roi.x * iw)
            y0 = int(body.roi.y * ih)
            x1 = min(int((body.roi.x + body.roi.w) * iw), iw)
            y1 = min(int((body.roi.y + body.roi.h) * ih), ih)
            if x1 - x0 > 10 and y1 - y0 > 10:
                image = image[y0:y1, x0:x1]

        # Build polygon mask
        custom_mask = None
        if body.mask_polygons:
            ih, iw = image.shape[:2]
            custom_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )

        _fringe_cache["last_image"] = image.copy()

        # Run analysis in a thread with progress callback
        progress_queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_event_loop()

        def on_progress(stage, progress, message):
            loop.call_soon_threadsafe(progress_queue.put_nowait,
                                      {"stage": stage, "progress": progress, "message": message})

        async def run_analysis():
            return await loop.run_in_executor(
                None,
                lambda: analyze_interferogram(
                    image,
                    wavelength_nm=body.wavelength_nm,
                    mask_threshold=body.mask_threshold,
                    subtract_terms=body.subtract_terms,
                    n_zernike=body.n_zernike,
                    use_full_mask=body.roi is not None and not body.mask_polygons,
                    custom_mask=custom_mask,
                    on_progress=on_progress,
                ),
            )

        async def event_stream():
            task = asyncio.create_task(run_analysis())
            try:
                while not task.done():
                    try:
                        event = await asyncio.wait_for(progress_queue.get(), timeout=1.0)
                        yield f"data: {json.dumps(event)}\n\n"
                    except asyncio.TimeoutError:
                        continue

                # Drain remaining progress events
                while not progress_queue.empty():
                    event = await progress_queue.get()
                    yield f"data: {json.dumps(event)}\n\n"

                result = task.result()
                yield f"data: {json.dumps({'stage': 'done', 'progress': 1.0, 'result': result})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'stage': 'error', 'message': str(e)})}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")
```

- [ ] **Step 8: Run all tests**

Run: `.venv/bin/pytest tests/test_fringe.py -v`
Expected: ALL PASS (existing + 4 new)

- [ ] **Step 9: Commit**

```bash
git add backend/vision/fringe.py backend/api_fringe.py tests/test_fringe.py
git commit -m "feat: SSE progress streaming for fringe analysis

Add on_progress callback to analyze_interferogram() and new
POST /fringe/analyze-stream endpoint that returns text/event-stream
with progress events (carrier, phase, unwrap, zernike, render, done)."
```

---

### Task 2: modes.js fringe-only toggle + top bar dropdowns

**Files:**
- Modify: `frontend/modes.js` (line 24, add fringe-only toggling)
- Modify: `frontend/index.html` (top bar, add Settings + Export dropdowns)
- Modify: `frontend/style.css` (fringe-only visibility)

**Context:** `modes.js:switchMode()` currently only toggles `.microscope-only` elements. We need the same for `.fringe-only`. The top bar in `index.html` has microscope-only menu buttons (Detect, Measure, Setup, DXF) on the left and utility buttons on the right. We add two fringe-only dropdowns between the mode switcher and the microscope-only items.

- [ ] **Step 1: Add `fringe-only` toggling to `modes.js`**

In `frontend/modes.js`, after line 26 (`});`), add:

```javascript
  // Toggle fringe-only top-bar items
  document.querySelectorAll(".fringe-only").forEach(el => {
    el.hidden = modeId !== "fringe";
  });
```

- [ ] **Step 2: Add fringe-only dropdowns to `index.html`**

In `frontend/index.html`, after the top-bar-divider (line 18) and before the microscope-only menu-group (line 20), add:

```html
    <div class="menu-group fringe-only" hidden>
      <button class="menu-btn" id="btn-menu-fringe-settings">Settings ▾</button>
      <div class="dropdown fringe-settings-panel" id="dropdown-fringe-settings" hidden>
        <div class="detect-section">
          <div class="detect-section-label">Wavelength</div>
          <select id="fringe-wavelength" style="width:100%;margin-top:4px;padding:4px"></select>
          <div id="fringe-custom-wl-label" hidden style="margin-top:4px">
            <label style="font-size:11px">Custom (nm)
              <input type="number" id="fringe-custom-wl" min="200" max="2000" step="0.1" value="589.0" style="width:80px;margin-left:4px" />
            </label>
          </div>
        </div>
        <div class="detect-section">
          <div class="detect-section-label">Mask Threshold</div>
          <div class="detect-row">
            <input type="range" id="fringe-mask-thresh" min="0" max="100" step="1" value="15" style="flex:1" />
            <span id="fringe-mask-thresh-val" class="detect-val" style="min-width:28px">15%</span>
          </div>
        </div>
        <div class="detect-section">
          <div class="detect-section-label">Reference Standard</div>
          <select id="fringe-standard" style="width:100%;margin-top:4px;padding:4px">
            <option value="">None</option>
          </select>
        </div>
      </div>
    </div>

    <div class="menu-group fringe-only" hidden>
      <button class="menu-btn" id="btn-menu-fringe-export">Export ▾</button>
      <div class="dropdown fringe-export-panel" id="dropdown-fringe-export" hidden>
        <div class="detect-section" style="display:flex;flex-direction:column;gap:4px">
          <button class="detect-btn" id="fringe-btn-export-pdf" disabled>PDF Report</button>
          <button class="detect-btn" id="fringe-btn-export-csv" disabled>Zernike CSV</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: Wire dropdown toggle behavior**

The existing microscope dropdowns are toggled by JS in `frontend/main.js`. Check how the existing dropdown toggle works (search for `dropdown-detect` or `btn-menu-detect` in `main.js`) and wire the fringe dropdowns identically. The pattern is: click the button → toggle the dropdown's `hidden` attribute, close others.

Since `fringe.js` handles its own init, the wiring will be done in Task 7 (fringe.js coordinator) when we wire the top bar buttons. For now, just add the HTML markup.

- [ ] **Step 4: Add CSS for `fringe-only` visibility**

In `frontend/style.css`, add near the existing `.microscope-only` rules (if any) or at the end of the top-bar section:

```css
/* Fringe-only items — hidden by default, shown when fringe mode active */
.fringe-only[hidden] { display: none !important; }
```

- [ ] **Step 5: Verify mode switching works**

Run: `./server.sh restart`
Open browser → switch between Microscope and Fringe modes. Verify:
- Fringe Settings/Export dropdowns appear only in Fringe mode
- Microscope Detect/Measure/etc disappear in Fringe mode
- No console errors

- [ ] **Step 6: Commit**

```bash
git add frontend/modes.js frontend/index.html frontend/style.css
git commit -m "feat: add fringe-only top bar dropdowns (Settings, Export)

Add fringe-only class toggling in modes.js and Settings/Export
dropdown markup in the top bar. Dropdowns will be wired in the
fringe module restructure."
```

---

### Task 3: CSS for subtraction pills and progress bar

**Files:**
- Modify: `frontend/style.css`

**Context:** Two new UI components need styling: the Zernike subtraction toggle pills (results area) and the analysis progress bar (left panel). These are added as CSS now so the later tasks that create the HTML can use them immediately.

- [ ] **Step 1: Add subtraction pill styles**

Append to `frontend/style.css`:

```css
/* ── Fringe subtraction pills ──────────────────────────────────────── */
.fringe-subtract-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.fringe-subtract-row .fringe-sub-label {
  font-size: 10px;
  opacity: 0.5;
  margin-right: 2px;
}

.fringe-pill {
  padding: 2px 8px;
  font-size: 10px;
  background: var(--bg-secondary, #2a2a2e);
  color: var(--text-secondary, #ccc);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  font-family: inherit;
  line-height: 1.4;
}

.fringe-pill:hover {
  border-color: #5a5a5e;
}

.fringe-pill.active {
  background: #2a5a8a;
  color: #fff;
  border-color: #3a7abd;
}

.fringe-pill.locked {
  opacity: 0.6;
  cursor: default;
}

.fringe-pill.locked:hover {
  border-color: var(--border);
}

.fringe-pill-divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 2px;
}
```

- [ ] **Step 2: Add progress bar styles**

Append to `frontend/style.css`:

```css
/* ── Fringe progress bar ───────────────────────────────────────────── */
.fringe-progress {
  margin-top: 4px;
}

.fringe-progress[hidden] { display: none; }

.fringe-progress-bar {
  height: 3px;
  background: #333;
  border-radius: 2px;
  overflow: hidden;
}

.fringe-progress-fill {
  height: 100%;
  width: 0%;
  background: #3a7abd;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.fringe-progress-fill.done {
  background: var(--success, #2ecc71);
}

.fringe-progress-fill.error {
  background: var(--danger, #e74c3c);
}

.fringe-progress-fill.timeout {
  background: var(--warning, #f39c12);
}

.fringe-progress-label {
  font-size: 9px;
  opacity: 0.5;
  margin-top: 2px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.fringe-progress-retry {
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
  font: inherit;
  padding: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/style.css
git commit -m "style: add CSS for fringe subtraction pills and progress bar"
```

---

### Task 4: Extract `fringe-measure.js`

**Files:**
- Create: `frontend/fringe-measure.js`
- Modify: `frontend/fringe.js` (remove extracted functions, add imports)

**Context:** This is the cleanest extraction — measurement functions are self-contained and only need the `fr` state object. Functions to extract: `drawCursorCrosshair`, `handlePoint2PointClick`, `drawMeasurePoints`, `handleLineProfileClick`, `drawProfileLine`, `drawLineProfileChart`, `handleAreaClick`, `computeAreaStats`, `setMeasureReadout`, `clearMeasureSvg`, `findPeakValley`, `drawPeakValleyMarkers`, `getHeightAt`, `surfaceMouseCoords`, `fmtNm` (the one at line 1050, not the lambda inside `renderResults`).

- [ ] **Step 1: Create `frontend/fringe-measure.js`**

Create the file with all measurement functions. The module needs:
- Import `fr` and `$` from `fringe.js` (which must first export them — see Step 2)
- Export all measurement functions that are called from outside (by `wireEvents` in `fringe.js`)

```javascript
// fringe-measure.js — Surface map measurement tools for fringe mode.
//
// Handles cursor readout, point-to-point height, line profiles,
// area statistics, and peak/valley markers on the surface map.

import { fr, $ } from './fringe.js';

export function setMeasureReadout(text) {
  const el = $("fringe-measure-readout");
  if (el) el.textContent = text;
}

export function clearMeasureSvg() {
  const svg = $("fringe-measure-svg");
  if (svg) svg.innerHTML = "";
}

export function fmtNm(v) {
  // Copy of the standalone fmtNm at fringe.js:1050 (not the lambda in renderResults)
  // Format nanometer values with appropriate precision
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0) + " nm";
  if (abs >= 100) return v.toFixed(1) + " nm";
  return v.toFixed(2) + " nm";
}
```

Then copy these functions verbatim from `fringe.js`, adding `export` to each:
- `export function getHeightAt(nx, ny)` (lines 1031-1038)
- `export function surfaceMouseCoords(e)` (lines 1040-1048)
- `export function findPeakValley()` (lines 977-999)
- `export function drawPeakValleyMarkers()` (lines 1002-1029)
- `export function drawCursorCrosshair(nx, ny)` (lines 684-698)
- `export function handlePoint2PointClick(coords)` (lines 700-717)
- `export function drawMeasurePoints()` (lines 719-752)
- `export function handleLineProfileClick(coords)` (lines 754-769)
- `export function drawProfileLine(p1, p2)` (lines 771-811)
- `export function drawLineProfileChart(samples)` (lines 813-876)
- `export function handleAreaClick(coords)` (lines 878-889)
- `export function computeAreaStats(p1, p2)` (lines 891-936)

Also export a wiring function for the measurement toolbar and surface viewport events:

```javascript
export function wireMeasureEvents() {
  // Measurement toolbar button switching
  document.querySelectorAll(".fringe-measure-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      // ... copy the event handler from fringe.js lines 584-598
    });
  });

  // Surface viewport mouse events (mousemove, mouseleave, click)
  const viewport = $("fringe-surface-viewport");
  if (viewport) {
    // Surface zoom/pan: copy from fringe.js lines 550-581
    // ... (the smZoom, smPanX, smPanY, smDragging logic)

    // Measurement mouse events: copy from fringe.js lines 602-661
    // ... (cursor, point2point, lineProfile, area handlers)
  }
}
```

- [ ] **Step 2: Export `fr` and `$` from `fringe.js`**

In `fringe.js`, change:
```javascript
const fr = {
```
to:
```javascript
export const fr = {
```

And change:
```javascript
function $(id) { return document.getElementById(id); }
```
to:
```javascript
export function $(id) { return document.getElementById(id); }
```

- [ ] **Step 3: Remove extracted functions from `fringe.js` and add imports**

At the top of `fringe.js`, add:
```javascript
import {
  wireMeasureEvents,
  drawPeakValleyMarkers,
  setMeasureReadout,
  clearMeasureSvg,
  fmtNm,
  getHeightAt,
  findPeakValley,
} from './fringe-measure.js';
```

Delete the function bodies from `fringe.js` (lines 684-936, 967-1057 approximately).

In `wireEvents()`, replace the inline measurement toolbar wiring (lines 583-661) with:
```javascript
  wireMeasureEvents();
```

- [ ] **Step 4: Verify the app works**

Run: `./server.sh restart`
Open browser → Fringe mode → analyze an image → verify surface map measurement tools (cursor, Δh, profile, area) still work. Check browser console for import errors.

- [ ] **Step 5: Run backend tests (sanity check)**

Run: `.venv/bin/pytest tests/ -v`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/fringe-measure.js frontend/fringe.js
git commit -m "refactor: extract fringe-measure.js from fringe.js

Move surface map measurement tools (cursor, point-to-point, line
profile, area stats, peak/valley markers) into dedicated module.
~300 lines extracted."
```

---

### Task 5: Create `fringe-progress.js`

**Files:**
- Create: `frontend/fringe-progress.js`

**Context:** This module handles the SSE streaming fetch to `/fringe/analyze-stream`, updates the progress bar DOM, and manages timeout/retry. It exports `analyzeWithProgress()` which will replace the current `fetch` call in the analyze handler. The progress bar HTML is injected below the analyze button.

- [ ] **Step 1: Create `frontend/fringe-progress.js`**

```javascript
// fringe-progress.js — SSE streaming client + progress bar for fringe analysis.
//
// Streams POST /fringe/analyze-stream, updates a progress bar with stage
// labels, handles 30s inactivity timeout and error/retry states.

import { $ } from './fringe.js';

const TIMEOUT_MS = 30_000;

/**
 * Create the progress bar DOM and insert it after the analyze button.
 * Call once during init. Returns the container element.
 */
export function createProgressBar() {
  const btn = $("fringe-btn-analyze");
  if (!btn) return null;

  const container = document.createElement("div");
  container.className = "fringe-progress";
  container.hidden = true;
  container.innerHTML = `
    <div class="fringe-progress-bar">
      <div class="fringe-progress-fill" id="fringe-progress-fill"></div>
    </div>
    <div class="fringe-progress-label">
      <span id="fringe-progress-msg"></span>
      <button class="fringe-progress-retry" id="fringe-progress-retry" hidden>Retry</button>
    </div>
  `;

  btn.insertAdjacentElement("afterend", container);
  return container;
}

/**
 * Run fringe analysis with SSE progress streaming.
 *
 * @param {object} body - JSON body for /fringe/analyze-stream
 * @param {function} onResult - called with the analysis result on success
 * @param {function} onError - called with error message string on failure
 * @param {function} [onRetry] - if provided, wired to the Retry button
 */
export async function analyzeWithProgress(body, onResult, onError, onRetry) {
  const container = document.querySelector(".fringe-progress");
  const fill = $("fringe-progress-fill");
  const msg = $("fringe-progress-msg");
  const retryBtn = $("fringe-progress-retry");

  if (!container || !fill || !msg) {
    // Fallback: no progress bar DOM, just do a regular fetch
    onError("Progress bar not initialized");
    return;
  }

  // Reset state
  container.hidden = false;
  fill.style.width = "0%";
  fill.className = "fringe-progress-fill";
  msg.textContent = "Starting...";
  if (retryBtn) {
    retryBtn.hidden = true;
    // Wire retry
    if (onRetry) {
      retryBtn.onclick = () => {
        retryBtn.hidden = true;
        onRetry();
      };
    }
  }

  const controller = new AbortController();
  let timeoutId = null;

  function resetTimeout() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      controller.abort();
      fill.className = "fringe-progress-fill timeout";
      msg.textContent = "Analysis timed out (no response for 30s).";
      if (retryBtn && onRetry) retryBtn.hidden = false;
      onError("Timeout");
    }, TIMEOUT_MS);
  }

  try {
    resetTimeout();

    const response = await fetch("/fringe/analyze-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      resetTimeout();
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        if (event.stage === "done") {
          fill.style.width = "100%";
          fill.className = "fringe-progress-fill done";
          msg.textContent = "Complete";
          if (timeoutId) clearTimeout(timeoutId);
          // Hide progress bar after a brief moment
          setTimeout(() => { container.hidden = true; }, 1500);
          onResult(event.result);
          return;
        }

        if (event.stage === "error") {
          fill.className = "fringe-progress-fill error";
          msg.textContent = event.message || "Analysis failed";
          if (retryBtn && onRetry) retryBtn.hidden = false;
          if (timeoutId) clearTimeout(timeoutId);
          onError(event.message);
          return;
        }

        // Progress update
        if (typeof event.progress === "number") {
          fill.style.width = (event.progress * 100) + "%";
        }
        if (event.message) {
          msg.textContent = event.message;
        }
      }
    }

    // Stream ended without done/error event
    if (timeoutId) clearTimeout(timeoutId);
    fill.className = "fringe-progress-fill error";
    msg.textContent = "Stream ended unexpectedly";
    if (retryBtn && onRetry) retryBtn.hidden = false;
    onError("Stream ended unexpectedly");

  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId);
    if (e.name === "AbortError") return; // timeout already handled
    fill.className = "fringe-progress-fill error";
    msg.textContent = "Connection lost";
    if (retryBtn && onRetry) retryBtn.hidden = false;
    onError(e.message);
  }
}

/**
 * Hide and reset the progress bar.
 */
export function hideProgress() {
  const container = document.querySelector(".fringe-progress");
  if (container) container.hidden = true;
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `./server.sh restart`
Open browser console → check for import/parse errors in fringe-progress.js (it won't be imported yet — just verify the file serves correctly by navigating to `http://localhost:8000/frontend/fringe-progress.js`).

- [ ] **Step 3: Commit**

```bash
git add frontend/fringe-progress.js
git commit -m "feat: create fringe-progress.js — SSE streaming client

New module handling streaming fetch to /fringe/analyze-stream,
progress bar DOM, 30s inactivity timeout, and error/retry states."
```

---

### Task 6: Create `fringe-panel.js` — restructured left panel

**Files:**
- Create: `frontend/fringe-panel.js`
- Modify: `frontend/fringe.js` (remove panel functions, add imports)

**Context:** This module owns the left panel HTML template and all capture-workflow logic: analyze button (now using `analyzeWithProgress`), averaging, mask polygon drawing, drop zone, focus polling. The template is restructured: settings, export, and Zernike subtraction sections are removed (they moved to top bar and results area). The analyze button is downsized.

- [ ] **Step 1: Create `frontend/fringe-panel.js`**

```javascript
// fringe-panel.js — Left panel template + capture workflow for fringe mode.
//
// Owns: camera preview, focus bar, analyze button, averaging controls,
// mask polygon drawing, drop zone, focus polling.

import { fr, $ } from './fringe.js';
import { apiFetch } from './api.js';
import { analyzeWithProgress, createProgressBar } from './fringe-progress.js';

// ── Left panel HTML template ────────────────────────────────────────
// Returns the HTML string for the left column content.
// Settings, export, and Zernike subtraction have moved to top bar / results area.

export function buildPanelHtml() {
  return `
    <div class="fringe-preview-container" style="position:relative">
      <img id="fringe-preview" src="/stream" alt="Camera preview" />
      <canvas id="fringe-roi-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
      <div class="fringe-enlarge-overlay" id="fringe-enlarge-overlay" hidden>
        <img id="fringe-enlarge-img" />
        <button class="fringe-enlarge-close" id="fringe-enlarge-close">&#10005;</button>
      </div>
    </div>
    <div class="fringe-focus-bar-container">
      <label style="font-size:11px;opacity:0.7">Focus quality</label>
      <div class="fringe-focus-bar">
        <div class="fringe-focus-fill" id="fringe-focus-fill" style="width:0%"></div>
      </div>
      <span id="fringe-focus-score" style="font-size:11px;min-width:30px;text-align:right">--</span>
    </div>

    <button class="detect-btn" id="fringe-btn-analyze" style="padding:4px 10px;font-size:11px;width:100%">
      Freeze &amp; Analyze
    </button>

    <div id="fringe-avg-controls" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <div style="display:flex;gap:4px;align-items:center">
        <button class="detect-btn" id="fringe-btn-avg-add" style="padding:4px 10px;font-size:11px;flex:1" disabled title="Freeze a frame and add its Zernike coefficients to the running average">
          + Add to Avg
        </button>
        <span id="fringe-avg-count" style="font-size:11px;opacity:0.6;min-width:20px;text-align:center">0</span>
        <button class="detect-btn" id="fringe-btn-avg-reset" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
          Reset
        </button>
      </div>
      <div style="display:flex;gap:4px;align-items:center;margin-top:2px">
        <label style="font-size:10px;opacity:0.5">Reject &gt;</label>
        <input type="number" id="fringe-avg-reject" min="1.5" max="10" step="0.5" value="3" style="width:40px;font-size:10px;padding:1px 3px" title="Auto-reject captures with RMS exceeding this multiple of the average" />
        <span style="font-size:10px;opacity:0.5">&times; avg</span>
      </div>
      <div id="fringe-avg-log" style="max-height:80px;overflow-y:auto;font-size:10px;margin-top:2px"></div>
    </div>

    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);display:flex;gap:4px;align-items:center">
      <button class="detect-btn" id="fringe-btn-mask" style="padding:4px 10px;font-size:11px;flex:1">
        Draw Mask
      </button>
      <button class="detect-btn" id="fringe-btn-mask-hole" style="padding:4px 10px;font-size:11px;flex:1" hidden>
        + Add Hole
      </button>
      <button class="detect-btn" id="fringe-btn-mask-clear" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
        Clear All
      </button>
    </div>
    <div id="fringe-mask-hint" style="font-size:10px;opacity:0.5;text-align:center" hidden>
      Click vertices to draw polygon. Double-click to close. Right-click to undo last vertex.
    </div>

    <div class="fringe-drop-zone" id="fringe-drop-zone" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <span style="opacity:0.5;font-size:12px">or drag &amp; drop an image</span>
    </div>
  `;
}

// ── Getters (used by multiple modules) ──────────────────────────────

export function getWavelength() {
  const sel = $("fringe-wavelength");
  if (!sel) return 632.8;
  if (sel.value === "custom") {
    const input = $("fringe-custom-wl");
    return input ? parseFloat(input.value) || 632.8 : 632.8;
  }
  const opt = sel.selectedOptions[0];
  return opt ? parseFloat(opt.dataset.nm) || 632.8 : 632.8;
}

export function getMaskThreshold() {
  const el = $("fringe-mask-thresh");
  return el ? parseInt(el.value, 10) / 100 : 0.15;
}

// ── Build analysis request body ─────────────────────────────────────

function buildAnalyzeBody(extra = {}) {
  const body = {
    wavelength_nm: getWavelength(),
    mask_threshold: getMaskThreshold(),
    ...extra,
  };
  if (fr.maskPolygons.length > 0) {
    body.mask_polygons = fr.maskPolygons.map(p => ({
      vertices: p.vertices.map(v => [v.x, v.y]),
      include: p.include,
    }));
  }
  return body;
}

// ── Analysis handlers ───────────────────────────────────────────────
// These are imported by fringe.js and wired to button click events.

export async function analyzeFromCamera() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;

  const body = buildAnalyzeBody();

  analyzeWithProgress(
    body,
    (result) => {
      fr.lastResult = result;
      // Dispatch a custom event so fringe-results.js can render
      document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: result }));
      if (btn) btn.disabled = false;
      $("fringe-btn-avg-add") && ($("fringe-btn-avg-add").disabled = false);
      $("fringe-btn-invert") && ($("fringe-btn-invert").disabled = false);
      $("fringe-btn-export-pdf") && ($("fringe-btn-export-pdf").disabled = false);
      $("fringe-btn-export-csv") && ($("fringe-btn-export-csv").disabled = false);
    },
    (errorMsg) => {
      console.warn("Fringe analysis error:", errorMsg);
      if (btn) btn.disabled = false;
    },
    () => analyzeFromCamera(), // retry
  );
}

export async function analyzeFromFile(file) {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;

  try {
    const arrayBuf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
    const body = buildAnalyzeBody({ image_b64: b64 });

    analyzeWithProgress(
      body,
      (result) => {
        fr.lastResult = result;
        document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: result }));
        if (btn) btn.disabled = false;
        $("fringe-btn-avg-add") && ($("fringe-btn-avg-add").disabled = false);
        $("fringe-btn-invert") && ($("fringe-btn-invert").disabled = false);
        $("fringe-btn-export-pdf") && ($("fringe-btn-export-pdf").disabled = false);
        $("fringe-btn-export-csv") && ($("fringe-btn-export-csv").disabled = false);
      },
      (errorMsg) => {
        console.warn("Fringe analysis error:", errorMsg);
        if (btn) btn.disabled = false;
      },
    );
  } catch (e) {
    console.warn("File read error:", e);
    if (btn) btn.disabled = false;
  }
}

// ── Averaging ───────────────────────────────────────────────────────
// Copy these functions verbatim from fringe.js:
// - computeAverage (lines 1559-1569)
// - renderAvgLog (lines 1571-1597) — uses safe DOM construction, not innerHTML
// - toggleCapture (lines 1599-1603)
// - recomputeAverage (lines 1605-1639) — imports getSubtractTerms from fringe-results.js
// - addToAverage (lines 1641-1700)
// - resetAverage (lines 1702-1711)
//
// All exported. Replace getSubtractTerms() calls with import from fringe-results.js.
// Replace getWavelength() calls with the local getWavelength() defined above.

export function computeAverage() { /* copy from fringe.js:1559-1569 */ }
export function renderAvgLog() { /* copy from fringe.js:1571-1597 */ }
export async function toggleCapture(idx) { /* copy from fringe.js:1599-1603 */ }
export async function recomputeAverage() { /* copy from fringe.js:1605-1639 */ }
export async function addToAverage() { /* copy from fringe.js:1641-1700 */ }
export function resetAverage() { /* copy from fringe.js:1702-1711 */ }

// ── Mask polygon drawing ────────────────────────────────────────────
// Copy these functions verbatim from fringe.js:
// - drawMaskOverlay (lines 1059-1068)
// - _drawPolygonsOnCtx (lines 1070-1123)
// - enterMaskDrawMode (lines 1125-1253)
// - exitMaskDrawMode (lines 1255-1283)
// - drawEnlargeMaskOverlay (lines 1285-1318)
// - _wireEnlargeContextMenu (lines 1320-1354)
// - _pointInPolygon (lines 1356-1366)
// - _showPolyContextMenu (lines 1368-1430)
//
// All need fr state for maskPolygons, maskDrawing, maskCurrentVertices, maskIsHole.

export function drawMaskOverlay() { /* copy from fringe.js:1059-1068 */ }
export function _drawPolygonsOnCtx(ctx, w, h, polygons, currentVerts) { /* copy */ }
export function enterMaskDrawMode(isHole) { /* copy from fringe.js:1125-1253 */ }
export function exitMaskDrawMode() { /* copy from fringe.js:1255-1283 */ }
export function drawEnlargeMaskOverlay(canvas, cursor, nearFirst) { /* copy */ }
export function _wireEnlargeContextMenu() { /* copy */ }
export function _pointInPolygon(px, py, vertices) { /* copy */ }
export function _showPolyContextMenu(cx, cy, idx) { /* copy */ }

// ── Focus polling ───────────────────────────────────────────────────

export async function pollFocusQuality() { /* copy from fringe.js:2298-2314 */ }
export function startPolling() { /* copy from fringe.js:2316-2320 */ }
export function stopPolling() { /* copy from fringe.js:2322-2327 */ }

// ── Panel event wiring ──────────────────────────────────────────────

export function wirePanelEvents() {
  // Analyze button
  $("fringe-btn-analyze")?.addEventListener("click", analyzeFromCamera);

  // Create progress bar DOM (after analyze button exists)
  createProgressBar();

  // Averaging buttons
  $("fringe-btn-avg-add")?.addEventListener("click", addToAverage);
  $("fringe-btn-avg-reset")?.addEventListener("click", resetAverage);
  $("fringe-avg-reject")?.addEventListener("change", (e) => {
    fr.avgRejectThreshold = parseFloat(e.target.value) || 3;
  });

  // Mask buttons
  $("fringe-btn-mask")?.addEventListener("click", () => {
    if (fr.maskDrawing) exitMaskDrawMode();
    else enterMaskDrawMode(false);
  });
  $("fringe-btn-mask-hole")?.addEventListener("click", () => enterMaskDrawMode(true));
  $("fringe-btn-mask-clear")?.addEventListener("click", () => {
    fr.maskPolygons = [];
    drawMaskOverlay();
    const clearBtn = $("fringe-btn-mask-clear");
    if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.6"; }
    const holeBtn = $("fringe-btn-mask-hole");
    if (holeBtn) holeBtn.hidden = true;
  });

  // Drop zone
  const dropZone = $("fringe-drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("fringe-drop-active");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("fringe-drop-active"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("fringe-drop-active");
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) analyzeFromFile(file);
    });
  }

  // Preview click-to-enlarge
  const preview = $("fringe-preview");
  if (preview) {
    preview.style.cursor = "zoom-in";
    preview.addEventListener("click", () => {
      const overlay = $("fringe-enlarge-overlay");
      const enlargeImg = $("fringe-enlarge-img");
      if (overlay && enlargeImg) {
        enlargeImg.src = preview.src;
        overlay.hidden = false;
      }
    });
  }
  $("fringe-enlarge-close")?.addEventListener("click", () => {
    if (fr.maskDrawing) { exitMaskDrawMode(); return; }
    const overlay = $("fringe-enlarge-overlay");
    if (overlay) overlay.hidden = true;
  });
  $("fringe-enlarge-overlay")?.addEventListener("click", (e) => {
    if (fr.maskDrawing) return;
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (fr.maskDrawing) { exitMaskDrawMode(); return; }
      const overlay = $("fringe-enlarge-overlay");
      if (overlay && !overlay.hidden) overlay.hidden = true;
    }
  });

  // Preview scroll-to-zoom
  const previewContainer = preview?.parentElement;
  if (previewContainer) {
    let zoomLevel = 1;
    previewContainer.addEventListener("wheel", (e) => {
      e.preventDefault();
      const img = $("fringe-preview");
      if (!img) return;
      zoomLevel = Math.max(1, Math.min(5, zoomLevel + (e.deltaY < 0 ? 0.2 : -0.2)));
      img.style.transform = `scale(${zoomLevel})`;
      img.style.transformOrigin = "center center";
    });
  }

  // Wavelength dropdown (moved to top bar, but still wired the same way)
  const wlSel = $("fringe-wavelength");
  if (wlSel) {
    wlSel.addEventListener("change", () => {
      const customLabel = $("fringe-custom-wl-label");
      if (customLabel) customLabel.hidden = wlSel.value !== "custom";
    });
  }

  // Mask threshold slider
  const maskSlider = $("fringe-mask-thresh");
  const maskLabel = $("fringe-mask-thresh-val");
  if (maskSlider && maskLabel) {
    maskSlider.addEventListener("input", () => {
      maskLabel.textContent = maskSlider.value + "%";
    });
  }
}
```

**Important:** The placeholder comments `/* copy from fringe.js:NNNN-NNNN */` mean: copy those exact lines from the current `fringe.js`, keeping the logic identical. Replace any calls to `getWavelength()` or `getMaskThreshold()` with the locally defined versions. Replace `getSubtractTerms()` calls with an import from `fringe-results.js` (created in Task 7). If `getSubtractTerms` doesn't exist yet, temporarily inline the import or use a late-binding approach (import at call time).

- [ ] **Step 2: Update `fringe.js` — remove panel functions, add imports**

Add imports at the top of `fringe.js`:
```javascript
import { buildPanelHtml, wirePanelEvents, startPolling, stopPolling, getWavelength, getMaskThreshold } from './fringe-panel.js';
```

In `buildWorkspace()`, replace the left column content (lines 111-231, from `<div class="fringe-preview-col">` inner content) with:
```javascript
      <div class="fringe-preview-col">
        ${buildPanelHtml()}
      </div>
```

Remove from `fringe.js`:
- `getWavelength` (lines 938-950)
- `getMaskThreshold` (lines 952-955)
- `setStatus` / `resetStatus` (lines 1432-1452)
- `analyzeFromCamera` (lines 1456-1504)
- `analyzeFromFile` (lines 1506-1555)
- All averaging functions (lines 1559-1711)
- All mask drawing functions (lines 1059-1430)
- Focus polling functions (lines 2298-2327)

In `wireEvents()`, remove:
- Analyze button click handler (line 449)
- Averaging button handlers (lines 452-456)
- Invert button handler (line 457) → moves to fringe-results.js
- Export button handlers (line 458-459) → moves to fringe-results.js
- Drop zone handlers (lines 462-478)
- Preview click/enlarge handlers (lines 482-525)
- Mask button handlers (lines 528-545)
- Wavelength dropdown handler (lines 426-432)
- Mask threshold slider handler (lines 435-441)

Replace all of the above with a single call:
```javascript
  wirePanelEvents();
```

- [ ] **Step 3: Verify the app works**

Run: `./server.sh restart`
Open browser → Fringe mode:
- Verify camera preview shows
- Click "Freeze & Analyze" → should show progress bar, then results
- Test averaging (Add to Avg, Reset)
- Test mask drawing (Draw Mask, Add Hole, Clear)
- Test drag & drop
- Check browser console for errors

- [ ] **Step 4: Commit**

```bash
git add frontend/fringe-panel.js frontend/fringe.js
git commit -m "refactor: extract fringe-panel.js — left panel + capture workflow

Move left panel template, analyze handlers (now using SSE progress),
averaging, mask polygon drawing, focus polling, and drop zone into
dedicated module. Left panel no longer contains settings, export,
or Zernike subtraction controls."
```

---

### Task 7: Create `fringe-results.js` — results + subtraction pills

**Files:**
- Create: `frontend/fringe-results.js`
- Modify: `frontend/fringe.js` (remove results functions, add imports)

**Context:** This module owns the results column HTML (summary bar, carrier row, subtraction pills, tabs, and all tab panel content), plus all rendering functions. The Zernike subtraction checkboxes are replaced with toggle pills. Export functions (CSV/PDF) also live here since they operate on `fr.lastResult`.

- [ ] **Step 1: Create `frontend/fringe-results.js`**

```javascript
// fringe-results.js — Results column rendering + Zernike subtraction pills.
//
// Owns: summary bar, carrier info, subtraction pill row, tab bar,
// all tab panels (surface, 3D, zernike, profiles, PSF/MTF, diagnostics),
// rendering functions, doReanalyze, invertWavefront, export (CSV/PDF).

import { fr, $ } from './fringe.js';
import { apiFetch } from './api.js';
import { getWavelength } from './fringe-panel.js';
import { drawPeakValleyMarkers } from './fringe-measure.js';

// ── Subtraction pill state ──────────────────────────────────────────
// Replaces the old checkbox-based approach.

const SUBTRACT_PILLS = [
  { id: "tilt",      terms: [2, 3],  label: "Tilt",      locked: true },
  { id: "power",     terms: [4],     label: "Power",     locked: false },
  { id: "astig",     terms: [5, 6],  label: "Astig",     locked: false },
  { id: "coma",      terms: [7, 8],  label: "Coma",      locked: false },
  { id: "spherical", terms: [11],    label: "Spherical", locked: false },
];

// Track which pills are active (tilt always on)
const pillState = { tilt: true, power: false, astig: false, coma: false, spherical: false };

/**
 * Get the current list of Noll indices to subtract, based on pill state.
 * Always includes piston (1) and tilt (2, 3).
 */
export function getSubtractTerms() {
  const terms = [1]; // piston always
  for (const pill of SUBTRACT_PILLS) {
    if (pillState[pill.id]) terms.push(...pill.terms);
  }
  return terms;
}

// ── Results column HTML ─────────────────────────────────────────────

export function buildResultsHtml() {
  // Build pill row HTML
  const pillsHtml = SUBTRACT_PILLS.map(p => {
    const cls = `fringe-pill${pillState[p.id] ? " active" : ""}${p.locked ? " locked" : ""}`;
    return `<button class="${cls}" data-pill="${p.id}" ${p.locked ? "" : 'onclick="void(0)"'}>${p.label}</button>`;
  }).join("\n          ");

  return `
    <div class="fringe-summary-bar" id="fringe-summary-bar" hidden title="PV = total range of surface error. RMS = average deviation. Lower = flatter.">
      <div class="fringe-stat">
        <span class="fringe-stat-label" title="Peak-to-Valley: worst-case surface error">PV</span>
        <span class="fringe-stat-value" id="fringe-pv-waves">--</span>
        <span class="fringe-stat-unit">\u03bb</span>
        <span class="fringe-stat-value fringe-stat-nm" id="fringe-pv-nm">--</span>
        <span class="fringe-stat-unit">nm</span>
      </div>
      <div class="fringe-stat">
        <span class="fringe-stat-label">RMS</span>
        <span class="fringe-stat-value" id="fringe-rms-waves">--</span>
        <span class="fringe-stat-unit">\u03bb</span>
        <span class="fringe-stat-value fringe-stat-nm" id="fringe-rms-nm">--</span>
        <span class="fringe-stat-unit">nm</span>
      </div>
      <div class="fringe-stat">
        <span class="fringe-stat-label" title="Strehl ratio: 1.0 = diffraction-limited. Computed as exp(-(2\u03c0\u00b7RMS)\u00b2)">Strehl</span>
        <span class="fringe-stat-value" id="fringe-strehl">--</span>
      </div>
      <div class="fringe-stat" style="margin-left:auto">
        <span class="fringe-stat-label" style="min-width:auto">\u03bb</span>
        <span id="fringe-summary-wl" style="font-size:12px;opacity:0.7">589 nm</span>
        <span style="margin-left:12px;font-size:11px;opacity:0.5" id="fringe-summary-sub">Tilt subtracted</span>
      </div>
    </div>

    <div class="fringe-carrier-row" id="fringe-carrier-row" hidden style="display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:11px;opacity:0.8;border-bottom:1px solid var(--border);cursor:pointer" title="Click to open Diagnostics tab">
      <span id="fringe-carrier-dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0"></span>
      <span>Carrier: <span id="fringe-carrier-period">--</span>px period @ <span id="fringe-carrier-angle">--</span>&deg;</span>
      <span style="margin-left:auto;opacity:0.6">Confidence: <span id="fringe-carrier-confidence">--</span></span>
    </div>

    <div class="fringe-subtract-row" id="fringe-subtract-row">
      <span class="fringe-sub-label">Subtract:</span>
      ${pillsHtml}
      <div class="fringe-pill-divider"></div>
      <button class="fringe-pill" id="fringe-btn-invert" disabled>\u2195 Invert</button>
    </div>

    <div class="fringe-tab-bar" id="fringe-tab-bar">
      <button class="fringe-tab active" data-tab="surface">Surface Map</button>
      <button class="fringe-tab" data-tab="3d">3D View</button>
      <button class="fringe-tab" data-tab="zernike">Zernike</button>
      <button class="fringe-tab" data-tab="profiles">Profiles</button>
      <button class="fringe-tab" data-tab="psf">PSF / MTF</button>
      <button class="fringe-tab" data-tab="diagnostics">Diagnostics</button>
    </div>

    <!-- Tab panels: copy verbatim from fringe.js lines 277-397 -->
    <!-- Surface Map panel (with measure toolbar, viewport, loading overlay) -->
    <!-- 3D View panel -->
    <!-- Zernike panel -->
    <!-- Profiles panel -->
    <!-- PSF/MTF panel -->
    <!-- Diagnostics panel -->
  `;
}
```

**Important:** The tab panel HTML (Surface Map, 3D View, Zernike, Profiles, PSF/MTF, Diagnostics) is copied verbatim from the current `fringe.js` lines 277-397. The only structural change is: the `fringe-loading-overlay` inside the surface panel is removed (progress bar replaces it).

Then copy these functions from `fringe.js`, all exported:

```javascript
// ── Rendering functions (copy verbatim from fringe.js) ──────────────
export function renderResults(data) { /* copy from fringe.js:1750-1901 */ }
export function updateCarrierDisplay(data) { /* copy from fringe.js:1905-1955 */ }
export function wireCarrierOverride() { /* copy from fringe.js:1957-2019 */ }
export function drawProfile(canvas, profile, title) { /* copy from fringe.js:2021-2082 */ }
export function drawMtfChart(mtfData) { /* copy from fringe.js:2084-2162 */ }
export async function render3dView() { /* copy from fringe.js:2166-2294 */ }
export async function doReanalyze() { /* copy from fringe.js:1713-1746 */ }
export async function invertWavefront() { /* copy from fringe.js:2331-2376 */ }
export function exportFringeCsv() { /* copy from fringe.js:2380-2411 */ }
export function exportFringePdf() { /* copy from fringe.js:2414-2547 */ }
```

**Key changes in the copied functions:**
- `renderResults`: replace `getSubtractTerms()` calls with the local `getSubtractTerms()`. Replace `getWavelength()` with the imported `getWavelength` from `fringe-panel.js`.
- `doReanalyze`: same import replacements.
- `invertWavefront`: same import replacements. Dispatch `"fringe:analyzed"` event after re-render so panel can update button states.
- Remove the `fringe-loading-overlay` show/hide from `renderResults` — progress bar handles this now.

Add pill wiring and results event wiring:

```javascript
// ── Results event wiring ────────────────────────────────────────────

export function wireResultsEvents() {
  // Tab switching
  document.querySelectorAll(".fringe-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".fringe-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".fringe-tab-panel").forEach(p => p.hidden = true);
      tab.classList.add("active");
      const panel = $("fringe-panel-" + tab.dataset.tab);
      if (panel) panel.hidden = false;
      if (tab.dataset.tab === "3d" && fr.lastResult) render3dView();
    });
  });

  // Subtraction pills
  let _reanalyzeDebounce = null;
  document.querySelectorAll(".fringe-pill[data-pill]").forEach(btn => {
    if (btn.classList.contains("locked")) return;
    btn.addEventListener("click", () => {
      const id = btn.dataset.pill;
      pillState[id] = !pillState[id];
      btn.classList.toggle("active", pillState[id]);
      // Debounced re-analyze
      if (_reanalyzeDebounce) clearTimeout(_reanalyzeDebounce);
      _reanalyzeDebounce = setTimeout(() => {
        if (fr.lastResult) doReanalyze();
      }, 150);
    });
  });

  // Invert button
  $("fringe-btn-invert")?.addEventListener("click", invertWavefront);

  // Export buttons (now in top bar)
  $("fringe-btn-export-pdf")?.addEventListener("click", exportFringePdf);
  $("fringe-btn-export-csv")?.addEventListener("click", exportFringeCsv);

  // Reference standard change
  $("fringe-standard")?.addEventListener("change", () => {
    if (fr.lastResult) renderResults(fr.lastResult);
  });

  // Carrier row → diagnostics tab
  $("fringe-carrier-row")?.addEventListener("click", () => {
    document.querySelectorAll(".fringe-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".fringe-tab-panel").forEach(p => p.hidden = true);
    const diagTab = document.querySelector('.fringe-tab[data-tab="diagnostics"]');
    if (diagTab) diagTab.classList.add("active");
    const panel = $("fringe-panel-diagnostics");
    if (panel) panel.hidden = false;
  });

  // Wire carrier override (FFT click)
  wireCarrierOverride();

  // Listen for analysis results from panel
  document.addEventListener("fringe:analyzed", (e) => {
    renderResults(e.detail);
  });
}
```

- [ ] **Step 2: Update `fringe.js` — remove results functions, add imports**

Add imports:
```javascript
import { buildResultsHtml, wireResultsEvents, getSubtractTerms, renderResults } from './fringe-results.js';
```

In `buildWorkspace()`, replace the right column content (lines 235-398) with:
```javascript
      <div class="fringe-results-col">
        ${buildResultsHtml()}
      </div>
```

Remove from `fringe.js`:
- `getSubtractTerms` (lines 957-964)
- `renderResults` (lines 1750-1901)
- `updateCarrierDisplay` (lines 1905-1955)
- `wireCarrierOverride` (lines 1957-2019)
- `drawProfile` (lines 2021-2082)
- `drawMtfChart` (lines 2084-2162)
- `render3dView` (lines 2166-2294)
- `doReanalyze` (lines 1713-1746)
- `invertWavefront` (lines 2331-2376)
- `exportFringeCsv` (lines 2380-2411)
- `exportFringePdf` (lines 2414-2547)

In `wireEvents()`, remove:
- Tab switching (lines 408-423)
- Zernike checkbox handlers (lines 664-677)
- `wireCarrierOverride()` call (line 679)

Replace with:
```javascript
  wireResultsEvents();
```

- [ ] **Step 3: Verify the app works**

Run: `./server.sh restart`
Open browser → Fringe mode:
- Verify summary bar shows after analysis
- Click subtraction pills → should toggle and trigger re-analysis
- Verify all tabs work (Surface, 3D, Zernike, Profiles, PSF/MTF, Diagnostics)
- Verify carrier override (click FFT image)
- Verify Invert Wavefront works
- Verify Export PDF and CSV work from top bar
- Check browser console for errors

- [ ] **Step 4: Commit**

```bash
git add frontend/fringe-results.js frontend/fringe.js
git commit -m "refactor: extract fringe-results.js + Zernike subtraction pills

Move results rendering, tab switching, carrier diagnostics, 3D view,
export (CSV/PDF), doReanalyze, and invertWavefront into dedicated module.
Replace Zernike subtraction checkboxes with toggle pills in the results
area between carrier row and tab bar."
```

---

### Task 8: Final `fringe.js` coordinator cleanup + top bar wiring

**Files:**
- Modify: `frontend/fringe.js` (final slim-down)

**Context:** After Tasks 4-7, `fringe.js` should be slim: just the `fr` state object, `$()` helper, wavelength preset loading, `buildWorkspace()` (now just assembling sub-module HTML), `wireEvents()` (now just calling sub-module wirers), and `initFringe()`. This task cleans up any remaining dead code and wires the top bar dropdown toggles.

- [ ] **Step 1: Clean up `fringe.js`**

The file should now contain approximately:

```javascript
// fringe.js — Fringe analysis mode coordinator.
//
// State object, init, and module wiring. All logic lives in sub-modules:
//   fringe-panel.js    — left panel + capture workflow
//   fringe-results.js  — results rendering + subtraction pills
//   fringe-progress.js — SSE streaming + progress bar
//   fringe-measure.js  — surface map measurement tools

import { apiFetch } from './api.js';
import { buildPanelHtml, wirePanelEvents, startPolling, stopPolling } from './fringe-panel.js';
import { buildResultsHtml, wireResultsEvents } from './fringe-results.js';
import { wireMeasureEvents } from './fringe-measure.js';

export const fr = {
  polling: null,
  built: false,
  threeLoaded: false,
  lastResult: null,
  lastMask: null,
  maskPolygons: [],
  maskDrawing: false,
  maskCurrentVertices: [],
  maskIsHole: false,
  measureMode: null,
  measurePoints: [],
  heightGrid: null,
  maskGrid: null,
  gridRows: 0,
  gridCols: 0,
  avgCaptures: [],
  avgRejectThreshold: 3,
  avgSurfaceHeight: 0,
  avgSurfaceWidth: 0,
  carrierOverride: null,
};

export function $(id) { return document.getElementById(id); }

// ── Wavelength presets ──────────────────────────────────────────────
// Copy WAVELENGTHS array, rebuildWavelengthSelect, loadWavelengthPresets
// from current fringe.js lines 41-97. These stay here because they
// populate DOM elements in both the top bar (Settings dropdown) and
// are used by fringe-panel.js.

let WAVELENGTHS = [
  { id: "sodium", label: "Sodium (589 nm)",   nm: 589.0 },
  { id: "hene",   label: "HeNe (632.8 nm)",   nm: 632.8 },
  { id: "green",  label: "Green LED (532 nm)", nm: 532.0 },
];

function rebuildWavelengthSelect() { /* copy from current fringe.js:47-62 */ }
async function loadWavelengthPresets() { /* copy from current fringe.js:64-97 */ }

// ── Build workspace ─────────────────────────────────────────────────

function buildWorkspace() {
  if (fr.built) return;
  fr.built = true;

  const root = $("mode-fringe");
  if (!root) return;

  root.innerHTML = `
    <div class="fringe-workspace">
      <div class="fringe-preview-col">
        ${buildPanelHtml()}
      </div>
      <div class="fringe-results-col">
        ${buildResultsHtml()}
      </div>
    </div>
  `;

  wireEvents();
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents() {
  wirePanelEvents();
  wireResultsEvents();
  wireMeasureEvents();
  wireTopBarDropdowns();
}

// ── Top bar dropdown toggles ────────────────────────────────────────

function wireTopBarDropdowns() {
  // Settings dropdown
  const settingsBtn = $("btn-menu-fringe-settings");
  const settingsPanel = $("dropdown-fringe-settings");
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Close other dropdowns
      $("dropdown-fringe-export")?.setAttribute("hidden", "");
      settingsPanel.toggleAttribute("hidden");
    });
  }

  // Export dropdown
  const exportBtn = $("btn-menu-fringe-export");
  const exportPanel = $("dropdown-fringe-export");
  if (exportBtn && exportPanel) {
    exportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      $("dropdown-fringe-settings")?.setAttribute("hidden", "");
      exportPanel.toggleAttribute("hidden");
    });
  }

  // Close dropdowns when clicking outside
  document.addEventListener("click", () => {
    $("dropdown-fringe-settings")?.setAttribute("hidden", "");
    $("dropdown-fringe-export")?.setAttribute("hidden", "");
  });
}

// ── Public init ─────────────────────────────────────────────────────

export function initFringe() {
  buildWorkspace();
  loadWavelengthPresets();

  const observer = new MutationObserver(() => {
    const root = $("mode-fringe");
    if (!root) return;
    if (root.hidden) stopPolling();
    else startPolling();
  });
  const root = $("mode-fringe");
  if (root) observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}
```

- [ ] **Step 2: Remove any remaining dead code**

Search `fringe.js` for any functions that were moved to sub-modules but not yet removed. The file should only contain: `fr`, `$`, `WAVELENGTHS`, `rebuildWavelengthSelect`, `loadWavelengthPresets`, `buildWorkspace`, `wireEvents`, `wireTopBarDropdowns`, `initFringe`.

- [ ] **Step 3: Verify line count**

Run: `wc -l frontend/fringe*.js`

Expected approximate sizes:
- `fringe.js`: ~120-150 lines (coordinator)
- `fringe-panel.js`: ~500-600 lines (panel + capture workflow)
- `fringe-results.js`: ~900-1000 lines (rendering + tabs + export)
- `fringe-progress.js`: ~130 lines (SSE client)
- `fringe-measure.js`: ~350-400 lines (measurement tools)
- Total: ~2000-2300 lines (slightly less than original due to removed duplication)

- [ ] **Step 4: Full verification**

Run: `./server.sh restart`

Complete walkthrough:
1. Switch to Fringe mode — left panel shows preview, focus bar, analyze button, averaging, mask, drop zone
2. Top bar shows Settings and Export dropdowns (click each to verify they open)
3. Settings dropdown: change wavelength, adjust mask threshold, select reference standard
4. Click "Freeze & Analyze" — progress bar appears with stage labels
5. Results appear: summary bar with PV/RMS/Strehl
6. Subtraction pills visible between carrier row and tabs — click Power, Astig etc to toggle
7. All tabs work: Surface Map, 3D View, Zernike, Profiles, PSF/MTF, Diagnostics
8. Surface measurement tools work: cursor, Δh, profile, area
9. Carrier override: click FFT image in Diagnostics tab
10. Export: PDF Report and Zernike CSV from top bar dropdown
11. Averaging: Add to Avg, check log, Reset
12. Mask: Draw Mask, Add Hole, Clear
13. Invert Wavefront
14. Switch to Microscope mode and back — no errors, fringe-only items toggle correctly

- [ ] **Step 5: Run all backend tests**

Run: `.venv/bin/pytest tests/ -v`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/fringe.js
git commit -m "refactor: slim fringe.js to coordinator + wire top bar dropdowns

fringe.js now contains only state, init, wavelength presets, and
module wiring (~130 lines). All logic lives in fringe-panel.js,
fringe-results.js, fringe-progress.js, and fringe-measure.js.
Top bar Settings and Export dropdowns are wired."
```

---

## Summary

| Task | What | Approx lines |
|------|------|-------------|
| 1 | Backend SSE (progress callback + endpoint + tests) | ~120 new |
| 2 | modes.js fringe-only + top bar dropdowns | ~50 new |
| 3 | CSS (pills + progress bar) | ~80 new |
| 4 | Extract fringe-measure.js | ~350 extracted |
| 5 | Create fringe-progress.js (SSE client) | ~130 new |
| 6 | Create fringe-panel.js (left panel restructure) | ~550 extracted+modified |
| 7 | Create fringe-results.js (results + pills) | ~950 extracted+modified |
| 8 | Slim fringe.js coordinator + top bar wiring | ~130 remaining |
