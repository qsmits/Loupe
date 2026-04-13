# Roadmap

> Revised 2026-04-10 — sweeping update covering the Z-stack / heightmap /
> super-res / stitching / camera-control / security work landed since
> 2026-04-04, and the shift in product framing from "microscope app" to
> "optical inspection frontend for DIY-able hardware."

## Context

**What Loupe is (2026-04-10):** an open-source optical inspection frontend
targeting DIY and small-shop hardware. Microscope/machine-vision is the
anchor mode, but the app is evolving toward multiple instrument modes that
*replace* each other (autocollimator, deflectometry, white-light
interferometer) because calibration units, tool availability, and workflows
diverge between them. Modes change workflow. Tools are specialized within a
mode.

**Target parts (microscope mode):** Wire EDM parts (sharp edges, mirror
finish), lathe parts (turned surfaces, concentric tooling marks), gears
(involute profiles, tooth spacing), and — newly relevant — surface texture
and profile metrology via Z-stack, plus macro-scale inspection work as the
user moves beyond pure micro.

**Distribution:** Open-source local install (full feature set) + a
hosted image-upload mode (compute-heavy features disabled). Not a commercial
product — user experience trumps shop-floor GD&T compliance. See
`CLAUDE.md` and `docs/2026-03-31-hosted-mode-security-audit.md`.

**Competitive position (as of 2026-04-10):**

| Category | Score | Notes |
|----------|-------|-------|
| Measurement tools | 94% | 14+ tools, sub-pixel snap, Bézier spline, canvas comments |
| Vision / auto-detection | 90% | Sub-pixel parabola + gaussian, JS instant preview, surface presets |
| CAD integration | 72% | DXF import/export, edge-based alignment (STEP pending) |
| Calibration & correction | 82% | Lens distortion, tilt homography, frame sync, log-scale camera controls, export/import profiles |
| Inspection / GD&T | 60% | Corridor inspection, True Position, Punch/Die |
| SPC & analytics | 48% | Run storage, Cpk, trend charts |
| Reporting & export | 70% | PDF, CSV, DXF, SPC CSV, TP, inspection results |
| Camera & hardware | 74% | Aravis/GigE, OpenCV enumeration, browser camera, 4-quadrant compare, log-scale slider + histogram + client-side auto-exposure |
| Automation & workflow | 58% | Templates, one-click inspect with auto-align |
| Surface & profile metrology | 75% | Z-stack depth-from-focus, ISO 25178-2/3/606, 3D viewer, HDR fusion |
| Multi-frame reconstruction | 72% | Image stitching wizard, super-resolution, HDR bracketing |
| UI / UX / platform | 98% | Web-based, multi-user hosted, cross-platform |

**Unique strengths vs. all competitors:**
- Web-based (browser UI) — no other metrology vendor offers this
- Open REST API — any shop with curl/Python can integrate
- Free / self-hosted — competitors cost $5K–$50K per seat
- Multi-user hosted mode with per-session frame isolation
- Z-stack depth-from-focus with ISO 25178 areal roughness on a single-camera DIY rig (no motorized Z needed)
- Image stitching + super-resolution wizards that reuse the inspection pipeline
- Shadow-aware edge fitting, edge-based DXF alignment without circles

---

## Completed Work

### Phase 1: Reliability & UX (2026-03-25)
- Annotation management overhaul (multi-select, drag-select, elevation, context menu)
- Auto-save to localStorage, restore prompt, beforeunload warning
- Detection busy indicators, result counts, error messages
- Zoom & pan (scroll zoom, pan tool, minimap, grid, zoom badge/presets)
- Viewport transform with correct coordinate handling across freeze/unfreeze

### Phase 2: DXF-Guided Inspection (2026-03-25–26)
- Corridor-based per-feature edge detection with RANSAC inlier filtering
- Shadow-aware edge selection (histogram peak detection)
- Manual point-pick fallback with compound feature support
- Edge-based DXF auto-alignment (template matching, no circles required)
- Punch/Die tolerance tagging with directional amber/red coloring
- Per-feature tolerance overrides, grouped inspection sidebar
- Draggable labels with leader lines, hover tooltips

