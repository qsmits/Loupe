"""Research-only local harmonic regression near fringe aperture edges.

Fits background and sine/cosine amplitudes to real in-aperture samples using
Gaussian weighted least squares. No pixels are synthesized outside the part.
This is a local regression experiment, not an implementation of Qian's WFR.
Run with --help; JSON records errors against analytic surfaces in nanometres.
"""
from pathlib import Path
import argparse
from contextlib import ExitStack
import json
import runpy
import time
import resource
import sys
from unittest.mock import patch
import numpy as np
from scipy.signal import fftconvolve
from scipy.ndimage import distance_transform_edt, label

B = runpy.run_path(str(Path(__file__).with_name('validate-fringe-boundaries.py')))
f = B['f']


from backend.vision.fringe_hybrid import local_phase, hybrid_merge


def evaluate(case, method):
    original_extract=f.extract_phase_dft
    original_kernel=f._elliptical_boundary_kernel
    original_unwrap=f.unwrap_phase_2d
    fit_quality={}
    diag={}
    mode='bounded'
    if method=='bounded':return B['analyze_case'](case,mode),diag
    parts=method.split(':')
    if len(parts) not in (3,4):
        raise ValueError('Use kind:window_fraction:guard_fraction[:polynomial_degree]')
    kind=parts[0];scale=float(parts[1]);guard=float(parts[2]);degree=int(parts[3]) if len(parts)>3 else 1
    if kind not in ('guard','local','refined','screened','screened-ungrouped','harmonic','hybrid','hybrid-strict'):
        raise ValueError(f'Unknown experimental estimator: {kind}')
    if not (0 < scale <= 2 and 0 <= guard <= 1 and degree in (1,2)):
        raise ValueError('Window must be in (0,2], guard in [0,1], degree 1 or 2')
    baseline={}
    if kind.startswith('hybrid'):
        def record(wrapped,mask=None,**kwargs):
            phase,risk,quality=original_unwrap(wrapped,mask,**kwargs)
            baseline.update(phase=phase,valid=mask & (risk!=2),risk=risk,quality=quality)
            return phase,risk,quality
        with patch.object(f,'unwrap_phase_2d',record):
            B['analyze_case'](case,mode)
    def extract(image,mask=None,**kwargs):
        wrapped,plain=original_extract(image,mask,**kwargs)
        meta=kwargs['filter_metadata'];theta=meta['carrier_angle_rad'];period=meta['fringe_period_px']
        if kind in ('local','refined','screened','screened-ungrouped','harmonic','hybrid','hybrid-strict'):
            wrapped,condition,amplitude=local_phase(image,mask,np.cos(theta)/period,np.sin(theta)/period,
                max(3.,period*scale),max(2.,period*scale/2),degree,fit_quality,harmonics=2 if kind=='harmonic' else 1)
            if kind=='refined' or kind.startswith('hybrid'):
                fx,fy=np.cos(theta)/period,np.sin(theta)/period
                for _ in range(2):
                    support=f._supported_interior(mask,np.ones((7,7),np.uint8))
                    support &= (condition<1000) & (amplitude>np.median(amplitude[mask])*.3)
                    mx=support[:,1:] & support[:,:-1];my=support[1:,:] & support[:-1,:]
                    if not mx.any() or not my.any():break
                    fx+=np.median(np.angle(np.exp(1j*np.diff(wrapped,axis=1)))[mx])/(2*np.pi)
                    fy+=np.median(np.angle(np.exp(1j*np.diff(wrapped,axis=0)))[my])/(2*np.pi)
                    wrapped,condition,amplitude=local_phase(image,mask,fx,fy,
                        max(3.,period*scale),max(2.,period*scale/2),degree,fit_quality)
                diag.update(refined_fx_cpp=float(fx),refined_fy_cpp=float(fy))
                if kind.startswith('hybrid'):
                    check={}
                    alternative,_,_=local_phase(image,mask,fx,fy,
                        max(3.,period*scale*1.3),max(2.,period*scale/2*1.3),degree,check)
                    limit=.01 if kind=='hybrid-strict' else .025
                    reliable=(fit_quality['condition']<1000) & (check['condition']<1000)
                    reliable &= (amplitude>15) & (check['amplitude']>15)
                    reliable &= (fit_quality['residual']<amplitude*.04) & (check['residual']<check['amplitude']*.04)
                    reliable &= np.abs(np.angle(np.exp(1j*(wrapped-alternative))))<limit
                    fit_quality['reliable']=reliable
                    fit_quality['period']=period
                    # Carrier refinement removes a plane. Restore the original
                    # carrier reference BEFORE comparing phases or fringe orders.
                    yy,xx=np.indices(image.shape)
                    wrapped=np.angle(np.exp(1j*(wrapped+2*np.pi*((fx-np.cos(theta)/period)*xx+(fy-np.sin(theta)/period)*yy))))
            diag.update(condition_p99=float(np.percentile(condition[mask],99)),
                        condition_max=float(condition[mask].max()),amplitude_p01=float(np.percentile(amplitude[mask],1)))
        return wrapped,plain
    def kernel(across,along,theta):
        return original_kernel(max(1.,across*guard),max(1.,along*guard),theta)
    def unwrap(wrapped,mask=None,**kwargs):
        valid=mask.copy()
        if kind in ('screened','screened-ungrouped'):
            valid &= (fit_quality['residual'] < .10*fit_quality['amplitude']) & (fit_quality['condition'] < 10000)
        if kind=='screened':
            # Removing a scratch can disconnect the aperture. Fringe order
            # between those components is unobservable: never merge their PV.
            valid=f._largest_component_mask(valid)
        phase,risk,quality=original_unwrap(wrapped,valid,**kwargs)
        risk[mask & ~valid]=2
        if kind.startswith('hybrid'):
            phase,valid,accepted=hybrid_merge(baseline['phase'],baseline['valid'],phase,
                mask & (risk!=2),fit_quality['reliable'],fit_quality['period'],
                agreement=.02 if kind=='hybrid-strict' else .05)
            risk=np.where(valid,baseline['risk'],2).astype(np.uint8)
            risk[accepted]=0
            quality=np.where(accepted,quality,baseline['quality'])
            diag.update(local_pixels=int(accepted.sum()),fallback_pixels=int((baseline['valid'] & ~accepted).sum()))
        return phase,risk,quality
    with patch.object(f,'extract_phase_dft',extract),patch.object(f,'_elliptical_boundary_kernel',kernel),patch.object(f,'unwrap_phase_2d',unwrap):
        return B['analyze_case'](case,mode),diag


