# Photographic recovery in Composite — 2026-10-25

The fifth Composite layer recovers additional photographic fringes while preserving earlier accepted raw phases, source labels, evidence categories and conflicts. Current and Hybrid admission rules remain unchanged. All new pixels are **Limited corroboration**, not a calibrated uncertainty category.

## Admission checks

Raw quadratic fits use two window sizes and a second window shape along the fringes. Both members of each pair require condition <1000, amplitude >15, residual/amplitude <20%, and phase agreement <0.025 rad. A mildly filtered image (Gaussian sigma = max(0.5 pixels, 0.05 fringe periods), normalized over observed aperture pixels only) must pass the same residual checks and agree with each raw primary fit within 0.025 rad. The lateral-window fit must also agree with the primary fit. **Heights come from the raw primary fit**, never the filtered image.

Candidates need at least 25 original Hybrid anchors, a consistent fringe order, 90th-percentile anchor disagreement ≤0.05 rad, connected support, a one-pixel transition inset, and a maximum reach of one fringe period from original anchors. Earlier layers can veto a disagreeing seam but cannot seed growth. An alternate unwrap check rejects new additions in ambiguous islands. Existing conflicts stay excluded. These correlated checks cannot establish true height or eliminate shared model errors.

## Experiments and choice

We compared filtered residual limits of 10% and 20%, retaining all other checks. The original 20 synthetic scenes and 12 holdouts were supplemented with eight fixed-seed scenes covering different carrier angles, fringe periods, correlated-texture scales, a central hole, small defects, broad edge roll-off and a narrow rim feature. Ground truth is used for scoring only. Errors use the same offset/tilt reference fitted on original Hybrid anchors for both variants.

| Full Composite comparison | 10% filtered gate | Selected 20% filtered gate |
|---|---:|---:|
| Added pixels across original 32 scenes | 34,427 | 71,837 |
| Mean coverage gain, original 32 | 5.39 percentage points | 8.99 percentage points |
| Worst added-pixel error, original 32 | 11.79 nm | 17.20 nm |
| Added pixels across eight fresh scenes | 15,238 | 33,300 |
| Mean coverage gain, eight fresh scenes | 6.19 percentage points | 13.54 percentage points |
| Worst added-pixel error, eight fresh scenes | 12.74 nm | 10.32 nm |
| Added pixels outside the part / in known defects, all 40 | 0 / 0 | 0 / 0 |

Every case asserts preservation of earlier raw phase, membership, source, quality and conflict arrays. One scratch scene remains rejected because its earlier stack has unresolved fringe-order ambiguity. Sixteen of the 40 scenes gain no pixels with the selected gate. The 20% gate provides substantially more recovery; its worst observed added-pixel error is 17.20 nm. The earlier isolated-gate experiment gave 13.44 nm, but that is **not** the final integrated result: production preprocessing and anchoring matter.

This is not a validated ±20 nm specification. Existing layers reach 53.62 nm error in the fresh suite, and the new layer does not repair those measurements. The 32 original cases informed development; the eight fresh cases are a small synthetic check, not external validation. Real optical-flat error, image processing, illumination, contact direction, small unresolved features and camera effects require physical validation. No ground-truth heights are available for the user's photograph.

## Real photograph

Using the same 1024 × 941 analysis, 589.3 nm wavelength, automatic aperture and Plane removal:

| Result | Pixels | Coverage of detected support |
|---|---:|---:|
| Earlier Composite / original Hybrid | 416,055 | 64.82395% |
| 10% filtered-gate variant | 427,042 | 66.53579% |
| Selected 20% variant | 448,992 | 69.95574% |

The selected variant adds **32,937 pixels**, mostly around the rim. Its raw gate admits 327,267 pixels; filtered checks retain 319,792; window-shape agreement retains 249,671; anchoring and later checks reduce the actual additions. Coverage is relative to the detected aperture, not an independently traced physical boundary.

The new full result has gap PV 118.55 nm and RMS 14.01 nm after its shared plane removal. Hiding photographic additions gives 64.8% coverage and RMS 12.99 nm while retaining that same plane and PV 118.55 nm. A new analysis can fit a different plane because it has more samples; the viewer toggle itself never refits or rescales anything. All pixels in this photograph remain limited evidence, including its original baseline; select **+ Limited corroboration** to inspect them.

## UI and verification

Choose Composite quality in Analysis settings. In the quality viewer, select **+ Limited corroboration**, then toggle **Photographic recovery** or select **Photographic additions** in Evidence overlay. Teal highlights additions and gray shows earlier layers. The toggle updates full-resolution coverage, PV/RMS and display-resolution CSV selection using fixed heights, plane and color scale. Current remains the default. README and in-app help describe the new layer.

Validation: 55 targeted Python tests, all 855 frontend tests, and four production browser-worker/native parity fixtures passed. Browser source/quality/conflict/mask grids and photographic counts matched exactly; rounded displayed heights matched exactly; PV differences were below 0.000002 nm. Browser UI checks on the actual photograph verified 448,992 → 416,055 → 448,992 pixels when toggling recovery. The photograph was analyzed natively with the shared implementation and loaded into the UI; the four smaller fixtures exercised browser execution directly.

## Reproduction and records

Run `.venv/bin/python scripts/experiment-fringe-texture-composite.py --filtered-limit .2 --output /tmp/integrated.json` for the original 32 scenes; add `--fresh` for the eight fresh scenes. Repeat with `--filtered-limit .1` for the stricter ablation. Set `OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/loupe-mpl`. `scripts/experiment-fringe-texture-layer.py` runs the isolated gate and must not substitute for the integrated audit. `scripts/prepare-fringe-composite-validation.py /tmp/frontend` prepares four browser parity fixtures.

Full per-scene data, both photograph audits, selected photograph summaries, and source hashes are retained in [composite-layer/](composite-layer/). The real-image audit reuses the four unchanged initial Hybrid fits from the earlier cache (image equality and initial mask count asserted); all Composite fits were recomputed. Raw photographic data remains local and is not included in this report.

Follow-up: [rejection diagnosis and ten further recovery candidates](../fringe-next-coverage/README.md), including failed defect-exclusion outcomes.
