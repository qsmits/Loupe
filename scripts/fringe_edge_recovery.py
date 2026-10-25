"""Research estimators: adaptive windows and interior-anchored edge recovery.

No production imports this module. Admission sees only image-derived fields;
analytic truth and physical boundaries are confined to the evaluation harness.
"""
import numpy as np
from scipy.ndimage import label, distance_transform_edt, binary_propagation
from backend.vision.fringe_hybrid import local_phase
from backend.vision import fringe as f


def fit_window(image, mask, metadata, across_fraction, along_fraction, degree=2):
    period=metadata['fringe_period_px'];theta=metadata['carrier_angle_rad']
    fx=metadata['refined_fx_cpp'];fy=metadata['refined_fy_cpp']
    diagnostics={}
    phase,condition,amplitude=local_phase(image,mask,fx,fy,max(3.,period*across_fraction),
        max(2.,period*along_fraction),degree,diagnostics)
    y,x=np.indices(image.shape)
    phase=np.angle(np.exp(1j*(phase+2*np.pi*((fx-np.cos(theta)/period)*x+(fy-np.sin(theta)/period)*y))))
    return dict(phase=phase,condition=condition,amplitude=amplitude,residual=diagnostics['residual'])


def stable_fit(a,b,mask,phase_limit=.025,condition_limit=1000,residual_floor=0.):
    condition=(a['condition']<condition_limit)&(b['condition']<condition_limit)
    amplitude=(a['amplitude']>15)&(b['amplitude']>15)
    residual=(a['residual']<np.maximum(a['amplitude']*.04,residual_floor))&(b['residual']<np.maximum(b['amplitude']*.04,residual_floor))
    agreement=np.abs(np.angle(np.exp(1j*(a['phase']-b['phase']))))<phase_limit
    valid=mask & condition & amplitude & residual & agreement
    # Report exclusive first-failing causes, not overlapping counts.
    reasons={};remaining=mask.copy()
    for name,gate in [('conditioning',condition),('contrast',amplitude),('image_residual',residual),('window_disagreement',agreement)]:
        reasons[name]=int((remaining&~gate).sum());remaining&=gate
    reasons['fit_passed']=int(valid.sum())
    return valid,reasons


def anchored_candidate(base_phase,base_valid,wrapped,reliable,mask,modulation,period,
                       reach=1.,agreement=.05,erode=True):
    """Unwrap real local fits and attach to ORIGINAL anchors, never filled values.

    No synthetic pixels enter the image regression. Every candidate component
    needs at least 25 anchor pixels and a consistent integer fringe order. Failed
    bridges are disconnected before growth; distance is measured from original
    observations even when all connected candidates are requested (reach=None).
    """
    local,_,_=f.unwrap_phase_2d(wrapped,mask,quality=modulation,
        fringe_period_px=period,edge_kernel=np.ones((1,1),np.uint8),correct_2pi_jumps=False)
    valid=reliable & mask & np.isfinite(local)
    if erode:valid=f._supported_interior(valid,np.ones((3,3),np.uint8))
    groups,count=label(valid)
    accepted=np.zeros_like(valid);aligned=local.copy()
    for j in range(1,count+1):
        region=groups==j;anchor=region & base_valid
        if anchor.sum()<25:continue
        turns=np.round(np.median((base_phase[anchor]-local[anchor])/(2*np.pi)))
        candidate=local+turns*2*np.pi
        error=np.abs(candidate[anchor]-base_phase[anchor])
        if np.percentile(error,90)>agreement:continue
        # Never use a disagreeing anchor as a bridge into a new area.
        eligible=region & (~base_valid | (np.abs(candidate-base_phase)<agreement))
        connected=binary_propagation(anchor & eligible,mask=eligible)
        if reach is not None:connected &= distance_transform_edt(~base_valid)<=period*reach
        accepted |= connected
        aligned[connected]=candidate[connected]
    return aligned,accepted


