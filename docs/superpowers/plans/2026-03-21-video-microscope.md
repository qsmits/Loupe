# Video Microscope Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based video microscope tool that streams live video from a Baumer USB3 camera, overlays a canvas for precision measurement (distance, angle, circle), and supports auto-detection of edges and circles.

**Architecture:** FastAPI backend serves an MJPEG stream and REST endpoints. Browser displays the stream under a `<canvas>` element that handles all measurement interactions. A `FrameStore` on the backend holds the last frozen/loaded frame for detection operations.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, OpenCV (opencv-python), numpy, Baumer neoAPI; vanilla HTML/CSS/JavaScript frontend (no build step).

---

## File Map

```
microscope/
├── requirements.txt
├── snapshots/                       # saved frames (created at runtime)
├── backend/
│   ├── __init__.py
│   ├── main.py                      # FastAPI app: CORS, static mount, lifespan
│   ├── api.py                       # all routes (stream, freeze, snapshot, detection, camera)
│   ├── stream.py                    # async MJPEG frame generator
│   ├── frame_store.py               # FrameStore: store/get/clear a single numpy frame
│   ├── cameras/
│   │   ├── __init__.py
│   │   ├── base.py                  # BaseCamera abstract class
│   │   ├── opencv.py                # OpenCVCamera (cv2.VideoCapture fallback)
│   │   └── baumer.py                # BaumerCamera (neoAPI)
│   └── vision/
│       ├── __init__.py
│       ├── calibration.py           # pure math: distance, angle, circle fit, px↔mm
│       └── detection.py             # Canny edges → PNG bytes; Hough circles → list
├── frontend/
│   ├── index.html                   # single-page app shell
│   ├── style.css                    # dark theme, toolbar/sidebar layout
│   └── app.js                       # all canvas tools, state, API calls
└── tests/
    ├── __init__.py
    ├── conftest.py                  # shared fixtures (mock camera, test client)
    ├── test_calibration.py          # pure math tests
    ├── test_detection.py            # OpenCV tests on synthetic frames
    └── test_api.py                  # FastAPI TestClient tests
```

---

## Task 1: Project scaffold

**Files:**
- Create: `microscope/requirements.txt`
- Create: `microscope/backend/__init__.py`
- Create: `microscope/backend/cameras/__init__.py`
- Create: `microscope/backend/vision/__init__.py`
- Create: `microscope/tests/__init__.py`
- Create: `microscope/snapshots/.gitkeep`

- [ ] **Step 1: Create the directory tree**

```bash
cd /Users/qsmits/Projects/MainDynamics
mkdir -p microscope/backend/cameras
mkdir -p microscope/backend/vision
mkdir -p microscope/frontend
mkdir -p microscope/tests
mkdir -p microscope/snapshots
touch microscope/backend/__init__.py
touch microscope/backend/cameras/__init__.py
touch microscope/backend/vision/__init__.py
touch microscope/tests/__init__.py
touch microscope/snapshots/.gitkeep
```

- [ ] **Step 2: Write requirements.txt**

```
fastapi
uvicorn[standard]
opencv-python
numpy
python-multipart
pytest
httpx
```

Note: `neoapi` is installed separately from the Baumer SDK `.whl`:
```bash
pip install /path/to/neoapi-*.whl
```

- [ ] **Step 3: Create a virtual environment and install dependencies**

```bash
cd /Users/qsmits/Projects/MainDynamics/microscope
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Expected: all packages install without error. `neoapi` will not be installed at this stage — that's fine, `BaumerCamera` will only be imported when explicitly requested.

---

## Task 2: Camera abstraction — BaseCamera + OpenCVCamera

**Files:**
- Create: `microscope/backend/cameras/base.py`
- Create: `microscope/backend/cameras/opencv.py`
- Create: `microscope/tests/test_cameras.py`

- [ ] **Step 1: Write the test**

`microscope/tests/test_cameras.py`:
```python
from unittest.mock import MagicMock, patch
import numpy as np
from backend.cameras.opencv import OpenCVCamera


def test_opencv_camera_get_frame_returns_numpy_array():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True
    mock_cap.read.return_value = (True, np.zeros((480, 640, 3), dtype=np.uint8))

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        cam.open()
        frame = cam.get_frame()

    assert isinstance(frame, np.ndarray)
    assert frame.shape == (480, 640, 3)


def test_opencv_camera_get_info():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True
    mock_cap.get.side_effect = lambda prop: {3: 640.0, 4: 480.0}.get(prop, 0.0)

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        cam.open()
        info = cam.get_info()

    assert info["width"] == 640
    assert info["height"] == 480
    assert "model" in info
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/qsmits/Projects/MainDynamics/microscope
source .venv/bin/activate
python -m pytest tests/test_cameras.py -v
```

Expected: `ModuleNotFoundError` for `backend.cameras.opencv`.

- [ ] **Step 3: Write BaseCamera**

`microscope/backend/cameras/base.py`:
```python
from abc import ABC, abstractmethod
import numpy as np


class BaseCamera(ABC):
    @abstractmethod
    def open(self) -> None:
        """Open the camera and start capture."""

    @abstractmethod
    def close(self) -> None:
        """Stop capture and release the camera."""

    @abstractmethod
    def get_frame(self) -> np.ndarray:
        """Return the latest frame as a BGR numpy array."""

    @abstractmethod
    def set_exposure(self, microseconds: float) -> None:
        """Set exposure time in microseconds."""

    @abstractmethod
    def set_gain(self, db: float) -> None:
        """Set gain in dB."""

    @abstractmethod
    def get_info(self) -> dict:
        """Return dict with keys: model, serial, width, height, exposure, gain."""
```

- [ ] **Step 4: Write OpenCVCamera**

`microscope/backend/cameras/opencv.py`:
```python
import cv2
import numpy as np
from .base import BaseCamera


class OpenCVCamera(BaseCamera):
    def __init__(self, index: int = 0):
        self._index = index
        self._cap: cv2.VideoCapture | None = None

    def open(self) -> None:
        self._cap = cv2.VideoCapture(self._index)
        if not self._cap.isOpened():
            raise RuntimeError(f"Cannot open camera at index {self._index}")

    def close(self) -> None:
        if self._cap:
            self._cap.release()
            self._cap = None

    def get_frame(self) -> np.ndarray:
        if not self._cap:
            raise RuntimeError("Camera not open")
        ok, frame = self._cap.read()
        if not ok:
            raise RuntimeError("Failed to read frame")
        return frame

    def set_exposure(self, microseconds: float) -> None:
        if self._cap:
            self._cap.set(cv2.CAP_PROP_EXPOSURE, microseconds / 1000.0)

    def set_gain(self, db: float) -> None:
        if self._cap:
            self._cap.set(cv2.CAP_PROP_GAIN, db)

    def get_info(self) -> dict:
        width = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) if self._cap else 0
        height = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) if self._cap else 0
        return {
            "model": "OpenCV Camera",
            "serial": f"index-{self._index}",
            "width": width,
            "height": height,
            "exposure": 0.0,
            "gain": 0.0,
        }
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
python -m pytest tests/test_cameras.py -v
```

Expected: both tests PASS.

---

## Task 3: BaumerCamera

**Files:**
- Create: `microscope/backend/cameras/baumer.py`

No automated tests for this task — the Baumer neoAPI requires physical hardware. The test is: connect the VCXU-32C and run the app manually.

- [ ] **Step 1: Write BaumerCamera**

`microscope/backend/cameras/baumer.py`:
```python
import numpy as np
from .base import BaseCamera

