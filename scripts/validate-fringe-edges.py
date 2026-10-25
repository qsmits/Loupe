"""Characterize boundary trimming against analytic truth; no production tuning.

MPLCONFIGDIR=/tmp/loupe-mpl .venv/bin/python scripts/validate-fringe-edges.py > /tmp/loupe-edge-validation.json
The half-width/near-zero cases are fault-injection experiments, not UI options.
"""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import json
from unittest.mock import patch
import numpy as np
from backend.vision import fringe as f


def characterize(case_names=None, band_factors=(1., .5, 0.)):
    n=192
    y,x=np.mgrid[:n,:n]
    radius=np.hypot(x-96,y-96)
    disk=radius<=75
    fixtures=[]
    for name, cycles, truth, aperture, background in [
        ('flat-full-fractional', 5.37, np.zeros((n,n)), None, 0),
        ('flat-ramped-illumination', 8.3, np.zeros((n,n)), None, 60),
        ('flat-disk', 14.3, np.zeros((n,n)), disk, 0),
        ('broad-edge-roll-disk', 14.3, -40*np.clip((radius-49)/26,0,1)**2, disk, 0),
        ('narrow-edge-roll-disk', 14.3, -40*np.clip((radius-65)/10,0,1)**2, disk, 0),
        ('edge-roll-full-frame', 14.3, -40*np.exp(-(n-1-x)/10), None, 0),
    ]:
        image=125+background*(x/n-.5)+80*np.cos(2*np.pi*(cycles*x/n+3.3*y/n)+4*np.pi*truth/632.8+.37)
        if aperture is not None: image=np.where(aperture,image,15.)
        fixtures.append((name,image,truth,aperture,cycles))
    rows=[]
    original_unwrap=f.unwrap_phase_2d
    for name,image,truth,aperture,cycles in fixtures:
        if case_names is not None and name not in case_names:
            continue
        for factor in band_factors:
            observed={}
            def unwrap(wrapped, mask=None, **kwargs):
                kwargs['edge_band_px']*=factor
                observed['mask']=mask.copy()
                return original_unwrap(wrapped,mask,**kwargs)
            with patch.object(f,'unwrap_phase_2d',unwrap):
                result=f.analyze_interferogram(image,wavelength_nm=632.8,form_model='plane',
                    custom_mask=aperture,use_full_mask=aperture is None,n_zernike=15,
                    _edge_mode='legacy')
            pre=observed['mask']; yy,xx=np.nonzero(pre)
            y0,y1,x0,x1=yy.min(),yy.max()+1,xx.min(),xx.max()+1
            py,px=max(2,int(.05*(y1-y0))),max(2,int(.05*(x1-x0)))
            y0,y1,x0,x1=max(0,y0-py),min(n,y1+py),max(0,x0-px),min(n,x1+px)
            shape=(result['grid_rows'],result['grid_cols'])
            assert shape==(y1-y0,x1-x0)
            valid=np.array(result['mask_grid'],bool).reshape(shape)
            A=np.column_stack([np.ones(valid.sum()),x[y0:y1,x0:x1][valid],y[y0:y1,x0:x1][valid]])
            target=truth[y0:y1,x0:x1][valid]; target=target-A@np.linalg.lstsq(A,target,rcond=None)[0]
            sign=np.sign(result['carrier']['fx_cpp']*cycles+result['carrier']['fy_cpp']*3.3)
            recovered=sign*np.array(result['height_grid']).reshape(shape)[valid]
            error=recovered-target; error-=A@np.linalg.lstsq(A,error,rcond=None)[0]
            rows.append(dict(case=name,band_factor=factor,retained_pct=round(100*valid.sum()/pre.sum(),2),
                recovered_pv_nm=round(float(np.ptp(recovered)),3),truth_pv_on_retained_nm=round(float(np.ptp(target)),3),
                rms_error_nm=round(float(np.sqrt(np.mean(error**2))),3),max_error_nm=round(float(np.max(np.abs(error))),3)))
    return rows

if __name__=='__main__':
    # PNG/chart rendering does not affect the numerical results.
    from contextlib import ExitStack
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        print(json.dumps(characterize(),indent=2))
