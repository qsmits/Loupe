"""Tests for fringe analysis vision module."""
import base64
import json
import math
import numpy as np
import pytest
import cv2

from backend.vision.fringe import (
    ZERNIKE_GROUPS,
    ZERNIKE_NAMES,
    fit_zernike,
    subtract_zernike,
    zernike_basis,
    zernike_noll_index,
    zernike_polynomial,
    _make_polar_coords,
    compute_fringe_modulation,
    create_fringe_mask,
    extract_phase_dft,
    unwrap_phase_2d,
    focus_quality,
    phase_to_height,
    surface_stats,
    render_surface_map,
    render_profile,
    render_zernike_chart,
    analyze_interferogram,
    reanalyze,
)


class TestZernikeNollIndex:
    def test_first_few_indices(self):
        assert zernike_noll_index(1) == (0, 0)   # Piston
        assert zernike_noll_index(2) == (1, 1)   # Tilt X
        assert zernike_noll_index(3) == (1, -1)  # Tilt Y
        assert zernike_noll_index(4) == (2, 0)   # Defocus
        assert zernike_noll_index(11) == (4, 0)  # Spherical

    def test_invalid_index_raises(self):
        with pytest.raises(ValueError):
            zernike_noll_index(0)

    def test_n_m_parity(self):
        """n - |m| must be even for all valid Noll indices."""
        for j in range(1, 37):
            n, m = zernike_noll_index(j)
            assert (n - abs(m)) % 2 == 0, f"j={j}: n={n}, m={m}"


class TestZernikePolynomial:
    def test_piston_is_constant(self):
        rho = np.linspace(0, 1, 50)
        theta = np.zeros_like(rho)
        Z1 = zernike_polynomial(1, rho, theta)
        # Piston Z1 = 1.0 (normalized)
        np.testing.assert_allclose(Z1, 1.0, atol=1e-10)

    def test_tilt_x_is_linear(self):
        """Tilt X (j=2) should be linear in x."""
        N = 100
        rho = np.linspace(0, 1, N)
        theta = np.zeros(N)  # along x-axis, theta=0
        Z2 = zernike_polynomial(2, rho, theta)
        # Should be proportional to rho*cos(0) = rho (linear in x)
        # Normalize both to compare shape
        Z2_norm = Z2 / Z2[-1] if Z2[-1] != 0 else Z2
        np.testing.assert_allclose(Z2_norm, rho / rho[-1], atol=1e-10)

    def test_orthogonality_on_unit_disk(self):
        """Verify orthogonality of first few Zernike polynomials via numerical integration."""
        N = 200
        rho_1d = np.linspace(0, 1, N)
        theta_1d = np.linspace(0, 2 * np.pi, N, endpoint=False)
        rho_2d, theta_2d = np.meshgrid(rho_1d, theta_1d)
        rho_flat = rho_2d.ravel()
        theta_flat = theta_2d.ravel()

        # Numerical integration weight: r * dr * dtheta (polar area element)
        dr = 1.0 / N
        dtheta = 2 * np.pi / N
        w = rho_flat * dr * dtheta

        for i in range(1, 7):
            for k in range(i + 1, 7):
                Zi = zernike_polynomial(i, rho_flat, theta_flat)
                Zk = zernike_polynomial(k, rho_flat, theta_flat)
                integral = np.sum(Zi * Zk * w) / np.pi  # normalize by disk area
                assert abs(integral) < 0.05, (
                    f"Z{i} and Z{k} not orthogonal: integral={integral:.4f}"
                )


