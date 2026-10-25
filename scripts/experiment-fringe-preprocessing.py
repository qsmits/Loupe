"""Assess cleaned image copies while retaining original-image phase values.

Research only. Replacing a raw-residual veto with a processed-residual test is a
change in evidence, NOT a claim that processing is neutral. Synthetic truth and
fringe-free defects test that distinction. Existing Composite phases stay fixed.
"""
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
import argparse,json,runpy,sys
import numpy as np
from scipy.ndimage import gaussian_filter,median_filter,binary_erosion,label
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.vision import fringe_composite as c,fringe as f
D=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-next-coverage.py')))


def smooth(image,mask,sigma):
    return gaussian_filter(np.where(mask,image,0.),sigma,mode='constant')/np.maximum(gaussian_filter(mask.astype(float),sigma,mode='constant'),1e-12)


def copies(image,mask,period):
    # Background subtraction has no resampling, clipping, or contrast expansion.
    background=smooth(image,mask,2*period)
    levelled=image-background+np.median(background[mask])
    # Repair only isolated six-MAD departures, with an entirely observed 3x3 neighborhood.
    med=median_filter(image,size=3,mode='nearest')
    interior=binary_erosion(mask,structure=np.ones((3,3),bool))
    # A median-filter difference is often exactly zero on smooth ramps, so its
    # MAD cannot estimate noise. Use fully observed diagonal Haar differences.
    detail=.5*(image[:-1,:-1]-image[:-1,1:]-image[1:,:-1]+image[1:,1:])
    observed=mask[:-1,:-1]&mask[:-1,1:]&mask[1:,:-1]&mask[1:,1:]
    noise=detail[observed];center=np.median(noise) if noise.size else 0.
    sigma=max(.5,1.4826*np.median(np.abs(noise-center))) if noise.size else .5
    spikes=interior&(np.abs(image-med)>6*sigma)
    groups,count=label(spikes,structure=np.ones((3,3),bool));sizes=np.bincount(groups.ravel())
    spikes &= (groups>0)&(sizes[groups]<=2)
    despiked=np.where(spikes,med,image)
    yield 'slow-lighting',levelled,dict(background_sigma_px=float(2*period))
    yield 'isolated-outliers',despiked,dict(replaced_pixels=int(spikes.sum()),noise_mad=float(sigma))
    yield 'mild-smoothing',smooth(image,mask,max(.5,.05*period)),dict(sigma_px=max(.5,.05*period))
    yield 'lighting-and-smoothing',smooth(levelled,mask,max(.5,.05*period)),dict(sigma_px=max(.5,.05*period))


