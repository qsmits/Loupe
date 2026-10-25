"""Compare smooth completion with image-gradient reconstruction of missing edges.

Every added value is RECONSTRUCTED, including pixels with good fit evidence.
No new value enters measurement statistics. Run with the edge-preview CLI.
"""
from pathlib import Path
import json,runpy,sys
import numpy as np
from scipy.ndimage import distance_transform_edt,label
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'scripts'))
from fringe_gradient_reconstruction import reconstruct,fit_evidence
E=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-edge-preview.py')))
D=E['D'];c=E['c']


def evaluate(image,mask,base,valid,meta,current,fields,fit,case=None,save=None):
    accepted=(fields['source']>0)&~fields['conflict'];domain=mask&~fields['conflict'];rows=[];maps={};fits={}
    if case is not None:
        sign=np.sign(np.cos(meta['carrier_angle_rad'])*case['fx']+np.sin(meta['carrier_angle_rad'])*case['fy'])
        y,x=np.indices(mask.shape);ref=base*sign*632.8/(4*np.pi)-case['truth']
        co=np.linalg.lstsq(np.column_stack([np.ones(valid.sum()),x[valid],y[valid]]),ref[valid],rcond=None)[0]
        plane=co[0]+co[1]*x+co[2]*y
        rim=case['physical']&(distance_transform_edt(np.pad(case['physical'],1))[1:-1,1:-1]<=max(3,meta['fringe_period_px']*.5))
    for model,harmonics in [('linear',1),('harmonic',2)]:
        a,b=[fit(image,mask,meta,.7*across,.7*along,degree=1,harmonics=harmonics) for across,along in [(.5,.25),(.65,.325)]]
        fits[model]=(a['phase'],fit_evidence(a,b,domain));fit.cache.clear()
        print(json.dumps(dict(case=case['name'] if case else 'photograph',stage='fit-complete',model=model)),flush=True)
    configs=[('smooth-only',np.zeros(mask.shape),np.zeros(mask.shape),.1)]
    for model,(wrapped,evidence) in fits.items():
        for strength in [.01,.1,1.]:configs.append((model+'-'+str(strength),wrapped,evidence,strength))
    for name,wrapped,evidence,strength in configs:
        phase,added,diag=reconstruct(current,accepted,domain,wrapped,evidence,strength)
        bad,_=c.order_check(phase,accepted|added)
        influence=evidence/(evidence+strength)
        row=dict(method=name,reconstructed_pixels=int(added.sum()),
            displayed_coverage_pct=float(100*(accepted|added).sum()/mask.sum()),
            measured_coverage_pct=float(100*accepted.sum()/mask.sum()),
            prior_dominant_pixels=int((added&(influence<.5)).sum()),
            reconstructed_order_conflict_pixels=int((bad&added).sum()),
            old_phase_change_max_rad=float(np.abs(phase[accepted]-current[accepted]).max()) if accepted.any() else 0.,**diag)
        if case is not None:
            heights=phase*sign*632.8/(4*np.pi)-plane;error=heights-case['truth'];e=np.abs(error[added])
            row.update(added_max_error_nm=float(e.max()) if e.size else None,
                added_p95_error_nm=float(np.percentile(e,95)) if e.size else None,
                added_rms_error_nm=float(np.sqrt(np.mean(e*e))) if e.size else None,
                added_over_20nm=int((e>20).sum()),added_over_50nm=int((e>50).sum()),added_over_100nm=int((e>100).sum()),
                added_outside_pixels=int((added&~case['physical']).sum()),added_defect_pixels=int((added&case['cap']).sum()),
                rim_displayed_coverage_pct=float(100*((accepted|added)&rim).sum()/max(1,rim.sum())),
                added_rim_pixels=int((added&rim).sum()),
                added_rim_p95_error_nm=float(np.percentile(np.abs(error[added&rim]),95)) if (added&rim).any() else None)
            if 'radius' in case:
                profile=[]
                for lo in np.arange(.5,1.,.05):
                    band=(case['radius']>=lo)&(case['radius']<lo+.05)&case['physical'];shown=band&(accepted|added)
                    profile.append(dict(radius_low=float(lo),radius_high=float(lo+.05),pixels=int(band.sum()),
                        measured_pixels=int((band&accepted).sum()),displayed_pixels=int(shown.sum()),
                        truth_mean_nm=float(case['truth'][band].mean()),
                        estimated_mean_nm=float(heights[shown].mean()) if shown.any() else None,
                        measured_mean_nm=float(heights[band&accepted].mean()) if (band&accepted).any() else None))
                row['radial_profile']=profile
        rows.append(row);print(json.dumps(dict(case=case['name'] if case else 'photograph',**row)),flush=True)
        if save:
            maps[name+'_phase']=phase;maps[name+'_added']=added;maps[name+'_influence']=influence
    if save:
        save.parent.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(save,image=image,mask=mask,accepted=accepted,current=current,**maps)
    row=dict(case=case['name'] if case else 'photograph',aperture_pixels=int(mask.sum()),current_pixels=int(accepted.sum()),
        measured_islands=int(label(accepted)[1]),variants=rows)
    if case is not None:row['before_rim_coverage_pct']=float(100*(accepted&rim).sum()/max(1,rim.sum()))
    if case is not None and 'depth_nm' in case:row.update(depth_nm=case['depth_nm'],rim_width=case['rim_width'])
    return row


if __name__=='__main__':
    E['main'].__globals__['evaluate']=evaluate
    E['main']()
