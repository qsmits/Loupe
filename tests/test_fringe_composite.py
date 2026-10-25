"""Composite provenance, real-pixel recovery and cutoff statistics."""
from pathlib import Path
import runpy
import json
import numpy as np
import pytest
from backend.vision import fringe as f
from backend.vision import fringe_composite as c
from backend.api_fringe import AnalyzeBody

E = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-coverage-budget.py'))

@pytest.fixture(autouse=True)
def no_render(monkeypatch):
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        monkeypatch.setattr(f,name,lambda *a,**kw:'')
    monkeypatch.setattr(f,'_edge_inspection',lambda *a,**kw:{})


def test_layers_preserve_original_and_prefer_strict_without_inventing_missing_pixels():
    phase=np.array([[10.,20.,30.,40.]])
    base=np.array([[1,0,0,0]],bool)
    strict=(phase+1,np.array([[1,1,0,0]],bool))
    broad=(phase+2,np.array([[1,1,1,0]],bool))
    out,mask,source=c.stack_layers(phase,base,strict,broad)
    np.testing.assert_array_equal(out[mask],[10,21,32])
    np.testing.assert_array_equal(source,[[1,2,3,0]])
    assert not mask[0,3]


def test_full_resolution_cutoffs_are_nested_and_conflicts_always_excluded():
    heights=np.array([[0.,10.,20.,900.]])
    fields=dict(source=np.array([[1,2,3,1]],np.uint8),quality=np.array([[1,2,3,1]],np.uint8),
                conflict=np.array([[0,0,0,1]],bool),aperture=np.ones((1,4),bool))
    result=c.payload(fields,heights,(0,1,0,4),(1,2))
    assert [s['pixels'] for s in result['summaries']]==[1,2,3]
    assert [s['pv_nm'] for s in result['summaries']]==[0,10,20]
    assert [s['coverage_pct'] for s in result['summaries']]==[25,50,75]
    np.testing.assert_array_equal(result['height_grid_nm'],[0,20])
    assert result['conflict_pixels']==1
    fields['quality'][:]=0
    assert c.payload(fields,heights,(0,1,0,4),(1,4))['summaries'][0]['pv_nm'] is None


@pytest.mark.parametrize('name',['narrow-roll-17.4','noisy-hole-flat'])
def test_composite_recovery_preserves_reference_and_matches_full_stats(name):
    case=next(v for v in E['E']['fixtures']('matrix') if v['name']==name)
    result=f.analyze_interferogram(case['image'],wavelength_nm=632.8,n_zernike=15,
        custom_mask=case['selected'],form_model='plane',analysis_method='composite')
    p=result['composite']
    assert p['summaries'][2]['pixels']==result['n_valid_pixels']
    assert p['summaries'][2]['pv_nm']==pytest.approx(result['pv_nm'])
    assert p['summaries'][2]['rms_nm']==pytest.approx(result['rms_nm'])
    assert p['summaries'][2]['coverage_pct']>95
    assert len(p['height_grid_nm'])==result['grid_rows']*result['grid_cols']
    assert {2,3}.issubset(set(p['source_grid']))
    assert len(p['sources'])==5 and all(s['capture_index']==0 for s in p['sources'])
    json.dumps(result,allow_nan=False)


def test_api_accepts_experimental_choice_and_bounds_input():
    assert AnalyzeBody(analysis_method='composite').analysis_method=='composite'
    with pytest.raises(ValueError,match='1024'):
        f.analyze_interferogram(np.zeros((30,1025)),analysis_method='composite')


def test_shared_fits_do_not_promote_uncorroborated_baseline(monkeypatch):
    shape=(32,32);base=np.zeros(shape,bool);base[8:24,8:24]=1
    fit=dict(phase=np.zeros(shape),amplitude=np.zeros(shape),condition=np.ones(shape),residual=np.ones(shape))
    monkeypatch.setattr(c,'fit_window',lambda *a,**kw:fit)
    phase,valid,fields=c.build_composite(np.zeros(shape),np.ones(shape,bool),np.zeros(shape),base,dict(fringe_period_px=8))
    np.testing.assert_array_equal(valid,base)
    assert np.all(fields['quality'][base]==3)
    assert not fields['conflict'].any()


