"""Click snap gate on the 5x5 Sobel magnitude (mirrors frontend/subpixel-js.js).

OpenCV's 5x5 Sobel answers a sharp unit step with 48 (3x3: 4), so the old
3x3 floor of 20 becomes 240: a 5-grey-level step. Accept only when the
magnitude is ABOVE the floor (``mag <= SNAP_MIN_MAGNITUDE`` rejects, as in
JS) and at least 0.15 x the strongest gradient in the search window.
"""
from pathlib import Path

import numpy as np
import pytest
from scipy.special import erf

from backend.vision.subpixel import SNAP_MIN_MAGNITUDE, refine_single_point


def test_floor_matches_the_browser_constant():
    assert SNAP_MIN_MAGNITUDE == 240
    js = (Path(__file__).resolve().parents[1] / "frontend" / "subpixel-js.js").read_text()
    assert "export const SNAP_MIN_MAGNITUDE = 240;" in js


@pytest.mark.parametrize("method", ["parabola", "gaussian"])
def test_flat_noisy_patch_never_snaps(method):
    rng = np.random.default_rng(12345)
    snaps = 0
    clicks = 0
    for patch in range(14):
        gray = np.clip(np.rint(128 + rng.normal(0, 1, (64, 64))), 0, 255).astype(np.uint8)
        for k in range(10):
            click = (24 + (k * 7) % 17, 24 + (k * 5 + patch) % 17)
            x, y, magnitude = refine_single_point(click, gray, 10, method)
            clicks += 1
            if magnitude > 0:
                snaps += 1
            else:
                assert (x, y) == (float(click[0]), float(click[1]))
    assert clicks == 140
    assert snaps == 0


def step(levels, sigma=0.5):
    y, x = np.mgrid[:64, :64]
    image = 100 + levels * (1 + erf((x - 32.37) / (np.sqrt(2) * sigma))) / 2
    return np.rint(image).astype(np.uint8)


def test_six_grey_level_step_still_snaps():
    x, _, magnitude = refine_single_point((30, 32), step(6))
    assert magnitude > SNAP_MIN_MAGNITUDE
    assert abs(x - 32.37) < 0.3


def test_four_grey_level_step_does_not_snap():
    x, y, magnitude = refine_single_point((30, 32), step(4))
    assert magnitude == 0.0
    assert (x, y) == (30.0, 32.0)


def test_relative_rule_still_applies():
    # A weak (but above-floor) edge next to a much stronger one is ignored
    # in favour of the strong ridge when it is under 0.15 x the maximum.
    y, x = np.mgrid[:64, :64]
    image = 20 + 8 * (1 + erf((x - 26.37) / np.sqrt(2))) / 2 + 200 * (1 + erf((x - 34.37) / np.sqrt(2))) / 2
    rx, _, magnitude = refine_single_point((26, 32), np.rint(image).astype(np.uint8))
    assert magnitude > SNAP_MIN_MAGNITUDE
    assert abs(rx - 34.37) < 0.3
