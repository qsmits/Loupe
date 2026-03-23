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

The current deviation display (`drawDeviations()`) already renders per-circle labels and color codes them green/amber/red, but only activates via a toggle button and uses global tolerances. M1 tightens this into a first-class inspection workflow.

- **Per-feature tolerance configuration** — tolerances are currently global; this allows tighter tolerances on critical features and looser ones on non-critical ones. Requires a stable identity scheme for DXF entities (using the DXF `handle` attribute exposed by ezdxf) so per-feature tolerances survive DXF reloads and re-inspections. Per-feature tolerances are stored in the session JSON alongside annotation data. Entity identity design is part of this work item and is a hard prerequisite for M4.
- **Always-on deviation display** — deviation callouts appear automatically after alignment completes, without requiring a separate toggle
- **Measurement panel cleanup** — reduce clicks to read results, cleaner layout, less visual noise. Done when the developer considers it a clear improvement.
- **Arc measurement tool** *(stretch goal)* — measure a partial arc interactively: radius, center point, span angle, chord length. If it ships in M1, its result format must be included in M4's CSV and PDF scope. If it risks delaying the core M1 items, defer it as a standalone item after M1 ships; it is not tied to M2 or M3.

**Success criteria:**
- Per-feature tolerance overrides are configurable and stored in the session JSON, surviving DXF reloads.
- After alignment completes, deviation callouts are visible immediately without any additional interaction.
- Arc measurement tool: M1 is PASS regardless of whether the stretch goal shipped. If it shipped, it correctly computes and displays radius, center, span angle, and chord length for a user-placed arc.

---

## Milestone 2 — Line & Arc Detection Foundation

**Goal:** Fix the detection pipeline so it produces reliable full lines and partial arcs, then use that foundation for DXF matching.

**Development method:** Use existing snapshots as a test bed to tune algorithms iteratively before integrating into the app.

**Detection pipeline architecture:** Contour-based edge tracing (deliverable 3) is the primary approach for straight feature detection. Hough fragment merging (deliverable 2) is the fallback for images where contour tracing is insufficient. The best-performing approach is chosen during development on the reference set and configured as the default; it is not runtime-dynamic per image. Real-world test images may be imperfect (non-ideal lighting, contrast variation) so the success criteria reflect achievable targets on realistic images, not ideal conditions.

### Deliverables

1. **Reference snapshot set** — before algorithm work starts, select and commit a set of representative part snapshots with annotated expected output. Annotation format: a JSON sidecar per image, schema `{"edges": [[x0, y0, x1, y1], ...], "arcs": [{"cx": ..., "cy": ..., "r": ..., "start_deg": ..., "end_deg": ...}, ...]}`, committed alongside the image files in `tests/fixtures/detection/`. Ground truth covers only clearly visible edges (high contrast, unoccluded). This is the test bed and gates all subsequent algorithm work.

2. **Hough fragment merging (fallback path)** — group collinear Hough line fragments into single continuous lines using gap tolerance and angle clustering. A single straight edge must never produce more than one output segment; T-junctions and corners producing two segments from two genuinely separate edges are correct and not a failure.

3. **Contour-based edge tracing (primary path)** — fit parametric line segments to straight subsets of contour polylines (e.g. via Douglas-Peucker reduction followed by collinear segment fitting). Output format: each detected line is a pair of endpoints in image pixel coordinates `[(x0,y0), (x1,y1)]`, with length as the Euclidean distance.

4. **Partial arc detection** — detect arcs subtending less than a full circle. The current `detect_circles` path rejects arcs below 160° (`_ARC_MIN_COVERAGE`) to avoid false positives on circle detection. Partial arc detection must be an entirely independent code path from circle detection, with no shared filtering, and a configurable lower threshold. The 160° guard in the circle detection path remains untouched. Detector output format: `{"cx": float, "cy": float, "r": float, "start_deg": float, "end_deg": float}` per arc, in image pixel coordinates.

5. **DXF line matching** — match detected line segments (endpoint pairs) to DXF line segments. Deviation is measured as the perpendicular distance from the DXF segment's midpoint to the detected segment's line. This is valid because longitudinal shifts would manifest as deviations on adjacent intersecting features. Angular error is reported separately as degrees. Both values are shown as callouts on the overlay with pass/fail coloring.

6. **DXF arc matching** — match detected partial arcs to DXF arc entities; show center deviation (mm) and radius deviation (mm) per arc as callouts on the overlay.

**Success criteria:**
- Reference snapshot set is committed in `tests/fixtures/detection/` with JSON sidecars.
- On the reference set, using whichever pipeline is selected per image: no single clearly visible edge produces more than one output segment, and at least 90% of annotated edges are detected.
- Partial arcs with span ≥ 45° are detected with center within 5px, radius within 5%, and span within 10°.
- DXF line features show midpoint perpendicular deviation in mm and angular error in degrees, with pass/fail.
- DXF arc features show center and radius deviation in mm with pass/fail.

---

## Milestone 3 — Compound Shape Matching

**Goal:** Match slots, pockets, and arbitrary closed arc+line profiles using the detection foundation from M2.

