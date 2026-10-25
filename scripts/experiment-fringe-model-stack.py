"""Combine simpler envelopes and a second intensity harmonic without changing the UI.

All fits see original observations. Existing Composite phases stay fixed. Truth
is scoring-only. Run the 40 regression cases and eight new stress cases before
interpreting photographic coverage. No candidate seeds another candidate.
"""
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
import argparse, json, runpy, sys, time
import numpy as np
from scipy.ndimage import gaussian_filter
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT/'scripts'))
from backend.vision import fringe_composite as c, fringe as f
from fringe_model_stack import prepare_candidate, stack_models, stack_tiers
D = runpy.run_path(str(Path(__file__).with_name('experiment-fringe-next-coverage.py')))

MODELS = {
    'linear': dict(degree=1),
    'small-linear': dict(degree=1, scale=.7),
    'quadratic-harmonic': dict(harmonics=2),
    'linear-harmonic': dict(degree=1, harmonics=2),
    'small-linear-harmonic': dict(degree=1, harmonics=2, scale=.7),
}
CORE = ['linear', 'small-linear', 'quadratic-harmonic']
STACKS = {
    'core-linear-first': (CORE, .05),
    'core-harmonic-first': (['quadratic-harmonic', 'linear', 'small-linear'], .05),
    'expanded': (list(MODELS), .05),
    'expanded-strict-overlap': (list(MODELS), .025),
    'expanded-loose-overlap': (list(MODELS), .1),
    'expanded-unchecked-overlap': (list(MODELS), None),
}


def new_cases():
    """Fixed additional stress set, specified before inspecting stack results."""
    y,x = np.mgrid[:208,:240]
    u=(x-117)/98; v=(y-103)/84; r=np.hypot(u,v)
    physical=(r<1)&(np.hypot(x-100,y-121)>11)
    for i in range(8):
        angle=.31+.43*i; period=14.3+1.7*i
        fx=np.cos(angle)/period; fy=np.sin(angle)/period
        truth=17*u*u-9*u*v-28*np.clip((r-.79)/.21,0,1)**2
        truth-= (12+3*i)*np.exp(-((r-.94)/(.025+.005*(i%3)))**2)
        truth+=9*np.exp(-((u-.26)**2+(v+.17)**2)/.018)
        arg=2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+.23*i
        amplitude=31*(1-.45*np.clip((r-.8)/.2,0,1))
        rng=np.random.default_rng(27001+i)
        texture=gaussian_filter(rng.normal(size=x.shape),[.6,1.8,3.7,6.2][i%4]);texture*=2.5/texture.std()
        image=139+13*u+11*v*v+amplitude*np.cos(arg)
        image+=(2+1.5*i)*np.cos(2*arg+.4)+texture+rng.normal(0,1.2,x.shape)
        if i>=4: image+=4*np.cos(3*arg-.7)
        defect=physical&((np.hypot(x-158,y-87)<(4+i%3)) | ((abs(u+.37-.15*v)<.015)&(v>.08))) if i%2 else np.zeros_like(physical)
        image[defect]=142+texture[defect]
        selected=r<1.025 if i in (2,6) else physical.copy()
        yield dict(name=f'stack-stress-{i}',image=np.where(physical,image,17.),truth=truth,
            physical=physical,selected=selected,fx=fx,fy=fy,cap=defect)


