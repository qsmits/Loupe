# Cross-Mode Mask Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fringe mode's cumbersome inline polygon mask drawing with a cross-mode workflow that leverages microscope mode's existing annotation tools.

**Architecture:** A new `cross-mode.js` module manages the handoff between fringe and microscope modes via a shared `window.crossMode` object. When the user clicks "Edit Mask" in fringe mode, the current camera preview frame is captured, microscope state is stashed, the preview is loaded as a frozen image, and the user draws masks using existing tools. On "Apply", polygons are extracted from annotations, normalized, and sent back to fringe mode via callback.

**Tech Stack:** Vanilla JS ES modules, canvas compositing for mask preview overlay, existing FastAPI `/snapshot` endpoint for frame capture.

---

### Task 1: Create `cross-mode.js` — State Management + Stash/Restore

**Files:**
- Create: `frontend/cross-mode.js`

This module owns the `window.crossMode` object lifecycle, microscope state stash/restore, and will later house the action bar and polygon extraction (Tasks 3-4).

- [ ] **Step 1: Create the module with crossMode helpers and stash/restore**

```javascript
// cross-mode.js — Cross-mode mask editing: state management,
// microscope state stash/restore, action bar, polygon extraction.
//
// Used when fringe mode delegates mask drawing to microscope mode.
// The workflow: fringe captures a preview frame, sets window.crossMode,
// switches to microscope mode. Microscope detects crossMode, stashes
// its own state, loads the fringe preview as a frozen image, and lets
// the user draw mask regions. On Apply, closed annotations become
// normalized mask polygons sent back to fringe via callback.

import { state, undoStack, redoStack } from './state.js';

let stashedState = null;

/**
 * Initialize crossMode on window — called from fringe panel's "Edit Mask" button.
 * @param {Object} opts - { imageBlob, existingMask, callback }
 */
export function initCrossMode({ imageBlob, existingMask, callback }) {
  window.crossMode = {
    source: 'fringe',
    imageBlob,
    existingMask: existingMask || [],
    callback: callback || (() => {}),
  };
}

/** True when a cross-mode mask-edit session is active. */
export function isCrossModeActive() {
  return !!(window.crossMode && window.crossMode.source);
}

/** Clear crossMode state. */
export function clearCrossMode() {
  window.crossMode = null;
}

/**
 * Stash current microscope state so it can be restored after mask editing.
 * Deep-copies mutable fields.
 */
export function stashMicroscopeState() {
  stashedState = {
    frozen: state.frozen,
    frozenBackground: state.frozenBackground,
    frozenSize: state.frozenSize ? { ...state.frozenSize } : null,
    annotations: JSON.parse(JSON.stringify(state.annotations)),
    calibration: state.calibration ? { ...state.calibration } : null,
    undoStack: undoStack.map(s => s),
    redoStack: redoStack.map(s => s),
    tool: state.tool,
  };
}

/**
 * Restore microscope state from stash. Called on Apply or Cancel.
 */
export function restoreMicroscopeState() {
  if (!stashedState) return;

  state.frozen = stashedState.frozen;
  state.frozenBackground = stashedState.frozenBackground;
  state.frozenSize = stashedState.frozenSize;
  state.annotations = stashedState.annotations;
  state.calibration = stashedState.calibration;

  // Restore undo/redo stacks (in-place to preserve references)
  undoStack.length = 0;
  undoStack.push(...stashedState.undoStack);
  redoStack.length = 0;
  redoStack.push(...stashedState.redoStack);

  state.tool = stashedState.tool;
  stashedState = null;
}
```

- [ ] **Step 2: Verify the module parses without errors**

