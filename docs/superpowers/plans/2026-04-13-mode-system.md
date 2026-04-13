# Mode System & Deflectometry Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deflectometry dialog overlay with a full-window workspace, controlled by a mode switcher dropdown in the top bar.

**Architecture:** A mode switcher `<select>` in the top bar toggles visibility of root containers (`#mode-microscope`, `#mode-deflectometry`, `#mode-fringe`). The existing microscope UI is wrapped in `#mode-microscope` unchanged. Deflectometry gets a three-column workspace (camera preview | workflow steps | tabbed results). The iPad page gains a `centering` command type for part alignment.

**Tech Stack:** Vanilla JS ES modules (no framework), CSS flexbox, existing MJPEG stream endpoint, Three.js (already lazy-loaded from esm.sh for 3D viewer).

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/index.html` | Modify | Add mode switcher, wrap existing UI in `#mode-microscope`, add `#mode-deflectometry` and `#mode-fringe` containers |
| `frontend/style.css` | Modify | Add mode container styles, deflectometry workspace layout, workflow step styles, result tab styles |
| `frontend/modes.js` | Create | Mode switching logic: show/hide containers, show/hide top-bar items, dispatch mode change |
| `frontend/deflectometry.js` | Rewrite | Full workspace module replacing the dialog overlay |
| `frontend/deflectometry-screen.html` | Modify | Add `centering` command handler (concentric circles) |
| `frontend/main.js` | Modify | Import and init `modes.js`, remove `#btn-deflectometry` click handler |

---

### Task 1: Mode Switcher & Container Wrappers

**Files:**
- Modify: `frontend/index.html`
- Create: `frontend/modes.js`
- Modify: `frontend/main.js`
- Modify: `frontend/style.css`

- [ ] **Step 1: Add mode switcher and container wrappers to index.html**

In `frontend/index.html`, replace the `<span id="app-title">Microscope</span>` with the mode switcher:

```html
<select id="mode-switcher" class="mode-switcher">
  <option value="microscope">Microscope</option>
  <option value="deflectometry">Deflectometry</option>
  <option value="fringe">Fringe Analysis</option>
</select>
```

Wrap the existing `<div id="main">` content. Change:

```html
  <!-- Main content area -->
  <div id="main">
```

to:

```html
  <!-- Main content area -->
  <div id="main">
    <div id="mode-microscope" class="mode-container mode-active">
```

And right before the closing `</div>` of `#main` (after `#sidebar` closes at line ~438), add:

```html
    </div><!-- /mode-microscope -->

    <div id="mode-deflectometry" class="mode-container" hidden>
    </div>

    <div id="mode-fringe" class="mode-container" hidden>
      <div style="display:flex;align-items:center;justify-content:center;flex:1;opacity:0.5;font-size:18px">
        Fringe Analysis — coming soon
      </div>
    </div>
```

Also in the top bar, add `class="microscope-only"` to the Detect, Overlay, and Clear menu-groups (the three `<div class="menu-group">` elements wrapping `#btn-menu-detect`, `#btn-menu-overlay`, `#btn-menu-clear`).

Add `class="microscope-only"` to the mode buttons in `.top-bar-right`: `#btn-compare`, `#btn-stitch`, `#btn-superres`, `#btn-zstack`, `#btn-deflectometry`, `#btn-zstack-3d-view`, `#btn-analyze-gear`, `#btn-load`, `#btn-save-session`. Keep `#btn-freeze`, `#btn-settings`, `#btn-help` without the class (they remain visible in all modes).

