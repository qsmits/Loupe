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
