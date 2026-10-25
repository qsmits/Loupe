"""Collect the reproducible hybrid sweep; no ground truth enters its gates."""
from pathlib import Path
import argparse
import csv
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--input-dir',type=Path,default=Path('/tmp'))
p.add_argument('--output',type=Path,default=Path('experiments/fringe-hybrid'))
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
rows=[];unique={}
for variant in ('','quadratic-'):
    for suite in ('matrix','stress','challenge'):
        name=f'loupe-hybrid-{variant}{suite}'
        for row in json.loads((a.input_dir/(name+'.json')).read_text()):
            rows.append(dict(run=name,suite=suite,**row))
            unique[suite,row['case'],row['method']]=row
fields=list(dict.fromkeys(k for row in rows for k in row))
with (a.output/'results.csv').open('w') as out:
    writer=csv.DictWriter(out,fields);writer.writeheader();writer.writerows(rows)
methods=['bounded','hybrid:.4:.4:1','hybrid-strict:.4:.4:1','hybrid:.5:.3:2']
labels=['Current','Linear hybrid','Stricter linear','Quadratic hybrid']
lines=['# Hybrid fringe-edge experiment — 2026-10-25','',
'Combining the methods is substantially safer than replacing the existing estimator everywhere. The quadratic hybrid is the strongest overall candidate in this sweep, but remains experimental: some sharp roll-off cases still get worse, and fallback preserves pre-existing errors around scratches. These checks are empirical admission rules, not calibrated uncertainty bounds. The application numerical default is unchanged.','',
'## Method','',
'The experiment runs the current bounded method first. A local harmonic fit then uses only in-aperture samples, refines the carrier twice, and restores the original carrier reference before mixing phases. A second fit with a 30% wider window checks stability. Both fits must have condition number below 1000, amplitude above 15 intensity units, residual below 4% of amplitude, and wrapped-phase disagreement below 0.025 rad (0.010 for the stricter variant). These intensity thresholds assume the existing 0–255 image convention. The same upstream illumination, modulation and foldover gates remain in place.','',
'Accepted regions are eroded one pixel, must connect to at least 25 existing valid measurements, and must agree with those measurements at their 90th-percentile phase difference within 0.05 rad (0.02 for the stricter variant). Each component acquires its integer fringe order from this overlap. New pixels cannot lie more than one fringe period from the existing valid mask. Inside the shared area a short distance taper blends the estimates; elsewhere failed candidates fall back to the exact baseline phase. Previously excluded pixels remain excluded unless the candidate passes. All baseline pixels are retained. Neither analytic height, the known carrier nor the synthetic physical mask is used for admission.','',
'Linear: window sigma 0.4 fringe period across / 0.2 along, guard factor 0.4. Quadratic: 0.5 / 0.25, guard factor 0.3. Full-frame square guards remain unchanged. Gates were fixed for the first hybrid sweep; the stricter and quadratic variants are explicit comparisons on the same fixtures, not independent validation after selection.','',
'## Same 126 scenes','',
f'{len(rows)} recorded evaluations, including repeated baselines and the earlier unrestricted refined fit on the 36-case matrix. All succeeded. The 36 original cases, 60 stress cases and 30 challenge cases are identical to the previous local-fit study. Error is measured against analytic height after removing only piston and tilt on each evaluated mask. Greater coverage changes the evaluated area; `common_rms_error_nm` and added-pixel metrics are included in the CSV.','',
'| Suite | Method | Mean coverage | Mean RMS error (nm) | Lower RMS than current | Worst increase in max error (nm) |',
'|---|---|---:|---:|---:|---:|']
for suite in ('matrix','stress','challenge'):
    for method,label in zip(methods,labels):
        rr=[r for (s,c,m),r in unique.items() if s==suite and m==method]
        base=[unique[suite,r['case'],'bounded'] for r in rr]
        lines.append(f"| {suite} | {label} | {np.mean([r['coverage_pct'] for r in rr]):.2f}% | {np.mean([r['rms_error_nm'] for r in rr]):.3f} | {sum(r['rms_error_nm']<b['rms_error_nm'] for r,b in zip(rr,base))}/{len(rr)} | {max(r['max_error_nm']-b['max_error_nm'] for r,b in zip(rr,base)):.3f} |")
