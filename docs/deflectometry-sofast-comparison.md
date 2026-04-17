# Deflectometry Mode vs SOFAST / OpenCSP

Updated 2026-04-15.

This note compares Loupe's current deflectometry mode with Sandia's SOFAST 2.0
implementation in OpenCSP. The purpose is not to clone SOFAST. SOFAST is a
large, laboratory-grade CSP mirror characterization system; Loupe is a browser
based bench tool for small shops and small specular parts. The useful question
is: which SOFAST ideas improve Loupe's repeatability, traceability, and
metrological honesty without making the workflow too heavy?

Reference material inspected:

- OpenCSP source, shallow clone from `https://github.com/sandialabs/OpenCSP`.
- `example/sofast_fringe/example_process_single_facet.py`
- `opencsp/app/sofast/lib/ProcessSofastFringe.py`
- `opencsp/app/sofast/lib/MeasurementSofastFringe.py`
- `opencsp/app/sofast/lib/Fringes.py`
- `opencsp/app/sofast/lib/ImageCalibrationScaling.py`
- `opencsp/common/lib/deflectometry/SlopeSolver.py`
- `opencsp/common/lib/deflectometry/Surface2DParabolic.py`
- Official docs and reports linked from the OpenCSP / SOFAST pages.

## Current Loupe Deflectometry Pipeline

The current Loupe implementation is compact and practical:

- uses an iPad/browser page as the sinusoidal fringe display
- captures x and y fringe orientations
- uses 8 phase shifts per orientation for harmonic suppression
- supports inverse gamma pre-correction when generating patterns
- supports flat-field capture and optional reference/baseline subtraction
- extracts wrapped phase with a generalized N-step formula
- unwraps x along image columns and y along image rows
- removes a best-fit tilt plane from phase maps
- builds a validity mask from x/y fringe modulation
- provides smoothing control and an automatic smoothing estimate
- integrates the two phase/slope-like fields with Frankot-Chellappa
- supports sphere-based height calibration
- renders phase maps, diagnostics, and a 3D height view

The backend center of gravity is
[`backend/vision/deflectometry.py`](/Users/qsmits/Projects/MainDynamics/microscope/backend/vision/deflectometry.py).
The workflow API is in
[`backend/api_deflectometry.py`](/Users/qsmits/Projects/MainDynamics/microscope/backend/api_deflectometry.py),
and the UI is in
[`frontend/deflectometry.js`](/Users/qsmits/Projects/MainDynamics/microscope/frontend/deflectometry.js).

This is a good "get useful relative surface information quickly" pipeline. It
is especially appropriate for experiments, process comparison, and small-part
screening.

## What SOFAST Does Differently

SOFAST is built around calibrated slope recovery rather than direct relative
height visualization. Its main architectural distinction is that it treats the
measurement as a geometric optical system:

- `MeasurementSofastFringe` stores mask images, captured fringe stacks, fringe
  periods, optic-screen distance, timestamp, and measurement metadata.
- `Fringes` projects multiple spatial periods per axis, with four phase shifts
  per period. Multiple periods help determine absolute screen coordinates, not
  only wrapped phase.
- `ImageCalibrationScaling` converts captured camera values back toward display
  values using mask/dark/light images and a response curve.
- `DisplayShape` maps fractional screen coordinates to physical display points,
  including display distortion/shape.
- `SpatialOrientation` carries camera, optic, and screen pose.
- `ProcessSofastFringe` turns calibrated fringe phase into physical screen
  points, camera pointing vectors, optic geometry, masks, and bad-pixel maps.
- `SlopeSolver` uses camera rays, reconstructed screen points, optic/screen
  position, and a surface model to solve for surface slopes.
- `Surface2DParabolic` and related surface classes fit a surface model and use
  robust least squares where requested.
- Output is organized around orthorectified slope maps, slope deviation maps,
  curvature, ray trace behavior, and saved HDF5 calculation products.