Run: `node --check frontend/cross-mode.js`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add frontend/cross-mode.js
git commit -m "feat(cross-mode): add state management and stash/restore module"
```

---

### Task 2: Update Fringe Panel — "Edit Mask" Button + CrossMode Setup

**Files:**
- Modify: `frontend/fringe-panel.js:33-91` (buildPanelHtml mask section)
- Modify: `frontend/fringe-panel.js:740-838` (wirePanelEvents mask handlers)
- Modify: `frontend/fringe-panel.js:96-158` (keep drawMaskOverlay, remove _drawPolygonsOnCtx helper → inline it into drawMaskOverlay)
- Modify: `frontend/fringe-panel.js:160-465` (remove enterMaskDrawMode, exitMaskDrawMode, drawEnlargeMaskOverlay, _wireEnlargeContextMenu, _pointInPolygon, _showPolyContextMenu)
- Modify: `frontend/fringe-panel.js:6` (add import for cross-mode)

Replace the old mask drawing UI (Draw Mask / Add Hole / Clear All + enlarge overlay drawing) with an "Edit Mask" button that captures the preview frame and sets up `window.crossMode`, then switches to microscope mode.

- [ ] **Step 1: Update the import at the top of fringe-panel.js**

In `frontend/fringe-panel.js`, add the cross-mode import after the existing imports (line 4):

```javascript
import { initCrossMode } from './cross-mode.js';
import { switchMode } from './modes.js';
```

- [ ] **Step 2: Replace the mask section in buildPanelHtml()**

In `frontend/fringe-panel.js`, replace the mask button HTML block (lines 73-86, from `<div style="display:flex;gap:4px` through the mask-hint div) with:

```html
        <div style="display:flex;gap:4px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <button class="detect-btn" id="fringe-btn-edit-mask" style="padding:4px 10px;font-size:11px;flex:1">
            Edit Mask
          </button>
          <button class="detect-btn" id="fringe-btn-mask-clear" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
            Clear Mask
          </button>
        </div>
        <div id="fringe-mask-status" style="font-size:10px;opacity:0.5;text-align:center" hidden></div>
```

Also remove the enlarge overlay HTML from the preview container (lines 38-41, the `fringe-enlarge-overlay` div). The enlarge overlay is no longer needed for mask drawing. Keep the preview image and ROI canvas.

Replace lines 35-42 with:

```html
        <div class="fringe-preview-container" style="position:relative">
          <img id="fringe-preview" src="/stream" alt="Camera preview" />
          <canvas id="fringe-roi-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
        </div>
```

- [ ] **Step 3: Inline _drawPolygonsOnCtx into drawMaskOverlay and simplify**

Replace the `drawMaskOverlay` function (lines 96-105) and `_drawPolygonsOnCtx` function (lines 107-158) with a single `drawMaskOverlay`:

```javascript
export function drawMaskOverlay() {
  const canvas = $("fringe-roi-canvas");
  const img = $("fringe-preview");
  if (!canvas || !img) return;
  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width;
  const h = canvas.height;

  for (const poly of fr.maskPolygons) {
    if (poly.vertices.length < 2) continue;
    const color = poly.include ? "#0a84ff" : "#ff453a";
    const fill  = poly.include ? "rgba(10,132,255,0.15)" : "rgba(255,69,58,0.15)";
    ctx.beginPath();
    ctx.moveTo(poly.vertices[0].x * w, poly.vertices[0].y * h);
    for (let i = 1; i < poly.vertices.length; i++) {
      ctx.lineTo(poly.vertices[i].x * w, poly.vertices[i].y * h);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Update mask status label
  const status = $("fringe-mask-status");
  if (status) {
    if (fr.maskPolygons.length > 0) {
      status.textContent = `Mask: ${fr.maskPolygons.length} region${fr.maskPolygons.length !== 1 ? 's' : ''}`;
      status.hidden = false;
    } else {
      status.hidden = true;
    }
  }
}
```

- [ ] **Step 4: Remove old mask drawing functions**

Delete the following functions entirely from `frontend/fringe-panel.js`:
- `enterMaskDrawMode` (lines 162-290)
- `exitMaskDrawMode` (lines 292-319)
- `drawEnlargeMaskOverlay` (lines 322-353)
- `_wireEnlargeContextMenu` (lines 357-389)
- `_pointInPolygon` (lines 391-401)
- `_showPolyContextMenu` (lines 403-465)

Also remove the `fr.maskDrawing`, `fr.maskCurrentVertices`, `fr.maskIsHole` state fields from `frontend/fringe.js` (lines 23-25) — they're no longer used. Remove `fr._maskCleanup` usage.

- [ ] **Step 5: Replace mask event wiring in wirePanelEvents()**

In `wirePanelEvents()`, replace the mask polygon drawing section (lines 820-838) with:

