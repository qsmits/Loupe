# Fringe Mode Implementation Plan

Companion to `fringe-design.md`. The design doc answers *what* and *why*;
this doc answers *in what order, with what tests, with what acceptance*.
Each milestone below is sized for one or two focused sessions, kept shippable
in isolation, and does not break the existing single-capture flow.

The plan covers Phases 1–4. Phase 5 is research-grade and is summarized
only. Inside each phase, milestones are ordered so master stays green
after every landed commit.

Overall sequencing constraint: **Phase 1 must land complete before
Phases 2–4 start.** Phases 2 and 3 can run in parallel if needed (they
touch different code paths). Phase 4 depends on both.

---

## Sequencing overview

```
Phase 1 (Foundations) — ✅ complete
  ├── M1.1  WavefrontResult skeleton + stage-1 wire format         [S]  ✅
  ├── M1.2  Client-side calibration record                         [S]  ✅
  ├── M1.3  Raw / fit / display grid separation                    [M]  ✅
  ├── M1.4  Geometry recipes (localStorage + UI)                   [M]  ✅
  ├── M1.5  Carrier diagnostics panel                              [M]  ✅
  ├── M1.6  Trusted-area and unwrap-risk outputs                   [S]  ✅
  └── M1.7  Server session captures list (typed)                   [S]  ✅

Phase 2 (Algorithmic wins) — ✅ complete
  ├── M2.1  A1 Exponential DC high-pass                            [S]  ✅
  ├── M2.2  A4 Band-limited carrier peak refinement                [S]  ✅
  ├── M2.3  A2 Hybrid quality map for unwrap                       [M]  ✅
  ├── M2.4  A8 Post-unwrap plane fit for non-circular apertures    [S]  ✅
  ├── M2.5  A5 User-tunable DFT parameters                         [S]  ✅
  └── M2.6  A3 Anisotropic LPF (deferred from spec, shipped 2:1)   [M]  ✅

Phase 3 (Session workflows) — ✅ complete
  ├── M3.1  Session store: list + index + timeout                  [M]  ✅ (folded into M1.7)
  ├── M3.2  A6 Averaging with rejection — backend                  [M]  ✅
  ├── M3.3  Averaging with rejection — UI                          [M]  ✅
  ├── M3.4  A7 Manual subtraction — backend                        [M]  ✅
  ├── M3.5  A7 Registration primary + fallback                     [L]  ✅
  ├── M3.6  A7 Subtraction UI with preview & guards                [M]  ✅
  └── M3.7  Export / import individual results                     [M]  ✅

Phase 4 (Workflow-aware UI) — ✅ complete
  ├── M4.1  Mode switcher scaffolding                              [S]  ✅
  ├── M4.2  Per-term Zernike table with RMS                        [M]  ✅
  ├── M4.3  Plane / poly2 / poly3 fit first-class                  [M]  ✅
  ├── M4.4  Ambiguity warnings                                     [S]  ✅
  └── M4.5  In-session trend plot                                  [M]  ✅
```

Size legend: S = 1 session, M = 1–2 sessions, L = 2–3 sessions.

---

## Phase 1 — Foundations

Goal: every capture has typed provenance, clean reanalysis, stable
geometry, and correct calibration. Everything downstream depends on this.

### M1.1 — WavefrontResult skeleton + stage-1 wire format

**Scope.** Backend analyze responses add new fields alongside the existing
ones. Frontend reads them where relevant but falls back to old fields
where it hasn't migrated.

**Backend changes.**
- `backend/vision/fringe.py`: `analyze_interferogram` builds a
  `WavefrontResult` dict with `id`, `origin`, `source_ids`, `captured_at`,
  `calibration_snapshot`, `warnings` list, `aperture_recipe`,
  `raw_height_grid_nm`, `raw_mask_grid`. Existing fields (`height_grid`,
  `mask_grid`, etc.) kept alongside as before — no renames.
- `backend/api_fringe.py`: analyze request bodies accept an optional
  `calibration` object (wavelength, pixel_to_mm, lens_k1, source,
  uncertainty); falls back to the current query-param defaults if missing.
- `backend/api_fringe.py`: responses include the new fields.

**Frontend changes.**
- `frontend/fringe-results.js`: `renderResults` captures the new fields
  into `fr.lastResult`. No consumer migration yet.
- Add a small helper `fr.lastResult.wavefront()` that returns the new-style
  view; nothing uses it yet.

**Tests.**
- `test_analyze_result_has_wavefront_fields`: assert origin, source_ids,
  calibration_snapshot, raw_height_grid_nm, raw_mask_grid are present
- `test_analyze_inlines_calibration`: send a calibration object; verify the
  snapshot in the response matches
- `test_analyze_default_calibration`: no calibration sent → snapshot still
  populated from defaults