The important difference: SOFAST is not merely converting phase maps to a height
map. It reconstructs where each camera pixel is seeing on the display, uses a
calibrated geometry model, and solves the reflection problem to get slopes in
physical coordinates.

## Domain Fit

SOFAST's native target is CSP mirrors, heliostat facets, dishes, and related
large optics. Loupe's likely target is much smaller:

- polished or lapped metal surfaces
- small specular parts
- benchtop fixtures
- relative comparison between parts/processes
- possibly simple reference artifacts such as flats and spheres

That means Loupe should borrow SOFAST's concepts selectively:

- Borrow: calibration separation, slope-first outputs, display/camera geometry,
  diagnostic artifacts, repeatability reporting, structured session data.
- Be careful with: multi-facet heliostat models, sun-source ray-trace outputs,
  large HDF workflows, heavy desktop/lab UI assumptions.
- Avoid for now: trying to vendor OpenCSP into Loupe or matching SOFAST feature
  for feature.

## Biggest Loupe Gaps

### 1. Phase Is Treated Like Slope Without Enough Geometry

Loupe currently passes the two unwrapped phase maps into Frankot-Chellappa as
`dzdx` and `dzdy`. That can be useful for relative visualization, but it is not
yet a physically calibrated deflectometry slope solution.

In true deflectometry, the measured phase identifies the display coordinate
seen by each surface point. With camera pose, display pose, and surface geometry,
that becomes a surface normal/slope. Loupe's sphere calibration partly patches
the scale, but it does not replace the geometric model.

Practical risk: absolute height in microns may look more authoritative than the
current model deserves, especially away from the calibration condition.

### 2. Only One Spatial Frequency Is Used

Loupe displays one frequency per axis, with 8 phase shifts. SOFAST uses multiple
periods per axis. The high frequency gives precision; lower frequencies help
resolve absolute screen location and unwrap ambiguity.

Practical risk: Loupe can be precise locally while still being fragile around
large slopes, discontinuities, weak modulation, or geometry changes.

### 3. Display Geometry Is Mostly a Pixel Pitch Setting

Loupe lets the user choose display pixel pitch and gamma. SOFAST has display
shape and screen-coordinate calibration so fractional screen phase can become a
physical point on the display.

Practical risk: iPad position, screen scale, camera angle, browser viewport,
and display distortion are all collapsed into a simple setting.

### 4. Camera Calibration Is Not Integrated Into Deflectometry

Loupe has lens calibration elsewhere in the app, but deflectometry does not yet
appear to use a full camera model to convert active pixels into rays for the
slope solution.

Practical risk: phase maps are computed in image coordinates, but the real
measurement is angular. Lens distortion and camera pose can leak into slope and
height.

### 5. Output Is Height-First

Loupe's marquee result is an integrated 3D height map. SOFAST's metrology center
is slope: x slope, y slope, slope magnitude, slope deviation, curvature, and
then higher-level optical behavior.

Practical risk: integration can hide low-frequency slope errors, boundary
effects, and non-integrable artifacts. Slope maps are closer to the raw
deflectometry measurement and should be first-class.

### 6. Masking Is Good But Not Yet Geometry-Aware

Loupe uses modulation thresholding, which is useful. SOFAST uses mask images,
largest-area filtering, optic/facet geometry, refined boundaries, and bad-pixel
maps.

Practical risk: rim artifacts, background reflections, holes, clips, and
specular dropouts can affect unwrapping, integration, and stats.

### 7. Diagnostics Exist But Do Not Yet Explain Validity

Loupe's diagnostics tab already shows raw frames, modulation, wrapped phase, and
unwrapped phase. SOFAST saves a broader calculation record: masks, screen
points, bad pixels, geometry errors, slope solver data, and output figures.

Practical risk: when Loupe gives a bad result, the user can see that something
looks wrong but not always why.

## Recommended Improvement Plan

### Phase 1 - Make Current Results More Honest and Discussable

These are low-risk improvements that do not require a full SOFAST-style geometry
solver.

