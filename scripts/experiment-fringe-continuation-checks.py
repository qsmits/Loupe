"""Compare continuation admission checks; preserve the earlier study unchanged."""
import argparse
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import runpy
import sys
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
E = runpy.run_path(str(ROOT/'scripts/experiment-fringe-edge-recovery.py'))
from fringe_continuation_checks import withheld_phase_check, structured_residual_check, checked_composite

BASE_METHODS = ('hybrid', 'bank-model-check', 'padded-continuation', 'padded-composite')


def load_baselines(case, cache_dir=None):
    """Cache image-derived baselines only, keyed by input and implementation.

    Analytic truth and physical aperture never enter this cache or admission.
    Metrics are recomputed each run, so altered truth tests do not reuse scores.
    """
    digest = hashlib.sha256()
    for value in (case['image'], case['selected']):
        if value is None:
            digest.update(b'no-custom-mask')
            continue
        digest.update(str((value.shape, value.dtype)).encode())
        digest.update(value.tobytes())
    for name in ('scripts/fringe_edge_recovery.py', 'scripts/experiment-fringe-edge-recovery.py',
                 'backend/vision/fringe.py', 'backend/vision/fringe_hybrid.py'):
        digest.update((ROOT/name).read_bytes())
    path = cache_dir/f'{digest.hexdigest()}.npz' if cache_dir else None
    if path and path.exists():
        with np.load(path, allow_pickle=False) as data:
            source = {key: data['source_'+key] for key in ('image', 'mask', 'phase', 'valid')}
            source['metadata'] = json.loads(str(data['metadata']))
            outputs = {method: {key: data[method+'_'+key] for key in ('phase', 'valid')}
                       for method in BASE_METHODS}
        return outputs, source
    _, outputs, source = E['run_case'](case, ['padded-composite'])
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {'source_'+key: source[key] for key in ('image', 'mask', 'phase', 'valid')}
        payload['metadata'] = json.dumps(source['metadata'])
        for method in BASE_METHODS:
            for key in ('phase', 'valid'):
                payload[method+'_'+key] = outputs[method][key]
        np.savez_compressed(path, **payload)
    return outputs, source


def run_case(case, cache_dir=None):
    outputs, source = load_baselines(case, cache_dir)
    phase, anchors = source['phase'], source['valid']
    period = source['metadata']['fringe_period_px']
    rim, rim_diag = withheld_phase_check(phase, anchors, period)
    strips, strips_diag = withheld_phase_check(phase, anchors, period, directional=True)
    structured, structured_diag, bias = structured_residual_check(
        source['image'], source['mask'], phase, anchors, source['metadata'])
    gates = {
        'cv-rim': np.full(phase.shape, rim),
        'cv-strips': np.full(phase.shape, strips),
        'structured': structured,
        'cv-rim-structured': structured & rim,
        'cv-strips-structured': structured & strips,
    }
    for name, gate in gates.items():
        p, valid = checked_composite(outputs['bank-model-check'], outputs['padded-continuation'], anchors, gate)
        outputs[name] = dict(phase=p, valid=valid)
    # Carrier sign is evaluation-only and comes from known fixture direction.
    theta = source['metadata']['carrier_angle_rad']
    scale = np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])*632.8/(4*np.pi)
    baseline = dict(height=phase*scale, valid=anchors)
    rows = []
    y, x = np.indices(phase.shape)
    design = np.column_stack([np.ones(anchors.sum()), x[anchors], y[anchors]])
    for method, output in outputs.items():
        if method not in (*BASE_METHODS, *gates):
            continue
        height = output['phase']*scale
        metrics = E['B']['metrics'](case, dict(height=height, valid=output['valid']), baseline)
        error = height-case['truth']
        coeff = np.linalg.lstsq(design, error[anchors], rcond=None)[0]
        aligned = error-(coeff[0]+coeff[1]*x+coeff[2]*y)
        added = output['valid'] & ~anchors
        metrics['added_anchor_max_nm'] = float(np.max(np.abs(aligned[added]))) if added.any() else None
        metrics['added_anchor_rms_nm'] = float(np.sqrt(np.mean(aligned[added]**2))) if added.any() else None
        rows.append(dict(case=case['name'], method=method, **metrics,
                         rim_check=rim_diag, strip_check=strips_diag, residual_check=structured_diag))
    return rows, outputs, source, bias


def fixtures(suite):
    if suite == 'fresh': return fresh_fixtures()
    if suite == 'matrix': return E['B']['fixtures']()
    if suite == 'stress': return E['B']['fixtures'](True)
    if suite == 'challenge': return E['E']['challenge_fixtures']()
    return E[suite+'_fixtures']()


