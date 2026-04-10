# Gear Common-Mode Refine Loop Design

Date: 2026-04-11
Status: Design spec — not yet planned or implemented. Depends on the
generate-gear-DXF + guided-inspection flow shipped in tasks #51 and #52.

## Motivation

The gear generator takes four user-supplied parameters — `n_teeth`, `module`,
`addendum_coef`, `dedendum_coef` (and `rolling_radius_coef` or
`pressure_angle_deg` depending on profile) — and produces an ideal polyline
that goes into `/inspect-guided` as a DXF overlay. If *any* of those inputs
is slightly wrong, the deviation map that comes back looks like **wear** even
though the teeth are fine: every flank is off in the same direction, every
root is deep by the same amount, every tip is short by the same amount.

This is a classic common-mode / differential-mode decomposition problem:

- **Common mode** — the systematic component that is the same for every
  tooth. This is *parameter error* in the overlay: wrong module (tip-circle
  fit noise), wrong dedendum coefficient (the watch-gear 1.04–1.12 vs the
  industrial 1.25 default), wrong rolling radius (cycloidal curvature
  mismatch), wrong rotation phase (sub-pitch offset).
- **Differential mode** — the per-tooth residual after the common mode is
  removed. This is real manufacturing error or wear.

For the first gear (17-tooth cycloidal) the user manually iterated on the
dedendum coefficient until the corridor overlay sat on the root circle. That
iteration is exactly the loop this spec formalises. On the validation gears
we already know the common mode can be O(30 µm) while the real per-tooth
wear residual is ~1–5 µm, so refinement is load-bearing for the
interpretation of results.

**Filter check:** this is motivated by a real friction point observed during
gear_1 and gear_3 validation. It is not speculative — the common-mode error
shows up on the very next gear the user loads. The refine loop is the
difference between "the report says every tooth is broken" and "the report
identifies the three actually-damaged teeth".

## Scope

### In
- A backend helper `decompose_gear_deviation(inspection_result, n_teeth)`
  that takes the per-feature deviation list from `/inspect-guided` and
  returns:
  - A **common-mode vector** expressed in parameter space (see Components
    below for the list).
  - A **per-tooth residual** inspection result with the common mode removed,
    for display to the user.
  - A **common-mode magnitude** scalar (RMS of the vector components, in
    their native units) for loop termination.
- A refine loop orchestrated on the backend (`POST /refine-gear`) that:
  1. Runs `/inspect-guided` with the current parameters.
  2. Decomposes the result.
  3. Adjusts the parameter vector along the common-mode direction with a
     damped step (initially `α = 0.5`).
  4. Regenerates the DXF overlay via the same path `/generate-gear-dxf`
     uses internally.
  5. Repeats until the common-mode magnitude drops below a termination
     threshold, plateaus between iterations, or a max iteration count is
     hit.
- A frontend "Refine" button next to "Generate overlay" in the gear modal
  that shows iteration count + common-mode magnitude as a live status, and
  on completion replaces the overlay with the refined version and shows the
  residual-only inspection result.
- A result panel that splits the deviation into "systematic correction
  applied" (common mode that was absorbed) and "remaining per-tooth
  residual" (the interesting signal).

### Out (deliberate cuts)
- No joint optimisation across multiple gears in a batch.
- No profile type selection — the refine loop assumes the user has picked
  cycloidal or involute correctly. Picking the wrong profile family will
  fail to converge; we report that and stop rather than try both.
- No per-tooth rotation correction (i.e. individual tooth phase) — the
  refine loop only corrects global rotation. Per-tooth rotation would make
  every tooth look perfect and defeat the purpose.
- No refinement of `n_teeth`. Tooth count comes from the user and must be
  correct before entering the loop.
- No calibration refinement. `pixelsPerMm` is taken as ground truth; errors
  there show up as module error and are absorbed into the module parameter
  with no way to distinguish.

## Components

### 1. Deviation decomposition

Input: the inspection result from `/inspect-guided`, which is a list of
per-polyline-segment entries with a signed deviation value (mm, outward
positive) and the segment's DXF-space endpoints. Because the overlay came
from `/generate-gear-dxf`, every segment's `parent_handle` is
`gear_{profile}_N{n}`, and the `segment_index` field is sequential around
the closed polyline.

The decomposition works in **radial + angular** coordinates about the gear
center `(cx, cy)` that the user supplied to `/generate-gear-dxf`:

