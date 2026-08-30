// frontend/measure-panel.js — the Measure panel: guided procedure while a tool
// is armed, properties inspector for the selection (Task 9), collapsed strip
// otherwise. Mirrors the Preact/htm pattern of toolbar.js.
import { h, render } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';
import { state } from './state.js';
import { PROCEDURES } from './procedures.js';
import { SUB_MODES } from './toolbar.js';

const html = htm.bind(h);
let _mount = null;

// Owned by the vnode, not the DOM: a resize drag calls setPanelWidth(), which
// re-renders. Preact only clears style props it previously wrote — if a
// mousemove handler wrote panel.style.width directly on the live DOM node
// instead, that inline width would out-rank the `.mp-collapsed` class rule
// forever (Preact's diff never sees it, since it appears in neither the old
// nor the new vnode). So the width lives here and is only ever emitted on
// the expanded-face roots below; the collapsed root gets no style prop at
// all, letting `.mp-panel.mp-collapsed { width: 26px }` always win.
let _panelWidth = 240;

export function setPanelWidth(px) {
  _panelWidth = Math.max(180, Math.min(420, px));
  renderMeasurePanel();
}

// True exactly when MeasurePanel() renders an expanded (non-collapsed) face —
// mirrors the face-selection conditions in MeasurePanel() below so the resize
// handle's visibility can never drift from what's actually rendered.
function _isExpandedFace() {
  const toolArmed = state.tool && state.tool !== 'select';
  const hasSelection = state.selected instanceof Set && state.selected.size > 0;
  return !state.measurePanelCollapsed && (toolArmed || hasSelection);
}

function dispatch(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

function Strip() {
  return html`<div class="mp-strip" onClick=${() => { state.measurePanelCollapsed = false; renderMeasurePanel(); }}>
    <span class="mp-strip-arrow">◂</span>
    <span class="mp-strip-label">MEASURE</span>
  </div>`;
}

function SubModeEcho({ tool }) {
  const group = SUB_MODES[tool];
  if (!group) return null;
  return html`<div class="mp-seg">
    ${group.options.map(opt => html`<button
      class="mp-seg-btn ${state[group.stateKey] === opt.value ? 'on' : ''}"
      onClick=${() => dispatch('set-tool', { tool, [group.stateKey]: opt.value })}
    >${opt.label}</button>`)}
  </div>`;
}

function ProcedureFace({ tool }) {
  const p = PROCEDURES[tool];
  if (!p) return html`<div class="mp-body">${tool}</div>`;
  const steps = p.steps(state);
  const cur = Math.min(p.currentStep(state), steps.length - 1);
  const live = p.liveLine ? p.liveLine(state) : null;
  const canFinish = p.finish && (state.pendingPoints || []).length >= p.finish.minPoints;
  return html`<div class="mp-body">
    <div class="mp-hdr">${p.title}
      <button class="mp-collapse" title="Collapse"
        onClick=${() => { state.measurePanelCollapsed = true; renderMeasurePanel(); }}>⌄</button>
    </div>
    <${SubModeEcho} tool=${tool} />
    ${steps.map((s, i) => html`<div class="mp-step ${i < cur ? 'mp-step-done' : i === cur ? 'mp-step-current' : 'mp-step-todo'}">
      <span class="mp-step-n">${i < cur ? '✓' : i + 1}</span><span>${s}</span>
    </div>`)}
    ${live ? html`<div class="mp-live">${live}</div>` : null}
    ${p.finish ? html`<div class="mp-btns">
      <button class="mp-btn mp-btn-pri" disabled=${!canFinish}
        onClick=${() => dispatch('measure-panel-action', { action: 'finish' })}>Finish ⏎</button>
      <button class="mp-btn"
        onClick=${() => dispatch('measure-panel-action', { action: 'cancel' })}>Cancel esc</button>
    </div>` : null}
  </div>`;
}

export function MeasurePanel() {
  const toolArmed = state.tool && state.tool !== 'select';
  const hasSelection = state.selected instanceof Set && state.selected.size > 0;
  if (toolArmed && !state.measurePanelCollapsed) {
    return html`<div class="mp-panel" style=${{ width: _panelWidth + 'px' }}><${ProcedureFace} tool=${state.tool} /></div>`;
  }
  if (!toolArmed && hasSelection && !state.measurePanelCollapsed) {
    // Properties face lands in Task 9; placeholder keeps the face-selection rule testable.
    return html`<div class="mp-panel" style=${{ width: _panelWidth + 'px' }}><div class="mp-body"><div class="mp-hdr">Properties</div><div>—</div></div></div>`;
  }
  return html`<div class="mp-panel mp-collapsed"><${Strip} /></div>`;
}

export function renderMeasurePanel() {
  if (!_mount) return;
  render(html`<${MeasurePanel} />`, _mount);
  // Hide the drag handle whenever the collapsed strip is showing — it must
  // not fight the collapsed strip for its leftmost 6px, and there's nothing
  // to resize while collapsed anyway. Null-guarded: absent in tests/other modes.
  const handle = document.getElementById('measure-panel-resize');
  if (handle) handle.style.display = _isExpandedFace() ? '' : 'none';
}

export function initMeasurePanel() {
  _mount = document.getElementById('measure-panel');
  if (!_mount) return;
  document.addEventListener('tool-changed', () => {
    // arming a tool or changing selection context re-opens a manually collapsed panel
    state.measurePanelCollapsed = false;
    renderMeasurePanel();
  });
  document.addEventListener('workspace-changed', renderMeasurePanel);
  renderMeasurePanel();
}
