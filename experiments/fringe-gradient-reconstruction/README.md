# Full-area fringe reconstruction — 2026-10-25

This research prototype reaches **100% displayed coverage of the selected aperture** on the test photograph. It freezes all 470,468 previously accepted pixels (73.30183%) and reconstructs the remaining 171,355 pixels (26.69817%). The denominator is 641,823 selected-support pixels, not an independently calibrated outline of the physical part. The additional pixels are **inferred display values, not additional measurements**. No production algorithm, application default, or UI option changes in this study.

The purpose is to reveal broad edge roll that a blank region conceals. A reconstruction driven by the recorded fringes retains substantially more of the simulated roll than smooth filling, but narrow roll is still attenuated and some local errors exceed 100 nm. It does not establish full-area metrology accuracy.

## Why loosening the existing checks did not suffice

The direct-fit experiment tests linear envelopes at normal and smaller windows, plus smaller linear envelopes with a second intensity harmonic. Each has four screening levels, from provisional through an ungated diagnostic. Four corresponding stacks bring the total to 16 alternatives. All fits use the recorded image; existing accepted values are fixed.

On the photograph, looser individual fits propose approximately 83–100% coverage. The weak small-window harmonic fit proposes 95.18%, and ungated fits propose 100%. However, the joint fringe-order check rejects every proposed addition: the independent unwrap paths disagree across the candidate islands. Checked coverage stays at 73.30%. These proposed masks cannot honestly be presented as measured coverage. The complete results, including unsuccessful variants, are in [raw-fit-photograph.json](raw-fit-photograph.json) and [raw-fit-synthetic.json](raw-fit-synthetic.json).

## Reconstruction method

Instead of treating those unreliable local phases as independently unwrapped heights, the prototype integrates their wrapped **neighbor-to-neighbor phase differences**. It minimizes, over four-connected edges inside the selected domain:

```text
sum_edges w * [(phase_j - phase_i) - wrap(raw_j - raw_i)]²
          + lambda * (phase_j - phase_i)²
```

All previously accepted phases are hard fixed anchors. The second term favors smooth extension where image evidence is weak; it can also suppress genuine steep changes. This is an explicit modeling assumption, not information recovered from the image. Only connected components containing at least 25 accepted anchors are eligible. Excluded holes have no graph edges crossing them, and existing conflict pixels remain excluded. A failed numerical solve adds no values.

Two original-image small-window fits estimate local evidence. With minimum amplitude `a`, maximum residual/amplitude `r`, wrapped window disagreement `d`, and maximum condition number `k`, the weight is:

```text
(a / (a + 5))² / [1 + (r / 0.5)² + (d / 0.15)² + (k / 10000)²]
```

An edge uses the smaller endpoint weight. The study compares linear envelopes with one or two intensity harmonics at `lambda = 0.01, 0.1, 1`, plus a zero-evidence smooth-fill control: seven alternatives. The sparse graph system uses diagonally preconditioned conjugate gradients, relative tolerance `1e-8`, absolute tolerance `1e-10`, and at most 3,000 iterations. Nearest accepted values initialize the solver; they do not supply the final reconstruction.

The displayed image influence `w / (w + lambda)` and spread between model alternatives are **heuristic sensitivity indicators, not calibrated uncertainty**. Every added pixel remains reconstructed, including pixels with high image influence. Retaining the original measurement mask and reference plane keeps reconstructed values out of measured PV/RMS and prevents earlier displayed heights from shifting.

