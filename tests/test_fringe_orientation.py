"""Spatial handedness is independent of the unavoidable phase-sign ambiguity."""
import base64

import cv2
import numpy as np
import pytest

from backend.vision import fringe as f


def asymmetric_scene():
    """Three different off-axis landmarks in a non-square camera image."""
    y, x = np.mgrid[:176, :224]
    height = (32*np.exp(-((x-58)**2 + (y-52)**2)/(2*13**2))
              - 24*np.exp(-((x-157)**2 + (y-111)**2)/(2*17**2))
              + 16*np.exp(-((x-120)**2 + (y-53)**2)/(2*10**2)))
    carrier = 2*np.pi*(14*x/224 + 8*y/176)
    image = np.rint(125 + 90*np.cos(carrier + 4*np.pi*height/632.8 + .37)).astype(np.uint8)
    return image, height, carrier


@pytest.mark.parametrize('transform', [lambda a: a, np.fliplr, np.flipud, np.rot90],
                         ids=['original', 'mirror-x', 'mirror-y', 'rotate-90'])
def test_asymmetric_image_preserves_landmark_positions(transform, monkeypatch, record_property):
    for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                 'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
        monkeypatch.setattr(f, name, lambda *args, **kwargs: '')
    image, truth, carrier = [transform(a).copy() for a in asymmetric_scene()]
    result = f.analyze_interferogram(image, wavelength_nm=632.8, use_full_mask=True, n_zernike=15)
    assert result['carrier_phase_sign'] == 1
    assert result['absolute_sign_known'] is False
    shape = (result['grid_rows'], result['grid_cols'])
    assert shape == image.shape
    valid = np.array(result['mask_grid'], bool).reshape(shape)
    # Orient height using the independently specified carrier, never by
    # minimizing the error against truth. This permits a phase sign change
    # when the sideband changes, but cannot conceal spatial mirroring.
    fx = np.mean(np.diff(carrier, axis=1))/(2*np.pi)
    fy = np.mean(np.diff(carrier, axis=0))/(2*np.pi)
    sign = np.sign(fx*result['carrier']['fx_cpp'] + fy*result['carrier']['fy_cpp'])
    recovered = sign*np.array(result['height_grid']).reshape(shape)
    y, x = np.indices(shape)
    plane = np.column_stack([np.ones(valid.sum()), x[valid], y[valid]])
    def residual(values):
        return values - plane@np.linalg.lstsq(plane, values, rcond=None)[0]
    reference = residual(truth[valid])
    error = residual(recovered[valid]) - reference
    rms = float(np.sqrt(np.mean(error**2)))
    record_property('orientation_height_rms_error_nm', rms)
    assert rms < 1.2
    # Each accidental reflection/half-turn must be decisively worse. An
    # axisymmetric bowl could pass these checks even when rendered backward.
    for wrong in (np.fliplr, np.flipud, lambda a: np.rot90(a, 2)):
        wrong_rms = np.sqrt(np.mean((residual(wrong(recovered)[valid]) - reference)**2))
        assert wrong_rms > 5*rms


@pytest.mark.parametrize('ambient_origin', ['upper', 'lower'])
def test_surface_png_has_camera_row_order_regardless_of_plot_defaults(ambient_origin):
    import matplotlib
    surface = np.zeros((80, 120))
    surface[10:30, 15:35] = 10
    surface[40:60, 70:90] = -10
    mask = np.ones(surface.shape, bool)
    mask[10:25, 95:110] = False
    with matplotlib.rc_context({'image.origin': ambient_origin}):
        png = f.render_surface_map(surface, mask)
    rgb = cv2.imdecode(np.frombuffer(base64.b64decode(png), np.uint8), cv2.IMREAD_COLOR)
    assert rgb.shape[:2] == surface.shape
    # OpenCV is BGR. Top-left high landmark is red; lower-right low is blue.
    assert int(rgb[20, 25, 2]) > int(rgb[20, 25, 0]) + 50
    assert int(rgb[50, 80, 0]) > int(rgb[50, 80, 2]) + 50
    assert not rgb[17, 102].any()


@pytest.mark.parametrize('lens_k1', [0., .12])
def test_reference_interferogram_matches_offcentre_analysis_crop(lens_k1, monkeypatch):
    image, _, _ = asymmetric_scene()
    mask = np.zeros(image.shape, bool)
    mask[35:155, 55:210] = True
    # Fix the aperture so the test isolates registration, not mask detection.
    monkeypatch.setattr(f, 'create_fringe_mask', lambda *a, **kw: np.ones(image.shape, bool))
    for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                 'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
        monkeypatch.setattr(f, name, lambda *a, **kw: '')
    result = f.analyze_interferogram(image, custom_mask=mask, lens_k1=lens_k1, n_zernike=15)
    reference = cv2.imdecode(np.frombuffer(base64.b64decode(result['reference_image_b64']), np.uint8),
                             cv2.IMREAD_GRAYSCALE)
    corrected = f.undistort_frame(image.astype(float), lens_k1)
    # Five-percent padding of the off-centre aperture, with image-edge clipping.
    expected = np.clip(corrected[29:161, 48:217], 0, 255).astype(np.uint8)
    assert reference.shape == (result['surface_height'], result['surface_width'])
    np.testing.assert_array_equal(reference, expected)


def test_zero_gap_contact_can_have_positive_gap_departure(monkeypatch):
    """Physical convex part under a tilted flat: zero contact need not be blue."""
    for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                 'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
        monkeypatch.setattr(f, name, lambda *a, **kw: '')
    rows, cols = 128, 160
    y, x = np.mgrid[:rows, :cols]
    xn = (x - (cols-1)/2) / ((cols-1)/2)
    yn = (y - (rows-1)/2) / ((rows-1)/2)
    specimen = 30 * (1 - xn*xn - yn*yn)  # Raised centre: convex specimen.
    reference_flat = 12 * 632.8 / 2 * y / rows
    gap = reference_flat - specimen
    contact = np.unravel_index(np.argmin(gap), gap.shape)
    gap -= gap[contact]  # Exact physical contact; nowhere is the gap negative.
    assert gap[contact] == 0 and gap.min() == 0
    image = np.rint(125 - 90*np.cos(4*np.pi*gap/632.8)).astype(np.uint8)
    result = f.analyze_interferogram(image, wavelength_nm=632.8, use_full_mask=True,
                                    n_zernike=15, form_model='plane')
    # Orient from the independently specified physical wedge, which opens down.
    sign = np.sign(result['carrier']['fy_cpp'])
    recovered = sign*np.array(result['height_grid']).reshape(rows, cols)
    valid = np.array(result['mask_grid'], bool).reshape(rows, cols)
    # Boundary contacts are excluded from measured pixels. The near-contact
    # interior still has positive residual although the physical gap there is
    # much smaller than the centre's gap; residual ordering is not gap ordering.
    upper = valid & (yn < -.65) & (np.abs(xn) < .2)
    centre = valid & (np.abs(yn) < .2) & (np.abs(xn) < .2)
    assert upper.any() and centre.any()
    assert recovered[upper].mean() > 0
    assert recovered[centre].mean() < 0
    assert gap[upper].mean() < gap[centre].mean()
