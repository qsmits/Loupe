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

    def capture_hdr_bracket(
        self,
        stops: list[float],
        settle_s: float = 0.15,
        drain_frames: int = 3,
    ) -> list[np.ndarray]:
        """Synchronously capture a bracket of frames at different exposures.

        Pauses the reader thread so this method owns the camera, then for each
        EV stop in ``stops``:
          1. sets exposure = baseline * 2**stop
          2. sleeps ``settle_s`` to let the new exposure take effect
          3. drains ``drain_frames`` buffered frames (which may still be at the
             old exposure) and keeps the last fresh one
        The baseline exposure is restored in a try/finally so a failure can't
        leave the camera at a bracketed value.  The reader thread is restarted
        on return.

        Returns a list of BGR numpy frames, one per stop, in the same order.
        """
        with self._format_lock:
            if self._thread is None:
                raise RuntimeError("CameraReader is not open")
            # Read baseline exposure up-front — if this fails, don't touch the reader.
            info = self._camera.get_info()
            baseline = float(info.get("exposure", 0.0))
            if baseline <= 0.0:
                raise RuntimeError("Could not read baseline exposure")

            # Stop reader so we have exclusive access to the camera.
            self._stop.set()
            if self._thread is not None:
                self._thread.join(timeout=2)
                if self._thread.is_alive():
                    raise RuntimeError(
                        "Reader thread did not stop within 2 s; aborting HDR bracket."
                    )

            frames: list[np.ndarray] = []
            try:
                for stop in stops:
                    target = baseline * (2.0 ** float(stop))
                    self._camera.set_exposure(target)
                    # Wait for the exposure change to take effect.  Sleep must
                    # exceed the new exposure duration, otherwise the next
                    # buffer will still be integrating at the old value.
                    settle = max(settle_s, (target / 1_000_000.0) * 1.5)
                    time.sleep(settle)
                    # Drain stale buffers queued before the exposure change.
                    last: np.ndarray | None = None
                    for _ in range(max(1, drain_frames)):
                        last = self._camera.get_frame()
                    if last is None:
                        raise RuntimeError("Camera returned no frame during bracket")
                    frames.append(last.copy())
            finally:
                # Always restore baseline, even if a shot failed.
                try:
                    self._camera.set_exposure(baseline)
                except Exception as e:
                    _log.warning("Failed to restore baseline exposure: %s", e)
                # Restart reader thread.
                self._stop.clear()
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()

            return frames

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

    def set_gamma(self, value: float) -> None:
        self._camera.set_gamma(value)

    def get_gamma(self) -> float:
        return self._camera.get_gamma()

    def set_auto_exposure(self) -> float:
        # Blocking (polls for up to ~2s) — call via asyncio.to_thread in API
        return self._camera.set_auto_exposure()

    def set_roi(self, offset_x, offset_y, width, height):
        with self._format_lock:
            if self._thread is None:
                raise RuntimeError("CameraReader is not open")
            self._stop.set()
            if self._thread is not None:
                self._thread.join(timeout=2)
                if self._thread.is_alive():
                    raise RuntimeError("Reader thread did not stop within 2 s; aborting ROI change.")
            self._camera.set_roi(offset_x, offset_y, width, height)
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def reset_roi(self):
        with self._format_lock:
            if self._thread is None:
                raise RuntimeError("CameraReader is not open")
            self._stop.set()
            if self._thread is not None:
                self._thread.join(timeout=2)
                if self._thread.is_alive():
                    raise RuntimeError("Reader thread did not stop within 2 s; aborting ROI reset.")
            self._camera.reset_roi()
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

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

    try:
        while not (hasattr(camera, '_stop') and camera._stop.is_set()):
            start = loop.time()

            frame = camera.get_frame()
            # Apply the 4-up "compare" post-processing profile if one is active.
            # Import lazily to avoid a circular import (api_compare -> cameras -> stream).
            try:
                from .api_compare import get_active_profile
                from .vision.settings_proposer import apply_variant
                profile = get_active_profile()
                if profile is not None:
                    frame = apply_variant(frame, profile)
            except Exception as e:  # pragma: no cover - defensive
                _log.warning("compare profile apply failed: %s", e)
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
    except (asyncio.CancelledError, GeneratorExit):
        return
