"""Summarize all model-stack outcomes, including defect and order failures."""
from pathlib import Path
import argparse, hashlib, json
import numpy as np


def merge_followup(rows, followup):
    other={r['case']:r for r in followup}
    assert len(other)==len(followup)==len(rows)
    assert set(other)=={r['case'] for r in rows}
    for row in rows:
        new=other[row['case']]
        for key in ('aperture_pixels','current_pixels','earlier_layers_preserved','analysis_rejected'):
            assert row.get(key)==new.get(key),(row['case'],key)
        row['variants']+=new['variants']
        assert len({v['method'] for v in row['variants']})==len(row['variants'])
        row['followup_elapsed_seconds']=new['elapsed_seconds']
    return rows


def summarize(rows):
    names=[v['method'] for v in rows[0]['variants']];result={}
    for name in names:
        pairs=[(r,next(v for v in r['variants'] if v['method']==name)) for r in rows]
        errors=[(v['added_max_error_nm'],r['case']) for r,v in pairs if v['added_max_error_nm'] is not None]
        worst=max(errors) if errors else (None,None)
        count=sum(v['added_pixels'] for _,v in pairs)
        result[name]=dict(cases=len(rows),cases_gaining=sum(v['added_pixels']>0 for _,v in pairs),added_pixels=count,
            mean_gain_percentage_points=float(np.mean([v['coverage_pct']-100*r['current_pixels']/r['aperture_pixels'] for r,v in pairs])),
            worst_added_error_nm=worst[0],worst_case=worst[1],
            pooled_added_rms_error_nm=float(np.sqrt(sum((v['added_rms_error_nm'] or 0)**2*v['added_pixels'] for _,v in pairs)/count)) if count else None,
            **{k:sum(v[k] for _,v in pairs) for k in ('added_over_10nm','added_over_20nm','added_over_50nm','added_outside_pixels','added_defect_pixels','joint_order_rejected_pixels')},
            old_phase_change_max_rad=max(v['old_phase_change_max_rad'] for _,v in pairs),
            remaining_old_order_conflict_pixels=sum(v['remaining_old_order_conflict_pixels'] for _,v in pairs))
    return result


def figures(photo, maps, directory):
    import matplotlib.pyplot as plt
    from matplotlib.colors import to_rgba
    from matplotlib.patches import Patch
    z=np.load(maps,allow_pickle=False);accepted=z['accepted'];mask=z['mask']
    colors=['#38bdf8','#34d399','#fbbf24','#fb7185','#c084fc']
    names=['Linear','Small linear','Quadratic + harmonic','Linear + harmonic','Small linear + harmonic']
    variants={v['method']:v for v in photo['variants']}
    fig,axes=plt.subplots(1,3,figsize=(15,6.4))
    fig.subplots_adjust(left=.005,right=.995,bottom=.14,top=.82,wspace=.02)
    last='tiered-expanded' if 'tiered-expanded' in variants else 'expanded'
    for ax,key,title in zip(axes,[None,'core-linear-first',last],['Existing Composite','Separate-model stack','Additive expanded stack' if last=='tiered-expanded' else 'Expanded model stack']):
        ax.imshow(z['image'],cmap='gray',origin='upper');rgba=np.zeros((*mask.shape,4));rgba[accepted]=to_rgba('#a0a0ad',.65)
        if key:
            source=z[key+'_source'];added=z[key+'_added']
            for i,color in enumerate(colors,6):rgba[added&(source==i)]=to_rgba(color,.95)
            coverage=variants[key]['coverage_pct'];count=variants[key]['added_pixels']
        else:coverage=100*accepted.sum()/mask.sum();count=0
        ax.imshow(rgba,origin='upper');ax.set_title(f'{title}\n{coverage:.2f}% coverage · +{count:,} pixels',fontsize=11);ax.axis('off')
    fig.legend(handles=[Patch(color='#a0a0ad',label='Existing measurements')]+[Patch(color=c,label=n) for c,n in zip(colors,names)],
               loc='lower center',bbox_to_anchor=(.5,.015),ncol=3,fontsize=10)
    fig.suptitle('Additional measured area by model — original-image fits, earlier heights unchanged\nResearch comparison; coverage within detected support, not an accuracy certificate',fontsize=12,y=.98)
    directory.mkdir(parents=True,exist_ok=True);fig.savefig(directory/'coverage.png',dpi=160);plt.close(fig)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--inputs',type=Path,nargs='+',required=True)
    p.add_argument('--tiered-inputs',type=Path,nargs='+');p.add_argument('--tiered-photo',type=Path)
    p.add_argument('--photo',type=Path);p.add_argument('--maps',type=Path);p.add_argument('--figures',type=Path)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--complete',action='store_true');args=p.parse_args()
    rows=[r for path in args.inputs for r in json.loads(path.read_text())]
    if args.tiered_inputs:rows=merge_followup(rows,[r for path in args.tiered_inputs for r in json.loads(path.read_text())])
    assert len(rows)==len({r['case'] for r in rows})
    regression=[r for r in rows if not r['case'].startswith('stack-stress-')]
    fresh=[r for r in rows if r['case'].startswith('stack-stress-')]
    if args.complete:assert len(regression)==40 and len(fresh)==8 and all(len(r['variants'])==12 for r in rows)
    summary={k:summarize(v) for k,v in [('regression',regression),('new_stress',fresh),('all',rows)] if v}
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'synthetic.json').write_text(json.dumps(rows,indent=2)+'\n')
    (args.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    if args.photo:
        photo=json.loads(args.photo.read_text())[0]
        if args.tiered_photo:photo=merge_followup([photo],json.loads(args.tiered_photo.read_text()))[0]
        (args.output/'photograph.json').write_text(json.dumps([photo],indent=2)+'\n')
        if args.maps and args.figures:figures(photo,args.maps,args.figures)
    root=Path(__file__).resolve().parents[1]
    files=['scripts/fringe_model_stack.py','scripts/experiment-fringe-model-stack.py','scripts/report-fringe-model-stack.py',
           'scripts/experiment-fringe-next-coverage.py','tests/test_fringe_model_stack.py',
           'backend/vision/fringe_composite.py','backend/vision/fringe_hybrid.py']
    (args.output/'source-sha256.json').write_text(json.dumps({f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},indent=2)+'\n')
    print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
