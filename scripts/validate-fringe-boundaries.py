"""Compare boundary/outline experiments against analytic height, never rendered maps.

MPLCONFIGDIR=/tmp/loupe-mpl .venv/bin/python scripts/validate-fringe-boundaries.py --output /tmp/fringe-boundaries.json
The bounded method is the application default. Alternative experimental modes
are Python-only; none are exposed by the application API.
The common-pixel and added-pixel errors prevent coverage gains from hiding bias.
"""
from pathlib import Path
import argparse
from contextlib import ExitStack
import json
import sys
from unittest.mock import patch
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.vision import fringe as f


def fixtures(stress=False):
    """Deterministic holdout cases distinct from the initial tuning fixtures."""
    specs = []
    for cycles, angle, phase in [(6.3, 7, 1.2), (10.7, 31, 2.8), (17.4, 63, .9), (24.2, 89, 2.1)]:
        for shape in ('flat', 'bow', 'broad-roll', 'narrow-roll'):
            specs.append((f'{shape}-{cycles}', 192, cycles, angle, phase, shape, 'disk', 0, 'precise'))
    for outline in ('disk', 'clipped', 'hole', 'frame'):
        for shape in ('flat', 'broad-roll'):
            specs.append((f'noisy-{outline}-{shape}', 224, 19.1, 38, 1.3, shape, outline, 2, 'precise'))
    for selection in ('auto', 'oversized', 'precise'):
        for feature in ('flat', 'weak-rim', 'cap', 'weak-all'):
            specs.append((f'{selection}-{feature}', 192, 16.2, 52, .73, feature, 'disk', 1, selection))
    if stress:
        specs = []
        for angle in (0, 17, 43, 77, 111, 147):
            for cycles in (7.9, 13.2, 21.8, 32.4):
                for shape in ('flat', 'broad-roll'):
                    n = 192 if cycles < 20 else 256
                    specs.append((f'stress-{shape}-{angle}-{cycles}', n, cycles, angle,
                                  .23 + angle/51, shape, 'disk', .7 if angle < 50 else 4, 'precise'))
        for outline in ('clipped', 'hole', 'corner', 'frame'):
            for angle in (12, 58, 123):
                specs.append((f'stress-{outline}-{angle}', 256, 18.6, angle, 2.37,
                              'bow', outline, 1.5, 'precise'))
    for i, (name, n, cycles, angle, phase, shape, outline, noise, selection) in enumerate(specs):
        y, x = np.mgrid[:n, :n]
        r = np.hypot(x-(.20 if outline=='corner' else .53)*n,
                     y-(.22 if outline=='corner' else .47)*n)
        radius = .37*n
        physical = r <= radius
        if outline == 'clipped': physical &= x > .35*n
        if outline == 'hole': physical &= np.hypot(x-.58*n,y-.46*n) > .07*n
        if outline == 'frame': physical = np.ones((n,n), bool)
        truth = np.zeros((n,n))
        if shape == 'bow': truth = 30*((x/n-.5)**2+.65*(y/n-.5)**2)
        if shape == 'broad-roll': truth = -40*np.clip((r-(radius-.14*n))/(.14*n),0,1)**2
        if shape == 'narrow-roll': truth = -40*np.clip((r-(radius-.04*n))/(.04*n),0,1)**2
        fx, fy = cycles/n*np.cos(np.deg2rad(angle)), cycles/n*np.sin(np.deg2rad(angle))
        amplitude = np.full((n,n), 75.)
        if shape == 'weak-rim': amplitude *= .05+.95*np.clip((radius-r)/(.10*n),0,1)
        if shape == 'weak-all': amplitude *= .12
        cap = np.hypot(x-.50*n,y-.48*n) < .09*n
        if shape == 'cap': amplitude[cap] = 0
        image = np.where(physical,125+30*(x/n-.5)+amplitude*np.cos(2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+phase),15.)
        image += np.random.default_rng(100+i).normal(0,noise,(n,n))
        if stress: image = np.rint(np.clip(image, 0, 255))
        selected = physical.copy()
        if selection == 'auto': selected = None
        if selection == 'oversized': selected = r <= radius+.08*n
        yield dict(name=name,image=image,truth=truth,physical=physical,selected=selected,fx=fx,fy=fy,cap=cap if shape=='cap' else np.zeros_like(cap))


