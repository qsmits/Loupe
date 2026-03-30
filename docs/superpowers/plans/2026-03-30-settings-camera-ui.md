# Settings & Camera UI Reorganization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all camera controls into a top-bar dropdown menu, reorganize the settings dialog into 3 well-organized tabs, add auto-exposure/gamma/ROI camera features with capability probing, and remove the sidebar camera panel.

**Architecture:** Backend-first: add feature probing and new camera methods to the camera abstraction layer, then new API endpoints. Frontend: build the camera dropdown, reorganize settings dialog, remove sidebar camera panel, wire everything together with capability-based visibility.

**Tech Stack:** Python (Aravis/GenICam via GObject Introspection), FastAPI, vanilla JS ES modules

**Spec:** `docs/superpowers/specs/2026-03-30-settings-camera-ui-design.md`

---

## File Map

### Files to modify (backend)
| File | Changes |
|------|---------|
| `backend/cameras/base.py` | Add `set_gamma`, `get_gamma`, `set_auto_exposure`, `set_roi`, `reset_roi` with default no-op implementations |
| `backend/cameras/aravis.py` | Implement new methods, extend `get_info()` with `supports` dict + gamma/ROI/sensor fields |
| `backend/cameras/null.py` | Extend `get_info()` with `supports: {all false}` and new field defaults |
| `backend/cameras/opencv.py` | Same as NullCamera — extend `get_info()` |
| `backend/stream.py` | Add `set_roi()`, `reset_roi()` to CameraReader (threading pattern) |
| `backend/api_camera.py` | New endpoints: `/camera/gamma`, `/camera/auto-exposure`, `/camera/roi`, `/camera/roi/reset` |

### Files to modify (frontend)
| File | Changes |
|------|---------|
| `frontend/index.html` | Add camera dropdown in top bar, remove sidebar camera section, reorganize settings tabs |
| `frontend/main.js` | Wire camera dropdown, update `closeAllDropdowns()`, move event handlers, reorganize settings |
| `frontend/sidebar.js` | Update `loadCameraInfo()` to populate camera dropdown instead of sidebar, remove sidebar camera rendering |
| `frontend/style.css` | Camera dropdown panel styling, settings dialog `min-height` |

---

### Task 1: Backend — feature probing and new camera methods

**Files:**
- Modify: `backend/cameras/base.py`
- Modify: `backend/cameras/aravis.py`
- Modify: `backend/cameras/null.py`
- Modify: `backend/cameras/opencv.py`

- [ ] **Step 1: Add new methods to BaseCamera**

In `backend/cameras/base.py`, add after the existing abstract methods (after line 43):

```python
# ── Optional features (default no-op for cameras that don't support them) ──

def set_gamma(self, value: float) -> None:
    """Set gamma correction. No-op if unsupported."""

def get_gamma(self) -> float:
    """Get current gamma value. Returns 1.0 if unsupported."""
    return 1.0

def set_auto_exposure(self) -> float:
    """Trigger one-shot auto-exposure. Returns new exposure value."""
    return 0.0

def set_roi(self, offset_x: int, offset_y: int, width: int, height: int) -> None:
    """Set camera region of interest. No-op if unsupported."""

def reset_roi(self) -> None:
    """Reset ROI to full sensor. No-op if unsupported."""
```

These are NOT abstract — they have default implementations so NullCamera and OpenCVCamera don't need to override them.

- [ ] **Step 2: Implement new methods on AravisCamera**

In `backend/cameras/aravis.py`, add after `set_white_balance_ratio()` (after line 200):