- `test_backward_compat`: existing fields (height_grid, pv_nm, etc.) still
  present and unchanged

**Acceptance.**
- No existing test fails
- Frontend still works identically (no visible behavior change)
- The new fields are present in every response

**Risks.** Minimal — purely additive.

### M1.2 — Client-side calibration record

**Scope.** Calibration lives in localStorage. UI to create, edit, switch,
export, import. Every analyze request sends the active calibration.

**Frontend changes.**
- New file `frontend/fringe-calibration.js`: CRUD helpers over
  localStorage, JSON export/import, default set on first load (sodium D1/D2
  doublet at 589.3 nm, pixel_to_mm=0, lens_k1=0, uncertainty 0.3 nm)
- `frontend/index.html` + `frontend/fringe-panel.js`: calibration chooser
  dropdown, "Edit calibration" dialog, "Export" and "Import" buttons
- `frontend/fringe.js`: active calibration tracked in state; included in
  analyze payloads
- `frontend/fringe-results.js`: summary bar shows the active calibration's
  name and wavelength (not hardcoded)

**Backend changes.**
- None (calibration is plumbed through M1.1 already).

**Tests.**
- Node script `test_calibration_roundtrip.mjs` (or similar) that exercises
  the localStorage CRUD — create, list, update, delete, export, import
- Integration: `.venv/bin/pytest tests/test_fringe.py -k calibration` for
  the backend-side snapshot handling from M1.1 (already covered)

**Acceptance.**
- User can create a "Na D1/D2" calibration and a "He-Ne" calibration,
  switch between them; each analyze request uses the active one
- Exported JSON reimports bit-identical
- Wavelength default is 589.3 nm on fresh install

**Risks.** Ensure the import path validates uploaded JSON — malformed
calibrations shouldn't corrupt localStorage.

### M1.3 — Raw / fit / display grid separation

**Scope.** Backend always computes raw + display grids. Reanalyze updates
display from raw without re-running phase extraction.

**Backend changes.**
- `backend/vision/fringe.py`: `analyze_interferogram` keeps the pre-
  form-removal height as `raw_height_nm`; form removal now produces
  `display_height_nm = raw_height_nm - fitted_form`. Response includes
  both downsampled grids (`raw_height_grid_nm` and
  `display_height_grid_nm` — the latter aliases to the existing
  `height_grid` for now to preserve compatibility).
- `backend/vision/fringe.py`: `reanalyze` takes the raw grid in its input
  and recomputes only fit + display. Returns fresh `display_height_grid_nm`
  and unchanged `raw_height_grid_nm`.

**Frontend changes.**
- `frontend/fringe-results.js`: `mergeReanalyzeResult` also updates
  `fr.lastResult.display_height_grid_nm` explicitly
- `frontend/fringe-measure.js`: Step tool + Area tool read
  `display_height_grid_nm` if present, else fall back to `height_grid`
  (no visible change until M1.6 consolidates)

**Tests.**
- `test_reanalyze_preserves_raw_grid`: raw grid identical before and after
  a subtraction pill toggle
- `test_reanalyze_updates_display_grid`: display grid differs after
  subtract_terms changes
- `test_raw_grid_contains_form`: raw grid includes tilt / curvature that
  display grid has subtracted (synthetic tilt test)

**Acceptance.**
- Every reanalyze call returns fresh display grid
- Step tool values match across the raw/display distinction as expected
- No regressions in existing tests

**Risks.** Storage size: we now store two grids per result. At 256×256×4
bytes each that's 512 KB per result — acceptable for session-scoped use.

### M1.4 — Geometry recipes (localStorage + UI)

**Scope.** Polygon apertures can be named, saved, and reused. Recipes
persist across browser sessions via localStorage, not server-side.

**Frontend changes.**
- New file `frontend/fringe-geometry.js`: CRUD over localStorage, JSON
  export/import, versioning
- Drawing UI: existing polygon tool output can be saved as a named recipe
- Recipe chooser dropdown in the fringe panel; active recipe is sent with
  every analyze request
- Active recipe shown as a small badge in the UI; "no recipe (auto-mask)"
  option with a warning badge

**Backend changes.**
- `backend/api_fringe.py`: analyze request accepts `aperture_recipe`
  (polygons + optional exclusions); rasterizes into the `custom_mask`
  path
- `backend/vision/fringe.py`: `use_full_mask` defaulted to False going
  forward; auto-mask is opt-in (explicit user choice, not silent fallback)

**Tests.**
- `test_aperture_recipe_rasterization`: known polygon recipe rasterizes
  to the expected boolean mask
- `test_aperture_recipe_applied_to_analysis`: analyze with a recipe
  excludes masked regions from the height grid
- `test_aperture_recipe_missing_defaults_to_auto_with_warning`: no recipe
  sent → response includes a `warnings` entry

