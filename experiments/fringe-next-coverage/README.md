# Recovery beyond the photographic Composite — 2026-10-25

This is a research comparison, not a change to the application's analysis thresholds. The reference is the five-layer Composite from the [previous integration study](../fringe-photographic-residual/composite-layer.md), including photographic recovery. Its real-photo coverage is 448,992 / 641,823 pixels (69.95574%). “Current” in these data means that existing Composite, not the application's estimator named Current.

## What rejects the missing area?

The remaining 192,831 pixels were traced through the actual photographic admission checks. The independent research implementation asserts exact equality with the production gate on every case. The following counts are exclusive first-failing checks, grouped by type:

| First failure | Pixels | Share of missing area |
|---|---:|---:|
| Intensity-fit mismatch / residual | 99,873 | 51.79% |
| Insufficient fitted contrast | 31,483 | 16.33% |
| Poorly constrained fit / conditioning | 28,212 | 14.63% |
| Window-size, window-shape or filtering phase disagreement | 28,892 | 14.98% |
| Anchoring or boundary checks | 4,371 | 2.27% |

Of the last group, 4,313 fail the transition inset and 58 lack connected/consistent original-anchor support. None is rejected solely by the one-period reach limit in this photograph. Order/seam checks add no further rejections after those categories here. The ordering matters: a pixel can fail several checks. For example, 141,133 missing pixels independently fail the primary raw residual check and 135,988 independently fail the window-shape agreement check. Loosening the first gate therefore need not recover those pixels.

These are algorithmic rejection causes, not measured surface errors and not proof that the pixels contain no usable information. The denominator is automatically detected support, not an independently measured physical part outline. The apparent 30% missing should not be treated as a calibrated percentage of the real part.

## Controlled experiments

Ten candidates were tested on the same 40 regression scenes (20 original synthetic scenes, 12 image-model holdouts, eight textured edge cases) and on the local photograph. They cover noise, correlated texture, illumination variation, harmonics, blur, scratches, oversized masks, a central hole, broad roll-off and narrow rim features. All candidates use the original Hybrid anchors; no recovered pixel seeds another candidate. Each extension must agree with existing Composite seams and pass the alternate unwrap check. Previously accepted phases are retained; nothing is interpolated outside the aperture.

Synthetic errors use one fixed offset/tilt reference fitted on the original Hybrid anchors and 632.8 nm wavelength. Truth is used only for scoring, never admission. The photograph uses its existing 589.3 nm wavelength. Figures below are independent additions beyond the existing Composite, not cumulative additions across rows.

| Candidate | Photograph coverage | Additional pixels | Worst added-pixel error, synthetic | Cases gaining area | Defect pixels admitted |
|---|---:|---:|---:|---:|---:|
| Allow two-period reach | 69.96% | 0 | 10.84 nm | 21/40 | 0 |
| Remove one-pixel transition inset | 70.63% | 4,313 | 17.37 nm | 26/40 | 1 |
| Residual limit 20% → 30% | 70.47% | 3,296 | 10.10 nm | 11/40 | 0 |
| Agreement limit 0.025 → 0.05 rad | 73.58% | 23,271 | 19.34 nm | 25/40 | 11 |
| Smaller quadratic windows | 70.14% | 1,167 | 11.04 nm | 16/40 | 0 |
| Add second intensity harmonic | 71.21% | 8,036 | 10.97 nm | 22/40 | 0 |
| Smaller-window / harmonic consensus | 69.99% | 213 | 4.91 nm | 9/40 | 0 |
| Linear background/amplitude model | 71.01% | 6,795 | 7.90 nm | 13/40 | 0 |
| Smaller linear model | 71.70% | 11,171 | 14.56 nm | 24/40 | 0 |
| Permissive stress: 30% residual, 0.10 rad agreement | 75.43% | 35,165 | 21.26 nm | 26/40 | 11 |