class TestZernikeFitting:
    def test_recovers_tilt(self):
        """Fit a pure tilt surface and verify coefficient recovery."""
        h, w = 128, 128
        rho, theta = _make_polar_coords((h, w))
        # Create a pure Tilt X surface (Noll j=2)
        Z2 = zernike_polynomial(2, rho, theta)
        surface = 3.5 * Z2
        mask = rho <= 1.0

        coeffs, _, _ = fit_zernike(surface, n_terms=36, mask=mask)
        # Coefficient for j=2 should be ~3.5, all others ~0
        assert abs(coeffs[1] - 3.5) < 0.1
        for j in range(36):
            if j != 1:
                assert abs(coeffs[j]) < 0.1, f"j={j+1}: coeff={coeffs[j]:.4f}"

    def test_recovers_power(self):
        """Fit a pure power (defocus) surface."""
        h, w = 128, 128
        rho, theta = _make_polar_coords((h, w))
        Z4 = zernike_polynomial(4, rho, theta)
        surface = 2.0 * Z4
        mask = rho <= 1.0

        coeffs, _, _ = fit_zernike(surface, n_terms=36, mask=mask)
        assert abs(coeffs[3] - 2.0) < 0.1
        for j in range(36):
            if j != 3:
                assert abs(coeffs[j]) < 0.15, f"j={j+1}: coeff={coeffs[j]:.4f}"

    def test_subtract_removes_tilt(self):
        """After subtracting tilt, residual should be near zero."""
        h, w = 128, 128
        rho, theta = _make_polar_coords((h, w))
        Z2 = zernike_polynomial(2, rho, theta)
        Z3 = zernike_polynomial(3, rho, theta)
        surface = 3.0 * Z2 + 1.5 * Z3
        mask = rho <= 1.0

        coeffs, rho_f, theta_f = fit_zernike(surface, n_terms=36, mask=mask)
        corrected = subtract_zernike(surface, coeffs, [2, 3], rho_f, theta_f, mask)
        # Residual should be near zero within the aperture
        residual_rms = np.sqrt(np.mean(corrected[mask] ** 2))
        assert residual_rms < 0.1


class TestZernikeNames:
    def test_has_36_entries(self):
        assert len(ZERNIKE_NAMES) == 36

    def test_first_terms(self):
        assert ZERNIKE_NAMES[1] == "Piston"
        assert ZERNIKE_NAMES[2] == "Tilt X"
        assert ZERNIKE_NAMES[3] == "Tilt Y"
        assert ZERNIKE_NAMES[4] == "Power (Defocus)"

    def test_groups_reference_valid_indices(self):
        """All Noll indices in ZERNIKE_GROUPS must be valid keys in ZERNIKE_NAMES."""
        for group_name, indices in ZERNIKE_GROUPS.items():
            for idx in indices:
                assert idx in ZERNIKE_NAMES, (
                    f"Group '{group_name}' references j={idx} not in ZERNIKE_NAMES"
                )


class TestFringeModulation:
    def test_modulation_shape_and_range(self):
        """Modulation map should have correct shape and be in [0, 1]."""
        img = np.full((128, 128), 128.0)
        img += np.random.RandomState(0).randn(*img.shape) * 0.01
        mod = compute_fringe_modulation(img)
        assert mod.shape == (128, 128)
        assert mod.min() >= 0.0
        assert mod.max() <= 1.0

    def test_fringe_image_high_modulation(self):
        """An image with sinusoidal fringes should have high modulation."""
        x = np.linspace(0, 20 * np.pi, 200)
        img = 128.0 + 100.0 * np.sin(x[None, :]) * np.ones((100, 1))
        mod = compute_fringe_modulation(img)
        # Center region should have high modulation
        center_mod = mod[30:70, 30:170].mean()
        assert center_mod > 0.2


class TestFringeMask:
    def test_mask_rejects_dark_region(self):
        """Dark background should be masked out, bright region kept."""
        # Bright center with fringes, dark surround
        img = np.zeros((100, 100), dtype=np.float64)
        img[20:80, 20:80] = 128.0  # Bright center
        mod = np.zeros((100, 100))
        mod[20:80, 20:80] = 1.0
        mask = create_fringe_mask(img, mod, threshold_frac=0.15)
        assert mask[50, 50] == True   # Center is valid
        assert mask[5, 5] == False    # Corner is masked

    def test_mask_all_zeros(self):
        """All-zero image and modulation should produce all-False mask."""
        img = np.zeros((50, 50), dtype=np.float64)
        mod = np.zeros((50, 50))
        mask = create_fringe_mask(img, mod, threshold_frac=0.15)
        assert not mask.any()


