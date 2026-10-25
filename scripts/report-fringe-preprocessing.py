"""Aggregate the assessment-copy experiment, including failed defect checks."""
from pathlib import Path
import argparse,json,hashlib
import numpy as np

def aggregate(rows):
    summary={}
    for method in [r['method'] for r in rows[0]['variants']]:
        pairs=[(row,next(v for v in row['variants'] if v['method']==method)) for row in rows]
        errors=[(v['added_max_error_nm'],row['case']) for row,v in pairs if v['added_max_error_nm'] is not None]
        worst=max(errors) if errors else (None,None)
        summary[method]=dict(cases=len(pairs),added_pixels=sum(v['added_pixels'] for _,v in pairs),
            cases_gaining=sum(v['added_pixels']>0 for _,v in pairs),worst_added_error_nm=worst[0],worst_case=worst[1],
            added_defect_pixels=sum(v['added_defect_pixels'] for _,v in pairs),
            added_outside_pixels=sum(v['added_outside_pixels'] for _,v in pairs),
            old_phase_change_max_rad=max(v['old_phase_change_max_rad'] for _,v in pairs),
            raw_phase_equivalence_max_rad=max(v['raw_phase_equivalence_max_rad'] for _,v in pairs))
    return summary

def merge_controls(rows, controls):
    by_case={r['case']:r for r in controls}
    assert len(by_case)==len(controls)==len(rows)
    assert set(by_case)=={r['case'] for r in rows}
    for row in rows:
        control=by_case[row['case']]
        for key in ('aperture_pixels','current_pixels','analysis_rejected'):
            assert row.get(key)==control.get(key),(row['case'],key)
        row['variants']+=control['variants']
        assert len({v['method'] for v in row['variants']})==len(row['variants'])
    return rows

def figures(photo,maps,out):
    import matplotlib.pyplot as plt
    from matplotlib.colors import to_rgba
    z=np.load(maps);image=z['image'];accepted=z['accepted'];mask=z['mask']
    # Compare each treatment with the original residual veto retained or relaxed.
    fig,axes=plt.subplots(2,4,figsize=(14,7.8),layout='constrained')
    methods=['slow-lighting','isolated-outliers','mild-smoothing','lighting-and-smoothing']
    labels=['Slow lighting removed','Isolated outliers removed','Mild smoothing','Lighting + smoothing']
    for j,(name,label) in enumerate(zip(methods,labels)):
        for k,limit in enumerate([.2,.3]):
            ax=axes[k,j];row=next(v for v in photo['variants'] if v['preprocessing']==name and v['raw_residual_limit']==limit)
            ax.imshow(image,cmap='gray',origin='upper');overlay=np.zeros((*mask.shape,4));overlay[accepted]=to_rgba('#a0a0ad',.45)
            overlay[z[row['method']+'_added']]=to_rgba('#2dd4bf',.9);ax.imshow(overlay,origin='upper');ax.axis('off')
            ax.set_title(f"{label}\nRaw residual ≤{100*limit:.0f}% · {row['coverage_pct']:.2f}% coverage\n+{row['added_pixels']:,} pixels",fontsize=10)
    fig.suptitle('Cleanup used only for assessment — heights from original-image fits\nGray: existing Composite; teal: new research-candidate pixels. Coverage is detected support.')
    fig.savefig(out/'assessment-copies.png',dpi=150);plt.close(fig)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--inputs',type=Path,nargs='+',required=True);p.add_argument('--controls',type=Path);p.add_argument('--photo',type=Path);p.add_argument('--photo-control',type=Path);p.add_argument('--maps',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--complete',action='store_true');args=p.parse_args()
    rows=[r for path in args.inputs for r in json.loads(path.read_text())]
    assert len({r['case'] for r in rows})==len(rows)
    if args.controls:rows=merge_controls(rows,json.loads(args.controls.read_text()))
    if args.complete:assert len(rows)==40 and all(len(r['variants'])==15 for r in rows)
    summary=aggregate(rows);args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'synthetic.json').write_text(json.dumps(rows,indent=2)+'\n');(args.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    photo=json.loads(args.photo.read_text())[0] if args.photo else None
    if args.photo_control:
        assert photo is not None
        photo=merge_controls([photo],json.loads(args.photo_control.read_text()))[0]
    if photo:(args.output/'photograph.json').write_text(json.dumps([photo],indent=2)+'\n')
    for method,s in summary.items():
        r=next(v for v in photo['variants'] if v['method']==method) if photo else None
        print(method,dict(photo_coverage=r['coverage_pct'] if r else None,**s))
    if photo and args.maps:figures(photo,args.maps,args.output)
    root=Path(__file__).resolve().parents[1]
    files=['scripts/experiment-fringe-preprocessing.py','scripts/report-fringe-preprocessing.py','tests/test_fringe_preprocessing_experiment.py','scripts/experiment-fringe-next-coverage.py','backend/vision/fringe_composite.py']
    (args.output/'source-sha256.json').write_text(json.dumps({f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},indent=2)+'\n')
if __name__=='__main__':main()
