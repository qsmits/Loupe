# Combining local fringe models — 2026-10-25

This study extends the five-layer photographic Composite using independently anchored local fits. The target is additional measured area without changing already accepted values. The implementation is a research layer in `scripts/fringe_model_stack.py`; it does not change application defaults or expose a new UI option.

The [preceding coverage study](../fringe-next-coverage/README.md) found complementary gains from simpler intensity models and a second intensity harmonic. The [preprocessing study](../fringe-preprocessing/README.md) found negligible genuine gains from cleaning assessment copies. Here the models fit the original recorded image directly. No synthetic exterior, image inpainting, or surface interpolation supplies a height.

## Models and assembly

“Linear” refers to the local illumination and complex fringe-amplitude envelopes, not a requirement that the surface itself be a plane. The normal envelope is quadratic. The second harmonic adds sine/cosine terms at twice the detected carrier frequency to describe a non-sinusoidal intensity waveform; the fundamental phase still supplies the surface height. Each fit excludes unobserved aperture pixels.

| Model | Envelope degree | Intensity harmonics | Window scale | Source ID |
|---|---:|---:|---:|---:|
| Linear | 1 | 1 | 1.0 | 6 |
| Small linear | 1 | 1 | 0.7 | 7 |
| Quadratic + harmonic | 2 | 2 | 1.0 | 8 |
| Linear + harmonic | 1 | 2 | 1.0 | 9 |
| Small linear + harmonic | 1 | 2 | 0.7 | 10 |

Every model uses the same screening as photographic recovery: raw and filtered primary windows at two sizes, raw lateral windows at two sizes, residual/amplitude below 20%, amplitude above 15 intensity units, condition below 1,000, and 0.025 rad agreement between the relevant fits. Primary Gaussian sigmas are (0.5, 0.25) and (0.65, 0.325) fringe periods; lateral windows use (0.5, 0.5) and (0.65, 0.65), multiplied by the listed scale. Sigma floors remain 3 and 2 pixels. Filtering is only a cross-check; heights come from the original-image primary fit.

Each candidate independently anchors to the **original Hybrid** observations, using the existing 25-anchor minimum, phase/order checks, one-period reach, and transition inset. It must agree with existing Composite phases where it passes through them. Recovered pixels never seed another fit. Candidate order conflicts are rejected before stacking.

The initial matrix compares five individual models and six assembly variants:

- The **three-model stack** uses linear, small linear, then quadratic + harmonic. A reversed-priority control puts the harmonic model first.
- The **peer expanded stack** considers all five models together. Its overlap controls use 0.025, 0.05, or 0.10 rad absolute **unwrapped** disagreement, plus an unchecked-overlap diagnostic union. The default comparison is 0.05 rad. These are agreement rules, not nanometer error budgets.
- Within a peer group, disagreeing overlap pixels and a one-pixel surrounding band are excluded. Each model must remain connected to original anchors after those exclusions. The first surviving model supplies the phase and provenance; phases are not averaged. The assembled map receives a new independent unwrap-path check. Conflicting additions are removed and the check repeats, preserving the older map.

The peer expanded stack exposed a hierarchy issue: on the photograph it removed 646 pixels accepted by the three-model stack while gaining 3,981 elsewhere. It preserved the original Composite but was not a nested extension of the new three-model result. The follow-up **additive expanded stack** fixes that: first complete and freeze the three-model tier, then let linear + harmonic and small linear + harmonic fill only its remaining gaps. Lower-priority disagreements cannot veto or overwrite an earlier tier, and lower fits cannot use a disagreeing earlier pixel as a bridge. Both tiers still connect to original Hybrid anchors, and each assembled tier passes the joint order check.

## Validation protocol

The initial 11 alternatives were evaluated on the same 40 regression scenes used previously and eight newly specified stress scenes. The new scenes vary carrier orientation and period, stronger second/third intensity harmonics, correlated texture, weak rims, narrow edge depressions, an asymmetric bump, holes, fringe-free defects, and oversized masks. They were defined before inspecting this study's results. They are synthetic stress tests, not an external blind validation set.

The additive follow-up refits the same inputs and records a twelfth alternative. The report merges it by case only after checking identical reference coverage, aperture, and analysis-rejection status. Earlier phases and provenance are asserted unchanged, including the first recovered tier when the second is added. The old quality/conflict/reason arrays also remain unchanged.

Synthetic truth is used only for scoring. Errors share one fixed offset/tilt reference fitted on original Hybrid anchors, with 632.8 nm wavelength. The photograph retains its 589.3 nm wavelength. The whole analysis still rejects the pre-existing ambiguous scratch scene and the new `stack-stress-2` scene; both have zero accepted reference pixels and are retained in the report rather than omitted. These are successful refusals, not successful surface measurements.

The photograph's reference is 448,992 accepted pixels within 641,823 detected-support pixels: **69.95574%**. This denominator is not an independently calibrated physical part outline. All coverage gains below are relative to that same reference and are not added together across alternative rows.

## Results

| Assembly | Photograph coverage | Extra photo pixels | Worst added-pixel error, 48 scenes | Pooled added-pixel RMS error |
|---|---:|---:|---:|---:|
| Existing Composite | 69.95574% | 0 | — | — |
| Three-model stack | 72.59525% | 16,941 | 16.47 nm | 3.08 nm |
| Five models as peers, 0.05 rad overlap | 73.11486% | 20,276 | 19.87 nm | 3.19 nm |
| **Additive expanded stack, 0.05 rad overlap** | **73.30183%** | **21,476** | **19.87 nm** | **3.21 nm** |
| Peer stack, looser 0.10 rad overlap | 73.30448% | 21,493 | 19.87 nm | 3.23 nm |

