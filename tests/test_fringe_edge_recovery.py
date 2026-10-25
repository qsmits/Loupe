"""Research admission and anchoring checks; production defaults stay unchanged."""
from pathlib import Path
import sys
import numpy as np
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from fringe_edge_recovery import stable_fit,anchored_candidate,extend_from_candidates,fit_window


def test_gate_diagnostics_are_exclusive_and_count_the_actual_mask():
    shape=(5,5);mask=np.ones(shape,bool);mask[0,0]=False
    a=dict(phase=np.zeros(shape),condition=np.ones(shape),amplitude=np.full(shape,60.),residual=np.ones(shape))
    b={k:v.copy() for k,v in a.items()}
    b['condition'][1,1]=1001;b['amplitude'][1,1]=0
    b['amplitude'][1,2]=0;b['residual'][1,3]=20;b['phase'][1,4]=.5
    valid,reasons=stable_fit(a,b,mask)
    assert sum(reasons.values())==mask.sum()
    assert all(reasons[k]==1 for k in ('conditioning','contrast','image_residual','window_disagreement'))
    assert valid.sum()==20
    assert not valid[0,0]


def test_extension_preserves_original_values_and_requires_two_votes_for_consensus():
    base=np.arange(36,dtype=float).reshape(6,6);mask=np.zeros((6,6),bool);mask[:3]=True
    first=np.full((6,6),10.);second=np.full((6,6),10.01)
    m1=np.ones_like(mask);m2=m1.copy();m2[5]=False
    phase,valid,votes=extend_from_candidates(base,mask,[(first,m1),(second,m2)],True)
    np.testing.assert_array_equal(phase[mask],base[mask]);assert valid[mask].all()
    assert valid[3:5].all();assert not valid[5].any()
    np.testing.assert_allclose(phase[3:5],10.005)
    assert (votes[3:5]==2).all()


def test_anchoring_cannot_admit_disconnected_islands_or_cross_failed_bridges(monkeypatch):
    import fringe_edge_recovery as r
    y,x=np.mgrid[:50,:70];base=np.zeros((50,70));valid=(x<25)&(y>5)&(y<45)
    reliable=(x<35)&(y>5)&(y<45);reliable[10:20,50:60]=True
    local=np.full_like(base,2*np.pi+.005)
    monkeypatch.setattr(r.f,'unwrap_phase_2d',lambda *a,**kw:(local,np.zeros_like(local),np.ones_like(local)))
    phase,accepted=anchored_candidate(base,valid,np.zeros_like(base),reliable,np.ones_like(valid),np.ones_like(base),10,reach=None)
    assert accepted[20,30];assert not accepted[15,55]
    np.testing.assert_allclose(phase[accepted],.005,atol=1e-12)
    reliable[:,28:31]=False
    _,accepted=anchored_candidate(base,valid,local,reliable,np.ones_like(valid),np.ones_like(base),10,reach=None)
    assert not accepted[20,33]


def test_bad_anchor_agreement_rejects_growth(monkeypatch):
    import fringe_edge_recovery as r
    base=np.zeros((30,30));valid=np.zeros_like(base,dtype=bool);valid[5:25,5:15]=True
    local=np.ones_like(base)
    monkeypatch.setattr(r.f,'unwrap_phase_2d',lambda *a,**kw:(local,local,local))
    _,accepted=anchored_candidate(base,valid,local,np.ones_like(valid),np.ones_like(valid),local,10,reach=None)
    assert not accepted.any()


def test_image_fit_never_reads_unselected_exterior():
    y,x=np.mgrid[:64,:64];mask=(x-32)**2+(y-32)**2<26**2
    image=125+70*np.cos(2*np.pi*(x/8+y/24)+.2)
    period=1/np.hypot(1/8,1/24);theta=np.arctan2(1/24,1/8)
    meta=dict(fringe_period_px=period,carrier_angle_rad=theta,refined_fx_cpp=1/8,refined_fy_cpp=1/24)
    a=fit_window(image,mask,meta,.5,.5)
    image[~mask]=np.random.default_rng(103).normal(10000,1000,(~mask).sum())
    b=fit_window(image,mask,meta,.5,.5)
    for key in a:np.testing.assert_array_equal(a[key],b[key])
    np.testing.assert_allclose(a['phase'][mask],.2,atol=1e-6)


