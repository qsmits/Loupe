# Measurement Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save inspection setups as replayable templates so repeat parts go from 10 minutes of setup to 30 seconds of "load template, freeze, Run."

**Architecture:** Templates are client-side JSON files (no server storage). A new `frontend/template.js` module handles save/load/validate. Template load sets up DXF entities, calibration, tolerances, detection settings, and feature modes. "Run Inspection" auto-aligns when a template is active. Frontend-only tests validate the template JSON structure.

**Tech Stack:** Vanilla JS ES modules, Node built-in test runner

**Spec:** `docs/superpowers/specs/2026-03-30-measurement-templates-design.md`

---

## File Map

### New files
| File | Purpose |
|------|---------|
| `frontend/template.js` | Template save/load/validate logic |
| `tests/frontend/test_template.js` | Tests for template assembly and validation |

### Files to modify
| File | Changes |
|------|---------|
| `frontend/state.js` | Add `_templateLoaded`, `_templateName` |
| `frontend/index.html` | Add Save/Load Template buttons in Overlay menu |
| `frontend/main.js` | Wire template buttons, file I/O handlers |
| `frontend/dxf.js` | "Run Inspection" auto-aligns when template active |
| `frontend/sidebar.js` | Show template name in status area |

---

### Task 1: Template module with save/load/validate + tests

**Files:**
- Create: `frontend/template.js`
- Create: `tests/frontend/test_template.js`

- [ ] **Step 1: Write tests for template assembly and validation**

```js
// tests/frontend/test_template.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTemplate, validateTemplate } from '../../frontend/template.js';

describe('assembleTemplate', () => {
  it('creates a valid template from state', () => {
    const tmpl = assembleTemplate({
      name: 'Test Part',
      description: 'A test',
      dxfFilename: 'test.dxf',
      entities: [{ handle: 'L1', type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }],
      calibration: { pixelsPerMm: 100, displayUnit: 'mm' },
      tolerances: { warn: 0.10, fail: 0.25 },
      featureTolerances: { L1: { warn: 0.05, fail: 0.15 } },
      featureModes: { L1: 'die' },
      featureNames: { L1: 'Edge A' },
      detection: { cannyLow: 50, cannyHigh: 130, smoothing: 1, subpixel: 'parabola' },
      alignment: { method: 'edges', smoothing: 2 },
    });
    assert.equal(tmpl.version, 1);
    assert.equal(tmpl.name, 'Test Part');
    assert.ok(tmpl.createdAt);
    assert.equal(tmpl.dxf.entities.length, 1);
    assert.equal(tmpl.calibration.pixelsPerMm, 100);
    assert.equal(tmpl.detection.cannyLow, 50);
  });
});

describe('validateTemplate', () => {
  const validTemplate = {
    version: 1,
    name: 'Test',
    dxf: { filename: 'test.dxf', entities: [{ handle: 'L1', type: 'line' }] },
    calibration: { pixelsPerMm: 100, displayUnit: 'mm' },
    tolerances: { warn: 0.10, fail: 0.25 },
    featureTolerances: {},
    featureModes: {},
    featureNames: {},
    detection: { cannyLow: 50, cannyHigh: 130, smoothing: 1, subpixel: 'parabola' },
    alignment: { method: 'edges', smoothing: 2 },
  };

  it('accepts valid template', () => {
    const result = validateTemplate(validTemplate);
    assert.equal(result.valid, true);
  });

  it('rejects missing version', () => {
    const bad = { ...validTemplate };
    delete bad.version;
    const result = validateTemplate(bad);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('version'));
  });

  it('rejects future version', () => {
    const result = validateTemplate({ ...validTemplate, version: 99 });
    assert.equal(result.valid, false);
  });

  it('rejects missing dxf entities', () => {
    const result = validateTemplate({ ...validTemplate, dxf: { filename: 'x.dxf' } });
    assert.equal(result.valid, false);
  });

  it('rejects zero pixelsPerMm', () => {
    const result = validateTemplate({
      ...validTemplate,
      calibration: { pixelsPerMm: 0, displayUnit: 'mm' }
    });
    assert.equal(result.valid, false);
  });

  it('rejects warn >= fail', () => {
    const result = validateTemplate({
      ...validTemplate,
      tolerances: { warn: 0.5, fail: 0.1 }
    });
    assert.equal(result.valid, false);
  });

  it('rejects missing detection settings', () => {
    const bad = { ...validTemplate };
    delete bad.detection;
    const result = validateTemplate(bad);
    assert.equal(result.valid, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/frontend/test_template.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `frontend/template.js`**

```js
// template.js — Measurement template save/load/validate

