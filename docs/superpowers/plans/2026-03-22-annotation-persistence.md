# Annotation Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add save/load of measurement sessions as versioned JSON files, with annotation name labels preserved.

**Architecture:** Fully client-side. Save triggers a browser download; load uses a file input. Version 1 format includes annotations, calibration, origin, and nextId. Annotation names use the existing `ann.name` field.

**Tech Stack:** Vanilla JS, File API, Blob download

---

## Task 1: Toolbar buttons + file input

### Current code

`frontend/index.html` toolbar (lines 23–37):

```html
  <div class="toolbar-sep"></div>
  <button class="tool-btn icon" id="btn-crosshair" title="Toggle crosshair">⊹</button>
  <button class="tool-btn icon" id="btn-set-origin" title="Set coordinate origin">⊙</button>
  <button class="tool-btn icon" id="btn-freeze" title="Freeze / Live">❄</button>
  <button class="tool-btn icon" id="btn-load" title="Load image">📁</button>
  <input type="file" id="file-input" accept="image/*">
  <button class="tool-btn icon" id="btn-snapshot" title="Save raw snapshot">📷</button>
  <input type="file" id="dxf-input" accept=".dxf" style="display:none">
  <button class="tool-btn icon" id="btn-load-dxf" title="Load DXF overlay">DXF</button>
  <button class="tool-btn icon" id="btn-export" title="Export annotated image">🖼</button>
  <button class="tool-btn icon" id="btn-export-csv" title="Export measurements as CSV">⬇CSV</button>
  <button class="tool-btn icon" id="btn-clear" title="Clear all annotations">✕</button>
  <div class="toolbar-sep"></div>
  <button class="tool-btn icon" id="btn-help" title="Help [?]">?</button>
  <button class="tool-btn icon" id="btn-settings" title="Settings">⚙</button>
```

The existing `.tool-btn.icon` style in `frontend/style.css` (line 50) is:

```css
.tool-btn.icon { padding: 4px 8px; font-size: 14px; }
```

No new CSS is needed — the Save and Load buttons use this class unchanged.

### Changes to `frontend/index.html`

Insert a 💾 Save button, a 📂 Load button, and the hidden file input **before** the `btn-clear` button. Place them after `btn-export-csv`:

- [ ] In `frontend/index.html`, replace:

```html
  <button class="tool-btn icon" id="btn-export-csv" title="Export measurements as CSV">⬇CSV</button>
  <button class="tool-btn icon" id="btn-clear" title="Clear all annotations">✕</button>
```

with:

```html
  <button class="tool-btn icon" id="btn-export-csv" title="Export measurements as CSV">⬇CSV</button>
  <button class="tool-btn icon" id="btn-save-session" title="Save session [S]">💾</button>
  <button class="tool-btn icon" id="btn-load-session" title="Load session">📂</button>
  <input type="file" id="session-file-input" accept=".json" style="display:none">
  <button class="tool-btn icon" id="btn-clear" title="Clear all annotations">✕</button>
```

### Keyboard shortcut `S` for save — change to `frontend/app.js`

The existing keydown handler is at line 118. The `toolKeys` map at line 147–149 handles lowercase letters. `S` is not in the map. Add a dedicated check for `s` **after** the tool-key lookup block, using `e.key.toLowerCase() === "s"`.

- [ ] In `frontend/app.js`, replace:

```js
  const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                     o: "circle", f: "arc-fit", m: "center-dist", e: "detect",
                     p: "perp-dist", l: "para-dist", r: "area" };
  const toolName = toolKeys[e.key.toLowerCase()];
  if (toolName) {
    setTool(toolName);
  }
});
```

with:

```js
  const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                     o: "circle", f: "arc-fit", m: "center-dist", e: "detect",
                     p: "perp-dist", l: "para-dist", r: "area" };
  const toolName = toolKeys[e.key.toLowerCase()];
  if (toolName) {
    setTool(toolName);
    return;
  }
  if (e.key.toLowerCase() === "s") {
    saveSession();
    return;
  }
});
```

### Manual verification

- [ ] Open app in browser. Toolbar shows 💾 and 📂 buttons between ⬇CSV and ✕.
- [ ] Click 💾 — a JSON file downloads (covered in Task 2 verification).
- [ ] Press `S` key (not in a text input) — same download triggers.
- [ ] Press `S` while a measurement name input is focused — nothing happens (shortcut is blocked by the existing `closest("input, …")` guard at line 126).

---

## Task 2: `saveSession()` function

### What it does

Builds a version-1 session object from `state`, filtering out transient overlay annotation types (`"edges-overlay"`, `"preprocessed-overlay"`, `"dxf-overlay"`, `"detected-circle"`, `"detected-line"`), serialises to pretty-printed JSON, and triggers a browser download.

### Implementation

- [ ] Add the following function to `frontend/app.js` **before** the `btn-clear` event listener (around line 1695). Place it in its own section after the CSV export block:

