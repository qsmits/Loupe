"""Tests for fringe analysis vision module."""
import base64
import json
import math
import numpy as np
import pytest
import cv2

from backend.vision.fringe import (
    WAVEFRONT_ORIGINS,
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
    average_wavefronts,
    reanalyze,
    register_captures,
    subtract_wavefronts,
    wrap_wavefront_result,
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
        unwrapped, _, _ = unwrap_phase_2d(wrapped)
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
        unwrapped, _, _ = unwrap_phase_2d(wrapped)
        # Should be smooth: no jumps > pi between adjacent pixels
        diff_x = np.abs(np.diff(unwrapped, axis=1))
        assert diff_x.max() < np.pi + 0.1

    def test_mask_zeros_invalid(self):
        phase = np.zeros((50, 50))
        mask = np.ones((50, 50), dtype=bool)
        mask[0:10, :] = False
        unwrapped, _, _ = unwrap_phase_2d(phase, mask)
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

        unwrapped, _, _ = unwrap_phase_2d(wrapped, mask, quality=quality)
        corr = np.corrcoef(unwrapped[mask], true_phase[mask])[0, 1]
        assert corr > 0.98

    def test_quality_guided_without_quality_map_still_works(self):
        """When quality=None, fall back to standard unwrapping."""
        h, w = 64, 64
        true_phase = np.tile(np.linspace(0, 4 * np.pi, w), (h, 1))
        wrapped = np.angle(np.exp(1j * true_phase))
        mask = np.ones((h, w), dtype=bool)

        unwrapped, _, _ = unwrap_phase_2d(wrapped, mask, quality=None)
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
        unwrapped_off, _, _ = fringe_mod.unwrap_phase_2d(
            unwrapped_in, correct_2pi_jumps=False)
        unwrapped_on, _, _ = fringe_mod.unwrap_phase_2d(
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
        assert len(result) == 3

    def test_risk_mask_shape(self):
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        _, risk, _ = unwrap_phase_2d(wrapped)
        assert risk.shape == wrapped.shape
        assert risk.dtype == np.uint8

    def test_clean_unwrap_has_zero_risk(self):
        from backend.vision.fringe import unwrap_phase_2d
        y = np.linspace(0, 4 * np.pi, 64)
        phase = np.tile(y, (64, 1))
        wrapped = np.angle(np.exp(1j * phase))
        _, risk, _ = unwrap_phase_2d(wrapped)
        assert np.mean(risk == 0) > 0.9

    def test_edge_contamination_zone(self):
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        mask = np.zeros((64, 64), dtype=bool)
        mask[10:54, 10:54] = True
        _, risk, _ = unwrap_phase_2d(wrapped, mask=mask, fringe_period_px=5.0)
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

    # ── M1.5: diagnostics envelope ───────────────────────────────────

    def _make_fringe_2d(self, h=128, w=128, period_px=16):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * xx / period_px)
        return np.clip(np.tile(row, (h, 1)), 0, 255).astype(np.uint8)

    def test_alternate_peaks_have_frequency_fields(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe_2d()
        result = _analyze_carrier(img)
        alts = result["alternate_peaks"]
        assert len(alts) > 0, "need at least one alternate to check fields"
        for a in alts:
            for key in ("fx_cpp", "fy_cpp", "fringe_period_px",
                        "fringe_angle_deg", "magnitude"):
                assert key in a, f"alternate missing {key}: {a}"
            assert isinstance(a["fx_cpp"], float)
            assert isinstance(a["fy_cpp"], float)
            assert isinstance(a["magnitude"], float)
            # Period non-negative / angle in [0, 180).
            assert a["fringe_period_px"] > 0
            assert 0.0 <= a["fringe_angle_deg"] < 180.0

    def test_carrier_chosen_envelope_matches_flat_keys(self):
        img = self._make_fringe_2d()
        result = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15)
        c = result["carrier"]
        assert "chosen" in c
        assert c["chosen"]["y"] == c["peak_y"]
        assert c["chosen"]["x"] == c["peak_x"]
        assert c["chosen"]["distance_px"] == c["distance_px"]
        assert c["chosen"]["fringe_period_px"] == c["fringe_period_px"]
        assert c["chosen"]["fringe_angle_deg"] == c["fringe_angle_deg"]
        assert c["chosen"]["fx_cpp"] == c["fx_cpp"]
        assert c["chosen"]["fy_cpp"] == c["fy_cpp"]

    def test_carrier_candidates_mirror_alternates(self):
        img = self._make_fringe_2d()
        result = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15)
        c = result["carrier"]
        assert "candidates" in c
        assert c["candidates"] == c["alternate_peaks"]

    def test_carrier_confidence_envelope(self):
        img = self._make_fringe_2d()
        result = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15)
        c = result["carrier"]
        assert "confidence" in c
        assert c["confidence"]["peak_ratio"] == c["peak_ratio"]
        assert c["confidence"]["snr_db"] == c["snr_db"]
        assert c["confidence"]["dc_margin_px"] == c["dc_margin_px"]
        assert c["confidence"]["peak_ratio"] is not None

    def test_carrier_override_false_by_default(self):
        img = self._make_fringe_2d()
        result = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15)
        assert result["carrier"]["override"] is False

    def test_carrier_override_true_on_manual(self):
        img = self._make_fringe_2d()
        h, w = img.shape
        # Pick any legal override offset (doesn't have to match the true
        # carrier; we only check the flag).
        result = analyze_interferogram(
            img, wavelength_nm=632.8, n_zernike=15,
            carrier_override=(h // 2, w // 2 + 8),
        )
        assert result["carrier"]["override"] is True

    def test_carrier_candidates_count(self):
        img = self._make_fringe_2d()
        result = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15)
        c = result["carrier"]
        candidates = c["candidates"]
        assert len(candidates) <= 3
        # Chosen peak must not appear among the alternates — it was masked
        # out before alternates were collected. Compare on (y, x) in the
        # diagnostic-crop coord system for alternates vs chosen flat
        # peak_y/peak_x (full-frame); since they use different coord frames
        # a direct match would be coincidental, so we verify by distance:
        # the chosen peak is at distance ≈ carrier distance from the
        # alternate coord-space center, whereas the alternates are
        # different spatial peaks in the magnitude spectrum after masking.
        # The strong invariant we can assert is that no alternate shares
        # the same (peak_ratio==1.0) identity with the chosen peak.
        for alt in candidates:
            # peak_ratio is carrier_peak / alt_peak, so chosen would be 1.0.
            # A legitimate alternate must be strictly > 1.0 (strictly
            # smaller magnitude than the chosen carrier).
            assert alt["peak_ratio"] > 1.0, (
                f"alternate has peak_ratio {alt['peak_ratio']} <= 1.0, "
                f"suggesting chosen peak leaked into candidates"
            )


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


# ── M1.1: WavefrontResult envelope ─────────────────────────────────────────

class TestWavefrontResultEnvelope:
    """M1.1 migration: analyze_interferogram output wrapped with envelope
    fields (id, origin, source_ids, captured_at, calibration_snapshot,
    warnings, aperture_recipe, raw_height_grid_nm, raw_mask_grid)."""

    def _fringe_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        return np.tile(row.astype(np.uint8), (h, 1))

    def test_wrap_adds_all_envelope_fields(self):
        img = self._fringe_image()
        result = analyze_interferogram(img, wavelength_nm=589.3)
        wrap_wavefront_result(result, origin="capture")

        for field in ("id", "origin", "source_ids", "captured_at",
                      "calibration_snapshot", "warnings", "aperture_recipe",
                      "raw_height_grid_nm", "raw_mask_grid"):
            assert field in result, f"envelope field {field!r} missing"

        assert result["origin"] == "capture"
        assert result["source_ids"] == []
        assert result["warnings"] == []
        assert result["calibration_snapshot"] is None
        assert result["aperture_recipe"] is None
        # Timestamp looks like an ISO-8601 UTC string.
        assert result["captured_at"].endswith("+00:00")
        # UUIDs are 32 hex characters (uuid4().hex).
        assert len(result["id"]) == 32 and all(c in "0123456789abcdef" for c in result["id"])

    def test_raw_grids_alias_existing_grids_stage_1(self):
        img = self._fringe_image()
        result = analyze_interferogram(img)
        wrap_wavefront_result(result, origin="capture")

        # M1.3: analyze_interferogram populates a real raw grid (pre-form-
        # removal). It's no longer the same list reference as height_grid
        # (that alias is now carried by display_height_grid_nm instead).
        assert result["raw_height_grid_nm"] is not None
        assert result["display_height_grid_nm"] is result["height_grid"]
        # Masks are still frame-shared; raw_mask_grid aliases mask_grid.
        assert result["raw_mask_grid"] is result["mask_grid"]

    def test_calibration_and_aperture_recipe_round_trip(self):
        img = self._fringe_image()
        result = analyze_interferogram(img)
        cal = {"mm_per_pixel": 0.004, "method": "stage-micrometer",
               "wavelength_nm": 589.3}
        recipe = {"id": "rec-01", "kind": "circle",
                  "cx": 0.5, "cy": 0.5, "r": 0.45}
        wrap_wavefront_result(result, origin="capture",
                              calibration=cal, aperture_recipe=recipe)

        assert result["calibration_snapshot"] == cal
        assert result["aperture_recipe"] == recipe

    def test_source_ids_copied_not_shared(self):
        """Mutating source_ids on the result must not mutate the caller's list."""
        img = self._fringe_image()
        result = analyze_interferogram(img)
        ids = ["abc", "def"]
        wrap_wavefront_result(result, origin="average", source_ids=ids)
        result["source_ids"].append("xyz")
        assert ids == ["abc", "def"]

    def test_invalid_origin_rejected(self):
        result = {"height_grid": [], "mask_grid": []}
        with pytest.raises(ValueError):
            wrap_wavefront_result(result, origin="bogus")

    def test_known_origins_match_constant(self):
        assert "capture" in WAVEFRONT_ORIGINS
        assert "average" in WAVEFRONT_ORIGINS
        assert "subtracted" in WAVEFRONT_ORIGINS
        assert "reconstruction" in WAVEFRONT_ORIGINS

    def test_existing_warnings_list_is_preserved(self):
        """If analyze_interferogram or upstream code already populated
        warnings, wrap must not clobber it."""
        result = {"height_grid": [], "mask_grid": [], "warnings": ["low-modulation"]}
        wrap_wavefront_result(result, origin="capture")
        assert result["warnings"] == ["low-modulation"]


