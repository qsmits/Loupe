"""Record reconstruction coverage, errors, and known unsupported pixels honestly."""
from pathlib import Path
import argparse,json,hashlib
import numpy as np


def summarize(rows):
    result={}
    for name in [v['method'] for v in rows[0]['variants']]:
        pairs=[(r,next(v for v in r['variants'] if v['method']==name)) for r in rows]
        errors=[(v['added_max_error_nm'],r['case']) for r,v in pairs if v['added_max_error_nm'] is not None]
        worst=max(errors) if errors else (None,None)
        n=sum(v['reconstructed_pixels'] for _,v in pairs)
        result[name]=dict(cases=len(rows),converged_cases=sum(v['converged'] for _,v in pairs),
            full_display_cases=sum(v['displayed_coverage_pct']>=99.999 for _,v in pairs),
            reconstructed_pixels=n,worst_added_error_nm=worst[0],worst_case=worst[1],
            pooled_added_rms_error_nm=float(np.sqrt(sum((v['added_rms_error_nm'] or 0)**2*v['reconstructed_pixels'] for _,v in pairs)/n)) if n else None,
            **{k:sum(v[k] for _,v in pairs) for k in ('added_over_20nm','added_over_50nm','added_over_100nm','added_outside_pixels','added_defect_pixels','reconstructed_order_conflict_pixels')},
            old_phase_change_max_rad=max(v['old_phase_change_max_rad'] for _,v in pairs))
    return result


