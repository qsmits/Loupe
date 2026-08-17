import { state, pushUndo, DETECTION_TYPES, OVERLAY_TYPES, pruneOrphanGroupEntries } from './state.js';
import { cascadeDeleteConstraints } from './constraints.js';
import { canvas, showStatus, redraw } from './render.js';
import { renderSidebar, updateCameraInfo, updateCalibrationButton, renderInspectionTable } from './sidebar.js';
import { calibrationPixelsPerMm, measurementPixelSpan, parseAreaInput,
         parseDistanceInput, calibrationPpmFromMeasurement } from './math.js';
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

export function addAnnotation(data, { skipUndo = false } = {}) {
  // skipUndo: for callers (applyCalibration) that already took a snapshot
  // BEFORE their own mutations — a second push here would create an extra
  // undo step whose snapshot captures an inconsistent intermediate state.
  if (!skipUndo) pushUndo();
  const ann = { ...data, id: state.nextId++, name: data.name ?? "", purpose: data.purpose ?? "measurement" };
  state.annotations.push(ann);
  state.selected = new Set([ann.id]);
  renderSidebar();
}

export function deleteAnnotation(id) {
  const ann = state.annotations.find(a => a.id === id);
  if (!ann) return;  // checked BEFORE pushUndo so a missing id leaves no phantom undo step
  pushUndo();
  _cleanupAnnotation(ann);
  state.annotations = state.annotations.filter(a => a.id !== id);
  cascadeDeleteConstraints(id);
  pruneOrphanGroupEntries();
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
  pruneOrphanGroupEntries();
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
  // Carry group membership over to the new id (avoids an orphaned entry)
  if (state.measurementGroups[id] !== undefined) {
    state.measurementGroups[elevated.id] = state.measurementGroups[id];
    delete state.measurementGroups[id];
  }
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
  pruneOrphanGroupEntries();
  state.selected = new Set([merged.id]);

  renderSidebar();
  redraw();
  showStatus(`Merged ${lineAnns.length} lines into one measurement`);
}

// ── Clear operations ─────────────────────────────────────────────────────────
// OVERLAY_TYPES (edges/preprocessed live-image overlays) comes from state.js —
// the same set gates undo-snapshot exclusion there.

export function clearDetections() {
  pushUndo();
  state.annotations = state.annotations.filter(a =>
    !DETECTION_TYPES.has(a.type) && !OVERLAY_TYPES.has(a.type)
  );
  pruneOrphanGroupEntries();
  state.selected = new Set();
  renderSidebar();
  redraw();
  showStatus("Cleared detections");
}

export function clearMeasurements() {
  pushUndo();
  const KEEP = new Set([...DETECTION_TYPES, ...OVERLAY_TYPES, "calibration", "origin", "dxf-overlay", "comment"]);
  state.annotations = state.annotations.filter(a => KEEP.has(a.type));
  pruneOrphanGroupEntries();
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
  pruneOrphanGroupEntries();
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

// Recompute state.calibration (and everything that mirrors it) from a
// calibration annotation's CURRENT geometry + knownValue/unit. Shared by
// applyCalibration and the calibration drag path in tools.js handleDrag —
// without this, dragging a calibration endpoint changed the drawn reference
// while the stored scale silently stayed stale.
// Returns false (and changes nothing) for degenerate geometry, e.g. both
// endpoints dragged onto each other mid-drag.
export function recalibrateFromAnnotation(ann) {
  const ppm = calibrationPixelsPerMm(ann);
  if (ppm == null) return false;
  state.calibration = { pixelsPerMm: ppm, displayUnit: ann.unit };
  // Auto-update DXF scale if not manually overridden
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (dxfAnn && !dxfAnn.scaleManual) {
    dxfAnn.scale = state.calibration.pixelsPerMm;
    const dxfScaleEl = document.getElementById("dxf-scale");
    if (dxfScaleEl) dxfScaleEl.value = dxfAnn.scale.toFixed(3);
  }
  updateCameraInfo(); // refresh the scale display in the sidebar
  updateCalibrationButton();
  document.dispatchEvent(new CustomEvent("dxf-state-changed"));
  return true;
}

export function applyCalibration(ann) {
  // Validate before the undo snapshot so a rejected calibration leaves no
  // phantom undo step.
  if (calibrationPixelsPerMm(ann) == null) {
    showStatus("Calibration rejected — zero length or zero known value");
    return;
  }
  // Single snapshot, taken BEFORE any mutation. addAnnotation below runs
  // with skipUndo so it does not push a second, inconsistent snapshot
  // (new calibration but no calibration annotation yet).
  pushUndo();
  // Remove any existing calibration annotation
  state.annotations = state.annotations.filter(a => a.type !== "calibration");
  recalibrateFromAnnotation(ann);
  addAnnotation(ann, { skipUndo: true });
}

const _CAL_PROMPTS = {
  length:   "Known length of this measurement (e.g. '1.5 mm' or '500 µm'):",
  diameter: "Known diameter of this circle (e.g. '5.000 mm' or '200 µm'):",
  area:     "Known area of this shape (e.g. '25 mm²' or '4000 µm²'):",
};

/** Calibrate from an existing measurement of known true size.
 *
 * No calibration annotation is added — the measurement itself is the visual
 * record of what was calibrated on, mirroring the elevate-then-calibrate
 * branch in tools.js. Exactly one annotation carries calSource at a time.
 *
 * @param {object} ann
 * @returns {boolean} true when the calibration was applied
 */
export function calibrateFromMeasurement(ann) {
  const measured = measurementPixelSpan(ann);
  if (!measured) return false;
  const entered = prompt(_CAL_PROMPTS[measured.kind]);
  if (entered === null) return false;                     // cancelled
  const parsed = measured.kind === "area"
    ? parseAreaInput(entered)
    : parseDistanceInput(entered);                        // alerts on bad input
  if (!parsed) {
    if (measured.kind === "area") {
      showStatus("Could not parse area — use a format like '25 mm²' or '4000 µm²'");
    }
    return false;
  }
  const knownMm = measured.kind === "area" ? parsed.mm2 : parsed.mm;
  const ppm = calibrationPpmFromMeasurement(measured.span, measured.kind, knownMm);
  if (ppm == null) {
    showStatus("Calibration rejected — zero length or zero known value");
    return false;
  }
  // One undoable step: a calibration change rewrites every displayed value.
  pushUndo();
  state.annotations = state.annotations.filter(a => a.type !== "calibration");
  for (const a of state.annotations) delete a.calSource;
  state.calibration = { pixelsPerMm: ppm, displayUnit: parsed.unit };
  ann.calSource = true;
  // Keep a non-manual DXF overlay in step, exactly as recalibrateFromAnnotation does.
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (dxfAnn && !dxfAnn.scaleManual) {
    dxfAnn.scale = state.calibration.pixelsPerMm;
    const dxfScaleEl = document.getElementById("dxf-scale");
    if (dxfScaleEl) dxfScaleEl.value = dxfAnn.scale.toFixed(3);
  }
  updateCameraInfo();
  updateCalibrationButton();
  document.dispatchEvent(new CustomEvent("dxf-state-changed"));
  renderSidebar();
  redraw();
  showStatus(`Calibration set from measurement — ${(1000 / ppm).toFixed(3)} µm/px`);
  return true;
}
