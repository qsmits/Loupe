# Microscope

Precision measurement and inspection tool for video microscopes. Streams live video from industrial cameras, provides measurement tools, computer vision-based feature detection, and DXF-guided part inspection with deviation reporting.

## Features

### Measurement
- **14 measurement tools**: Distance, Angle, Circle (3-point), Fit Arc, Arc Measure, Center Distance, Parallel, Perpendicular, Area, Point-Circle Distance, Line Intersect, Slot Distance, Select, Pan
- Pixel ↔ mm calibration (two-point or circle-based)
- Coordinate origin with rotation
- Undo/redo for all operations

### Detection & Inspection
- **Auto-detection**: Circle detection (Hough), contour-based line detection, partial arc detection — with adjustable Canny thresholds, smoothing, and NMS parameters
- **DXF-guided inspection**: Load a DXF drawing, auto-align to the part (edge-based template matching), run corridor-based per-feature edge detection with RANSAC inlier filtering and shadow-aware edge selection
- **Manual point-pick**: Click any DXF feature to measure it by placing points along the actual edge. Supports compound features (slots, outlines) and connected standalone entities — points auto-assign to the nearest sub-segment
- **Punch/Die tolerance tagging**: Mark features as Punch (outer) or Die (cavity) for directional deviation coloring — green (pass), amber (reworkable), red (scrap)
- **Deviation reporting**: Grouped inspection results by feature, hover tooltips with full detail, numbered feature markers matching PDF table. CSV and PDF export with grouped results

### Annotation Management
- **Multi-select**: Shift+click, rectangle drag-select
- **Elevation**: Promote auto-detected features to editable measurements
- **Merge lines**: Combine multiple line segments into one measurement
- **Measurement grouping**: Select multiple → right-click → "Group as..." with uniform color rendering
- **Draggable labels**: Click and drag any measurement or deviation label to reposition, with leader lines
- **Right-click context menu**: Elevate, delete, rename, merge, group, convert arc→circle, Punch/Die toggle, clear operations
- **Sidebar**: Detections separated from measurements with elevate ↑ button, collapsible groups
- **Clear menu**: Separate clearing of detections, measurements, DXF overlay, or all

### Zoom & Pan
- Scroll-wheel zoom centered on cursor (frozen mode, up to 10x)
- Pan tool (`H` key) and middle-mouse-button pan
- Zoom presets: `0` = fit to window, `1` = 1:1 pixel mapping
- Zoom indicator badge with clickable preset dropdown (Fit, 50%–800%)
- Minimap overview when zoomed in (click to jump)
- Measurement grid overlay with adaptive spacing

### Camera & Session
- Live MJPEG stream from industrial cameras (Baumer/Aravis, OpenCV fallback)
- Camera controls: exposure, gain, white balance
- Freeze frame for measurement
- Session save/load (JSON format with inspection results)
- Auto-save to localStorage every 30 seconds with restore prompt
- Snapshot capture and image load
- Annotated image export (PNG), measurement CSV, inspection PDF
- **DXF export** for reverse engineering — export measurements as a DXF file (lines, circles, arcs, polylines in mm)

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

## Tests

```bash
.venv/bin/pytest tests/        # all tests
.venv/bin/pytest tests/ -v     # verbose
```

No camera hardware required.

## Project Structure

```
backend/
  cameras/           BaseCamera + AravisCamera, OpenCVCamera, NullCamera
  vision/
    detection.py     Edge/circle/line/arc detection with preprocessing
    guided_inspection.py  DXF-guided corridor inspection + manual fitting
    line_arc_matching.py  DXF↔detected feature matching, shared transforms
    dxf_parser.py    DXF → JSON (LINE, CIRCLE, ARC, LWPOLYLINE with bulge)
    dxf_export.py    Measurements → DXF (reverse engineering export)
    alignment.py     Circle-based and edge-based DXF auto-alignment
    calibration.py   Pixel↔mm math
  api.py             REST endpoints
  main.py            App factory and camera selection
  stream.py          Background-thread camera reader
  frame_store.py     Thread-safe frame store
  config.py          Atomic JSON config
frontend/
  main.js            Entry point, events, undo/redo, context menu, point-pick
  state.js           Global state, undo stack, type classifications
  render.js          Canvas rendering, viewport transform, all draw functions
  viewport.js        Zoom/pan state and coordinate transforms
  tools.js           Tool logic, hit-testing, snap, drag, DXF entity selection
  dxf.js             DXF overlay, alignment, guided inspection handler
  detect.js          Detection button handlers with busy indicators
  annotations.js     Add/delete/elevate/merge/clear annotations
  session.js         Save/load, CSV/PDF/DXF export, auto-save
  sidebar.js         Sidebar, inspection table, camera controls
  math.js            fitCircle, fitLine, fitCircleAlgebraic, geometry helpers
  calibration.js     Calibration dialog
  index.html         App shell
  style.css          macOS-dark theme
tests/               pytest suite (no camera required)
docs/
  roadmap.md         Product roadmap
  superpowers/       Design specs and implementation plans
snapshots/           Saved test images
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `V` | Select tool |
| `D` | Distance |
| `A` | Angle |
| `O` | Circle (3-point) |
| `F` | Fit Arc |
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
