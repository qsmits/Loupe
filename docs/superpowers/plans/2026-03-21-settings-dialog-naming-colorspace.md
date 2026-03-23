# Settings Dialog, Named Measurements & Color Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tabbed settings dialog (pixel format + crosshair color/opacity), editable measurement names in the sidebar, and rename BaumerCamera → AravisCamera.

**Architecture:** Backend gains `set_pixel_format()` threaded through `BaseCamera` → `AravisCamera`/`OpenCVCamera` → `CameraReader` → new API endpoint. Frontend gains a native `<dialog>` with Camera/Display tabs, inline name inputs on each measurement row, and a `state.settings` object driving crosshair rendering.

**Tech Stack:** Python 3.13, FastAPI, Aravis GI, pytest + httpx (TestClient), vanilla JS, native HTML `<dialog>`

**Note:** This project has no git history. Skip all commit steps.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/cameras/baumer.py` | Delete | — |
| `backend/cameras/aravis.py` | Create | AravisCamera — Aravis GI camera driver |
| `backend/cameras/base.py` | Modify | Add abstract `set_pixel_format()` |
| `backend/cameras/opencv.py` | Modify | No-op `set_pixel_format()`, add `pixel_format` to `get_info()` |
| `backend/cameras/__init__.py` | Modify | Update export |
| `backend/stream.py` | Modify | `CameraReader.set_pixel_format()` with thread stop/restart |
| `backend/api.py` | Modify | `PUT /camera/pixel-format`, extend `GET /camera/info` |
| `backend/main.py` | Modify | Import `AravisCamera`, `ARAVIS_AVAILABLE` |
| `tests/conftest.py` | Modify | Add `set_pixel_format()` no-op to `FakeCamera` |
| `tests/test_cameras.py` | Modify | Tests for `OpenCVCamera.set_pixel_format()` and `get_info()` `pixel_format` field |
| `tests/test_api.py` | Modify | Tests for `PUT /camera/pixel-format` and updated `GET /camera/info` |
| `frontend/index.html` | Modify | Add ⚙ toolbar button + `<dialog>` element with two tab panels |
| `frontend/style.css` | Modify | Dialog styles, tab styles, updated measurement row |
| `frontend/app.js` | Modify | `state.settings`, settings dialog JS, named measurements, updated `drawCrosshair()` |

---

## Task 1: Rename BaumerCamera → AravisCamera

**Files:**
- Create: `backend/cameras/aravis.py`
- Delete: `backend/cameras/baumer.py`
- Modify: `backend/cameras/__init__.py`
- Modify: `backend/main.py`

- [ ] **Step 1: Create `aravis.py` as a copy of `baumer.py` with renames applied**

  Copy the content of `backend/cameras/baumer.py` to `backend/cameras/aravis.py`. Make these changes:
  - Class name: `BaumerCamera` → `AravisCamera`
  - Export flag: `_ARAVIS_AVAILABLE` → `ARAVIS_AVAILABLE`
  - Update the class's `__init__` guard to reference `ARAVIS_AVAILABLE` internally

  The rest of the class body (open, close, get_frame, set_exposure, set_gain, get_info) is unchanged.

- [ ] **Step 2: Update `backend/cameras/__init__.py`**

  Current content just exports `BaseCamera`. No import of `BaumerCamera` exists here, so this file needs no change beyond verifying it doesn't reference `baumer`. Confirm and leave as-is.

- [ ] **Step 3: Update `backend/main.py` import**

  Change the single import line. Both the class name AND the flag name must change:

  ```python
  # Before:
  from .cameras.baumer import BaumerCamera, _ARAVIS_AVAILABLE

  # After:
  from .cameras.aravis import AravisCamera, ARAVIS_AVAILABLE
  ```

  Also update the two references in `create_app()`:
  ```python
  # Before:
  if _ARAVIS_AVAILABLE:
      camera = BaumerCamera()

  # After:
  if ARAVIS_AVAILABLE:
      camera = AravisCamera()
  ```

- [ ] **Step 4: Delete `backend/cameras/baumer.py`**

  ```bash
  rm backend/cameras/baumer.py
  ```

- [ ] **Step 5: Verify the server starts and run tests**

  ```bash
  .venv/bin/pytest tests/ -v
  ./server.sh restart && sleep 4 && curl -s http://localhost:8000/camera/info | python3 -m json.tool
  ```

  Note: on a machine with the real Aravis camera, `curl` will return `"model": "VCXU-32C"`. Without hardware, it falls back to `OpenCVCamera` and returns `"model": "OpenCV Camera"` — both are valid. Use the pytest output, not the curl model name, to verify the rename succeeded.

---

## Task 2: Add `set_pixel_format()` to BaseCamera, OpenCVCamera, FakeCamera

**Files:**
- Modify: `backend/cameras/base.py`
- Modify: `backend/cameras/opencv.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_cameras.py`

- [ ] **Step 1: Write failing tests for OpenCVCamera**

  Add to `tests/test_cameras.py`:

  ```python
  def test_opencv_camera_get_info_includes_pixel_format():
      mock_cap = MagicMock()
      mock_cap.isOpened.return_value = True
      mock_cap.get.side_effect = lambda prop: {3: 640.0, 4: 480.0}.get(prop, 0.0)

      with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
          cam = OpenCVCamera(index=0)
          cam.open()
          info = cam.get_info()

      assert "pixel_format" in info
      assert info["pixel_format"] == "n/a"


  def test_opencv_camera_set_pixel_format_is_noop():
      mock_cap = MagicMock()
      mock_cap.isOpened.return_value = True

      with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
          cam = OpenCVCamera(index=0)
          cam.open()
          cam.set_pixel_format("BayerRG8")  # must not raise
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd /Users/qsmits/Projects/MainDynamics/microscope
  .venv/bin/pytest tests/test_cameras.py::test_opencv_camera_get_info_includes_pixel_format tests/test_cameras.py::test_opencv_camera_set_pixel_format_is_noop -v
  ```

  Expected: FAIL — `set_pixel_format` is not defined.

- [ ] **Step 3: Add abstract method to `BaseCamera`**

  Add to `backend/cameras/base.py`:

  ```python
  @abstractmethod
  def set_pixel_format(self, fmt: str) -> None:
      """Set the pixel format (e.g. 'BayerRG8'). No-op on cameras that don't support it."""
  ```

- [ ] **Step 4: Implement in `OpenCVCamera`**

  Add to `backend/cameras/opencv.py`:

  ```python
  def set_pixel_format(self, fmt: str) -> None:
      pass  # OpenCV does not expose pixel format selection
  ```

  Also add `"pixel_format": "n/a"` to the dict returned by `get_info()`:

  ```python
  return {
      "model": "OpenCV Camera",
      "serial": f"index-{self._index}",
      "width": width,
      "height": height,
      "exposure": exposure,
      "gain": gain,
      "pixel_format": "n/a",
  }
  ```

- [ ] **Step 5: Add no-op to `FakeCamera` in `tests/conftest.py`**

  `FakeCamera` implements `BaseCamera`. Add:

  ```python
  def set_pixel_format(self, fmt: str) -> None:
      pass
  ```

  Also add `"pixel_format": "BayerRG8"` to `FakeCamera.get_info()` return dict.

- [ ] **Step 6: Run tests to confirm they pass**

  ```bash
  .venv/bin/pytest tests/test_cameras.py -v
  ```

  Expected: all PASS.

---

## Task 3: Add `set_pixel_format()` to AravisCamera + extend `get_info()`

**Files:**
- Modify: `backend/cameras/aravis.py`

No automated tests for `AravisCamera` — it requires real hardware. Manual verification via the running server after Task 5.

- [ ] **Step 1: Add `set_pixel_format()` to `AravisCamera`**

  Add the method after `set_gain()`. Validation is the API layer's responsibility; the camera method trusts its caller:

  ```python
  def set_pixel_format(self, fmt: str) -> None:
      self._cam.stop_acquisition()
      self._cam.get_device().set_string_feature_value("PixelFormat", fmt)
      # Re-push stream buffers — payload size may have changed
      payload = self._cam.get_payload()
      while self._stream.try_pop_buffer() is not None:
          pass  # drain old buffers
      for _ in range(10):
          self._stream.push_buffer(Aravis.Buffer.new_allocate(payload))
      self._cam.start_acquisition()
  ```

- [ ] **Step 2: Extend `get_info()` to include `pixel_format`**

  In `AravisCamera.get_info()`, add:

  ```python
  pixel_format = device.get_string_feature_value("PixelFormat")
  ```

  And include it in the returned dict:

  ```python
  return {
      "model": model,
      "serial": serial,
      "width": int(width),
      "height": int(height),
      "exposure": float(exposure),
      "gain": float(gain),
      "pixel_format": pixel_format,
  }
  ```

---

## Task 4: Add `CameraReader.set_pixel_format()` with thread coordination

**Files:**
- Modify: `backend/stream.py`

- [ ] **Step 1: Write failing tests**

  Add these imports at the **top of `tests/test_cameras.py`** (alongside the existing ones):

  ```python
  from backend.stream import CameraReader
  ```

  Then add the two test functions (append to the file):

  ```python
  def test_camera_reader_set_pixel_format_delegates():
      # Inline fake — do NOT import from tests/conftest.py (conftest is a pytest
      # plugin file, not a regular importable module; direct import will fail).
      class MinimalFake(BaseCamera):
          def open(self): pass
          def close(self): pass
          def get_frame(self): return np.zeros((480, 640, 3), dtype=np.uint8)
          def set_exposure(self, us): pass
          def set_gain(self, db): pass
          def get_info(self): return {}
          def set_pixel_format(self, fmt): pass

      reader = CameraReader(MinimalFake())
      reader.open()
      reader.set_pixel_format("Mono8")  # must not raise
      reader.close()


  def test_camera_reader_set_pixel_format_calls_inner_camera():
      inner = MagicMock(spec=["open", "close", "get_frame", "set_exposure",
                               "set_gain", "get_info", "set_pixel_format"])
      inner.get_frame.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
      reader = CameraReader(inner)
      reader.open()
      reader.set_pixel_format("Mono8")
      inner.set_pixel_format.assert_called_once_with("Mono8")
      reader.close()
  ```

  Note: `BaseCamera`, `np`, and `MagicMock` are already imported at the top of `test_cameras.py`.

- [ ] **Step 2: Run to confirm failure**

  ```bash
  .venv/bin/pytest tests/test_cameras.py::test_camera_reader_set_pixel_format_delegates tests/test_cameras.py::test_camera_reader_set_pixel_format_calls_inner_camera -v
  ```

  Expected: FAIL — `CameraReader` has no `set_pixel_format`.

- [ ] **Step 3: Implement `CameraReader.set_pixel_format()`**

  Add to `CameraReader` in `backend/stream.py`, after `set_gain()`:

  ```python
  def set_pixel_format(self, fmt: str) -> None:
      # Stop the reader thread so no concurrent get_frame() calls race
      # against the Aravis stream restart inside set_pixel_format().
      self._stop.set()
      if self._thread is not None:
          self._thread.join(timeout=2)
          if self._thread.is_alive():
              raise RuntimeError(
                  "Reader thread did not stop within 2 s; aborting pixel format change."
              )
      # Delegate to the inner camera (thread is stopped — safe).
      self._camera.set_pixel_format(fmt)
      # Restart the reader thread.
      # Note: _run() will start calling get_frame() immediately. AravisCamera's
      # set_pixel_format() ensures start_acquisition() completes before returning,
      # so by the time we reach here the camera is ready. No additional delay needed.
      self._stop.clear()
      self._thread = threading.Thread(target=self._run, daemon=True)
      self._thread.start()
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  .venv/bin/pytest tests/test_cameras.py -v
  ```

  Expected: all PASS.

---

## Task 5: API endpoint `PUT /camera/pixel-format` + extend `GET /camera/info`

**Files:**
- Modify: `backend/api.py`
- Modify: `tests/test_api.py`

- [ ] **Step 1: Write failing tests**

  Add to `tests/test_api.py`:

  ```python
  def test_camera_info_includes_pixel_format(client):
      r = client.get("/camera/info")
      assert r.status_code == 200
      assert "pixel_format" in r.json()


  def test_set_pixel_format(client):
      r = client.put("/camera/pixel-format", json={"pixel_format": "BayerRG8"})
      assert r.status_code == 200
      assert r.json() == {"ok": True}


  def test_set_pixel_format_invalid(client):
      r = client.put("/camera/pixel-format", json={"pixel_format": "NotAFormat"})
      assert r.status_code == 400
  ```

- [ ] **Step 2: Run to confirm failure**

  ```bash
  .venv/bin/pytest tests/test_api.py::test_camera_info_includes_pixel_format tests/test_api.py::test_set_pixel_format tests/test_api.py::test_set_pixel_format_invalid -v
  ```

  Expected: FAIL — endpoint does not exist, `pixel_format` missing from info.

- [ ] **Step 3: Add `PixelFormatBody` model and endpoint to `api.py`**

  Add the Pydantic model near the other body models at the top of `make_router()`:

  ```python
  class PixelFormatBody(BaseModel):
      pixel_format: str
  ```

  Add a module-level constant near the top of `backend/api.py` (no import from aravis needed — this is the validation set and is always present regardless of camera driver):

  ```python
  _SUPPORTED_PIXEL_FORMATS = frozenset({"BayerRG8", "Mono8", "BGR8Packed", "RGB8Packed"})
  ```

  Add the endpoint inside `make_router()`:

  ```python
  @router.put("/camera/pixel-format")
  async def set_pixel_format(body: PixelFormatBody):
      if body.pixel_format not in _SUPPORTED_PIXEL_FORMATS:
          raise HTTPException(status_code=400, detail=f"Unsupported format: {body.pixel_format}")
      camera.set_pixel_format(body.pixel_format)
      return {"ok": True}
  ```

  Note: `camera` here is the `CameraReader` passed into `make_router()`. `CameraReader` now has `set_pixel_format()` from Task 4.

  `GET /camera/info` requires no change — it calls `camera.get_info()` which now returns `pixel_format` via `FakeCamera` (tests) and `AravisCamera` (production).

- [ ] **Step 4: Run all tests**

  ```bash
  .venv/bin/pytest tests/ -v
  ```

  Expected: all PASS.

- [ ] **Step 5: Manual verify on running server**

  ```bash
  ./server.sh restart && sleep 4
  curl -s http://localhost:8000/camera/info | python3 -m json.tool
  curl -s -X PUT http://localhost:8000/camera/pixel-format \
    -H "Content-Type: application/json" \
    -d '{"pixel_format":"Mono8"}' | python3 -m json.tool
  ```

  Expected: `get_info` shows `pixel_format` field; PUT returns `{"ok": true}`.

---

## Task 6: Named Measurements (Frontend)

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/style.css`

