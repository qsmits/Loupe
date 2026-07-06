import threading
import time
from unittest.mock import MagicMock, patch
import pytest
import numpy as np
from backend.cameras.opencv import OpenCVCamera
from backend.cameras.base import BaseCamera
from backend.cameras.null import NullCamera
from backend.stream import CameraReader


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


def test_get_frame_before_open_raises():
    cam = OpenCVCamera(index=0)
    with pytest.raises(RuntimeError):
        cam.get_frame()


def test_open_raises_when_camera_unavailable():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = False

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        with pytest.raises(RuntimeError):
            cam.open()


def test_opencv_camera_get_info_includes_pixel_format():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True
    mock_cap.get.side_effect = lambda prop: {3: 640.0, 4: 480.0}.get(prop, 0.0)

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        cam.open()
        info = cam.get_info()

    assert "pixel_format" in info
    assert info["pixel_format"] == "n/a"


def test_opencv_camera_set_pixel_format_is_noop():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        cam.open()
        cam.set_pixel_format("BayerRG8")  # must not raise


def test_camera_reader_set_pixel_format_delegates():
    # Inline fake — do NOT import from tests/conftest.py (conftest is a pytest
    # plugin file, not a regular importable module; direct import will fail).
    class MinimalFake(BaseCamera):
        def open(self): pass
        def close(self): pass
        def get_frame(self): return np.zeros((480, 640, 3), dtype=np.uint8)
        def set_exposure(self, us): pass
        def set_gain(self, db): pass
        def get_info(self): return {}
        def set_pixel_format(self, fmt): pass
        def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_ratio(self, channel, value): pass

    reader = CameraReader(MinimalFake())
    reader.open()
    reader.set_pixel_format("Mono8")  # must not raise
    reader.close()


def test_camera_reader_set_pixel_format_calls_inner_camera():
    inner = MagicMock(spec=["open", "close", "get_frame", "set_exposure",
                             "set_gain", "get_info", "set_pixel_format"])
    inner.get_frame.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
    reader = CameraReader(inner)
    reader.open()
    reader.set_pixel_format("Mono8")
    inner.set_pixel_format.assert_called_once_with("Mono8")
    reader.close()


def test_opencv_camera_get_white_balance_returns_ones():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        cam.open()
        wb = cam.get_white_balance()

    assert wb == {"red": 1.0, "green": 1.0, "blue": 1.0}


def test_opencv_camera_set_white_balance_ratio_is_noop():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        cam.open()
        cam.set_white_balance_ratio("Red", 1.5)  # must not raise


def test_opencv_camera_set_white_balance_auto_returns_ones():
    mock_cap = MagicMock()
    mock_cap.isOpened.return_value = True

    with patch("backend.cameras.opencv.cv2.VideoCapture", return_value=mock_cap):
        cam = OpenCVCamera(index=0)
        cam.open()
        result = cam.set_white_balance_auto()

    assert result == {"red": 1.0, "green": 1.0, "blue": 1.0}


def test_camera_reader_delegates_white_balance_methods():
    # Inline fake — do NOT import from tests/conftest.py (conftest is a pytest
    # plugin file, not a regular importable module; direct import will fail).
    class MinimalFake(BaseCamera):
        def open(self): pass
        def close(self): pass
        def get_frame(self): return np.zeros((480, 640, 3), dtype=np.uint8)
        def set_exposure(self, us): pass
        def set_gain(self, db): pass
        def get_info(self): return {}
        def set_pixel_format(self, fmt): pass
        def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_ratio(self, channel, value): pass

    reader = CameraReader(MinimalFake())
    reader.open()
    wb = reader.get_white_balance()          # must not raise
    reader.set_white_balance_ratio("Red", 1.2)  # must not raise
    reader.close()
    assert wb == {"red": 1.0, "green": 1.0, "blue": 1.0}


def test_camera_reader_wb_ratio_calls_inner_camera():
    inner = MagicMock(spec=["open", "close", "get_frame", "set_exposure",
                             "set_gain", "get_info", "set_pixel_format",
                             "get_white_balance", "set_white_balance_auto",
                             "set_white_balance_ratio"])
    inner.get_frame.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
    reader = CameraReader(inner)
    reader.open()
    reader.set_white_balance_ratio("Blue", 0.9)
    inner.set_white_balance_ratio.assert_called_once_with("Blue", 0.9)
    reader.close()


