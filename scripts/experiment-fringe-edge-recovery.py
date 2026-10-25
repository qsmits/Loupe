"""Evaluate edge recovery against production Hybrid and analytic truth.

Uses original fixed matrices plus new holdouts. Output includes full-surface,
common-area and added-area errors. Not a production algorithm switch.
"""
from pathlib import Path
import argparse,json,runpy,sys,time
from contextlib import ExitStack
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from backend.vision import fringe as f,fringe_hybrid as h
from fringe_edge_recovery import fit_window,stable_fit,anchored_candidate,extend_from_candidates,fringe_continuation
E=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-local-fit.py')))
B=E['B']


def capture(case):
    observed={};original_candidate=h.quadratic_candidate;original_combine=h.combine_candidate
    def candidate(image,mask,metadata,progress):
        phase,reliable,diagnostics=original_candidate(image,mask,metadata,progress)
        observed.update(image=image.copy(),fit_mask=mask.copy(),wrapped=phase.copy(),reliable=reliable.copy())
        observed['metadata']={**metadata,**diagnostics}
        return phase,reliable,diagnostics
    def combine(baseline,phase,reliable,mask,modulation,metadata,*args):
        result=original_combine(baseline,phase,reliable,mask,modulation,metadata,*args)
        observed.update(base_phase=baseline[0].copy(),base_valid=mask&(baseline[1]!=2),phase=result[0].copy(),valid=mask&(result[1]!=2),mask=mask.copy(),modulation=modulation.copy())
        return result
    with patch.object(h,'quadratic_candidate',candidate),patch.object(h,'combine_candidate',combine):
        result=f.analyze_interferogram(case['image'],wavelength_nm=632.8,custom_mask=case['selected'],n_zernike=15,form_model='plane',analysis_method='hybrid')
    observed['result']=result
    observed['sign']=np.sign(result['carrier']['fx_cpp']*case['fx']+result['carrier']['fy_cpp']*case['fy'])
    return observed