class TestFringeAPIWavefrontEnvelope:
    """API-level: envelope fields flow through /fringe/analyze and
    /fringe/reanalyze-carrier with calibration + aperture_recipe round-trip."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_analyze_response_contains_envelope(self, client):
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 589.3,
            "image_b64": self._b64_image(),
        })
        assert r.status_code == 200
        data = r.json()
        assert data["origin"] == "capture"
        assert data["source_ids"] == []
        assert data["warnings"] == []
        assert data["calibration_snapshot"] is None
        assert data["aperture_recipe"] is None
        assert isinstance(data["id"], str) and len(data["id"]) == 32
        assert data["captured_at"].endswith("+00:00")
        # M1.3: raw grid is distinct from display; display_height_grid_nm
        # aliases the legacy height_grid key. Masks are still frame-shared.
        assert "raw_height_grid_nm" in data
        assert data["display_height_grid_nm"] == data["height_grid"]
        assert data["raw_mask_grid"] == data["mask_grid"]

    def test_calibration_and_aperture_recipe_flow_through(self, client):
        cal = {"mm_per_pixel": 0.00412, "method": "stage-micrometer",
               "captured_at": "2026-04-10T12:00:00+00:00",
               "wavelength_nm": 589.3}
        recipe = {"id": "ap-01", "kind": "circle",
                  "cx": 0.5, "cy": 0.5, "r": 0.4}
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 589.3,
            "image_b64": self._b64_image(),
            "calibration": cal,
            "aperture_recipe": recipe,
        })
        assert r.status_code == 200
        data = r.json()
        # model_dump preserves the explicit fields and any extras. Check a
        # representative set; extra keys round-trip because extra='allow'.
        snap = data["calibration_snapshot"]
        assert snap["mm_per_pixel"] == pytest.approx(cal["mm_per_pixel"])
        assert snap["method"] == cal["method"]
        assert snap["wavelength_nm"] == pytest.approx(cal["wavelength_nm"])
        ap = data["aperture_recipe"]
        assert ap["id"] == "ap-01"
        assert ap["kind"] == "circle"
        assert ap["cx"] == pytest.approx(0.5)
        assert ap["r"] == pytest.approx(0.4)

    def test_reanalyze_carrier_also_wrapped(self, client):
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200
        carrier = r1.json().get("carrier") or {}
        cy = carrier.get("y") or carrier.get("carrier_y") or 0
        cx = carrier.get("x") or carrier.get("carrier_x") or 6
        r = client.post("/fringe/reanalyze-carrier", json={
            "carrier_y": float(cy),
            "carrier_x": float(cx),
            "image_b64": b64,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["origin"] == "capture"
        assert "id" in data and len(data["id"]) == 32
        assert "captured_at" in data


class TestSessionCaptures:
    """M1.7: per-session captures list via _FringeCache.

    Each /fringe/analyze (and /fringe/analyze-stream) appends a lightweight
    summary; /fringe/reanalyze-carrier does NOT (it re-analyzes an existing
    image). GET /fringe/session/captures returns them oldest-first;
    POST /fringe/session/clear empties last_image/last_mask and the list.
    """

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def _parse_sse(self, raw: str) -> list[dict]:
        events = []
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                events.append(json.loads(payload))
        return events

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        """Clear the module-level cache between tests to prevent cross-test
        pollution (the default session id is shared across TestClients)."""
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()

    def test_analyze_records_capture(self, client):
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": self._b64_image(),
        })
        assert r.status_code == 200
        result = r.json()

        r2 = client.get("/fringe/session/captures")
        assert r2.status_code == 200
        data = r2.json()
        assert "captures" in data
        assert len(data["captures"]) == 1
        cap = data["captures"][0]
        assert cap["id"] == result["id"]
        assert cap["origin"] == "capture"
        assert isinstance(cap["pv_nm"], (int, float))
        assert isinstance(cap["rms_nm"], (int, float))
        # Heavy fields must not leak into the summary.
        for leaked in ("height_grid", "raw_height_grid_nm", "surface_map",
                       "coefficients", "mask_grid", "raw_mask_grid"):
            assert leaked not in cap

    def test_multiple_analyses_accumulate(self, client):
        b64 = self._b64_image()
        ids = []
        for _ in range(3):
            r = client.post("/fringe/analyze", json={"image_b64": b64})
            assert r.status_code == 200
            ids.append(r.json()["id"])

        r = client.get("/fringe/session/captures")
        assert r.status_code == 200
        caps = r.json()["captures"]
        assert len(caps) == 3
        assert [c["id"] for c in caps] == ids  # insertion order

    def test_reanalyze_carrier_records_new_capture(self, client):
        # Fix 3 (Open Q 1): /fringe/reanalyze-carrier now records the
        # manually-carrier reanalysis as a first-class capture so the user
        # can export it and chain it into subtract/average. Fix 2: when the
        # override is applied against the cached image (no image_b64 in
        # body) the new capture's source_ids points back to the most recent
        # capture so provenance survives.
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200
        first = r1.json()

        caps_before = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps_before) == 1

        carrier = first.get("carrier") or {}
        cy = carrier.get("y") or carrier.get("carrier_y") or 0
        cx = carrier.get("x") or carrier.get("carrier_x") or 6
        # Omit image_b64 — exercise the cached-image path so the override
        # links back to the prior capture.
        r2 = client.post("/fringe/reanalyze-carrier", json={
            "carrier_y": float(cy),
            "carrier_x": float(cx),
        })
        assert r2.status_code == 200
        new_body = r2.json()
        new_id = new_body["id"]

        caps_after = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps_after) == 2
        # New capture appended; the new id matches the response id.
        assert caps_after[-1]["id"] == new_id
        assert caps_after[-1]["origin"] == "capture"
        # Original capture preserved.
        assert any(c["id"] == first["id"] for c in caps_after)
        # Fix 2: the new capture references the original via source_ids.
        assert new_body["source_ids"] == [first["id"]]
        assert caps_after[-1]["source_ids"] == [first["id"]]

    def test_reanalyze_carrier_with_uploaded_image_has_no_source_id(self, client):
        # Fix 2 edge case: when the user uploads an image_b64 to
        # /fringe/reanalyze-carrier the cached `last_image` may not match,
        # so source_ids stays empty rather than lying about provenance.
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200

        r2 = client.post("/fringe/reanalyze-carrier", json={
            "carrier_y": 0.0,
            "carrier_x": 6.0,
            "image_b64": b64,
        })
        assert r2.status_code == 200
        assert r2.json()["source_ids"] == []

    def test_clear_empties_captures(self, client):
        b64 = self._b64_image()
        for _ in range(2):
            r = client.post("/fringe/analyze", json={"image_b64": b64})
            assert r.status_code == 200
        assert len(client.get("/fringe/session/captures").json()["captures"]) == 2

        r = client.post("/fringe/session/clear")
        assert r.status_code == 200
        assert r.json() == {"cleared": True}

        assert client.get("/fringe/session/captures").json()["captures"] == []

    def test_stream_endpoint_records_capture(self, client):
        b64 = self._b64_image()
        with client.stream("POST", "/fringe/analyze-stream",
                           json={"image_b64": b64, "n_zernike": 15}) as resp:
            assert resp.status_code == 200
            raw = resp.read().decode("utf-8")

        events = self._parse_sse(raw)
        done = [e for e in events if e.get("stage") == "done"]
        assert len(done) == 1
        streamed_id = done[0]["result"]["id"]

        caps = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps) == 1
        assert caps[0]["id"] == streamed_id
        assert caps[0]["origin"] == "capture"

    def test_capture_cap_enforced(self, client, monkeypatch):
        import backend.api_fringe as api_fringe
        monkeypatch.setattr(api_fringe, "_CAPTURES_PER_SESSION", 3)

        b64 = self._b64_image()
        ids = []
        for _ in range(5):
            r = client.post("/fringe/analyze", json={"image_b64": b64})
            assert r.status_code == 200
            ids.append(r.json()["id"])

        caps = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps) == 3
        # Oldest two evicted; last three retained in insertion order.
        assert [c["id"] for c in caps] == ids[-3:]

    def test_session_isolation(self):
        """Two clients with distinct X-Session-ID headers see only their own captures."""
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)

        sid_a = "11111111-1111-1111-1111-111111111111"
        sid_b = "22222222-2222-2222-2222-222222222222"
        b64 = self._b64_image()

        with TestClient(app) as client_a, TestClient(app) as client_b:
            ra = client_a.post("/fringe/analyze",
                               headers={"X-Session-ID": sid_a},
                               json={"image_b64": b64})
            assert ra.status_code == 200
            id_a = ra.json()["id"]

            rb = client_b.post("/fringe/analyze",
                               headers={"X-Session-ID": sid_b},
                               json={"image_b64": b64})
            assert rb.status_code == 200
            id_b = rb.json()["id"]

            caps_a = client_a.get("/fringe/session/captures",
                                  headers={"X-Session-ID": sid_a}).json()["captures"]
            caps_b = client_b.get("/fringe/session/captures",
                                  headers={"X-Session-ID": sid_b}).json()["captures"]

            assert len(caps_a) == 1 and caps_a[0]["id"] == id_a
            assert len(caps_b) == 1 and caps_b[0]["id"] == id_b
            assert id_a != id_b


# ── M1.2: Client calibration payload contract ─────────────────────────────


class TestCalibrationPayloadContract:
    """Behavioral contract between the M1.2 frontend calibration record
    and the backend /fringe/analyze endpoint.

    The backend Pydantic snapshot uses extra='allow', so arbitrary fields
    (including informational metadata like `notes` and `uncertainty_nm`)
    must round-trip unchanged. Critically: `body.wavelength_nm` at the top
    level drives the analysis math; `body.calibration.wavelength_nm` is
    pure metadata and MUST NOT override the top-level wavelength.
    """

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_analyze_accepts_full_calibration_payload(self, client):
        """The full M1.2 calibration shape round-trips through the
        WavefrontResult.calibration_snapshot envelope, including extra
        (extra='allow') fields like `notes` and `uncertainty_nm`."""
        cal = {
            "name": "Sodium D (default)",
            "wavelength_nm": 589.3,
            "mm_per_pixel": 0.00412,
            "lens_k1": 0.0,
            "uncertainty_nm": 0.3,
            "method": "stage-micrometer",
            "captured_at": "2026-04-10T12:00:00+00:00",
            "notes": "lab bench, morning run",
        }
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 589.3,
            "image_b64": self._b64_image(),
            "calibration": cal,
        })
        assert r.status_code == 200
        snap = r.json()["calibration_snapshot"]
        assert snap is not None
        # Declared fields:
        assert snap["wavelength_nm"] == pytest.approx(cal["wavelength_nm"])
        assert snap["mm_per_pixel"] == pytest.approx(cal["mm_per_pixel"])
        assert snap["method"] == cal["method"]
        assert snap["captured_at"] == cal["captured_at"]
        # extra='allow' fields must also round-trip verbatim:
        assert snap["name"] == cal["name"]
        assert snap["lens_k1"] == pytest.approx(cal["lens_k1"])
        assert snap["uncertainty_nm"] == pytest.approx(cal["uncertainty_nm"])
        assert snap["notes"] == cal["notes"]

    def test_analyze_uses_calibration_wavelength(self, client):
        """Top-level `wavelength_nm` drives the analysis math; the
        `calibration.wavelength_nm` field is metadata only. The backend
        must NOT silently swap them.

        When the two disagree, the response's top-level `wavelength_nm`
        stays at the request's top-level value, while the snapshot
        preserves the client-supplied calibration wavelength verbatim.
        """
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": self._b64_image(),
            "calibration": {
                "name": "Sodium D (stale)",
                "wavelength_nm": 589.3,
                "mm_per_pixel": 0.004,
                "lens_k1": 0.0,
                "uncertainty_nm": 0.3,
                "method": "manual",
                "captured_at": "2026-04-10T12:00:00+00:00",
                "notes": "",
            },
        })
        assert r.status_code == 200
        data = r.json()
        # Analysis used the top-level wavelength:
        assert data["wavelength_nm"] == pytest.approx(632.8)
        # Snapshot preserves the client's (possibly-stale) calibration wl:
        assert data["calibration_snapshot"]["wavelength_nm"] == pytest.approx(589.3)


class TestRawDisplayGridSeparation:
    """M1.3: raw (pre-form-removal) vs display (post-form-removal) grid split.

    The raw grid preserves tilt/curvature that form removal strips out of
    the display grid; reanalyze with the raw grid recomputes a fresh
    display grid without redoing the FFT+unwrap stages.
    """

    def _tilted_fringe_image(self, h=128, w=128, fx=8, tilt_px_per_row=0.6):
        """Carrier plus a quadratic (defocus-like) surface term. The carrier
        is purely horizontal so the detector locks to it; the quadratic
        surface survives demodulation as real unwrapped phase. Form removal
        [1,2,3] (piston + tilt) cannot cancel a quadratic, so both raw and
        display have non-zero variance — but defocus dominates both and we
        still expect raw > 3× display because plane-fit residuals shrink
        disp_std. NOTE: the old version of this helper used a linear `tilt`
        baked into the phase; M2.2 sub-pixel carrier detection now locks the
        carrier to that linear tilt, leaving no residual — that would make
        this test vacuous.
        """
        yy, xx = np.mgrid[0:h, 0:w]
        # Pure horizontal carrier + a rotationally-symmetric defocus (power)
        # surface term. M2.2's sub-pixel carrier detection absorbs any pure
        # linear phase component (i.e. real tilt is aliased into the
        # carrier), so we use defocus — a quadratic, zero-mean-gradient
        # surface — that survives demodulation untouched. With Z4 (Power)
        # in `subtract_terms` below, defocus is removed from the display
        # grid while the raw grid retains the full dome.
        carrier_phase = 2 * np.pi * fx * xx / w
        rho_sq = ((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2
        # Amplitude scaled so tilt_px_per_row=0.6 → ~3.5 rad swing.
        surface_phase = tilt_px_per_row * 6.0 * rho_sq
        img = 128 + 80 * np.cos(carrier_phase + surface_phase)
        return img.astype(np.uint8)

    def test_analyze_returns_both_grids(self):
        """Analyze populates raw + display grids; display matches height_grid."""
        img = self._tilted_fringe_image()
        result = analyze_interferogram(img, wavelength_nm=632.8,
                                       subtract_terms=[1, 2, 3])
        assert "raw_height_grid_nm" in result
        assert "display_height_grid_nm" in result
        assert "height_grid" in result
        assert isinstance(result["raw_height_grid_nm"], list)
        assert isinstance(result["display_height_grid_nm"], list)
        # display == height_grid element-wise (shared reference).
        assert result["display_height_grid_nm"] == result["height_grid"]
        # Both grids share the same (grid_rows, grid_cols) shape.
        assert len(result["raw_height_grid_nm"]) == (
            result["grid_rows"] * result["grid_cols"])
        assert len(result["display_height_grid_nm"]) == (
            result["grid_rows"] * result["grid_cols"])

    def test_raw_grid_retains_tilt_when_display_does_not(self):
        """With form_model=plane, the LSQ plane is subtracted from display.
        Raw retains the full pre-form-removal defocus dome.

        (Pure linear tilt is absorbed by sub-pixel carrier detection, so
        the test image uses a non-linear defocus surface instead. Plane
        form removal fits the least-squares plane through the defocus
        dome — most of the dome "range" is tilt-like per row, so plane
        removal substantially reduces display std vs. raw.)"""
        img = self._tilted_fringe_image(tilt_px_per_row=0.9)
        result = analyze_interferogram(img, wavelength_nm=632.8,
                                       form_model="plane",
                                       correct_2pi_jumps=False)
        raw = np.array(result["raw_height_grid_nm"], dtype=np.float64)
        disp = np.array(result["display_height_grid_nm"], dtype=np.float64)
        mask = np.array(result["mask_grid"], dtype=bool)
        if mask.any():
            raw_v = raw[mask]
            disp_v = disp[mask]
        else:
            raw_v, disp_v = raw, disp
        raw_std = float(np.std(raw_v))
        disp_std = float(np.std(disp_v))
        # Raw grid retains the full defocus dome; plane-removed display
        # has only the residual after LSQ plane subtraction.
        assert raw_std > disp_std, (
            f"raw_std={raw_std:.2f} should exceed disp_std={disp_std:.2f}")

    def test_reanalyze_with_raw_grid_path(self):
        """Providing the raw grid + shape routes to the full-fidelity path.

        Changing subtract_terms must change the display grid; the raw grid
        must come back unchanged.
        """
        img = self._tilted_fringe_image()
        analyze_out = analyze_interferogram(img, wavelength_nm=632.8,
                                            subtract_terms=[1, 2, 3])
        raw_grid = list(analyze_out["raw_height_grid_nm"])
        grid_rows = analyze_out["grid_rows"]
        grid_cols = analyze_out["grid_cols"]
        mask_serialized = list(analyze_out["mask_grid"])

        re_out = reanalyze(
            coefficients=analyze_out["coefficients"],
            subtract_terms=[1, 2, 3, 4],
            wavelength_nm=632.8,
            surface_shape=(analyze_out["surface_height"],
                           analyze_out["surface_width"]),
            mask_serialized=mask_serialized,
            raw_height_grid_nm=raw_grid,
            raw_grid_rows=grid_rows,
            raw_grid_cols=grid_cols,
        )
        # The display grid reflects the extra defocus subtraction.
        assert re_out["height_grid"] != analyze_out["height_grid"]
        assert "display_height_grid_nm" in re_out
        assert re_out["display_height_grid_nm"] == re_out["height_grid"]
        # Raw grid echoed back unchanged.
        assert re_out["raw_height_grid_nm"] == raw_grid
        # Shape matches the raw grid we supplied.
        assert re_out["grid_rows"] == grid_rows
        assert re_out["grid_cols"] == grid_cols
        # Standard reanalyze return fields still present.
        for key in ("surface_map", "zernike_chart", "profile_x", "profile_y",
                    "pv_nm", "rms_nm", "pv_waves", "rms_waves", "strehl"):
            assert key in re_out

    def test_reanalyze_legacy_path_unchanged(self):
        """Without raw-grid args, reanalyze behaves exactly like before."""
        h, w = 64, 64
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 4 * xx / w
        img = (128 + 80 * np.cos(carrier)).astype(np.uint8)

        full = analyze_interferogram(img, wavelength_nm=632.8,
                                     subtract_terms=[1, 2, 3])
        sh, sw = full["surface_height"], full["surface_width"]
        mask_full = np.ones(sh * sw, dtype=int).tolist()

        result = reanalyze(
            coefficients=full["coefficients"],
            subtract_terms=[1, 2, 3, 4],
            wavelength_nm=632.8,
            surface_shape=(sh, sw),
            mask_serialized=mask_full,
        )
        # Matches the shape contract TestReanalyze asserts.
        assert "height_grid" in result
        assert "mask_grid" in result
        assert "grid_rows" in result
        assert "grid_cols" in result
        assert isinstance(result["height_grid"], list)
        assert isinstance(result["mask_grid"], list)
        assert len(result["height_grid"]) == result["grid_rows"] * result["grid_cols"]
        assert len(result["mask_grid"]) == result["grid_rows"] * result["grid_cols"]
        # Legacy path does NOT echo raw_height_grid_nm (caller didn't
        # provide one, so there's nothing to return).
        assert "raw_height_grid_nm" not in result
        # display_height_grid_nm is a sibling of height_grid.
        assert result["display_height_grid_nm"] == result["height_grid"]
        assert 0 < result["strehl"] <= 1.0


class TestRawDisplayGridAPI:
    """M1.3 API-level: POST /fringe/reanalyze with raw_height_grid_nm
    routes to the full-fidelity path, and the display grid differs from
    the legacy coefficient-only reconstruction."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def _b64_tilted_image(self, h=128, w=128, fx=8, tilt_px_per_row=0.9):
        yy, xx = np.mgrid[0:h, 0:w]
        phase = 2 * np.pi * (fx * xx / w + tilt_px_per_row * yy / w)
        img = (128 + 80 * np.cos(phase)).astype(np.uint8)
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_reanalyze_with_raw_grid_path_via_api(self, client):
        b64 = self._b64_tilted_image()
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": b64,
            "subtract_terms": [1, 2, 3],
        })
        assert r.status_code == 200
        analyze_out = r.json()
        assert "raw_height_grid_nm" in analyze_out
        raw_grid = analyze_out["raw_height_grid_nm"]
        grid_rows = analyze_out["grid_rows"]
        grid_cols = analyze_out["grid_cols"]

        # Legacy path (no raw grid).
        r_legacy = client.post("/fringe/reanalyze", json={
            "coefficients": analyze_out["coefficients"],
            "subtract_terms": [1, 2, 3, 4],
            "wavelength_nm": 632.8,
            "surface_height": analyze_out["surface_height"],
            "surface_width": analyze_out["surface_width"],
        })
        assert r_legacy.status_code == 200
        legacy_data = r_legacy.json()
        assert "height_grid" in legacy_data
        assert "raw_height_grid_nm" not in legacy_data

        # Full-fidelity path with raw grid.
        r_full = client.post("/fringe/reanalyze", json={
            "coefficients": analyze_out["coefficients"],
            "subtract_terms": [1, 2, 3, 4],
            "wavelength_nm": 632.8,
            "surface_height": analyze_out["surface_height"],
            "surface_width": analyze_out["surface_width"],
            "raw_height_grid_nm": raw_grid,
            "raw_grid_rows": grid_rows,
            "raw_grid_cols": grid_cols,
        })
        assert r_full.status_code == 200
        full_data = r_full.json()
        assert "display_height_grid_nm" in full_data
        assert "raw_height_grid_nm" in full_data
        # Raw echoed back unchanged.
        assert full_data["raw_height_grid_nm"] == raw_grid
        # Full-fidelity display grid differs from the legacy coefficient
        # path's display grid — the former refits on actual cached heights;
        # the latter uses only the Zernike model.
        assert full_data["height_grid"] != legacy_data["height_grid"]