**Acceptance.**
- Creating, saving, reusing a recipe produces identical masks across
  captures
- Backend never silently falls back to full-frame mask when a recipe is
  provided
- Recipe JSON round-trips through export/import

**Risks.** Coordinate-frame confusion: recipes are in image-pixel space,
which depends on camera resolution. If a recipe is loaded for a capture
from a different camera / resolution, we need to warn or re-scale. For M1.4
we just warn; scaling is deferred.

### M1.5 — Carrier diagnostics panel

**Scope.** Expose the carrier choice, alternates, and confidence in the UI.
Allow manual override via click-on-FFT (existing infra).

**Backend changes.**
- `backend/vision/fringe.py`: `_find_carrier` and `_analyze_carrier`
  expose top-N candidate peaks (default N=3) with magnitudes, frequencies,
  period_px, angle_deg, and distance_px from DC
- Response includes `carrier.chosen`, `carrier.candidates`,
  `carrier.confidence`, `carrier.override` (bool)

**Frontend changes.**
- New panel in `frontend/fringe-results.js`: carrier diagnostics section
  — chosen peak, alternates in a small table, confidence metrics,
  "override" badge when user-forced
- `frontend/fringe-panel.js`: click-on-FFT override already exists;
  marks `carrier.override = true` on the resulting result

**Tests.**
- `test_carrier_returns_candidates`: response has N candidate peaks
- `test_carrier_confidence_fields`: peak_ratio, SNR, DC margin all present
- `test_carrier_override_marks_flag`: override path sets `carrier.override`

**Acceptance.**
- User can see at a glance why the pipeline picked the carrier it picked
- User can override and the override is visible in the diagnostics

**Risks.** Candidate extraction needs to suppress the conjugate sideband
(same half-plane we already zero); otherwise candidates are just the
reflection of the chosen peak.

### M1.6 — Trusted-area and unwrap-risk outputs

**Scope.** Compute a `trusted_mask` (pixels that passed modulation + unwrap
quality thresholds) and a scalar trusted-area percentage. Return both.

**Backend changes.**
- `backend/vision/fringe.py`: unwrap step computes a quality map
  (modulation × phase-consistency — foundation for A2 in Phase 2);
  pixels below threshold are marked "untrusted" but still included in
  display
- `WavefrontResult.aperture.trusted_mask` and
  `WavefrontResult.stats.trusted_area_pct` populated

**Frontend changes.**
- `frontend/fringe-results.js`: trusted-area percentage in summary bar
- Measurement tools can optionally exclude untrusted pixels (checkbox
  "use trusted pixels only")

**Tests.**
- `test_trusted_area_percentage_present`: field populated
- `test_trusted_mask_subset_of_analysis_mask`: trusted_mask ⊆ analysis_mask
- `test_low_modulation_reduces_trusted_area`: synthetic low-mod region
  drops trusted_area_pct

**Acceptance.**
- Trusted area is visible in the UI
- Measurements can be restricted to trusted pixels

**Risks.** Threshold tuning — set a reasonable default and expose in M2.5.

### M1.7 — Server session captures list (typed)

**Scope.** Extend the existing `_fringe_cache` into a typed captures list
per session. Minimal viable version — just the list; averaging and
subtraction build on this in Phase 3.

**Backend changes.**
- `backend/api_fringe.py`: after every `analyze` or `analyze-stream`,
  append the result to `session.captures`
- New endpoint `GET /fringe/session/captures` — returns a lightweight
  summary (id, origin, captured_at, stats) of each capture in the session
- New endpoint `POST /fringe/session/clear` — clears the session store
- Session timeout already exists; no change needed

**Frontend changes.**
- `frontend/fringe-results.js`: "session captures" sidebar showing the
  list, allowing the user to click and re-display a prior capture
- "Clear session" button in the fringe panel

**Tests.**
- `test_session_captures_accumulate`: three analyze calls → three
  captures in the list
- `test_session_clear_empties_list`: after clear, list is empty
- `test_session_timeout_evaporates`: simulate timeout → captures gone

**Acceptance.**
- User can see the list of captures made this session
- Reloading the browser starts fresh (no persistence beyond session)

**Risks.** Memory pressure for long sessions with many captures. Cap at
100 captures per session with FIFO eviction and a visible warning.

---

## Phase 2 — Algorithmic wins

Goal: measurably better recovery on edge-case captures — low fringe count,
contamination, near-edge features, sub-optimal carrier. Each milestone is
independently shippable.

### M2.1 — A1: Exponential DC high-pass

**Scope.** Replace hard 2×2 DC zeroing in `_find_carrier` and background
subtraction in `extract_phase_dft` with smooth exponential ramp.