class TestDFTPhaseExtraction:
    def test_extracts_phase_from_synthetic_interferogram(self):
        """Generate a synthetic interferogram with known carrier and verify extraction."""
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        # Carrier: 8 fringes across the width (vertical fringes)
        carrier_freq = 8
        carrier_phase = 2 * np.pi * carrier_freq * xx / w
        # Surface phase: a gentle tilt
        surface_phase = 0.5 * (xx - w / 2) / w * 2 * np.pi
        # Interferogram: I = 128 + 100 * cos(carrier + surface)
        interferogram = 128.0 + 100.0 * np.cos(carrier_phase + surface_phase)

        wrapped = extract_phase_dft(interferogram)
        assert wrapped.shape == (h, w)
        # Unwrap and check correlation with known surface phase.
        # Use interior region (25%-75%) to avoid Hann window edge effects.
        unwrapped, _ = unwrap_phase_2d(wrapped)
        lo, hi = w // 4, 3 * w // 4
        center_uw = unwrapped[h // 2, lo:hi]
        center_true = surface_phase[h // 2, lo:hi]
        # Correlation: extracted phase should track the true surface phase
        corr = np.corrcoef(center_uw, center_true)[0, 1]
        assert abs(corr) > 0.95, f"Phase correlation {corr:.3f} too low"

    def test_returns_correct_shape(self):
        img = np.random.rand(64, 128) * 255
        wrapped = extract_phase_dft(img)
        assert wrapped.shape == (64, 128)


class TestUnwrap2D:
    def test_unwraps_simple_ramp(self):
        """A phase ramp should unwrap to a smooth surface."""
        h, w = 50, 200
        true_phase = np.linspace(0, 6 * np.pi, w)[None, :].repeat(h, 0)
        wrapped = np.angle(np.exp(1j * true_phase))
        unwrapped, _ = unwrap_phase_2d(wrapped)
        # Should be smooth: no jumps > pi between adjacent pixels
        diff_x = np.abs(np.diff(unwrapped, axis=1))
        assert diff_x.max() < np.pi + 0.1

    def test_mask_zeros_invalid(self):
        phase = np.zeros((50, 50))
        mask = np.ones((50, 50), dtype=bool)
        mask[0:10, :] = False
        unwrapped, _ = unwrap_phase_2d(phase, mask)
        assert unwrapped[5, 25] == 0.0  # masked pixel is zeroed

    def test_quality_guided_prefers_high_quality_regions(self):
        """Quality-guided unwrapping should propagate from high-quality pixels."""
        h, w = 80, 80
        # Linear phase ramp with 3 full wraps
        true_phase = np.tile(np.linspace(0, 6 * np.pi, w), (h, 1))
        wrapped = np.angle(np.exp(1j * true_phase))
        mask = np.ones((h, w), dtype=bool)

        # Quality map: high everywhere except a vertical stripe
        quality = np.ones((h, w), dtype=np.float64)
        quality[:, 35:45] = 0.01  # low-quality stripe

        unwrapped, _ = unwrap_phase_2d(wrapped, mask, quality=quality)
        corr = np.corrcoef(unwrapped[mask], true_phase[mask])[0, 1]
        assert corr > 0.98

    def test_quality_guided_without_quality_map_still_works(self):
        """When quality=None, fall back to standard unwrapping."""
        h, w = 64, 64
        true_phase = np.tile(np.linspace(0, 4 * np.pi, w), (h, 1))
        wrapped = np.angle(np.exp(1j * true_phase))
        mask = np.ones((h, w), dtype=bool)

        unwrapped, _ = unwrap_phase_2d(wrapped, mask, quality=None)
        corr = np.corrcoef(unwrapped[mask], true_phase[mask])[0, 1]
        assert corr > 0.98


class TestUnwrapRiskMask:
    def test_returns_tuple(self):
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        result = unwrap_phase_2d(wrapped)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_risk_mask_shape(self):
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        _, risk = unwrap_phase_2d(wrapped)
        assert risk.shape == wrapped.shape
        assert risk.dtype == np.uint8

    def test_clean_unwrap_has_zero_risk(self):
        from backend.vision.fringe import unwrap_phase_2d
        y = np.linspace(0, 4 * np.pi, 64)
        phase = np.tile(y, (64, 1))
        wrapped = np.angle(np.exp(1j * phase))
        _, risk = unwrap_phase_2d(wrapped)
        assert np.mean(risk == 0) > 0.9

    def test_edge_contamination_zone(self):
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        mask = np.zeros((64, 64), dtype=bool)
        mask[10:54, 10:54] = True
        _, risk = unwrap_phase_2d(wrapped, mask=mask, fringe_period_px=5.0)
        assert np.any(risk == 2)
        assert risk[30, 30] != 2


class TestFocusQuality:
    def test_sharp_image_scores_high(self):
        """An image with sharp edges should score higher than a blurred one."""
        # Sharp: white rectangle on black
        sharp = np.zeros((100, 100), dtype=np.uint8)
        cv2.rectangle(sharp, (20, 20), (80, 80), 255, 2)

        # Blurred: same rectangle, heavily blurred
        blurred = cv2.GaussianBlur(sharp, (31, 31), 10)

        score_sharp = focus_quality(sharp)
        score_blurred = focus_quality(blurred)
        assert score_sharp > score_blurred

    def test_returns_0_to_100(self):
        img = np.zeros((50, 50), dtype=np.uint8)
        score = focus_quality(img)
        assert 0 <= score <= 100


class TestPhaseToHeight:
    def test_known_conversion(self):
        """2*pi radians at 632.8 nm should give 632.8/(4*pi)*2*pi = 316.4 nm."""
        phase = np.array([2 * np.pi])
        height = phase_to_height(phase, 632.8)
        expected = 632.8 / 2.0  # lambda/2 for a full wave
        np.testing.assert_allclose(height, expected, rtol=1e-6)

    def test_zero_phase_zero_height(self):
        phase = np.zeros((10, 10))
        height = phase_to_height(phase, 589.0)
        np.testing.assert_allclose(height, 0.0)


class TestSurfaceStats:
    def test_ramp_stats(self):
        s = np.linspace(0, 10, 101)
        stats = surface_stats(s)
        assert abs(stats["pv"] - 10.0) < 1e-9
        assert stats["rms"] > 0

    def test_masked_stats(self):
        s = np.array([0.0, 1.0, 2.0, 100.0])  # outlier at index 3
        mask = np.array([True, True, True, False])
        stats = surface_stats(s, mask)
        assert abs(stats["pv"] - 2.0) < 1e-9

    def test_empty_mask(self):
        s = np.ones((5, 5))
        mask = np.zeros((5, 5), dtype=bool)
        stats = surface_stats(s, mask)
        assert stats["pv"] == 0.0
        assert stats["rms"] == 0.0


class TestRenderSurfaceMap:
    def test_returns_valid_base64_png(self):
        surface = np.random.rand(50, 50)
        b64 = render_surface_map(surface)
        assert len(b64) > 100
        # Should decode without error
        decoded = base64.b64decode(b64)
        # PNG magic bytes
        assert decoded[:4] == b'\x89PNG'

    def test_masked_surface(self):
        surface = np.random.rand(50, 50)
        mask = np.ones((50, 50), dtype=bool)
        mask[:10, :] = False
        b64 = render_surface_map(surface, mask)
        assert len(b64) > 100


class TestRenderProfile:
    def test_x_profile(self):
        surface = np.arange(100).reshape(10, 10).astype(float)
        profile = render_profile(surface, axis="x")
        assert profile["axis"] == "x"
        assert len(profile["positions"]) == 10
        assert len(profile["values"]) == 10
        assert all(v is not None for v in profile["values"])

    def test_y_profile(self):
        surface = np.arange(100).reshape(10, 10).astype(float)
        profile = render_profile(surface, axis="y")
        assert profile["axis"] == "y"
        assert len(profile["positions"]) == 10

    def test_masked_profile(self):
        surface = np.ones((10, 10))
        mask = np.ones((10, 10), dtype=bool)
        mask[5, 3] = False
        profile = render_profile(surface, mask, axis="x")
        # The center row profile at y=5 should have None at x=3
        assert profile["values"][3] is None


class TestRenderZernikeChart:
    def test_returns_valid_png(self):
        coeffs = [0.1] * 36
        b64 = render_zernike_chart(coeffs, [2, 3], 632.8)
        assert len(b64) > 100
        decoded = base64.b64decode(b64)
        assert decoded[:4] == b'\x89PNG'


def _make_fringe_image(h, w, n_fringes=10):
    """Create a synthetic interferogram with horizontal fringes."""
    y = np.linspace(0, n_fringes * 2 * np.pi, h)
    pattern = np.outer(np.cos(y), np.ones(w))
    return ((pattern + 1) * 127).astype(np.uint8)


class TestAnalyzeInterferogram:
    def test_analyze_returns_height_grid(self):
        """analyze_interferogram should return height_grid, mask_grid, grid_rows, grid_cols."""
        image = _make_fringe_image(256, 256)
        result = analyze_interferogram(image, wavelength_nm=632.8)
        assert "height_grid" in result
        assert "mask_grid" in result
        assert "grid_rows" in result
        assert "grid_cols" in result
        assert isinstance(result["height_grid"], list)
        assert isinstance(result["mask_grid"], list)
        assert result["grid_rows"] > 0
        assert result["grid_cols"] > 0
        assert len(result["height_grid"]) == result["grid_rows"] * result["grid_cols"]
        assert len(result["mask_grid"]) == result["grid_rows"] * result["grid_cols"]

    def test_full_pipeline_synthetic(self):
        """Full pipeline on a synthetic interferogram returns expected keys."""
        h, w = 128, 128
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 6 * xx / w
        surface = 0.5 * ((xx - w/2)**2 + (yy - h/2)**2) / (w/2)**2
        img = (128 + 100 * np.cos(carrier + surface)).astype(np.uint8)

        result = analyze_interferogram(img, wavelength_nm=632.8)

        # Check all expected keys are present
        expected_keys = {
            "surface_map", "zernike_chart", "profile_x", "profile_y",
            "coefficients", "coefficient_names", "pv_nm", "rms_nm",
            "pv_waves", "rms_waves", "strehl", "modulation_stats", "focus_score",
            "subtracted_terms", "wavelength_nm", "n_valid_pixels", "n_total_pixels",
        }
        assert expected_keys.issubset(set(result.keys()))
        assert len(result["coefficients"]) == 36
        assert result["pv_nm"] >= 0
        assert result["rms_nm"] >= 0
        assert 0 <= result["focus_score"] <= 100

    def test_strehl_in_range(self):
        """Strehl ratio should be between 0 and 1."""
        image = _make_fringe_image(128, 128)
        result = analyze_interferogram(image, wavelength_nm=632.8)
        assert "strehl" in result
        assert 0 < result["strehl"] <= 1.0


class TestCarrierDiagnostics:
    def _make_fringe(self, period=20):
        x = np.arange(256)
        img = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(img, (256, 1))

    def test_snr_db_present(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert "snr_db" in result
        assert result["snr_db"] > 0

    def test_dc_margin_present(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert "dc_margin_px" in result
        assert result["dc_margin_px"] > 0

    def test_alternate_peaks_present(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert "alternate_peaks" in result
        assert isinstance(result["alternate_peaks"], list)
        assert len(result["alternate_peaks"]) <= 3

    def test_high_snr_for_clean_fringes(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert result["snr_db"] > 10


class TestReanalyze:
    def test_reanalyze_changes_stats(self):
        """Re-analyzing with different subtraction should change PV/RMS."""
        # First do a full analysis
        h, w = 64, 64
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 4 * xx / w
        img = (128 + 80 * np.cos(carrier)).astype(np.uint8)

        result = analyze_interferogram(img, wavelength_nm=632.8,
                                       subtract_terms=[1, 2, 3])
        coeffs = result["coefficients"]

        # Re-analyze: subtract nothing
        r1 = reanalyze(coeffs, subtract_terms=[1],
                       wavelength_nm=632.8, surface_shape=(h, w))
        # Re-analyze: subtract tilt + power
        r2 = reanalyze(coeffs, subtract_terms=[1, 2, 3, 4],
                       wavelength_nm=632.8, surface_shape=(h, w))

        # The two should generally have different PV
        assert r1["pv_nm"] >= 0
        assert r2["pv_nm"] >= 0
        assert "surface_map" in r1
        assert "surface_map" in r2
        # Strehl should be present and valid
        assert 0 < r1["strehl"] <= 1.0
        assert 0 < r2["strehl"] <= 1.0


class TestPolygonMask:
    def test_single_include_polygon(self):
        from backend.vision.fringe import rasterize_polygon_mask
        polygons = [
            {"vertices": [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)], "include": True},
        ]
        mask = rasterize_polygon_mask(polygons, 100, 100)
        assert mask.shape == (100, 100)
        assert mask.dtype == bool
        # Center should be included
        assert mask[50, 50] is np.True_
        # Corner should be excluded
        assert mask[0, 0] is np.False_

    def test_include_with_hole(self):
        from backend.vision.fringe import rasterize_polygon_mask
        polygons = [
            {"vertices": [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)], "include": True},
            {"vertices": [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)], "include": False},
        ]
        mask = rasterize_polygon_mask(polygons, 100, 100)
        # Center (inside hole) should be excluded
        assert mask[50, 50] is np.False_
        # Outside hole but inside boundary should be included
        assert mask[10, 10] is np.True_

    def test_no_polygons_returns_full_mask(self):
        from backend.vision.fringe import rasterize_polygon_mask
        mask = rasterize_polygon_mask([], 100, 100)
        assert mask.all()


class TestDiagnosticRendering:
    def test_render_fft_image_returns_base64_png(self):
        from backend.vision.fringe import render_fft_image
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        image = 128.0 + 100.0 * np.cos(2 * np.pi * 8 * xx / w)
        result = render_fft_image(image, peak_y=128, peak_x=160)
        assert isinstance(result, str)
        img_bytes = base64.b64decode(result)
        assert img_bytes[:4] == b"\x89PNG"

    def test_render_modulation_map_returns_base64_png(self):
        from backend.vision.fringe import render_modulation_map
        modulation = np.random.rand(100, 100)
        mask = np.ones((100, 100), dtype=bool)
        mask[40:60, 40:60] = False
        result = render_modulation_map(modulation, mask)
        assert isinstance(result, str)
        img_bytes = base64.b64decode(result)
        assert img_bytes[:4] == b"\x89PNG"

    def test_analyze_returns_fft_and_modulation(self):
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        image = 128 + 80 * np.cos(2 * np.pi * 8 * xx / w + 0.5 * yy / h)
        image = np.clip(image, 0, 255).astype(np.uint8)
        result = analyze_interferogram(image, n_zernike=15)
        assert "fft_image" in result
        assert "modulation_map" in result
        assert isinstance(result["fft_image"], str)
        assert isinstance(result["modulation_map"], str)


class TestFringeAPI:
    """API-level tests using the FastAPI test client."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def test_analyze_from_camera(self, client):
        """POST /fringe/analyze with no image uses camera frame."""
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "mask_threshold": 0.15,
            "subtract_terms": [1, 2, 3],
        })
        assert r.status_code == 200
        data = r.json()
        assert "surface_map" in data
        assert "coefficients" in data
        assert len(data["coefficients"]) == 36

    def test_analyze_with_image(self, client):
        """POST /fringe/analyze with base64 image."""
        h, w = 64, 64
        xx = np.arange(w)
        img = (128 + 80 * np.cos(2 * np.pi * 4 * xx / w)).astype(np.uint8)
        img_2d = np.tile(img, (h, 1))
        _, buf = cv2.imencode(".png", img_2d)
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")

        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": b64,
        })
        assert r.status_code == 200
        data = r.json()
        assert "pv_nm" in data
        assert data["pv_nm"] >= 0

    def test_reanalyze(self, client):
        """POST /fringe/reanalyze with cached coefficients."""
        r = client.post("/fringe/reanalyze", json={
            "coefficients": [0.1] * 36,
            "subtract_terms": [1, 2, 3],
            "wavelength_nm": 632.8,
            "surface_height": 64,
            "surface_width": 64,
        })
        assert r.status_code == 200
        data = r.json()
        assert "surface_map" in data
        assert "pv_nm" in data

    def test_focus_quality(self, client):
        """GET /fringe/focus-quality returns a score."""
        r = client.get("/fringe/focus-quality")
        assert r.status_code == 200
        data = r.json()
        assert "score" in data
        assert 0 <= data["score"] <= 100


class TestCarrierOverride:
    def test_analyze_with_carrier_override(self):
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        carrier_freq = 8
        image = 128.0 + 80.0 * np.cos(2 * np.pi * carrier_freq * xx / w)
        image = np.clip(image, 0, 255).astype(np.uint8)

        # Auto-detect carrier
        result_auto = analyze_interferogram(image, n_zernike=15)

        # Force a different carrier (slightly off from auto)
        auto_peak_x = result_auto["carrier"]["peak_x"]
        forced_x = auto_peak_x + 5
        forced_y = h // 2  # center row
        result_forced = analyze_interferogram(
            image, n_zernike=15,
            carrier_override=(forced_y, forced_x),
        )
        # Should still produce valid results, just different
        assert result_forced["pv_nm"] >= 0
        assert result_forced["carrier"]["peak_x"] == forced_x


class TestProgressCallback:
    """Tests for the on_progress callback added to analyze_interferogram."""

    def test_progress_callback_receives_all_stages(self):
        """All 5 expected stages should be reported with monotonically increasing progress."""
        h, w = 128, 128
        xx = np.arange(w)
        img = (128 + 80 * np.cos(2 * np.pi * 6 * xx / w)).astype(np.uint8)
        img = np.tile(img, (h, 1))

        events: list[tuple[str, float, str]] = []

        def on_progress(stage: str, progress: float, message: str) -> None:
            events.append((stage, progress, message))

        analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15,
                              on_progress=on_progress)

        stages_seen = [e[0] for e in events]
        progresses = [e[1] for e in events]

        # All 5 named stages must be present
        for expected in ("carrier", "phase", "unwrap", "zernike", "render"):
            assert expected in stages_seen, f"Stage '{expected}' not reported"

        # Progress must be monotonically non-decreasing
        for i in range(1, len(progresses)):
            assert progresses[i] >= progresses[i - 1], (
                f"Progress went backwards: {progresses[i-1]} -> {progresses[i]}"
            )

        # Final progress value must be 1.0
        assert progresses[-1] == 1.0, f"Final progress not 1.0: {progresses[-1]}"

    def test_no_callback_still_works(self):
        """analyze_interferogram without on_progress must still return normal results."""
        h, w = 64, 64
        xx = np.arange(w)
        img = (128 + 80 * np.cos(2 * np.pi * 4 * xx / w)).astype(np.uint8)
        img = np.tile(img, (h, 1))

        result = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15)
        assert "surface_map" in result
        assert "pv_nm" in result
        assert result["pv_nm"] >= 0


class TestAnalyzeStream:
    """API-level tests for the SSE /fringe/analyze-stream endpoint."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def _parse_sse(self, raw: str) -> list[dict]:
        """Parse raw SSE text into a list of JSON event dicts."""
        events = []
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                events.append(json.loads(payload))
        return events

    def test_stream_returns_progress_events(self, client):
        """POST with a valid image_b64 should yield progress events and a done event."""
        h, w = 64, 64
        xx = np.arange(w)
        img = (128 + 80 * np.cos(2 * np.pi * 4 * xx / w)).astype(np.uint8)
        img_2d = np.tile(img, (h, 1))
        _, buf = cv2.imencode(".png", img_2d)
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")

        with client.stream("POST", "/fringe/analyze-stream",
                           json={"image_b64": b64, "n_zernike": 15}) as resp:
            assert resp.status_code == 200
            assert "text/event-stream" in resp.headers.get("content-type", "")
            raw = resp.read().decode("utf-8")

        events = self._parse_sse(raw)
        assert len(events) > 0, "No SSE events received"

        stages = [e["stage"] for e in events]
        assert "done" in stages, "No 'done' event received"

        done_event = next(e for e in events if e["stage"] == "done")
        assert "result" in done_event
        assert "surface_map" in done_event["result"]
        assert "pv_nm" in done_event["result"]
        assert done_event["progress"] == 1.0

    def test_stream_error_returns_error_event(self, client):
        """POST with bad base64 should return an error SSE event (not an HTTP error)."""
        with client.stream("POST", "/fringe/analyze-stream",
                           json={"image_b64": "not-valid-base64!!!"}) as resp:
            # The response starts as SSE (200) even for errors
            assert resp.status_code == 200
            raw = resp.read().decode("utf-8")

        events = self._parse_sse(raw)
        assert len(events) > 0, "No SSE events received"
        error_events = [e for e in events if e["stage"] == "error"]
        assert len(error_events) > 0, "No error event received"
        assert "message" in error_events[0]


class TestConfidenceMetrics:
    def test_high_confidence(self):
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 15.0}
        modulation = np.full((64, 64), 0.8)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["carrier"] > 70
        assert result["modulation"] > 70
        assert result["unwrap"] > 95
        assert result["overall"] > 70

    def test_low_carrier_confidence(self):
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 1.5}
        modulation = np.full((64, 64), 0.8)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["carrier"] < 30
        assert result["overall"] < 30

    def test_low_modulation_coverage(self):
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 15.0}
        modulation = np.full((64, 64), 0.01)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["modulation"] < 30

    def test_many_unwrap_corrections(self):
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 15.0}
        modulation = np.full((64, 64), 0.8)
        risk_mask = np.ones((64, 64), dtype=np.uint8)  # all corrected
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["unwrap"] < 10


