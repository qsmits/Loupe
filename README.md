# Loupe

Open-source optical inspection frontend for DIY and small-shop hardware. Browser-based (vanilla JS + FastAPI backend, no framework, no build step). Streams live video from industrial cameras, provides precision measurement tools, computer vision-based feature detection, DXF-guided part inspection, and multiple instrument modes for surface metrology.

## Instrument Modes

Modes replace each other — calibration units, tool availability, and workflows differ between them.

### Microscope (default)
Precision measurement and feature inspection using a video microscope or machine-vision camera. Covers all measurement tools, DXF-guided inspection, SPC, and surface metrology via Z-stack.

### Deflectometry
Specular surface measurement using an iPad as a phase-shifting display. 8-step phase shifting with gamma pre-correction, Gaussian smoothing, sphere calibration, Frankot-Chellappa height integration, inline 3D viewer, and a diagnostics tab. Requires a controlled enclosure to suppress stray light.

### Fringe Analysis
Interferometric surface flatness measurement using an optical flat and monochromatic light. Single-image DFT phase extraction, 2D phase unwrapping, Zernike polynomial fitting (up to 66 terms, Noll indexing), PV/RMS/Strehl statistics, PSF and MTF computation, wavefront averaging, contour lines, 3D WebGL viewer, horizontal/vertical profiles, reference standards (ISO 3650, JIS B 7506, ASME B89.1.9, DIN 861), PDF and CSV export.

---

## Features

### Measurement (Microscope mode)
- **15+ measurement tools**: Distance, Angle, Circle (3-point), Fit Arc, Arc Measure, Center Distance, Parallel Distance, Perpendicular Distance, Area, Point-Circle Distance, Line Intersect, Slot Distance, Bézier Spline, Select, Pan
- **Canvas comment annotations**: freeform text notes placed on the image
- Pixel ↔ mm calibration (two-point or circle-based), coordinate origin with rotation
- Calibration profiles with per-magnification settings, export/import
- Lens distortion correction, perspective (tilt) correction via 4-point homography
- Undo/redo for all operations
- Sub-pixel edge snapping (parabola + Gaussian, client-side, instant preview)

### Detection & Inspection
- **Auto-detection**: Circle detection (Hough), contour-based line detection, partial arc detection — adjustable Canny thresholds, smoothing, NMS, surface presets (Wire EDM / Lathe / 3D Print)
- **DXF-guided inspection**: Load a DXF drawing, auto-align to the part (edge-based template matching, no circles required), run corridor-based per-feature edge detection with RANSAC inlier filtering and shadow-aware edge selection
- **Manual point-pick**: Click any DXF feature to measure it by placing points along the actual edge; compound features and connected standalone entities auto-assign points to the nearest sub-segment
- **GD&T**: True Position (TP = 2 × radial deviation), Punch/Die tolerance tagging with directional deviation coloring (green/amber/red)
- **Deviation reporting**: Grouped sidebar, hover tooltips, numbered cross-references to PDF. CSV and PDF export

### Annotation Management
- **Multi-select**: Shift+click, rectangle drag-select; bulk delete/elevate
- **Elevation**: Promote auto-detected features to editable measurements
- **Merge lines**: Combine multiple line segments into one measurement
- **Measurement grouping**: Named groups with uniform color, collapsible sidebar sections
- **Draggable labels**: Reposition any measurement or deviation label, with leader lines
- **Per-annotation visibility toggles**: Eye icon hides individual annotations without deleting them
- **Measurement templates**: Save/load inspection recipes as JSON (DXF entities, calibration, tolerances, detection settings)
- **Right-click context menu**: Elevate, delete, rename, merge, group, convert arc→circle, Punch/Die toggle, clear operations

### Surface Metrology (Z-Stack)
- Capture stack + compute all-in-focus composite + per-pixel height map
- ISO 4287 1D and ISO 25178 2D areal roughness parameters (Sa, Sq, Sp, Sv, Sz, Ssk, Sku)
- ISO 25178-606 surface texture parameters, ISO 25178-3 Gaussian S-filter / L-filter
- Spatial texture parameters: Sal, Str, Std
- 2D profile extraction along user-drawn lines with live roughness readout
- Bearing ratio (Abbott-Firestone curve), 2D PSD, plane / poly² detrend
- HDR bracketing + Laplacian pyramid fusion
- 3D textured heightmap viewer with confidence mask and Z calibration
- Quadrature noise-floor compensation

### Multi-Frame Reconstruction
- **Image stitching wizard**: manual tile capture with X/Y µm coordinate tracking, sub-pixel placement, anti-ghost blending
- **Super-resolution wizard**: multi-frame sub-pixel shift, pyramid reconstruction

