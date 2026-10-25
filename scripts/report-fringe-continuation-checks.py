"""Publish the complete follow-up study, including conservative rejections."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import platform
import subprocess

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import scipy

SUITES = {'matrix': 36, 'stress': 60, 'challenge': 30, 'holdout': 24,
          'confirmation': 12, 'blind': 12, 'fresh': 36}
LABELS = {'hybrid': 'Hybrid', 'bank-model-check': 'Selective local fits',
          'padded-continuation': 'Padded continuation alone', 'padded-composite': 'Previous composite',
          'cv-rim': 'Withheld rim', 'cv-strips': 'Withheld directional strips',
          'structured': 'Structured residual', 'cv-rim-structured': 'Rim + residual',
          'cv-strips-structured': 'Strips + residual'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', type=Path, default=Path('/tmp'))
    parser.add_argument('--output', type=Path, default=Path('experiments/fringe-continuation-checks'))
    args = parser.parse_args()
    runs = {}
    for suite, expected in SUITES.items():
        data = json.loads((args.input_dir/f'loupe-checks-{suite}.json').read_text())
        if len({r['case'] for r in data}) != expected or len(data) != expected*len(LABELS):
            raise ValueError(f'Incomplete suite: {suite}')
        runs[suite] = data
    rows = [dict(suite=suite, **r) for suite, data in runs.items() for r in data]
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'results.json').write_text(json.dumps(rows, indent=2)+'\n')
    with (args.output/'results.csv').open('w') as out:
        writer = csv.DictWriter(out, list(rows[0]))
        writer.writeheader()
        writer.writerows({k: json.dumps(v, sort_keys=True) if isinstance(v, dict) else v for k, v in r.items()} for r in rows)
    root = Path(__file__).resolve().parents[1]
    paths = ['scripts/fringe_continuation_checks.py', 'scripts/experiment-fringe-continuation-checks.py',
             'scripts/fringe_edge_recovery.py', 'scripts/experiment-fringe-edge-recovery.py',
             'backend/vision/fringe.py', 'backend/vision/fringe_hybrid.py']
    provenance = dict(base_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
                      python=platform.python_version(), numpy=np.__version__, scipy=scipy.__version__,
                      source_sha256={p: hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths})
    (args.output/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
    lines = ['# Testing continuation admission checks', '',
             '## Scope', '',
             'Research only: the application’s Current and Hybrid algorithms are unchanged. This follows the '
             '[edge-recovery study](../fringe-edge-recovery/README.md), whose padded continuation could pass '
             'image-error checks while adding biased phase on a quartic surface. The new checks restrict '
             'continuation additions; all existing Hybrid and accepted selective-local-fit values are preserved.', '',
             f'{len(rows)} suite evaluations across 210 distinct synthetic scenes. The original 174 scenes are '
             'development/reused evidence. All five new variants and their thresholds were specified before '
             'running 36 fresh scenes; none were adjusted against that set. Pilot reruns are omitted from '
             'this count. Full numerical records, dependency versions and source hashes accompany this report.', '',
             '## Admission rules', '',
             '- **Withheld rim:** fit quadratic phase on original Hybrid anchors more than one fringe period '
             'from the anchor boundary. Predict the held-out outer rim and require its 95th-percentile absolute '
             'phase discrepancy to be ≤0.01 rad. Require at least 100 training and 25 validation pixels and a '
             'full-rank fit. Failure disables continuation, retaining the selective local bank.',
             '- **Withheld directional strips:** repeat with the left/right/top/bottom 20% coordinate strips '
             'held out separately. All four predictions must satisfy the same 0.01-rad criterion.',
             '- **Structured residual:** fit the same quadratic phase/illumination continuation model. In '
             'Gaussian windows of sigma half a fringe period, regress the remaining image error on offset, '
             'carrier amplitude and phase derivative. Offset/amplitude are nuisance terms. Reject phase-like '
             'bias exceeding both 0.01 rad and three estimated standard errors. The covariance uses squared '
             'discrete Gaussian weights; noise comes from a robust diagonal high-pass estimate. This is an '
             'iid-noise approximation, not a calibrated uncertainty guarantee.',
             '- **Combined variants:** require both the global rim/strip check and the local residual check. '
             'Added continuation pixels must remain connected through accepted continuation pixels to original '
             'Hybrid anchors. Newly added local-fit pixels cannot start growth.', '',
             'The previous global and local image-model gates, original-anchor checks and aperture constraints '
             'remain in force. The checks use no analytic truth or physical-outline oracle. Withheld phase is '
             'still a reconstructed estimate from the same photograph, so validation agreement is correlated evidence.', '',
             '## Results', '',
             'Coverage is relative to the known physical aperture. RMS is averaged per scene. Worst Δ max is '
             'the largest increase in maximum error relative to Hybrid; it is not an instrument accuracy bound. '
             'A plane is removed for scoring, never curvature or scale. Added-area error uses a reference plane '
             'fitted on original Hybrid pixels only.', '']
    for suite, data in runs.items():
        base = {r['case']: r for r in data if r['method'] == 'hybrid'}
        previous = {r['case']: r for r in data if r['method'] == 'padded-composite'}
        lines += [f'### {suite} ({SUITES[suite]} scenes)', '',
                  '| Method | Mean coverage % | Mean RMS nm | Worst Δ max nm | Largest added-area error nm |',
                  '|---|---:|---:|---:|---:|']
        for method, label in LABELS.items():
            group = [r for r in data if r['method'] == method]
            added = [r['added_anchor_max_nm'] for r in group if r['added_anchor_max_nm'] is not None]
            worst = max(r['max_error_nm']-base[r['case']]['max_error_nm'] for r in group)
            extra = f'{max(added):.3f}' if added else '—'
            lines.append(f'| {label} | {np.mean([r["coverage_pct"] for r in group]):.2f} | '
                         f'{np.mean([r["rms_error_nm"] for r in group]):.3f} | {worst:.3f} | {extra} |')
        lines.append('')
    lines += ['![Coverage retained and maximum-error change](tradeoffs.png)', '',
              '![Representative image-level results](examples.png)', '',
              '## Findings and decision', '',
              'The local structured-residual check is the more useful next candidate: it can reject a biased '
              'portion of continuation while retaining other additions. Global cross-validation is more '
              'conservative and rejects some useful additions wholesale. Combining both inherits that coverage '
              'cost; the tables retain all alternatives rather than choosing by average RMS alone.', '',
              '- On the prior quartic failure, the previous composite reaches 93.95% coverage with 1.660 nm '
              'maximum error. The residual check retains about 91.7% and reduces maximum error to about '
              '0.617 nm. Rim validation falls back to the local bank (90.51%, 0.613 nm).',
              '- The fresh localized-ridge case (`fresh-ridge-1`) improves from approximately 1.286 nm '
              'maximum error to 1.021 nm with the residual check, while retaining about 86% coverage.',
              '- The clean noisy flat with a hole retains 95.4% coverage under the rim or residual checks. '
              'Directional-strip validation drops it to 89.9%, showing that extra checks can be unnecessarily restrictive.',
              '- Fresh distorted-carrier cases still regress. The retained local bank already contains the '
              'added-area error (up to about 2.8 nm against the original-anchor plane); a continuation-only gate '
              'cannot fix it. Removing some continuation also changes the fitted scoring plane, so the full-map '
              'maximum can rise slightly despite retaining exactly the same problematic local-bank heights.', '',
              'Keep these as research prototypes. The new checks address the identified continuation failure '
              'and improve fresh ridge cases, but the study does not establish a universal accuracy bound '
              'or justify complete aperture filling. No new application mode or default change is made.', '',
              '## Limitations and interpretation', '',
              'Neither a passing cross-validation check nor a small residual proves true surface height. '
              'Camera distortion, correlated noise, fringe-order mistakes and common model bias can survive. '
              'These rules preserve existing local-fit and Hybrid errors by design. Adding clean pixels can '
              'lower full-map RMS while leaving a serious defect unchanged. Compare maximum and added-area '
              'errors alongside coverage.', '',
              'The fresh suite varies frame dimensions (including odd rectangular sizes), carrier direction '
              'and pitch, noise, quartic surfaces, localized bumps/ridges, abrupt roll-off, holes, contrast '
              'falloff, illumination, gamma response, distorted carriers and defects. The distorted-carrier '
              'cases score against part height excluding the optical artifact; the checks cannot establish '
              'lens calibration. Real-part validation remains separate.', '',
              '## Verification', '',
              '44 targeted tests passed across the new checks, edge-recovery prototypes, production Hybrid '
              'and earlier local-fit experiments. Tests cover true quadratic prediction, withheld-region '
              'failure, missing support, coherent phase bias versus offset/amplitude changes, white noise, '
              'unselected-pixel independence, connected admission, exact original-value preservation, '
              'truth-independent reconstruction and cache invalidation. Existing dependency warnings remain.', '',
              '## Reproduce', '', '```sh',
              'export OPENBLAS_NUM_THREADS=1 MPLCONFIGDIR=/tmp/loupe-mpl',
              'for suite in matrix stress challenge holdout confirmation blind fresh; do',
              '  .venv/bin/python scripts/experiment-fringe-continuation-checks.py --suite "$suite" --output "/tmp/loupe-checks-$suite.json"',
              'done', '.venv/bin/python scripts/report-fringe-continuation-checks.py',
              '.venv/bin/python scripts/plot-fringe-continuation-checks.py', '```', '',
              'Baseline arrays are cached under `/tmp/loupe-continuation-cache`, keyed by the image, custom '
              'mask and baseline implementation hashes. Analytic truth is not cached; every score is '
              'recomputed. The initial automatic-mask cache bug was repaired without changing an admission '
              'rule, and that suite was rerun. Prior study files are preserved.', '',
              '## Sources', '',
              'These are new engineering hypotheses building on the [previous study’s references]'
              '(../fringe-edge-recovery/README.md#scientific-guidance), particularly the distinction between '
              'local phase estimation and modeled fringe continuation. The strip checks and residual '
              'admission rules are our own prototypes, not reproductions of a published algorithm.', '']
    (args.output/'README.md').write_text('\n'.join(lines))
    fig, axes = plt.subplots(1, 3, figsize=(14, 4), layout='constrained')
    for ax, method in zip(axes, ('cv-rim', 'structured', 'cv-rim-structured')):
        for suite, color in [('matrix', '#3b82f6'), ('stress', '#10b981'), ('challenge', '#f59e0b'),
                             ('holdout', '#a855f7'), ('confirmation', '#78716c'), ('blind', '#ec4899'), ('fresh', '#dc2626')]:
            data = runs[suite]
            base = {r['case']: r for r in data if r['method'] == 'hybrid'}
            group = [r for r in data if r['method'] == method]
            ax.scatter([r['coverage_pct']-base[r['case']]['coverage_pct'] for r in group],
                       [r['max_error_nm']-base[r['case']]['max_error_nm'] for r in group],
                       label=suite, color=color, s=16, alpha=.7)
        ax.axhline(0, color='#777', lw=.7)
        ax.set_title(LABELS[method]); ax.grid(alpha=.2)
        ax.set_xlabel('Coverage gain over Hybrid (percentage points)')
        ax.set_ylabel('Maximum-error change (nm)')
    axes[0].legend(fontsize=8)
    fig.savefig(args.output/'tradeoffs.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'Published {len(rows)} evaluations to {args.output}')


if __name__ == '__main__':
    main()