**Heterogeneous RANSAC alignment** must be designed first as a standalone sub-task before any other M3 work starts. The existing RANSAC in `backend/vision/alignment.py` operates on circle center points only; extending it to lines and arcs requires a different constraint model (lines have no single point correspondence). Time-box this sub-task: if no viable approach is identified within the first week of M3, default to option (b) and proceed with the rest of M3.

The design sub-task must conclude with one of:
- **(a)** A viable heterogeneous RANSAC approach that unblocks slot and pocket matching on parts without circles
- **(b)** Circle-only alignment retained. Under option (b), drag-to-translate alignment of the DXF overlay is a required M3 deliverable (not currently in the codebase) so that parts without circles can be manually aligned before inspection. Slot and pocket matching remain in scope for parts that can be aligned either way.

- **Slot matching** — a slot is two parallel lines connected by two semicircular arcs; detect and match as a single compound feature with width, length, and positional deviation
- **Pocket/profile matching** — closed boundaries composed of arbitrary arc+line sequences (rounded rectangles, D-cutouts, prismatic profiles) matched against DXF outlines. In scope regardless of which alignment option is chosen, for parts that can be aligned.

**Success criteria (default, if option a):** A part with no circles can be loaded, auto-aligned using heterogeneous RANSAC, and inspected with all of: line features showing perpendicular deviation, arc features showing center and radius deviation, slot features showing width/length/position deviation, and pocket/profile features showing per-feature boundary deviation using the same tolerance model as circles (per-feature or global).

**Success criteria (if option b):** All of the above for parts that have circles and can be auto-aligned. The DXF overlay can be manually drag-translated for parts without circles. Manual alignment accuracy is the user's responsibility; alignment is considered done when the user proceeds with inspection.

---

## Milestone 4 — Inspection Reports

**Goal:** Make inspection results shareable and archivable for any geometry types that have been inspected.

**Note on M3 dependency:** M4 has no structural dependency on M3 — CSV and PDF are formatting layers over whatever features are currently matched. M4 can be built after M1+M2 if desired. The dependency diagram shows M3 before M4 because shipping reports before compound shape matching produces a less complete product, not because there is a technical blocker.

**Hard prerequisite:** entity identity scheme from M1 (DXF `handle`) must be in place for stable feature IDs in CSV and the result table.

**Session persistence:** Inspection results (per-feature deviation, tolerance, pass/fail) must be persisted in the session JSON to support re-export on session reload. This is new work — currently results are computed in-memory and not saved. Persisting results is a required deliverable of M4.

**Camera frame preservation:** The inspection camera frame must be saved as part of the session (as a JPEG or base64-encoded snapshot) so that PDF re-export on a machine with no active camera (e.g. `NO_CAMERA=1`) produces the same annotated image as the original. This is new work.

**PDF compositing approach:** client-side canvas capture (`canvas.toDataURL` composited with the saved camera frame, then rendered to PDF via jsPDF). jsPDF is loaded via CDN `<script>` tag, consistent with the project's no-build-step vanilla JS architecture. Server-side compositing is not in scope.

**Part name source:** The `part name` field in CSV and the result table is derived from the DXF filename (without extension). No user-entry field is required.

**Arc measurement tool scope:** If the M1 arc stretch goal shipped, its results (radius, center, span angle, chord length) must be included in the CSV export and PDF result table. M4 must not silently omit any shipped measurement type.

- **Per-feature result table (DOM panel)** — a structured HTML table in a sidebar or drawer showing each DXF feature and each manual measurement result, with deviation, tolerance band, and pass/fail status. Distinct from M1's canvas-rendered callouts.
- **Persist inspection results and camera frame to session JSON** — required for re-export; new backend work.
- **CSV export** — one row per feature; columns: part name (DXF filename), timestamp, feature ID, feature type, deviation, tolerance, result (PASS/FAIL/WARN)
- **PDF export** — client-side: saved camera frame composited with the canvas overlay via `canvas.toDataURL`, plus the result table, rendered to PDF via jsPDF (CDN)
- **Session integration** — re-opening a saved session restores inspection results and allows re-export without re-running the inspection

**Success criteria:**
- After a complete inspection, a user can export a CSV with correct per-feature data for all matched geometry types, with part name sourced from the DXF filename.
- CSV re-export from a reloaded session produces correct per-feature data; a new file with a new export timestamp is acceptable.
- PDF re-export from a reloaded session contains the same result table, per-feature data, and camera frame image as the original export, regardless of whether a camera is active.

---

## Dependencies

```
M1 (UX Polish) — independent, can start immediately
  └─ entity identity scheme (DXF handle) is a hard prerequisite for M4
  └─ arc stretch goal result format must be included in M4 if shipped

M2 (Line & Arc Detection) — independent of M1, can run in parallel
  └─ reference snapshot set is the first deliverable, gates all algorithm work

M3 (Compound Matching) — requires M2
  └─ starts with time-boxed RANSAC design sub-task (1 week max)
  └─ if option (b): drag-to-translate UI is a required M3 deliverable
  └─ note: M3 is substantially larger than M2; RANSAC redesign is non-trivial

M4 (Reports) — requires entity identity from M1; no hard dependency on M3
               (recommended to follow M3 for product completeness)
  └─ requires persisting inspection results + camera frame to session JSON
```

M1 and M2 can be built concurrently if bandwidth allows.
