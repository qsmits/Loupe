# Fringe Mode Design

Updated 2026-04-17. Supersedes `fringe-dftfringe-derived-design.md` (kept as
reference). This document combines an earlier DFTFringe-review design with a
second pass that went deeper into DFTFringe's data model, algorithmic details,
and workflow/metrology primitives.

It is a design for a small-part metrology workflow that learns from a mature
interferometry codebase. It is not a port.

## Context

Loupe's fringe mode today is strongest when:

- the interferogram is a single, smooth, continuous surface
- the useful aperture is easy to infer from brightness and modulation
- the carrier is obvious
- the user wants a quick answer from one frame

That is a reasonable baseline for polished-flat inspection but not a complete
metrology workflow. Today's failure modes are mostly about hidden assumptions:

- the mask is image-derived rather than geometry-derived
- the DFT choice is mostly automatic and opaque
- the unwrap is not confidence-driven
- averaging trusts bad frames equally with good ones
- form removal is optics-centric rather than part-centric
- discontinuous or ambiguous measurements are forced through the same pipeline
- every capture is treated as an island with no provenance or session context
- wavelength and calibration live in query parameters, not in a system record

DFTFringe demonstrates a more mature stance:

- define geometry explicitly
- let the operator inspect Fourier choices
- unwrap in quality order
- expose diagnostics
- reject bad frames before they corrupt an average
- carry provenance and metadata with every wavefront
- separate measurement modes when physics demands it

That is the template this design follows.

## Design goals

1. Make smooth-surface measurements more trustworthy on real parts.
2. Make failure modes visible before users trust a bad map.
3. Support repeatable bench workflows within a session. Support longitudinal
   tracking (lapping progress over days/weeks) via explicit user-controlled
   export/import, not via server-side persistence.
4. Keep the default flow fast and simple for ordinary flat inspection.
5. Add dedicated workflows for ambiguous measurements rather than pretending
   one single-shot pipeline can solve everything.
6. Give every result a traceable lineage within its session (which capture,
   which reference, which calibration snapshot, which aperture recipe).
7. Keep the server stateless across sessions — nothing persists to disk;
   session store evaporates on timeout.

## Non-goals

- Recreating DFTFringe's mirror-centric UI or its telescope-optics terminology.
- Building annular Zernike support. Our parts are not obstructed telescope
  pupils. Annular math stays off the table until a use case demands it.
- Making large-step single-shot spatial-carrier measurements look "solved"
  when the physics is ambiguous.
- Porting the whole Qt UI architecture into our browser stack.

## Product stance

Loupe should aim to be:

- more geometry-aware than DFTFringe
- more confidence-aware than DFTFringe
- better integrated with microscope-mode context than DFTFringe
- more honest about which measurements are ambiguous

The goal is to combine DFTFringe's mature interferometry instincts with
Loupe's strengths: part-centric geometry, live camera integration,
browser-based accessibility, and recipe-driven inspection.

---

## What we borrow from DFTFringe

### 1. Geometry as a first-class input

DFTFringe builds every analysis around explicit outlines, obstructions, and
exclusion polygons before it trusts the Fourier pipeline. Loupe should do the
same, with part-oriented geometry:

- polygon measurement apertures
- exclusion polygons (dust, defects, mounting hardware)
- saved named ROIs
- DXF-derived masks (we already have DXF in microscope mode)
- part-boundary-assisted masks (shared with microscope's inspection flow)
- circle/ellipse tools as options, not as the core model

The idea to borrow is not "circles." It is: the measurement domain should
usually be defined on purpose.

### 2. Provenance and origin tracking

DFTFringe's `wavefront` struct ([`DFTFringe/wavefront.h:45–72`]) carries every
scrap of context about a result:

- `data`, `mask`
- `lambda`, `diameter`, `roc`
- `InputZerns` (the fitted Zernike coefficients)
- `m_outside`, `m_inside` (aperture geometry as parametric objects)
- `m_origin` — a `WavefrontOrigin` enum
  ([`DFTFringe/wavefront.h:24–34`]) with values like `Igram`, `File`, `Average`,
  `Subtraction`, `Zernikes`, `Smoothed`, `Simulation`
- `wasSmoothed`, `GBSmoothingValue`, `gaussian_diameter`
- `name` (file path / identifier), datetime

The origin enum lets the UI refuse nonsensical operations (you cannot subtract
a Zernike-reconstructed surface from the original interferogram). Our current
flat dict throws all of this away.

**Loupe adoption.** Every wavefront Loupe produces gets:

- `origin`: enum {capture, file, average, subtracted, fitted, smoothed,
  synthetic}
- `source_ids`: list of parent wavefront IDs, session-scoped (for averages
  and subtractions)
- `aperture`: explicit geometry recipe (not just a boolean mask)
- `calibration_snapshot`: inlined copy of the active calibration at capture
  time (wavelength, pixel_to_mm, lens_k1, source, uncertainty)
- `wavelength_nm`, `temperature_c`, `operator`, `captured_at`
- `was_smoothed`, smoothing parameters

### 3. Inspectable DFT choices

DFTFringe exposes its center-filter (high-pass) and lets the user inspect the
detected peak visually. Loupe should keep stronger automation, but the carrier
choice must become visible and overridable:

- show the detected carrier peak on the FFT display
- show alternate plausible peaks with their magnitudes and distances
- show period, angle, distance from DC, and confidence
- allow manual override via click-on-FFT
- persist setup-specific carrier preferences
- surface warnings when the chosen peak is weak, too close to DC, or unstable

### 4. Quality-guided unwrapping with branch-cut detection

DFTFringe's unwrap is seeded at the highest-quality pixel and floods outward
in descending quality order ([`DFTFringe/dftarea.cpp:561–603`]). Crucially,
its quality metric isn't just amplitude — it's derived from *local phase
consistency* ([`DFTFringe/dftarea.cpp:808–863`]), computing the magnitude of
a phase-orientation derivative as a proxy for residue density. High-modulation
regions with noisy phase get flagged; pure modulation metrics miss this.

Loupe should adopt both the flood order and the hybrid quality signal:

- modulation strength (we have this)
- wrapped-phase Laplacian (proxy for residue density — new)
- distance from aperture edge
- saturation / glare detection
- carrier-confidence consistency across the image

### 5. Robust averaging with outlier rejection

DFTFringe's averaging ([`DFTFringe/averagewavefrontfilesdlg.cpp:41–134`]) is
not a naïve sum. Before adding a wavefront to the running average it:

- computes its residual RMS
- rejects it if RMS exceeds a user threshold (default 0.1 λ)
- logs the rejection with reason
- presents an audit list in `rejectedwavefrontsdlg.cpp`

Our current "add to average" is an unweighted grid sum that treats every
capture equally. One bad capture corrupts the whole session.

### 6. Reference-flat subtraction

DFTFringe supports measuring a reference wavefront once and subtracting it
from subsequent measurements ([`DFTFringe/surfacemanager.cpp:1907–1971`],
[`DFTFringe/subtractwavefronatsdlg.cpp`]). Output becomes deviation-from-
reference, which is how serious interferometers report traceable numbers.

**Loupe's version is intentionally narrower.** We support reference
subtraction within a single session — user picks two captures, one as
reference, one as measurement, clicks subtract. We do not support an
always-on "designated reference" that silently applies to every new
capture, and we do not persist references across sessions. The cross-
session lapping workflow is export-import-subtract, run by the user
manually. See A7 for the algorithmic specification and rationale.

### 7. Normalization weights stored with every fit

DFTFringe keeps the Zernike normalization vector `Zw[]`
([`DFTFringe/zernikes.cpp:41–54`]) alive alongside coefficients. This makes
the convention explicit and lets the UI display peak-to-valley and RMS values
for each term without recomputation. We currently normalize implicitly in the
basis and force the UI to recompute — a small but real source of ambiguity.

### 8. Per-term Zernike subtraction UI

DFTFringe's Zernike dialog ([`DFTFringe/zernikeEditDlg.h:10–45`],
[`DFTFringe/zernikedlg.h`]) is a table with one row per term: name, raw value,
RMS value, individual enable toggle. Toggling any term updates the display
live. Our current "subtract [1, 2, 3]" is a coarse tool by comparison.

