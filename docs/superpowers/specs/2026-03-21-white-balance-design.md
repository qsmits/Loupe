# White Balance Design

## Goal

Add hardware white balance control to the video microscope via the Baumer VCXU-32C camera's GenICam interface. Provide a one-shot auto button plus manual R/G/B ratio sliders in the existing Camera tab of the settings dialog.

## Approach

Hardware white balance via Aravis GenICam features — `BalanceWhiteAuto` for auto correction and `BalanceRatioSelector` + `BalanceRatio` for per-channel manual adjustment. No software image processing. On the OpenCV camera fallback, all white balance controls are no-ops (disabled in the UI, same pattern as pixel format).

## Architecture

### New camera methods

Three methods added to `BaseCamera` (abstract), `AravisCamera` (real), `OpenCVCamera` (no-op), `FakeCamera` (stub), and `CameraReader` (delegate):

- `get_white_balance() -> dict[str, float]` — returns `{"red": float, "green": float, "blue": float}`
- `set_white_balance_auto() -> dict[str, float]` — triggers auto once, returns updated ratios
- `set_white_balance_ratio(channel: str, value: float) -> None` — sets ratio for one channel

`CameraReader` does **not** need to stop/restart the reader thread for these calls. However, a `_wb_lock = threading.Lock()` must be added to `CameraReader.__init__` and used in `get_white_balance` and `set_white_balance_ratio` delegations to serialise concurrent requests — the selector-write + ratio-read sequence is not atomic, and two simultaneous requests (e.g. rapid slider events) would corrupt each other's reads.

### AravisCamera implementation

```python
import time

def get_white_balance(self) -> dict[str, float]:
    if self._cam is None:
        raise RuntimeError("Camera not open")
    device = self._cam.get_device()
    result = {}
    for ch in ("Red", "Green", "Blue"):
        device.set_string_feature_value("BalanceRatioSelector", ch)
        result[ch.lower()] = float(device.get_float_feature_value("BalanceRatio"))
    return result

def set_white_balance_auto(self) -> dict[str, float]:
    if self._cam is None:
        raise RuntimeError("Camera not open")
    device = self._cam.get_device()
    device.set_string_feature_value("BalanceWhiteAuto", "Once")
    for _ in range(20):
        time.sleep(0.05)
        if device.get_string_feature_value("BalanceWhiteAuto") == "Off":
            break
    else:
        # Polling timed out — camera did not confirm completion; log and continue
        import logging
        logging.getLogger(__name__).warning(
            "BalanceWhiteAuto did not return to 'Off' within 1 s"
        )
    return self.get_white_balance()

def set_white_balance_ratio(self, channel: str, value: float) -> None:
    if self._cam is None:
        raise RuntimeError("Camera not open")
    device = self._cam.get_device()
    device.set_string_feature_value("BalanceRatioSelector", channel)
    device.set_float_feature_value("BalanceRatio", value)
```

If the camera does not support a white balance feature (e.g. firmware omits it), Aravis raises `gi.repository.GLib.GError`. `AravisCamera` does **not** catch this — it propagates up. `CameraReader` also does not catch it. The API layer catches it as a generic `Exception` and returns HTTP 400 with a descriptive message (see API section).

### OpenCVCamera

All three methods are no-ops:

```python
def get_white_balance(self) -> dict[str, float]:
    return {"red": 1.0, "green": 1.0, "blue": 1.0}

def set_white_balance_auto(self) -> dict[str, float]:
    return {"red": 1.0, "green": 1.0, "blue": 1.0}

def set_white_balance_ratio(self, channel: str, value: float) -> None:
    pass
```

### CameraReader

Add `_wb_lock = threading.Lock()` in `__init__`. Then:

```python
def get_white_balance(self) -> dict[str, float]:
    with self._wb_lock:
        return self._camera.get_white_balance()

def set_white_balance_auto(self) -> dict[str, float]:
    # Blocking — must be called via asyncio.to_thread in the API layer
    with self._wb_lock:
        return self._camera.set_white_balance_auto()

def set_white_balance_ratio(self, channel: str, value: float) -> None:
    with self._wb_lock:
        return self._camera.set_white_balance_ratio(channel, value)
```

## API

### Validation constants (module-level in `api.py`)

```python
_VALID_WB_CHANNELS = frozenset({"Red", "Green", "Blue"})
WB_RATIO_MIN = 0.5
WB_RATIO_MAX = 2.5
```

### `GET /camera/info` — extended

Three new fields added to the existing response dict:

```json
{ ..., "wb_red": 1.2, "wb_green": 1.0, "wb_blue": 0.85 }
```

`FakeCamera.get_info()` gains `"wb_red": 1.0, "wb_green": 1.0, "wb_blue": 1.0`.

Alternatively `get_white_balance()` can be called separately, but merging into `/camera/info` avoids an extra round-trip when the dialog opens.

### `POST /camera/white-balance/auto`

Triggers auto once. Because `set_white_balance_auto` blocks (up to 1 s of polling), this endpoint must use `asyncio.to_thread`:

```python
@router.post("/camera/white-balance/auto")
async def auto_white_balance():
    try:
        ratios = await asyncio.to_thread(camera.set_white_balance_auto)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ratios
```

Response: `{"red": float, "green": float, "blue": float}`

### `PUT /camera/white-balance/ratio`

Pydantic body model:

```python
class WhiteBalanceRatioBody(BaseModel):
    channel: str
    value: float
```

```python
@router.put("/camera/white-balance/ratio")
async def set_wb_ratio(body: WhiteBalanceRatioBody):
    if body.channel not in _VALID_WB_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Invalid channel: {body.channel}")
    if not (WB_RATIO_MIN <= body.value <= WB_RATIO_MAX):
        raise HTTPException(status_code=400,
            detail=f"Value must be between {WB_RATIO_MIN} and {WB_RATIO_MAX}")
    try:
        camera.set_white_balance_ratio(body.channel, body.value)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}
```

## Frontend

### HTML additions (`frontend/index.html`, Camera tab)

Below the pixel format row, inside `#settings-camera-panel`:

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

### JavaScript (`frontend/app.js`)

**Initialisation** — in `loadCameraInfo()`, after pixel format init:

```js
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

**Auto WB button:**

```js
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

Note: `fmtStatusEl` was renamed from `statusEl` in the previous task — it references `#settings-status`.

**Slider handlers** — debounced at 150 ms to avoid flooding the backend:

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
          body: JSON.stringify({ channel: ch.charAt(0).toUpperCase() + ch.slice(1), value: val }),
        });
      } catch (err) {
        console.error("WB ratio update failed:", err);
      }
    }, 150);
  });
});
```

## Files changed

| File | Change |
|------|--------|
| `backend/cameras/base.py` | 3 new abstract methods |
| `backend/cameras/aravis.py` | 3 new implementations; `import time` |
| `backend/cameras/opencv.py` | 3 no-op implementations |
| `backend/stream.py` | `_wb_lock`; 3 delegation methods on `CameraReader` |
| `backend/api.py` | `_VALID_WB_CHANNELS`, `WB_RATIO_MIN/MAX`, `WhiteBalanceRatioBody`; extend `/camera/info`; `POST /camera/white-balance/auto`; `PUT /camera/white-balance/ratio` |
| `tests/conftest.py` | `FakeCamera`: 3 stub methods; `get_info()` gains `wb_*` fields |
| `tests/test_cameras.py` | Tests for `OpenCVCamera` no-ops and `CameraReader` delegation |
| `tests/test_api.py` | Tests for new endpoints and extended `/camera/info` |
| `frontend/index.html` | White balance rows in Camera tab |
| `frontend/app.js` | WB init in `loadCameraInfo()`, Auto WB handler, debounced slider handlers |

## Testing

All tests in `tests/` (no hardware required):

- `test_opencv_camera_get_white_balance_returns_ones`
- `test_opencv_camera_set_white_balance_ratio_is_noop`
- `test_opencv_camera_set_white_balance_auto_returns_ones`
- `test_camera_reader_delegates_white_balance_methods` — uses inline `MinimalFake` with all methods; verifies delegation without raising
- `test_camera_reader_wb_ratio_calls_inner_camera` — uses `MagicMock(spec=["open", "close", "get_frame", "set_exposure", "set_gain", "get_info", "set_pixel_format", "get_white_balance", "set_white_balance_auto", "set_white_balance_ratio"])`, asserts `set_white_balance_ratio` called with correct args
- `test_camera_info_includes_wb_fields` — `/camera/info` response has `wb_red`, `wb_green`, `wb_blue`
- `test_auto_white_balance` — `POST /camera/white-balance/auto` returns dict with `red/green/blue` floats
- `test_set_white_balance_ratio` — `PUT` with valid channel+value returns `{"ok": true}`
- `test_set_white_balance_ratio_invalid_channel` — returns 400
- `test_set_white_balance_ratio_out_of_range` — value < 0.5 or > 2.5 returns 400

No automated tests for `AravisCamera` (requires hardware).
