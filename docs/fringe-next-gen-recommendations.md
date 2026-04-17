# Next-Generation Fringe Recommendations

Updated 2026-04-14.

This note steps back from DFTFringe as the reference target and focuses on what
Loupe's fringe mode could do better for its real use case:

- optical flats on lapped / polished metal parts
- arbitrary part geometry rather than mostly circular optical pupils
- repeatable inspection workflows rather than one-off optical analysis

The question is not "how do we copy DFTFringe?" but "what can Loupe do better
because it already has microscope-mode geometry, live camera workflows, and
part-inspection context?"

## Core idea

DFTFringe is a strong optical analysis tool, but Loupe can surpass it by being:

- more geometry-aware
- more confidence-aware
- more automation-friendly
- more manufacturing-oriented
- better integrated across modes

## Highest-value recommendations

### 1. Geometry-aware masking and apertures

This is the strongest improvement opportunity.

Instead of relying mainly on brightness + modulation masks, Loupe should support:

- saved ROIs for repeated measurements
- polygon apertures and exclusion zones
- DXF-derived analysis masks
- masks snapped to detected part boundaries
- hole / cutout / slot exclusion regions
- template masks tied to part recipes

Why this is better than DFTFringe:

- DFTFringe is optimized around mirror-like optical pupils
- Loupe can define the actual functional measurement area of a metal part
- better masks improve every downstream step: phase extraction, unwrapping,
  form removal, statistics, and reporting

## 2. Confidence and uncertainty reporting

Most fringe pipelines produce a surface map but do not explain how trustworthy
it is. Loupe should expose analysis confidence explicitly.

Recommended outputs:

- carrier-confidence metric
- unwrap-confidence / unwrap-risk map
- low-modulation warning map
- edge-contamination map
- repeatability map across captures
- "trusted area" coverage percentage

Why this matters:

- manufactured parts often have edges, scratches, contamination, mixed reflectivity,
  and localized bad fringe contrast
- users need to know where the result is reliable, not just what the result is

## 3. Robust averaging and capture rejection

Loupe already has a concept of averaging. It can go much further.

Recommended improvements:

- reject bad captures automatically based on RMS, carrier confidence, coverage,
  or consistency against prior captures
- support robust averaging methods:
  median, trimmed mean, or Huber-weighted mean
- report convergence:
  "after N captures the result changed by X nm"
- show per-pixel standard deviation across captures
- keep a list of accepted vs rejected captures with reasons

Why this is better than DFTFringe:

- it turns averaging into a repeatability tool instead of just a smoothing tool
- it matches bench and shop workflows where users often take several captures
  and want to know whether they agree

## 4. Quality-guided unwrapping with part-specific heuristics

Loupe should move beyond generic 2D unwrapping and use a quality-driven unwrap
tailored to interferograms of manufactured parts.

Useful quality signals:

- fringe modulation
- local wrapped-phase variance
- carrier confidence
- distance from mask boundary
- dust / saturation / glare detection
- neighborhood consistency

A stronger unwrap strategy would:

- start from the cleanest seed regions
- expand into lower-confidence areas gradually
- avoid crossing weak or contaminated boundaries too early
- surface probable unwrap-error regions back to the UI

This is one of the clearest places to improve on older optical software.

## 5. Multiple form-removal models beyond Zernike-first

Zernikes are useful, but they should not dominate the UX for metal parts.

Recommended form-removal options:

- piston / tilt removal
- best-fit plane
- best-fit paraboloid or simple curvature model
- low-order polynomial surface removal
- optional Zernike subtraction for advanced users
- recipe-driven defaults by part type

Why this matters:

- for manufactured surfaces, users usually care about flatness relative to a
  practical datum or low-order form
- the natural language of the result should be "surface deviation" and
  "functional flatness", not primarily optical aberration terms

## 6. Smarter carrier estimation and demodulation

Loupe can modernize the DFT stage beyond the classic manual center-filter model.

Recommended upgrades:

- subpixel carrier peak estimation
- confidence-ranked alternate carrier candidates
- adaptive demodulation bandwidth
- automatic retry when the primary carrier looks weak
- optional local-carrier estimation when fringe orientation drifts over the field
- user-facing diagnostics when the detected carrier is too close to DC or too weak

This should reduce operator burden while still allowing manual correction when needed.

## 7. Cross-mode integration

This is where Loupe can do things DFTFringe fundamentally could not do.

Recommended integrations:

- reuse microscope calibration so fringe maps have physical scale
- reuse aligned DXF overlays as fringe apertures
- overlay microscope annotations onto fringe results
- correlate visible image features with fringe anomalies
- save fringe setups as part-specific inspection recipes
- share measurement datums and coordinate frames across modes

This is likely the biggest product-level differentiator.

## 8. Inspection-oriented outputs

Loupe should emphasize outputs that help users decide whether a part is good.

Examples:

- flatness over the selected functional area
- high / low spot localization
- line profiles along critical paths
- comparison against a reference or golden sample
- pass / fail against configured tolerances
- trend-over-time plots for repeat production checks

These outputs are often more valuable to part inspection than a deeper optical
aberration decomposition.

## Suggested priority order

If the goal is maximum real-world impact, implement in roughly this order:

1. geometry-aware masks and DXF-driven apertures
2. confidence / uncertainty visualization
3. robust averaging with rejection and repeatability metrics
4. quality-guided unwrapping
5. alternative form-removal models beyond Zernikes
6. improved carrier estimation and manual override
7. inspection-oriented reporting and tolerancing
8. deeper optional optical analysis for advanced users

## Repo-oriented implementation suggestions

Likely backend areas:

- [`backend/vision/fringe.py`](/Users/qsmits/Projects/MainDynamics/microscope/backend/vision/fringe.py)
  for masking, carrier analysis, unwrap logic, confidence metrics, and averaging
- [`backend/api_fringe.py`](/Users/qsmits/Projects/MainDynamics/microscope/backend/api_fringe.py)
  for exposing new options and diagnostics

Likely frontend areas:

- [`frontend/fringe.js`](/Users/qsmits/Projects/MainDynamics/microscope/frontend/fringe.js)
  for diagnostics, mask tools, confidence display, averaging UX, and recipe controls
- [`frontend/index.html`](/Users/qsmits/Projects/MainDynamics/microscope/frontend/index.html)
  for new controls, help text, and part-oriented reporting panels

Likely cross-mode work:

- microscope/fringe sharing of ROI, DXF, and calibration state
- saved part recipes in config or session storage

## Summary

The best path forward is not to become a browser clone of DFTFringe.

The best path is to use modern automation plus Loupe's own multi-mode context to
build a fringe workflow that is:

- more robust on arbitrary metal-part geometry
- more transparent about confidence and failure modes
- more repeatable across multiple captures
- more useful for pass/fail inspection decisions
- better integrated with the rest of the app
