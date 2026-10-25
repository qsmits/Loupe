"""Experimental quadratic harmonic fit with conservative-estimator fallback.

Admission thresholds reproduce experiments/fringe-hybrid, not uncertainty bounds.
Kept separate so the default path never allocates local-fit work arrays.
"""
import numpy as np
from scipy.signal import fftconvolve
from scipy.ndimage import distance_transform_edt, label

def _local_phase_full(image, mask, fx, fy, across, along, degree=1, diagnostics=None, harmonics=1, target=None):
    """Polynomial background and complex amplitude, fixed detected carrier.

    Coordinates are scaled by the Gaussian sigmas for conditioning. All
    normal-equation convolutions exclude pixels outside the actual aperture.
    Solves are row-chunked; no full-frame 9x9/18x18 matrix allocation.
    """
    h,w=image.shape
    top,bottom,left,right = target or (0,h,0,w)
    crop=np.s_[top:bottom,left:right]
    theta=np.arctan2(fy,fx)
    radius=int(np.ceil(4*max(across,along)))
    ky,kx=np.mgrid[-radius:radius+1,-radius:radius+1]
    # Convolution uses target-source; the regression uses source-target.
    u=-(kx*np.cos(theta)+ky*np.sin(theta))/across
    v=-(-kx*np.sin(theta)+ky*np.cos(theta))/along
    g=np.exp(-.5*(u*u+v*v));g/=g.sum()
    terms=[(0,0),(1,0),(0,1)] if degree==1 else [(0,0),(1,0),(0,1),(2,0),(1,1),(0,2)]
    moments=sorted({(a+c,b+d) for a,b in terms for c,d in terms})
    yy,xx=np.indices(image.shape)
    carrier=2*np.pi*(fx*xx+fy*yy)
    trig=[np.ones_like(image)]
    for harmonic in range(1,2*harmonics+1):
        trig.extend([np.cos(harmonic*carrier),np.sin(harmonic*carrier)])
    ntrig=1+2*harmonics
    weights={}
    rhs={}
    weight=mask.astype(float)
    for a,b in moments:
        kernel=g*u**a*v**b
        for k,t in enumerate(trig):
            weights[a,b,k]=fftconvolve(weight*t,kernel,mode='same')[crop].copy()
        if (a,b) in terms:
            for k,t in enumerate(trig[:ntrig]):
                rhs[a,b,k]=fftconvolve(weight*t*image,kernel,mode='same')[crop].copy()
    energy=fftconvolve(weight*image*image,g,mode='same')[crop].copy()
    residual=np.full_like(image,np.inf)
    # trig products: 1, cos, sin, cos², sin², cos*sin.
    def trig_term(frequency,sine,scale):
        if frequency==0:return [] if sine else [(0,scale)]
        sign=-1 if sine and frequency<0 else 1
        return [(2*abs(frequency)-(0 if sine else 1),scale*sign)]
    products={}
    for k in range(ntrig):
        for m in range(k,ntrig):
            if k==0:products[k,m]=[(m,1.)];continue
            a=(k+1)//2;b=(m+1)//2
            sa=k%2==0;sb=m%2==0
            if not sa and not sb:
                terms_product=trig_term(a-b,False,.5)+trig_term(a+b,False,.5)
            elif sa and sb:
                terms_product=trig_term(a-b,False,.5)+trig_term(a+b,False,-.5)
            elif not sa:
                terms_product=trig_term(b+a,True,.5)+trig_term(b-a,True,.5)
            else:
                terms_product=trig_term(a+b,True,.5)+trig_term(a-b,True,.5)
            products[k,m]=terms_product
    basis=[(a,b,k) for k in range(ntrig) for a,b in terms]
    n=len(basis);phase=np.zeros_like(image);condition=np.full_like(image,np.inf)
    amplitude=np.zeros_like(image)
    top,bottom,left,right = target or (0,h,0,w)
    for start in range(top,bottom,8):
        sl=np.s_[start:min(start+8,bottom),left:right]
        moment_sl=np.s_[start-top:min(start+8,bottom)-top,:]
        shape=image[sl].shape
        matrix=np.empty((*shape,n,n));target=np.empty((*shape,n))
        for j,(a,b,k) in enumerate(basis):
            target[...,j]=rhs[a,b,k][moment_sl]
            for l,(c,d,m) in enumerate(basis):
                matrix[...,j,l]=sum(scale*weights[a+c,b+d,t][moment_sl] for t,scale in products[tuple(sorted((k,m)))])
        # Only evaluate inside the aperture; nearly unsupported exterior
        # matrices need not be solved or used to infer missing pixels.
        valid=mask[sl]
        mat=matrix[valid]
        if not mat.size:continue
        eig=np.linalg.eigvalsh(mat)
        cond=eig[:,-1]/np.maximum(eig[:,0],1e-15)
        condition[sl][valid]=cond
        mat+=np.eye(n)*1e-10
        solved=np.linalg.solve(mat,target[valid][...,None])[...,0]
        cosine=solved[:,len(terms)];sine=solved[:,2*len(terms)]
        phase[sl][valid]=np.arctan2(-sine,cosine)
        amplitude[sl][valid]=np.hypot(cosine,sine)
        sse=energy[moment_sl][valid]-np.sum(solved*target[valid],axis=-1)
        residual[sl][valid]=np.sqrt(np.maximum(0,sse)/np.maximum(weights[0,0,0][moment_sl][valid],1e-12))
    if diagnostics is not None:
        diagnostics.update(residual=residual,condition=condition,amplitude=amplitude)
    return phase,condition,amplitude


