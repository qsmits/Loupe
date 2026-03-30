"""Tests for per-session frame storage."""
import time

import numpy as np
import pytest

from backend.session_store import SessionFrameStore


@pytest.fixture
def store():
    return SessionFrameStore(max_sessions=50, ttl_seconds=1800)


def _frame(value: int = 42) -> np.ndarray:
    return np.full((4, 4, 3), value, dtype=np.uint8)


class TestSessionFrameStore:
    def test_get_returns_copy(self, store):
        """Mutating returned frame doesn't affect stored frame."""
        store.store("a", _frame(10))
        got = store.get("a")
        got[:] = 99
        assert np.all(store.get("a") == 10)

    def test_store_copies_input(self, store):
        """Mutating input after store doesn't affect stored frame."""
        frame = _frame(20)
        store.store("a", frame)
        frame[:] = 99
        assert np.all(store.get("a") == 20)

    def test_sessions_isolated(self, store):
        """Two sessions have independent frames."""
        store.store("a", _frame(1))
        store.store("b", _frame(2))
        assert np.all(store.get("a") == 1)
        assert np.all(store.get("b") == 2)

    def test_get_nonexistent_returns_none(self, store):
        assert store.get("nope") is None

    def test_clear_removes_session(self, store):
        store.store("a", _frame(5))
        store.clear("a")
        assert store.get("a") is None

    def test_max_sessions_enforced(self):
        store = SessionFrameStore(max_sessions=2, ttl_seconds=1800)
        store.store("a", _frame(1))
        store.store("b", _frame(2))
        with pytest.raises(RuntimeError, match="Too many active sessions"):
            store.store("c", _frame(3))

    def test_max_sessions_allows_update_existing(self):
        store = SessionFrameStore(max_sessions=2, ttl_seconds=1800)
        store.store("a", _frame(1))
        store.store("b", _frame(2))
        # Updating existing session should not raise
        store.store("a", _frame(99))
        assert np.all(store.get("a") == 99)

    def test_expiration(self):
        store = SessionFrameStore(max_sessions=50, ttl_seconds=0.1)
        store.store("a", _frame(7))
        time.sleep(0.2)
        assert store.get("a") is None

    def test_touch_on_get_resets_ttl(self):
        store = SessionFrameStore(max_sessions=50, ttl_seconds=0.2)
        store.store("a", _frame(8))
        # Touch before expiry
        time.sleep(0.1)
        assert store.get("a") is not None  # resets TTL
        time.sleep(0.15)
        # Should still be alive because get reset the clock
        assert store.get("a") is not None

    def test_has_frame(self, store):
        assert store.has_frame("a") is False
        store.store("a", _frame(1))
        assert store.has_frame("a") is True
        store.clear("a")
        assert store.has_frame("a") is False
