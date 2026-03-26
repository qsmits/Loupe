import asyncio
import logging
import threading
import time
import cv2
import numpy as np
from .cameras.base import BaseCamera

_log = logging.getLogger(__name__)

BOUNDARY = b"frame"

_BLANK = np.zeros((480, 640, 3), dtype=np.uint8)


class CameraReader(BaseCamera):
    """
    Wraps a BaseCamera and owns a single background thread that continuously
    reads frames.  All callers use get_frame() which returns the latest
    buffered frame — no concurrent access to the underlying camera.

    This avoids the AVFoundation thread-safety crash on macOS where
    cv2.VideoCapture.read() must not be called from arbitrary threads.
    """

    def __init__(self, camera: BaseCamera, fps: int = 30):
        self._camera = camera
        self._interval = 1.0 / fps
        self._lock = threading.Lock()
        self._format_lock = threading.Lock()
        self._wb_lock = threading.Lock()
        self._latest: np.ndarray | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ── BaseCamera interface ────────────────────────────────────────────────

    def open(self) -> None:
        # NOTE: _camera.open() is called first, before _stop.clear() or _thread.start().
        # If _camera.open() raises, _thread remains None and _stop is still in its
        # initial (set) state — so it is safe to replace _camera and call open() again
        # after a failure (as done in the lifespan fallback in main.py).
        self._camera.open()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)  # Camera timeout_pop_buffer is 2s, need headroom
        self._camera.close()

    def get_frame(self) -> np.ndarray:
        with self._lock:
            frame = self._latest
        return frame.copy() if frame is not None else _BLANK.copy()

    def set_exposure(self, microseconds: float) -> None:
        self._camera.set_exposure(microseconds)

    def set_gain(self, db: float) -> None:
        self._camera.set_gain(db)

    def set_pixel_format(self, fmt: str) -> None:
        with self._format_lock:
            if self._thread is None:
                raise RuntimeError("CameraReader is not open")
            # Stop the reader thread so no concurrent get_frame() calls race
            # against the Aravis stream restart inside set_pixel_format().
            self._stop.set()
            if self._thread is not None:
                self._thread.join(timeout=2)
                if self._thread.is_alive():
                    raise RuntimeError(
                        "Reader thread did not stop within 2 s; aborting pixel format change."
                    )
            # Delegate to the inner camera (thread is stopped — safe).
            self._camera.set_pixel_format(fmt)
            # Restart the reader thread.
            # Note: _run() will start calling get_frame() immediately. AravisCamera's
            # set_pixel_format() ensures start_acquisition() completes before returning,
            # so by the time we reach here the camera is ready. No additional delay needed.
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def switch_camera(self, new_camera: BaseCamera) -> None:
        """
        Live-swap the underlying camera. Stops the reader thread, closes the
        old camera, opens the new one, and restarts the thread.
        Uses _format_lock to prevent concurrent pixel-format changes and
        concurrent switch_camera calls.
        If the new camera fails to open, the old one is restored and an
        exception is raised.
        """
        with self._format_lock:
            self._stop.set()
            if self._thread is not None:
                self._thread.join(timeout=5)
                if self._thread.is_alive():
                    raise RuntimeError(
                        "Reader thread did not stop within 5 s; aborting camera switch."
                    )
            old_camera = self._camera
            try:
                # Close old camera FIRST to release the USB/GigE device,
                # then open the new one. Necessary because USB cameras can't
                # have two handles open on the same device simultaneously.
                old_camera.close()
                new_camera.open()
                self._camera = new_camera
            except Exception as switch_err:
                # new_camera.open() failed; try to reopen the old camera
                try:
                    old_camera.open()
                    self._camera = old_camera
                except Exception:
                    # Old camera also failed to reopen — fall back to NullCamera
                    from .cameras.null import NullCamera
                    self._camera = NullCamera()
                    self._camera.open()
                    _log.warning("Camera switch failed and old camera could not reopen; using NullCamera")
                self._stop.clear()
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()
                raise switch_err
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def get_info(self) -> dict[str, object]:
        return self._camera.get_info()

    def get_white_balance(self) -> dict[str, float]:
        with self._wb_lock:
            return self._camera.get_white_balance()

    def set_white_balance_auto(self) -> dict[str, float]:
        # Blocking (up to ~1 s polling) — call via asyncio.to_thread in the API layer.
        with self._wb_lock:
            return self._camera.set_white_balance_auto()

    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        with self._wb_lock:
            return self._camera.set_white_balance_ratio(channel, value)

    @property
    def is_null(self) -> bool:
        return self._camera.is_null

    # ── Internal ───────────────────────────────────────────────────────────

    def _run(self) -> None:
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                frame = self._camera.get_frame()
                with self._lock:
                    self._latest = frame
            except Exception as e:
                _log.warning("get_frame() error: %s", e)
            elapsed = time.monotonic() - t0
            time.sleep(max(0.0, self._interval - elapsed))


async def mjpeg_generator(camera: BaseCamera, fps: int = 30):
    """
    Async generator yielding MJPEG multipart chunks.
    Expects `camera` to be a CameraReader (or any BaseCamera whose get_frame()
    is safe to call from the event loop thread).
    """
    interval = 1.0 / fps
    loop = asyncio.get_running_loop()

    while True:
        start = loop.time()

        frame = camera.get_frame()
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
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