### 9. Separate workflows when physics changes

The most important lesson from DFTFringe is not in its DFT path. It's that
DFTFringe also has PSI workflows, three-flat wizards, standard-astig
subtraction wizards, etc. Mature tools switch modes when the problem changes.
Loupe should explicitly split:

- single-shot spatial-carrier analysis (smooth continuous surfaces)
- small-step region-comparison (sub-λ/4 steps, away from the edge)
- averaging-with-rejection sessions (repeatability, lapping tracking)
- reference-flat-relative measurements (lapping, drift monitoring)
- future multi-frame or multi-wavelength workflows (ambiguous / large steps)

---

## What we explicitly do not borrow

1. **Circle-first geometry.** Loupe's default geometry describes machined
   parts, not telescope pupils.
2. **Annular Zernike polynomials.** DFTFringe's `zapm()` implementation is
   mathematically proper but irrelevant for unobstructed microscopy parts.
3. **Zernike-first UX.** Our primary language should be height map, flatness,
   plane/curvature/low-order form removal, datum-relative measurements,
   repeatability, confidence. Zernikes stay available for advanced users.
4. **Conic-based auto-invert.** DFTFringe predicts expected sign from mirror
   ROC/conic ([`DFTFringe/autoinvertdlg.cpp`]). Transmissive flats don't have
   conics. We can add reference-based sign detection later if needed.
5. **Counter-rotation for mirror averaging.** A Bath-interferometer artifact.
6. **Monte-Carlo tolerance stacks** from ROC/diameter uncertainty
   ([`DFTFringe/nullvariationdlg.cpp:35–51`]). Our parts don't have those
   parameters.
7. **Desktop-era UI patterns.** A Qt menubar full of wizards is not our
   target. Our workflows should live in the existing panel-and-tool pattern.
8. **Single-shot heroics for fundamentally ambiguous cases.** Adding cleanup
   heuristics to hide the physics is worse than flagging the ambiguity.

---

## Target architecture

Six layers. Each has a clear responsibility, clear inputs, clear outputs.

### Layer 1 — Geometry

Defines the valid measurement domain and carries it consistently through
analysis, display, and reanalysis.

- **Inputs:** user polygon, DXF-derived mask, shared microscope ROI, saved
  recipe, or (fallback) auto-mask with explicit warning
- **Outputs:** `analysis_mask` (what analysis runs over), `trusted_mask`
  (which pixels survive confidence filtering), `aperture_recipe` (how to
  reproduce this geometry on another capture)
- **Primary code:** `backend/vision/fringe.py`, `backend/api_fringe.py`,
  `frontend/fringe-panel.js`, `frontend/fringe.js`

### Layer 2 — Carrier

Detects and validates the carrier; exposes alternates and confidence;
persists user overrides per setup.

- **Outputs:** chosen carrier (sub-pixel), up to N candidate carriers with
  magnitude and distance, carrier confidence (peak_ratio, SNR, DC margin,
  stability), recommended demodulation bandwidth
- **Primary code:** `backend/vision/fringe.py`

### Layer 3 — Demodulation and unwrap

Demodulates with bandwidth and orientation appropriate to the chosen carrier;
unwraps in confidence order; preserves sharp structure when the method should
preserve it; reports likely-risk regions instead of burying them.

- **Outputs:** wrapped phase, unwrapped phase, unwrap-risk / confidence map,
  demodulation quality metrics
- **Primary code:** `backend/vision/fringe.py`

### Layer 4 — Surface model

Converts phase to height; supports multiple removal models; keeps raw and
fitted surfaces distinct.

- **Outputs:** `raw_height_grid_nm`, `fit_height_grid_nm` (optional),
  `display_height_grid_nm`, plus metadata describing which fit is active
- **Supported models:** piston, tilt, best-fit plane, simple curvature /
  paraboloid, low-order polynomial, optional Zernike subtraction
- **Primary code:** `backend/vision/fringe.py`, `frontend/fringe-results.js`

### Layer 5 — Confidence and repeatability

Tells the user which parts of the result are trustworthy; supports
multi-capture repeatability.

- **Outputs:** trusted-area percentage, capture rejection reasons, per-pixel
  spread across captures, analysis warnings, effective-N-aware uncertainty
- **Primary code:** `backend/vision/fringe.py`, `backend/api_fringe.py`,
  `frontend/fringe-results.js`

### Layer 6 — Measurement workflow

Presents tools appropriate to the measurement physics. Keeps the UI honest
about what each tool can and cannot claim.

- **Workflows:** smooth-surface map, area and profile measurements, small-
  step dual-region comparison, averaging with rejection, reference-relative
  measurement, future multi-frame workflows
- **Primary code:** `frontend/fringe-measure.js`, `frontend/fringe-results.js`,
  `frontend/index.html`

---

## Data model

### Core `WavefrontResult` object

Every backend analysis produces one typed object. Serialized as JSON on the
API boundary; held in an in-memory session store on the server until session
timeout.

**Statelessness stance.** The server does not persist measurement data to disk
across sessions. Within a session, the server keeps captures, averages, and
any designated reference in the session store; when the session times out,
that data is gone. Long-term persistence is the client's responsibility —
localStorage for per-user calibration and geometry recipes, explicit file
export for individual measurements a user wants to keep. This removes a whole
class of "which reference was this captured against, and is that record
still valid, and is the math still consistent with that stored entry"
gotchas in exchange for accepting that cross-session continuity is a manual
workflow, not an automatic one.