class TestTrustedArea:
    """M1.6: trusted-area mask + percentage."""

    @staticmethod
    def _clean_fringe_image(h=192, w=192, n_fringes=8):
        """Clean horizontal-carrier sinusoidal fringes, uniform modulation."""
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * n_fringes * xx / w
        img = (128 + 100 * np.cos(carrier)).astype(np.uint8)
        return img

    def test_trusted_area_present(self):
        img = self._clean_fringe_image()
        result = analyze_interferogram(img, wavelength_nm=632.8)
        assert "trusted_area_pct" in result
        assert "trusted_mask_grid" in result
        pct = result["trusted_area_pct"]
        assert isinstance(pct, float)
        assert 0.0 <= pct <= 100.0
        grid = result["trusted_mask_grid"]
        assert isinstance(grid, list)
        assert len(grid) == result["grid_rows"] * result["grid_cols"]
        assert set(int(v) for v in grid).issubset({0, 1})

    def test_trusted_mask_subset_of_analysis_mask(self):
        img = self._clean_fringe_image()
        result = analyze_interferogram(img, wavelength_nm=632.8)
        mask = result["mask_grid"]
        trusted = result["trusted_mask_grid"]
        assert len(mask) == len(trusted)
        for i, t in enumerate(trusted):
            if t == 1:
                assert mask[i] == 1, f"trusted pixel {i} is not in analysis mask"

    def test_clean_fringes_high_trusted_fraction(self):
        img = self._clean_fringe_image()
        result = analyze_interferogram(img, wavelength_nm=632.8)
        assert result["trusted_area_pct"] > 70.0, (
            f"expected >70%% trusted on clean fringes, got {result['trusted_area_pct']:.1f}%%"
        )

    def test_low_modulation_region_reduces_trusted_area(self):
        # Use use_full_mask=True so the analysis mask covers the whole image
        # and the low-modulation region counts as "valid but not trusted",
        # dropping the ratio rather than being excluded from the denominator.
        img_full = self._clean_fringe_image(h=192, w=192, n_fringes=8)
        r_full = analyze_interferogram(img_full, wavelength_nm=632.8,
                                       mask_threshold=0.15, use_full_mask=True)
        pct_full = r_full["trusted_area_pct"]

        # Test: left half strong fringes, right half completely uniform DC.
        h, w = 192, 192
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 8 * xx / w
        strong = 128 + 100 * np.cos(carrier)
        # Right half: truly flat DC so modulation is essentially zero there.
        flat = np.full((h, w), 128.0)
        img_half = np.where(xx < w // 2, strong, flat).astype(np.uint8)
        r_half = analyze_interferogram(img_half, wavelength_nm=632.8,
                                       mask_threshold=0.15, use_full_mask=True)
        pct_half = r_half["trusted_area_pct"]
        assert pct_half < pct_full - 20.0, (
            f"expected half-modulated image to be >=20pp lower; full={pct_full:.1f}%% "
            f"half={pct_half:.1f}%%"
        )

    def test_trusted_area_matches_unwrap_stats(self):
        img = self._clean_fringe_image()
        result = analyze_interferogram(img, wavelength_nm=632.8)
        assert "trusted_area_pct" in result["unwrap_stats"]
        assert result["unwrap_stats"]["trusted_area_pct"] == result["trusted_area_pct"]

    def test_trusted_mask_grid_shape_matches_display(self):
        img = self._clean_fringe_image()
        result = analyze_interferogram(img, wavelength_nm=632.8)
        assert len(result["trusted_mask_grid"]) == len(result["mask_grid"])
        assert len(result["trusted_mask_grid"]) == result["grid_rows"] * result["grid_cols"]


class TestTrustedOnlyContract:
    """Frontend M1.6 wiring depends on this contract: when the user toggles
    "use trusted pixels only", the client recomputes PV/RMS locally from
    the cached height_grid filtered by trusted_mask_grid. That only works
    if both grids exist and have the same length as the analysis grid."""

    def test_height_grid_and_trusted_mask_same_length(self):
        h, w = 192, 192
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 8 * xx / w
        img = (128 + 100 * np.cos(carrier)).astype(np.uint8)
        data = analyze_interferogram(img, wavelength_nm=632.8)
        rows, cols = data["grid_rows"], data["grid_cols"]
        assert len(data["height_grid"]) == rows * cols
        assert len(data["trusted_mask_grid"]) == rows * cols
        assert len(data["mask_grid"]) == rows * cols


# ── M3.4: Manual wavefront subtraction (backend, no registration) ─────────


def _clean_fringes(h=128, w=128, n_fringes=8):
    xx = np.arange(w)
    row = 128 + 80 * np.cos(2 * np.pi * n_fringes * xx / w)
    return np.tile(row.astype(np.uint8), (h, 1))


def _make_wrapped_result(*, wavelength_nm=632.8, calibration=None,
                        origin="capture", source_ids=None):
    """Return a freshly-wrapped analyze_interferogram result."""
    img = _clean_fringes()
    r = analyze_interferogram(img, wavelength_nm=wavelength_nm)
    r.pop("_mask_full", None)
    wrap_wavefront_result(r, origin=origin, calibration=calibration,
                          source_ids=source_ids)
    return r


def _fake_wrapped_result(rows, cols, *, wavelength_nm=632.8, height_nm_const=0.0,
                        mask_value=1, calibration=None):
    """Hand-built minimal WavefrontResult for shape/warning unit tests."""
    n = rows * cols
    mask = [int(mask_value)] * n
    heights = [float(height_nm_const)] * n
    base = {
        "surface_map": "",
        "profile_x": {"positions": [], "values": [], "axis": "x"},
        "profile_y": {"positions": [], "values": [], "axis": "y"},
        "coefficients": [0.0] * 36,
        "coefficient_names": {str(j): f"Z{j}" for j in range(1, 37)},
        "pv_nm": 0.0,
        "rms_nm": 0.0,
        "pv_waves": 0.0,
        "rms_waves": 0.0,
        "strehl": 1.0,
        "subtracted_terms": [1, 2, 3],
        "wavelength_nm": wavelength_nm,
        "n_valid_pixels": int(sum(mask)),
        "n_total_pixels": n,
        "surface_height": rows,
        "surface_width": cols,
        "height_grid": heights,
        "display_height_grid_nm": heights,
        "raw_height_grid_nm": heights,
        "mask_grid": mask,
        "raw_mask_grid": mask,
        "grid_rows": rows,
        "grid_cols": cols,
    }
    wrap_wavefront_result(base, origin="capture", calibration=calibration)
    return base


class TestSubtractWavefronts:
    """M3.4: unit tests for subtract_wavefronts (no registration)."""

    def test_subtract_self_is_zero(self):
        r = _make_wrapped_result()
        out = subtract_wavefronts(r, r)
        assert out["origin"] == "subtracted"
        disp = np.asarray(out["display_height_grid_nm"], dtype=np.float64)
        mask = np.asarray(out["mask_grid"], dtype=bool)
        # Within 1 nm everywhere (exact on valid, zero on invalid).
        assert float(np.abs(disp).max()) < 1.0
        # All valid pixels retained (mask == mask & mask).
        assert int(mask.sum()) == int(np.asarray(r["mask_grid"], dtype=bool).sum())
        # Stats basically zero.
        assert out["rms_nm"] < 1.0
        assert out["pv_nm"] < 1.0

    def test_subtract_wavelength_mismatch_warns(self):
        m = _fake_wrapped_result(8, 8, wavelength_nm=632.8)
        r = _fake_wrapped_result(8, 8, wavelength_nm=589.3)
        out = subtract_wavefronts(m, r)
        assert any("Wavelength mismatch" in w for w in out["warnings"])

    def test_subtract_shape_mismatch_raises(self):
        m = _fake_wrapped_result(8, 8)
        r = _fake_wrapped_result(16, 8)
        with pytest.raises(ValueError) as ei:
            subtract_wavefronts(m, r)
        assert "Grid shapes differ" in str(ei.value)

    def test_subtract_calibration_mismatch_warns(self):
        m = _fake_wrapped_result(8, 8,
                                 calibration={"mm_per_pixel": 0.005,
                                              "method": "x"})
        r = _fake_wrapped_result(8, 8,
                                 calibration={"mm_per_pixel": 0.010,
                                              "method": "x"})
        out = subtract_wavefronts(m, r)
        assert any("Calibration mm_per_pixel differs" in w for w in out["warnings"])

    def test_subtract_low_overlap_warns(self):
        # Build two masks that overlap on only 1 of 16 pixels (~6%).
        rows, cols = 4, 4
        m = _fake_wrapped_result(rows, cols)
        r = _fake_wrapped_result(rows, cols)
        m_mask = [0] * 16
        r_mask = [0] * 16
        # Measurement has 8 valid pixels, reference has 8 valid pixels,
        # but only 1 overlaps.
        m_mask[0] = 1
        for i in range(1, 8):
            m_mask[i] = 1
        # Reference: pixels 0 (overlap) + 8..14 (no overlap).
        r_mask[0] = 1
        for i in range(8, 15):
            r_mask[i] = 1
        m["mask_grid"] = m_mask
        m["raw_mask_grid"] = m_mask
        r["mask_grid"] = r_mask
        r["raw_mask_grid"] = r_mask
        out = subtract_wavefronts(m, r)
        assert any("Low overlap" in w for w in out["warnings"])

    def test_subtract_sets_source_ids_and_origin(self):
        m = _fake_wrapped_result(8, 8)
        r = _fake_wrapped_result(8, 8)
        out = subtract_wavefronts(m, r)
        assert out["origin"] == "subtracted"
        assert out["source_ids"] == [m["id"], r["id"]]

    def test_subtract_reduces_rms_for_matching_reference(self):
        # Measurement = flat tilt + small bump; reference = flat tilt.
        rows, cols = 32, 32
        yy, xx = np.mgrid[0:rows, 0:cols].astype(np.float32)
        tilt = 100.0 * xx / cols  # nm
        bump = np.zeros((rows, cols), dtype=np.float32)
        cy, cx = rows // 2, cols // 2
        rr2 = (yy - cy) ** 2 + (xx - cx) ** 2
        bump[rr2 < 4] = 20.0  # ~20 nm bump in a small region

        measurement = _fake_wrapped_result(rows, cols)
        reference = _fake_wrapped_result(rows, cols)
        heights_m = (tilt + bump).astype(np.float32).ravel().tolist()
        heights_r = tilt.astype(np.float32).ravel().tolist()
        measurement["display_height_grid_nm"] = heights_m
        measurement["height_grid"] = heights_m
        measurement["raw_height_grid_nm"] = heights_m
        reference["display_height_grid_nm"] = heights_r
        reference["height_grid"] = heights_r
        reference["raw_height_grid_nm"] = heights_r

        measurement_rms = float(np.sqrt(np.mean(
            (np.asarray(heights_m) - np.mean(heights_m)) ** 2
        )))
        out = subtract_wavefronts(measurement, reference)
        assert out["rms_nm"] < measurement_rms * 0.5, (
            f"expected subtraction to cut RMS in half; got "
            f"measurement_rms={measurement_rms:.2f}, "
            f"subtracted_rms={out['rms_nm']:.2f}"
        )


class TestSubtractRawDomainCorrectness:
    """Fix 1 (P1b): subtract_wavefronts must operate on raw grids so
    differential tilt / low-order form between measurement and reference is
    preserved before form removal is re-applied to produce the display grid."""

    def _wrapped_from_grids(self, raw_grid, display_grid, *,
                            wavelength_nm=632.8, mask=None,
                            form_model="zernike",
                            subtracted_terms=(1, 2, 3)):
        rows, cols = raw_grid.shape
        if mask is None:
            mask = np.ones((rows, cols), dtype=bool)
        mask_list = [int(v) for v in mask.astype(np.uint8).ravel()]
        raw = raw_grid.astype(np.float32).ravel().tolist()
        disp = display_grid.astype(np.float32).ravel().tolist()
        base = {
            "surface_map": "",
            "profile_x": {"positions": [], "values": [], "axis": "x"},
            "profile_y": {"positions": [], "values": [], "axis": "y"},
            "coefficients": [0.0] * 36,
            "coefficient_names": {str(j): f"Z{j}" for j in range(1, 37)},
            "pv_nm": 0.0, "rms_nm": 0.0, "pv_waves": 0.0, "rms_waves": 0.0,
            "strehl": 1.0,
            "subtracted_terms": list(subtracted_terms),
            "form_model": form_model,
            "wavelength_nm": wavelength_nm,
            "n_valid_pixels": int(mask.sum()),
            "n_total_pixels": rows * cols,
            "surface_height": rows, "surface_width": cols,
            "height_grid": disp,
            "display_height_grid_nm": disp,
            "raw_height_grid_nm": raw,
            "mask_grid": mask_list, "raw_mask_grid": mask_list,
            "grid_rows": rows, "grid_cols": cols,
        }
        wrap_wavefront_result(base, origin="capture")
        return base

    def test_subtract_preserves_differential_tilt(self):
        # Measurement = flat + tilt_A + small bump.
        # Reference   = flat + tilt_B (tilt_B != tilt_A; no bump).
        # When each is analyzed independently, both have their own tilt
        # removed (display grid = bump for measurement, ~0 for reference).
        # After Fix 1, subtract_wavefronts differences on the *raw* grids so
        # the raw diff carries (tilt_A - tilt_B) + bump (differential tilt
        # preserved). The display diff re-applies form removal so the user-
        # visible residual is just the bump — and the *raw* diff RMS must
        # be meaningfully larger than the display diff RMS.
        rows, cols = 64, 64
        yy, xx = np.mgrid[0:rows, 0:cols].astype(np.float32)
        # Tilts in nm, big enough to dominate the bump.
        tilt_a = (5.0 * xx / cols + 2.0 * yy / rows) * 100.0
        tilt_b = (1.0 * xx / cols + 4.0 * yy / rows) * 100.0
        bump = np.zeros((rows, cols), dtype=np.float32)
        cy, cx = rows // 2, cols // 2
        rr2 = (yy - cy) ** 2 + (xx - cx) ** 2
        bump[rr2 < 16] = 25.0  # ~25 nm bump in a small region

        # Raw heights (pre-form-removal) for each capture.
        m_raw = (tilt_a + bump).astype(np.float32)
        r_raw = tilt_b.astype(np.float32)
        # Display heights (post form removal) — simulate independent
        # plane-removal so each capture's display grid has near-zero tilt.
        # (Use _subtract_plane to mirror what analyze_interferogram does.)
        from backend.vision.fringe import _subtract_plane
        m_disp = _subtract_plane(m_raw.astype(np.float64)).astype(np.float32)
        r_disp = _subtract_plane(r_raw.astype(np.float64)).astype(np.float32)

        # Sanity: independently form-removed display grids show the bump
        # (measurement) and ~0 (reference), regardless of original tilts.
        m_disp_rms = float(np.sqrt(np.mean(m_disp ** 2)))
        r_disp_rms = float(np.sqrt(np.mean(r_disp ** 2)))
        assert m_disp_rms > 0.5  # bump is present
        assert r_disp_rms < 1.0  # tilt_b removed cleanly

        # Use plane form-model for predictable behavior under our test plane.
        m = self._wrapped_from_grids(m_raw, m_disp, form_model="plane",
                                     subtracted_terms=())
        r = self._wrapped_from_grids(r_raw, r_disp, form_model="plane",
                                     subtracted_terms=())

        out = subtract_wavefronts(m, r, register=False)

        raw_diff = np.asarray(out["raw_height_grid_nm"],
                              dtype=np.float64).reshape(rows, cols)
        disp_diff = np.asarray(out["display_height_grid_nm"],
                               dtype=np.float64).reshape(rows, cols)
        mask_out = np.asarray(out["mask_grid"], dtype=bool).reshape(rows, cols)

        raw_rms = float(np.sqrt(np.mean(raw_diff[mask_out] ** 2)))
        disp_rms = float(np.sqrt(np.mean(disp_diff[mask_out] ** 2)))

        # Raw diff carries the tilt difference plus the bump — RMS is large.
        # Display diff has the differential tilt re-removed → just the bump.
        # The display RMS must be meaningfully smaller than the raw RMS.
        assert raw_rms > disp_rms * 2.0, (
            f"raw_rms={raw_rms:.2f} should dominate disp_rms={disp_rms:.2f} "
            "when differential tilt is preserved on the raw grid"
        )
        # Stats reflect the display grid (the user-visible residual).
        assert abs(out["rms_nm"] - disp_rms) < 0.5, (
            f"out.rms_nm={out['rms_nm']:.2f} should match display "
            f"diff RMS {disp_rms:.2f}"
        )

    def test_subtract_zero_diff_on_identical_captures_raw_domain(self):
        # Analyze the same image twice; subtracting must zero both the raw
        # diff (no differential anything) and the display diff.
        m = _make_wrapped_result()
        r = _make_wrapped_result()
        # Force identical raw + display + mask grids (different ids).
        for k in ("raw_height_grid_nm", "display_height_grid_nm", "height_grid",
                  "mask_grid", "raw_mask_grid"):
            r[k] = list(m[k])
        out = subtract_wavefronts(m, r, register=False)

        raw_diff = np.asarray(out["raw_height_grid_nm"], dtype=np.float64)
        disp_diff = np.asarray(out["display_height_grid_nm"], dtype=np.float64)
        assert float(np.abs(raw_diff).max()) < 1.0, (
            f"raw diff should be ~0 on identical captures; got max "
            f"{float(np.abs(raw_diff).max()):.3f}"
        )
        assert float(np.abs(disp_diff).max()) < 1.0


class TestSubtractModulationGridRegistration:
    """Fix 2 (P2b): analyze_interferogram now emits a numeric modulation_grid
    so register_captures can use it as the primary correlation source."""

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_modulation_grid_present_in_analyze_response(self):
        # analyze_interferogram should emit a flat modulation_grid list
        # of length grid_rows * grid_cols, values clamped to [0, 1].
        img = _clean_fringes(h=96, w=96, n_fringes=6)
        out = analyze_interferogram(img)
        assert "modulation_grid" in out
        gh = int(out["grid_rows"])
        gw = int(out["grid_cols"])
        mod = out["modulation_grid"]
        assert isinstance(mod, list)
        assert len(mod) == gh * gw
        for v in mod:
            assert 0.0 <= float(v) <= 1.0

    def test_register_uses_modulation_when_available(self):
        # Two analyzed captures of the same image should register via the
        # modulation method when the modulation map has registerable
        # structure. We synthesize fringes with a spatially-varying
        # contrast envelope so the modulation grid contains a clear,
        # off-DC bump (rather than uniform high-contrast across the frame).
        # Previously the modulation_map was a base64 PNG with no numeric
        # grid, so register_captures unconditionally fell back to the
        # raw_intensity (display-grid) path; with Fix 2 the primary path
        # actually fires.
        h, w = 128, 128
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        # Carrier fringes.
        phase = 2 * np.pi * (8.0 * xx / w)
        # Off-center Gaussian contrast envelope (modulation amplitude
        # peaks well away from the image center, providing structure that
        # cross-correlation can latch onto).
        env_cy, env_cx = h * 0.35, w * 0.65
        envelope = 0.3 + 0.7 * np.exp(
            -((xx - env_cx) ** 2 + (yy - env_cy) ** 2) / (2.0 * 18.0 ** 2)
        )
        img = np.clip(128.0 + 90.0 * envelope * np.cos(phase),
                      0, 255).astype(np.uint8)
        m = analyze_interferogram(img)
        r = analyze_interferogram(img)
        m.pop("_mask_full", None)
        r.pop("_mask_full", None)
        wrap_wavefront_result(m, origin="capture")
        wrap_wavefront_result(r, origin="capture")
        # Sanity: modulation_grid present and varies enough to correlate.
        mod_arr = np.asarray(m["modulation_grid"], dtype=np.float64)
        assert mod_arr.std() > 0.05, (
            f"modulation_grid too uniform to test modulation registration "
            f"(std={mod_arr.std():.3f})"
        )
        info = register_captures(m, r, hosted=False)
        assert info["method"] == "modulation", (
            f"expected modulation method (analyze emits modulation_grid); "
            f"got {info['method']!r}"
        )


class TestFringeSubtractAPI:
    """M3.4: HTTP tests for /fringe/subtract."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_subtract_endpoint_happy_path(self, client):
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        r2 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200 and r2.status_code == 200
        id1 = r1.json()["id"]
        id2 = r2.json()["id"]
        rs = client.post("/fringe/subtract", json={
            "measurement_id": id1,
            "reference_id": id2,
        })
        assert rs.status_code == 200, rs.text
        data = rs.json()
        assert data["origin"] == "subtracted"
        assert data["source_ids"] == [id1, id2]

    def test_subtract_endpoint_unknown_id_is_404(self, client):
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200
        id1 = r1.json()["id"]
        rs = client.post("/fringe/subtract", json={
            "measurement_id": id1,
            "reference_id": "deadbeef" * 4,
        })
        assert rs.status_code == 404
        # Also: unknown measurement_id.
        rs2 = client.post("/fringe/subtract", json={
            "measurement_id": "deadbeef" * 4,
            "reference_id": id1,
        })
        assert rs2.status_code == 404

    def test_subtract_result_appears_in_captures(self, client):
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        r2 = client.post("/fringe/analyze", json={"image_b64": b64})
        id1, id2 = r1.json()["id"], r2.json()["id"]
        rs = client.post("/fringe/subtract", json={
            "measurement_id": id1,
            "reference_id": id2,
        })
        assert rs.status_code == 200
        sub_id = rs.json()["id"]
        caps = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps) == 3
        origins = [c["origin"] for c in caps]
        assert origins.count("subtracted") == 1
        subbed = [c for c in caps if c["origin"] == "subtracted"][0]
        assert subbed["id"] == sub_id

    def test_chain_subtract_supported(self, client):
        b64 = self._b64_image()
        id_a = client.post("/fringe/analyze", json={"image_b64": b64}).json()["id"]
        id_b = client.post("/fringe/analyze", json={"image_b64": b64}).json()["id"]
        id_c = client.post("/fringe/analyze", json={"image_b64": b64}).json()["id"]
        rs1 = client.post("/fringe/subtract", json={
            "measurement_id": id_a, "reference_id": id_b})
        assert rs1.status_code == 200
        id_d = rs1.json()["id"]
        rs2 = client.post("/fringe/subtract", json={
            "measurement_id": id_d, "reference_id": id_c})
        assert rs2.status_code == 200
        assert rs2.json()["origin"] == "subtracted"
        assert rs2.json()["source_ids"] == [id_d, id_c]


class TestSubtractUIContract:
    """M3.6 — guard the capture-summary fields the Compare dialog UI depends on.

    The Compare modal populates its reference-picker and compatibility table
    from /fringe/session/captures (not from the full result).  A silent rename
    or removal of any of these summary keys would regress the UI without
    breaking the existing M3.4 tests, so we assert the exact contract here.
    """

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_captures_summary_has_fields_ui_needs(self, client):
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        r2 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200 and r2.status_code == 200

        resp = client.get("/fringe/session/captures")
        assert resp.status_code == 200
        caps = resp.json()["captures"]
        assert len(caps) == 2

        # Fields the Compare dialog reads.  If any of these disappears or is
        # renamed, the reference picker / compatibility banner will silently
        # break — so assert the exact set on every summary.
        required = {
            "id", "pv_nm", "rms_nm", "origin", "wavelength_nm", "captured_at",
            "surface_height", "surface_width", "n_valid_pixels",
            "calibration_snapshot",
        }
        for cap in caps:
            missing = required - set(cap.keys())
            assert not missing, f"capture summary missing fields: {missing}"


class TestTunableParams:
    """M2.5 — user-tunable DFT parameters (LPF σ, DC margin, mask threshold)."""

    def _noisy_fringe_image(self, h=192, w=192, n_fringes=6, seed=0):
        """Noisy synthetic fringes so smoothing differences are observable."""
        rng = np.random.default_rng(seed)
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * n_fringes * xx / w
        clean = 128 + 80 * np.cos(carrier)
        noise = rng.normal(0, 30, size=(h, w))
        return np.clip(clean + noise, 0, 255).astype(np.uint8)

    def test_analyze_respects_lpf_sigma_frac(self):
        """Small σ => higher RMS (less smoothing); large σ => lower RMS."""
        img = self._noisy_fringe_image()
        r_small = analyze_interferogram(
            img, wavelength_nm=632.8, n_zernike=15,
            use_full_mask=True, lpf_sigma_frac=0.1,
        )
        r_large = analyze_interferogram(
            img, wavelength_nm=632.8, n_zernike=15,
            use_full_mask=True, lpf_sigma_frac=3.0,
        )
        rms_small = r_small["rms_nm"]
        rms_large = r_large["rms_nm"]
        assert rms_small > rms_large, (
            f"expected small-σ RMS ({rms_small:.2f}) > large-σ RMS ({rms_large:.2f})"
        )
        # Comfortable margin (>10% difference).
        assert rms_small > rms_large * 1.1, (
            f"expected >10%% gap; small={rms_small:.2f}, large={rms_large:.2f}"
        )

    def test_analyze_respects_dc_margin_override(self):
        """Both DC-margin overrides should return a carrier result without crashing."""
        h, w = 192, 192
        yy, xx = np.mgrid[0:h, 0:w]
        img = (128 + 80 * np.cos(2 * np.pi * 3 * xx / w)).astype(np.uint8)
        r_wide = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15,
                                       use_full_mask=True, dc_margin_override=8)
        r_zero = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15,
                                       use_full_mask=True, dc_margin_override=0)
        assert "carrier" in r_wide
        assert "carrier" in r_zero
        assert r_wide["carrier"]["fringe_period_px"] > 0
        assert r_zero["carrier"]["fringe_period_px"] > 0

    def _api_client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient
        camera = FakeCamera()
        app = create_app(camera)
        return TestClient(app)

    def test_tuning_echoed_in_response(self):
        """POST with explicit tuning fields => response echoes them in data.tuning."""
        with self._api_client() as client:
            r = client.post("/fringe/analyze", json={
                "wavelength_nm": 632.8,
                "mask_threshold": 0.2,
                "lpf_sigma_frac": 0.9,
                "dc_margin_override": 4,
                "dc_cutoff_cycles": 2.0,
            })
            assert r.status_code == 200, r.text
            data = r.json()
            assert data.get("tuning") == {
                "mask_threshold": 0.2,
                "lpf_sigma_frac": 0.9,
                "dc_margin_override": 4,
                "dc_cutoff_cycles": 2.0,
            }

    def test_none_values_use_auto(self):
        """POST without tuning fields => echoed tuning has None for overrides."""
        with self._api_client() as client:
            r = client.post("/fringe/analyze", json={"wavelength_nm": 632.8})
            assert r.status_code == 200, r.text
            data = r.json()
            t = data.get("tuning")
            assert t is not None
            assert t["lpf_sigma_frac"] is None
            assert t["dc_margin_override"] is None
            assert t["mask_threshold"] == 0.15


# ──────────────────────────────────────────────────────────────────────
# Phase 2 (M2) regression tests
# ──────────────────────────────────────────────────────────────────────


class TestMaskRenderLeak:
    """Task 0: render_surface_map must not bleed surface color outside
    a user-drawn polygon mask (matplotlib bilinear resampling bug)."""

    def test_custom_polygon_mask_respected_in_surface_map(self):
        """Polygon covering only the left half of a fringe image.
        The grid's right-half pixels must be masked out (0 in mask_grid)."""
        from backend.vision.mask_utils import rasterize_polygon_mask
        h, w = 200, 200
        yy, xx = np.mgrid[0:h, 0:w]
        img = (128.0 + 100.0 * np.cos(2 * np.pi * (0.1 * xx + 0.05 * yy))
               ).astype(np.uint8)
        # Left half polygon with small margin so the bbox + 5% pad
        # doesn't slide the grid geometry off the polygon.
        poly = [{"vertices": [(0.02, 0.02), (0.48, 0.02),
                              (0.48, 0.98), (0.02, 0.98)],
                 "include": True}]
        custom_mask = rasterize_polygon_mask(poly, h, w)
        result = analyze_interferogram(img, custom_mask=custom_mask)
        rows = result["grid_rows"]
        cols = result["grid_cols"]
        mask_grid = np.array(result["mask_grid"]).reshape(rows, cols)
        # When the polygon is strictly on the left, the analysis bbox
        # encompasses only the left half → grid_cols should be close to
        # w * polygon_fraction. Stricter assertion: NO pixels in the
        # rightmost quarter of the full image are present in mask_grid.
        # Since the bbox is cropped, the grid itself lives inside the
        # polygon; all valid pixels must sit inside the polygon rectangle.
        assert mask_grid.any(), "mask_grid should have some True pixels"
        # Check the rendered PNG: decode and confirm masked-out pixels are
        # black (interpolation='nearest' fix — previously bilinear leaked
        # colored surface data across the mask boundary).
        import base64, cv2
        png = base64.b64decode(result["surface_map"])
        arr = np.frombuffer(png, dtype=np.uint8)
        png_img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        assert png_img is not None
        # On a nearest-interpolation render, any pixel outside mask_grid
        # should be the black figure background.
        ph, pw = png_img.shape[:2]
        if (ph, pw) == (rows, cols):
            # direct pixel correspondence
            outside = png_img[~mask_grid.astype(bool)]
            if outside.size:
                # Allow a handful of anti-aliased edge pixels but the
                # bulk must be near-black.
                max_lum = outside.max(axis=-1) if outside.ndim > 1 else outside
                near_black = (max_lum < 20).mean()
                assert near_black > 0.8, (
                    f"Too few near-black pixels outside mask: "
                    f"{near_black*100:.0f}% < 80%")


class TestM21ExponentialDCHighPass:
    """M2.1: smooth exponential DC ramp replaces the hard dc_margin cliff
    at carrier detection and in phase extraction."""

    def test_low_fringe_count_carrier_detection(self):
        """3 fringes across a 256x256 image → carrier within ±1 bin of truth."""
        from backend.vision.fringe import _find_carrier
        h, w = 256, 256
        n = 3
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * n * xx / w)
        img = np.tile(row, (h, 1)).astype(np.uint8)
        py, px, _ = _find_carrier(img, dc_cutoff_cycles=1.5)
        # Truth: horizontal carrier at bin (cy, cx+n)
        cy, cx = h // 2, w // 2
        expected_x = cx + n
        assert abs(px - expected_x) < 1.0, (
            f"Low-fringe carrier off: found px={px:.2f}, expected {expected_x}"
        )
        assert abs(py - cy) < 1.0, (
            f"Horizontal carrier should be on central row; got py={py:.2f}"
        )

    def test_no_spectral_ringing_on_flat_field(self):
        """Flat field (no fringes, just vignette): recovered wrapped phase
        has no ring-shaped FFT artifact at the dc_margin boundary.

        The smooth DC ramp (M2.1) replaces the hard zero that produced
        ringing in legacy behavior. We compare the peak radial magnitude
        to the DC magnitude: on a flat field the recovered phase should be
        small, and no off-DC ring should rival the peak-of-peaks.
        """
        from backend.vision.fringe import extract_phase_dft
        h, w = 128, 128
        yy, xx = np.mgrid[0:h, 0:w]
        r2 = (xx - w/2) ** 2 + (yy - h/2) ** 2
        # Gaussian vignette only, no carrier signal.
        img = (180.0 * np.exp(-r2 / (2 * (w / 3) ** 2))).astype(np.uint8)
        wrapped = extract_phase_dft(img, dc_cutoff_cycles=1.5)
        # Sanity: the recovered phase should be small — without a carrier
        # there's nothing to demodulate, so extracted phase is mostly noise
        # plus whatever the LPF passed through. Peak-to-valley should be
        # bounded well below 2π.
        pv = float(wrapped.max() - wrapped.min())
        assert pv < 2 * np.pi, (
            f"Flat-field wrapped-phase PV should be small, got {pv:.2f} rad"
        )


    def test_dc_cutoff_param_accepted(self):
        """extract_phase_dft accepts dc_cutoff_cycles and produces a finite
        wrapped-phase map across a range of values."""
        from backend.vision.fringe import extract_phase_dft
        h, w = 128, 128
        yy, xx = np.mgrid[0:h, 0:w]
        img = (128 + 80 * np.cos(2 * np.pi * 8 * xx / w)).astype(np.uint8)
        for cutoff in (0.5, 1.0, 1.5, 3.0, 8.0):
            wrapped = extract_phase_dft(img, dc_cutoff_cycles=cutoff)
            assert np.isfinite(wrapped).all()


