# Roadmap

> Revised 2026-04-04 after completing calibration profiles + detection presets.
> See `Loupe_Competitive_Analysis.html` for the full 80+ feature comparison matrix.

## Context

**Target parts:** Wire EDM parts (sharp edges, mirror finish), lathe parts
(turned surfaces, concentric tooling marks), and eventually gears (involute
profiles, tooth spacing).

**Competitive position (as of 2026-03-31):**

| Category | Score | Notes |
|----------|-------|-------|
| Measurement tools | 92% | 14 tools + center-edge circle, sub-pixel snap |
| Vision / auto-detection | 88% | Sub-pixel parabola + gaussian, JS instant preview |
| CAD integration | 72% | DXF import/export, edge-based alignment |
| Calibration & correction | 70% | Lens distortion, perspective/tilt correction, frame sync |
| Inspection / GD&T | 58% | Corridor inspection, True Position, Punch/Die |
| SPC & analytics | 45% | Run storage, Cpk, trend charts |
| Reporting & export | 68% | PDF, CSV, DXF, SPC CSV, TP in exports |
| Camera & hardware | 55% | Aravis/GigE, gamma, auto-exposure, ROI |
| Automation & workflow | 55% | Templates, one-click inspect with auto-align |
| UI / UX / platform | 98% | Web-based, multi-user hosted, cross-platform |

**Unique strengths vs. all competitors:**
- Web-based (browser UI) — no other metrology vendor offers this
- Open REST API — any shop with curl/Python can integrate
- Free / self-hosted — competitors cost $5K–$50K per seat
- Multi-user hosted mode — concurrent users, session isolation
- Shadow-aware edge fitting
- Edge-based DXF alignment without circles

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
- Gradient magnitude visualization overlay
- Zoom-scaled search radius

### Camera UI Overhaul (2026-03-30)
- Camera dropdown menu in top bar (replaces sidebar panel)
- Exposure, gain, gamma, auto-exposure, auto-WB, white balance RGB
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
- Template name display in sidebar

### GD&T: True Position (2026-03-30)
- TP = 2 × radial deviation for circle features
- Datum-frame X/Y decomposition in hover tooltip
- TP displayed in sidebar, CSV, and PDF exports
- Feature-type-aware: lines show perpendicular deviation, circles show TP

### Run Storage + SPC (2026-03-30)
- SQLite database for inspection history (parts → runs → results)
- Feature-type-aware Cpk (one-sided for circles, two-sided for lines)
- Canvas 2D trend chart with tolerance bands and colored dots
- Cpk summary with capability rating (green/amber/red)
- Part and feature selector dropdowns
- SPC CSV export
- Disabled in hosted mode (no server-side file persistence)

### Client-Side Sub-Pixel Snapping (2026-03-31)
- `parabola-js` / `gaussian-js` modes run entirely in the browser
- Instant orange crosshair snap preview on mousemove — no HTTP round-trip
- Cached `ImageData` from frozen canvas; patch sampled per-mousemove
- Default in hosted mode; server-side remains available locally

### Bézier Spline Tool (2026-03-31)
- `B` key; click to place anchor points, double-click/Enter to finish
- Catmull-Rom interpolation — smooth curve through every anchor, no manual handle adjustment
- Draggable anchors in Select mode; arc length output (mm if calibrated)
- DXF export as `SPLINE` entity

### Help System Overhaul (2026-04-04)
- Redesigned as two-panel layout: nav tree (left) + content page (right)
- 20+ pages covering every tool, algorithm, workflow, and export format
- New pages: Perspective Correction, Sub-pixel Snapping, Edge Detection pipeline, Circle & Arc Fitting, DXF Auto-alignment
- All new features documented: grouped flyout toolbar, tool options bar, center-dist tracking, arc-measure modes

### Calibration Profiles + Detection Presets (2026-04-04)
- **Multi-magnification calibration profiles**: save/load/delete named calibration presets in localStorage; floating panel in Setup flyout; instant recall per objective without re-calibrating
- **Detection surface presets**: Wire EDM (default) / Lathe / 3D Print selector at top of Detect menu; surface-aware preprocessing — anisotropic directional blur for lathe tooling marks, extra bilateral pass for 3D print texture; `surface_mode` threaded through all detection endpoints

