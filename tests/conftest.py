import numpy as np
import pytest
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
    def set_pixel_format(self, fmt: str) -> None: pass

    def get_white_balance(self) -> dict[str, float]:
        return {"red": 1.0, "green": 1.0, "blue": 1.0}

    def set_white_balance_auto(self) -> dict[str, float]:
        return {"red": 1.0, "green": 1.0, "blue": 1.0}

    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        pass

    def get_info(self) -> dict[str, object]:
        return {
            "model": "FakeCamera",
            "serial": "FAKE-001",
            "width": 640,
            "height": 480,
            "exposure": 5000.0,
            "gain": 0.0,
            "pixel_format": "BayerRG8",
            "device_id": "fake-0",
            "wb_red": 1.0,
            "wb_green": 1.0,
            "wb_blue": 1.0,
            "wb_manual_supported": True,
        }


@pytest.fixture
def client():
    from backend.main import create_app
    camera = FakeCamera()
    app = create_app(camera)
    with TestClient(app) as c:
        yield c