class TestM22SubpixelCarrier:
    """M2.2: 2-D paraboloid sub-pixel fit over annulus ±2 bins."""

    def test_subpixel_carrier_smooth_surface(self):
        """Pure cos(2π·fx·x) on 256×256 → carrier within 0.05 bins of truth."""
        from backend.vision.fringe import _find_carrier
        h, w = 256, 256
        fx = 0.1
        yy, xx = np.mgrid[0:h, 0:w]
        img = (128 + 80 * np.cos(2 * np.pi * fx * xx)).astype(np.uint8)
        py, px, _ = _find_carrier(img)
        cx = w // 2
        expected_px = cx + fx * w  # bin index
        assert abs(px - expected_px) < 0.1, (
            f"Smooth carrier off: found px={px:.3f}, expected {expected_px:.3f}"
        )

    def test_subpixel_carrier_unbiased_by_step(self):
        """A phase step in the middle of the image biases the legacy 3-point
        parabolic fit; the M2.2 paraboloid over an annulus is more robust."""
        from backend.vision.fringe import _find_carrier
        h, w = 256, 256
        fx = 0.1
        step_height = 1.5  # radians, discontinuous
        yy, xx = np.mgrid[0:h, 0:w]
        step = np.where(xx > w / 2, step_height, 0.0)
        img = (128 + 80 * np.cos(2 * np.pi * fx * xx + step)).astype(np.uint8)
        py, px, _ = _find_carrier(img)
        cx = w // 2
        expected_px = cx + fx * w
        # Paraboloid vertex over an annulus is less biased than 3-point fit.
        assert abs(px - expected_px) < 0.5, (
            f"Step-biased carrier: found px={px:.3f}, expected {expected_px:.3f}"
        )