```
WavefrontResult {
    // Identity & provenance
    id: uuid                       // session-scoped
    origin: {capture | file | average | subtracted | fitted | smoothed | sim}
    source_ids: [uuid]            // parent results (same-session only)
    captured_at: ISO8601
    operator: str | null
    notes: str | null

    // Physics
    wavelength_nm: float
    temperature_c: float | null
    calibration_snapshot: {...}    // inlined copy of the client-supplied
                                   // calibration at capture time (see below)

    // Geometry
    aperture: {
        analysis_mask: bool[H×W]    // binary, full-res
        trusted_mask: bool[H×W]     // after confidence filtering
        recipe: {                   // how to reproduce
            type: "polygon" | "dxf" | "auto" | "roi_ref"
            polygons: [...] | null
            dxf_path: str | null
            roi_id: uuid | null
        }
    }

    // Phase-extraction diagnostics
    carrier: {
        chosen: {py: float, px: float, fy_cpp: float, fx_cpp: float,
                 period_px: float, angle_deg: float}
        candidates: [{...}, ...]   // top-N alternates
        confidence: {peak_ratio: float, snr_db: float,
                     dc_margin_px: float, stability: float}
        override: bool             // true if user-forced
    }

    unwrap: {
        quality_mean: float
        quality_map_b64: str       // PNG preview
        n_residues: int
        risk_pct: float            // fraction of pixels in high-risk zones
    }

    // Surfaces (the core rename)
    raw_height_grid_nm: float[gR×gC]        // before form removal
    fit_height_grid_nm: float[gR×gC] | null // if a fit is active
    display_height_grid_nm: float[gR×gC]    // raw - fit, what UI shows
    grid_rows: int
    grid_cols: int

    // Form removal state
    form_model: "none" | "piston" | "plane" | "poly" | "zernike"
    zernike_coeffs: [float]         // full set, always computed
    zernike_norm_weights: [float]   // Zw[], stored with the fit
    subtracted_terms: [int]         // which ones are currently subtracted
    plane_fit: {a, b, c} | null

    // Derived metrics
    stats: {pv_nm, rms_nm, pv_waves, rms_waves, strehl,
            n_valid_pixels, n_total_pixels, trusted_area_pct}
    confidence_overall: float       // 0-100
    warnings: [str]                 // human-readable reasons for caution

    // Visualization (rendered server-side)
    surface_map_b64, profile_x_b64, profile_y_b64,
    zernike_chart_b64, modulation_map_b64, fft_image_b64
}
```

**Critical property:** `raw_height_grid_nm` and `display_height_grid_nm` are
always both present. Reanalysis (toggling subtraction pills) recomputes
`display_height_grid_nm` and updates `subtracted_terms`/`form_model`, but
never discards `raw_height_grid_nm`. This fixes the reanalyze-desync class
of bugs at its root.

### Calibration record (client-side)

Calibration is a per-user, per-setup concern that should persist across
browser sessions, but not across users or workstations. It lives in
`localStorage` on the client.

```
CalibrationRecord {
    id: uuid                            // local to this browser
    system_id: str                      // "microscope_v1", "keyence_fizeau"
    wavelength_nm: float
    wavelength_source: "HeNe" | "NaD1D2" | "custom"
    wavelength_uncertainty_nm: float
    pixel_to_mm: float
    lens_k1: float
    calibrated_at: ISO8601
    calibrated_by: str
    notes: str
}
```

The frontend sends the currently-selected calibration as part of every
analyze request. The backend inlines a snapshot of that calibration into
the `WavefrontResult` so each result carries its own calibration context —
no cross-reference needed, no stale-DB risk. Fixes the 632.8-vs-589 nm
default mismatch by letting the user persist their source choice once per
browser.

Export / import of calibration records is a simple JSON download / upload in
the UI — workstation migrations and shared-lab handoffs work without any
server-side database.

### Session / measurement series (in-memory, server-scoped)

```
MeasurementSession {
    session_id: str                     // existing server session id
    captures: [WavefrontResult]         // accumulated this session
    averages: [WavefrontResult]         // with origin=average, source_ids=[...]
    designated_reference: uuid | null   // one capture in the session marked
                                        // as the "current reference" for
                                        // explicit subtraction operations
    created_at
    last_accessed_at
}
```

The session store is the existing `_fringe_cache` infrastructure extended
with a typed list of captures. It's already in-memory, already per-session,
already times out. No new persistence layer. Cross-session continuity is the
user's responsibility: download a result, upload it next time.

### Saved geometry recipes (client-side)

Moved up from Phase 2 because reference subtraction and long-lived
repeatability work are much more trustworthy when the aperture is stable by
design rather than re-inferred from every capture.

```
GeometryRecipe {
    id: uuid                            // local to this browser
    name: str                           // "Flat 1 - 20mm aperture"
    version: int                        // schema version
    polygons: [
        { vertices: [[x, y], ...], include: bool }
    ]
    dxf_ref: { path: str, transform: {...} } | null
    roi_ref: uuid | null                // shared microscope ROI
    created_at, modified_at
}
```

Also in localStorage, also exportable as JSON. The analyze request carries
either an inline aperture or a client-side recipe payload (the server
doesn't resolve recipe IDs — it just takes the polygon set the client
sends).

### Migration strategy (this matters — there are many consumers)

An inventory of the current frontend showed 6 categories of consumers with
no generic key iteration and no persistent storage of results. The migration
can be fully additive at the wire level. The plan:

**Stage 0 (already done):** `height_grid`, `mask_grid`, `grid_rows`,
`grid_cols` are emitted by `/fringe/reanalyze` and merged by
`mergeReanalyzeResult`. The reanalyze-desync bug is closed.

**Stage 1 — add the new fields alongside the old.** The analyze endpoints
return `raw_height_grid_nm` and `raw_mask_grid` in addition to the existing
`height_grid`/`mask_grid`, and new sibling keys for `origin`, `source_ids`,
`calibration_snapshot`, `warnings`, `aperture_recipe`, `trusted_mask`.
Existing consumers continue to read the old keys unchanged. No breaking
changes. This is the foundation phase — call it Phase 1a.

**Stage 2 — group the stats and diagnostics into sub-objects.**
`pv_nm`/`rms_nm`/`pv_waves`/`rms_waves`/`strehl`/`focus_score` move into
`result.stats`. `carrier.chosen` / `carrier.candidates` replaces the flat
carrier dict. Old keys kept as deprecated aliases (just pointers to the new
locations). Consumers migrate at their leisure. Phase 1b.