def analyze_case(case, mode):
    observed={}
    original=f.unwrap_phase_2d
    def unwrap(wrapped, mask=None, **kw):
        phase,risk,quality=original(wrapped,mask,**kw)
        observed.update(phase=phase,valid=mask & (risk!=2))
        return phase,risk,quality
    with patch.object(f,'unwrap_phase_2d',unwrap):
        result=f.analyze_interferogram(case['image'],wavelength_nm=632.8,custom_mask=case['selected'],n_zernike=15,form_model='plane',_edge_mode=mode)
    sign=np.sign(result['carrier']['fx_cpp']*case['fx']+result['carrier']['fy_cpp']*case['fy'])
    observed['height']=sign*observed.pop('phase')*632.8/(4*np.pi)
    observed['result']=result
    return observed


def metrics(case, current, baseline):
    valid=current['valid']; base=baseline['valid']; truth=case['truth']; height=current['height']
    y,x=np.indices(valid.shape)
    def remove_plane(values,mask):
        A=np.column_stack([np.ones(mask.sum()),x[mask],y[mask]])
        return values[mask]-A@np.linalg.lstsq(A,values[mask],rcond=None)[0]
    # Only piston and tilt may be fitted. No rescaling, curvature removal,
    # registration, or best-case sign chosen from the recovered surface.
    error=height-truth
    A=np.column_stack([np.ones(valid.sum()),x[valid],y[valid]])
    coeff=np.linalg.lstsq(A,error[valid],rcond=None)[0]
    aligned=error-(coeff[0]+coeff[1]*x+coeff[2]*y)
    common=valid & base
    added=valid & ~base
    target=remove_plane(truth,valid); recovered=remove_plane(height,valid)
    out=dict(coverage_pct=100*valid.sum()/case['physical'].sum(),n_measured=int(valid.sum()),
        added_pixels=int(added.sum()),removed_pixels=int((base & ~valid).sum()),
        outside_physical_pixels=int((valid & ~case['physical']).sum()),
        cap_pixels=int((valid & case['cap']).sum()),
        rms_error_nm=float(np.sqrt(np.mean(aligned[valid]**2))),max_error_nm=float(np.abs(aligned[valid]).max()),
        recovered_pv_nm=float(np.ptp(recovered)),truth_pv_nm=float(np.ptp(target)),
        common_rms_error_nm=float(np.sqrt(np.mean(remove_plane(error,common)**2))) if common.any() else None,
        added_rms_error_nm=float(np.sqrt(np.mean(aligned[added]**2))) if added.any() else None,
        added_max_error_nm=float(np.abs(aligned[added]).max()) if added.any() else None)
    return {k:round(v,6) if isinstance(v,float) else v for k,v in out.items()}


def compare(modes=('legacy','footprint','outline','combined','bounded'), names=None, progress=False, stress=False):
    if not modes or modes[0] != 'legacy':
        raise ValueError('The first mode must be legacy to establish the comparison aperture')
    rows=[]
    with ExitStack() as stack:
        for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
            stack.enter_context(patch.object(f,name,lambda *a,**kw:''))
        stack.enter_context(patch.object(f,'_edge_inspection',lambda *a,**kw:{}))
        for case in fixtures(stress):
            if names is not None and case['name'] not in names: continue
            baseline=None
            for mode in modes:
                try:
                    current=analyze_case(case,mode)
                    if baseline is None: baseline=current
                    rows.append(dict(case=case['name'],mode=mode,**metrics(case,current,baseline)))
                except ValueError as e:
                    rows.append(dict(case=case['name'],mode=mode,error=str(e)))
            if progress: print(case['name'],file=sys.stderr,flush=True)
    return rows


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output');p.add_argument('--modes',nargs='+',default=['legacy','footprint','outline','combined','bounded']);p.add_argument('--cases',nargs='+');p.add_argument('--stress',action='store_true');args=p.parse_args()
    rows=compare(args.modes,args.cases,progress=True,stress=args.stress)
    text=json.dumps(rows,indent=2)+'\n'
    if args.output: Path(args.output).write_text(text)
    else: print(text)
