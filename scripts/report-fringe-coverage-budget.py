"""Archive coverage-first experiments, including failed error-budget hypotheses."""
import csv
import hashlib
import json
from pathlib import Path
import platform
import runpy
import subprocess

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import scipy

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'experiments/fringe-coverage-budget'
SUITES = dict(matrix=36, stress=60, challenge=30, holdout=24, confirmation=12,
              blind=12, fresh=36, **{'budget-holdout': 18})
METHODS = ['hybrid', 'selective-local']+[f'{d}-{n}nm' for d in ('supported', 'selected') for n in (5, 10, 20)]


def main():
    experiment = runpy.run_path(str(ROOT/'scripts/experiment-fringe-coverage-budget.py'))
    rows = []
    for suite, count in SUITES.items():
        data = json.loads(Path(f'/tmp/loupe-budget-{suite}.json').read_text())
        cases = list(experiment['budget_holdouts']() if suite == 'budget-holdout' else experiment['E']['fixtures'](suite))
        assert len(cases) == count and len(data) == count*len(METHODS)
        assert len({(r['case'], r['method']) for r in data}) == len(data)
        assert {r['method'] for r in data} == set(METHODS)
        base = {r['case']: r for r in data if r['method'] == 'hybrid'}
        for case in cases:
            physical = case['physical']; y, x = np.indices(physical.shape)
            design = np.column_stack([np.ones(physical.sum()), x[physical], y[physical]])
            truth = case['truth'][physical]
            full_pv = float(np.ptp(truth-design @ np.linalg.lstsq(design, truth, rcond=None)[0]))
            for r in (r for r in data if r['case'] == case['name']):
                # Scoring-only additions for runs made before these columns existed.
                r.update(physical_coverage_pct=100*(r['n_measured']-r['outside_physical_pixels'])/physical.sum(),
                         added_cap_pixels=r['cap_pixels']-base[r['case']]['cap_pixels'],
                         full_aperture_truth_pv_nm=full_pv,
                         full_aperture_pv_error_nm=abs(r['recovered_pv_nm']-full_pv))
                rows.append(dict(suite=suite, **r))
    assert len(rows) == 1824
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT/'results.json').write_text(json.dumps(rows, indent=2)+'\n')
    with (OUT/'results.csv').open('w') as f:
        writer = csv.DictWriter(f, list(rows[0])); writer.writeheader(); writer.writerows(rows)
    for name in ('pilot', 'rim-pilot'):
        (OUT/f'{name}.json').write_bytes(Path(f'/tmp/loupe-budget-{name}.json').read_bytes())
    paths = ['scripts/experiment-fringe-coverage-budget.py', 'scripts/report-fringe-coverage-budget.py',
             'scripts/experiment-fringe-continuation-checks.py', 'scripts/experiment-fringe-edge-recovery.py',
             'scripts/fringe_edge_recovery.py', 'scripts/validate-fringe-boundaries.py',
             'backend/vision/fringe.py', 'backend/vision/fringe_hybrid.py']
    provenance = dict(base_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                      python=platform.python_version(), numpy=np.__version__, scipy=scipy.__version__,
                      source_sha256={p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in paths})
    (OUT/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
    lines = ['# Recovering more of a lapped part', '',
        'Research only. Production Current/Hybrid algorithms and browser UI are unchanged. '
        'The objective is useful physical-aperture coverage, particularly the rolled edge, with errors '
        'assessed against a practical tens-of-nanometers target. Earlier experiments emphasized much '
        'smaller errors and discarded substantial usable area.', '',
        '## Experiment', '',
        '1,824 evaluations across 228 synthetic scenes: 210 reused scenes plus 18 new holdouts specified '
        'after the six-case pilot, without changing the six admission rules. Reused scenes are development '
        'evidence. The pilot (48 evaluations) and a subsequent failed rim-control experiment (18 evaluations '
        'on three known failures) are archived separately and excluded from the main count.', '',
        'Three quadratic local fringe fits use Gaussian windows of (across, along) = '
        '(0.35, 0.175), (0.5, 0.25), and (0.5, 0.5) fringe periods. Each is compared with a window '
        '1.3 times wider. Require amplitude >10 gray levels, condition <10,000, two agreeing fit '
        'candidates, connectivity to original Hybrid anchors, and the existing 0.05-rad anchor agreement '
        'check. Remove the earlier one-period growth limit and one-pixel erosion. Existing Hybrid '
        'measurements are preserved exactly. These are fits to recorded image intensities, not painted '
        'or interpolated surface patches.', '',
        '**Supported** fits use the existing analysis support mask. **Selected** fits can recover '
        'pixels excluded upstream, using the user-selected aperture (or existing support if no selection '
        'exists). The known physical outline and true surface enter scoring only. Some selections are '
        'deliberately oversized. All variants preserve explicit aperture exclusions for new pixels.', '',
        'The admission score is wavelength/(4π) times the larger of cross-window phase disagreement '
        'and normalized intensity-fit residual. Thresholds of 5, 10, and 20 nm are experimental '
        '**scores, not calibrated error bounds**. Agreement among correlated fits can hide common bias. '
        'The data below explicitly tests and disproves interpreting those thresholds as guaranteed errors.', '',
        '## Scoring', '',
        '- Area coverage counts included pixels inside the true physical aperture, divided by its area.',
        '- Edge coverage uses a boundary band with width 10% of the equivalent aperture radius '
        '(minimum two pixels), including hole boundaries. A high area percentage can conceal a missing edge.',
        '- Added-area error removes only a reference plane fitted on original Hybrid anchors. '
        'Newly admitted pixels cannot improve their score by changing that reference plane.',
        '- Full-aperture PV discrepancy compares recovered PV with true PV after a plane fit across '
        'the entire physical aperture. This is distinct from the also-archived included-area PV error. '
        'Both are synthetic diagnostics, not certified instrument uncertainty.', '',
        '## Results', '',
        'Each row averages coverage per scene. Worst added error is the maximum over all newly included '
        'pixels and scenes. “>20” counts scenes with added-area error exceeding 20 nm; it does not certify '
        'the remaining scene’s original measurements or total physical uncertainty.', '']
    for suite, count in SUITES.items():
        lines += [f'### {suite}: {count} scenes', '',
                  '| Method / score | Area % | Edge % | Worst added error nm | >20 nm scenes | Mean full-aperture PV discrepancy nm |',
                  '|---|---:|---:|---:|---:|---:|']
        for method in METHODS:
            group = [r for r in rows if r['suite'] == suite and r['method'] == method]
            errors = [r['added_anchor_max_nm'] for r in group if r['added_anchor_max_nm'] is not None]
            worst = f'{max(errors):.2f}' if errors else '—'
            lines.append(f'| {method} | {np.mean([r["physical_coverage_pct"] for r in group]):.1f} | '
                         f'{np.mean([r["edge_coverage_pct"] for r in group]):.1f} | {worst} | '
                         f'{sum(e > 20 for e in errors)} | {np.mean([r["full_aperture_pv_error_nm"] for r in group]):.2f} |')
        lines.append('')
    candidates = [r for r in rows if r['method'] == 'selected-5nm']
    lines += ['![Coverage and added-error distributions](tradeoffs.png)', '',
              '![Examples, including a failure](examples.png)', '', '## Findings', '']
    for name in ('narrow-roll-17.4', 'noisy-hole-flat', 'precise-weak-rim', 'challenge-blur-56', 'holdout-scratch-24'):
        r = next(r for r in candidates if r['case'] == name)
        b = next(r for r in rows if r['case'] == name and r['method'] == 'hybrid')
        lines.append(f'- `{name}`: area {b["physical_coverage_pct"]:.1f} → {r["physical_coverage_pct"]:.1f}%, '
                     f'edge {b["edge_coverage_pct"]:.1f} → {r["edge_coverage_pct"]:.1f}%, '
                     f'added-area maximum error {r["added_anchor_max_nm"]:.2f} nm. '
                     f'Full-aperture PV discrepancy {r["full_aperture_pv_error_nm"]:.2f} nm.')
    lines += ['', f'The selected/5-score candidate exceeds 20 nm added-area error on '
              f'{sum((r["added_anchor_max_nm"] or 0)>20 for r in candidates)} of 228 scenes. '
              'The scratch case already has an approximately 169 nm baseline maximum error: preserving '
              'those anchors preserves a bad fringe-order solution. It must be identified as an invalid '
              'measurement, not rescued by reporting a good average.', '',
              'Blur failures remain at roughly 25–30 nm even after excluding the outermost three pixels. '
              'The archived rim pilot rejects the hypothesis that a tiny border exclusion solves them. '
              'The 10/20-score variants sometimes admit much larger errors without a useful coverage gain. '
              'An imprecise user aperture can either restrict recovery or contaminate fits with background; '
              'the new holdouts deliberately exercise this. No single variant wins every scene.', '',
              f'Across all 1,824 records: removed original pixels = {sum(r["removed_pixels"] for r in rows)}; '
              f'pixels outside the physical aperture = {sum(r["outside_physical_pixels"] for r in rows)}; '
              f'new pixels in synthetic fringe-free defects = {sum(r["added_cap_pixels"] for r in rows)}. '
              'These are counts summed across repeated methods, not distinct physical pixels. '
              'Both 5-score variants admit zero background pixels and zero new defect pixels across all '
              '228 scenes; the unwanted admissions occur with the looser 10/20 scores. '
              'Some original baseline pixels already lie in defects; preserving them does not validate them.', '',
              'The new holdouts also contain two defect cases with recovered PV above 300 nm on a true '
              'flat, despite small errors in the added area. Those large errors are inherited from the '
              'baseline. Likewise, some localized features remain mostly excluded: for example '
              '`challenge-bump-11` still misses about 53 nm of full-aperture PV. '
              'The coverage gain and small added-area errors therefore cannot be reported as whole-part '
              'measurement accuracy.', '',
              '## Decision', '',
              'Pursue the stricter coverage-first local-fit candidate: large practical coverage gains are '
              'possible without demanding sub-nanometer error everywhere. Keep it experimental until '
              'blur, bad-anchor/fringe-order, and aperture-quality checks can distinguish the failures '
              'from useful results. Do not label its score as a ±5 nm or ±20 nm uncertainty. '
              'Expose edge coverage and provenance of added pixels alongside the measured area; do not '
              'present missing edges as measured whole-part flatness. Real interferograms remain essential '
              'to test whether these synthetic gains transfer to the user’s setup.', '',
              '## Reproduce', '', '```sh',
              'OPENBLAS_NUM_THREADS=1 MPLCONFIGDIR=/tmp/loupe-mpl .venv/bin/python scripts/experiment-fringe-coverage-budget.py --suite matrix --output /tmp/loupe-budget-matrix.json',
              '# Repeat for stress, challenge, holdout, confirmation, blind, fresh, budget-holdout.',
              'OPENBLAS_NUM_THREADS=1 MPLCONFIGDIR=/tmp/loupe-mpl .venv/bin/python scripts/report-fringe-coverage-budget.py',
              'OPENBLAS_NUM_THREADS=1 MPLCONFIGDIR=/tmp/loupe-mpl .venv/bin/python scripts/plot-fringe-coverage-budget.py',
              '```', '',
              'The reporter also archives `/tmp/loupe-budget-pilot.json` and `...-rim-pilot.json`. '
              'Run the six pilot cases listed in `pilot.json` with `--cases`; run the three blur '
              'cases listed in `rim-pilot.json` with `--suite challenge --rim-audit`. '
              'The baseline cache is optional and keyed by scene inputs and baseline source hashes. '
              'All sources, raw records and dependency versions are recorded for audit.', '']
    (OUT/'README.md').write_text('\n'.join(lines))
    fig, axes = plt.subplots(1, 3, figsize=(14, 5), layout='constrained')
    colors = ['#728294', '#916eb8', '#009c95', '#49a6dc', '#de8f22', '#cc5363', '#9c754d', '#537f48']
    for i, (method, color) in enumerate(zip(METHODS, colors)):
        group = [r for r in rows if r['method'] == method]
        for ax, key in zip(axes[:2], ['physical_coverage_pct', 'edge_coverage_pct']):
            vals = sorted(r[key] for r in group)
            ax.plot(vals, np.arange(1, len(vals)+1)/len(vals)*100, label=method, color=color)
        errors = sorted(r['added_anchor_max_nm'] for r in group if r['added_anchor_max_nm'] is not None)
        if errors: axes[2].plot(np.maximum(errors, 1e-4), np.arange(1, len(errors)+1)/len(errors)*100, color=color)
    for ax, title in zip(axes, ['Physical area measured (%)', 'Boundary band measured (%)', 'Maximum added-area error (nm)']):
        ax.set_xlabel(title); ax.set_ylabel('Scenes at or below value (%)'); ax.grid(alpha=.2)
    axes[0].legend(fontsize=8); axes[2].set_xscale('log'); axes[2].axvline(20, color='black', linestyle='--', linewidth=1)
    fig.suptitle('Coverage-first recovery: 228 synthetic scenes\nThe acceptance score is not an error bound; dashed line = 20 nm actual added error')
    fig.savefig(OUT/'tradeoffs.png', dpi=140); plt.close(fig)
    print(f'{len(rows)} records archived at {OUT}')


if __name__ == '__main__': main()