def evaluate(image,mask,base,valid,meta,current,fields,fit,case=None,save=None,control_only=False):
    def pair(img,a,b):return [fit(img,mask,meta,a,b),fit(img,mask,meta,1.3*a,1.3*b)]
    raw=pair(image,.5,.25);lateral=pair(image,.5,.5);allraw=raw+lateral
    original=current.copy();original_image=image.copy();accepted=(fields['source']>0)&~fields['conflict'];anchors=valid&~fields['conflict']
    delta=D['delta'];raw_gate=mask.copy();raw_ratio=np.zeros(mask.shape)
    for a in allraw:
        raw_gate&=(a['condition']<1000)&(a['amplitude']>15)
        raw_ratio=np.maximum(raw_ratio,a['residual']/np.maximum(a['amplitude'],1e-12))
    raw_gate&=(delta(raw[0]['phase'],raw[1]['phase'])<.025)&(delta(lateral[0]['phase'],lateral[1]['phase'])<.025)&(delta(raw[0]['phase'],lateral[0]['phase'])<.025)
    if case is not None:
        theta=meta['carrier_angle_rad'];sign=np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy']);y,x=np.indices(mask.shape)
        error_ref=base*sign*632.8/(4*np.pi)-case['truth'];A=np.column_stack([np.ones(valid.sum()),x[valid],y[valid]])
        co=np.linalg.lstsq(A,error_ref[valid],rcond=None)[0];plane=co[0]+co[1]*x+co[2]*y
    rows=[];maps={}
    assessed=[('unchanged-copy',image.copy(),{})] if control_only else copies(image,mask,meta['fringe_period_px'])
    for name,processed,description in assessed:
        a,b=pair(processed,.5,.25);screen=raw_gate.copy()
        for original_fit,clean in zip(raw,[a,b]):
            screen&=(clean['condition']<1000)&(clean['amplitude']>15)&(clean['residual']<.2*clean['amplitude'])
            screen&=delta(original_fit['phase'],clean['phase'])<.025
        screen&=delta(a['phase'],b['phase'])<.025
        for raw_limit in [.2,.3,None]:
            # .2 retains the raw residual veto but still replaces the assessment branch.
            # Only mild-smoothing/.2 reproduces the existing photographic gate.
            # .3 and None also relax the raw veto; these are explicit experiments.
            gate=screen if raw_limit is None else screen&(raw_ratio<raw_limit)
            phase,added,diag=D['attach'](base,anchors,current,fields,raw[0]['phase'],gate,mask,meta)
            combined=current.copy();combined[added]=phase[added]
            assert np.array_equal(combined[accepted],current[accepted])
            assert not (added&~mask).any() and not (added&fields['conflict']).any()
            row=dict(method=name+'-raw-'+str(raw_limit),preprocessing=name,raw_residual_limit=raw_limit,
                added_pixels=int(added.sum()),coverage_pct=float(100*(accepted|added).sum()/mask.sum()),
                old_phase_change_max_rad=float(np.max(np.abs(combined[accepted]-current[accepted]))) if accepted.any() else 0.,
                raw_phase_equivalence_max_rad=float(np.max(delta(phase[added],raw[0]['phase'][added]))) if added.any() else 0.,
                **description,**diag)
            if case is not None:
                error=phase*sign*632.8/(4*np.pi)-case['truth']-plane
                row.update(added_max_error_nm=float(np.abs(error[added]).max()) if added.any() else None,
                    added_p95_error_nm=float(np.percentile(np.abs(error[added]),95)) if added.any() else None,
                    added_outside_pixels=int((added&~case['physical']).sum()),added_defect_pixels=int((added&case['cap']).sum()))
            rows.append(row);maps[row['method']+'_added']=added
            print(json.dumps(dict(case=case['name'] if case else 'photograph',**row)),flush=True)
    assert np.array_equal(current,original) and np.array_equal(image,original_image)
    if save:save.parent.mkdir(parents=True,exist_ok=True);np.savez_compressed(save,image=image,mask=mask,accepted=accepted,phase=current,**maps)
    return dict(case=case['name'] if case else 'photograph',aperture_pixels=int(mask.sum()),current_pixels=int(accepted.sum()),variants=rows)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--context',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--maps',type=Path);p.add_argument('--start',type=int,default=0);p.add_argument('--stop',type=int,default=40);p.add_argument('--resume',action='store_true');p.add_argument('--control-only',action='store_true');args=p.parse_args()
    rows=json.loads(args.output.read_text()) if args.resume and args.output.exists() else [];completed={r['case'] for r in rows}
    def record(row):
        rows.append(row);args.output.parent.mkdir(parents=True,exist_ok=True)
        temp=args.output.with_suffix('.tmp');temp.write_text(json.dumps(rows,indent=2)+'\n');temp.replace(args.output)
    if args.context:
        # Only numeric/string members of our own research context are read; never unpickle diagnostics.
        z=np.load(args.context,allow_pickle=False);meta=json.loads(str(z['metadata']));fields={k:z[k] for k in ['source','quality','conflict','aperture','reasons']}
        accepted=(fields['source']>0)&~fields['conflict'];assert accepted.sum()==448992
        fit=D['Fits']()
        record(evaluate(z['image'],z['mask'],z['base'],z['valid'],meta,z['current'],fields,fit,save=args.maps,control_only=args.control_only))
        return
    original=c.build_composite
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        cases=[*D['E']['E']['fixtures'](),*D['E']['E']['holdouts'](),*D['E']['fresh_cases']()]
        for case in cases[args.start:args.stop]:
            if case['name'] in completed:continue
            fit=D['Fits']()
            def audited(image,mask,base,valid,meta,*a,**kw):
                current,accepted,fields=original(image,mask,base,valid,meta,*a,**kw)
                record(evaluate(image,mask,base,valid,meta,current,fields,fit,case,control_only=args.control_only))
                return current,accepted,fields
            with patch.object(c,'fit_window',fit),patch.object(c,'build_composite',audited):
                try:f.analyze_interferogram(case['image'],custom_mask=case['selected'],form_model='plane',analysis_method='composite',wavelength_nm=632.8,n_zernike=15)
                except ValueError as error:
                    if 'fringe-order check' not in str(error):raise
                    rows[-1]['analysis_rejected']=str(error);args.output.write_text(json.dumps(rows,indent=2)+'\n')
if __name__=='__main__':main()
