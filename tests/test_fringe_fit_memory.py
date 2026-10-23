"""All-pixel bounded-memory fitting agrees with the dense least-squares oracle."""
import numpy as np
import pytest
from backend.vision import fringe as f


@pytest.mark.parametrize('aperture', ['full', 'circle', 'clipped', 'ring', 'line', 'few'])
def test_block_fit_matches_dense(monkeypatch, aperture):
    y, x = np.mgrid[:61, :73]
    radius = np.hypot(x - 36, y - 30)
    mask = {'full': None, 'circle': radius < 29,
            'clipped': (radius < 29) & (x > 31),
            'ring': (radius < 29) & (radius > 24),
            'line': y == 30, 'few': (x == 30) & (y < 5)}[aperture]
    surface = .3 * np.sin(x / 8) + .1 * np.cos(y / 7)
    surface += np.random.default_rng(123).normal(0, .001, x.shape)
    rho, theta = f._make_polar_coords(surface.shape, mask)
    basis = f.zernike_basis(36, rho, theta, mask)
    values = surface.ravel() if mask is None else surface[mask]
    expected = np.linalg.lstsq(basis, values, rcond=None)[0]
    monkeypatch.setattr(f, '_DENSE_FIT_MAX_ELEMENTS', 0)
    monkeypatch.setattr(f, '_FIT_BLOCK_ROWS', 97)
    actual, _, _ = f.fit_zernike(surface, mask=mask)
    np.testing.assert_allclose(actual, expected, rtol=2e-7, atol=2e-8)
    np.testing.assert_allclose(basis @ actual, basis @ expected, rtol=2e-8, atol=2e-9)


def test_large_fit_bounds_matrix_rows_and_uses_every_pixel(monkeypatch):
    basis_fn = f.zernike_basis
    solve = np.linalg.lstsq
    rows = []
    def bounded_basis(n, rho, theta, mask=None):
        assert rho.size <= f._FIT_BLOCK_ROWS
        rows.append(rho.size)
        return basis_fn(n, rho, theta, mask)
    def bounded_solve(a, b, **kw):
        assert a.shape[0] <= 36
        return solve(a, b, **kw)
    monkeypatch.setattr(f, 'zernike_basis', bounded_basis)
    monkeypatch.setattr(np.linalg, 'lstsq', bounded_solve)
    y, x = np.mgrid[:201, :213]
    surface = 3.0 + x / 50 - y / 40
    actual, rho, theta = f.fit_zernike(surface)
    assert sum(rows) == surface.size
    reconstructed = sum(c * f.zernike_polynomial(j, rho, theta)
                        for j, c in enumerate(actual, 1))
    np.testing.assert_allclose(reconstructed, surface, atol=1e-11)
