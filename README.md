# Microscope

Industrial video microscope application for precision measurement and inspection. Streams live video from USB3/GigE industrial cameras and provides measurement tools, edge/circle/line detection, DXF overlay, and calibrated pixel-to-mm conversion.

## Features

- Live MJPEG stream from industrial cameras (Baumer/Aravis, OpenCV fallback)
- 11 measurement tools: Distance, Angle, Circle, Fit Arc, Center Distance, Parallel, Perpendicular, Area, Point-Circle, Line Intersect, Slot
- Edge, circle, and line detection with adjustable parameters
- Pixel ↔ mm calibration
- DXF geometry import as reference overlay
- Session save/load, snapshot capture
- Camera controls: exposure, gain, white balance
- Configurable app name and theme

## Requirements

- macOS (primary platform)
- Python 3.13
- [Homebrew](https://brew.sh)

For Baumer or other GigE/USB3 Vision cameras, Aravis is required. OpenCV is used as a fallback for other cameras.

## Installation

### 1. Install system dependencies

```bash
brew install python@3.13
```

For GigE/USB3 Vision cameras (Baumer, etc.):

```bash
brew install aravis
```

### 2. Clone the repository

```bash
git clone <repo-url>
cd microscope
```

### 3. Create a virtual environment and install Python dependencies

```bash
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Running

### With a camera

```bash
./server.sh start
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

```bash
./server.sh stop      # stop the server
./server.sh restart   # restart
./server.sh status    # check if running
```

The server starts on port 8000. Logs are written to `.server.log`.

**Camera selection order at startup:**

1. `NullCamera` (blank frames) — if `NO_CAMERA=1` env var is set, or `config.json` has `"no_camera": true`
2. `AravisCamera` — if Aravis is installed (GigE/USB3 Vision, Baumer cameras)
3. `OpenCVCamera` — fallback using camera index 1
4. `NullCamera` — final fallback with a startup warning

> **Note:** Baumer cameras require Aravis. They will not work via OpenCV.

### Without a camera (development / testing)

```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

This runs the app with a stub camera that returns blank frames. All measurement and annotation tools work normally.

## Configuration

Runtime settings are stored in `config.json` at the project root and managed through the app's Settings dialog. You can also edit it directly:

```json
{
  "camera_id": null,
  "no_camera": false,
  "app_name": "Microscope",
  "theme": "macos-dark"
}
```

| Key | Description |
|-----|-------------|
| `camera_id` | Aravis device ID string, or `null` to use the first found camera |
| `no_camera` | Set to `true` to always start without a camera |
| `app_name` | Title shown in the top bar and browser tab |
| `theme` | UI theme name (currently `macos-dark`) |

## Running tests

No camera hardware is required to run the test suite.

```bash
.venv/bin/pytest tests/        # all tests
.venv/bin/pytest tests/ -v     # verbose
```

## Project structure

```
backend/
  cameras/       BaseCamera + AravisCamera, OpenCVCamera, NullCamera
  vision/        Edge/circle/line detection, calibration math, DXF parser
  api.py         REST endpoints (/stream, /freeze, /detect-*, /load-dxf, …)
  main.py        App factory and camera selection logic
  stream.py      Background-thread camera reader (macOS thread-safety)
  frame_store.py Thread-safe frame store for freeze feature
  config.py      Atomic JSON config load/save
frontend/
  index.html     App entry point
  app.js         All client-side logic (~2900 lines, no framework)
  style.css      macOS-dark theme
tests/           pytest suite
server.sh        Start/stop/restart/status script
requirements.txt Python dependencies
config.json      Runtime configuration
```
