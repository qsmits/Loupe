import numpy as np
from .base import BaseCamera


_BLANK_FRAME = np.full((480, 640, 3), 80, dtype=np.uint8)


class NullCamera(BaseCamera):
    """Camera stub for camera-less operation. Returns gray blank frames."""

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def get_frame(self) -> np.ndarray:
        return _BLANK_FRAME.copy()

    def get_info(self) -> dict[str, object]:
        return {
            "model": "None",
            "serial": "",
            "width": 640,
            "height": 480,
            "exposure": 0,
            "gain": 0,
            "pixel_format": "",
            "device_id": "",
            "wb_red": 1.0,
            "wb_green": 1.0,
            "wb_blue": 1.0,
            "wb_manual_supported": False,
            "no_camera": True,
        }

    @property
    def is_null(self) -> bool:
        return True

    def set_exposure(self, microseconds: float) -> None:
        raise NotImplementedError("No camera")

    def set_gain(self, db: float) -> None:
        raise NotImplementedError("No camera")

    def set_pixel_format(self, fmt: str) -> None:
        raise NotImplementedError("No camera")

    def get_white_balance(self) -> dict[str, float]:
        raise NotImplementedError("No camera")

    def set_white_balance_auto(self) -> dict[str, float]:
        raise NotImplementedError("No camera")

    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        raise NotImplementedError("No camera")
