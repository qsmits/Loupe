# White Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hardware white balance control (Auto WB button + R/G/B ratio sliders) to the microscope via the camera's GenICam interface.

**Architecture:** Three new methods (`get_white_balance`, `set_white_balance_auto`, `set_white_balance_ratio`) are threaded through `BaseCamera` → `AravisCamera` / `OpenCVCamera` → `CameraReader` → two new API endpoints. The existing settings dialog Camera tab gains an Auto WB button and three range sliders initialised from `/camera/info`.

**Tech Stack:** Python 3.13, FastAPI, Aravis GI (`gi.repository.Aravis`), pytest + httpx (TestClient), vanilla JS

**Note:** This project has no git history. Skip all commit steps.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/cameras/base.py` | Modify | Add 3 abstract white balance methods |
| `backend/cameras/aravis.py` | Modify | Real GenICam implementation; add `import time` |
| `backend/cameras/opencv.py` | Modify | No-op implementations |
| `backend/stream.py` | Modify | `_wb_lock`; 3 delegation methods on `CameraReader` |
| `backend/api.py` | Modify | Validation constants; `WhiteBalanceRatioBody`; extend `/camera/info`; `POST /camera/white-balance/auto`; `PUT /camera/white-balance/ratio`; add `import asyncio` |
| `tests/conftest.py` | Modify | `FakeCamera`: 3 stub methods; `get_info()` gains `wb_*` fields |
| `tests/test_cameras.py` | Modify | `OpenCVCamera` no-ops; `CameraReader` delegation |
| `tests/test_api.py` | Modify | New endpoints; extended `/camera/info` |
| `frontend/index.html` | Modify | White balance rows in Camera tab |
| `frontend/app.js` | Modify | WB init, Auto WB handler, debounced slider handlers |

---

## Task 1: BaseCamera + OpenCVCamera + FakeCamera white balance methods

**Files:**
- Modify: `backend/cameras/base.py`
- Modify: `backend/cameras/opencv.py`
- Modify: `tests/conftest.py`
- Test: `tests/test_cameras.py`

- [ ] **Step 1: Write failing tests**

  Add to `tests/test_cameras.py`:

  ```python
  def test_opencv_camera_get_white_balance_returns_ones():
      mock_cap = MagicMock()
      mock_cap.isOpened.return_value = True

      with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
          cam = OpenCVCamera(index=0)
          cam.open()
          wb = cam.get_white_balance()

      assert wb == {"red": 1.0, "green": 1.0, "blue": 1.0}


  def test_opencv_camera_set_white_balance_ratio_is_noop():
      mock_cap = MagicMock()
      mock_cap.isOpened.return_value = True

      with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
          cam = OpenCVCamera(index=0)
          cam.open()
          cam.set_white_balance_ratio("Red", 1.5)  # must not raise


  def test_opencv_camera_set_white_balance_auto_returns_ones():
      mock_cap = MagicMock()
      mock_cap.isOpened.return_value = True

      with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
          cam = OpenCVCamera(index=0)
          cam.open()
          result = cam.set_white_balance_auto()

      assert result == {"red": 1.0, "green": 1.0, "blue": 1.0}
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd /Users/qsmits/Projects/MainDynamics/microscope
  .venv/bin/pytest tests/test_cameras.py::test_opencv_camera_get_white_balance_returns_ones tests/test_cameras.py::test_opencv_camera_set_white_balance_ratio_is_noop tests/test_cameras.py::test_opencv_camera_set_white_balance_auto_returns_ones -v
  ```

  Expected: FAIL — `OpenCVCamera` has no `get_white_balance`.

- [ ] **Step 3: Add abstract methods to `BaseCamera`**

  Append to `backend/cameras/base.py` (after `set_pixel_format`):

  ```python
      @abstractmethod
      def get_white_balance(self) -> dict[str, float]:
          """Return white balance ratios as {"red": float, "green": float, "blue": float}."""

      @abstractmethod
      def set_white_balance_auto(self) -> dict[str, float]:
          """Trigger auto white balance once. Return updated ratios."""

      @abstractmethod
      def set_white_balance_ratio(self, channel: str, value: float) -> None:
          """Set white balance ratio for channel ('Red', 'Green', or 'Blue')."""
  ```

  Also update the `get_info` docstring to mention the new `wb_red/green/blue` fields:
  ```python
      @abstractmethod
      def get_info(self) -> dict[str, object]:
          """Return dict with keys: model, serial, width, height, exposure, gain, pixel_format, wb_red, wb_green, wb_blue."""
  ```

- [ ] **Step 4: Implement no-ops in `OpenCVCamera`**

  Append to `backend/cameras/opencv.py` (after `set_pixel_format`):

  ```python
      def get_white_balance(self) -> dict[str, float]:
          return {"red": 1.0, "green": 1.0, "blue": 1.0}

      def set_white_balance_auto(self) -> dict[str, float]:
          return {"red": 1.0, "green": 1.0, "blue": 1.0}

      def set_white_balance_ratio(self, channel: str, value: float) -> None:
          pass  # OpenCV does not support hardware white balance
  ```

  Also extend `get_info()` to add `wb_red`, `wb_green`, `wb_blue` to the returned dict:

  ```python
      def get_info(self) -> dict[str, object]:
          width = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) if self._cap is not None else 0
          height = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) if self._cap is not None else 0
          exposure = self._cap.get(cv2.CAP_PROP_EXPOSURE) if self._cap is not None else 0.0
          gain = self._cap.get(cv2.CAP_PROP_GAIN) if self._cap is not None else 0.0
          return {
              "model": "OpenCV Camera",
              "serial": f"index-{self._index}",
              "width": width,
              "height": height,
              "exposure": exposure,
              "gain": gain,
              "pixel_format": "n/a",
              "wb_red": 1.0,
              "wb_green": 1.0,
              "wb_blue": 1.0,
          }
  ```

- [ ] **Step 5: Add stubs to `FakeCamera` in `tests/conftest.py`**

  Add three methods to `FakeCamera`:

  ```python
      def get_white_balance(self) -> dict[str, float]:
          return {"red": 1.0, "green": 1.0, "blue": 1.0}

      def set_white_balance_auto(self) -> dict[str, float]:
          return {"red": 1.0, "green": 1.0, "blue": 1.0}

      def set_white_balance_ratio(self, channel: str, value: float) -> None:
          pass
  ```

  Also extend `FakeCamera.get_info()` return dict:

  ```python
      def get_info(self) -> dict[str, object]:
          return {
              "model": "FakeCamera",
              "serial": "FAKE-001",
              "width": 640,
              "height": 480,
              "exposure": 5000.0,
              "gain": 0.0,
              "pixel_format": "BayerRG8",
              "wb_red": 1.0,
              "wb_green": 1.0,
              "wb_blue": 1.0,
          }
  ```

- [ ] **Step 6: Run tests to confirm they pass**

  ```bash
  .venv/bin/pytest tests/test_cameras.py -v
  ```

  Expected: all PASS.

---

## Task 2: CameraReader white balance delegation

**Files:**
- Modify: `backend/stream.py`
- Test: `tests/test_cameras.py`

- [ ] **Step 1: Write failing tests**

  Add to `tests/test_cameras.py`:

  ```python
  def test_camera_reader_delegates_white_balance_methods():
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
          def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
          def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
          def set_white_balance_ratio(self, channel, value): pass

      reader = CameraReader(MinimalFake())
      reader.open()
      wb = reader.get_white_balance()          # must not raise
      reader.set_white_balance_ratio("Red", 1.2)  # must not raise
      reader.close()
      assert wb == {"red": 1.0, "green": 1.0, "blue": 1.0}


  def test_camera_reader_wb_ratio_calls_inner_camera():
      inner = MagicMock(spec=["open", "close", "get_frame", "set_exposure",
                               "set_gain", "get_info", "set_pixel_format",
                               "get_white_balance", "set_white_balance_auto",
                               "set_white_balance_ratio"])
      inner.get_frame.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
      reader = CameraReader(inner)
      reader.open()
      reader.set_white_balance_ratio("Blue", 0.9)
      inner.set_white_balance_ratio.assert_called_once_with("Blue", 0.9)
      reader.close()
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  .venv/bin/pytest tests/test_cameras.py::test_camera_reader_delegates_white_balance_methods tests/test_cameras.py::test_camera_reader_wb_ratio_calls_inner_camera -v
  ```

  Expected: FAIL — `CameraReader` has no `get_white_balance`.

- [ ] **Step 3: Implement in `CameraReader`**

  In `backend/stream.py`, add `_wb_lock` to `__init__` and three delegation methods.

  In `CameraReader.__init__`, after `self._format_lock = threading.Lock()`, add:

  ```python
          self._wb_lock = threading.Lock()
  ```

  After `get_info()`, add the three delegation methods:

  ```python
      def get_white_balance(self) -> dict[str, float]:
          with self._wb_lock:
              return self._camera.get_white_balance()

      def set_white_balance_auto(self) -> dict[str, float]:
          # Blocking (up to ~1 s polling) — call via asyncio.to_thread in the API layer.
          with self._wb_lock:
              return self._camera.set_white_balance_auto()

      def set_white_balance_ratio(self, channel: str, value: float) -> None:
          with self._wb_lock:
              return self._camera.set_white_balance_ratio(channel, value)
  ```

- [ ] **Step 4: Run all camera tests**

  ```bash
  .venv/bin/pytest tests/test_cameras.py -v
  ```

  Expected: all PASS.

---

## Task 3: AravisCamera white balance implementation

**Files:**
- Modify: `backend/cameras/aravis.py`

No automated tests — requires real hardware. Manual verification after Task 4 via the running server.

- [ ] **Step 1: Add `import time` to `backend/cameras/aravis.py`**

  The file currently starts with `import numpy as np`. Add `import time` after it:

  ```python
  import time
  import numpy as np
  from .base import BaseCamera
  ```

- [ ] **Step 2: Add `get_white_balance()` to `AravisCamera`**

  Append after `get_info()` in `backend/cameras/aravis.py`:

  ```python
      def get_white_balance(self) -> dict[str, float]:
          if self._cam is None:
              raise RuntimeError("Camera not open")
          device = self._cam.get_device()
          result = {}
          for ch in ("Red", "Green", "Blue"):
              device.set_string_feature_value("BalanceRatioSelector", ch)
              result[ch.lower()] = float(device.get_float_feature_value("BalanceRatio"))
          return result
  ```

- [ ] **Step 3: Add `set_white_balance_auto()` to `AravisCamera`**

  Append after `get_white_balance()`:

  ```python
      def set_white_balance_auto(self) -> dict[str, float]:
          if self._cam is None:
              raise RuntimeError("Camera not open")
          import logging
          device = self._cam.get_device()
          device.set_string_feature_value("BalanceWhiteAuto", "Once")
          for _ in range(20):
              time.sleep(0.05)
              if device.get_string_feature_value("BalanceWhiteAuto") == "Off":
                  break
          else:
              logging.getLogger(__name__).warning(
                  "BalanceWhiteAuto did not return to 'Off' within 1 s"
              )
          return self.get_white_balance()
  ```

  Note: the `for/else` construct means the `else` block only runs if the loop exhausted all 20 iterations without hitting `break` (i.e. the camera never confirmed completion). On timeout the method logs a warning and still returns the current ratios — it does not raise.

- [ ] **Step 4: Add `set_white_balance_ratio()` to `AravisCamera`**

  Append after `set_white_balance_auto()`:

  ```python
      def set_white_balance_ratio(self, channel: str, value: float) -> None:
          if self._cam is None:
              raise RuntimeError("Camera not open")
          device = self._cam.get_device()
          device.set_string_feature_value("BalanceRatioSelector", channel)
          device.set_float_feature_value("BalanceRatio", value)
  ```

- [ ] **Step 5: Extend `get_info()` to include white balance ratios**

  In `AravisCamera.get_info()`, the method currently returns a dict with `pixel_format` as the last key. Extend it to call `get_white_balance()` and merge the results:

  ```python
      def get_info(self) -> dict[str, object]:
          if self._cam is None:
              raise RuntimeError("Camera not open")
          device = self._cam.get_device()
          width = int(device.get_integer_feature_value("Width"))
          height = int(device.get_integer_feature_value("Height"))
          exposure = self._cam.get_exposure_time()
          gain = self._cam.get_gain()
          model = device.get_string_feature_value("DeviceModelName")
          serial = device.get_string_feature_value("DeviceSerialNumber")
          pixel_format = str(device.get_string_feature_value("PixelFormat"))
          wb = self.get_white_balance()
          return {
              "model": model,
              "serial": serial,
              "width": int(width),
              "height": int(height),
              "exposure": float(exposure),
              "gain": float(gain),
              "pixel_format": pixel_format,
              "wb_red": wb["red"],
              "wb_green": wb["green"],
              "wb_blue": wb["blue"],
          }
  ```

- [ ] **Step 6: Run full test suite to confirm nothing broken**

  ```bash
  .venv/bin/pytest tests/ -v
  ```

  Expected: all PASS (AravisCamera tests are skipped — no hardware needed).

---

## Task 4: API endpoints

**Files:**
- Modify: `backend/api.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write failing tests**

  Add to `tests/test_api.py`:

  ```python
  def test_camera_info_includes_wb_fields(client):
      r = client.get("/camera/info")
      assert r.status_code == 200
      data = r.json()
      assert "wb_red" in data
      assert "wb_green" in data
      assert "wb_blue" in data
      assert isinstance(data["wb_red"], float)


  def test_auto_white_balance(client):
      r = client.post("/camera/white-balance/auto")
      assert r.status_code == 200
      data = r.json()
      assert "red" in data
      assert "green" in data
      assert "blue" in data


  def test_set_white_balance_ratio(client):
      r = client.put("/camera/white-balance/ratio",
                     json={"channel": "Red", "value": 1.2})
      assert r.status_code == 200
      assert r.json() == {"ok": True}


  def test_set_white_balance_ratio_invalid_channel(client):
      r = client.put("/camera/white-balance/ratio",
                     json={"channel": "Ultraviolet", "value": 1.0})
      assert r.status_code == 400


  def test_set_white_balance_ratio_out_of_range(client):
      r = client.put("/camera/white-balance/ratio",
                     json={"channel": "Red", "value": 99.0})
      assert r.status_code == 400
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  .venv/bin/pytest tests/test_api.py::test_camera_info_includes_wb_fields tests/test_api.py::test_auto_white_balance tests/test_api.py::test_set_white_balance_ratio tests/test_api.py::test_set_white_balance_ratio_invalid_channel tests/test_api.py::test_set_white_balance_ratio_out_of_range -v
  ```

  Expected: FAIL — endpoints do not exist; `wb_*` fields missing from info.

