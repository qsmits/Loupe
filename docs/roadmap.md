# Roadmap: Taking the Microscope Inspector to the Next Level

> Written after a comprehensive audit of the full codebase, UI, and workflow.
> The app has excellent bones — 12 measurement tools, 6 detection algorithms,
> a full DXF inspection pipeline. But it's not yet *genuinely useful* for
> day-to-day inspection. This roadmap focuses on what would change that.

## Context

**Target parts:** Primarily wire EDM parts (sharp edges, mirror finish), lathe parts
(turned surfaces, concentric tooling marks), and eventually gears (involute profiles,
tooth spacing). 3D printed parts are used for prototyping but not the primary use case.

**Why this matters for priorities:** Wire EDM parts are the *best possible* scenario for
edge detection — razor-sharp edges with high contrast. The detection algorithms should
work extremely well here with minimal tuning. This means Phase 3 (detection robustness)
is less urgent than Phase 2 (workflow speed). The biggest bang for the buck is making the
DXF→inspection→report pipeline fast and frictionless, because the input signal (EDM edges)
is already excellent.

**Future: Gears.** Gear inspection is a specialized domain — involute profile checking,
tooth-to-tooth spacing, runout, profile deviation charts. This deserves its own phase
once the gear-making machine is running. The existing arc detection is a starting point
but involute curves are not circular arcs.

## The Core Problem

The app has powerful features but the **end-to-end workflow is too fragile and manual** for real inspection. Inspecting a part against its DXF requires: freeze frame → calibrate → load DXF → manually align → detect lines → detect arcs → run inspection → hope for matches. That's 8 steps where any one can fail silently. There's no way to save progress safely or build on previous work.

**The goal: put a part under the microscope, load the DXF, get a pass/fail report in under 60 seconds.**

---

## Phase 1: Make What Exists Reliable
*Estimated effort: 1 week. Priority: critical.*

These aren't features — they're the minimum for the app to be trustworthy.

### ~~1.0 Annotation management overhaul~~ ✅ DONE (2026-03-25)
Implemented in full:
- `state.selected` migrated from single ID to `Set` for multi-select
- Click-to-select on canvas for ALL annotation types (including detections)
- Consistent blue selection highlighting with handles on every type
- Sidebar ↔ canvas flash (pulse halo when clicking sidebar items)
- Shift+click to toggle multi-select
- Rectangle drag-select in Select mode
- **Elevation**: promote detections to measurements (`U` key or context menu)
- **Right-click context menu**: elevate, delete, rename, convert arc→circle
- **Clear menu** in top bar: Clear detections / measurements / DXF / all
- Detection busy indicator (progress cursor + button disable)
- Arc deduplication (arcs overlapping detected circles are filtered)
- Arc-measure fully draggable (extend/shorten by dragging p1/p3)
- Spec: `docs/superpowers/specs/2026-03-25-annotation-management-design.md`

### 1.1 Auto-save sessions
Sessions live only in memory. Browser crash = lost work. Add IndexedDB auto-save (30-second debounce) and a "restore last session?" prompt on startup. Also warn before closing the tab with unsaved changes (`beforeunload`).

### 1.2 Measurement reference integrity
Deleting a circle that a center-distance measurement references leaves a broken annotation. Track dependencies: warn before deleting referenced geometry, or cascade-delete dependent measurements.

### 1.3 Better error feedback everywhere
Several endpoints return generic errors. The status bar should show the real error from the server. Detection failures should explain *why* (no frame? no edges found? all filtered?). The inspection "Run" button should disable with a tooltip explaining prerequisites.

### 1.4 Renumber measurements on delete
Deleting measurement #2 of 5 leaves a gap (①③④⑤). Renumber them. Small thing, but it makes the sidebar confusing.

---

## Phase 1.5: Zoom & Pan
*Estimated effort: 1-2 weeks. Priority: high.*

The camera captures more resolution than the canvas displays. Zoom unlocks precision
and makes dense annotations manageable. This is foundational — it improves every
other workflow.

### 1.5.1 Viewport transform
Add a viewport state: `{ zoom: 1.0, panX: 0, panY: 0 }`. All canvas rendering goes
through this transform. The image is drawn at `zoom` scale, offset by `panX/panY`.
Annotations, detections, DXF overlays — everything must render through the same
viewport transform.

### 1.5.2 Scroll-wheel zoom
Mouse scroll wheel zooms in/out, centered on the cursor position. Zoom range:
0.25x (zoom out to see full image) to 8x (zoom in for sub-pixel precision).
Smooth zoom with momentum would be nice but not required.

### 1.5.3 Pan
Middle-mouse-button drag to pan, or hold Space + left-drag (Photoshop convention).
When zoomed in, the viewport shows a portion of the image. Pan moves that window.

