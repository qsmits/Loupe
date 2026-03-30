# Measurement Templates

## Goal

Save an inspection setup as a replayable recipe so that inspecting repeat
parts goes from 10 minutes of manual setup to 30 seconds of "load template,
place part, press go."

## Context

Currently every inspection is manual: load DXF, calibrate, align, set
tolerances, configure Punch/Die modes, run detection, run inspection, export.
For repeat parts (the common case in production), this setup is identical
every time — only the frozen frame changes.

A template captures everything except the image: DXF entities, alignment
parameters, tolerances, detection settings, feature modes/names. The operator
loads a template, places the part, freezes, and clicks "Run." The template
handles alignment (auto-align), detection, and inspection automatically.

## Design

### 1. What a template contains

A template is a JSON file with this structure:

```json
{
  "version": 1,
  "name": "Slot Bracket v2",
  "description": "10mm slot with 2 mounting holes",
  "createdAt": "2026-03-30T20:00:00Z",
  "updatedAt": "2026-03-30T20:00:00Z",

  "dxf": {
    "filename": "slot-bracket.dxf",
    "entities": [...]
  },

  "calibration": {
    "pixelsPerMm": 152.2,
    "displayUnit": "mm"
  },

  "tolerances": {
    "warn": 0.10,
    "fail": 0.25
  },
  "featureTolerances": { "C1": { "warn": 0.05, "fail": 0.15 } },
  "featureModes": { "C1": "die", "L1": "punch" },
  "featureNames": { "C1": "Mounting hole A" },

  "detection": {
    "cannyLow": 50,
    "cannyHigh": 130,
    "smoothing": 1,
    "subpixel": "parabola"
  },

  "alignment": {
    "method": "edges",
    "smoothing": 2
  }
}
```

**What's NOT in the template:** The frozen frame (image), measurement
annotations (placed per-session), inspection results (computed per-run),
calibration line annotation (the calibration value is saved, not the
annotation geometry — it's re-derived from pixelsPerMm).

### 2. Save template

**When:** After the user has completed a full inspection setup (loaded DXF,
calibrated, set tolerances, run inspection successfully). A "Save as Template"
button in the Overlay menu (near the existing export buttons).

**Flow:**
1. User clicks "Save as Template"
2. Prompt for name + optional description
3. Frontend assembles the template JSON from current state
4. Downloads as `.loupe-template.json` file (client-side download, no server storage)

In hosted mode, this works identically — templates are client-side files, no
server filesystem needed.

### 3. Load template

**When:** User wants to inspect a new part using a saved recipe.

**Flow:**
1. User clicks "Load Template" (in Overlay menu, next to Load DXF)
2. File picker for `.loupe-template.json`
3. Frontend reads the JSON, validates version
4. Applies all settings:
   - Sets calibration (pixelsPerMm + displayUnit)
   - Loads DXF entities (creates dxf-overlay annotation)
   - Sets tolerances, feature modes, feature names
   - Sets detection parameters (updates slider values)
5. Shows status: "Template loaded: Slot Bracket v2"
6. User freezes frame (or it's already frozen)
7. User clicks "Run Inspection" (existing button) — which auto-aligns + detects + inspects

**No auto-run on load:** The template sets up the configuration but doesn't
automatically run the inspection. The user needs to freeze the frame first
(the part needs to be under the microscope). The "Run Inspection" button
does the auto-align → detect → inspect pipeline.

**Template load clears existing state:** Loading a template clears any
existing DXF overlay, inspection results, and feature config — same as
loading a new DXF file. A confirmation dialog is shown if unsaved work exists.

**Calibration mismatch warning:** If current calibration differs from the
template's `pixelsPerMm`, show a confirmation: "Template calibration
(152.2 px/mm) differs from current (145.0 px/mm). Use template calibration?"

**Validation on load:** Check required fields exist (`dxf.entities` is array,
`calibration.pixelsPerMm > 0`, `tolerances.warn < tolerances.fail`). Reject
unknown versions with an error message.

**Detection slider mapping:** Template `cannyLow` → `#canny-low` slider,
`cannyHigh` → `#canny-high`, `smoothing` → `#adv-smoothing`,
`subpixel` → `state.settings.subpixelMethod`.

**Template-active flag:** Set `state._templateLoaded = true` when a template
is loaded. The "Run Inspection" handler checks this flag to decide whether
to auto-align before inspecting.

### 4. "Run Inspection" enhancement

Currently "Run Inspection" only runs the corridor-based guided inspection.
With templates loaded, it should also auto-align first:

1. Auto-align DXF (edge-based, using template's alignment settings)
2. Run guided inspection (using template's detection + tolerance settings)
3. Show results

This makes the one-click workflow possible: load template → freeze → Run.

### 5. UI changes

**Overlay menu additions:**
- "Save as Template" button (visible when DXF is loaded and calibration exists)
- "Load Template" button (always visible)
- File input (hidden, triggered by the button)

**Template info display:** When a template is loaded, show the template name
in the sidebar status area or as a small badge near the DXF controls.

### 6. Storage

**Client-side only.** Templates are JSON files the user manages. No server-side
template storage (keeps hosted mode simple). The user can store templates in
their filesystem, share them with colleagues, version control them.

**Future:** A "Recent Templates" list in localStorage (just the file names,
not the full template — the user re-loads from their file system).

## Known limitations

**DXF handle stability:** Per-feature config (tolerances, modes, names) is
keyed by DXF entity `handle`. Handles are assigned by CAD software and may
change when the DXF is re-exported. If a re-exported DXF has different
handles, the per-feature config in the template becomes orphaned. The user
would need to re-save the template. This is acceptable for now — geometry-
based matching is a future enhancement.

**Version migration:** Template `version: 1` is the initial format. If the
format changes, add version-checking logic mirroring the session loader
pattern (`session.js` lines 443-451). Unknown future versions are rejected
with an error message.

## What this does NOT include

- Server-side template storage or template library
- Automatic re-calibration (template assumes the same lens/magnification)
- Multi-step templates (template is one inspection, not a sequence)
- Template editing UI (edit by re-doing the setup and re-saving)
