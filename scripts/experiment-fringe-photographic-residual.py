"""Research-only residual gates for textured/low-contrast interferograms.

No production acceptance thresholds change. All candidates keep the Current
heights unchanged and use real-image phase fits, original anchors, and a second
unwrap-path check. Run --suite for analytic truth, or --project a local .loupe
export. User images/arrays stay in the explicitly chosen local cache directory.
"""
from pathlib import Path
import argparse
from contextlib import ExitStack
import json
import runpy
import sys
from unittest.mock import patch
import numpy as np
from scipy.ndimage import gaussian_filter
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.vision import fringe as f, fringe_hybrid as h, fringe_composite as c
from backend.browser.fringe import _prepare


def capture(image, custom_mask=None, threshold=.3):
    fits=[]; source={}; original_fit=h.local_phase; original_merge=h.combine_candidate
    def record_fit(*args,**kwargs):
        output=original_fit(*args,**kwargs)
        diagnostics=args[7] if len(args)>7 else kwargs['diagnostics']
        fits.append(dict(phase=output[0],condition=output[1],amplitude=output[2],residual=diagnostics['residual']))
        return output
    def record_merge(baseline,phase,reliable,mask,modulation,metadata,edge_band,edge_kernel,correct):
        source.update(image=image,mask=mask,modulation=modulation,phase=phase,
                      base_phase=baseline[0],base_risk=baseline[1],base_quality=baseline[2],
                      metadata=dict(metadata),edge_band=edge_band,edge_kernel=edge_kernel)
        return original_merge(baseline,phase,reliable,mask,modulation,metadata,edge_band,edge_kernel,correct)
    with patch.object(h,'local_phase',record_fit),patch.object(h,'combine_candidate',record_merge):
        result=f.analyze_interferogram(image,custom_mask=custom_mask,analysis_method='hybrid',
            mask_threshold=threshold,form_model='plane',n_zernike=15)
    source['metadata'].update(result['hybrid_diagnostics'])
    source['a'],source['b']=fits[-2:]
    return source


def candidates(source):
    m=source['mask'];a,b=source['a'],source['b'];meta=source['metadata'];period=meta['fringe_period_px']
    base=source['base_phase'];bv=m&(source['base_risk']!=2)
    condition=(a['condition']<1000)&(b['condition']<1000)
    contrast=(a['amplitude']>15)&(b['amplitude']>15)
    window=np.abs(np.angle(np.exp(1j*(a['phase']-b['phase']))))<.025
    residual=np.maximum(a['residual']/np.maximum(a['amplitude'],1e-12),b['residual']/np.maximum(b['amplitude'],1e-12))
    weight=m.astype(float);sigma=max(.5,period*.05)
    image=source['image'].astype(float)
    filtered=gaussian_filter(image*weight,sigma)/np.maximum(gaussian_filter(weight,sigma),1e-12)
    fx,fy=meta['refined_fx_cpp'],meta['refined_fy_cpp'];qa={};qb={}
    pa,ca,aa=h.local_phase(filtered,m,fx,fy,max(3.,period*.5),max(2.,period*.25),2,qa)
    pb,cb,ab=h.local_phase(filtered,m,fx,fy,max(3.,period*.65),max(2.,period*.325),2,qb)
    filtered_residual=np.maximum(qa['residual']/np.maximum(aa,1e-12),qb['residual']/np.maximum(ab,1e-12))
    filtered_stable=(ca<1000)&(cb<1000)&(aa>15)&(ab>15)
    filtered_stable &= np.abs(np.angle(np.exp(1j*(pa-pb))))<.025
    filtered_stable &= np.abs(np.angle(np.exp(1j*(pa-a['phase']))))<.025
    filtered_stable &= np.abs(np.angle(np.exp(1j*(pb-b['phase']))))<.025
    gates={
        'strict':condition&contrast&window&(residual<.04),
        'residual-20pct':condition&contrast&window&(residual<.20),
        'filtered-residual-4pct':condition&contrast&window&filtered_stable&(filtered_residual<.04),
        'filtered-residual-10pct':condition&contrast&window&filtered_stable&(filtered_residual<.10),
    }
    yield 'current',base,bv,dict(added_pixels=0)
    for name,gate in gates.items():
        # Prefiltering only evaluates residual structure; retain the RAW fit's
        # phase. Never use generated exterior values or new pixels as anchors.
        phase,accepted=c.anchored_candidate(base,bv,source['phase'],m&gate,m,source['modulation'],period)
        out=base.copy();added=accepted&~bv;out[added]=phase[added];valid=bv|added
        conflict,order=c.order_check(out,valid)
        # Research additions fail closed when their island has conflicting order;
        # baseline is kept so this study never silently changes the reference.
        added &= ~conflict;valid=bv|added;out[~added]=base[~added]
        yield name,out,valid,dict(fit_passed=int((m&gate).sum()),added_pixels=int(added.sum()),
            rejected_order_pixels=order['conflicted_pixels'],filter_sigma_px=sigma)