# neoAPI is installed from the Baumer SDK .whl — only import at runtime
try:
    import neoapi
    _NEOAPI_AVAILABLE = True
except ImportError:
    _NEOAPI_AVAILABLE = False


class BaumerCamera(BaseCamera):
    def __init__(self):
        if not _NEOAPI_AVAILABLE:
            raise ImportError(
                "neoapi not installed. Install with: pip install /path/to/neoapi-*.whl"
            )
        self._cam = neoapi.Cam()

    def open(self) -> None:
        self._cam.Connect()

    def close(self) -> None:
        self._cam.Disconnect()

    def get_frame(self) -> np.ndarray:
        img = self._cam.GetImage()
        return img.GetNPArray()

    def set_exposure(self, microseconds: float) -> None:
        self._cam.f.ExposureTime.Set(microseconds)

    def set_gain(self, db: float) -> None:
        self._cam.f.Gain.Set(db)

    def get_info(self) -> dict:
        width = int(self._cam.f.Width.Get())
        height = int(self._cam.f.Height.Get())
        exposure = float(self._cam.f.ExposureTime.Get())
        gain = float(self._cam.f.Gain.Get())
        model = self._cam.f.DeviceModelName.Get()
        serial = self._cam.f.DeviceSerialNumber.Get()
        return {
            "model": model,
            "serial": serial,
            "width": width,
            "height": height,
            "exposure": exposure,
            "gain": gain,
        }
```

- [ ] **Step 2: Verify the import guard works without hardware**

```bash
python -c "from backend.cameras.baumer import BaumerCamera; print('import ok')"
```

Expected: `import ok` (no crash, even without neoapi installed — the `try/except` protects it).

---

## Task 4: Vision math — calibration.py

**Files:**
- Create: `microscope/backend/vision/calibration.py`
- Create: `microscope/tests/test_calibration.py`

- [ ] **Step 1: Write the tests**

`microscope/tests/test_calibration.py`:
```python
import math
import pytest
from backend.vision.calibration import (
    distance_px,
    px_to_mm,
    mm_to_px,
    angle_degrees,
    fit_circle_three_points,
)


def test_distance_px():
    assert distance_px((0, 0), (3, 4)) == pytest.approx(5.0)
    assert distance_px((1, 1), (1, 1)) == pytest.approx(0.0)


def test_px_to_mm():
    assert px_to_mm(1220.5, 1220.5) == pytest.approx(1.0)
    assert px_to_mm(0, 1220.5) == pytest.approx(0.0)


def test_mm_to_px():
    assert mm_to_px(1.0, 1220.5) == pytest.approx(1220.5)


def test_angle_degrees_right_angle():
    # p1=(1,0), vertex=(0,0), p3=(0,1) → 90°
    assert angle_degrees((1, 0), (0, 0), (0, 1)) == pytest.approx(90.0)


def test_angle_degrees_straight():
    # p1=(-1,0), vertex=(0,0), p3=(1,0) → 180°
    assert angle_degrees((-1, 0), (0, 0), (1, 0)) == pytest.approx(180.0)


def test_fit_circle_three_points_known():
    # Three points on a circle centered at (5, 5) with radius 5
    p1 = (10.0, 5.0)   # right
    p2 = (5.0, 10.0)   # top
    p3 = (0.0, 5.0)    # left
    cx, cy, r = fit_circle_three_points(p1, p2, p3)
    assert cx == pytest.approx(5.0, abs=1e-6)
    assert cy == pytest.approx(5.0, abs=1e-6)
    assert r == pytest.approx(5.0, abs=1e-6)


def test_fit_circle_collinear_raises():
    with pytest.raises(ValueError, match="collinear"):
        fit_circle_three_points((0, 0), (1, 1), (2, 2))
```

- [ ] **Step 2: Run to confirm failure**

```bash
python -m pytest tests/test_calibration.py -v
```

Expected: `ImportError` — module doesn't exist yet.

- [ ] **Step 3: Write calibration.py**

`microscope/backend/vision/calibration.py`:
```python
import math


def distance_px(p1: tuple, p2: tuple) -> float:
    """Euclidean distance between two (x, y) points in pixels."""
    return math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2)


def px_to_mm(pixels: float, pixels_per_mm: float) -> float:
    """Convert a pixel distance to mm."""
    return pixels / pixels_per_mm


def mm_to_px(mm: float, pixels_per_mm: float) -> float:
    """Convert a mm distance to pixels."""
    return mm * pixels_per_mm


def angle_degrees(p1: tuple, vertex: tuple, p3: tuple) -> float:
    """Angle in degrees at `vertex` formed by the line from p1→vertex and vertex→p3."""
    v1 = (p1[0] - vertex[0], p1[1] - vertex[1])
    v2 = (p3[0] - vertex[0], p3[1] - vertex[1])
    mag1 = math.sqrt(v1[0] ** 2 + v1[1] ** 2)
    mag2 = math.sqrt(v2[0] ** 2 + v2[1] ** 2)
    if mag1 < 1e-10 or mag2 < 1e-10:
        return 0.0
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    cos_a = max(-1.0, min(1.0, dot / (mag1 * mag2)))
    return math.degrees(math.acos(cos_a))


def fit_circle_three_points(p1: tuple, p2: tuple, p3: tuple) -> tuple:
    """
    Fit a circle through three points on its circumference.
    Returns (cx, cy, radius).
    Raises ValueError if points are collinear.
    """
    ax, ay = p1
    bx, by = p2
    cx, cy = p3
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-10:
        raise ValueError("Points are collinear — cannot fit a circle")
    sq_a = ax ** 2 + ay ** 2
    sq_b = bx ** 2 + by ** 2
    sq_c = cx ** 2 + cy ** 2
    ux = (sq_a * (by - cy) + sq_b * (cy - ay) + sq_c * (ay - by)) / d
    uy = (sq_a * (cx - bx) + sq_b * (ax - cx) + sq_c * (bx - ax)) / d
    radius = math.sqrt((ax - ux) ** 2 + (ay - uy) ** 2)
    return ux, uy, radius
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
python -m pytest tests/test_calibration.py -v
```

Expected: all 6 tests PASS.

---

## Task 5: Vision detection — detection.py

**Files:**
- Create: `microscope/backend/vision/detection.py`
- Create: `microscope/tests/test_detection.py`

- [ ] **Step 1: Write the tests**

`microscope/tests/test_detection.py`:
```python
import numpy as np
import pytest
from backend.vision.detection import detect_edges, detect_circles


def white_circle_frame():
    """640×480 black frame with a white circle — easy for Hough to find."""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    import cv2
    cv2.circle(frame, (320, 240), 80, (255, 255, 255), 3)
    return frame


def test_detect_edges_returns_png_bytes():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    result = detect_edges(frame, threshold1=50, threshold2=150)
    assert isinstance(result, bytes)
    assert result[:4] == b"\x89PNG"  # PNG magic bytes


def test_detect_circles_finds_circle():
    frame = white_circle_frame()
    circles = detect_circles(
        frame, dp=1.2, min_dist=50, param1=100, param2=30,
        min_radius=60, max_radius=100
    )
    assert len(circles) >= 1
    c = circles[0]
    assert abs(c["x"] - 320) < 15
    assert abs(c["y"] - 240) < 15
    assert abs(c["radius"] - 80) < 15