```js
// ── Session save ────────────────────────────────────────────────────────────
const TRANSIENT_TYPES = new Set([
  "edges-overlay", "preprocessed-overlay", "dxf-overlay",
  "detected-circle", "detected-line",
]);

function saveSession() {
  const session = {
    version: 1,
    savedAt: new Date().toISOString(),
    nextId: state.nextId,
    calibration: state.calibration ? { ...state.calibration } : null,
    origin: state.origin ? { ...state.origin } : null,
    annotations: state.annotations
      .filter(a => !TRANSIENT_TYPES.has(a.type))
      .map(a => ({ ...a })),
  };
  const json = JSON.stringify(session, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().slice(0, 19).replace(/[-T:]/g, (c) => c === "T" ? "-" : c);
  a.download = `microscope-session-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] Add the click handler for `btn-save-session` immediately after the function:

```js
document.getElementById("btn-save-session").addEventListener("click", saveSession);
```

### Manual verification

- [ ] Add two or three measurements (e.g. a distance and a circle). Name one of them.
- [ ] Run edge detection so an `edges-overlay` annotation is present in state.
- [ ] Press 💾. A file named `microscope-session-YYYYMMDD-HHMMSS.json` downloads.
- [ ] Open the file in a text editor. Confirm:
  - `"version": 1` is present.
  - `"savedAt"` is a valid ISO timestamp.
  - `"nextId"` matches the expected next ID.
  - `"annotations"` contains the distance and circle but **not** the edges-overlay.
  - Named annotation has `"name": "your label"`.
  - `"calibration"` is `null` if uncalibrated, or `{ "pixelsPerMm": …, "displayUnit": "mm" }` if calibrated.
  - `"origin"` is `null` if not set, or `{ "x": …, "y": …, "angle": … }` if set.

---

## Task 3: `loadSession()` function

### What it does

Opens the hidden `#session-file-input`, reads the selected JSON file with the File API, validates version and format, optionally confirms overwrite, then restores `state` (preserving any live DXF overlay). Calls `renderSidebar()` and `redraw()` at the end.

### Validation rules (from spec)

| Condition | Action |
|---|---|
| JSON parse error | `showStatus("Cannot load: invalid file")` and abort |
| `version` field absent | `showStatus("Loaded legacy session (no version field)")`, treat as v1 |
| `version === 1` | Proceed |
| `version > 1` | `showStatus(\`Cannot load: session format version ${data.version} is newer than this app supports\`)` and abort |
| `annotations` not an array | `showStatus("Cannot load: invalid file")` and abort |
| `calibration` non-null and `pixelsPerMm` not finite > 0 | `showStatus("Cannot load: invalid file")` and abort |
| `calibration` non-null and `displayUnit` not `"mm"` or `"µm"` | `showStatus("Cannot load: invalid file")` and abort |
| Non-transient annotations already present | `confirm("Replace current session? This cannot be undone.")` — abort if cancelled |

### Restore steps

1. Collect any existing `dxf-overlay` annotation from `state.annotations` to re-append after load.
2. Set `state.annotations` to the loaded annotations array.
3. Re-append the saved DXF overlay annotation if one existed.
4. Set `state.calibration` to loaded `calibration` (or `null`).
5. Set `state.origin` to loaded `origin` (or `null`).
6. Set `state.nextId` to loaded `nextId` if present; otherwise `Math.max(0, ...annotations.map(a => a.id)) + 1`.
7. Set `state.selected` to `null`.
8. Clear `#coord-display` text content.
9. Call `renderSidebar()` and `redraw()`.

### Implementation

- [ ] Add the following function to `frontend/app.js` immediately after the `saveSession` block and `btn-save-session` click handler:

```js
// ── Session load ────────────────────────────────────────────────────────────
function loadSession(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    showStatus("Cannot load: invalid file");
    return;
  }

  // Version check
  if (!data.version) {
    showStatus("Loaded legacy session (no version field)");
    // fall through and attempt to treat as v1
  } else if (data.version === 1) {
    // proceed
  } else {
    showStatus(`Cannot load: session format version ${data.version} is newer than this app supports`);
    return;
  }

  // Format validation
  if (!Array.isArray(data.annotations)) {
    showStatus("Cannot load: invalid file");
    return;
  }
  if (data.calibration !== null && data.calibration !== undefined) {
    const cal = data.calibration;
    if (typeof cal.pixelsPerMm !== "number" || !isFinite(cal.pixelsPerMm) || cal.pixelsPerMm <= 0) {
      showStatus("Cannot load: invalid file");
      return;
    }
    if (cal.displayUnit !== "mm" && cal.displayUnit !== "µm") {
      showStatus("Cannot load: invalid file");
      return;
    }
  }

  // Confirm overwrite if non-transient annotations exist
  const hasExisting = state.annotations.some(a => !TRANSIENT_TYPES.has(a.type));
  if (hasExisting) {
    if (!confirm("Replace current session? This cannot be undone.")) return;
  }

  // Preserve existing DXF overlay (if any)
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");

  // Restore state
  state.annotations = data.annotations.slice();
  if (dxfAnn) state.annotations.push(dxfAnn);

  state.calibration = data.calibration ?? null;
  state.origin = data.origin ?? null;

  // Sync origin annotation's angle from state.origin (state.origin is authoritative)
  if (state.origin) {
    const originAnn = state.annotations.find(a => a.type === "origin");
    if (originAnn) originAnn.angle = state.origin.angle ?? 0;
  }

  if (data.nextId !== undefined && data.nextId !== null) {
    state.nextId = data.nextId;
  } else {
    const maxId = data.annotations.reduce((m, a) => Math.max(m, a.id ?? 0), 0);
    state.nextId = maxId + 1;
  }

  state.selected = null;

  const coordEl = document.getElementById("coord-display");
  if (coordEl) coordEl.textContent = "";

  // Show status only when no legacy warning was already set
  if (data.version === 1) showStatus("Session loaded");

  renderSidebar();
  redraw();
}

document.getElementById("btn-load-session").addEventListener("click", () => {
  document.getElementById("session-file-input").click();
});

document.getElementById("session-file-input").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    loadSession(ev.target.result);
    e.target.value = ""; // reset so the same file can be re-loaded
  };
  reader.readAsText(file);
});
```

