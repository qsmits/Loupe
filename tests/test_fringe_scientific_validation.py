"""Independent numerical checks; see docs/fringe-scientific-basis.md.

Reference phases and intensities use analytic functions, not Loupe's forward
helpers. scikit-image is a separate reference for the default heap flood;
SciPy's Jacobi polynomials independently evaluate the radial Zernike basis.
These tests establish synthetic software behavior, not instrument accuracy.
"""
import inspect

import numpy as np
import pytest
from scipy.ndimage import binary_erosion, label
from scipy.special import eval_jacobi, roots_legendre
from skimage.restoration import unwrap_phase

from backend.vision import fringe as f


# Explicit Noll table through radial order 7; independent of Loupe's index loop.
NOLL = [
    (0, 0), (1, 1), (1, -1), (2, 0), (2, -2), (2, 2),
    (3, -1), (3, 1), (3, -3), (3, 3), (4, 0), (4, 2),
    (4, -2), (4, 4), (4, -4), (5, 1), (5, -1), (5, 3),
    (5, -3), (5, 5), (5, -5), (6, 0), (6, -2), (6, 2),
    (6, -4), (6, 4), (6, -6), (6, 6), (7, -1), (7, 1),
    (7, -3), (7, 3), (7, -5), (7, 5), (7, -7), (7, 7),
]


