"""Research weak-evidence edge fits, preserving measured layers and reporting failures.

This is not a measurement-mode threshold change. All extrapolation or weak-fit
pixels must remain distinct from measured data. Truth is used only for scoring.
"""
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
import argparse,json,runpy,sys
import numpy as np
from scipy.ndimage import binary_propagation,distance_transform_edt
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
M=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-model-stack.py')))
D=M['D'];c=M['c'];f=M['f']
MODELS={'small-linear':dict(degree=1,scale=.7,harmonics=1),
        'small-linear-harmonic':dict(degree=1,scale=.7,harmonics=2),
        'linear':dict(degree=1,scale=1.,harmonics=1)}
# amplitude, condition, residual/amplitude, window agreement, anchor agreement.
LEVELS={'provisional':(8,1e4,.5,.15,.15),'weak':(4,1e5,1.,.35,.35),
        'survey':(1,1e6,2.,1.,.5),'ungated-diagnostic':(0,np.inf,np.inf,np.pi,1.)}


def rim_cases():
    y,x=np.mgrid[:176,:192];u=(x-96)/78;v=(y-88)/70;r=np.hypot(u,v);physical=r<1
    for i,(depth,width) in enumerate([(0,.2),(20,.2),(60,.2),(100,.2),(20,.07),(60,.07),(-30,.15),(0,.07)]):
        fx=np.cos(.25+.29*i)/16.7;fy=np.sin(.25+.29*i)/16.7
        truth=-depth*np.clip((r-(1-width))/width,0,1)**2
        arg=2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+.71
        rng=np.random.default_rng(30400+i)
        # Every case includes a bright rim and contrast loss. Flat controls
        # distinguish illumination structure from an actual surface roll.
        background=130+35*np.clip((r-.8)/.2,0,1)**2+8*u
        amplitude=38*(1-.5*np.clip((r-.8)/.2,0,1))
        image=background+amplitude*np.cos(arg)+4*np.cos(2*arg+.2)+rng.normal(0,1.5,x.shape)
        yield dict(name=f'rim-{i}-depth-{depth}',image=np.where(physical,image,12),truth=truth,
            physical=physical,selected=physical.copy(),fx=fx,fy=fy,cap=np.zeros_like(physical),
            radius=r,depth_nm=depth,rim_width=width)