const TEMPLATE_VERSION = 1;

/**
 * Assemble a template JSON object from current inspection state.
 */
export function assembleTemplate({
  name, description = '', dxfFilename, entities,
  calibration, tolerances, featureTolerances, featureModes, featureNames,
  detection, alignment,
}) {
  return {
    version: TEMPLATE_VERSION,
    name,
    description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dxf: {
      filename: dxfFilename || 'unknown.dxf',
      entities: entities || [],
    },
    calibration: { ...calibration },
    tolerances: { ...tolerances },
    featureTolerances: { ...featureTolerances },
    featureModes: { ...featureModes },
    featureNames: { ...featureNames },
    detection: { ...detection },
    alignment: { ...alignment },
  };
}

/**
 * Validate a template JSON object. Returns { valid, error? }.
 */
export function validateTemplate(tmpl) {
  if (!tmpl || typeof tmpl !== 'object')
    return { valid: false, error: 'Not a valid template object' };
  if (tmpl.version === undefined || tmpl.version === null)
    return { valid: false, error: 'Missing version field' };
  if (tmpl.version > TEMPLATE_VERSION)
    return { valid: false, error: `Template version ${tmpl.version} is newer than supported (${TEMPLATE_VERSION})` };
  if (!tmpl.dxf?.entities || !Array.isArray(tmpl.dxf.entities) || tmpl.dxf.entities.length === 0)
    return { valid: false, error: 'Missing or empty dxf.entities' };
  if (!tmpl.calibration?.pixelsPerMm || tmpl.calibration.pixelsPerMm <= 0)
    return { valid: false, error: 'Invalid calibration.pixelsPerMm (must be > 0)' };
  if (!tmpl.calibration?.displayUnit || !['mm', 'µm'].includes(tmpl.calibration.displayUnit))
    return { valid: false, error: 'Invalid calibration.displayUnit' };
  if (!tmpl.tolerances || tmpl.tolerances.warn >= tmpl.tolerances.fail)
    return { valid: false, error: 'tolerances.warn must be < tolerances.fail' };
  if (!tmpl.detection || typeof tmpl.detection.cannyLow !== 'number')
    return { valid: false, error: 'Missing detection settings' };
  return { valid: true };
}

/**
 * Download a template as a JSON file.
 */