def local_phase(image, mask, fx, fy, across, along, degree=1, diagnostics=None, harmonics=1, _tile_size=256):
    """Finite-support fits in tiles, with full Gaussian-kernel halos.

    Only the core is solved; neighboring real samples still contribute through
    the halo. Restore the global carrier origin before assembling the phases.
    This bounds the moment arrays without changing the estimator or resolution.
    """
    h,w=image.shape
    if max(h,w)<=_tile_size:
        return _local_phase_full(image,mask,fx,fy,across,along,degree,diagnostics,harmonics)
    halo=int(np.ceil(4*max(across,along)))
    phase=np.zeros_like(image);condition=np.full_like(image,np.inf)
    amplitude=np.zeros_like(image);residual=np.full_like(image,np.inf)
    for top in range(0,h,_tile_size):
        for left in range(0,w,_tile_size):
            bottom=min(h,top+_tile_size);right=min(w,left+_tile_size)
            core=np.s_[top:bottom,left:right]
            if not mask[core].any():continue
            y0=max(0,top-halo);y1=min(h,bottom+halo)
            x0=max(0,left-halo);x1=min(w,right+halo)
            tile=np.s_[y0:y1,x0:x1]
            local_core=np.s_[top-y0:bottom-y0,left-x0:right-x0]
            fit={}
            p,c,a=_local_phase_full(image[tile],mask[tile],fx,fy,across,along,
                degree,fit,harmonics,target=(top-y0,bottom-y0,left-x0,right-x0))
            phase[core]=np.angle(np.exp(1j*(p[local_core]-2*np.pi*(fx*x0+fy*y0))))
            condition[core]=c[local_core];amplitude[core]=a[local_core]
            residual[core]=fit['residual'][local_core]
    phase[~mask]=0
    if diagnostics is not None:diagnostics.update(residual=residual,condition=condition,amplitude=amplitude)
    return phase,condition,amplitude


def hybrid_merge(base_phase, base_valid, local, local_valid, reliable, period,
                 agreement=.04):
    """Blend only connected, order-anchored fits; baseline survives rejection.

    Phases must share a carrier reference. Agreement is radians, not an
    uncertainty claim. No analytic truth or known physical boundary is read.
    """
    from . import fringe as f

    reliable = reliable & local_valid & np.isfinite(local)
    # Stay away from failed-fit transitions (not just the aperture boundary).
    reliable = f._supported_interior(reliable, np.ones((3,3),np.uint8))
    components,count=label(reliable)
    accepted=np.zeros_like(base_valid)
    aligned=local.copy()
    for component in range(1,count+1):
        region=components==component
        anchor=region & base_valid
        if anchor.sum()<25:continue
        turns=np.round(np.median((base_phase[anchor]-local[anchor])/(2*np.pi)))
        aligned[region]+=turns*2*np.pi
        # A component whose order cannot be resolved consistently is rejected.
        delta=np.abs(aligned[anchor]-base_phase[anchor])
        if np.percentile(delta,90)>agreement:continue
        accepted |= region
    accepted &= ~base_valid | (np.abs(aligned-base_phase)<agreement)
    # New pixels must stay near existing supported measurements, not bridge
    # a hole or form a distant island based only on a good-looking fit.
    accepted &= distance_transform_edt(~base_valid)<=period
    weight=np.minimum(1.,distance_transform_edt(accepted)/max(2.,period*.25))
    valid=base_valid | accepted
    out=base_phase.copy()
    common=base_valid & accepted
    out[common]+=weight[common]*(aligned[common]-base_phase[common])
    out[accepted & ~base_valid]=aligned[accepted & ~base_valid]
    return out,valid,accepted