```python
def set_gamma(self, value: float) -> None:
    if self._cam is None:
        raise RuntimeError("Camera not open")
    self._cam.get_device().set_float_feature_value("Gamma", value)

def get_gamma(self) -> float:
    if self._cam is None:
        raise RuntimeError("Camera not open")
    return float(self._cam.get_device().get_float_feature_value("Gamma"))

def set_auto_exposure(self) -> float:
    if self._cam is None:
        raise RuntimeError("Camera not open")
    device = self._cam.get_device()
    device.set_string_feature_value("ExposureAuto", "Once")
    prev_exp = self._cam.get_exposure_time()
    for _ in range(40):  # up to 2s
        time.sleep(0.05)
        try:
            if device.get_string_feature_value("ExposureAuto") == "Off":
                break
        except Exception:
            pass
        cur_exp = self._cam.get_exposure_time()
        if abs(cur_exp - prev_exp) < 1.0:
            break
        prev_exp = cur_exp
    return self._cam.get_exposure_time()

def set_roi(self, offset_x: int, offset_y: int, width: int, height: int) -> None:
    """Set ROI. Same pattern as set_pixel_format: stop acquisition, change
    settings, reallocate buffers, restart acquisition."""
    if self._cam is None:
        raise RuntimeError("Camera not open")
    self._cam.stop_acquisition()
    try:
        device = self._cam.get_device()
        device.set_integer_feature_value("OffsetX", 0)
        device.set_integer_feature_value("OffsetY", 0)
        device.set_integer_feature_value("Width", width)
        device.set_integer_feature_value("Height", height)
        device.set_integer_feature_value("OffsetX", offset_x)
        device.set_integer_feature_value("OffsetY", offset_y)
        # Reallocate buffers (payload size changed)
        payload = self._cam.get_payload()
        while self._stream.try_pop_buffer() is not None:
            pass
        for _ in range(10):
            self._stream.push_buffer(Aravis.Buffer.new_allocate(payload))
    finally:
        self._cam.start_acquisition()

def reset_roi(self) -> None:
    if self._cam is None:
        raise RuntimeError("Camera not open")
    device = self._cam.get_device()
    sw = int(device.get_integer_feature_value("SensorWidth"))
    sh = int(device.get_integer_feature_value("SensorHeight"))
    self.set_roi(0, 0, sw, sh)  # reuse set_roi for acquisition/buffer handling
```

- [ ] **Step 3: Extend AravisCamera.get_info() with feature probing**

In `get_info()` (lines 134-164), add feature probing and new fields. After the existing return dict is built, add:

```python
# Feature probing — try each optional GenICam feature
def _probe(fn):
    try:
        fn()
        return True
    except Exception:
        return False

supports = {
    "wb_manual": wb_manual,  # already computed
    "wb_auto": _probe(lambda: device.get_string_feature_value("BalanceWhiteAuto")),
    "auto_exposure": _probe(lambda: device.get_string_feature_value("ExposureAuto")),
    "gamma": _probe(lambda: device.get_float_feature_value("Gamma")),
    "roi": _probe(lambda: device.get_integer_feature_value("OffsetX")),
}

# Read current gamma
try:
    gamma = float(device.get_float_feature_value("Gamma"))
except Exception:
    gamma = 1.0

# Read gamma range
try:
    gamma_min = float(device.get_float_feature_bounds("Gamma")[0])
    gamma_max = float(device.get_float_feature_bounds("Gamma")[1])
except Exception:
    gamma_min, gamma_max = 0.5, 2.0

# Read ROI info
try:
    sensor_w = int(device.get_integer_feature_value("SensorWidth"))
    sensor_h = int(device.get_integer_feature_value("SensorHeight"))
except Exception:
    sensor_w, sensor_h = width, height

try:
    roi_w_inc = int(device.get_integer_feature_bounds("Width")[2])  # (min, max, inc)
    roi_h_inc = int(device.get_integer_feature_bounds("Height")[2])
except Exception:
    roi_w_inc, roi_h_inc = 4, 4

roi = {
    "offset_x": int(device.get_integer_feature_value("OffsetX")) if supports["roi"] else 0,
    "offset_y": int(device.get_integer_feature_value("OffsetY")) if supports["roi"] else 0,
    "width": width,
    "height": height,
}
```

Add all new fields to the return dict:
```python
return {
    # ... existing fields ...
    "supports": supports,
    "gamma": gamma,
    "gamma_min": gamma_min,
    "gamma_max": gamma_max,
    "roi": roi,
    "sensor_width": sensor_w,
    "sensor_height": sensor_h,
    "roi_width_inc": roi_w_inc,
    "roi_height_inc": roi_h_inc,
}
```

**Note on Aravis GI API for bounds:** The method names may vary:
- `device.get_float_feature_bounds(name)` may return `(min, max)` — NOT `(min, max, inc)`
- For integer increment, try `device.get_integer_feature_value("WidthIncrement")` or check `dir(device)` for `get_integer_feature_bounds` return format
- The implementer should verify with `dir(device)` or Aravis GI docs and adapt. The pseudocode shows the intent; exact method names need checking.