def experiment(image, mask, base, valid, meta, current, fields, fit, case=None, save=None, tiered_only=False):
    start=time.monotonic(); accepted=(fields['source']>0)&~fields['conflict'];anchors=valid&~fields['conflict']
    originals={k:fields[k].copy() for k in ('source','quality','conflict','reasons')}
    original_phase=current.copy(); candidates={}; diagnostics={}; rows=[]; maps={}
    if case is not None:
        sign=np.sign(np.cos(meta['carrier_angle_rad'])*case['fx']+np.sin(meta['carrier_angle_rad'])*case['fy'])
        y,x=np.indices(mask.shape); ref=base*sign*632.8/(4*np.pi)-case['truth']
        co=np.linalg.lstsq(np.column_stack([np.ones(valid.sum()),x[valid],y[valid]]),ref[valid],rcond=None)[0]
        plane=co[0]+co[1]*x+co[2]*y
    def record(name, phase, added, source, diag):
        row=dict(method=name,added_pixels=int(added.sum()),coverage_pct=float(100*(accepted|added).sum()/mask.sum()),
            old_phase_change_max_rad=float(np.abs(phase[accepted]-current[accepted]).max()) if accepted.any() else 0.,**diag)
        if case is not None:
            error=phase*sign*632.8/(4*np.pi)-case['truth']-plane
            e=np.abs(error[added])
            row.update(added_max_error_nm=float(e.max()) if e.size else None,
                added_p95_error_nm=float(np.percentile(e,95)) if e.size else None,
                added_rms_error_nm=float(np.sqrt(np.mean(e*e))) if e.size else None,
                added_over_10nm=int((e>10).sum()),added_over_20nm=int((e>20).sum()),added_over_50nm=int((e>50).sum()),
                added_outside_pixels=int((added&~case['physical']).sum()),added_defect_pixels=int((added&case['cap']).sum()),
                before_max_error_nm=float(np.abs(error[accepted]).max()) if accepted.any() else None,
                after_max_error_nm=float(np.abs(error[accepted|added]).max()) if (accepted|added).any() else None)
        rows.append(row);print(json.dumps(dict(case=case['name'] if case else 'photograph',**row)),flush=True)
        if save: maps[name+'_added']=added;maps[name+'_phase']=phase;maps[name+'_source']=source
    for name,options in MODELS.items():
        wrapped,gate,gates=D['screened'](image,mask,meta,fit,**options)
        phase,support,diag=prepare_candidate(base,anchors,current,fields,wrapped,gate,mask,meta['fringe_period_px'])
        candidates[name]=(phase,support);diagnostics[name]=diag
        if not tiered_only:
            p,a,s,d=stack_models(current,fields,anchors,mask,candidates,[name])
            record(name,p,a,s,{**diag,**d})
        else:print(json.dumps(dict(stage='fit-complete',case=case['name'] if case else 'photograph',model=name)),flush=True)
        # Release fit tensors between models. Later candidates do not use them.
        fit.cache.clear()
    for name,(order,tolerance) in ([] if tiered_only else STACKS.items()):
        p,a,s,d=stack_models(current,fields,anchors,mask,candidates,order,tolerance)
        union=np.logical_or.reduce([candidates[n][1] for n in order])&~accepted
        d.update(mask_union_pixels=int(union.sum()),overlap_tolerance_rad=tolerance)
        record(name,p,a,s,d)
    p,a,s,d=stack_tiers(current,fields,anchors,mask,candidates,
        [CORE,['linear-harmonic','small-linear-harmonic']],tolerance=.05)
    record('tiered-expanded',p,a,s,d)
    assert np.array_equal(current,original_phase)
    for k in originals:assert np.array_equal(fields[k],originals[k])
    if save:
        save.parent.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(save,image=image,mask=mask,accepted=accepted,current=current,**maps)
    return dict(case=case['name'] if case else 'photograph',aperture_pixels=int(mask.sum()),
        current_pixels=int(accepted.sum()),earlier_layers_preserved=True,elapsed_seconds=time.monotonic()-start,variants=rows)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--context',type=Path);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--maps',type=Path);p.add_argument('--start',type=int,default=0);p.add_argument('--stop',type=int,default=48)
    p.add_argument('--resume',action='store_true');p.add_argument('--tiered-only',action='store_true');args=p.parse_args()
    rows=json.loads(args.output.read_text()) if args.resume and args.output.exists() else [];completed={r['case'] for r in rows}
    def record(row):
        rows.append(row);args.output.parent.mkdir(parents=True,exist_ok=True)
        temp=args.output.with_suffix('.tmp');temp.write_text(json.dumps(rows,indent=2)+'\n');temp.replace(args.output)
    if args.context:
        z=np.load(args.context,allow_pickle=False);meta=json.loads(str(z['metadata']))
        fields={k:z[k] for k in ('source','quality','conflict','aperture','reasons')}
        assert ((fields['source']>0)&~fields['conflict']).sum()==448992
        record(experiment(z['image'],z['mask'],z['base'],z['valid'],meta,z['current'],fields,D['Fits'](),save=args.maps,tiered_only=args.tiered_only));return
    original=c.build_composite
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        cases=[*D['E']['E']['fixtures'](),*D['E']['E']['holdouts'](),*D['E']['fresh_cases'](),*new_cases()]
        for case in cases[args.start:args.stop]:
            if case['name'] in completed:continue
            fit=D['Fits']()
            def audited(image,mask,base,valid,meta,*a,**kw):
                current,accepted,fields=original(image,mask,base,valid,meta,*a,**kw)
                fit.cache.clear()
                record(experiment(image,mask,base,valid,meta,current,fields,fit,case,tiered_only=args.tiered_only))
                return current,accepted,fields
            count=len(rows)
            with patch.object(c,'fit_window',fit),patch.object(c,'build_composite',audited):
                try:f.analyze_interferogram(case['image'],custom_mask=case['selected'],form_model='plane',analysis_method='composite',wavelength_nm=632.8,n_zernike=15)
                except ValueError as error:
                    if 'fringe-order check' not in str(error) or len(rows)!=count+1:raise
                    rows[-1]['analysis_rejected']=str(error);args.output.write_text(json.dumps(rows,indent=2)+'\n')
if __name__=='__main__':main()