### Measurement Workflow (2026-03-28)
- Measurement grouping with uniform colors, collapsible headers
- Draggable labels for all measurement types
- DXF export for reverse engineering (measurements → DXF in mm)
- PDF report with grouped inspection results + all measurement types
- Annotated screenshot with numbered cross-references

### Technical Foundation (2026-03-29)
- 105+ frontend tests (math, viewport, measurementLabel, CSV, templates)
- Module splits: main.js 1714→611, render.js 1585→302, api.py 585→70
- Pure function extraction for testability
- Canvas coordinate stability fixes

### Sub-Pixel Edge Refinement (2026-03-30)
- Pluggable algorithm architecture (parabola + gaussian)
- Guided inspection: sub-pixel refinement per-corridor (on by default)
- Manual measurement: click-to-edge snap with magnitude/distance scoring
- Live snap preview (orange crosshair on mousemove)
- Gradient magnitude visualization overlay, zoom-scaled search radius

### Camera UI (first pass, 2026-03-30)
- Camera dropdown menu in top bar (replaces sidebar panel)
- Exposure, gain, gamma, auto-WB, white balance RGB
- Camera selection, pixel format, ROI set-from-view/reset
- Capability-based visibility (unsupported features hidden per camera)
- Settings dialog: 3 tabs (General, Measurement, Display)

### Multi-User Hosted Mode (2026-03-30)
- Per-session frame store (SessionFrameStore with UUID keys, TTL)
- Frontend apiFetch wrapper on all API calls
- Config read-only in hosted mode (403 with graceful handling)
- Security: CORS, rate limiting, input validation, error scrubbing
- Deploy scripts for Ubuntu + Apache + supervisord

### Measurement Templates (2026-03-30)
- Save/load inspection recipes as JSON files (client-side, no server storage)
- Template captures: DXF entities, calibration, tolerances, detection settings, feature modes
- One-click "Run Inspection" with auto-align when template loaded

### GD&T: True Position (2026-03-30)
- TP = 2 × radial deviation for circle features
- Datum-frame X/Y decomposition in hover tooltip
- TP displayed in sidebar, CSV, and PDF exports

### Run Storage + SPC (2026-03-30)
- SQLite database for inspection history (parts → runs → results)
- Feature-type-aware Cpk (one-sided for circles, two-sided for lines)
- Canvas 2D trend chart with tolerance bands and colored dots
- Cpk summary with capability rating (green/amber/red)
- SPC CSV export; disabled in hosted mode

### Client-Side Sub-Pixel Snapping (2026-03-31)
- `parabola-js` / `gaussian-js` modes run entirely in the browser
- Instant orange crosshair snap preview on mousemove — no HTTP round-trip
- Default in hosted mode; server-side remains available locally

### Bézier Spline Tool (2026-03-31)
- `B` key; click to place anchors, double-click/Enter to finish
- Catmull-Rom interpolation — smooth curve through every anchor
- Draggable anchors in Select mode; arc length output
- DXF export as `SPLINE` entity

### Help System Overhaul (2026-04-04)
- Two-panel layout: nav tree (left) + content page (right)
- 20+ pages covering every tool, algorithm, workflow, and export format

### Calibration Profiles + Detection Presets (2026-04-04)
- Multi-magnification calibration profiles (localStorage)
- Detection surface presets: Wire EDM / Lathe / 3D Print with surface-aware preprocessing

### UX & Calibration Sprint (2026-04-04)
- Grouped flyout toolbar (Measure ▾ + Setup ▾), tool options bar
- Arc-measure ends-first mode, circle center+edge mode
- Center-dist dynamic linking (read-only, tracks linked circles)
- Calibration status badge (always-visible orange/green pill)
- Perspective (tilt) correction via 4-point homography
- Lens cal + perspective cal loupe magnifier
- Backend frame sync: all analysis operates on the corrected image