def reference_zernike(n, m, rho, theta):
    """Jacobi identity, distinct from the production factorial expansion."""
    radial = rho**abs(m) * eval_jacobi((n - abs(m)) // 2, 0, abs(m), 2*rho**2 - 1)
    if m == 0:
        return np.sqrt(n + 1) * radial
    angular = np.cos(m*theta) if m > 0 else np.sin(-m*theta)
    return np.sqrt(2*(n + 1)) * radial * angular


@pytest.mark.parametrize('j,nm', enumerate(NOLL, 1))
def test_noll_order_and_jacobi_reference(j, nm):
    rng = np.random.default_rng(42)
    rho, theta = rng.uniform(0, 1, 301), rng.uniform(-np.pi, np.pi, 301)
    assert f.zernike_noll_index(j) == nm
    np.testing.assert_allclose(f.zernike_polynomial(j, rho, theta),
                               reference_zernike(*nm, rho, theta), atol=2e-13)


def test_noll_unit_disk_orthonormality_by_quadrature():
    # Integrate r dr dtheta / pi exactly to this polynomial order.
    nodes, weights = roots_legendre(24)
    rho = np.sqrt((nodes[:, None] + 1) / 2)
    theta = np.arange(64)[None, :] * 2*np.pi / 64
    modes = np.array([f.zernike_polynomial(j, rho, theta) + np.zeros_like(theta)
                      for j in range(1, 37)])
    gram = np.einsum('irt,jrt,r->ij', modes, modes, weights / (2*64))
    np.testing.assert_allclose(gram, np.eye(36), atol=2e-13)


@pytest.mark.parametrize('aperture', ['disk', 'clipped', 'rectangle', 'annulus'])
def test_fit_and_term_weights_on_nonorthogonal_apertures(aperture):
    y, x = np.mgrid[:80, :96]
    dx, dy = x - 48., 40. - y
    mask = dx*dx + dy*dy <= 35**2
    if aperture == 'clipped':
        mask &= dx >= -9
    elif aperture == 'rectangle':
        mask = (abs(dx) <= 30) & (abs(dy) <= 22)
    elif aperture == 'annulus':
        mask &= dx*dx + dy*dy >= 17**2
    # Published Loupe coordinate convention: image center, Cartesian Y up,
    # normalization to the furthest valid pixel. Do not call its coord helper.
    rho = np.hypot(dx, dy) / np.hypot(dx, dy)[mask].max()
    theta = np.arctan2(dy, dx)
    basis = np.array([reference_zernike(*nm, rho, theta) for nm in NOLL[:15]])
    expected = np.array([.7, -.2, .13, .4, -.1, .25, .12, -.07, .08, .09, .2, .03, -.04, .02, .01])
    surface = np.einsum('i,iyx->yx', expected, basis)
    coeffs, r, t = f.fit_zernike(surface, n_terms=15, mask=mask)
    np.testing.assert_allclose(coeffs, expected, atol=2e-11)
    residual = f.subtract_zernike(surface, coeffs, [1, 2, 3, 4], r, t, mask)
    np.testing.assert_allclose(residual[mask], np.einsum('i,iyx->yx', expected[4:], basis[4:])[mask], atol=2e-11)
    weights, rms_nm = f._zernike_term_metrics(coeffs, r, t, mask, 632.8)
    reference_weights = np.sqrt(np.mean(basis[:, mask]**2, axis=1))
    np.testing.assert_allclose(weights, reference_weights, atol=2e-13)
    np.testing.assert_allclose(rms_nm, abs(expected) * reference_weights * 632.8/(4*np.pi), atol=2e-11)
    if aperture == 'clipped':
        # Individual modal RMS values must not be combined in quadrature on
        # a clipped pupil: cross terms are real, not a fitting error.
        total_rms = np.sqrt(np.mean(surface[mask]**2))
        assert abs(total_rms - np.linalg.norm(expected * reference_weights)) > .05


def unwrap_scene(aperture, noisy=False):
    y, x = np.mgrid[:96, :128]
    mask = (x - 64)**2 + (y - 48)**2 < 40**2
    if aperture == 'annulus':
        mask &= (x - 64)**2 + (y - 48)**2 > 34**2
    elif aperture == 'thin':
        mask &= abs(y - 48) < 3
    elif aperture == 'hole':
        mask &= (x - 55)**2 + (y - 40)**2 > 12**2
    elif aperture == 'disconnected':
        mask &= abs(x - 64) > 7
    truth = .22*x + .08*y + .2*np.sin(y/12)
    quality = .15 + .85*np.exp(-((x-80)**2 + (y-40)**2)/500)
    noise = np.random.default_rng(91).normal(0, .025/quality, mask.shape) if noisy else 0
    wrapped = np.angle(np.exp(1j*(truth + noise)))
    return truth, noise, wrapped, mask, quality


def component_errors(actual, truth, mask):
    """Remove only one piston per connected component, never local orders."""
    components, count = label(mask)
    errors = np.zeros_like(truth)
    for i in range(1, count + 1):
        valid = components == i
        diff = actual[valid] - truth[valid]
        errors[valid] = diff - np.median(diff)
    return errors[mask]


@pytest.mark.parametrize('aperture', ['disk', 'annulus', 'thin', 'hole', 'disconnected'])
@pytest.mark.parametrize('noisy', [False, True])
@pytest.mark.parametrize('correct', [False, True])
def test_unwrap_against_independent_reference(aperture, noisy, correct, record_property):
    truth, noise, wrapped, mask, quality = unwrap_scene(aperture, noisy)
    # scikit-image 0.24 used `seed`; newer supported versions use `rng`.
    random_keyword = 'rng' if 'rng' in inspect.signature(unwrap_phase).parameters else 'seed'
    reference = np.asarray(unwrap_phase(np.ma.array(wrapped, mask=~mask), **{random_keyword: 0}))
    actual, risk, _ = f.unwrap_phase_2d(wrapped, mask, quality, correct_2pi_jumps=correct)
    # Explicit fringe-order error, not just correlation with a smooth ramp.
    order_errors = component_errors(actual, truth + noise, mask)
    wrong = int(np.count_nonzero(np.rint(order_errors/(2*np.pi))))
    rms = float(np.std(component_errors(actual, truth, mask)))
    record_property('wrong_fringe_orders', wrong)
    record_property('phase_rms_rad', rms)
    assert wrong == 0
    assert rms < (.18 if noisy else 1e-10)
    np.testing.assert_allclose(component_errors(actual, reference, mask), 0, atol=1e-10)
    assert not np.any(actual[~mask])
    assert not np.any(risk[~mask])


@pytest.mark.parametrize('sigma', [1.5, 2.0])
def test_cleanup_preserves_resolved_smooth_peak(sigma):
    y, x = np.mgrid[:96, :128]
    truth = 6*np.exp(-((x-64)**2 + (y-48)**2)/(2*sigma**2)) + .02*x
    mask = (x - 64)**2 + (y - 48)**2 < 40**2
    # Large total height, but every neighboring change is below pi: spatially
    # resolvable. A median discrepancy alone is not evidence of a bad order.
    assert max(abs(np.diff(truth, axis=0)).max(), abs(np.diff(truth, axis=1)).max()) < np.pi
    wrapped = np.angle(np.exp(1j*truth))
    actual, risk, _ = f.unwrap_phase_2d(wrapped, mask, np.ones(mask.shape))
    np.testing.assert_allclose(component_errors(actual, truth, mask), 0, atol=1e-10)
    assert not np.any(risk[mask])


def test_single_wavelength_step_order_is_not_observable():
    y, x = np.mgrid[:48, :64]
    wavelength = 632.8
    low = np.where(x >= 32, 80., 0.)
    high = low + np.where(x >= 32, wavelength/2, 0.)
    carrier = 2*np.pi*x/8
    # An extra reflected-light fringe gives exactly the same input image.
    np.testing.assert_allclose(np.cos(carrier + 4*np.pi*low/wavelength),
                               np.cos(carrier + 4*np.pi*high/wavelength), atol=1e-14)
    wrapped = np.angle(np.exp(1j*4*np.pi*high/wavelength))
    actual, _, _ = f.unwrap_phase_2d(wrapped, quality=np.ones(x.shape), correct_2pi_jumps=False)
    step = (np.median(actual[:, 40:]) - np.median(actual[:, :24])) * wavelength/(4*np.pi)
    assert step == pytest.approx(80., abs=1e-10)
    assert abs(step - (80 + wavelength/2)) > 300


def test_cleanup_still_repairs_a_small_wrong_order_patch(monkeypatch):
    y, x = np.mgrid[:64, :64]
    truth = .04*x + .03*y
    wrong = truth.copy()
    wrong[30:33, 30:33] += 2*np.pi
    monkeypatch.setattr(f, '_quality_guided_unwrap', lambda *args: wrong.copy())
    # Isolate the median pass: the larger-region merger is independently
    # tested in test_fringe_unwrap_islands.py.
    monkeypatch.setattr(f, '_merge_unwrap_islands',
                        lambda u, *args, **kwargs: (u, np.zeros(u.shape, bool)))
    actual, risk, _ = f.unwrap_phase_2d(np.angle(np.exp(1j*truth)),
                                       np.ones(truth.shape, bool), np.ones(truth.shape))
    np.testing.assert_allclose(actual, truth, atol=1e-12)
    assert np.count_nonzero(risk == 1) == 9


@pytest.fixture
def numerical_pipeline(monkeypatch):
    # Disable only PNG rendering. All numerical analysis and serialization
    # stages remain active; check round-trip grids as received by the UI.
    for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                 'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
        monkeypatch.setattr(f, name, lambda *args, **kwargs: '')
    return f.analyze_interferogram


@pytest.mark.parametrize('angle,cycles', [(0, 8), (27, 12), (90, 16), (153, 12)])
@pytest.mark.parametrize('sigma', [.12, .18, .30])
@pytest.mark.parametrize('noise', [0., 1.])
def test_forward_model_carrier_filter_noise_sweep(numerical_pipeline, angle, cycles, sigma, noise, record_property):
    n = 192
    y, x = np.mgrid[:n, :n]
    u, v = (x - n/2)/(n/2), (y - n/2)/(n/2)
    truth = 25*(u*u + .6*v*v) + 12*np.exp(-((u-.15)**2 + (v+.1)**2)/.12)
    wavelength = 589.3
    a = np.deg2rad(angle)
    fx, fy = cycles*np.cos(a)/n, cycles*np.sin(a)/n
    illumination, amplitude = 125 + 15*u + 10*v, 80 - 15*u
    image = illumination + amplitude*np.cos(2*np.pi*(fx*x + fy*y) + 4*np.pi*truth/wavelength + .37)
    image += np.random.default_rng(16).normal(0, noise, image.shape)
    result = numerical_pipeline(image, wavelength_nm=wavelength, use_full_mask=True,
                                lpf_sigma_frac=sigma, n_zernike=15)
    assert (result['grid_rows'], result['grid_cols']) == truth.shape
    mask = np.array(result['mask_grid'], bool).reshape(truth.shape)
    # Determine sign from the known imposed carrier and the sideband selected
    # by the analyzer, never by choosing whichever best fits the answer.
    carrier = result['carrier']
    sign = np.sign(carrier['fx_cpp']*fx + carrier['fy_cpp']*fy)
    assert sign != 0
    assert carrier['fringe_period_px'] == pytest.approx(n/cycles, rel=.025)
    recovered = sign*np.array(result['height_grid']).reshape(truth.shape)
    plane = np.column_stack([np.ones(mask.sum()), x[mask], y[mask]])
    target = truth[mask] - plane@np.linalg.lstsq(plane, truth[mask], rcond=None)[0]
    error = recovered[mask] - target
    # Piston and tilt cannot be separated from the imposed wedge. Remove
    # only those degrees of freedom; no gain, curvature, or local alignment.
    error -= plane@np.linalg.lstsq(plane, error, rcond=None)[0]
    rms = float(np.sqrt(np.mean(error**2)))
    pv_error = float(abs(np.ptp(recovered[mask]) - np.ptp(target)))
    coverage = float(mask.mean())
    record_property('height_rms_error_nm', rms)
    record_property('pv_error_nm', pv_error)
    record_property('returned_aperture_fraction', coverage)
    # Deliberate software acceptance envelope for this modest smooth surface,
    # not an accuracy claim for real images or fine spatial detail.
    assert rms < .5
    assert pv_error < 1.
    assert coverage > .40


@pytest.mark.parametrize('aperture', ['disk', 'clipped', 'hole'])
def test_forward_model_with_offset_aperture(numerical_pipeline, aperture, record_property):
    n = 192
    y, x = np.mgrid[:n, :n]
    mask = (x-101)**2 + (y-88)**2 <= 65**2
    if aperture == 'clipped':
        mask &= x > 70
    elif aperture == 'hole':
        mask &= (x-110)**2 + (y-80)**2 > 18**2
    truth = 25*((x-96)**2 + .6*(y-96)**2)/96**2
    image = 125 + 80*np.cos(2*np.pi*(12*x+7*y)/n + 4*np.pi*truth/632.8 + .37)
    result = numerical_pipeline(image, wavelength_nm=632.8, custom_mask=mask, n_zernike=15)
    # Translate the source truth into the documented padded-aperture crop;
    # no interpolation or image registration is allowed to improve agreement.
    yy, xx = np.nonzero(mask)
    y0, y1, x0, x1 = yy.min(), yy.max()+1, xx.min(), xx.max()+1
    py, px = max(2, int(.05*(y1-y0))), max(2, int(.05*(x1-x0)))
    y0, y1, x0, x1 = max(0, y0-py), min(n, y1+py), max(0, x0-px), min(n, x1+px)
    shape = (result['grid_rows'], result['grid_cols'])
    assert shape == (y1-y0, x1-x0)
    valid = np.array(result['mask_grid'], bool).reshape(shape)
    plane = np.column_stack([np.ones(valid.sum()), x[y0:y1, x0:x1][valid], y[y0:y1, x0:x1][valid]])
    target = truth[y0:y1, x0:x1][valid]
    target -= plane@np.linalg.lstsq(plane, target, rcond=None)[0]
    sign = np.sign(result['carrier']['fx_cpp']*12 + result['carrier']['fy_cpp']*7)
    recovered = sign*np.array(result['height_grid']).reshape(shape)[valid]
    recovered -= plane@np.linalg.lstsq(plane, recovered, rcond=None)[0]
    rms = float(np.std(recovered - target))
    coverage = float(valid.sum()/mask.sum())
    record_property('height_rms_error_nm', rms)
    record_property('returned_aperture_fraction', coverage)
    assert rms < .1
    assert abs(np.ptp(recovered) - np.ptp(target)) < .2
    # This fine-carrier fixture binds at the 5 px across-fringe sigma floor.
    # A full 3-sigma support excludes a 15 px square band around *every*
    # boundary, including the hole. Compare with independent morphology,
    # rather than accepting arbitrary loss of aperture to get a low error.
    expected_valid = binary_erosion(mask, structure=np.ones((31, 31), bool))
    np.testing.assert_array_equal(valid, expected_valid[y0:y1, x0:x1])


@pytest.mark.parametrize('feature_cycles', [1, 3, 6])
@pytest.mark.parametrize('sigma', [.12, .18, .30])
def test_spatial_detail_transfer_is_measured(numerical_pipeline, feature_cycles, sigma, record_property):
    n = 192
    y, x = np.mgrid[:n, :n]
    truth = 10*np.sin(2*np.pi*feature_cycles*x/n + .7)
    image = 125 + 80*np.cos(2*np.pi*16*x/n + 4*np.pi*truth/632.8 + .37)
    result = numerical_pipeline(image, wavelength_nm=632.8, use_full_mask=True,
                                lpf_sigma_frac=sigma, n_zernike=15)
    assert (result['grid_rows'], result['grid_cols']) == truth.shape
    mask = np.array(result['mask_grid'], bool).reshape(truth.shape)
    plane = np.column_stack([np.ones(mask.sum()), x[mask], y[mask]])
    target = truth[mask] - plane@np.linalg.lstsq(plane, truth[mask], rcond=None)[0]
    recovered = np.sign(result['carrier']['fx_cpp'])*np.array(result['height_grid']).reshape(truth.shape)[mask]
    recovered -= plane@np.linalg.lstsq(plane, recovered, rcond=None)[0]
    gain = float(recovered@target/(target@target))
    rms = float(np.std(recovered - target))
    record_property('feature_amplitude_gain', gain)
    record_property('height_rms_error_nm', rms)
    # Characterization bounds, not a claim of unity transfer. At 6/16 of the
    # carrier frequency the 5 px Gaussian floor attenuates substantial detail.
    # Preserve this limitation explicitly instead of hiding it with a gain fit.
    lower, upper = {1: (.95, 1.03), 3: (.83, .95), 6: (.55, .70)}[feature_cycles]
    assert lower < gain < upper
    assert rms < 3.2


def test_fine_carrier_boundary_band_covers_actual_filter_floor(numerical_pipeline):
    y, x = np.mgrid[:192, :192]
    image = 125 + 80*np.cos(2*np.pi*24*x/192 + .37)
    result = numerical_pipeline(image, use_full_mask=True, lpf_sigma_frac=.05, n_zernike=15)
    mask = np.array(result['mask_grid'], bool).reshape(192, 192)
    # The actual across-fringe sigma is at least 5 px, so all quantitative
    # samples need 15 px of support, even though .75*period is only 6 px.
    assert not mask[:15].any() and not mask[-15:].any()
    assert not mask[:, :15].any() and not mask[:, -15:].any()
    assert mask[20:-20, 20:-20].all()