def run_case(case,methods):
    start=time.perf_counter();s=capture(case);scale=s['sign']*632.8/(4*np.pi)
    baseline=dict(valid=s['valid'],height=s['phase']*scale,result=s['result'])
    common_diag=dict(upstream_rejected=int((case['physical'] & ~s['mask']).sum()),
        downstream_rejected=int((s['mask'] & ~s['valid']).sum()))
    rows=[];outputs={}
    def record(method,phase,valid,extra=None):
        current=dict(valid=valid,height=phase*scale,phase=phase.copy())
        metrics=B['metrics'](case,current,baseline)
        # Fit the reference plane ONLY on baseline pixels for added-area audit.
        y,x=np.indices(valid.shape);anchor=s['valid'];A=np.column_stack([np.ones(anchor.sum()),x[anchor],y[anchor]])
        err=current['height']-case['truth'];coef=np.linalg.lstsq(A,err[anchor],rcond=None)[0]
        aligned=err-(coef[0]+coef[1]*x+coef[2]*y);added=valid & ~anchor
        metrics['added_anchor_rms_nm']=float(np.sqrt(np.mean(aligned[added]**2))) if added.any() else None
        metrics['added_anchor_max_nm']=float(np.abs(aligned[added]).max()) if added.any() else None
        rows.append(dict(case=case['name'],method=method,**metrics,**common_diag,**(extra or {}),seconds=round(time.perf_counter()-start,3)))
        outputs[method]=current
    record('hybrid',s['phase'],s['valid'])
    record('current',s['base_phase'],s['base_valid'])
    candidates=[]
    def anchored(phase,reliable,reach=1.,erode=True):
        return anchored_candidate(s['phase'],s['valid'],phase,reliable,s['mask'],s['modulation'],s['metadata']['fringe_period_px'],reach=reach,erode=erode)
    if 'guard-free' in methods:
        candidate=anchored(s['wrapped'],s['reliable'])
        phase,valid,_=extend_from_candidates(s['phase'],s['valid'],[candidate]);record('guard-free',phase,valid)
    pairs=[(.35,.175),(.5,.25),(.5,.5)]
    if any(m.startswith('bank') for m in methods) or any(m in methods for m in ('checked-composite','padded-composite')):
        cache={}
        def fit(a,b,degree=2):
            key=(a,b,degree)
            if key not in cache:cache[key]=fit_window(s['image'],s['fit_mask'],s['metadata'],a,b,degree)
            return cache[key]
        gates={}
        for a,b in pairs:
            small=fit(a,b);large=fit(a*1.3,b*1.3)
            reliable,reasons=stable_fit(small,large,s['mask'])
            gates[f'{a:g},{b:g}']=reasons
            candidates.append(anchored(small['phase'],reliable))
        for method in dict.fromkeys([*methods,*(['bank-model-check'] if any(m in methods for m in ('checked-composite','padded-composite')) else [])]):
            if not method.startswith('bank'):continue
            chosen=candidates
            if method=='bank-model-check':
                chosen=[]
                for a,b in pairs:
                    small=fit(a,b);large=fit(a*1.3,b*1.3);linear=fit(a,b,1)
                    reliable,_=stable_fit(small,large,s['mask'],phase_limit=.01)
                    reliable &= np.abs(np.angle(np.exp(1j*(small['phase']-linear['phase']))))<.01
                    chosen.append(anchored(small['phase'],reliable))
            if method in ('bank-noise-aware','bank-conditioned'):
                chosen=[]
                for a,b in pairs:
                    small=fit(a,b);large=fit(a*1.3,b*1.3)
                    floor=1.5*np.median(small['residual'][s['valid']]) if method=='bank-noise-aware' else 0.
                    reliable,_=stable_fit(small,large,s['mask'],phase_limit=.01,
                        condition_limit=10000 if method=='bank-conditioned' else 1000,residual_floor=floor)
                    chosen.append(anchored(small['phase'],reliable))
            if method=='bank-strict':
                chosen=[]
                for a,b in pairs:
                    small=fit(a,b);large=fit(a*1.3,b*1.3);reliable,_=stable_fit(small,large,s['mask'],phase_limit=.01)
                    chosen.append(anchored(small['phase'],reliable))
            if method=='bank-grow':
                chosen=[]
                for a,b in pairs:
                    small=fit(a,b);large=fit(a*1.3,b*1.3);reliable,_=stable_fit(small,large,s['mask'])
                    chosen.append(anchored(small['phase'],reliable,reach=None))
            if method=='bank-no-erosion':
                chosen=[]
                for a,b in pairs:
                    small=fit(a,b);large=fit(a*1.3,b*1.3);reliable,_=stable_fit(small,large,s['mask'])
                    chosen.append(anchored(small['phase'],reliable,erode=False))
            phase,valid,_=extend_from_candidates(s['phase'],s['valid'],chosen,consensus=method!='bank-union',tolerance=.01 if method in ('bank-strict','bank-noise-aware','bank-conditioned','bank-model-check') else .025)
            record(method,phase,valid,dict(reference_window_gates=gates))
    if any(m in methods for m in ('continuation','continuation-validated','checked-composite','padded-continuation','padded-composite')):
        wrapped,reliable,diagnostics=fringe_continuation(s['image'],s['mask'],s['phase'],s['valid'],s['metadata'])
        new=anchored(wrapped,reliable,reach=None)
        phase,valid,_=extend_from_candidates(s['phase'],s['valid'],[new])
        record('continuation',phase,valid,diagnostics)
        global_agreement=diagnostics['prediction_rms']<=max(.01*diagnostics['prediction_amplitude'],1.5*diagnostics['prediction_anchor_rms'])
        if not global_agreement:phase=s['phase'];valid=s['valid']
        if 'continuation-validated' in methods or any(m in methods for m in ('checked-composite','padded-composite')):
            record('continuation-validated',phase,valid,{**diagnostics,'global_prediction_passed':bool(global_agreement)})
        if 'padded-continuation' in methods or 'padded-composite' in methods:
            wrapped,reliable,padded_diag=fringe_continuation(s['image'],s['mask'],s['phase'],s['valid'],s['metadata'],pad_frame=True)
            pnew=anchored(wrapped,reliable,reach=None)
            pphase,pvalid,_=extend_from_candidates(s['phase'],s['valid'],[pnew])
            if not global_agreement:pphase=s['phase'];pvalid=s['valid']
            record('padded-continuation',pphase,pvalid,{**padded_diag,'global_prediction_passed':bool(global_agreement)})
            if 'padded-composite' in methods:
                bank=outputs['bank-model-check']
                merged=bank['phase'].copy();mask=bank['valid'].copy()
                extra=pvalid & ~mask;merged[extra]=pphase[extra];mask|=pvalid
                record('padded-composite',merged,mask,{'global_prediction_passed':bool(global_agreement)})
        if 'checked-composite' in methods:
            bank=outputs['bank-model-check']
            merged=bank['phase'].copy();mask=bank['valid'].copy()
            extra=valid & ~mask;merged[extra]=phase[extra];mask|=valid
            record('checked-composite',merged,mask,{'global_prediction_passed':bool(global_agreement)})
    return rows,outputs,s


