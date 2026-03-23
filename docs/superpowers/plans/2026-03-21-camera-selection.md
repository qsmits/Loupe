# Camera Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a camera selection dropdown to the settings dialog that lists available Aravis cameras, switches live, and persists the choice to `config.json`.

**Architecture:** A new `backend/config.py` handles JSON persistence. `AravisCamera` gains an optional `device_id` parameter and a module-level `list_aravis_cameras()` function. `CameraReader` gets a `switch_camera()` method that stops/swaps/restarts using the existing `_format_lock` pattern. Two new API endpoints (`GET /cameras`, `POST /camera/select`) are added inside the existing `make_router()` factory. The frontend populates the dropdown on settings open and posts on change.

**Tech Stack:** Python 3.13, FastAPI, Aravis GI (`gi.repository.Aravis`), pytest + httpx (TestClient), vanilla JS

**Note:** This project has no git history. Skip all commit steps.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `config.json` | Create | Persists `camera_id` across restarts |
| `backend/config.py` | Create | `load_config()` and `save_config()` |
| `backend/cameras/aravis.py` | Modify | `list_aravis_cameras()`; `__init__` accepts `device_id`; `open()` uses it; `get_info()` includes it |
| `backend/cameras/opencv.py` | Modify | `get_info()` gains `"device_id": "opencv-0"` |
| `backend/main.py` | Modify | Read config in `create_app()`; pass `device_id` to `AravisCamera` |
| `backend/stream.py` | Modify | `CameraReader.switch_camera()` |
| `backend/api.py` | Modify | `Field` import; `CameraSelectBody`; `GET /cameras`; `POST /camera/select` |
| `tests/conftest.py` | Modify | `FakeCamera.get_info()` gains `"device_id": "fake-0"` |
| `tests/test_config.py` | Create | Unit tests for `load_config` and `save_config` |
| `tests/test_api.py` | Modify | Tests for new endpoints and `device_id` in `/camera/info` |
| `frontend/index.html` | Modify | Camera dropdown above pixel format row |
| `frontend/app.js` | Modify | `loadCameraList()`; change handler; call on settings open |

---

## Task 1: `backend/config.py` + `config.json`

**Files:**
- Create: `backend/config.py`
- Create: `config.json`
- Test: `tests/test_config.py`

- [ ] **Step 1: Write failing tests**

  Create `tests/test_config.py`:

  ```python
  import json
  import pytest
  from backend.config import load_config, save_config, CONFIG_PATH


  def test_config_load_defaults_when_missing(tmp_path, monkeypatch):
      monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
      result = load_config()
      assert result == {"camera_id": None}


  def test_config_save_and_load(tmp_path, monkeypatch):
      path = tmp_path / "config.json"
      monkeypatch.setattr("backend.config.CONFIG_PATH", path)
      save_config({"camera_id": "Aravis-USB0-abc123"})
      result = load_config()
      assert result["camera_id"] == "Aravis-USB0-abc123"


  def test_config_load_merges_defaults(tmp_path, monkeypatch):
      path = tmp_path / "config.json"
      monkeypatch.setattr("backend.config.CONFIG_PATH", path)
      # Write a partial config missing camera_id
      path.write_text(json.dumps({}))
      result = load_config()
      assert "camera_id" in result
      assert result["camera_id"] is None
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd /Users/qsmits/Projects/MainDynamics/microscope
  .venv/bin/pytest tests/test_config.py -v
  ```

  Expected: FAIL — `backend.config` does not exist.

- [ ] **Step 3: Create `backend/config.py`**

  ```python
  import json
  import pathlib

  CONFIG_PATH = pathlib.Path(__file__).parent.parent / "config.json"
  _DEFAULTS = {"camera_id": None}


  def load_config() -> dict:
      """Return config dict. Missing keys fall back to defaults. File missing → all defaults."""
      if not CONFIG_PATH.exists():
          return dict(_DEFAULTS)
      try:
          data = json.loads(CONFIG_PATH.read_text())
          return {**_DEFAULTS, **data}
      except Exception:
          return dict(_DEFAULTS)


  def save_config(data: dict) -> None:
      """Merge data into existing config and write atomically via a temp file."""
      current = load_config()
      current.update(data)
      tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
      tmp.write_text(json.dumps(current, indent=2))
      tmp.replace(CONFIG_PATH)
  ```

- [ ] **Step 4: Create `config.json`**

  ```json
  {"camera_id": null}
  ```

