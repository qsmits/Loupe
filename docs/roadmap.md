# Roadmap

> Revised 2026-03-31 after completing all Tier 1-2 features from the
> competitive analysis. See `Loupe_Competitive_Analysis.docx` for the full
> 80+ feature comparison matrix.

## Context

**Target parts:** Wire EDM parts (sharp edges, mirror finish), lathe parts
(turned surfaces, concentric tooling marks), and eventually gears (involute
profiles, tooth spacing).

**Competitive position (as of 2026-03-31):**

| Category | Score | Notes |
|----------|-------|-------|
| Measurement tools | 90% | 14 tools, sub-pixel snap |
| Vision / auto-detection | 85% | Sub-pixel parabola + gaussian, live preview |
| CAD integration | 70% | DXF import/export, edge-based alignment |
| Inspection / GD&T | 55% | Corridor inspection, True Position, Punch/Die |
| SPC & analytics | 40% | Run storage, Cpk, trend charts |
| Reporting & export | 70% | PDF, CSV, DXF, SPC CSV, TP in exports |
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

---

## Next Up

### Detection presets (EDM / Lathe / 3D Print)
*Priority: medium. Effort: low.*

Surface-aware preprocessing instead of one pipeline for all surfaces:
- **Wire EDM** (default): light preprocessing, lower CLAHE to avoid boosting reflections
- **Turned/Lathe**: directional filtering to suppress concentric tooling marks
- **3D Print**: bilateral smoothing (already available as slider)
- **Custom**: expose all parameters

### GD&T: Profile of a line
*Priority: medium. Effort: medium.*

Our corridor-based inspection is conceptually close to profile tolerance
already. Wrapping it in proper GD&T semantics (bilateral/unilateral zones,
datum references) makes inspection results directly comparable to print
callouts.

### Customizable report templates
*Priority: medium. Effort: medium.*

Shops have customer-specific report layouts (first-article inspection forms,
PPAP templates). A template system: logo, header fields, which features to
include, field placement.

### Batch inspection
*Priority: medium. Effort: high.*

Swiss lathe operator use case: scatter a handful of parts under the microscope,
get all of them measured at once. Part instance detection via DXF template
matching, per-instance alignment and inspection, batch results + combined PDF.

---

## Future / Deferred

| Feature | Why deferred |
|---------|-------------|
| Gear inspection (involute profiles, tooth spacing) | Separate domain. Wait for gear machine. |
| Nikon SC-102 XY stage integration | Hardware-dependent. Separate project. |
| STEP/IGES import with PMI | High effort. Auto-import GD&T tolerances from 3D model. Needs pythonocc/OpenCascade. |
| Pattern matching / golden template | Interesting for incoming inspection but niche. |
| Full GD&T (runout, concentricity, profile of surface) | Revisit when a compliance requirement drives it. |
| Height map / focus stacking | Requires motorized Z-axis. Separate project. |
| QDAS/QIF export | Revisit when an ISO shop asks. |
| Lens distortion correction | Checkerboard calibration → `cv2.undistort()`. Not needed for telecentric objectives. Relevant for hosted mode with phone/USB microscope photos. |
| Calibration traceability / uncertainty budgets | ISO 17025 requirement. Not needed yet. |
| OCR serial number recognition | Read etched/stamped serial numbers. Auto-name SPC runs and reports. Tesseract or EasyOCR. |
| Education / cloud mode | Login, server-side session storage, teacher dashboard. See `docs/superpowers/specs/2026-03-30-education-cloud-notes.md`. |
| Enterprise shared microscope | Role-based access, shared image library, audit trail. Builds on education mode. |
| Named calibration profiles | Store calibration per physical objective. Not needed for single-lens setups. |

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

Next:      Detection presets                 — EDM/Lathe/Print surface modes
Then:      GD&T: Profile of a line           — bilateral/unilateral tolerance zones
Then:      Report templates                  — customer-specific FAI forms
Then:      Batch inspection                  — multi-part production use case
Future:    Gear inspection                   — when gear machine is running
Future:    Nikon XY stage                    — hardware integration
Future:    Education / cloud mode            — university adoption
Future:    Enterprise shared microscope      — production shop multi-user
```