**Backend changes.**
- `backend/vision/fringe.py`:
  - `_find_carrier`: replace hard zero margin with
    `a(ρ) = 1 - exp(-ρ²/ρ_cutoff²)` multiplier
  - `extract_phase_dft`: apply the same in frequency domain before
    demodulation
- New parameter `dc_cutoff_cycles` (default 1.5, exposed via API in M2.5)

**Tests.**
- `test_low_fringe_count_carrier_detection`: 3-fringe synthetic image;
  verify carrier found near correct frequency (new behavior should
  handle this without special-casing)
- `test_no_spectral_ringing`: flat image with vignetting; verify no
  ring artifacts in recovered phase

**Acceptance.**
- Low-fringe-count captures no longer snap to wrong bin
- Existing test coverage unchanged

**Risks.** The existing retry logic at low frequencies may become
redundant. Simplify or delete if no longer needed.

### M2.2 — A4: Band-limited carrier peak refinement

**Scope.** Sub-pixel peak fit uses an annulus-masked region around the
expected carrier, excluding low-frequency leakage.

**Backend changes.**
- `backend/vision/fringe.py::_find_carrier`: after finding the integer
  peak, mask an annulus (radius ± 2 bins) and fit a 2D paraboloid to
  magnitudes inside the annulus; return the paraboloid vertex as
  sub-pixel coordinates

**Tests.**
- `test_subpixel_carrier_unbiased_by_step`: synthetic image with a
  step feature; verify detected carrier is within 0.1 bin of truth
  (current behavior biases by ~0.9 bin)
- `test_subpixel_carrier_smooth_surface`: clean fringes, no surface
  content; verify detected carrier matches truth exactly

**Acceptance.**
- Step-feature captures no longer introduce slope artifacts from
  carrier-bin drift
- Reference subtraction and averaging get more stable baselines

**Risks.** Paraboloid fit requires enough bins — if the image is too
small, fall back to the current 3-point parabolic fit.

### M2.3 — A2: Hybrid quality map for unwrap

**Scope.** Quality-guided unwrap uses modulation × phase-consistency
instead of modulation alone.

**Backend changes.**
- `backend/vision/fringe.py`:
  - Compute wrapped-phase Laplacian as a proxy for residue density
  - Define `quality = modulation * (1 - clip(|∇²φ|/π, 0, 1))`
  - Use `quality` as seed-selection and propagation-order signal in
    `_quality_guided_unwrap`
  - Return `quality_map_b64` and `n_residues` in the WavefrontResult's
    `unwrap` section

**Tests.**
- `test_unwrap_flood_starts_from_high_quality_pixel`: synthetic image
  with a localized low-quality region; verify unwrap starts outside it
- `test_residue_detection`: synthetic image with a known phase residue;
  verify n_residues reports non-zero
- `test_edge_contamination_fewer_artifacts`: dust-like contamination
  near the aperture edge; verify fewer unwrap artifacts than current
  code

**Acceptance.**
- Demonstrable improvement on contaminated captures (fewer stripe
  artifacts, correct unwrap near low-modulation patches)
- No regression on clean captures

**Risks.** The Laplacian is noisy in low-SNR regions. Smooth before
thresholding; test against varying noise levels.

### M2.4 — A8: Post-unwrap plane fit for non-circular apertures

**Scope.** After unwrap, fit `z = a·x + b·y + c` to masked pixels;
subtract if user selected "plane" or "plane + curvature" form model.
Already exists (`_fit_plane`) — wire it as the canonical path for
non-circular apertures.

**Backend changes.**
- `backend/vision/fringe.py::analyze_interferogram`: when
  `form_model == "plane"`, ensure `_fit_plane` runs on the unwrapped phase
  before conversion to height, handling rectangular / polygonal apertures
- `form_model == "zernike"` with `subtract_terms=[1,2,3]` still works
  (uses Zernike-basis tilt), but the UI defaults to "plane" for
  non-circular recipes

**Tests.**
- `test_plane_fit_rectangular_aperture`: analyze a rectangular ROI with
  synthetic tilt + plane model; verify tilt is removed
- `test_plane_fit_noncircular_polygon`: irregular polygon aperture; verify
  plane fit succeeds and subtracts tilt

**Acceptance.**
- Users with non-circular apertures (polygon ROIs) get correct tilt
  removal without Zernike approximation artifacts

**Risks.** SVD-based plane fit is well-conditioned for reasonable
geometries; degenerate cases (very thin apertures) may need a guard.

### M2.5 — A5: User-tunable DFT parameters

**Scope.** Expose `lp_sigma_fringe_multiple` (default 2.5) and
`dc_cutoff_cycles` (default 1.5) in the API and UI.

**Backend changes.**
- `backend/api_fringe.py`: analyze body accepts both parameters with
  defaults
- `backend/vision/fringe.py`: honor them through `extract_phase_dft`
  and `_find_carrier`