Also update `loadCameraList()` in `sidebar.js` (line 376) to target `#camera-select-top` instead of `#camera-select` — otherwise the camera selector dropdown won't be populated.

- [ ] **Step 4: Update NullCamera and OpenCVCamera get_info()**

Add to both `get_info()` return dicts:

```python
"supports": {
    "wb_manual": False,
    "wb_auto": False,
    "auto_exposure": False,
    "gamma": False,
    "roi": False,
},
"gamma": 1.0,
"gamma_min": 0.5,
"gamma_max": 2.0,
"roi": {"offset_x": 0, "offset_y": 0, "width": 640, "height": 480},
"sensor_width": 640,
"sensor_height": 480,
"roi_width_inc": 4,
"roi_height_inc": 4,
```

For OpenCVCamera, use actual width/height from `get_info()` instead of 640x480.

- [ ] **Step 5: Run tests**

Run: `python3 -m pytest tests/test_cameras.py -v`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add backend/cameras/base.py backend/cameras/aravis.py backend/cameras/null.py backend/cameras/opencv.py
git commit -m "feat: add feature probing, gamma, auto-exposure, ROI to camera layer"
```

---

### Task 2: Backend — CameraReader ROI threading + new API endpoints

**Files:**
- Modify: `backend/stream.py`
- Modify: `backend/api_camera.py`

- [ ] **Step 1: Add new delegation methods to CameraReader**

In `backend/stream.py`, add delegation methods for all new camera features. These follow existing patterns (e.g., `set_exposure` delegates directly, `set_pixel_format` uses `_format_lock` for stream-affecting changes):

**Simple delegations** (after existing `set_gain`, around line 63):
```python
def set_gamma(self, value: float) -> None:
    self._camera.set_gamma(value)

def get_gamma(self) -> float:
    return self._camera.get_gamma()

def set_auto_exposure(self) -> float:
    # Blocking (up to ~2s polling) — call via asyncio.to_thread in API layer
    return self._camera.set_auto_exposure()
```

**Stream-affecting operations** (after `set_pixel_format`, using `_format_lock`):
```python
def set_roi(self, offset_x: int, offset_y: int, width: int, height: int) -> None:
    """Set camera ROI. Stops reader thread, delegates to inner camera
    (which handles acquisition stop/start + buffer reallocation), restarts."""
    with self._format_lock:
        if self._thread is None:
            raise RuntimeError("CameraReader is not open")
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            if self._thread.is_alive():
                raise RuntimeError("Reader thread did not stop within 2 s")
        self._camera.set_roi(offset_x, offset_y, width, height)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

def reset_roi(self) -> None:
    with self._format_lock:
        if self._thread is None:
            raise RuntimeError("CameraReader is not open")
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            if self._thread.is_alive():
                raise RuntimeError("Reader thread did not stop within 2 s")
        self._camera.reset_roi()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
```

Note: `AravisCamera.set_roi()` (from Task 1) already handles `stop_acquisition()`, GenICam feature writes, buffer reallocation, and `start_acquisition()` internally — same pattern as `set_pixel_format`. So `CameraReader` just needs to stop/restart its reader thread around the call.

- [ ] **Step 2: Add new API endpoints**

In `backend/api_camera.py`, add Pydantic models:

```python
class GammaBody(BaseModel):
    value: float = Field(ge=0.1, le=4.0)

class RoiBody(BaseModel):
    offset_x: int = Field(ge=0)
    offset_y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
```

Add endpoints inside `make_camera_router()`:

```python
@router.put("/camera/gamma")
async def set_gamma(body: GammaBody):
    if camera.is_null:
        raise HTTPException(503, detail="No camera")
    await asyncio.to_thread(camera.set_gamma, body.value)
    return {"ok": True}

@router.post("/camera/auto-exposure")
async def auto_exposure():
    if camera.is_null:
        raise HTTPException(503, detail="No camera")
    exposure = await asyncio.to_thread(camera.set_auto_exposure)
    return {"exposure": exposure}