### Z-Stack (Depth-from-Focus) Workflow (2026-04-05–07)
- Capture stack + compute all-in-focus composite + per-pixel height map
- Heightmap analysis: Gaussian filters, bearing ratio (Abbott-Firestone), 2D PSD
- ISO 4287 1D and ISO 25178 2D areal roughness (Sa, Sq, Sp, Sv, Sz)
- ISO 25178-606 surface metrology parameters
- ISO 25178-3 Gaussian S-filter / L-filter (spatial filtering)
- 2D profile extraction along user-drawn lines with live roughness readout
- Plane / poly² detrend for heightmaps
- Delete individual frames; unified server-side Z calibration
- Session persistence across dialog reopens
- Toolbar Surface button; preserve focus on dialog reopen
- HDR bracketing + Laplacian pyramid fusion for high-dynamic-range stacks
- Noise reference capture (sticky across reset)
- 3D textured heightmap viewer with confidence mask, saturation override, Z calibration
- Use-all-in-focus composite as the frozen view

### Z-Stack Metrics Extensions (2026-04-10)
- Skewness (Ssk) and kurtosis (Sku) in areal readout
- ISO 25178-2 spatial texture parameters: Sal (fastest autocorrelation decay),
  Str (texture aspect ratio), Std (dominant texture direction)
- Quadrature noise-floor compensation using the stored noise reference
- Calibration warning banner + disabled S/L filters when no pixel cal is set
  (the backend silently skipped the S/L branch without calibration)

### Image Stitching + Super-Resolution (2026-04-06)
- Stitch wizard: manual tile capture with X/Y µm coordinate tracking
- Separate X/Y overlap, sub-pixel placement, anti-ghost blending
- 413 large-panorama protection; use-as-image error handling
- Super-resolution wizard: multi-frame sub-pixel shift, pyramid reconstruction
- Both wizards pre-fill pixel pitch from global calibration
- Both disabled in hosted mode

### 4-Quadrant Image Settings Comparison (2026-04-07)
- Keyence-style side-by-side comparison of 4 live views with independent
  exposure, gain, gamma, lighting settings — pick the best before measuring

### Measurement Menu Restructure (2026-04-07)
- 14 tools collapsed into 6 top-level groups
- Area-from-shape added
- Misc group, top-bar cleanup, canvas comment annotations

### Camera Enumeration + Browser Camera (2026-04-08)
- OpenCV webcam enumeration (multiple devices, per-index device_id)
- Browser camera support via MediaDevices API
- Per-device dropdown entries after permission granted
- Placeholder option forces explicit selection (prevents silent fallthrough)
- Hide drop-image overlay when browser camera is active

### Security Hardening (2026-04-08–09)
- CSP headers + Permissions-Policy + media-src
- Concurrent operation limit for hosted mode
- innerHTML → safe DOM construction (XSS prevention)
- Server-issued session tokens (replaces client-generated UUIDs)
- Bundled jsPDF locally (no third-party CDN)
- Per-router hosted-mode rejection for stitch, super-res, and Z-stack
- Pre-existing test failures resolved (4 tests fixed)

### Camera Controls Overhaul (2026-04-10)
- Log-scale exposure and gain sliders spanning the camera's reported
  min/max. Each slider step is ~constant perceptual brightness change.
  Baumer VCXU's 250× linear gain range is now usable; no more dead
  slider travel.
- Companion number input for exact entry; camera-native units (dB or
  linear multiplier) auto-detected.
- Backend AravisCamera publishes exposure_min/max and gain_min/max;
  feature probing uses native `is_*_available()` instead of swallowing
  exceptions.
- Live 32-bin luma histogram with min/mean/max stats and clip warnings,
  computed client-side from the MJPEG stream at 1 Hz.
