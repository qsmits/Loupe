# Fringe Mode Design Derived from DFTFringe

Updated 2026-04-17.

This document turns the DFTFringe review into a concrete design for Loupe's
fringe mode. The goal is to borrow the mature parts of DFTFringe's approach
without inheriting its telescope-optics worldview or its desktop-era UX.

This is not a porting plan. It is a design for a small-part metrology workflow
that happens to learn from a mature interferometry codebase.

## Problem statement

Today Loupe's fringe mode is strongest when all of the following are true:

- the interferogram is a single, smooth, continuous surface
- the useful aperture is easy to infer from brightness and modulation
- the carrier is obvious
- the user wants a quick answer from one frame

That is a good baseline for optical-flat inspection on polished parts, but it is
not yet a complete metrology workflow. The current failure modes are mostly
about hidden assumptions:

- the mask is image-derived rather than geometry-derived
- the DFT choice is mostly automatic and opaque
- the unwrap is not confidence-driven enough
- averaging trusts bad frames too much
- form removal is still more optics-centric than part-centric
- discontinuous or ambiguous measurements are forced through the same pipeline

DFTFringe shows a more mature stance:

- define geometry explicitly
- let the operator inspect Fourier choices
- unwrap in quality order
- expose diagnostics
- switch measurement mode when physics demands it

That is the template this design follows.

## Design goals

1. Make smooth-surface measurements more trustworthy on real parts.
2. Make failure modes visible before users trust a bad map.
3. Support repeatable bench workflows, not just one-off captures.
4. Keep the default flow fast and simple for ordinary flat inspection.
5. Add dedicated workflows for ambiguous measurements instead of pretending one
   single-shot pipeline can solve everything.

## Non-goals

- Recreating DFTFringe's mirror-centric UI, annular-first geometry model, or
  optical-aberration-heavy terminology.
- Making large-step single-shot spatial-carrier measurements look "solved" when
  the physics is ambiguous.
- Building full telescope-style annular Zernike support ahead of geometry,
  confidence, and repeatability work that matters more for Loupe's use case.

## What we borrow from DFTFringe

### 1. Geometry as a first-class input

DFTFringe builds its analysis around explicit outlines, obstructions, and
exclusion polygons before it trusts the Fourier pipeline. Loupe should do the
same, but with part-oriented geometry:

- polygon measurement apertures
- exclusion polygons
- saved ROIs
- DXF-derived masks
- part-boundary-assisted masks
- optional circle / ellipse tools when they actually help

The core idea to borrow is not "circles." It is "the measurement domain should
usually be defined on purpose."

### 2. Inspectable DFT choices

DFTFringe exposes its center-filter choice and lets the user inspect it. Loupe
should keep stronger automation, but the carrier choice must become visible and
adjustable:

- show the detected carrier peak
- show alternate plausible peaks
- show period, angle, distance from DC, and confidence
- allow manual override and saved setup defaults
- surface warnings when the chosen peak is weak, too close to DC, or unstable

### 3. Quality-guided unwrapping

DFTFringe's unwrap logic is driven by a quality map. Loupe should adopt the same
principle, but with quality signals that match our parts:

- modulation strength
- local wrapped-phase consistency
- distance from aperture edge
- saturation / glare detection
- dust or contamination heuristics
- carrier-confidence consistency

### 4. Diagnostics that help users distrust the result intelligently

DFTFringe exposes more of the analysis state. Loupe should do the same in a way
that fits a browser workflow:

- trusted-area percentage
- carrier-confidence score
- unwrap-risk map
- low-modulation overlay
- edge-contamination overlay
- accepted vs rejected captures in an averaging run

### 5. Separate workflows when physics changes

One of the most important lessons from DFTFringe is not in its single-frame DFT
path. It is in the fact that it also has PSI workflows. Mature tools switch
measurement modes when the problem changes.

Loupe should explicitly split:

- single-shot spatial-carrier analysis for smooth continuous surfaces
- small-step region-comparison workflows for sub-`lambda/4` steps
- future multi-frame or multi-wavelength workflows for ambiguous or larger steps

## What we do not borrow literally

### 1. Circle-first geometry

Loupe's default geometry should describe machined parts, not telescope pupils.
Circle and ellipse tools belong in the toolbox, not at the center of the model.

### 2. Zernike-first UX

For Loupe, the primary language should be:

- height map
- flatness
- plane / curvature / low-order form removal
- datum-relative measurements
- repeatability and confidence

Zernikes stay available for advanced users, but they should not define the main
workflow or mental model.

### 3. Single-shot heroics for fundamentally ambiguous cases

We should not keep piling cleanup heuristics onto a single-shot DFT pipeline and
call that step metrology. When the ambiguity is real, the product should say so
and route users toward the right workflow.

## Target architecture

The design is organized into six layers.

### 1. Geometry layer

Responsibility:

- define the valid measurement domain
- carry that domain consistently through analysis, display, and reanalysis

Core outputs:

- analysis mask
- exclusion mask
- optional named regions of interest
- saved geometry recipe

Primary implementation areas:

