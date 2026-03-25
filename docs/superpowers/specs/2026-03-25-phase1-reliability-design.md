# Phase 1 Remainder — Reliability Fixes Design Spec

## Problem

Three reliability gaps that erode trust in the app:
1. Session data lives only in memory — browser crash loses all work
2. Deleting a circle that other measurements reference leaves broken annotations
3. Some UI states lack feedback (disabled buttons without explanation, detection results without summary)

## Solution

### 1.1 Auto-save to localStorage

**Save:** Every 30 seconds, if state has changed since last save, serialize the session
(same format as manual save) and write to `localStorage` under key `microscope-autosave`.
Track changes via a dirty flag set in `pushUndo()` and cleared after auto-save.

**Restore:** On app startup (in `main.js` init), check `localStorage` for the key. If
found, show an inline prompt in the status bar area: "Previous session found — [Restore] [Dismiss]".
Restore calls `loadSession()` with the stored JSON. Dismiss clears the key.

**beforeunload:** Add a `window.addEventListener("beforeunload", ...)` that sets
`e.returnValue` if there are non-transient annotations and the session hasn't been
manually saved since the last change.

**Files:**
- `frontend/session.js` — add `autoSave()`, `autoRestore()`, dirty flag logic
- `frontend/main.js` — call `autoRestore()` on init, start `setInterval` for auto-save
- `frontend/state.js` — add `_dirty: false` field, set in `pushUndo()`

### 1.2 Measurement reference integrity

**On delete:** Before removing an annotation, scan all other annotations for references
to it. References are detected by checking if any annotation's coordinate fields point
to the same circle/line (by matching annotation ID stored during creation, or by
geometric proximity if IDs aren't tracked).

**Current reality:** Measurements like `center-dist` don't store references to the
circles they were created from — they store computed `a` and `b` points. So there's
no dangling reference to break. The same is true for `perp-dist`, `para-dist`, etc.

**Revised approach:** Since measurements store computed coordinates (not references),
deletion of source geometry doesn't actually break anything — the measurement keeps
its values. The only real issue is that the measurement's position no longer corresponds
to a visible feature. This is a UX concern, not a data integrity issue.

**Implementation:** Add a visual indicator instead of cascade-delete. When an annotation
is selected, dim or highlight the annotations that were created from it (if trackable).
For now, this is low-priority — the computed-coordinate approach is already safe.

**Files:** No changes needed. Downgrade to "nice-to-have" in roadmap.

### 1.3 Better error feedback

**Detection result count:** After each detection runs, show result count in status bar.
Already partially implemented (the `withBusy` wrapper shows "Detecting...").
Add: after detection completes, show "Found N circles" / "Found N lines" / "No features
found — try adjusting settings".

**Disabled button tooltips:** Add `title` attributes to disabled buttons that explain
prerequisites:
- "Run inspection" → `title="Load a DXF and run detection first"`
- "Auto-align" → `title="Need 2+ circles in both DXF and image"`
- Export buttons → `title="Run inspection first"`

**Files:**
- `frontend/detect.js` — add result count to status after each detection
- `frontend/index.html` — add `title` attributes to disabled buttons
- `frontend/sidebar.js` — update button titles dynamically in `updateDxfControlsVisibility`

---

## What's NOT in scope

- IndexedDB (localStorage is simpler and sufficient for one session blob)
- Multi-session auto-save history (just keep the latest)
- Cascade-delete on reference removal (measurements store computed coords, not refs)
