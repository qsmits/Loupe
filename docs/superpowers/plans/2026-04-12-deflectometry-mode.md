# Deflectometry Mode v1 — Implementation Plan

> **For agentic workers:** This plan is built so each top-level task can be
> handed to a fresh subagent in isolation. The Protocol section below is the
> contract every component must match; keep it in sync if you change it.

**Goal:** Add a deflectometry workflow (new toolbar button + dialog + backend
router + iPad-as-display WebSocket) that captures 4-phase-shifted sinusoidal
fringe patterns reflected off a specular part and outputs wrapped/unwrapped
phase maps plus PV/RMS statistics.

**Architecture:** Follows the existing z-stack/super-res/stitch wizard pattern:
per-router in-memory session state, rejected in hosted mode, dialog built
programmatically in JS. NEW: introduces the first FastAPI WebSocket in the
codebase, used only between the backend and the iPad browser page (not the
main UI).

**Tech:** NumPy, OpenCV (for PNG encode + colormap), FastAPI WebSocket, vanilla
JS canvas 2D. No new third-party dependencies.

---

## Protocol (contract between components)

### HTTP endpoints (all under router prefix `/deflectometry`)

```
POST /deflectometry/start
  body: {}
  response: {
    session_id: str,             // uuid4 hex
    pairing_url: str,            // "/deflectometry-screen.html?session=<id>"
    ipad_connected: bool,        // always false at start
  }

GET /deflectometry/status
  response: {
    session_id: str | null,      // null if no session started
    ipad_connected: bool,
    captured_count: int,         // 0..8
    has_result: bool,
    last_result: {
      phase_x_png_b64: str,      // pseudocolor PNG, base64 (no prefix)
      phase_y_png_b64: str,
      stats_x: {pv: float, rms: float, mean: float},  // radians
      stats_y: {pv: float, rms: float, mean: float},
    } | null,
  }

POST /deflectometry/capture-sequence
  body: {freq: int = 16}         // cycles across canvas dimension
  response: {captured_count: 8}
  errors:
    400 if no session / ipad_connected == false
    503 if ack timeout (2s per pattern)

POST /deflectometry/compute
  body: {}
  response: same shape as status.last_result
  errors: 400 if captured_count < 8

POST /deflectometry/reset
  body: {}
  response: {}
```

### WebSocket `/deflectometry/ws/{session_id}`

Backend → iPad (JSON text frames):
```
{type: "pattern", pattern_id: int, freq: int, phase: float, orientation: "x"|"y"}
{type: "solid",   pattern_id: int, value: int}   // 0..255 — for flat-field future use
{type: "clear",   pattern_id: int}               // show mid-gray 128
```

iPad → Backend:
```
{type: "hello", session_id: str}                 // sent once on connect
{type: "ack",   pattern_id: int}                 // sent after canvas render
```

### Fringe math (must match on both sides to within rounding)

- `orientation == "x"` → `I(x,y) = 127 + 127·cos(2π·freq·x/width + phase)`
- `orientation == "y"` → `I(x,y) = 127 + 127·cos(2π·freq·y/height + phase)`
- Clamp to `[0, 255]`, cast to `uint8`.
- `phase` is in radians.

### Capture sequence order

```
[(x, 0), (x, π/2), (x, π), (x, 3π/2),
 (y, 0), (y, π/2), (y, π), (y, 3π/2)]
```

Frames stored in that order. Phase extraction for orientation `o`:
```
wrapped_o = atan2(I3 - I1, I0 - I2)      # shape (H,W), [-π, π]
```

Unwrap: `np.unwrap` along the axis the phase varies
(`axis=1` for `"x"`, `axis=0` for `"y"`).

Stats: `pv = ptp`, `rms = sqrt(mean((u - mean(u))**2))`, `mean = mean(u)`.

### Pseudocolor PNG