- [ ] **Step 3: Add `import asyncio` to `backend/api.py`**

  The file currently starts with `import datetime`. Add `import asyncio` after it:

  ```python
  import asyncio
  import datetime
  import pathlib
  ```

- [ ] **Step 4: Add validation constants and body model to `backend/api.py`**

  After `_SUPPORTED_PIXEL_FORMATS`, add:

  ```python
  _VALID_WB_CHANNELS = frozenset({"Red", "Green", "Blue"})
  WB_RATIO_MIN = 0.5
  WB_RATIO_MAX = 2.5
  ```

  After `PixelFormatBody`, add:

  ```python
  class WhiteBalanceRatioBody(BaseModel):
      channel: str
      value: float
  ```

- [ ] **Step 5: Extend `GET /camera/info` to include wb fields**

  The current `/camera/info` endpoint simply returns `camera.get_info()`. Since `FakeCamera.get_info()` (and `OpenCVCamera.get_info()` and `AravisCamera.get_info()`) now all include `wb_red/green/blue`, no change to the endpoint itself is needed. The test will pass once `FakeCamera.get_info()` was updated in Task 1.

  Verify the existing endpoint code in `make_router()`:

  ```python
  @router.get("/camera/info")
  async def camera_info():
      return camera.get_info()
  ```

  This is already correct — no changes needed here.