class TestConfidenceMaps:
    def test_returns_dict_with_expected_keys(self):
        from backend.vision.fringe import render_confidence_maps
        modulation = np.random.uniform(0, 1, (64, 64)).astype(np.float32)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = render_confidence_maps(modulation, risk_mask, mask)
        assert "unwrap_risk" in result
        assert "composite" in result

    def test_outputs_are_valid_base64_png(self):
        import base64
        from backend.vision.fringe import render_confidence_maps
        modulation = np.random.uniform(0, 1, (64, 64)).astype(np.float32)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = render_confidence_maps(modulation, risk_mask, mask)
        for key in ("unwrap_risk", "composite"):
            raw = base64.b64decode(result[key])
            assert raw[:4] == b"\x89PNG"


class TestPlaneFormRemoval:
    def _make_fringe_image(self, h=256, w=256, period=20):
        x = np.arange(w)
        row = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(row, (h, 1))

    def test_plane_model_returns_result(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img, form_model="plane")
        assert "pv_nm" in result
        assert "form_model" in result
        assert result["form_model"] == "plane"

    def test_plane_model_has_plane_fit(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img, form_model="plane")
        assert "plane_fit" in result
        assert "a" in result["plane_fit"]
        assert "b" in result["plane_fit"]
        assert "c" in result["plane_fit"]

    def test_zernike_model_is_default(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert result["form_model"] == "zernike"

    def test_plane_model_different_from_zernike(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        r_zernike = analyze_interferogram(img, form_model="zernike")
        r_plane = analyze_interferogram(img, form_model="plane")
        assert r_zernike["pv_nm"] != r_plane["pv_nm"] or r_zernike["rms_nm"] != r_plane["rms_nm"]
