// toolbar.js — row-2 microscopy toolbar (Preact, rendered by shell.js).
// Flat wrapping row: every tool as icon+text (inline SVG, no emoji), active
// tool highlighted, contextual sub-mode segment, Calibrate/Origin plain
// buttons, Undo/Redo at the end. Replaces the floating #tool-strip, its
// flyouts and the floating sub-mode selector.
//
// Engine seam: buttons dispatch "set-tool" / "toolbar-action" CustomEvents;
// active state is read from `state` on every render (shell re-renders on
// "tool-changed" / "workspace-changed").

import { html } from './shell.js';
import { state } from './state.js';

function dispatch(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

// 16×16 stroke icons (stroke=currentColor set on the <svg> wrapper).
const ICONS = {
  select: '<path d="M4 2l7.5 6.5-3.7.7 2 4.2-1.7.8-2-4.2L4 12.6z"/>',
  pan: '<path d="M8 1.5v13M1.5 8h13M8 1.5L6.2 3.3M8 1.5l1.8 1.8M8 14.5l-1.8-1.8M8 14.5l1.8-1.8M1.5 8l1.8-1.8M1.5 8l1.8 1.8M14.5 8l-1.8-1.8M14.5 8l-1.8 1.8"/>',
  comment: '<path d="M2.5 3h11v7.5H7.5l-3 3v-3h-2z"/>',
  distance: '<path d="M3 13L13 3M3 13l2.6-.5M3 13l.5-2.6M13 3l-2.6.5M13 3l-.5 2.6"/>',
  angle: '<path d="M3 13h10M3 13L11.5 4M7.8 13a5 5 0 0 0-1.3-3.3"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  'arc-fit': '<path d="M2.5 13.5A11 11 0 0 1 13.5 2.5"/><circle cx="3.2" cy="9.5" r=".9"/><circle cx="7" cy="5.3" r=".9"/><circle cx="11.5" cy="3" r=".9"/>',
  'arc-measure': '<path d="M2.5 11.5a6.5 6.5 0 0 1 11 0M2.5 11.5l.4-2.2M13.5 11.5l-.4-2.2"/>',
  area: '<path d="M3 6.5L7 3l6 2-1 7-7 1z"/>',
  'area-shape': '<path d="M3 6.5L7 3l6 2-1 7-7 1z" stroke-dasharray="2.2 1.6"/>',
  spline: '<path d="M2 12.5C4.5 5 7.5 13 14 4"/><circle cx="2" cy="12.5" r=".9"/><circle cx="14" cy="4" r=".9"/>',
  'fit-line': '<path d="M2 8.5h12"/><circle cx="4.5" cy="6.8" r=".9"/><circle cx="8" cy="10" r=".9"/><circle cx="11.5" cy="7.2" r=".9"/>',
  point: '<circle cx="8" cy="8" r="1.3"/><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3"/>',
  calibrate: '<path d="M2 10.5h12M4 10.5V7.5M6.5 10.5v-2M9 10.5V7.5M11.5 10.5v-2M14 10.5V7.5"/>',
  origin: '<path d="M3.5 13V3M3.5 13h10M3.5 3L2 5M3.5 3l1.5 2M13.5 13l-2-1.5M13.5 13l-2 1.5"/>',
  undo: '<path d="M5 3.5L2.5 6.5 5 9.5M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7"/>',
  redo: '<path d="M11 3.5l2.5 3L11 9.5M13.5 6.5H6a3.5 3.5 0 0 0 0 7h3"/>',
};

function Icon({ name }) {
  return html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none"
    stroke="currentColor" stroke-width="1.4" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
    dangerouslySetInnerHTML=${{ __html: ICONS[name] ?? "" }} />`;
}

// Every tool, flat — no flyouts, no hidden tools (spec).
const TOOL_BUTTONS = [
  { tool: "select",      label: "Select",    key: "V" },
  { tool: "pan",         label: "Pan",       key: "H" },
  { tool: "comment",     label: "Note",      key: "T" },
  null,   // divider
  { tool: "distance",    label: "Distance",  key: "D" },
  { tool: "angle",       label: "Angle",     key: "A" },
  { tool: "circle",      label: "Circle",    key: "O" },
  { tool: "arc-fit",     label: "Best fit" },
  { tool: "arc-measure", label: "Arc" },
  { tool: "area",        label: "Area",      key: "R" },
  { tool: "area-shape",  label: "Shape" },
  { tool: "spline",      label: "Spline" },
  { tool: "fit-line",    label: "Flatness",  key: "L" },
  { tool: "point",       label: "Point",     key: "P" },
];

// Contextual sub-modes for the active tool (replaces the floating
// sub-mode selector; ≤2 options per tool so the row stays flat).
const SUB_MODES = {
  circle: {
    stateKey: "circleMode",
    options: [
      { label: "3-point",     value: "3-point" },
      { label: "Center+edge", value: "center-edge" },
    ],
  },
  "arc-fit": {
    stateKey: "arcFitMode",
    options: [
      { label: "Circle", value: "circle" },
      { label: "Arc",    value: "arc" },
    ],
  },
  "arc-measure": {
    stateKey: "arcMeasureMode",
    options: [
      { label: "Sequential", value: "sequential" },
      { label: "Ends first", value: "ends-first" },
    ],
  },
  angle: {
    stateKey: "angleMode",
    options: [
      { label: "Two lines",    value: "two-lines" },
      { label: "Three points", value: "three-points" },
    ],
  },
};

function ToolButton({ btn }) {
  const active = state.tool === btn.tool;
  const title = btn.key ? `${btn.label} (${btn.key})` : btn.label;
  return html`
    <button class="tb-btn ${active ? "active" : ""}" title=${title}
      onClick=${() => dispatch("set-tool", { tool: btn.tool })}>
      <${Icon} name=${btn.tool} /><span>${btn.label}</span>
    </button>`;
}

function SubModeSegment() {
  const group = SUB_MODES[state.tool];
  if (!group) return null;
  const current = state[group.stateKey];
  return html`
    <div class="tb-seg" role="group">
      ${group.options.map(opt => html`
        <button key=${opt.value}
          class="tb-seg-btn ${current === opt.value ? "active" : ""}"
          onClick=${() => dispatch("set-tool",
            { tool: state.tool, [group.stateKey]: opt.value })}>
          ${opt.label}
        </button>`)}
    </div>`;
}

export function Toolbar() {
  return html`
    ${TOOL_BUTTONS.map((btn, i) => btn === null
      ? html`<div key=${"div" + i} class="tb-divider"></div>`
      : html`<${ToolButton} key=${btn.tool} btn=${btn} />`)}
    <${SubModeSegment} />
    <div class="tb-divider"></div>
    <button class="tb-btn ${state.tool === "calibrate" ? "active" : ""}"
      title="Calibrate (C)" onClick=${() => dispatch("set-tool", { tool: "calibrate" })}>
      <${Icon} name="calibrate" /><span>Calibrate</span>
    </button>
    <button class="tb-btn ${state._originMode ? "active" : ""}" title="Set origin"
      onClick=${() => dispatch("toolbar-action", { action: "origin" })}>
      <${Icon} name="origin" /><span>Origin</span>
    </button>
    <div class="tb-divider"></div>
    <button class="tb-btn" title="Undo (Ctrl+Z)"
      onClick=${() => dispatch("toolbar-action", { action: "undo" })}>
      <${Icon} name="undo" /><span>Undo</span>
    </button>
    <button class="tb-btn" title="Redo (Ctrl+Y)"
      onClick=${() => dispatch("toolbar-action", { action: "redo" })}>
      <${Icon} name="redo" /><span>Redo</span>
    </button>`;
}