```javascript
  // Edit Mask — cross-mode workflow
  $("fringe-btn-edit-mask")?.addEventListener("click", async () => {
    const btn = $("fringe-btn-edit-mask");
    if (btn) { btn.disabled = true; btn.textContent = "Capturing..."; }

    try {
      // Capture the current camera preview frame
      const resp = await apiFetch("/snapshot");
      if (!resp.ok) throw new Error("Snapshot failed");
      const blob = await resp.blob();

      // Set up cross-mode state
      initCrossMode({
        imageBlob: blob,
        existingMask: fr.maskPolygons.length > 0
          ? JSON.parse(JSON.stringify(fr.maskPolygons))
          : [],
        callback: (polygons) => {
          fr.maskPolygons = polygons;
          drawMaskOverlay();
          // Update clear button state
          const clearBtn = $("fringe-btn-mask-clear");
          if (clearBtn) {
            clearBtn.disabled = polygons.length === 0;
            clearBtn.style.opacity = polygons.length === 0 ? "0.6" : "1";
          }
          // Auto-analyze with new mask
          if (polygons.length > 0) {
            analyzeFromCamera();
          }
        },
      });

      // Switch to microscope mode
      switchMode("microscope");
      const sel = $("mode-switcher");
      if (sel) sel.value = "microscope";
    } catch (e) {
      console.warn("[fringe] Edit Mask failed:", e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Edit Mask"; }
    }
  });

  // Clear mask
  $("fringe-btn-mask-clear")?.addEventListener("click", () => {
    fr.maskPolygons = [];
    drawMaskOverlay();
    const clearBtn = $("fringe-btn-mask-clear");
    if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.6"; }
  });
```

- [ ] **Step 6: Remove enlarge overlay event wiring from wirePanelEvents()**

Remove the preview click-to-enlarge handler (lines 774-797) and the Escape key handler for the enlarge overlay (lines 798-804). These relied on the enlarge overlay which is removed.

Keep the preview scroll-to-zoom handler (lines 807-818).

- [ ] **Step 7: Clean up fr state in fringe.js**

In `frontend/fringe.js`, remove the now-unused mask state fields from the `fr` object (lines 23-25):

```javascript
  maskDrawing: false,      // DELETE
  maskCurrentVertices: [], // DELETE
  maskIsHole: false,       // DELETE
```

Keep `maskPolygons` — it's still used.

- [ ] **Step 8: Run tests**

Run: `.venv/bin/pytest tests/ -v`
Expected: All tests pass (backend unchanged)

- [ ] **Step 9: Commit**

```bash
git add frontend/fringe-panel.js frontend/fringe.js
git commit -m "feat(fringe): replace inline mask drawing with Edit Mask cross-mode trigger"
```

---

### Task 3: Action Bar + Enter/Exit Mask-Edit Session in Microscope Mode

**Files:**
- Modify: `frontend/cross-mode.js` (add action bar DOM, enterMaskEditSession, exitMaskEditSession)
- Modify: `frontend/main.js` (detect crossMode after mode switch, call enterMaskEditSession)

When microscope mode activates with `window.crossMode` set, it enters a mask-edit session: stash state, load the fringe preview image, show the action bar, convert existing mask polygons to annotations.

- [ ] **Step 1: Add action bar creation and mask-edit session to cross-mode.js**

Append to `frontend/cross-mode.js`:

```javascript
import { setTool } from './tools.js';
import { canvas, redraw, resizeCanvas } from './render.js';
import { viewport, setImageSize } from './viewport.js';
import { switchMode } from './modes.js';

let actionBar = null;

/**
 * Create and show the floating action bar for mask editing.
 * @param {Function} onApply - called when user clicks Apply
 * @param {Function} onCancel - called when user clicks Cancel
 */
function showActionBar(onApply, onCancel) {
  if (actionBar) actionBar.remove();

  actionBar = document.createElement('div');
  actionBar.id = 'cross-mode-action-bar';
  actionBar.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'cross-mode-label';
  label.textContent = 'Defining fringe mask';

  const applyBtn = document.createElement('button');
  applyBtn.className = 'detect-btn cross-mode-apply';
  applyBtn.textContent = 'Apply Mask';
  applyBtn.addEventListener('click', onApply);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cross-mode-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);

  actionBar.appendChild(label);
  actionBar.appendChild(applyBtn);
  actionBar.appendChild(cancelBtn);

  document.body.appendChild(actionBar);
}

function hideActionBar() {
  if (actionBar) {
    actionBar.remove();
    actionBar = null;
  }
}

/**
 * Convert existing fringe mask polygons to microscope area annotations
 * so the user can edit their previous mask.
 */
function loadExistingMask(existingMask, imgWidth, imgHeight) {
  for (const poly of existingMask) {
    if (!poly.vertices || poly.vertices.length < 3) continue;
    // Convert normalized coords to pixel coords
    const points = poly.vertices.map(v => ({
      x: v.x * imgWidth,
      y: v.y * imgHeight,
    }));
    const ann = {
      type: 'area',
      points,
      id: state.nextId++,
      name: '',
      mode: poly.include ? 'punch' : 'die',
    };
    state.annotations.push(ann);
  }
}

/**
 * Enter mask-edit session. Called when microscope mode activates with crossMode set.
 */
export async function enterMaskEditSession() {
  if (!window.crossMode) return;

  const cm = window.crossMode;

  // 1. Stash current microscope state
  stashMicroscopeState();

  // 2. Clear microscope state for mask editing
  state.annotations = [];
  state.calibration = null;
  undoStack.length = 0;
  redoStack.length = 0;

  // 3. Load the fringe preview image as frozen background
  const url = URL.createObjectURL(cm.imageBlob);
  const loadedImg = new Image();
  await new Promise((resolve, reject) => {
    loadedImg.onload = resolve;
    loadedImg.onerror = reject;
    loadedImg.src = url;
  });

  const w = loadedImg.naturalWidth;
  const h = loadedImg.naturalHeight;
  state.frozen = true;
  state.frozenBackground = loadedImg;
  state.frozenSize = { w, h };
  setImageSize(w, h);
  viewport.zoom = 1;
  viewport.panX = 0;
  viewport.panY = 0;

  // 4. Convert existing mask polygons to area annotations
  if (cm.existingMask && cm.existingMask.length > 0) {
    loadExistingMask(cm.existingMask, w, h);
  }

  // 5. Set tool to area drawing
  setTool('area');

  // 6. Hide mode switcher
  const switcher = document.getElementById('mode-switcher');
  if (switcher) switcher.hidden = true;

  // 7. Show action bar
  showActionBar(
    () => applyMask(),
    () => cancelMask(),
  );

  // 8. Update canvas
  resizeCanvas();
  redraw();
}

/**
 * Extract closed polygon annotations and return as normalized mask polygons.
 */
function extractMaskPolygons() {
  const polygons = [];
  const imgW = state.frozenSize?.w || 1;
  const imgH = state.frozenSize?.h || 1;

  for (const ann of state.annotations) {
    if (ann.type === 'area' && ann.points && ann.points.length >= 3) {
      polygons.push({
        vertices: ann.points.map(p => ({
          x: p.x / imgW,
          y: p.y / imgH,
        })),
        include: ann.mode !== 'die',
      });
    }
  }

  return polygons;
}

function applyMask() {
  if (!window.crossMode) return;

  const polygons = extractMaskPolygons();
  const callback = window.crossMode.callback;

  // Clean up
  hideActionBar();
  restoreMicroscopeState();
  clearCrossMode();

  // Restore mode switcher
  const switcher = document.getElementById('mode-switcher');
  if (switcher) { switcher.hidden = false; switcher.value = 'fringe'; }

  // Switch back to fringe
  switchMode('fringe');

  // Deliver polygons to fringe via callback
  callback(polygons);

  redraw();
}

function cancelMask() {
  // Discard everything, restore microscope state
  hideActionBar();
  restoreMicroscopeState();
  clearCrossMode();

  // Restore mode switcher
  const switcher = document.getElementById('mode-switcher');
  if (switcher) { switcher.hidden = false; switcher.value = 'fringe'; }

  // Switch back to fringe
  switchMode('fringe');

  redraw();
}
```

Update the imports at the top of `cross-mode.js` to include all needed modules:

```javascript
import { state, undoStack, redoStack } from './state.js';
import { setTool } from './tools.js';
import { redraw, resizeCanvas } from './render.js';
import { viewport, setImageSize } from './viewport.js';
import { switchMode } from './modes.js';
```

- [ ] **Step 2: Wire crossMode detection in main.js**

In `frontend/main.js`, add the import for `enterMaskEditSession`:

```javascript
import { enterMaskEditSession, isCrossModeActive } from './cross-mode.js';
```

Then, after the `initModes()` call (find it in the init section), add a listener for mode switches that detects crossMode:

