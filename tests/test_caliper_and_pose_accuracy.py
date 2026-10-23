"""Production caliper and pose checks against analytic, fractional geometry."""
import math

import numpy as np
import pytest
from scipy.special import erf

from backend.vision.alignment import align_dxf_edges
from backend.vision.caliper import nominal_calipers, sample_caliper_edges
from backend.vision.guided_inspection import inspect_features
from backend.vision.line_arc_matching import dxf_to_image_px
from tests.test_metrology_accuracy import bgr, step_image, load_frame


@pytest.mark.parametrize("angle", [0, 15, 45])
@pytest.mark.parametrize("sigma,noise", [(0.8, 0), (1.5, 3), (2.5, 5)])
def test_caliper_line_accuracy_without_canny(angle, sigma, noise):
    y, x = np.mgrid[:240, :320]
    n = np.array([np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))])
    t = np.array([-n[1], n[0]])
    origin = np.array([160.37, 120.81])
    a, z = -80 * t, 80 * t
    entity = {"type": "line", "handle": "L", "x1": a[0]/10, "y1": -a[1]/10,
              "x2": z[0]/10, "y2": -z[1]/10}
    frame = bgr(step_image((x-origin[0])*n[0] + (y-origin[1])*n[1], sigma, noise))
    result = inspect_features(frame, [entity], 10, tx=origin[0], ty=origin[1],
                              edge_method="caliper", canny_low=255, canny_high=255)[0]
    assert result["matched"], result["reason"]
    assert abs(result["perp_dev_mm"] * 10) < 0.05
    assert result["sampling_quality"]["sampling_coverage"] > 0.9
    assert result["fit_quality"]["rms_px"] < 0.2


@pytest.mark.parametrize("kind", ["circle", "arc"])
@pytest.mark.parametrize("flip_h,flip_v,angle", [(False, False, 0), (True, False, 27), (False, True, -13)])
def test_caliper_arc_sector_and_circle_accuracy(kind, flip_h, flip_v, angle):
    y, x = np.mgrid[:240, :320]
    entity = {"type": kind, "handle": "C", "cx": 0, "cy": 0, "radius": 6.537,
              "start_angle": 20, "end_angle": 150}
    frame = bgr(step_image(np.hypot(x-160.37, y-120.81)-65.37, noise=3))
    result = inspect_features(frame, [entity], 10, tx=160.37, ty=120.81, angle_deg=angle,
                              flip_h=flip_h, flip_v=flip_v, edge_method="caliper")[0]
    assert result["matched"], result["reason"]
    assert abs(result["fit"]["r"]-65.37) < 0.1
    assert np.hypot(result["fit"]["cx"]-160.37, result["fit"]["cy"]-120.81) < 0.1
    centers, _, _ = nominal_calipers(entity, 10, 160.37, 120.81, math.radians(angle), flip_h, flip_v)
    # A partial sector samples the transformed nominal endpoints, not raw image angles.
    if kind == "arc":
        a = math.radians(20 + 0.05 * 130)
        expected = dxf_to_image_px(6.537*math.cos(a), 6.537*math.sin(a), 10,
                                   160.37, 120.81, math.radians(angle), flip_h, flip_v)
        np.testing.assert_allclose(centers[0], expected, atol=1e-8)


def test_caliper_polarity_resolves_a_false_pass_boundary():
    y, x = np.mgrid[:160, :200]
    # Dark feature stripe: falling texture near nominal, rising real edge 8 px away.
    image = 180 - 100*(1+erf((x-100.37)/np.sqrt(2)))/2 + 150*(1+erf((x-108.37)/np.sqrt(2)))/2
    frame = bgr(np.rint(image).astype(np.uint8))
    # Directed upward in the image => normal points right.
    entity = {"type": "line", "handle": "L", "x1": 0, "y1": -5, "x2": 0, "y2": 5}
    unknown = inspect_features(frame, [entity], 10, tx=100.37, ty=80, edge_method="caliper")[0]
    assert not unknown["matched"]
    assert "ambiguous" in unknown["reason"]
    known = inspect_features(frame, [entity], 10, tx=100.37, ty=80, edge_method="caliper",
                             caliper={"polarity": "rising"})[0]
    assert known["matched"], known["reason"]
    assert known["perp_dev_mm"] == pytest.approx(0.8, abs=0.01)
    assert known["pass_fail"] == "fail"


@pytest.mark.parametrize("selection,expected", [("first", 50.37), ("closest", 50.37), ("strongest", 58.81)])
def test_caliper_explicit_edge_choices(selection, expected):
    y, x = np.mgrid[:96, :128]
    image = 60*(1+erf((x-50.37)/np.sqrt(2)))/2 + 180*(1+erf((x-58.81)/np.sqrt(2)))/2
    centers = np.array([[49, v] for v in np.linspace(25, 70, 10)])
    normals = np.tile([1, 0], (10, 1))
    result = sample_caliper_edges(np.rint(image).astype(np.uint8), centers, normals, selection=selection)
    assert len(result.points) == 10
    assert np.max(np.abs(result.points[:, 0]-expected)) < 0.05


def test_caliper_declines_missing_coverage_and_clipped_profiles():
    gray = np.full((60, 80), 128, np.uint8)
    centers = np.array([[1, 1], [40, 30]])
    edges = sample_caliper_edges(gray, centers, np.tile([1, 0], (2, 1)))
    assert edges.outside == 1
    assert len(edges.points) == 0
    entity = {"type": "circle", "cx": 0, "cy": 0, "radius": 2}
    result = inspect_features(bgr(gray), [entity], 10, tx=40, ty=30, edge_method="caliper")[0]
    assert not result["matched"]
    assert result["pass_fail"] is None


