"""Coverage-first local-fit experiment; allowances are hypotheses, not bounds.

Compare existing-mask recovery with recovery across the user's selected aperture.
Truth enters scoring only. Never interpolate a surface into unmeasured pixels.
"""
import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import runpy
import sys
from unittest.mock import patch

import numpy as np
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
E = runpy.run_path(str(ROOT/'scripts/experiment-fringe-continuation-checks.py'))
from fringe_edge_recovery import fit_window, anchored_candidate, extend_from_candidates

ALLOWANCES = (5., 10., 20.)
WINDOWS = ((.35, .175), (.5, .25), (.5, .5))
NM_PER_RAD = 632.8/(4*np.pi)


def recover(source, domain, allowance_nm):
    """Prepare fits once using prepare_fits instead for multi-allowance runs."""
    return recover_fits(source, domain, prepare_fits(source, domain), allowance_nm)


def prepare_fits(source, domain):
    return [(fit_window(source['image'], domain, source['metadata'], a, b),
             fit_window(source['image'], domain, source['metadata'], 1.3*a, 1.3*b))
            for a, b in WINDOWS]


def recover_fits(source, domain, fits, allowance_nm):
    """Use measured local fits with two-window agreement and original anchors.

    The score combines window disagreement and normalized intensity residual.
    Its nm units are convenient, but it is NOT a measured-error guarantee.
    The holdout audit below tests whether the allowance actually bounds error.
    """
    if not np.isfinite(allowance_nm) or allowance_nm <= 0:
        raise ValueError('A positive finite allowance is required')
    candidates = []
    for small, large in fits:
        difference = np.abs(np.angle(np.exp(1j*(small['phase']-large['phase']))))
        residual = np.maximum(small['residual']/np.maximum(small['amplitude'], 1e-12),
                              large['residual']/np.maximum(large['amplitude'], 1e-12))
        score_nm = NM_PER_RAD*np.maximum(difference, residual)
        reliable = domain & (small['amplitude'] > 10) & (large['amplitude'] > 10)
        reliable &= (small['condition'] < 10000) & (large['condition'] < 10000)
        reliable &= np.isfinite(score_nm) & (score_nm <= allowance_nm)
        candidates.append(anchored_candidate(
            source['phase'], source['valid'], small['phase'], reliable, domain,
            np.where(domain, np.maximum(small['amplitude'], 0), 0),
            source['metadata']['fringe_period_px'], reach=None, erode=False))
    phase, valid, votes = extend_from_candidates(
        source['phase'], source['valid'], candidates, consensus=True,
        tolerance=allowance_nm/NM_PER_RAD)
    return dict(phase=phase, valid=valid, votes=votes)


def run_case(case, cache_dir=Path('/tmp/loupe-continuation-cache'), rim_audit=False):
    baselines, source = E['load_baselines'](case, cache_dir)
    outputs = {'hybrid': baselines['hybrid'], 'selective-local': baselines['bank-model-check']}
    for mode in (('selected',) if rim_audit else ('supported', 'selected')):
        domain = source['mask'] if mode == 'supported' or case['selected'] is None else case['selected']
        # Preserve explicit exclusions; existing observations remain unchanged.
        fits = prepare_fits(source, domain)
        for allowance in ((5.,) if rim_audit else ALLOWANCES):
            outputs[f'{mode}-{allowance:g}nm'] = recover_fits(source, domain, fits, allowance)
        if rim_audit:
            parent = outputs['selected-5nm']
            distance = distance_transform_edt(np.pad(domain, 1))[1:-1, 1:-1]
            for margin in (1, 2, 3):
                outputs[f'selected-5nm-rim{margin}'] = dict(
                    phase=parent['phase'].copy(),
                    valid=source['valid'] | (parent['valid'] & (distance > margin)))
    theta = source['metadata']['carrier_angle_rad']
    scale = np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])*NM_PER_RAD
    base = source['valid']
    baseline = dict(valid=base, height=source['phase']*scale)
    y, x = np.indices(base.shape)
    design = np.column_stack([np.ones(base.sum()), x[base], y[base]])
    physical = case['physical']
    full_design = np.column_stack([np.ones(physical.sum()), x[physical], y[physical]])
    full_truth = case['truth'][physical]
    full_truth_pv = float(np.ptp(full_truth-full_design @ np.linalg.lstsq(full_design, full_truth, rcond=None)[0]))
    distance = distance_transform_edt(np.pad(physical, 1))[1:-1, 1:-1]
    edge = physical & (distance <= max(2., .1*np.sqrt(physical.sum()/np.pi)))
    rows = []
    for name, output in outputs.items():
        valid = output['valid']; height = output['phase']*scale
        metrics = E['E']['B']['metrics'](case, dict(valid=valid, height=height), baseline)
        error = height-case['truth']
        coeff = np.linalg.lstsq(design, error[base], rcond=None)[0]
        aligned = error-(coeff[0]+coeff[1]*x+coeff[2]*y)
        added = valid & ~base
        allowance = float(name.split('-')[1][:-2]) if 'nm' in name else None
        metrics.update(edge_coverage_pct=float(100*(valid & edge).sum()/edge.sum()),
                       physical_coverage_pct=float(100*(valid & physical).sum()/physical.sum()),
                       added_cap_pixels=int((added & case['cap']).sum()),
                       added_anchor_max_nm=float(np.abs(aligned[added]).max()) if added.any() else None,
                       added_anchor_rms_nm=float(np.sqrt(np.mean(aligned[added]**2))) if added.any() else None,
                       pv_error_nm=float(abs(metrics['recovered_pv_nm']-metrics['truth_pv_nm'])),
                       full_aperture_truth_pv_nm=full_truth_pv,
                       full_aperture_pv_error_nm=float(abs(metrics['recovered_pv_nm']-full_truth_pv)),
                       allowance_nm=allowance,
                       added_over_allowance=int((added & (np.abs(aligned) > allowance)).sum()) if allowance is not None else None,
                       upstream_lost_pixels=int((physical & ~source['mask']).sum()),
                       recovered_upstream_pixels=int((valid & physical & ~source['mask']).sum()))
        rows.append(dict(case=case['name'], method=name, **metrics))
    return rows, outputs, source


