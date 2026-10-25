"""Research-only recovery beyond the photographic Composite; no UI gates change.

Run --real-cache with the prior local diagnostic cache, or --suite for 40 known
surfaces. Every candidate anchors to original Hybrid observations and retains
all currently accepted Composite phases. Synthetic truth is scoring-only.
"""
from pathlib import Path
import sys,json,runpy,argparse,hashlib
from contextlib import ExitStack
from unittest.mock import patch
import numpy as np
from scipy.ndimage import gaussian_filter,binary_propagation
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.vision import fringe_composite as c,fringe_hybrid as h,fringe as f
E=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-texture-composite.py')))

class Fits:
    def __init__(self, directory=None):self.cache={};self.directory=directory
    def __call__(self,image,mask,meta,a,b,degree=2,harmonics=1):
        key=hashlib.sha256(image.tobytes()+mask.tobytes()+repr((a,b,degree,harmonics,meta['refined_fx_cpp'],meta['refined_fy_cpp'],meta['carrier_angle_rad'],meta['fringe_period_px'])).encode()).hexdigest()
        if key in self.cache:return self.cache[key]
        path=self.directory/(key+'.npz') if self.directory else None
        if path and path.exists():out=dict(np.load(path))
        else:
            period=meta['fringe_period_px'];fx=meta['refined_fx_cpp'];fy=meta['refined_fy_cpp'];theta=meta['carrier_angle_rad'];diag={}
            p,condition,amplitude=h.local_phase(image,mask,fx,fy,max(3.,period*a),max(2.,period*b),degree,diag,harmonics=harmonics)
            y,x=np.indices(image.shape)
            phase=np.angle(np.exp(1j*(p+2*np.pi*((fx-np.cos(theta)/period)*x+(fy-np.sin(theta)/period)*y))))
            out=dict(phase=phase,condition=condition,amplitude=amplitude,residual=diag['residual'])
            if path:path.parent.mkdir(parents=True,exist_ok=True);np.savez_compressed(path,**out)
        self.cache[key]=out;return out

def delta(a,b):return np.abs(np.angle(np.exp(1j*(a-b))))

def screened(image,mask,meta,fit,scale=1.,harmonics=1,residual=.2,agreement=.025,degree=2):
    def pair(img,across,along):
        return tuple(fit(img,mask,meta,scale*a,scale*b,degree=degree,harmonics=harmonics) for a,b in [(across,along),(1.3*across,1.3*along)])
    a,b=pair(image,.5,.25)
    gates=[]
    def check(a,b,prefix):
        gates.extend([(prefix+'conditioning',(a['condition']<1000)&(b['condition']<1000)),
                      (prefix+'contrast',(a['amplitude']>15)&(b['amplitude']>15)),
                      (prefix+'residual',(a['residual']<residual*a['amplitude'])&(b['residual']<residual*b['amplitude'])),
                      (prefix+'window_agreement',delta(a['phase'],b['phase'])<agreement)])
    check(a,b,'raw_')
    sigma=max(.5,meta['fringe_period_px']*.05)
    filtered=gaussian_filter(np.where(mask,image,0.),sigma,mode='constant')/np.maximum(gaussian_filter(mask.astype(float),sigma,mode='constant'),1e-12)
    fa,fb=pair(filtered,.5,.25);check(fa,fb,'filtered_')
    gates.append(('filter_phase_shift',(delta(a['phase'],fa['phase'])<agreement)&(delta(b['phase'],fb['phase'])<agreement)))
    la,lb=pair(image,.5,.5);check(la,lb,'lateral_')
    gates.append(('window_shape_agreement',delta(a['phase'],la['phase'])<agreement))
    allowed=mask.copy()
    for _,gate in gates:allowed &= gate
    return a['phase'],allowed,gates

def attach(base,anchors,current,fields,wrapped,gate,mask,meta,reach=1.,erode=True):
    conflict=fields['conflict'];accepted=fields['source']>0
    phase,supported=c.anchored_candidate(base,anchors,wrapped,gate&~conflict,mask,mask.astype(float),meta['fringe_period_px'],reach=reach,erode=erode)
    eligible=supported&~conflict&(~accepted|(np.abs(phase-current)<.05))
    connected=binary_propagation(eligible&anchors,mask=eligible)
    added=connected&~accepted&mask
    trial=current.copy();trial[added]=phase[added]
    bad,_=c.order_check(trial,(accepted&~conflict)|added)
    rejected=int((added&bad).sum());added &= ~bad
    return phase,added,dict(supported_pixels=int(supported.sum()),order_rejected_pixels=rejected)