### 1.5.4 Mouse coordinate transform
Every `canvasPoint(e)` call must account for the viewport transform — converting
screen pixels to image-space coordinates. This is the hardest part: every mouse
handler, hit-test, snap, and tool click must work in image-space, not screen-space.

### 1.5.5 Fit-to-window
Double-click the scroll wheel or press `0` to reset zoom to fit the full image
in the canvas. Press `1` for 1:1 pixel mapping.

### 1.5.6 Zoom indicator
Show the current zoom level as a small badge in the corner of the canvas (e.g.
"2.0x" or "100%"). Updates live as user zooms. Click it to get a dropdown with
preset zoom levels (Fit, 50%, 100%, 200%, 400%).

### 1.5.7 Minimap
When zoomed in past fit-to-window, show a small semi-transparent overview in a
corner showing the full image with a rectangle indicating the current viewport.
- Click the minimap to jump to that area
- Drag the rectangle to pan quickly
- Hide automatically when zoom = fit-to-window (not useful when you can see everything)
- Should be unobtrusive — small (e.g. 150x100px), low opacity until hovered

**Engineering notes:** This is the hardest change in the roadmap because it touches
the coordinate system that everything else depends on. The key insight: change
`canvasPoint(e)` to return image-space coordinates (accounting for zoom/pan), and
change the rendering to apply the viewport transform before drawing. If those two
are correct, everything else follows. The DXF overlay transform (which already has
its own scale/rotate/translate) composes with the viewport transform.

---

## Phase 2: One-Click Inspection
*Estimated effort: 2 weeks. Priority: high.*

The DXF inspection workflow needs to go from 8 manual steps to 2: load part + get report. This is the "take it to the next level" phase.

### 2.1 Guided inspection wizard
Replace the current scattered buttons with a step-by-step flow:
1. **"New Inspection"** button → prompts for DXF file + part name
2. Auto-freezes frame
3. Runs calibration check (warns if not calibrated or if scale looks wrong)
4. Auto-detects circles → attempts auto-align. If it fails, drops into manual drag-to-align mode with clear instructions.
5. Runs line + arc detection with current settings
6. Runs inspection matching
7. Shows results panel with pass/fail summary

The wizard can be abandoned at any step and the user drops back to manual mode with everything still accessible.

### 2.2 Smart alignment fallback
Auto-align fails when there aren't 2+ detected circles matching DXF circles (common with 3D prints). Add fallback strategies:
- **Point-pair alignment**: Click 2+ corresponding points on DXF and image (any feature, not just circles)
- **Edge alignment**: Drag DXF to roughly position, then auto-refine by minimizing distance between detected edges and DXF lines
- **Remember last alignment**: If the part hasn't moved, reuse the previous transform

### 2.3 Deviation statistics
The inspection table shows per-feature pass/fail but no summary. Add:
- Total features / matched / unmatched / pass / warn / fail counts
- Mean and max deviation across all features
- Cpk (process capability index) if tolerance is set — this is what QC engineers actually care about

### 2.4 Inspection frame persistence
Currently `ann.lineMatchResults` / `ann.arcMatchResults` live on the DXF annotation which is transient (not saved). Either make the DXF annotation persist with the session, or reconstruct deviation callouts from `state.inspectionResults` on session load.

---

## Phase 3: Detection Tuned for Precision Parts
*Estimated effort: 1-2 weeks. Priority: medium (EDM edges are already clean).*

Wire EDM parts have mirror finishes and razor-sharp edges — edge detection should be
near-perfect. The main challenges are: lathe tooling marks (concentric grooves that look
like arcs), reflections on polished surfaces, and varying lighting conditions.

### 3.1 Surface-aware preprocessing
Instead of one pipeline for all surfaces, offer presets:
- **Wire EDM** (default): Light preprocessing. EDM edges are so clean that aggressive
  filtering actually hurts by rounding sharp corners. Lower CLAHE clip limit to avoid
  boosting reflections on polished surfaces.
- **Turned/Lathe**: Directional filtering to suppress concentric tooling marks.
  The marks are radial arcs at a consistent radius — can be filtered by detecting the
  dominant arc family and suppressing it.
- **3D Print**: 2-3x bilateral (already implemented as the smoothing slider).
- **Custom**: Expose all preprocessing parameters for power users.

### 3.2 Interactive detection refinement
After auto-detection, let the user:
- Click a false detection to delete it
- Click an edge to force-detect a line/arc there (local refinement around the click)
- Merge two line segments into one

This bridges the gap between "fully automatic" and "fully manual." For EDM parts this
should rarely be needed, but for complex geometries it's essential.