def budget_holdouts():
    """18 new scenes specified after the pilot, with the six rules unchanged."""
    from scipy.ndimage import binary_dilation
    for j, kind in enumerate(('flat', 'saddle', 'roll', 'bump', 'weak-rim', 'defect')):
        for k in range(3):
            ny, nx = (181, 213) if k != 1 else (206, 194)
            y, x = np.mgrid[:ny, :nx]; u = x/(nx-1); v = y/(ny-1)
            rng = np.random.default_rng(20261030+j*131+k*37)
            r = np.hypot((u-.47)/.40, (v-.51)/.36)
            physical = r < 1
            if k == 1: physical &= np.hypot(u-.50, v-.49) > .09
            if k == 2: physical &= u+.3*v > .31
            selected = binary_dilation(physical, iterations=3) if k == 2 else physical.copy()
            truth = np.zeros((ny, nx))
            if kind == 'saddle': truth = 140*((u-.5)**2-.8*(v-.5)**2)
            if kind == 'roll': truth = -35*np.clip((r-.87)/.13, 0, 1)**2
            if kind == 'bump': truth = 42*np.exp(-((u-.73)**2+(v-.36)**2)/.0025)
            period = rng.uniform(8, 19); theta = rng.uniform(.1, 3.)
            fx, fy = np.cos(theta)/period, np.sin(theta)/period
            amplitude = np.full((ny, nx), 72.)
            if kind == 'weak-rim': amplitude *= .1+.9*np.clip((1-r)/.22, 0, 1)
            arg = 2*np.pi*(fx*x+fy*y)+4*np.pi*truth/632.8+rng.uniform(-np.pi, np.pi)
            signal = 125+22*(v-.5)+amplitude*np.cos(arg)
            cap = np.zeros_like(physical)
            if kind == 'defect':
                cap = physical & (np.hypot(u-.57, v-.44) < .045)
                signal[cap] = 232
            image = np.rint(np.clip(np.where(physical, signal, 14)+rng.normal(0, (1., 2.5, 1.5)[k], signal.shape), 0, 255))
            yield dict(name=f'budget-holdout-{kind}-{k}', image=image, truth=truth,
                       physical=physical, selected=selected, fx=fx, fy=fy, cap=cap)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite', choices=['matrix', 'stress', 'challenge', 'holdout', 'confirmation', 'blind', 'fresh', 'budget-holdout'], default='matrix')
    parser.add_argument('--cases', nargs='+')
    parser.add_argument('--rim-audit', action='store_true', help='Compare thin 1/2/3-pixel rim controls at the 5 nm admission score')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rows = []
    with ExitStack() as stack:
        for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                     'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
            stack.enter_context(patch.object(E['E']['f'], name, lambda *a, **kw: ''))
        stack.enter_context(patch.object(E['E']['f'], '_edge_inspection', lambda *a, **kw: {}))
        cases = budget_holdouts() if args.suite == 'budget-holdout' else E['fixtures'](args.suite)
        for case in cases:
            if args.cases and case['name'] not in args.cases: continue
            result, _, _ = run_case(case, rim_audit=args.rim_audit); rows.extend(result)
            print(case['name'], [(r['method'], round(r['coverage_pct'], 1),
                  round(r['edge_coverage_pct'], 1), round(r['added_anchor_max_nm'] or 0, 2)) for r in result], flush=True)
            args.output.write_text(json.dumps(rows, indent=2)+'\n')


if __name__ == '__main__': main()
