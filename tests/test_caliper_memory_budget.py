"""Caliper sampling memory and work are bounded.

- calipers are processed in chunks (bit-identical to one pass) so a long
  line at maximal search/caliper widths no longer allocates gigabytes;
- the frame is converted to float once per inspection request, not once
  per entity;
- a request whose total profile-sample count exceeds
  caliper.MAX_CALIPER_SAMPLES is declined up front: every caliper entity
  comes back unmatched with a reason, before any sampling work is done.
"""
import time
import tracemalloc

import numpy as np
import pytest
from scipy.special import erf

from backend.vision import caliper
from backend.vision.caliper import nominal_calipers, sample_caliper_edges
from backend.vision.guided_inspection import inspect_features
from tests.test_metrology_accuracy import bgr


def textured_scene():
    rng = np.random.default_rng(4)
    y, x = np.mgrid[:240, :320]
    image = 60 + 120 * (1 + erf((np.hypot(x - 160.37, y - 120.81) - 65.37) / 2)) / 2
    image += 40 * (1 + erf((x - 70.2) / 1.5)) / 2 + rng.normal(0, 4, x.shape)
    return np.clip(np.rint(image), 0, 255).astype(np.uint8)


@pytest.mark.parametrize("polarity,selection", [("any", "unique"), ("rising", "first"),
                                                ("any", "strongest"), ("falling", "closest")])
def test_chunked_sampling_is_bit_identical(polarity, selection):
    gray = textured_scene()
    entity = {"type": "circle", "cx": 0, "cy": 0, "radius": 6.537}
    centers, normals, _ = nominal_calipers(entity, 10, 160.37, 120.81, 0, spacing=1)
    # Push some calipers off the frame so "outside" bookkeeping is exercised.
    centers = np.vstack([centers, [[2.0, 3.0], [318.0, 5.0], [-40.0, 50.0]]])
    normals = np.vstack([normals, [[1.0, 0.0], [0.0, 1.0], [1.0, 0.0]]])
    args = dict(corridor_px=12, width=5, sigma=1.2, polarity=polarity, selection=selection)
    one_pass = sample_caliper_edges(gray, centers, normals, chunk_calipers=10**9, **args)
    chunked = sample_caliper_edges(gray, centers, normals, chunk_calipers=7, **args)
    assert len(centers) > 400
    for field in ("points", "normals", "strengths", "indices"):
        assert np.array_equal(getattr(one_pass, field), getattr(chunked, field)), field
    assert (one_pass.requested, one_pass.ambiguous, one_pass.outside) == \
           (chunked.requested, chunked.ambiguous, chunked.outside)
    assert one_pass.outside == 3


def test_frame_converted_to_float_once_per_request(monkeypatch):
    seen = []
    real = caliper._bilinear_sample

    def recording(img, xs, ys):
        seen.append((id(img), img.dtype))
        return real(img, xs, ys)

    monkeypatch.setattr(caliper, "_bilinear_sample", recording)
    frame = bgr(textured_scene())
    entities = [{"type": "circle", "handle": "C", "cx": 0, "cy": 0, "radius": 6.537},
                {"type": "arc", "handle": "A", "cx": 0, "cy": 0, "radius": 6.537,
                 "start_angle": 10, "end_angle": 120},
                {"type": "line", "handle": "L", "x1": -9.0, "y1": -3, "x2": -9.0, "y2": 3}]
    inspect_features(frame, entities, 10, tx=160.37, ty=120.81, edge_method="caliper")
    assert len(seen) >= 3
    assert {dtype for _, dtype in seen} == {np.dtype(np.float64)}
    assert len({ident for ident, _ in seen}) == 1


def test_long_line_at_maximal_parameters_has_bounded_memory():
    gray = np.full((3000, 4000), 128, np.uint8)
    entity = {"type": "line", "x1": 5, "y1": -30, "x2": 75, "y2": -30}  # 3500 px at ppm 50
    centers, normals, width_limit = nominal_calipers(entity, 50, 0, 0, 0, spacing=1)
    assert len(centers) == 2000
    gray_f = gray.astype(np.float64)
    tracemalloc.start()
    try:
        sample_caliper_edges(gray_f, centers, normals, corridor_px=200, width=min(21, width_limit), sigma=5)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 400e6, f"peak {peak / 1e6:.0f} MB"