- [`frontend/fringe.js`](../frontend/fringe.js)
- [`frontend/fringe-panel.js`](../frontend/fringe-panel.js)
- [`frontend/fringe-results.js`](../frontend/fringe-results.js)
- [`backend/api_fringe.py`](../backend/api_fringe.py)
- [`backend/vision/fringe.py`](../backend/vision/fringe.py)

### 2. Carrier layer

Responsibility:

- detect and validate the carrier
- expose alternate candidates and confidence
- persist user overrides per setup

Core outputs:

- chosen carrier
- candidate carriers
- carrier confidence metrics
- recommended demodulation bandwidth

Primary implementation area:

- [`backend/vision/fringe.py`](../backend/vision/fringe.py)

### 3. Demodulation and unwrap layer

Responsibility:

- demodulate with bandwidth and orientation appropriate to the chosen carrier
- unwrap in confidence order
- preserve sharp structure when the method should preserve it
- report likely-risk regions instead of burying them

Core outputs:

- wrapped phase
- unwrapped phase
- unwrap risk / confidence map
- demodulation quality metrics

Primary implementation area:

- [`backend/vision/fringe.py`](../backend/vision/fringe.py)

### 4. Surface-model layer

Responsibility:

- convert phase to height
- support multiple removal models
- keep raw and fitted surfaces distinct

Core outputs:

- raw height map
- fitted low-order model
- residual height map
- metadata describing which model is active

Supported model families:

- piston / tilt
- best-fit plane
- simple curvature / paraboloid
- low-order polynomial
- optional Zernike subtraction

Primary implementation areas:

- [`backend/vision/fringe.py`](../backend/vision/fringe.py)
- [`frontend/fringe-results.js`](../frontend/fringe-results.js)

### 5. Confidence and repeatability layer

Responsibility:

- tell the user which parts of the result are trustworthy
- support multi-capture repeatability workflows

Core outputs:

- trusted-area percentage
- capture rejection reasons
- per-pixel spread across captures
- analysis warnings

Primary implementation areas:

- [`backend/vision/fringe.py`](../backend/vision/fringe.py)
- [`backend/api_fringe.py`](../backend/api_fringe.py)
- [`frontend/fringe-results.js`](../frontend/fringe-results.js)

### 6. Measurement workflow layer

Responsibility:

- present tools appropriate to the measurement physics
- keep the UI honest about what each tool can and cannot claim

Core workflows:

- smooth-surface map
- area and profile measurements
- small-step dual-region comparison
- averaging with rejection
- future guided workflows for multi-frame / multi-wavelength step analysis

Primary implementation areas:

- [`frontend/fringe-measure.js`](../frontend/fringe-measure.js)
- [`frontend/fringe-results.js`](../frontend/fringe-results.js)
- [`frontend/index.html`](../frontend/index.html)

## Data model changes

The backend response model should become more explicit about what it is
returning. At minimum, every analysis result should distinguish:

- `raw_height_grid_nm`: directly recovered surface before low-order subtraction
- `fit_height_grid_nm`: the currently selected fitted model, if any
- `display_height_grid_nm`: the grid used by the UI right now
- `analysis_mask`
- `trusted_mask`
- `carrier_info`
- `unwrap_info`
- `warnings`

This avoids a recurring source of bugs where the UI displays one surface while a
measurement tool or reanalysis path uses another.

## Proposed workflows

### Smooth surface workflow

Use case:

- optical flats
- lapped and polished part surfaces
- gentle bumps or low-order form

Default behavior:

- apply explicit geometry if provided, otherwise use auto-mask plus warning
- auto-detect carrier and show diagnostics
- quality-guided unwrap
- display raw surface plus optional removable fit terms
- allow averaging with rejection

### Small-step workflow

Use case:

- steps smaller than the single-wavelength ambiguity limit
- region-to-region comparisons away from the step edge

Behavior:

- disable step-hostile cleanup by default for this mode
- require two plateau regions
- compute region means, scatter, and distance from edge
- warn when the measured step approaches ambiguity limits or the regions cross
  low-confidence pixels

Important constraint:

This is not a general single-shot large-step workflow. The UI should say so
clearly.

### Large-step / ambiguous-height workflow

Use case:

- steps near or above the single-shot ambiguity limit
- cases where absolute plateau offset cannot be inferred from one wavelength

Near-term product stance:

- explicitly warn that single-shot results are ambiguous
- do not imply traceable large-step metrology

Longer-term direction:

- multi-wavelength workflow
- phase-shifting workflow
- guided dual-analysis or calibration workflows if they can be physically
  justified and validated

## Recommended implementation phases

### Phase 1: Make the current single-shot pipeline more inspectable

Outcome:

- users can see why the pipeline chose a carrier and how trustworthy it is
- reanalysis and measurement tools stay in sync

Scope:

- carrier diagnostics panel
- alternate carrier candidates
- trusted-area and unwrap-risk outputs
- persistent carrier overrides
- explicit raw vs display surface metadata

Acceptance criteria:

- every analysis result exposes carrier confidence and trusted-area metrics
- every measurement tool reads the same grid that the display is using
- tests cover reanalysis consistency and carrier override round-trips

