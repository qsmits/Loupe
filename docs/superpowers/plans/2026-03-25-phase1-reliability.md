# Phase 1 Remainder — Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auto-save to localStorage, detection result counts, and disabled button tooltips.

**Architecture:** Auto-save uses a dirty flag in `pushUndo()` + `setInterval`. Detection counts are added inside each handler after annotations are created. Tooltips are static `title` attributes updated dynamically.

**Tech Stack:** Vanilla JS, localStorage API.

**Spec:** `docs/superpowers/specs/2026-03-25-phase1-reliability-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `frontend/state.js` | Add `_dirty` and `_savedManually` flags |
| `frontend/session.js` | Add `autoSave()`, `tryAutoRestore()`. Exclude `inspectionFrame` from auto-save. |
| `frontend/main.js` | Call `tryAutoRestore()` on init, start auto-save interval, add `beforeunload` handler |
| `frontend/detect.js` | Add result count `showStatus` calls inside each detection handler |
| `frontend/index.html` | Add `title` attributes to disabled buttons |
| `frontend/sidebar.js` | Update titles dynamically in `updateDxfControlsVisibility` |
| `frontend/dxf.js` | Update export button titles in `updateExportButtons` |

---

### Task 1: Auto-save to localStorage

**Files:**
- Modify: `frontend/state.js`
- Modify: `frontend/session.js`
- Modify: `frontend/main.js`

- [ ] **Step 1: Add dirty flags to `state.js`**

In `frontend/state.js`, add to the state object (after `_flashExpiry`):
```js
_dirty: false,        // set by pushUndo/loadSession/undo/redo; cleared by autoSave
_savedManually: true,  // cleared on state change; set by manual save
```

In `pushUndo()` (line 58), add after `redoStack.length = 0`:
```js
state._dirty = true;
state._savedManually = false;
```

- [ ] **Step 2: Add auto-save and auto-restore to `session.js`**

Add at the end of `frontend/session.js`:

```js
const AUTOSAVE_KEY = "microscope-autosave";

export function autoSave() {
  if (!state._dirty) return;
  const session = {
    version: 2,
    savedAt: new Date().toISOString(),
    nextId: state.nextId,
    calibration: state.calibration ? { ...state.calibration } : null,
    origin: state.origin ? { ...state.origin } : null,
    featureTolerances: { ...state.featureTolerances },
    dxfFilename: state.dxfFilename ?? null,
    inspectionResults: state.inspectionResults.slice(),
    inspectionFrame: null,  // excluded — too large for localStorage
    annotations: state.annotations
      .filter(a => !TRANSIENT_TYPES.has(a.type))
      .map(a => ({ ...a })),
  };
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(session));
    state._dirty = false;
  } catch (e) {
    // QuotaExceededError — silently skip, user can still manually save
    console.warn("Auto-save failed:", e.message);
  }
}

export function tryAutoRestore() {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) return;
  // Show restore prompt in status area
  const bar = document.getElementById("status-bar") || document.querySelector(".status");
  if (!bar) return;
  const prompt = document.createElement("div");
  prompt.style.cssText = "display:flex; gap:8px; align-items:center; padding:4px 8px; background:var(--surface-2); border-radius:4px;";
  prompt.innerHTML = `
    <span style="font-size:12px; color:var(--text)">Previous session found</span>
    <button id="restore-btn" style="font-size:11px; padding:2px 8px; cursor:pointer;">Restore</button>
    <button id="dismiss-btn" style="font-size:11px; padding:2px 8px; cursor:pointer;">Dismiss</button>
  `;
  bar.parentElement.insertBefore(prompt, bar);
  document.getElementById("restore-btn").addEventListener("click", () => {
    prompt.remove();
    loadSession(raw);
    localStorage.removeItem(AUTOSAVE_KEY);
  });
  document.getElementById("dismiss-btn").addEventListener("click", () => {
    prompt.remove();
    localStorage.removeItem(AUTOSAVE_KEY);
  });
}

export function clearAutoSave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}
```

- [ ] **Step 3: Wire auto-save in `main.js`**

At the top of `frontend/main.js`, import the new functions:
```js
import { autoSave, tryAutoRestore, clearAutoSave } from './session.js';
```

In the init section (after all handlers are wired, near the end of the file), add:
```js
// Auto-save every 30 seconds
setInterval(autoSave, 30000);

// Offer to restore previous session
tryAutoRestore();

