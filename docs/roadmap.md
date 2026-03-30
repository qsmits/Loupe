# Roadmap

> Revised 2026-03-30 after competitive analysis against Mitutoyo, Heidenhain,
> Keyence, Zeiss, Hexagon, and OGP. See `Loupe_Competitive_Analysis.docx` for
> the full 80+ feature comparison matrix and scoring.

## Context

**Target parts:** Wire EDM parts (sharp edges, mirror finish), lathe parts
(turned surfaces, concentric tooling marks), and eventually gears (involute
profiles, tooth spacing).

**Competitive position:** Strong on measurement tools (90%), UI/UX (95%), and
CAD integration (70%). Weak on Inspection/GD&T (40%), SPC/analytics (5%),
and automation (35%). Unique strengths: web-based, open API, shadow-aware
edge fitting, edge-based alignment without circles, free/self-hosted.

**Strategic goal:** Cross the credibility threshold on accuracy (sub-pixel)
and quality systems (GD&T + SPC). Shops won't switch from a $10K Mitutoyo
license if they can't generate a Cpk report or trust the measurement resolution.

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

### Phase 4 (partial): Measurement Workflow (2026-03-28)
- Measurement grouping with uniform colors, collapsible headers
- Draggable labels for all measurement types
- DXF export for reverse engineering (measurements → DXF in mm)

### Phase 5.1: Reporting (2026-03-28)
- PDF report with grouped inspection results + all measurement types
- Annotated screenshot with numbered cross-references
- CSV export for inspection results

### Phase 6: Technical Foundation (2026-03-29)
- 81 frontend tests (math, viewport transforms, measurementLabel, CSV format)
- `main.js` split: 1714 → 611 lines (5 event modules)
- `render.js` split: 1585 → 302 lines (4 render modules + format.js)
- `tools.js` split: 821 → 615 lines (hit-test.js extracted)
- `api.py` split: 585 → 70 lines (3 sub-routers)
- Pure function extraction (measurementLabel, formatCsvValue, viewport transforms)
- Canvas backing resolution decoupled from zoom (fixed coordinate stability bugs)

---

## Tier 1: Accuracy & Daily Workflow

These close the biggest competitive gaps and make the tool trustworthy for
production measurement. Every major competitor has these.

### Sub-pixel edge refinement
*Priority: critical. Effort: medium.*

The single biggest accuracy improvement without hardware changes. Moves
effective resolution from ~5µm to ~1µm. Gradient-based sub-pixel localization
along existing Canny edges. Apply to both auto-detection and guided inspection
corridor fitting.

Competitive context: all six competitors have this. Currently our main
accuracy limitation.

### Measurement templates / programs
*Priority: high. Effort: medium.*

Save a measurement sequence as a replayable recipe: "Calibrate → align DXF →
run these features → generate report." Load the template, place the part,
press go. This is Keyence's entire selling point ("place and press").

Enables the 60-second inspection goal. Also foundational for batch inspection
(Tier 3) — you can't batch-measure without a repeatable program.

### Detection presets (EDM / Lathe / 3D Print)
*Priority: medium. Effort: low.*

Surface-aware preprocessing instead of one pipeline for all surfaces:
- **Wire EDM** (default): light preprocessing, lower CLAHE to avoid boosting reflections
- **Turned/Lathe**: directional filtering to suppress concentric tooling marks
- **3D Print**: bilateral smoothing (already available as slider)
- **Custom**: expose all parameters

---

## Tier 2: Quality System Credibility

These cross Loupe into ISO 9001 / IATF 16949 territory. Without them, shops
must re-measure in a CMM or export data to external tools.

### GD&T: True Position
*Priority: high. Effort: medium.*

Most requested GD&T callout for wire EDM and precision turned parts. Hole
patterns on the DXF already have nominal positions; we just need to compute
position deviation from a datum reference and apply the cylindrical tolerance
zone formula. Our coordinate origin + DXF overlay provide the datum framework.

### Multi-part run storage (SQLite)
*Priority: high. Effort: medium.*

Currently each session is standalone. Store inspection results per part number
and serial number in a lightweight local database (SQLite). This is
foundational for SPC (next item), trend tracking, and batch inspection.

Schema: parts → runs → feature_results. Simple REST API on top.

### Basic SPC (Cpk/Ppk + histogram + trend)
*Priority: high. Effort: low–medium.*