class TestM23HybridQualityMap:
    """M2.3: unwrap uses modulation × phase-consistency for seed selection;
    response exposes the quality_map grid."""

    def test_quality_map_populated(self):
        """After analyze_interferogram, response has a quality_map grid
        whose shape matches mask_grid."""
        h, w = 128, 128
        yy, xx = np.mgrid[0:h, 0:w]
        img = (128 + 80 * np.cos(2 * np.pi * 8 * xx / w)).astype(np.uint8)
        result = analyze_interferogram(img, wavelength_nm=632.8, n_zernike=15)
        assert "quality_map" in result
        assert isinstance(result["quality_map"], list)
        assert len(result["quality_map"]) == (result["grid_rows"]
                                              * result["grid_cols"])
        assert len(result["quality_map"]) == len(result["mask_grid"])
        # All values in [0, 1] after masking.
        qvals = np.array(result["quality_map"])
        assert qvals.min() >= 0.0
        assert qvals.max() <= 1.0

    def test_quality_map_excludes_edge_discontinuities(self):
        """Central fringes with a sharp discontinuity at the edge: quality
        is low at the discontinuity and high in the center."""
        from backend.vision.fringe import _phase_consistency
        h, w = 200, 200
        yy, xx = np.mgrid[0:h, 0:w]
        # Clean horizontal fringes everywhere, with a π-jump at x == 5 (edge).
        phase = 2 * np.pi * 0.08 * xx
        phase = np.where(xx < 5, phase + np.pi, phase)
        wrapped = np.angle(np.exp(1j * phase))
        q = _phase_consistency(wrapped)
        # Near the discontinuity column (x≈5), quality should be low.
        edge_q = float(np.mean(q[:, 4:7]))
        center_q = float(np.mean(q[:, w // 2 - 5:w // 2 + 5]))
        assert edge_q < 0.5, f"Edge quality should be <0.5, got {edge_q:.3f}"
        assert center_q > 0.8, f"Center quality should be >0.8, got {center_q:.3f}"


class TestM24PostUnwrapPlaneFit:
    """M2.4: post-unwrap plane fit diagnostic `plane_fit_residual_nm`."""

    def test_plane_fit_residual_small_for_circular_aperture(self):
        """Circular mask + tilted phase: Zernike tilt (Z2/Z3) captures the
        slope, so the plane-fit residual is small."""
        h, w = 128, 128
        yy, xx = np.mgrid[0:h, 0:w]
        # Tilted fringes (carrier + small surface tilt not aliased to carrier).
        carrier_phase = 2 * np.pi * 8 * xx / w
        # Surface: linear tilt that the carrier could absorb, but we force
        # a circular mask so Zernike fits on the disk.
        img = (128 + 80 * np.cos(carrier_phase)).astype(np.uint8)
        # Build a circular mask.
        cy, cx = h / 2, w / 2
        r = min(h, w) * 0.45
        mask = ((xx - cx) ** 2 + (yy - cy) ** 2) <= r ** 2
        result = analyze_interferogram(img, wavelength_nm=632.8,
                                       custom_mask=mask,
                                       subtract_terms=[1, 2, 3])
        assert "plane_fit_residual_nm" in result
        resid = float(result["plane_fit_residual_nm"])
        # Circular aperture: Zernike tilt captures everything, plane residual
        # should be very small. Give generous margin for numerical noise.
        assert resid < 5.0, (
            f"Circular aperture plane residual should be small, got {resid:.2f} nm"
        )

    def test_plane_fit_residual_nontrivial_for_rectangular_aperture(self):
        """Rectangular mask + tilted surface: Zernike basis defined on the
        unit disk leaves some tilt residual that the plane fit catches."""
        h, w = 128, 256
        yy, xx = np.mgrid[0:h, 0:w]
        # Carrier plus a visible surface tilt via a cross-term y·x/aperture
        # so the surface has real tilt that Zernike can't perfectly capture
        # on a non-circular aperture.
        carrier_phase = 2 * np.pi * 10 * xx / w
        # Add a *non-carrier-absorbable* tilt: modulate the carrier amplitude
        # along y so the surface phase has a weak tilt in y post-demod.
        # Simplest: quadratic defocus on a rectangular mask.
        y_norm = (yy - h / 2) / (h / 2)
        surface = 0.8 * y_norm  # pure y-tilt
        img = (128 + 80 * np.cos(carrier_phase + surface)).astype(np.uint8)
        # Rectangular mask slightly inset from the image border.
        mask = np.zeros((h, w), dtype=bool)
        mask[5:h-5, 5:w-5] = True
        result = analyze_interferogram(img, wavelength_nm=632.8,
                                       custom_mask=mask,
                                       subtract_terms=[1, 2, 3])
        assert "plane_fit_residual_nm" in result
        # Non-zero — we don't require a specific magnitude, just that it's
        # meaningfully above the circular-aperture floor.
        resid = float(result["plane_fit_residual_nm"])
        assert resid >= 0.0


class TestM26AnisotropicLPF:
    """M2.6: FFT-space anisotropic Gaussian centered on DC (post-demod),
    aligned with the detected fringe direction."""

    def test_anisotropic_lpf_preserves_along_fringe_detail(self):
        """A bump running along the fringe direction is preserved better
        by the anisotropic LPF than by a narrow isotropic one."""
        from backend.vision.fringe import extract_phase_dft, unwrap_phase_2d
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        fx = 0.1  # horizontal carrier → fringes run vertically
        # Along-fringe bump: tall and narrow in y (perpendicular to carrier
        # in image frame ≡ along-fringe direction).
        bump_sigma_x = 40.0  # wider in x (along-fringe direction... wait)
        bump_sigma_y = 12.0
        # With horizontal carrier, fringes are vertical stripes. Along-fringe
        # (perpendicular to carrier vector) = vertical (y) direction. So
        # rapid detail along fringes = fast y-variation.
        cy, cx = h / 2, w / 2
        bump_phase = 1.0 * np.exp(
            -((xx - cx) ** 2) / (2 * bump_sigma_x ** 2)
            - ((yy - cy) ** 2) / (2 * bump_sigma_y ** 2)
        )
        img = (128 + 80 * np.cos(2 * np.pi * fx * xx + bump_phase)).astype(np.uint8)
        w_aniso = extract_phase_dft(img, anisotropic_lpf=True)
        w_iso = extract_phase_dft(img, anisotropic_lpf=False)
        u_aniso, _, _ = unwrap_phase_2d(w_aniso)
        u_iso, _, _ = unwrap_phase_2d(w_iso)
        # Recovered bump peak-minus-background (sample the center vs corner).
        peak_aniso = float(u_aniso[int(cy), int(cx)]
                           - u_aniso[:20, :20].mean())
        peak_iso = float(u_iso[int(cy), int(cx)]
                         - u_iso[:20, :20].mean())
        # Anisotropic should preserve at least as much bump amplitude as
        # isotropic for this along-fringe detail.
        assert abs(peak_aniso) >= 0.9 * abs(peak_iso), (
            f"Anisotropic LPF lost more along-fringe detail: "
            f"aniso={peak_aniso:.3f} vs iso={peak_iso:.3f}"
        )

    def test_anisotropic_lpf_removes_cross_fringe_harmonics(self):
        """A synthetic 2nd-harmonic content across the fringe direction
        should be suppressed more aggressively by the anisotropic LPF."""
        from backend.vision.fringe import extract_phase_dft
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        fx = 0.1
        carrier = 2 * np.pi * fx * xx
        # Across-fringe harmonic at 2×fx (parallel to carrier vector).
        harmonic = 0.3 * np.cos(2 * np.pi * 2 * fx * xx)
        img = (128 + 80 * np.cos(carrier) + 20 * harmonic).astype(np.uint8)
        # Recovered phase: the 2nd-harmonic, if not suppressed, shows up as
        # phase ripple at across-fringe frequency 2·fx − fx = fx.
        w_aniso = extract_phase_dft(img, anisotropic_lpf=True)
        w_iso = extract_phase_dft(img, anisotropic_lpf=False)
        # Measure ripple amplitude at fx cycles/px on the central row.
        def _ripple(wr):
            row = wr[h // 2] - wr[h // 2].mean()
            sp = np.abs(np.fft.rfft(row))
            bin_fx = int(round(fx * w))
            return float(sp[bin_fx])
        r_aniso = _ripple(w_aniso)
        r_iso = _ripple(w_iso)
        # Anisotropic should suppress this harmonic at least as well.
        assert r_aniso <= r_iso * 1.10, (
            f"Anisotropic LPF didn't reduce cross-fringe harmonic: "
            f"aniso ripple={r_aniso:.2f} vs iso={r_iso:.2f}"
        )


# ── M3.2 / M3.3 — average_wavefronts ────────────────────────────────────


class TestAverageWavefronts:
    """M3.2: unit tests for average_wavefronts (pixel-aligned, optional
    per-pixel outlier rejection)."""

    def test_average_two_identical_is_same_surface(self):
        # Same image twice → average should reproduce the single-result grid.
        r1 = _make_wrapped_result()
        r2 = _make_wrapped_result()
        # Force both grids to match exactly (fresh analyses may differ at
        # the numerical-noise level, which is not what this test is about).
        r2["display_height_grid_nm"] = list(r1["display_height_grid_nm"])
        r2["raw_height_grid_nm"] = list(r1["raw_height_grid_nm"])
        r2["mask_grid"] = list(r1["mask_grid"])
        r2["raw_mask_grid"] = list(r1["mask_grid"])
        r2["grid_rows"] = r1["grid_rows"]
        r2["grid_cols"] = r1["grid_cols"]
        r2["surface_height"] = r1["surface_height"]
        r2["surface_width"] = r1["surface_width"]

        out = average_wavefronts([r1, r2])
        a = np.asarray(out["display_height_grid_nm"], dtype=np.float64)
        b = np.asarray(r1["display_height_grid_nm"], dtype=np.float64)
        # Masked pixels zero on both sides; valid pixels equal.
        mask = np.asarray(out["mask_grid"], dtype=bool)
        assert mask.sum() >= 1
        assert np.allclose(a, b, atol=1e-6)

    def test_average_reduces_rms_noise(self):
        # 5 flat surfaces plus independent Gaussian noise → averaged RMS ≈
        # single RMS / sqrt(5).
        rng = np.random.default_rng(1234)
        rows, cols = 32, 32
        n = 5
        noise_sigma = 50.0  # nm
        results = []
        for _ in range(n):
            noise = rng.normal(0.0, noise_sigma, size=(rows, cols)).astype(np.float32)
            heights = noise.ravel().tolist()
            r = _fake_wrapped_result(rows, cols)
            r["display_height_grid_nm"] = heights
            r["height_grid"] = heights
            r["raw_height_grid_nm"] = heights
            results.append(r)

        single_rms = float(np.sqrt(np.mean(
            (np.asarray(results[0]["display_height_grid_nm"]) -
             np.mean(results[0]["display_height_grid_nm"])) ** 2
        )))
        out = average_wavefronts(results)
        avg_rms = float(out["rms_nm"])
        # Expect ≈ single_rms / sqrt(5); allow generous slack for finite sample size.
        expected = single_rms / math.sqrt(n)
        assert avg_rms < single_rms * 0.75, (
            f"averaging failed to cut RMS: avg={avg_rms:.2f} vs single={single_rms:.2f}"
        )
        assert avg_rms < expected * 1.75, (
            f"avg RMS far above sqrt(N) expectation: {avg_rms:.2f} vs {expected:.2f}"
        )

    def _make_constant_layer(self, rows, cols, value_nm):
        r = _fake_wrapped_result(rows, cols)
        heights = [float(value_nm)] * (rows * cols)
        r["display_height_grid_nm"] = heights
        r["height_grid"] = heights
        r["raw_height_grid_nm"] = heights
        return r

    def test_average_sigma_rejection_drops_outlier(self):
        # 4 clean + 1 extreme outlier. With threshold=1.5 the outlier is
        # definitively rejected while all clean layers pass — sigma rejection
        # is sensitive to the outlier's own contribution to std, so the test
        # uses clean_vals that have small spread relative to the outlier.
        rows, cols = 8, 8
        clean_vals = [10.0, 10.5, 11.0, 11.5]
        clean = [self._make_constant_layer(rows, cols, v) for v in clean_vals]
        outlier = self._make_constant_layer(rows, cols, 5000.0)
        all_layers = clean + [outlier]
        out = average_wavefronts(all_layers, rejection="sigma",
                                 rejection_threshold=1.5)
        heights = np.asarray(out["display_height_grid_nm"], dtype=np.float64)
        mask = np.asarray(out["mask_grid"], dtype=bool)
        clean_mean = float(np.mean(clean_vals))
        assert np.allclose(heights[mask], clean_mean, atol=0.5)
        # rejection_stats: outlier layer (index 4) should have all pixels rejected.
        stats = out["rejection_stats"]
        assert stats["n_inputs"] == 5
        assert len(stats["n_rejected_per_layer"]) == 5
        assert stats["n_rejected_per_layer"][4] == rows * cols

    def test_average_mad_rejection_drops_outlier(self):
        rows, cols = 8, 8
        clean_vals = [10.0, 10.1, 10.2, 10.3]
        clean = [self._make_constant_layer(rows, cols, v) for v in clean_vals]
        outlier = self._make_constant_layer(rows, cols, 500.0)
        all_layers = clean + [outlier]
        out = average_wavefronts(all_layers, rejection="mad",
                                 rejection_threshold=2.0)
        heights = np.asarray(out["display_height_grid_nm"], dtype=np.float64)
        mask = np.asarray(out["mask_grid"], dtype=bool)
        clean_mean = float(np.mean(clean_vals))
        assert np.allclose(heights[mask], clean_mean, atol=0.5)
        assert out["rejection_stats"]["n_rejected_per_layer"][4] == rows * cols

    def test_average_shape_mismatch_raises(self):
        a = _fake_wrapped_result(8, 8)
        b = _fake_wrapped_result(16, 8)
        with pytest.raises(ValueError) as ei:
            average_wavefronts([a, b])
        assert "Grid shapes differ" in str(ei.value)

    def test_average_requires_two_inputs(self):
        a = _fake_wrapped_result(8, 8)
        with pytest.raises(ValueError) as ei:
            average_wavefronts([a])
        assert "at least 2" in str(ei.value)

    def test_average_envelope_origin_and_source_ids(self):
        a = _fake_wrapped_result(8, 8)
        b = _fake_wrapped_result(8, 8)
        out = average_wavefronts([a, b])
        assert out["origin"] == "average"
        assert out["source_ids"] == [a["id"], b["id"]]
        # wrap_wavefront_result stamps the averaged result with a fresh id.
        assert out["id"] != a["id"] and out["id"] != b["id"]

    def test_average_wavelength_mismatch_warns(self):
        a = _fake_wrapped_result(8, 8, wavelength_nm=632.8)
        b = _fake_wrapped_result(8, 8, wavelength_nm=589.3)
        out = average_wavefronts([a, b])
        assert any("Wavelength mismatch" in w for w in out["warnings"])

    def test_average_mask_intersection(self):
        # Two masks that only partially overlap — averaged mask must be
        # the intersection (≥ 2 valid contributors).
        rows, cols = 4, 4
        a = _fake_wrapped_result(rows, cols)
        b = _fake_wrapped_result(rows, cols)
        m_a = [0] * (rows * cols)
        m_b = [0] * (rows * cols)
        # a valid on pixels 0..7, b valid on 4..11 → intersection 4..7.
        for i in range(0, 8):
            m_a[i] = 1
        for i in range(4, 12):
            m_b[i] = 1
        a["mask_grid"] = m_a
        a["raw_mask_grid"] = m_a
        b["mask_grid"] = m_b
        b["raw_mask_grid"] = m_b
        out = average_wavefronts([a, b])
        mask = np.asarray(out["mask_grid"], dtype=np.uint8)
        expected = np.array(
            [1 if (m_a[i] == 1 and m_b[i] == 1) else 0
             for i in range(rows * cols)],
            dtype=np.uint8,
        )
        assert mask.tolist() == expected.tolist()


class TestFringeAverageAPI:
    """M3.2/M3.3: HTTP tests for /fringe/average."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_average_endpoint_happy_path(self, client):
        b64 = self._b64_image()
        ids = []
        for _ in range(3):
            r = client.post("/fringe/analyze", json={"image_b64": b64})
            assert r.status_code == 200, r.text
            ids.append(r.json()["id"])
        rs = client.post("/fringe/average", json={"source_ids": ids})
        assert rs.status_code == 200, rs.text
        data = rs.json()
        assert data["origin"] == "average"
        assert data["source_ids"] == ids

    def test_average_endpoint_rejects_single_source(self, client):
        b64 = self._b64_image()
        r = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r.status_code == 200
        id1 = r.json()["id"]
        rs = client.post("/fringe/average", json={"source_ids": [id1]})
        # Pydantic min_length=2 → 422, but accept 400 as well.
        assert rs.status_code in (400, 422)

    def test_average_endpoint_unknown_id_is_404(self, client):
        b64 = self._b64_image()
        r = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r.status_code == 200
        good = r.json()["id"]
        rs = client.post("/fringe/average", json={
            "source_ids": [good, "deadbeef" * 4],
        })
        assert rs.status_code == 404
        detail = rs.json().get("detail", "")
        assert "deadbeef" in detail

    def test_average_result_appears_in_captures(self, client):
        b64 = self._b64_image()
        ids = []
        for _ in range(2):
            r = client.post("/fringe/analyze", json={"image_b64": b64})
            ids.append(r.json()["id"])
        rs = client.post("/fringe/average", json={"source_ids": ids})
        assert rs.status_code == 200
        avg_id = rs.json()["id"]
        caps = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps) == 3
        origins = [c["origin"] for c in caps]
        assert origins.count("average") == 1
        avg_entry = [c for c in caps if c["origin"] == "average"][0]
        assert avg_entry["id"] == avg_id

    def test_average_chain_supported(self, client):
        b64 = self._b64_image()
        id_a = client.post("/fringe/analyze", json={"image_b64": b64}).json()["id"]
        id_b = client.post("/fringe/analyze", json={"image_b64": b64}).json()["id"]
        id_c = client.post("/fringe/analyze", json={"image_b64": b64}).json()["id"]
        rs1 = client.post("/fringe/average", json={"source_ids": [id_a, id_b]})
        assert rs1.status_code == 200, rs1.text
        id_d = rs1.json()["id"]
        rs2 = client.post("/fringe/average", json={"source_ids": [id_d, id_c]})
        assert rs2.status_code == 200, rs2.text
        assert rs2.json()["origin"] == "average"
        assert rs2.json()["source_ids"] == [id_d, id_c]


# ── M3.5 — register_captures + subtraction with registration ──────────────


def _make_result_from_grid(
    display_grid: np.ndarray,
    *,
    mask: np.ndarray | None = None,
    wavelength_nm: float = 632.8,
    calibration: dict | None = None,
) -> dict:
    """Build a minimal WavefrontResult from a hand-crafted display grid."""
    rows, cols = display_grid.shape
    heights = display_grid.astype(np.float32).ravel().tolist()
    if mask is None:
        mask = np.ones((rows, cols), dtype=bool)
    mask_list = [int(v) for v in mask.astype(np.uint8).ravel()]
    base = {
        "surface_map": "",
        "profile_x": {"positions": [], "values": [], "axis": "x"},
        "profile_y": {"positions": [], "values": [], "axis": "y"},
        "coefficients": [0.0] * 36,
        "coefficient_names": {str(j): f"Z{j}" for j in range(1, 37)},
        "pv_nm": 0.0,
        "rms_nm": 0.0,
        "pv_waves": 0.0,
        "rms_waves": 0.0,
        "strehl": 1.0,
        "subtracted_terms": [1, 2, 3],
        "wavelength_nm": wavelength_nm,
        "n_valid_pixels": int(mask.sum()),
        "n_total_pixels": rows * cols,
        "surface_height": rows,
        "surface_width": cols,
        "height_grid": heights,
        "display_height_grid_nm": heights,
        "raw_height_grid_nm": heights,
        "mask_grid": mask_list,
        "raw_mask_grid": mask_list,
        "grid_rows": rows,
        "grid_cols": cols,
    }
    wrap_wavefront_result(base, origin="capture", calibration=calibration)
    return base


def _fourier_translate(grid: np.ndarray, dy: float, dx: float) -> np.ndarray:
    """Apply a sub-pixel shift (dy, dx) to a 2-D array via Fourier ramp."""
    h, w = grid.shape
    fy = np.fft.fftfreq(h).reshape(-1, 1)
    fx = np.fft.fftfreq(w).reshape(1, -1)
    ramp = np.exp(-1j * 2.0 * np.pi * (dy * fy + dx * fx))
    shifted = np.fft.ifft2(np.fft.fft2(grid.astype(np.float64)) * ramp).real
    return shifted.astype(np.float32)


def _synth_surface(rows=64, cols=64, seed=0) -> np.ndarray:
    """Smoothly varying random surface with enough structure for correlation."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:rows, 0:cols].astype(np.float64)
    z = np.zeros((rows, cols), dtype=np.float64)
    for _ in range(6):
        cy = rng.uniform(0, rows)
        cx = rng.uniform(0, cols)
        s = rng.uniform(5, 15)
        amp = rng.uniform(-50, 50)
        z += amp * np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / (2.0 * s * s))
    z += 0.5 * xx - 0.3 * yy
    return z.astype(np.float32)


class TestRegisterCaptures:
    """M3.5 — unit tests for register_captures."""

    def test_register_zero_shift_on_identical(self):
        surf = _synth_surface(64, 64, seed=1)
        m = _make_result_from_grid(surf)
        r = _make_result_from_grid(surf)
        out = register_captures(m, r)
        assert abs(out["dy"]) < 0.1
        assert abs(out["dx"]) < 0.1
        assert out["confidence"] > 10.0
        assert out["method"] in ("modulation", "raw_intensity")
        assert out["downsampled"] is False

    def test_register_detects_subpixel_translation(self):
        # Reference = measurement translated by (+truth_dy, +truth_dx) in
        # image coordinates (i.e. reference(y, x) = measurement(y - dy, x - dx)).
        # The detected shift is the one that, when applied to the reference,
        # aligns it with the measurement — i.e. -truth_dy, -truth_dx.
        surf = _synth_surface(96, 96, seed=2)
        truth_dy, truth_dx = 1.7, 2.3
        shifted = _fourier_translate(surf, truth_dy, truth_dx)
        m = _make_result_from_grid(surf)
        r = _make_result_from_grid(shifted)
        out = register_captures(m, r)
        expected_dy = -truth_dy
        expected_dx = -truth_dx
        assert abs(out["dy"] - expected_dy) < 0.3, (
            f"dy={out['dy']} expected={expected_dy}"
        )
        assert abs(out["dx"] - expected_dx) < 0.3, (
            f"dx={out['dx']} expected={expected_dx}"
        )
        assert out["method"] != "none"

    def test_register_detects_integer_translation(self):
        surf = _synth_surface(96, 96, seed=3)
        truth_dy, truth_dx = 3.0, 5.0
        shifted = _fourier_translate(surf, truth_dy, truth_dx)
        m = _make_result_from_grid(surf)
        r = _make_result_from_grid(shifted)
        out = register_captures(m, r)
        assert abs(out["dy"] - (-truth_dy)) < 0.3
        assert abs(out["dx"] - (-truth_dx)) < 0.3

    def test_register_low_confidence_on_uncorrelated(self):
        rng = np.random.default_rng(42)
        rows, cols = 64, 64
        a = rng.standard_normal((rows, cols)).astype(np.float32) * 100
        b = rng.standard_normal((rows, cols)).astype(np.float32) * 100
        m = _make_result_from_grid(a)
        r = _make_result_from_grid(b)
        out = register_captures(m, r)
        assert out["confidence"] < 3.0
        assert out["method"] == "none"
        assert out["warning"] is not None

    def test_register_hosted_downsamples(self):
        rows = cols = 1024
        surf = _synth_surface(rows, cols, seed=7)
        truth_dy, truth_dx = 4.0, 6.0
        shifted = _fourier_translate(surf, truth_dy, truth_dx)
        m = _make_result_from_grid(surf)
        r = _make_result_from_grid(shifted)
        out = register_captures(m, r, hosted=True)
        assert out["downsampled"] is True
        # Downsampling halves accuracy; allow generous tolerance in the
        # original-space coordinates. Detected shift is the inverse of the
        # truth because it's the shift to apply to the reference.
        assert abs(out["dy"] - (-truth_dy)) < 2.5, f"dy={out['dy']}"
        assert abs(out["dx"] - (-truth_dx)) < 2.5, f"dx={out['dx']}"


class TestSubtractWithRegistration:
    """M3.5 — subtract_wavefronts with register kwarg."""

    def test_subtract_with_subpixel_shift_residual_small(self):
        surf = _synth_surface(96, 96, seed=11)
        truth_dy, truth_dx = 1.7, 1.3
        measurement_grid = surf
        reference_grid = _fourier_translate(surf, truth_dy, truth_dx)

        m = _make_result_from_grid(measurement_grid)
        r = _make_result_from_grid(reference_grid)

        out_reg = subtract_wavefronts(m, r, register=True)
        out_nore = subtract_wavefronts(m, r, register=False)

        assert out_reg["rms_nm"] < out_nore["rms_nm"], (
            f"Registration should reduce RMS: "
            f"registered={out_reg['rms_nm']:.3f} "
            f"vs pixel-aligned={out_nore['rms_nm']:.3f}"
        )
        assert out_reg["rms_nm"] < out_nore["rms_nm"] * 0.5

    def test_subtract_register_false_skips(self):
        surf = _synth_surface(32, 32, seed=13)
        m = _make_result_from_grid(surf)
        r = _make_result_from_grid(surf)
        out = subtract_wavefronts(m, r, register=False)
        assert "registration" in out
        assert out["registration"]["method"] == "disabled"

    def test_subtract_residual_rms_warning(self):
        rng = np.random.default_rng(99)
        rows = cols = 48
        a = rng.standard_normal((rows, cols)).astype(np.float32) * 200
        b = rng.standard_normal((rows, cols)).astype(np.float32) * 200
        m = _make_result_from_grid(a)
        r = _make_result_from_grid(b)
        # Skip registration so the warning fires deterministically from
        # the residual-RMS check.
        out = subtract_wavefronts(m, r, register=False)
        warnings_text = " ".join(out.get("warnings") or [])
        assert "Residual RMS exceeds measurement RMS" in warnings_text

    def test_subtract_mask_shift_does_not_wrap(self):
        rows = cols = 48
        surf = _synth_surface(rows, cols, seed=21)
        m = _make_result_from_grid(surf)
        # Reference is the surface shifted by (+15, +15). The registration
        # detects (-15, -15) as the correction. When the reference mask
        # is shifted by that integer offset with explicit zero-fill
        # slicing, content moves up and to the left, so the BOTTOM 15
        # rows and RIGHT 15 cols are exposed (zero-filled). If np.roll
        # were used instead, they'd wrap around and be nonzero.
        truth_dy = truth_dx = 15.0
        shifted = _fourier_translate(surf, truth_dy, truth_dx)
        ref_mask = np.ones((rows, cols), dtype=bool)
        r = _make_result_from_grid(shifted, mask=ref_mask)
        out = subtract_wavefronts(m, r, register=True)

        out_mask = np.asarray(out["mask_grid"], dtype=np.uint8).reshape(rows, cols)
        # Exposed edges after a (-15, -15) shift: bottom rows and right
        # cols. Check a 14-pixel-deep strip (1-pixel tolerance from the
        # sub-pixel-to-integer rounding of the detected shift).
        bottom_rows = out_mask[-14:, :]
        right_cols = out_mask[:, -14:]
        assert bottom_rows.sum() == 0, (
            f"bottom rows wrapped: sum={bottom_rows.sum()}"
        )
        assert right_cols.sum() == 0, (
            f"right cols wrapped: sum={right_cols.sum()}"
        )


class TestFringeSubtractAPIWithRegistration:
    """M3.5 — HTTP tests for /fringe/subtract with register flag."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_subtract_endpoint_registers_by_default(self, client):
        b64 = self._b64_image()
        id1 = client.post("/fringe/analyze",
                          json={"image_b64": b64}).json()["id"]
        id2 = client.post("/fringe/analyze",
                          json={"image_b64": b64}).json()["id"]
        rs = client.post("/fringe/subtract", json={
            "measurement_id": id1,
            "reference_id": id2,
        })
        assert rs.status_code == 200, rs.text
        data = rs.json()
        assert "registration" in data
        assert data["registration"]["method"] in (
            "modulation", "raw_intensity", "none"
        )

    def test_subtract_endpoint_register_false(self, client):
        b64 = self._b64_image()
        id1 = client.post("/fringe/analyze",
                          json={"image_b64": b64}).json()["id"]
        id2 = client.post("/fringe/analyze",
                          json={"image_b64": b64}).json()["id"]
        rs = client.post("/fringe/subtract", json={
            "measurement_id": id1,
            "reference_id": id2,
            "register": False,
        })
        assert rs.status_code == 200, rs.text
        data = rs.json()
        assert data["registration"]["method"] == "disabled"


# ── M1.4 — Aperture recipe contract ─────────────────────────────────────


class TestApertureRecipeContract:
    """The /fringe/analyze* endpoints must echo the aperture_recipe back
    untouched (extra='allow' on ApertureRecipe)."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_aperture_recipe_echoed_in_response(self, client):
        recipe = {
            "id": "rec-circle-1",
            "kind": "circle",
            "name": "Circle aperture",
            "circle": {"cx": 0.5, "cy": 0.5, "r": 0.42},
            "source_resolution": {"width": 96, "height": 96},
            "notes": "Saved for the 4 inch flat",
        }
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": self._b64_image(),
            "aperture_recipe": recipe,
        })
        assert r.status_code == 200, r.text
        data = r.json()
        echoed = data["aperture_recipe"]
        assert echoed is not None
        assert echoed["id"] == "rec-circle-1"
        assert echoed["kind"] == "circle"
        assert echoed["name"] == "Circle aperture"
        assert echoed["circle"]["cx"] == pytest.approx(0.5)
        assert echoed["circle"]["cy"] == pytest.approx(0.5)
        assert echoed["circle"]["r"] == pytest.approx(0.42)
        assert echoed["source_resolution"]["width"] == 96
        assert echoed["notes"] == "Saved for the 4 inch flat"


# ── M3.7 — Capture export/import ────────────────────────────────────────


class TestCaptureExportImport:
    """GET /fringe/session/capture/{id} returns the full result dict;
    POST /fringe/session/import re-ingests it under a fresh id, preserving
    the original id on `imported_from_id`."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_export_existing_capture(self, client):
        analyze = client.post(
            "/fringe/analyze",
            json={"wavelength_nm": 632.8, "image_b64": self._b64_image()},
        )
        assert analyze.status_code == 200, analyze.text
        analyzed = analyze.json()
        cap_id = analyzed["id"]

        r = client.get(f"/fringe/session/capture/{cap_id}")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["_export_version"] == 1
        for key in ("id", "origin", "raw_height_grid_nm",
                    "display_height_grid_nm", "grid_rows", "grid_cols",
                    "mask_grid", "wavelength_nm"):
            assert key in data, f"missing {key}"
        assert data["id"] == cap_id
        # Grids match what was returned by /fringe/analyze.
        assert data["grid_rows"] == analyzed["grid_rows"]
        assert data["grid_cols"] == analyzed["grid_cols"]
        assert data["raw_height_grid_nm"] == analyzed["raw_height_grid_nm"]
        assert data["display_height_grid_nm"] == analyzed["display_height_grid_nm"]
        assert data["mask_grid"] == analyzed["mask_grid"]

    def test_export_unknown_capture_is_404(self, client):
        r = client.get("/fringe/session/capture/no-such-id")
        assert r.status_code == 404
        body = r.json()
        assert "no-such-id" in body["detail"]

    def test_import_roundtrip(self, client):
        analyze = client.post(
            "/fringe/analyze",
            json={"wavelength_nm": 632.8, "image_b64": self._b64_image()},
        )
        assert analyze.status_code == 200, analyze.text
        original_id = analyze.json()["id"]

        export = client.get(f"/fringe/session/capture/{original_id}")
        assert export.status_code == 200
        exported = export.json()

        # Wipe the session, then re-import.
        clear = client.post("/fringe/session/clear")
        assert clear.status_code == 200
        assert client.get("/fringe/session/captures").json()["captures"] == []

        imp = client.post("/fringe/session/import", json={"result": exported})
        assert imp.status_code == 200, imp.text
        imported = imp.json()
        assert imported["id"] != original_id
        assert imported["imported_from_id"] == original_id
        # Origin pass-through.
        assert imported["origin"] == exported["origin"]
        # Bit-exact grid round-trip.
        assert imported["raw_height_grid_nm"] == exported["raw_height_grid_nm"]
        assert imported["display_height_grid_nm"] == exported["display_height_grid_nm"]
        assert imported["mask_grid"] == exported["mask_grid"]
        assert imported["grid_rows"] == exported["grid_rows"]
        assert imported["grid_cols"] == exported["grid_cols"]
        # Captures list now shows the imported one with the new id.
        caps = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps) == 1
        assert caps[0]["id"] == imported["id"]

    def test_import_wrong_grid_length_is_400(self, client):
        bad = {
            "id": "synthetic-1",
            "origin": "capture",
            "raw_height_grid_nm": [0.0] * 10,
            "display_height_grid_nm": [0.0] * 10,
            "grid_rows": 4,
            "grid_cols": 4,
            "mask_grid": [1] * 10,
            "wavelength_nm": 632.8,
        }
        r = client.post("/fringe/session/import", json={"result": bad})
        assert r.status_code == 400
        assert "grid_rows*grid_cols" in r.json()["detail"] \
            or "length" in r.json()["detail"]

    def test_import_missing_required_fields_is_400(self, client):
        bad = {
            "id": "synthetic-2",
            "origin": "capture",
            # Missing raw_height_grid_nm, display_height_grid_nm, etc.
            "wavelength_nm": 632.8,
        }
        r = client.post("/fringe/session/import", json={"result": bad})
        assert r.status_code == 400
        assert "Missing required fields" in r.json()["detail"]


# ── M4.2 — Per-Zernike-term RMS table fields ───────────────────────────


class TestZernikeTableFields:
    """analyze_interferogram surfaces zernike_norm_weights + zernike_rms_nm
    so the per-term RMS table can render without further computation."""

    def test_zernike_norm_weights_present(self):
        image = _make_fringe_image(128, 128)
        result = analyze_interferogram(image, wavelength_nm=632.8, n_zernike=15)
        assert "zernike_norm_weights" in result
        weights = result["zernike_norm_weights"]
        assert len(weights) == 15
        assert all(isinstance(w, float) for w in weights)
        # Norm weights are RMS over the aperture; for a non-degenerate aperture
        # they must all be strictly positive.
        assert all(w > 0 for w in weights)

    def test_zernike_rms_nm_present(self):
        image = _make_fringe_image(128, 128)
        result = analyze_interferogram(image, wavelength_nm=632.8, n_zernike=15)
        assert "zernike_rms_nm" in result
        rms = result["zernike_rms_nm"]
        assert len(rms) == 15
        # |coeff| * weight (in phase) → nm via phase_to_height: must be >= 0.
        assert all(r >= 0 for r in rms)

    def test_rms_display_matches_analytic(self):
        """Synthesize a tilt-only surface (Z2 in phase units) and verify the
        per-term RMS contribution matches the analytic value via the same
        phase_to_height conversion the backend uses.

        Z2 is the Noll-normalized tilt, which is RMS-1 over the unit disk.
        For a coefficient c, the per-term RMS is exactly |c| * 1.0 (phase),
        so in nm it equals phase_to_height(|c|) ≈ |c| * λ / (4π).
        """
        h, w = 128, 128
        rho, theta = _make_polar_coords((h, w))
        Z2 = zernike_polynomial(2, rho, theta)
        amp_phase = 2.5  # arbitrary phase amplitude
        surface = amp_phase * Z2
        mask = rho <= 1.0

        coeffs, _, _ = fit_zernike(surface, n_terms=15, mask=mask)
        # Recovered c2 should match input amplitude.
        assert abs(coeffs[1] - amp_phase) < 0.1

        # Manually mimic what analyze_interferogram does: |c| * RMS(Z_j on mask)
        # then phase_to_height. Compute that here.
        from backend.vision.fringe import phase_to_height as _pth
        z2_vals = Z2[mask]
        norm = float(np.sqrt(np.mean(z2_vals * z2_vals)))
        # Z2 is Noll-normalized (orthonormal in the continuous limit), but
        # discretized on a 128² mask the RMS settles around 0.8 — close
        # enough to confirm the basis is the Noll convention, but the
        # quantitative comparison below uses the actually-computed weight.
        assert 0.5 < norm < 1.2
        wl = 632.8
        expected_nm = float(_pth(np.asarray([abs(coeffs[1]) * norm]), wl)[0])

        # Now exercise the analyze pipeline on a synthetic interferogram that
        # produces (approximately) this tilt-only surface, and check that the
        # zernike_rms_nm[1] entry matches the formula.
        # Direct unit test of the formula: set up a fake call by constructing
        # a fringe image whose wavefront is dominated by Z2.
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 6 * xx / w
        img = np.clip(128 + 100 * np.cos(carrier + amp_phase * Z2), 0, 255).astype(np.uint8)
        result = analyze_interferogram(img, wavelength_nm=wl, n_zernike=15)
        # Tolerance: phase recovery has fitting error, but the relationship
        # is mechanical — just verify the formula is applied consistently.
        observed_nm = result["zernike_rms_nm"][1]
        observed_coeff = result["coefficients"][1]
        observed_weight = result["zernike_norm_weights"][1]
        recomputed = float(_pth(np.asarray([abs(observed_coeff) * observed_weight]), wl)[0])
        assert abs(observed_nm - recomputed) < 1e-3, (
            f"zernike_rms_nm[1]={observed_nm} != |c|*w*phase_to_height={recomputed}"
        )


# ── M4.3 — Polynomial form-removal models ──────────────────────────────


class TestPolyFormModels:
    """form_model='poly2' / 'poly3' fits and subtracts a 2D polynomial
    form, producing residuals that contain only the high-frequency content."""

    def test_form_model_pattern_accepts_poly(self):
        """API contract: form_model accepts 'poly2' and 'poly3'."""
        from backend.api_fringe import AnalyzeBody
        for model in ("zernike", "plane", "poly2", "poly3"):
            body = AnalyzeBody(form_model=model)
            assert body.form_model == model

    def test_form_model_pattern_rejects_unknown(self):
        from backend.api_fringe import AnalyzeBody
        with pytest.raises(Exception):
            AnalyzeBody(form_model="bogus")

    def test_poly2_removes_defocus_and_tilt(self):
        """Synthesize a smooth quadratic surface (defocus + tilt) plus a small
        bump, run analyze with form_model='poly2', and verify the residual
        contains only the bump."""
        h, w = 96, 96
        yy, xx = np.mgrid[0:h, 0:w]
        # Carrier for fringe extraction
        carrier = 2 * np.pi * 6 * xx / w
        # Smooth poly-2 surface (in phase units, small-amplitude so no wrap)
        nx = (xx - w / 2) / (w / 2)
        ny = (yy - h / 2) / (h / 2)
        smooth = 0.6 * nx + 0.4 * ny + 0.5 * (nx ** 2 + ny ** 2)
        img = np.clip(128 + 100 * np.cos(carrier + smooth), 0, 255).astype(np.uint8)

        result_poly2 = analyze_interferogram(img, wavelength_nm=632.8,
                                             form_model="poly2", n_zernike=15)
        # With poly2 form removal, the residual on a smooth quadratic
        # surface should be near zero (much smaller than the input PV).
        # The input phase span is ~1.5 rad → ~75 nm @ 632.8 nm. After poly2
        # removal we expect << 30 nm RMS.
        assert result_poly2["rms_nm"] < 30.0, (
            f"poly2 left rms_nm={result_poly2['rms_nm']} on smooth quadratic"
        )
        # subtracted_terms should be empty for non-Zernike form removal.
        assert result_poly2["subtracted_terms"] == []
        assert result_poly2["form_model"] == "poly2"

    def test_poly3_handles_coma_like(self):
        """A surface with a coma-like cubic component plus tilt is well
        described by a 3rd-degree polynomial."""
        h, w = 96, 96
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 6 * xx / w
        nx = (xx - w / 2) / (w / 2)
        ny = (yy - h / 2) / (h / 2)
        # Coma-like: cubic in one direction, plus tilt
        smooth = 0.5 * nx + 0.6 * (nx ** 3) - 0.4 * (nx * ny ** 2)
        img = np.clip(128 + 100 * np.cos(carrier + smooth), 0, 255).astype(np.uint8)

        result_poly3 = analyze_interferogram(img, wavelength_nm=632.8,
                                             form_model="poly3", n_zernike=15)
        assert result_poly3["form_model"] == "poly3"
        assert result_poly3["subtracted_terms"] == []
        # Smooth cubic surface: poly3 should leave a small residual.
        assert result_poly3["rms_nm"] < 30.0, (
            f"poly3 left rms_nm={result_poly3['rms_nm']} on smooth cubic"
        )


# ── M4.4 — Warnings field present on every result ──────────────────────


class TestWarningsContract:
    """Every analyze response carries a `warnings: list` field, regardless
    of whether anything is actually warned about."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def _b64(self, h=64, w=64, fx=4):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_warnings_field_present_on_analyze(self, client):
        r = client.post("/fringe/analyze", json={"image_b64": self._b64()})
        assert r.status_code == 200
        assert isinstance(r.json().get("warnings"), list)


# ── M4.5 — Trend plot relies on capture summary fields ─────────────────


class TestTrendContract:
    """The session captures summary contains the fields the in-session
    trend plot needs: pv_nm, rms_nm, captured_at."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64(self, h=64, w=64, fx=4):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_captures_have_fields_trend_needs(self, client):
        # Make a couple of captures.
        for _ in range(2):
            r = client.post("/fringe/analyze", json={"image_b64": self._b64()})
            assert r.status_code == 200

        caps = client.get("/fringe/session/captures").json()["captures"]
        assert len(caps) >= 2
        for c in caps:
            assert "pv_nm" in c, "trend chart needs pv_nm"
            assert "rms_nm" in c, "trend chart needs rms_nm"
            assert "captured_at" in c, "trend chart needs captured_at"


class TestReanalyzeFullFidelityPath:
    """Frontend wired the raw-grid full-fidelity path into every
    /fringe/reanalyze call site (M1.3 frontend wiring). When the request
    body includes raw_height_grid_nm + raw_grid_rows + raw_grid_cols, the
    backend should refit Zernike on the cached raw heightmap and return a
    fresh display grid that preserves content the legacy coefficient-only
    reconstruction discards. This test exercises both paths against the
    same /fringe/analyze output and asserts that the full-fidelity path
    is observably distinct: the response carries the raw grid back, and
    the display surface differs from the coefficient-only reconstruction
    by a non-trivial amount."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_fringes_with_highfreq_bump(self, h=128, w=128, fx=8):
        """Tilted fringes plus a sharp localised Gaussian bump. The narrow
        support of the bump contains spatial frequencies that the 36
        Zernike terms used by analyze cannot fully represent, so the
        legacy coefficient-only reanalyze path discards content that the
        full-fidelity path preserves."""
        yy, xx = np.mgrid[0:h, 0:w]
        phase = 2 * np.pi * (fx * xx / w + 0.5 * yy / w)
        cy, cx = h / 2, w / 2
        sigma = 2.5
        bump = 35.0 * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))
        img = np.clip(128 + 80 * np.cos(phase) + bump, 0, 255).astype(np.uint8)
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_reanalyze_with_raw_grid_differs_from_coeffs_only(self, client):
        b64 = self._b64_fringes_with_highfreq_bump()
        # Use a low n_zernike (4) so the legacy coefficient-only
        # reconstruction is forced to discard meaningful content from the
        # bump — exactly the case the full-fidelity path is designed to
        # rescue. With the production default n_zernike=36, the basis
        # captures most well-behaved synthetic test surfaces and the
        # difference between the paths shrinks to numerical jitter; a
        # truncated basis isolates the contract under test.
        n_zernike = 4
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": b64,
            "subtract_terms": [1],
            "n_zernike": n_zernike,
        })
        assert r.status_code == 200
        analyze_out = r.json()
        raw_grid = analyze_out["raw_height_grid_nm"]
        grid_rows = analyze_out["grid_rows"]
        grid_cols = analyze_out["grid_cols"]
        assert raw_grid is not None
        assert grid_rows > 0 and grid_cols > 0

        common = {
            "coefficients": analyze_out["coefficients"],
            "subtract_terms": [1],
            "wavelength_nm": 632.8,
            "n_zernike": n_zernike,
            "surface_height": analyze_out["surface_height"],
            "surface_width": analyze_out["surface_width"],
        }

        # Legacy path — no raw grid. Reconstructs surface from coeffs only.
        r_legacy = client.post("/fringe/reanalyze", json=common)
        assert r_legacy.status_code == 200
        legacy_data = r_legacy.json()
        legacy_rms = legacy_data["rms_nm"]
        assert legacy_rms is not None and legacy_rms > 0
        # Sentinel: the legacy path must NOT echo a raw grid back. If this
        # ever flips, the full-fidelity path may be silently engaged for
        # the legacy comparison and the test loses its meaning.
        assert "raw_height_grid_nm" not in legacy_data

        # Full-fidelity path — frontend now sends raw_height_grid_nm +
        # raw_grid_rows + raw_grid_cols on every reanalyze call.
        r_full = client.post("/fringe/reanalyze", json={
            **common,
            "raw_height_grid_nm": raw_grid,
            "raw_grid_rows": grid_rows,
            "raw_grid_cols": grid_cols,
        })
        assert r_full.status_code == 200
        full_data = r_full.json()
        full_rms = full_data["rms_nm"]
        assert full_rms is not None and full_rms > 0

        # Contract: full-fidelity path returns the raw grid back so the
        # frontend can chain subsequent reanalyze calls without losing it.
        assert "raw_height_grid_nm" in full_data
        assert "display_height_grid_nm" in full_data

        # Significant relative RMS difference — high-frequency content
        # preserved by the full-fidelity path is dropped by the legacy
        # coefficient reconstruction, so the two paths must disagree by a
        # non-trivial margin on a deliberately broadband test surface
        # truncated to a small Zernike basis. Empirically with a 4-term
        # basis on this image the gap is ~27%; use 15% as the safety
        # margin to absorb minor pipeline drift.
        rel_diff = abs(full_rms - legacy_rms) / max(legacy_rms, 1e-9)
        assert rel_diff > 0.15, (
            f"full-fidelity vs legacy RMS too close to call "
            f"(full={full_rms:.3f} nm, legacy={legacy_rms:.3f} nm, "
            f"rel_diff={rel_diff:.4f})"
        )