### 3.3 Sub-pixel edge refinement
For metrology-grade accuracy on EDM parts, the current pixel-level edge detection
isn't enough. Add sub-pixel edge localization:
- After Canny gives pixel-level edges, fit a gradient-based sub-pixel position
  along each detected line/arc
- This can improve measurement accuracy from ~1px to ~0.1px
- At typical microscope magnifications, this is the difference between 10µm and 1µm accuracy

### 3.4 Detection persistence across runs
Track which features are auto-detected vs user-confirmed. Re-running detection only
replaces auto-detected features, preserving manual confirmations.

---

## Phase 4: Measurement Workflow Improvements
*Estimated effort: 1-2 weeks. Priority: medium.*

### 4.1 Measurement groups / part sections
Let users organize measurements into named groups ("Slot A", "Bore #3", "Overall dimensions"). Groups can be collapsed in the sidebar and exported as sections in reports.

### 4.2 Snap-to-detected-feature
Currently measurement tools snap to other annotations. Extend snapping to detected features: click near a detected line to snap the measurement endpoint to that line's nearest point, or click near an arc to snap to its center or endpoint.

### 4.3 Measurement templates / recipes
Save a sequence of measurement types as a template: "Slot inspection = 2 lines + 2 arcs + 2 distances + 1 slot-distance". Load the template and the app walks through each measurement step-by-step. Reusable across parts of the same type.

### 4.4 Measurement comparison
Compare measurements across sessions: "This slot was 10.032mm last time, now it's 10.048mm." Useful for wear tracking or batch comparison.

---

## Phase 5: Reporting & Traceability
*Estimated effort: 1-2 weeks. Priority: medium.*

### 5.1 Unified measurement export
The current CSV export only covers inspection results (DXF features). Add a unified export that includes ALL measurements (manual + detected + inspection) in one report, with:
- Screenshot of the part with annotations numbered
- Table mapping numbers to measurements, values, tolerances, pass/fail
- Header with part name, date, operator, calibration info

### 5.2 Part history
Keep a local database of inspections: part name → [inspection 1, inspection 2, ...]. Show trends over time. Flag if a dimension is drifting toward its tolerance limit.

### 5.3 Batch export
Inspect 5 parts, then export all 5 reports as a ZIP or combined PDF. Essential for production QC where you're checking parts off a line.

---

## Phase 6: Technical Foundation
*Estimated effort: 2-3 weeks. Priority: medium, do incrementally.*

### 6.1 Frontend testing
Currently 0% frontend test coverage. Add:
- Unit tests for `math.js`, `tools.js` geometry calculations
- Integration tests for save/load round-trips
- Visual regression tests for canvas rendering (snapshot comparison)

### 6.2 Split large modules
`render.js` is 1000+ LOC. Split by annotation type: `render-distance.js`, `render-circle.js`, `render-dxf.js`, etc. Same for `main.js` event handlers.

### 6.3 Structured logging (backend)
Add Python `logging` throughout the backend. Log detection times, camera events, errors. Essential for debugging user-reported issues.

### 6.4 Multi-point calibration
The current 2-point / circle calibration is sufficient for many cases but doesn't account for lens distortion or parallax. Add a multi-point mode: user marks 5+ known distances, system fits an affine (or polynomial) correction model and reports the calibration uncertainty.

---

## Phase 7: Multi-Part Batch Inspection
*Estimated effort: 2-3 weeks. Priority: high (real production use case).*

A Swiss lathe operator makes hundreds of identical parts. They should be able to
scatter a handful under the microscope and get all of them measured at once.

### 7.1 Part instance detection
Given a frozen frame with multiple identical parts visible:
- Detect all instances of the part using the DXF as a template
- Use contour matching or feature-based matching (detected circles/lines) to find
  each copy's position and rotation
- Handle parts at different orientations and slight overlaps
- Show each detected instance outlined and numbered

### 7.2 Per-instance alignment and inspection
For each detected part instance:
- Compute the DXF→instance transform (position, rotation, scale)
- Run the feature matching pipeline against detected edges local to that instance
- Produce a per-instance deviation report

This reuses the existing inspection pipeline but runs it N times with different
transforms. The hard part is isolating each instance's edges from its neighbors.

### 7.3 Batch results view
- Summary table: instance #, pass/fail, worst deviation, key dimensions
- Color-coded overlay: green parts pass, red parts fail, amber parts warn
- Click an instance to drill into its full deviation report
- Statistical summary across the batch: mean, std, Cpk for each feature
- Histogram of key dimension across all instances

### 7.4 Batch export
- Single PDF report covering all instances (one page per part, summary page at front)
- CSV with one row per instance per feature (pivot-table friendly)
- SPC (Statistical Process Control) chart: dimension vs. part number, with control limits

### 7.5 Quick re-inspection
For production use, the operator needs speed:
- "Same setup" mode: keep the DXF, calibration, and detection settings. Just freeze a
  new frame (new handful of parts) and click "Inspect batch"
