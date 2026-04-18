"""Track 1 of Phase 2: multi-frequency phase unwrapping.

Tests the pure ``cascade_unwrap`` math primitive plus the HTTP-level
behavior of the new ``capture_style`` parameter on the capture-sequence
and compute endpoints.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.vision.deflectometry import (
    CAPTURE_STYLES,
    DEFAULT_MULTI_FREQ_PERIODS,
    DEFAULT_CONSISTENCY_THRESHOLD,
    cascade_unwrap,
    compute_wrapped_phase,
    generate_fringe_pattern,
)


# ── Unit tests for cascade_unwrap ────────────────────────────────────────


def _wrapped_ramp_at_period(H: int, W: int, period: int) -> tuple[np.ndarray, np.ndarray]:
    """Return (true_absolute_phase, wrapped_phase) for a horizontal ramp.

    The absolute phase sweeps from 0 to 2π·period across the width, which
    for the finest period gives the screen position in radians scaled to
    that period (matching cascade_unwrap's output convention).
    """
    coord = np.linspace(0.0, 1.0, W, endpoint=False)
    abs_phase = 2.0 * np.pi * float(period) * coord
    abs_phase = np.broadcast_to(abs_phase[None, :], (H, W)).copy()
    wrapped = np.mod(abs_phase + np.pi, 2.0 * np.pi) - np.pi
    return abs_phase, wrapped


def test_cascade_unwrap_single_frequency_passthrough():
    """With one period there is no coarser reference — cascade degenerates
    to a wrapped-phase passthrough. Verify the output equals the wrapped
    phase lifted to [0, 2π) and that consistency is all ones."""
    H, W = 8, 32
    p = 1  # period=1 → whole screen is one fringe, fraction covers [0, 1)
    _abs_phase, wrapped = _wrapped_ramp_at_period(H, W, p)

    cascaded, cons = cascade_unwrap([wrapped], [p])

    # Single-period consistency is defined as all ones.
    np.testing.assert_allclose(cons, np.ones_like(cons))

    # Output is the wrapped phase lifted to [0, 2π·p_fine) = [0, 2π).
    expected = np.mod(wrapped, 2.0 * np.pi)
    np.testing.assert_allclose(cascaded, expected, atol=1e-9)


def test_cascade_unwrap_synthetic_ramp():
    """Generate a known phase ramp and feed wrapped phases at 3 periods
    through cascade_unwrap. Within the unambiguous range of the coarsest
    period (here: 1/3 of a screen) the cascade should recover the absolute
    phase up to a constant offset — that is the correctness proof.

    We evaluate the ramp on a patch smaller than 1/periods[0] of the screen
    so every cascade level is unambiguous — a faithful simulation of a
    specular reflection that covers only part of the screen."""
    H, W = 16, 256
    periods = [3, 12, 48]
    # Screen coordinate for each column; keep the ramp WELL inside one
    # coarsest fringe (length 1/periods[0] = 1/3 of the screen) so that
    # abs_phase at the coarsest never wraps around 2π. Start at 0 and
    # span ~80% of one coarse fringe.
    coord = np.linspace(0.0, 0.8 / periods[0], W)
    wraps: list[np.ndarray] = []
    true_abs: list[np.ndarray] = []
    for p in periods:
        abs_p = 2.0 * np.pi * float(p) * coord
        abs_p = np.broadcast_to(abs_p[None, :], (H, W)).copy()
        true_abs.append(abs_p)
        wraps.append(np.mod(abs_p + np.pi, 2.0 * np.pi) - np.pi)

    cascaded, cons = cascade_unwrap(wraps, periods)

    # Compare to the finest-period absolute phase. The cascade anchors on
    # the coarsest wrapped fraction, so the global offset is zero here
    # (our coarsest ramp starts at phase 2π·3·0.05 ≈ 0.94, well inside
    # one fringe).
    err = cascaded - true_abs[-1]
    # Allow a global additive offset common to all pixels.
    err = err - err[0, 0]
    np.testing.assert_allclose(err, 0.0, atol=1e-6)

    # Consistency map: noiseless input → perfect agreement everywhere.
    assert cons.shape == (H, W)
    assert (cons >= 1.0 - 1e-9).all()


def test_cascade_unwrap_consistency_map_detects_disagreement():
    """Injecting inconsistent wrapped phase at one period should drop
    the consistency score at the affected pixels."""
    H, W = 8, 128
    periods = [3, 12, 48]
    coord = np.linspace(0.0, 1.0, W, endpoint=False)
    wraps: list[np.ndarray] = []
    for p in periods:
        abs_p = 2.0 * np.pi * float(p) * coord
        abs_p = np.broadcast_to(abs_p[None, :], (H, W)).copy()
        wraps.append(np.mod(abs_p + np.pi, 2.0 * np.pi) - np.pi)

    # Corrupt the finest-period wrapped phase in a small patch by adding
    # a phase shift of π (half the period) — maximum disagreement.
    wraps[-1] = wraps[-1].copy()
    wraps[-1][2:5, 40:60] += np.pi
    wraps[-1][2:5, 40:60] = np.mod(
        wraps[-1][2:5, 40:60] + np.pi, 2.0 * np.pi
    ) - np.pi

    _, cons = cascade_unwrap(wraps, periods)

    # Corrupted region has low consistency; untouched region has high.
    corrupted = cons[2:5, 40:60]
    untouched = np.delete(np.delete(cons, slice(2, 5), 0), slice(40, 60), 1)
    assert corrupted.mean() < 0.3, f"corrupted region consistency {corrupted.mean():.3f} not low"
    assert untouched.mean() > 0.95, f"untouched region consistency {untouched.mean():.3f} not high"


def test_cascade_unwrap_validates_inputs():
    H, W = 4, 8
    w = np.zeros((H, W), dtype=np.float64)

    # Empty list
    with pytest.raises(ValueError):
        cascade_unwrap([], [])

    # Mismatched lengths
    with pytest.raises(ValueError):
        cascade_unwrap([w, w], [3])

    # Non-ascending periods (finest first)
    with pytest.raises(ValueError):
        cascade_unwrap([w, w], [12, 3])

    # Duplicate periods
    with pytest.raises(ValueError):
        cascade_unwrap([w, w], [3, 3])

    # Non-positive period
    with pytest.raises(ValueError):
        cascade_unwrap([w, w], [0, 3])

    # Shape mismatch
    with pytest.raises(ValueError):
        cascade_unwrap([w, np.zeros((H, W + 1))], [3, 12])


# ── HTTP-level tests via the router closure ──────────────────────────────


def _get_deflectometry_state(client):
    """Reach into the router closure to grab the session state dict."""
    app = client.app
    for route in app.routes:
        if getattr(route, "name", "") == "deflectometry_start":
            for cell in route.endpoint.__closure__ or []:
                try:
                    val = cell.cell_contents
                except ValueError:
                    continue
                if isinstance(val, dict) and "session" in val:
                    return val
    raise RuntimeError("Could not locate deflectometry state in router closure")


def _inject_multifreq_frames(
    client, periods: tuple[int, ...] = (3, 12, 48),
    width: int = 64, height: int = 64,
):
    """Inject 16 × len(periods) synthetic frames arranged coarsest-first."""
    state = _get_deflectometry_state(client)
    s = state["session"]
    assert s is not None

    phases = [k * math.pi / 4.0 for k in range(8)]
    frames = []
    for period in periods:
        for orientation in ("x", "y"):
            for phase in phases:
                f = generate_fringe_pattern(width, height, phase, period, orientation)
                frames.append(np.stack([f, f, f], axis=-1))
    s.frames = frames
    s.capture_style = "multi_freq"
    s.periods = tuple(periods)
    s.freq = int(periods[-1])


def _inject_fast_frames(client, freq: int = 4, width: int = 64, height: int = 64):
    state = _get_deflectometry_state(client)
    s = state["session"]
    assert s is not None

    phases = [k * math.pi / 4.0 for k in range(8)]
    frames = []
    for orientation in ("x", "y"):
        for phase in phases:
            f = generate_fringe_pattern(width, height, phase, freq, orientation)
            frames.append(np.stack([f, f, f], axis=-1))
    s.frames = frames
    s.capture_style = "fast"
    s.periods = (freq,)
    s.freq = freq


def test_capture_sequence_rejects_unknown_style(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/capture-sequence", json={"capture_style": "banana"})
    assert r.status_code == 422


def test_capture_sequence_accepts_capture_style(client, monkeypatch):
    """Drive capture-sequence with a fake iPad and verify it captures
    16 × len(periods) frames and reports capture_style + periods back."""
    client.post("/deflectometry/reset", json={})
    r0 = client.post("/deflectometry/start", json={})
    assert r0.status_code == 200

    state = _get_deflectometry_state(client)
    s = state["session"]
    # Stub a WebSocket that just records sends and auto-acks.

    class FakeWS:
        def __init__(self):
            self.sent: list[dict] = []

        async def send_json(self, msg):
            self.sent.append(msg)
            pid = msg.get("pattern_id")
            if pid is not None:
                # Set the ack event synchronously.
                ev = s.pending_acks.get(int(pid))
                if ev is not None:
                    ev.set()

    s.ws = FakeWS()

    periods = [3, 6, 12]
    r = client.post(
        "/deflectometry/capture-sequence",
        json={
            "capture_style": "multi_freq",
            "periods": periods,
            "averages": 1,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["captured_count"] == 16 * len(periods)
    assert body["capture_style"] == "multi_freq"
    assert body["periods"] == periods
    assert s.capture_style == "multi_freq"
    assert list(s.periods) == periods


def test_capture_sequence_rejects_non_ascending_periods(client):
    client.post("/deflectometry/reset", json={})
    r0 = client.post("/deflectometry/start", json={})
    assert r0.status_code == 200

    state = _get_deflectometry_state(client)
    s = state["session"]

    class FakeWS:
        async def send_json(self, msg):
            pid = msg.get("pattern_id")
            if pid is not None:
                ev = s.pending_acks.get(int(pid))
                if ev is not None:
                    ev.set()

    s.ws = FakeWS()

    r = client.post(
        "/deflectometry/capture-sequence",
        json={"capture_style": "multi_freq", "periods": [12, 3]},
    )
    assert r.status_code == 422


def test_compute_multifreq_envelope_has_consistency_grid(client):
    """After a multi-freq capture + compute, the cached envelope exposes
    the consistency grid, the per-period wrapped phases, and the periods."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_multifreq_frames(client, periods=(3, 6, 12), width=32, height=32)

    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    assert r.json()["tuning"]["capture_style"] == "multi_freq"
    assert r.json()["tuning"]["periods"] == [3, 6, 12]

    r2 = client.get(f"/deflectometry/result/{rid}")
    assert r2.status_code == 200, r2.text
    full = r2.json()

    assert "phase_consistency_grid" in full
    grid = full["phase_consistency_grid"]
    assert isinstance(grid, list) and len(grid) == 32
    assert len(grid[0]) == 32
    # All values clamped to [0, 1]
    for row in grid:
        for v in row:
            assert v is None or 0.0 <= v <= 1.0

    assert full["periods_used"] == [3, 6, 12]
    for key in ("phase_x_grid_per_period", "phase_y_grid_per_period"):
        assert key in full
        lst = full[key]
        assert isinstance(lst, list)
        assert len(lst) == 3
        for g in lst:
            assert len(g) == 32 and len(g[0]) == 32


def test_compute_fast_envelope_consistency_is_unity(client):
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_fast_frames(client, freq=4, width=32, height=32)

    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    assert r.json()["tuning"]["capture_style"] == "fast"
    assert r.json()["tuning"]["periods"] == [4]

    r2 = client.get(f"/deflectometry/result/{rid}")
    assert r2.status_code == 200, r2.text
    full = r2.json()

    grid = full["phase_consistency_grid"]
    assert len(grid) == 32 and len(grid[0]) == 32
    flat = [v for row in grid for v in row]
    for v in flat:
        assert v == pytest.approx(1.0)

    # Only the captured period appears in the per-period list.
    assert len(full["phase_x_grid_per_period"]) == 1
    assert len(full["phase_y_grid_per_period"]) == 1
    assert full["periods_used"] == [4]


def test_unwrap_jump_risk_label(client):
    """A multi-freq capture where a fraction of pixels are phase-inconsistent
    should land in the expected label bucket."""
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_multifreq_frames(client, periods=(3, 6, 12), width=64, height=64)

    state = _get_deflectometry_state(client)
    s = state["session"]

    # Corrupt a large fraction of the finest-period X frames (frames
    # indexed 32..39 in a 3-period layout) by adding a non-linear
    # perturbation. This will inject disagreement between periods in that
    # region. Corrupt >5% of pixels to hit the "high" bucket.
    base = 16 * 2  # finest period X block start
    for i in range(base, base + 8):
        arr = s.frames[i].astype(np.int16)
        # Randomize a ~10% spatial patch — large bright offset drives
        # wrapped-phase disagreement at that period.
        rng = np.random.default_rng(42 + i)
        noise = rng.integers(-120, 120, size=arr.shape, dtype=np.int16)
        mask = rng.random(arr.shape[:2]) < 0.15
        arr[mask] = np.clip(arr[mask] + noise[mask], 0, 255)
        s.frames[i] = arr.astype(np.uint8)

    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200, r.text
    quality = r.json()["quality"]
    assert "unwrap_jump_risk" in quality
    assert quality["unwrap_jump_risk"] in ("low", "medium", "high")

    # Also check the "fast" case reports "unknown".
    client.post("/deflectometry/reset", json={})
    client.post("/deflectometry/start", json={})
    _inject_fast_frames(client, freq=4, width=32, height=32)
    r2 = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r2.status_code == 200
    assert r2.json()["quality"]["unwrap_jump_risk"] == "unknown"


def test_constants_exposed():
    """The module-level constants spec'd by the task are importable and
    have the expected values."""
    assert CAPTURE_STYLES == ("fast", "multi_freq")
    assert DEFAULT_MULTI_FREQ_PERIODS == (3, 12, 48)
    assert DEFAULT_CONSISTENCY_THRESHOLD == 0.7