def extend_from_candidates(base_phase,base_valid,candidates,consensus=False,tolerance=.025):
    """Keep existing measurements exactly; fill only independently anchored fits."""
    out=base_phase.copy();valid=base_valid.copy();support=np.zeros_like(out,dtype=np.uint8)
    if not candidates:return out,valid,support
    phases=np.stack([p for p,m in candidates]);masks=np.stack([m for p,m in candidates])
    for j in range(len(candidates)):
        agreeing=masks & (np.abs(phases-phases[j])<tolerance)
        count=agreeing.sum(axis=0)
        permitted=masks[j] & ~base_valid & (count>=(2 if consensus else 1)) & (count>support)
        out[permitted]=np.sum(np.where(agreeing,phases,0),axis=0)[permitted]/count[permitted]
        valid[permitted]=True;support[permitted]=count[permitted]
    return out,valid,support


def fringe_continuation(image,mask,base_phase,base_valid,metadata,pad_frame=False):
    """Predict OUTSIDE the measured aperture only; never admit synthetic samples.

    A quadratic phase model plus quadratic illumination comes from the reliable
    interior. Image agreement is tested on actual in-aperture pixels before
    allowing the newly filtered phase to contribute. Model failure remains a
    diagnostic, never a reason to overwrite the original photograph.
    """
    from scipy.ndimage import uniform_filter
    y,x=np.indices(image.shape);u=x/max(1,image.shape[1]-1)-.5;v=y/max(1,image.shape[0]-1)-.5
    basis=np.stack([np.ones_like(u),u,v,u*u,u*v,v*v],axis=-1)
    coeff=np.linalg.lstsq(basis[base_valid],base_phase[base_valid],rcond=None)[0]
    residual_phase=basis@coeff
    theta=metadata['carrier_angle_rad'];period=metadata['fringe_period_px']
    fx,fy=np.cos(theta)/period,np.sin(theta)/period
    arg=2*np.pi*(fx*x+fy*y)+residual_phase
    design=np.concatenate([basis,np.cos(arg)[...,None],np.sin(arg)[...,None]],axis=-1)
    photo=np.linalg.lstsq(design[base_valid],image[base_valid],rcond=None)[0]
    predicted=design@photo
    # Keep EVERY real in-aperture pixel; only exterior/known exclusions filled.
    extended=np.where(mask,image,np.clip(predicted,0,255))
    if pad_frame:
        pad=int(np.ceil(2*period))
        py,px=np.mgrid[-pad:image.shape[0]+pad,-pad:image.shape[1]+pad]
        pu=px/max(1,image.shape[1]-1)-.5;pv=py/max(1,image.shape[0]-1)-.5
        pb=np.stack([np.ones_like(pu),pu,pv,pu*pu,pu*pv,pv*pv],axis=-1)
        pa=2*np.pi*(fx*px+fy*py)+pb@coeff
        pd=np.concatenate([pb,np.cos(pa)[...,None],np.sin(pa)[...,None]],axis=-1)
        extended=np.clip(pd@photo,0,255)
        extended[pad:-pad,pad:-pad]=np.where(mask,image,np.clip(predicted,0,255))
    wrapped=f.extract_phase_dft(extended,np.ones_like(extended,dtype=bool),
        carrier_override=(extended.shape[0]//2+fy*extended.shape[0],extended.shape[1]//2+fx*extended.shape[1]))
    if pad_frame:
        wrapped=np.angle(np.exp(1j*(wrapped[pad:-pad,pad:-pad]+2*np.pi*(fx+fy)*pad)))
    amplitude=float(np.hypot(photo[-2],photo[-1]))
    width=max(3,int(round(period)))
    weight=uniform_filter(mask.astype(float),size=width,mode='constant')
    mse=uniform_filter(np.where(mask,(image-predicted)**2,0),size=width,mode='constant')/np.maximum(weight,1e-12)
    reliable=mask & (np.sqrt(np.maximum(0,mse))<.04*amplitude) & (amplitude>15)
    return wrapped,reliable,dict(prediction_rms=float(np.sqrt(np.mean((image[mask]-predicted[mask])**2))),prediction_amplitude=amplitude,prediction_anchor_rms=float(np.sqrt(np.mean((image[base_valid]-predicted[base_valid])**2))))
