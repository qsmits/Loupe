"""Admission checks must detect model bias without changing existing data."""
from pathlib import Path
import runpy
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from fringe_continuation_checks import (
    withheld_phase_check, structured_residual_check, checked_composite,
)


@pytest.mark.parametrize('directional', [False, True])
def test_withheld_phase_accepts_quadratic_and_rejects_unpredicted_rim(directional):
    y, x = np.mgrid[:100, :120]
    anchors = (x > 10) & (x < 110) & (y > 10) & (y < 90)
    phase = .001*x + .003*y + .00001*x*y
    passed, diagnostics = withheld_phase_check(phase, anchors, 8, directional)
    assert passed
    assert diagnostics['p95_rad'] < 1e-10
    bent = phase + .15*np.clip((x-90)/20, 0, 1)**2
    assert not withheld_phase_check(bent, anchors, 8, directional)[0]


def test_withheld_phase_fails_closed_when_training_support_is_missing():
    phase = np.zeros((40, 40))
    assert not withheld_phase_check(phase, np.zeros_like(phase, bool), 10)[0]
    y, x = np.indices(phase.shape)
    assert not withheld_phase_check(phase, x == 20, 5, True)[0]


def photo_scene():
    y, x = np.mgrid[:96, :128]
    fx, fy = 1/8.3, 1/31
    arg = 2*np.pi*(fx*x+fy*y)+.4
    anchors = (x > 15) & (x < 65) & (y > 15) & (y < 80)
    metadata = dict(fringe_period_px=1/np.hypot(fx, fy), carrier_angle_rad=np.arctan2(fy, fx))
    return x, arg, anchors, metadata


def test_residual_check_distinguishes_phase_bias_from_offset_and_amplitude():
    x, arg, anchors, metadata = photo_scene()
    phase = np.full(x.shape, .4)
    mask = np.ones_like(x, bool)
    transition = np.clip((x-70)/15, 0, 1)
    photo = 125+70*np.cos(arg)
    biased = 125+70*np.cos(arg+.05*transition)
    nuisance = 125+20*transition+(70-20*transition)*np.cos(arg)
    good, _, _ = structured_residual_check(photo, mask, phase, anchors, metadata)
    bad, _, delta = structured_residual_check(biased, mask, phase, anchors, metadata)
    offset, _, _ = structured_residual_check(nuisance, mask, phase, anchors, metadata)
    assert good[48, 105]
    assert offset[48, 105]
    assert not bad[48, 105]
    assert delta[48, 105] == pytest.approx(.05, abs=.002)


def test_residual_check_retains_white_noise_and_ignores_unselected_samples():
    x, arg, anchors, metadata = photo_scene()
    mask = np.ones_like(x, bool); mask[:, :8] = False
    image = 125+70*np.cos(arg)+np.random.default_rng(19).normal(0, 2, x.shape)
    phase = np.full(x.shape, .4)
    a, diag, delta = structured_residual_check(image, mask, phase, anchors, metadata)
    image[~mask] = 1e9
    b, other, changed = structured_residual_check(image, mask, phase, anchors, metadata)
    np.testing.assert_array_equal(a, b)
    np.testing.assert_array_equal(delta, changed)
    assert diag == other
    assert a[20:-20, 20:-20].mean() > .95
    assert not a[~mask].any()
    assert diag['noise_sigma'] == pytest.approx(2, abs=.2)


def test_composite_requires_connection_to_original_anchors_and_preserves_bank():
    y, x = np.mgrid[:20, :30]
    anchors = x < 8
    bank = dict(phase=x.astype(float), valid=x < 10)
    continuation = dict(phase=np.full(x.shape, 42.), valid=np.ones_like(x, bool))
    permitted = x != 12
    phase, valid = checked_composite(bank, continuation, anchors, permitted)
    np.testing.assert_array_equal(phase[bank['valid']], bank['phase'][bank['valid']])
    assert valid[:, 11].all()
    assert not valid[:, 13:].any()
    assert (phase[:, 11] == 42).all()


def test_new_composites_and_cached_inputs_are_independent_of_analytic_truth(monkeypatch, tmp_path):
    runner = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-continuation-checks.py'))
    for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                 'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
        monkeypatch.setattr(runner['E']['f'], name, lambda *a, **kw: '')
    monkeypatch.setattr(runner['E']['f'], '_edge_inspection', lambda *a, **kw: {})
    case = next(c for c in runner['fixtures']('matrix') if c['name'] == 'flat-10.7')
    _, outputs, source, _ = runner['run_case'](case, tmp_path)
    changed = {**case, 'truth': case['truth']+np.indices(case['image'].shape)[0]**2,
               'physical': ~case['physical'], 'cap': ~case['cap']}
    _, others, _, _ = runner['run_case'](changed, tmp_path)
    for method in ('cv-rim', 'cv-strips', 'structured', 'cv-rim-structured', 'cv-strips-structured'):
        a, b = outputs[method], others[method]
        np.testing.assert_array_equal(a['phase'], b['phase'])
        np.testing.assert_array_equal(a['valid'], b['valid'])
        np.testing.assert_array_equal(a['phase'][source['valid']], source['phase'][source['valid']])
        assert a['valid'][source['valid']].all()
        assert not a['valid'][~source['mask']].any()


def test_baseline_cache_supports_automatic_mask_and_invalidates_changed_image(monkeypatch, tmp_path):
    runner = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-continuation-checks.py'))
    calls = []
    def analyze(case, methods):
        calls.append(case['image'].copy())
        image = case['image']
        phase = image.copy()
        valid = np.ones(image.shape, bool)
        outputs = {m: dict(phase=phase, valid=valid) for m in runner['BASE_METHODS']}
        source = dict(image=image, mask=valid, phase=phase, valid=valid, metadata={})
        return [], outputs, source
    monkeypatch.setitem(runner['E'], 'run_case', analyze)
    case = dict(image=np.zeros((8, 8)), selected=None)
    runner['load_baselines'](case, tmp_path)
    runner['load_baselines'](case, tmp_path)
    assert len(calls) == 1
    changed = dict(image=case['image']+1, selected=None)
    runner['load_baselines'](changed, tmp_path)
    assert len(calls) == 2