- Auto Exposure replaced with a client-side histogram-bisection loop
  driving mean luma toward mid-gray. Works on cameras without hardware
  ExposureAuto; caps search exposure at 200 ms to prevent UI hangs;
  diagnoses under/over-exposure when it can't converge.
- Camera dropdown grouped by backend (Scientific / Webcams / Browser).
- Stream force-reconnects on camera switch (fixes stale MJPEG pipe).

### Annotation Visibility + Calibration Polish (2026-04-10)
- Per-row eye toggle in the sidebar hides individual annotations on canvas
  but keeps the data; skipped in render and hit-testing
- Global "hide all" button in the Measurements header
- Calibration profile export/import (versioned JSON, collision-safe names)
- `setTool("calibrate")` blocked until camera dimensions are known
  (prevents calibration against a stale fallback imageWidth)

---

## Next Up

### Autocollimator mode *(new top-of-queue when hardware arrives)*
*Priority: high once the Nikon autocollimator arrives. Effort: medium.*

This is the first "replacement mode" and the template for future instrument
modes. The Nikon autocollimator with 12mm lens + 3D-printed adapter is
incoming from a friend. Angular measurement (arcsec/px) cannot coexist with
linear measurement tools (distance, circle, area) — the image is an angular
view of a reflected reticle, not a spatial view of a part. Mode switch
changes which tools/HUD are available and which calibration type applies.

**Work needed:**
- Mode concept refactor: add a mode-type field to calibration profiles;
  gate tool availability by active mode
- Focal-length-based calibration (arcsec/px from reticle displacement)
- Angular HUD (Δx/Δy in arcsec with unit toggle to µrad)
- Capture-reading button (snap current Δ as a logged value)
- Parallelism workflow using the lapped base as a zero reference (no
  flip-and-divide arithmetic required)

**Why first:** establishes the mode-replacement pattern cleanly. Whatever
shortcuts land here become tech debt for every future mode, so the
refactor needs to be done properly.

### Deflectometry mode *(integrated, iterating)*
*Priority: active. Effort: ongoing.*

Full-window deflectometry workspace with mode switcher, iPad-as-display
architecture, and working measurement pipeline. Current state (2026-04-13):
8-step phase shifting, gamma pre-correction, Gaussian smoothing, sphere
calibration, Frankot-Chellappa height integration, inline 3D viewer,
diagnostics tab. Cardboard-box testing confirms stray light was the
dominant artifact source — proper enclosure in progress.

**Hardware in progress:**
- Modular 3D-printed enclosure (stackable frame segments, iPad-as-ceiling,
  threaded extension tubes for camera lens)
- G28 25mm calibration sphere on order (ERIKS, DIN 5401 100Cr6)

**Future improvements:**
- Per-pixel gamma calibration (capture LCD response curve spatially)
- Monochrome display (resin printer LCD + backlight) for higher contrast
  and elimination of RGB subpixel artifacts
- Phase-shifting with more steps (12/16) if 8-step proves insufficient
  for challenging surfaces
- Zernike polynomial fitting for optical surface characterization
- Export to standard surface formats (Zygo MetroPro .dat, x3p)
- Multi-capture averaging for noise reduction
- Automated capture sequencing (auto-trigger compute after capture)

Concrete hello-world target: measure the free-state shape of a visibly-bent
0.1 mm gage block.

### STEP import — geometry + PMI tolerances
*Priority: high. Effort: high.*

Two phases, both needed:

**Phase 1 — Geometry:** Accept a STEP file (AP203/AP214/AP242), project the
relevant face to 2D, feed into the DXF overlay pipeline as LINE/CIRCLE/ARC
entities. Replaces the "export DXF from your CAD tool first" step.

**Phase 2 — PMI tolerances:** STEP AP242 stores GD&T callouts semantically
linked to features. Read these and auto-populate feature tolerances on load
— eliminating manual tolerance entry. No competitor at this price point
does this.

