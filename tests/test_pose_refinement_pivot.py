"""Pose refinement solves rotation about the caliper centroid, not the DXF origin.

With the drawing origin far from the part, a small rotation about the origin
is a large translation at the part; solving about the origin made a -1.1 deg
correction look like a >4 px step and the refinement bailed out. The solve
now pivots on the weighted centroid of the caliper centres and converts the
translation back to the origin convention used by the response.
"""
import math

import numpy as np
import pytest

from backend.vision.alignment import align_dxf_edges
from backend.vision.line_arc_matching import dxf_to_image_px
from tests.test_metrology_accuracy import bgr, step_image


def scene(angle, origin, noise=2, H=300, W=400):
    """The reviewer's polygon + circle, placed so the part sits at (200.37, 150.81) px."""
    oc = np.array(dxf_to_image_px(origin[0], origin[1], 10, 0, 0, math.radians(angle)))
    tx, ty = 200.37 - oc[0], 150.81 - oc[1]
    poly = np.array([[-8, -5], [10, -5], [10, 2], [4, 6], [-8, 6]], float) + origin
    entities = [{"type": "line", "handle": f"L{i}", "x1": p[0], "y1": p[1], "x2": q[0], "y2": q[1]}
                for i, (p, q) in enumerate(zip(poly, np.roll(poly, -1, 0)))]
    entities.append({"type": "circle", "handle": "C", "cx": origin[0] + 1, "cy": origin[1] + 0.5,
                     "radius": 2.5})
    V = np.array([dxf_to_image_px(*p, 10, tx, ty, math.radians(angle)) for p in poly])
    y, x = np.mgrid[:H, :W]
    d = np.full(x.shape, np.inf)
    for p, q in zip(V, np.roll(V, -1, 0)):
        dd = q - p
        inward = np.array([dd[1], -dd[0]]) / np.linalg.norm(dd)
        d = np.minimum(d, (x - p[0]) * inward[0] + (y - p[1]) * inward[1])
    c = np.array(dxf_to_image_px(origin[0] + 1, origin[1] + 0.5, 10, tx, ty, math.radians(angle)))
    d = np.minimum(d, np.hypot(x - c[0], y - c[1]) - 25)
    return bgr(step_image(d, 1.5, noise)), entities, tx, ty


@pytest.mark.parametrize("origin", [(0, 0), (150, 90)])
@pytest.mark.parametrize("angle", [-4.3, -1.1, 0.37, 3.9])
def test_refinement_is_independent_of_drawing_origin(angle, origin):
    frame, entities, tx, ty = scene(angle, np.array(origin, float))
    result = align_dxf_edges(frame, entities, 10)
    assert result["success"], result
    assert result["refinement"]["refined"], result["refinement"]
    assert result["angle_deg"] == pytest.approx(angle, abs=0.01)
    cx, cy = dxf_to_image_px(result["dxf_cx"], result["dxf_cy"], 10, tx, ty, math.radians(angle))
    assert math.hypot(result["img_cx"] - cx, result["img_cy"] - cy) < 0.02