- Target: under 10 seconds from placing parts to seeing results

---

## Phase 8: Gear Inspection (Future)
*Estimated effort: 3-4 weeks. Priority: future (when the gear-making machine is running).*

Gear inspection is a specialized domain that goes beyond line/arc/circle matching.
This phase adds gear-specific measurement and analysis tools.

### 7.1 Involute profile detection
Gears don't use circular arcs — tooth profiles are involute curves (the path traced
by a point on a string unwinding from a circle). The DXF will contain these as
splines or polylines with many short segments.
- Add involute curve fitting: given base circle radius and pressure angle, fit detected
  edge points to the theoretical involute
- Report **profile deviation** — how far the actual tooth profile deviates from the
  theoretical involute (this is the standard gear inspection metric)

### 7.2 Tooth-to-tooth measurements
- **Tooth spacing error**: Measure the angular pitch between consecutive teeth.
  Compare to the theoretical pitch (360° / N teeth).
- **Tooth thickness**: Measure chordal thickness at a specified reference diameter.
- **Runout**: If the gear can be rotated on a fixture, measure total indicated
  runout (TIR) by tracking the pitch circle across multiple angular positions.

### 7.3 Gear profile chart
Standard gear inspection produces a profile deviation chart — a plot of deviation
vs. roll angle for each tooth. Add this as an export:
- X-axis: roll angle along the tooth flank
- Y-axis: deviation from theoretical involute (in µm)
- One trace per measured tooth, overlaid
- This is the format that gear engineers expect to see

### 7.4 DXF gear recognition
Detect that a loaded DXF contains a gear (repeating radial pattern with involute-like
profiles) and automatically switch to gear inspection mode. Extract module, tooth count,
pressure angle from the geometry.

---

## What NOT to Do (Yet)

These came up in the audit but would be premature:

- **TypeScript migration** — the codebase is small enough that vanilla JS works. Migrate when it exceeds 10K LOC or when 2+ developers are working on it.
- **Component framework (Svelte/Vue)** — overkill for a single-page tool with no dynamic routing. The vanilla JS canvas approach is actually well-suited.
- **WebGL rendering** — canvas performance is fine at current image sizes. Only needed for 4K+ images.
- **Multi-user collaboration** — this is a single-operator tool. Collaboration adds massive complexity for minimal value.
- **AI-assisted detection** — intriguing but premature. The classical CV pipeline needs to work reliably first.
- **Mobile app** — the microscope is desktop-attached. A tablet companion could be useful eventually but isn't the bottleneck.
- **GD&T (Geometric Dimensioning & Tolerancing)** — full GD&T inspection (position, concentricity, profile of a surface) is a massive scope expansion. The current pass/warn/fail system covers the 80% case. Revisit when there's a real need for formal GD&T callouts.

---

## Suggested Execution Order

```
Done:      Phase 1.0 (annotation mgmt)  — COMPLETE    — selection, multi-select, elevation, context menu
Now:       Phase 1 remainder            — 3-4 days    — auto-save, ref integrity, error feedback
Next:      Phase 1.5 (zoom/pan)         — 1-2 weeks   — precision & usability unlock
Then:      Phase 2 (one-click)          — 2 weeks     — fast inspection workflow
Then:      Phase 5 (reporting)          — 1-2 weeks   — useful output
Then:      Phase 3 (detection tuning)   — 1-2 weeks   — accurate (once microscope arrives)
Then:      Phase 7 (batch inspection)   — 2-3 weeks   — production use case
Ongoing:   Phase 6 (tech foundation)    — sprinkle in as you go
Later:     Phase 4 (measurement UX)     — 1-2 weeks   — power user features
Future:    Phase 8 (gears)              — 3-4 weeks   — when gear machine is running
```

**Why zoom/pan before one-click inspection:** Zoom is foundational — it makes every
measurement more precise, every detection easier to verify, and every DXF alignment
more accurate. It also makes the annotation management features we just built much
more useful (zoom into a crowded area to select individual features). It's hard
engineering (touches the coordinate system everything depends on), but the payoff
is enormous.

**Why reporting before detection tuning:** Without a microscope, detection tuning is
theoretical. But the reporting pipeline can be built and tested with saved snapshots.

**Why batch inspection is high priority:** This is a real production use case from a
Swiss lathe operator. Scatter a handful of identical parts under the scope, get all of
them measured at once. This is where the tool goes from "interesting hobby project" to
"actually saves someone hours per week."

Phase 1 makes it trustworthy. Phase 1.5 makes it precise. Phase 2 makes it fast.
Phase 5 produces useful output. Phase 3 makes it accurate. Phase 7 makes it a
production tool.