Options: server-side `pythonocc-core` (~200 MB via conda-forge) or
client-side `opencascade.js` (~40 MB WASM). Phase 1 alone isn't compelling;
the goal is Phase 1 + PMI together.

### SPC: Control charts + histograms
*Priority: medium. Effort: low–medium.*

X-bar/R control charts, histograms, Pp/Ppk — completes the quality
analytics picture using the existing Canvas 2D rendering pattern.

### GD&T: Form tolerances (roundness, flatness)
*Priority: medium. Effort: medium.*

Roundness from existing circle fits; flatness from line fits. Data is
already present in inspection results. Lower priority than STEP import
since tolerances can come from PMI.

### GD&T: Profile of a line/surface
*Priority: medium. Effort: medium.*

Corridor inspection already computes perpendicular deviation per point;
wrap in formal GD&T semantics (bilateral/unilateral zones, datums).
Better addressed after STEP/PMI since they overlap heavily.

### Batch inspection
*Priority: low. Effort: high.*

Multi-part detection + per-instance alignment. Less relevant for the
image-upload mode.

---

## Future / Deferred

| Feature | Why deferred |
|---------|-------------|
| White-light interferometer mode | Longer-term — no hardware yet. Third mode after autocollimator + deflectometry. |
| Cross-mode calibration sharing | Share microscope calibration (px/mm) with fringe mode so surface maps show physical dimensions. Measure part dimensions in microscope, drop optical flat on top, switch to fringe — same calibration applies. |
| Cross-mode annotation overlay | Show microscope annotations (hole positions, feature dimensions) as an overlay in fringe mode for spatial correlation. |
| Fringe mode: custom profile lines | Click on surface map to place arbitrary cross-section lines instead of only center H/V profiles. |
| Fringe mode: phase-shifting capture | Add piezo-based multi-frame phase shifting as an alternative to single-image DFT extraction — higher accuracy, requires hardware. |
| Fringe mode: lens distortion correction | Apply microscope lens cal to fringe images for more accurate Zernike fitting and spatial localization. |
| Digital level app (Digi-Pas DWL-3500XY ×3, BLE) | **Separate app, not a Loupe mode.** Shares backend plumbing with Loupe. Needs BLE protocol reverse engineering. |
| Gear inspection | Separate domain. Wait for gear machine. |
| Nikon SC-102 XY stage integration | Hardware-dependent. Separate project. |
| Pattern matching / golden template | Interesting for incoming inspection but niche. |
| Full GD&T (runout, concentricity, profile of surface) | Revisit when a compliance requirement drives it. |
| QDAS/QIF export | Revisit when an ISO shop asks. |
| Calibration traceability / uncertainty budgets | ISO 17025 requirement. Not needed yet. |
| OCR serial number recognition | Auto-name SPC runs from etched serials. |
| Education / cloud mode | Login, server-side session storage, teacher dashboard. |
| Enterprise shared microscope | Role-based access, shared image library, audit trail. |
| Customizable report templates | Fixed-format PDF covers most cases. |

---

## Modes explicitly rejected

These have been discussed and **will not** be built into Loupe:

- **Shadowgraph / profile projector as its own mode.** The Mitutoyo
  toolmakers scope already does this via microscope mode + green backlight.
  Mounting a camera to the Nikon profile projector is a hardware problem,
  not software. At most, "a lighting preset within microscope mode."
- **Photogrammetry.** Meshroom / RealityCapture do it better. No reason to
  reinvent.
- **Laser triangulation, colorimetry, schlieren.** Niche, different data
  models, or not inspection.

---

## What NOT to Do

