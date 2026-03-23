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
    def get_info(self) -> dict[str, object]:
        """Return dict with keys: model, serial, width, height, exposure, gain, pixel_format, wb_red, wb_green, wb_blue."""

    @abstractmethod
    def set_pixel_format(self, fmt: str) -> None:
        """Set the pixel format (e.g. 'BayerRG8'). No-op on cameras that don't support it."""

    @abstractmethod
    def get_white_balance(self) -> dict[str, float]:
        """Return white balance ratios as {"red": float, "green": float, "blue": float}."""

    @abstractmethod
    def set_white_balance_auto(self) -> dict[str, float]:
        """Trigger auto white balance once. Return updated ratios."""

    @abstractmethod
    def set_white_balance_ratio(self, channel: str, value: float) -> None:
        """Set white balance ratio for channel ('Red', 'Green', or 'Blue')."""

    @property
    def is_null(self) -> bool:
        """Return True if this is a NullCamera (no hardware). Default False."""
        return False
