# Settings & Camera UI Reorganization

## Goal

Move all camera controls from the bottom-right sidebar panel into a top-bar
dropdown menu with quick access. Reorganize the settings dialog for clarity
and future growth. Add new camera features (auto-exposure, gamma, ROI).
Probe camera capabilities so unsupported controls are hidden, not broken.

## Problems with current layout

1. Camera panel in the sidebar takes permanent screen real estate for controls
   used infrequently (exposure/gain adjustments happen at session start, not
   during measurement).
2. Camera settings are split between the sidebar panel (exposure, gain) and the
   settings dialog Camera tab (pixel format, white balance, camera selection).
3. Settings dialog resizes when switching tabs — feels unpolished.
4. White balance RGB sliders are shown even when the camera doesn't support
   manual white balance (Baumer via Aravis reports `wb_manual_supported: false`
   but the UI ignores it).

## Design

### 1. New "Camera" dropdown menu in the top bar

A dropdown panel following the same pattern as the existing Detect and Overlay
menus. Placed in the top bar after the Clear menu and before the freeze button.

**Layout:**

```
Camera ▾
┌──────────────────────────────┐
│ [Baumer VCXU-50M         ▾]  │  camera selector (dropdown if multiple)
│ 2592 × 1944 · [BayerRG8  ▾]  │  resolution + pixel format selector
│──────────────────────────────│
│ Exposure    ──●─────── 5000µs│  slider + live value
│ Gain        ●─────────  0.0dB│  slider + live value
│ Gamma       ───●──────  1.0  │  slider + live value (NEW)
│ [Auto Exposure]   [Auto WB]  │  one-click buttons
│──────────────────────────────│
│ White Balance                 │  section (hidden if !wb_manual)
│  R ────●─────── 1.23         │
│  G ────●─────── 1.00         │
│  B ────●─────── 1.15         │
│──────────────────────────────│
│ ROI                           │  section (hidden if !roi)
│ [Set from view]       [Reset] │
│ 2592 × 1944 (full frame)     │  shows current ROI dims
└──────────────────────────────┘
```

**Behavior:**
- Dropdown stays open while adjusting sliders (same as detect panel — existing
  "don't close on slider input" logic).
- Camera selector: `<select>` populated from `GET /cameras`. When only one
  camera, shows as plain text (no dropdown arrow). Switching cameras triggers
  the existing `/camera/select` endpoint.
- Pixel format: small `<select>` on the info line. Changing triggers the
  existing `/camera/pixel-format` endpoint.
- Auto Exposure: one-click button, calls `POST /camera/auto-exposure`. Same
  poll-until-done pattern as Auto WB.
- Auto WB: moved from settings dialog, same behavior as current.
- Gamma slider: 0.5–2.0, step 0.1, default 1.0.
- ROI "Set from view": uses current viewport visible area to set camera ROI.
  "Reset" returns to full sensor. Only shown when camera supports ROI.

**Controls hidden when unsupported:**
- Gamma slider: hidden if `supports.gamma === false`
- White Balance section: hidden if `supports.wb_manual === false`
- Auto WB button: hidden if `supports.wb_auto === false`
- Auto Exposure button: hidden if `supports.auto_exposure === false`
- ROI section: hidden if `supports.roi === false`

### 2. Remove sidebar camera panel

Delete the bottom-right camera section (`#camera-section-header`,
`#camera-section-body`, exposure/gain sliders, `#camera-info`).

The sidebar retains: measurements list, inspection panel, status bar
(live/frozen indicator), and calibration button.

This reclaims vertical space in the sidebar for the measurement list and
inspection results, which benefit from more room.

### 3. Reorganized settings dialog

**3 tabs instead of 4.** Camera tab removed (all camera controls in top bar).

**Fixed height:** `min-height: 380px` on the dialog body so tab switching
doesn't resize the dialog.

**General tab:**
- App name
- Theme

**Measurement tab** (merges old General sub-pixel settings + Tolerances):
- Tolerance warn (mm)
- Tolerance fail (mm)
- Sub-pixel method dropdown
- Snap radius slider

**Display tab:**
- Crosshair color swatches
- Crosshair opacity slider

### 4. New camera features (backend)

#### Feature probing

`get_info()` gains a `supports` dict that probes each optional GenICam feature:

