"""Coverage admission uses local evidence without changing known measurements."""
from pathlib import Path
import runpy
import numpy as np
import pytest

E = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-coverage-budget.py'))


def sample_fits():
    shape = (40, 40)
    fit = dict(phase=np.zeros(shape), amplitude=np.full(shape, 60.),
               condition=np.ones(shape), residual=np.ones(shape))
    return [(dict((k, v.copy()) for k, v in fit.items()),
             dict((k, v.copy()) for k, v in fit.items())) for _ in range(3)]


def source_data():
    valid = np.zeros((40, 40), bool); valid[10:30, 10:30] = True
    return dict(phase=np.zeros(valid.shape), valid=valid, metadata=dict(fringe_period_px=8))


def test_low_contrast_and_inconsistent_fits_cannot_expand_coverage():
    source = source_data(); domain = np.ones((40, 40), bool)
    fits = sample_fits()
    for a, b in fits:
        a['amplitude'][:, 31:] = 0
        b['phase'][:8] = .8
    output = E['recover_fits'](source, domain, fits, 5.)
    assert not output['valid'][:, 31:].any()
    assert not output['valid'][:8].any()
    assert output['valid'][30, 20]
    np.testing.assert_array_equal(output['phase'][source['valid']], source['phase'][source['valid']])


def test_selected_boundary_and_disconnected_islands_are_respected():
    source = source_data(); domain = np.ones((40, 40), bool)
    domain[:, 32:34] = False
    result = E['recover_fits'](source, domain, sample_fits(), 10.)
    assert result['valid'][30, 20]
    assert not result['valid'][~domain].any()
    assert not result['valid'][:, 34:].any()


@pytest.mark.parametrize('allowance', [0, -1, float('nan'), float('inf')])
def test_invalid_allowance_is_rejected(allowance):
    with pytest.raises(ValueError):
        E['recover_fits'](source_data(), np.ones((40, 40), bool), sample_fits(), allowance)


def test_reconstruction_does_not_use_true_surface_or_outline(monkeypatch, tmp_path):
    f = E['E']['E']['f']
    for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                 'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
        monkeypatch.setattr(f, name, lambda *a, **kw: '')
    monkeypatch.setattr(f, '_edge_inspection', lambda *a, **kw: {})
    case = next(c for c in E['E']['fixtures']('matrix') if c['name'] == 'flat-10.7')
    _, output, source = E['run_case'](case, tmp_path)
    altered = {**case, 'truth': case['truth']+np.indices(case['image'].shape)[0]**2,
               'physical': ~case['physical'], 'cap': ~case['cap']}
    _, other, _ = E['run_case'](altered, tmp_path)
    for method in output:
        np.testing.assert_array_equal(output[method]['phase'], other[method]['phase'])
        np.testing.assert_array_equal(output[method]['valid'], other[method]['valid'])
        np.testing.assert_array_equal(output[method]['phase'][source['valid']], source['phase'][source['valid']])
    assert output['selected-5nm']['valid'].sum() > source['valid'].sum()
    assert not output['selected-5nm']['valid'][~case['selected']].any()
