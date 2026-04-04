// ── State ──────────────────────────────────────────────────────────────────
export const state = {
  tool: "select",
  frozen: false,
  frozenBackground: null,   // HTMLImageElement set by doFreeze()
  frozenSize: null,          // { w, h } set by doFreeze()
  crosshair: false,
  showGrid: false,
  showGradientOverlay: false,
  _gradientOverlayImg: null,
  calibration: null,
  annotations: [],
  selected: new Set(),  // Set of annotation IDs; do NOT include in JSON.stringify
  pendingPoints: [],
  pendingCenterCircle: null,
  pendingRefLine: null,
  pendingCircleRef: null,
  origin: null,
  dragState: null,
  snapTarget: null,
  mousePos: { x: 0, y: 0 },
  dxfAlignMode: false,
  dxfAlignStep: 0,
  dxfAlignPick: null,
  dxfAlignHover: null,
  dxfDragMode: false,
  dxfDragOrigin: null,  // { mouseX, mouseY, annOffsetX, annOffsetY }
  showDeviations: false,
  tolerances: { warn: 0.10, fail: 0.25 },
  featureTolerances: {},
  featureModes: {},        // { [handle]: "punch" | "die" } — default is "die"
  inspectionResults: [],   // populated by "Run inspection"; persisted in session v2
  inspectionFrame: null,   // base64 JPEG of composited camera+overlay at inspection time
  dxfFilename: null,       // set from DXF filename on load; cleared on DXF clear
  featureNames: {},              // { [handle_or_parent]: "user name" }
  measurementGroups: {},         // { [annotationId]: "group name" }
  inspectionHoverHandle: null,   // handle being hovered in table or canvas
  inspectionPickTarget: null,   // DXF entity being manually measured (point-pick mode)
  inspectionPickPoints: [],     // [{x, y}, ...] placed by user
  inspectionPickFit: null,      // live fit result (client-side)
  nextId: 1,
  settings: {
    crosshairColor: "#ffffff",
    crosshairOpacity: 0.4,
    pixelFormat: "BayerRG8",
    subpixelMethod: "parabola",
    subpixelSearchRadius: 10,
  },
  _originMode: false,       // was let _originMode (line 2539 in app.js)
  _dxfOriginMode: false,    // was let _dxfOriginMode (line 2547)
  _selectRect: null,
  _panStart: null,
  _flashExpiry: 0,
  _labelDrag: null,         // { handle, startX, startY, origDx, origDy }
  _templateLoaded: false,
  _templateName: null,
  _subpixelSnapTarget: null, // { x, y } — live preview of where sub-pixel snap would place a point
  lensK1: 0,                 // radial distortion coefficient (applied in-place to frozenBackground)
  arcMeasureMode: "sequential", // "sequential" | "ends-first"
  circleMode: "3-point",       // "3-point" | "center-edge"
  surfaceMode: "edm",          // "edm" | "lathe" | "print"
  _noCamera: false,         // was let _noCamera (line 36)
  _dirty: false,
  _savedManually: true,
};

export const undoStack = [];
export const redoStack = [];
export const UNDO_LIMIT = 50;

export const _deviationHitBoxes = [];  // populated by drawDeviations, read by main.js
export const _labelHitBoxes = [];     // populated by drawGuidedResults, used for drag + tooltip

export function takeSnapshot() {
  return JSON.stringify({
    annotations: state.annotations,
    calibration: state.calibration,
    origin: state.origin,
  });
}

export function pushUndo() {
  if (undoStack.length >= UNDO_LIMIT) undoStack.shift();
  undoStack.push(takeSnapshot());
  redoStack.length = 0;
  state._dirty = true;
  state._savedManually = false;
}

// ── TOOL_STATUS ─────────────────────────────────────────────────────────────
export const TOOL_STATUS = {
  "select":         "Select",
  "calibrate":      "Click — place two points or select a circle",
  "distance":       "Click — place point 1",
  "angle":          "Click — place point 1",
  "circle":         "Click — place point 1 (3-point mode)",
  "arc-fit":        "Click — place points (double-click to confirm)",
  "center-dist":    "Click — select a circle",
  "detect":         "Click — detect features",
  "perp-dist":      "Click — select a reference line",
  "para-dist":      "Click — select a reference line",
  "area":           "Click — place points (double-click to confirm)",
  "pt-circle-dist": "Click — select a circle to measure from",
  "intersect":      "Click — select a reference line",
  "slot-dist":      "Click — select a reference line",
  "arc-measure":    "Click — place 3 points on arc (double-click or 3rd click to confirm)",
  "spline":         "Click — place anchor points (double-click or Enter to finish)",
};

// ── TRANSIENT_TYPES (moved from line 3062) ───────────────────────────────────
export const TRANSIENT_TYPES = new Set([
  "edges-overlay", "preprocessed-overlay", "dxf-overlay",
  "detected-circle", "detected-line",
  "detected-line-merged", "detected-arc-partial",
]);

export const DETECTION_TYPES = new Set([
  "detected-circle", "detected-line", "detected-line-merged", "detected-arc-partial",
]);
