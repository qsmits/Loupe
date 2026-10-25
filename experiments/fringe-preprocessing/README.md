# Image cleanup as an assessment aid — 2026-10-25

We tested whether a modified copy of an interferogram can improve rejection decisions while taking every added phase value from the original image. It can preserve existing phases exactly, but the tested cleanup methods recover almost no additional area on this photograph once controls separate cleanup from changes to acceptance rules. No application code or UI thresholds changed in this study.

The reference is the five-layer Composite, including photographic recovery: 448,992 / 641,823 detected-support pixels, or 69.95574% coverage. This is not a calibrated physical part area. “Current” in the JSON means that Composite, not the application's estimator named Current. The previous [coverage study](../fringe-next-coverage/README.md) records the rejection breakdown and alternative fit models.

## Experiment and controls

The original image supplies four local fits: two primary windows and two wider lateral windows. Raw contrast, conditioning, phase agreement between window sizes/shapes, original Hybrid anchoring, seam agreement, one-period reach, transition inset, and alternate fringe-order checks remain in place. Candidate heights use the primary **raw** fit. Previously accepted Composite phases are copied unchanged; recovered pixels never become new anchors.

Two primary fits on an assessment copy must have residual/amplitude below 20%, sufficient amplitude and conditioning, and phase agreement with the corresponding raw fits within 0.025 rad. Five assessment copies were compared:

- **Unchanged copy:** an essential control. It replaces the production filtered cross-check with raw fits, so it is itself a different acceptance policy, even though no image pixels change.
- **Slow lighting removed:** subtract a mask-normalized Gaussian background with sigma two fringe periods, retaining the median brightness. No clipping or resampling.
- **Isolated outliers repaired:** replace only connected groups of at most two pixels whose departure from a 3×3 median exceeds six robust noise sigmas. All nine neighbors must be observed. Noise is estimated from fully observed diagonal Haar differences, with a 0.5 intensity-unit floor; this avoids the degenerate zero MAD of median-filter differences on smooth ramps.
- **Mild smoothing:** mask-normalized Gaussian sigma max(0.5 pixels, 0.05 fringe periods), reproducing the existing photographic assessment.
- **Lighting plus smoothing:** the lighting-corrected copy followed by that same mild smoothing.

Each copy was tested with the raw residual/amplitude ceiling retained at 20%, relaxed to 30%, or omitted. These are explicit experimental substitutions. Even with the 20% raw veto retained, replacing the assessment branch can change acceptance. Only **mild smoothing + 20% raw veto** reproduces the existing gate; it correctly adds zero pixels in all cases and on the photograph. With the raw ceiling omitted, the assessment-copy residual test still applies.

The suite contains 40 reused regression scenes: 20 original scenes, 12 image-model holdouts, and eight textured edge cases. Five assessment copies × three raw ceilings × 40 scenes gives **600 candidate comparisons**, plus 15 comparisons on the photograph. Truth is used only for scoring. Synthetic errors use 632.8 nm wavelength and one fixed offset/tilt reference fitted on original Hybrid anchors; the photograph retains 589.3 nm. These are not new blind tests or physical validation.

## Photograph results

Each cell is final coverage, followed by additional pixels beyond the existing Composite. Rows are independent alternatives, not cumulative additions.

| Assessment copy | Raw ceiling 20% | Raw ceiling 30% | Raw ceiling omitted |
|---|---:|---:|---:|
| Unchanged control | 70.53674% (+3,729) | 70.94417% (+6,344) | 71.23397% (+8,204) |
| Lighting removed | 70.53658% (+3,728) | 70.94401% (+6,343) | 71.23288% (+8,197) |
| Isolated outliers repaired | 70.53674% (+3,729) | 70.94479% (+6,348) | 71.23522% (+8,212) |
| Mild smoothing | 69.95574% (+0) | 70.45026% (+3,174) | 70.89338% (+6,018) |
| Lighting plus smoothing | 69.95994% (+27) | 70.45463% (+3,202) | 70.89712% (+6,042) |

The outlier treatment modifies 1,420 assessment-copy pixels, but at the original 20% raw ceiling its added mask is **identical** to the unchanged-copy control. Lighting subtraction alone loses one pixel relative to that control. The apparent gains of roughly 0.58–1.28 percentage points are therefore mostly changes to the assessment policy or raw residual ceiling, not recovered evidence from cleaning the image.

