"""Legacy contour path (requests without ``edge_method``) keeps its measurement.

Competing edges in a contour corridor are reported as a flag on the MATCHED
result (``ambiguous: True`` plus a ``reason``), with the same proximity-
selected measurement the contour path has always produced. Gear tooth
segments (``tooth_index``) are never flagged: interior texture is expected
there. The caliper path keeps its explicit "unique" semantics and reports
competing edges as unmatched/ambiguous.
"""
import numpy as np
import pytest
from scipy.special import erf

from backend.vision.guided_inspection import inspect_features
from tests.test_metrology_accuracy import bgr

y, x = np.mgrid[:200, :240]


def E(d, s=1.0):
    return (1 + erf(d / (np.sqrt(2) * s))) / 2


LINE = {"type": "line", "handle": "L", "x1": 0, "y1": -6, "x2": 0, "y2": 6}


def shadow_scene(gap, shadow=60):
    """Real dark-part edge at x=120.3 plus a weaker shadow step ``gap`` px out."""
    return 40 + (210 - 40 - shadow) * E(x - 120.3) + shadow * E(x - 120.3 - gap)


def gear_scene():
    img = 40 + 170 * E(x - 120.3)
    return img - 50 * np.exp(-((x - 113.3) ** 2) / 2) * (x < 120)


def chamfer_scene():
    d = np.hypot(x - 120.3, y - 100)
    return 30 + 90 * E(d - 40) + 100 * E(d - 46)


# (scene, entity, HEAD perp_dev_mm or radius_dev_mm, flagged)
SCENES = {
    "shadow+6px": (lambda: shadow_scene(6), LINE, ("perp_dev_mm", -0.0017), True),
    "shadow+12px": (lambda: shadow_scene(12), LINE, ("perp_dev_mm", -0.0017), True),
    "gear tooth scratch": (gear_scene, dict(LINE, tooth_index=3), ("perp_dev_mm", -0.0029), False),
    "hole chamfer": (chamfer_scene, {"type": "circle", "handle": "C", "cx": 0, "cy": 0, "radius": 4.0},
                     ("radius_dev_mm", -0.001), True),
}


def frame_of(img):
    return bgr(np.clip(np.rint(img), 0, 255).astype(np.uint8))


@pytest.mark.parametrize("name", list(SCENES))
def test_contour_path_matches_with_head_measurement(name):
    scene, entity, (field, head_value), flagged = SCENES[name]
    r = inspect_features(frame_of(scene()), [entity], 10, tx=120.3, ty=100)[0]
    assert r["matched"], r["reason"]
    assert r[field] == pytest.approx(head_value, abs=0.01)
    assert r["pass_fail"] == "pass"
    assert r["ambiguous"] is flagged
    if flagged:
        assert "ambiguous" in r["reason"]
    else:
        assert r["reason"] is None


def test_contour_single_edge_is_not_flagged():
    r = inspect_features(frame_of(40 + 170 * E(x - 120.3)), [LINE], 10, tx=120.3, ty=100)[0]
    assert r["matched"] and r["ambiguous"] is False and r["reason"] is None


@pytest.mark.parametrize("name", ["shadow+6px", "shadow+12px", "hole chamfer"])
def test_caliper_unique_reports_competing_edges_as_ambiguous(name):
    scene, entity, _, _ = SCENES[name]
    r = inspect_features(frame_of(scene()), [entity], 10, tx=120.3, ty=100,
                         edge_method="caliper", caliper={"selection": "unique"})[0]
    assert not r["matched"]
    assert "ambiguous" in r["reason"]
