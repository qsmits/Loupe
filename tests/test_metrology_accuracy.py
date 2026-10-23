"""Accuracy gates on production paths, using non-integer analytic geometry.

Pixels are rounded samples of an erf step (Gaussian-blurred ideal boundary).
These are software regression limits, not a claim about optical accuracy.
"""
import cv2
import numpy as np
import pytest
from scipy.special import erf

from backend.vision.detection import detect_circles, detect_lines_contour
from backend.vision.guided_inspection import inspect_features, fit_manual_points
from backend.vision.subpixel import refine_single_point
from backend.vision.geometry import fit_circle_robust


def step_image(distance, sigma=1.5, noise=0, seed=7):
    image = 127.5 * (1 + erf(distance / (np.sqrt(2) * sigma)))
    image += np.random.default_rng(seed).normal(0, noise, distance.shape)
    return np.clip(np.rint(image), 0, 255).astype(np.uint8)


def bgr(gray):
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


@pytest.mark.parametrize("sigma", [0.8, 1.5, 2.5])
@pytest.mark.parametrize("angle", [0, 15, 45])
@pytest.mark.parametrize("phase", [0.13, 0.37, 0.81])
def test_click_sweep_localizes_the_ridge(sigma, angle, phase):
    y, x = np.mgrid[:96, :128]
    normal = np.array([np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))])
    origin = np.array([64 + phase, 48.0])
    distance = (x - origin[0]) * normal[0] + (y - origin[1]) * normal[1]
    gray = step_image(distance, sigma)
    errors = []
    for offset in np.linspace(-6, 6, 25):
        click = origin + offset * normal
        rx, ry, magnitude = refine_single_point(tuple(click), gray)
        assert magnitude > 20
        errors.append(abs((np.array([rx, ry]) - origin) @ normal))
    assert max(errors) < (0.05 if angle == 0 else 0.15), errors


def test_click_prefers_nearest_edge_over_stronger_neighbor():
    y, x = np.mgrid[:96, :128]
    image = 60 * (1 + erf((x - 50.37) / np.sqrt(2))) / 2
    image += 180 * (1 + erf((x - 58.81) / np.sqrt(2))) / 2
    gray = np.rint(image).astype(np.uint8)
    rx, _, magnitude = refine_single_point((49, 48), gray, search_radius=12)
    assert magnitude > 20
    assert abs(rx - 50.37) < 0.05


@pytest.mark.parametrize("sigma,noise", [(0.8, 0), (1.5, 0), (2.5, 0), (1.5, 3), (2.5, 5)])
@pytest.mark.parametrize("phase", [0.13, 0.37, 0.81])
def test_closed_circle_detection_and_guided_fit(sigma, noise, phase):
    y, x = np.mgrid[:240, :320]
    cx, cy, radius = 160 + phase, 120.81, 65.37
    frame = bgr(step_image(np.hypot(x - cx, y - cy) - radius, sigma, noise))
    circles = detect_circles(frame, subpixel="parabola", min_radius=55, max_radius=75)
    assert circles
    detected = min(circles, key=lambda c: np.hypot(c["x"] - cx, c["y"] - cy))
    entity = {"type": "circle", "handle": "C", "cx": 0, "cy": 0, "radius": radius / 10}
    result = inspect_features(frame, [entity], 10, tx=cx, ty=cy)[0]
    assert result["matched"], result["reason"]
    for fit_cx, fit_cy, fit_r in [
        (detected["x"], detected["y"], detected["radius"]),
        (result["fit"]["cx"], result["fit"]["cy"], result["fit"]["r"]),
    ]:
        assert np.hypot(fit_cx - cx, fit_cy - cy) < 0.1
        assert abs(fit_r - radius) < 0.1


@pytest.mark.parametrize("angle", [0, 30, 45])
def test_contour_line_endpoints_lie_on_the_fitted_edge(angle):
    y, x = np.mgrid[:240, :320]
    n = np.array([np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))])
    distance = (x - 160.37) * n[0] + (y - 120.81) * n[1]
    frame = bgr(step_image(distance, 1.5, 3))
    lines = detect_lines_contour(frame, subpixel="parabola", min_length_px=80)
    assert lines
    line = max(lines, key=lambda l: l["length"])
    for p in [(line["x1"], line["y1"]), (line["x2"], line["y2"])]:
        assert abs((np.array(p) - [160.37, 120.81]) @ n) < 0.2