- [ ] **Step 6: Add `POST /camera/white-balance/auto` endpoint**

  Inside `make_router()`, after the `PUT /camera/pixel-format` endpoint, add:

  ```python
      @router.post("/camera/white-balance/auto")
      async def auto_white_balance():
          try:
              ratios = await asyncio.to_thread(camera.set_white_balance_auto)
          except Exception as e:
              raise HTTPException(status_code=400, detail=str(e))
          return ratios
  ```

  Note: `asyncio.to_thread` is used because `set_white_balance_auto` blocks for up to 1 s while polling the camera. Running it directly in the async route would stall the entire FastAPI event loop.

- [ ] **Step 7: Add `PUT /camera/white-balance/ratio` endpoint**

  Inside `make_router()`, after the auto endpoint, add:

  ```python
      @router.put("/camera/white-balance/ratio")
      async def set_wb_ratio(body: WhiteBalanceRatioBody):
          if body.channel not in _VALID_WB_CHANNELS:
              raise HTTPException(status_code=400,
                  detail=f"Invalid channel: {body.channel}")
          if not (WB_RATIO_MIN <= body.value <= WB_RATIO_MAX):
              raise HTTPException(status_code=400,
                  detail=f"Value must be between {WB_RATIO_MIN} and {WB_RATIO_MAX}")
          try:
              camera.set_white_balance_ratio(body.channel, body.value)
          except Exception as e:
              raise HTTPException(status_code=400, detail=str(e))
          return {"ok": True}
  ```

