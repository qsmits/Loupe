# Fringe Analysis vs DFTFringe

Updated 2026-04-14.

This note compares the current browser-based fringe pipeline in Loupe's microscope
project with the legacy-but-mature workflow in the bundled `DFTFringe` source.
The goal is not feature parity for its own sake; it is to identify the parts of
DFTFringe that materially improve robustness, traceability, and repeatability.

Important framing:

- Loupe's main fringe use case is optical-flat inspection of lapped / polished
  metal parts.
- DFTFringe was built primarily around telescope mirrors and related optics.

Those workflows overlap in Fourier demodulation, phase unwrapping, and form
removal, but they are not the same product problem. DFTFringe should be treated
as an algorithm reference, not as the target UX or feature set.

## Current microscope fringe pipeline

The current backend in
[`backend/vision/fringe.py`](/Users/qsmits/Projects/MainDynamics/microscope/backend/vision/fringe.py)
does the following:

- auto-detects a carrier with a windowed FFT
- estimates fringe modulation and builds an automatic mask from brightness + modulation
- extracts wrapped phase with spatial complex demodulation
- unwraps with `skimage.restoration.unwrap_phase`
- fits standard circular Zernikes
- subtracts selected low-order terms
- converts to height, then reports PV/RMS/Strehl, PSF/MTF, profiles, and renders

This is compact and works well for "drop in a reasonably clean interferogram and
get a result" workflows. It is also easy to run from a browser with live camera input.
That is a better fit for shop-floor or bench-top part inspection than DFTFringe's
more operator-driven optical-lab workflow.

## What DFTFringe does differently

The `DFTFringe` codebase adds several robustness layers that the microscope mode
does not yet have:

- Explicit aperture geometry instead of relying mainly on image-derived masking.
  `DFTFringe/dftarea.cpp` builds masks from outside + inside outlines and optional
  polygon exclusions, including ellipse support.
- Interactive DFT sideband control. The user can inspect the DFT and tune the
  "center filter" radius instead of relying on a single automatic choice.
- Quality-guided unwrapping. `DFTFringe/punwrap.cpp` computes local phase quality
  maps and unwraps highest-confidence regions first.
- Better support for annular pupils / central obstructions in both mask handling
  and Zernike processing. `DFTFringe/zernikeprocess.cpp` explicitly branches to
  annular Zernike handling. This is very important for telescope optics, but it
  is secondary for flat-on-part inspection unless Loupe starts targeting ring
  parts or fixtures that genuinely create annular measurement domains.
- Averaging with rejection. `DFTFringe/averagewavefrontfilesdlg.cpp` can reject
  wavefronts above an RMS threshold before averaging, and `DFTFringe/wftstats.cpp`
  includes outlier analysis on running averages.
- More operator-visible diagnostics. The desktop app exposes outline plots, DFT
  thumbnails, filter controls, and wavefront statistics so users can verify that
  the algorithm made sensible choices.

## Gaps that matter most

The biggest practical gaps today are:

1. Aperture definition is weaker in the microscope mode.
   Auto-thresholding is convenient, but for metal parts it is less reliable than
   an explicit part boundary, ROI, polygon mask, or DXF-derived mask.

2. Carrier selection is opaque.
   DFTFringe makes sideband selection inspectable; the microscope mode does not.
   When carrier detection is wrong, the user has very little to go on.

3. Unwrapping is not quality-guided.
   DFTFringe unwraps from the best pixels outward. The microscope mode used a
   generic unwrap with post-hoc median cleanup, which is simpler but less robust
   around weak-fringe regions.

4. Averaging is too trusting.
   The browser UI averages coefficients, but it does not reject obviously bad
   captures before they contaminate the result.

5. The analysis is still somewhat optics-centric in how it models form.
   The current Zernike fitting assumes a filled circular pupil and is inherited
   from optical-aberration thinking. For metal parts, plane removal, optional
   low-order form removal, and geometry-aware masking may be more important than
   expanding aggressively into higher-order optical pupil models.

## Improvements recommended for the microscope project

### High priority for Loupe's actual use case

- Add explicit aperture tools:
  ROI, polygon, part-boundary, and DXF-derived masks first; circle / ellipse
  where useful. This is the single biggest robustness gain because it improves
  phase extraction, unwrapping, form removal, and reported flatness metrics.

- Expose carrier diagnostics and manual override:
  show detected carrier location, fringe angle/period, and a peak-confidence
  metric; allow nudging the carrier/filter when auto-detection looks wrong.

- Add quality-guided unwrapping:
  use modulation and/or local wrapped-phase variance to seed unwrapping from
  high-confidence regions first, similar to `DFTFringe/punwrap.cpp`. This is
  valuable for parts because edge contamination and uneven fringe quality are
  common failure modes.

- Add averaging rejection:
  reject captures above a configurable RMS threshold and show which captures
  were excluded.

### Medium priority

- Support annular Zernikes only when a real part/fixture workflow needs them.
  This should not outrank part-boundary masking or robust unwrap improvements.

- Add repeatability stats for multi-capture sessions:
  running average RMS, capture-to-capture spread, and outlier visualization.

- Persist aperture and carrier settings with an analysis session so a user can
  re-run a series consistently on repeated part measurements.

### Lower priority but still useful

- Add a DFT preview tab or collapsible diagnostics panel.

- Add batch processing for dropped image sets, not just one image at a time.

- Add richer line/profile tooling that follows the mask and can sample arbitrary
  user-drawn sections instead of only center cross-sections.

## Changes made now

Two immediate improvements were implemented:

- `unwrap_phase_2d()` now unwraps masked data as a masked array, so invalid pixels
  do not influence the unwrap solution.
- `analyze_interferogram()` now returns carrier diagnostics (`peak`, `period`,
  `angle`, `peak_ratio`) so the UI can surface DFT-side health information.

These do not replace the larger workflow upgrades above, but they are still
relevant for Loupe's metal-part use case:

- mask-aware unwrapping is directly useful because invalid background or rim
  pixels should never drive the unwrap
- carrier diagnostics are directly useful because they make failure analysis and
  future manual override possible without turning Loupe into a clone of DFTFringe