def polygon_reference(angle=2.37, tx=200.37, ty=150.81, noise=0):
    polygon = np.array([[-8, -5], [10, -5], [10, 2], [4, 6], [-8, 6]], dtype=float)
    entities = [{"type": "line", "handle": f"L{i}", "x1": p[0], "y1": p[1],
                 "x2": q[0], "y2": q[1]} for i, (p, q) in enumerate(zip(polygon, np.roll(polygon, -1, axis=0)))]
    vertices = np.array([dxf_to_image_px(*p, 10, tx, ty, math.radians(angle)) for p in polygon])
    y, x = np.mgrid[:300, :400]
    distance = np.full(x.shape, np.inf)
    for p, q in zip(vertices, np.roll(vertices, -1, axis=0)):
        delta = q-p
        inward = np.array([delta[1], -delta[0]]) / np.linalg.norm(delta)
        distance = np.minimum(distance, (x-p[0])*inward[0]+(y-p[1])*inward[1])
    return bgr(step_image(distance, 1.5, noise)), entities


@pytest.mark.parametrize("angle", [0, 0.37, 2.37, -2.37])
@pytest.mark.parametrize("noise", [0, 3])
def test_edge_alignment_returns_fractional_pose_in_overlay_convention(angle, noise):
    frame, entities = polygon_reference(angle, noise=noise)
    result = align_dxf_edges(frame, entities, 10)
    assert result["success"], result
    assert result["angle_deg"] == pytest.approx(angle, abs=0.02)
    assert result["refinement"]["refined"]
    cx, cy = dxf_to_image_px(result["dxf_cx"], result["dxf_cy"], 10, 200.37, 150.81, math.radians(angle))
    assert np.hypot(result["img_cx"]-cx, result["img_cy"]-cy) < 0.1


def test_caliper_api_validates_and_returns_sampling_diagnostics(client):
    y, x = np.mgrid[:160, :200]
    load_frame(client, bgr(step_image(x-100.37)))
    body = {"entities": [{"type": "line", "handle": "L", "x1": 0, "y1": -5, "x2": 0, "y2": 5}],
            "pixels_per_mm": 10, "tx": 100.37, "ty": 80, "edge_method": "caliper"}
    response = client.post("/inspect-guided", json=body)
    assert response.status_code == 200
    assert response.json()[0]["sampling_quality"]["sampling_method"] == "caliper"
    body["caliper"] = {"sigma": -1}
    assert client.post("/inspect-guided", json=body).status_code == 422


def test_pose_refinement_requires_observable_constraints():
    from backend.vision.alignment import _refine_edge_pose
    y, x = np.mgrid[:200, :240]
    frame = step_image(x-100.37)
    entity = {"type": "line", "x1": 0, "y1": -5, "x2": 0, "y2": 5}
    tx, ty, angle, quality = _refine_edge_pose(frame, [entity], 10, 100, 100, 0, 5)
    assert not quality["refined"]
    assert "constrained" in quality["reason"]
    assert (tx, ty, angle) == (100, 100, 0)


def test_alignment_can_hold_rotation_fixed():
    frame, entities = polygon_reference(angle=0, noise=3)
    result = align_dxf_edges(frame, entities, 10, angle_range=0)
    assert result["refinement"]["refined"]
    assert result["angle_deg"] == 0
    cx, cy = dxf_to_image_px(result["dxf_cx"], result["dxf_cy"], 10, 200.37, 150.81, 0)
    assert np.hypot(result["img_cx"]-cx, result["img_cy"]-cy) < 0.1


def test_marked_alignment_datums_exclude_deformed_geometry():
    frame, entities = polygon_reference(noise=3)
    # Three untouched edges constrain pose. Shift the drawing's other two
    # edges: they must not move the registered datums to hide a size defect.
    for i in (0, 3, 4):
        entities[i]["alignment_datum"] = True
    for i in (1, 2):
        entities[i]["x1"] += 0.3
        entities[i]["x2"] += 0.3
    result = align_dxf_edges(frame, entities, 10)
    assert result["refinement"]["refined"], result
    assert result["refinement"]["datum_count"] == 3
    assert result["angle_deg"] == pytest.approx(2.37, abs=0.02)
    cx, cy = dxf_to_image_px(result["dxf_cx"], result["dxf_cy"], 10, 200.37, 150.81, math.radians(2.37))
    assert np.hypot(result["img_cx"]-cx, result["img_cy"]-cy) < 0.1


def test_edge_pose_api_returns_fractional_transform(client):
    frame, entities = polygon_reference(noise=3)
    load_frame(client, frame)
    response = client.post('/align-dxf-edges', json={"entities": entities, "pixels_per_mm": 10})
    assert response.status_code == 200
    result = response.json()
    assert result["refinement"]["refined"]
    assert result["angle_deg"] == pytest.approx(2.37, abs=0.02)
    assert result["img_cx"] != round(result["img_cx"])
    assert result["flip_h"] is False


def test_rotated_circle_template_retains_the_full_radius():
    from backend.vision.alignment import _render_dxf_template
    circle = [{"type": "circle", "cx": 0, "cy": 0, "radius": 6}]
    template, min_x, min_y = _render_dxf_template(circle, 10, 30)
    assert template.shape == (130, 130)
    assert min_x == min_y == -6
    ys, xs = np.nonzero(template)
    assert xs.max()-xs.min() >= 120
    assert ys.max()-ys.min() >= 120
