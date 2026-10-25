"""Production hybrid must reproduce the studied estimator, without global patches."""
from pathlib import Path
import runpy
import numpy as np
import pytest
from backend.vision import fringe as f
from backend.api_fringe import AnalyzeBody, ReanalyzeCarrierBody

EXP=runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-local-fit.py'))


@pytest.fixture(autouse=True)
def no_render(monkeypatch):
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        monkeypatch.setattr(f,name,lambda *a,**kw:'')
    monkeypatch.setattr(f,'_edge_inspection',lambda *a,**kw:{})


@pytest.mark.parametrize('name',['noisy-hole-flat','narrow-roll-10.7','challenge-scratch-119'])
def test_hybrid_matches_research_result_and_keeps_baseline_pixels(name):
    cases=list(EXP['B']['fixtures']())+list(EXP['challenge_fixtures']())
    case=next(c for c in cases if c['name']==name)
    expected,_=EXP['evaluate'](case,'hybrid:.5:.3:2')
    kwargs=dict(wavelength_nm=632.8,custom_mask=case['selected'],n_zernike=15,form_model='plane')
    actual=f.analyze_interferogram(case['image'],analysis_method='hybrid',**kwargs)
    baseline=f.analyze_interferogram(case['image'],**kwargs)
    np.testing.assert_array_equal(actual['mask_grid'],expected['result']['mask_grid'])
    np.testing.assert_allclose(actual['height_grid'],expected['result']['height_grid'],atol=.011)
    assert actual['pv_nm']==pytest.approx(expected['result']['pv_nm'],abs=1e-7)
    assert actual['n_valid_pixels']>=baseline['n_valid_pixels']
    assert actual['hybrid_diagnostics']['baseline_pixels']==baseline['n_valid_pixels']
    assert actual['analysis_method']=='hybrid'
    assert actual['hybrid_diagnostics']['version']==1


def test_current_is_default_and_does_not_run_local_fits(monkeypatch):
    from backend.vision import fringe_hybrid as h
    def unexpected(*a,**kw):raise AssertionError('Default must not run hybrid')
    monkeypatch.setattr(h,'quadratic_candidate',unexpected)
    case=next(EXP['B']['fixtures']())
    default=f.analyze_interferogram(case['image'],n_zernike=15)
    explicit=f.analyze_interferogram(case['image'],n_zernike=15,analysis_method='current')
    assert default['analysis_method']=='current'
    assert default['hybrid_diagnostics'] is None
    assert default['height_grid']==explicit['height_grid']
    assert default['mask_grid']==explicit['mask_grid']


def test_method_validation_and_bounded_experimental_memory():
    assert AnalyzeBody().analysis_method=='current'
    assert ReanalyzeCarrierBody(carrier_x=1,carrier_y=2).analysis_method=='current'
    assert AnalyzeBody(analysis_method='hybrid').analysis_method=='hybrid'
    with pytest.raises(ValueError):AnalyzeBody(analysis_method='invented')
    with pytest.raises(ValueError,match='Unknown fringe analysis method'):
        f.analyze_interferogram(np.zeros((40,40)),analysis_method='invented')
    with pytest.raises(ValueError,match='1024'):
        f.analyze_interferogram(np.zeros((40,1025)),analysis_method='hybrid')


@pytest.mark.parametrize('angle',[23,117])
def test_tiled_fits_preserve_phase_and_quality_across_seams_and_holes(angle):
    from backend.vision.fringe_hybrid import local_phase, _local_phase_full
    y,x=np.mgrid[:110,:140]
    mask=(x-70)**2+(y-50)**2<50**2
    mask&=(x-56)**2+(y-60)**2>8**2
    fx=np.cos(np.deg2rad(angle))/9;fy=np.sin(np.deg2rad(angle))/9
    image=125+65*np.cos(2*np.pi*(fx*x+fy*y)+.4+.0004*(x-70)**2)
    image[~mask]=9876 # exterior must never contribute
    fullq={};tileq={}
    full=_local_phase_full(image,mask,fx,fy,5,2.5,2,fullq)
    tiled=local_phase(image,mask,fx,fy,5,2.5,2,tileq,_tile_size=32)
    np.testing.assert_allclose(np.angle(np.exp(1j*(full[0][mask]-tiled[0][mask]))),0,atol=1e-10)
    np.testing.assert_allclose(full[1][mask],tiled[1][mask],rtol=1e-9)
    np.testing.assert_allclose(full[2][mask],tiled[2][mask],atol=1e-8)
    np.testing.assert_allclose(fullq['residual'][mask],tileq['residual'][mask],atol=2e-7)