**Stage 3 — introduce a frontend wrapper class.** A thin `WavefrontResult`
constructor that takes the raw dict and provides named accessors. New code
uses the wrapper; old code keeps direct dict access. Over time, migrate the
direct accesses to the wrapper. Once all consumers are on the wrapper, we
can drop the deprecated top-level aliases. Phase 1c, possibly spread across
multiple small PRs.

**Critical-risk fields that must not be renamed or moved silently** (from the
inventory — each read in 5+ places):

- `coefficients` — 7 read sites (Zernike table, CSV/PDF export, reanalyze
  request body, invert path, averaging store)
- `height_grid` / `mask_grid` — 6+ sites each (3D mesh, Step tool, Area tool,
  cursor readout)
- `surface_height` / `surface_width` — 5+ sites (3D aspect, reanalyze body,
  averaging state)
- `pv_nm` / `rms_nm` — 5+ sites (summary bar, pass/fail coloring, CSV, PDF)
- `wavelength_nm` — 5+ sites (Zernike↔nm conversion, summary, export, Step
  tool aliasing detection)

Low-risk fields (0–1 reads, safe to restructure freely): `focus_score`,
`modulation_stats`, `plane_fit`, `_mask_full`, `coefficient_names`.

**mergeReanalyzeResult also needs a refresh.** The inventory found that on
reanalyze the merge function drops `carrier`, `confidence`, `unwrap_stats`,
`modulation_map`, `fft_image`, `confidence_maps`, `modulation_stats`. For
pure subtraction-toggle reanalysis these don't change and leaving them
stale is defensible, but it's load-bearing undocumented behavior — when we
expand reanalyze to also cover carrier override or geometry changes, the
merge function must explicitly re-merge those diagnostics.

---

## Algorithmic improvements

These are specific, targeted changes to the current pipeline. Each is
small-to-medium effort, each has a clear justification.

### A1. Exponential DC high-pass

Replace the 2×2-bin zeroing in `_find_carrier` and the background-subtraction
step in `extract_phase_dft` with a smooth exponential ramp:

```
a(ρ) = 1 - exp(-ρ² / ρ_cutoff²)
```

Multiply the Fourier plane by `a` before inverse FFT. Parameter
`dc_cutoff_cycles` (default 1.5 cycles, range 0.5–3.0) becomes a user-tunable
setting. Fixes the hard-edge-ringing issue that bites on 3–5-fringe captures
where the carrier is close to DC. Reference: DFTFringe `dftarea.cpp:684–691`.

### A2. Hybrid quality map

Compute a second quality signal beyond modulation:

```
residue_proxy = |∇²φ_wrapped|   (Laplacian of wrapped phase)
phase_consistency = 1 - clip(residue_proxy / π, 0, 1)
quality = modulation · phase_consistency
```

Use `quality` in `_quality_guided_unwrap` as the seed-selection and
propagation-order signal. Return `quality` as a confidence map in the API.
Reference: DFTFringe `dftarea.cpp:808–863`.

### A3. Anisotropic LPF aligned to carrier

The current Gaussian LPF is isotropic, so σ = 2.5·period chokes surface
detail symmetrically in both directions. In reality the unwanted spectral
components after demodulation all lie along the carrier axis:

- Original DC appears at `-carrier` after the demodulation shift
- Conjugate sideband appears at `-2·carrier`
- Surface content is concentrated near the new DC

Nothing needs to be rejected in the direction perpendicular to the carrier.
An elliptical LPF can be tight along the carrier axis (to reject DC-at-
(-carrier) and conjugate-at-(-2·carrier)) and generous perpendicular, which
preserves surface high-frequencies along that axis. Standard practice in
spatial-carrier interferometry is "orient the carrier perpendicular to the
feature of interest"; this codifies the reason.

**Implementation — move the LPF from spatial to frequency domain.**
Current code does `cv2.GaussianBlur` on the real and imaginary parts of the
demodulated complex envelope. An elliptical rotated kernel in spatial domain
is awkward (non-separable). Frequency domain is trivial: one FFT, multiply
by an oriented mask, one IFFT.

```python
# After spatial demodulation (unchanged)
demod = enhanced * np.exp(-2j * np.pi * (fy * yy + fx * xx))

# Anisotropic LPF in frequency domain
F = np.fft.fft2(demod)
F_shifted = np.fft.fftshift(F)

h, w = demod.shape
cy, cx = h // 2, w // 2
fy_grid = (np.arange(h) - cy) / h  # cycles/px, (h,) vector
fx_grid = (np.arange(w) - cx) / w  # (w,) vector
fyy, fxx = np.meshgrid(fy_grid, fx_grid, indexing='ij')

# Rotate (fyy, fxx) into carrier-aligned frame
carrier_angle = np.arctan2(fy, fx)
u_par  =  fxx * np.cos(carrier_angle) + fyy * np.sin(carrier_angle)
u_perp = -fxx * np.sin(carrier_angle) + fyy * np.cos(carrier_angle)

carrier_freq = math.sqrt(fy**2 + fx**2)
# Along carrier: tight enough to reject DC-at-(-carrier) and conjugate-at-(-2·carrier).
# Gaussian at f=carrier_freq drops to ~0.01 when sigma ≈ carrier_freq/3
sigma_par  = carrier_freq / 3.0
# Perpendicular: generous, preserve surface content up to the carrier frequency
sigma_perp = carrier_freq / 1.2

mask = np.exp(-(u_par**2 / (2 * sigma_par**2)
              + u_perp**2 / (2 * sigma_perp**2)))
demod_lp = np.fft.ifft2(np.fft.ifftshift(F_shifted * mask))
wrapped = np.angle(demod_lp)
```

**Cost.** FFT + IFFT on a 2048×2048 complex image is ~700 ms single-threaded
in numpy, ~150 ms with pyFFTW/scipy.fft. The current two Gaussian blurs with
σ=21 cost ~400 ms. Frequency-domain is comparable or faster and scales better
for larger σ.

**Edge cases to handle:**

1. Very-low-frequency carriers (3–5 fringes): `sigma_par = carrier_freq/3`
   may overlap with DC at ~0 and the surface content near DC. Add a floor:
   `sigma_par = max(carrier_freq/3, 1.0/w)` so we never reject arbitrarily
   close to DC. For 3-fringe images, effectively falls back to isotropic.
2. Carrier very close to an axis (vertical or horizontal): no special case
   — the rotation matrix handles it.
3. No carrier detected (fallback path): use isotropic Gaussian as today.
4. Sub-pixel carrier (which we now do): rotation is continuous; elliptical
   mask aligns correctly regardless of the sub-pixel offset.

**Tests.**

- `test_anisotropic_lpf_rejects_conjugate`: synthetic interferogram with
  known carrier; after anisotropic LPF, magnitude of demodulated spectrum at
  `-2·carrier` must be < 1% of peak. Same assertion for `-carrier`.