def evaluate(image,mask,base,valid,meta,current,fields,fit,case=None,save=None):
    accepted=(fields['source']>0)&~fields['conflict'];anchors=valid&~fields['conflict']
    reference=current.copy();rows=[];maps={};candidates={}
    if case is not None:
        sign=np.sign(np.cos(meta['carrier_angle_rad'])*case['fx']+np.sin(meta['carrier_angle_rad'])*case['fy'])
        y,x=np.indices(mask.shape);ref=base*sign*632.8/(4*np.pi)-case['truth']
        co=np.linalg.lstsq(np.column_stack([np.ones(valid.sum()),x[valid],y[valid]]),ref[valid],rcond=None)[0]
        plane=co[0]+co[1]*x+co[2]*y
        rim=case['physical']&(distance_transform_edt(np.pad(case['physical'],1))[1:-1,1:-1]<=max(3,meta['fringe_period_px']*.5))
    for model,opts in MODELS.items():
        scale=opts['scale'];kw={k:opts[k] for k in ('degree','harmonics')}
        a,b=[fit(image,mask,meta,scale*across,scale*along,**kw) for across,along in [(0.5,.25),(.65,.325)]]
        for level,(amp,cond,resid,agree,anchor_agree) in LEVELS.items():
            gate=mask&(a['amplitude']>amp)&(b['amplitude']>amp)&(a['condition']<cond)&(b['condition']<cond)
            # The ungated diagnostic uses infinity; zero-amplitude exterior
            # pixels can yield inf*0, but are already excluded by mask/contrast.
            with np.errstate(invalid='ignore'):
                gate&=(a['residual']<resid*a['amplitude'])&(b['residual']<resid*b['amplitude'])
            gate&=D['delta'](a['phase'],b['phase'])<agree
            phase,support=c.anchored_candidate(base,anchors,a['phase'],gate&~fields['conflict'],mask,
                np.where(mask,np.maximum(a['amplitude'],0),0),meta['fringe_period_px'],reach=None,agreement=anchor_agree,erode=False)
            eligible=support&~fields['conflict']&(~accepted|(np.abs(phase-current)<anchor_agree))
            connected=binary_propagation(eligible&anchors,mask=eligible)
            added=connected&~accepted
            combined=current.copy();combined[added]=phase[added]
            bad,_=c.order_check(combined,accepted|added)
            name=model+'-'+level
            candidates[name]=(combined,added,bad&added)
        fit.cache.clear()
    # First fit wins within each evidence level. Each fit anchored independently.
    for level in LEVELS:
        phase=current.copy();added=np.zeros(mask.shape,bool)
        for model in MODELS:
            p,pm,bad=candidates[model+'-'+level]
            take=pm&~bad&~accepted&~added
            phase[take]=p[take];added|=take
        bad,_=c.order_check(phase,accepted|added)
        candidates['stack-'+level]=(phase,added,bad&added)
    for name,(phase,added,bad) in candidates.items():
        checked=added&~bad
        row=dict(method=name,proposed_pixels=int(added.sum()),added_pixels=int(checked.sum()),
            proposed_coverage_pct=float(100*(accepted|added).sum()/mask.sum()),
            coverage_pct=float(100*(accepted|checked).sum()/mask.sum()),order_conflict_pixels=int(bad.sum()),
            old_phase_change_max_rad=float(np.abs(phase[accepted]-current[accepted]).max()) if accepted.any() else 0.)
        if case is not None:
            error=phase*sign*632.8/(4*np.pi)-case['truth']-plane;e=np.abs(error[checked])
            row.update(added_max_error_nm=float(e.max()) if e.size else None,
                added_p95_error_nm=float(np.percentile(e,95)) if e.size else None,
                added_rms_error_nm=float(np.sqrt(np.mean(e*e))) if e.size else None,
                added_over_20nm=int((e>20).sum()),added_over_50nm=int((e>50).sum()),added_over_100nm=int((e>100).sum()),
                added_outside_pixels=int((checked&~case['physical']).sum()),added_defect_pixels=int((checked&case['cap']).sum()))
            row.update(rim_coverage_pct=float(100*((accepted|checked)&rim).sum()/max(1,rim.sum())),
                added_rim_pixels=int((checked&rim).sum()),
                added_rim_p95_error_nm=float(np.percentile(np.abs(error[checked&rim]),95)) if (checked&rim).any() else None)
            if 'radius' in case:
                estimates=phase*sign*632.8/(4*np.pi)-plane
                row['radial_profile']=[dict(radius_low=float(lo),radius_high=float(lo+.05),
                    pixels=int(((case['radius']>=lo)&(case['radius']<lo+.05)&case['physical']).sum()),
                    accepted_pixels=int(((case['radius']>=lo)&(case['radius']<lo+.05)&(accepted|checked)&case['physical']).sum()),
                    truth_mean_nm=float(case['truth'][(case['radius']>=lo)&(case['radius']<lo+.05)&case['physical']].mean()),
                    estimated_mean_nm=float(estimates[(case['radius']>=lo)&(case['radius']<lo+.05)&(accepted|checked)&case['physical']].mean())
                    if ((case['radius']>=lo)&(case['radius']<lo+.05)&(accepted|checked)&case['physical']).any() else None)
                    for lo in np.arange(.5,1.,.05)]
        assert np.array_equal(phase[accepted],reference[accepted])
        rows.append(row);print(json.dumps(dict(case=case['name'] if case else 'photograph',**row)),flush=True)
        if save and name.startswith('stack-'):
            maps[name+'_phase']=phase;maps[name+'_added']=checked;maps[name+'_ambiguous']=bad
    if save:
        save.parent.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(save,image=image,mask=mask,accepted=accepted,current=current,**maps)
    row=dict(case=case['name'] if case else 'photograph',aperture_pixels=int(mask.sum()),current_pixels=int(accepted.sum()),variants=rows)
    if case is not None:row['before_rim_coverage_pct']=float(100*(accepted&rim).sum()/max(1,rim.sum()))
    if case is not None and 'depth_nm' in case:row.update(depth_nm=case['depth_nm'],rim_width=case['rim_width'])
    return row


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--context',type=Path);p.add_argument('--tiered',type=Path)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--maps',type=Path)
    p.add_argument('--start',type=int,default=0);p.add_argument('--stop',type=int,default=56);args=p.parse_args();rows=[]
    def record(row):
        rows.append(row);args.output.parent.mkdir(parents=True,exist_ok=True)
        temp=args.output.with_suffix('.tmp');temp.write_text(json.dumps(rows,indent=2)+'\n');temp.replace(args.output)
    if args.context:
        z=np.load(args.context,allow_pickle=False);meta=json.loads(str(z['metadata']))
        fields={k:z[k] for k in ('source','quality','conflict','reasons')};current=z['current']
        if args.tiered:
            t=np.load(args.tiered,allow_pickle=False);current=t['tiered-expanded_phase'];fields['source']=t['tiered-expanded_source']
            assert ((fields['source']>0)&~fields['conflict']).sum()==470468
        record(evaluate(z['image'],z['mask'],z['base'],z['valid'],meta,current,fields,D['Fits'](),save=args.maps));return
    original=c.build_composite
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        cases=[*D['E']['E']['fixtures'](),*D['E']['E']['holdouts'](),*D['E']['fresh_cases'](),*M['new_cases'](),*rim_cases()]
        for case in cases[args.start:args.stop]:
            fit=D['Fits']()
            def audited(image,mask,base,valid,meta,*a,**kw):
                current,accepted,fields=original(image,mask,base,valid,meta,*a,**kw);fit.cache.clear()
                record(evaluate(image,mask,base,valid,meta,current,fields,fit,case));return current,accepted,fields
            count=len(rows)
            with patch.object(c,'fit_window',fit),patch.object(c,'build_composite',audited):
                try:f.analyze_interferogram(case['image'],custom_mask=case['selected'],form_model='plane',analysis_method='composite',wavelength_nm=632.8,n_zernike=15)
                except ValueError as error:
                    if 'fringe-order check' not in str(error) or len(rows)!=count+1:raise
                    rows[-1]['analysis_rejected']=str(error);args.output.write_text(json.dumps(rows,indent=2)+'\n')
if __name__=='__main__':main()