def holdout_fixtures():
    """New asymmetric scenes, phases and pitches; fixed before the follow-up run."""
    from scipy.ndimage import gaussian_filter
    n=208;y,x=np.mgrid[:n,:n];u=x/n;v=y/n
    for j,kind in enumerate(('ellipse','annulus','clipped','near-edge-bump','sharp-roll','weak-rim','scratch','clipped-light')):
        for angle in (24,83,138):
            r=np.hypot((u-.47)/.39,(v-.53)/.33);physical=r<1
            if kind=='annulus':physical &= np.hypot(u-.52,v-.49)>.105
            if kind=='clipped':physical &= (v>.22+.15*u)
            cycles={24:8.8,83:16.7,138:27.1}[angle]
            fx=cycles/n*np.cos(np.deg2rad(angle));fy=cycles/n*np.sin(np.deg2rad(angle))
            truth=45*((u-.5)**2-.4*(v-.5)**2)-32*np.clip((r-.68)/.32,0,1)**2
            if kind=='near-edge-bump':truth+=55*np.exp(-((u-.75)**2+(v-.39)**2)/.0018)
            if kind=='sharp-roll':truth-=45*np.clip((r-.91)/.09,0,1)**2
            amp=np.full((n,n),68.)
            if kind=='weak-rim':amp*=.08+.92*np.clip((1-r)/.25,0,1)
            signal=122+40*(v-.5)+amp*np.cos(2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+.83+j*.47)
            cap=np.zeros_like(physical)
            if kind=='scratch':
                cap=physical&(abs(u-.51+.2*(v-.5))<.008);signal[cap]=235
            if kind=='clipped-light':signal=70+1.5*signal
            image=np.where(physical,signal,12.)
            noise=3.5 if angle==138 else 1.3
            image=np.rint(np.clip(image+np.random.default_rng(20261026+j*41+angle).normal(0,noise,image.shape),0,255))
            selected=physical.copy()
            yield dict(name=f'holdout-{kind}-{angle}',image=image,truth=truth,physical=physical,selected=selected,fx=fx,fy=fy,cap=cap)


def confirmation_fixtures():
    """First frozen-rule confirmation set, before the frame-padding follow-up."""
    n=180;y,x=np.mgrid[:n,:n];u=x/n;v=y/n
    for j,kind in enumerate(('flat','curved','roll','hole','scratch','harmonic')):
        for seed in (4,19):
            rng=np.random.default_rng(20261027+j*31+seed)
            angle=rng.uniform(0,np.pi);cycles=rng.uniform(10,25);fx=cycles/n*np.cos(angle);fy=cycles/n*np.sin(angle)
            radius=np.sqrt(((u-.51)/.40)**2+((v-.48)/.35)**2);physical=radius<1
            truth=np.zeros_like(u)
            if kind=='curved':truth=160*((u-.5)**2+.4*(v-.5)**2)
            if kind=='roll':truth=-35*np.clip((radius-.88)/.12,0,1)**2
            if kind=='hole':physical&=np.hypot(u-.56,v-.43)>.10
            phase=2*np.pi*(fx*x+fy*y)+rng.uniform(-np.pi,np.pi)+4*np.pi*truth/632.8
            signal=120+20*(u-.5)+72*np.cos(phase)
            if kind=='harmonic':signal+=12*np.cos(2*phase+.2)
            cap=np.zeros_like(physical)
            if kind=='scratch':cap=physical&(abs(v-.51-.11*u)<.007);signal[cap]=235
            image=np.rint(np.clip(np.where(physical,signal,14)+rng.normal(0,1.1 if seed==4 else 3.2,u.shape),0,255))
            yield dict(name=f'confirmation-{kind}-{seed}',image=image,truth=truth,physical=physical,selected=physical.copy(),fx=fx,fy=fy,cap=cap)