def challenge_fixtures():
    """Separate holdouts: not used to select the pilot window sizes.

    Include non-sinusoidal fringes, curved illumination, clipping, local
    surface features, blur and erroneous selections; deterministic 8-bit data.
    """
    from scipy.ndimage import gaussian_filter
    n=224
    y,x=np.mgrid[:n,:n];u=x/n;v=y/n
    r=np.hypot(u-.49,v-.52);physical=r<.39
    for i,kind in enumerate(('harmonic','illumination','contrast','clipping','blur',
                            'bump','strong-bow','scratch','hole','loose')):
        for angle in (11,56,119):
            cycles=9.6 if angle==11 else 22.3
            fx=cycles/n*np.cos(np.deg2rad(angle));fy=cycles/n*np.sin(np.deg2rad(angle))
            truth=-30*np.clip((r-.27)/.12,0,1)**2
            if kind=='bump':truth=65*np.exp(-((u-.70)**2+(v-.43)**2)/(.055**2))
            if kind=='strong-bow':truth=350*((u-.5)**2-.65*(v-.5)**2)
            phase=2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+1.57+i*.31
            bg=125+25*(u-.5);amp=np.full((n,n),70.)
            if kind=='illumination':bg+=100*((u-.5)**2+2*(v-.5)**2)+30*np.exp(-((u-.69)**2+(v-.36)**2)/.025)
            if kind=='contrast':amp*=.25+.75*np.clip((.39-r)/.10,0,1)
            signal=bg+amp*np.cos(phase)
            if kind=='harmonic':signal+=.18*amp*np.cos(2*phase+.4)+.07*amp*np.cos(3*phase-.2)
            if kind=='clipping':signal=50+1.55*signal
            part=physical.copy()
            if kind=='hole':part&=np.hypot(u-.62,v-.48)>.09
            cap=np.zeros((n,n),bool)
            if kind=='scratch':
                cap=physical & (abs(v-.49-.15*(u-.5))<.009)
                signal[cap]=230
            image=np.where(part,signal,15.)
            if kind=='blur':image=gaussian_filter(image,1.6)
            image=np.rint(np.clip(image+np.random.default_rng(20261025+i*13+angle).normal(0,2.,image.shape),0,255))
            selected=(r<.46) if kind=='loose' else part.copy()
            yield dict(name=f'challenge-{kind}-{angle}',image=image,truth=truth,physical=part,
                       selected=selected,fx=fx,fy=fy,cap=cap)