@pytest.mark.parametrize("span", [30, 60, 90, 360])
def test_manual_arc_fit_has_low_mean_radius_bias(span):
    rng = np.random.default_rng(19)
    angle = np.linspace(0, np.deg2rad(span), 500)
    truth = np.column_stack([320.37 + 100 * np.cos(angle), 240.81 + 100 * np.sin(angle)])
    entity = {"type": "arc", "handle": "A", "cx": 0, "cy": 0, "radius": 100}
    errors = []
    for _ in range(24):
        points = truth + rng.normal(0, 0.2, truth.shape)
        result = fit_manual_points(entity, points.tolist(), 1, tx=320.37, ty=240.81)
        assert result["matched"], result["reason"]
        errors.append(result["fit"]["r"] - 100)
    assert abs(np.mean(errors)) < 0.15, errors


def test_guided_competing_edges_cannot_silently_pass():
    y, x = np.mgrid[:160, :200]
    # Texture near the nominal and a real edge 8 px out of tolerance.
    image = 100 * (1 + erf((x - 100.37) / np.sqrt(2))) / 2
    image += 150 * (1 + erf((x - 108.37) / np.sqrt(2))) / 2
    entity = {"type": "line", "handle": "L", "x1": 0, "y1": 5, "x2": 0, "y2": -5}
    result = inspect_features(bgr(np.rint(image).astype(np.uint8)), [entity], 10,
                              tx=100.37, ty=80, tolerance_warn=0.1, tolerance_fail=0.25)[0]
    # The legacy contour path keeps its proximity-selected measurement but
    # must flag the competing edge rather than pass silently.
    if result["matched"] and result["pass_fail"] == "pass":
        assert result["ambiguous"] is True, result
        assert "ambiguous" in result["reason"]


def test_circle_fit_resists_outliers_and_reports_conditional_errors():
    rng = np.random.default_rng(31)
    angle = np.linspace(0, np.pi / 2, 200)
    radius = 80 + rng.normal(0, 0.1, 200)
    radius[::20] += 8
    points = np.column_stack([1e6 + radius * np.cos(angle), -1e6 + radius * np.sin(angle)])
    fit = fit_circle_robust(points)
    assert np.hypot(fit.cx - 1e6, fit.cy + 1e6) < 0.3
    assert abs(fit.r - 80) < 0.3
    assert fit.rms_px < 0.2
    quality = fit.diagnostics()
    assert quality["inlier_count"] < len(points)
    assert all(np.isfinite(quality["parameter_std_error_px"]))


@pytest.mark.parametrize("points", [
    [[3, 4]] * 5, [[0, 0], [1, 1], [2, 2]], [[np.nan, 0], [1, 0], [0, 1]],
    np.column_stack([100 * np.cos(np.linspace(0, np.pi / 180, 50)),
                     100 * np.sin(np.linspace(0, np.pi / 180, 50))]),
])
def test_manual_circle_fit_declines_degenerate_geometry(points):
    entity = {"type": "arc", "handle": "A", "cx": 0, "cy": 0, "radius": 100}
    result = fit_manual_points(entity, np.asarray(points).tolist(), 1)
    assert not result["matched"]
    assert result["reason"]
    assert result["pass_fail"] is None


@pytest.mark.parametrize("span", [60, 90])
@pytest.mark.parametrize("noise", [0, 3])
def test_guided_arc_localizes_analytic_boundary(span, noise):
    y, x = np.mgrid[:300, :400]
    frame = bgr(step_image(np.hypot(x - 200.37, y - 150.81) - 100.37, noise=noise))
    entity = {"type": "arc", "handle": "A", "cx": 0, "cy": 0, "radius": 10.037,
              "start_angle": 0, "end_angle": span}
    result = inspect_features(frame, [entity], 10, tx=200.37, ty=150.81)[0]
    assert result["matched"], result["reason"]
    fit = result["fit"]
    assert abs(fit["r"] - 100.37) < (0.1 if noise == 0 else 0.35)
    assert np.hypot(fit["cx"] - 200.37, fit["cy"] - 150.81) < (0.1 if noise == 0 else 0.35)
    assert result["fit_quality"]["coverage_deg"] > span - 5


def test_guided_concentric_competing_edges_are_ambiguous():
    y, x = np.mgrid[:240, :320]
    distance = np.hypot(x - 160.37, y - 120.81)
    image = 100 * (1 + erf((distance - 65.37) / np.sqrt(2))) / 2
    image += 150 * (1 + erf((distance - 73.37) / np.sqrt(2))) / 2
    entity = {"type": "circle", "handle": "C", "cx": 0, "cy": 0, "radius": 6.537}
    frame = bgr(np.rint(image).astype(np.uint8))
    # Contour path (legacy requests): matched, measured as before, flagged.
    result = inspect_features(frame, [entity], 10, tx=160.37, ty=120.81)[0]
    assert result["matched"]
    assert result["ambiguous"] is True
    assert "ambiguous" in result["reason"]
    # Caliper path, default "unique" selection: competing edges are unmatched.
    caliper = inspect_features(frame, [entity], 10, tx=160.37, ty=120.81, edge_method="caliper")[0]
    assert not caliper["matched"]
    assert "ambiguous" in caliper["reason"]