def test_detect_circles_empty_frame():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    circles = detect_circles(
        frame, dp=1.2, min_dist=50, param1=100, param2=30,
        min_radius=10, max_radius=200
    )
    assert circles == []
```

- [ ] **Step 2: Run to confirm failure**

```bash
python -m pytest tests/test_detection.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Write detection.py**

`microscope/backend/vision/detection.py`:
```python
import cv2
import numpy as np


def detect_edges(frame: np.ndarray, threshold1: int, threshold2: int) -> bytes:
    """
    Run Canny edge detection on frame.
    Returns a PNG image (RGBA, edges white on transparent background) as bytes.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, threshold1, threshold2)

    # Build RGBA image: edges are white, background transparent
    rgba = np.zeros((*edges.shape, 4), dtype=np.uint8)
    rgba[edges > 0] = [255, 255, 255, 255]

    ok, buf = cv2.imencode(".png", rgba)
    if not ok:
        raise RuntimeError("Failed to encode edge image as PNG")
    return buf.tobytes()


def detect_circles(
    frame: np.ndarray,
    dp: float,
    min_dist: int,
    param1: int,
    param2: int,
    min_radius: int,
    max_radius: int,
) -> list[dict]:
    """
    Run Hough circle detection on frame.
    Returns list of {"x": int, "y": int, "radius": int}.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (9, 9), 2)
    result = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=dp,
        minDist=min_dist,
        param1=param1,
        param2=param2,
        minRadius=min_radius,
        maxRadius=max_radius,
    )
    if result is None:
        return []
    return [
        {"x": int(x), "y": int(y), "radius": int(r)}
        for x, y, r in np.round(result[0]).astype(int)
    ]
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
python -m pytest tests/test_detection.py -v
```

Expected: all 3 tests PASS.

---

## Task 6: FrameStore + MJPEG stream

**Files:**
- Create: `microscope/backend/frame_store.py`
- Create: `microscope/backend/stream.py`

- [ ] **Step 1: Write FrameStore**

`microscope/backend/frame_store.py`:
```python
import threading
import numpy as np


class FrameStore:
    """Thread-safe store for a single numpy frame (frozen or loaded image)."""

    def __init__(self):
        self._frame: np.ndarray | None = None
        self._lock = threading.Lock()

    def store(self, frame: np.ndarray) -> None:
        with self._lock:
            self._frame = frame.copy()

    def get(self) -> np.ndarray | None:
        with self._lock:
            return self._frame.copy() if self._frame is not None else None

    def clear(self) -> None:
        with self._lock:
            self._frame = None

    @property
    def has_frame(self) -> bool:
        with self._lock:
            return self._frame is not None
```

- [ ] **Step 2: Write the MJPEG stream generator**

`microscope/backend/stream.py`:
```python
import asyncio
import cv2
import numpy as np
from .cameras.base import BaseCamera

BOUNDARY = b"frame"


async def mjpeg_generator(camera: BaseCamera, fps: int = 30):
    """
    Async generator yielding MJPEG multipart chunks from `camera`.
    Each chunk is a complete multipart segment including headers.
    """
    interval = 1.0 / fps
    loop = asyncio.get_event_loop()

    while True:
        start = loop.time()
        try:
            frame = await loop.run_in_executor(None, camera.get_frame)
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if not ok:
                continue
            data = buf.tobytes()
            yield (
                b"--" + BOUNDARY + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(data)).encode() + b"\r\n"
                b"\r\n" + data + b"\r\n"
            )
        except Exception:
            # Camera temporarily unavailable — send a blank frame
            blank = np.zeros((480, 640, 3), dtype=np.uint8)
            ok, buf = cv2.imencode(".jpg", blank)
            if ok:
                data = buf.tobytes()
                yield (
                    b"--" + BOUNDARY + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(data)).encode() + b"\r\n"
                    b"\r\n" + data + b"\r\n"
                )

        elapsed = loop.time() - start
        await asyncio.sleep(max(0.0, interval - elapsed))
```

- [ ] **Step 3: Quick sanity check (no test runner needed)**

```bash
python -c "
from backend.frame_store import FrameStore
import numpy as np
fs = FrameStore()
assert not fs.has_frame
fs.store(np.zeros((10,10,3), dtype=np.uint8))
assert fs.has_frame
f = fs.get()
assert f.shape == (10, 10, 3)
fs.clear()
assert not fs.has_frame
print('FrameStore OK')
"
```

Expected: `FrameStore OK`.

---

## Task 7: FastAPI backend — api.py + main.py

**Files:**
- Create: `microscope/backend/api.py`
- Create: `microscope/backend/main.py`
- Create: `microscope/tests/conftest.py`
- Create: `microscope/tests/test_api.py`

- [ ] **Step 1: Write conftest.py with a mock camera fixture**

`microscope/tests/conftest.py`:
```python
import numpy as np
import pytest
from unittest.mock import MagicMock
from fastapi.testclient import TestClient

from backend.cameras.base import BaseCamera


class FakeCamera(BaseCamera):
    """A camera that returns a solid-colour frame. No hardware required."""

    def open(self): pass
    def close(self): pass

    def get_frame(self) -> np.ndarray:
        return np.full((480, 640, 3), 128, dtype=np.uint8)

    def set_exposure(self, us): pass
    def set_gain(self, db): pass

    def get_info(self) -> dict:
        return {
            "model": "FakeCamera",
            "serial": "FAKE-001",
            "width": 640,
            "height": 480,
            "exposure": 5000.0,
            "gain": 0.0,
        }


@pytest.fixture
def client():
    from backend.main import create_app
    camera = FakeCamera()
    camera.open()
    app = create_app(camera)
    with TestClient(app) as c:
        yield c
```

- [ ] **Step 2: Write the API tests**

`microscope/tests/test_api.py`:
```python
import pytest


def test_camera_info(client):
    r = client.get("/camera/info")
    assert r.status_code == 200
    data = r.json()
    assert data["model"] == "FakeCamera"
    assert data["width"] == 640
    assert data["height"] == 480


def test_freeze(client):
    r = client.post("/freeze")
    assert r.status_code == 200
    data = r.json()
    assert data["width"] == 640
    assert data["height"] == 480


def test_snapshot_saves_file(client, tmp_path, monkeypatch):
    monkeypatch.setattr("backend.api.SNAPSHOTS_DIR", tmp_path)
    r = client.post("/snapshot")
    assert r.status_code == 200
    filename = r.json()["filename"]
    assert (tmp_path / filename).exists()


def test_detect_edges_requires_freeze_first(client):
    # No freeze yet → 400
    r = client.post("/detect-edges", json={"threshold1": 50, "threshold2": 150})
    assert r.status_code == 400


def test_detect_edges_after_freeze(client):
    client.post("/freeze")
    r = client.post("/detect-edges", json={"threshold1": 50, "threshold2": 150})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_detect_circles_after_freeze(client):
    client.post("/freeze")
    r = client.post("/detect-circles", json={
        "dp": 1.2, "min_dist": 50, "param1": 100,
        "param2": 30, "min_radius": 10, "max_radius": 200
    })
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_set_exposure(client):
    r = client.put("/camera/exposure", json={"value": 10000.0})
    assert r.status_code == 200


def test_set_gain(client):
    r = client.put("/camera/gain", json={"value": 3.0})
    assert r.status_code == 200
```