### Manual verification

**Happy path — load replaces current session:**

- [ ] Add two named measurements, calibrate.
- [ ] Save the session (💾).
- [ ] Add another measurement so the session has changed.
- [ ] Click 📂, select the saved file. Confirm dialog appears. Click OK.
- [ ] Sidebar shows only the original two named measurements with their names intact.
- [ ] `state.calibration` is restored (verify by checking measurement values match original).
- [ ] `#coord-display` is cleared.

**DXF overlay preservation:**

- [ ] Load a DXF overlay so `dxf-overlay` annotation exists in state.
- [ ] Load a session file via 📂.
- [ ] After load the DXF overlay remains visible on the canvas and the DXF panel stays visible.

**Confirm cancel:**

- [ ] With measurements present, click 📂 and select a file.
- [ ] Click Cancel on the confirm dialog.
- [ ] State is unchanged — existing measurements are still in the sidebar.

**Validation — bad JSON:**

- [ ] Create a `.json` file containing `{not valid json}`.
- [ ] Load it via 📂. Status line shows `"Cannot load: invalid file"`. State unchanged.

**Validation — future version:**

- [ ] Create a file with `"version": 99, "annotations": []`.
- [ ] Load it. Status line shows `"Cannot load: session format version 99 is newer than this app supports"`. State unchanged.

**Validation — missing version (legacy):**

- [ ] Create a valid session file with no `version` field and a valid `annotations` array.
- [ ] Load it. Status line shows `"Loaded legacy session (no version field)"`. Annotations are restored.

**Validation — bad calibration:**

- [ ] Create a file with `"version": 1, "annotations": [], "calibration": { "pixelsPerMm": -5, "displayUnit": "mm" }`.
- [ ] Load it. Status shows `"Cannot load: invalid file"`.
- [ ] Create a file with `"version": 1, "annotations": [], "calibration": { "pixelsPerMm": 100, "displayUnit": "inches" }`.
- [ ] Load it. Status shows `"Cannot load: invalid file"`.

---

## Task 4: CSV `Name` column label

### Current code

The CSV export handler in `frontend/app.js` at line 1673–1693:

```js
document.getElementById("btn-export-csv").addEventListener("click", () => {
  const cal = state.calibration;
  const rows = [["#", "name", "type", "value"]];
  let i = 1;
  state.annotations.forEach(ann => {
    const val = measurementLabel(ann);
    if (!val) return;  // skip non-measurement overlays
    rows.push([i++, ann.name || "", ann.type, val]);
  });
  ...
```

The `name` column is already second (position index 1, after `#`), and `ann.name` is already exported. The only issue is the header label is lowercase `"name"` — the spec requires it to be `"Name"`.

The spec says: "The `name` field appears in the CSV export as the `"Name"` column." It also says to "prepend it before other columns" — the column is already second after `#`, which satisfies "before `type` and `value`". No column reordering is needed.

### Change

- [ ] In `frontend/app.js`, replace:

```js
  const rows = [["#", "name", "type", "value"]];
```

with:

```js
  const rows = [["#", "Name", "type", "value"]];
```

### Manual verification

- [ ] Add two measurements, name one of them `"bore diameter"`.
- [ ] Click ⬇CSV. Open the downloaded file.
- [ ] First header row is `"#","Name","type","value"`.
- [ ] `Name` column is the second column (after `#`).
- [ ] The named measurement row has `"bore diameter"` in the `Name` column.
- [ ] The unnamed measurement has an empty string in the `Name` column.

---

## Summary of all file changes

| File | Change |
|---|---|
| `frontend/index.html` | Add `btn-save-session`, `btn-load-session`, and `session-file-input` to toolbar |
| `frontend/app.js` | Add `TRANSIENT_TYPES` set, `saveSession()`, `loadSession()`, click handlers for both buttons, `session-file-input` change handler, `S` keyboard shortcut; rename `"name"` → `"Name"` in CSV header |
| `frontend/style.css` | No changes — buttons reuse existing `.tool-btn.icon` styles |