- TypeScript migration (codebase is ~10K LOC, vanilla JS works fine)
- Component framework (canvas rendering doesn't benefit)
- WebGL rendering (canvas performance is fine at current image sizes)
- AI-assisted detection (classical CV pipeline needs to be solid first)
- **Feature-driven mode proliferation.** A few well-designed modes beat a
  pile of half-modes. The question that has to be answered before adding
  any feature (mode-level or tool-level) is *"what current recurring pain
  would this fix?"* — not *"do I have the hardware?"*

---

## Execution Log

```
✅ Phase 1 (reliability + UX)        — 2026-03-25
✅ Phase 1.5 (zoom/pan)              — 2026-03-25
✅ Phase 2 (guided inspection)       — 2026-03-25
✅ Phase 2.5 (Punch/Die + tol)       — 2026-03-26
✅ Edge-based auto-alignment         — 2026-03-28
✅ DXF export, grouping, labels      — 2026-03-28
✅ PDF/CSV reports                   — 2026-03-28
✅ Tests + module splits             — 2026-03-29
✅ Sub-pixel edge refinement         — 2026-03-30
✅ Camera UI overhaul (first pass)   — 2026-03-30
✅ Multi-user hosted mode            — 2026-03-30
✅ Security hardening + deploy       — 2026-03-30
✅ Measurement templates             — 2026-03-30
✅ GD&T: True Position               — 2026-03-30
✅ Run storage + SPC                 — 2026-03-30
✅ Client-side sub-pixel snapping    — 2026-03-31
✅ Bézier spline tool                — 2026-03-31
✅ Help system overhaul              — 2026-04-04
✅ Grouped flyout toolbar            — 2026-04-04
✅ Perspective (tilt) correction     — 2026-04-04
✅ Calibration profiles + presets    — 2026-04-04
✅ Z-stack + heightmap analysis      — 2026-04-05
✅ ISO 25178-606 surface metrology   — 2026-04-05
✅ ISO 25178-3 S/L spatial filters   — 2026-04-05
✅ Z-stack profile + roughness 1D    — 2026-04-06
✅ Z-stack plane/poly² detrend       — 2026-04-06
✅ HDR bracketing + pyramid fusion   — 2026-04-06
✅ Image stitching wizard            — 2026-04-06
✅ Super-resolution wizard           — 2026-04-06
✅ 3D textured heightmap viewer      — 2026-04-07
✅ 4-quadrant image compare          — 2026-04-07
✅ Measure menu restructure          — 2026-04-07
✅ Canvas comment annotations        — 2026-04-07
✅ OpenCV webcam enumeration         — 2026-04-08
✅ Browser camera support            — 2026-04-08
✅ Hosted-mode CSP + media-src       — 2026-04-08
✅ Concurrent op limit + XSS fix     — 2026-04-09
✅ Server-issued session tokens      — 2026-04-09
✅ Camera controls overhaul          — 2026-04-10
✅ Z-stack texture params + noise    — 2026-04-10
✅ Annotation visibility toggles     — 2026-04-10
✅ Cal profile export/import         — 2026-04-10
✅ Deflectometry mode (core)         — 2026-04-13: mode switcher, workspace UI, 8-step phase shifting,
                                       gamma pre-correction, smoothing, sphere calibration, iPad centering,
                                       3D viewer, diagnostics. Enclosure + calibration ball pending.

Next:      Autocollimator mode         — when Nikon unit arrives; establishes mode-replacement pattern
Then:      STEP import (geometry+PMI)  — auto inspection setup from STEP file drop
Then:      SPC: control charts         — X-bar/R, Pp/Ppk
Then:      GD&T: form tolerances       — roundness, flatness (after STEP/PMI)
Then:      GD&T: profile of line/surf  — formal tolerance zones (after STEP/PMI)
Then:      Batch inspection            — multi-part, lower priority for image-mode
Later:     White-light interferometer  — third mode, no hardware yet
Later:     Digital level app           — separate app, shares backend plumbing
Future:    Gear inspection             — when gear machine is running
Future:    Education / cloud mode      — university adoption
Active:    Fringe analysis mode        — single-image DFT interferogram analysis, Zernike fitting
```
