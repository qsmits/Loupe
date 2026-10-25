"""Audit the integrated photographic layer against the identical Composite without it."""
from pathlib import Path
import sys,json,runpy,argparse,hashlib
from contextlib import ExitStack
from unittest.mock import patch
import numpy as np
from scipy.ndimage import gaussian_filter
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.vision import fringe_composite as c,fringe as f
E=runpy.run_path(str(Path(__file__).with_name('experiment-fringe-photographic-residual.py')))


def fresh_cases():
    y,x=np.mgrid[:224,:256];r=np.sqrt(((x-128)/108)**2+((y-112)/92)**2)
    physical=(r<1)&(np.hypot(x-121,y-126)>12)
    for i in range(8):
        period=16+2.1*i;angle=.17+.37*i;fx=np.cos(angle)/period;fy=np.sin(angle)/period
        truth=12*((x-128)/108)**2-35*np.clip((r-.82)/.18,0,1)**2
        if i>=4:truth-=20*np.exp(-((r-.95)/.03)**2)
        arg=2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+.41*i
        rng=np.random.default_rng(20261025+i)
        texture=gaussian_filter(rng.normal(0,1,x.shape),[.7,2.3,5.1,9.4][i%4]);texture*=3/texture.std()
        image=145+18*np.sin(x/79)+25*np.cos(arg)+3*np.cos(2*arg+.6)+texture+rng.normal(0,1,x.shape)
        defect=(np.hypot(x-173,y-93)<6) if i%2 else np.zeros(x.shape,bool)
        image[defect]=145
        yield dict(name=f'fresh-texture-{i}',image=np.where(physical,image,15),truth=truth,
            physical=physical,selected=physical.copy(),fx=fx,fy=fy,cap=defect&physical)


def evaluate(case):
    build=c.build_composite;fit=c.fit_window;cache={};row=dict(case=case['name'])
    def memo(image,mask,meta,a,b,degree=2):
        key=(hashlib.sha256(image.tobytes()).hexdigest(),hashlib.sha256(mask.tobytes()).hexdigest(),a,b,degree)
        if key not in cache:cache[key]=fit(image,mask,meta,a,b,degree)
        return cache[key]
    def audit(image,mask,phase,valid,meta,*args,**kwargs):
        old=build(image,mask,phase,valid,meta,*args,**kwargs,_photographic=False)
        new=build(image,mask,phase,valid,meta,*args,**kwargs)
        assert np.array_equal(old[0][old[1]],new[0][old[1]])
        assert np.all(new[1][old[1]])
        assert np.array_equal(old[2]['conflict'],new[2]['conflict'])
        assert np.array_equal(old[2]['quality'][old[1]],new[2]['quality'][old[1]])
        assert np.array_equal(old[2]['source'][old[1]],new[2]['source'][old[1]])
        added=(new[2]['source']==5)&~new[2]['conflict']
        assert np.all(new[2]['quality'][added]==3)
        assert not (added & ~mask).any()
        theta=meta['carrier_angle_rad'];sign=np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])
        error=new[0]*sign*632.8/(4*np.pi)-case['truth']
        y,x=np.indices(mask.shape);A=np.column_stack([np.ones(valid.sum()),x[valid],y[valid]])
        reference=phase*sign*632.8/(4*np.pi)-case['truth'];co=np.linalg.lstsq(A,reference[valid],rcond=None)[0]
        error-=co[0]+co[1]*x+co[2]*y
        before=old[1]&~old[2]['conflict'];after=new[1]&~new[2]['conflict']
        row.update(before_coverage_pct=float(100*(before&case['physical']).sum()/case['physical'].sum()),
            after_coverage_pct=float(100*(after&case['physical']).sum()/case['physical'].sum()),
            added_pixels=int(added.sum()),added_max_error_nm=float(np.abs(error[added]).max()) if added.any() else None,
            before_max_error_nm=float(np.abs(error[before]).max()) if before.any() else None,
            after_max_error_nm=float(np.abs(error[after]).max()) if after.any() else None,
            added_outside_pixels=int((added&~case['physical']).sum()),added_defect_pixels=int((added&case['cap']).sum()),
            earlier_layers_preserved=True,diagnostics=new[2]['diagnostics']['photographic'])
        return new
    with patch.object(c,'fit_window',memo),patch.object(c,'build_composite',audit):
        try:
            f.analyze_interferogram(case['image'],custom_mask=case['selected'],form_model='plane',
                                   analysis_method='composite',wavelength_nm=632.8,n_zernike=15)
        except ValueError as error:
            if 'fringe-order check' not in str(error):raise
            row['analysis_rejected']=str(error)
    return row


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--fresh',action='store_true');p.add_argument('--filtered-limit',type=float,choices=[.1,.2]);args=p.parse_args();rows=[]
    if args.filtered_limit is not None:
        photographic=c.photographic_fit_checks
        c.photographic_fit_checks=lambda *a,**kw:photographic(*a,**kw,_filtered_residual_limit=args.filtered_limit)
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        for case in fresh_cases() if args.fresh else [*E['fixtures'](),*E['holdouts']()]:
            row=evaluate(case);rows.append(row);print(json.dumps(row),flush=True)
            args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(rows,indent=2)+'\n')
if __name__=='__main__':main()