def blind_fixtures():
    """Post-freeze tests: odd rectangular frames and previously unused models.

    Specified after the padded composite was frozen. No parameters are revised
    against this suite. A warped carrier deliberately tests camera distortion;
    analytic part height excludes that optical artifact.
    """
    ny,nx=193,211;y,x=np.mgrid[:ny,:nx];u=x/(nx-1);v=y/(ny-1)
    for j,kind in enumerate(('quartic','two-bumps','contrast-gradient','gamma','warped-carrier','paired-defects')):
        for seed in (7,43):
            rng=np.random.default_rng(20261028+71*j+seed)
            angle=rng.uniform(.1,2.9);period=rng.uniform(9,21)
            fx,fy=np.cos(angle)/period,np.sin(angle)/period
            radius=np.hypot((u-.48)/.42,(v-.52)/.38);physical=radius<1
            truth=35*((u-.5)**2+.4*(v-.5)**2)
            if kind=='quartic':truth+=300*((u-.5)**4-1.5*(v-.5)**4)
            if kind=='two-bumps':truth+=40*np.exp(-((u-.69)**2+(v-.35)**2)/.002)-28*np.exp(-((u-.25)**2+(v-.59)**2)/.006)
            amplitude=np.full(u.shape,70.)
            if kind=='contrast-gradient':amplitude*=.15+.85*np.clip((1-radius)/.3,0,1)
            carrier=2*np.pi*(fx*x+fy*y)
            if kind=='warped-carrier':carrier+=.5*((u-.5)**2+(v-.5)**2)*(2*u-1)
            phase=carrier+4*np.pi*truth/632.8+rng.uniform(-np.pi,np.pi)
            signal=124+23*(u-.5)-17*(v-.5)+amplitude*np.cos(phase)
            if kind=='gamma':signal=255*(np.clip(signal,0,255)/255)**1.8
            cap=np.zeros_like(physical)
            if kind=='paired-defects':
                cap=physical&((np.hypot(u-.64,v-.39)<.027)|(np.hypot(u-.31,v-.60)<.019));signal[cap]=232
            image=np.rint(np.clip(np.where(physical,signal,11)+rng.normal(0,1.7 if seed==7 else 3.8,u.shape),0,255))
            yield dict(name=f'blind-{kind}-{seed}',image=image,truth=truth,physical=physical,selected=physical.copy(),fx=fx,fy=fy,cap=cap)


def main():
    p=argparse.ArgumentParser();p.add_argument('--suite',choices=['matrix','stress','challenge','holdout','confirmation','blind'],default='matrix');p.add_argument('--cases',nargs='+');p.add_argument('--methods',nargs='+',default=['guard-free','bank-union','bank-consensus','bank-strict','bank-grow','bank-no-erosion']);p.add_argument('--output',required=True);args=p.parse_args()
    cases=blind_fixtures() if args.suite=='blind' else confirmation_fixtures() if args.suite=='confirmation' else holdout_fixtures() if args.suite=='holdout' else E['challenge_fixtures']() if args.suite=='challenge' else B['fixtures'](args.suite=='stress')
    rows=[]
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        for case in cases:
            if args.cases and case['name'] not in args.cases:continue
            try:
                result,_,_=run_case(case,args.methods);rows.extend(result)
                print(case['name'],[(r['method'],round(r['coverage_pct'],1),round(r['rms_error_nm'],3)) for r in result],flush=True)
            except (ValueError,np.linalg.LinAlgError) as e:
                rows.append(dict(case=case['name'],error=str(e)));print(case['name'],'ERROR',e,flush=True)
            Path(args.output).write_text(json.dumps(rows,indent=2)+'\n')
if __name__=='__main__':main()
