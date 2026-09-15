"""Tests for corridor-based guided inspection."""
import math
import numpy as np
import cv2
import pytest

from backend.vision.guided_inspection import (
    inspect_features,
    fit_manual_points,
    _apply_spec_scoring,
    _band_verdict,
    _worse_verdict,
    _existing_dev_mm,
)


def _make_blank_frame(w=640, h=480, color=128):
    """Create a uniform gray BGR frame."""
    return np.full((h, w, 3), color, dtype=np.uint8)


def _draw_vertical_line(frame, x, y_start=50, y_end=430, color=255, thickness=2):
    """Draw a vertical white line on a dark frame."""
    frame = frame.copy()
    cv2.line(frame, (x, y_start), (x, y_end), (color, color, color), thickness)
    return frame


def _draw_circle(frame, cx, cy, r, color=255, thickness=2):
    """Draw a white circle on a dark frame."""
    frame = frame.copy()
    cv2.circle(frame, (cx, cy), r, (color, color, color), thickness)
    return frame


class TestInspectLine:
    def test_finds_edge_in_corridor(self):
        """A vertical line at x=100 in the image should be matched by a DXF line at x=100."""
        frame = _make_blank_frame(color=0)
        frame = _draw_vertical_line(frame, x=100)

        entity = {
            "handle": "L1",
            "type": "line",
            "parent_handle": None,
            # DXF coords in mm; with ppm=1, tx=0, ty=0, they map directly to pixels
            # For Y: dxf_to_image_px flips Y, so y1_mm=430 -> y_px = -430 + ty
            # With ppm=1, tx=100, ty=240: x_mm=0 -> x_px=100, y_mm=0 -> y_px=240
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["edge_point_count"] >= 5
        # Deviation should be small (line is exactly at expected position)
        assert r["perp_dev_mm"] is not None
        assert abs(r["perp_dev_mm"]) < 5.0  # generous threshold for edge detection jitter

    def test_no_edge_unmatched(self):
        """A uniform gray frame should produce no edges, so the entity is unmatched."""
        frame = _make_blank_frame(color=128)

        entity = {
            "handle": "L2",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -100,
            "x2": 0, "y2": 100,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is False
        assert r["reason"] is not None


class TestInspectCircle:
    def test_finds_arc(self):
        """A drawn circle should be matched by a DXF circle at the same position."""
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=80)

        entity = {
            "handle": "C1",
            "type": "circle",
            "parent_handle": None,
            # With ppm=1, tx=300, ty=240: cx_mm=0 -> 300px, cy_mm=0 -> 240px
            "cx": 0, "cy": 0,
            "radius": 80,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["edge_point_count"] >= 8
        assert r["center_dev_mm"] is not None
        assert r["center_dev_mm"] < 5.0
        assert r["radius_dev_mm"] is not None
        assert abs(r["radius_dev_mm"]) < 5.0


class TestInspectWithTransform:
    def test_line_with_translation(self):
        """Line at x=150 in image, DXF says x=50mm with tx=100 (50*1+100=150)."""
        frame = _make_blank_frame(color=0)
        frame = _draw_vertical_line(frame, x=150)

        entity = {
            "handle": "L3",
            "type": "line",
            "parent_handle": None,
            "x1": 50, "y1": -190,
            "x2": 50, "y2": 190,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert abs(r["perp_dev_mm"]) < 5.0


class TestTolerancePassWarnFail:
    def test_thresholds(self):
        """Verify pass/warn/fail classification based on deviation thresholds."""
        frame = _make_blank_frame(color=0)
        # Line at x=100, DXF also at x=100 => ~0 deviation => pass
        frame = _draw_vertical_line(frame, x=100)

        entity_pass = {
            "handle": "LP",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
            "tolerance_warn": 10.0,
            "tolerance_fail": 20.0,
        }

        results = inspect_features(
            frame, [entity_pass],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
            canny_low=30, canny_high=100,
            tolerance_warn=10.0,
            tolerance_fail=20.0,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["pass_fail"] == "pass"
        assert r["tolerance_warn"] == 10.0
        assert r["tolerance_fail"] == 20.0

        # Now use very tight tolerance so the same small deviation triggers warn/fail
        entity_tight = {
            "handle": "LT",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
            "tolerance_warn": 0.0001,
            "tolerance_fail": 0.0002,
        }

        results_tight = inspect_features(
            frame, [entity_tight],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
            canny_low=30, canny_high=100,
            tolerance_warn=0.0001,
            tolerance_fail=0.0002,
        )

        r2 = results_tight[0]
        if r2["matched"]:
            # With extremely tight tolerances, any deviation should be warn or fail
            assert r2["pass_fail"] in ("warn", "fail")


class TestFitManualPointsLine:
    def test_fit_line(self):
        """Manual points along a vertical line should produce a valid fit."""
        entity = {
            "handle": "ML1",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -100,
            "x2": 0, "y2": 100,
        }

        # Points roughly along x=100 (the projected nominal line with tx=100)
        points = [[100.0 + i * 0.1, float(50 + i * 10)] for i in range(10)]

        result = fit_manual_points(
            entity, points,
            pixels_per_mm=1.0,
            tx=100, ty=240,
            tolerance_warn=5.0,
            tolerance_fail=10.0,
        )

        assert result["matched"] is True
        assert result["fit"]["type"] == "line"
        assert result["perp_dev_mm"] is not None
        assert result["pass_fail"] in ("pass", "warn", "fail")

    def test_too_few_points(self):
        """Fewer than 5 points should return unmatched."""
        entity = {
            "handle": "ML2",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -100,
            "x2": 0, "y2": 100,
        }

        result = fit_manual_points(
            entity, [[100, 100]],  # only 1 point — need at least 2
            pixels_per_mm=1.0,
        )

        assert result["matched"] is False
        assert "at least" in result["reason"]


class TestFitManualPointsCircle:
    def test_fit_circle(self):
        """Manual points on a circle should produce a valid fit."""
        entity = {
            "handle": "MC1",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 50,
        }

        # Generate points on a circle centered at (300, 240) with r=50
        angles = np.linspace(0, 2 * math.pi, 20, endpoint=False)
        points = [[300 + 50 * math.cos(a), 240 + 50 * math.sin(a)] for a in angles]

        result = fit_manual_points(
            entity, points,
            pixels_per_mm=1.0,
            tx=300, ty=240,
            tolerance_warn=5.0,
            tolerance_fail=10.0,
        )

        assert result["matched"] is True
        assert result["fit"]["type"] == "circle"
        assert result["center_dev_mm"] is not None
        assert result["center_dev_mm"] < 2.0
        assert result["radius_dev_mm"] is not None
        assert abs(result["radius_dev_mm"]) < 2.0

    def test_too_few_points(self):
        """Fewer than 8 points should return unmatched."""
        entity = {
            "handle": "MC2",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 50,
        }

        result = fit_manual_points(
            entity, [[100, 100], [110, 110]],  # only 2 points — need at least 3 for arc
            pixels_per_mm=1.0,
        )

        assert result["matched"] is False
        assert "at least" in result["reason"]


def _draw_horizontal_line(frame, y, x1, x2, color=255, thickness=2):
    frame = frame.copy()
    cv2.line(frame, (x1, y), (x2, y), (color, color, color), thickness)
    return frame


def _draw_arc(frame, cx, cy, r, start_deg, end_deg, color=255, thickness=2):
    """Draw a partial arc (image-frame angles, y-down) on a dark frame."""
    frame = frame.copy()
    cv2.ellipse(frame, (cx, cy), (r, r), 0, start_deg, end_deg,
                (color, color, color), thickness)
    return frame


class TestUndersizeRadiusGate:
    """An undersized circle must fail inspection — negative radius deviation
    must not be discarded by the max(center_dev, radius_dev) gate."""

    def test_corridor_undersize_circle_fails(self):
        """Circle 0.5mm undersize, centered on nominal, tol ±0.1/0.25 -> fail."""
        frame = _make_blank_frame(color=0)
        # ppm=10: nominal radius 8mm -> 80px; filled disc of 75px -> single
        # boundary edge 5px inside nominal -> -0.5mm deviation
        frame = _draw_circle(frame, cx=300, cy=240, r=75, thickness=-1)

        entity = {
            "handle": "U1",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 8.0,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=10.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=10,
            canny_low=30, canny_high=100,
            tolerance_warn=0.1,
            tolerance_fail=0.25,
        )

        r = results[0]
        assert r["matched"] is True
        # Reported deviation stays signed (frontend displays the sign)
        assert r["radius_dev_mm"] == pytest.approx(-0.5, abs=0.15)
        assert r["pass_fail"] == "fail"

    def test_manual_points_undersize_circle_fails(self):
        """Manual point fit 0.5mm undersize, centered on nominal -> fail."""
        entity = {
            "handle": "U2",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 8.0,
        }

        # Points on a 75px circle centered exactly on the nominal (300, 240)
        angles = np.linspace(0, 2 * math.pi, 20, endpoint=False)
        points = [[300 + 75 * math.cos(a), 240 + 75 * math.sin(a)] for a in angles]

        result = fit_manual_points(
            entity, points,
            pixels_per_mm=10.0,
            tx=300, ty=240,
            tolerance_warn=0.1,
            tolerance_fail=0.25,
        )

        assert result["matched"] is True
        assert result["radius_dev_mm"] == pytest.approx(-0.5, abs=0.01)
        assert result["pass_fail"] == "fail"


class TestPartialArcCorridorFrame:
    """The angular corridor mask must be built in the image frame via the
    alignment transform, not from raw DXF angles (y-up, un-rotated)."""

    def test_rotated_arc_selects_correct_sector(self):
        """DXF arc 0-90deg with angle_deg=90: the transformed arc lands at
        image angles 180-270deg; the corridor must select that sector."""
        frame = _make_blank_frame(color=0)
        frame = _draw_arc(frame, cx=300, cy=240, r=80, start_deg=180, end_deg=270)

        entity = {
            "handle": "AR1",
            "type": "arc",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 80.0,
            "start_angle": 0.0,
            "end_angle": 90.0,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=300, ty=240,
            angle_deg=90.0,
            corridor_px=10,
            canny_low=30, canny_high=100,
        )

        r = results[0]
        assert r["matched"] is True, r["reason"]
        # Generous thresholds for edge jitter / partial-arc fit bias — the
        # decisive check is matched: a wrong-frame corridor collects 0 points.
        assert r["center_dev_mm"] < 5.0
        assert abs(r["radius_dev_mm"]) < 5.0

    def test_flipped_arc_selects_correct_sector(self):
        """DXF arc 0-90deg with flip_h: the transformed arc lands at image
        angles 180-270deg; the corridor must select that sector."""
        frame = _make_blank_frame(color=0)
        frame = _draw_arc(frame, cx=300, cy=240, r=80, start_deg=180, end_deg=270)

        entity = {
            "handle": "AR2",
            "type": "arc",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 80.0,
            "start_angle": 0.0,
            "end_angle": 90.0,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=300, ty=240,
            angle_deg=0.0,
            flip_h=True,
            corridor_px=10,
            canny_low=30, canny_high=100,
        )

        r = results[0]
        assert r["matched"] is True, r["reason"]
        assert r["center_dev_mm"] < 5.0
        assert abs(r["radius_dev_mm"]) < 5.0

    def test_full_span_arc_keeps_all_angles(self):
        """A 0-360deg arc entity must not collapse the corridor to a sliver
        around angle 0 — edge points at all angles must be retained."""
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=80)

        entity = {
            "handle": "AR3",
            "type": "arc",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 80.0,
            "start_angle": 0.0,
            "end_angle": 360.0,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=10,
            canny_low=30, canny_high=100,
        )

        r = results[0]
        assert r["matched"] is True, r["reason"]
        # Full circle is ~500px circumference with two Canny contours; a
        # sliver mask would leave only a few dozen points.
        assert r["edge_point_count"] > 400
        assert r["center_dev_mm"] < 3.0
        assert abs(r["radius_dev_mm"]) < 3.0


class TestTruePosition:
    def test_circle_has_tp_dev_mm(self):
        """Circle inspection results should include tp_dev_mm = 2 * center_dev_mm."""
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=80)

        entity = {
            "handle": "TP1",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 80,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["tp_dev_mm"] is not None
        assert r["center_dev_mm"] is not None
        # Allow small rounding tolerance since both values are independently rounded
        assert abs(r["tp_dev_mm"] - 2.0 * r["center_dev_mm"]) < 0.001

    def test_circle_has_dx_dy_px(self):
        """Circle results should include raw pixel deviations dx_px, dy_px."""
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=80)

        entity = {
            "handle": "TP2",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 80,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["dx_px"] is not None
        assert r["dy_px"] is not None
        # With ppm=1, sqrt(dx_px^2 + dy_px^2) should equal center_dev_mm
        computed = math.sqrt(r["dx_px"] ** 2 + r["dy_px"] ** 2)
        assert abs(computed - r["center_dev_mm"]) < 0.1

    def test_line_has_no_tp(self):
        """Line inspection results should have tp_dev_mm = None."""
        frame = _make_blank_frame(color=0)
        frame = _draw_horizontal_line(frame, y=240, x1=50, x2=590)

        entity = {
            "handle": "TP3",
            "type": "line",
            "parent_handle": None,
            "x1": -270, "y1": 0,
            "x2": 270, "y2": 0,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=320, ty=240,
            angle_deg=0.0,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        assert len(results) == 1
        r = results[0]
        assert r["matched"] is True
        assert r["tp_dev_mm"] is None
        assert r["dx_px"] is None
        assert r["dy_px"] is None


# --- DXF drawing-spec / default-tolerance scoring ---
#
# _band_verdict / _worse_verdict / _existing_dev_mm / _apply_spec_scoring are
# unit-tested directly (precise numeric truth table) rather than through the
# Canny/corridor pipeline, which has too much pixel-level jitter to hit exact
# 80%-of-limit boundaries deterministically. inspect_features() end-to-end
# tests below cover the wiring/precedence through the real pipeline.

class TestBandVerdictAsymmetricTruthTable:
    """upper=0.05, lower=-0.02 (deliberately asymmetric, as the spec calls
    out explicitly): pass / warn-high / fail-high / warn-low / fail-low,
    each checked around its exact 80%-of-limit and limit boundaries."""

    UPPER, LOWER = 0.05, -0.02

    def test_pass_zone(self):
        assert _band_verdict(0.0, self.UPPER, self.LOWER) == "pass"
        assert _band_verdict(0.03, self.UPPER, self.LOWER) == "pass"       # < 0.8*0.05=0.04
        assert _band_verdict(0.04, self.UPPER, self.LOWER) == "pass"       # exactly 80% -> still pass
        assert _band_verdict(-0.01, self.UPPER, self.LOWER) == "pass"      # > 0.8*-0.02=-0.016
        assert _band_verdict(-0.016, self.UPPER, self.LOWER) == "pass"     # exactly 80% -> still pass

    def test_warn_high_side(self):
        assert _band_verdict(0.041, self.UPPER, self.LOWER) == "warn"
        assert _band_verdict(0.05, self.UPPER, self.LOWER) == "warn"       # exactly at the limit -> warn, not fail

    def test_fail_high_side(self):
        assert _band_verdict(0.0501, self.UPPER, self.LOWER) == "fail"

    def test_warn_low_side_asymmetric(self):
        """The low side's 80% threshold (-0.016) is a different magnitude
        than the high side's (0.04) because the band is asymmetric."""
        assert _band_verdict(-0.017, self.UPPER, self.LOWER) == "warn"
        assert _band_verdict(-0.02, self.UPPER, self.LOWER) == "warn"      # exactly at the limit -> warn, not fail

    def test_fail_low_side(self):
        assert _band_verdict(-0.0201, self.UPPER, self.LOWER) == "fail"


class TestWorseVerdict:
    def test_orders_pass_warn_fail(self):
        assert _worse_verdict("pass", "pass") == "pass"
        assert _worse_verdict("pass", "warn") == "warn"
        assert _worse_verdict("warn", "pass") == "warn"
        assert _worse_verdict("warn", "fail") == "fail"
        assert _worse_verdict("fail", "pass") == "fail"
        assert _worse_verdict("fail", "fail") == "fail"


class TestExistingDevMm:
    def test_line_uses_signed_perp_dev(self):
        result = {"perp_dev_mm": -0.3, "center_dev_mm": None, "radius_dev_mm": None}
        assert _existing_dev_mm(result) == -0.3

    def test_circle_uses_larger_magnitude_of_center_or_radius(self):
        assert _existing_dev_mm({"perp_dev_mm": None, "center_dev_mm": 0.1, "radius_dev_mm": -0.5}) == 0.5
        assert _existing_dev_mm({"perp_dev_mm": None, "center_dev_mm": 0.6, "radius_dev_mm": -0.5}) == 0.6


class TestApplySpecScoringUnit:
    """Direct unit tests of the drawing-spec scoring helper, bypassing the
    image pipeline so the diameter-basis doubling and precedence rules can
    be pinned exactly."""

    def _circle_entity(self, handle="C1"):
        return {"handle": handle, "type": "circle", "cx": 0, "cy": 0, "radius": 10.0}

    def _matched_result(self, fit_r_px, center_dev_mm=0.0, radius_dev_mm=0.0):
        return {
            "matched": True,
            "fit": {"type": "circle", "cx": 0.0, "cy": 0.0, "r": fit_r_px},
            "center_dev_mm": center_dev_mm,
            "radius_dev_mm": radius_dev_mm,
            "pass_fail": "pass",
        }

    def test_diameter_spec_pass_inside_band(self):
        """Diameter-kind spec: nominal/upper/lower are already diameter-valued,
        no doubling."""
        entity = self._circle_entity()
        spec = {"kind": "diameter", "nominal": 20.0, "upper": 0.05, "lower": -0.02}
        # fit_r=10.005mm (ppm=1) -> measured diameter 20.01 -> dev=+0.01 (< 0.8*0.05)
        result = self._matched_result(fit_r_px=10.005)
        _apply_spec_scoring(result, entity, spec, ppm=1.0, default_tol=None,
                             tolerance_warn=0.1, tolerance_fail=0.25)
        assert result["pass_fail"] == "pass"
        assert result["spec"] == {"nominal": 20.0, "upper": 0.05, "lower": -0.02,
                                   "kind": "diameter", "source": "drawing"}
        assert result["size_dev_mm"] == pytest.approx(0.01, abs=1e-6)
        assert "spec_source" not in result  # position judged by global tol, not default_tol

    def test_radius_spec_doubles_nominal_and_limits_for_size_verdict(self):
        """The classic mistake: ±0.01 on a *radius* dim is ±0.02 on diameter.
        A deviation of 0.015mm on the diameter must PASS under the correctly
        doubled band (±0.02) but would FAIL under the undoubled band (±0.01)."""
        entity = self._circle_entity()
        spec = {"kind": "radius", "nominal": 10.0, "upper": 0.01, "lower": -0.01}
        # measured diameter = 2*10.0075 = 20.015 -> dev = +0.015 vs nominal_d=20.0
        result = self._matched_result(fit_r_px=10.0075)
        _apply_spec_scoring(result, entity, spec, ppm=1.0, default_tol=None,
                             tolerance_warn=0.1, tolerance_fail=0.25)
        assert result["size_dev_mm"] == pytest.approx(0.015, abs=1e-6)
        # 0.015 < 0.8 * (2*0.01) == 0.016 -> pass. Undoubled it would be > 0.01 -> fail.
        assert result["pass_fail"] == "pass"

    def test_size_fail_dominates_worst_of_two(self):
        """Size fails, position (center_dev) is perfect -> overall fail."""
        entity = self._circle_entity()
        spec = {"kind": "diameter", "nominal": 20.0, "upper": 0.05, "lower": -0.02}
        # measured diameter = 2*10.2 = 20.4 -> dev=+0.4, way outside upper=0.05
        result = self._matched_result(fit_r_px=10.2, center_dev_mm=0.0)
        _apply_spec_scoring(result, entity, spec, ppm=1.0, default_tol=None,
                             tolerance_warn=0.1, tolerance_fail=0.25)
        assert result["pass_fail"] == "fail"

    def test_position_judged_by_default_tol_when_no_override(self):
        """With a drawing spec present, POSITION is still judged: by
        default_tol when given, else the global warn/fail. Also proves the
        worst-of-two: size passes here but position fails against default_tol."""
        entity = self._circle_entity()
        spec = {"kind": "diameter", "nominal": 20.0, "upper": 0.05, "lower": -0.02}
        result = self._matched_result(fit_r_px=10.0, center_dev_mm=0.5)  # size dev = 0 -> pass
        _apply_spec_scoring(result, entity, spec, ppm=1.0, default_tol=0.1,
                             tolerance_warn=999, tolerance_fail=999)
        assert result["size_dev_mm"] == pytest.approx(0.0, abs=1e-9)
        assert result["pass_fail"] == "fail"  # center_dev 0.5 >> default_tol 0.1
        assert result["spec_source"] == "default"
        assert result["spec"]["source"] == "drawing"

    def test_position_falls_back_to_global_tolerance_without_default_tol(self):
        entity = self._circle_entity()
        spec = {"kind": "diameter", "nominal": 20.0, "upper": 0.05, "lower": -0.02}
        result = self._matched_result(fit_r_px=10.0, center_dev_mm=0.5)  # size dev = 0 -> pass
        _apply_spec_scoring(result, entity, spec, ppm=1.0, default_tol=None,
                             tolerance_warn=0.1, tolerance_fail=0.25)
        assert result["pass_fail"] == "fail"  # center_dev 0.5 >> global fail=0.25
        assert "spec_source" not in result

    def test_no_spec_falls_back_to_default_tol_band(self):
        """No drawing spec at all, but a default_tol is set: judge the
        existing single deviation measure against fail=default_tol,
        warn=0.8*default_tol."""
        entity = self._circle_entity()
        result = self._matched_result(fit_r_px=10.0, center_dev_mm=0.09, radius_dev_mm=0.0)
        _apply_spec_scoring(result, entity, spec=None, ppm=1.0, default_tol=0.1,
                             tolerance_warn=0.01, tolerance_fail=0.02)
        assert "spec" not in result
        assert result["spec_source"] == "default"
        assert result["pass_fail"] == "warn"  # 0.09 > 0.8*0.1=0.08, <= 0.1

    def test_no_spec_no_default_tol_is_a_pure_noop(self):
        """The regression pin: with neither a drawing spec nor a default_tol,
        _apply_spec_scoring must not touch the result at all."""
        entity = self._circle_entity()
        result = self._matched_result(fit_r_px=10.5, center_dev_mm=0.5, radius_dev_mm=0.5)
        result["pass_fail"] = "warn"  # whatever _inspect_arc_circle already decided
        before = dict(result)
        _apply_spec_scoring(result, entity, spec=None, ppm=1.0, default_tol=None,
                             tolerance_warn=0.1, tolerance_fail=0.25)
        assert result == before

    def test_line_entity_ignores_spec_even_if_present(self):
        """Specs only ever apply to circles/arcs; a spec dict on a line
        handle (which the parser never produces) must be ignored."""
        entity = {"handle": "L1", "type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0}
        result = {
            "matched": True,
            "fit": {"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0},
            "perp_dev_mm": 0.01,
            "pass_fail": "pass",
        }
        spec = {"kind": "diameter", "nominal": 20.0, "upper": 0.05, "lower": -0.02}
        _apply_spec_scoring(result, entity, spec, ppm=1.0, default_tol=None,
                             tolerance_warn=0.1, tolerance_fail=0.25)
        assert "spec" not in result
        assert result["pass_fail"] == "pass"  # untouched (no default_tol either)


class TestInspectFeaturesSpecPrecedence:
    """End-to-end through inspect_features(): popover feature_tolerances
    override must win over any drawing spec / default_tol, exactly like
    today, and a spec-judged result must carry its fields through the real
    Canny/corridor pipeline."""

    def test_popover_override_wins_over_drawing_spec(self):
        """A feature_tolerances entry for this handle must produce the exact
        same result the pre-existing (pre-feature) code path would: no spec/
        size_dev_mm/spec_source fields, pass_fail from the simple deviation
        measure against the popover's own warn/fail."""
        frame = _make_blank_frame(color=0)
        # ppm=10: nominal radius 8mm -> 80px; filled disc of 75px -> -0.5mm deviation
        frame = _draw_circle(frame, cx=300, cy=240, r=75, thickness=-1)

        entity = {
            "handle": "PVR",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 8.0,
        }
        # A drawing spec so tight it would fail if it were consulted at all.
        spec = {"handle": "PVR", "kind": "diameter", "nominal": 16.0, "upper": 0.001, "lower": -0.001}

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=10.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=10,
            canny_low=30, canny_high=100,
            tolerance_warn=0.1, tolerance_fail=0.25,
            feature_tolerances={"PVR": {"warn": 10.0, "fail": 20.0}},
            feature_specs={"PVR": spec},
            default_tol=0.001,
        )

        r = results[0]
        assert r["matched"] is True
        assert r["pass_fail"] == "pass"  # popover's generous 10/20mm band, not the tight spec
        assert "spec" not in r
        assert "spec_source" not in r
        assert "size_dev_mm" not in r

    def test_drawing_spec_is_applied_when_no_override(self):
        frame = _make_blank_frame(color=0)
        frame = _draw_circle(frame, cx=300, cy=240, r=75, thickness=-1)

        entity = {
            "handle": "DSA",
            "type": "circle",
            "parent_handle": None,
            "cx": 0, "cy": 0,
            "radius": 8.0,
        }
        # Generous band around the ~-1.0mm diameter deviation this undersized
        # disc actually produces (measured Ø ~= 15mm vs nominal 16mm).
        spec = {"kind": "diameter", "nominal": 16.0, "upper": 5.0, "lower": -5.0}

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=10.0,
            tx=300, ty=240,
            angle_deg=0.0,
            corridor_px=10,
            canny_low=30, canny_high=100,
            feature_specs={"DSA": spec},
        )

        r = results[0]
        assert r["matched"] is True
        assert r["spec"]["source"] == "drawing"
        assert r["spec"]["kind"] == "diameter"
        assert r["size_dev_mm"] is not None
        assert r["size_dev_mm"] < 0  # undersized disc -> negative diameter deviation

    def test_default_tol_applied_when_no_spec_no_override(self):
        frame = _make_blank_frame(color=0)
        frame = _draw_vertical_line(frame, x=100)

        entity = {
            "handle": "DTL",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
            canny_low=30, canny_high=100,
            default_tol=5.0,
        )

        r = results[0]
        assert r["matched"] is True
        assert r["spec_source"] == "default"

    def test_no_spec_no_default_regression_pin(self):
        """With neither feature_specs nor default_tol passed (the historical
        call signature), behavior and result shape are byte-for-byte
        unchanged: no spec/spec_source/size_dev_mm keys anywhere."""
        frame = _make_blank_frame(color=0)
        frame = _draw_vertical_line(frame, x=100)

        entity = {
            "handle": "L1",
            "type": "line",
            "parent_handle": None,
            "x1": 0, "y1": -190,
            "x2": 0, "y2": 190,
        }

        results = inspect_features(
            frame, [entity],
            pixels_per_mm=1.0,
            tx=100, ty=240,
            corridor_px=15,
            canny_low=30, canny_high=100,
        )

        r = results[0]
        assert r["matched"] is True
        assert "spec" not in r
        assert "spec_source" not in r
        assert "size_dev_mm" not in r