Normalize unwrapped phase to `[0, 255]` via min/max, apply `cv2.COLORMAP_VIRIDIS`,
encode with `cv2.imencode(".png", ...)`, base64 encode the bytes — **without**
a `data:` prefix. The frontend adds `"data:image/png;base64,"` itself.

---

## Task 1: Backend pure compute + tests (`backend/vision/deflectometry.py`)

**Files:**
- Create: `backend/vision/deflectometry.py`
- Create: `tests/test_deflectometry.py`

### Public API

```python
import numpy as np

def generate_fringe_pattern(
    width: int, height: int,
    phase: float, freq: int, orientation: str,  # "x" | "y"
) -> np.ndarray:
    """Return an (H, W) uint8 sinusoidal fringe image.

    I(x,y) = 127 + 127·cos(2π·freq·coord/extent + phase), clamped.
    `orientation="x"` varies along axis 1 (width), making vertical stripes;
    `"y"` varies along axis 0, making horizontal stripes.
    """

def compute_wrapped_phase(frames4: list[np.ndarray]) -> np.ndarray:
    """4-step phase extraction: atan2(I3 - I1, I0 - I2). Input frames may
    be uint8 or float; output is float64 in [-π, π]. Frames can be
    multi-channel; if so, they're converted to grayscale via mean over
    the channel axis before extraction."""

def unwrap_phase(wrapped: np.ndarray, orientation: str) -> np.ndarray:
    """np.unwrap along the axis the phase varies. `orientation="x"` →
    axis=1; `"y"` → axis=0."""

def phase_stats(unwrapped: np.ndarray) -> dict:
    """Return {'pv': float, 'rms': float, 'mean': float} in the unit
    of `unwrapped` (radians, typically). RMS is about the mean."""

def pseudocolor_png_b64(unwrapped: np.ndarray) -> str:
    """Normalize to [0,255], apply cv2 viridis colormap, PNG-encode,
    return base64 string (no 'data:' prefix)."""
```

### TDD steps

1. Write the failing tests first in `tests/test_deflectometry.py`:

```python
import math
import numpy as np
from backend.vision.deflectometry import (
    generate_fringe_pattern, compute_wrapped_phase, unwrap_phase,
    phase_stats, pseudocolor_png_b64,
)

def test_generate_fringe_pattern_x_is_sinusoidal():
    img = generate_fringe_pattern(64, 32, phase=0.0, freq=2, orientation="x")
    assert img.shape == (32, 64)
    assert img.dtype == np.uint8
    # Along any row, expect cos(2π·2·x/64) — first sample 255, quarter-period minimum
    row = img[10].astype(np.float32)
    assert row[0] == 255                          # cos(0) = 1 → 127+127 = 254, allow off-by-1
    # Two full cycles across the 64-pixel width, so minima at x = 16, 48
    assert row[16] <= 1
    assert row[48] <= 1

def test_generate_fringe_pattern_y_varies_along_axis_0():
    img = generate_fringe_pattern(64, 32, phase=0.0, freq=1, orientation="y")
    # Every row at fixed y must be constant (varies along y only)
    assert np.all(img[0] == img[0, 0])
    assert np.all(img[15] == img[15, 0])

def test_four_phase_extraction_recovers_known_phase():
    H, W = 16, 32
    true_phase = np.linspace(-2.5, 2.5, W)[None, :].repeat(H, 0)  # ramp in x
    amplitude = 100.0
    offset = 127.0
    frames = [offset + amplitude * np.cos(true_phase + k * np.pi / 2)
              for k in range(4)]
    wrapped = compute_wrapped_phase(frames)
    # atan2(sin, cos) recovers phase wrapped to [-π, π]. The true ramp already
    # fits inside (-π, π), so equality is exact up to float noise.
    assert wrapped.shape == (H, W)
    np.testing.assert_allclose(wrapped, true_phase, atol=1e-6)

def test_unwrap_removes_2pi_jumps_along_x():
    H, W = 8, 64
    true_phase = np.linspace(0, 6 * np.pi, W)[None, :].repeat(H, 0)
    wrapped = np.angle(np.exp(1j * true_phase))
    unwrapped = unwrap_phase(wrapped, orientation="x")
    # Unwrapped should match true phase up to a constant offset per row
    diff = unwrapped - true_phase
    per_row_offset = diff[:, :1]
    np.testing.assert_allclose(diff, per_row_offset, atol=1e-9)

def test_phase_stats_on_ramp():
    u = np.linspace(0.0, 10.0, 101)
    s = phase_stats(u)
    assert abs(s["pv"] - 10.0) < 1e-9
    assert abs(s["mean"] - 5.0) < 1e-9
    assert s["rms"] > 0

def test_pseudocolor_png_b64_decodes_to_png():
    import base64
    u = np.random.default_rng(0).normal(size=(24, 24))
    b64 = pseudocolor_png_b64(u)
    blob = base64.b64decode(b64)
    assert blob.startswith(b"\x89PNG\r\n\x1a\n")
```

