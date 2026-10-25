"""Summarize next-coverage experiments; optional figures use a local photo cache."""
from pathlib import Path
import argparse,json,collections
import numpy as np

def summarize(rows):
    by_method=collections.defaultdict(list)
    for case in rows:
        for row in case['variants']:by_method[row['method']].append((case,row))
    result={}
    for method,pairs in by_method.items():
        errors=[(row['added_max_error_nm'],case['case']) for case,row in pairs if row.get('added_max_error_nm') is not None]
        gains=[row['coverage_pct']-100*case['diagnostic']['current_pixels']/case['diagnostic']['aperture_pixels'] for case,row in pairs]
        result[method]=dict(cases=len(pairs),cases_with_additions=sum(row['added_pixels']>0 for case,row in pairs),
            added_pixels=sum(row['added_pixels'] for case,row in pairs),mean_gain_percentage_points=float(np.mean(gains)),
            worst_added_error_nm=max(errors)[0] if errors else None,worst_case=max(errors)[1] if errors else None,
            added_outside_pixels=sum(row.get('added_outside_pixels',0) for case,row in pairs),
            added_defect_pixels=sum(row.get('added_defect_pixels',0) for case,row in pairs))
    return result

def figures(photo,cache,directory):
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch
    z=np.load(cache/'maps.npz');image=z['image'];mask=z['mask'];accepted=z['accepted'];reasons=z['reasons']
    names=list(photo['diagnostic']['first_rejection']);categories=[('Poorly constrained fit','#f472b6'),('Insufficient contrast','#facc15'),('Intensity mismatch','#fb923c'),('Fits disagree','#60a5fa'),('Anchoring / boundary checks','#a78bfa')]
    rgba=np.zeros((*mask.shape,4));groups=collections.Counter()
    from matplotlib.colors import to_rgba
    for idx,name in enumerate(names,1):
        category=0 if 'conditioning' in name else 1 if 'contrast' in name else 2 if 'residual' in name else 3 if 'agreement' in name or 'phase_shift' in name else 4
        selected=(reasons==idx)&mask&~accepted
        rgba[selected]=to_rgba(categories[category][1],.78);groups[category]+=int(selected.sum())
    fig,(ax,bars)=plt.subplots(1,2,figsize=(12,5.5),layout='constrained')
    ax.imshow(image,cmap='gray',origin='upper');ax.imshow(rgba,origin='upper');ax.axis('off');ax.set_title('First failing check in the missing 30.0%')
    labels=[name for name,color in categories];counts=[groups[i] for i in range(len(categories))]
    bars.barh(labels,counts,color=[color for name,color in categories]);bars.invert_yaxis();bars.set_xlabel('Rejected analysis pixels (exclusive counts)')
    for i,count in enumerate(counts):bars.text(count,i,f' {count:,}',va='center')
    bars.set_xlim(0,max(counts)*1.25);bars.spines[['top','right']].set_visible(False)
    fig.suptitle('Rejection diagnosis within detected support — not a height-error map');fig.savefig(directory/'rejections.png',dpi=160);plt.close(fig)
    variants=sorted(photo['variants'],key=lambda r:r['coverage_pct'],reverse=True)
    fig,axes=plt.subplots(2,3,figsize=(13,8.5),layout='constrained')
    for ax,row in zip(axes.flat,[dict(method='current',coverage_pct=100*accepted.sum()/mask.sum(),added_pixels=0),*variants[:5]]):
        ax.imshow(image,cmap='gray',origin='upper');layer=np.zeros((*mask.shape,4));layer[accepted]=to_rgba('#a0a0ad',.45)
        if row['method']!='current':layer[z[row['method']+'_added']]=to_rgba('#2dd4bf',.85)
        ax.imshow(layer,origin='upper');ax.axis('off');ax.set_title(f"{row['method']}\n{row['coverage_pct']:.2f}% · +{row['added_pixels']:,} pixels",fontsize=10)
    fig.suptitle('Independent research candidates — gray: current; teal: extra coverage\nCoverage alone does not demonstrate accuracy')
    fig.savefig(directory/'candidates.png',dpi=160);plt.close(fig)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--synthetic',type=Path,required=True);p.add_argument('--photo',type=Path);p.add_argument('--cache',type=Path);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    args.output.mkdir(parents=True,exist_ok=True);rows=json.loads(args.synthetic.read_text());result=summarize(rows)
    (args.output/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
    if args.photo and args.cache:figures(json.loads(args.photo.read_text())[0],args.cache,args.output)
if __name__=='__main__':main()
