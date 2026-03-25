import { state, pushUndo } from './state.js';
import { redraw } from './render.js';
import { renderSidebar, updateCameraInfo, updateCalibrationButton } from './sidebar.js';

// ── Annotations management ──────────────────────────────────────────────────────

function _cleanupAnnotation(ann) {
  if (ann.type === "calibration") { state.calibration = null; updateCalibrationButton(); }
  if (ann.type === "origin") {
    state.origin = null;
    const coordEl = document.getElementById("coord-display");
    if (coordEl) coordEl.textContent = "";
  }
  if (ann.type === "dxf-overlay") {
    const p = document.getElementById("dxf-panel"); if (p) p.style.display = "none";
  }
}

export function addAnnotation(data) {
  pushUndo();
  const ann = { ...data, id: state.nextId++, name: data.name ?? "" };
  state.annotations.push(ann);
  state.selected = new Set([ann.id]);
  renderSidebar();
}

export function deleteAnnotation(id) {
  pushUndo();
  const ann = state.annotations.find(a => a.id === id);
  if (!ann) return;
  _cleanupAnnotation(ann);
  state.annotations = state.annotations.filter(a => a.id !== id);
  state.selected.delete(id);
  if (state.pendingCenterCircle && state.pendingCenterCircle.id === id) state.pendingCenterCircle = null;
  renderSidebar();
  redraw();
}

export function deleteSelected() {
  if (state.selected.size === 0) return;
  pushUndo();
  for (const id of [...state.selected]) {
    const ann = state.annotations.find(a => a.id === id);
    if (ann) _cleanupAnnotation(ann);
    state.annotations = state.annotations.filter(a => a.id !== id);
  }
  state.selected = new Set();
  renderSidebar();
  redraw();
}

export function applyCalibration(ann) {
  pushUndo();
  // Remove any existing calibration annotation
  state.annotations = state.annotations.filter(a => a.type !== "calibration");
  // Compute pixelsPerMm
  let pixelDist;
  if (ann.x1 !== undefined) {
    pixelDist = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
  } else {
    pixelDist = ann.r * 2; // diameter
  }
  const knownMm = ann.unit === "µm" ? ann.knownValue / 1000 : ann.knownValue;
  state.calibration = { pixelsPerMm: pixelDist / knownMm, displayUnit: ann.unit };
  // Auto-update DXF scale if not manually overridden
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (dxfAnn && !dxfAnn.scaleManual) {
    dxfAnn.scale = state.calibration.pixelsPerMm;
    const dxfScaleEl = document.getElementById("dxf-scale");
    if (dxfScaleEl) dxfScaleEl.value = dxfAnn.scale.toFixed(3);
  }
  addAnnotation(ann);
  updateCameraInfo(); // refresh the scale display in the sidebar
  updateCalibrationButton();
}
