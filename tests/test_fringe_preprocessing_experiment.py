"""Boundary and photometric controls for the research-only cleanup experiment."""
from pathlib import Path
import runpy
import numpy as np
P=runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/experiment-fringe-preprocessing.py'))

def scene():
    y,x=np.mgrid[:64,:72]
    mask=((x-36)/30)**2+((y-32)/26)**2<1
    image=125+30*np.cos(2*np.pi*(x/16+y/21))+.1*y
    return image,mask

def test_cleanups_ignore_unobserved_exterior():
    image,mask=scene();a=np.where(mask,image,1e6);b=np.where(mask,image,-1e6)
    ca=list(P['copies'](a,mask,16));cb=list(P['copies'](b,mask,16))
    for (name,im,diag),(other,im2,diag2) in zip(ca,cb):
        assert name==other and diag==diag2
        np.testing.assert_array_equal(im[mask],im2[mask])

def test_isolated_outlier_detection_does_not_flatten_clean_fringe_peaks():
    image,mask=scene();clean=dict((n,(im,d)) for n,im,d in P['copies'](image,mask,16))
    assert clean['isolated-outliers'][1]['replaced_pixels']==0
    damaged=image.copy();damaged[32,36]=255
    fixed=dict((n,(im,d)) for n,im,d in P['copies'](damaged,mask,16))
    assert fixed['isolated-outliers'][1]['replaced_pixels']==1
    changed=fixed['isolated-outliers'][0]!=damaged
    assert changed.sum()==1 and changed[32,36]
    np.testing.assert_array_equal(image,scene()[0])

def test_unclipped_affine_brightness_preserves_phase_and_relative_residual():
    image,mask=scene();rng=np.random.default_rng(43);image+=rng.normal(0,2,image.shape)
    fx,fy=1/16,1/21;meta=dict(refined_fx_cpp=fx,refined_fy_cpp=fy,carrier_angle_rad=np.arctan2(fy,fx),fringe_period_px=1/np.hypot(fx,fy))
    fit=P['D']['Fits']();a=fit(image,mask,meta,.5,.25);gain=1.4;b=fit(image*gain+12,mask,meta,.5,.25)
    checked=mask&(a['condition']<1000)
    assert checked.sum()>100
    assert np.max(P['D']['delta'](a['phase'][checked],b['phase'][checked]))<1e-7
    np.testing.assert_allclose(a['condition'][checked],b['condition'][checked],rtol=0,atol=0)
    np.testing.assert_allclose(a['residual'][checked]/a['amplitude'][checked],b['residual'][checked]/b['amplitude'][checked],rtol=1e-5,atol=1e-7)