def test_null_camera_is_null():
    assert NullCamera().is_null is True


def test_base_camera_is_null_false():
    # FakeCamera (defined in this file) is a concrete BaseCamera — must return False
    class MinimalFake(BaseCamera):
        def open(self): pass
        def close(self): pass
        def get_frame(self): return np.zeros((480, 640, 3), dtype=np.uint8)
        def set_exposure(self, us): pass
        def set_gain(self, db): pass
        def get_info(self): return {}
        def set_pixel_format(self, fmt): pass
        def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_ratio(self, channel, value): pass
    assert MinimalFake().is_null is False


def test_null_camera_open_close_noop():
    cam = NullCamera()
    cam.open()   # must not raise
    cam.close()  # must not raise


def test_null_camera_get_frame_returns_gray_blank():
    cam = NullCamera()
    frame = cam.get_frame()
    assert frame.shape == (480, 640, 3)
    assert frame.dtype == np.uint8
    assert int(frame[0, 0, 0]) == 80  # gray value


def test_null_camera_get_info_returns_dict_with_no_camera_flag():
    info = NullCamera().get_info()
    assert info["no_camera"] is True
    assert "model" in info


def test_null_camera_control_methods_raise():
    cam = NullCamera()
    with pytest.raises(NotImplementedError):
        cam.set_exposure(1000)
    with pytest.raises(NotImplementedError):
        cam.set_gain(0)
    with pytest.raises(NotImplementedError):
        cam.set_pixel_format("Mono8")
    with pytest.raises(NotImplementedError):
        cam.get_white_balance()
    with pytest.raises(NotImplementedError):
        cam.set_white_balance_auto()
    with pytest.raises(NotImplementedError):
        cam.set_white_balance_ratio("Red", 1.0)


def test_camera_reader_is_null_false_for_real_camera():
    class MinimalFake(BaseCamera):
        def open(self): pass
        def close(self): pass
        def get_frame(self): return np.zeros((480, 640, 3), dtype=np.uint8)
        def set_exposure(self, us): pass
        def set_gain(self, db): pass
        def get_info(self): return {}
        def set_pixel_format(self, fmt): pass
        def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
        def set_white_balance_ratio(self, ch, v): pass
    reader = CameraReader(MinimalFake())
    assert reader.is_null is False


def test_camera_reader_is_null_true_for_null_camera():
    reader = CameraReader(NullCamera())
    assert reader.is_null is True


# ═══════════════════════════════════════════════════════════════════════════
# Camera lifecycle hardening (blocking get_frame, failed reconfigure, races)
# ═══════════════════════════════════════════════════════════════════════════