- [ ] **Step 8: Run all tests**

  ```bash
  .venv/bin/pytest tests/ -v
  ```

  Expected: all PASS.

---

## Task 5: Frontend — HTML + JavaScript

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

No automated tests for the frontend. Verify manually in the browser after the server is restarted.

- [ ] **Step 1: Add white balance rows to `frontend/index.html`**

  In `frontend/index.html`, find the Camera panel inside `#settings-camera-panel`. It currently has a pixel format `<select>` row at the top, followed by Model and Serial info rows. Add the following four rows **below the pixel format row** (after the pixel-format `<div class="settings-row">` block and before the Model row):

  ```html
      <div class="settings-row">
        <label>White balance</label>
        <button id="btn-wb-auto" class="tool-btn" style="font-size:11px;padding:3px 8px">Auto WB</button>
      </div>
      <div class="settings-row">
        <label for="wb-red-slider">R</label>
        <input type="range" id="wb-red-slider" min="0.5" max="2.5" step="0.01" value="1.0">
        <span id="wb-red-value">1.00</span>
      </div>
      <div class="settings-row">
        <label for="wb-green-slider">G</label>
        <input type="range" id="wb-green-slider" min="0.5" max="2.5" step="0.01" value="1.0">
        <span id="wb-green-value">1.00</span>
      </div>
      <div class="settings-row">
        <label for="wb-blue-slider">B</label>
        <input type="range" id="wb-blue-slider" min="0.5" max="2.5" step="0.01" value="1.0">
        <span id="wb-blue-value">1.00</span>
      </div>
  ```