def fresh_fixtures():
    """36 post-freeze cases, specified before their first reconstruction.

    All five admission rules and thresholds are fixed before this suite runs.
    Distortion is deliberately an optical artifact, excluded from part truth.
    """
    kinds = ('flat', 'quadratic', 'quartic', 'two-bumps', 'ridge', 'edge-roll',
             'hole', 'contrast', 'illumination', 'gamma', 'distortion', 'defects')
    for j, kind in enumerate(kinds):
        for k, shape in enumerate(((171, 197), (210, 186), (191, 223))):
            rng = np.random.default_rng(20261029+101*j+17*k)
            y, x = np.indices(shape); u = x/(shape[1]-1); v = y/(shape[0]-1)
            radius = np.hypot((u-.49)/.43, (v-.52)/.39)
            physical = radius < 1
            if kind == 'flat' and k == 2: physical = np.ones(shape, bool)
            if kind == 'hole': physical &= np.hypot(u-.44, v-.57) > .115
            angle = rng.uniform(.04, 3.1); period = rng.uniform(7.5, 22)
            fx, fy = np.cos(angle)/period, np.sin(angle)/period
            truth = np.zeros(shape)
            if kind != 'flat': truth += 30*((u-.5)**2+.7*(v-.5)**2)
            if kind == 'quadratic': truth += 180*((u-.5)**2-.6*(v-.5)**2)
            if kind == 'quartic': truth += rng.uniform(250, 550)*((u-.5)**4-1.2*(v-.5)**4)+25*(u-.5)**3
            if kind == 'two-bumps': truth += 32*np.exp(-((u-.73)**2+(v-.47)**2)/.004)-23*np.exp(-((u-.26)**2+(v-.65)**2)/.003)
            if kind == 'ridge': truth += 22*np.exp(-((v-.4-.25*u)/.045)**2)
            if kind == 'edge-roll': truth -= 40*np.clip((radius-.85)/.15, 0, 1)**2
            amplitude = np.full(shape, 67.)
            if kind == 'contrast': amplitude *= .12+.88*np.clip((1-radius)/.28, 0, 1)
            illumination = 122+19*(u-.5)-14*(v-.5)
            if kind == 'illumination': illumination += 35*np.exp(-((u-.68)**2+(v-.32)**2)/.03)
            carrier = 2*np.pi*(fx*x+fy*y)
            if kind == 'distortion': carrier += .7*((u-.5)**2+(v-.5)**2)*(2*v-1)
            phase = carrier+4*np.pi*truth/632.8+rng.uniform(-np.pi, np.pi)
            signal = illumination+amplitude*np.cos(phase)
            if kind == 'gamma': signal = 255*(np.clip(signal, 0, 255)/255)**rng.uniform(1.5, 2.2)
            cap = np.zeros(shape, bool)
            if kind == 'defects':
                cap = physical & ((np.hypot(u-.64, v-.39) < .024) | (np.abs(u-.33+.13*v) < .004))
                signal[cap] = 236
            image = np.rint(np.clip(np.where(physical, signal, 13)+rng.normal(0, (.7, 2., 4.)[k], shape), 0, 255))
            yield dict(name=f'fresh-{kind}-{k}', image=image, truth=truth, physical=physical,
                       selected=physical.copy(), fx=fx, fy=fy, cap=cap)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite', choices=['matrix', 'stress', 'challenge', 'holdout', 'confirmation', 'blind', 'fresh'], default='matrix')
    parser.add_argument('--cases', nargs='+')
    parser.add_argument('--cache-dir', type=Path, default=Path('/tmp/loupe-continuation-cache'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rows = []
    with ExitStack() as stack:
        for name in ('render_surface_map', 'render_profile', 'render_fft_image',
                     'render_modulation_map', 'render_confidence_maps', 'render_zernike_chart'):
            stack.enter_context(patch.object(E['f'], name, lambda *a, **kw: ''))
        stack.enter_context(patch.object(E['f'], '_edge_inspection', lambda *a, **kw: {}))
        for case in fixtures(args.suite):
            if args.cases and case['name'] not in args.cases:
                continue
            result, _, _, _ = run_case(case, args.cache_dir)
            rows.extend(result)
            print(case['name'], [(r['method'], round(r['coverage_pct'], 1), round(r['max_error_nm'], 3)) for r in result], flush=True)
            args.output.write_text(json.dumps(rows, indent=2)+'\n')


if __name__ == '__main__':
    main()
