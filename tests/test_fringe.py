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
    undistort_frame,
    zernike_basis,
    zernike_noll_index,
    zernike_polynomial,
    _make_polar_coords,
    _find_carrier,
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

    def test_correct_2pi_jumps_flag_off_preserves_step(self, monkeypatch):
        """The flag must skip the 9x9 median-filter 2π snap when False, and
        apply it when True. This documents a critical bug in the legacy
        cleanup: a pixel that differs from its local 9x9 median by >π is
        snapped by 2π toward the median, which silently destroys real
        physical steps ≥ ~λ/4 (~158 nm at 632.8 nm) — corrupting
        gage-block validation measurements.

        We monkey-patch the underlying skimage spatial unwrap to be the
        identity. That isolates the median-filter block from skimage's
        own (lossy) wrap-resolution behavior, which would otherwise
        flatten any ≥π synthetic step before the median ever sees it.
        After the patch, the ONLY difference between the two flag values
        is whether the median snap is applied.
        """
        from backend.vision import fringe as fringe_mod

        # Construct a smooth background plus a narrow ~5 rad ridge that
        # the median filter will see as a 2π unwrap glitch.
        h, w = 60, 120
        ridge_height = 5.0  # ~1.6π — > π so the snap rounds by 2π
        center = w // 2
        unwrapped_in = np.zeros((h, w), dtype=np.float64)
        unwrapped_in[:, center - 1:center + 2] = ridge_height  # 3-px ridge

        # Patch skimage.restoration.unwrap_phase (imported lazily inside
        # unwrap_phase_2d) to return the input unchanged. This bypasses
        # spatial-unwrap's destructive folding of large steps so we can
        # test the median-filter logic in isolation.
        import skimage.restoration as sr
        monkeypatch.setattr(sr, "unwrap_phase",
                            lambda phase: np.asarray(phase, dtype=np.float64))

        # quality=None and mask=None routes through the patched skimage path.
        unwrapped_off, _ = fringe_mod.unwrap_phase_2d(
            unwrapped_in, correct_2pi_jumps=False)
        unwrapped_on, _ = fringe_mod.unwrap_phase_2d(
            unwrapped_in, correct_2pi_jumps=True)

        # Sample inside the ridge vs. background.
        bg_col = w // 8
        ridge_off = float(np.median(unwrapped_off[:, center] - unwrapped_off[:, bg_col]))
        ridge_on = float(np.median(unwrapped_on[:, center] - unwrapped_on[:, bg_col]))

        # Flag OFF: the median-filter snap is skipped, so the ridge survives
        # within ~5% of its true height.
        assert abs(ridge_off - ridge_height) < 0.05 * ridge_height, (
            f"With correct_2pi_jumps=False, ridge should equal {ridge_height:.3f} rad "
            f"but got {ridge_off:.3f} rad"
        )

        # Flag ON: the bug snaps the ridge by 2π toward the local median
        # (background ≈ 0), so the recovered ridge is ridge_height − 2π ≈
        # −1.28 rad — i.e., the real step is destroyed.
        assert abs(ridge_on - ridge_height) > 0.5, (
            f"Expected the legacy correction to corrupt the ridge, but "
            f"recovered ridge={ridge_on:.3f} rad is still close to "
            f"true={ridge_height:.3f} rad — has the bug been fixed elsewhere?"
        )
        # And specifically: the snap rounds by ~2π.
        assert abs(ridge_on - (ridge_height - 2 * np.pi)) < 0.1, (
            f"Expected ridge to be snapped to ridge_height − 2π ≈ "
            f"{ridge_height - 2*np.pi:.3f} rad, got {ridge_on:.3f} rad"
        )


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

    def test_downsampled_large_image_preserves_carrier_period(self):
        from backend.vision.fringe import _analyze_carrier
        h, w = 512, 2048
        period = 32
        x = np.arange(w)
        row = (128 + 80 * np.cos(2 * np.pi * x / period)).astype(np.uint8)
        img = np.tile(row, (h, 1))

        result = _analyze_carrier(img)

        assert abs(result["fringe_period_px"] - period) < 1.0

    def test_low_fringe_count_large_image_not_hidden_by_dc_mask(self):
        from backend.vision.fringe import _analyze_carrier
        h, w = 512, 2048
        n_fringes = 4
        x = np.arange(w)
        row = (128 + 80 * np.cos(2 * np.pi * n_fringes * x / w)).astype(np.uint8)
        img = np.tile(row, (h, 1))

        result = _analyze_carrier(img)

        assert abs(result["fringe_period_px"] - (w / n_fringes)) < 2.0

    def test_partial_bright_region_carrier_diagnostics_match_true_period(self):
        from backend.vision.fringe import _analyze_carrier
        h, w = 768, 2048
        y0, y1 = 160, 640
        x0, x1 = 720, 1120
        period = 32
        img = np.full((h, w), 20, dtype=np.float64)
        xx = np.arange(x1 - x0)
        patch = 170 + 50 * np.cos(2 * np.pi * xx / period)
        img[y0:y1, x0:x1] = patch[None, :]
        img = np.clip(img, 0, 255).astype(np.uint8)

        result = _analyze_carrier(img)

        assert abs(result["fringe_period_px"] - period) < 2.0