```python
"supports": {
    "wb_manual": bool,    # BalanceRatioSelector readable
    "wb_auto": bool,      # BalanceWhiteAuto writable
    "auto_exposure": bool, # ExposureAuto writable
    "gamma": bool,         # Gamma readable/writable
    "roi": bool,           # OffsetX/OffsetY writable, Width/Height writable
}
```

Each probe: try to read the feature, catch exceptions → `False`. This is done
once in `get_info()`, not on every frame.

`get_info()` also returns current values for new features:
```python
"gamma": float,          # current gamma (or 1.0 if unsupported)
"roi": {                 # current ROI (or full sensor if unsupported)
    "offset_x": int,
    "offset_y": int,
    "width": int,
    "height": int,
},
"sensor_width": int,     # full sensor dimensions (for ROI reset)
"sensor_height": int,
```

#### Feature probing — extended `get_info()` details

Also probe and return dynamic ranges for slider limits:
```python
"gamma_min": float,      # from device Gamma.Min (default 0.5 if unreadable)
"gamma_max": float,      # from device Gamma.Max (default 2.0 if unreadable)
"roi_width_inc": int,    # Width increment step (e.g. 4 for Bayer alignment)
"roi_height_inc": int,   # Height increment step
```

Frontend uses these to set slider min/max and snap ROI dimensions to valid
increments rather than hardcoding ranges.

#### BaseCamera + NullCamera + OpenCVCamera updates

New methods added to `BaseCamera` with default no-op implementations so that
all camera types are safe to call through `CameraReader`:

```python
# BaseCamera (default implementations):
def set_gamma(self, value: float) -> None: pass
def get_gamma(self) -> float: return 1.0
def set_auto_exposure(self) -> float: return 0.0
def set_roi(self, offset_x, offset_y, width, height) -> None: pass
def reset_roi(self) -> None: pass
```

`NullCamera.get_info()` and `OpenCVCamera.get_info()` updated to include
`supports: { all false }` and the new fields with safe defaults.

#### Auto-exposure

```python
def set_auto_exposure(self) -> float:
    """Trigger one-shot auto-exposure. Returns new exposure value."""
    device.set_string_feature_value("ExposureAuto", "Once")
    # Poll until ExposureAuto returns to "Off" OR exposure value stabilizes
    # (some cameras don't reset to "Off" after "Once")
    prev_exp = self._cam.get_exposure_time()
    for _ in range(40):  # up to 2s
        time.sleep(0.05)
        if device.get_string_feature_value("ExposureAuto") == "Off":
            break
        cur_exp = self._cam.get_exposure_time()
        if abs(cur_exp - prev_exp) < 1.0:  # stabilized
            break
        prev_exp = cur_exp
    return self._cam.get_exposure_time()
```

New endpoint: `POST /camera/auto-exposure` → `{"exposure": float}`

#### Gamma

```python
def set_gamma(self, value: float) -> None:
    device.set_float_feature_value("Gamma", value)

def get_gamma(self) -> float:
    return float(device.get_float_feature_value("Gamma"))
```

New endpoint: `PUT /camera/gamma` with `{"value": float}` body. Debounced
on the frontend (same pattern as white balance ratio — 200ms debounce).

#### ROI

**Threading:** ROI changes require stopping and restarting the camera stream.
This MUST go through `CameraReader`, not directly on `AravisCamera`. Follow
the same pattern as `CameraReader.set_pixel_format()` in `stream.py`:

1. `CameraReader.set_roi()` stops the reader thread (`_stop.set()`, join)
2. Calls inner camera's `set_roi()` (acquisition stopped, safe)
3. Restarts the reader thread

```python
# On AravisCamera (inner camera, called while stream is stopped):
def set_roi(self, offset_x: int, offset_y: int, width: int, height: int) -> None:
    """Set camera ROI. Caller must stop acquisition first."""
    device = self._cam.get_device()
    # Reset offsets first to avoid constraint violations
    device.set_integer_feature_value("OffsetX", 0)
    device.set_integer_feature_value("OffsetY", 0)
    # Set new dimensions (snapped to increment by the API layer)
    device.set_integer_feature_value("Width", width)
    device.set_integer_feature_value("Height", height)
    device.set_integer_feature_value("OffsetX", offset_x)
    device.set_integer_feature_value("OffsetY", offset_y)

# On CameraReader (handles threading + buffer reallocation):
def set_roi(self, offset_x, offset_y, width, height) -> None:
    with self._format_lock:  # reuse existing lock (prevents concurrent changes)
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        # Inner camera set_roi (thread stopped, safe)
        self._camera.stop_acquisition()
        self._camera.set_roi(offset_x, offset_y, width, height)
        # Reallocate buffers (payload size changed, same as set_pixel_format)
        payload = self._camera._cam.get_payload()
        while self._camera._stream.try_pop_buffer() is not None:
            pass
        for _ in range(10):
            self._camera._stream.push_buffer(Aravis.Buffer.new_allocate(payload))
        self._camera._cam.start_acquisition()
        # Restart reader thread
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
```