export function downloadTemplate(tmpl) {
  const json = JSON.stringify(tmpl, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = (tmpl.name || 'template').replace(/[^a-zA-Z0-9_-]/g, '_');
  a.download = `${safeName}.loupe-template.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Read and validate a template from a File object. Returns the parsed template.
 * Throws on invalid JSON or failed validation.
 */
export async function readTemplateFile(file) {
  const text = await file.text();
  let tmpl;
  try {
    tmpl = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }
  const validation = validateTemplate(tmpl);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  return tmpl;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/frontend/test_template.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/template.js tests/frontend/test_template.js
git commit -m "feat: template module with save/load/validate + tests"
```

---

### Task 2: State + UI buttons + file I/O

**Files:**
- Modify: `frontend/state.js`
- Modify: `frontend/index.html`
- Modify: `frontend/main.js`

- [ ] **Step 1: Add template state to `state.js`**

Add to the state object (after `_labelDrag`):
```js
_templateLoaded: false,
_templateName: null,
```

- [ ] **Step 2: Add buttons to Overlay menu in `index.html`**

In the Overlay dropdown (`#dropdown-overlay`), add before the DXF controls group:

```html
<div class="dropdown-divider"></div>
<button class="dropdown-item" id="btn-save-template">Save as Template</button>
<button class="dropdown-item" id="btn-load-template">Load Template</button>
<input type="file" id="template-input" accept=".json" hidden />
```

The "Save as Template" button should only be visible when a DXF is loaded and calibration exists — handle visibility in JS.

- [ ] **Step 3: Wire buttons in `main.js`**

Add imports:
```js
import { assembleTemplate, validateTemplate, downloadTemplate, readTemplateFile } from './template.js';
```

Also update the existing `annotations.js` import to include `addAnnotation`:
```js
import { deleteAnnotation, elevateSelected, clearDetections, clearMeasurements,
         clearDxfOverlay, clearAll, addAnnotation } from './annotations.js';
```

Wire "Save as Template":
```js
document.getElementById("btn-save-template")?.addEventListener("click", () => {
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (!dxfAnn || !state.calibration) {
    showStatus("Load a DXF and calibrate before saving a template");
    return;
  }
  const name = prompt("Template name:", state.dxfFilename || "");
  if (!name) return;
  const tmpl = assembleTemplate({
    name,
    description: '',
    dxfFilename: state.dxfFilename,
    entities: dxfAnn.entities,
    calibration: state.calibration,
    tolerances: { ...state.tolerances },
    featureTolerances: { ...state.featureTolerances },
    featureModes: { ...state.featureModes },
    featureNames: { ...state.featureNames },
    detection: {
      cannyLow: parseInt(document.getElementById("canny-low")?.value || "50"),
      cannyHigh: parseInt(document.getElementById("canny-high")?.value || "130"),
      smoothing: parseInt(document.getElementById("adv-smoothing")?.value || "1"),
      subpixel: state.settings.subpixelMethod,
    },
    alignment: {
      method: 'edges',
      smoothing: parseInt(document.getElementById("adv-smoothing")?.value || "2"),
    },
  });
  downloadTemplate(tmpl);
  showStatus(`Template saved: ${name}`);
});
```

Wire "Load Template":
```js
document.getElementById("btn-load-template")?.addEventListener("click", () => {
  document.getElementById("template-input").click();
});

document.getElementById("template-input")?.addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";  // allow re-loading same file

  try {
    const tmpl = await readTemplateFile(file);

    // Confirm overwrite if unsaved work exists
    const hasWork = state.annotations.some(a => !TRANSIENT_TYPES.has(a.type));
    if (hasWork && !confirm("Loading a template will replace your current work. Continue?")) return;

    // Calibration mismatch warning
    if (state.calibration && state.calibration.pixelsPerMm > 0 &&
        Math.abs(state.calibration.pixelsPerMm - tmpl.calibration.pixelsPerMm) > 0.1) {
      const use = confirm(
        `Template calibration (${tmpl.calibration.pixelsPerMm.toFixed(1)} px/mm) ` +
        `differs from current (${state.calibration.pixelsPerMm.toFixed(1)} px/mm). ` +
        `Use template calibration?`
      );
      if (!use) return;
    }

    // Clear existing DXF, inspection state, and feature config
    state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
    state.inspectionResults = [];
    state.inspectionFrame = null;
    state.featureTolerances = {};
    state.featureModes = {};
    state.featureNames = {};

    // Apply calibration
    state.calibration = { ...tmpl.calibration };

    // Apply tolerances and feature config
    state.tolerances = { ...tmpl.tolerances };
    state.featureTolerances = { ...tmpl.featureTolerances };
    state.featureModes = { ...tmpl.featureModes };
    state.featureNames = { ...tmpl.featureNames };

    // Create DXF overlay annotation
    const cal = tmpl.calibration;
    const scale = cal.pixelsPerMm;
    addAnnotation({
      type: "dxf-overlay",
      entities: tmpl.dxf.entities,
      offsetX: canvas.width / 2,
      offsetY: canvas.height / 2,
      scale,
      angle: 0,
      scaleManual: false,
      flipH: false,
      flipV: false,
    });

    // Apply detection settings to sliders
    const det = tmpl.detection;
    const setSlider = (id, val) => {
      const el = document.getElementById(id);
      if (el) { el.value = val; }
      const valEl = document.getElementById(id + "-val");
      if (valEl) { valEl.textContent = val; }
    };
    setSlider("canny-low", det.cannyLow);
    setSlider("canny-high", det.cannyHigh);
    setSlider("adv-smoothing", det.smoothing);
    if (det.subpixel) state.settings.subpixelMethod = det.subpixel;

    // Mark template as loaded
    state._templateLoaded = true;
    state._templateName = tmpl.name;
    state.dxfFilename = tmpl.dxf.filename || tmpl.name;

    // Show DXF controls
    const dxfPanel = document.getElementById("dxf-panel");
    if (dxfPanel) dxfPanel.style.display = "";
    // Update DXF scale input
    const dxfScaleInput = document.getElementById("dxf-scale");
    if (dxfScaleInput) dxfScaleInput.value = scale.toFixed(3);

    renderSidebar();
    renderInspectionTable();
    updateCalibrationButton();
    redraw();
    showStatus(`Template loaded: ${tmpl.name}`);
  } catch (err) {
    alert("Failed to load template: " + err.message);
  }
});
```

- [ ] **Step 4: Update button visibility**

Add a function to show/hide the "Save as Template" button based on state.
Call it after DXF load, calibration change, and DXF clear:

```js
function updateTemplateButtons() {
  const hasDxf = state.annotations.some(a => a.type === "dxf-overlay");
  const hasCal = state.calibration && state.calibration.pixelsPerMm > 0;
  const saveBtn = document.getElementById("btn-save-template");
  if (saveBtn) saveBtn.style.display = (hasDxf && hasCal) ? "" : "none";
}
```

Call `updateTemplateButtons()` at these specific locations:
- `main.js`: after the template load handler completes
- `main.js`: after the DXF clear handlers (`btn-clear-dxf`, `btn-clear-all`)
- `dxf.js`: after DXF file input loads a new DXF (line ~115) — dispatch a
  custom event `document.dispatchEvent(new Event("dxf-state-changed"))` and
  listen for it in main.js
- `annotations.js`: `applyCalibration()` after calibration is set — same
  event dispatch pattern

- [ ] **Step 5: Run tests**

Run: `node --test tests/frontend/test_*.js`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add frontend/state.js frontend/index.html frontend/main.js
git commit -m "feat: template save/load UI with file I/O and state management"
```

---

### Task 3: "Run Inspection" auto-aligns when template loaded

**Files:**
- Modify: `frontend/dxf.js`

- [ ] **Step 1: Modify the "Run Inspection" handler to auto-align first**

In `frontend/dxf.js`, find the `btn-run-inspection` click handler (around line 382). Before the existing `/inspect-guided` fetch, add auto-align when template is loaded:

First, **extract the alignment offset calculation into a shared helper** in
`dxf.js` to avoid duplicating the tricky math (it appears in the DXF load
auto-align AND the auto-align button handler already):

```js
/**
 * Apply alignment result from /align-dxf-edges to a DXF overlay annotation.
 * Computes the correct offset from the anchor point.
 */
export function applyAlignmentResult(ann, result) {
  ann.scale = result.scale ?? ann.scale;
  ann.angle = result.angle_deg ?? 0;
  const cosA = Math.cos(ann.angle * Math.PI / 180);
  const sinA = Math.sin(ann.angle * Math.PI / 180);
  const xr = result.dxf_cx * cosA - result.dxf_cy * sinA;
  const yr = result.dxf_cx * sinA + result.dxf_cy * cosA;
  const cx = xr * ann.scale;
  const cy = -yr * ann.scale;
  ann.offsetX = result.img_cx - cx;
  ann.offsetY = result.img_cy - cy;
}
```

Update the existing two call sites in `dxf.js` (DXF load auto-align ~line 146
and auto-align button ~line 346) to use `applyAlignmentResult(ann, result)`.

Then in the "Run Inspection" handler, add before the existing `/inspect-guided` fetch:

```js
// If template is loaded, auto-align before inspecting
if (state._templateLoaded && state.frozen) {
  showStatus("Auto-aligning DXF...");
  const smoothing = parseInt(document.getElementById("adv-smoothing")?.value || "2");
  try {
    const alignResp = await apiFetch("/align-dxf-edges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entities: ann.entities,
        pixels_per_mm: state.calibration.pixelsPerMm,
        smoothing,
      }),
    });
    if (alignResp.ok) {
      const result = await alignResp.json();
      applyAlignmentResult(ann, result);
      redraw();
      showStatus("Aligned. Running inspection...");
    } else {
      showStatus("Auto-align failed, running inspection on current position...");
    }
  } catch (err) {
    showStatus("Auto-align error, running inspection on current position...");
  }
}
```

- [ ] **Step 2: Clear template flag on manual DXF operations**

When the user manually loads a new DXF, clears the DXF, or manually aligns, clear the template flag:

In dxf.js, after clearing DXF state:
```js
state._templateLoaded = false;
state._templateName = null;
```

Add this to: the DXF file input handler (line ~96), and the clear DXF handler.

- [ ] **Step 3: Manual smoke test**

1. Set up an inspection (load DXF, calibrate, set tolerances)
2. Save as template
3. Clear everything
4. Load the template → DXF appears, tolerances set, detection sliders updated
5. Freeze frame → click "Run Inspection" → should auto-align first, then inspect
6. Verify results match original inspection

- [ ] **Step 4: Commit**

```bash
git add frontend/dxf.js
git commit -m "feat: Run Inspection auto-aligns when template is loaded"
```

---

### Task 4: Template info display in sidebar

**Files:**
- Modify: `frontend/sidebar.js`
- Modify: `frontend/index.html`

- [ ] **Step 1: Add template info area to sidebar HTML**

In `frontend/index.html`, in the sidebar section (before the measurement list), add:

```html
<div id="template-info" class="template-info" hidden>
  <span class="template-badge">📋</span>
  <span id="template-name-display"></span>