def figures(photo,maps,rows,out):
    import matplotlib.pyplot as plt
    out.mkdir(parents=True,exist_ok=True);z=np.load(maps,allow_pickle=False);accepted=z['accepted'];mask=z['mask']
    y,x=np.indices(mask.shape);co=np.linalg.lstsq(np.column_stack([np.ones(accepted.sum()),x[accepted],y[accepted]]),z['current'][accepted],rcond=None)[0]
    plane=co[0]+co[1]*x+co[2]*y;factor=589.3/(4*np.pi)
    measured=(z['current']-plane)*factor;reconstructed=(z['harmonic-0.01_phase']-plane)*factor
    all_maps=np.stack([z[n+'_phase'] for n in ['harmonic-0.01','harmonic-0.1','linear-0.01','linear-0.1']])
    spread=np.ptp(all_maps,axis=0)*factor
    fig,axes=plt.subplots(1,3,figsize=(15,6.2));fig.subplots_adjust(left=.02,right=.98,top=.80,bottom=.19,wspace=.08)
    for ax in axes:ax.imshow(z['image'],cmap='gray',origin='upper');ax.axis('off')
    axes[0].imshow(np.ma.array(measured,mask=~accepted),cmap='coolwarm',vmin=-130,vmax=130,alpha=.9)
    im=axes[1].imshow(np.ma.array(reconstructed,mask=~mask),cmap='coolwarm',vmin=-130,vmax=130,alpha=.9)
    axes[1].contourf(np.where(mask&~accepted,1.,np.nan),levels=[.5,1.5],colors='none',hatches=['///'])
    sens=axes[2].imshow(np.ma.array(spread,mask=~(mask&~accepted)),cmap='magma',vmin=0,vmax=60,alpha=.95)
    axes[0].set_title('Retained measurements: 73.30%')
    axes[1].set_title('Image-guided display: 100%\nHatching = reconstructed')
    axes[2].set_title('Sensitivity to model / smoothing\nShown only in reconstructed areas')
    cb=fig.colorbar(im,ax=axes[:2],orientation='horizontal',fraction=.05,pad=.06,shrink=.85)
    cb.set_label('Relative optical deviation (nm); shared plane, physical height sign unverified')
    cb=fig.colorbar(sens,ax=axes[2],orientation='horizontal',fraction=.05,pad=.06,extend='max')
    cb.set_label('Model spread (nm), NOT calibrated uncertainty')
    fig.suptitle('Research preview: full display is not full measurement coverage\nEvery earlier height stays fixed; reconstructed pixels do not enter measured flatness',fontsize=12,y=.98)
    fig.savefig(out/'photo-reconstruction.png',dpi=160);plt.close(fig)
    fig,axes=plt.subplots(2,2,figsize=(10,7));fig.subplots_adjust(top=.85,bottom=.16,hspace=.35,wspace=.25)
    names=['rim-0-depth-0','rim-2-depth-60','rim-3-depth-100','rim-5-depth-60']
    titles=['Flat part with bright rim','Broad roll: 60 nm at the boundary','Broad roll: 100 nm at the boundary','Narrow roll: 60 nm at the boundary']
    styles=[('smooth-only','Smooth fill','#888888',':'),('harmonic-0.01','Image-guided, λ=0.01','#9333ea','-'),('harmonic-0.1','Image-guided, λ=0.1','#0284c7','--')]
    for ax,name,title in zip(axes.flat,names,titles):
        row=next(r for r in rows if r['case']==name);vs={v['method']:v for v in row['variants']}
        profile=vs['smooth-only']['radial_profile'];r=[.5*(v['radius_low']+v['radius_high']) for v in profile]
        ax.plot(r,[v['truth_mean_nm'] for v in profile],color='black',lw=2,label='Known truth')
        for key,label,color,style in styles:ax.plot(r,[v['estimated_mean_nm'] for v in vs[key]['radial_profile']],color=color,ls=style,label=label)
        ax.set_title(title,fontsize=10);ax.set_xlabel('Radius / part radius');ax.set_ylabel('Radial mean deviation (nm)');ax.grid(alpha=.2)
    handles,labels=axes.flat[0].get_legend_handles_labels();fig.legend(handles,labels,loc='lower center',ncol=2)
    fig.suptitle('Does full display preserve the edge roll?\nSynthetic radial means; local errors can be much larger than the mean',fontsize=12,y=.98)
    fig.savefig(out/'known-edge-profiles.png',dpi=160);plt.close(fig)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--inputs',type=Path,nargs='+',required=True)
    p.add_argument('--raw-inputs',type=Path,nargs='+');p.add_argument('--raw-photo',type=Path);p.add_argument('--photo',type=Path,required=True)
    p.add_argument('--maps',type=Path);p.add_argument('--figures',type=Path);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    rows=[r for path in args.inputs for r in json.loads(path.read_text())]
    assert len(rows)==len({r['case'] for r in rows})==56 and all(len(r['variants'])==7 for r in rows)
    photo=json.loads(args.photo.read_text());args.output.mkdir(parents=True,exist_ok=True)
    for name,obj in [('synthetic.json',rows),('photograph.json',photo)]: (args.output/name).write_text(json.dumps(obj,indent=2)+'\n')
    summary={group:summarize(subset) for group,subset in [('earlier_48',[r for r in rows if not r['case'].startswith('rim-')]),('rim_controls',[r for r in rows if r['case'].startswith('rim-')]),('all',rows)]}
    (args.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    if args.raw_inputs:
        raw=[r for path in args.raw_inputs for r in json.loads(path.read_text())]
        assert len(raw)==len({r['case'] for r in raw})==56 and all(len(r['variants'])==16 for r in raw)
        (args.output/'raw-fit-synthetic.json').write_text(json.dumps(raw,indent=2)+'\n')
    if args.raw_photo:(args.output/'raw-fit-photograph.json').write_text(args.raw_photo.read_text())
    if args.maps and args.figures:figures(photo[0],args.maps,rows,args.figures)
    root=Path(__file__).resolve().parents[1]
    files=['scripts/fringe_gradient_reconstruction.py','scripts/experiment-fringe-edge-preview.py',
        'scripts/experiment-fringe-gradient-reconstruction.py','scripts/report-fringe-gradient-reconstruction.py',
        'tests/test_fringe_gradient_reconstruction.py','backend/vision/fringe_composite.py','backend/vision/fringe_hybrid.py']
    (args.output/'source-sha256.json').write_text(json.dumps({f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},indent=2)+'\n')
    print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
