import threading
import numpy as np


class FrameStore:
    """Thread-safe store for a single numpy frame (frozen or loaded image)."""

    def __init__(self):
        self._frame: np.ndarray | None = None
        self._lock = threading.Lock()

    def store(self, frame: np.ndarray) -> None:
        with self._lock:
            self._frame = frame.copy()

    def get(self) -> np.ndarray | None:
        with self._lock:
            return self._frame.copy() if self._frame is not None else None

    def clear(self) -> None:
        with self._lock:
            self._frame = None

    @property
    def has_frame(self) -> bool:
        with self._lock:
            return self._frame is not None
