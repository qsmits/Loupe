# Scientific basis of fringe analysis

This audit was made on 2026-10-23 from the source, tests, Git history, and
local design notes (including the Git-ignored `docs/` directory).
It distinguishes recorded provenance from references found during this audit.
The references explain the underlying methods; they do not establish the
accuracy of Loupe's implementation or a particular optical setup.

## What the repository establishes

- **DFTFringe was the main recorded application and source-code reference.**
  The local `docs/superpowers/specs/2026-04-13-fringe-analysis-mode-design.md`
  explicitly identifies it as the reference application. The April 14
  comparison notes and April 17 `docs/fringe-design.md` document source
  review by filename and line number: aperture geometry, quality-guided
  unwrapping, diagnostics, provenance, averaging, and form removal. The
  design describes learning from DFTFringe rather than porting it. Its
  [upstream repository](https://github.com/githubdoe/DFTFringe) is confirmed
  by the local reference checkout's Git remote. These local design notes
  are ignored by Git and may not be present in a fresh Loupe checkout.
- `backend/vision/fringe.py::zernike_noll_index` explicitly names **Noll (1976)**.
  The original Zernike implementation is commit `7611be5` (2026-04-13).
- DFT extraction and the original scikit-image unwrapping arrived in
  `1a87413` (2026-04-13). The current extraction uses carrier detection,
  single-sideband filtering, complex demodulation, boundary-aware filtering,
  and wrapped-phase extraction. This is related to Fourier fringe analysis,
  but no formal Takeda citation was recorded in the inspected source or
  commit text. A June 3 local code audit does call it Takeda analysis.
- Commit `a8e55dc` (2026-04-14) introduced a custom quality-guided unwrapper.
  Its commit message and old docstrings called it “Goldstein/Zebker” and
  called scikit-image's method “raster-order.” Those descriptions were
  inaccurate: Loupe uses a priority-queue flood; Goldstein's method uses
  residues and cuts; scikit-image documents reliability sorting. The current
  docstrings correct this attribution without changing the algorithms.
- There was no scientific bibliography, paper PDF, or DOI reference in the
  inspected fringe source or design notes. The evidence supports an
  application/source-code-led design, not a documented scientific-paper
  review. Author names and standard algorithm terminology are evidence of
  methodological ancestry, **not evidence that the papers were read during
  development**. Earlier conversations or other research may contain
  additional provenance that this audit cannot establish.

## References checked during this audit

| Reference | Connection to Loupe |
| --- | --- |
| [Takeda, Ina & Kobayashi (1982), *Fourier-transform method of fringe-pattern analysis for computer-based topography and interferometry*, JOSA 72, 156–160](https://opg.optica.org/josa/abstract.cfm?uri=josa-72-1-156), DOI: 10.1364/JOSA.72.000156 | Foundational Fourier fringe-analysis reference. Newly identified guidance for reviewing carrier separation and phase extraction, not a claim that Loupe reproduces the paper exactly. |
| [Noll (1976), *Zernike polynomials and atmospheric turbulence*, JOSA 66, 207–211](https://opg.optica.org/josa/abstract.cfm?uri=josa-66-3-207), DOI: 10.1364/JOSA.66.000207 | The convention already named in code. Useful for checking mode ordering and normalization; orthogonality is defined on a circular pupil. |
| [Herráez et al. (2002), *Fast two-dimensional phase-unwrapping algorithm based on sorting by reliability following a noncontinuous path*, Applied Optics 41, 7437–7444](https://opg.optica.org/ao/abstract.cfm?uri=ao-41-35-7437), DOI: 10.1364/AO.41.007437 | The algorithm cited by the [scikit-image API documentation](https://scikit-image.org/docs/stable/api/skimage.restoration.html#skimage.restoration.unwrap_phase), which Loupe uses when no quality map is supplied. This is not Loupe's default custom flood. |
| [Zhao et al. (2011), *Quality-guided phase unwrapping technique: comparison of quality maps and guiding strategies*, Applied Optics 50, 6214–6224](https://opg.optica.org/ao/abstract.cfm?uri=ao-50-33-6214), DOI: 10.1364/AO.50.006214 | Newly identified comparison for Loupe's modulation × phase-consistency quality map and flood strategy. Discusses why quality guidance alone cannot resolve discontinuities. |
| [Goldstein, Zebker & Werner (1988), *Satellite radar interferometry: Two-dimensional phase unwrapping*, Radio Science 23, 713–720](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/RS023i004p00713), DOI: 10.1029/RS023i004p00713 | Relevant background on residues and error propagation, and the basis for correcting the old attribution. Loupe's flood is not an implementation of this paper. |
| [Doiron & Beers, *The Gage Block Handbook*, NIST Monograph 180, chapter 6](https://www.nist.gov/sites/default/files/documents/calibrations/mono180.pdf) | Newly identified metrology reference for the double-pass path, fringe orders, environmental corrections, and multiple-wavelength measurements. Particularly relevant to interpreting optical-flat measurements and their limits. |

## Physical interpretation and implementation limits

Loupe converts recovered phase to near-normal-incidence air-gap departure as
`h = phase × wavelength / (4π)`. One full phase cycle therefore corresponds
to `wavelength / 2` of gap. A single intensity image does not establish
absolute specimen high/low sign; an external wedge/contact orientation is
needed, and reference-flat figure is included in the measured gap.

Spatial unwrapping assumes sufficiently small phase changes along a valid
connected path. An abrupt step beyond about `wavelength / 4` can be assigned
the wrong integer fringe order. This is not a limit on the total range of a
smooth, adequately sampled surface. Disconnected regions also lack a known
relative fringe order. NIST chapter 6.8 explains why additional wavelengths
or prior length information are needed to resolve order ambiguity.

The current boundary continuation, carrier-leak subtraction, automatic mask,
island merging, and median correction include Loupe-specific heuristics.
The papers above do not validate those choices. Disabling 2π correction for
step measurements prevents that cleanup from flattening real steps, but it
does not remove the underlying single-wavelength ambiguity. Likewise, the
0–100 confidence indicators are diagnostic scores, not calibrated
probabilities or a measurement uncertainty in nanometers.

## Validation priorities

Existing tests include known-height synthetic interferograms, wavelength and
sign checks, hand-coded Zernike values, mask-boundary cases, carrier leakage,
unwrap islands, and the actual browser step estimator (`tests/test_fringe.py`,
`tests/test_fringe_math_regressions.py`, `tests/test_fringe_leak.py`,
`tests/test_fringe_unwrap_islands.py`, and `tests/fringe_step_helper.py`).
These are useful software regression checks; they are not independent
instrument calibration.

1. Compare the default flood and correction stages with independent
   unwrappers on the same noise, low-modulation, hole, discontinuity, and
   disconnected-region cases. Measure integer-order errors as well as RMS.
2. Sweep carrier frequency/direction, aperture boundaries, illumination,
   camera noise, and filter width against independently generated truth.
   Quantify bias and lost spatial detail introduced by leak subtraction and
   boundary filtering, rather than judging the smoothness of the map.
3. Verify Zernike ordering/normalization against Noll and compare fits on
   circular, clipped, and noncircular masks. Per-term RMS values on a cropped
   aperture need not combine as independent orthogonal contributions.
4. Measure independently characterized flats and step artifacts repeatedly,
   including rotated/repositioned captures. Record wavelength, optical-flat
   uncertainty, incidence, imaging calibration, and environmental conditions;
   compare recovered heights and repeatability against the reference values.
   Repeatability alone does not establish absolute accuracy.

Adding citations makes the method traceable. Establishing quantitative
accuracy requires those comparisons and a documented uncertainty budget.

## First numerical validation pass — 2026-10-23

`tests/test_fringe_scientific_validation.py` adds 102 deterministic checks.
The forward model is written directly as intensity = illumination + amplitude
× cos(carrier + 4π × height / wavelength); it does not use Loupe's phase,
height, or Zernike generation helpers. Only PNG rendering is stubbed out in
pipeline tests. Returned, rounded height grids are assessed on the returned
quantitative mask. Reference sign comes from the known imposed carrier and
the selected sideband. Only piston and a plane are removed for comparison;
no fitted gain, curvature, local registration, or local fringe-order
alignment is allowed to improve the height-error measurements.

The unwrapping reference is scikit-image's independent reliability-sorted
implementation, with a fixed random seed. Each disconnected component gets
its own constant piston alignment because its relative order is unobservable.
Noise-free and noisy phases cover disks, thin rings, thin strips, holes,
and disconnected regions, with correction both on and off. Noise is stronger
in low-quality regions. This bounded-noise comparison does not characterize
all residue-rich or under-sampled scenes.

Zernike checks use an explicit 36-entry Noll table and the Jacobi identity
`R_n^m(r) = r^m P_((n-m)/2)^(0,m)(2r²−1)`, evaluated by
[SciPy's separate Jacobi implementation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.special.eval_jacobi.html),
rather than Loupe's factorial expansion. Disk orthonormality uses radial
Gauss–Legendre quadrature and angular integration. Fit, selective subtraction,
and per-term RMS checks also cover clipped, rectangular, and annular pupils.
They explicitly demonstrate why modal RMS values cannot simply be added
in quadrature on a clipped aperture.

### Findings and changes

1. **Mask zeros could create wrong fringe orders.** The median cleanup
   treated pixels outside the aperture as zero-height observations. An
   otherwise exact smooth ramp acquired whole-order errors, especially on
   thin rings and strips. Cleanup now requires a fully valid 9×9 footprint.
2. **Resolved peaks could be flattened.** Smooth 6 rad peaks with 1.5–2 px
   Gaussian widths had adjacent differences below π, yet the median cleanup
   shifted nine peak pixels by −2π. Candidate correction regions now require
   an actual adjacent phase discontinuity above π, measured between valid
   pixels. Small wrong-order plateaus still get corrected with their rims.
   The initial independent test set exposed 12 failures before these fixes;
   the existing island-repair tests remain part of regression coverage.
3. **Boundary exclusion underestimated filter support for fine fringes.**
   The Gaussian filter has minimum image-space sigmas of 5 px across and
   2 px along fringes. Boundary exclusion previously used only the requested
   fraction of the fringe period. Shared width calculation now includes
   those floors, making the conservative three-sigma band at least 15 px
   for these analyses. More pixels around edges and holes can be excluded;
   PV/RMS describe that smaller aperture. A fine-carrier test and independent
   binary erosion check pin the behavior.
4. **Fine-detail attenuation remains measurable.** At a 12 px carrier period,
   the 5 px filter floor dominates several slider settings. The tests measure
   feature gain explicitly; they do not compensate the output to make it
   match truth. No new deconvolution or universal gain correction was added.

### Measured results

Results below are from Python 3.13.12, NumPy 2.4.3, SciPy 1.17.1,
scikit-image 0.26.0, and OpenCV 4.13.0. They are fixture-specific regression
results, not a nanometer accuracy specification for the instrument.
The focused suite passed all 102 checks; the full backend suite passed
1,350 tests, with one skip and one expected failure.

| Check | Observed result |
| --- | --- |
| 36 Noll/Jacobi modes and disk orthonormality | Agreement within the test's 2×10⁻¹³ absolute tolerance |
| Four pupil shapes: fitted coefficients, selected-term subtraction, modal RMS | All pass; coefficient/subtraction tolerance 2×10⁻¹¹ |
| 20 masked-phase comparisons, including correction on/off and bounded noise | Zero wrong fringe orders; RMS phase error against noiseless truth 0–0.1292 rad; agreement with the independent unwrap within 10⁻¹⁰ rad after component piston alignment |
| 24 full-frame image cases: four carrier angle/count pairs, three filter settings, two noise levels, sloping illumination | RMS height error 0.0625–0.2991 nm; PV error 0.0131–0.4321 nm; returned aperture 47.3–71.2% |
| Three offset apertures: disk, clipped disk, disk with hole | RMS height error 0.0033–0.0035 nm on returned pixels; retained aperture 20.4–48.6%, independently checked against the expected support band |
| Nine sinusoidal-detail cases: 1, 3, or 6 feature cycles versus 16 carrier cycles, three filter settings | Gain about 0.987, 0.88–0.89, and 0.61–0.62 respectively; worst RMS height error 2.7630 nm for a 10 nm-amplitude feature |
| Single-wavelength discontinuity | 80 nm and 80 nm + λ/2 steps produce the same intensity image; disabling cleanup does not recover the missing fringe order |

Reproduce the numerical report with:

```bash
.venv/bin/pytest -q tests/test_fringe_scientific_validation.py \
  --junitxml=/tmp/loupe-fringe-validation.xml -o junit_family=legacy
```

The JUnit test properties contain height-error, retained-aperture, phase-error,
fringe-order-error, and feature-gain measurements. Existing larger-image
carrier-leak and unwrap-island regressions complement this small deterministic
suite. Wider noise/contrast, gamma/JPEG, carrier-bandwidth, and sampling sweeps
remain useful extensions; these tests do not establish safe operation for
every combination of those factors.

### Physical validation still needed

No independently characterized physical capture set or reference certificate
was available for this pass. A practical next experiment is a certified flat
and a known step comfortably below λ/4, photographed repeatedly with recorded
wavelength, exposure, pixel scale, incidence, reference-flat specification,
and analysis settings. Retain the original images and exported results;
repeat after repositioning and rotating the specimen/reference, and compare
height bias and repeatability with the reference uncertainty. Larger steps
require additional order information or wavelengths. That experiment and an
uncertainty budget are still required before claiming measurement accuracy.

## Contact reference and spatial orientation — 2026-10-23

A verified contact is a useful physical reference for zero air gap, but it
must be distinguished from an arbitrary display zero. A contact location
does not supply the flat's tilt plane. Loupe demodulates the carrier and
normally subtracts piston/tilt; merely setting a point on that residual map
to zero cannot reconstruct the physical gap. PV and mean-centered RMS are
unchanged by a constant zero adjustment. Contact information plus the known
direction in which the gap opens can help establish phase polarity; this
should be recorded explicitly rather than inferred from red/blue colors.
[Reeve's NBS/NIST optical-flat comparison procedure, section 5.3](https://www.nist.gov/system/files/documents/calibrations/75-975.pdf)
specifically checks wedge direction because a sign reversal changes the
computed profile. [Edmund Optics' optical-flat guide](https://www.edmundoptics.com/knowledge-center/application-notes/optics/optical-flats/)
describes the contact/air-wedge geometry.

Spatial mirroring is a separate question. `tests/test_fringe_orientation.py`
uses a non-square, 8-bit synthetic interferogram with three distinct off-axis
height features. It checks original, horizontally mirrored, vertically
mirrored, and 90-degree-rotated inputs against their correspondingly
transformed ground truth. Carrier polarity is specified independently;
no spatial registration or best-fit sign is allowed to hide a reversal.
The normal processing path preserves landmark positions in these cases.
The tests also decode the actual rendered PNG and check colored landmarks
and an asymmetric mask hole. The renderer now explicitly specifies
`origin='upper'`: the default already behaved this way, but a changed global
Matplotlib default could previously reverse it. A frontend regression checks
height sampling and peak/valley marker coordinates on an asymmetric grid.
The focused validation run passed 108 backend and 11 frontend checks.

These checks do not certify camera-driver or optical-path orientation for a
physical setup. An orientation mark on the rim or fixture, outside the
measuring surface, remains useful for registering a round part to its photo.
The paired source/map view preserves the actual crop transform and uses shared
landmarks with linked navigation. Physical observations can be recorded separately:
gap-opening direction, an optional contact landmark, checked display polarity,
and setup notes. They do not establish an absolute gap or modify height zero.
Inverting the display reverses the recorded red/blue meaning, while a fresh
analysis starts without physical observations. Reports preserve both aligned
images, their labels, and these observations.

### Large-fit memory use

Large Zernike fits reduce blocks of at most 16,384 pixel rows by QR before a
small least-squares solve. Every valid pixel participates; no sampling or image
resolution reduction is introduced. The final rank cutoff uses the original
pixel count, and orthogonal reduction avoids the loss of conditioning from
forming normal equations. Regression checks compare against the dense solve
on full, circular, clipped, annular and rank-deficient apertures.

An isolated 1024 × 1024, 36-term fit on the development Mac used 118 MiB peak
process RSS versus 725 MiB for the dense path. Runtime was 2.15 s versus 1.43 s,
and the maximum coefficient difference was 3.0 × 10⁻¹⁴. These figures include
the fit process and imports, not the entire analysis pipeline; FFT, image
rendering and concurrent analyses still require additional memory. Benchmark
input was `0.3*sin(x/80) + 0.1*cos(y/70)` with no aperture mask.