- `test_anisotropic_lpf_preserves_perpendicular_detail`: synthetic surface
  with a feature along the perpendicular axis (e.g., a ridge at 45° if the
  carrier is 0°); after demodulation, the recovered surface retains the
  ridge amplitude within 5% (vs the isotropic case which blurs it to
  maybe 40%).
- `test_anisotropic_lpf_diagonal_carrier`: carrier at 45°; verify same
  rejection and preservation properties hold.
- `test_anisotropic_lpf_low_fringe_count`: 3-fringe image; verify graceful
  fallback (no catastrophic failure even if sigma_par can't be tight
  enough).

**When to ship.** Phase 3 in the phased plan, alongside the other
algorithmic wins. Not critical-path for the metrology workflow; quality-
of-life for edge accuracy.

### A4. Band-limited carrier peak refinement

Current parabolic sub-pixel refinement uses the peak's immediate 3×3
neighbors in the FFT, which biases on low-frequency surface content (1/f
leakage from steps). Instead, mask a narrow annulus at the expected carrier
radius and fit a 2D paraboloid only to peaks inside the annulus. Excludes
DC/surface leakage by construction.

### A5. User-tunable DFT parameters

Expose two settings to an "advanced" UI section:

- `lp_sigma_fringe_multiple` (default 2.5, range 1.0–4.0): LPF width relative
  to fringe period
- `dc_cutoff_cycles` (default 1.5, range 0.5–3.0): DC high-pass radius

Reference: DFTFringe `vortexdebug.h`, `settingsdft.cpp`.

### A6. Robust averaging with rejection

Before adding a capture to an average:

1. Check carrier confidence, modulation coverage, trusted-area percentage
2. Compute residual RMS after form removal
3. Reject if any metric fails threshold; log reason

Output the accepted/rejected list alongside the averaged result. Reference:
DFTFringe `averagewavefrontfilesdlg.cpp:64–78, 120`.

### A7. Reference-flat subtraction (manual, in-session only)

**Scope.** Subtraction is an explicit, in-session-only operation. A user
picks a reference from the session's captures, picks a measurement from the
same session, and clicks "subtract." Nothing happens automatically. Nothing
persists across sessions. We do not support a "designated reference flat
that silently applies to every new capture" mode — the previous draft of
that workflow accumulated too many correctness-burden gotchas (stale
references, cross-session drift, audit invariance) for the benefit it
gave.

This is deliberately less capable than DFTFringe. The exchange is: simpler
semantics, no silent errors, each subtraction traceable to its inputs
within a single session.

#### Algorithm

**1. Compatibility gates.**

Before subtracting, check:

- Same `wavelength_nm` — warn but allow override
- Same `calibration_snapshot` (pixel_to_mm, lens_k1) — warn but allow
- Masks overlap > 80% of the smaller mask — warn below 80%, hard-fail below
  60%

These are warnings, not silent corrections. The user sees them before the
subtraction proceeds.

**2. Registration by modulation-map cross-correlation, with fallback.**

Modulation maps are the default registration signal: always positive,
typically carry illumination gradient + aperture boundary + dust features,
and are insensitive to carrier direction. But they fail on very clean flats
with uniform illumination — the modulation map is a featureless disk and
the correlation peak is broad. We need a confidence measurement and a
fallback.

```python
def register(reference, measurement):
    # Primary: modulation-map cross-correlation on intersection mask
    intersect = reference.mask & measurement.mask
    dy, dx, peak = _xcorr_register(
        reference.modulation_map * intersect,
        measurement.modulation_map * intersect)
    sidelobe = _xcorr_sidelobe_level(reference.modulation_map, measurement.modulation_map)
    confidence = peak / max(sidelobe, 1e-9)  # peak-to-sidelobe ratio

    if confidence >= 3.0:
        return RegistrationResult(dy, dx, confidence, method="modulation")

    # Fallback A: cross-correlate raw-intensity images
    # (works when there's visible residual structure, e.g. dust, edge defects,
    # fringe envelope that wasn't symmetric). Carriers should be similar.
    dy_raw, dx_raw, peak_raw = _xcorr_register(reference.raw_image, measurement.raw_image)
    conf_raw = peak_raw / _xcorr_sidelobe_level(reference.raw_image, measurement.raw_image)
    if conf_raw >= 3.0:
        return RegistrationResult(dy_raw, dx_raw, conf_raw, method="intensity")

    # Fallback B: no registration (user confirms alignment manually)
    return RegistrationResult(0.0, 0.0, max(confidence, conf_raw),
                              method="none",
                              warning="Low-confidence registration; user-verified alignment assumed")
```

Sub-pixel refinement uses parabolic fit on the correlation peak (same
pattern as `_find_carrier` sub-pixel refinement). Confidence threshold of
3.0 is a starting heuristic; tune against real captures.

UI shows the chosen method and confidence number. If the user sees
"method: none, confidence: 1.4," that's a clear signal to check alignment
visually before trusting the result.

**3. Apply the shift.**

Fourier-domain shift on the height grid (preserves sub-pixel accuracy
without interpolation artifacts):

```python
def shift_height_grid(grid, dy, dx):
    F = np.fft.fft2(grid)
    h, w = grid.shape
    fy = np.fft.fftfreq(h).reshape(-1, 1)
    fx = np.fft.fftfreq(w).reshape(1, -1)
    return np.fft.ifft2(F * np.exp(-2j * np.pi * (dy * fy + dx * fx))).real
```

**Mask shift is a separate problem. Do not use `np.roll`** — it wraps around
the image and pulls opposite-edge pixels into what should be newly-empty
space, silently corrupting the mask near the edges. Zero-fill semantics are
correct here:

```python
def shift_mask(mask, dy, dx):
    # Integer part: direct index shift with zero-fill on the vacated edges
    idy, idx = int(round(dy)), int(round(dx))
    shifted = np.zeros_like(mask)
    h, w = mask.shape
    src_y0 = max(0, -idy); src_y1 = min(h, h - idy)
    src_x0 = max(0, -idx); src_x1 = min(w, w - idx)
    dst_y0 = max(0, idy);  dst_y1 = dst_y0 + (src_y1 - src_y0)
    dst_x0 = max(0, idx);  dst_x1 = dst_x0 + (src_x1 - src_x0)
    shifted[dst_y0:dst_y1, dst_x0:dst_x1] = mask[src_y0:src_y1, src_x0:src_x1]
    # Fractional part is < 1 pixel; treating boolean mask conservatively:
    # erode by 1 pixel along the shift direction to avoid leaking invalid
    # pixels into the valid region. Cheaper and safer than interpolating
    # the mask and re-thresholding.
    return shifted & _erode_by_one(shifted, along=(idy, idx))
```

The height-grid shift and mask shift are applied to the *reference* (not
the measurement), so the subtraction lands in the measurement's coordinate
frame.

**4. Subtract on the mask intersection.**

