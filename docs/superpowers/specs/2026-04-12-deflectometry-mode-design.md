# Deflectometry Mode — Design Spec (v1)

**Status:** approved 2026-04-12
**Scope:** initial version (hello-world, bench prototype), not production polish

## Goal

Add phase-measuring deflectometry as a self-contained workflow (dialog +
backend router) alongside the existing Z-stack, super-res, and stitching
wizards. Let a user measure the shape of a flat specular part (hello-world
target: a visibly-bent 0.1 mm gage block) using the microscope camera, a
spare iPad as a network-attached fringe display, and a cardboard-box
enclosure.

This is explicitly **not** the full instrument-mode refactor — that's
reserved for when the Nikon autocollimator arrives, which will establish
the mode-replacement pattern. Deflectometry v1 is a workflow, launched
from a toolbar button, that coexists with microscope mode like z-stack
and super-res do.

## Applicability bounds

- **Works on:** near-specular surfaces, Ra ≲ 50 nm. Lapped gage blocks,
  shim stock, feeler gauges, polished stampings, thin optical windows.
- **Does not work on:** surface-ground, machined, or any matte finish.
  Those parts should use the existing z-stack depth-from-focus workflow.
- **Feature gating:** rejected in hosted mode (like z-stack/super-res/
  stitch), because the capture hardware is strictly local.

## Architecture

### Physical setup (user-built)

- Cardboard-box enclosure, interior spray-painted matte black
- Bottom of box: part face-up on a flat reference surface
- Top of box: two 3D-printed mounts
  - One holds the iPad at a fixed angle and distance from the part
  - One holds the microscope camera at a symmetric angle and distance
- Camera and iPad are mirrored across the vertical through the part center;
  the iPad's reflection in the part must fully fill the camera's view of
  the part
- Target angle: ~20° from vertical for both camera and iPad (→ 40° between
  them); this is the v1 default and can be refined later
- Target working distance: set by the lens (TEC-55 is the bench candidate);
  iPad distance should roughly match so the reflected iPad image in the
  camera view is near 1:1 with the part image

### Backend (`backend/`)

- **`vision/deflectometry.py`** — pure computation, no Loupe state:
  - `generate_fringe_pattern(width, height, phase_rad, freq_cycles, orientation)` → `np.ndarray` (uint8 grayscale)
  - `compute_wrapped_phase(frames4)` → `np.ndarray` (radians, [-π, π]), 4-step phase shift
  - `unwrap_phase_1d(wrapped)` → `np.ndarray` (axis=1 scanline unwrap as v1; skimage not imported yet)
  - `phase_stats(unwrapped)` → `dict(pv, rms, mean)` in radians
- **`api_deflectometry.py`** — FastAPI router following the z-stack pattern:
  - `make_deflectometry_router(camera) -> APIRouter`
  - `Depends(_reject_hosted)` on the router
  - In-memory session state in closure (single active session)
  - Routes:
    - `POST /deflectometry/start` → generates a session id + returns the
      pairing URL (`/deflectometry-screen.html?session=<id>`) for the iPad
    - `GET  /deflectometry/status` → session state + iPad connected? +
      captured frame count + last result
    - `WS   /deflectometry/ws/{session_id}` → iPad-side WebSocket: receives
      `{type: 'pattern', phase, freq, orientation, pattern_id}` and sends
      `{type: 'ack', pattern_id}` after canvas render
    - `POST /deflectometry/capture-sequence` → orchestrates 8 captures
      (4 phases × 2 orientations), returns frame references
    - `POST /deflectometry/compute` → runs phase extraction on captured
      frames, returns pseudocolor PNG previews (base64) + phase stats
    - `POST /deflectometry/reset` → clears session state
- **`api.py`** — add `make_deflectometry_router(camera)` to the composed
  router

### Frontend — iPad side (`frontend/deflectometry-screen.html`)

