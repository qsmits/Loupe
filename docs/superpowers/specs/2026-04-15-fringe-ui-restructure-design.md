# Fringe Mode UI Restructure — Design Spec

## Goal

Reorganize the fringe mode left panel from a flat wall of controls into a clean, purpose-driven layout: top bar for settings/export, left panel for capture workflow only, results area for Zernike subtraction controls. Add SSE-based progress reporting for the 10-20s analysis.

## Current Problems

- Left panel mixes capture workflow, settings, display controls, and export — no grouping
- Oversized "Freeze & Analyze" button dominates the panel
- No progress feedback during 10-20s analysis
- Zernike subtraction checkboxes live in the left panel but affect the results display
- Settings (wavelength, mask threshold, reference standard) are always visible even though they rarely change
- `fringe.js` is a ~2500-line monolith handling init, UI, analysis, measurements, and rendering

## Architecture

### 1. Top Bar — Settings & Export Dropdowns

Add two `fringe-only` dropdown menus to the top bar, following the existing microscope-mode pattern (`<button class="menu-btn">` + `<div class="dropdown">`).

**Settings dropdown** contains:
- Wavelength select (same options as current, including Custom)
- Mask threshold slider
- Reference standard select

**Export dropdown** contains:
- PDF Report button
- Zernike CSV button

Both dropdowns are hidden outside fringe mode via `fringe-only` CSS class, toggled by `modes.js` the same way `microscope-only` items work.

### 2. Left Panel — Capture Workflow Only

Vertical stack with subtle `1px solid var(--border)` dividers between groups. No collapsible sections. Contents top to bottom:

1. **Camera preview** — `<img>` with mask overlay `<canvas>` (unchanged)
2. **Focus quality bar** — horizontal bar with score (unchanged)
3. **Analyze button + progress bar** — normal-sized button matching app button style (not oversized). Below it, a progress bar (hidden until analysis starts) with:
   - 3px-tall colored bar showing progress 0–100%
   - Stage label below: "Detecting carrier...", "Extracting phase...", etc.
   - Bar turns green on completion, red on error, orange on timeout
   - Error/timeout states show message + clickable "Retry" link
4. **Averaging controls** — Add to Avg / count / Reset row, reject threshold row, capture log div (unchanged functionally)
5. **Mask controls** — Draw Mask / Add Hole / Clear buttons (unchanged functionally)
6. **Drop zone** — drag-and-drop area (unchanged)

The analyze button loses its `font-size:13px;font-weight:600` oversized styling — it becomes a standard `detect-btn` sized button at full width.

### 3. Zernike Subtraction — Results Area

A new row of toggle pills between the carrier info row and the tab bar in the results column.

Layout: `Subtract:` label, then pill buttons: `Tilt` (always active, non-clickable), `Power`, `Astig`, `Coma`, `Spherical`, a vertical divider, then `↕ Invert`.

**Pill styling:**
- Inactive: `background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 10px`
- Active: `background: #2a5a8a; color: white; border-radius: 10px`
- Tilt: always active, reduced opacity, no pointer cursor

**Behavior:** Clicking a pill toggles the corresponding Zernike term and triggers the existing `doReanalyze()` with 150ms debounce (same as current checkbox behavior). The pills replace the checkboxes — no hidden checkboxes needed, the pill state is read directly.

### 4. SSE Progress Reporting

#### Backend: `POST /fringe/analyze-stream`

New endpoint in `api_fringe.py`. Accepts the same request body as `POST /fringe/analyze`. Returns `text/event-stream` (FastAPI `StreamingResponse`).

**Event format** (one JSON object per SSE `data:` line):
```json
{"stage": "carrier",  "progress": 0.15, "message": "Detecting carrier..."}
{"stage": "phase",    "progress": 0.40, "message": "Extracting phase..."}
{"stage": "unwrap",   "progress": 0.65, "message": "Unwrapping phase..."}
{"stage": "zernike",  "progress": 0.85, "message": "Fitting Zernike polynomials..."}
{"stage": "render",   "progress": 0.95, "message": "Rendering surface map..."}
{"stage": "done",     "progress": 1.0,  "result": { ... }}
{"stage": "error",    "message": "Phase extraction failed — insufficient fringe contrast"}
```

**Progress ranges:**
| Stage | Progress | Typical duration |
|-------|----------|-----------------|
| carrier | 0.00–0.15 | ~1s |
| phase | 0.15–0.40 | ~3-5s |
| unwrap | 0.40–0.65 | ~3-5s |
| zernike | 0.65–0.85 | ~2-3s |
| render | 0.85–1.00 | ~1-2s |

