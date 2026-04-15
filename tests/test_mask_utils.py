import numpy as np
from backend.vision.mask_utils import rasterize_polygon_mask


def test_rasterize_empty_returns_all_true():
    mask = rasterize_polygon_mask([], 64, 64)
    assert mask.shape == (64, 64)
    assert mask.all()


def test_rasterize_include_polygon():
    polys = [{"vertices": [(0.25, 0.25), (0.75, 0.25), (0.75, 0.75), (0.25, 0.75)], "include": True}]
    mask = rasterize_polygon_mask(polys, 100, 100)
    assert mask.shape == (100, 100)
    assert mask[50, 50]
    assert not mask[5, 5]


def test_rasterize_exclude_punches_hole():
    polys = [
        {"vertices": [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)], "include": True},
        {"vertices": [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)], "include": False},
    ]
    mask = rasterize_polygon_mask(polys, 100, 100)
    assert mask[10, 10]
    assert not mask[50, 50]