- [ ] **Step 5: Run tests to confirm they pass**

  ```bash
  .venv/bin/pytest tests/test_config.py -v
  ```

  Expected: 3 PASS.

---

## Task 2: `AravisCamera` + `OpenCVCamera` + `FakeCamera` — `device_id` field

**Files:**
- Modify: `backend/cameras/aravis.py`
- Modify: `backend/cameras/opencv.py`
- Modify: `tests/conftest.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write failing test**

  Add to `tests/test_api.py`:

  ```python
  def test_camera_info_includes_device_id(client):
      r = client.get("/camera/info")
      assert r.status_code == 200
      assert "device_id" in r.json()
  ```

- [ ] **Step 2: Run test to confirm it fails**

  ```bash
  .venv/bin/pytest tests/test_api.py::test_camera_info_includes_device_id -v
  ```

  Expected: FAIL — `device_id` not in response.

- [ ] **Step 3: Modify `AravisCamera`**

  Read `backend/cameras/aravis.py` first.

  **3a — `__init__`:** Add `device_id` parameter. Change:
  ```python
  def __init__(self):
      if not ARAVIS_AVAILABLE:
          raise ImportError(
              "Aravis GI not available. Install aravis and set GST_PLUGIN_PATH."
          )
      self._cam = None
      self._stream = None
  ```
  To:
  ```python
  def __init__(self, device_id: str | None = None):
      if not ARAVIS_AVAILABLE:
          raise ImportError(
              "Aravis GI not available. Install aravis and set GST_PLUGIN_PATH."
          )
      self._device_id = device_id  # None → first available
      self._cam = None
      self._stream = None
  ```

  **3b — `open()`:** Change:
  ```python
  self._cam = Aravis.Camera.new(None)  # connects to first available camera
  ```
  To:
  ```python
  self._cam = Aravis.Camera.new(self._device_id)  # None → first available
  ```

  **3c — `get_info()`:** Add `"device_id": self._device_id` to the returned dict, after `"wb_manual_supported"`. The full return dict becomes:
  ```python
  return {
      "model": model,
      "serial": serial,
      "width": int(width),
      "height": int(height),
      "exposure": float(exposure),
      "gain": float(gain),
      "pixel_format": pixel_format,
      "device_id": self._device_id,
      "wb_red": wb["red"],
      "wb_green": wb["green"],
      "wb_blue": wb["blue"],
      "wb_manual_supported": wb_manual,
  }
  ```

  **3d — `list_aravis_cameras()`:** Add this module-level function after the `AravisCamera` class definition:

  ```python
  def list_aravis_cameras() -> list[dict]:
      """
      Return list of available Aravis cameras as
      [{"id": str, "vendor": str, "label": str}, ...].
      Returns [] if Aravis is not available.
      'label' is a human-readable display string for the UI dropdown.
      """
      if not ARAVIS_AVAILABLE:
          return []
      Aravis.update_device_list()
      cameras = []
      for i in range(Aravis.get_n_devices()):
          device_id = Aravis.get_device_id(i)
          vendor = Aravis.get_device_vendor(i) or "Unknown"
          cameras.append({
              "id": device_id,
              "vendor": vendor,
              "label": f"{vendor} — {device_id}",
          })
      return cameras
  ```

- [ ] **Step 4: Add `"device_id": "opencv-0"` to `OpenCVCamera.get_info()`**

  Read `backend/cameras/opencv.py`. In `get_info()`, add `"device_id": "opencv-0"` to the returned dict after `"wb_manual_supported"`.

- [ ] **Step 5: Add `"device_id": "fake-0"` to `FakeCamera.get_info()`**

  Read `tests/conftest.py`. In `FakeCamera.get_info()`, add `"device_id": "fake-0"` to the returned dict.

- [ ] **Step 6: Run all tests to confirm they pass**

  ```bash
  .venv/bin/pytest tests/ -v
  ```

  Expected: all PASS.

---

## Task 3: `CameraReader.switch_camera()`

**Files:**
- Modify: `backend/stream.py`

No automated tests for `switch_camera()` — requires hardware. The method follows the same stop/restart pattern as the existing `set_pixel_format()`, which can be read as reference (lines ~58–79 in `stream.py`).

- [ ] **Step 1: Read `backend/stream.py`**

  Familiarise yourself with `set_pixel_format()` (the thread stop/restart pattern you'll follow) and `__init__` (where `_format_lock` is defined).

- [ ] **Step 2: Add `switch_camera()` to `CameraReader`**

  Add this method after `set_pixel_format()` in `backend/stream.py`:

  ```python
      def switch_camera(self, new_camera: BaseCamera) -> None:
          """
          Live-swap the underlying camera. Stops the reader thread, closes the
          old camera, opens the new one, and restarts the thread.
          Uses _format_lock to prevent concurrent pixel-format changes and
          concurrent switch_camera calls.
          If the new camera fails to open, the old one is restored and an
          exception is raised.
          """
          with self._format_lock:
              self._stop.set()
              if self._thread is not None:
                  self._thread.join(timeout=2)
                  if self._thread.is_alive():
                      raise RuntimeError(
                          "Reader thread did not stop within 2 s; aborting camera switch."
                      )
              old_camera = self._camera
              try:
                  new_camera.open()
                  old_camera.close()
                  self._camera = new_camera
              except Exception as switch_err:
                  # Restore old camera; log if restoration also fails
                  try:
                      old_camera.open()
                      self._camera = old_camera
                  except Exception as restore_err:
                      _log.error(
                          "Camera switch failed and restoration also failed: %s", restore_err
                      )
                  self._stop.clear()
                  self._thread = threading.Thread(target=self._run, daemon=True)
                  self._thread.start()
                  raise switch_err
              self._stop.clear()
              self._thread = threading.Thread(target=self._run, daemon=True)
              self._thread.start()
  ```

  Note: `_log` is already defined at the top of `stream.py` from the previous white balance session (`_log = logging.getLogger(__name__)`).

- [ ] **Step 3: Run full test suite to confirm nothing broken**

  ```bash
  .venv/bin/pytest tests/ -v
  ```

  Expected: all PASS.

---

## Task 4: API endpoints + `main.py` config integration

**Files:**
- Modify: `backend/api.py`
- Modify: `backend/main.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write failing tests**

  Add to `tests/test_api.py`:

  ```python
  def test_list_cameras_returns_list(client):
      r = client.get("/cameras")
      assert r.status_code == 200
      data = r.json()
      assert isinstance(data, list)
      assert len(data) >= 1
      assert "id" in data[0]
      assert "label" in data[0]


  def test_select_camera_opencv_id_rejected(client):
      r = client.post("/camera/select", json={"camera_id": "opencv-0"})
      assert r.status_code == 400


  def test_select_camera_aravis_unavailable(client):
      # In the test environment Aravis is unavailable, so AravisCamera.__init__
      # raises ImportError — the endpoint catches all exceptions as 400.
      r = client.post("/camera/select", json={"camera_id": "Aravis-USB0-fake"})
      assert r.status_code == 400
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  .venv/bin/pytest tests/test_api.py::test_list_cameras_returns_list tests/test_api.py::test_select_camera_opencv_id_rejected tests/test_api.py::test_select_camera_aravis_unavailable -v
  ```

  Expected: FAIL — endpoints do not exist.