2. Run tests → all should fail with ImportError first.
3. Implement `backend/vision/deflectometry.py` using the signatures above.
   - `generate_fringe_pattern`: meshgrid + cos + clamp + astype(uint8).
   - `compute_wrapped_phase`: stack to (4, H, W) float, grayscale reduce if
     4-D, then `np.arctan2(I3 - I1, I0 - I2)`.
   - `unwrap_phase`: `np.unwrap(wrapped, axis=1 if orientation=="x" else 0)`.
   - `phase_stats`: straight numpy.
   - `pseudocolor_png_b64`: min/max normalize → `cv2.applyColorMap(...,
     cv2.COLORMAP_VIRIDIS)` → `cv2.imencode(".png", ...)` →
     `base64.b64encode(...).decode()`.
4. Run tests → all green.

---

## Task 2: Backend API router (`backend/api_deflectometry.py`)

**Files:**
- Create: `backend/api_deflectometry.py`
- Modify: `backend/api.py` (add one line to compose the router)
- Create: `tests/test_deflectometry_api.py`

### Shape

```python
import asyncio, base64, uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .cameras import BaseCamera
from .vision.deflectometry import (
    generate_fringe_pattern, compute_wrapped_phase, unwrap_phase,
    phase_stats, pseudocolor_png_b64,
)

def _reject_hosted(request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Deflectometry is not available in hosted mode")

class _Session:
    def __init__(self, sid: str):
        self.id = sid
        self.ws: Optional[WebSocket] = None
        self.pending_acks: dict[int, asyncio.Event] = {}
        self.frames: list = []         # list[np.ndarray] in capture order
        self.last_result: Optional[dict] = None

def make_deflectometry_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter(dependencies=[Depends(_reject_hosted)])
    state: dict = {"session": None}   # single active session

    class StartBody(BaseModel):
        pass
    class CaptureBody(BaseModel):
        freq: int = 16

    @router.post("/deflectometry/start")
    async def start(body: StartBody):
        sid = uuid.uuid4().hex
        state["session"] = _Session(sid)
        return {
            "session_id": sid,
            "pairing_url": f"/deflectometry-screen.html?session={sid}",
            "ipad_connected": False,
        }

    @router.get("/deflectometry/status")
    async def status():
        s = state["session"]
        if s is None:
            return {"session_id": None, "ipad_connected": False,
                    "captured_count": 0, "has_result": False, "last_result": None}
        return {
            "session_id": s.id,
            "ipad_connected": s.ws is not None,
            "captured_count": len(s.frames),
            "has_result": s.last_result is not None,
            "last_result": s.last_result,
        }

    @router.post("/deflectometry/reset")
    async def reset():
        s = state["session"]
        if s is not None:
            s.frames = []
            s.last_result = None
        return {}

    @router.websocket("/deflectometry/ws/{session_id}")
    async def ws(websocket: WebSocket, session_id: str):
        # Hosted check is not applied to WebSocket routes via the router
        # dependency — do an explicit check here.
        if getattr(websocket.app.state, "hosted", False):
            await websocket.close(code=1008)
            return
        s = state["session"]
        if s is None or s.id != session_id:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        s.ws = websocket
        try:
            while True:
                msg = await websocket.receive_json()
                if msg.get("type") == "ack":
                    pid = int(msg["pattern_id"])
                    ev = s.pending_acks.get(pid)
                    if ev is not None:
                        ev.set()
                elif msg.get("type") == "hello":
                    pass  # already recorded via ws = websocket
        except WebSocketDisconnect:
            pass
        finally:
            if s.ws is websocket:
                s.ws = None

    async def _push_and_wait(s, payload, timeout_s=2.0, settle_s=0.12):
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")
        pid = int(payload["pattern_id"])
        ev = asyncio.Event()
        s.pending_acks[pid] = ev
        try:
            await s.ws.send_json(payload)
            try:
                await asyncio.wait_for(ev.wait(), timeout=timeout_s)
            except asyncio.TimeoutError:
                raise HTTPException(503, detail=f"iPad ack timeout (pattern {pid})")
        finally:
            s.pending_acks.pop(pid, None)
        await asyncio.sleep(settle_s)

    @router.post("/deflectometry/capture-sequence")
    async def capture_sequence(body: CaptureBody):
        import math
        s = state["session"]
        if s is None:
            raise HTTPException(400, detail="No session")
        if s.ws is None:
            raise HTTPException(400, detail="iPad not connected")
        s.frames = []
        phases = [0.0, math.pi / 2, math.pi, 3 * math.pi / 2]
        pid = 0
        for orientation in ("x", "y"):
            for phase in phases:
                pid += 1
                await _push_and_wait(s, {
                    "type": "pattern",
                    "pattern_id": pid,
                    "freq": int(body.freq),
                    "phase": float(phase),
                    "orientation": orientation,
                })
                frame = camera.capture()
                if frame is None:
                    raise HTTPException(500, detail="Camera capture returned None")
                s.frames.append(frame.copy())
        return {"captured_count": len(s.frames)}

    @router.post("/deflectometry/compute")
    async def compute():
        import numpy as np
        s = state["session"]
        if s is None or len(s.frames) < 8:
            raise HTTPException(400, detail="Need 8 captured frames before compute")
        frames_x = [np.asarray(f, dtype=np.float64).mean(axis=-1)
                    if f.ndim == 3 else np.asarray(f, dtype=np.float64)
                    for f in s.frames[:4]]
        frames_y = [np.asarray(f, dtype=np.float64).mean(axis=-1)
                    if f.ndim == 3 else np.asarray(f, dtype=np.float64)
                    for f in s.frames[4:]]
        wrap_x = compute_wrapped_phase(frames_x)
        wrap_y = compute_wrapped_phase(frames_y)
        unw_x = unwrap_phase(wrap_x, orientation="x")
        unw_y = unwrap_phase(wrap_y, orientation="y")
        result = {
            "phase_x_png_b64": pseudocolor_png_b64(unw_x),
            "phase_y_png_b64": pseudocolor_png_b64(unw_y),
            "stats_x": phase_stats(unw_x),
            "stats_y": phase_stats(unw_y),
        }
        s.last_result = result
        return result

    return router
```