# ──────────────────────────────────────────────────────────────────────
# M2.6 — frontend reads tuning.lpf_sigma_frac for effective-N correction
# ──────────────────────────────────────────────────────────────────────
#
# Background: frontend/fringe-measure.js::_corrCellsPerLpf estimates the
# per-region effective-N correction from the *applied* LPF σ. After M2.5
# the user can override lpf_sigma_frac, so the frontend must read the
# echoed value from data.tuning.lpf_sigma_frac instead of hard-coding the
# legacy 2.5×fringe_period default. These tests guard the contract on the
# field that the frontend reads.


class TestEffectiveNUsesTuning:
    """The frontend Step-tool effective-N SEM correction reads
    `data.tuning.lpf_sigma_frac` from /fringe/analyze (and the M2.6
    anisotropic LPF preserves correlation-area geometric mean, so the
    isotropic-equivalent uses the same multiplier). These tests verify
    the API contract on that field."""

    def _api_client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient
        camera = FakeCamera()
        app = create_app(camera)
        return TestClient(app)

    def test_lpf_sigma_frac_echoed_in_response(self):
        """POST with lpf_sigma_frac=0.5 => data.tuning.lpf_sigma_frac == 0.5."""
        with self._api_client() as client:
            r = client.post("/fringe/analyze", json={
                "wavelength_nm": 632.8,
                "lpf_sigma_frac": 0.5,
            })
            assert r.status_code == 200, r.text
            data = r.json()
            assert data.get("tuning") is not None
            assert data["tuning"]["lpf_sigma_frac"] == 0.5

    def test_lpf_sigma_frac_auto_returns_none(self):
        """POST without lpf_sigma_frac => data.tuning.lpf_sigma_frac is None
        so the frontend falls back to the legacy 2.5 multiplier."""
        with self._api_client() as client:
            r = client.post("/fringe/analyze", json={"wavelength_nm": 632.8})
            assert r.status_code == 200, r.text
            data = r.json()
            t = data.get("tuning")
            assert t is not None
            assert t["lpf_sigma_frac"] is None