- [ ] **Step 3: Update `backend/api.py`**

  Read `backend/api.py` first.

  **3a — Add `Field` to the pydantic import:**
  Change:
  ```python
  from pydantic import BaseModel
  ```
  To:
  ```python
  from pydantic import BaseModel, Field
  ```

  **3b — Add `CameraSelectBody` after `WhiteBalanceRatioBody`:**
  ```python
  class CameraSelectBody(BaseModel):
      camera_id: str = Field(..., min_length=1)
  ```

  **3c — Add both endpoints inside `make_router()`, after the `PUT /camera/white-balance/ratio` endpoint:**
  ```python
      @router.get("/cameras")
      async def list_cameras():
          from .cameras.aravis import list_aravis_cameras
          cameras = await asyncio.to_thread(list_aravis_cameras)
          if not cameras:
              # OpenCV fallback — return a single non-selectable entry
              cameras = [{"id": "opencv-0", "vendor": "OpenCV", "label": "OpenCV Camera"}]
          return cameras

      @router.post("/camera/select")
      async def select_camera(body: CameraSelectBody):
          if body.camera_id == "opencv-0":
              raise HTTPException(status_code=400,
                  detail="Camera selection is not supported on the OpenCV fallback.")
          from .cameras.aravis import AravisCamera
          from .config import save_config
          try:
              new_cam = AravisCamera(device_id=body.camera_id)
              await asyncio.to_thread(camera.switch_camera, new_cam)
          except Exception as e:
              raise HTTPException(status_code=400, detail=str(e))
          save_config({"camera_id": body.camera_id})
          return {"ok": True}
  ```

