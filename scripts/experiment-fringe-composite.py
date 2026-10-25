"""Audit shipped composite against known edge successes and failure cases.

Run with --suite budget-holdout for the fresh coverage-study set. This audits
actual errors for each qualitative cutoff; categories are not error bounds.
"""
from pathlib import Path
import argparse
import json
import runpy
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.vision.fringe_composite import build_composite

E=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-coverage-budget.py')))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--suite',choices=['regression','budget-holdout'],default='regression')
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    names={'narrow-roll-17.4','noisy-hole-flat','precise-weak-rim','oversized-flat','challenge-blur-56',
           'challenge-blur-119','challenge-loose-11','holdout-scratch-24'}
    cases=list(E['budget_holdouts']()) if args.suite=='budget-holdout' else [c for suite in ['matrix','challenge','holdout'] for c in E['E']['fixtures'](suite) if c['name'] in names]
    rows=[]
    for case in cases:
        _,source=E['E']['load_baselines'](case,Path('/tmp/loupe-continuation-cache'))
        domain=case['selected'] if case['selected'] is not None else source['mask']
        phase,valid,fields=build_composite(source['image'],domain,source['phase'],source['valid'],source['metadata'])
        assert np.array_equal(phase[source['valid']],source['phase'][source['valid']])
        assert not (valid & ~domain).any()
        theta=source['metadata']['carrier_angle_rad']
        scale=np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])*E['NM_PER_RAD']
        error=phase*scale-case['truth'];base=source['valid'];y,x=np.indices(phase.shape)
        design=np.column_stack([np.ones(base.sum()),x[base],y[base]])
        coef=np.linalg.lstsq(design,error[base],rcond=None)[0];error-=coef[0]+coef[1]*x+coef[2]*y
        for cutoff in [1,2,3]:
            included=valid & (fields['quality']<=cutoff) & ~fields['conflict']
            added=included & ~base
            rows.append(dict(case=case['name'],cutoff=cutoff,coverage_pct=float(100*(included&case['physical']).sum()/case['physical'].sum()),
                included_pixels=int(included.sum()),max_error_nm=float(np.max(np.abs(error[included]))) if included.any() else None,
                added_max_error_nm=float(np.max(np.abs(error[added]))) if added.any() else None,
                conflicts=int(fields['conflict'].sum()),outside_pixels=int((included&~case['physical']).sum()),
                added_defect_pixels=int((added&case['cap']).sum())))
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(rows,indent=2)+'\n')
        print(case['name'],[(r['cutoff'],round(r['coverage_pct'],1),round(r['max_error_nm'] or 0,2)) for r in rows[-3:]],flush=True)


if __name__=='__main__':main()