@router.put("/camera/roi")
async def set_roi(body: RoiBody):
    if camera.is_null:
        raise HTTPException(503, detail="No camera")
    info = camera.get_info()
    w_inc = info.get("roi_width_inc", 4)
    h_inc = info.get("roi_height_inc", 4)
    # Snap to valid increments
    width = max(w_inc, round(body.width / w_inc) * w_inc)
    height = max(h_inc, round(body.height / h_inc) * h_inc)
    offset_x = round(body.offset_x / w_inc) * w_inc
    offset_y = round(body.offset_y / h_inc) * h_inc
    # Clamp to sensor bounds
    sw = info.get("sensor_width", info["width"])
    sh = info.get("sensor_height", info["height"])
    offset_x = min(offset_x, sw - width)
    offset_y = min(offset_y, sh - height)
    await asyncio.to_thread(camera.set_roi, offset_x, offset_y, width, height)
    return {"offset_x": offset_x, "offset_y": offset_y, "width": width, "height": height}

@router.post("/camera/roi/reset")
async def reset_roi():
    if camera.is_null:
        raise HTTPException(503, detail="No camera")
    await asyncio.to_thread(camera.reset_roi)
    return {"ok": True}
```

`set_gamma` is synchronous (fast GenICam write). `auto_exposure` and ROI changes use `asyncio.to_thread` because they block (polling / stream restart).

- [ ] **Step 3: Run tests**

Run: `python3 -m pytest tests/ -q`
Expected: No new failures

- [ ] **Step 4: Commit**

```bash
git add backend/stream.py backend/api_camera.py
git commit -m "feat: add gamma, auto-exposure, ROI API endpoints with threading"
```

---

### Task 3: Frontend — camera dropdown HTML and wiring

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/main.js`
- Modify: `frontend/style.css`

- [ ] **Step 1: Add camera dropdown to top bar**

In `frontend/index.html`, add a new dropdown between the Clear menu (line ~186) and the freeze button (line ~189):

```html
<button class="top-btn" id="btn-menu-camera">Camera ▾</button>
<div class="dropdown camera-panel" id="dropdown-camera" hidden>
  <div class="camera-panel-header">
    <select id="camera-select-top" class="camera-select-dropdown"></select>
    <div class="camera-info-line">
      <span id="camera-res-display">—</span> ·
      <select id="pixel-format-top" class="pixel-format-dropdown">
        <option value="BayerRG8">BayerRG8</option>
        <option value="BayerRG12">BayerRG12</option>
        <option value="Mono8">Mono8</option>
      </select>
    </div>
  </div>
  <div class="camera-panel-section">
    <div class="detect-row">
      <label class="detect-label">Exposure</label>
      <input type="range" id="exp-slider-top" min="100" max="100000" step="100" value="5000" />
      <span class="detect-val" id="exp-value-top">5000 µs</span>
    </div>
    <div class="detect-row">
      <label class="detect-label">Gain</label>
      <input type="range" id="gain-slider-top" min="0" max="24" step="0.1" value="0" />
      <span class="detect-val" id="gain-value-top">0 dB</span>
    </div>
    <div class="detect-row" id="gamma-row" hidden>
      <label class="detect-label">Gamma</label>
      <input type="range" id="gamma-slider" min="0.5" max="2.0" step="0.1" value="1.0" />
      <span class="detect-val" id="gamma-value">1.0</span>
    </div>
    <div class="camera-panel-buttons">
      <button class="detect-btn" id="btn-auto-exposure" hidden>Auto Exposure</button>
      <button class="detect-btn" id="btn-wb-auto-top">Auto WB</button>
    </div>
  </div>
  <div class="camera-panel-section" id="wb-section" hidden>
    <div class="detect-section-label">White Balance</div>
    <div class="detect-row">
      <label class="detect-label">R</label>
      <input type="range" id="wb-red-slider-top" min="0.5" max="2.5" step="0.01" value="1.0" />
      <span class="detect-val" id="wb-red-value-top">1.00</span>
    </div>
    <div class="detect-row">
      <label class="detect-label">G</label>
      <input type="range" id="wb-green-slider-top" min="0.5" max="2.5" step="0.01" value="1.0" />
      <span class="detect-val" id="wb-green-value-top">1.00</span>
    </div>
    <div class="detect-row">
      <label class="detect-label">B</label>
      <input type="range" id="wb-blue-slider-top" min="0.5" max="2.5" step="0.01" value="1.0" />
      <span class="detect-val" id="wb-blue-value-top">1.00</span>
    </div>
  </div>
  <div class="camera-panel-section" id="roi-section" hidden>
    <div class="detect-section-label">Region of Interest</div>
    <div class="camera-panel-buttons">
      <button class="detect-btn" id="btn-roi-set">Set from view</button>
      <button class="detect-btn" id="btn-roi-reset">Reset</button>
    </div>
    <div class="camera-info-line" id="roi-info">Full frame</div>
  </div>
</div>
```