- [ ] **Step 2: Add WB initialisation to `loadCameraInfo()` in `frontend/app.js`**

  In `app.js`, find `loadCameraInfo()`. It currently ends with the pixel format init block (which sets `fmtSelect.disabled = true` on OpenCV fallback). After that block, still inside the `try { ... }` block, add:

  ```js
      // White balance — initialise sliders and enable/disable based on availability
      const wbAvailable = d.pixel_format && d.pixel_format !== "n/a";
      ["red", "green", "blue"].forEach(ch => {
        const slider = document.getElementById(`wb-${ch}-slider`);
        const display = document.getElementById(`wb-${ch}-value`);
        if (slider) {
          slider.value = d[`wb_${ch}`] ?? 1.0;
          if (display) display.textContent = parseFloat(slider.value).toFixed(2);
          slider.disabled = !wbAvailable;
        }
      });
      const wbAutoBtn = document.getElementById("btn-wb-auto");
      if (wbAutoBtn) wbAutoBtn.disabled = !wbAvailable;
  ```

- [ ] **Step 3: Add Auto WB button handler to `frontend/app.js`**

  At the end of `app.js`, after the existing settings dialog block, add:

  ```js
  // ── White balance ───────────────────────────────────────────────────────────
  document.getElementById("btn-wb-auto").addEventListener("click", async () => {
    fmtStatusEl.textContent = "Applying…";
    try {
      const r = await fetch("/camera/white-balance/auto", { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      const ratios = await r.json();
      ["red", "green", "blue"].forEach(ch => {
        const slider = document.getElementById(`wb-${ch}-slider`);
        const display = document.getElementById(`wb-${ch}-value`);
        if (slider) { slider.value = ratios[ch]; display.textContent = ratios[ch].toFixed(2); }
      });
      fmtStatusEl.textContent = "Done";
      setTimeout(() => { fmtStatusEl.textContent = ""; }, 2000);
    } catch (err) {
      fmtStatusEl.textContent = `Error: ${err.message}`;
    }
  });
  ```

  Note: `fmtStatusEl` is the const declared near the top of the settings dialog block — it references `document.getElementById("settings-status")`. It was renamed from `statusEl` in a previous task to avoid shadowing the module-level `statusEl` (which references `#status-line`).

