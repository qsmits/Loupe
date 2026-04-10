# Gear Analysis PoC Design

Date: 2026-04-10
Status: Proof of concept — scoped to validate the core algorithm against a real
manual baseline before committing to a production feature.

## Motivation

This afternoon's session walked a slightly mangled Swiss-watch gear through
Loupe's existing measurement tools: fit tip circle, fit root circle, count
teeth, compute PCD, then measure the angular tooth width at the PCD for all 17
teeth with the 3-click angle tool. Total wall-clock time: roughly ten minutes of
clicking per gear, plus another pass of Pt-Circle distance checks on suspected
bent teeth.

The manual workflow produced a clean, self-consistent ranked damage table
(T3 = 9.93° being the reference, T9 = 8.63° the worst) and a clear physical
interpretation (R-addendum + L-dedendum wear signature typical of cycloidal
watch wheels). The workflow is sound; the labour is avoidable.

This PoC replicates exactly that manual flow as a one-button operation, so we
can decide — based on seeing it work on a second and third gear — whether to
invest in a fuller "Gear Inspection" tool.

**Filter check:** unlike the parked fringe-analysis idea, this is motivated by a
completed manual workflow under real conditions, with a pipeline of real gears
queued up. If the PoC lands cleanly, the "what recurring pain does this fix?"
question has a concrete answer.

## Scope

### In
- Sidebar **Analyze Gear** button.
- Click flow: pick the tip circle annotation → pick the root circle annotation
  → type tooth count N → Go.
- Backend endpoint `POST /analyze-gear` that takes the frozen grayscale frame,
  `(cx, cy)`, `tip_r`, `root_r`, `n_teeth` and returns one entry per tooth
  with angular width in degrees and the L/R flank crossing angles on the PCD.
- Frontend overlay: PCD circle + per-tooth L→R arc on the canvas, labelled with
  the tooth index.
- Sidebar results panel: sortable table with tooth#, angular width °, Δ° vs
  best tooth, Δµm at PCD (using the active calibration).

### Out (deliberate PoC cuts)
- No auto-detection of which circle annotations are tip vs root — the user
  picks them.
- No Pt-Circle tip-bend check in the wizard — the existing manual tool covers
  it.
- No CSV/PDF export — the results panel is read-only. Copy-paste is fine for
  a PoC.
- No tolerance-band tagging or pass/fail colouring.
- No profile fitting (involute/cycloidal), no module estimation, no bore
  concentricity check.
- No multi-gear handling — one gear per frozen frame.
- No live-video mode — frozen frame only.
- No runtime override for PCD — uses `(tip_r + root_r) / 2` as first pass.

## Architecture

### Backend

**`backend/vision/gear_analysis.py`** — new, pure numpy/OpenCV module:

```python
def analyze_gear(
    gray: np.ndarray,
    cx: float, cy: float,
    tip_r: float, root_r: float,
    n_teeth: int,
) -> dict
```

Returns:

```json
{
  "pcd_radius_px": 74.2,
  "teeth": [
    {"index": 1, "l_angle_deg": 3.15, "r_angle_deg": 12.48,
     "center_angle_deg": 7.82, "angular_width_deg": 9.33},
    ...
  ]
}
```

Pure function. No global state. No I/O. Easy to unit-test.

**`backend/api.py`** — add one endpoint:

```
POST /analyze-gear
body: { cx, cy, tip_r, root_r, n_teeth }
```

Pulls the current frozen frame from `frame_store`, converts to grayscale, calls
`analyze_gear()`, returns the result. Fails with 400 if no frame is frozen.

### Frontend

**`frontend/gear.js`** — new small module:
- `startGearAnalysis()` — enters a short modal click-flow state.
- Click 1: user clicks a circle annotation → locks it as `tipCircle`.
- Click 2: user clicks a second circle annotation → locks it as `rootCircle`.
- Then: prompt for N (numeric input, min 6 max 300).
- POSTs to `/analyze-gear`, stores the result in `state.gearAnalysis`.
- Renders PCD + per-tooth arcs on canvas.
- Populates the sidebar results panel.

**`frontend/main.js`** — wire the Analyze Gear button to `startGearAnalysis()`.

**`frontend/sidebar.js`** — add the button and a "Gear Analysis" collapsible
section that renders the results table from `state.gearAnalysis`.