- [ ] **Step 4: Update `backend/main.py`**

  Read `backend/main.py` first. Inside `create_app()`, in the `if camera is None:` branch, add config loading and pass `device_id` to `AravisCamera`:

  Change:
  ```python
      if camera is None:
          if ARAVIS_AVAILABLE:
              camera = AravisCamera()
          else:
              log.warning("Aravis not found — falling back to OpenCV camera (index 1)")
              camera = OpenCVCamera(index=1)
  ```
  To:
  ```python
      if camera is None:
          from .config import load_config
          cfg = load_config()
          if ARAVIS_AVAILABLE:
              camera = AravisCamera(device_id=cfg.get("camera_id"))
          else:
              log.warning("Aravis not found — falling back to OpenCV camera (index 1)")
              camera = OpenCVCamera(index=1)
  ```

- [ ] **Step 5: Run all tests**

  ```bash
  .venv/bin/pytest tests/ -v
  ```

  Expected: all PASS.

---

## Task 5: Frontend — HTML + JavaScript

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

No automated frontend tests. Verify manually in the browser after server restart.

- [ ] **Step 1: Add camera dropdown to `frontend/index.html`**

  Read `frontend/index.html` first. Inside `#settings-camera-panel`, add the following row **above** the existing pixel format row (i.e. before `<div class="settings-row">` that contains `<select id="pixel-format-select">`):

  ```html
      <div class="settings-row">
        <label for="camera-select">Camera</label>
        <select id="camera-select">
          <option value="">Loading…</option>
        </select>
      </div>
  ```

- [ ] **Step 2: Add `loadCameraList()` to `frontend/app.js`**

  Read `frontend/app.js` first. Find `loadCameraInfo()` — `loadCameraList()` will be a sibling function, defined just before or after it.

  Add `loadCameraList()` as a new async function:

  ```js
  async function loadCameraList() {
    const sel = document.getElementById("camera-select");
    try {
      const [camerasResp, infoResp] = await Promise.all([
        fetch("/cameras"),
        fetch("/camera/info"),
      ]);
      const cameras = await camerasResp.json();
      const info = await infoResp.json();
      const currentId = info.device_id ?? "";
      sel.innerHTML = cameras.map(c =>
        `<option value="${c.id}"${c.id === currentId ? " selected" : ""}>${c.label}</option>`
      ).join("");
      sel.disabled = cameras.length <= 1 && cameras[0]?.id === "opencv-0";
    } catch {
      sel.innerHTML = "<option>Unavailable</option>";
      sel.disabled = true;
    }
  }
  ```

- [ ] **Step 3: Call `loadCameraList()` when the settings dialog opens**

  In `app.js`, find the settings open handler — the code that calls `loadCameraInfo()` when the settings button is clicked or the dialog shown. Add `loadCameraList()` call alongside it:

  ```js
  loadCameraInfo();
  loadCameraList();
  ```

- [ ] **Step 4: Add the camera select change handler**

  At the end of `app.js` (after the WB debounce handlers), add:

  ```js
  // ── Camera selection ────────────────────────────────────────────────────────
  document.getElementById("camera-select").addEventListener("change", async e => {
    const camera_id = e.target.value;
    if (!camera_id) return;
    fmtStatusEl.textContent = "Switching…";
    try {
      const r = await fetch("/camera/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera_id }),
      });
      if (!r.ok) throw new Error(await r.text());
      await loadCameraInfo();
      fmtStatusEl.textContent = "Done";
      setTimeout(() => { fmtStatusEl.textContent = ""; }, 2000);
    } catch (err) {
      fmtStatusEl.textContent = `Error: ${err.message}`;
    }
  });
  ```

- [ ] **Step 5: Restart the server and verify manually**

  ```bash
  ./server.sh restart && sleep 6
  curl -s http://localhost:8000/cameras | python3 -m json.tool
  ```

  Expected: JSON array with at least one camera entry, each with `id`, `vendor`, `label`.

  Open the browser at `http://localhost:8000` (hard-refresh with Cmd+Shift+R). Open the ⚙ settings dialog, Camera tab:
  - Camera dropdown appears above Pixel format
  - Dropdown shows the connected Baumer camera label
  - If only one camera is present, dropdown may be enabled but selecting the same camera is a no-op

  Check `config.json` after selecting a camera:
  ```bash
  cat /Users/qsmits/Projects/MainDynamics/microscope/config.json
  ```
  Expected: `{"camera_id": "Aravis-USB0-..."}` (or whatever the device ID is).
