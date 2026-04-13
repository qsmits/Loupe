"""Tests for fringe analysis vision module."""
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
    def test_uniform_image_low_modulation(self):
        """A uniform gray image should have very low modulation everywhere."""
        img = np.full((100, 100), 128.0)
        mod = compute_fringe_modulation(img)
        assert mod.shape == (100, 100)
        assert mod.max() < 0.05

    def test_fringe_image_high_modulation(self):
        """An image with sinusoidal fringes should have high modulation."""
        x = np.linspace(0, 20 * np.pi, 200)
        img = 128.0 + 100.0 * np.sin(x[None, :]) * np.ones((100, 1))
        mod = compute_fringe_modulation(img)
        # Center region should have high modulation
        center_mod = mod[30:70, 30:170].mean()
        assert center_mod > 0.2


class TestFringeMask:
    def test_mask_rejects_uniform_region(self):
        """Uniform region should be masked out."""
        mod = np.zeros((100, 100))
        mod[20:80, 20:80] = 1.0  # Only center has fringes
        mask = create_fringe_mask(mod, threshold_frac=0.15)
        assert mask[50, 50] == True   # Center is valid
        assert mask[5, 5] == False    # Corner is masked

    def test_mask_all_zeros(self):
        """All-zero modulation should produce all-False mask."""
        mod = np.zeros((50, 50))
        mask = create_fringe_mask(mod, threshold_frac=0.15)
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
        unwrapped = unwrap_phase_2d(wrapped)
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
        unwrapped = unwrap_phase_2d(wrapped)
        # Should be smooth: no jumps > pi between adjacent pixels
        diff_x = np.abs(np.diff(unwrapped, axis=1))
        assert diff_x.max() < np.pi + 0.1

    def test_mask_zeros_invalid(self):
        phase = np.zeros((50, 50))
        mask = np.ones((50, 50), dtype=bool)
        mask[0:10, :] = False
        unwrapped = unwrap_phase_2d(phase, mask)
        assert unwrapped[5, 25] == 0.0  # masked pixel is zeroed


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
