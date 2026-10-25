from pathlib import Path
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from fringe_gradient_reconstruction import reconstruct


def test_known_slope_and_wrapping_recovered_with_fixed_anchors():
    y,x=np.mgrid[:24,:36];truth=.3*x+.04*y;accepted=np.zeros(x.shape,bool);accepted[:,:5]=True
    current=np.where(accepted,truth,0);mask=np.ones(x.shape,bool)
    out,new,diag=reconstruct(current,accepted,mask,np.angle(np.exp(1j*truth)),np.ones(x.shape),regularization=1e-6)
    assert diag['converged'] and new.sum()==24*31
    np.testing.assert_array_equal(out[accepted],truth[accepted])
    np.testing.assert_allclose(out[new],truth[new],atol=1e-4)


def test_holes_and_unanchored_components_are_not_bridged():
    mask=np.ones((24,36),bool);mask[:,18:20]=False;accepted=np.zeros_like(mask);accepted[:,:5]=True
    phase=np.full(mask.shape,.4)
    out,new,diag=reconstruct(phase,accepted,mask,phase,np.ones(mask.shape))
    assert not (new&~mask).any() and not new[:,20:].any()
    assert new[:,5:18].all() and diag['unanchored_pixels']==24*16


def test_no_image_evidence_is_smooth_inference_not_a_measurement():
    mask=np.ones((20,30),bool);accepted=np.zeros_like(mask);accepted[:,:5]=True
    current=np.where(accepted,.7,0)
    out,new,diag=reconstruct(current,accepted,mask,np.zeros(mask.shape),np.zeros(mask.shape))
    np.testing.assert_allclose(out[new],.7,atol=1e-7)
    np.testing.assert_array_equal(out[accepted],current[accepted])


def test_solver_failure_adds_nothing():
    y,x=np.mgrid[:24,:36];accepted=np.zeros(x.shape,bool);accepted[:,:5]=True
    truth=.03*x*x+.01*y*y;current=np.where(accepted,truth,0)
    out,new,diag=reconstruct(current,accepted,np.ones(x.shape,bool),np.angle(np.exp(1j*truth)),np.ones(x.shape),maxiter=1)
    assert not diag['converged'] and not new.any()
    np.testing.assert_array_equal(out,current)