**Frontend changes.**
- `frontend/fringe-panel.js`: "Advanced" collapsible section with two
  sliders + numeric entry for each parameter; reset-to-default button
- Active values included in the analyze request

**Tests.**
- `test_lp_sigma_multiple_respected`: synthetic image analyzed at two
  different multiples; verify the displayed surface differs correspondingly
- `test_dc_cutoff_respected`: same pattern

**Acceptance.**
- Advanced users can tune the LPF and DC cutoff per-capture
- Defaults unchanged for non-advanced users

**Risks.** None — additive.

### M2.6 — A3: Anisotropic LPF (may defer)

**Scope.** Replace isotropic Gaussian with elliptical frequency-domain
mask aligned to carrier direction.

**Backend changes.**
- `backend/vision/fringe.py::extract_phase_dft`:
  - Move LPF from spatial (cv2.GaussianBlur) to frequency domain
  - Build rotated elliptical Gaussian mask using the detected carrier
    angle
  - `sigma_par = carrier_freq / 3.0`,
    `sigma_perp = carrier_freq / 1.2` as defaults
  - Expose `lp_sigma_parallel_factor` and `lp_sigma_perp_factor` for
    advanced tuning

**Tests.**
- `test_anisotropic_lpf_rejects_conjugate`: mask magnitude at
  `-2·carrier` < 1% of peak
- `test_anisotropic_lpf_preserves_perpendicular_detail`: perpendicular-
  axis feature recovered within 5% vs ~40% loss in isotropic case
- `test_anisotropic_lpf_diagonal_carrier`: 45° carrier works correctly
- `test_anisotropic_lpf_low_fringe_count`: graceful fallback when
  sigma_par can't be tight enough

**Acceptance.**
- Edge detail on step-perpendicular-to-carrier features visibly sharper
- No regression on clean captures

**Risks.** Frequency-domain LPF requires careful shift handling. Test
thoroughly on both axis-aligned and diagonal carriers. **Deferrable if
Phase 2 scope is tight** — the quality-of-life gain is real but not
critical-path.

---

## Phase 3 — Session workflows

Goal: averaging and manual subtraction. Turns the fringe mode into a
repeatability tool within a session, with cross-session continuity via
export/import.

### M3.1 — Session store: list + index + timeout

**Scope.** Build on M1.7. Add indexed access, ordering, capacity limits.

**Backend changes.**
- `backend/api_fringe.py`: session store gains:
  - `GET /fringe/session/captures/{id}` — fetch one capture by ID
  - `DELETE /fringe/session/captures/{id}` — remove one
  - Ordered by `captured_at`
  - Capacity cap (100 captures/session) with FIFO eviction and warning
    in the response

**Tests.**
- `test_session_captures_fetch_by_id`: GET single capture returns the
  full WavefrontResult
- `test_session_captures_capacity`: 101st capture evicts the first
- `test_session_captures_delete`: remove one; list size shrinks

**Acceptance.**
- Individual captures can be fetched, deleted, listed in order
- Sessions can't blow up memory indefinitely

**Risks.** The 100-capture cap may surprise users in long sessions.
Document prominently; consider an explicit "expand capacity" flag later.

### M3.2 — A6: Averaging with rejection (backend)

**Scope.** Given a list of in-session capture IDs, produce an averaged
WavefrontResult with rejection audit.

**Backend changes.**
- `backend/vision/fringe.py`: new `average_wavefronts` function
  - For each candidate, compute per-capture residual RMS after form
    removal
  - Reject if RMS > threshold (default 0.15 λ, parameterized)
  - Also reject if carrier confidence < threshold or trusted_area_pct <
    threshold
  - Accepted captures combined via pixel-wise mean on intersection mask
  - Compute per-pixel spread (std dev across accepted captures)
- New endpoint `POST /fringe/session/average` — body `{member_ids,
  reject_rms_threshold_nm, reject_confidence_threshold}`
- Returns a WavefrontResult with `origin=average`, `source_ids=accepted`,
  `rejected_ids`, per-capture rejection reasons in `warnings`

**Tests.**
- `test_average_of_identical_captures`: two identical captures → average
  equals input, spread is zero
- `test_average_with_outlier_rejected`: three captures, one with a
  known artifact → that one is rejected, average is clean
- `test_average_rejection_audit_trail`: rejection reasons are human-
  readable and reference the right metric

**Acceptance.**
- Bad captures don't corrupt the average
- User can inspect why a capture was rejected