def compare(methods,names=None,stress=False,challenge=False):
    if not methods or methods[0]!='bounded':
        raise ValueError('First method must be bounded (current baseline)')
    rows=[]
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        for case in (challenge_fixtures() if challenge else B['fixtures'](stress)):
            if names and case['name'] not in names:continue
            baseline=None
            for method in methods:
                start=time.perf_counter()
                try:
                    current,diag=evaluate(case,method)
                    if baseline is None:baseline=current
                    rows.append(dict(case=case['name'],method=method,**B['metrics'](case,current,baseline),**diag,seconds=round(time.perf_counter()-start,3)))
                except (ValueError,np.linalg.LinAlgError) as e:
                    rows.append(dict(case=case['name'],method=method,error=str(e)))
            print(case['name'],flush=True)
    return rows


def benchmark(size):
    """One native, single-pass fit; RSS includes imports and process overhead."""
    y,x=np.mgrid[:size,:size]
    mask=np.hypot(x-.5*size,y-.5*size)<.4*size
    fx,fy=17.4/size,6.2/size
    image=np.where(mask,125+75*np.cos(2*np.pi*(fx*x+fy*y)+.4),15.)
    start=time.perf_counter()
    local_phase(image,mask,fx,fy,22.2*size/1024,11.1*size/1024)
    rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return dict(size=size,seconds=time.perf_counter()-start,
                peak_process_rss_bytes=rss if sys.platform=='darwin' else rss*1024)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    suite=p.add_mutually_exclusive_group()
    suite.add_argument('--challenge',action='store_true')
    suite.add_argument('--stress',action='store_true')
    suite.add_argument('--benchmark-size',type=int)
    p.add_argument('--output',required=True)
    p.add_argument('--cases',nargs='+')
    p.add_argument('--methods',nargs='+',default=['bounded','guard:1:.5','local:.4:.4:1','refined:.4:.4:1'],
        help='bounded, or kind:window_fraction:guard_fraction[:degree]. Kinds: guard, local, refined, harmonic, screened, screened-ungrouped, hybrid, hybrid-strict. Window is across-fringe sigma / period; along sigma is half. Guard scales the current directional radii; full-frame square guards stay unchanged. Degree is 1 or 2.')
    args=p.parse_args()
    if args.methods[0]!='bounded':p.error('First method must be bounded (current baseline)')
    if args.benchmark_size:
        if not 32<=args.benchmark_size<=2048:p.error('Benchmark size must be 32–2048')
        result=benchmark(args.benchmark_size)
    else:
        result=compare(args.methods,args.cases,args.stress,args.challenge)
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