New endpoints:
- `PUT /camera/roi` with `{"offset_x": int, "offset_y": int, "width": int, "height": int}`
  Backend snaps width/height to `roi_width_inc`/`roi_height_inc` before passing
  to the camera. Returns the actual applied ROI.
- `POST /camera/roi/reset`

After ROI change, the frontend calls `loadCameraInfo()` to update
`imageWidth`/`imageHeight` and `fitToWindow()`.

def reset_roi(self) -> None:
    """Reset ROI to full sensor."""
    self.set_roi(0, 0, sensor_width, sensor_height)
```

New endpoints:
- `PUT /camera/roi` with `{"offset_x": int, "offset_y": int, "width": int, "height": int}`
- `POST /camera/roi/reset`

**ROI and calibration:** Changing the ROI does NOT invalidate calibration.
Each pixel still covers the same physical area — the ROI just crops the
sensor. The field of view changes but pixels-per-mm stays the same.

**ROI and imageWidth:** After setting ROI, the frame dimensions change.
`loadCameraInfo()` must re-run to update `imageWidth`/`imageHeight` and
call `fitToWindow()`.

**"Set from view":** The frontend computes the ROI from the current viewport,
accounting for any existing ROI offset (since `viewport.panX/Y` is relative
to the current image, not the full sensor):

```js
const currentRoi = cameraInfo.roi;  // from latest get_info()
const widthInc = cameraInfo.roi_width_inc || 4;
const heightInc = cameraInfo.roi_height_inc || 4;

// Viewport coordinates → absolute sensor coordinates
let offset_x = Math.max(0, currentRoi.offset_x + Math.round(viewport.panX));
let offset_y = Math.max(0, currentRoi.offset_y + Math.round(viewport.panY));
let width = Math.round(canvas.clientWidth / viewport.zoom);
let height = Math.round(canvas.clientHeight / viewport.zoom);

// Snap to camera increment steps (Bayer alignment)
width = Math.max(widthInc, Math.round(width / widthInc) * widthInc);
height = Math.max(heightInc, Math.round(height / heightInc) * heightInc);
offset_x = Math.round(offset_x / widthInc) * widthInc;
offset_y = Math.round(offset_y / heightInc) * heightInc;

// Clamp to sensor bounds
offset_x = Math.min(offset_x, cameraInfo.sensor_width - width);
offset_y = Math.min(offset_y, cameraInfo.sensor_height - height);
```

The camera then only reads out that region, giving a hardware-level crop
with faster frame rate.

### 5. NullCamera handling

NullCamera returns `supports: { all false }`. The camera menu shows
"No camera" with resolution and a note. All controls are hidden. Only the
camera selector dropdown remains functional (for switching to a real camera
if one becomes available).

### 6. Frontend migration notes

**Dropdown close behavior:** The existing `closeAllDropdowns()` in `main.js`
hardcodes dropdown IDs. Add the new camera dropdown ID. The camera dropdown
must use the `.dropdown` CSS class so the existing "don't close on slider
input" logic (`if (e.target.closest(".dropdown")) return;`) applies.

**Event listener migration:** The following event listeners currently in
`main.js` (settings dialog Camera tab wiring) move to the camera dropdown
module:
- Pixel format select change handler
- White balance Auto button click
- White balance RGB slider input handlers + debounce
- Camera select change handler

The settings dialog Camera tab DOM elements are deleted from `index.html`.
The tab switching code in `main.js` is generic (queries all `.settings-tab`)
and needs no change — it just finds fewer tabs.

**Session compatibility:** The new `get_info()` fields (`supports`, `gamma`,
`roi`, etc.) are additive. Sessions don't store camera info — they store
annotations and calibration. No session format change needed.

## What this does NOT include

- Trigger mode (no current use case without motorized stage)
- Binning (useful but niche — add later if needed)
- ReverseX/Y (can add as checkboxes in the camera menu if requested)
- Frame rate control (usually auto-derived from exposure time)