Remove the `#btn-deflectometry` button entirely (it's replaced by the mode switcher).

- [ ] **Step 2: Add mode container CSS to style.css**

Append to `frontend/style.css`:

```css
/* ── Mode system ─────────────────────────────────────────── */

.mode-switcher {
  font-size: 14px;
  font-weight: 600;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
  outline: none;
}
.mode-switcher:focus {
  border-color: var(--accent);
}

.mode-container {
  display: flex;
  flex: 1;
  min-height: 0;
}
.mode-container[hidden] {
  display: none !important;
}
```

- [ ] **Step 3: Create modes.js**

Create `frontend/modes.js`:

```js
// modes.js — Mode switching: Microscope / Deflectometry / Fringe Analysis.
//
// Controls visibility of mode root containers and top-bar items.
// Each mode module registers itself; switching hides the current
// container and shows the new one.

const MODES = ["microscope", "deflectometry", "fringe"];
let activeMode = "microscope";

function $(id) { return document.getElementById(id); }

/** Switch to a mode by id. Hides current, shows target, toggles top-bar items. */
export function switchMode(modeId) {
  if (!MODES.includes(modeId)) return;
  activeMode = modeId;

  // Toggle mode containers
  for (const m of MODES) {
    const el = $("mode-" + m);
    if (el) el.hidden = m !== modeId;
  }

  // Toggle microscope-only top-bar items
  document.querySelectorAll(".microscope-only").forEach(el => {
    el.hidden = modeId !== "microscope";
  });

  // Toggle microscope-only bottom elements (tool strip, sidebar)
  const toolStrip = $("tool-strip");
  const sidebar = $("sidebar");
  if (toolStrip) toolStrip.hidden = modeId !== "microscope";
  if (sidebar) sidebar.hidden = modeId !== "microscope";
}

export function getActiveMode() {
  return activeMode;
}

/** Wire up the mode switcher <select>. Call once from main.js. */
export function initModes() {
  const sel = $("mode-switcher");
  if (!sel) return;
  sel.addEventListener("change", () => switchMode(sel.value));
}
```

- [ ] **Step 4: Wire modes.js into main.js**

In `frontend/main.js`, add the import near the top (after the existing feature imports):

```js
import { initModes } from './modes.js';
```

Call `initModes()` early in the initialization, before the feature inits (e.g., right after `initKeyboard`):

```js
initModes();
```

Remove the `#btn-deflectometry` line from `initDeflectometry()` wiring — it no longer exists in the DOM. (The actual `initDeflectometry()` call stays; we rewrite that function in Task 3.)

- [ ] **Step 5: Verify mode switching works**

Open http://localhost:8000 in a browser. The mode dropdown should appear in the top bar. Switching to "Deflectometry" should hide the microscope UI (viewer, sidebar, tool strip, detect/overlay/clear menus, mode buttons) and show an empty container. Switching to "Fringe Analysis" should show the coming-soon message. Switching back to "Microscope" should restore everything.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/style.css frontend/modes.js frontend/main.js
git commit -m "feat: mode switcher (Microscope / Deflectometry / Fringe Analysis)"
```

---

### Task 2: iPad Centering Pattern

**Files:**
- Modify: `frontend/deflectometry-screen.html`
- Modify: `backend/api_deflectometry.py`

- [ ] **Step 1: Add centering circle renderer to iPad page**

In `frontend/deflectometry-screen.html`, add a `renderCentering()` function after the existing `renderSolid(value)` function:

```js
  function renderCentering() {
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;
    const maxR = Math.min(W, H) / 2;
    const spacing = Math.min(W, H) / 12;
    const ringCount = Math.floor(maxR / spacing);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1));

    for (let i = 1; i <= ringCount; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, i * spacing, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // Center crosshair
    const crossSize = Math.round(8 * (window.devicePixelRatio || 1));
    ctx.beginPath();
    ctx.moveTo(cx - crossSize, cy);
    ctx.lineTo(cx + crossSize, cy);
    ctx.moveTo(cx, cy - crossSize);
    ctx.lineTo(cx, cy + crossSize);
    ctx.stroke();

    drawSessionLabel();
  }