```
for each segment (x1,y1)→(x2,y2) with signed deviation d:
    midpoint (mx, my) = ((x1+x2)/2, (y1+y2)/2)
    r_mid = hypot(mx - cx, my - cy)
    θ_mid = atan2(my - cy, mx - cx)
    # bin each segment by its position in the canonical tooth period:
    tooth_phase = (θ_mid - rotation_rad) mod (2π/N)
    region = classify_region(r_mid, tooth_phase)  # flank-L, flank-R, tip, root
```

Each segment lives in exactly one of the four regions per tooth. For a
healthy gear the four regions have a characteristic deviation signature
under each parameter error:

| Parameter too large | flank-L | flank-R | tip    | root   |
|---------------------|---------|---------|--------|--------|
| `module`            | outward | outward | outward| outward|
| `addendum_coef`     | ~zero   | ~zero   | outward| ~zero  |
| `dedendum_coef`     | ~zero   | ~zero   | ~zero  | inward |
| `rolling_coef` (cyc)| curvature-dependent (epicycloid flank bulge vs trough) |
| `pressure_angle`(inv)| same — flank slope vs flank slope |
| `rotation_deg`      | +/-     | -/+     | ~zero  | ~zero  |

So the common-mode extraction is essentially a least-squares fit:

```
minimize Σ_segments ( d_segment - Σ_params J[region, param] · δparam )²
```

where `J` is a Jacobian whose rows are regions and whose columns are the
parameters being refined. The Jacobian is estimated by **finite
differencing the generator**: regenerate the gear with each parameter
perturbed by a small amount, re-project onto the original per-region mean
deviations, and read off the slope. This is slow (one generator call per
parameter per iteration) but trivially correct and avoids hand-derived
partials that will bit-rot when we change generators.

To reduce differencing noise we median-across-teeth before fitting: for
each (region, tooth) pair compute the mean segment deviation, then take
the cross-tooth median per region. This gives one value per region
(four values total) which is what the Jacobian's rows are indexed by.
This median-first step is what rejects actual damage from the common-mode
estimate — a single broken tooth cannot bias the median of 17 values.

### 2. Refine loop

```python
params = initial_params_from_modal
history = []
for iter in range(MAX_ITER):  # MAX_ITER = 8
    overlay = generate_gear(params)
    result = inspect_guided(overlay)
    cm_vector, residual, cm_magnitude = decompose(result, params)
    history.append(cm_magnitude)
    if cm_magnitude < ABSOLUTE_THRESHOLD:   # 5 µm at PCD
        break
    if iter >= 2 and history[-1] > 0.9 * history[-3]:  # plateau
        break
    params = step(params, cm_vector, alpha=0.5)
return {"params": params, "residual": residual, "history": history,
        "iterations": len(history), "converged": cm_magnitude < ABSOLUTE_THRESHOLD}
```

Damping `α = 0.5` is conservative; the initial validation sweep will tell
us whether we can raise it without oscillating. If the common-mode
magnitude *increases* between iterations we halve `α` and retry once
before bailing out.

### 3. API surface

New endpoint on the inspection router:

```python
@insp_router.post("/refine-gear")
async def refine_gear_route(body: RefineGearBody, session_id=...):
    frame = frame_store.get(session_id)
    ...
    return refine_gear_parameters(frame, body)
```

`RefineGearBody` carries the same fields as `GenerateGearBody` plus the
same inspection tolerances and `corridor_px` that `/inspect-guided` takes.
The response shape matches `/inspect-guided` for the residual field (so
existing result-panel rendering works unchanged) plus the refine-specific
fields `refined_params`, `iterations`, `history`, `converged`,
`common_mode_absorbed` (human-readable summary of what was corrected).

### 4. Frontend

- Add a third action button **Refine** to the gear modal next to
  "Measure tooth widths" and "Generate overlay".
- Disabled until a frame is frozen and calibration exists (same as
  Generate overlay).
- On click: show a progress overlay with iteration count + common-mode
  magnitude in µm at PCD, updated via streaming response or polled
  progress endpoint (pick one in the implementation plan — streaming is
  cleaner but needs more plumbing).
- On success: swap in the refined overlay, render the residual-only
  inspection result, and show a small summary chip: "Corrected module by
  +12 µm, dedendum by +0.08, rotation by −0.4°. Residual range: 2–7 µm."
- On non-convergence: leave the original overlay in place, show the
  history, and print a message suggesting the user check the profile
  type and tip-circle fit.

## Architecture