### SPC & Analytics
- SQLite run storage (parts → runs → results)
- Cpk with feature-type-aware one-sided/two-sided calculation, capability rating
- Canvas 2D trend charts with tolerance bands
- SPC CSV export (disabled in hosted mode)

### Camera & Session
- Live MJPEG stream from industrial cameras (Baumer/Aravis, OpenCV, browser MediaDevices API)
- Camera controls: log-scale exposure and gain sliders, companion exact-value inputs, pixel format, ROI set-from-view/reset, auto white balance, RGB white balance
- Live 32-bin luma histogram with clip warnings; client-side auto-exposure loop
- 4-quadrant image comparison (Keyence-style: 4 live views, independent settings)
- Freeze frame for measurement; auto-freeze on detection
- Session save/load (JSON v2 with inspection results), auto-save to localStorage (30s), restore prompt, beforeunload warning
- Snapshot capture and drag-and-drop image load
- Export: annotated PNG, measurement CSV, inspection CSV, inspection PDF (jsPDF, bundled locally), DXF (reverse engineering — measurements → DXF in mm)

### Zoom & Pan
- Scroll-wheel zoom centered on cursor (frozen mode, up to 10x)
- Pan tool (`H` key) and middle-mouse-button pan
- Zoom presets: `0` = fit to window, `1` = 1:1 pixel mapping
- Zoom indicator badge with clickable preset dropdown (Fit, 50%–800%)
- Minimap overview when zoomed in; measurement grid overlay

### Hosted Mode
- Multi-user image-upload-only mode with per-session frame isolation (SessionFrameStore, UUID keys, TTL)
- CSP headers, rate limiting, input validation, error scrubbing
- Concurrent operation limit; stitch, super-res, Z-stack, and SPC disabled in hosted mode
- Server-issued session tokens; jsPDF bundled locally (no third-party CDN)
- Deploy scripts for Ubuntu + Apache + supervisord

### Help System
- Two-panel layout (nav tree + content page), 20+ pages covering every tool, algorithm, workflow, and export format

---

## Requirements