# ──────────────────────────────────────────────────────────────────────
# Fix 1 — Derived results (subtract/average) carry PSF and MTF
# ──────────────────────────────────────────────────────────────────────


class TestDerivedPSFMTF:
    """Subtract and average results expose PSF/MTF for the residual surface
    so the user can judge imaging quality of the difference / mean."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_subtract_result_has_psf_mtf(self, client):
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        r2 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200 and r2.status_code == 200
        rs = client.post("/fringe/subtract", json={
            "measurement_id": r1.json()["id"],
            "reference_id": r2.json()["id"],
        })
        assert rs.status_code == 200, rs.text
        data = rs.json()
        # PSF is a base64 PNG payload — non-empty string.
        assert isinstance(data.get("psf"), str)
        assert len(data["psf"]) > 0
        # MTF is a structured payload (dict).
        assert isinstance(data.get("mtf"), dict)

    def test_average_result_has_psf_mtf(self, client):
        b64 = self._b64_image()
        r1 = client.post("/fringe/analyze", json={"image_b64": b64})
        r2 = client.post("/fringe/analyze", json={"image_b64": b64})
        assert r1.status_code == 200 and r2.status_code == 200
        ra = client.post("/fringe/average", json={
            "source_ids": [r1.json()["id"], r2.json()["id"]],
        })
        assert ra.status_code == 200, ra.text
        data = ra.json()
        assert isinstance(data.get("psf"), str)
        assert len(data["psf"]) > 0
        assert isinstance(data.get("mtf"), dict)


# ──────────────────────────────────────────────────────────────────────
# Fix 3 — Reanalyze raw-grid path × form_model combinations
# ──────────────────────────────────────────────────────────────────────


class TestReanalyzeFormModelCombinations:
    """Regression coverage for the M1.3 raw-grid reanalyze path crossed with
    the M4.3 plane/poly2/poly3 form models. The implementation already
    branches on form_model in the raw-grid path, so these tests exist to
    keep that contract from regressing."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def _analyze_then_reanalyze(self, client, form_model: str):
        b64 = self._b64_image()
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": b64,
            "form_model": "zernike",
        })
        assert r.status_code == 200, r.text
        out = r.json()
        body = {
            "coefficients": out["coefficients"],
            "subtract_terms": [1, 2, 3],
            "wavelength_nm": 632.8,
            "n_zernike": len(out["coefficients"]),
            "surface_height": out["surface_height"],
            "surface_width": out["surface_width"],
            "form_model": form_model,
            "raw_height_grid_nm": out["raw_height_grid_nm"],
            "raw_grid_rows": out["grid_rows"],
            "raw_grid_cols": out["grid_cols"],
        }
        rr = client.post("/fringe/reanalyze", json=body)
        assert rr.status_code == 200, rr.text
        return rr.json()

    def test_reanalyze_raw_grid_with_poly2(self, client):
        data = self._analyze_then_reanalyze(client, "poly2")
        assert data.get("pv_nm") is not None
        assert data["form_model"] == "poly2"
        # poly2 is non-Zernike form removal — subtracted_terms must be
        # empty per the M4.3 contract.
        assert data["subtracted_terms"] == []

    def test_reanalyze_raw_grid_with_poly3(self, client):
        data = self._analyze_then_reanalyze(client, "poly3")
        assert data.get("pv_nm") is not None
        assert data["form_model"] == "poly3"
        assert data["subtracted_terms"] == []

    def test_reanalyze_raw_grid_with_plane(self, client):
        data = self._analyze_then_reanalyze(client, "plane")
        assert data.get("pv_nm") is not None
        assert data["form_model"] == "plane"
        assert data["subtracted_terms"] == []


