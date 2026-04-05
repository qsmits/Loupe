// ── Sub-mode selector ────────────────────────────────────────────────────────
// Horizontal segmented control shown directly under (above) the main tool strip
// whenever a measure tool is active. Lets the user switch between sub-modes of
// the current top-level measure tool without reopening the Measure menu.
//
// Top-level groups are defined in tools.js (MEASURE_TOP_LEVEL). This module
// renders the active group's sub-modes as buttons and wires clicks back to
// setTool(). It also registers a sync hook so external setTool calls (keyboard
// shortcuts, dropdowns) keep the segmented control in sync.

import { state } from './state.js';
import { MEASURE_TOP_LEVEL, topLevelOfTool, setTool, registerSubModeSelectorSync } from './tools.js';
import { redraw } from './render.js';

let _container = null;

// Determine which sub-mode id within the current top-level group matches the
// current state.tool (+ state.circleMode where relevant).
function _activeSubModeId(group) {
  if (!group) return null;
  for (const sm of group.subModes) {
    if (sm.tool !== state.tool) continue;
    if (sm.circleMode && sm.circleMode !== state.circleMode) continue;
    if (sm.arcMeasureMode && sm.arcMeasureMode !== state.arcMeasureMode) continue;
    if (sm.arcFitMode && sm.arcFitMode !== state.arcFitMode) continue;
    if (sm.angleMode && sm.angleMode !== state.angleMode) continue;
    return sm.id;
  }
  // Fallback: first sub-mode whose underlying tool matches.
  const first = group.subModes.find(sm => sm.tool === state.tool);
  return first ? first.id : null;
}

function _render() {
  if (!_container) return;
  const topKey = state._topLevelTool ?? topLevelOfTool(state.tool);
  const group = topKey ? MEASURE_TOP_LEVEL[topKey] : null;
  if (!group) {
    _container.hidden = true;
    _container.innerHTML = "";
    return;
  }
  _container.hidden = false;

  // Build segmented control: group label on the left, then sub-mode buttons.
  // We rebuild fully on each sync — simpler and cheap (small DOM).
  const activeId = _activeSubModeId(group);
  const frag = document.createDocumentFragment();

  const label = document.createElement("span");
  label.className = "sub-mode-label";
  label.textContent = group.label;
  frag.appendChild(label);

  const seg = document.createElement("div");
  seg.className = "sub-mode-segmented";
  for (const sm of group.subModes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sub-mode-btn";
    btn.textContent = sm.label;
    btn.dataset.subMode = sm.id;
    if (sm.id === activeId) btn.classList.add("active");
    btn.addEventListener("click", () => _onSubModeClick(topKey, sm));
    seg.appendChild(btn);
  }
  frag.appendChild(seg);

  _container.replaceChildren(frag);
}

function _onSubModeClick(topKey, sm) {
  // Set the circle sub-mode (3-point vs center-edge) before switching tool so
  // the tool handler sees the right mode on first click.
  if (sm.circleMode) {
    state.circleMode = sm.circleMode;
    state.pendingPoints = [];
  }
  if (sm.angleMode) {
    state.angleMode = sm.angleMode;
  }
  if (sm.arcFitMode) {
    state.arcFitMode = sm.arcFitMode;
  }
  if (sm.arcMeasureMode) {
    state.arcMeasureMode = sm.arcMeasureMode;
    state.pendingPoints = [];
    // Keep the legacy point-order buttons in sync (they still exist in the DOM
    // for the moment; the old options bar is now hidden for arc-measure).
    document.getElementById("btn-arc-order-sequential")?.classList.toggle("active", sm.arcMeasureMode === "sequential");
    document.getElementById("btn-arc-order-ends-first")?.classList.toggle("active", sm.arcMeasureMode === "ends-first");
  }
  // Angle sub-modes both map to the "angle" tool; selecting them is a pure UI
  // hint — the underlying tool chooses two-lines vs three-points based on the
  // first click target. We still force the tool state so the status text and
  // top-level tracking stay correct.
  if (state.tool !== sm.tool) {
    setTool(sm.tool);
  } else {
    // Already on the correct tool (e.g. switching between angle sub-modes, or
    // toggling circleMode without changing the tool). Re-render the selector
    // and redraw the canvas so the change is visible.
    state._topLevelTool = topKey;
    _render();
    redraw();
  }
}

export function initSubModeSelector(containerId = "sub-mode-selector") {
  _container = document.getElementById(containerId);
  if (!_container) return;
  registerSubModeSelectorSync(_render);
  _render();
}