Scientific provenance: the abstract of [Ghiglia & Romero (1994), *Robust two-dimensional weighted and unweighted phase unwrapping that uses fast transforms and iterative methods*](https://doi.org/10.1364/JOSAA.11.000107) was consulted for weighted least-squares phase unwrapping. This is an independently implemented masked sparse-graph integration with hard anchors and a smoothness prior, not a reproduction of that paper's fast-transform solver. No external implementation was copied, and the paper is not evidence for this prototype's accuracy.

## Validation protocol

The suite contains the preceding 40 regression scenes, eight model-stack stress scenes, and eight additional radial controls specified before examining their results. There are **896 direct-fit evaluations (56 × 16)** and **392 reconstruction evaluations (56 × 7)**. Synthetic truth is used only for scoring. Synthetic heights use 632.8 nm and one fixed offset/tilt reference fitted on the original Hybrid anchors; the photograph uses 589.3 nm. Its physical height sign is unverified in the cached input, so figures show relative optical deviation.

The photograph starts from the preceding additive model stack at 73.30%. Synthetic trials start from the existing five-layer Composite, rather than recomputing that additive stack. Therefore the synthetic added-pixel population differs from the preceding model-stack study; their aggregate errors should not be compared as if they described the same pixels.

The new controls contain elliptical parts, varied carrier directions, bright rim illumination, reduced rim contrast, a second intensity harmonic, and noise. Boundary depths are 0, 20, 60, and 100 nm for broad roll; 20 and 60 nm for narrow roll; −30 nm for an upturned edge; and a second flat control. Broad roll occupies the outer 20% of radius, narrow roll 7%, and the upturned edge 15%. These are synthetic stress tests, not physical calibration or an external blind dataset.

## Results

All seven photograph variants converge and retain every earlier phase exactly. Their displayed coverage reaches 100%, but the inferred shape depends on the model and regularization. The harmonic `lambda = 0.01` result is shown in the preview because it retains more broad roll; it is not a selected or validated production default.

All 392 synthetic evaluations preserve earlier phases exactly. Each alternative displays the full selected area in 49 of 56 scenes. Two previously rejected ambiguous analyses have no eligible anchors and remain empty; five other scenes retain small gaps from existing conflict masks. A converged/no-op solver status in an empty scene does not mean successful analysis.

Selected aggregate results below score only newly reconstructed pixels, across all 56 scenes:

| Alternative | Pooled RMS error | Worst local error | Pixels above 100 nm error |
|---|---:|---:|---:|
| Smooth fill | 30.58 nm | 274.90 nm | 10,585 |
| Linear, lambda 0.01 | 12.02 nm | 229.62 nm | 913 |
| Harmonic, lambda 0.01 | 13.06 nm | 241.05 nm | 1,500 |
| Harmonic, lambda 0.1 | 12.40 nm | 168.50 nm | 1,199 |
| Harmonic, lambda 1 | 21.30 nm | 224.42 nm | 3,042 |

Each alternative reconstructs 584,410 pixels across the suite, including **18,330 outside the known physical part** in deliberately oversized masks and **3,807 labeled fringe-free defect pixels**. These are inferred values inside the selected domain, not accepted measurements. This is a material limitation: completion cannot distinguish a missing measurement from an incorrectly included region by geometry alone. Accurate aperture/exclusion masks and a visible reconstructed-layer designation are essential. Passing the joint-order diagnostic does not prove the inferred height is correct.

The radial tests show why reconstruction can nevertheless help inspect edge roll. These numbers are means in the outer annulus `0.95 <= radius / part_radius < 1`, not the exact boundary depths:

| Simulated part | True annular mean | Smooth fill | Harmonic, lambda 0.01 |
|---|---:|---:|---:|
| Broad 60 nm roll | −46.2 nm | −8.3 nm | −38.5 nm |
| Broad 100 nm roll | −77.0 nm | −4.0 nm | −66.5 nm |
| Narrow 60 nm roll | −27.1 nm | −1.0 nm | −16.5 nm |

The reconstructed broad roll is much closer to truth than smooth filling, but narrow roll remains substantially attenuated. Radial averaging also conceals local errors: the harmonic `lambda = 0.01` narrow-60-nm case reaches 105.47 nm local error. Its flat controls have near-zero outer radial means but local errors up to 38.65 nm. Stronger smoothing reduces some artifacts while also reducing recovered roll. Neither average error nor model agreement is a guaranteed error budget.

Four focused tests cover known wrapped-gradient recovery with fixed anchors, excluded holes and unsupported components, smooth inference with no evidence, and failure without additions on nonconvergence. They pass. This remains a research implementation; no reconstructed pixels are introduced into application statistics or exports.

## Records and reproduction

- [synthetic.json](synthetic.json): every reconstruction trial, radial profiles, and error counts.
- [summary.json](summary.json): all alternatives, separated into earlier scenes and new rim controls.
- [photograph.json](photograph.json): selected-area coverage and solver diagnostics without image data.
- [source-sha256.json](source-sha256.json): code fingerprints, including unchanged production Hybrid/Composite modules.

From the repository root, with the existing development environment:

```sh
OPENBLAS_NUM_THREADS=1 .venv/bin/python scripts/experiment-fringe-edge-preview.py --output /tmp/edge-preview.json
OPENBLAS_NUM_THREADS=1 .venv/bin/python scripts/experiment-fringe-gradient-reconstruction.py --output /tmp/gradient-reconstruction.json
.venv/bin/pytest -q tests/test_fringe_gradient_reconstruction.py
```

Both experiment runners default to all 56 scenes; `--start` and `--stop` allow partitioning. To reproduce the photograph, supply `--context` with the previous numeric photograph context, `--tiered` with the additive model-stack maps, and optionally `--maps` to save reconstructed arrays. Those private image/context files are not committed. The report runner accepts `--inputs`, `--raw-inputs`, `--photo`, `--raw-photo`, and `--output`; optional `--maps` and `--figures` generate the photograph comparison and known-edge profiles. On macOS, set `MPLBACKEND=Agg` and a writable `MPLCONFIGDIR` for headless plots.

## Application follow-up

The optional preview is now integrated in `backend/vision/fringe_reconstruction.py` and the Composite quality viewer. Select Composite quality and Plane removal, then enable **Prepare reconstructed surface preview**. Production anchors are the existing five-layer Composite, not the research-only additive model stack. White hatching and reconstructed hover labels are permanent; measured coverage and PV/RMS stay separate from displayed coverage. Measurement CSV and capture combination omit the inferred values. The payload is saved with the result and uses the fixed analysis-time plane and air-gap sign. The historical experiment files and code fingerprints above remain unchanged; they describe the research run, not later application sources.

Integration validation: 40 focused backend tests pass, including seven new reconstruction tests, the four original research tests, Composite and browser-adapter checks. The three server-route cases were rerun with reconstruction enabled, including capture-history round trips. A further 54 carrier-related regressions pass after making server carrier reruns honor their requested form model; 38 frontend tests pass. The real Pyodide worker matches native Python on the rolled-rim/hole fixture (identical measured grids and masks, reconstructed heights within 0.02 nm). UI checks cover setup opt-in, unsupported-form disabling, preview toggling without PV/RMS changes, reconstructed hover labels, and persistence through a page reload.

A fresh full-size photograph run using the production pipeline and automatic area has 428,619 measured pixels (68.23285%) plus 199,552 inferred pixels, covering all 628,171 selected pixels. Its solve converged in 1,281 iterations; the complete native analysis took approximately 281 seconds on the test machine. This is a different automatic mask and production baseline from the frozen research context above, so the coverage percentages are not a like-for-like algorithm comparison. The small browser fixture validates cross-runtime parity; the full-size photograph run was native Python.