```javascript
// Cross-mode mask editing: detect when microscope mode activates with crossMode set
document.getElementById('mode-switcher')?.addEventListener('change', () => {
  if (getActiveMode() === 'microscope' && isCrossModeActive()) {
    // Defer to next tick so mode switch DOM updates complete first
    setTimeout(() => enterMaskEditSession(), 0);
  }
});
```

**Important:** The mode-switcher already has a `change` listener in `modes.js:initModes()` that calls `switchMode()`. This second listener on the same element runs after the first, so the mode containers are already toggled when `enterMaskEditSession` fires. But `switchMode` is also called programmatically from fringe-panel.js — in that case the `change` event won't fire on the `<select>`. So we also need to trigger the session entry after programmatic switches.

Better approach: use a custom event. In `frontend/modes.js`, dispatch a custom event after switching:

Add at the end of `switchMode()` in `modes.js` (after line 37):

```javascript
  document.dispatchEvent(new CustomEvent('mode-switched', { detail: { mode: modeId } }));
```

Then in `main.js`, listen to that event instead:

```javascript
document.addEventListener('mode-switched', (e) => {
  if (e.detail.mode === 'microscope' && isCrossModeActive()) {
    setTimeout(() => enterMaskEditSession(), 0);
  }
});
```

- [ ] **Step 3: Verify the module parses**

Run: `node --check frontend/cross-mode.js`
Expected: No output (clean parse)

- [ ] **Step 4: Test manually**

1. Start server: `./server.sh restart`
2. Open browser, switch to Fringe Analysis mode
3. Click "Edit Mask" — should capture preview, switch to microscope mode with the preview as frozen image
4. Action bar should appear at top-center: "Defining fringe mask" / "Apply Mask" / "Cancel"
5. Mode switcher should be hidden
6. Drawing tools should work
7. Click "Cancel" — should return to fringe mode with no mask changes
8. Click "Edit Mask" again, draw an area annotation, click "Apply Mask" — should return to fringe with mask applied

- [ ] **Step 5: Commit**

```bash
git add frontend/cross-mode.js frontend/main.js frontend/modes.js
git commit -m "feat(cross-mode): action bar, enter/exit mask-edit session, polygon extraction"
```

---

### Task 4: Mask Preview Overlay in Microscope Canvas

**Files:**
- Modify: `frontend/render.js:271-452` (add mask preview overlay render pass in redraw)
- Modify: `frontend/cross-mode.js` (export isCrossModeActive for render.js)

During mask-edit mode, render a live overlay that dims excluded areas as the user draws annotations.

- [ ] **Step 1: Add mask preview overlay render pass to redraw()**

In `frontend/render.js`, add an import for crossMode:

```javascript
import { isCrossModeActive } from './cross-mode.js';
```

In the `redraw()` function, add the mask preview overlay render pass right after `drawAnnotations(redraw, _dxfFns);` (line 290) and before the `drawPendingPoints();` call (line 291):

```javascript
  // Cross-mode mask preview overlay: dim excluded areas during mask editing
  if (isCrossModeActive()) {
    drawMaskPreviewOverlay();
  }
```

Add the `drawMaskPreviewOverlay` function before `redraw()`:

```javascript
/** Mask preview overlay for cross-mode mask editing.
 *  Dims areas that would be excluded by the current mask annotations. */
function drawMaskPreviewOverlay() {
  const iw = imageWidth || canvas.width;
  const ih = imageHeight || canvas.height;

  // Collect closed area annotations and classify as punch/die
  const punches = [];
  const dies = [];
  for (const ann of state.annotations) {
    if (ann.type !== 'area' || !ann.points || ann.points.length < 3) continue;
    if (ann.mode === 'die') {
      dies.push(ann.points);
    } else {
      punches.push(ann.points);
    }
  }

  // No annotations → no overlay
  if (punches.length === 0 && dies.length === 0) return;

  ctx.save();
  ctx.globalAlpha = 0.4;

  if (punches.length > 0) {
    // Punch regions exist: darken everything, cut out punch regions, re-darken die regions
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, iw, ih);

    // Cut out punch regions
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#fff';
    for (const pts of punches) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    }

    // Re-darken die regions within punch areas
    if (dies.length > 0) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000';
      for (const pts of dies) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }
  } else {
    // No punch regions, only die: darken just the die regions
    ctx.fillStyle = '#000';
    for (const pts of dies) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}
```

- [ ] **Step 2: Verify the module parses**