No automated tests for frontend JS. Verify manually in the browser.

- [ ] **Step 1: Add `name` field to `addAnnotation()`**

  In `app.js`, change `addAnnotation()`:

  ```js
  function addAnnotation(data) {
    const ann = { ...data, id: state.nextId++, name: data.name ?? "" };
    state.annotations.push(ann);
    state.selected = ann.id;
    renderSidebar();
  }
  ```

- [ ] **Step 2: Update `renderSidebar()` to show name input**

  Replace the current `renderSidebar()` function:

  ```js
  function renderSidebar() {
    listEl.innerHTML = "";
    let i = 0;
    state.annotations.forEach(ann => {
      if (ann.type === "detected-edges" || ann.type === "detected-circles") return;
      const number = String.fromCodePoint(9312 + i);
      i++;
      const row = document.createElement("div");
      row.className = "measurement-item" + (ann.id === state.selected ? " selected" : "");
      row.innerHTML = `
        <span class="measurement-number">${number}</span>
        <input class="measurement-name" type="text" value="${ann.name}" placeholder="Label…">
        <span class="measurement-value">${measurementLabel(ann)}</span>
        <button class="del-btn" data-id="${ann.id}">✕</button>`;
      row.querySelector(".measurement-name").addEventListener("input", e => {
        ann.name = e.target.value;
      });
      row.querySelector(".del-btn").addEventListener("click", e => {
        e.stopPropagation();
        state.annotations = state.annotations.filter(a => a.id !== ann.id);
        if (state.selected === ann.id) state.selected = null;
        renderSidebar();
        redraw();
      });
      row.addEventListener("click", () => {
        state.selected = ann.id;
        renderSidebar();
        redraw();
      });
      listEl.appendChild(row);
    });
  }
  ```