- [ ] **Step 3: Run to confirm failure**

```bash
python -m pytest tests/test_api.py -v
```

Expected: `ImportError` for `backend.main`.

- [ ] **Step 4: Write api.py**

`microscope/backend/api.py`:
```python
import datetime
import pathlib

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from .cameras.base import BaseCamera
from .frame_store import FrameStore
from .stream import mjpeg_generator, BOUNDARY
from .vision import detection

SNAPSHOTS_DIR = pathlib.Path(__file__).parent.parent / "snapshots"


class ExposureBody(BaseModel):
    value: float


class GainBody(BaseModel):
    value: float


class EdgeParams(BaseModel):
    threshold1: int = 50
    threshold2: int = 150


class CircleParams(BaseModel):
    dp: float = 1.2
    min_dist: int = 50
    param1: int = 100
    param2: int = 30
    min_radius: int = 10
    max_radius: int = 200


def make_router(camera: BaseCamera, frame_store: FrameStore) -> APIRouter:
    router = APIRouter()

    @router.get("/stream")
    async def stream():
        return StreamingResponse(
            mjpeg_generator(camera),
            media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}",
        )

    @router.post("/freeze")
    async def freeze():
        frame = camera.get_frame()
        frame_store.store(frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.post("/snapshot")
    async def snapshot():
        frame = camera.get_frame()
        SNAPSHOTS_DIR.mkdir(exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{ts}.jpg"
        path = SNAPSHOTS_DIR / filename
        cv2.imwrite(str(path), frame)
        return {"filename": filename}

    @router.post("/load-image")
    async def load_image(file: UploadFile = File(...)):
        data = await file.read()
        arr = np.frombuffer(data, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="Cannot decode image")
        frame_store.store(frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.post("/detect-edges")
    async def detect_edges_route(params: EdgeParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        png_bytes = detection.detect_edges(frame, params.threshold1, params.threshold2)
        return Response(content=png_bytes, media_type="image/png")

    @router.post("/detect-circles")
    async def detect_circles_route(params: CircleParams):
        frame = frame_store.get()
        if frame is None:
            raise HTTPException(status_code=400, detail="No frame stored. Call /freeze first.")
        circles = detection.detect_circles(
            frame, params.dp, params.min_dist, params.param1,
            params.param2, params.min_radius, params.max_radius
        )
        return circles

    @router.get("/camera/info")
    async def camera_info():
        return camera.get_info()

    @router.put("/camera/exposure")
    async def set_exposure(body: ExposureBody):
        camera.set_exposure(body.value)
        return {"ok": True}

    @router.put("/camera/gain")
    async def set_gain(body: GainBody):
        camera.set_gain(body.value)
        return {"ok": True}

    return router
```

- [ ] **Step 5: Write main.py**

`microscope/backend/main.py`:
```python
import pathlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .cameras.base import BaseCamera
from .cameras.baumer import BaumerCamera, _NEOAPI_AVAILABLE
from .cameras.opencv import OpenCVCamera
from .frame_store import FrameStore
from .api import make_router

FRONTEND_DIR = pathlib.Path(__file__).parent.parent / "frontend"


def create_app(camera: BaseCamera | None = None) -> FastAPI:
    frame_store = FrameStore()

    if camera is None:
        if _NEOAPI_AVAILABLE:
            camera = BaumerCamera()
        else:
            print("neoapi not found — falling back to OpenCV camera (index 0)")
            camera = OpenCVCamera(index=0)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        camera.open()
        try:
            yield
        finally:
            camera.close()

    app = FastAPI(title="Video Microscope", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(make_router(camera, frame_store))

    if FRONTEND_DIR.exists():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=False)
```

- [ ] **Step 6: Run all tests**

```bash
python -m pytest tests/ -v
```

Expected: all tests PASS (cameras, calibration, detection, api).

- [ ] **Step 7: Smoke-test the server**

```bash
python -m backend.main
```

Open `http://localhost:8000/camera/info` in a browser.
Expected: JSON with camera info (Baumer if connected, OpenCV fallback otherwise).

---

## Task 8: Frontend shell — index.html + style.css

**Files:**
- Create: `microscope/frontend/index.html`
- Create: `microscope/frontend/style.css`

- [ ] **Step 1: Write style.css**

`microscope/frontend/style.css`:
```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0f172a;
  --surface: #1e293b;
  --border: #334155;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #3b82f6;
  --accent-hover: #2563eb;
  --danger: #ef4444;
  --green: #22c55e;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 13px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Toolbar ── */
#toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tool-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.1s, color 0.1s;
}
.tool-btn:hover { background: var(--border); color: var(--text); }
.tool-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.tool-btn.icon { padding: 4px 8px; font-size: 14px; }

.toolbar-sep { width: 1px; background: var(--border); height: 22px; margin: 0 4px; }

/* ── Main area ── */
#main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ── Video area ── */
#viewer {
  flex: 1;
  position: relative;
  background: #000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

#stream-img {
  max-width: 100%;
  max-height: 100%;
  display: block;
  object-fit: contain;
}

#overlay-canvas {
  position: absolute;
  top: 0; left: 0;
  cursor: crosshair;
  pointer-events: auto;
}

/* ── Sidebar ── */
#sidebar {
  width: 210px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  flex-shrink: 0;
}

.sidebar-section {
  padding: 10px;
  border-bottom: 1px solid var(--border);
}

.sidebar-label {
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 6px;
}

.measurement-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.measurement-item:hover { color: var(--accent); }
.measurement-item.selected { color: var(--accent); }
.measurement-item .del-btn {
  background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px;
}
.measurement-item .del-btn:hover { color: var(--danger); }

.camera-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
}
.camera-row label { color: var(--muted); }
.camera-row input[type=range] { width: 90px; }
.camera-row span { color: var(--text); min-width: 55px; text-align: right; }

.status-line {
  font-size: 11px;
  color: var(--muted);
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}
.status-line.frozen { color: #f59e0b; }
```

- [ ] **Step 2: Write index.html**

`microscope/frontend/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Video Microscope</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>

<div id="toolbar">
  <button class="tool-btn active" data-tool="select">Select</button>
  <button class="tool-btn" data-tool="calibrate">Calibrate</button>
  <button class="tool-btn" data-tool="distance">Distance</button>
  <button class="tool-btn" data-tool="angle">Angle</button>
  <button class="tool-btn" data-tool="circle">Circle</button>
  <button class="tool-btn" data-tool="detect">Detect</button>
  <div class="toolbar-sep"></div>
  <button class="tool-btn icon" id="btn-crosshair" title="Toggle crosshair">⊹</button>
  <button class="tool-btn icon" id="btn-freeze" title="Freeze / Live">❄</button>
  <button class="tool-btn icon" id="btn-load" title="Load image">📁</button>
  <input type="file" id="file-input" accept="image/*" style="display:none">
  <button class="tool-btn icon" id="btn-snapshot" title="Save raw snapshot">📷</button>
  <button class="tool-btn icon" id="btn-export" title="Export annotated image">🖼</button>
  <button class="tool-btn icon" id="btn-clear" title="Clear all annotations" style="margin-left:auto">✕</button>
</div>

<div id="main">
  <div id="viewer">
    <img id="stream-img" src="/stream" alt="camera stream">
    <canvas id="overlay-canvas"></canvas>
  </div>

  <div id="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-label">Measurements</div>
      <div id="measurement-list"></div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">Camera</div>
      <div class="camera-row">
        <label>Exp</label>
        <input type="range" id="exp-slider" min="100" max="100000" step="100" value="5000">
        <span id="exp-value">5000 µs</span>
      </div>
      <div class="camera-row">
        <label>Gain</label>
        <input type="range" id="gain-slider" min="0" max="24" step="0.5" value="0">
        <span id="gain-value">0 dB</span>
      </div>
      <div id="camera-info" style="color:var(--muted);margin-top:6px;line-height:1.6"></div>
    </div>
    <div class="status-line" id="status-line">Live</div>
  </div>
</div>

<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Verify the page loads**

Start the server (`python -m backend.main`) and open `http://localhost:8000`.