```

Update the `handleCommand` function to recognize the `centering` type. Add a case before the `return;`:

```js
    } else if (cmd.type === 'centering') {
      renderCentering();
```

Also update the `reRenderLast` function to handle it:

```js
      else if (lastCommand.type === 'centering') renderCentering();
```

Change the initial boot and reconnect to show centering circles instead of mid-gray. In `ws.onmessage`, change the `paired` handler:

```js
      if (msg.type === 'paired') {
        sessionId = msg.session_id;
        paired = true;
        lastCommand = { type: 'centering' };
        renderCentering();
        return;
      }
```

- [ ] **Step 2: Send centering command from backend after connect and after captures**

In `backend/api_deflectometry.py`, in the WebSocket handler `deflectometry_ws`, after sending the `paired` message, also send centering:

```python
        await websocket.send_json({"type": "paired", "session_id": s.id})
        await websocket.send_json({"type": "centering"})
```

At the end of the `deflectometry_flat_field` endpoint, before the return, add:

```python
            # Return iPad to centering pattern
            if s.ws is not None:
                await s.ws.send_json({"type": "centering"})
```

Replace the existing `_push_and_wait(s, {"type": "clear", "pattern_id": 3})` call with this centering send (remove the clear call).

At the end of `deflectometry_capture_sequence`, after the `async with s.lock:` block and before the return, add:

```python
        # Return iPad to centering pattern
        if s.ws is not None:
            await s.ws.send_json({"type": "centering"})
```

At the end of `deflectometry_capture_reference`, after the reference phases are stored and before the return, add:

```python
        # Return iPad to centering pattern
        if s.ws is not None:
            await s.ws.send_json({"type": "centering"})
```

- [ ] **Step 3: Test centering pattern**

Run: `.venv/bin/pytest tests/test_deflectometry.py tests/test_deflectometry_api.py -v`
Expected: all tests pass (centering is a WebSocket-only feature; HTTP tests should not be affected).

Restart the server (`./server.sh restart`), open the iPad page, and verify:
- On connect: concentric white circles on black background with center crosshair.
- After flat field / capture: circles return automatically.

- [ ] **Step 4: Commit**

```bash
git add frontend/deflectometry-screen.html backend/api_deflectometry.py
git commit -m "feat: iPad centering circles for part alignment"
```

---

### Task 3: Deflectometry Workspace Layout

**Files:**
- Rewrite: `frontend/deflectometry.js`
- Modify: `frontend/style.css`

This is the largest task. The existing `deflectometry.js` (dialog-overlay approach) is completely rewritten as a three-column workspace that lives inside `#mode-deflectometry`.

- [ ] **Step 1: Add deflectometry workspace CSS**

Append to `frontend/style.css`:

```css
/* ── Deflectometry workspace ─────────────────────────────── */

.defl-workspace {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 0;
}

/* Left column: preview + settings */
.defl-preview-col {
  width: 250px;
  min-width: 250px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  padding: 10px;
  gap: 10px;
  overflow-y: auto;
}
.defl-preview-col img {
  width: 100%;
  border: 1px solid var(--border);
  background: #111;
  display: block;
}
.defl-badge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.defl-badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 3px;
  border: 1px solid #333;
  background: #1a1a2a;
  color: #888;
}
.defl-badge.active {
  background: #0f2a16;
  color: #4ade80;
  border-color: #1f5a2e;
}
.defl-setting-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.defl-setting-group label {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.defl-setting-group input[type="number"],
.defl-setting-group select {
  width: 100%;
  max-width: 160px;
}

/* Center column: workflow steps */
.defl-workflow-col {
  width: 280px;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  padding: 10px;
  gap: 0;
  overflow-y: auto;
}
.defl-workflow-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  opacity: 0.7;
}
.defl-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 6px;
  border-bottom: 1px solid var(--border);
}
.defl-step.disabled {
  opacity: 0.35;
  pointer-events: none;
}
.defl-step-indicator {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #555;
  flex-shrink: 0;
  margin-top: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}
.defl-step-indicator.done {
  border-color: #4ade80;
  color: #4ade80;
}
.defl-step-indicator.error {
  border-color: #f87171;
  color: #f87171;
}
.defl-step-body {
  flex: 1;
  min-width: 0;
}
.defl-step-name {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 3px;
}
.defl-step-status {
  font-size: 11px;
  opacity: 0.7;
  margin-bottom: 4px;
}
.defl-step-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.defl-step-controls input[type="number"] {
  width: 65px;
}
.defl-workflow-footer {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

/* Right column: results */
.defl-results-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.defl-tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  padding: 0 10px;
}
.defl-tab {
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  opacity: 0.6;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
  color: var(--text);
}
.defl-tab:hover { opacity: 0.85; }
.defl-tab.active {
  opacity: 1;
  border-bottom-color: var(--accent);
}
.defl-tab-panel {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  min-height: 0;
}
.defl-tab-panel[hidden] {
  display: none !important;
}
.defl-phase-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.defl-phase-grid img {
  width: 100%;
  border: 1px solid #444;
  background: #111;
  display: block;
}
.defl-phase-grid pre {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: #0b0b0b;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: pre;
}
.defl-empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  opacity: 0.4;
  font-size: 14px;
  min-height: 200px;
}
.defl-3d-host {
  flex: 1;
  min-height: 400px;
  position: relative;
}
.defl-3d-host canvas {
  width: 100% !important;
  height: 100% !important;
}
.defl-3d-controls {
  position: absolute;
  bottom: 10px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0,0,0,0.7);
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
}
.defl-diag-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.defl-diag-grid img {
  width: 100%;
  border: 1px solid #444;
  background: #111;
  display: block;
}
.defl-diag-grid pre {
  margin: 4px 0 0;
  padding: 4px 6px;
  background: #0b0b0b;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  font-size: 10px;
}
```

- [ ] **Step 2: Rewrite deflectometry.js — module state and helpers**

Rewrite `frontend/deflectometry.js` from scratch. Start with the module header, imports, state, and utility functions:

```js
// deflectometry.js — Full-window deflectometry workspace.
//
// Three-column layout:
//   Left:   camera preview + status badges + settings
//   Center: workflow step checklist
//   Right:  tabbed results (Phase Maps | 3D Surface | Diagnostics)
//
// Replaces the previous dialog-overlay approach. Lives inside
// #mode-deflectometry, managed by modes.js.

import { apiFetch } from './api.js';
import { state } from './state.js';

const df = {
  polling: null,
  built: false,
  threeLoaded: false,
};

function $(id) { return document.getElementById(id); }

function setStepStatus(stepId, status, text) {
  const indicator = $("defl-ind-" + stepId);
  const statusEl = $("defl-status-" + stepId);
  if (indicator) {
    indicator.className = "defl-step-indicator" + (status === "done" ? " done" : status === "error" ? " error" : "");
    indicator.textContent = status === "done" ? "\u2713" : status === "error" ? "\u2717" : "";
  }
  if (statusEl && text !== undefined) statusEl.textContent = text;
}

function setStepEnabled(stepId, enabled) {
  const el = $("defl-step-" + stepId);
  if (el) {
    if (enabled) el.classList.remove("disabled");
    else el.classList.add("disabled");
  }
}

function setBadge(id, active) {
  const el = $(id);
  if (!el) return;
  if (active) el.classList.add("active");
  else el.classList.remove("active");
}

function formatStats(stats, calFactor) {
  if (!stats) return "\u2014";
  if (calFactor) {
    const k = Math.abs(calFactor) * 1000;
    const pv = Number.isFinite(stats.pv) ? (stats.pv * k).toFixed(2) : "\u2014";
    const rms = Number.isFinite(stats.rms) ? (stats.rms * k).toFixed(2) : "\u2014";
    const mean = Number.isFinite(stats.mean) ? (stats.mean * k).toFixed(2) : "\u2014";
    return `PV:   ${pv} \u00b5m\nRMS:  ${rms} \u00b5m\nMean: ${mean} \u00b5m`;
  }
  const pv = Number.isFinite(stats.pv) ? stats.pv.toFixed(3) : "\u2014";
  const rms = Number.isFinite(stats.rms) ? stats.rms.toFixed(3) : "\u2014";
  const mean = Number.isFinite(stats.mean) ? stats.mean.toFixed(3) : "\u2014";
  return `PV:   ${pv} rad\nRMS:  ${rms} rad\nMean: ${mean} rad`;
}
```

- [ ] **Step 3: Rewrite deflectometry.js — buildWorkspace function (DOM construction)**

Add the `buildWorkspace()` function that creates the three-column layout inside `#mode-deflectometry`:

```js
function buildWorkspace() {
  if (df.built) return;
  df.built = true;

  const root = $("mode-deflectometry");
  if (!root) return;

  root.innerHTML = `
    <div class="defl-workspace">
      <!-- Left: preview + settings -->
      <div class="defl-preview-col">
        <img id="defl-preview" src="/stream" alt="Camera preview" />
        <div class="defl-badge-row">
          <span class="defl-badge" id="defl-badge-ipad">iPad: \u2014</span>
          <span class="defl-badge" id="defl-badge-flat">Flat field: \u2014</span>
          <span class="defl-badge" id="defl-badge-ref">Reference: \u2014</span>
          <span class="defl-badge" id="defl-badge-cal">Calibration: \u2014</span>
        </div>
        <div class="defl-setting-group">
          <label>Display device
            <select id="defl-display-device">
              <option value="0.0962">iPad Air 1 (264 ppi)</option>
              <option value="0.0962">iPad Air 2 (264 ppi)</option>
              <option value="0.0846">iPad Pro 11" (264 ppi)</option>
              <option value="0.0846">iPad Pro 12.9" (264 ppi)</option>
              <option value="custom">Custom\u2026</option>
            </select>
          </label>
          <label id="defl-custom-pitch-label" hidden>Pixel pitch (mm)
            <input type="number" id="defl-custom-pitch" min="0.01" max="1" step="0.001" value="0.096" />
          </label>
          <label>Fringe frequency (cycles)
            <input type="number" id="defl-freq" min="2" max="64" step="1" value="16" />
          </label>
          <label>Mask threshold
            <input type="range" id="defl-mask-thresh" min="0" max="20" step="1" value="2" style="width:100px" />
            <span id="defl-mask-thresh-val" style="min-width:28px;font-size:11px">2%</span>
          </label>
        </div>
      </div>

      <!-- Center: workflow steps -->
      <div class="defl-workflow-col">
        <div class="defl-workflow-title">Workflow</div>

        <div class="defl-step" id="defl-step-connect">
          <div class="defl-step-indicator" id="defl-ind-connect"></div>
          <div class="defl-step-body">
            <div class="defl-step-name">1. Connect iPad</div>
            <div class="defl-step-status" id="defl-status-connect">Waiting\u2026</div>
          </div>
        </div>

        <div class="defl-step disabled" id="defl-step-flat">
          <div class="defl-step-indicator" id="defl-ind-flat"></div>
          <div class="defl-step-body">
            <div class="defl-step-name">2. Flat Field</div>
            <div class="defl-step-status" id="defl-status-flat">\u2014</div>
            <div class="defl-step-controls">
              <button class="detect-btn" id="defl-btn-flat">Capture</button>
            </div>
          </div>
        </div>

        <div class="defl-step disabled" id="defl-step-ref">
          <div class="defl-step-indicator" id="defl-ind-ref"></div>
          <div class="defl-step-body">
            <div class="defl-step-name">3. Capture Reference</div>
            <div class="defl-step-status" id="defl-status-ref">Optional \u2014 flat mirror</div>
            <div class="defl-step-controls">
              <button class="detect-btn" id="defl-btn-ref">Capture</button>
            </div>
          </div>
        </div>

        <div class="defl-step disabled" id="defl-step-capture">
          <div class="defl-step-indicator" id="defl-ind-capture"></div>
          <div class="defl-step-body">
            <div class="defl-step-name">4. Capture Part</div>
            <div class="defl-step-status" id="defl-status-capture">\u2014</div>
            <div class="defl-step-controls">
              <button class="detect-btn" id="defl-btn-capture">Capture</button>
            </div>
          </div>
        </div>

        <div class="defl-step disabled" id="defl-step-compute">
          <div class="defl-step-indicator" id="defl-ind-compute"></div>
          <div class="defl-step-body">
            <div class="defl-step-name">5. Compute</div>
            <div class="defl-step-status" id="defl-status-compute">\u2014</div>
            <div class="defl-step-controls">
              <button class="detect-btn" id="defl-btn-compute">Compute</button>
            </div>
          </div>
        </div>

        <div class="defl-step disabled" id="defl-step-calibrate">
          <div class="defl-step-indicator" id="defl-ind-calibrate"></div>
          <div class="defl-step-body">
            <div class="defl-step-name">6. Calibrate</div>
            <div class="defl-step-status" id="defl-status-calibrate">Optional \u2014 sphere</div>
            <div class="defl-step-controls">
              <label style="font-size:12px">Sphere \u2300 (mm)
                <input type="number" id="defl-sphere-diam" min="0.1" max="500" step="0.1" value="25.0" style="width:65px" />
              </label>
              <button class="detect-btn" id="defl-btn-calibrate">Calibrate</button>
            </div>
          </div>
        </div>

        <div class="defl-workflow-footer">
          <button class="detect-btn" id="defl-btn-reset" style="width:100%">Reset Capture</button>
        </div>
      </div>

      <!-- Right: results -->
      <div class="defl-results-col">
        <div class="defl-tab-bar">
          <button class="defl-tab active" data-tab="phase">Phase Maps</button>
          <button class="defl-tab" data-tab="3d">3D Surface</button>
          <button class="defl-tab" data-tab="diag">Diagnostics</button>
        </div>

        <div class="defl-tab-panel" id="defl-panel-phase">
          <div class="defl-empty-state" id="defl-phase-empty">Complete the workflow to see results.</div>
          <div id="defl-phase-content" hidden>
            <div class="defl-phase-grid">
              <div>
                <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Phase X (vertical fringes)</div>
                <img id="defl-phase-x-img" />
                <pre id="defl-phase-x-stats">\u2014</pre>
              </div>
              <div>
                <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Phase Y (horizontal fringes)</div>
                <img id="defl-phase-y-img" />
                <pre id="defl-phase-y-stats">\u2014</pre>
              </div>
            </div>
          </div>
        </div>

        <div class="defl-tab-panel" id="defl-panel-3d" hidden>
          <div class="defl-empty-state" id="defl-3d-empty">Compute results first, then view the 3D surface.</div>
          <div id="defl-3d-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <div class="defl-3d-host" id="defl-3d-host"></div>
            <div class="defl-3d-controls" id="defl-3d-controls">
              <label style="font-size:12px">Z exaggeration:
                <input type="range" id="defl-3d-z-scale" min="1" max="200" step="1" value="10" style="width:120px" />
                <span id="defl-3d-z-val">10x</span>
              </label>
            </div>
          </div>
        </div>

        <div class="defl-tab-panel" id="defl-panel-diag" hidden>
          <div class="defl-empty-state" id="defl-diag-empty">Run diagnostics to see detailed frame analysis.</div>
          <div id="defl-diag-content" hidden>
            <pre id="defl-diag-framestats" style="margin:0 0 10px;padding:6px 8px;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:3px;font-size:11px;overflow-x:auto">\u2014</pre>
            <div class="defl-diag-grid">
              <div>
                <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Modulation X</div>
                <img id="defl-diag-mod-x" />
                <pre id="defl-diag-mod-x-stats">\u2014</pre>
              </div>
              <div>
                <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Modulation Y</div>
                <img id="defl-diag-mod-y" />
                <pre id="defl-diag-mod-y-stats">\u2014</pre>
              </div>
              <div>
                <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Wrapped phase X</div>
                <img id="defl-diag-wrap-x" />
              </div>
              <div>
                <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Wrapped phase Y</div>
                <img id="defl-diag-wrap-y" />
              </div>
              <div>
                <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Unwrapped X (before tilt removal)</div>
                <img id="defl-diag-unw-x" />
              </div>
              <div>
                <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Unwrapped Y (before tilt removal)</div>
                <img id="defl-diag-unw-y" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  wireEvents();
}
```

- [ ] **Step 4: Rewrite deflectometry.js — wireEvents and tab switching**

Add the event wiring function and tab switching:

```js
function wireEvents() {
  // Tab switching
  document.querySelectorAll(".defl-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".defl-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".defl-tab-panel").forEach(p => p.hidden = true);
      tab.classList.add("active");
      $("defl-panel-" + tab.dataset.tab).hidden = false;
    });
  });

  // Display device dropdown
  const deviceSel = $("defl-display-device");
  const customLabel = $("defl-custom-pitch-label");
  if (deviceSel && customLabel) {
    deviceSel.addEventListener("change", () => {
      customLabel.hidden = deviceSel.value !== "custom";
    });
  }

  // Mask threshold slider
  const maskSlider = $("defl-mask-thresh");
  const maskLabel = $("defl-mask-thresh-val");
  let _maskDebounce = null;
  if (maskSlider && maskLabel) {
    maskSlider.addEventListener("input", () => {
      maskLabel.textContent = maskSlider.value + "%";
      if (_maskDebounce) clearTimeout(_maskDebounce);
      _maskDebounce = setTimeout(() => {
        const content = $("defl-phase-content");
        if (content && !content.hidden) compute();
      }, 300);
    });
  }

  // Workflow buttons
  $("defl-btn-flat")?.addEventListener("click", flatField);
  $("defl-btn-ref")?.addEventListener("click", captureReference);
  $("defl-btn-capture")?.addEventListener("click", captureSequence);
  $("defl-btn-compute")?.addEventListener("click", compute);
  $("defl-btn-calibrate")?.addEventListener("click", calibrateSphere);
  $("defl-btn-reset")?.addEventListener("click", resetSession);
}
```

- [ ] **Step 5: Rewrite deflectometry.js — workflow action functions**

Add all the action functions. These are similar to the old dialog versions but update the step checklist instead of a progress line:

```js
function getFreq() {
  const el = $("defl-freq");
  let freq = parseInt(el ? el.value : "16", 10);
  if (!Number.isFinite(freq) || freq < 2) freq = 2;
  if (freq > 64) freq = 64;
  return freq;
}