### Phase 2: Make geometry explicit

Outcome:

- the measurement domain is defined intentionally for repeated work

Scope:

- saved polygon aperture
- exclusion regions
- mask import from DXF-derived regions or shared microscope ROI
- recipe persistence

Acceptance criteria:

- the same geometry can be reused across captures and sessions
- backend analysis does not silently fall back to full-frame when geometry is
  provided
- tests cover mask round-trips and geometry-aware stats

### Phase 3: Replace generic unwrap with quality-guided unwrap

Outcome:

- better resilience near weak fringes, edges, glare, and partial contamination

Scope:

- quality map generation
- seed selection
- unwrap in descending quality order
- unwrap-risk map returned to the UI

Acceptance criteria:

- synthetic tests show fewer unwrap failures under edge contamination
- diagnostics identify low-confidence regions instead of smoothing them away

### Phase 4: Add robust averaging and repeatability workflows

Outcome:

- averaging becomes a metrology aid instead of just a smoother

Scope:

- accepted / rejected frame list
- rejection thresholds with reasons
- per-pixel spread
- convergence summary

Acceptance criteria:

- bad captures can be automatically excluded
- UI shows why captures were rejected
- repeatability metrics are available in exported results

### Phase 5: Add dedicated ambiguous-height workflows

Outcome:

- Loupe stops pretending that all surfaces are solvable by one single-shot path

Scope:

- guided small-step measurement mode
- explicit large-step ambiguity warnings
- design groundwork for multi-wavelength or PSI analysis

Acceptance criteria:

- the UI clearly differentiates small-step and ambiguous-height workflows
- tests verify that ambiguous cases are flagged rather than misrepresented

## Recommended backend changes

### `backend/vision/fringe.py`

Near-term changes:

- factor geometry handling into reusable helpers
- separate raw, fitted, and display surfaces in the analysis result
- add candidate-carrier ranking and confidence metrics
- add unwrap-quality and trusted-mask outputs

Medium-term changes:

- implement a quality-guided unwrap path
- add robust averaging helpers and capture rejection logic
- keep step-oriented paths separate from smooth-surface defaults

### `backend/api_fringe.py`

Near-term changes:

- accept explicit geometry payloads and saved recipe references
- expose richer diagnostics in API responses
- keep response contracts explicit about which surface each consumer should use

Medium-term changes:

- add averaging session endpoints or richer batch payloads
- prepare an API shape for future multi-frame measurement modes

## Recommended frontend changes

### `frontend/fringe.js`

- own geometry state and saved recipe state
- coordinate cross-mode sharing of ROI / DXF / calibration context
- manage capture-session state for averaging workflows

### `frontend/fringe-panel.js`

- expose geometry tools and saved recipe controls
- present warnings when the analysis is running without explicit geometry
- let users switch clearly between surface and step workflows

### `frontend/fringe-results.js`

- add a diagnostics panel for carrier, unwrap, trust, and capture rejection
- keep raw vs fitted vs display surfaces visible in the UI model
- make reanalysis state explicit and lossless

### `frontend/fringe-measure.js`

- keep measurement tools tied to the active display grid
- report confidence-aware measurement summaries
- distinguish "scatter in sampled region" from full uncertainty
- support named measurement regions for repeated checks

## Test strategy

The next wave of tests should be organized by physics, not only by code path.

### Synthetic analysis tests

- known tilt sign and magnitude
- known smooth bump sign and amplitude
- wavelength scaling invariance for controlled non-ambiguous cases
- carrier-choice stability under brightness gradients and partial apertures
- geometry-aware masking correctness

### Failure-mode tests

- weak-carrier warnings
- unwrap-risk localization
- empty or nearly empty trusted mask behavior
- reanalysis consistency between displayed and measured surfaces
- explicit ambiguity warnings for large-step single-shot cases

### Session and workflow tests

- saved geometry recipe round-trips
- averaging rejection behavior
- measurement-tool consistency after reanalysis
- dropped-image vs live-camera state consistency

### Bench validation protocol

Use the real artifacts already available in the lab:

- three-flat closure with certified flats
- repeatability runs on a stable flat pair
- gauge-block small-step checks using region means away from the edge
- explicit null checks before any laddered step validation

This should live next to the automated tests, not as tribal knowledge.

## Product stance

Loupe should aim to be:

- more geometry-aware than DFTFringe
- more confidence-aware than DFTFringe
- better integrated with microscope-mode context than DFTFringe
- more honest than DFTFringe-era tools about which measurements are ambiguous

The point is not to become a browser clone of a legacy optical desktop app.
The point is to combine DFTFringe's mature interferometry instincts with Loupe's
own strengths:

- part-centric geometry
- live camera integration
- browser-based accessibility
- recipe-driven inspection workflows

## Recommended first milestone

If we want the highest-value first milestone, it should include:

1. explicit geometry masks and saved recipes
2. carrier diagnostics plus manual override
3. raw vs fitted vs display surface separation
4. trusted-area / unwrap-risk outputs

That gives users a much stronger and more inspectable smooth-surface tool before
we take on the bigger work of a new unwrap engine or multi-frame workflows.