Operate on **raw** height grids, not display grids. Each capture's display
grid has its own independently-fit form removal; subtracting them
double-corrects. The raw grid is the natural substrate.

```python
intersect = measurement.mask & shifted_ref_mask
deviation_height = np.where(intersect,
                            measurement.raw_height_grid_nm - shifted_ref_height,
                            0.0)
```

**5. Attribute.**

```
result.origin        = "subtracted"
result.source_ids    = [measurement.id, reference.id]
result.aperture      = { analysis_mask: intersect, ... }
result.warnings      = compatibility_warnings + registration_warnings
result.registration  = { shift_px: (dy, dx), confidence, method }
```

**6. Guards.**

- Refuse to subtract a `subtracted` result from another (chained
  subtraction produces confusing source_ids; block at the UI and the API)
- Refuse cross-session subtraction (the reference is in-session-only by
  design)
- Residual-RMS sanity check: after subtraction, if the deviation's RMS is
  larger than either input's RMS, something is wrong (misregistered,
  rotated, wrong reference). Warn.

#### Scope notes for the implementer

- **Registration handles translation only.** Camera rotation, camera
  distance change, perspective tilt, and reference-flat realignment
  between captures are all out of scope. These require either re-
  characterizing the reference at the new setup (hardware-level fix) or
  affine registration (significantly more complex).
- **Registration does not handle carrier change.** Each capture independently
  detects its own carrier — if the reference flat was tilted differently
  between captures, both still demodulate correctly. What matters for
  subtraction is image-geometry alignment (pixel ↔ part-point), not carrier
  alignment.
- **Three sanity checks let us detect out-of-scope scenarios cheaply:**
  (a) registration peak-to-sidelobe ratio — if < 3, translation-only
  registration can't align the maps, flag the user. (b) carrier comparison
  — if reference and measurement carriers differ by > 2% in period or > 2°
  in angle, flag a warning ("instrument reconfigured between captures").
  (c) residual RMS — post-subtraction RMS larger than either input's RMS
  is a strong indicator something fundamental is wrong.

#### Tests

- `test_subtract_identical_captures`: subtract a capture from itself
  (same session, same capture ID cloned). Result ~0 ± noise floor.
- `test_subtract_known_deviation`: reference = synthetic surface R;
  measurement = R + δ (known Gaussian bump). Recovered deviation matches δ
  within 5% RMS.
- `test_subtract_with_subpixel_translation`: shift measurement by
  (1.7, 2.3) px sub-pixel; residual RMS after registered subtraction is
  much smaller than after naïve subtraction.
- `test_subtract_mask_shift_does_not_wrap`: use the shift_mask helper with
  a shift larger than the mask extent; verify edges are zero, not wrapped.
- `test_subtract_mask_intersection`: reference and measurement masks
  partially overlap; verify n_valid_pixels is the overlap count only.
- `test_subtract_low_modulation_falls_back`: synthetic uniform-modulation
  flat (no dust, no features) → modulation-map confidence is low →
  fallback path is chosen. Test asserts the fallback triggers.
- `test_subtract_cross_wavelength_warns`: subtract He-Ne reference from
  sodium measurement; verify warning is attached but result still produced.
- `test_subtract_rejects_chained`: create a subtracted result, attempt to
  subtract it from another capture, assert explicit rejection.
- `test_subtract_residual_rms_sanity`: build a measurement that is rotated
  from the reference by 2° (out of scope for translation registration);
  verify the residual-RMS sanity check fires.

#### UI affordances

- Reference picker is a simple dropdown listing in-session captures (with
  `origin=capture` or `origin=average` only — `subtracted` results are
  grayed out as invalid reference candidates)
- Before the subtraction is committed, a preview shows the detected shift,
  the registration confidence, the registration method used, and any
  compatibility warnings
- The subtraction result is a new entry in the session capture list with
  a clear visual tag (e.g., "Δ" prefix or subtle icon) and a backlink to
  the reference ID and measurement ID

### A8. Post-unwrap plane fit for non-circular apertures

After unwrap, fit `z = a·x + b·y + c` to masked pixels via least squares
(SVD). Subtract before further analysis. Handles arbitrary-shape ROIs cleanly,
whereas Zernike-based tilt removal assumes a circular basis. Reference:
DFTFringe `dftarea.cpp:943–977`.

### A9. Effective-N uncertainty with empirical correlation length

Our current effective-N approximation uses a theoretical LPF kernel area.
Better: on a known-flat region of the actual image, measure the noise
autocorrelation length empirically. Use the measured length to derive
effective-N per region. More honest reporting when the pipeline is operating
outside its design point.

### A10. Fix defaults to match hardware

- Backend default wavelength: 632.8 nm (He-Ne) → 589.3 nm (sodium)
- Frontend default: already 589, keep aligned
- Every API request that doesn't specify wavelength inherits the system's
  calibration record, not a hardcoded constant

---

## Workflows

### Smooth-surface workflow (default)

Optical flats, polished surfaces, gentle bumps.

- Apply explicit geometry if provided, otherwise auto-mask with visible warning
- Auto-detect carrier, show diagnostics (chosen peak + alternates + confidence)
- Quality-guided unwrap using hybrid metric (A2)
- Compute `raw_height_grid_nm`; apply current form removal → `display_*`
- Allow averaging with rejection (A6)

### Small-step workflow

Steps < λ/4 (≈147 nm for sodium, ≈158 nm for HeNe).

- `correct_2pi_jumps` defaults to OFF for this mode (no median smoothing of
  real step edges)
- Step tool requires two non-overlapping plateau regions, each away from the
  step edge by at least the LPF kernel radius
- Compute region means on `display_height_grid_nm`; report mean(A) − mean(B)
- Report σ-region (scatter within each region) and effective-N SEM separately
- Warn if |step| > λ/4: aliased-wrap ambiguity banner

### Manual reference-subtraction workflow

- User picks two captures from the current session: one reference, one
  measurement
- Clicks "subtract" → sees registration preview with shift, confidence,
  method, and any compatibility warnings
- Confirms → a new session capture appears with `origin=subtracted`
- Deviation can be inspected like any other capture: area tool, step tool,
  profiles, export

The workflow is intentionally manual. No session-wide "designated reference"
state, no automatic subtraction on every new capture, no cross-session
reference persistence. For longitudinal lapping work, the user manually
exports individual measurement results (JSON including raw_height_grid_nm
and metadata), re-imports and subtracts as needed. That keeps the server
stateless, the audit trail explicit, and the "is this reference still
valid for this measurement" question entirely in the user's hands.

### Averaging-with-rejection workflow

- User captures a series of frames within the session
- At any point, selects a window of captures to average
- The rejection gate (A6) runs on each candidate; accepted frames are
  incorporated, rejected ones are logged with reasons