**Risks.** Alignment across captures — if the part drifted between
captures, the average is bad even if each capture is good. Document
that averaging assumes stationary mounting; if drift is visible in the
spread map, users should re-capture. Alignment across averaged captures
is explicitly out of scope for M3.2 (it's an open question deferred).

### M3.3 — Averaging with rejection (UI)

**Scope.** UI to select captures and average them.

**Frontend changes.**
- Session captures sidebar gains checkboxes for multi-select
- "Average selected" button with a rejection-threshold slider in a
  popover
- Averaging progress indicator (re-uses the existing SSE progress
  infrastructure)
- Result appears in the capture list with an "average" tag and an
  expandable panel showing accepted/rejected members with reasons

**Tests.**
- Manual verification on synthetic and real captures
- (Optional) Playwright test if the project has one

**Acceptance.**
- User can select 3–10 captures and produce an average with visible
  audit
- Rejected captures' reasons are clearly shown

**Risks.** UX complexity — tight design iteration to avoid clutter.

### M3.4 — A7: Manual subtraction (backend, no registration yet)

**Scope.** Subtract two in-session captures, pixel-aligned, no
registration. Includes compatibility gates and chain guards.

**Backend changes.**
- `backend/vision/fringe.py`: new `subtract_wavefronts` function
  - Compatibility checks (wavelength, calibration, mask overlap);
    warnings added, hard fail on < 60% overlap or chained-subtraction
    attempt
  - Subtract raw grids on mask intersection; write new WavefrontResult
    with `origin=subtracted`, `source_ids=[measurement, reference]`
- New endpoint `POST /fringe/session/subtract` — body
  `{reference_id, measurement_id}`

**Tests.**
- `test_subtract_identical_captures`: deviation ≈ 0
- `test_subtract_known_deviation`: reference + known delta, verify
  recovery within 5% RMS
- `test_subtract_mask_intersection`: partially-overlapping masks
- `test_subtract_cross_wavelength_warns`: warning attached
- `test_subtract_rejects_chained`: subtracted result can't be an input
- `test_subtract_low_overlap_fails`: < 60% mask overlap → error

**Acceptance.**
- End-to-end subtraction works for well-aligned in-session pairs
- Guards prevent obvious misuse

**Risks.** Deferring registration means misregistered subtractions will
have large residuals — which is fine for M3.4 (user sees the problem in
the residual RMS and knows to wait for M3.5).

### M3.5 — A7: Registration primary + fallback

**Scope.** Modulation-map cross-correlation with confidence metric;
raw-intensity fallback; "no registration" fallback with prominent
warning.

**Backend changes.**
- `backend/vision/fringe.py`: new `register_captures` function
  - Primary: modulation-map cross-correlation with parabolic sub-pixel
    refinement and peak-to-sidelobe confidence
  - If confidence < 3.0: raw-intensity cross-correlation fallback
  - If both confidences < 3.0: `method=none, confidence=low`, warning
  - Returns `{dy, dx, confidence, method, warning?}`
  - Resolution mode: hosted deployments (`HOSTED` env var set) downsample
    to 512² before correlation; local/on-prem run at full source
    resolution. Sub-pixel fit of the correlation peak preserves accuracy
    in either case. `register_captures` reads `os.environ["HOSTED"]`
    directly so the behavior matches the rest of `backend/main.py`'s
    hosted-mode gates.
- `subtract_wavefronts` uses `register_captures` and applies the shift
  via Fourier shift on the reference raw grid and explicit zero-fill
  mask shift (NOT np.roll)
- Residual-RMS sanity check after subtraction; warning if deviation
  RMS > input RMS

**Tests.**
- `test_subtract_with_subpixel_translation`: (1.7, 2.3) px shift;
  residual RMS after registration much smaller than naïve subtraction
- `test_mask_shift_does_not_wrap`: large shift; edges are zero, not
  wrapped
- `test_registration_fallback_on_low_modulation`: uniform-modulation
  reference → fallback method invoked
- `test_registration_reports_low_confidence`: two uncorrelated
  captures → method=none, warning set
- `test_residual_rms_sanity_check`: simulated 2° rotation → residual
  RMS warning fires

**Acceptance.**
- Cross-session subtraction workflow is viable (user imports reference
  from a previous session, subtracts; registration handles sub-pixel
  drift automatically)
- Out-of-scope scenarios (rotation, perspective) are flagged, not
  silently corrupted

**Risks.** Performance — cross-correlation on 2048² images is ~500 ms.
Mitigated by hosted-mode 512² downsample; local/on-prem runs full-res to
preserve maximum registration accuracy.

### M3.6 — A7: Subtraction UI with preview and guards

**Scope.** UI to pick reference + measurement, preview registration
before committing, show warnings.

**Frontend changes.**
- Reference picker and measurement picker in a "Subtract" dialog;
  dropdowns filter in-session captures (origin ∈ {capture, average},
  not `subtracted`)
- Preview panel: detected shift, confidence, method, compatibility
  warnings
- "Confirm" commits; "Cancel" returns to the previous view
- Result appears in the capture list with a Δ badge and backlinks to
  measurement and reference

**Tests.**
- Manual verification
- E2E test if available

**Acceptance.**
- User can't accidentally subtract incompatible captures without seeing
  warnings first
- The new subtracted result is navigable and labeled

**Risks.** UX dense enough that iteration is likely needed.

### M3.7 — Export / import individual results

**Scope.** JSON export of a single WavefrontResult, including the full
raw_height_grid_nm as base64-encoded Float32. Import adds to the current
session with a new ID.

**Backend changes.**
- New endpoints:
  - `GET /fringe/session/captures/{id}/export`
  - `POST /fringe/session/import` (multipart file upload)
- Exported JSON schema versioned; import validates and rejects old/new
  incompatible versions with a clear error

**Frontend changes.**
- "Export" button per capture in the session list; downloads as JSON
- "Import" button in the session panel; opens file picker; imported
  capture shows up in the session list tagged with `origin=file`

**Tests.**
- `test_export_import_roundtrip`: export, reimport, verify identical
  WavefrontResult (modulo new session-scoped ID)
- `test_import_rejects_old_schema`: synthetic v0 export → clear error
- `test_export_size_reasonable`: 256×256 grid exports to < 500 KB JSON

**Acceptance.**
- Cross-session lapping workflow works: capture a reference today,
  export, reimport next week, subtract against new capture
- Import validation is strict; no silent corruption

**Risks.** JSON size — Float32Array as base64 doubles storage. Consider
gzip on the wire; acceptable for now.

---

## Phase 4 — Workflow-aware UI

Goal: UI makes the physics-appropriate tools obvious; users can't
accidentally misuse them.

### M4.1 — Mode switcher scaffolding

**Scope.** Radio / dropdown at the top of the fringe panel selecting
mode: Surface / Small-step / Averaging / Subtraction. Each mode shows
only the relevant tools; measurements labeled with their mode.

**Frontend changes.**
- `frontend/fringe-panel.js`: mode selector; mode-specific tool visibility
- Each tool's output labeled with the current mode

**Tests.**
- Manual verification

**Acceptance.**
- Tool palette adapts to the selected mode
- Measurements exported/saved carry their mode tag

**Risks.** Mode state must not leak across analyze calls in a way that
surprises users. Mode is a UI-only concept; backend ignores it.

### M4.2 — Per-term Zernike table with RMS

**Scope.** Replace the current "subtract [1,2,3]" checkbox-list with a
table: one row per Zernike term, with name, raw coefficient, RMS
coefficient, individual enable toggle.

**Frontend changes.**
- `frontend/fringe-results.js`: new Zernike table component; reads
  `zernike_coeffs` and `zernike_norm_weights` from WavefrontResult;
  toggle maps to `subtract_terms` via reanalyze
- Column for peak vs RMS normalization (toggle)

**Backend changes.**
- `WavefrontResult.zernike_norm_weights` populated in analyze (the
  normalization constants for each fit term)
- No change to reanalyze logic

**Tests.**
- `test_zernike_norm_weights_present`: field populated
- `test_rms_display_matches_analytic`: synthetic surface with known
  tilt magnitude; verify reported RMS matches `magnitude / √3`

**Acceptance.**
- User can toggle individual Zernike terms and see their RMS /
  peak-to-valley contribution

**Risks.** UI complexity — 36 rows is a lot. Group visually (tilt,
defocus, astigmatism, coma, spherical, higher).

### M4.3 — Plane / curvature / polynomial fit first-class

**Scope.** Form-removal model selector (plane / low-order polynomial /
Zernike) as equals, not Zernike with plane as a hidden special case.

**Backend changes.**
- `backend/vision/fringe.py`: `form_model` takes
  `"plane" | "poly2" | "poly3" | "zernike"`
- "poly2" / "poly3" fit polynomial surfaces of degrees 2 and 3 (includes
  defocus + astigmatism)

**Frontend changes.**
- Form model dropdown in fringe panel with the new options
- Each option's description shown inline

**Tests.**
- `test_poly2_fit_removes_defocus_and_tilt`
- `test_poly3_fit_handles_coma_like_surface`

**Acceptance.**
- User picks polynomial when the aperture is non-circular; picks
  Zernike when the aperture is circular; either produces reasonable
  form removal

**Risks.** Poly fit on non-circular apertures can be ill-conditioned;
test with several geometries.

### M4.4 — Ambiguity warnings

**Scope.** When a Step tool measurement exceeds λ/4, show a clear banner
that the result is likely aliased. When the analysis `warnings` list is
non-empty, show them prominently.

**Frontend changes.**
- `frontend/fringe-measure.js`: already shows a warning for |step| > λ/4;
  extend with a tooltip explaining why
- `frontend/fringe-results.js`: warnings list rendered as a dismissible
  banner above the surface map

**Tests.**
- Manual verification

**Acceptance.**
- Users cannot miss an ambiguity warning

**Risks.** None.

### M4.5 — In-session trend plot

**Scope.** Given the session's captures, group by some user-selected tag
(e.g., operator name, calibration name, first N characters of note
field), sort by timestamp, plot PV/RMS over time.

**Frontend changes.**
- New component `frontend/fringe-trend.js`: simple line chart
- Session captures sidebar gains a "show trend" button

**Tests.**
- Manual verification

**Acceptance.**
- User can see lapping progress within a session at a glance

**Risks.** None — purely presentation.

---

## Phase 5 — Ambitious / research

Not scoped here as concrete milestones. Listed for completeness.

- Multi-wavelength synthetic-wavelength pipeline (needs hardware —
  second source; user mentioned possibly getting a He-Ne)
- PSI via Keyence Z-stage (needs mechanical evaluation)
- Hilbert / Kreis demod as an alternative path
- Deep-learning phase extraction (speculative, 1-month+ project)
- Guided alignment assistant (can prototype once Phase 1 diagnostics land)
- Sub-aperture stitching (needs XY stage workflow design)

Each would earn its own design doc + plan when prioritized.

---

## Testing strategy across phases

Each milestone lands with its own tests (see per-milestone lists above).
Across phases:

**Regression suite.** Every milestone runs:
```
.venv/bin/pytest tests/test_fringe.py  (target: no red)
```

**Bench validation protocol.** After Phase 3 completes:
- Three-flat closure with characterized flats
- Repeatability run (10 captures, same mount) — verify averaging
  rejects none and per-pixel spread is below λ/20
- Gauge-block small-step check (if sub-λ/4 blocks available) — verify
  recovered step matches truth within 10%
- Null check — two equal blocks wrung → step reads 0 ± noise floor
- Reference-flat drift — capture, export, reimport, subtract; verify
  residual is within noise

Bench protocol lives next to the automated tests as a markdown checklist.

---

## Risk register

| Risk | Phase | Severity | Mitigation |
|---|---|---|---|
| Migration breaks existing frontend | 1 | High | Stage-1 additive wire format; test backward compat each milestone |
| Session memory growth | 1, 3 | Medium | 100-capture cap with eviction, visible warning |
| Averaging assumes stationary mount | 3 | Medium | Document; flag in the UI when spread map is large |
| Registration fails silently on out-of-scope shifts | 3 | Medium | Three sanity checks (confidence, carrier compare, residual RMS) — explicit in A7 |
| Frequency-domain LPF shift handling bugs | 2 | Low | Thorough tests, especially diagonal carriers |
| UI complexity explosion | 4 | Medium | Mode switcher gates visibility; iterate on UX |
| Deep-learning path lures effort | 5 | Low | Explicitly out of scope until 1–4 land |

---

## Effort budget

Rough totals assuming one-focused-session/day pacing:

- Phase 1: 7 milestones × ~1.5 sessions each = **~10 sessions**
- Phase 2: 6 milestones × ~1 session each = **~6 sessions**
- Phase 3: 7 milestones × ~2 sessions each = **~14 sessions**
- Phase 4: 5 milestones × ~1.5 sessions each = **~7 sessions**

**Total for Phases 1–4: ~37 focused sessions.**

At 2–3 sessions per week (realistic for side-project pacing), this is
~3–4 months calendar time. Faster if milestones can be stacked within a
single session (many of the "S"-sized ones can).

Phase 2 and Phase 3 are parallelizable — if we have bandwidth to run
two tracks (one algorithmic, one workflow), the critical path drops to
Phase 1 → max(Phase 2, Phase 3) → Phase 4 ≈ 23 sessions ≈ 2 months.

---

## Kickoff recommendation

Start with **M1.1 (WavefrontResult skeleton) and M1.2 (calibration record)**
together — they're both small, non-breaking, and unlock every other
milestone. M1.3 (raw/display separation) naturally follows. That's about
one week of work and gets us the provenance + calibration foundation.

Then tackle M1.4 (geometry recipes) as the next standalone unit — it's
worth its own session because the UX needs to be right.

The remaining Phase 1 milestones (M1.5–M1.7) can land in order; each is
one session.

After Phase 1 is complete, pick whichever of Phase 2 / Phase 3 has the
more pressing use case. For the bench validation workflow you've
described, I'd lead with Phase 3 (averaging + subtraction) and let
Phase 2 (algorithmic wins) fill in around it.

---

## Resolved design decisions

- **Registration resolution** — full source resolution in local/on-prem
  mode; 512² downsample in hosted mode (`HOSTED=1`). Sub-pixel parabolic
  fit preserves accuracy in either mode.
- **Session capture cap** — 100 per session; oldest evicted on overflow.
- **Export format** — JSON with base64-encoded Float32 grids; no
  separate binary format for v1.
