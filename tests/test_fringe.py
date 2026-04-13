"""Tests for fringe analysis vision module."""
import math
import numpy as np
import pytest

from backend.vision.fringe import (
    ZERNIKE_NAMES,
    fit_zernike,
    subtract_zernike,
    zernike_basis,
    zernike_noll_index,
    zernike_polynomial,
    _make_polar_coords,
)


class TestZernikeNollIndex:
    def test_first_few_indices(self):
        assert zernike_noll_index(1) == (0, 0)   # Piston
        assert zernike_noll_index(2) == (1, 1)   # Tilt X
        assert zernike_noll_index(3) == (1, -1)  # Tilt Y
        assert zernike_noll_index(4) == (2, 0)   # Defocus

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