- Per-pixel spread map shows where the ensemble disagrees
- Result is a new `WavefrontResult` in the session capture list with
  `origin = average`, `source_ids = [accepted_ids]`, and an audit sub-
  object recording rejection reasons

### Large-step workflow (explicit ambiguity mode)

For steps ≥ λ/4 where single-wavelength single-shot cannot resolve
unambiguously.

- UI explicitly flags the ambiguity
- Does not imply traceable large-step metrology
- Future: multi-wavelength path, PSI path, or external reference integration

---

## API surface (near-term)

### `POST /fringe/analyze` and `POST /fringe/analyze-stream`

- Accept inline `aperture` (polygon set, or recipe payload sent client-side)
- Accept `calibration` object (inlined from the client's localStorage at
  request time — server does not look up a calibration by ID)
- Accept `correct_2pi_jumps`, `subtract_terms`, `lens_k1`, `lp_sigma_multiple`,
  `dc_cutoff_cycles`
- Return full `WavefrontResult` with raw/fit/display grids plus diagnostics
- Add the result to the server-side session store (keyed by session_id)

### `POST /fringe/reanalyze`

- Takes the in-session result ID + new `subtracted_terms`
- Recomputes `fit_height_grid_nm` and `display_height_grid_nm`
- Never drops the raw grid
- Returns fresh grid data so UI and measurement tools stay synced

### `GET /fringe/session/captures`

Returns the list of `WavefrontResult`s currently held in the session.

### `POST /fringe/session/average`

Body: `{ member_ids: [uuid], reject_rms_threshold_nm: float }`.
Runs rejection + average over the specified captures in the current session.
Returns a new `WavefrontResult` with `origin=average`, `source_ids=member_ids`,
and an `accepted_ids`/`rejected_ids` audit list.

### `POST /fringe/session/subtract`

Body: `{ reference_id: uuid, measurement_id: uuid }`.
Runs the A7 subtraction workflow (registration → shift → subtract → attribute)
on two in-session results. Returns a new `WavefrontResult` with
`origin=subtracted`. Both inputs must be in the same session.

### `POST /fringe/session/clear`

Clears the session store. Used on explicit "new session" or when the user
navigates away and back.

**No calibration endpoints.** Calibration is client-side; the server inlines
a snapshot into each result.

**No series endpoints.** Series are a client-side presentation concern —
given the in-session capture list, the client groups by part_id, sorts by
timestamp, renders a trend plot. Nothing server-side persists across the
session timeout.

**Export / import for cross-session continuity:**

- `GET /fringe/session/captures/{id}/export` → JSON blob with the full
  `WavefrontResult` serialized (including `raw_height_grid_nm` as
  base64-encoded Float32). Client saves to disk.
- `POST /fringe/session/import` → upload a previously-exported JSON, server
  adds it to the current session store as-is (with new session-scoped ID).
  Useful for bringing a reference measurement from a previous session to
  subtract against a new one.

---

## Frontend changes

### `frontend/fringe.js` (state owner)

- Own geometry state (polygon, active saved recipe, DXF reference)
- Own the active calibration record (loaded from localStorage, sent with
  each analyze request)
- Mirror the server session's capture list in client memory for fast tool
  access
- Coordinate cross-mode sharing of ROI / DXF / calibration

### `frontend/fringe-panel.js`

- Geometry tools: polygon, DXF-pick, saved-recipe chooser, exclusion polygons
- Warning banner when analyzing without explicit geometry
- Calibration chooser
- Mode switch between surface / small-step / reference-relative / averaging

### `frontend/fringe-results.js`

- Diagnostics panel with carrier chosen + candidates, confidence, unwrap
  quality, trusted-area, rejection-reasons
- Raw vs fitted vs display surface toggle (display is default)
- Per-term Zernike table with per-term enable/disable and RMS column
- Reanalysis always lossless (never drops raw)

### `frontend/fringe-measure.js`

- Always read `display_height_grid_nm`, which is refreshed on every
  reanalysis (fixes the P1 desync bug at the data level)
- Keep scatter/SEM labels distinct from metrology uncertainty
- Small-step tool integrates with the physics-aware warning system
- Named measurement regions persist across captures for series comparisons

---

## Implementation phases

Each phase has scope, outcome, and acceptance criteria. Each phase should
land as a small number of commits that don't break the existing single-capture
flow.

### Phase 1 — Foundations: data model, diagnostics, geometry, client-side calibration

**Outcome:** every analysis produces a typed WavefrontResult with provenance
and diagnostics. Reanalyze never desyncs. Geometry is a first-class, saved-
and-reused concept, not re-inferred from every capture. Calibration lives
in the client and each result carries a snapshot.

Geometry moved up from the previous Phase 2 — reference subtraction,
averaging, and repeatability all become substantially more trustworthy when
the aperture is stable by design rather than re-inferred from each image.
Foundational enough to block everything else, so it ships together with the
data-model work.

Scope:
- `WavefrontResult` shape extended with new fields alongside old
  (Stage 1 of the migration plan)
- Raw / fit / display grid separation (A10 foundation)
- Carrier diagnostics panel: chosen + alternates + confidence
- Trusted-area and unwrap-risk outputs
- Fix wavelength default — 10-minute bug fix, do it here so the calibration
  plumbing is already there
- Client-side `CalibrationRecord` in localStorage; UI for editing and
  switching the active calibration
- Each analyze request sends a calibration snapshot; each result carries it
- Client-side saved `GeometryRecipe` in localStorage (polygon + optional
  exclusion regions + optional DXF reference + optional microscope-ROI
  reference)
- UI for saving, naming, reusing, deleting geometry recipes
- Backend never silently falls back to full-frame when an aperture is
  provided; use_full_mask defaulted False going forward

Acceptance:
- Every analysis result exposes origin, source_ids, carrier confidence,
  trusted-area, raw grid, display grid, calibration snapshot, aperture
  recipe
- Reanalyze (subtraction toggle) updates display grid everywhere — UI,
  Step tool, 3D view — in one round trip
- A saved geometry recipe reused across captures produces identical
  analysis masks
- Tests: reanalyze lossless, carrier override round-trip, origin enum
  correctness, recipe round-trip, analyze honors supplied aperture

### Phase 2 — Quality-guided unwrap and algorithmic wins

**Outcome:** better resilience near weak fringes, edges, glare. Better small-
scale accuracy. Correct defaults.

Scope:
- Hybrid quality map (A2)
- Exponential high-pass (A1)
- Band-limited carrier refinement (A4)
- Post-unwrap plane fit for non-circular apertures (A8)
- User-tunable DFT params (A5)
- Anisotropic LPF (A3) — deferred if Phase 2 scope is tight; it's a
  refinement, not critical-path