The additive stack recovers **3.34609 percentage points**, or **11.14% of the previously missing detected-support pixels**. Its first recovery tier contributes 16,941 pixels, and its second contributes a further 4,535. It preserves every pixel, phase, and source ID of both the original Composite and the first recovery tier. The looser peer stack gains only 17 more photographic pixels than this additive result, so weakening the overlap limit provides no material advantage here.

The additional photographic pixels break down by source as follows: linear 6,437; small linear 6,752; quadratic + harmonic 3,752; linear + harmonic 796; small linear + harmonic 3,739. Unlike a mask-only union, the final result has a defined height and source at every included pixel and passes the joint fringe-order check. The masks were explicitly checked to be nested, and the preserved photographic phases/source IDs were compared bit-for-bit.

Across the 40 regression scenes, the additive version gains area in 25 cases and adds 32,423 pixels, with a worst added-pixel error of 19.87 nm. Across the eight new stress scenes, it gains area in seven and adds 25,949 pixels, with a worst error of 16.47 nm. Pooled across both sets, 472 of 58,372 added pixels exceed 10 nm error (0.81%); none exceeds 20 or 50 nm. These pixel counts are correlated observations from synthetic scenes, not independent calibration samples or confidence intervals.

All **576 comparisons** preserve old phase values exactly and add zero labelled-defect or outside-part pixels. The additive variant additionally asserts preservation at each recovered tier. No assembled candidate introduces a detected joint-order conflict in this suite; targeted tests separately exercise the rollback path. Two complete analyses remain rejected as described above. The eight focused tests and 31 existing Hybrid/Composite tests pass (**39 tests**); research scripts compile and `git diff --check` passes.

All 12 alternatives, including stricter/unchecked overlap and priority-order controls, remain in [synthetic.json](synthetic.json), [summary.json](summary.json), and [photograph.json](photograph.json). These tables report individual candidate results, not the sums of their masks. The final additive result still leaves 26.70% of detected support unmeasured: this is a useful extension, not full coverage.

## Interpretation and limits

Earlier Composite values remain exactly unchanged. Keeping displayed heights fixed also requires keeping the same reference plane; refitting Plane removal over a larger area would shift the displayed old heights. New pixels can change full-map PV/RMS, and their individual model provenance should remain visible at the lowest evidence tier if this is integrated into the UI.

Observed added-pixel errors are not calibrated uncertainty bounds. The earlier Composite already has errors up to 53.62 nm in this suite; preserving it cannot turn the entire map into a 20 nm-accurate result. Agreement checks share model assumptions and can miss common bias. No model produced an added labelled-defect or outside-part pixel in the initial 48-scene matrix. Full per-case results, including the additive follow-up, are retained so failures cannot disappear into an average.

The practical candidate is an additive stack, with separate provenance for both recovery tiers. The more permissive peer-overlap variant offers only a small further photographic gain and is not needed to demonstrate the model improvement. Browser runtime and UI presentation have not been validated for these additional fits, so this study does not silently enable them in the application.

Compute cost also matters: five models require 30 extra local-window fits in this unoptimized harness. The initial photographic experiment took about 515 seconds while synthetic jobs ran concurrently. That includes all candidate assemblies and checks, but starts from an already computed Composite; it is not an isolated browser benchmark. A UI integration should reuse work and measure browser latency before making this a routine option.

## Reproduction

Use `OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/loupe-mpl` with the repository environment:

```sh
.venv/bin/python scripts/experiment-fringe-model-stack.py --start 0 --stop 24 --output /tmp/model-stack-a.json
.venv/bin/python scripts/experiment-fringe-model-stack.py --start 24 --stop 48 --output /tmp/model-stack-b.json
.venv/bin/python scripts/report-fringe-model-stack.py --inputs /tmp/model-stack-a.json /tmp/model-stack-b.json --output /tmp/model-stack-report --complete
.venv/bin/pytest -q tests/test_fringe_model_stack.py tests/test_fringe_hybrid.py tests/test_fringe_composite.py
```

The default experiment now emits all 12 alternatives. For this recorded study the original 11 were run first, then `--tiered-only` ran the additive follow-up. The reporter's `--tiered-inputs` merges those separate runs without omitting or duplicating cases. Each experiment JSON is written atomically between completed scenes; `--resume` skips completed cases.

For the local photograph, pass `--context /tmp/loupe-next-coverage-linear/context.npz`, an exact saved numeric context from the preceding coverage study. The experiment checks the 448,992-pixel reference and never unpickles diagnostics. `--maps` optionally saves private image/mask/phase/source arrays. The reporter accepts `--photo`, `--tiered-photo`, `--maps`, and a separate `--figures` directory. Keep photographic figures outside the repository: this report includes aggregate measurements but no user image or fit cache.

The focused tests exercise earlier-layer and provenance preservation, unwrapped overlap disagreement, original-anchor connectivity, order-conflict rollback, conflict/aperture exclusion, strictly additive tiers, and second-harmonic phase recovery across tiling seams for both envelope degrees. Source hashes are in [source-sha256.json](source-sha256.json). The shared production Composite and local fitter were not modified in this study.