def test_continuation_keeps_real_pixels_and_only_uses_actual_evidence(monkeypatch):
    import fringe_edge_recovery as r
    y,x=np.mgrid[:64,:64];mask=(x-32)**2+(y-32)**2<25**2;valid=(x-32)**2+(y-32)**2<17**2
    fx,fy=1/9,1/27;period=1/np.hypot(fx,fy);phase=np.full((64,64),.4)
    image=np.where(mask,125+70*np.cos(2*np.pi*(fx*x+fy*y)+.4),900.)
    seen={}
    def extract(extended,whole,**kwargs):seen['image']=extended;return phase.copy()
    monkeypatch.setattr(r.f,'extract_phase_dft',extract)
    wrapped,reliable,diag=r.fringe_continuation(image,mask,phase,valid,dict(fringe_period_px=period,carrier_angle_rad=np.arctan2(fy,fx)))
    np.testing.assert_array_equal(seen['image'][mask],image[mask])
    assert np.max(seen['image'][~mask])<256
    assert not reliable[~mask].any()
    assert reliable[mask].all()
    assert diag['prediction_rms']<1e-9
    broken=image.copy();broken[mask & (x>45)]=235
    _,reliable,_=r.fringe_continuation(broken,mask,phase,valid,dict(fringe_period_px=period,carrier_angle_rad=np.arctan2(fy,fx)))
    assert not reliable[30,52]


def test_noisy_fit_relaxation_does_not_bypass_phase_agreement_or_low_amplitude():
    shape=(5,5);mask=np.ones(shape,bool)
    a=dict(phase=np.zeros(shape),condition=np.ones(shape),amplitude=np.full(shape,60.),residual=np.full(shape,4.))
    b={k:v.copy() for k,v in a.items()}
    assert not stable_fit(a,b,mask)[0].any()
    valid,_=stable_fit(a,b,mask,residual_floor=6.)
    assert valid.all()
    b['phase'][2,2]=.3;b['amplitude'][1,1]=1
    valid,_=stable_fit(a,b,mask,residual_floor=6.)
    assert not valid[2,2];assert not valid[1,1]


@pytest.mark.parametrize("method", ["checked-composite", "padded-composite"])
def test_composite_is_truth_blind_and_preserves_hybrid_observations(monkeypatch, method):
    import runpy
    experiment=runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-edge-recovery.py'))
    f=experiment['f']
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        monkeypatch.setattr(f,name,lambda *a,**kw:'')
    monkeypatch.setattr(f,'_edge_inspection',lambda *a,**kw:{})
    case=next(c for c in experiment['B']['fixtures']() if c['name']=='flat-10.7')
    _,outputs,source=experiment['run_case'](case,[method])
    altered={**case,'truth':case['truth']+321*np.indices(case['image'].shape)[0]**2,'physical':~case['physical'],'cap':~case['cap']}
    _,other,_=experiment['run_case'](altered,[method])
    a=outputs[method];b=other[method]
    np.testing.assert_array_equal(a['valid'],b['valid'])
    np.testing.assert_array_equal(a['phase'],b['phase'])
    np.testing.assert_array_equal(a['phase'][source['valid']],source['phase'][source['valid']])
    assert a['valid'][source['valid']].all()
    assert not a['valid'][~source['mask']].any()
    assert a['valid'].sum()>source['valid'].sum()


@pytest.mark.parametrize("fx,fy", [(1/9,1/27),(-1/23,1/11)])
def test_padded_continuation_preserves_carrier_origin_at_frame_boundary(fx,fy):
    import fringe_edge_recovery as r
    y,x=np.mgrid[:80,:96]
    mask=np.ones(x.shape,bool);valid=(x>15)&(x<80)&(y>15)&(y<65)
    phase=np.full(x.shape,.4)
    image=125+70*np.cos(2*np.pi*(fx*x+fy*y)+phase)
    meta=dict(fringe_period_px=1/np.hypot(fx,fy),carrier_angle_rad=np.arctan2(fy,fx))
    wrapped,reliable,_=r.fringe_continuation(image,mask,phase,valid,meta,pad_frame=True)
    error=np.angle(np.exp(1j*(wrapped-phase)))
    assert reliable.all()
    assert np.max(np.abs(error))<5e-5


def test_padded_continuation_retains_real_image_inside_padded_frame(monkeypatch):
    import fringe_edge_recovery as r
    y,x=np.mgrid[:64,:64];mask=(x-32)**2+(y-32)**2<25**2
    valid=(x-32)**2+(y-32)**2<17**2
    fx,fy=1/9,1/27;period=1/np.hypot(fx,fy);phase=np.full(x.shape,.4)
    image=np.where(mask,125+70*np.cos(2*np.pi*(fx*x+fy*y)+phase),900.)
    seen={}
    def extract(extended,whole,**kwargs):
        seen['image']=extended.copy()
        return np.zeros(extended.shape)
    monkeypatch.setattr(r.f,'extract_phase_dft',extract)
    _,reliable,_=r.fringe_continuation(image,mask,phase,valid,dict(fringe_period_px=period,carrier_angle_rad=np.arctan2(fy,fx)),pad_frame=True)
    pad=int(np.ceil(2*period));center=seen['image'][pad:-pad,pad:-pad]
    np.testing.assert_array_equal(center[mask],image[mask])
    assert not reliable[~mask].any()
    assert seen['image'].shape==(64+2*pad,64+2*pad)