def experiment(image,mask,base,valid,meta,current,fields,fit,case=None,save=None,variant_names=None):
    accepted=(fields['source']>0)&~fields['conflict'];anchors=valid&~fields['conflict'];missing=mask&~accepted
    p,g,gates=screened(image,mask,meta,fit)
    production,production_gate,_=c.photographic_fit_checks(image,mask,meta)
    assert np.array_equal(g,production_gate) and np.allclose(p,production)
    reasons=np.zeros(mask.shape,np.uint8);left=missing.copy();reject={}
    for idx,(name,gate) in enumerate(gates,1):
        failed=left&~gate;reasons[failed]=idx;reject[name]=int(failed.sum());left &= gate
    # Show which geometric safeguards reject otherwise sound image fits.
    for name,reach,erode in [('anchor_or_connected_support',None,False),('transition_inset',None,True),('one_period_reach',1.,True)]:
        _,passed=c.anchored_candidate(base,anchors,p,g&~fields['conflict'],mask,mask.astype(float),meta['fringe_period_px'],reach=reach,erode=erode)
        failed=left&~passed;reject[name]=int(failed.sum());reasons[failed]=len(reject);left &= passed
    reject['seam_order_or_existing_conflict']=int(left.sum());reasons[left]=len(reject)
    assert sum(reject.values())==missing.sum()
    diagnostic=dict(aperture_pixels=int(mask.sum()),current_pixels=int(accepted.sum()),missing_pixels=int(missing.sum()),first_rejection=reject,
                    independent_rejection={name:int((missing&~gate).sum()) for name,gate in gates})
    variants=[('reach-two-periods',{},dict(reach=2.)),('no-transition-inset',{},dict(erode=False)),
              ('residual-30pct',dict(residual=.3),{}),('phase-agreement-005',dict(agreement=.05),{}),
              ('smaller-windows',dict(scale=.7),{}),('second-harmonic',dict(harmonics=2),{})]
    if variant_names:
        variants += [('linear-envelope',dict(degree=1),{}),('small-linear-envelope',dict(degree=1,scale=.7),{}),('permissive-stress',dict(residual=.3,agreement=.1),{})]
        variants=[v for v in variants if v[0] in variant_names]
    rows=[];outputs={}
    if case is not None:
        theta=meta['carrier_angle_rad'];sign=np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])
        y,x=np.indices(mask.shape);reference=base*sign*632.8/(4*np.pi)-case['truth']
        A=np.column_stack([np.ones(valid.sum()),x[valid],y[valid]]);co=np.linalg.lstsq(A,reference[valid],rcond=None)[0]
        plane=co[0]+co[1]*x+co[2]*y
    def record(name,phase,added,diag):
        assert not (added&accepted).any() and not (added&~mask).any() and not (added&fields['conflict']).any()
        row=dict(method=name,added_pixels=int(added.sum()),coverage_pct=float(100*(accepted|added).sum()/mask.sum()),**diag)
        if case is not None:
            error=phase*sign*632.8/(4*np.pi)-case['truth']-plane
            row.update(added_max_error_nm=float(np.max(np.abs(error[added]))) if added.any() else None,
                added_p95_error_nm=float(np.percentile(np.abs(error[added]),95)) if added.any() else None,
                added_outside_pixels=int((added&~case['physical']).sum()),added_defect_pixels=int((added&case['cap']).sum()))
        rows.append(row);outputs[name]=(phase,added)
        print(json.dumps(dict(case=case['name'] if case else 'photograph',**row)),flush=True)
    for name,options,attach_options in variants:
        vp,vg,_=screened(image,mask,meta,fit,**options) if options else (p,g,gates)
        phase,added,diag=attach(base,anchors,current,fields,vp,vg,mask,meta,**attach_options)
        record(name,phase,added,diag)
    # Independent candidates may corroborate each other, never seed one another.
    if 'smaller-windows' in outputs and 'second-harmonic' in outputs:
        a,am=outputs['smaller-windows'];b,bm=outputs['second-harmonic']
        both=am&bm&(np.abs(a-b)<.025)
        record('small-harmonic-consensus',a,both,{})
    if save:
        save.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(save/'maps.npz',image=image,mask=mask,accepted=accepted,reasons=reasons,phase=current,
                            **{name+'_added':out[1] for name,out in outputs.items()})
    return dict(case=case['name'] if case else 'photograph',diagnostic=diagnostic,variants=rows)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--suite',action='store_true');parser.add_argument('--real-cache',type=Path);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--cache',type=Path);parser.add_argument('--only',default='');parser.add_argument('--variants',default='');parser.add_argument('--resume',action='store_true');args=parser.parse_args()
    rows=json.loads(args.output.read_text()) if args.resume and args.output.exists() else []
    completed={r['case'] for r in rows};original=c.build_composite
    def run(image,mask,base,valid,meta,*unused,**kwargs):
        current,accepted,fields=original(image,mask,base,valid,meta)
        if args.cache:
            args.cache.mkdir(parents=True,exist_ok=True)
            np.savez_compressed(args.cache/'context.npz',image=image,mask=mask,base=base,valid=valid,metadata=json.dumps(meta),current=current,**fields)
        row=experiment(image,mask,base,valid,meta,current,fields,fit,case, args.cache if case is None else None, args.variants.split(',') if args.variants else None)
        rows.append(row);args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(rows,indent=2)+'\n')
        return current,accepted,fields
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        stack.enter_context(patch.object(c,'build_composite',run))
        if args.real_cache:
            case=None;z=np.load(args.real_cache);meta=json.loads(str(z['metadata']))
            # Cached metadata lacks final refined diagnostics; require explicit adjacent result.
            meta.update(json.loads((args.real_cache.parent/'loupe-real-result.json').read_text())['hybrid_diagnostics'])
            fit=Fits(args.cache/'fits' if args.cache else None)
            with patch.object(c,'fit_window',fit):
                phase,accepted,fields=run(z['image'].astype(float),z['mask'],z['base_phase'],z['mask']&(z['base_risk']!=2),meta)
                assert int((accepted&~fields['conflict']).sum())==448992, 'Real cache must reproduce current Composite exactly'
        else:
            cases=[*E['E']['fixtures'](),*E['E']['holdouts'](),*E['fresh_cases']()]
            for case in cases:
                if case['name'] in completed or (args.only and args.only not in case['name']):continue
                fit=Fits()
                with patch.object(c,'fit_window',fit):
                    try:f.analyze_interferogram(case['image'],custom_mask=case['selected'],form_model='plane',analysis_method='composite',wavelength_nm=632.8,n_zernike=15)
                    except ValueError as error:
                        if 'fringe-order check' not in str(error):raise
                        rows[-1]['analysis_rejected']=str(error);args.output.write_text(json.dumps(rows,indent=2)+'\n')
if __name__=='__main__':main()