def test_wrapped_agreement_cannot_certify_inconsistent_fringe_order(monkeypatch):
    shape=(40,40);base=np.zeros(shape,bool);base[10:30,10:30]=1
    phase=np.zeros(shape);phase[:,20:]=2*np.pi
    fit=dict(phase=np.zeros(shape),amplitude=np.full(shape,60.),condition=np.ones(shape),residual=np.ones(shape)*.1)
    monkeypatch.setattr(c,'fit_window',lambda *a,**kw:fit)
    _,_,fields=c.build_composite(np.zeros(shape),np.ones(shape,bool),phase,base,dict(fringe_period_px=8))
    # Every wrapped value agrees, but no single fringe order fits the anchors.
    assert np.all(fields['quality'][base]==3)


@pytest.mark.parametrize('route',['/fringe/analyze','/fringe/analyze-stream','/fringe/reanalyze-carrier'])
def test_composite_reaches_server_results_and_capture_history(client,route):
    import base64,cv2
    y,x=np.mgrid[:112,:144]
    image=np.rint(125+80*np.cos(2*np.pi*(12*x/144+4*y/112))).astype('uint8')
    body=dict(image_b64=base64.b64encode(cv2.imencode('.png',image)[1]).decode(),
              analysis_method='composite',form_model='plane',n_zernike=15,reconstructed_preview=True)
    if route.endswith('carrier'):body.update(carrier_y=60,carrier_x=84)
    response=client.post(route,json=body)
    assert response.status_code==200,response.text
    if route.endswith('stream'):
        events=[json.loads(line[5:]) for line in response.text.splitlines() if line.startswith('data:')]
        assert any(e['stage']=='composite-fit' for e in events)
        result=next(e['result'] for e in events if e['stage']=='done')
    else:result=response.json()
    assert result['analysis_method']=='composite' and result['composite']['version']==1
    assert result['composite']['reconstruction']['kind']=='inferred_not_measured'
    saved=client.get('/fringe/session/capture/'+result['id']).json()
    assert saved['composite']==result['composite']


def test_alternative_order_check_ignores_island_piston_but_quarantines_slip():
    y,x=np.mgrid[:32,:40]
    phase=.03*x+.02*y
    valid=np.ones(phase.shape,bool);valid[:,18:21]=False
    phase[:,21:]+=12*np.pi
    conflict,diagnostics=c.order_check(phase,valid)
    assert not conflict.any() and diagnostics['checked_pixels']==valid.sum()
    phase[15:,25:]+=2*np.pi
    conflict,_=c.order_check(phase,valid)
    assert conflict[:,21:].all() and not conflict[:,:21].any()


def test_checked_continuation_is_last_layer_only_and_never_fills_a_hole():
    case=next(v for v in E['E']['fixtures']('matrix') if v['name']=='noisy-hole-flat')
    result=f.analyze_interferogram(case['image'],custom_mask=case['selected'],form_model='plane',analysis_method='composite')
    p=result['composite']
    assert p['diagnostics']['continuation']['added_pixels']>0
    assert all(q==3 for q,s in zip(p['quality_grid'],p['source_grid']) if s==4)
    assert all(not s or a for s,a in zip(p['source_grid'],p['aperture_grid']))
    assert len(p['reason_grid'])==len(p['source_grid'])


def test_all_ambiguous_capture_reports_reason_instead_of_flatness():
    case=next(v for v in E['budget_holdouts']() if v['name']=='budget-holdout-defect-0')
    with pytest.raises(ValueError,match='fringe-order check.*conflicting unwrap paths'):
        f.analyze_interferogram(case['image'],custom_mask=case['selected'],form_model='plane',analysis_method='composite')


