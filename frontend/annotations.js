import { state, pushUndo, DETECTION_TYPES } from './state.js';
import { cascadeDeleteConstraints } from './constraints.js';
import { canvas, showStatus, redraw } from './render.js';
import { renderSidebar, updateCameraInfo, updateCalibrationButton, renderInspectionTable } from './sidebar.js';
import { imageWidth, imageHeight } from './viewport.js';

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
  cascadeDeleteConstraints(id);
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
    cascadeDeleteConstraints(id);
    state.annotations = state.annotations.filter(a => a.id !== id);
  }
  state.selected = new Set();
  renderSidebar();
  redraw();
}

// ── Detection → Measurement elevation ────────────────────────────────────────

export function isDetection(ann) {
  return DETECTION_TYPES.has(ann.type);
}

export function elevateAnnotation(id) {
  const ann = state.annotations.find(a => a.id === id);
  if (!ann || !isDetection(ann)) return null;

  const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
  const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;

  let elevated;

  if (ann.type === "detected-line" || ann.type === "detected-line-merged") {
    elevated = {
      type: "distance",
      a: { x: ann.x1 * sx, y: ann.y1 * sy },
      b: { x: ann.x2 * sx, y: ann.y2 * sy },
    };
  } else if (ann.type === "detected-circle") {
    elevated = {
      type: "circle",
      cx: ann.x * sx,
      cy: ann.y * sy,
      r: ann.radius * sx,
    };
  } else if (ann.type === "detected-arc-partial") {
    const cx = ann.cx * sx, cy = ann.cy * sy, r = ann.r * sx;
    const startRad = ann.start_deg * Math.PI / 180;
    const endRad = ann.end_deg * Math.PI / 180;
    // Handle wrapping: if arc crosses 0°, simple average gives wrong midpoint
    let midDeg = (ann.start_deg + ann.end_deg) / 2;
    if (ann.end_deg < ann.start_deg) midDeg += 180;
    const midRad = midDeg * Math.PI / 180;
    const p1 = { x: cx + r * Math.cos(startRad), y: cy + r * Math.sin(startRad) };
    const p2 = { x: cx + r * Math.cos(midRad), y: cy + r * Math.sin(midRad) };
    const p3 = { x: cx + r * Math.cos(endRad), y: cy + r * Math.sin(endRad) };
    let spanDeg = ann.end_deg - ann.start_deg;
    if (spanDeg < 0) spanDeg += 360;
    const chordPx = Math.hypot(p3.x - p1.x, p3.y - p1.y);
    elevated = {
      type: "arc-measure",
      cx, cy, r, p1, p2, p3,
      span_deg: spanDeg,
      chord_px: chordPx,
    };
  }

  if (!elevated) return null;

  // Remove original detection
  state.annotations = state.annotations.filter(a => a.id !== id);
  state.selected.delete(id);

  // Add as new measurement
  elevated.id = state.nextId++;
  elevated.name = "";
  state.annotations.push(elevated);
  return elevated.id;
}

export function elevateSelected() {
  const toElevate = [...state.selected].filter(id => {
    const ann = state.annotations.find(a => a.id === id);
    return ann && isDetection(ann);
  });
  if (toElevate.length === 0) {
    showStatus("No detections selected to elevate");
    return;
  }

  pushUndo();
  const newIds = [];
  for (const id of toElevate) {
    const newId = elevateAnnotation(id);
    if (newId != null) newIds.push(newId);
  }
  state.selected = new Set(newIds);
  renderSidebar();
  redraw();
  showStatus(`Elevated ${newIds.length} detection${newIds.length > 1 ? "s" : ""} to measurement${newIds.length > 1 ? "s" : ""}`);
}

// ── Merge selected lines ─────────────────────────────────────────────────────

const LINE_TYPES = new Set(["detected-line", "detected-line-merged", "distance"]);

export function mergeSelectedLines() {
  // Collect all selected line-type annotations
  const lineAnns = [...state.selected]
    .map(id => state.annotations.find(a => a.id === id))
    .filter(a => a && LINE_TYPES.has(a.type));

  if (lineAnns.length < 2) {
    showStatus("Select 2+ lines to merge");
    return;
  }

  pushUndo();

  // Collect all endpoints in image-space
  const points = [];
  for (const ann of lineAnns) {
    if (ann.type === "distance") {
      points.push(ann.a, ann.b);
    } else {
      // detected-line or detected-line-merged: scale from frame to image space
      const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
      const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
      points.push({ x: ann.x1 * sx, y: ann.y1 * sy });
      points.push({ x: ann.x2 * sx, y: ann.y2 * sy });
    }
  }

  // Fit a single line through all points (eigenvector method)
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(theta), dy = Math.sin(theta);

  // Project all points onto the line direction to find extent
  let tMin = Infinity, tMax = -Infinity;
  for (const p of points) {
    const t = (p.x - cx) * dx + (p.y - cy) * dy;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }

  // Create merged distance annotation
  const merged = {
    type: "distance",
    id: state.nextId++,
    name: "",
    a: { x: cx + tMin * dx, y: cy + tMin * dy },
    b: { x: cx + tMax * dx, y: cy + tMax * dy },
  };

  // Remove the original lines
  const removeIds = new Set(lineAnns.map(a => a.id));
  state.annotations = state.annotations.filter(a => !removeIds.has(a.id));
  state.annotations.push(merged);
  state.selected = new Set([merged.id]);

  renderSidebar();
  redraw();
  showStatus(`Merged ${lineAnns.length} lines into one measurement`);
}

// ── Clear operations ─────────────────────────────────────────────────────────

const OVERLAY_TYPES = new Set(["edges-overlay", "preprocessed-overlay"]);

export function clearDetections() {
  pushUndo();
  state.annotations = state.annotations.filter(a =>
    !DETECTION_TYPES.has(a.type) && !OVERLAY_TYPES.has(a.type)
  );
  state.selected = new Set();
  renderSidebar();
  redraw();
  showStatus("Cleared detections");
}

export function clearMeasurements() {
  pushUndo();
  const KEEP = new Set([...DETECTION_TYPES, ...OVERLAY_TYPES, "calibration", "origin", "dxf-overlay", "comment"]);
  state.annotations = state.annotations.filter(a => KEEP.has(a.type));
  state.selected = new Set();
  renderSidebar();
  redraw();
  showStatus("Cleared measurements");
}

export function clearDxfOverlay() {
  pushUndo();
  state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
  state.inspectionResults = [];
  state.inspectionFrame = null;
  state.dxfFilename = null;
  state._templateLoaded = false;
  state._templateName = null;
  state.featureModes = {};
  state.featureNames = {};
  const p = document.getElementById("dxf-panel");
  if (p) p.style.display = "none";
  state.selected = new Set();
  renderSidebar();
  renderInspectionTable();
  redraw();
  document.dispatchEvent(new CustomEvent("dxf-state-changed"));
  showStatus("Cleared DXF overlay");
}

export function clearAll() {
  if (!confirm("Clear all annotations? Calibration and origin will be preserved.")) return;
  pushUndo();
  state.annotations = state.annotations.filter(a =>
    a.type === "calibration" || a.type === "origin"
  );
  state.inspectionResults = [];
  state.inspectionFrame = null;
  state.dxfFilename = null;
  state.featureModes = {};
  state.featureNames = {};
  const p = document.getElementById("dxf-panel");
  if (p) p.style.display = "none";
  state.selected = new Set();
  renderSidebar();
  renderInspectionTable();
  redraw();
  showStatus("Cleared all annotations");
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
  document.dispatchEvent(new CustomEvent("dxf-state-changed"));
}