- [ ] **Step 2: Add CSS for camera dropdown**

In `frontend/style.css`, add styles for the camera panel. Follow the existing `.detect-panel` pattern — same width, padding, section styling. Add:

```css
.camera-panel { width: 280px; }
.camera-panel-header { padding: 8px 10px; border-bottom: 1px solid var(--border); }
.camera-select-dropdown { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 4px; font-size: 12px; }
.pixel-format-dropdown { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; font-size: 11px; }
.camera-info-line { font-size: 11px; color: var(--muted); margin-top: 4px; }
.camera-panel-section { padding: 6px 10px; border-bottom: 1px solid var(--border); }
.camera-panel-buttons { display: flex; gap: 6px; margin-top: 4px; }
```

Also add `min-height: 380px` to `.dialog-body` or the settings panel container so the settings dialog doesn't resize on tab switch.

- [ ] **Step 3: Wire camera dropdown toggle in main.js**

Update `closeAllDropdowns()` (lines 17-28) to include `dropdown-camera` and `btn-menu-camera`.

Add toggle handler for the camera menu button:

```js
document.getElementById("btn-menu-camera").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-camera", "dropdown-camera");
});
```

- [ ] **Step 4: Wire camera controls (exposure, gain, gamma, auto-exposure, WB)**

Move the exposure/gain/WB event handlers from their current locations in main.js to work with the new `-top` suffixed element IDs. This is the bulk of the wiring work:

- Exposure slider: `exp-slider-top` → PUT `/camera/exposure`
- Gain slider: `gain-slider-top` → PUT `/camera/gain`
- Gamma slider: `gamma-slider` → PUT `/camera/gamma` (debounced 200ms)
- Auto Exposure button: `btn-auto-exposure` → POST `/camera/auto-exposure`
- Auto WB button: `btn-wb-auto-top` → POST `/camera/white-balance/auto`
- WB RGB sliders: `wb-{ch}-slider-top` → PUT `/camera/white-balance/ratio` (debounced)
- Camera select: `camera-select-top` → POST `/camera/select`
- Pixel format: `pixel-format-top` → PUT `/camera/pixel-format`

- [ ] **Step 5: Update loadCameraInfo() in sidebar.js**

`loadCameraInfo()` currently populates the sidebar camera panel. Update it to populate the new top-bar dropdown instead:

- Camera resolution → `#camera-res-display`
- Exposure/gain → `#exp-slider-top`, `#exp-value-top`, `#gain-slider-top`, `#gain-value-top`
- Pixel format → `#pixel-format-top`
- WB sliders → `#wb-{ch}-slider-top`, `#wb-{ch}-value-top`
- **NEW:** Gamma → `#gamma-slider`, `#gamma-value` (set from `d.gamma`, range from `d.gamma_min`/`d.gamma_max`)
- **NEW:** ROI info → `#roi-info`
- **NEW:** Capability-based visibility:
  ```js
  const sup = d.supports || {};
  document.getElementById("gamma-row").hidden = !sup.gamma;
  document.getElementById("btn-auto-exposure").hidden = !sup.auto_exposure;
  document.getElementById("wb-section").hidden = !sup.wb_manual;
  document.getElementById("btn-wb-auto-top").hidden = !sup.wb_auto;
  document.getElementById("roi-section").hidden = !sup.roi;
  ```

- [ ] **Step 6: Wire ROI buttons**

