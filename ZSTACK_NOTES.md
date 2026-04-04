# 3D Z-Stack (Depth-from-Focus) — Implementation Notes

Manual focus-stacking workflow inspired by the Keyence VHX-900 "3D" mode.
The user collects N frames while manually turning the Z knob by a fixed
step between captures; the backend builds an all-in-focus composite plus
a height map.

## Files touched

### New
- `backend/vision/focus_stack.py` — core depth-from-focus algorithm.
- `backend/api_zstack.py` — `/zstack/*` HTTP endpoints.
- `frontend/zstack.js` — UI state machine + modal dialog.
- `tests/test_zstack.py` — unit + HTTP-level tests (5 tests).

### Modified
- `backend/api.py` — includes `make_zstack_router(camera)` in the composed router.
- `frontend/index.html` — adds `#btn-zstack` ("3D") in the top bar next to Freeze.
- `frontend/main.js` — imports and calls `initZstack()`.

## Algorithm (focus_stack.py)

Per pixel, pick the frame whose |Laplacian|² (box-filtered over a 9×9
window) is largest. Standard variance-of-Laplacian sharpness measure
(Pech-Pacheco et al. 2000). The resulting index map is median-filtered
to knock out isolated spikes, then converted to a Z map via
`z0 + index * z_step`. Composite image is built by gather-indexing the
stacked frames along axis 0 with the index map. Height-map visualisation
uses OpenCV's built-in `COLORMAP_VIRIDIS` — no matplotlib dependency.

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/zstack/start` | Begin a fresh session (clears any prior stack) |
| POST | `/zstack/capture` | Grab current camera frame, append to stack |
| GET  | `/zstack/status` | Current count + whether a result exists |
| POST | `/zstack/compute` | Body `{ z_step_mm, z0_mm? }` — run focus stacking |
| GET  | `/zstack/composite.png` | All-in-focus composite PNG |
| GET  | `/zstack/heightmap.png` | Viridis-colorised height map PNG |
| POST | `/zstack/reset` | Discard current session |

One active stack at a time, guarded by a threading lock. Everything is
in-memory; nothing is persisted. Max 64 frames per stack; compute
requires ≥3 frames.

## How to test manually

1. `./server.sh restart` (or `NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --port 8000`).
2. Open `http://localhost:8000`.
3. Click the **3D** button (top bar, left of ❄ Live).
4. Set a Z step (default 0.05 mm).
5. Turn the microscope Z knob to the lowest interesting focus plane,
   click **Capture frame**.
6. Move Z up by the displayed step, click **Capture frame** again.
   Repeat 10–15 times covering the full feature depth range.
7. Click **Build height map** → composite + colorised depth map appear
   side by side with min/max Z labels and per-image download buttons.
8. Click **Use composite as working image** to push the sharp composite
   into the frozen background so Distance / Circle / etc. operate on it.

Smoke test without a camera: the FakeCamera in `tests/conftest.py`
returns a solid colour, so the HTTP test (`test_zstack_http_workflow`)
exercises the full pipeline end-to-end even though there's no real
focus gradient.

## Test status

`.venv/bin/pytest tests/` → **229 passed, 1 skipped** (was 224+1; added
5 new tests in `test_zstack.py`, no regressions).

## Known limitations / follow-ups

- **Uniform Z step assumption**: all frames are assumed to be at
  regular intervals. A per-frame Z entry would let the user recover
  from a mis-step without restarting.
- **No scale normalisation between frames**: microscope magnification
  can shift slightly as focus changes ("focus breathing"). A pre-align
  pass (ECC or phase correlation) would improve edge sharpness in the
  composite; out of scope for v1.
- **No depth refinement**: picks the exact frame index rather than
  parabolic-fitting the three frames around the focus peak. Sub-frame
  refinement would give smoother height maps for future 3D rendering.
- **No 3D view**: height map is 2D colorised only. A WebGL/CSS 3D
  surface view would be a natural next step (requires a new frontend
  module, not a new backend dep).
- **In-memory only**: server restart loses the current stack. Save/
  restore would need a new endpoint and a disk format.
- **No capture debounce**: rapid double-clicks of Capture will grab
  two identical frames from the same focus plane. The user can just
  reset, but a short cooldown would be friendlier.
- **Composite upload round-trip**: "Use composite as working image"
  re-uploads the PNG through `/load-image`. It would be cleaner to
  add a dedicated `/zstack/use-as-frame` endpoint that copies the
  composite directly into the session frame store server-side.