Once we have run storage, Cpk is a small calculation on top of stored
deviation data. Add:
- Cpk/Ppk per feature across runs
- Histogram of deviations per feature
- Trend chart (deviation vs. run number) with control limits
- Summary dashboard: which features are drifting toward tolerance limits

This is what ISO 9001 shops need. Currently scored at 5% — even basic SPC
moves us to ~40%, which is competitive for the price point.

### GD&T: Profile of a line
*Priority: medium. Effort: medium.*

Our corridor-based inspection is conceptually close to profile tolerance
already. Wrapping it in proper GD&T semantics (bilateral/unilateral zones,
datum references) makes inspection results directly comparable to print
callouts. Connects naturally to the existing inspection pipeline.

---

## Tier 3: Production Workflow

These make the tool fast enough for daily production use.

### Customizable report templates
*Priority: medium. Effort: medium.*

Shops have customer-specific report layouts (first-article inspection forms,
PPAP templates). A template system: logo, header fields, which features to
include, field placement. Differentiator at our price point (free vs $5K–$50K
per seat for competitors).

### Batch inspection
*Priority: medium. Effort: high.*

Swiss lathe operator use case: scatter a handful of parts under the microscope,
get all of them measured at once. Depends on templates (for repeatable
measurement sequence) and run storage (for results). Includes:
- Part instance detection via DXF template matching
- Per-instance alignment and inspection
- Batch results view with statistical summary
- Combined PDF report

### Named calibration profiles
*Priority: low. Effort: low.*

Store calibration per physical objective/lens (e.g., "5x", "20x"). Useful when
swapping objectives on a turret microscope. Not needed for single-lens setups
since digital zoom preserves calibration. Quick-switch dropdown in the
calibration panel.

---

## Future / Deferred

These are real features but not near-term priorities given the current use case.

| Feature | Why deferred |
|---------|-------------|
| Gear inspection (involute profiles, tooth spacing) | Separate domain. Wait for gear machine. |
| Nikon SC-102 XY stage integration | Hardware-dependent. Separate project. |
| STEP/IGES import | High effort. DXF covers 2D inspection well. |
| Pattern matching / golden template | Interesting for incoming inspection but niche. |
| Full GD&T (runout, concentricity, profile of surface) | Revisit when a compliance requirement drives it. |
| Height map / focus stacking | Requires motorized Z-axis. Separate project. |
| Part history database (full) | Subsumed by run storage + SPC. |
| QDAS/QIF export | Revisit when an ISO shop asks. |
| Multi-point calibration (lens distortion correction) | Current 2-point is sufficient at single magnification. |
| Calibration traceability / uncertainty budgets | ISO 17025 requirement. Not needed yet. |

---

## What NOT to Do

Unchanged from original assessment:
- TypeScript migration (codebase is ~7K LOC, vanilla JS works fine)
- Component framework (canvas rendering doesn't benefit)
- WebGL rendering (canvas performance is fine at current image sizes)
- Multi-user collaboration (single-operator tool)
- AI-assisted detection (classical CV pipeline needs to be solid first)

---

## Execution Log

```
✅ Done:   Phase 1 (reliability + UX)    — 2026-03-25
✅ Done:   Phase 1.5 (zoom/pan)          — 2026-03-25
✅ Done:   Phase 2 (guided inspection)   — 2026-03-25
✅ Done:   Phase 2.5 (Punch/Die + tol)   — 2026-03-26
✅ Done:   Misc polish + camera fixes    — 2026-03-26
✅ Done:   Edge-based auto-alignment     — 2026-03-28
✅ Done:   DXF export, grouping, labels  — 2026-03-28
✅ Done:   Phase 5.1 (PDF/CSV reports)   — 2026-03-28
✅ Done:   Phase 6 (tests + module splits)— 2026-03-29
✅ Done:   Viewport coordinate fixes     — 2026-03-29

Next:      Sub-pixel edge refinement     — accuracy from ~5µm to ~1µm
Then:      Measurement templates         — repeatable inspection programs
Then:      GD&T: True Position           — hole pattern inspection
Then:      Run storage (SQLite)          — foundational for SPC
Then:      Basic SPC (Cpk + charts)      — quality system credibility
Ongoing:   Detection presets             — EDM/Lathe/Print surface modes
Later:     Report templates              — customer-specific FAI forms
Later:     Batch inspection              — multi-part production use case
Future:    Gear inspection               — when gear machine is running
Future:    Nikon XY stage                — hardware integration
```
