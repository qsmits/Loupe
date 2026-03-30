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

    def set_gamma(self, value: float) -> None:
        """Set gamma correction. No-op if unsupported."""

    def get_gamma(self) -> float:
        """Get current gamma value. Returns 1.0 if unsupported."""
        return 1.0

    def set_auto_exposure(self) -> float:
        """Trigger one-shot auto-exposure. Returns new exposure value (0.0 if unsupported)."""
        return 0.0

    def set_roi(self, offset_x: int, offset_y: int, width: int, height: int) -> None:
        """Set camera region of interest. No-op if unsupported."""

    def reset_roi(self) -> None:
        """Reset ROI to full sensor. No-op if unsupported."""

    @property
    def is_null(self) -> bool:
        """Return True if this is a NullCamera (no hardware). Default False."""
        return False