**`frontend/state.js`** — add `state.gearAnalysis = null` plus a small flag
for the click-flow mode (`state.gearPickMode`). Clear both on clearAll().

**`frontend/render.js`** — add a `drawGearAnalysis(ctx)` hook called at the
end of the annotation render pass; draws PCD and L→R arcs from
`state.gearAnalysis`.

## Algorithm

1. **Compute PCD radius**: `pcd_r = (tip_r + root_r) / 2`.
   First-pass approximation. Acceptably close to the module-derived PCD for
   small-module watch gears (M<0.2). Self-consistent across teeth, so the
   *ranking* is correct even if absolute values drift.
2. **Sample profile along PCD**: for `k` in `0..K-1` with `K = 7200`
   (step = 0.05°):
   ```
   θ = 2π k / K
   x = cx + pcd_r * cos(θ)
   y = cy + pcd_r * sin(θ)
   profile[k] = bilinear_sample(gray, x, y)
   ```
3. **Smooth**: 5-tap boxcar over the profile to reject sensor noise without
   wiping out the sharp flank edges.
4. **Binarize**: Otsu threshold on the smoothed profile. The backlit-gear
   images have excellent contrast so this is robust.
5. **Find runs**: contiguous "material" runs in the binarized circular profile
   (handle wrap-around across index 0). Sort by length, keep the top N. If
   fewer than N runs are found, return an error result (we'll surface it in
   the UI).
6. **Sub-pixel flank crossings**: for each run's L and R boundary, read the raw
   (unsmoothed) profile samples around the crossing and linearly interpolate
   against the Otsu threshold value to get a fractional index. Convert to
   angle via `θ = 2π * frac_index / K`.
7. **Normalize angles**: set L and R to degrees in `[0, 360)`, handle the
   wrap-around case where a tooth straddles 0°.
8. **Sort teeth by center angle** and assign indices starting at the tooth
   closest to angle 0° (top of image in image coordinates, matching how the
   user numbered them manually).
9. **Return** the list.

### Failure modes the algorithm will not handle
- Gears whose addenda have been worn down below the PCD on most teeth
  (no material crossing the PCD at all). Not the current test gear.
- Gears with severe bore offset → radial asymmetry. The PoC assumes
  `(cx, cy)` is accurate; the user provides it via the circle fits.
- Low contrast, non-backlit imaging. Assumes backlit silhouette.
- Overlapping teeth in the image (two gears in the frame, debris etc.).

## Acceptance Test

Use the gear currently under the scope. Compare the automatic angular width
values to the manual values captured this session for the clean reference teeth.

| Tooth | Manual ° |
|-------|----------|
| T3    | 9.93     |
| T5    | 9.38     |
| T11   | 9.07     |
| T13   | 9.37     |

**Pass**: all four within ±0.1° of the manual reading.
**Soft pass**: all four self-consistent (same relative ordering) but with a
  systematic offset; update the spec to note the PCD approximation as the
  likely source.
**Fail**: ordering disagrees with the manual run on any clean tooth. In that
  case, commit whatever was built, disable the button, and leave a status
  note so the user doesn't come back to a broken UI.

## Files Touched

- **new**: `backend/vision/gear_analysis.py`
- **new**: `frontend/gear.js`
- **edit**: `backend/api.py` (one new endpoint)
- **edit**: `frontend/main.js` (wire button)
- **edit**: `frontend/sidebar.js` (button + results panel)
- **edit**: `frontend/state.js` (two new state fields)
- **edit**: `frontend/render.js` (one draw hook)
- **edit**: `frontend/index.html` (one button)

No other files. Blast radius is contained.

## Not Doing

- Not adding tests to `tests/` — this is a PoC, we'll add tests when/if it
  graduates.
- Not refactoring any existing code.
- Not touching calibration, hosted-mode guards, camera code, DXF code, or
  inspection code.
- Not creating a new "Gear mode". This is a tool inside microscope mode.

## Open Questions

None that block implementation. Everything parked for V2:
- Manual PCD override
- Module estimation / reporting
- Per-tooth tolerance colours
- Export formats
- Wizard-style modal vs inline click flow
- Gear sidebar panel location / collapsibility defaults
