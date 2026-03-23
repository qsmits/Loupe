import logging
import cv2
import numpy as np
from .base import BaseCamera

logger = logging.getLogger(__name__)


class OpenCVCamera(BaseCamera):
    def __init__(self, index: int = 0):
        self._index = index
        self._cap: cv2.VideoCapture | None = None

    def open(self) -> None:
        self._cap = cv2.VideoCapture(self._index)
        if not self._cap.isOpened():
            raise RuntimeError(f"Cannot open camera at index {self._index}")
        # Request a workable resolution and framerate; the driver may override these
        # but it prevents the camera defaulting to 4K/1fps which stalls the stream.
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
        self._cap.set(cv2.CAP_PROP_FPS, 15)

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def get_frame(self) -> np.ndarray:
        if self._cap is None:
            raise RuntimeError("Camera not open")
        ok, frame = self._cap.read()
        if not ok:
            raise RuntimeError("Failed to read frame")
        return frame

    def set_exposure(self, microseconds: float) -> None:
        if self._cap is None:
            raise RuntimeError("Camera not open")
        ok = self._cap.set(cv2.CAP_PROP_EXPOSURE, microseconds / 1000.0)
        if not ok:
            logger.warning("CAP_PROP_EXPOSURE is not supported by this camera")

    def set_gain(self, db: float) -> None:
        if self._cap is None:
            raise RuntimeError("Camera not open")
        ok = self._cap.set(cv2.CAP_PROP_GAIN, db)
        if not ok:
            logger.warning("CAP_PROP_GAIN is not supported by this camera")

    def get_info(self) -> dict[str, object]:
        width = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) if self._cap is not None else 0
        height = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) if self._cap is not None else 0
        exposure = self._cap.get(cv2.CAP_PROP_EXPOSURE) if self._cap is not None else 0.0
        gain = self._cap.get(cv2.CAP_PROP_GAIN) if self._cap is not None else 0.0
        return {
            "model": "OpenCV Camera",
            "serial": f"index-{self._index}",
            "width": width,
            "height": height,
            "exposure": exposure,
            "gain": gain,
            "pixel_format": "n/a",
            "device_id": "opencv-0",
            "wb_red": 1.0,
            "wb_green": 1.0,
            "wb_blue": 1.0,
            "wb_manual_supported": False,
        }

    def set_pixel_format(self, fmt: str) -> None:
        pass  # OpenCV does not expose pixel format selection

    def get_white_balance(self) -> dict[str, float]:
        return {"red": 1.0, "green": 1.0, "blue": 1.0}

    def set_white_balance_auto(self) -> dict[str, float]:
        return {"red": 1.0, "green": 1.0, "blue": 1.0}

    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        pass  # OpenCV does not support hardware white balance