Acceptance:
- Synthetic tests: fewer unwrap failures under edge contamination
- Synthetic tests: improved step-recovery under the small-step workflow
- Diagnostics correctly localize low-confidence regions instead of masking
  them

### Phase 3 — Session workflows: averaging and manual subtraction

**Outcome:** Loupe becomes a repeatability tool within a session. Enables
the core lapping workflow. No server-side persistence across sessions —
export / import if the user wants to carry a reference forward.

Scope:
- Server-side session store extended with typed `captures` list
- Averaging with rejection (A6) — in-session window of captures
- Manual reference subtraction (A7) — user picks two in-session captures,
  gets a subtracted result
- Per-pixel spread maps across averages
- Export / import of individual results as JSON
- Three sanity checks for subtraction (registration confidence, carrier
  comparison, residual RMS)

Acceptance:
- Three-flat test can be run end-to-end within a single session: capture
  three flats, average each with rejection, pairwise subtract
- Lapping within a session: reference capture + measurement captures +
  manual subtraction of each against the reference
- Rejected captures have human-readable reasons in the audit list
- Exported JSON round-trips cleanly to an import on a later session
- Tests: averaging rejection, reference subtraction correctness,
  registration fallback on low-modulation captures, cross-session export
  and re-import

### Phase 4 — Workflow-aware UI

**Outcome:** the UI reflects what physics each tool can claim.

Scope:
- Clear mode switcher: surface / small-step / averaging / manual subtraction
- Per-term Zernike enable/disable with RMS column
- Ambiguity warnings for large-step cases
- Plane/curvature/poly fit as first-class options alongside Zernike
- A "current series" presentation that groups the session's captures by
  part_id and renders a trend plot — entirely client-side, no server state

Acceptance:
- UI never reports a measurement outside its own claimed scope
- Advanced users can use per-term Zernike control; default users don't see
  Zernike at all unless they ask
- Trend plot updates as captures are added / rejected from an average

### Phase 5 — Ambitious / research (open-ended)

- Multi-wavelength synthetic-wavelength pipeline (needs hardware decision)
- White-light / PSI via Keyence Z-stage (requires mechanical evaluation)
- Deep-learning phase extraction
- Hilbert / Kreis demod as an alternative path
- Guided alignment assistant

---

## Test strategy

Organized by physics, not code path.

### Synthetic correctness

- Known tilt sign and magnitude (pipeline preserves sign and scale)
- Known smooth bump sign and amplitude (< λ/4)
- Wavelength scaling invariance for non-ambiguous cases
- Carrier-choice stability under brightness gradients
- Geometry-aware masking correctness
- Zernike normalization (specific numerical values, not round-trips)
- Reanalyze-lossless property: raw_height_grid is never lost

### Failure-mode tests

- Weak-carrier warnings fire when peak_ratio < threshold
- Unwrap-risk map localizes regions near edge contamination
- Empty or nearly-empty trusted mask handled without crash
- Reanalyze consistency between display and measurement grids
- Ambiguity warnings fire for large-step single-shot cases (these are
  regression tests for known limits — if they start failing, the pipeline
  gained new capability and the test should be deleted)

### Workflow tests

- Saved geometry recipe round-trips
- Averaging rejection behavior: known-bad frames rejected, reasons logged
- Reference-flat subtraction correctness on synthetic pairs
- Measurement-tool consistency after reanalysis
- Series persistence and reload
- Calibration record audit trail

### Bench-validation protocol (lives next to the automated tests)

- **Three-flat closure** with characterized flats — the canonical absolute-
  flatness calibration
- **Repeatability runs** on a stable flat pair (short-term and over-mount)
- **Gauge-block small-step checks** using region means away from the edge
- **Null checks** before any laddered step validation — two equal blocks
  wrung together should read 0 ± noise floor
- **Reference-flat drift** tracking over days/weeks — validates the
  export/import lapping workflow end-to-end (export a reference capture
  today, import and subtract next week, inspect residual trend)

---

## Recommended first milestone

Phase 1 as written above. It combines what used to be two phases (data
model + geometry) because they're mutually reinforcing — typed provenance
without stable geometry is weaker than the sum of its parts, and stable
geometry without typed provenance is harder to debug.

Post-Phase-1 the user gets:
- Every capture has traceable provenance, clean reanalysis, exposed
  diagnostics
- Geometry is defined once per aperture and reused across captures
- Calibration is a client-owned, session-inlined snapshot
- Wavelength default matches the hardware

Post-Phase-3 the user gets:
- In-session averaging with rejection (runs the three-flat test end-to-end)
- Manual reference-subtraction workflow (runs the per-session lapping
  comparison)
- Export / import of individual results for cross-session continuity when
  the user wants it, without the server carrying that burden

The remaining phases are quality-of-life (algorithms) and presentation
(workflow-aware UI), both of which build naturally on the Phase 1 & 3
foundations.

## Appendix — DFTFringe references for implementors

Quick-look table for reviewers verifying claims against DFTFringe source
(`/Users/qsmits/Projects/MainDynamics/DFTFringe`).

| Topic | File | Lines | What it shows |
|---|---|---|---|
| Wavefront struct | `wavefront.h` | 45–72 | Full data model |
| Origin enum | `wavefront.h` | 24–34 | Provenance tracking |
| Aperture objects | `wavefront.h` | 60–61 | Parametric outlines |
| Zernike norms | `zernikes.cpp` | 41–54 | `Zw[]` array, Noll convention |
| Per-term UI | `zernikeEditDlg.h` | 10–45 | Table-based subtraction |
| Smoothing metadata | `wavefront.h` | 52–54 | `wasSmoothed` + params |
| Exponential HP | `dftarea.cpp` | 684–691 | Smooth DC cutoff |
| Orientation quality | `dftarea.cpp` | 808–863 | Hybrid quality map |
| Quality-guided unwrap | `dftarea.cpp` | 561–603 | Flood from seed |
| Post-unwrap plane | `dftarea.cpp` | 943–977 | SVD plane fit |
| Averaging + rejection | `averagewavefrontfilesdlg.cpp` | 41–134 | RMS threshold, audit |
| Rejected list | `rejectedwavefrontsdlg.cpp` | — | Audit UI |
| Reference subtract | `surfacemanager.cpp` | 1907–1971 | Wavefront − wavefront |
| Session loader | `wavefrontloaderworker.cpp` | 22–31 | `.wft` format |
| Batch wizard | `batchigramwizard.cpp` | 30–150 | Multi-image processing |
| Auto-invert (skip) | `autoinvertdlg.cpp` | 18–47 | Telescope-only |
| Annular Zernikes (skip) | `zernikeprocess.cpp` | 382–384 | `zapm()` basis |
| Mirror config (skip) | `mirrordlg.h` | 48–59 | ROC / conic / diameter |
| User settings | `settingsdft.cpp`, `vortexdebug.h` | — | Tunable params |