- [ ] **Step 3: Update CSS for new measurement row layout**

  In `frontend/style.css`, update `.measurement-item` to use flex layout accommodating the new elements. Add:

  ```css
  .measurement-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
  }

  .measurement-number {
    flex-shrink: 0;
    font-size: 13px;
  }

  .measurement-name {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    color: inherit;
    font-size: 12px;
    padding: 1px 2px;
    outline: none;
  }

  .measurement-name:focus {
    border-bottom-color: var(--accent, #60a5fa);
  }

  .measurement-name::placeholder {
    color: var(--muted, #6b7280);
  }

  .measurement-value {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--muted, #6b7280);
    white-space: nowrap;
  }
  ```

  Remove or update any existing `.measurement-item span` styles that conflict.

- [ ] **Step 4: Manual verify**

  Reload the browser. Place a distance annotation. Confirm:
  - Sidebar shows: ① [empty input with "Label…" placeholder] [distance value] [✕]
  - Typing in the input updates `ann.name` (check in console: `state.annotations[0].name`)
  - Canvas still shows only ①

---

## Task 7: Settings Dialog — HTML Structure

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/style.css`

- [ ] **Step 1: Add ⚙ toolbar button to `index.html`**

  In the toolbar div, add after the crosshair button:

  ```html
  <button class="tool-btn icon" id="btn-settings" title="Settings">⚙</button>
  ```

- [ ] **Step 2: Add `<dialog>` element to `index.html`**

  Add before the closing `</body>` tag (before the `<script>` tag):

  ```html
  <dialog id="settings-dialog">
    <div id="settings-header">
      <div id="settings-tabs">
        <button class="settings-tab active" data-tab="camera">Camera</button>
        <button class="settings-tab" data-tab="display">Display</button>
      </div>
      <button id="settings-close">✕</button>
    </div>

    <div id="settings-camera-panel" class="settings-panel">
      <div class="settings-row">
        <label for="pixel-format-select">Pixel format</label>
        <select id="pixel-format-select">
          <option value="BayerRG8">BayerRG8</option>
          <option value="Mono8">Mono8</option>
          <option value="BGR8Packed">BGR8Packed</option>
          <option value="RGB8Packed">RGB8Packed</option>
        </select>
      </div>
      <div class="settings-row settings-info">
        <span class="settings-label">Model</span>
        <span id="settings-model">—</span>
      </div>
      <div class="settings-row settings-info">
        <span class="settings-label">Serial</span>
        <span id="settings-serial">—</span>
      </div>
    </div>

    <div id="settings-display-panel" class="settings-panel" style="display:none">
      <div class="settings-row">
        <label>Crosshair color</label>
        <div id="crosshair-swatches">
          <button class="swatch active" data-color="#ffffff" style="background:#ffffff" title="White"></button>
          <button class="swatch" data-color="#ef4444" style="background:#ef4444" title="Red"></button>
          <button class="swatch" data-color="#22c55e" style="background:#22c55e" title="Green"></button>
          <button class="swatch" data-color="#facc15" style="background:#facc15" title="Yellow"></button>
          <button class="swatch" data-color="#22d3ee" style="background:#22d3ee" title="Cyan"></button>
        </div>
      </div>
      <div class="settings-row">
        <label for="crosshair-opacity">Opacity</label>
        <input type="range" id="crosshair-opacity" min="0" max="100" value="40">
        <span id="crosshair-opacity-value">40%</span>
      </div>
    </div>

    <div id="settings-status"></div>
  </dialog>
  ```

- [ ] **Step 3: Add dialog CSS to `style.css`**

  ```css
  #settings-dialog {
    width: 360px;
    background: var(--surface, #1e1e2e);
    color: var(--text, #e2e8f0);
    border: 1px solid var(--border, #333);
    border-radius: 8px;
    padding: 0;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }

  #settings-dialog::backdrop {
    background: rgba(0,0,0,0.4);
  }

  #settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border, #333);
  }

  #settings-tabs {
    display: flex;
    gap: 4px;
  }

  .settings-tab {
    background: none;
    border: none;
    color: var(--muted, #6b7280);
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 13px;
  }

  .settings-tab.active {
    background: var(--accent-muted, #1e3a5f);
    color: var(--accent, #60a5fa);
  }

  #settings-close {
    background: none;
    border: none;
    color: var(--muted, #6b7280);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
  }

  .settings-panel {
    padding: 14px 16px;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
    font-size: 13px;
  }

  .settings-row label,
  .settings-row .settings-label {
    width: 100px;
    flex-shrink: 0;
    color: var(--muted, #6b7280);
    font-size: 12px;
  }

  .settings-row select {
    flex: 1;
    background: var(--surface2, #2a2a3e);
    color: var(--text, #e2e8f0);
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
  }

  .settings-info span:last-child {
    color: var(--text, #e2e8f0);
    font-size: 12px;
  }

  #crosshair-swatches {
    display: flex;
    gap: 8px;
  }

  .swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }

  .swatch.active {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }

  #crosshair-opacity {
    flex: 1;
    accent-color: var(--accent, #60a5fa);
  }

  #settings-status {
    padding: 6px 16px 10px;
    font-size: 11px;
    color: var(--muted, #6b7280);
    min-height: 22px;
  }
  ```

---

## Task 8: Settings Dialog — JavaScript Logic

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add `state.settings` and update `drawCrosshair()`**

  At the top of `app.js`, extend the `state` object:

  ```js
  const state = {
    tool: "select",
    frozen: false,
    crosshair: false,
    calibration: null,
    annotations: [],
    selected: null,
    pendingPoints: [],
    dragState: null,
    nextId: 1,
    settings: {
      crosshairColor: "#ffffff",
      crosshairOpacity: 0.4,
      pixelFormat: "BayerRG8",
    },
  };
  ```

  Replace `drawCrosshair()` with:

  ```js
  function drawCrosshair() {
    if (!state.crosshair) return;
    const { crosshairColor, crosshairOpacity } = state.settings;
    const r = parseInt(crosshairColor.slice(1, 3), 16);
    const g = parseInt(crosshairColor.slice(3, 5), 16);
    const b = parseInt(crosshairColor.slice(5, 7), 16);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    ctx.strokeStyle = `rgba(${r},${g},${b},${crosshairOpacity})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
    ctx.setLineDash([]);
  }
  ```

- [ ] **Step 2: Update `loadCameraInfo()` to populate dialog fields**

  In the existing `loadCameraInfo()` function, after setting the slider values, add:

  ```js
  // Populate settings dialog camera info
  const modelEl = document.getElementById("settings-model");
  const serialEl = document.getElementById("settings-serial");
  if (modelEl) modelEl.textContent = d.model;
  if (serialEl) serialEl.textContent = d.serial;

  // Pixel format: initialise dropdown and state
  const fmtSelect = document.getElementById("pixel-format-select");
  if (fmtSelect) {
    const fmt = d.pixel_format && d.pixel_format !== "n/a" ? d.pixel_format : null;
    if (fmt) {
      fmtSelect.value = fmt;
      state.settings.pixelFormat = fmt;
    } else {
      fmtSelect.disabled = true;  // OpenCV fallback — format not configurable
    }
  }
  ```

- [ ] **Step 3: Wire up the ⚙ button, dialog open/close, and tab switching**

  Add to `app.js`:

  ```js
  // ── Settings dialog ────────────────────────────────────────────────────────
  const settingsDialog = document.getElementById("settings-dialog");

  document.getElementById("btn-settings").addEventListener("click", () => {
    settingsDialog.showModal();
  });

  document.getElementById("settings-close").addEventListener("click", () => {
    settingsDialog.close();
  });

  // Backdrop click: close only when clicking outside dialog content
  settingsDialog.addEventListener("click", e => {
    if (e.target === settingsDialog) settingsDialog.close();
  });

  // Tab switching
  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".settings-panel").forEach(p => p.style.display = "none");
      tab.classList.add("active");
      document.getElementById(`settings-${tab.dataset.tab}-panel`).style.display = "block";
    });
  });
  ```

- [ ] **Step 4: Wire up crosshair color swatches and opacity slider**

  ```js
  // Crosshair swatches
  document.querySelectorAll(".swatch").forEach(swatch => {
    swatch.addEventListener("click", () => {
      document.querySelectorAll(".swatch").forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
      state.settings.crosshairColor = swatch.dataset.color;
      redraw();
    });
  });

  // Crosshair opacity
  document.getElementById("crosshair-opacity").addEventListener("input", e => {
    const pct = parseInt(e.target.value);
    document.getElementById("crosshair-opacity-value").textContent = `${pct}%`;
    state.settings.crosshairOpacity = pct / 100;
    redraw();
  });
  ```

- [ ] **Step 5: Wire up pixel format dropdown**

  ```js
  // Pixel format select
  document.getElementById("pixel-format-select").addEventListener("change", async e => {
    const fmt = e.target.value;
    const prev = state.settings.pixelFormat;
    const statusEl = document.getElementById("settings-status");
    statusEl.textContent = "Applying…";
    try {
      const r = await fetch("/camera/pixel-format", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pixel_format: fmt }),
      });
      if (!r.ok) throw new Error(await r.text());
      state.settings.pixelFormat = fmt;
      statusEl.textContent = "Done";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      e.target.value = prev;  // revert dropdown
    }
  });
  ```

- [ ] **Step 6: Manual verify in browser**

  Reload the browser. Verify:
  1. ⚙ button opens the dialog
  2. Camera tab shows model, serial, pixel format dropdown populated from `/camera/info`
  3. Display tab shows color swatches and opacity slider
  4. Changing swatch color updates crosshair color immediately
  5. Changing opacity slider updates crosshair opacity immediately
  6. Clicking backdrop closes dialog
  7. Changing pixel format sends PUT request (check Network tab in DevTools) and shows "Done"

---

## Task 9: Run Full Test Suite

- [ ] **Step 1: Run all tests**

  ```bash
  cd /Users/qsmits/Projects/MainDynamics/microscope
  .venv/bin/pytest tests/ -v
  ```

  Expected: all PASS.

- [ ] **Step 2: Restart server and smoke-test key endpoints**

  ```bash
  ./server.sh restart && sleep 4
  curl -s http://localhost:8000/camera/info | python3 -m json.tool
  curl -s -X PUT http://localhost:8000/camera/pixel-format \
    -H "Content-Type: application/json" \
    -d '{"pixel_format":"BayerRG8"}' | python3 -m json.tool
  curl -s -X PUT http://localhost:8000/camera/pixel-format \
    -H "Content-Type: application/json" \
    -d '{"pixel_format":"NotAFormat"}' | python3 -m json.tool
  ```

  Expected:
  - `camera/info` returns `pixel_format` field
  - Valid format PUT returns `{"ok": true}`
  - Invalid format PUT returns 400 with detail message