def test_photographic_checks_reject_window_shape_sensitive_texture(monkeypatch):
    shape=(24,32);mask=np.ones(shape,bool)
    fit=dict(phase=np.zeros(shape),condition=np.full(shape,30.),amplitude=np.full(shape,30.),residual=np.ones(shape))
    lateral={**fit,'phase':np.full(shape,.08)}
    monkeypatch.setattr(c,'fit_window',lambda *a,**kw:fit)
    _,gate,diagnostics=c.photographic_fit_checks(np.ones(shape),mask,dict(fringe_period_px=10),
        primary=(fit,fit),lateral=(lateral,lateral))
    assert diagnostics['filtered_passed_pixels']==mask.sum()
    assert diagnostics['cross_window_passed_pixels']==0
    assert not gate.any()


def test_photographic_filter_does_not_read_exterior_pixels():
    y,x=np.mgrid[:48,:64];mask=(x-32)**2+(y-24)**2<20**2
    image=125+40*np.cos(2*np.pi*x/8)+np.random.default_rng(42).normal(0,1,x.shape)
    meta=dict(fringe_period_px=8,carrier_angle_rad=0,refined_fx_cpp=.125,refined_fy_cpp=0)
    a=c.photographic_fit_checks(np.where(mask,image,1e6),mask,meta)
    b=c.photographic_fit_checks(np.where(mask,image,-1e6),mask,meta)
    np.testing.assert_array_equal(a[0],b[0]);np.testing.assert_array_equal(a[1],b[1])
    assert a[2]==b[2]
    assert not a[1][~mask].any()


@pytest.mark.parametrize('reject_order',[False,True])
def test_photographic_layer_cannot_overwrite_promote_or_invalidate_earlier_layers(monkeypatch,reject_order):
    from backend.vision import fringe_checks
    shape=(40,48);mask=np.ones(shape,bool);mask[4:7,4:7]=False
    base=np.zeros(shape,bool);base[12:28,16:32]=True;phase=np.zeros(shape)
    fit=dict(phase=phase,condition=np.full(shape,30.),amplitude=np.full(shape,60.),residual=np.ones(shape))
    monkeypatch.setattr(c,'fit_window',lambda *a,**kw:fit)
    monkeypatch.setattr(c,'extend_from_candidates',lambda p,v,*a,**kw:(p.copy(),v.copy(),np.zeros(shape,np.uint8)))
    monkeypatch.setattr(fringe_checks,'withheld_phase_check',lambda *a,**kw:(False,dict(complete=False)))
    calls=[]
    def order(p,v):
        calls.append(1);conflict=v.copy() if reject_order and len(calls)>1 else np.zeros(shape,bool)
        return conflict,dict(checked_pixels=int(v.sum()),conflicted_pixels=int(conflict.sum()))
    monkeypatch.setattr(c,'order_check',order)
    before=c.build_composite(np.ones(shape),mask,phase,base,dict(fringe_period_px=8),_photographic=False)
    calls.clear()
    after=c.build_composite(np.ones(shape),mask,phase,base,dict(fringe_period_px=8))
    np.testing.assert_array_equal(after[0][base],before[0][base])
    np.testing.assert_array_equal(after[2]['quality'][base],before[2]['quality'][base])
    np.testing.assert_array_equal(after[2]['conflict'],before[2]['conflict'])
    assert np.all(after[1][base]) and not after[1][~mask].any()
    added=after[2]['source']==5
    assert added.any()!=reject_order
    assert np.all(after[2]['quality'][added]==3)


def test_photographic_toggle_statistics_use_fixed_heights_and_full_resolution():
    heights=np.array([[1.,4.,40.,900.]])
    fields=dict(source=np.array([[1,4,5,5]],np.uint8),quality=np.array([[1,3,3,3]],np.uint8),
        conflict=np.array([[0,0,0,1]],bool),aperture=np.ones((1,4),bool))
    p=c.payload(fields,heights,(0,1,0,4),(1,2))
    assert p['photographic_pixels']==1
    assert p['summaries'][2]['pixels']==3 and p['summaries'][2]['pv_nm']==39
    assert p['without_photographic_summaries'][2]['pixels']==2
    assert p['without_photographic_summaries'][2]['pv_nm']==3
    assert p['summaries'][:2]==p['without_photographic_summaries'][:2]
    np.testing.assert_array_equal(p['height_grid_nm'],[1,40])