### Wire into `backend/api.py`

Add next to the existing wizard router lines (currently z-stack / stitch /
superres around lines 85–88):

```python
from .api_deflectometry import make_deflectometry_router
# ...
composed.include_router(make_deflectometry_router(camera))
```

### API tests (`tests/test_deflectometry_api.py`)

```python
def test_deflectometry_start_returns_pairing_url(client):
    r = client.post("/deflectometry/start", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["ipad_connected"] is False
    assert body["pairing_url"].startswith("/deflectometry-screen.html?session=")
    assert body["session_id"] in body["pairing_url"]

def test_deflectometry_status_when_no_session(client):
    # Fresh app — reset router state by reimporting or calling reset
    client.post("/deflectometry/reset", json={})
    r = client.get("/deflectometry/status")
    assert r.status_code == 200
    # Fine for this to report either "no session" or a reset session

def test_deflectometry_capture_requires_ipad(client):
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/capture-sequence", json={"freq": 16})
    assert r.status_code == 400
    assert "iPad" in r.json()["detail"]

def test_deflectometry_compute_requires_frames(client):
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/compute", json={})
    assert r.status_code == 400

def test_deflectometry_rejected_in_hosted_mode(monkeypatch):
    from backend.main import create_app
    from fastapi.testclient import TestClient
    from tests.conftest import FakeCamera
    monkeypatch.setenv("HOSTED", "1")
    app = create_app(FakeCamera())
    with TestClient(app) as c:
        r = c.post("/deflectometry/start", json={})
        assert r.status_code == 403
```