```js
document.getElementById("btn-roi-set")?.addEventListener("click", async () => {
  const info = /* cached camera info from last loadCameraInfo */;
  const currentRoi = info.roi || { offset_x: 0, offset_y: 0 };
  const wInc = info.roi_width_inc || 4;
  const hInc = info.roi_height_inc || 4;

  let ox = Math.max(0, currentRoi.offset_x + Math.round(viewport.panX));
  let oy = Math.max(0, currentRoi.offset_y + Math.round(viewport.panY));
  let w = Math.round(canvas.clientWidth / viewport.zoom);
  let h = Math.round(canvas.clientHeight / viewport.zoom);

  // Snap to increments
  w = Math.max(wInc, Math.round(w / wInc) * wInc);
  h = Math.max(hInc, Math.round(h / hInc) * hInc);
  ox = Math.round(ox / wInc) * wInc;
  oy = Math.round(oy / hInc) * hInc;

  // Clamp
  ox = Math.min(ox, info.sensor_width - w);
  oy = Math.min(oy, info.sensor_height - h);

  const resp = await fetch("/camera/roi", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset_x: ox, offset_y: oy, width: w, height: h }),
  });
  if (resp.ok) {
    await loadCameraInfo();  // updates imageWidth/Height + fitToWindow
  }
});

document.getElementById("btn-roi-reset")?.addEventListener("click", async () => {
  const resp = await fetch("/camera/roi/reset", { method: "POST" });
  if (resp.ok) {
    await loadCameraInfo();
  }
});
```

- [ ] **Step 7: Manual smoke test**

