# Annotation Persistence Design

**Date:** 2026-03-22

## Goal

Allow users to save their full measurement session (annotations, calibration, origin) to a versioned JSON file and reload it on the same image.

## Session File Format

```json
{
  "version": 1,
  "savedAt": "2026-03-22T14:32:00.000Z",
  "nextId": 12,
  "calibration": {
    "pixelsPerMm": 123.4,
    "displayUnit": "mm"
  },
  "origin": { "x": 400, "y": 300, "angle": 0.52 },
  "annotations": [
    { "id": 1, "type": "distance", "name": "bore diameter", "a": {"x":100,"y":200}, "b": {"x":300,"y":200} },
    { "id": 2, "type": "circle", "name": "", "cx": 400, "cy": 300, "r": 50 }
  ]
}
```

- `calibration` is `null` if not set.
- `origin` is `null` if not set. When non-null it includes `angle` (radians), matching the shape stored in `state.origin`.
- `nextId` is the current `state.nextId` value — restored on load to prevent ID collisions.
- `annotations` preserves all fields of each annotation object as-is, including the `name` field (see §Annotation names below).
- All coordinates are canvas pixel coordinates, valid only with the same image at the same display size.

### Excluded annotation types

The following types must be filtered out of `annotations` on save (they are transient overlays, not user measurements):
`"edges-overlay"`, `"preprocessed-overlay"`, `"dxf-overlay"`, `"detected-circle"`, `"detected-line"`

The DXF overlay (`dxf-overlay`) is preserved in `state.annotations` through a load — it is neither saved nor cleared by the load operation.

### `calibration.displayUnit` valid values

`"mm"` or `"µm"` — the only values the app currently sets. Load validation must reject any other string.

## Save

Toolbar button **💾** (`id="btn-save-session"`, title "Save session [S]", keyboard shortcut `S`):

1. Build session object: filter `state.annotations` to exclude transient types, copy `state.calibration`, `state.origin`, `state.nextId`.
2. `JSON.stringify` with 2-space indent.
3. Trigger browser download with filename `microscope-session-YYYYMMDD-HHMMSS.json`.

No backend involvement — fully client-side.

## Load

Toolbar button **📂** (`id="btn-load-session"`, title "Load session"):

1. Opens a hidden `<input type="file" id="session-file-input" accept=".json">`.
2. On file selection, wrap everything in `try/catch` — a JSON parse error shows `"Cannot load: invalid file"` in the status line and aborts.
3. Validate:
   - `version` missing → treat as v0: show `"Loaded legacy session (no version field)"` in status line, attempt to load as v1.
   - `version === 1` → proceed.
   - `version > 1` → show `"Cannot load: session format version ${data.version} is newer than this app supports"` and abort.
   - `annotations` is not an array → abort with error.
   - If `calibration` is non-null: `pixelsPerMm` must be a finite number > 0 and `displayUnit` must be `"mm"` or `"µm"` — abort with error otherwise.
4. **Confirmation:** If `state.annotations` (filtered to non-transient types) is non-empty, show a confirm dialog: `"Replace current session? This cannot be undone."` Abort if cancelled.
5. Restore:
   - `state.annotations` = loaded `annotations` (DXF overlay annotation, if any, is re-appended from current `state.annotations`).
   - `state.calibration` = loaded `calibration` (or `null`).
   - `state.origin` = loaded `origin` (or `null`).
   - `state.nextId` = loaded `nextId` (or `max(annotation ids) + 1` if `nextId` absent in file).
   - `state.selected` = `null`.
   - Clear `#coord-display` text content.
   - If `state.origin` is non-null, ensure the `origin`-type annotation in `state.annotations` has `angle` set; `state.origin.angle` is the authoritative source.
6. Call `renderSidebar()` and `redraw()`.

## Annotation Names

Each annotation already has a `name: ""` field (initialized in `addAnnotation`, edited in the sidebar via the existing `<input class="measurement-name">` per row). This field is preserved naturally through JSON serialization — no new field is needed.

The `name` field appears in the CSV export as the `"Name"` column (the existing CSV already outputs `ann.name`).

**Origin annotation sidebar row:** The origin row is rendered on a special code path without a name input. No change needed — the `name` field on the origin annotation object is still saved/restored, it is just not editable in the UI.

## Version Migration

```js
function loadSession(raw) {
  let data;
  try { data = JSON.parse(raw); }
  catch { showStatus("Cannot load: invalid file"); return; }

  if (!data.version) {
    showStatus("Loaded legacy session (no version field)");
    // attempt to treat as v1
  } else if (data.version === 1) {
    // proceed
  } else {
    showStatus(`Cannot load: session format version ${data.version} is newer than this app supports`);
    return;
  }
  restoreV1(data);
}
```

Future format changes bump the version and add a `migrateV1toV2(data)` function.

## Files Changed

| File | Change |
|------|--------|
| `frontend/app.js` | `saveSession()`, `loadSession()` functions; keyboard shortcut `S` for save; `btn-save-session` and `btn-load-session` click handlers |
| `frontend/index.html` | 💾 and 📂 toolbar buttons; hidden `<input id="session-file-input">` |
| `frontend/style.css` | No new styles needed (buttons use existing `.tool-btn.icon` class) |

## Out of Scope

- Server-side session storage.
- Embedding or referencing the source image in the session file.
- Canvas-coordinate normalization to image-relative fractions (deferred to v2).
- Rendering annotation names on the canvas (sidebar only).