@pytest.mark.parametrize('route',['/fringe/analyze','/fringe/analyze-stream','/fringe/reanalyze-carrier'])
def test_server_routes_forward_method_and_record_it_in_history(client,route):
    import base64,json,cv2
    y,x=np.mgrid[:144,:176]
    image=np.rint(125+80*np.cos(2*np.pi*(12*x/176+4*y/144))).astype('uint8')
    body=dict(image_b64=base64.b64encode(cv2.imencode('.png',image)[1]).decode(),
              analysis_method='hybrid',form_model='plane',n_zernike=15)
    if route.endswith('carrier'):body.update(carrier_y=76,carrier_x=100)
    response=client.post(route,json=body)
    assert response.status_code==200,response.text
    if route.endswith('stream'):
        events=[json.loads(line[5:]) for line in response.text.splitlines() if line.startswith('data:')]
        assert any(e['stage']=='hybrid-fit' for e in events)
        result=next(e['result'] for e in events if e['stage']=='done')
    else:result=response.json()
    assert result['analysis_method']=='hybrid'
    assert result['hybrid_diagnostics']['version']==1
    capture=next(c for c in client.get('/fringe/session/captures').json()['captures'] if c['id']==result['id'])
    assert capture['analysis_method']=='hybrid'


def test_browser_boundary_defaults_and_forwards_explicit_method(monkeypatch):
    import base64,cv2
    from backend.browser import fringe as browser
    seen=[]
    def analyze(*args,**kwargs):
        seen.append(kwargs['analysis_method'])
        return {'warnings':[],'analysis_method':kwargs['analysis_method']}
    monkeypatch.setattr(browser,'analyze_interferogram',analyze)
    encoded=base64.b64encode(cv2.imencode('.png',np.zeros((40,40),np.uint8))[1]).decode()
    assert browser.execute('analyze',{'image_b64':encoded})['analysis_method']=='current'
    assert browser.execute('analyze',{'image_b64':encoded,'analysis_method':'hybrid'})['analysis_method']=='hybrid'
    assert seen==['current','hybrid']


def test_fit_diagnostics_account_for_the_aperture():
    from backend.vision.fringe_hybrid import quadratic_candidate
    y,x=np.mgrid[:70,:90]
    mask=(x-45)**2+(y-35)**2<30**2
    image=125+60*np.cos(2*np.pi*x/10+.2)
    _,reliable,metadata=quadratic_candidate(image,mask,dict(carrier_angle_rad=0.,fringe_period_px=10.))
    checks=metadata['fit_checks']
    assert checks['aperture_pixels']==int(mask.sum())
    assert checks['passed_pixels']==int(reliable.sum())
    assert sum(checks['first_rejection'].values())+checks['passed_pixels']==int(mask.sum())
    assert not reliable[~mask].any()
    for key,count in checks['first_rejection'].items():
        assert count<=checks['independent_rejection'][key]<=mask.sum()


def test_merge_diagnostics_distinguish_anchor_failure_from_fit_failure():
    from backend.vision.fringe_hybrid import hybrid_merge
    base=np.zeros((30,40));valid=np.ones_like(base,bool)
    diagnostics={}
    out,kept,accepted=hybrid_merge(base,valid,base+.2,valid,valid,10,diagnostics=diagnostics)
    assert diagnostics['fit_passed']==valid.sum()
    assert diagnostics['anchor_disagreement_pixels']==diagnostics['transition_supported']>0
    assert diagnostics['accepted_pixels']==0
    np.testing.assert_array_equal(out,base)
    np.testing.assert_array_equal(kept,valid)
    assert not accepted.any()
