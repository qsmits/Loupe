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