Expected: dark-themed page with toolbar, black video area, sidebar. The stream image will load if a camera is connected.

---

## Task 9: Frontend app.js — canvas infrastructure + calibration tool

**Files:**
- Create: `microscope/frontend/app.js`

- [ ] **Step 1: Write the canvas infrastructure and calibration tool**

`microscope/frontend/app.js` (full file — will be extended in later tasks):
```js
// ── State ──────────────────────────────────────────────────────────────────
const state = {
  tool: "select",
  frozen: false,
  crosshair: false,
  calibration: null,   // { pixelsPerMm, displayUnit, pointA, pointB, knownDistance }
  annotations: [],     // [{type, ...data, id}]
  selected: null,      // annotation id
  pendingPoints: [],   // clicks accumulated for current tool
  dragState: null,     // { annotationId, handleKey, startX, startY }
  nextId: 1,
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const img       = document.getElementById("stream-img");
const canvas    = document.getElementById("overlay-canvas");
const ctx       = canvas.getContext("2d");
const statusEl  = document.getElementById("status-line");
const listEl    = document.getElementById("measurement-list");
const cameraInfoEl = document.getElementById("camera-info");

// ── Canvas sizing ──────────────────────────────────────────────────────────
function resizeCanvas() {
  const r = img.getBoundingClientRect();
  canvas.style.left   = r.left - img.parentElement.getBoundingClientRect().left + "px";
  canvas.style.top    = r.top  - img.parentElement.getBoundingClientRect().top  + "px";
  canvas.width  = r.width;
  canvas.height = r.height;
  redraw();
}

new ResizeObserver(resizeCanvas).observe(img);
img.addEventListener("load", resizeCanvas);
window.addEventListener("resize", resizeCanvas);

// ── Tool selection ─────────────────────────────────────────────────────────
document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    state.tool = btn.dataset.tool;
    state.pendingPoints = [];
    document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    canvas.style.cursor = state.tool === "select" ? "default" : "crosshair";
    redraw();
  });
});

// ── Canvas mouse events ────────────────────────────────────────────────────
canvas.addEventListener("mousedown", onMouseDown);
canvas.addEventListener("mousemove", onMouseMove);
canvas.addEventListener("mouseup",   onMouseUp);

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onMouseDown(e) {
  const pt = canvasPoint(e);
  if (state.tool === "select") { handleSelectDown(pt, e); return; }
  handleToolClick(pt);
}

function onMouseMove(e) {
  if (state.dragState) { handleDrag(canvasPoint(e)); }
}

function onMouseUp() {
  state.dragState = null;
}

// ── Keyboard ───────────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected !== null) {
    state.annotations = state.annotations.filter(a => a.id !== state.selected);
    state.selected = null;
    renderSidebar();
    redraw();
  }
  if (e.key === "Escape") {
    state.pendingPoints = [];
    redraw();
  }
});

// ── Tool click handler ─────────────────────────────────────────────────────
function handleToolClick(pt) {
  const tool = state.tool;

  if (tool === "calibrate") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 2) {
      const [a, b] = state.pendingPoints;
      const dist = prompt("Distance between these two points (e.g. '1.000 mm' or '500 µm'):");
      if (dist) {
        const parsed = parseDistanceInput(dist);
        if (parsed) {
          const pxDist = Math.hypot(b.x - a.x, b.y - a.y);
          state.calibration = {
            pixelsPerMm: pxDist / parsed.mm,
            displayUnit: parsed.unit,
            pointA: a,
            pointB: b,
            knownDistance: parsed.value,
          };
          updateCameraInfo();
        }
      }
      state.pendingPoints = [];
    }
    redraw();
    return;
  }

  if (tool === "distance") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 2) {
      const [a, b] = state.pendingPoints;
      addAnnotation({ type: "distance", a, b });
      state.pendingPoints = [];
    }
    redraw();
    return;
  }

  if (tool === "angle") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 3) {
      const [p1, vertex, p3] = state.pendingPoints;
      addAnnotation({ type: "angle", p1, vertex, p3 });
      state.pendingPoints = [];
    }
    redraw();
    return;
  }

  if (tool === "circle") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 3) {
      const [p1, p2, p3] = state.pendingPoints;
      try {
        const { cx, cy, r } = fitCircle(p1, p2, p3);
        addAnnotation({ type: "circle", cx, cy, r });
      } catch {
        alert("Those three points are collinear — can't fit a circle.");
      }
      state.pendingPoints = [];
    }
    redraw();
    return;
  }
}

// ── Calibration input parser ───────────────────────────────────────────────
function parseDistanceInput(input) {
  // accepts "1.5 mm", "500 µm", "0.5mm", etc.
  const m = input.trim().match(/^([0-9.]+)\s*(mm|µm|um)?$/i);
  if (!m) { alert("Could not parse distance. Use format like '1.5 mm' or '500 µm'"); return null; }
  const value = parseFloat(m[1]);
  const unit = (m[2] || "mm").replace("um", "µm").toLowerCase();
  const mm = unit === "µm" ? value / 1000 : value;
  return { value, unit, mm };
}

// ── Circle fit (circumscribed circle through 3 points) ────────────────────
function fitCircle(p1, p2, p3) {
  const ax = p1.x, ay = p1.y;
  const bx = p2.x, by = p2.y;
  const cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-10) throw new Error("collinear");
  const sqA = ax*ax + ay*ay, sqB = bx*bx + by*by, sqC = cx*cx + cy*cy;
  const ux = (sqA*(by-cy) + sqB*(cy-ay) + sqC*(ay-by)) / d;
  const uy = (sqA*(cx-bx) + sqB*(ax-cx) + sqC*(bx-ax)) / d;
  const r  = Math.hypot(ax - ux, ay - uy);
  return { cx: ux, cy: uy, r };
}

// ── Annotation management ──────────────────────────────────────────────────
function addAnnotation(data) {
  const ann = { ...data, id: state.nextId++ };
  state.annotations.push(ann);
  state.selected = ann.id;
  renderSidebar();
}

function measurementLabel(ann) {
  const cal = state.calibration;
  if (ann.type === "distance") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "angle") {
    const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
    const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
    const dot = v1.x*v2.x + v1.y*v2.y;
    const mag = Math.hypot(v1.x,v1.y) * Math.hypot(v2.x,v2.y);
    const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1,Math.min(1,dot/mag))) * 180/Math.PI;
    return `${deg.toFixed(2)}°`;
  }
  if (ann.type === "circle") {
    if (!cal) return `⌀ ${(ann.r * 2).toFixed(1)} px`;
    const mm = (ann.r * 2) / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⌀ ${(mm * 1000).toFixed(2)} µm`
      : `⌀ ${mm.toFixed(3)} mm`;
  }
  return "";
}