(If `FakeCamera` isn't importable directly from conftest, inline a trivial
fake returning a fixed ndarray — whatever is simplest.)

---

## Task 3: iPad screen page (`frontend/deflectometry-screen.html`)

**File:** Create `frontend/deflectometry-screen.html` (single file, inline
CSS + inline JS, no external dependencies beyond the WebSocket API).

### Requirements

- `<!DOCTYPE html>` + iOS PWA meta tags:
  - `<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
- Body CSS: `margin: 0; background: #000; overflow: hidden;
  touch-action: none; -webkit-user-select: none; user-select: none;`
- Also `pointer-events: none` on the canvas so accidental touches do
  nothing (the WebSocket's still alive regardless).
- Canvas sized to `window.innerWidth × window.innerHeight` in CSS pixels,
  but with its backing-store resolution set to `devicePixelRatio ×
  innerWidth/Height` so the fringes are drawn at real device pixels.
- Read `?session=...` from `location.search`. If missing, render a
  "NO SESSION" message and stop.
- Open WebSocket to `ws(s)://<host>/deflectometry/ws/<session_id>`.
  Use `wss` if `location.protocol === "https:"`, else `ws`.
- Send `{type: "hello", session_id}` on open.
- On message:
  - `"pattern"` → render `I(x,y) = 127 + 127·cos(2π·freq·coord/extent + phase)`
    with `orientation` picking the axis. Use `ImageData` with a flat
    Uint8ClampedArray for speed.
  - `"solid"`  → fill with `value` (grayscale level 0–255).
  - `"clear"`  → fill with 128.
- After each render, use `requestAnimationFrame(() => { ws.send({type:
  "ack", pattern_id}); })` so the ack is deferred until *after* the
  browser has composited the frame.
- On `resize`, re-size the canvas (rarely matters on iOS but still).
- On WebSocket close or error, show a subtle status message centered on
  the canvas ("reconnecting…") and retry every 2s.

### Optional polish (if trivial)

- A tiny top-right "session: abc123" label drawn in dim gray (opacity 0.2)
  so you can visually confirm you're connected to the right session.
  Ignored by the measurement (dim enough that it's below the fringe
  contrast floor).

---

## Task 4: Measurement-PC dialog (`frontend/deflectometry.js`)

**Files:**
- Create: `frontend/deflectometry.js`
- Modify: `frontend/main.js` (add import + call `initDeflectometry()`)
- Modify: `frontend/index.html` (add `<button id="btn-deflectometry"
  class="top-btn">Deflect</button>` next to `#btn-zstack`)

### Behavior

Pattern mirrors `frontend/zstack.js`'s `openZstackDialog` / `buildDialog`
structure — build dialog DOM on first open, then show.