def fixtures():
    E=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-local-fit.py')))
    names={'flat-6.3','bow-10.7','broad-roll-17.4','narrow-roll-10.7','noisy-hole-flat',
           'precise-weak-rim','oversized-flat','precise-cap'}
    originals=[case for case in E['B']['fixtures']() if case['name'] in names]
    yield from originals
    yield from [case for case in E['challenge_fixtures']() if case['name'] in
                {'challenge-blur-56','challenge-blur-119','challenge-scratch-119','challenge-loose-11'}]
    for i,case in enumerate(originals[:4]):
        rng=np.random.default_rng(611+i)
        image=125+.26*(case['image']-125)+rng.normal(0,3,case['image'].shape)
        yield {**case,'name':'low-contrast-noisy-'+case['name'],'image':image}
        texture=gaussian_filter(rng.normal(0,1,image.shape),2)
        texture*=3/max(texture.std(),1e-12)
        yield {**case,'name':'correlated-texture-'+case['name'],'image':image+texture}


def holdouts():
    """Fresh image-model violations, fixed before reviewing their outcomes."""
    n=256;y,x=np.mgrid[:n,:n];r=np.hypot(x-129,y-125);physical=r<105
    physical &= np.hypot(x-141,y-143)>13
    for i in range(12):
        period=[14.,23.,31.][i%3];angle=[.23,1.12,2.13][i%3]
        fx,fy=np.cos(angle)/period,np.sin(angle)/period
        truth=8*((x-128)/105)**2-35*np.clip((r-88)/17,0,1)**2
        if i>=6: truth-=25*np.exp(-((r-100)/2.5)**2)
        arg=2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+.37*i
        rng=np.random.default_rng(9010+i)
        amplitude=20+5*np.sin(x/83)
        image=160+25*np.cos(y/91)+amplitude*np.cos(arg)
        kind=['harmonics','correlated','scratch'][i%3]
        defect=np.zeros_like(physical)
        if kind=='harmonics':image+=5*np.cos(2*arg+.4)+2*np.cos(3*arg)
        if kind=='correlated':
            texture=gaussian_filter(rng.normal(0,1,(n,n)),[.8,2.,5.,8.][i//3])
            image+=3*texture/texture.std()
        if kind=='scratch':
            defect=physical&(np.abs(y-.35*x-90)<2)
            image[defect]=145
        image+=rng.normal(0,1.5,(n,n))
        image=np.where(physical,image,30)
        yield dict(name=f'holdout-{i}-{kind}',image=image,truth=truth,physical=physical,
            selected=physical.copy(),fx=fx,fy=fy,cap=defect)


def metrics(case,source,phase,valid):
    mask=source['mask'];base=mask&(source['base_risk']!=2);added=valid&~base
    result=dict(coverage_pct=float(100*valid.sum()/mask.sum()),included_pixels=int(valid.sum()),
                common_change_max_rad=float(np.max(np.abs(phase[base]-source['base_phase'][base]))))
    if case is None:return result
    meta=source['metadata'];theta=meta['carrier_angle_rad'];sign=np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])
    error=phase*sign*632.8/(4*np.pi)-case['truth'];y,x=np.indices(mask.shape)
    # Fit offset/tilt ONCE on ORIGINAL Current anchors. Extra coverage may not
    # improve its score by choosing a different plane or sign from the truth.
    A=np.column_stack([np.ones(base.sum()),x[base],y[base]])
    reference=source['base_phase']*sign*632.8/(4*np.pi)-case['truth']
    co=np.linalg.lstsq(A,reference[base],rcond=None)[0];error-=co[0]+co[1]*x+co[2]*y
    result.update(coverage_pct=float(100*(valid&case['physical']).sum()/case['physical'].sum()),
        max_error_nm=float(np.abs(error[valid]).max()),rms_error_nm=float(np.sqrt(np.mean(error[valid]**2))),
        added_max_error_nm=float(np.abs(error[added]).max()) if added.any() else None,
        outside_pixels=int((valid&~case['physical']).sum()),added_defect_pixels=int((added&case['cap']).sum()))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    source=parser.add_mutually_exclusive_group(required=True);source.add_argument('--suite',action='store_true');source.add_argument('--holdout',action='store_true');source.add_argument('--project',type=Path)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--cache',type=Path)
    args=parser.parse_args();rows=[]
    if args.project:
        data=json.loads(args.project.read_text())['workspace']['opaque']['data'];r=data['lastResult']
        image,mask,*_=_prepare(dict(image_b64=data['droppedImageB64'],mask_polygons=data.get('maskPolygons'),lens_k1=data.get('lensK1',0)))
        cases=[dict(name='local-interferogram',image=image,selected=mask,threshold=r.get('tuning',{}).get('mask_threshold',.3),real=True)]
    else:cases=holdouts() if args.holdout else fixtures()
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        for case in cases:
            observed=capture(case['image'],case['selected'],case.get('threshold',.3))
            for method,phase,valid,diagnostics in candidates(observed):
                row=dict(case=case['name'],method=method,**metrics(None if case.get('real') else case,observed,phase,valid),**diagnostics)
                rows.append(row);print(json.dumps(row),flush=True)
                if args.cache:
                    args.cache.mkdir(parents=True,exist_ok=True)
                    np.savez_compressed(args.cache/f"{case['name']}-{method}.npz",phase=phase,valid=valid,mask=observed['mask'],image=case['image'])
            args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(rows,indent=2)+'\n')

if __name__=='__main__':main()