- Open the Camera dropdown → verify sliders, camera info, pixel format
- Adjust exposure/gain → verify camera responds
- Check that unsupported features are hidden (e.g., gamma hidden if camera doesn't support it)
- If ROI supported: zoom in, click "Set from view", verify camera crops

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html frontend/main.js frontend/sidebar.js frontend/style.css
git commit -m "feat: camera dropdown menu in top bar with all controls"
```

---

### Task 4: Frontend — settings dialog reorganization

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/main.js`
- Modify: `frontend/sidebar.js`

- [ ] **Step 1: Reorganize settings dialog HTML**

In `frontend/index.html`, modify the settings dialog (lines 305-414):

**Remove** the Camera tab button and `#settings-camera-panel` entirely (lines 313, 344-381).

**Rename** Tolerances tab to "Measurement" and merge sub-pixel settings into it:

```html
<div class="dialog-tabs">
  <button class="settings-tab active" data-tab="general">General</button>
  <button class="settings-tab" data-tab="measurement">Measurement</button>
  <button class="settings-tab" data-tab="display">Display</button>
</div>
```

**General panel** — keep only app name + theme:
```html
<div class="settings-panel" id="settings-general-panel" style="display:block">
  <div class="settings-row">
    <label class="settings-label">App name</label>
    <input id="app-name-input" class="settings-input" value="Microscope" />
  </div>
  <div class="settings-row">
    <label class="settings-label">Theme</label>
    <select id="theme-select" class="settings-select">
      <option value="macos-dark">macOS Dark</option>
    </select>
  </div>
  <button class="settings-save-btn" id="btn-save-general">Save</button>
</div>
```

**Measurement panel** (new, merges tolerances + sub-pixel):
```html
<div class="settings-panel" id="settings-measurement-panel" style="display:none">
  <div class="settings-row">
    <label class="settings-label">Warn tolerance (mm)</label>
    <input type="number" id="tol-warn-input" class="settings-input" step="0.01" value="0.10" />
  </div>
  <div class="settings-row">
    <label class="settings-label">Fail tolerance (mm)</label>
    <input type="number" id="tol-fail-input" class="settings-input" step="0.01" value="0.25" />
  </div>
  <div class="settings-row">
    <label class="settings-label">Sub-pixel method</label>
    <select id="subpixel-method-select" class="settings-select">
      <option value="none">None (pixel-level)</option>
      <option value="parabola" selected>Parabola (default)</option>
    </select>
  </div>
  <div class="settings-row">
    <label class="settings-label" title="Search radius for edge snap (pixels at 1x zoom)">Snap radius (px)</label>
    <input type="range" id="subpixel-radius-slider" min="3" max="25" value="10" style="width:100px" />
    <span id="subpixel-radius-value" style="min-width:24px;text-align:right">10</span>
  </div>
  <button class="settings-save-btn" id="btn-save-tolerances">Save</button>
  <span id="tolerances-status" class="settings-status"></span>
</div>
```

**Display panel** — unchanged (crosshair color + opacity).

- [ ] **Step 2: Add min-height to settings dialog**

In `frontend/style.css`, add to the dialog body container:
```css
.settings-panel { min-height: 300px; }
```

This ensures the dialog doesn't shrink when switching from a tall tab (Measurement with 4 rows) to a short one (General with 2 rows). The exact value should be tuned visually — set it to match the tallest tab's content height.

- [ ] **Step 3: Update tab switching JS**

The existing generic tab-switching code in main.js (lines 435-442) uses `data-tab` attributes and `settings-${tab}-panel` ID pattern. Since we renamed "tolerances" to "measurement", the panel ID changes from `settings-tolerances-panel` to `settings-measurement-panel`. Update the tolerance save button ID reference if it changed.

The sub-pixel settings wiring code in main.js already references `subpixel-method-select` and `subpixel-radius-slider` by ID — these stay the same, just moved to a different tab. No JS change needed for those.

- [ ] **Step 4: Remove old camera-related settings JS**

Delete the following event handlers from main.js (they now live in the camera dropdown wiring from Task 3):
- Pixel format change handler (lines ~540-558)
- WB auto button handler (lines ~561-595)
- WB RGB slider handlers (lines ~598-618)
- Camera select handler (lines ~621-642)

Also remove the `loadCameraList()` call from the settings dialog open handler (line ~422) — camera list is loaded in `loadCameraInfo()` for the top-bar dropdown now.

- [ ] **Step 5: Manual smoke test**

- Open settings → 3 tabs (General, Measurement, Display)
- Verify dialog doesn't resize when switching tabs
- Verify tolerance save works
- Verify sub-pixel settings work from Measurement tab
- Verify no camera-related controls in settings

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/main.js frontend/style.css
git commit -m "refactor: reorganize settings dialog to 3 tabs (General, Measurement, Display)"
```

---

### Task 5: Remove sidebar camera panel

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/main.js`
- Modify: `frontend/sidebar.js`

- [ ] **Step 1: Remove camera section from sidebar HTML**

In `frontend/index.html`, delete the camera section (lines ~275-293):
```html
<!-- DELETE: camera-section including header, body, sliders, camera-info -->
```

- [ ] **Step 2: Remove camera section toggle from main.js**

Delete the camera section header/body toggle handler (lines 45-52).

Also delete the old exposure/gain slider handlers (lines ~581-595) if not already removed in Task 4.

- [ ] **Step 3: Clean up sidebar.js**

In `loadCameraInfo()`, remove all references to the old sidebar elements:
- `#exp-slider`, `#exp-value` (old sidebar exposure)
- `#gain-slider`, `#gain-value` (old sidebar gain)
- `#camera-info` (old sidebar camera info div)

These have been replaced by the `-top` variants in the camera dropdown.

- [ ] **Step 4: Run all tests**

```bash
node --test tests/frontend/test_*.js
python3 -m pytest tests/ -q
```
Expected: All pass

- [ ] **Step 5: Manual smoke test**

- Sidebar should only show: measurements, inspection panel, status, calibration
- No camera section visible
- More vertical space for measurement list

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/main.js frontend/sidebar.js
git commit -m "refactor: remove sidebar camera panel (moved to top-bar dropdown)"
```

---

## Final Verification

After all 5 tasks:

```bash
node --test tests/frontend/test_*.js    # frontend tests
python3 -m pytest tests/ -q             # backend tests
```

### Manual test checklist
- [ ] Camera dropdown shows in top bar, opens/closes correctly
- [ ] Exposure, gain sliders work from dropdown
- [ ] Camera selector works (if multiple cameras)
- [ ] Pixel format selector works
- [ ] Auto WB button works
- [ ] Unsupported features are hidden (check with NullCamera — everything hidden)
- [ ] Settings dialog has 3 tabs, doesn't resize on tab switch
- [ ] Tolerances save from Measurement tab
- [ ] Sub-pixel settings in Measurement tab
- [ ] Sidebar has no camera section, more room for measurements
- [ ] Gamma slider shown/hidden based on camera capability
- [ ] ROI "Set from view" + "Reset" (if camera supports it)