1. Add slope-first result tabs.
   Show X phase/slope, Y phase/slope, slope magnitude, and curl/integrability
   residual before the integrated height map.

2. Rename or qualify units when uncalibrated.
   Make it explicit when the output is "phase-radian integrated height proxy"
   versus calibrated microns.

3. Add a deflectometry quality summary.
   Include modulation coverage, low-modulation fraction, clipped-pixel fraction,
   mask area, unwrap/jump risk, and integration residual.

4. Save structured diagnostics for a run.
   Add one JSON payload per run with acquisition settings, mask threshold,
   smoothing, frequency, gamma, flat/reference status, stats, and warnings.

5. Update the repeatability script for the current 8-step capture.
   `scripts/dev/deflectometry_repeatability.py` still assumes four frames in
   parts of its local reload loop. Bring it in line with the 16-frame capture.

### Phase 2 - Borrow SOFAST's Calibration Shape Without Heavy Geometry

These make Loupe more repeatable while keeping the workflow simple.

1. Add a "deflectometry setup profile."
   Persist display model, browser viewport/display resolution, pixel pitch,
   gamma, camera calibration profile, screen distance, and fixture notes.

2. Add display response calibration.
   Instead of a single gamma value, capture a small grayscale ramp through the
   reflected display and build a response lookup similar in spirit to SOFAST's
   image calibration classes.

3. Add display-screen sanity checks.
   Capture projected border/corner/dot patterns to confirm the iPad viewport,
   orientation, scale, and reflected screen region are consistent.

4. Add explicit part/measurement masks.
   Reuse Loupe's existing ROI, polygon, and DXF ideas so the modulation mask can
   be combined with a user or geometry-defined aperture.

### Phase 3 - Add a Loupe-Sized Geometric Slope Solver

This is the first major algorithmic step toward physically meaningful
deflectometry.

1. Model camera pixels as rays.
   Use camera intrinsics/lens calibration to turn valid pixels into camera rays.

2. Model the display plane.
   Use screen physical size, pose, and observed calibration patterns to map
   phase-derived screen coordinates to points on the display plane.

3. Estimate or constrain the surface location.
   Start with a planar nominal surface at a known distance, then later allow
   sphere/paraboloid/reference-artifact fitting.

4. Compute x/y slopes from reflection geometry.
   Treat the current Frankot-Chellappa height map as downstream of calibrated
   slopes, not as the primary measurement.

5. Report slope in mrad and height only when the solver assumptions are known.

### Phase 4 - Advanced Reference-Grade Features

These are worth considering only after the simpler pieces are useful.

- multi-frequency phase capture for absolute screen coordinates
- robust least-squares slope fitting and outlier rejection
- orthorectified slope maps in part coordinates
- reference-surface subtraction in slope space
- batch/averaging with rejection
- HDF5 or zipped run bundles for traceability
- optional comparison against CAD or nominal shape

## Suggested First Discussion Decisions

Before implementation, decide the product target for deflectometry mode:

1. Is the near-term goal relative process comparison or absolute micron-scale
   metrology?
2. Should the UI present slope maps as the primary result, with height as a
   derived view?
3. How much setup calibration is acceptable before the workflow feels too heavy?
4. Are we measuring mostly flats, gentle spherical/curved surfaces, or arbitrary
   small specular parts?
5. Should Loupe optimize for "fast capture" or "traceable calibrated session"?

My recommendation: do Phase 1 first. It improves trust immediately and gives us
better evidence for deciding whether Phase 2 or Phase 3 is worth the complexity.

## Concrete First Implementation Candidates

If we choose to proceed after discussing this report, the best first changes are:

1. Add a Deflectometry Quality block in the UI and `/deflectometry/compute`
   response.
2. Add slope magnitude and integration residual renderings.
3. Fix and extend the repeatability script for 8-step captures.
4. Add run diagnostics export as JSON.
5. Add explicit language in the UI distinguishing phase proxy, calibrated
   height, and physically modeled slope.

These changes are small enough to review, but they set the direction toward a
SOFAST-informed deflectometry workflow.