// Warn before closing if unsaved
window.addEventListener("beforeunload", e => {
  if (!state._savedManually && state.annotations.some(a => !TRANSIENT_TYPES.has(a.type))) {
    e.preventDefault();
    e.returnValue = "";
  }
});
```

Import `TRANSIENT_TYPES` from state.js if not already imported.

- [ ] **Step 4: Set dirty flag in undo/redo and loadSession**

In `frontend/main.js`, in the `undo()` and `redo()` functions, add after restoring state:
```js
state._dirty = true;
state._savedManually = false;
```

In `frontend/session.js`, in `loadSession()`, add after restoring all state fields:
```js
state._dirty = true;
state._savedManually = false;
```

Also in `saveSession()`, add after the download trigger:
```js
state._savedManually = true;
clearAutoSave();
```

- [ ] **Step 5: Verify manually**

1. Create some measurements → wait 30 seconds → check `localStorage.getItem("microscope-autosave")` in browser console (should be non-null)
2. Reload the page → "Previous session found" prompt should appear
3. Click Restore → measurements reappear
4. Create measurements → try to close tab → browser should warn

- [ ] **Step 6: Commit**

```bash
git add frontend/state.js frontend/session.js frontend/main.js
git commit -m "feat: auto-save sessions to localStorage with restore prompt and beforeunload warning"
```

---

### Task 2: Detection Result Counts

**Files:**
- Modify: `frontend/detect.js`

- [ ] **Step 1: Add result counts to each detection handler**

In `frontend/detect.js`, add a `showStatus` call inside each detection handler, right before the `redraw()` call:

**Circles handler** (before `redraw()` at ~line 132):
```js
showStatus(circles.length > 0 ? `Found ${circles.length} circle${circles.length !== 1 ? "s" : ""}` : "No circles found — try adjusting settings");
```

**Lines handler** (before `redraw()` at ~line 157):
```js
showStatus(lines.length > 0 ? `Found ${lines.length} line${lines.length !== 1 ? "s" : ""}` : "No lines found — try adjusting settings");
```

**Merged lines handler** (before `redraw()` at ~line 179):
```js
showStatus(lines.length > 0 ? `Found ${lines.length} line${lines.length !== 1 ? "s" : ""}` : "No lines found — try adjusting settings");
```

**Partial arcs handler** (before `redraw()` at ~line 210):
```js
showStatus(filteredArcs.length > 0 ? `Found ${filteredArcs.length} arc${filteredArcs.length !== 1 ? "s" : ""}` : "No arcs found — try adjusting settings");
```

**Edges handler** — no count needed (it's a visual overlay, not a feature list).

**Preprocessed handler** — no count needed (diagnostic tool).

- [ ] **Step 2: Commit**

```bash
git add frontend/detect.js
git commit -m "feat: show detection result counts in status bar"
```

---

### Task 3: Disabled Button Tooltips

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/sidebar.js`
- Modify: `frontend/dxf.js`

- [ ] **Step 1: Add static tooltips to `index.html`**

Add `title` attributes to these buttons:

- `btn-show-deviations` (line 156): `title="Run inspection first"`
- `btn-run-inspection` (line 158): `title="Load a DXF and detect features first"`
- `btn-dxf-move` (line 159): `title="Load a DXF first"`
- `btn-export-inspection-csv` (line 161): `title="Run inspection first"`
- `btn-export-inspection-pdf` (line 162): `title="Run inspection first"`

(`btn-auto-align` already has a title.)

- [ ] **Step 2: Update dynamic tooltips in `sidebar.js`**

In `updateDxfControlsVisibility()` (line 260), after the existing enable/disable logic, add:

```js
if (inspBtn) inspBtn.title = inspBtn.disabled ? "Load a DXF and detect features first" : "Run DXF inspection";
if (moveBtn) moveBtn.title = moveBtn.disabled ? "Load a DXF first" : "Drag to reposition DXF overlay";
```

- [ ] **Step 3: Update export button tooltips in `dxf.js`**

Find the `updateExportButtons()` function. After setting `disabled`, add:

```js
if (csvBtn) csvBtn.title = csvBtn.disabled ? "Run inspection first" : "Export inspection results as CSV";
if (pdfBtn) pdfBtn.title = pdfBtn.disabled ? "Run inspection first" : "Export inspection report as PDF";
```

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/sidebar.js frontend/dxf.js
git commit -m "feat: add tooltips to disabled buttons explaining prerequisites"
```
