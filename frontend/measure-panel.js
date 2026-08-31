// frontend/measure-panel.js — the Measure panel: guided procedure while a tool
// is armed, properties inspector for the selection (Task 9), collapsed strip
// otherwise. Mirrors the Preact/htm pattern of toolbar.js.
import { h, render } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';
import { state, pushUndo } from './state.js';
import { PROCEDURES } from './procedures.js';
import { SUB_MODES } from './toolbar.js';
import { measurementLabel, measurementNumeric } from './format.js';
import { evaluateSpec, formatDeviation } from './spec.js';
import { annotationNumbers } from './numbering.js';

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

// Context object for format.js/measurementNumeric — mirrors sidebar.js's _mctx
// but the properties face never needs imageWidth/imageHeight (no
// detected-* types reach a selectable measurement's properties face).
function _mctx() {
  return { calibration: state.calibration, annotations: state.annotations, origin: state.origin };
}

// One tolerance input (nominal/upper/lower). Values are STORED on ann.spec in
// the measurement's base unit (mm) — the input displays/accepts the active
// display unit (µm ×1000); toMm/fromMm are the only place that conversion
// happens. Mirrors sidebar.js's rename undo-session pattern (~lines 137-150):
// pushUndo() once per focus→blur session, on the first keystroke, snapshotting
// state BEFORE the edit. `undoPushed` lives in this call's closure, which
// survives the whole session because renderMeasurePanel() is only invoked on
// blur, not on every keystroke.
function SpecField({ ann, field, label }) {
  const cal = state.calibration;
  const toMm = v => (cal && cal.displayUnit === 'µm' ? v / 1000 : v);
  const fromMm = v => (cal && cal.displayUnit === 'µm' ? v * 1000 : v);
  const unit = measurementNumeric(ann, _mctx())?.unit ?? (cal ? 'mm' : 'px');
  const displayUnit = unit === 'mm' && cal?.displayUnit === 'µm' ? 'µm' : unit;
  const raw = ann.spec?.[field];
  let undoPushed = false;
  return html`<div class="mp-fld">
    <label>${label}</label>
    <input class="mp-in" type="number" step="any"
      value=${raw != null ? String(fromMm(raw)) : ''}
      onFocus=${() => { undoPushed = false; }}
      onInput=${e => {
        if (!undoPushed) { pushUndo(); undoPushed = true; }
        const v = e.target.value.trim();
        if (field === 'nominal' && v === '') { delete ann.spec; }
        else {
          if (!ann.spec) ann.spec = { nominal: NaN, upper: 0, lower: 0 };
          ann.spec[field] = toMm(parseFloat(v));
        }
      }}
      onBlur=${() => { renderMeasurePanel(); dispatch('annotations-changed'); }}
    /><span>${displayUnit}</span>
  </div>`;
}

// One radio option within a center-dist's Pattern/Direction section. `def` is
// the value treated as "absent" — clicking it deletes ann[field] rather than
// writing the default explicitly, so old sessions/exports stay minimal.
function RadioRow({ ann, field, value, label, def }) {
  const on = (ann[field] ?? def) === value;
  return html`<div class="mp-radio ${on ? 'on' : ''}" onClick=${() => {
    pushUndo();
    if (value === def) delete ann[field]; else ann[field] = value;
    dispatch('annotations-changed');
    renderMeasurePanel();
  }}><span class="mp-dot"></span>${label}</div>`;
}

// Properties face: name/value/tolerance editing for a single selected
// measurement. Multi-select collapses to a bare count (bulk actions live on
// the sidebar rows, not here) — see the brief's interface note.
function PropertiesFace() {
  const ids = [...state.selected];
  if (ids.length > 1) {
    // Single JS string, not an htm interpolation split across literal text —
    // htm treats `${x} selected` as two separate children (a number leaf and
    // a ' selected' leaf), which textOf() then joins with an extra space.
    const countLabel = `${ids.length} selected`;
    return html`<div class="mp-body"><div class="mp-hdr">${countLabel}</div>
    <div class="mp-live">Bulk actions: Delete removes all, the eye toggles visibility per row.</div></div>`;
  }
  const ann = state.annotations.find(a => a.id === ids[0]);
  if (!ann) return html`<div class="mp-body">—</div>`;
  const ctx = _mctx();
  const num = annotationNumbers(state.annotations, state.measurementGroups).get(ann.id);
  const numLabel = "[" + (num ?? '–') + "]";  // same single-string pattern as sidebar.js's row numbers
  const n = measurementNumeric(ann, ctx);
  const ev = ann.spec ? evaluateSpec(n?.value, ann.spec) : null;
  return html`<div class="mp-body">
    <div class="mp-hdr">${numLabel}
      <input class="mp-name" placeholder="Label…" value=${ann.name || ''}
        onChange=${e => { pushUndo(); ann.name = e.target.value; dispatch('annotations-changed'); }} />
      <button class="mp-collapse" onClick=${() => { state.measurePanelCollapsed = true; renderMeasurePanel(); }}>⌄</button>
    </div>
    <div class="mp-value">${measurementLabel(ann, ctx)}
      ${ev ? html`<span class="spec-chip ${ev.pass ? 'pass' : 'fail'}">${ev.pass ? 'PASS' : 'FAIL'}</span>` : null}
    </div>
    ${ann.type === 'center-dist' ? html`
      <div class="mp-sect"><div class="mp-sect-t">Pattern</div>
        <${RadioRow} ann=${ann} field="pattern" value="centers" def="centers" label="Between centers" />
        <${RadioRow} ann=${ann} field="pattern" value="min" def="centers" label="Minimum gap" />
        <${RadioRow} ann=${ann} field="pattern" value="max" def="centers" label="Maximum span" />
      </div>
      ${state.origin ? html`<div class="mp-sect"><div class="mp-sect-t">Direction</div>
        <${RadioRow} ann=${ann} field="direction" value="line" def="line" label="Direct line" />
        <${RadioRow} ann=${ann} field="direction" value="x" def="line" label="X · reference axis" />
        <${RadioRow} ann=${ann} field="direction" value="y" def="line" label="Y · reference axis" />
      </div>` : null}
    ` : null}
    <div class="mp-sect"><div class="mp-sect-t">Tolerance</div>
      <${SpecField} ann=${ann} field="nominal" label="Nominal" />
      <${SpecField} ann=${ann} field="upper" label="Upper" />
      <${SpecField} ann=${ann} field="lower" label="Lower" />
      ${ev ? html`<div class="mp-dev">Deviation <b class=${ev.pass ? 'dev-pass' : 'dev-fail'}>${formatDeviation(ev.deviation, n.unit, state.calibration?.displayUnit)}</b></div>` : null}
    </div>
  </div>`;
}

export function MeasurePanel() {
  const toolArmed = state.tool && state.tool !== 'select';
  const hasSelection = state.selected instanceof Set && state.selected.size > 0;
  if (toolArmed && !state.measurePanelCollapsed) {
    return html`<div class="mp-panel" style=${{ width: _panelWidth + 'px' }}><${ProcedureFace} tool=${state.tool} /></div>`;
  }
  if (!toolArmed && hasSelection && !state.measurePanelCollapsed) {
    return html`<div class="mp-panel" style=${{ width: _panelWidth + 'px' }}><${PropertiesFace} /></div>`;
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