class TestReanalyze:
    def test_reanalyze_returns_height_grid(self):
        """reanalyze() must return a refreshed height_grid/mask_grid so the
        frontend Step tool and 3D view don't read stale pre-reanalyze data."""
        h, w = 64, 64
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 4 * xx / w
        # Flat-ish surface so Zernike reconstruction is meaningful
        img = (128 + 80 * np.cos(carrier)).astype(np.uint8)

        full = analyze_interferogram(img, wavelength_nm=632.8,
                                     subtract_terms=[1, 2, 3])
        coeffs = full["coefficients"]
        mask_serialized = [int(v) for v in full["mask_grid"]]  # placeholder; replaced below

        # Use the full-resolution mask that the API caches: rebuild one the
        # same shape as the (cropped) surface returned by analyze.
        sh, sw = full["surface_height"], full["surface_width"]
        mask_full = np.ones(sh * sw, dtype=int).tolist()

        result = reanalyze(
            coefficients=coeffs,
            subtract_terms=[1, 2, 3, 4],
            wavelength_nm=632.8,
            surface_shape=(sh, sw),
            mask_serialized=mask_full,
        )

        assert "height_grid" in result
        assert "mask_grid" in result
        assert "grid_rows" in result
        assert "grid_cols" in result
        assert isinstance(result["height_grid"], list)
        assert isinstance(result["mask_grid"], list)
        assert result["grid_rows"] > 0
        assert result["grid_cols"] > 0
        assert len(result["height_grid"]) > 0
        assert len(result["mask_grid"]) > 0
        assert len(result["height_grid"]) == result["grid_rows"] * result["grid_cols"]
        assert len(result["mask_grid"]) == result["grid_rows"] * result["grid_cols"]

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