The full per-case counts and errors are in [synthetic.json](synthetic.json), the real-image diagnosis and candidates in [photograph.json](photograph.json), and aggregates in [summary.json](summary.json). Every candidate has zero added pixels outside the known synthetic part. Three candidates fail the known-defect exclusion check in `fresh-texture-7`: removing the transition inset admits one fringe-free defect pixel, relaxing agreement to 0.05 rad admits 11, and the permissive stress admits 11. Their numerical height errors do not reveal that those pixels lack local fringe evidence. These are failed rejection outcomes, even when the inferred heights happen to be close to truth. The other seven candidates retain zero added defect pixels. One pre-existing ambiguous scratch case remains rejected by the original Composite's fringe-order check; it is recorded rather than omitted.

These maxima describe the newly added pixels only. Earlier accepted pixels can have substantially larger errors (up to 53.62 nm in the previous 40-scene audit). Neither these candidates nor a passing image-consistency check certifies an entire map to a nanometer budget. These are reused regression cases, not independent physical validation or a new blind validation set.

## Findings and next step

The largest single-candidate real coverage is 75.43%, using deliberately permissive residual and agreement gates. A milder agreement relaxation reaches 73.58%, but both fail defect exclusion and are not recommended for promotion. The extra harmonic and smaller linear model recover different, smaller patches without that failure: 71.21% and 71.70% coverage respectively. Doubling the reach limit contributes nothing on this photograph, and removing the transition inset gives only 0.67 percentage points. Smaller quadratic windows often lose support through conditioning/agreement checks instead of improving the edge.

A mask-only union of smaller linear plus second harmonic covers 72.32% (15,156 additional pixels). Adding the milder agreement candidate raises that to 74.53% (29,363 additional pixels), but includes a method that failed defect exclusion. Removing the transition inset would contribute only 25 more unique pixels and also failed defect exclusion. That is an overlap/coverage calculation, **not a validated combined height field**. The methods may disagree where their recovered regions meet, so their individual coverage gains must not be added together or treated as a proven new stack.

The next useful implementation experiment is a combined stack of the simpler-model and harmonic contributions with explicit overlap disagreement and final joint fringe-order checks. Keep their contributions identifiable. Do not promote the agreement relaxation or removed inset on the strength of a nominal height-error budget: first repair their failure to reject fringe-free defects and repeat independent checks. A large jump toward full coverage will need better-supported fits in the broad intensity-mismatch and weak/unstable regions; these experiments do not establish that simply relaxing existing gates can recover them accurately. No candidate was promoted into the UI in this study.

## Reproduction

Use `OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/loupe-mpl` with the repository Python environment:

```sh
.venv/bin/python scripts/experiment-fringe-next-coverage.py --suite --output /tmp/next-core.json
.venv/bin/python scripts/experiment-fringe-next-coverage.py --suite --variants linear-envelope,small-linear-envelope --output /tmp/next-linear.json
.venv/bin/python scripts/experiment-fringe-next-coverage.py --suite --variants permissive-stress --output /tmp/next-stress.json
```

`--resume` skips complete cases already in the chosen JSON file; it was used after a logging/I/O failure interrupted the linear-model run. All three runs ultimately contain 40 unique complete cases. `scripts/report-fringe-next-coverage.py` summarizes the JSON and can create private photo overlays with `--photo` and `--cache`.

For the specific local photograph, use `--real-cache /tmp/loupe-real-fit.npz --cache /tmp/next-photo --output /tmp/next-photo.json`; this requires the adjacent original `loupe-real-result.json`. The script checks that the cached input reconstructs exactly 448,992 accepted Composite pixels before trusting the comparison. Two unchanged second-harmonic fits were reused from the preceding local experiment, with the same input, aperture, carrier, degree and windows; remaining fits were recomputed. Generated fitting caches were removed afterward to release disk space. Inputs, result maps and private figures remain local; no user image is included in this repository report.

Source hashes are recorded in [source-sha256.json](source-sha256.json). The production Composite source hash still matches the previously validated integration study. Research scripts compile, `git diff --check` passes, and all 400 synthetic candidate comparisons completed. Application tests were not rerun because no application code changed in this study.