</div>
```

- [ ] **Step 2: Add CSS for template info**

In `frontend/style.css`:
```css
.template-info {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--accent);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 6px;
}
.template-badge { font-size: 13px; }
```

- [ ] **Step 3: Update sidebar to show template name**

In `frontend/sidebar.js`, add a function:
```js
export function updateTemplateDisplay() {
  const el = document.getElementById("template-info");
  const nameEl = document.getElementById("template-name-display");
  if (el && nameEl) {
    if (state._templateLoaded && state._templateName) {
      nameEl.textContent = state._templateName;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
}
```

Call `updateTemplateDisplay()` from:
- The template load handler (in main.js, after setting `state._templateLoaded`)
- `renderSidebar()` (at the end)
- DXF clear handler (after resetting template state)

- [ ] **Step 4: Run all tests**

```bash
node --test tests/frontend/test_*.js
```

- [ ] **Step 5: Commit**

```bash
git add frontend/sidebar.js frontend/index.html frontend/style.css
git commit -m "feat: template name display in sidebar"
```

---

## Final Verification

```bash
node --test tests/frontend/test_*.js    # all frontend tests
python3 -m pytest tests/ -q             # all backend tests (no backend changes)
```

### Manual test checklist
- [ ] Load DXF + calibrate → "Save as Template" button appears
- [ ] Save template → downloads .loupe-template.json file
- [ ] Load template → DXF appears, calibration set, sliders updated
- [ ] Template name shown in sidebar
- [ ] Calibration mismatch → confirmation dialog
- [ ] Freeze + "Run Inspection" → auto-aligns first, then inspects
- [ ] Clear DXF → template name disappears
- [ ] Load invalid file → error message
- [ ] Load template with future version → rejected with error
