# Photographic residual rejection — 2026-10-25

The reported Current/Hybrid identity was real fallback, not a duplicated comparison image. A local export of the user's interferogram reproduced the browser result natively: 416,055 measured pixels out of the 641,823-pixel post-continuity aperture (64.82395%), PV 115.93647 nm, RMS 12.92003 nm. The original was 2048 × 1883, analyzed at 1024 × 941, automatic area, 5% weak-fringe threshold, plane removal, 589.3 nm wavelength. The original rules below were research-only. A subsequently checked variant is now available as the limited-evidence Composite layer; see [integration experiments](composite-layer.md).

## Why no Hybrid pixels survived

Local fits run before continuity filtering, on 652,065 initial pixels. Browser diagnostics independently reject **all 652,065 on the 4%-of-amplitude image-residual check**. Exclusive first-failure accounting is: 28,212 conditioning, 75,851 contrast, 548,002 image residual, zero window disagreement, zero passed. Independent failures overlap: conditioning 28,212, contrast 76,432, residual 652,065, window disagreement 185,272. Continuity filtering subsequently removes 10,242 pixels. These two screening stages therefore have different denominators.

On the retained aperture, the larger residual/amplitude ratio across the two windows has minimum 9.53%, median 18.71%, and 90th percentile 74.44%. The fixed 4% gate cannot admit any of these pixels. Texture, noise, illumination/model mismatch and non-sinusoidal fringe intensity can all contribute; these residuals alone do not establish a surface-height error.

The image's automatically chosen red channel is not materially saturated (0.0072% of retained pixels ≥254). Trying green did not fix the problem: its minimum relative residual was 10.33%, with lower fringe amplitude. Mild image filtering also left the residual above 4%. A second intensity harmonic reduced the minimum to 6.60%, still above the existing cutoff. Thus neither switching channels nor simple denoising restores the existing Hybrid admission rule.

## Controlled recovery experiments

The main comparison uses the same raw quadratic phase fits, two-window agreement <0.025 rad, condition <1000, amplitude >15, original Current anchors (at least 25), anchor 90th-percentile disagreement ≤0.05 rad, connected growth, one-fringe reach, a one-pixel transition inset, and an alternate unwrap-path check. It fills only new pixels; **all Current heights and pixels are preserved exactly**. There is no reduced fixed boundary inset: local support/conditioning and these checks determine the boundary. This is a research extension using existing Composite anchoring, not the production Hybrid blending rule.

The filtered-residual policies assess image mismatch after normalized Gaussian filtering inside the aperture, sigma = max(0.5 px, 0.05 fringe period). Both filtered windows must also agree with their raw fits within 0.025 rad. **The output retains the raw fit's phase**, not the filtered phase. Filtering is a diagnostic hypothesis, not a noise calibration. Neither policy uses true heights to accept pixels.

| Policy | Photograph coverage | Added pixels | Largest added-pixel error, initial 20 scenes | Largest added-pixel error, fresh 12 holdouts |
|---|---:|---:|---:|---:|
| Current | 64.824% | 0 | — | — |
| Existing 4% residual gate with research anchoring | 64.824% | 0 | 4.31 nm | No additions |
| Filtered residual <4% | 64.824% | 0 | 4.64 nm | 2.04 nm |
| Filtered residual <10% | 67.958% | 20,117 | 6.83 nm | 14.60 nm |
| Raw residual <20% | 73.893% | 58,210 | 12.63 nm | 17.05 nm |

All 160 synthetic policy evaluations retained existing heights exactly, added zero pixels outside the physical surface and zero marked defect pixels. Some cases added nothing. Errors use a fixed offset/tilt fitted on the original Current anchors; added pixels cannot improve their score by refitting that plane. Wavelength for synthetic error reporting is 632.8 nm. The photograph's true heights are unknown.

**These are observed errors, not a guaranteed 20 nm budget.** Correlated texture raised errors substantially in the fresh holdout. Existing Current errors also remain: the initial suite includes a scratch case with 146.93 nm maximum baseline error; the fresh holdout baseline reaches 22.89 nm. An added-pixel limit does not certify whole-map PV/RMS or resolve shared fringe-order mistakes. The alternate unwrap test can detect some failures, but agreement is not truth.

Separate exploratory ablations on the photograph, not included in the 160-run validation:

- Simply changing Hybrid's residual/contrast gates to 20%/5, retaining its fixed inset and blending, yields 72.011% coverage. This motivates the residual investigation but is not the evaluated extension above.
- Loosening raw residual to 40% with amplitude >15 and research anchoring yields 75.621%, indicating diminishing returns and increasing model mismatch.
- Adding a second intensity harmonic with 20% residual allowance yields 75.482%, compared with 73.893% for the raw single-harmonic extension. This richer model still needs its own synthetic regression campaign.
- Removing the one-period reach cap only changes raw recovery from 73.893% to 73.935%; it is not the important bottleneck here. The richer model changes from 75.4820% to 75.4825%.

## Product changes

Production thresholds and measurement heights remain unchanged. Hybrid now records exclusive and independent fit failures plus attrition during unwrap, transition, anchor, pointwise and reach checks. Coverage details explain these stages. Comparison snapshots preserve the diagnostic metadata and explicitly say when Hybrid fell back everywhere, so identical maps cannot be mistaken for independent confirmation. Old saved pairs can obtain the fallback notice from their owning Hybrid result.

The actual browser rerun reproduced zero accepted fits and the native surface statistics. UI verification used the saved browser result in a fresh local preview because the older preview retained cached JavaScript. Automated verification: 50 relevant Python tests and 853 frontend tests passed.

## Reproduce

```sh
OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/loupe-mpl \
  .venv/bin/python scripts/experiment-fringe-photographic-residual.py \
  --suite --output /tmp/photographic-synthetic.json
OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/loupe-mpl \
  .venv/bin/python scripts/experiment-fringe-photographic-residual.py \
  --holdout --output /tmp/photographic-holdout.json
OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/loupe-mpl \
  .venv/bin/python scripts/experiment-fringe-photographic-residual.py \
  --project /path/to/export.loupe --output /tmp/photograph.json --cache /tmp/photograph-arrays
```

The project runner prepares the saved original image/mask/lens correction and uses its weak-fringe threshold; this study used otherwise automatic carrier/filter settings and plane removal. It is not a general saved-project replay for arbitrary manual carrier/filter overrides. `synthetic.json`, `holdout.json`, `photograph-summary.json`, and `browser-diagnostics.json` contain numeric results. User photographs, project exports, screenshots and full-resolution arrays remain local and are not included in this repository.

## Next experiment

Evaluate a spatially correlated residual model and the richer harmonic fit against the same holdouts, with particular attention to narrow rim roll-off and scratches. A recovery layer would belong in Composite's limited-evidence tier, with provenance, original anchors and cutoff-specific statistics. Do not replace the default or label the recovered area as a calibrated uncertainty bound on this evidence alone.