- Python 3.11+ (3.13 recommended)
- For GigE/USB3 Vision cameras (Baumer, etc.): [Aravis](https://github.com/AravisProject/aravis) via Homebrew

## Installation

```bash
# Install Python (macOS)
brew install python@3.13

# For industrial cameras (optional)
brew install aravis

# Clone and set up
git clone <repo-url>
cd microscope
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Running

### With a camera

```bash
./server.sh start
```

Open [http://localhost:8000](http://localhost:8000). Logs in `.server.log`.

```bash
./server.sh stop      # stop the server
./server.sh restart   # restart
./server.sh status    # check if running
```

### Without a camera

```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Load images via drag-and-drop or the File menu. All tools work normally.

### Camera priority

1. `NullCamera` — if `NO_CAMERA=1` or `config.json` `no_camera: true`
2. `AravisCamera` — GigE/USB3 Vision (Baumer, etc.)
3. `OpenCVCamera` — fallback (camera index 1)
4. `NullCamera` — final fallback with warning

Browser cameras (MediaDevices API) are selectable from the camera dropdown after granting permission.

## Configuration

Runtime settings in `config.json`:

| Key | Description |
|-----|-------------|
| `camera_id` | Aravis device ID, or `null` for first found |
| `no_camera` | `true` to always start without a camera |
| `app_name` | Title in top bar and browser tab |
| `theme` | UI theme (`macos-dark`) |
| `tolerance_warn` | Global warning tolerance in mm (default 0.10) |
| `tolerance_fail` | Global failure tolerance in mm (default 0.25) |
| `fringe_wavelengths` | Named wavelength presets for fringe analysis (nm) |
| `fringe_standards` | Reference standard tolerance tables for fringe analysis |

## Tests

```bash
.venv/bin/pytest tests/        # all tests
.venv/bin/pytest tests/ -v     # verbose
```

No camera hardware required.

## Project Structure

```
backend/
  cameras/              BaseCamera + AravisCamera, OpenCVCamera, NullCamera
  vision/
    detection.py        Edge/circle/line/arc detection with preprocessing
    guided_inspection.py  DXF-guided corridor inspection + manual fitting
    line_arc_matching.py  DXF↔detected feature matching, shared transforms
    dxf_parser.py       DXF → JSON (LINE, CIRCLE, ARC, LWPOLYLINE with bulge)
    dxf_export.py       Measurements → DXF (reverse engineering export)
    alignment.py        Circle-based and edge-based DXF auto-alignment
    calibration.py      Pixel↔mm math
    subpixel.py         Sub-pixel edge refinement (parabola + Gaussian)
    focus_stack.py      Depth-from-focus stack computation, HDR fusion
    heightmap_analysis.py  ISO 25178 areal roughness, spatial texture, PSD
    stitch.py           Image stitching with sub-pixel placement
    superres.py         Super-resolution pyramid reconstruction
    deflectometry.py    Phase-shifting deflectometry processing pipeline
    fringe.py           DFT interferometric analysis, Zernike fitting, PSF/MTF
    gear_analysis.py    Gear tooth detection and spacing analysis
    gear_geometry.py    Involute/cycloidal gear geometry generation
    gear_phase.py       Gear phase estimation
    settings_proposer.py  Detection preset proposer
  api.py                Core REST endpoints (stream, freeze, snapshot, DXF, calibration)
  api_camera.py         Camera controls and enumeration endpoints
  api_detection.py      Detection and sub-pixel snap endpoints
  api_inspection.py     Guided inspection and feature fitting endpoints
  api_deflectometry.py  Deflectometry HTTP API
  api_fringe.py         Fringe analysis HTTP API
  api_zstack.py         Z-stack depth-from-focus HTTP API
  api_stitch.py         Image stitching HTTP API
  api_superres.py       Super-resolution HTTP API
  api_compare.py        4-quadrant comparison HTTP API
  api_runs.py           SPC run storage endpoints
  main.py               App factory, camera selection, router registration
  stream.py             Background-thread camera reader
  frame_store.py        Thread-safe frame store (single + per-session)
  session_store.py      Per-session frame isolation for hosted mode
  run_store.py          SQLite SPC run storage
  rate_limit.py         Request rate limiting middleware
  config.py             Atomic JSON config load/save
frontend/
  main.js               Entry point, event wiring, undo/redo, context menu, point-pick
  state.js              Global state, undo stack, type classifications
  modes.js              Mode switcher (Microscope / Deflectometry / Fringe)
  render.js             Canvas rendering, viewport transform, draw dispatch
  render-annotations.js Per-type annotation draw functions
  render-dxf.js         DXF overlay rendering, dxfToCanvas coordinate transform
  render-hud.js         HUD rendering (crosshair, zoom badge, minimap)
  viewport.js           Zoom/pan state, imageToScreen/screenToImage transforms
  tools.js              Tool logic, hit-testing, snap, drag, DXF entity selection
  hit-test.js           Hit-testing helpers
  events-mouse.js       Mouse event handlers
  events-keyboard.js    Keyboard shortcut handlers
  events-inspection.js  Guided inspection event handlers
  events-context-menu.js  Right-click context menu
  dxf.js                DXF overlay, alignment, guided inspection handler
  detect.js             Detection button handlers with busy indicators
  annotations.js        Add/delete/elevate/merge/clear annotations
  session.js            Save/load, CSV/PDF/DXF export, auto-save
  sidebar.js            Sidebar, inspection table, camera controls
  spc.js                SPC trend charts, Cpk display
  template.js           Measurement template save/load
  cal-profiles.js       Calibration profile management
  calibration.js        Calibration dialog flow
  lens-cal.js           Lens distortion calibration
  tilt-cal.js           Perspective (tilt) calibration
  subpixel-js.js        Client-side sub-pixel snapping (parabola + Gaussian)
  stitch.js             Image stitching wizard UI
  superres.js           Super-resolution wizard UI
  zstack.js             Z-stack workflow UI
  zstack-3d.js          3D textured heightmap viewer (WebGL)
  deflectometry.js      Deflectometry workspace UI
  fringe.js             Fringe analysis workspace UI
  compare.js            4-quadrant image comparison UI
  browser-camera.js     MediaDevices browser camera integration
  sub-mode-selector.js  Sub-mode selector widget
  comment-editor.js     Canvas comment annotation editor
  math.js               fitCircle, fitLine, fitCircleAlgebraic, geometry helpers
  format.js             Number formatting utilities
  api.js                apiFetch wrapper (session token, hosted-mode handling)
  gear.js               Gear analysis UI (parked)
  index.html            App shell
  deflectometry-screen.html  Deflectometry display page (served to iPad)
  style.css             macOS-dark theme
tests/                  pytest suite (no camera required)
docs/
  roadmap.md            Product roadmap with competitive position
  superpowers/          Design specs and implementation plans
snapshots/              Saved test images
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `V` | Select tool |
| `D` | Distance |
| `A` | Angle |
| `O` | Circle (3-point) |
| `F` | Fit Arc |
| `B` | Bézier Spline |
| `H` | Pan |
| `U` | Elevate selected detections |
| `0` | Fit zoom to window |
| `1` | 1:1 pixel zoom |
| `` ` `` | Toggle measurement grid |
| `Escape` | Cancel / exit mode / deselect |
| `Delete` | Delete selected |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `S` | Save session |

## License

Proprietary. All rights reserved.