```js
// frontend/deflectometry.js
import { apiFetch } from './main.js';   // or wherever apiFetch lives — check zstack.js

let dlg = null;
let poller = null;
const df = { sessionId: null, pairingUrl: null, ipadConnected: false };

function buildDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("div");
  dlg.className = "dialog-overlay";
  dlg.hidden = true;
  dlg.innerHTML = /* html */`
    <div class="dialog-content" style="max-width:980px;width:92vw;max-height:90vh">
      <div class="dialog-header">
        <span class="dialog-title">Deflectometry</span>
        <button class="dialog-close" type="button">✕</button>
      </div>
      <div style="padding:14px 18px;overflow:auto">
        <div id="df-pair-row" style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
          <label>Pair iPad:</label>
          <code id="df-pair-url" style="flex:1;padding:6px 10px;background:var(--surface-2);border-radius:4px"></code>
          <button id="df-copy" class="settings-save-btn" type="button">Copy</button>
          <span id="df-ipad-status">iPad: <b style="color:#f87">disconnected</b></span>
        </div>
        <div style="display:flex;gap:14px;margin-bottom:14px">
          <label>Freq (cycles across screen):
            <input id="df-freq" type="number" value="16" min="2" max="64" style="width:70px">
          </label>
          <button id="df-capture" class="settings-save-btn" type="button">Capture Sequence</button>
          <button id="df-compute" class="settings-save-btn" type="button">Compute</button>
          <button id="df-reset" class="settings-save-btn" type="button">Reset</button>
        </div>
        <div id="df-progress" style="margin-bottom:14px;color:var(--muted)"></div>
        <div id="df-result" style="display:none">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <figure style="margin:0">
              <figcaption>Phase X (vertical fringes)</figcaption>
              <img id="df-img-x" style="width:100%;border:1px solid var(--border)">
              <pre id="df-stats-x" style="font-size:12px"></pre>
            </figure>
            <figure style="margin:0">
              <figcaption>Phase Y (horizontal fringes)</figcaption>
              <img id="df-img-y" style="width:100%;border:1px solid var(--border)">
              <pre id="df-stats-y" style="font-size:12px"></pre>
            </figure>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  dlg.querySelector(".dialog-close").addEventListener("click", closeDialog);
  dlg.querySelector("#df-copy").addEventListener("click", onCopy);
  dlg.querySelector("#df-capture").addEventListener("click", onCapture);
  dlg.querySelector("#df-compute").addEventListener("click", onCompute);
  dlg.querySelector("#df-reset").addEventListener("click", onReset);
  return dlg;
}

async function openDeflectometryDialog() {
  buildDialog();
  dlg.hidden = false;
  // If no session exists yet, start one
  const status = await (await apiFetch("/deflectometry/status")).json();
  if (!status.session_id) {
    const r = await (await apiFetch("/deflectometry/start", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: "{}",
    })).json();
    df.sessionId = r.session_id;
    df.pairingUrl = r.pairing_url;
  } else {
    df.sessionId = status.session_id;
    df.pairingUrl = `/deflectometry-screen.html?session=${status.session_id}`;
    if (status.last_result) renderResult(status.last_result);
  }
  const abs = location.origin + df.pairingUrl;
  dlg.querySelector("#df-pair-url").textContent = abs;
  startPolling();
}

function closeDialog() {
  dlg.hidden = true;
  stopPolling();
}

function startPolling() {
  stopPolling();
  poller = setInterval(async () => {
    try {
      const s = await (await apiFetch("/deflectometry/status")).json();
      df.ipadConnected = s.ipad_connected;
      const el = dlg.querySelector("#df-ipad-status");
      el.innerHTML = `iPad: <b style="color:${s.ipad_connected ? '#7f7' : '#f87'}">${s.ipad_connected ? 'connected' : 'disconnected'}</b>`;
    } catch (e) { /* ignore transient */ }
  }, 1000);
}

function stopPolling() {
  if (poller) { clearInterval(poller); poller = null; }
}

function onCopy() {
  const url = dlg.querySelector("#df-pair-url").textContent;
  navigator.clipboard?.writeText(url);
}