function getMaskThreshold() {
  const el = $("defl-mask-thresh");
  return el ? parseInt(el.value, 10) / 100 : 0.02;
}

async function flatField() {
  const btn = $("defl-btn-flat");
  if (btn) btn.disabled = true;
  setStepStatus("flat", "", "Capturing\u2026");
  try {
    const r = await apiFetch("/deflectometry/flat-field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      setStepStatus("flat", "error", "Failed: " + msg);
      return;
    }
    setStepStatus("flat", "done", "Captured");
  } catch (e) {
    setStepStatus("flat", "error", "Failed: " + (e?.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function captureReference() {
  const btn = $("defl-btn-ref");
  if (btn) btn.disabled = true;
  setStepStatus("ref", "", "Capturing\u2026");
  try {
    const r = await apiFetch("/deflectometry/capture-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freq: getFreq() }),
    });
    if (!r.ok) {
      const msg = await r.text();
      setStepStatus("ref", "error", "Failed: " + msg);
      return;
    }
    setStepStatus("ref", "done", "Captured");
  } catch (e) {
    setStepStatus("ref", "error", "Failed: " + (e?.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function captureSequence() {
  const btn = $("defl-btn-capture");
  if (btn) btn.disabled = true;
  setStepStatus("capture", "", "Capturing 8 frames\u2026");
  try {
    const r = await apiFetch("/deflectometry/capture-sequence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freq: getFreq() }),
    });
    if (!r.ok) {
      const msg = await r.text();
      setStepStatus("capture", "error", "Failed: " + msg);
      return;
    }
    const data = await r.json();
    setStepStatus("capture", "done", data.captured_count + " frames");
  } catch (e) {
    setStepStatus("capture", "error", "Failed: " + (e?.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function compute() {
  const btn = $("defl-btn-compute");
  if (btn) btn.disabled = true;
  setStepStatus("compute", "", "Computing\u2026");
  try {
    const r = await apiFetch("/deflectometry/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mask_threshold: getMaskThreshold() }),
    });
    if (!r.ok) {
      const msg = await r.text();
      setStepStatus("compute", "error", "Failed: " + msg);
      return;
    }
    const result = await r.json();
    setStepStatus("compute", "done", "Done");
    renderPhaseResult(result);
  } catch (e) {
    setStepStatus("compute", "error", "Failed: " + (e?.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function calibrateSphere() {
  const ppm = state.calibration?.pixelsPerMm;
  if (!ppm || ppm <= 0) {
    setStepStatus("calibrate", "error", "Camera calibration (px/mm) required first");
    return;
  }
  const diamEl = $("defl-sphere-diam");
  let diam = parseFloat(diamEl ? diamEl.value : "25");
  if (!Number.isFinite(diam) || diam <= 0) {
    setStepStatus("calibrate", "error", "Enter a valid sphere diameter");
    return;
  }
  const btn = $("defl-btn-calibrate");
  if (btn) btn.disabled = true;
  setStepStatus("calibrate", "", "Calibrating\u2026");
  try {
    const r = await apiFetch("/deflectometry/calibrate-sphere", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sphere_diameter_mm: diam, px_per_mm: ppm }),
    });
    if (!r.ok) {
      const msg = await r.text();
      setStepStatus("calibrate", "error", "Failed: " + msg);
      return;
    }
    const data = await r.json();
    setStepStatus("calibrate", "done",
      data.cal_factor_um.toFixed(4) + " \u00b5m/rad, R=" + data.fitted_radius_mm.toFixed(1) + "mm");
    // Re-render phase results with calibrated units
    const status = await apiFetch("/deflectometry/status");
    if (status.ok) {
      const sd = await status.json();
      if (sd.last_result) renderPhaseResult(sd.last_result);
    }
  } catch (e) {
    setStepStatus("calibrate", "error", "Failed: " + (e?.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resetSession() {
  try {
    await apiFetch("/deflectometry/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch { /* ignore */ }
  setStepStatus("capture", "", "\u2014");
  setStepStatus("compute", "", "\u2014");
  // Hide results
  const content = $("defl-phase-content");
  const empty = $("defl-phase-empty");
  if (content) content.hidden = true;
  if (empty) empty.hidden = false;
  const content3d = $("defl-3d-content");
  const empty3d = $("defl-3d-empty");
  if (content3d) content3d.hidden = true;
  if (empty3d) empty3d.hidden = false;
}
```

- [ ] **Step 6: Rewrite deflectometry.js — result rendering and polling**

Add result rendering, status polling, and the 3D viewer:

```js
function renderPhaseResult(result) {
  if (!result) return;
  const content = $("defl-phase-content");
  const empty = $("defl-phase-empty");
  if (content) content.hidden = false;
  if (empty) empty.hidden = true;
  if (result.phase_x_png_b64) {
    $("defl-phase-x-img").src = "data:image/png;base64," + result.phase_x_png_b64;
  }
  if (result.phase_y_png_b64) {
    $("defl-phase-y-img").src = "data:image/png;base64," + result.phase_y_png_b64;
  }
  const cal = result.cal_factor || null;
  $("defl-phase-x-stats").textContent = formatStats(result.stats_x, cal);
  $("defl-phase-y-stats").textContent = formatStats(result.stats_y, cal);
}

async function refreshStatus() {
  try {
    const r = await apiFetch("/deflectometry/status");
    if (!r.ok) return;
    const d = await r.json();
    // iPad
    const connected = !!d.ipad_connected;
    setBadge("defl-badge-ipad", connected);
    $("defl-badge-ipad").textContent = "iPad: " + (connected ? "connected" : "\u2014");
    setStepStatus("connect", connected ? "done" : "", connected ? "Connected" : "Waiting\u2026");
    // Enable/disable steps based on iPad
    setStepEnabled("flat", connected);
    setStepEnabled("ref", connected);
    setStepEnabled("capture", connected);
    // Flat field
    setBadge("defl-badge-flat", !!d.has_flat_field);
    $("defl-badge-flat").textContent = "Flat field: " + (d.has_flat_field ? "\u2713" : "\u2014");
    // Reference
    setBadge("defl-badge-ref", !!d.has_reference);
    $("defl-badge-ref").textContent = "Reference: " + (d.has_reference ? "\u2713" : "\u2014");
    // Calibration
    const hasCal = d.cal_factor != null;
    setBadge("defl-badge-cal", hasCal);
    $("defl-badge-cal").textContent = "Calibration: " + (hasCal ? "\u2713" : "\u2014");
    // Compute step enable
    setStepEnabled("compute", d.captured_count >= 8);
    // Calibrate step enable
    setStepEnabled("calibrate", d.has_result);
    // Render last result if we have one and phase content is not showing
    if (d.last_result && $("defl-phase-content")?.hidden) {
      renderPhaseResult(d.last_result);
      setStepStatus("compute", "done", "Done");
    }
  } catch { /* ignore */ }
}

function startPolling() {
  stopPolling();
  // Immediately fire + start session
  apiFetch("/deflectometry/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => {});
  refreshStatus();
  df.polling = setInterval(refreshStatus, 1000);
}

function stopPolling() {
  if (df.polling) {
    clearInterval(df.polling);
    df.polling = null;
  }
}
```

- [ ] **Step 7: Rewrite deflectometry.js — 3D viewer (inline tab) and diagnostics**

Add the 3D viewer (embedded in the tab, not a modal) and diagnostics handler. The Three.js lazy-load pattern is the same as before but renders into the tab panel:

```js
async function load3dSurface() {
  const empty = $("defl-3d-empty");
  const content = $("defl-3d-content");
  if (empty) empty.textContent = "Loading 3D surface\u2026";
  try {
    const r = await apiFetch("/deflectometry/heightmap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mask_threshold: getMaskThreshold() }),
    });
    if (!r.ok) {
      if (empty) empty.textContent = "Failed to load heightmap.";
      return;
    }
    const hm = await r.json();
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
    await render3d(hm);
  } catch (e) {
    if (empty) empty.textContent = "Error: " + (e?.message || e);
  }
}

async function render3d(hm) {
  const host = $("defl-3d-host");
  if (!host) return;
  host.innerHTML = "";

  if (!df.threeLoaded) {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const { OrbitControls } = await import("https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js");
    df.THREE = THREE;
    df.OrbitControls = OrbitControls;
    df.threeLoaded = true;
  }
  const THREE = df.THREE;
  const OrbitControls = df.OrbitControls;

  const w = host.clientWidth || 600;
  const h = host.clientHeight || 400;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);

  const cols = hm.width, rows = hm.height;
  const geo = new THREE.PlaneGeometry(cols, rows, cols - 1, rows - 1);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  // Find min/max for normalization
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < hm.data.length; i++) {
    const v = hm.data[i];
    if (v != null) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
  }
  const zRange = zMax - zMin || 1;

  const zSlider = $("defl-3d-z-scale");
  const zLabel = $("defl-3d-z-val");
  let zScale = zSlider ? parseFloat(zSlider.value) : 10;

  function applyZ() {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const v = hm.data[idx];
        const z = (v != null) ? ((v - zMin) / zRange - 0.5) * zScale : 0;
        pos.setZ(idx, z);
        // Viridis-like color
        const t = (v != null) ? (v - zMin) / zRange : 0;
        colors[idx * 3] = t < 0.5 ? t * 1.2 : 0.3 + t * 0.4;
        colors[idx * 3 + 1] = 0.1 + t * 0.7;
        colors[idx * 3 + 2] = 0.4 + (1 - t) * 0.5;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  applyZ();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const light1 = new THREE.DirectionalLight(0xffffff, 1);
  light1.position.set(1, 1, 2);
  scene.add(light1);
  scene.add(new THREE.AmbientLight(0x404040));

  camera.position.set(0, -cols * 0.4, cols * 0.6);
  camera.lookAt(0, 0, 0);
  controls.update();

  if (zSlider) {
    zSlider.oninput = () => {
      zScale = parseFloat(zSlider.value);
      if (zLabel) zLabel.textContent = zScale + "x";
      applyZ();
    };
  }

  function animate() {
    if (!host.isConnected) return;
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Handle resize
  const ro = new ResizeObserver(() => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (nw > 0 && nh > 0) {
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
  });
  ro.observe(host);
}

async function runDiagnostics() {
  const empty = $("defl-diag-empty");
  const content = $("defl-diag-content");
  if (empty) empty.textContent = "Running diagnostics\u2026";
  try {
    const r = await apiFetch("/deflectometry/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      if (empty) empty.textContent = "Failed: " + msg;
      return;
    }
    const d = await r.json();
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
    // Frame stats
    const fs = $("defl-diag-framestats");
    if (fs && d.frame_stats) {
      fs.textContent = d.frame_stats.map(f =>
        `${f.name}  min=${f.min.toFixed(0)}  max=${f.max.toFixed(0)}  mean=${f.mean.toFixed(1)}  std=${f.std.toFixed(1)}`
      ).join("\n");
    }
    // Images
    const b64 = (id, key) => { const el = $(id); if (el && d[key]) el.src = "data:image/png;base64," + d[key]; };
    b64("defl-diag-mod-x", "modulation_x");
    b64("defl-diag-mod-y", "modulation_y");
    b64("defl-diag-wrap-x", "wrapped_x_png_b64");
    b64("defl-diag-wrap-y", "wrapped_y_png_b64");
    b64("defl-diag-unw-x", "unwrapped_raw_x_png_b64");
    b64("defl-diag-unw-y", "unwrapped_raw_y_png_b64");
    // Modulation stats
    const modStats = (id, key) => {
      const el = $(id);
      if (el && d[key]) {
        const m = d[key];
        el.textContent = `min=${m.min.toFixed(1)} max=${m.max.toFixed(1)} mean=${m.mean.toFixed(1)} median=${m.median.toFixed(1)}`;
      }
    };
    // modulation_x and modulation_y contain png_b64 + stats
    if (d.modulation_x) {
      $("defl-diag-mod-x").src = "data:image/png;base64," + d.modulation_x.png_b64;
      const el = $("defl-diag-mod-x-stats");
      if (el) el.textContent = `min=${d.modulation_x.min.toFixed(1)} max=${d.modulation_x.max.toFixed(1)} mean=${d.modulation_x.mean.toFixed(1)} median=${d.modulation_x.median.toFixed(1)}`;
    }
    if (d.modulation_y) {
      $("defl-diag-mod-y").src = "data:image/png;base64," + d.modulation_y.png_b64;
      const el = $("defl-diag-mod-y-stats");
      if (el) el.textContent = `min=${d.modulation_y.min.toFixed(1)} max=${d.modulation_y.max.toFixed(1)} mean=${d.modulation_y.mean.toFixed(1)} median=${d.modulation_y.median.toFixed(1)}`;
    }
  } catch (e) {
    if (empty) empty.textContent = "Error: " + (e?.message || e);
  }
}
```

- [ ] **Step 8: Rewrite deflectometry.js — tab activation triggers and export**

Add the tab activation handler that triggers 3D loading and diagnostics on first switch, plus the export function:

```js
function wireTabActivation() {
  document.querySelectorAll(".defl-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "3d" && $("defl-3d-content")?.hidden) {
        load3dSurface();
      }
      if (tab.dataset.tab === "diag" && $("defl-diag-content")?.hidden) {
        runDiagnostics();
      }
    });
  });
}

export function initDeflectometry() {
  // Build workspace DOM on first init
  buildWorkspace();
  wireTabActivation();

  // Start polling when mode becomes active, stop when hidden
  const observer = new MutationObserver(() => {
    const root = $("mode-deflectometry");
    if (!root) return;
    if (root.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });
  const root = $("mode-deflectometry");
  if (root) observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}
```

- [ ] **Step 9: Verify the full workspace**

Run: `./server.sh restart`

Open http://localhost:8000, switch to Deflectometry mode. Verify:
- Three-column layout renders correctly.
- Camera preview shows the live stream.
- Workflow steps show with proper enable/disable based on iPad connection.
- Status badges update via polling.
- Settings controls (frequency, mask, display device) work.
- All action buttons trigger the correct API calls.
- Tab switching works (Phase Maps, 3D Surface, Diagnostics).
- Switching back to Microscope mode restores full microscope UI.

- [ ] **Step 10: Commit**

```bash
git add frontend/deflectometry.js frontend/style.css
git commit -m "feat: full-window deflectometry workspace with workflow steps and tabbed results"
```

---

### Task 4: Clean Up Old Dialog Styles

**Files:**
- Modify: `frontend/style.css`

- [ ] **Step 1: Remove old deflectometry-3d modal CSS**

In `frontend/style.css`, find and remove the `deflectometry-3d-*` styles block (the fullscreen modal overlay, canvas host, close button, settings panel styles). These are replaced by the inline `.defl-3d-*` classes from Task 3.

Search for `deflectometry-3d` in `style.css` and remove all matching rules.

- [ ] **Step 2: Verify no visual regressions**

Open the app, switch between modes, verify the 3D viewer works inline in the tab.

- [ ] **Step 3: Commit**

```bash
git add frontend/style.css
git commit -m "chore: remove old deflectometry dialog modal styles"
```

---

### Task 5: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `.venv/bin/pytest tests/ -v`
Expected: all tests pass. The backend API endpoints are unchanged, so all existing tests should work.

- [ ] **Step 2: Manual smoke test**

1. Open http://localhost:8000
2. Verify Microscope mode works normally (all tools, sidebar, detect, overlay)
3. Switch to Deflectometry — workspace renders, steps show
4. Switch to Fringe Analysis — placeholder shows
5. Switch back to Microscope — everything restored
6. Open iPad page — centering circles display on connect
7. Settings and Help buttons visible in all modes (top-right)

- [ ] **Step 3: Commit if any final fixes needed**

```bash
git add -A
git commit -m "fix: address test/smoke-test issues from mode system"
```