The decomposer lives in `backend/vision/gear_refine.py` as a pure function
that takes the inspection result dict and the parameter dict, returns
`(cm_vector, residual_result, cm_magnitude)`. This is trivially unit
testable with synthetic input — the test suite will build a deliberately
wrong overlay, run the real inspection on a real synthetic frame, and
assert that the decomposer correctly attributes the bias.

The refine orchestrator lives in `backend/api_inspection.py` next to
`/inspect-guided` and `/generate-gear-dxf` since it composes both. It does
not need any new camera or frame-store abstraction — it reuses the session
frame exactly like the existing inspection endpoint.

The frontend changes are confined to `frontend/gear.js` and the modal HTML
already in place. No new state fields — the refine result reuses
`state.inspectionResults` and `state.annotations`' existing dxf-overlay
annotation.

## Testing

1. **Golden synthetic**: render a known gear with parameters `P_true`,
   then call the refiner with `P_0 = P_true + Δ`. Assert that after
   convergence `||P_refined - P_true|| < ε` for a range of Δ.
2. **Damage rejection**: take a synthetic gear and manually displace
   a single tooth radially by 20 µm. Run the refiner. Assert that the
   refined common-mode vector is ~zero (no common-mode error present) and
   the residual cleanly flags the damaged tooth at ~20 µm. This is the
   critical test — if the loop absorbs real damage into its common-mode
   correction the whole feature is worse than useless.
3. **Plateau termination**: feed the refiner a case it cannot solve
   (wrong profile family, cycloidal overlay on involute gear). Assert
   that it terminates within MAX_ITER with `converged: false` and the
   user-visible message explains why.
4. **Jacobian stability**: the finite-difference step size matters. Pick
   a step per parameter that is small enough to be local but large
   enough to be above inspection noise. Add a regression test that pins
   the step sizes and checks Jacobian condition number on a reference
   gear.
5. **Watch-gear regression**: the cached gear_1 and gear_3 inspection
   frames (already in the repo under `snapshots/`) feed directly into
   a non-PR regression test that just asserts the refine loop converges
   with sensible parameters. These are the canonical truth for the
   feature — if it regresses on them we lost something.

## Open questions

1. **Profile-family detection**: we decided above to require the user to
   pick cycloidal vs involute. But a watch-wheel/pinion pair will have
   one cycloidal and one involute-ish tooth; can we auto-detect from the
   initial inspection's residual signature? Not for v1. Flag for later.

2. **Rotation vs sub-pitch phase**: the generator already supports
   `rotation_deg` and the validation script's autophase finds it. Do we
   let the refine loop adjust rotation, or do we freeze it to the
   autophase output and only refine the dimensional parameters? Current
   plan: refine both, but with a different damping coefficient for
   rotation because it's much more sensitive than module. Confirm
   during implementation.

3. **Per-flank vs averaged flank Jacobian rows**: the table in Components
   assumes flank-L and flank-R respond identically to module changes and
   oppositely to rotation. If there's asymmetric pressure angle (one-way
   drive gears) the assumption breaks. Watch gears don't have this but
   industrial gears sometimes do. Park until we get a real one-way gear.

4. **Batch mode**: once this works for a single gear, should we offer a
   "refine across gear library" mode that shares a module parameter
   across gears of the same module? Out of scope for v1, but cheap to
   add later if we want it.

## Success criteria

The feature ships when:
- Golden synthetic test converges for `||Δ|| ≤ 0.15` in each parameter's
  natural scale.
- Damage rejection test leaves single-tooth defects ≥ 15 µm in the
  residual and flags them.
- Running Refine on the gear_1 and gear_3 validation frames produces a
  residual map where the human-eye-obvious damaged teeth are the top-3
  entries in the sorted residual list.
- The Refine button completes in under 15 seconds on the user's hardware
  for a 17-tooth gear at default corridor width.

## Implementation order (for the follow-up plan)

1. `decompose_gear_deviation` pure function + unit tests with synthetic
   input. No endpoint, no frontend.
2. Finite-difference Jacobian helper + stability tests.
3. `refine_gear_parameters` orchestrator (pure function, takes a frame
   and params, returns result dict). Tests with synthetic frames.
4. `/refine-gear` endpoint + integration test that hits it with a real
   snapshot.
5. Frontend button + progress UI.
6. Add the watch-gear regression test using the snapshots.

Each step is independently testable and committable — the first four
steps ship backend value without any frontend changes, so the user can
validate the algorithm from the shell before we touch the UI.