class _ReaderFake(BaseCamera):
    """Instrumented fake for CameraReader lifecycle tests.

    - counts get_frame calls (``frames_served``)
    - can be made to block inside get_frame (``block`` / ``release`` /
      ``entered`` events) to simulate a wedged driver
    - records whether close() was called (``close_called``)
    """

    def __init__(self):
        self.frames_served = 0
        self.block = threading.Event()     # when set, get_frame blocks
        self.release = threading.Event()   # set to unblock get_frame
        self.entered = threading.Event()   # a get_frame call is blocked inside
        self.close_called = threading.Event()
        self.closed = False

    def open(self):
        self.closed = False

    def close(self):
        self.close_called.set()
        self.closed = True

    def get_frame(self):
        if self.block.is_set():
            self.entered.set()
            self.release.wait(timeout=30)
        self.frames_served += 1
        return np.zeros((16, 16, 3), dtype=np.uint8)

    def set_exposure(self, us): pass
    def set_gain(self, db): pass
    def get_info(self): return {"exposure": 5000.0}
    def set_pixel_format(self, fmt): pass
    def get_white_balance(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
    def set_white_balance_auto(self): return {"red": 1.0, "green": 1.0, "blue": 1.0}
    def set_white_balance_ratio(self, channel, value): pass


def _wait_for(predicate, timeout=5.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def test_reader_close_skips_camera_close_when_thread_stuck():
    """If the reader thread is wedged inside get_frame(), close() must return
    in bounded time WITHOUT calling camera.close() — freeing a native handle
    under a live thread is a use-after-free (leak-not-crash contract)."""
    cam = _ReaderFake()
    reader = CameraReader(cam)
    reader.open()
    try:
        assert _wait_for(lambda: cam.frames_served > 0)
        cam.block.set()
        assert cam.entered.wait(timeout=5.0)

        t0 = time.monotonic()
        reader.close()
        elapsed = time.monotonic() - t0

        assert elapsed < 6.5, f"close() took {elapsed:.1f}s"
        assert not cam.close_called.is_set(), (
            "camera.close() was called while the reader thread was still "
            "inside camera.get_frame() — native use-after-free"
        )
    finally:
        # Unblock so the orphaned thread can exit cleanly.
        cam.release.set()
        if reader._thread is not None:
            reader._thread.join(timeout=5.0)


def test_reader_close_closes_camera_when_thread_stops_cleanly():
    cam = _ReaderFake()
    reader = CameraReader(cam)
    reader.open()
    assert _wait_for(lambda: cam.frames_served > 0)
    reader.close()
    assert cam.close_called.is_set()


def test_reader_set_roi_failure_respawns_reader():
    """A camera-level set_roi failure must propagate, but the reader thread
    must be respawned so the live view survives the failed reconfigure."""
    class RoiFailCamera(_ReaderFake):
        def set_roi(self, *a):
            raise RuntimeError("ROI rejected by camera")

    cam = RoiFailCamera()
    reader = CameraReader(cam)
    reader.open()
    try:
        assert _wait_for(lambda: cam.frames_served > 0)

        with pytest.raises(RuntimeError, match="ROI rejected"):
            reader.set_roi(0, 0, 8, 8)

        assert reader._thread is not None and reader._thread.is_alive(), (
            "reader thread not respawned after failed set_roi — dead live view"
        )
        assert not reader._stop.is_set()
        n0 = cam.frames_served
        assert _wait_for(lambda: cam.frames_served > n0), (
            "reader stopped serving frames after failed set_roi"
        )
    finally:
        reader.close()


def test_reader_set_roi_join_timeout_recovers_live_view():
    """If the reader thread can't be stopped (wedged in get_frame), set_roi
    must abort with an error, must NOT touch the camera, and the reader must
    survive: once the driver unwedges, frames flow again."""
    class RoiTrackingCamera(_ReaderFake):
        def __init__(self):
            super().__init__()
            self.roi_calls = 0

        def set_roi(self, *a):
            self.roi_calls += 1

    cam = RoiTrackingCamera()
    reader = CameraReader(cam)
    reader._join_timeout_reconfig = 0.3  # keep the test fast
    reader.open()
    try:
        assert _wait_for(lambda: cam.frames_served > 0)
        cam.block.set()
        assert cam.entered.wait(timeout=5.0)

        with pytest.raises(RuntimeError, match="did not stop"):
            reader.set_roi(0, 0, 8, 8)

        assert cam.roi_calls == 0, (
            "set_roi reached the camera while the reader thread was live"
        )

        # Unwedge the driver: the reader must resume serving frames.
        cam.block.clear()
        cam.release.set()
        n0 = cam.frames_served
        assert _wait_for(lambda: cam.frames_served > n0), (
            "live view did not survive the aborted ROI change"
        )
        assert not reader._stop.is_set()
    finally:
        cam.release.set()
        reader.close()


def test_reader_set_pixel_format_failure_respawns_reader():
    class PixFailCamera(_ReaderFake):
        def set_pixel_format(self, fmt):
            raise RuntimeError("format rejected")

    cam = PixFailCamera()
    reader = CameraReader(cam)
    reader.open()
    try:
        assert _wait_for(lambda: cam.frames_served > 0)
        with pytest.raises(RuntimeError, match="format rejected"):
            reader.set_pixel_format("Mono8")
        assert reader._thread is not None and reader._thread.is_alive()
        n0 = cam.frames_served
        assert _wait_for(lambda: cam.frames_served > n0)
    finally:
        reader.close()


def test_concurrent_set_exposure_during_switch_camera():
    """set_exposure racing switch_camera must never reach a closed camera
    (native use-after-free) — it must serialize behind the switch and land
    on the new camera."""
    class OldCamera(_ReaderFake):
        def __init__(self):
            super().__init__()
            self.exposure_after_close = False

        def set_exposure(self, us):
            if self.closed:
                self.exposure_after_close = True
                raise AssertionError("set_exposure on closed camera")

    class NewCamera(_ReaderFake):
        def __init__(self):
            super().__init__()
            self.exposure_calls = []

        def open(self):
            super().open()
            time.sleep(0.5)  # slow open widens the race window

        def set_exposure(self, us):
            self.exposure_calls.append(us)

    old_cam = OldCamera()
    new_cam = NewCamera()
    reader = CameraReader(old_cam)
    reader.open()
    errors: list[BaseException] = []

    def do_switch():
        try:
            reader.switch_camera(new_cam)
        except BaseException as e:  # pragma: no cover - failure reporting
            errors.append(e)

    def do_exposure():
        try:
            reader.set_exposure(1234.0)
        except BaseException as e:
            errors.append(e)

    try:
        assert _wait_for(lambda: old_cam.frames_served > 0)
        t_switch = threading.Thread(target=do_switch)
        t_switch.start()
        # Let the switch acquire the lock and close the old camera,
        # then fire set_exposure mid-switch.
        assert _wait_for(lambda: old_cam.closed, timeout=5.0)
        t_exp = threading.Thread(target=do_exposure)
        t_exp.start()
        t_switch.join(timeout=10.0)
        t_exp.join(timeout=10.0)
        assert not t_switch.is_alive() and not t_exp.is_alive()

        assert errors == [], f"unexpected errors: {errors}"
        assert not old_cam.exposure_after_close, (
            "set_exposure hit the old camera after it was closed"
        )
        assert new_cam.exposure_calls == [1234.0]
        assert reader._camera is new_cam
        assert reader._thread is not None and reader._thread.is_alive()
    finally:
        reader.close()


def test_get_stats_concurrent_with_streaming():
    """get_stats() iterates _frame_times while the reader thread appends —
    both must use the same lock (no 'deque mutated during iteration')."""
    cam = _ReaderFake()
    reader = CameraReader(cam, fps=200)
    reader.open()
    try:
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            stats = reader.get_stats()
            assert "fps" in stats
    finally:
        reader.close()


# ═══════════════════════════════════════════════════════════════════════════
# dc1394 multi-shot re-arm interval (pure function — no dylib required)
# ═══════════════════════════════════════════════════════════════════════════


def test_compute_rearm_interval_unknown_fps_falls_back_to_5s():
    from backend.cameras.dc1394 import compute_rearm_interval
    assert compute_rearm_interval(None) == 5.0
    assert compute_rearm_interval(0.0) == 5.0
    assert compute_rearm_interval(-10.0) == 5.0
    assert compute_rearm_interval(float("nan")) == 5.0
    assert compute_rearm_interval(float("inf")) == 5.0


def test_compute_rearm_interval_low_fps_preserves_legacy_cadence():
    from backend.cameras.dc1394 import compute_rearm_interval
    # At <= ~25 fps a 255-frame batch lasts >= 10 s; the legacy 5 s cadence
    # is already conservative and is kept as the ceiling.
    assert compute_rearm_interval(5.0) == 5.0
    assert compute_rearm_interval(20.0) == 5.0


def test_compute_rearm_interval_tracks_half_batch():
    from backend.cameras.dc1394 import compute_rearm_interval
    # Re-arm when ~half of the 255-frame batch is consumed: 0.5 * 255 / fps.
    assert compute_rearm_interval(30.0) == pytest.approx(4.25)
    assert compute_rearm_interval(60.0) == pytest.approx(2.125)
    assert compute_rearm_interval(100.0) == pytest.approx(1.275)


def test_compute_rearm_interval_high_fps_clamped_to_floor():
    from backend.cameras.dc1394 import compute_rearm_interval
    assert compute_rearm_interval(500.0) == pytest.approx(0.255)
    assert compute_rearm_interval(1000.0) == 0.25  # floor
    assert compute_rearm_interval(1e9) == 0.25


def test_compute_rearm_interval_never_exceeds_batch_duration():
    from backend.cameras.dc1394 import compute_rearm_interval
    # For any plausible fps the interval must be well under the batch
    # duration (255/fps) OR at the 5 s legacy fallback for slow cameras.
    for fps in (26, 40, 60, 75, 100, 150, 200, 300, 500):
        interval = compute_rearm_interval(float(fps))
        batch = 255.0 / fps
        assert interval <= 0.6 * batch, (fps, interval, batch)