lines+=['','![Coverage and error changes](tradeoffs.png)','','## Important cases','',
'| Scene | Method | Coverage | RMS error (nm) | Max error (nm) |','|---|---|---:|---:|---:|']
for suite,case in [('matrix','noisy-hole-flat'),('stress','stress-flat-17-7.9'),('matrix','narrow-roll-10.7'),('challenge','challenge-hole-11'),('challenge','challenge-scratch-119')]:
    for method in ('bounded','hybrid:.4:.4:1','hybrid:.5:.3:2'):
        r=unique[suite,case,method]
        lines.append(f"| {case} | {labels[methods.index(method)]} | {r['coverage_pct']:.2f}% | {r['rms_error_nm']:.3f} | {r['max_error_nm']:.3f} |")
rr=[r for (s,c,m),r in unique.items() if m=='hybrid:.5:.3:2']
assert len(rr)==126 and all(r['removed_pixels']==0 and r['outside_physical_pixels']==0 for r in rr)
base=[unique[next(s for s,c,m in unique if c==r['case']),r['case'],'bounded'] for r in rr]
lines+=['',f"The quadratic hybrid increases coverage in {sum(r['added_pixels']>0 for r in rr)}/126 scenes and lowers RMS in {sum(r['rms_error_nm']<b['rms_error_nm'] for r,b in zip(rr,base))}/126. It removes zero baseline pixels and admits zero pixels outside the known synthetic physical aperture. These are results of this suite, not guarantees for photographs.",'',
'The stricter gate is not uniformly better: it can retain more of the biased baseline and introduce transitions between estimators. The quadratic variant reduces broad-curvature bias, but cannot recover genuinely unresolved narrow features reliably. Scratch fallback is particularly important: lower whole-mask RMS can partly result from adding cleaner pixels while retaining the original bad scratch values. It is not evidence that the scratch became measurable.','',
'## Reproduce','',
'```sh',
'export OPENBLAS_NUM_THREADS=1 MPLCONFIGDIR=/tmp/loupe-mpl',
'for suite in matrix stress challenge; do',
'  flag=""; [ "$suite" = matrix ] || flag="--$suite"',
'  .venv/bin/python scripts/experiment-fringe-local-fit.py $flag \\\n    --methods bounded hybrid:.4:.4:1 hybrid-strict:.4:.4:1 \\\n    --output "/tmp/loupe-hybrid-$suite.json"',
'  .venv/bin/python scripts/experiment-fringe-local-fit.py $flag \\\n    --methods bounded hybrid:.5:.3:2 \\\n    --output "/tmp/loupe-hybrid-quadratic-$suite.json"',
'done',
'.venv/bin/python scripts/report-fringe-hybrid.py',
'```','',
'The recorded matrix also includes `refined:.4:.4:1` as an unrestricted comparator. Source implementation and focused tests are in `scripts/experiment-fringe-local-fit.py` and `tests/test_fringe_local_fit_experiment.py`. The quadratic candidate is available under Analysis method → Hybrid quadratic fit (experimental), in both engines. Current method remains the default. The integrated version tiles fits with full kernel halos, limits hybrid inputs to 1024 pixels on the longest side, and records method and fit/fallback counts in results. Browser analysis resizes larger images; use the same resolution and settings for comparisons.','',
'Scientific background remains the windowed Fourier literature documented in the [preceding study](../fringe-local-fit/README.md). This is our own harmonic-regression and fallback experiment, not a reproduction of those algorithms.']
(a.output/'README.md').write_text('\n'.join(lines)+'\n')
fig,axes=plt.subplots(1,2,figsize=(11,4),layout='constrained')
for method,label,color in [('hybrid:.4:.4:1','Linear hybrid','#3182bd'),('hybrid:.5:.3:2','Quadratic hybrid','#d95f02')]:
    pairs=[(r,unique[s,c,'bounded']) for (s,c,m),r in unique.items() if m==method]
    x=[r['coverage_pct']-b['coverage_pct'] for r,b in pairs]
    axes[0].scatter(x,[r['rms_error_nm']-b['rms_error_nm'] for r,b in pairs],s=20,alpha=.6,label=label,c=color)
    axes[1].scatter(x,[r['max_error_nm']-b['max_error_nm'] for r,b in pairs],s=20,alpha=.6,label=label,c=color)
for ax,title in zip(axes,['Change in RMS error (nm)','Change in maximum error (nm)']):
    ax.axhline(0,color='#777',lw=.7);ax.set_xlabel('Additional coverage (percentage points)');ax.set_ylabel(title);ax.grid(alpha=.15)
axes[0].legend();fig.suptitle('Same 126 scenes · below zero = lower error than current method')
fig.savefig(a.output/'tradeoffs.png',dpi=170);plt.close(fig)
print(a.output/'README.md')