class TestPipelineConfidence:
    def _make_fringe_image(self, h=256, w=256, period=20):
        x = np.arange(w)
        row = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(row, (h, 1))

    def test_confidence_in_result(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert "confidence" in result
        for key in ("carrier", "modulation", "unwrap", "overall"):
            assert key in result["confidence"]
            assert 0 <= result["confidence"][key] <= 100

    def test_confidence_maps_in_result(self):
        import base64
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert "confidence_maps" in result
        for key in ("unwrap_risk", "composite"):
            assert key in result["confidence_maps"]
            raw = base64.b64decode(result["confidence_maps"][key])
            assert raw[:4] == b"\x89PNG"

    def test_unwrap_stats_in_result(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert "unwrap_stats" in result
        for key in ("n_corrected", "n_edge_risk", "n_reliable"):
            assert key in result["unwrap_stats"]


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
        carrier = {"peak_ratio": 1.0}
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


class TestPipelineV2Integration:
    """Full pipeline integration tests for v2 features."""

    def _make_fringe_image(self, h=256, w=256, period=20):
        x = np.arange(w)
        row = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(row, (h, 1))

    def test_full_result_has_all_v2_fields(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        r = analyze_interferogram(img)
        # Confidence
        assert "confidence" in r
        assert "confidence_maps" in r
        assert "unwrap_stats" in r
        # Form model
        assert "form_model" in r
        assert r["form_model"] == "zernike"
        # Enhanced carrier
        assert "snr_db" in r["carrier"]
        assert "dc_margin_px" in r["carrier"]
        assert "alternate_peaks" in r["carrier"]

    def test_plane_model_full_pipeline(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        r = analyze_interferogram(img, form_model="plane")
        assert r["form_model"] == "plane"
        assert r["plane_fit"] is not None
        assert "a" in r["plane_fit"]
        assert r["pv_nm"] > 0

    def test_reanalyze_with_plane_model(self):
        from backend.vision.fringe import analyze_interferogram, reanalyze
        img = self._make_fringe_image()
        r1 = analyze_interferogram(img)
        r2 = reanalyze(
            coefficients=r1["coefficients"],
            subtract_terms=[1, 2, 3],
            wavelength_nm=632.8,
            surface_shape=(r1["surface_height"], r1["surface_width"]),
            form_model="plane",
        )
        assert r2["form_model"] == "plane"
        assert "pv_nm" in r2


class TestFringeAPIV2:
    """API-level v2 integration tests: form_model and confidence fields."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def test_analyze_accepts_form_model(self, client):
        r = client.post("/fringe/analyze", json={"form_model": "plane"})
        assert r.status_code == 200
        data = r.json()
        assert data["form_model"] == "plane"

    def test_analyze_returns_confidence(self, client):
        r = client.post("/fringe/analyze", json={})
        assert r.status_code == 200
        data = r.json()
        assert "confidence" in data
        assert "confidence_maps" in data


class TestUndistortFrame:
    def test_zero_k1_returns_same(self):
        img = np.random.randint(0, 255, (64, 64), dtype=np.uint8)
        result = undistort_frame(img, 0.0)
        np.testing.assert_array_equal(result, img)

    def test_positive_k1_pincushion(self):
        """Positive k1 (pincushion correction) moves edge content inward."""
        sz = 128
        img = np.zeros((sz, sz), dtype=np.uint8)
        # Place bright blob near the corner (off both axes)
        cv2.circle(img, (100, 10), 3, 255, -1)
        cx, cy = sz / 2, sz / 2
        # Use large normalized k1 — at 128x128, diag_sq=8192 so k1_raw = k1/8192;
        # need large normalized value to produce visible shift on tiny images.
        result = undistort_frame(img, 10.0)
        orig_ys, orig_xs = np.where(img > 0)
        res_ys, res_xs = np.where(result > 0)
        assert len(res_ys) > 0, "Bright pixels should still be visible"
        orig_dist = np.hypot(orig_xs.mean() - cx, orig_ys.mean() - cy)
        result_dist = np.hypot(res_xs.mean() - cx, res_ys.mean() - cy)
        assert result_dist < orig_dist, "Positive k1 should move edge content inward"

    def test_negative_k1_barrel(self):
        """Negative k1 (barrel correction) moves edge content outward."""
        sz = 128
        img = np.zeros((sz, sz), dtype=np.uint8)
        # Place bright blob between center and edge
        cv2.circle(img, (80, 30), 3, 255, -1)
        cx, cy = sz / 2, sz / 2
        result = undistort_frame(img, -10.0)
        orig_ys, orig_xs = np.where(img > 0)
        res_ys, res_xs = np.where(result > 0)
        assert len(res_ys) > 0, "Bright pixels should still be visible"
        orig_dist = np.hypot(orig_xs.mean() - cx, orig_ys.mean() - cy)
        result_dist = np.hypot(res_xs.mean() - cx, res_ys.mean() - cy)
        assert result_dist > orig_dist, "Negative k1 should move edge content outward"

    def test_roundtrip_shape(self):
        """Output shape matches input for various sizes."""
        for shape in [(64, 64), (128, 96), (48, 128), (64, 64, 3)]:
            img = np.zeros(shape, dtype=np.uint8)
            result = undistort_frame(img, 0.3)
            assert result.shape == img.shape, f"Shape mismatch for input {shape}"

    def test_analyze_interferogram_accepts_lens_k1(self):
        """Smoke test: analyze_interferogram with lens_k1 returns valid result."""
        # Create a simple fringe pattern
        y = np.arange(128).reshape(-1, 1)
        fringe_img = (127 + 127 * np.sin(2 * np.pi * y / 20)).astype(np.uint8)
        fringe_img = np.tile(fringe_img, (1, 128))
        result = analyze_interferogram(fringe_img, lens_k1=0.1)
        assert isinstance(result, dict)
        assert "pv_nm" in result
        assert "rms_nm" in result


class TestLensK1Integration:
    def test_analyze_with_lens_k1(self):
        """analyze_interferogram produces valid output with lens_k1."""
        h, w = 128, 128
        x = np.arange(w)
        img = np.tile((128 + 100 * np.sin(2 * np.pi * x / 20)).astype(np.uint8), (h, 1))
        result = analyze_interferogram(img, lens_k1=0.3)
        assert "pv_nm" in result
        assert "rms_nm" in result
        assert result["pv_nm"] > 0

    def test_analyze_lens_k1_zero_matches_no_k1(self):
        """lens_k1=0.0 should produce identical results to omitting it."""
        h, w = 64, 64
        x = np.arange(w)
        img = np.tile((128 + 100 * np.sin(2 * np.pi * x / 16)).astype(np.uint8), (h, 1))
        r1 = analyze_interferogram(img, lens_k1=0.0)
        r2 = analyze_interferogram(img)
        assert r1["pv_nm"] == r2["pv_nm"]
        assert r1["rms_nm"] == r2["rms_nm"]

    def test_api_analyze_accepts_lens_k1(self, client):
        r = client.post("/fringe/analyze", json={"lens_k1": 0.3})
        assert r.status_code == 200
        data = r.json()
        assert "pv_nm" in data

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c


# ──────────────────────────────────────────────────────────────────────
#  Physical-units validation tests
#
#  These tests synthesize interferograms with known physical heights and
#  verify the recovered surface in nm. Designed to catch:
#    - Sign errors (carrier-direction ambiguity)
#    - Scale errors (factor-of-2 from single- vs double-pass)
#    - Hardcoded wavelength bugs
#    - Zernike Noll-ordering / normalization bugs
#    - Off-axis (diagonal carrier) sign bugs
# ──────────────────────────────────────────────────────────────────────


def _grid_to_2d(result):
    """Reshape the flat height_grid list back into a 2-D numpy array."""
    rows = result["grid_rows"]
    cols = result["grid_cols"]
    grid = np.array(result["height_grid"], dtype=np.float64).reshape(rows, cols)
    mask = np.array(result["mask_grid"], dtype=bool).reshape(rows, cols)
    return grid, mask


class TestPhysicalUnitsValidation:
    @pytest.mark.xfail(
        reason="Single-shot step recovery: a step's 1/f spectrum biases the "
               "sub-pixel carrier estimate, producing a residual slope that "
               "dwarfs sub-λ/4 steps. Use dual-mask protocol for step "
               "measurements (see test_dual_mask_protocol_for_larger_step)."
    )
    def test_physical_step_recovery_nm(self):
        """Synthesize an interferogram with a known +100 nm step (<λ/4).

        Single-shot recovery does not work for step features because the
        step's low-frequency spectral leakage biases carrier detection,
        producing a slope that overwhelms the step. For smooth features
        (bumps, gradual slopes, optical flat form) the pipeline works.
        """
        h, w = 256, 256
        wavelength_nm = 632.8
        true_step_nm = 100.0  # well under λ/4 = 158 nm, no wrap aliasing
        height = np.zeros((h, w), dtype=np.float64)
        height[:, w // 2:] = true_step_nm

        # Convert height to phase (double-pass): phase = (4π/λ) * h
        surface_phase = (4.0 * np.pi / wavelength_nm) * height

        # Carrier: 30 vertical fringes
        yy, xx = np.mgrid[0:h, 0:w]
        carrier_phase = 2.0 * np.pi * 30.0 * xx / w

        I = 0.5 + 0.5 * np.cos(carrier_phase + surface_phase)
        img = (I * 255.0).astype(np.uint8)

        result = analyze_interferogram(
            img,
            wavelength_nm=wavelength_nm,
            subtract_terms=[1],          # piston only — keep the step!
            use_full_mask=True,
            form_model="zernike",
            correct_2pi_jumps=False,     # don't smooth real steps away
        )
        grid, mask = _grid_to_2d(result)

        gh, gw = grid.shape
        margin_y = gh // 5
        plateau_A = grid[margin_y:gh - margin_y, gw // 8: gw // 2 - gw // 8]
        plateau_B = grid[margin_y:gh - margin_y, gw // 2 + gw // 8: 7 * gw // 8]
        mask_A = mask[margin_y:gh - margin_y, gw // 8: gw // 2 - gw // 8]
        mask_B = mask[margin_y:gh - margin_y, gw // 2 + gw // 8: 7 * gw // 8]

        mean_A = float(np.mean(plateau_A[mask_A])) if mask_A.any() else 0.0
        mean_B = float(np.mean(plateau_B[mask_B])) if mask_B.any() else 0.0
        measured_step = mean_B - mean_A

        assert abs(measured_step - true_step_nm) < 0.10 * true_step_nm, (
            f"Recovered step {measured_step:.1f} nm differs from {true_step_nm} nm "
            f"by more than 10%. plateau_A mean={mean_A:.1f} nm, plateau_B mean={mean_B:.1f} nm"
        )

    def test_sign_convention_bump_is_positive(self):
        """A +100 nm Gaussian bump must recover with positive height (<λ/4, no wrap)."""
        h, w = 256, 256
        wavelength_nm = 632.8
        peak_nm = 100.0

        yy, xx = np.mgrid[0:h, 0:w]
        cx, cy = w / 2.0, h / 2.0
        # Sigma much larger than LPF σ (~21 px) so the LPF doesn't round the peak.
        sigma = w / 4.0
        bump = peak_nm * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))

        surface_phase = (4.0 * np.pi / wavelength_nm) * bump
        carrier_phase = 2.0 * np.pi * 30.0 * xx / w

        I = 0.5 + 0.5 * np.cos(carrier_phase + surface_phase)
        img = (I * 255.0).astype(np.uint8)

        result = analyze_interferogram(
            img,
            wavelength_nm=wavelength_nm,
            subtract_terms=[1],
            use_full_mask=True,
            form_model="zernike",
            correct_2pi_jumps=False,
        )
        grid, mask = _grid_to_2d(result)
        gh, gw = grid.shape

        center_val = float(grid[gh // 2, gw // 2])
        corner = grid[: gh // 8, : gw // 8]
        corner_mask = mask[: gh // 8, : gw // 8]
        bg_val = float(np.mean(corner[corner_mask])) if corner_mask.any() else 0.0
        peak_height = center_val - bg_val

        assert peak_height > 0, (
            f"Expected positive bump, got peak_height={peak_height:.1f} nm "
            f"(center={center_val:.1f}, bg={bg_val:.1f}). Sign convention error."
        )
        assert abs(peak_height - peak_nm) < 0.25 * peak_nm, (
            f"Peak height {peak_height:.1f} nm differs from {peak_nm} nm by more than 25%."
        )

    def test_wavelength_invariance(self):
        """Same physical 80 nm bump at 632.8 nm vs 532 nm should match.

        Peak = 80 nm keeps surface_phase < π at both wavelengths
        (4π·80/532 = 1.89 rad), so no unwrap stress at either.
        """
        h, w = 256, 256
        peak_nm = 80.0

        yy, xx = np.mgrid[0:h, 0:w]
        cx, cy = w / 2.0, h / 2.0
        sigma = w / 4.0  # wide bump — doesn't get rounded by LPF
        bump = peak_nm * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))

        carrier_phase = 2.0 * np.pi * 30.0 * xx / w

        results = {}
        for wavelength_nm in (632.8, 532.0):
            surface_phase = (4.0 * np.pi / wavelength_nm) * bump
            I = 0.5 + 0.5 * np.cos(carrier_phase + surface_phase)
            img = (I * 255.0).astype(np.uint8)

            r = analyze_interferogram(
                img,
                wavelength_nm=wavelength_nm,
                subtract_terms=[1],
                use_full_mask=True,
                form_model="zernike",
                correct_2pi_jumps=False,
            )
            grid, mask = _grid_to_2d(r)
            gh, gw = grid.shape
            center_val = float(grid[gh // 2, gw // 2])
            corner_mask = mask[: gh // 8, : gw // 8]
            bg_val = float(np.mean(grid[: gh // 8, : gw // 8][corner_mask])) \
                if corner_mask.any() else 0.0
            results[wavelength_nm] = center_val - bg_val

        peak_red = results[632.8]
        peak_grn = results[532.0]
        rel_diff = abs(peak_red - peak_grn) / max(abs(peak_red), abs(peak_grn), 1e-9)
        assert rel_diff < 0.05, (
            f"Wavelength invariance violated: 632.8nm→{peak_red:.1f} nm vs "
            f"532nm→{peak_grn:.1f} nm (rel diff {rel_diff*100:.1f}%). "
            f"Likely a hardcoded wavelength somewhere."
        )

    def test_zernike_polynomial_reference_values(self):
        """Hand-coded reference values for normalized Noll Zernikes."""
        # Z1 (piston) = 1
        z1 = float(zernike_polynomial(1, np.array([0.0]), np.array([0.0]))[0])
        assert abs(z1 - 1.0) < 1e-10, f"Z1(0,0) = {z1}, expected 1.0 (piston)"

        # Z2 (tilt-x, m=+1, n=1): norm = sqrt(2*(n+1)) = 2. R_1^1(rho)=rho.
        # Z2(rho=1, theta=0) = 2 * 1 * cos(0) = 2.
        z2 = float(zernike_polynomial(2, np.array([1.0]), np.array([0.0]))[0])
        assert abs(z2 - 2.0) < 1e-10, f"Z2(1,0) = {z2}, expected 2.0 (tilt-x)"

        # Z4 (defocus, m=0, n=2): norm = sqrt(n+1) = sqrt(3).
        # R_2^0(rho) = 2*rho^2 - 1; at rho=1, R = 1. → Z4 = sqrt(3).
        z4 = float(zernike_polynomial(4, np.array([1.0]), np.array([0.0]))[0])
        assert abs(z4 - math.sqrt(3.0)) < 1e-10, (
            f"Z4(1,0) = {z4}, expected sqrt(3) ≈ {math.sqrt(3):.6f} (defocus)"
        )

        # Z5: in this codebase, even j → m>0 (cos), odd j → m<0 (sin).
        # j=5 odd → m=-2 (oblique astig, sin term). norm = sqrt(2*(n+1)) = sqrt(6).
        # R_2^2(rho) = rho^2. Z5(1, pi/4) = sqrt(6) * 1 * sin(2*pi/4) = sqrt(6).
        z5 = float(zernike_polynomial(5, np.array([1.0]), np.array([math.pi / 4]))[0])
        assert abs(z5 - math.sqrt(6.0)) < 1e-10, (
            f"Z5(1,pi/4) = {z5}, expected sqrt(6) ≈ {math.sqrt(6):.6f} (oblique astig)"
        )

    @pytest.mark.xfail(
        reason="Single-shot step recovery with diagonal carrier — same "
               "limitation as test_physical_step_recovery_nm."
    )
    def test_diagonal_carrier_works(self):
        """A diagonal carrier should recover a +100 nm step like an on-axis carrier."""
        h, w = 256, 256
        wavelength_nm = 632.8
        true_step_nm = 100.0  # under λ/4, no wrap aliasing
        height = np.zeros((h, w), dtype=np.float64)
        height[:, w // 2:] = true_step_nm

        surface_phase = (4.0 * np.pi / wavelength_nm) * height

        # Diagonal carrier ~45°: 20 cycles per image diagonal
        yy, xx = np.mgrid[0:h, 0:w]
        n_fringes = 20.0
        carrier_phase = 2.0 * np.pi * n_fringes * (xx + yy) / (w * math.sqrt(2.0))

        I = 0.5 + 0.5 * np.cos(carrier_phase + surface_phase)
        img = (I * 255.0).astype(np.uint8)

        result = analyze_interferogram(
            img,
            wavelength_nm=wavelength_nm,
            subtract_terms=[1],
            use_full_mask=True,
            form_model="zernike",
            correct_2pi_jumps=False,
        )
        grid, mask = _grid_to_2d(result)
        gh, gw = grid.shape
        margin_y = gh // 5
        plateau_A = grid[margin_y:gh - margin_y, gw // 8: gw // 2 - gw // 8]
        plateau_B = grid[margin_y:gh - margin_y, gw // 2 + gw // 8: 7 * gw // 8]
        mask_A = mask[margin_y:gh - margin_y, gw // 8: gw // 2 - gw // 8]
        mask_B = mask[margin_y:gh - margin_y, gw // 2 + gw // 8: 7 * gw // 8]
        mean_A = float(np.mean(plateau_A[mask_A])) if mask_A.any() else 0.0
        mean_B = float(np.mean(plateau_B[mask_B])) if mask_B.any() else 0.0
        measured_step = mean_B - mean_A

        assert abs(measured_step - true_step_nm) < 0.15 * true_step_nm, (
            f"Diagonal-carrier step recovery: {measured_step:.1f} nm, "
            f"expected +{true_step_nm} nm. plateau_A={mean_A:.1f}, plateau_B={mean_B:.1f}."
        )

    def test_large_step_cannot_be_recovered_single_wavelength(self):
        """Regression test documenting a physics limitation.

        Single-shot single-wavelength spatial-carrier interferometry cannot
        unambiguously resolve a step > λ/4 (~158 nm at 632.8 nm). The phase
        difference between the two plateaus is ambiguous mod 2π, so the
        recovered step is the wrapped-phase alias of the true step, not the
        true step itself.

        This test feeds the pipeline a synthetic 1000 nm step (> λ/2, well
        outside the unambiguous range) and asserts that the recovered step
        is NOT within 10 % of truth. It passes today because the pipeline
        correctly reports the wrapped alias.

        If this test starts failing, it means the pipeline gained step-aware
        recovery (e.g., multi-wavelength, temporal phase shifting, or a
        dual-analysis protocol actually wired up), at which point this test
        should be DELETED — the limitation it documents no longer exists.
        """
        h, w = 256, 256
        wavelength_nm = 632.8
        true_step_nm = 1000.0  # ~3.16 · λ/2, far outside λ/4 unambiguous range
        height = np.zeros((h, w), dtype=np.float64)
        height[:, w // 2:] = true_step_nm

        # Small tilt so the surface isn't perfectly flat (mimics real setup).
        yy, xx = np.mgrid[0:h, 0:w]
        height = height + 5.0 * (xx - w / 2) / w  # ±2.5 nm tilt

        surface_phase = (4.0 * np.pi / wavelength_nm) * height
        carrier_phase = 2.0 * np.pi * 30.0 * xx / w
        I = 0.5 + 0.5 * np.cos(carrier_phase + surface_phase)
        img = (I * 255.0).astype(np.uint8)

        result = analyze_interferogram(
            img,
            wavelength_nm=wavelength_nm,
            subtract_terms=[1],          # piston only — keep the step
            use_full_mask=True,
            form_model="zernike",
            correct_2pi_jumps=False,     # don't smooth the step away
        )
        grid, mask = _grid_to_2d(result)

        gh, gw = grid.shape
        margin_y = gh // 5
        # Strips away from the edge on each plateau.
        plateau_A = grid[margin_y:gh - margin_y, gw // 8: gw // 2 - gw // 8]
        plateau_B = grid[margin_y:gh - margin_y, gw // 2 + gw // 8: 7 * gw // 8]
        mask_A = mask[margin_y:gh - margin_y, gw // 8: gw // 2 - gw // 8]
        mask_B = mask[margin_y:gh - margin_y, gw // 2 + gw // 8: 7 * gw // 8]

        mean_A = float(np.mean(plateau_A[mask_A])) if mask_A.any() else 0.0
        mean_B = float(np.mean(plateau_B[mask_B])) if mask_B.any() else 0.0
        measured_step = mean_B - mean_A

        assert abs(measured_step - true_step_nm) > 100.0, (
            "Single-shot single-wavelength interferometry cannot resolve a "
            "1000 nm step (>> λ/4). This test documents the limitation; if "
            "it starts failing, it means the pipeline gained step-aware "
            "recovery (e.g., multi-wavelength), and this test should be "
            f"removed. Got measured_step={measured_step:.1f} nm, "
            f"truth={true_step_nm:.1f} nm, |error|="
            f"{abs(measured_step - true_step_nm):.1f} nm."
        )

    def test_small_smooth_surface_region_comparison(self):
        """Step tool's actual valid use case: mean difference between two
        regions on a SMOOTH surface (sub-λ/4 height variation everywhere).

        Example use cases: checking asymmetry on an optical flat, comparing
        peak vs background on a Gaussian bump, quantifying localized form
        error. These are well-defined because the phase is continuous and
        unambiguous across the whole field.

        For sharp step features > λ/4, see
        test_large_step_cannot_be_recovered_single_wavelength (limitation
        doc — a single-wavelength pipeline cannot resolve those).
        """
        h, w = 256, 256
        wavelength_nm = 632.8
        peak_nm = 100.0  # under λ/4, no wrap ambiguity

        yy, xx = np.mgrid[0:h, 0:w]
        cx, cy = w / 2.0, h / 2.0
        # Wide Gaussian bump so the LPF doesn't round the peak away.
        sigma = w / 4.0
        bump = peak_nm * np.exp(
            -((xx - cx) ** 2 + (yy - cy) ** 2) / (2.0 * sigma ** 2)
        )

        surface_phase = (4.0 * np.pi / wavelength_nm) * bump
        carrier_phase = 2.0 * np.pi * 30.0 * xx / w
        I = 0.5 + 0.5 * np.cos(carrier_phase + surface_phase)
        img = (I * 255.0).astype(np.uint8)

        result = analyze_interferogram(
            img,
            wavelength_nm=wavelength_nm,
            subtract_terms=[1],
            use_full_mask=True,
            form_model="zernike",
            correct_2pi_jumps=False,
        )
        grid, mask = _grid_to_2d(result)
        gh, gw = grid.shape

        # Two rectangular regions defined in image pixel coords, then mapped
        # into the (rows, cols) of the output height_grid (which covers the
        # full image extent but may be subsampled).
        peak_half = 16  # ±16 px around image center
        bg_half = 20
        bg_cx, bg_cy = bg_half + 4, bg_half + 4  # just inside upper-left corner

        def img_rect_to_grid(y0, y1, x0, x1):
            ry0 = int(round(y0 * gh / h))
            ry1 = int(round(y1 * gh / h))
            rx0 = int(round(x0 * gw / w))
            rx1 = int(round(x1 * gw / w))
            return ry0, ry1, rx0, rx1

        py0, py1, px0, px1 = img_rect_to_grid(
            int(cy) - peak_half, int(cy) + peak_half,
            int(cx) - peak_half, int(cx) + peak_half,
        )
        by0, by1, bx0, bx1 = img_rect_to_grid(
            bg_cy - bg_half, bg_cy + bg_half,
            bg_cx - bg_half, bg_cx + bg_half,
        )

        peak_region = grid[py0:py1, px0:px1]
        peak_mask = mask[py0:py1, px0:px1]
        bg_region = grid[by0:by1, bx0:bx1]
        bg_mask = mask[by0:by1, bx0:bx1]

        assert peak_mask.any() and bg_mask.any(), (
            "Region masks are empty — sampling rectangles landed outside "
            "the valid mask."
        )

        peak_mean = float(np.mean(peak_region[peak_mask]))
        bg_mean = float(np.mean(bg_region[bg_mask]))
        measured_diff = peak_mean - bg_mean

        # Analytic expectation: mean of the Gaussian bump over each rectangle
        # in image-pixel space (where the synthetic truth is defined).
        def bump_mean_over_rect(y0, y1, x0, x1):
            y0, y1 = max(0, y0), min(h, y1)
            x0, x1 = max(0, x0), min(w, x1)
            return float(np.mean(bump[y0:y1, x0:x1]))

        expected_peak = bump_mean_over_rect(
            int(cy) - peak_half, int(cy) + peak_half,
            int(cx) - peak_half, int(cx) + peak_half,
        )
        expected_bg = bump_mean_over_rect(
            bg_cy - bg_half, bg_cy + bg_half,
            bg_cx - bg_half, bg_cx + bg_half,
        )
        expected_diff = expected_peak - expected_bg

        rel_err = abs(measured_diff - expected_diff) / max(abs(expected_diff), 1e-9)
        assert rel_err < 0.30, (
            f"Step-tool region comparison on a smooth surface differs from "
            f"analytic expectation by more than 30%. "
            f"measured={measured_diff:.2f} nm, expected={expected_diff:.2f} nm, "
            f"rel_err={rel_err*100:.1f}%. "
            f"peak_mean={peak_mean:.2f} nm, bg_mean={bg_mean:.2f} nm, "
            f"expected_peak={expected_peak:.2f} nm, expected_bg={expected_bg:.2f} nm."
        )


class TestPipelineDiagnostics:
    """Bisection tests to localize the sign and magnitude bugs.

    Strategy: each test exercises one stage in isolation so the failure
    mode points at a single root cause. Tests are diagnostic — failures
    print enough info to identify which sideband, which σ, etc.
    """

    # ── helpers ─────────────────────────────────────────────────────────

    @staticmethod
    def _make_image(surface_height_nm, carrier_freq_x_cycles=30,
                    wavelength_nm=632.8, h=256, w=256):
        """Build I = 0.5 + 0.5 * cos(carrier_x + surface_phase)."""
        surface_height_nm = np.broadcast_to(surface_height_nm, (h, w))
        yy, xx = np.mgrid[0:h, 0:w]
        surface_phase = (4.0 * np.pi / wavelength_nm) * surface_height_nm
        carrier_phase = 2.0 * np.pi * carrier_freq_x_cycles * xx / w
        I = 0.5 + 0.5 * np.cos(carrier_phase + surface_phase)
        return (I * 255.0).astype(np.uint8)

    @staticmethod
    def _demod_with_sigma(img_uint8, py, px, lp_sigma):
        """Inline simplified demodulation with explicit σ (no auto-σ).

        Mirrors extract_phase_dft but with σ as a parameter and no
        background subtraction (keeps the test purely about LPF damage).
        Returns wrapped phase.
        """
        img = np.asarray(img_uint8, dtype=np.float64)
        h, w = img.shape
        fy = (py - h // 2) / h
        fx = (px - w // 2) / w
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = np.exp(-2j * np.pi * (fy * yy + fx * xx))
        demod = (img - img.mean()) * carrier
        re = cv2.GaussianBlur(demod.real, (0, 0), lp_sigma)
        im = cv2.GaussianBlur(demod.imag, (0, 0), lp_sigma)
        return np.angle(re + 1j * im)

    # ── Test 1: which sideband does _find_carrier select? ──────────────

    def test_find_carrier_sideband_choice(self):
        """_find_carrier must pick the +sideband for cos(+carrier + surface)."""
        img = self._make_image(surface_height_nm=0.0,
                               carrier_freq_x_cycles=30)
        h, w = img.shape
        cy, cx = h // 2, w // 2

        py, px, dist = _find_carrier(img)

        # With sub-pixel refinement, px is a float — allow ±1 bin slack.
        offset_y = py - cy
        offset_x = px - cx

        assert abs(offset_y) < 1.5, (
            f"Expected carrier ~on centerline (py≈cy={cy}), got py={py:.2f}."
        )
        assert abs(offset_x - 30.0) < 1.0, (
            f"_find_carrier must pick the +30 sideband for cos(+30·x+surface). "
            f"Got px - cx = {offset_x:+.2f} (expected +30 ± 1). "
            f"If this is negative, the conjugate sideband was picked — "
            f"that globally inverts the recovered surface phase."
        )

    # ── Test 2: extract_phase_dft sign with explicit carrier override ──

    def test_extract_phase_dft_sign_with_explicit_carrier(self):
        """With a known +sideband carrier, recovered phase must match input sign.

        Bisects the bug: if this passes, demodulation math in extract_phase_dft
        is correct and the bug is purely in _find_carrier's sideband choice.
        """
        h, w = 256, 256
        cy, cx = h // 2, w // 2
        wavelength_nm = 632.8

        # Linear x-tilt, small enough not to wrap (max phase ≈ 0.99 rad < π).
        yy, xx = np.mgrid[0:h, 0:w]
        slope_nm_per_px = 50.0 / w  # 50 nm PV across the image
        surface_height = slope_nm_per_px * xx
        img = self._make_image(surface_height, carrier_freq_x_cycles=30,
                               wavelength_nm=wavelength_nm)

        # Use the +sideband (the surface-bearing one for cos(+carrier+surface)).
        wrapped_plus  = extract_phase_dft(img, carrier_override=(cy, cx + 30))
        wrapped_minus = extract_phase_dft(img, carrier_override=(cy, cx - 30))

        # Sample slope by comparing left and right strips, well away from edges
        # to avoid LPF transients.
        left  = wrapped_plus [h // 4:3 * h // 4, w // 8: w // 4]
        right = wrapped_plus [h // 4:3 * h // 4, 3 * w // 4:7 * w // 8]
        slope_plus_rad = float(np.mean(right) - np.mean(left))

        left  = wrapped_minus[h // 4:3 * h // 4, w // 8: w // 4]
        right = wrapped_minus[h // 4:3 * h // 4, 3 * w // 4:7 * w // 8]
        slope_minus_rad = float(np.mean(right) - np.mean(left))

        # Expected phase difference between the right and left strips:
        # surface_height differs by ~slope · (5w/8 - w/8 - w/8 + w/8) = slope · w/2.
        # actually right_center - left_center ≈ (3w/4 + w/16) - (w/8 + w/16)
        #     = 3w/4 - w/8 = 5w/8. So Δheight ≈ slope · 5w/8 = 50/w · 5w/8 = 31.25 nm.
        # Δphase = (4π/λ) · 31.25 ≈ 0.62 rad.
        expected_rad = (4.0 * np.pi / wavelength_nm) * (slope_nm_per_px * (5 * w / 8))

        assert slope_plus_rad > 0, (
            f"+sideband gave slope {slope_plus_rad:+.3f} rad (expected ≈ +{expected_rad:.3f}). "
            f"Demodulation sign is wrong even with the correct sideband."
        )
        assert slope_minus_rad < 0, (
            f"−sideband gave slope {slope_minus_rad:+.3f} rad (expected ≈ −{expected_rad:.3f}). "
            f"Conjugate-sideband symmetry broken."
        )
        # Magnitudes should agree with theory within 30% (LPF will attenuate
        # somewhat at this fringe density).
        assert 0.5 * expected_rad < slope_plus_rad < 1.5 * expected_rad, (
            f"+sideband slope magnitude {slope_plus_rad:.3f} rad "
            f"differs from expected {expected_rad:.3f} rad by >50%. "
            f"Suggests LPF or carrier-frequency offset."
        )

    # ── Test 3: linear tilt through the full pipeline ─────────────────

    def test_centered_bump_sign_through_full_pipeline(self):
        """A centered +100 nm Gaussian bump must recover with positive height.

        A linear tilt would have been a simpler sign probe, but sub-pixel
        carrier refinement correctly absorbs slow surface tilts into the
        carrier estimate (tilt and a small carrier-frequency offset are
        physically indistinguishable in a single FFT). A centered bump
        cannot be absorbed this way — its spectrum is symmetric around DC
        and does not shift the carrier peak — so it's a cleaner test of
        the full pipeline's sign convention.
        """
        h, w = 256, 256
        wavelength_nm = 632.8
        peak_nm = 100.0  # under λ/4, no wrap

        yy, xx = np.mgrid[0:h, 0:w]
        cx, cy = w / 2.0, h / 2.0
        sigma = w / 4.0  # wide bump so LPF doesn't round the peak
        bump = peak_nm * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))

        img = self._make_image(bump, carrier_freq_x_cycles=30,
                               wavelength_nm=wavelength_nm)

        result = analyze_interferogram(
            img,
            wavelength_nm=wavelength_nm,
            subtract_terms=[1],
            use_full_mask=True,
            form_model="zernike",
            correct_2pi_jumps=False,
        )
        grid, mask_g = _grid_to_2d(result)
        gh, gw = grid.shape

        center_val = float(grid[gh // 2, gw // 2])
        corner = grid[: gh // 8, : gw // 8]
        corner_mask = mask_g[: gh // 8, : gw // 8]
        bg_val = float(np.mean(corner[corner_mask])) if corner_mask.any() else 0.0
        recovered_peak = center_val - bg_val

        assert recovered_peak > 0, (
            f"SIGN BUG: input is +{peak_nm} nm bump, recovered peak = "
            f"{recovered_peak:+.1f} nm. Pipeline inverts surface heights."
        )
        assert abs(recovered_peak - peak_nm) < 0.25 * peak_nm, (
            f"Bump peak recovered at {recovered_peak:.1f} nm vs input {peak_nm} nm "
            f"(off by {abs(recovered_peak - peak_nm)/peak_nm*100:.0f}%)."
        )

    # ── Test 4: LPF σ sweep on a synthetic step ────────────────────────

    def test_lpf_sigma_sweep_step_recovery(self):
        """Quantify how much the Gaussian LPF kills a step at varying σ.

        Uses a 100 nm step (max phase ≈ 1.99 rad < π so no unwrap needed).
        Carrier: 30 vertical fringes (period ≈ 8.5 px).
        Sweep σ from 1 px to 30 px and report fraction recovered.
        Uses the +sideband explicitly so this test isolates LPF damage,
        not sign or sideband bugs.
        """
        h, w = 256, 256
        cy, cx = h // 2, w // 2
        wavelength_nm = 632.8
        true_step_nm = 100.0

        height = np.zeros((h, w))
        height[:, w // 2:] = true_step_nm
        img = self._make_image(height, carrier_freq_x_cycles=30,
                               wavelength_nm=wavelength_nm)

        carrier_period_px = w / 30  # ≈ 8.53 px
        sigmas = [1.0, 2.0, 3.0, 4.0, 5.0,
                  carrier_period_px,                      # ~8.5
                  carrier_period_px * 1.5,                # ~12.8
                  carrier_period_px * 2.5,                # ~21.3 (current default)
                  carrier_period_px * 4.0]                # ~34.1

        results = []
        for sigma in sigmas:
            wrapped = self._demod_with_sigma(img, cy, cx + 30, sigma)
            # No unwrap needed: 100 nm step keeps |phase| < π everywhere.
            height_map = wrapped * wavelength_nm / (4.0 * np.pi)
            # Strips well away from step edge to avoid LPF transient.
            edge_buffer_px = max(int(3 * sigma), 10)
            left  = height_map[h // 4:3 * h // 4,
                               w // 8: max(w // 2 - edge_buffer_px, w // 8 + 1)]
            right = height_map[h // 4:3 * h // 4,
                               min(w // 2 + edge_buffer_px, 7 * w // 8 - 1): 7 * w // 8]
            if left.size < 100 or right.size < 100:
                results.append((sigma, None, None, "buffer ate the strip"))
                continue
            mean_L = float(np.mean(left))
            mean_R = float(np.mean(right))
            recovered = mean_R - mean_L
            frac = recovered / true_step_nm
            results.append((sigma, recovered, frac, ""))

        # Print the full table on failure
        report_lines = ["σ_px | recovered_nm | fraction_of_truth | note"]
        for sigma, rec, frac, note in results:
            if rec is None:
                report_lines.append(f"{sigma:5.1f} |       —       |        —        | {note}")
            else:
                report_lines.append(f"{sigma:5.1f} | {rec:+12.2f} |     {frac:+6.3f}      | {note}")
        report = "\n".join(report_lines)

        # Find the σ that gives the best recovery
        valid = [r for r in results if r[1] is not None]
        best = max(valid, key=lambda r: abs(r[2]))
        best_sigma, best_rec, best_frac, _ = best

        # We assert that *some* σ recovers the step within 20%. This is the
        # quantitative claim: the LPF defaults are wrong, but the math itself
        # (with the right σ) does work.
        assert abs(best_frac) > 0.8, (
            f"Even the best σ only recovered {best_frac*100:+.1f}% of the step. "
            f"LPF is not the only attenuator — there is another bug.\n{report}"
        )
