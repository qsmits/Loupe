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
            "exposure_min": 100.0,
            "exposure_max": 100000.0,
            "gain": 0,
            "gain_min": 0.0,
            "gain_max": 24.0,
            "pixel_format": "",
            "device_id": "",
            "wb_red": 1.0,
            "wb_green": 1.0,
            "wb_blue": 1.0,
            "wb_manual_supported": False,
            "no_camera": True,
            "supports": {"wb_manual": False, "wb_auto": False, "auto_exposure": False, "gamma": False, "roi": False},
            "gamma": 1.0, "gamma_min": 0.5, "gamma_max": 2.0,
            "roi": {"offset_x": 0, "offset_y": 0, "width": 640, "height": 480},
            "sensor_width": 640, "sensor_height": 480,
            "roi_width_inc": 4, "roi_height_inc": 4,
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
