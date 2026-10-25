"""Independent checks of the research estimator; no production default changes."""
from pathlib import Path
import runpy
import numpy as np
import pytest

EXPERIMENT=runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-local-fit.py'))


@pytest.mark.parametrize('angle',[0,37,112])
@pytest.mark.parametrize('degree',[1,2])
def test_local_fit_recovers_known_amplitude_model_at_mask_and_frame_edges(angle,degree):
    n=72;y,x=np.mgrid[:n,:n];u=x/n-.5;v=y/n-.5
    fx=np.cos(np.deg2rad(angle))/9;fy=np.sin(np.deg2rad(angle))/9
    carrier=2*np.pi*(fx*x+fy*y)
    cosine=45+8*u-6*v;sine=20-5*u+3*v;bg=115+20*u+5*v
    if degree==2:
        cosine+=7*u*v;sine+=4*u*u;bg+=15*v*v
    physical=np.hypot(x-30,y-35)<32
    physical&=np.hypot(x-35,y-40)>6
    image=bg+cosine*np.cos(carrier)+sine*np.sin(carrier)
    # Exterior is unrelated to the field; masked regression must not read it.
    image[~physical]=900
    phase,condition,amplitude=EXPERIMENT['local_phase'](image,physical,fx,fy,5.,3.,degree)
    expected=np.arctan2(-sine,cosine)
    error=np.angle(np.exp(1j*(phase-expected)))
    assert np.max(np.abs(error[physical])) < 2e-6
    np.testing.assert_allclose(amplitude[physical],np.hypot(cosine,sine)[physical],atol=1e-4)
    assert np.isfinite(condition[physical]).all()
    assert np.isinf(condition[~physical]).all()


def test_local_fit_is_invariant_to_unselected_exterior():
    n=64;y,x=np.mgrid[:n,:n];mask=(x-32)**2+(y-32)**2<25**2
    image=125+65*np.cos(2*np.pi*(x/9+y/27)+.4)
    a=EXPERIMENT['local_phase'](image,mask,1/9,1/27,5.,2.5)[0]
    image[~mask]=np.random.default_rng(99).normal(1000,500,(~mask).sum())
    b=EXPERIMENT['local_phase'](image,mask,1/9,1/27,5.,2.5)[0]
    np.testing.assert_array_equal(a,b)


def test_harmonic_fit_recovers_fundamental_without_reading_second_harmonic_as_height():
    y,x=np.mgrid[:80,:80];mask=(x-40)**2+(y-40)**2<32**2
    carrier=2*np.pi*(x/10+y/25)
    expected=.63
    image=125+70*np.cos(carrier+expected)+20*np.cos(2*carrier-.7)
    phase,_,_=EXPERIMENT['local_phase'](image,mask,1/10,1/25,6.,3.,harmonics=2)
    assert np.max(np.abs(np.angle(np.exp(1j*(phase[mask]-expected))))) < 1e-6


def test_carrier_refinement_recovers_noisy_flat_edge_without_ground_truth_tuning():
    rows=EXPERIMENT['compare'](['bounded','local:.4:.4:1','refined:.4:.4:1'],
        names=['stress-flat-17-7.9'],stress=True)
    baseline,plain,refined=rows
    assert refined['coverage_pct']>baseline['coverage_pct']+25
    assert refined['rms_error_nm']<baseline['rms_error_nm']/3
    assert refined['max_error_nm']<baseline['max_error_nm']/3
    assert refined['rms_error_nm']<plain['rms_error_nm']/10
    assert refined['outside_physical_pixels']==0


def test_scratch_rejection_does_not_combine_disconnected_fringe_orders():
    baseline,screened=EXPERIMENT['compare'](['bounded','screened:.4:.4:1'],
        names=['challenge-scratch-119'],challenge=True)
    assert baseline['cap_pixels']>0
    assert screened['cap_pixels']==0
    assert screened['max_error_nm']<1.
    assert screened['coverage_pct']<baseline['coverage_pct'] # honest cost of rejection


def test_hybrid_rejects_unreliable_and_unanchored_islands_without_removing_baseline():
    y,x=np.mgrid[:60,:60]
    baseline=np.zeros((60,60));base_valid=(x>10)&(x<30)&(y>10)&(y<50)
    local=np.full_like(baseline,2*np.pi+.005)
    reliable=(x>8)&(x<35)&(y>8)&(y<52)
    reliable[20:25,20:25]=False
    reliable[40:50,45:55]=True # separate island cannot acquire fringe order
    out,valid,accepted=EXPERIMENT['hybrid_merge'](baseline,base_valid,local,
        np.ones_like(base_valid),reliable,10)
    assert np.all(valid[base_valid])
    assert valid.sum()>base_valid.sum()
    assert not accepted[45,50]
    assert not accepted[22,22]
    assert out[22,22]==baseline[22,22]
    assert np.max(np.abs(out[accepted]))<.006 # carrier-order anchoring
    assert np.all(out[base_valid & ~accepted]==baseline[base_valid & ~accepted])


def test_hybrid_falls_back_on_phase_disagreement():
    base=np.zeros((40,40));valid=np.ones_like(base,dtype=bool)
    out,mask,accepted=EXPERIMENT['hybrid_merge'](base,valid,base+1,valid,valid,10)
    np.testing.assert_array_equal(out,base)
    np.testing.assert_array_equal(mask,valid)
    assert not accepted.any()


def test_hybrid_recovers_hole_edges_and_does_not_use_analytic_truth_to_select_pixels():
    case=next(c for c in EXPERIMENT['B']['fixtures']() if c['name']=='noisy-hole-flat')
    first,diag=EXPERIMENT['evaluate'](case,'hybrid:.4:.4:1')
    altered={**case,'truth':case['truth']+9999,'physical':~case['physical']}
    second,_=EXPERIMENT['evaluate'](altered,'hybrid:.4:.4:1')
    np.testing.assert_array_equal(first['valid'],second['valid'])
    np.testing.assert_array_equal(first['height'],second['height'])
    baseline,_=EXPERIMENT['evaluate'](case,'bounded')
    metrics=EXPERIMENT['B']['metrics'](case,first,baseline)
    assert metrics['removed_pixels']==0
    assert metrics['coverage_pct']>60
    assert metrics['rms_error_nm']<.25
    assert metrics['max_error_nm']<1
    assert diag['local_pixels']>0
