import numpy as np
import cv2
import pytest

from backend.vision.gear_analysis import analyze_gear


def make_synthetic_gear(size=1200, cx=600, cy=600, tip_r=500, root_r=400, n=17, tooth_frac=0.5):
    """Render a backlit-style gear: dark silhouette on bright background.

    Exact numpy rasterizer (no cv2 antialiasing) so the test validates the
    analyze_gear algorithm, not the drawing primitives. tooth_frac is the
    fraction of each angular step (360/n) occupied by material at the PCD.
    """
    img = np.full((size, size), 255, dtype=np.uint8)
    y, x = np.ogrid[:size, :size]
    dx = x - cx
    dy = y - cy
    r = np.sqrt(dx * dx + dy * dy)
    theta = np.arctan2(dy, dx)
    theta = np.where(theta < 0, theta + 2 * np.pi, theta)

    step_rad = 2 * np.pi / n
    # Teeth are centered at i * step_rad for i = 0..n-1. Find each pixel's
    # angular distance to the nearest tooth center.
    nearest_center_idx = np.round(theta / step_rad) % n
    nearest_center = nearest_center_idx * step_rad
    d = np.abs(theta - nearest_center)
    d = np.minimum(d, 2 * np.pi - d)  # wrap-safe

    half_tooth = step_rad * tooth_frac / 2
    in_tooth_wedge = d <= half_tooth
    in_root_disc = r <= root_r
    in_tip_disc = r <= tip_r

    material = in_root_disc | (in_tip_disc & in_tooth_wedge)
    img[material] = 0
    return img


def test_synthetic_17_tooth_widths_within_tolerance():
    img = make_synthetic_gear(size=1200, cx=600, cy=600, tip_r=500, root_r=400, n=17, tooth_frac=0.5)
    result = analyze_gear(img, cx=600, cy=600, tip_r=500, root_r=400, n_teeth=17)

    assert len(result["teeth"]) == 17

    step = 360.0 / 17  # ~21.176
    expected_width = step * 0.5  # ~10.588
    for tooth in result["teeth"]:
        assert abs(tooth["angular_width_deg"] - expected_width) < 0.1, (
            f"tooth {tooth['index']}: width {tooth['angular_width_deg']:.3f} "
            f"vs expected {expected_width:.3f}"
        )


def test_synthetic_17_tooth_centers_uniform_spacing():
    img = make_synthetic_gear(n=17)
    result = analyze_gear(img, cx=600, cy=600, tip_r=500, root_r=400, n_teeth=17)

    centers = sorted([t["center_angle_deg"] for t in result["teeth"]])
    expected_step = 360.0 / 17
    gaps = [(centers[(i + 1) % 17] - centers[i]) % 360 for i in range(17)]
    for g in gaps:
        assert abs(g - expected_step) < 0.1


def test_gear_with_flank_marking_still_measures_correctly():
    """A dark marking inside a tooth near the flank must not break the measurement.

    The single-ring sampler would see the marking as background and split the
    tooth run in two, measuring only the longer half (~60% of the true width).
    The polar-strip sampler sees the marking as a few bad pixels in an
    otherwise-material column and ignores it.
    """
    img = make_synthetic_gear(size=1200, cx=600, cy=600, tip_r=500, root_r=400, n=17, tooth_frac=0.5)

    # Synthetic is dark material on bright background. Carve a small
    # bright (background-colored) blob INSIDE one tooth, centered at the
    # PCD radius, 60% of the way from tooth-center toward the right flank.
    # On a real backlit gear this models a dark mark/scratch on a flank.
    pcd_r = 450
    step = 2 * np.pi / 17
    half_wedge = step * 0.5 / 2  # tooth_frac=0.5
    notch_angle = half_wedge * 0.6
    notch_cx = 600 + pcd_r * np.cos(notch_angle)
    notch_cy = 600 + pcd_r * np.sin(notch_angle)
    y, x = np.ogrid[:1200, :1200]
    d = np.sqrt((x - notch_cx) ** 2 + (y - notch_cy) ** 2)
    img[d <= 4] = 255  # background color

    result = analyze_gear(img, cx=600, cy=600, tip_r=500, root_r=400, n_teeth=17)
    assert len(result["teeth"]) == 17

    # Find the tooth nearest to angle 0 — that's the one with the notch.
    def circ_dist_deg(a: float, b: float) -> float:
        d = abs(a - b) % 360.0
        return min(d, 360.0 - d)

    affected = min(result["teeth"], key=lambda t: circ_dist_deg(t["center_angle_deg"], 0.0))
    expected_width = (360.0 / 17) * 0.5  # ~10.588
    assert abs(affected["angular_width_deg"] - expected_width) < 0.1, (
        f"marked tooth width {affected['angular_width_deg']:.3f} "
        f"vs expected {expected_width:.3f}"
    )


def test_invalid_n_teeth_raises():
    img = np.zeros((100, 100), dtype=np.uint8)
    with pytest.raises(ValueError):
        analyze_gear(img, 50, 50, 40, 30, n_teeth=2)


def test_invalid_radii_raises():
    img = np.zeros((100, 100), dtype=np.uint8)
    with pytest.raises(ValueError):
        analyze_gear(img, 50, 50, 30, 40, n_teeth=17)