Run: `node --check frontend/render.js`
Expected: No output (clean parse)

- [ ] **Step 3: Test manually**

1. Start server, go to Fringe mode, click "Edit Mask"
2. In microscope mode, draw an area annotation (default = Punch)
3. Everything outside the area should dim
4. Right-click the area → toggle to Die
5. Only the Die area should dim, rest stays clear
6. Draw a Punch area + a Die area inside it → Punch clears, Die within Punch darkens
7. Delete all annotations → overlay disappears

- [ ] **Step 4: Commit**

```bash
git add frontend/render.js
git commit -m "feat(cross-mode): live mask preview overlay dims excluded areas during editing"
```

---

### Task 5: Prevent Mode Switching + Skip Auto-Save During CrossMode

**Files:**
- Modify: `frontend/modes.js:13` (guard switchMode when crossMode is active)
- Modify: `frontend/session.js:542` (skip auto-save when crossMode is active)

- [ ] **Step 1: Guard mode switching in modes.js**

In `frontend/modes.js`, add the import:

```javascript
import { isCrossModeActive } from './cross-mode.js';
```

At the top of `switchMode()` (line 14), add a guard that allows only the cross-mode module's own calls (which go through the exported `switchMode` directly):

```javascript
  // During cross-mode mask editing, only allow switches initiated by cross-mode.js
  // (Apply/Cancel set crossMode to null before calling switchMode)
  if (isCrossModeActive() && modeId !== 'microscope') {
    // Block — the user shouldn't switch modes while editing a mask
    // Exception: switching TO microscope is the initial entry
    return;
  }
```

Wait — this logic needs refinement. The cross-mode module calls `switchMode('fringe')` after clearing crossMode, so by the time that call happens, `isCrossModeActive()` is already false. The guard only blocks user-initiated switches during mask editing. But we also need to allow the initial switch to microscope. Let me simplify:

```javascript
  if (isCrossModeActive()) return;
```

This works because:
- When fringe calls `switchMode('microscope')`, crossMode is set but `switchMode` was already called before the `mode-switched` event fires `enterMaskEditSession`. Actually, let's trace the flow:
  1. User clicks "Edit Mask" → `initCrossMode()` sets `window.crossMode` → `switchMode('microscope')` is called
  2. At this point `isCrossModeActive()` is true, so the guard would block it!

We need to allow the initial switch. Better approach — only block if we're already in the mask-edit session (the action bar is visible):

Replace the guard with a check for the action bar DOM element:

```javascript
  // Block mode switching during cross-mode mask editing (action bar visible)
  if (document.getElementById('cross-mode-action-bar')) return;
```

This is clean: the action bar only exists during an active mask-edit session, and it's created *after* the initial mode switch completes.

In `frontend/modes.js`, add this at the start of `switchMode()` after line 14 (`if (!MODES.includes(modeId)) return;`):

```javascript
  // Block user-initiated mode switching during cross-mode mask editing
  if (document.getElementById('cross-mode-action-bar')) return;
```

No import needed — pure DOM check.

- [ ] **Step 2: Skip auto-save during crossMode in session.js**

In `frontend/session.js`, add the import:

```javascript
import { isCrossModeActive } from './cross-mode.js';
```

At the top of `autoSave()` (line 542), add:

```javascript
  if (isCrossModeActive()) return;
```

So it becomes:

```javascript
export function autoSave() {
  if (isCrossModeActive()) return;
  if (!state._dirty) return;
  // ... rest unchanged
```

- [ ] **Step 3: Verify modules parse**

Run: `node --check frontend/modes.js && node --check frontend/session.js`
Expected: No output

- [ ] **Step 4: Test manually**

1. Enter mask-edit mode via "Edit Mask"
2. Try to change the mode switcher dropdown — it should be hidden (Task 3 hides it)
3. If somehow accessible, the guard prevents switching
4. Auto-save should not fire during mask editing (check localStorage — value should not update while in mask-edit mode)

- [ ] **Step 5: Commit**

```bash
git add frontend/modes.js frontend/session.js
git commit -m "feat(cross-mode): block mode switching and skip auto-save during mask editing"
```

---

### Task 6: Action Bar Styling

**Files:**
- Modify: `frontend/style.css` (add action bar styles)

- [ ] **Step 1: Add action bar CSS**

Append to `frontend/style.css`:

```css
/* ─── Cross-mode mask editing action bar ───────────────── */
#cross-mode-action-bar {
  position: fixed;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  font-size: 12px;
}

.cross-mode-label {
  opacity: 0.7;
  white-space: nowrap;
}

.cross-mode-apply {
  padding: 4px 12px;
  font-size: 11px;
}

.cross-mode-cancel {
  padding: 4px 10px;
  font-size: 11px;
  opacity: 0.6;
  border-radius: 4px;
}

.cross-mode-cancel:hover {
  background: var(--surface-2);
  opacity: 1;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/style.css
git commit -m "style: add cross-mode mask editing action bar styles"
```

---

### Task 7: Round-Trip Editing — Punch/Die Mode on Area Annotations

**Files:**
- Modify: `frontend/cross-mode.js` (verify Punch/Die mode is correctly read/written)

This task ensures the round-trip works: existing fringe mask polygons → microscope area annotations with Punch/Die mode → back to fringe mask polygons. The `mode` property on area annotations (`"punch"` or `"die"`) is already used by the microscope mode's right-click context menu for Punch/Die toggling.

- [ ] **Step 1: Verify the mode property mapping**

Check that the context menu's Punch/Die toggle uses `ann.mode = "punch"` / `ann.mode = "die"`. Search for the toggle in the codebase.

Run: Search for `mode.*punch` or `mode.*die` in the context menu code.

The existing right-click context menu in `frontend/events-context-menu.js` should have Punch/Die toggle that sets `ann.mode`. Verify this works with area annotations.

- [ ] **Step 2: Verify loadExistingMask sets the correct mode values**

In `cross-mode.js`, the `loadExistingMask` function already sets:
```javascript
mode: poly.include ? 'punch' : 'die',
```

And `extractMaskPolygons` reads:
```javascript
include: ann.mode !== 'die',
```

These are consistent. Verify the default: annotations with no `mode` property (or `mode === undefined`) are treated as `include: true` (punch), which matches the spec ("Punch (or untagged) → include: true").

- [ ] **Step 3: Test round-trip manually**

1. Go to Fringe mode, click "Edit Mask"
2. Draw two area polygons
3. Right-click one → set to Die
4. Click "Apply Mask"
5. Verify fringe shows "Mask: 2 regions" and the ROI canvas shows the polygons
6. Click "Edit Mask" again
7. Verify both polygons appear in microscope mode with correct Punch/Die
8. Modify one polygon, click "Apply Mask"
9. Verify the modified mask is applied

- [ ] **Step 4: Commit (if any fixes needed)**

```bash
git add frontend/cross-mode.js
git commit -m "fix(cross-mode): ensure round-trip Punch/Die mode mapping is correct"
```

---

### Task 8: Integration Testing + Edge Cases

**Files:**
- Modify: `frontend/cross-mode.js` (edge case fixes if needed)
- Modify: `frontend/fringe-panel.js` (edge case fixes if needed)

- [ ] **Step 1: Test edge case — Cancel with no changes**

1. Click "Edit Mask" in fringe mode
2. Don't draw anything
3. Click "Cancel"
4. Verify: back in fringe mode, no mask changes, microscope state fully restored

- [ ] **Step 2: Test edge case — Apply with no annotations**

1. Click "Edit Mask"
2. Don't draw anything
3. Click "Apply Mask"
4. Verify: returns to fringe with empty mask array, no crash

- [ ] **Step 3: Test edge case — Clear Mask button**

1. Apply a mask (via Edit Mask workflow)
2. Verify "Clear Mask" button is enabled
3. Click "Clear Mask"
4. Verify mask is removed, button becomes disabled, ROI canvas is cleared

- [ ] **Step 4: Test edge case — Microscope state restoration**

1. In microscope mode, load an image, draw some annotations
2. Switch to fringe mode
3. Click "Edit Mask", draw mask, click "Apply"
4. Switch back to microscope mode
5. Verify: original image and annotations are restored

- [ ] **Step 5: Test edge case — Die-only mask (no Punch regions)**

1. Click "Edit Mask"
2. Draw one area annotation, right-click → set to Die
3. Click "Apply Mask"
4. Verify: mask is applied (the Die region excludes, everything else is implicitly included)

- [ ] **Step 6: Fix any issues found and commit**

```bash
git add -u
git commit -m "fix(cross-mode): address edge cases in mask editing workflow"
```