def quadratic_candidate(image, mask, metadata, progress=lambda *args: None):
    """Return phase in the original carrier reference and image-only fit checks."""
    from . import fringe as f
    theta=metadata['carrier_angle_rad'];period=metadata['fringe_period_px']
    fx0,fy0=np.cos(theta)/period,np.sin(theta)/period
    fx,fy=fx0,fy0
    across,along=max(3.,period*.5),max(2.,period*.25)
    fit={}
    for iteration in range(3):
        progress('hybrid-fit', .28+iteration*.05,
                 f'Experimental hybrid: local quadratic fit {iteration+1}/3…')
        phase,condition,amplitude=local_phase(image,mask,fx,fy,across,along,2,fit)
        if iteration==2:break
        support=f._supported_interior(mask,np.ones((7,7),np.uint8))
        support &= (condition<1000) & (amplitude>np.median(amplitude[mask])*.3)
        mx=support[:,1:] & support[:,:-1];my=support[1:,:] & support[:-1,:]
        if not mx.any() or not my.any():break
        fx+=np.median(np.angle(np.exp(1j*np.diff(phase,axis=1)))[mx])/(2*np.pi)
        fy+=np.median(np.angle(np.exp(1j*np.diff(phase,axis=0)))[my])/(2*np.pi)
    progress('hybrid-check', .44, 'Experimental hybrid: checking a wider fit window…')
    check={}
    alternate,_,_=local_phase(image,mask,fx,fy,max(3.,period*.65),max(2.,period*.325),2,check)
    reliable=(condition<1000) & (check['condition']<1000)
    reliable &= (amplitude>15) & (check['amplitude']>15)
    reliable &= (fit['residual']<amplitude*.04) & (check['residual']<check['amplitude']*.04)
    reliable &= np.abs(np.angle(np.exp(1j*(phase-alternate))))<.025
    y,x=np.indices(image.shape)
    phase=np.angle(np.exp(1j*(phase+2*np.pi*((fx-fx0)*x+(fy-fy0)*y))))
    return phase,reliable,dict(version=1,polynomial_degree=2,
        sigma_across_px=across,sigma_along_px=along,guard_fraction=.3,
        refined_fx_cpp=float(fx),refined_fy_cpp=float(fy))


def combine_candidate(baseline, phase, reliable, mask, modulation, metadata,
                      edge_band, edge_kernel, correct_2pi_jumps):
    from . import fringe as f
    base_phase,base_risk,base_quality=baseline
    kernel=None
    if edge_kernel is not None:
        kernel=f._elliptical_boundary_kernel(max(1.,metadata['boundary_across_px']*.3),
            max(1.,metadata['boundary_along_px']*.3),metadata['carrier_angle_rad'])
    local,risk,quality=f.unwrap_phase_2d(phase,mask,quality=modulation,
        fringe_period_px=metadata['fringe_period_px'],correct_2pi_jumps=correct_2pi_jumps,
        edge_band_px=edge_band,edge_kernel=kernel)
    base_valid=mask & (base_risk!=2)
    phase,valid,accepted=hybrid_merge(base_phase,base_valid,local,mask & (risk!=2),
        reliable,metadata['fringe_period_px'],agreement=.05)
    combined_risk=np.where(valid,base_risk,2).astype(np.uint8)
    combined_risk[accepted]=0
    quality=np.where(accepted,quality,base_quality)
    stats=dict(local_pixels=int(accepted.sum()),added_pixels=int((accepted & ~base_valid).sum()),
        fallback_pixels=int((base_valid & ~accepted).sum()),baseline_pixels=int(base_valid.sum()))
    return phase,combined_risk,quality,stats
