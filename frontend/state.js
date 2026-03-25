// ── State ──────────────────────────────────────────────────────────────────
export const state = {
  tool: "select",
  frozen: false,
  frozenBackground: null,   // HTMLImageElement set by doFreeze()
  frozenSize: null,          // { w, h } set by doFreeze()
  crosshair: false,
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
  inspectionResults: [],   // populated by "Run inspection"; persisted in session v2
  inspectionFrame: null,   // base64 JPEG of composited camera+overlay at inspection time
  dxfFilename: null,       // set from DXF filename on load; cleared on DXF clear
  nextId: 1,
  settings: {
    crosshairColor: "#ffffff",
    crosshairOpacity: 0.4,
    pixelFormat: "BayerRG8",
  },
  _originMode: false,       // was let _originMode (line 2539 in app.js)
  _dxfOriginMode: false,    // was let _dxfOriginMode (line 2547)
  _selectRect: null,
  _flashExpiry: 0,
  _noCamera: false,         // was let _noCamera (line 36)
};

export const undoStack = [];
export const redoStack = [];
export const UNDO_LIMIT = 50;

export const _deviationHitBoxes = [];  // populated by drawDeviations, read by main.js

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
}

// ── TOOL_STATUS ─────────────────────────────────────────────────────────────
export const TOOL_STATUS = {
  "select":         "Select",
  "calibrate":      "Click — place two points or select a circle",
  "distance":       "Click — place point 1",
  "angle":          "Click — place point 1",
  "circle":         "Click — place point 1",
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
