"""Publish all edge-recovery trials, including regressions and negative controls."""
from pathlib import Path
import argparse,csv,json,hashlib,platform,subprocess
import scipy
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

p=argparse.ArgumentParser();p.add_argument('--input-dir',type=Path,default=Path('/tmp'));p.add_argument('--output',type=Path,default=Path('experiments/fringe-edge-recovery'));args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
names=['pilot','matrix','stress','challenge','holdout','followup','model-pilot',
       'second-matrix','second-stress','second-challenge','second-holdout',
       'final-matrix','final-holdout','confirmation',
       'padding-matrix','padding-holdout','padding-confirmation',
       *['padded-final-'+suite for suite in ('matrix','stress','challenge','holdout','confirmation','blind')]]
root=Path(__file__).resolve().parents[1]
source_paths=['scripts/fringe_edge_recovery.py','scripts/experiment-fringe-edge-recovery.py',
              'scripts/experiment-fringe-local-fit.py','scripts/validate-fringe-boundaries.py',
              'backend/vision/fringe.py','backend/vision/fringe_hybrid.py']
provenance=dict(base_commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
                python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__,
                final_source_sha256={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in source_paths})
(args.output/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
rows=[];runs={}
for name in names:
    path=args.input_dir/f'loupe-recovery-{name}.json'
    if not path.exists():continue
    data=json.loads(path.read_text())
    for row in data:
        if 'gates' in row:row['reference_window_gates']=row.pop('gates')
    runs[name]=data
    rows.extend(dict(run=name,**r) for r in data)
(args.output/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
fields=list(dict.fromkeys(k for r in rows for k in r))
with (args.output/'results.csv').open('w') as out:
    writer=csv.DictWriter(out,fields);writer.writeheader()
    writer.writerows({k:json.dumps(v,sort_keys=True) if isinstance(v,dict) else v for k,v in r.items()} for r in rows)
methods=['current','hybrid','guard-free','bank-union','bank-consensus','bank-strict','bank-grow','bank-no-erosion','bank-model-check','continuation','continuation-validated','checked-composite','bank-noise-aware','bank-conditioned','padded-continuation','padded-composite']
labels={'current':'Current','hybrid':'Hybrid','guard-free':'Guard removal','bank-union':'Window union','bank-consensus':'Window consensus','bank-strict':'Strict consensus','bank-grow':'Outward growth','bank-no-erosion':'No one-pixel erosion','bank-model-check':'Linear/quadratic check','continuation':'Fringe continuation','continuation-validated':'Globally checked continuation','checked-composite':'Checked composite','bank-noise-aware':'Noise-aware residual','bank-conditioned':'Relaxed conditioning','padded-continuation':'Padded, checked continuation','padded-composite':'Padded composite'}
# Prefer later identical-baseline runs; do not combine counts from disjoint suites.
def suite_rows(suite):
    selected={}
    for key in [suite,'second-'+suite,'final-'+suite,'padding-'+suite,'padded-final-'+suite]:
        for r in runs.get(key,[]):
            if 'method' in r:selected[r['case'],r['method']]=r
    return selected
lines=['# Further fringe-edge recovery experiments','',
'## Scope and decision','',
'These are research implementations, not new production methods. The application’s Current and experimental Hybrid estimators are unchanged. The comparison-view work in the working tree is separate. Greater synthetic coverage does not establish accuracy on real parts; this study retains failures and does not claim full coverage.','',
f'{len(rows)} recorded evaluations (including repeated baselines and pilot reruns); {len({r["case"] for r in rows})} distinct scenes. Errors, if any, remain in the raw records. Final source hashes, dependency versions and the base Git revision are in `provenance.json`. The original 126 scenes were reused, followed by 24 asymmetric exploratory holdouts and 12 final confirmation scenes. The follow-up model check was designed after inspecting the exploratory holdouts, so those 24 are not an independent final test. The 12 confirmation scenes were specified and run after freezing the combined rule; their outcomes were not used to revise its thresholds. A separate padded variant was then developed after finding a frame-edge failure in the original matrix. Its checks reuse all suites, including the confirmation scenes; those checks were therefore exploratory for the padded variant. A further 12 scenes were then specified and run with the padded algorithm frozen: odd rectangular frames, quartic/two-bump surfaces, contrast falloff, gamma response, warped carrier and paired defects. No rule was revised against this final blind suite.','',
'## What was implemented','',
'- **Rejection accounting:** separate upstream mask losses from downstream rejections, and report exclusive first-failing local-fit gates: conditioning, contrast, image residual, window disagreement. The `reference_window_gates` counts describe the common 0.025-rad reference check before each variant’s extra rules, not all final admission failures. Upstream/downstream losses refer to the original Hybrid aperture. Physical-outline counts are evaluation-only; estimators do not receive analytic truth.','- **Adaptive window bank:** quadratic local harmonic fits at across/along sigma fractions (0.35, 0.175), (0.5, 0.25), and (0.5, 0.5) of fringe period, each checked against a 30% wider window. Same amplitude >15, condition <1000 and residual <4% amplitude checks as Hybrid. Fit windows exclude unselected image samples.','- **Interior anchoring:** unwrap each candidate, resolve its integer fringe order from at least 25 original Hybrid pixels with 90th-percentile phase agreement within 0.05 rad, remove failed bridges, and grow only through connected accepted fits. Existing Hybrid phase values and pixels are preserved exactly. New values never become anchors for later fits.','- **Consensus and growth controls:** compare union, two-window consensus, 0.01-rad strict agreement, removal of the one-period reach limit, and removal of the one-pixel reliability erosion. These are explicit alternatives, not silently loosened defaults.','- **Model diversity:** require the local quadratic phase to agree with a linear-amplitude/background fit within 0.01 rad, in addition to strict window consensus. This rejects some real curvature along with biased sharp-rim estimates.','- **Fringe continuation:** fit quadratic phase and illumination plus sinusoidal amplitude on the reliable interior, synthesize only outside the allowed aperture, then re-filter. Every real in-aperture input pixel remains unchanged. Admit only real selected pixels whose period-sized neighborhood has image-model RMS below 4% amplitude and which pass original-anchor checks. Synthetic pixels are never counted as measurements.','- **Globally checked continuation:** additionally require whole-aperture image prediction RMS ≤ max(1% amplitude, 1.5 × anchor-area image RMS). The checked composite takes model-checked local additions first, then accepted continuation only where still missing.','- **Frame padding:** a separate variant extends the same prediction two fringe periods beyond every photograph boundary before filtering, crops back, and restores the carrier-coordinate origin. It uses the same global/local admission gates. The padded composite takes model-checked local additions first, then padded continuation; the failed unpadded version remains in the results.', '- **Negative/control ideas:** noise-aware residual floor (1.5 × median interior fit residual) and conditioning limit 10000 instead of 1000 were also tested.','',
'## Results by suite','',
'All heights and errors below are nm. Coverage is relative to the known physical aperture. Mean RMS is computed per scene then averaged. Worst Δ max is the largest increase in a scene’s maximum error relative to Hybrid. Added-area max uses a plane fitted on the original Hybrid domain only; this avoids fitting away new edge errors, but is itself affected by severe pre-existing unwrap errors.','']
for suite in ['matrix','stress','challenge','holdout','confirmation','blind']:
    selected=suite_rows(suite);baseline={c:r for (c,m),r in selected.items() if m=='hybrid'}
    lines += [f'### {suite} ({len(baseline)} scenes)','', '| Method | N | Mean coverage % | Mean RMS nm | Worst Δ max nm | Worst added-area max nm |','|---|---:|---:|---:|---:|---:|']
    for method in methods:
        data=[r for (c,m),r in selected.items() if m==method]
        if not data:continue
        added=[r.get('added_anchor_max_nm') for r in data if r.get('added_anchor_max_nm') is not None]
        lines.append(f'| {labels[method]} | {len(data)} | {np.mean([r["coverage_pct"] for r in data]):.2f} | {np.mean([r["rms_error_nm"] for r in data]):.3f} | {max(r["max_error_nm"]-baseline[r["case"]]["max_error_nm"] for r in data):.3f} | {max(added):.3f} |' if added else f'| {labels[method]} | {len(data)} | {np.mean([r["coverage_pct"] for r in data]):.2f} | {np.mean([r["rms_error_nm"] for r in data]):.3f} | {max(r["max_error_nm"]-baseline[r["case"]]["max_error_nm"] for r in data):.3f} | — |')
    lines.append('')
lines += ['![Coverage gains versus worst-error changes](tradeoffs.png)','',
'## Interpretation','',
'The unpadded composite failed on a noisy flat that fills the photograph: coverage rose from 75.0% to 98.2%, but maximum error rose from 0.945 to 8.224 nm. Global image-model agreement did not catch a filtering error at the frame boundary. Explicit two-period padding removes that particular failure; the table and example figure show its performance without discarding the failed run.', '',
'![Representative recovery and failure cases](examples.png)', '',
'The fixed guard is a substantial source of lost area on clean, well-resolved surfaces. Removing it indiscriminately is unsafe: several windows can agree on the same biased estimate near abrupt roll-off. Outward growth increases reach but cannot create information. Relaxed conditioning and a noise floor increase coverage in some scenes, but can admit weak-rim or defect-related errors. A simple linear/quadratic check is more selective: it gives up some curvature coverage to avoid many of the sharp-rim regressions. Continuation is strongest on surfaces that its whole-image model actually explains; local image agreement alone is insufficient.','',
'The final blind suite exposes a remaining continuation bias: `blind-quartic-7` gains coverage from 73.77% to 93.95%, but maximum error increases from 0.615 to 1.660 nm. The selective local bank alone reaches 90.51% with maximum error 0.613 nm. Continuation passes both image-model checks in this case; a good average intensity fit is not a sufficient guarantee of accurate phase at every newly admitted pixel. The frozen rule is retained, and this is a reason not to promote the combined method yet.', '',
'The checked composite preserves every original Hybrid value. Consequently it also preserves existing serious failures, including scratch-related fringe-order errors. Lower overall RMS after adding clean pixels must not be interpreted as fixing a scratch. The existing upstream illumination, modulation, connected-region and foldover gates remain in force, so these methods cannot recover all selected pixels. No 100%-coverage accuracy claim follows from these results.','',
'## Error accounting and limits','',
'Analytic height is used only after reconstruction to score each output. Sign is determined from the detected versus generated carrier direction, never chosen to minimize error. Only piston and tilt are fitted for scoring; no curvature, scale, registration or best-case sign correction is allowed. Common-area error, added-area error, full-mask error, removed original pixels, cap pixels and outside-physical pixels are retained in the CSV/JSON. The `seconds` field is cumulative elapsed time within one scene with shared fits; it is not an isolated per-method benchmark.','',
'Do not promote the broad window union, relaxed conditioning, or unpadded continuation on these results. The selective local-fit and padded-composite paths are candidates for further experiments, not validated metrology options. The final blind suite probes non-quadratic phase, varying contrast and camera artifacts. Further work should target independently detecting existing fringe-order failures before extension. A multi-image method would also need registration, common fringe order and a physical acquisition protocol.', '',
'Fit agreement is correlated evidence from one image, not independent measurement or a calibrated uncertainty bound. This research implementation has not been ported into the browser worker or added to the UI. Real-part validation is still required.','',
'## Next experiments worth pursuing','',
'- Test whether spatially structured prediction residuals can distinguish model bias from camera noise before continuation is admitted. The blind quartic failure passes an RMS-only check.',
'- Hold out strips of reliable interior pixels when fitting the continuation model, then test prediction on those strips before extending outward. This tests extrapolation behavior rather than relying only on training-area agreement.',
'- Detect and flag existing fringe-order failures before combining results. Every variant here deliberately preserves original measurements, including their errors.',
'These are proposed follow-ups, not implemented results in this study.', '',
'## Verification','',
'36 targeted tests passed across the recovery prototypes, production Hybrid and prior local-fit experiments. They cover original-value preservation, truth-independent admission, disconnected regions, bad anchor agreement, excluded-pixel independence, padded coordinate origin in both carrier directions, and retention of actual image pixels. Existing dependency deprecation warnings remain.', '',
'## Reproduce','',
'```sh','export OPENBLAS_NUM_THREADS=1 MPLCONFIGDIR=/tmp/loupe-mpl',
'for suite in matrix stress challenge; do',
'  .venv/bin/python scripts/experiment-fringe-edge-recovery.py --suite "$suite" --output "/tmp/loupe-recovery-$suite.json"',
'  .venv/bin/python scripts/experiment-fringe-edge-recovery.py --suite "$suite" --methods bank-model-check continuation --output "/tmp/loupe-recovery-second-$suite.json"','done',
'.venv/bin/python scripts/experiment-fringe-edge-recovery.py --suite holdout --methods guard-free bank-consensus bank-strict bank-grow bank-noise-aware bank-conditioned --output /tmp/loupe-recovery-holdout.json',
'.venv/bin/python scripts/experiment-fringe-edge-recovery.py --suite holdout --methods bank-model-check continuation --output /tmp/loupe-recovery-second-holdout.json',
'for suite in matrix holdout; do',
'  .venv/bin/python scripts/experiment-fringe-edge-recovery.py --suite "$suite" --methods checked-composite --output "/tmp/loupe-recovery-final-$suite.json"','done',
'.venv/bin/python scripts/experiment-fringe-edge-recovery.py --suite confirmation --methods checked-composite --output /tmp/loupe-recovery-confirmation.json',
'for suite in matrix stress challenge holdout confirmation blind; do',
'  .venv/bin/python scripts/experiment-fringe-edge-recovery.py --suite "$suite" --methods padded-composite --output "/tmp/loupe-recovery-padded-final-$suite.json"','done',
'.venv/bin/python scripts/report-fringe-edge-recovery.py',
'.venv/bin/python scripts/plot-fringe-edge-recovery.py','```','',
'Pilot and follow-up rows in the recorded dataset are retained for provenance; the commands above reproduce the suite tables. Source: `scripts/fringe_edge_recovery.py`; tests: `tests/test_fringe_edge_recovery.py`.','',
'## Scientific guidance','',
'The adaptive-fit experiments build on the local/windowed analysis motivation of [Qian (2004)](https://doi.org/10.1364/AO.43.002695) and the bias/noise discussion in [Gao & Qian (2012)](https://opg.optica.org/viewmedia.cfm?seq=0&uri=ao-51-3-328). [Massig & Heppner (2001)](https://doi.org/10.1364/AO.40.002081) reports fringe-extrapolation techniques to reduce border errors and motivates the continuation experiment. These implementations are our own model/anchoring tests, not reproductions of those published algorithms.','']
# Summarize paired gains without hiding individual regressions.
summary=['## Final padded-composite comparison', '',
         '| Suite | Scenes | Hybrid coverage → composite | Hybrid RMS → composite (nm) | Largest maximum-error increase (nm) |',
         '|---|---:|---:|---:|---:|']
for suite in ('matrix','stress','challenge','holdout','confirmation','blind'):
    selected=suite_rows(suite)
    pairs=[(selected[c,'hybrid'],r) for (c,m),r in selected.items() if m=='padded-composite']
    if not pairs:continue
    mean=lambda index,key:np.mean([pair[index][key] for pair in pairs])
    penalty=max(b['max_error_nm']-a['max_error_nm'] for a,b in pairs)
    summary.append(f'| {suite} | {len(pairs)} | {mean(0,"coverage_pct"):.2f}% → {mean(1,"coverage_pct"):.2f}% | {mean(0,"rms_error_nm"):.3f} → {mean(1,"rms_error_nm"):.3f} | {penalty:.3f} |')
summary += ['', 'These are software reconstruction errors on synthetic images, not instrument accuracy. Higher coverage does not repair errors already present in Hybrid. The final blind set is reported separately from the scenes used during development.', '']
pos=lines.index('## What was implemented')
lines[pos:pos]=summary
(args.output/'README.md').write_text('\n'.join(lines))
fig,axes=plt.subplots(1,4,figsize=(16,4),layout='constrained')
for ax,method in zip(axes,['bank-strict','bank-model-check','continuation','padded-composite']):
    for suite,color in [('matrix','#3b82f6'),('stress','#10b981'),('challenge','#f59e0b'),('holdout','#b455db'),('blind','#d34242')]:
        selected=suite_rows(suite);baseline={c:r for (c,m),r in selected.items() if m=='hybrid'}
        data=[r for (c,m),r in selected.items() if m==method]
        ax.scatter([r['coverage_pct']-baseline[r['case']]['coverage_pct'] for r in data],
                   [r['max_error_nm']-baseline[r['case']]['max_error_nm'] for r in data],label=suite,s=16,alpha=.7,color=color)
    ax.axhline(0,color='#777',lw=.7);ax.set_title(labels[method]);ax.set_xlabel('Coverage gain vs Hybrid (percentage points)');ax.set_ylabel('Change in maximum error (nm)');ax.grid(alpha=.2)
axes[0].legend(fontsize=8)
fig.savefig(args.output/'tradeoffs.png',dpi=150);plt.close(fig)
print(f'Wrote {len(rows)} evaluations to {args.output}')