def load_frame(client, frame):
    ok, encoded = cv2.imencode(".png", frame)
    assert ok
    response = client.post("/load-image", files={"file": ("reference.png", encoded.tobytes(), "image/png")})
    assert response.status_code == 200


def test_refine_point_api_calibration_distance(client):
    y, x = np.mgrid[:96, :200]
    image = 127.5 * (erf((x - 40.37) / (np.sqrt(2) * 2.5)) - erf((x - 140.81) / (np.sqrt(2) * 2.5)))
    load_frame(client, bgr(np.rint(image).astype(np.uint8)))
    for offset in [-6, 0, 6]:
        points = []
        for click in [40.37 + offset, 140.81 - offset]:
            response = client.post("/refine-point", json={"x": click, "y": 48})
            assert response.status_code == 200
            point = response.json()
            assert point["magnitude"] > 20
            points.append(point)
        # 1 mm reference gives 100.44 px/mm, independent of cursor offset.
        assert abs(points[1]["x"] - points[0]["x"] - 100.44) < 0.1


def test_circle_api_refines_by_default_and_validates_method(client):
    y, x = np.mgrid[:240, :320]
    load_frame(client, bgr(step_image(np.hypot(x - 160.37, y - 120.81) - 65.37)))
    response = client.post("/detect-circles", json={"min_radius": 55, "max_radius": 75})
    assert response.status_code == 200
    circles = response.json()
    assert circles
    assert abs(circles[0]["radius"] - 65.37) < 0.1
    assert np.hypot(circles[0]["x"] - 160.37, circles[0]["y"] - 120.81) < 0.1
    assert client.post("/detect-circles", json={"subpixel": "bogus"}).status_code == 422


def test_fit_feature_api_returns_quality_without_a_frame(client):
    angles = np.linspace(0, np.pi / 2, 50)
    points = np.column_stack([100.37 + 65.37 * np.cos(angles), 120.81 + 65.37 * np.sin(angles)])
    response = client.post("/fit-feature", json={
        "entity": {"type": "arc", "handle": "A", "cx": 0, "cy": 0, "radius": 6.537},
        "points": points.tolist(), "pixels_per_mm": 10, "tx": 100.37, "ty": 120.81,
    })
    assert response.status_code == 200
    result = response.json()
    assert result["matched"]
    assert abs(result["fit"]["r"] - 65.37) < 1e-6
    assert result["fit_quality"]["inlier_count"] == 50
    assert "subpixel" not in client.get("/openapi.json").json()["components"]["schemas"]["FitFeatureBody"]["properties"]


@pytest.mark.parametrize("sigma", [0.8, 1.5, 2.5])
@pytest.mark.parametrize("noise", [3, 5])
def test_noisy_click_sweep_stays_within_quarter_pixel(sigma, noise):
    y, x = np.mgrid[:96, :128]
    for angle in [0, 15, 45]:
        normal = np.array([np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))])
        origin = np.array([64.37, 48.0])
        gray = step_image((x - origin[0]) * normal[0] + (y - origin[1]) * normal[1], sigma, noise)
        for offset in np.linspace(-6, 6, 25):
            rx, ry, magnitude = refine_single_point(tuple(origin + offset * normal), gray)
            assert magnitude > 20
            assert abs((np.array([rx, ry]) - origin) @ normal) < 0.25


def test_backend_and_browser_fit_the_same_noisy_arcs():
    import json
    import shutil
    import subprocess
    from pathlib import Path

    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for browser/backend numerical consistency check")
    rng = np.random.default_rng(71)
    cases = []
    for span in [30, 60, 90, 360]:
        angle = np.linspace(0, np.deg2rad(span), 200)
        points = np.column_stack([320.37 + 100 * np.cos(angle), 240.81 + 100 * np.sin(angle)])
        points += rng.normal(0, 0.2, points.shape)
        if span >= 90:
            points[::20] += 5 * np.column_stack([np.cos(angle[::20]), np.sin(angle[::20])])
        cases.append(points)
    script = """
        import { fitCircleRobust } from './frontend/math.js';
        let input = ''; for await (const chunk of process.stdin) input += chunk;
        console.log(JSON.stringify(JSON.parse(input).map(points =>
            fitCircleRobust(points.map(([x,y]) => ({x,y}))))));
    """
    response = subprocess.run([node, "--input-type=module", "-e", script],
                              input=json.dumps([p.tolist() for p in cases]), text=True,
                              capture_output=True, check=True,
                              cwd=Path(__file__).resolve().parents[1])
    for points, browser in zip(cases, json.loads(response.stdout)):
        assert browser is not None
        backend = fit_circle_robust(points)
        np.testing.assert_allclose([browser["cx"], browser["cy"], browser["r"]], backend.parameters, atol=1e-4, rtol=0)
