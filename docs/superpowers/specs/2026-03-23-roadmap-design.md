# Microscope Feature Roadmap

**Date:** 2026-03-23
**Status:** Approved

## Context

The microscope app is used by makers and engineers for precision measurement and part inspection. The core loop today is: stream live camera, apply measurement tools, load a DXF reference, auto-align via RANSAC circle matching, and check deviations. The app is actively used by multiple people with similar engineering use cases.

The two main gaps identified:
1. The inspection UX (deviation display, pass/fail) is functional but rough
2. DXF matching only supports circles — lines, arcs, slots, and compound shapes are not matched

The roadmap addresses these gaps in dependency order: polish what exists, fix the detection foundations, build compound matching on top, then add reporting.

---

## Milestone 1 — Inspection UX Polish

**Goal:** Make the existing circle-based inspection feel excellent before expanding geometry coverage.

- **Per-feature deviation callouts** — each matched circle displays its own label showing actual deviation value, not just a global color overlay
- **Pass/fail per feature** — green/amber/red indicator per feature based on its individual tolerance band
- **Per-feature tolerance configuration** — tolerances are currently global; this allows tighter tolerances on critical features and looser ones on non-critical ones
- **Measurement panel cleanup** — reduce clicks to read results, cleaner layout, less visual noise

**Success criteria:** A user can load a DXF, run alignment, and immediately see which individual circles pass and which fail, with deviation values visible without additional interaction.

---

## Milestone 2 — Line & Arc Detection Foundation

**Goal:** Fix the detection pipeline so it produces reliable full lines and partial arcs, then use that foundation for DXF matching.

**Development method:** Use existing snapshots as a test bed to tune algorithms iteratively before integrating into the app. Quantify improvement (e.g. detection rate, false positives) on real part images before touching the UI.

### Detection improvements

- **Segment merging** — group collinear Hough line fragments into single continuous lines using gap tolerance and angle clustering; eliminate the current behaviour where one edge becomes many short segments
- **Contour-based edge tracing** — extract full edge boundaries from contours (already used well for circle detection) as a complement or alternative to Hough for straight features
- **Partial arc detection** — detect arcs that subtend less than a full circle; required for compound profiles (pockets, D-cutouts, rounded rectangles) where most boundaries are arc+line composites

### DXF matching

- **DXF line matching** — match detected full lines to DXF line segments; show per-line deviation (perpendicular distance) with pass/fail coloring
- **DXF arc matching** — match detected partial arcs to DXF arc entities; show center deviation and radius deviation per arc

### Measurement tool

- **Arc measurement tool** — measure a partial arc interactively: radius, center point, span angle, chord length; natural to add here while arc geometry is being worked on

**Success criteria:** On a snapshot of a real part, the detection pipeline finds the major straight edges as single lines (not fragments) and detects partial arcs correctly. DXF line and arc features show deviation callouts with pass/fail.

---

## Milestone 3 — Compound Shape Matching

**Goal:** Match slots, pockets, and arbitrary closed arc+line profiles using the detection foundation from M2.

- **Slot matching** — a slot is two parallel lines connected by two semicircular arcs; detect and match as a single compound feature with width, length, and positional deviation
- **Pocket/profile matching** — closed boundaries composed of arbitrary arc+line sequences (rounded rectangles, D-cutouts, prismatic profiles) matched against DXF outlines
- **Multi-feature alignment** — use a combination of circles, lines, and arcs together for RANSAC alignment; makes alignment more robust on parts that have few or no circles

**Success criteria:** A part with no circles (e.g. a rectangular pocket with rounded corners) can be loaded, aligned, and inspected fully using line, arc, and slot features only.

---

## Milestone 4 — Inspection Reports

**Goal:** Make inspection results shareable and archivable.

- **Per-feature result table** — live panel showing each DXF feature, its measured deviation, tolerance band, and pass/fail status; visible during inspection without needing to export
- **CSV export** — one row per feature; columns: part name, timestamp, feature ID, feature type, deviation, tolerance, result (PASS/FAIL/WARN)
- **PDF export** — snapshot of the live view with overlay rendered in, plus the result table; suitable for a paper trail or customer sign-off
- **Session integration** — the report is tied to the saved session; re-opening a session allows re-export without re-running the inspection

**Success criteria:** After a complete inspection, a user can export a PDF that contains the annotated part image and a per-feature summary table, and a CSV that can be opened in a spreadsheet.

---

## Dependencies

```
M1 (UX Polish) — independent, can start immediately
M2 (Line & Arc Detection) — independent of M1, can run in parallel or after
M3 (Compound Matching) — requires M2
M4 (Reports) — requires M1 and M3 (needs polished per-feature UX + full geometry coverage)
```

M1 and M2 can be built concurrently if bandwidth allows.