def test_request_over_the_sample_budget_is_declined_up_front(monkeypatch):
    frame = bgr(textured_scene())
    entities = [{"type": "circle", "handle": "C", "cx": 0, "cy": 0, "radius": 6.537},
                {"type": "line", "handle": "L", "x1": -9.0, "y1": -3, "x2": -9.0, "y2": 3}]
    total = caliper.request_caliper_samples(entities, 10, 15, {})
    assert total > 0
    monkeypatch.setattr(caliper, "MAX_CALIPER_SAMPLES", total)
    within = inspect_features(frame, entities, 10, tx=160.37, ty=120.81, corridor_px=15,
                              edge_method="caliper")
    assert within[0]["matched"], within[0]["reason"]
    monkeypatch.setattr(caliper, "MAX_CALIPER_SAMPLES", total - 1)
    over = inspect_features(frame, entities, 10, tx=160.37, ty=120.81, corridor_px=15,
                            edge_method="caliper")
    for r in over:
        assert not r["matched"]
        assert "budget" in r["reason"]


def test_huge_request_returns_quickly_with_budget_reason():
    frame = bgr(np.full((300, 400), 128, np.uint8))
    entities = [{"type": "line", "handle": f"L{i}", "x1": 0, "y1": -i, "x2": 70, "y2": -i}
                for i in range(30)]  # 30 x 3500 px lines
    start = time.perf_counter()
    results = inspect_features(frame, entities, 50, edge_method="caliper", corridor_px=200,
                               caliper={"spacing": 1, "width": 21, "sigma": 5})
    assert time.perf_counter() - start < 2.0
    assert all(not r["matched"] and "budget" in r["reason"] for r in results)


def test_budget_counts_match_sampling_geometry():
    entity = {"type": "arc", "cx": 1, "cy": 2, "radius": 3.3, "start_angle": 15, "end_angle": 200}
    centers, _, width_limit = nominal_calipers(entity, 10, 50, 60, 0.3, spacing=4)
    per = caliper.samples_per_caliper(15, min(5, width_limit), 1)
    assert caliper.request_caliper_samples([entity], 10, 15, {"spacing": 4}) == len(centers) * per


def _circles(n, seed=7):
    rng = np.random.default_rng(seed)
    return [{"type": "circle", "handle": f"C{i}", "cx": 0, "cy": 0,
             "radius": float(rng.uniform(50, 82)) / 20} for i in range(n)]


def test_realistic_400_circle_request_is_within_budget():
    # 400 circles r 50-82 px at 20 px/mm, corridor 40, width 11: ~58M samples,
    # which the old 50M cap declined outright (0/400 matched).
    entities = _circles(400)
    total = caliper.request_caliper_samples(entities, 20, 40, {"width": 11})
    assert 50_000_000 < total <= caliper.MAX_CALIPER_SAMPLES, total
    # Not declined: the guided path only declines when total > the constant, so
    # a tiny frame must produce per-entity (non-budget) results for a few of them.
    frame = bgr(np.full((300, 400), 128, np.uint8))
    results = inspect_features(frame, entities[:3], 20, tx=200, ty=150, corridor_px=40,
                               edge_method="caliper", caliper={"width": 11})
    assert all("budget" not in (r.get("reason") or "") for r in results)


def test_request_above_200m_is_declined_without_sampling(monkeypatch):
    assert caliper.MAX_CALIPER_SAMPLES == 200_000_000
    entities = _circles(400)
    total = caliper.request_caliper_samples(entities, 20, 200, {"width": 21, "sigma": 5})
    assert total > caliper.MAX_CALIPER_SAMPLES

    def boom(*a, **k):
        raise AssertionError("sampling must not run for a declined request")

    monkeypatch.setattr(caliper, "_bilinear_sample", boom)
    frame = bgr(np.full((300, 400), 128, np.uint8))
    start = time.perf_counter()
    results = inspect_features(frame, entities, 20, tx=200, ty=150, corridor_px=200,
                               edge_method="caliper", caliper={"width": 21, "sigma": 5})
    assert time.perf_counter() - start < 2.0
    assert len(results) == 400
    assert all(not r["matched"] and "budget" in r["reason"] for r in results)