### UX & Calibration Sprint (2026-04-04)
- **Grouped flyout toolbar**: Measure ▾ (13 tools with key labels) + Setup ▾ (Calibrate, Lens Cal, Perspective Correct) flyouts above the tool strip
- **Tool options bar**: second row in strip, shown per-tool — arc-measure Sequential/Ends-First toggle, circle 3-Point/Center+Edge toggle
- **Arc-measure ends-first mode**: click both arc ends first, then the midpoint — easier when ends snap cleanly
- **Circle center+edge mode**: two-click circle (center then any edge point) alongside existing 3-point mode
- **Center-dist dynamic linking**: center-distance annotation updates live when either linked circle moves; read-only (delete only, no manual drag)
- **Calibration status badge**: always-visible orange/green pill in status bar; click it to enter calibration mode
- **Perspective (tilt) correction**: 4-point homography from a known rectangle; corrects camera tilt without telecentric optics
- **Lens cal + perspective cal magnifier**: loupe now active during both calibration modes for precise point placement
- **Backend frame sync**: `POST /update-frame` endpoint; called after lens or perspective correction so all backend analysis (detection, guided inspection, sub-pixel refinement) operates on the corrected image

---

## Next Up

### STEP import — geometry + PMI tolerances
*Priority: high. Effort: high.*

Two phases, both needed to make this worth the effort:

**Phase 1 — Geometry:** Accept a STEP file (AP203/AP214/AP242), project the relevant face to 2D, and feed the result into the existing DXF overlay pipeline as LINE/CIRCLE/ARC entities. Replaces the current "export DXF from your CAD tool first" step — many users have STEP from FreeCAD, OnShape, or Fusion 360 but no dedicated CAD tool to flatten it.

**Phase 2 — PMI tolerances:** STEP AP242 stores GD&T callouts semantically (tolerance values, datum references, bilateral zones) linked to specific geometric features. Read these and auto-populate feature tolerances on load — eliminating manual tolerance entry entirely. No competitor at this price point does this.

Implementation options:
- **Server-side:** `pythonocc-core` (Python wrapper for OpenCASCADE, available via conda-forge, ~200 MB). Handles both geometry projection and PMI extraction. Works well for local installs.
- **Client-side:** `opencascade.js` (WebAssembly build of the same library, ~40 MB lazy-loaded). STEP file stays in the browser — privacy win, no server dependency, works in hosted image-mode. API is less mature than pythonocc but sufficient for Phase 1 geometry and basic AP242 PMI.

Phase 1 alone isn't compelling enough to justify the dependency. The goal is Phase 1 + PMI together — automatic inspection setup from a STEP file drop.

### SPC: Control charts + histograms
*Priority: medium. Effort: low–medium.*

Run storage and Cpk are implemented. Adding X-bar/R control charts, histograms, and Pp/Ppk completes the quality analytics picture. Same Canvas 2D rendering pattern as the existing trend charts.

### GD&T: Form tolerances (roundness, flatness)
*Priority: medium. Effort: medium.*

Roundness: already fit circles and compute radius; max deviation from the fit radius = roundness error. Flatness on a line segment: max deviation from the best-fit line across the measured points. Both are common callouts for turned and ground parts, and the data is already present in the inspection results. Lower priority than STEP import since tolerances can come from PMI.

### GD&T: Profile of a line/surface
*Priority: medium. Effort: medium.*

The corridor-based inspection already computes perpendicular deviation per feature point. Wrapping it in formal GD&T semantics (bilateral/unilateral tolerance zones, datum references in the report) makes results directly comparable to print callouts. Better addressed after STEP/PMI import since that work overlaps heavily.

### Batch inspection
*Priority: low. Effort: high.*

Multiple parts in one frame, each measured in one pass. Part instance detection via DXF template matching, per-instance alignment and inspection, batch results table and combined PDF. Less relevant for single-image upload mode.

---

## Future / Deferred