**Implementation:** The existing `analyze_interferogram()` function is refactored to accept an optional progress callback `on_progress(stage, progress, message)`. The streaming endpoint wraps this callback to yield SSE events. The non-streaming `/fringe/analyze` endpoint continues to work without a callback (backwards compatible).

**Error handling:** Any exception during analysis sends an `{"stage": "error", "message": "..."}` event before closing the stream. The error message is the exception's string representation (safe — these are computational errors, not internal secrets).

#### Frontend: Streaming Fetch

The analyze button handler switches from a regular `fetch` POST to a streaming fetch:

```
const response = await fetch("/fringe/analyze-stream", { method: "POST", body, signal });
const reader = response.body.getReader();
```

**Timeout logic:**
- A 30-second timer resets on each received event
- On timeout: `AbortController.abort()`, show orange timeout state with "Retry" link
- On fetch error / stream error: show red error state with "Retry" link
- Retry: re-calls the same request

**Progress bar updates:**
- On each event: update bar width to `progress * 100%`, update stage label to `message`
- On `done`: bar goes to 100% green, process the `result` payload exactly as the current non-streaming handler does
- On `error`: bar stops at current position, turns red, show error message + Retry
- On timeout: bar stops, turns orange, show timeout message + Retry

#### Backwards Compatibility

The existing `POST /fringe/analyze` stays unchanged. It's used by:
- `doReanalyze()` (Zernike subtraction changes, carrier override) — these are fast re-computations that don't need progress
- Any external callers

Only the initial "Freeze & Analyze" button uses the new streaming endpoint.

### 5. Module Decomposition

Break `fringe.js` (~2500 lines) into focused ES modules:

| Module | Responsibility |
|--------|---------------|
| `frontend/fringe.js` | Entry point, state object (`fr`), `initFringe()`, event wiring, coordinator. Imports and delegates to the other modules. |
| `frontend/fringe-panel.js` | Left panel HTML template, analyze button handler, averaging logic (`addToAverage`, `computeAverage`, `renderAvgLog`, `toggleCapture`, `resetAverage`), mask polygon drawing (`enterMaskDrawMode`, `exitMaskDrawMode`, `drawMaskOverlay`), drop zone, focus bar updates. |
| `frontend/fringe-results.js` | Results column HTML, subtraction pill row, tab switching, carrier display, summary bar updates, `doReanalyze()`, `invertWavefront()`, surface map rendering, Zernike chart, profiles, PSF/MTF, diagnostics tab content. |
| `frontend/fringe-progress.js` | SSE streaming fetch, progress bar DOM updates, timeout/retry logic, error states. Exports `analyzeWithProgress(body, onResult, onError)`. |
| `frontend/fringe-measure.js` | Surface map measurement tools: cursor crosshair, point-to-point Δh, line profile, area stats, peak/valley markers, measurement SVG rendering. |

**Shared state:** All modules import and mutate the same `fr` state object exported from `fringe.js`. This matches the existing pattern (single mutable state object) without introducing new abstractions.

**Export pattern:** Each module exports named functions. `fringe.js` imports them and wires them to DOM events in `initFringe()`. Modules can also import from each other where needed (e.g., `fringe-panel.js` imports `analyzeWithProgress` from `fringe-progress.js`).

## Files Changed

- `frontend/index.html` — Add `fringe-only` dropdown markup in `#top-bar`
- `frontend/fringe.js` — Slim down to coordinator: state, init, imports. Move logic to sub-modules.
- `frontend/fringe-panel.js` — New: left panel template + capture workflow logic
- `frontend/fringe-results.js` — New: results rendering, subtraction pills, tabs
- `frontend/fringe-progress.js` — New: SSE streaming, progress bar, timeout/retry
- `frontend/fringe-measure.js` — New: surface map measurement tools
- `frontend/style.css` — Styles for subtraction pills, progress bar, `fringe-only` class
- `frontend/modes.js` — Add `fringe-only` class toggling in `switchMode()` (currently only handles `microscope-only`)
- `backend/api_fringe.py` — New `POST /fringe/analyze-stream` endpoint
- `backend/vision/fringe.py` — Add `on_progress` callback parameter to `analyze_interferogram()`

## What's NOT Changing

- Right-side results layout (tabs, surface map, 3D view, etc.) — unchanged except the new subtraction pill row
- Analysis algorithm — unchanged
- Averaging logic — unchanged functionally (just repositioned)
- Mask drawing — unchanged functionally (just repositioned)
- Session save/load format — unchanged
- Carrier diagnostics tab — unchanged