// ── Sidebar render ─────────────────────────────────────────────────────────
function renderSidebar() {
  listEl.innerHTML = "";
  state.annotations.forEach((ann, i) => {
    if (ann.type === "detected-edges" || ann.type === "detected-circles") return;
    const row = document.createElement("div");
    row.className = "measurement-item" + (ann.id === state.selected ? " selected" : "");
    row.innerHTML = `<span>&#9312; ${measurementLabel(ann)}</span>
      <button class="del-btn" data-id="${ann.id}">✕</button>`;
    row.querySelector(".del-btn").addEventListener("click", e => {
      e.stopPropagation();
      state.annotations = state.annotations.filter(a => a.id !== ann.id);
      if (state.selected === ann.id) state.selected = null;
      renderSidebar();
      redraw();
    });
    row.addEventListener("click", () => {
      state.selected = ann.id;
      renderSidebar();
      redraw();
    });
    // Fix numbering
    row.querySelector("span").textContent = `${String.fromCodePoint(9312 + i)} ${measurementLabel(ann)}`;
    listEl.appendChild(row);
  });
}

// ── Camera info ────────────────────────────────────────────────────────────
async function loadCameraInfo() {
  try {
    const r = await fetch("/camera/info");
    const d = await r.json();
    cameraInfoEl.innerHTML =
      `<div>${d.model}</div>` +
      `<div style="color:var(--muted)">${d.width}×${d.height}</div>` +
      `<div id="scale-display">${state.calibration ? scaleText() : "Uncalibrated"}</div>`;
    document.getElementById("exp-slider").value = d.exposure;
    document.getElementById("exp-value").textContent = `${d.exposure} µs`;
    document.getElementById("gain-slider").value = d.gain;
    document.getElementById("gain-value").textContent = `${d.gain} dB`;
  } catch { cameraInfoEl.textContent = "Camera unavailable"; }
}

function scaleText() {
  const cal = state.calibration;
  if (!cal) return "Uncalibrated";
  const pxPerUnit = cal.displayUnit === "µm"
    ? cal.pixelsPerMm / 1000
    : cal.pixelsPerMm;
  return `1 px = ${(1/pxPerUnit).toFixed(3)} ${cal.displayUnit}`;
}

function updateCameraInfo() {
  const el = document.getElementById("scale-display");
  if (el) el.textContent = scaleText();
}

document.getElementById("exp-slider").addEventListener("input", async e => {
  const v = parseFloat(e.target.value);
  document.getElementById("exp-value").textContent = `${v} µs`;
  await fetch("/camera/exposure", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({value:v}) });
});

document.getElementById("gain-slider").addEventListener("input", async e => {
  const v = parseFloat(e.target.value);
  document.getElementById("gain-value").textContent = `${v} dB`;
  await fetch("/camera/gain", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({value:v}) });
});

// ── Redraw ─────────────────────────────────────────────────────────────────
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawAnnotations();
  drawPendingPoints();
  drawCrosshair();
}

function drawAnnotations() {
  state.annotations.forEach(ann => {
    const sel = ann.id === state.selected;
    if (ann.type === "distance")        drawDistance(ann, sel);
    else if (ann.type === "angle")      drawAngle(ann, sel);
    else if (ann.type === "circle")     drawCircle(ann, sel);
    else if (ann.type === "edges-overlay") drawEdgesOverlay(ann);
    else if (ann.type === "detected-circles") drawDetectedCircles(ann);
  });
}

function drawLine(a, b, color, width) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawHandle(pt, color) {
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawLabel(text, x, y) {
  ctx.font = "bold 12px ui-monospace, monospace";
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  const m = ctx.measureText(text);
  ctx.fillRect(x - 2, y - 13, m.width + 4, 16);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x, y);
}

function drawDistance(ann, sel) {
  drawLine(ann.a, ann.b, sel ? "#60a5fa" : "#facc15", sel ? 2 : 1.5);
  if (sel) { drawHandle(ann.a, "#60a5fa"); drawHandle(ann.b, "#60a5fa"); }
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

function drawAngle(ann, sel) {
  drawLine(ann.p1, ann.vertex, sel ? "#60a5fa" : "#a78bfa", sel ? 2 : 1.5);
  drawLine(ann.vertex, ann.p3, sel ? "#60a5fa" : "#a78bfa", sel ? 2 : 1.5);
  if (sel) { [ann.p1, ann.vertex, ann.p3].forEach(p => drawHandle(p, "#60a5fa")); }
  drawLabel(measurementLabel(ann), ann.vertex.x + 8, ann.vertex.y - 8);
}

function drawCircle(ann, sel) {
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, 0, Math.PI * 2);
  ctx.strokeStyle = sel ? "#60a5fa" : "#34d399";
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.stroke();
  if (sel) {
    drawHandle({ x: ann.cx, y: ann.cy }, "#60a5fa");
    drawHandle({ x: ann.cx + ann.r, y: ann.cy }, "#60a5fa");
  }
  drawLabel(measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5);
}