Static HTML file served at `/deflectometry-screen.html` via the existing
StaticFiles mount. Reads `?session=<id>` from its own URL, opens a
WebSocket to `/deflectometry/ws/<id>`, renders received patterns on a
full-screen canvas, acks back to the backend.

- `<meta name="apple-mobile-web-app-capable" content="yes">` + companion
  meta tags for Add-to-Home-Screen fullscreen launch on iOS
- `touch-action: none; pointer-events: none; user-select: none` on body
- Canvas fills `window.innerWidth × window.innerHeight`, rendered via
  ImageData for exact pixel control
- Pattern generator mirrors the backend's `generate_fringe_pattern` math
  (kept simple: sinusoid in the specified orientation at a given frequency
  and phase, clamped to [0, 255])
- `requestAnimationFrame` before sending the ack to guarantee the canvas
  was composited

### Frontend — measurement PC side (`frontend/deflectometry.js`)

Dialog module following the z-stack / super-res / stitch pattern:
- `initDeflectometry()` wires the `btn-deflectometry` toolbar button
- `openDeflectometryDialog()` probes `/deflectometry/status`, rehydrates
  if a session exists, otherwise starts a fresh session
- Dialog DOM:
  - Pairing row: big URL + copy button + "iPad connected ✓" indicator
  - Geometry row: screen-pitch-mm input, fringes-across-screen input
  - Action row: "Flat Field", "Capture Sequence", "Compute"
  - Progress indicator during capture
  - Result area: phase-h pseudocolor, phase-v pseudocolor, PV/RMS readout
- Periodic poll of `/deflectometry/status` (1 Hz) while the dialog is
  open, to update the "iPad connected" indicator

### Tests (`tests/test_deflectometry.py`)

- `test_generate_fringe_pattern_is_sinusoidal` — synth call, assert the
  pattern matches expected `A + B·cos(2π·f·x + phi)`
- `test_four_phase_extraction_recovers_phase` — inject frames with known
  phase, recover via `compute_wrapped_phase`, assert pixel-wise ≤ 1e-6
  error
- `test_unwrap_handles_linear_phase_ramp` — create a wrapped ramp that
  exceeds 2π, verify monotonic recovery
- `test_phase_stats_on_known_input` — fixed input → known PV/RMS
- `test_api_start_returns_pairing_url` — API smoke test via `client`
- `test_api_hosted_mode_rejected` — 403 with HOSTED=1

No WebSocket integration test in v1 — starlette's `TestClient` does
support WebSockets, but the orchestration test would need a real camera
loop, and manual testing is cheaper than building the mocks. Add later
if it becomes a recurring failure mode.

## Out of scope for v1 (explicit)

- Slope → height integration (Frankot-Chellappa). Phase maps alone are
  enough to see that the mode is plumbed correctly.
- Physical calibration (arcsec → µm / mm). The user enters screen pitch
  and fringe count, but the height output stays in phase-radians for v1.
- Reference-flat subtraction (measure reference + part, diff). Useful
  next step but not needed to validate the pipeline.
- 3D textured surface viewer (like z-stack has). Pseudocolor previews
  only in v1.
- Multi-frequency / heterodyne phase unwrap. Single-frequency 1D scanline
  unwrap is enough for flat parts at v1.
- QR code for pairing — just display the URL; the user types it once.
- Persistence across dialog reopens. v1 keeps state for the lifetime of
  the session in the router closure, same as other wizards.

## Why now, ahead of autocollimator

- All hardware is in hand: iPad Air 1, TEC-55 lens, microscope camera,
  workshop space. No blocking dependency.
- A cardboard-box enclosure + 3D-printed mounts is a one-evening build.
- Provides a working second-mode proof-of-concept before the real mode
  refactor, reducing risk of that refactor (we'll know what the second
  mode actually needs from the mode system).
- If the autocollimator arrives first, deflectometry v1 simply gets folded
  into the mode system later — the workflow code doesn't have to change.