- [ ] **Step 4: Add debounced slider handlers to `frontend/app.js`**

  Immediately after the Auto WB handler, add:

  ```js
  let _wbDebounce = {};
  ["red", "green", "blue"].forEach(ch => {
    document.getElementById(`wb-${ch}-slider`).addEventListener("input", e => {
      const val = parseFloat(e.target.value);
      document.getElementById(`wb-${ch}-value`).textContent = val.toFixed(2);
      clearTimeout(_wbDebounce[ch]);
      _wbDebounce[ch] = setTimeout(async () => {
        try {
          await fetch("/camera/white-balance/ratio", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: ch.charAt(0).toUpperCase() + ch.slice(1),
              value: val,
            }),
          });
        } catch (err) {
          console.error("WB ratio update failed:", err);
        }
      }, 150);
    });
  });
  ```

  The 150 ms debounce prevents a flood of PUT requests while the user drags a slider. The display text updates immediately on every input event; only the network call is deferred.

- [ ] **Step 5: Restart the server and verify manually**

  ```bash
  ./server.sh restart && sleep 6
  curl -s http://localhost:8000/camera/info | python3 -m json.tool
  ```

  Expected: response includes `"wb_red"`, `"wb_green"`, `"wb_blue"` fields.

  Open the browser at `http://localhost:8000`. Open the ⚙ settings dialog (far-right toolbar button), Camera tab:
  - R/G/B sliders visible, initialised to values from `/camera/info`
  - "Auto WB" button visible
  - Dragging a slider sends a PUT (visible in browser DevTools → Network)
  - Clicking "Auto WB" shows "Applying…" briefly then "Done", sliders update to new values
  - On the OpenCV fallback (if running without the Aravis camera), all WB controls are disabled