async function onCapture() {
  const freq = parseInt(dlg.querySelector("#df-freq").value, 10) || 16;
  dlg.querySelector("#df-progress").textContent = "Capturing 8 frames…";
  try {
    const r = await apiFetch("/deflectometry/capture-sequence", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({freq}),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    const j = await r.json();
    dlg.querySelector("#df-progress").textContent = `Captured ${j.captured_count}/8. Click Compute.`;
  } catch (e) {
    dlg.querySelector("#df-progress").textContent = `Capture failed: ${e.message}`;
  }
}

async function onCompute() {
  dlg.querySelector("#df-progress").textContent = "Computing…";
  try {
    const r = await apiFetch("/deflectometry/compute", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: "{}",
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    renderResult(await r.json());
    dlg.querySelector("#df-progress").textContent = "Done.";
  } catch (e) {
    dlg.querySelector("#df-progress").textContent = `Compute failed: ${e.message}`;
  }
}

async function onReset() {
  await apiFetch("/deflectometry/reset", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: "{}",
  });
  dlg.querySelector("#df-result").style.display = "none";
  dlg.querySelector("#df-progress").textContent = "Reset.";
}

function renderResult(res) {
  dlg.querySelector("#df-img-x").src = `data:image/png;base64,${res.phase_x_png_b64}`;
  dlg.querySelector("#df-img-y").src = `data:image/png;base64,${res.phase_y_png_b64}`;
  const fmt = s => `PV: ${s.pv.toFixed(3)} rad\nRMS: ${s.rms.toFixed(3)} rad\nMean: ${s.mean.toFixed(3)} rad`;
  dlg.querySelector("#df-stats-x").textContent = fmt(res.stats_x);
  dlg.querySelector("#df-stats-y").textContent = fmt(res.stats_y);
  dlg.querySelector("#df-result").style.display = "block";
}

export function initDeflectometry() {
  const btn = document.getElementById("btn-deflectometry");
  if (btn) btn.addEventListener("click", openDeflectometryDialog);
}
```

Notes:
- If `apiFetch` lives in a different module (check `frontend/zstack.js` imports to confirm), adjust the import.
- The `settings-save-btn` CSS class is used for buttons elsewhere in the UI (see `frontend/gear.js`); reuse it for visual consistency.
- Only reasonable CSS class invention: `.dialog-overlay`, `.dialog-content`, `.dialog-header`, `.dialog-title`, `.dialog-close` — all already defined in `frontend/style.css`.

### Wire

- `frontend/main.js`: add `import { initDeflectometry } from './deflectometry.js';`
  and call `initDeflectometry()` in the same place `initZstack()` / `initStitch()` / `initSuperRes()` are called (~line 1267).
- `frontend/index.html`: add `<button id="btn-deflectometry" class="top-btn">Deflect</button>` right next to `#btn-zstack`.

---

## Task 5: Final checks

1. Run `./venv/bin/pytest tests/ -q` — all tests must still pass, plus the
   new deflectometry tests.
2. Manually sanity-check the server starts: `NO_CAMERA=1 .venv/bin/python -m
   uvicorn backend.main:app --host 127.0.0.1 --port 8000` then `curl -s
   http://127.0.0.1:8000/deflectometry/status` should return 200.
3. Commit in logical chunks:
   - `feat(deflectometry): pure compute module + tests` (Task 1)
   - `feat(deflectometry): API router with iPad WebSocket` (Task 2 + wiring)
   - `feat(deflectometry): iPad screen page + measurement dialog` (Tasks 3 + 4)

---

## What's deliberately NOT in v1

- Height map reconstruction (slope integration). Phase maps alone prove
  the pipeline works.
- Physical calibration (rad → mm/µm). Phase stats reported in radians.
- Reference-flat subtraction for absolute flatness.
- 3D viewer.
- Multi-frequency phase unwrap (only 1D scanline unwrap for now).
- WebSocket integration test. Manual testing is cheaper at this stage.

Roadmap these for v2 once the v1 bench prototype is validating flat
parts correctly.