| Feature | Why deferred |
|---------|-------------|
| Gear inspection (involute profiles, tooth spacing) | Separate domain. Wait for gear machine. |
| Nikon SC-102 XY stage integration | Hardware-dependent. Separate project. |
| Pattern matching / golden template | Interesting for incoming inspection but niche. |
| Full GD&T (runout, concentricity, profile of surface) | Revisit when a compliance requirement drives it. |
| Height map / focus stacking | Requires motorized Z-axis. Separate project. |
| QDAS/QIF export | Revisit when an ISO shop asks. |
| Calibration traceability / uncertainty budgets | ISO 17025 requirement. Not needed yet. |
| OCR serial number recognition | Read etched/stamped serial numbers. Auto-name SPC runs and reports. Tesseract or EasyOCR. |
| Education / cloud mode | Login, server-side session storage, teacher dashboard. See `docs/superpowers/specs/2026-03-30-education-cloud-notes.md`. |
| Enterprise shared microscope | Role-based access, shared image library, audit trail. Builds on education mode. |
| Customizable report templates | Fixed-format PDF covers most cases; full template system (logo, layout, PPAP fields) deferred until someone asks for it. |

---

## What NOT to Do

- TypeScript migration (codebase is ~10K LOC, vanilla JS works fine)
- Component framework (canvas rendering doesn't benefit)
- WebGL rendering (canvas performance is fine at current image sizes)
- AI-assisted detection (classical CV pipeline needs to be solid first)

---

## Execution Log

```
✅ Done:   Phase 1 (reliability + UX)        — 2026-03-25
✅ Done:   Phase 1.5 (zoom/pan)              — 2026-03-25
✅ Done:   Phase 2 (guided inspection)       — 2026-03-25
✅ Done:   Phase 2.5 (Punch/Die + tol)       — 2026-03-26
✅ Done:   Misc polish + camera fixes        — 2026-03-26
✅ Done:   Edge-based auto-alignment         — 2026-03-28
✅ Done:   DXF export, grouping, labels      — 2026-03-28
✅ Done:   Phase 5.1 (PDF/CSV reports)       — 2026-03-28
✅ Done:   Phase 6 (tests + module splits)   — 2026-03-29
✅ Done:   Viewport coordinate fixes         — 2026-03-29
✅ Done:   Sub-pixel edge refinement         — 2026-03-30
✅ Done:   Camera UI overhaul               — 2026-03-30
✅ Done:   Multi-user hosted mode           — 2026-03-30
✅ Done:   Security hardening + deploy      — 2026-03-30
✅ Done:   Measurement templates            — 2026-03-30
✅ Done:   GD&T: True Position              — 2026-03-30
✅ Done:   Run storage + SPC               — 2026-03-30
✅ Done:   Client-side sub-pixel snapping  — 2026-03-31
✅ Done:   Bézier spline tool              — 2026-03-31
✅ Done:   Help system overhaul            — 2026-04-04
✅ Done:   Grouped flyout toolbar          — 2026-04-04
✅ Done:   Perspective (tilt) correction   — 2026-04-04
✅ Done:   Circle center+edge mode         — 2026-04-04
✅ Done:   Arc-measure ends-first mode     — 2026-04-04
✅ Done:   Center-dist dynamic linking     — 2026-04-04
✅ Done:   Backend frame sync (corrections)— 2026-04-04
✅ Done:   Multi-mag calibration profiles  — per-objective cal recall
✅ Done:   Detection presets               — EDM/Lathe/Print surface modes

Next:      STEP import (geometry + PMI)     — auto inspection setup from STEP file drop
Then:      STEP import (geometry + PMI)     — auto inspection setup from STEP file drop
Then:      SPC: control charts + histograms — X-bar/R, Pp/Ppk
Then:      GD&T: Form tolerances            — roundness, flatness (after STEP/PMI)
Then:      GD&T: Profile of a line/surface  — formal tolerance zones (after STEP/PMI)
Then:      Batch inspection                 — multi-part, lower priority for image-mode
Future:    Gear inspection                  — when gear machine is running
Future:    Nikon XY stage                   — hardware integration
Future:    Education / cloud mode           — university adoption
Future:    Enterprise shared microscope     — production shop multi-user
```