function drawEdgesOverlay(ann) {
  ctx.globalAlpha = 0.7;
  ctx.drawImage(ann.image, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1.0;
}

function drawDetectedCircles(ann) {
  ann.circles.forEach(c => {
    const sx = canvas.width / ann.frameWidth;
    const sy = canvas.height / ann.frameHeight;
    ctx.beginPath();
    ctx.arc(c.x * sx, c.y * sy, c.radius * sx, 0, Math.PI * 2);
    ctx.strokeStyle = "#f472b6";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

function drawPendingPoints() {
  state.pendingPoints.forEach(pt => drawHandle(pt, "#fb923c"));
  // Preview line for distance tool
  if (state.tool === "distance" && state.pendingPoints.length === 1) {
    canvas.addEventListener("mousemove", previewLine, { once: false });
  }
}

let _previewHandler = null;
canvas.addEventListener("mousemove", e => {
  if (state.pendingPoints.length > 0 && state.tool !== "select") {
    redraw();
    const pt = canvasPoint(e);
    const last = state.pendingPoints[state.pendingPoints.length - 1];
    drawLine(last, pt, "rgba(251,146,60,0.5)", 1);
  }
});

function drawCrosshair() {
  if (!state.crosshair) return;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, canvas.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
  ctx.setLineDash([]);
}

// ── Init ───────────────────────────────────────────────────────────────────
loadCameraInfo();
resizeCanvas();

// Placeholder stubs — implemented in later tasks
function handleSelectDown(pt, e) {}
function handleDrag(pt) {}
```

- [ ] **Step 2: Verify calibration works end-to-end**

1. Start server: `python -m backend.main`
2. Open `http://localhost:8000`
3. Click **Calibrate**, click two points on the canvas
4. Enter `1.000 mm` in the prompt
5. Expected: scale display in sidebar updates to show `1 px = X.XXX mm`

---

## Task 10: Frontend — Distance and Angle tools

The stubs for distance and angle are already in `app.js` from Task 9 (`handleToolClick`). This task verifies they work and adds the calibration-dependent distance display.

- [ ] **Step 1: Manual test — distance tool**

1. Calibrate first (Task 9 step 2)
2. Click **Distance**, click two points
3. Expected: yellow line with calibrated distance label, measurement appears in sidebar

- [ ] **Step 2: Manual test — angle tool**

1. Click **Angle**, click three points (click the vertex second)
2. Expected: purple angle with degree label at the vertex

- [ ] **Step 3: Manual test — sidebar interaction**

1. Click a measurement in the sidebar → it highlights on canvas
2. Press **Delete** → annotation removed from canvas and sidebar

---

## Task 11: Frontend — Circle 3-point tool

The circle tool stub is already in `app.js`. This task verifies it and tests the edge case.

- [ ] **Step 1: Manual test — circle tool**

1. Click **Circle**, click three points on the visible edge of a round feature
2. Expected: green circle fitted through the three points, diameter label shown

- [ ] **Step 2: Manual test — collinear error**

1. Click three points in a straight line
2. Expected: alert "Those three points are collinear — can't fit a circle."

---

## Task 12: Frontend — Select & Edit (drag handles)

This task fills in the `handleSelectDown` and `handleDrag` stubs in `app.js`.

**Files:**
- Modify: `microscope/frontend/app.js`

- [ ] **Step 1: Implement hit testing**

Replace the `handleSelectDown` stub in `app.js`:

```js
function handleSelectDown(pt, e) {
  // First check drag handles of selected annotation
  if (state.selected !== null) {
    const ann = state.annotations.find(a => a.id === state.selected);
    if (ann) {
      const handle = hitTestHandle(ann, pt);
      if (handle) {
        state.dragState = { annotationId: ann.id, handleKey: handle, startX: pt.x, startY: pt.y };
        return;
      }
    }
  }
  // Then check if we clicked on any annotation body
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    if (hitTestAnnotation(ann, pt)) {
      state.selected = ann.id;
      state.dragState = { annotationId: ann.id, handleKey: "body", startX: pt.x, startY: pt.y };
      renderSidebar();
      redraw();
      return;
    }
  }
  // Clicked empty space — deselect
  state.selected = null;
  renderSidebar();
  redraw();
}

function hitTestHandle(ann, pt) {
  const RADIUS = 8;
  const handles = getHandles(ann);
  for (const [key, hp] of Object.entries(handles)) {
    if (Math.hypot(pt.x - hp.x, pt.y - hp.y) < RADIUS) return key;
  }
  return null;
}

function getHandles(ann) {
  if (ann.type === "distance") return { a: ann.a, b: ann.b };
  if (ann.type === "angle")    return { p1: ann.p1, vertex: ann.vertex, p3: ann.p3 };
  if (ann.type === "circle")   return { center: { x: ann.cx, y: ann.cy }, edge: { x: ann.cx + ann.r, y: ann.cy } };
  return {};
}

function hitTestAnnotation(ann, pt) {
  if (ann.type === "distance") {
    return distPointToSegment(pt, ann.a, ann.b) < 8;
  }
  if (ann.type === "angle") {
    return distPointToSegment(pt, ann.p1, ann.vertex) < 8 ||
           distPointToSegment(pt, ann.vertex, ann.p3) < 8;
  }
  if (ann.type === "circle") {
    const d = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    return Math.abs(d - ann.r) < 10 || d < 10; // near circumference or center dot
  }
  return false;
}

function distPointToSegment(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx*dx + dy*dy;
  if (lenSq < 1e-10) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x-a.x)*dx + (pt.y-a.y)*dy) / lenSq));
  return Math.hypot(pt.x - (a.x + t*dx), pt.y - (a.y + t*dy));
}
```

- [ ] **Step 2: Implement drag**

Replace the `handleDrag` stub:

```js
function handleDrag(pt) {
  if (!state.dragState) return;
  const { annotationId, handleKey } = state.dragState;
  const ann = state.annotations.find(a => a.id === annotationId);
  if (!ann) return;

  const dx = pt.x - state.dragState.startX;
  const dy = pt.y - state.dragState.startY;
  state.dragState.startX = pt.x;
  state.dragState.startY = pt.y;

  if (ann.type === "distance") {
    if (handleKey === "a")    { ann.a.x += dx; ann.a.y += dy; }
    else if (handleKey === "b") { ann.b.x += dx; ann.b.y += dy; }
    else { ann.a.x+=dx; ann.a.y+=dy; ann.b.x+=dx; ann.b.y+=dy; }
  }
  else if (ann.type === "angle") {
    if (handleKey === "p1")     { ann.p1.x+=dx; ann.p1.y+=dy; }
    else if (handleKey === "p3") { ann.p3.x+=dx; ann.p3.y+=dy; }
    else if (handleKey === "vertex") { ann.vertex.x+=dx; ann.vertex.y+=dy; }
    else { ann.p1.x+=dx; ann.p1.y+=dy; ann.vertex.x+=dx; ann.vertex.y+=dy; ann.p3.x+=dx; ann.p3.y+=dy; }
  }
  else if (ann.type === "circle") {
    if (handleKey === "edge") {
      ann.r = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    } else {
      ann.cx += dx; ann.cy += dy;
    }
  }

  renderSidebar();
  redraw();
}
```

- [ ] **Step 3: Manual tests**

1. Draw a distance line → click **Select** → click the line → drag one endpoint → label updates
2. Draw a circle → select it → drag the center → circle moves → drag the edge handle → radius changes
3. Draw an angle → select it → drag the vertex → angle updates
4. Select any annotation → press Delete → removed

---

## Task 13: Frontend — Detection overlays + crosshair

**Files:**
- Modify: `microscope/frontend/app.js`
- Modify: `microscope/frontend/index.html` (detection params panel)

- [ ] **Step 1: Add detection params panel to index.html**

Add this inside `<div id="sidebar">`, after the camera section:

```html
<div class="sidebar-section" id="detect-panel" style="display:none">
  <div class="sidebar-label">Edge Detection</div>
  <div class="camera-row">
    <label>Low</label>
    <input type="range" id="canny-low" min="10" max="255" value="50">
    <span id="canny-low-val">50</span>
  </div>
  <div class="camera-row">
    <label>High</label>
    <input type="range" id="canny-high" min="10" max="255" value="150">
    <span id="canny-high-val">150</span>
  </div>
  <button class="tool-btn" id="btn-run-edges" style="width:100%;margin-top:4px">Run edge detect</button>
  <div class="sidebar-label" style="margin-top:10px">Circle Detection</div>
  <div class="camera-row">
    <label>Sensitivity</label>
    <input type="range" id="hough-p2" min="10" max="80" value="30">
    <span id="hough-p2-val">30</span>
  </div>
  <button class="tool-btn" id="btn-run-circles" style="width:100%;margin-top:4px">Run circle detect</button>
</div>
```

- [ ] **Step 2: Wire up detection in app.js**

Append to `app.js`:

```js
// ── Detect tool ────────────────────────────────────────────────────────────
document.querySelector('[data-tool="detect"]').addEventListener("click", () => {
  document.getElementById("detect-panel").style.display = "block";
});

document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
  if (btn.dataset.tool !== "detect") {
    btn.addEventListener("click", () => {
      document.getElementById("detect-panel").style.display = "none";
    });
  }
});

["canny-low","canny-high","hough-p2"].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener("input", () => {
    document.getElementById(id + "-val").textContent = el.value;
  });
});

document.getElementById("btn-run-edges").addEventListener("click", async () => {
  await ensureFrozen();
  const t1 = parseInt(document.getElementById("canny-low").value);
  const t2 = parseInt(document.getElementById("canny-high").value);
  const r = await fetch("/detect-edges", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ threshold1: t1, threshold2: t2 }),
  });
  if (!r.ok) { alert(await r.text()); return; }
  const blob = await r.blob();
  const img = new Image();
  img.onload = () => {
    // Remove old edge overlay
    state.annotations = state.annotations.filter(a => a.type !== "edges-overlay");
    addAnnotation({ type: "edges-overlay", image: img });
    redraw();
  };
  img.src = URL.createObjectURL(blob);
});

document.getElementById("btn-run-circles").addEventListener("click", async () => {
  await ensureFrozen();
  const p2 = parseInt(document.getElementById("hough-p2").value);
  const r = await fetch("/detect-circles", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ dp:1.2, min_dist:50, param1:100, param2:p2, min_radius:10, max_radius:500 }),
  });
  if (!r.ok) { alert(await r.text()); return; }
  const circles = await r.json();
  // Get stored frame dimensions from last freeze
  state.annotations = state.annotations.filter(a => a.type !== "detected-circles");
  addAnnotation({ type: "detected-circles", circles, frameWidth: state.frozenSize?.w || canvas.width, frameHeight: state.frozenSize?.h || canvas.height });
  redraw();
});

// ── Crosshair toggle ───────────────────────────────────────────────────────
document.getElementById("btn-crosshair").addEventListener("click", () => {
  state.crosshair = !state.crosshair;
  document.getElementById("btn-crosshair").classList.toggle("active", state.crosshair);
  redraw();
});
```

- [ ] **Step 3: Manual test — edge detection**

1. Point camera at a PCB or other high-contrast object
2. Click **Detect**, freeze if prompted, click **Run edge detect**
3. Expected: white edge overlay drawn on top of the canvas at 70% opacity

- [ ] **Step 4: Manual test — circle detection**

1. Point camera at a drilled hole or round feature
2. Click **Run circle detect**
3. Expected: pink circles drawn around detected round features

---

## Task 14: Frontend — Freeze/live, load image, snapshot, annotated export

**Files:**
- Modify: `microscope/frontend/app.js`

- [ ] **Step 1: Implement freeze/live toggle**

Append to `app.js`:

```js
// ── Freeze / Live ──────────────────────────────────────────────────────────
state.frozenSize = null;

async function ensureFrozen() {
  if (!state.frozen) await doFreeze();
}

async function doFreeze() {
  const r = await fetch("/freeze", { method: "POST" });
  if (!r.ok) return;
  const { width, height } = await r.json();
  state.frozenSize = { w: width, h: height };

  // Draw the current visible stream frame onto the canvas before hiding the stream.
  // NOTE: draw the <img> element directly — do NOT re-fetch /stream as an Image src,
  // because /stream is an MJPEG multipart response, not a single JPEG, and browsers
  // will not load it as an <img> src correctly.
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  redraw();

  img.style.opacity = "0";   // hide stream
  state.frozen = true;
  document.getElementById("btn-freeze").classList.add("active");
  statusEl.textContent = "Frozen";
  statusEl.className = "status-line frozen";
}

document.getElementById("btn-freeze").addEventListener("click", async () => {
  if (state.frozen) {
    // Unfreeze
    img.style.opacity = "1";
    state.frozen = false;
    state.frozenBackground = null;
    document.getElementById("btn-freeze").classList.remove("active");
    statusEl.textContent = "Live";
    statusEl.className = "status-line";
    redraw();
  } else {
    await doFreeze();
  }
});

// ── Load image ─────────────────────────────────────────────────────────────
document.getElementById("btn-load").addEventListener("click", () => {
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  const r = await fetch("/load-image", { method: "POST", body: formData });
  if (!r.ok) { alert("Could not load image"); return; }
  const { width, height } = await r.json();
  state.frozenSize = { w: width, h: height };

  const url = URL.createObjectURL(file);
  const loadedImg = new Image();
  loadedImg.onload = () => {
    img.style.opacity = "0";
    state.frozen = true;
    document.getElementById("btn-freeze").classList.add("active");
    statusEl.textContent = "Loaded image";
    statusEl.className = "status-line frozen";
    // Draw loaded image as canvas background
    ctx.drawImage(loadedImg, 0, 0, canvas.width, canvas.height);
    redraw();
  };
  loadedImg.src = url;
  e.target.value = "";
});

// ── Raw snapshot ───────────────────────────────────────────────────────────
document.getElementById("btn-snapshot").addEventListener("click", async () => {
  const r = await fetch("/snapshot", { method: "POST" });
  if (!r.ok) { alert("Snapshot failed"); return; }
  const { filename } = await r.json();
  // Briefly flash a status message
  const prev = statusEl.textContent;
  statusEl.textContent = `Saved: ${filename}`;
  setTimeout(() => { statusEl.textContent = prev; }, 2000);
});

// ── Annotated export ───────────────────────────────────────────────────────
document.getElementById("btn-export").addEventListener("click", () => {
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `microscope_${new Date().toISOString().replace(/[:.]/g,"-")}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
});

// ── Clear all annotations ──────────────────────────────────────────────────
document.getElementById("btn-clear").addEventListener("click", () => {
  if (confirm("Clear all annotations?")) {
    state.annotations = [];
    state.selected = null;
    renderSidebar();
    redraw();
  }
});
```

- [ ] **Step 2: Manual test — freeze**

1. Click **❄** — stream freezes, button turns blue, status shows "Frozen"
2. Draw a measurement on the frozen frame
3. Click **❄** again — stream resumes, annotations persist

- [ ] **Step 3: Manual test — load image**

1. Click **📁**, select a JPEG or PNG from disk
2. Expected: image fills the viewer, measurements can be drawn on it

- [ ] **Step 4: Manual test — snapshot**

1. Click **📷**
2. Expected: status briefly shows `Saved: 20260321_HHMMSS.jpg`, file appears in `microscope/snapshots/`

- [ ] **Step 5: Manual test — annotated export**

1. Draw some measurements
2. Click **🖼**
3. Expected: PNG downloaded to browser's downloads folder, containing both the image and annotation overlays

---

## Task 15: Full integration smoke test

- [ ] **Step 1: Run all automated tests one final time**

```bash
cd /Users/qsmits/Projects/MainDynamics/microscope
source .venv/bin/activate
python -m pytest tests/ -v
```

Expected: all tests PASS.

- [ ] **Step 2: Start with Baumer camera**

Connect the VCXU-32C. Start the server:

```bash
python -m backend.main
```

Open `http://localhost:8000`. Verify:
- Live stream from Baumer camera visible
- Calibrate with a known feature (e.g. a 1mm calibration target)
- Measure a feature with the distance tool
- Measure an angle
- Fit a circle on a round feature using 3-point tool
- Select and drag an annotation
- Freeze, run edge detection, run circle detection
- Export annotated PNG

- [ ] **Step 3: Test LAN access**

From a second device on the same network, open `http://<mac-ip>:8000`.

Expected: full app accessible, live stream visible. Measurement state is per-browser (frontend-only calibration).
