"""Test the actual photographic Composite gate against prior texture holdouts."""
from pathlib import Path
import sys,json,runpy,argparse
from contextlib import ExitStack
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.vision import fringe_composite as c,fringe as f
E=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-photographic-residual.py')))

def evaluate(case):
    s=E['capture'](case['image'],case['selected']);m=s['mask'];base=s['base_phase'];valid=m&(s['base_risk']!=2)
    phase,gate,diag=c.photographic_fit_checks(s['image'],m,s['metadata'])
    local,accepted=c.anchored_candidate(base,valid,phase,gate,m,s['modulation'],s['metadata']['fringe_period_px'])
    out=base.copy();added=accepted&~valid;out[added]=local[added]
    conflict,_=c.order_check(out,valid|added);added&=~conflict;out[~added]=base[~added]
    return dict(case=case['name'],**E['metrics'](case,s,out,valid|added),added_pixels=int(added.sum()),**diag)

def main():
    p=argparse.ArgumentParser();p.add_argument('--holdout',action='store_true');p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    rows=[]
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        for case in E['holdouts']() if args.holdout else E['fixtures']():
            row=evaluate(case);rows.append(row);print(json.dumps(row),flush=True)
            args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(rows,indent=2)+'\n')
if __name__=='__main__':main()