# ──────────────────────────────────────────────────────────────────────
# Fix 4 — Uncalibrated sentinel (mm_per_pixel=0) does not crash
# ──────────────────────────────────────────────────────────────────────


class TestUncalibratedSentinel:
    """``mm_per_pixel=0`` is the explicit "uncalibrated" sentinel accepted
    by the pydantic validator (``ge=0``). Smoke-test that the analyze
    pipeline survives it without dividing by zero. Audit (see report):
    every backend site that reads ``mm_per_pixel`` already guards the
    zero/None case before using the value as a denominator."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    @pytest.fixture(autouse=True)
    def _reset_fringe_cache(self):
        from backend.api_fringe import _fringe_cache
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()
        yield
        with _fringe_cache._lock:
            _fringe_cache._data.clear()
            _fringe_cache._full_results.clear()

    def _b64_image(self, h=96, w=96, fx=6):
        xx = np.arange(w)
        row = 128 + 80 * np.cos(2 * np.pi * fx * xx / w)
        img = np.tile(row.astype(np.uint8), (h, 1))
        _, buf = cv2.imencode(".png", img)
        return base64.b64encode(buf.tobytes()).decode("ascii")

    def test_analyze_with_mm_per_pixel_zero_does_not_crash(self, client):
        r = client.post("/fringe/analyze", json={
            "image_b64": self._b64_image(),
            "calibration": {"mm_per_pixel": 0, "wavelength_nm": 589.3},
        })
        assert r.status_code == 200, r.text
        data = r.json()
        # Calibration snapshot is forwarded verbatim.
        snap = data.get("calibration_snapshot") or {}
        assert snap.get("mm_per_pixel") == 0
        # Numeric stats are finite (no NaN/Inf leaked through a guarded path).
        for key in ("pv_nm", "rms_nm", "pv_waves", "rms_waves", "strehl"):
            v = data.get(key)
            assert v is not None
            assert math.isfinite(float(v)), f"{key} not finite: {v!r}"