The matched comparisons isolate the actual cleanup contribution:

| Cleanup versus matching control | Net pixels, 20% ceiling | Net pixels, 30% ceiling | Net pixels, no raw ceiling |
|---|---:|---:|---:|
| Lighting versus unchanged copy | −1 | −1 | −7 |
| Outlier repair versus unchanged copy | 0 | +4 | +8 |
| Lighting + smoothing versus smoothing | +27 | +28 | +24 |

At the original raw ceiling, the useful lighting-plus-smoothing gain is **27 pixels, or 0.00421 percentage points**. The largest net cleanup gain in these comparisons is 28 pixels; that configuration also relaxes the raw ceiling. [control-comparison.json](control-comparison.json) records gained and lost pixels separately, not just their net count.

## Accuracy checks and interpretation

All 600 comparisons preserved previously accepted phase values exactly. Added phases match the corresponding original-image fit modulo a whole fringe to within 3.11e-15 rad. No candidate added a pixel outside the known synthetic part or inside its labelled fringe-free defects. One pre-existing ambiguous scratch scene still fails the full Composite fringe-order check; its candidate diagnostics are retained and its analysis rejection is explicitly recorded, rather than presented as a successfully reportable map.

The worst newly added-pixel error across this suite is **11.65 nm**. For lighting plus smoothing with the original raw ceiling, only 25 synthetic pixels were added across nine scenes, with a maximum error of 10.59 nm. These are observed new-pixel errors, not certified bounds. Earlier accepted pixels had errors up to 53.62 nm in the preceding audit; this experiment does not improve those values or establish whole-map accuracy.

Three focused tests also pass: exterior pixels cannot influence any assessment copy inside the mask; the outlier rule preserves clean fringe peaks and repairs a single injected spike; and unclipped positive affine brightness/contrast adjustment preserves phase, conditioning, and relative residual. Such brightness scaling can cross an absolute contrast threshold, but it does not add information or improve signal-to-noise, so it is not a valid recovery strategy by itself.

“Without affecting output” needs a precise scope: existing **raw phases** remain unchanged. Existing displayed heights also require retaining the same reference plane, as the Composite comparison viewer does. Refitting the plane after changing coverage can move old displayed heights; adding pixels can also change PV/RMS. Keeping raw phases does not prove that newly admitted pixels are accurate: a cleaned copy can hide evidence of a bad original fit.

These results do not justify adding a cleanup option to the UI. For this image, the simpler local models and second intensity harmonic from the preceding study offer larger gains and are the more useful next experiments. A joint model for slowly varying background/amplitude can be tested against original observations directly, with explicit agreement and uncertainty checks, rather than relying on cleaned residuals alone.

## Reproduction and records

Use the repository Python environment with `OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/loupe-mpl`:

```sh
.venv/bin/python scripts/experiment-fringe-preprocessing.py --start 0 --stop 20 --output /tmp/preprocess-a.json
.venv/bin/python scripts/experiment-fringe-preprocessing.py --start 20 --stop 40 --output /tmp/preprocess-b.json
.venv/bin/python scripts/experiment-fringe-preprocessing.py --control-only --output /tmp/preprocess-control.json
.venv/bin/python scripts/report-fringe-preprocessing.py --inputs /tmp/preprocess-a.json /tmp/preprocess-b.json --controls /tmp/preprocess-control.json --output /tmp/preprocess-report --complete
.venv/bin/pytest -q tests/test_fringe_preprocessing_experiment.py
```

For the local photograph, pass `--context /tmp/loupe-next-coverage-linear/context.npz` to the experiment, using separate output files for normal and `--control-only` runs. This is the exact numeric context saved by the preceding real-image study; the script asserts 448,992 previously accepted pixels. It reads only numeric/string fields with pickle loading disabled. `--maps` saves optional local masks. The reporter accepts `--photo` and `--photo-control` to merge the photographic results. Optional figures contain the user's photograph and should be generated only in a private local output directory. No image or fit cache is included here.

[synthetic.json](synthetic.json), [summary.json](summary.json), and [photograph.json](photograph.json) retain every candidate result. [source-sha256.json](source-sha256.json) records the scripts, targeted tests, and production Composite source. The production source still matches the previous photographic integration study. Research scripts compile and the three targeted tests pass; application tests were not rerun because this study changes no application code.
