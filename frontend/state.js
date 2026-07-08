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
  pendingRefLineClick: null,
  hoverRefLine: null,  // annotation the angle tool would capture on click
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
  dxfRotateMode: false,
  dxfRotateOrigin: null, // { pivotX, pivotY, startAngleRad, annAngleStart }
  showDeviations: false,
  includeWebcams: false,
  tolerances: { warn: 0.10, fail: 0.25 },
  featureTolerances: {},
  featureModes: {},        // { [handle]: "punch" | "die" } — default is "die"
  inspectionResults: [],   // populated by "Run inspection"; persisted in session v2
  inspectionFrame: null,   // base64 JPEG of composited camera+overlay at inspection time
  dxfFilename: null,       // set from DXF filename on load; cleared on DXF clear
  featureNames: {},              // { [handle_or_parent]: "user name" }
  measurementGroups: {},         // { [annotationId]: "group name" }
  constraints: [],              // geometric constraints between annotations
  nextConstraintId: 1,          // auto-increment ID for constraints
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
  _dragUndoSnapshot: null,  // takeSnapshot() captured at drag start (mousedown)
  _dragMoved: false,        // set by mousemove drag paths; gates the undo push on mouseup
  _templateLoaded: false,
  _templateName: null,
  _subpixelSnapTarget: null, // { x, y } — live preview of where sub-pixel snap would place a point
  _previewCursor: null,      // { x, y } — snapped cursor (image space) while a measurement is in progress
  lensK1: 0,                 // radial distortion coefficient (applied in-place to frozenBackground)
  arcMeasureMode: "sequential", // "sequential" | "ends-first"
  arcFitMode: "arc",           // "arc" | "circle" — whether Best-fit yields a partial arc or full circle
  angleMode: "two-lines",      // "two-lines" | "three-points"
  circleMode: "3-point",       // "3-point" | "center-edge"
  surfaceMode: "edm",          // "edm" | "lathe" | "print"
  _topLevelTool: null,      // non-persistent: "distance"|"angle"|"circle"|"flatness"|"area"|"intersect" when a measure tool is active
  _noCamera: false,         // was let _noCamera (line 36)
  _hosted: false,           // set from /config/ui at startup
  _dirty: false,
  _savedManually: true,
  _hideAllAnnotations: false,  // global visibility toggle — overrides ann.hidden when true
  // Gear analysis PoC
  gearPickMode: null,      // null | "pick-tip" | "pick-root"
  gearPickBuffer: null,    // { tipCircle?, rootCircle? }
  gearPickHover: null,     // annotation id of circle currently under cursor in gear pick mode
  gearAnalysis: null,      // null | { pcd_radius_px, teeth, material_is_dark, cx, cy }
  _hoveredConstraintId: null,
  // Reticle overlay
  activeReticle: null,           // loaded reticle JSON object, or null
  reticleRotationDeg: 0,         // current rotation in degrees
  reticleColorOverride: null,    // user color override, or null (use reticle default)
  reticleOpacityOverride: null,  // user opacity override, or null (use reticle default)
};

// Active camera's exposure and gain bounds — refreshed from /camera/info
// whenever the camera panel is opened. Used by the log-scale sliders so they
// always span the camera's full usable range in its native units.
export const camBounds = {
  expMin: 100, expMax: 100000,
  gainMin: 1.0, gainMax: 24.0,
};

export const undoStack = [];
export const redoStack = [];
export const UNDO_LIMIT = 50;

export const _deviationHitBoxes = [];  // populated by drawDeviations, read by main.js
export const _labelHitBoxes = [];     // populated by drawGuidedResults, used for drag + tooltip

// Overlay annotations that carry a LIVE HTMLImageElement (detect.js stores
// `{ type: "edges-overlay", image: <Image> }`). An Image serializes to `{}`,
// so these must NEVER enter a JSON snapshot — a restored `{}` image bricks
// every redraw via ctx.drawImage. They are excluded from snapshots and
// re-attached after undo/redo by mergeRestoredAnnotations() below.
// NOTE: deliberately narrower than TRANSIENT_TYPES — dxf-overlay and the
// detected-* types are plain JSON and have working undo flows (DXF align/
// rotate, elevate, clear detections) that rely on being snapshotted.
export const OVERLAY_TYPES = new Set(["edges-overlay", "preprocessed-overlay"]);

export function takeSnapshot() {
  return JSON.stringify({
    annotations: state.annotations.filter(a => !OVERLAY_TYPES.has(a.type)),
    calibration: state.calibration,
    origin: state.origin,
    constraints: state.constraints,
    featureModes: state.featureModes,
    featureNames: state.featureNames,
    measurementGroups: state.measurementGroups,
  });
}

// Recombine a restored snapshot's annotations with the overlays that are
// currently alive on screen. Pure — used by undo()/redo(). Restored overlays
// (dead: image === {}) are dropped; live overlays keep their identity and
// stay at the end of the array, matching detect.js insertion order (overlays
// are drawn last, on top).
export function mergeRestoredAnnotations(restoredAnnotations, currentAnnotations) {
  return [
    ...restoredAnnotations.filter(a => !OVERLAY_TYPES.has(a.type)),
    ...currentAnnotations.filter(a => OVERLAY_TYPES.has(a.type)),
  ];
}

// Drop measurementGroups entries whose annotation no longer exists (object
// keys are strings; annotation ids are numbers). Called after any bulk or
// single annotation removal so autosaved sessions don't accumulate orphans.
export function pruneOrphanGroupEntries() {
  const ids = new Set(state.annotations.map(a => String(a.id)));
  for (const key of Object.keys(state.measurementGroups)) {
    if (!ids.has(key)) delete state.measurementGroups[key];
  }
}

// pushUndo(snapshot): the optional argument is a snapshot captured BEFORE a
// mutation began (e.g. on mousedown, before a drag mutates state on every
// mousemove). Default (no argument) snapshots the current state.
export function pushUndo(snapshot = null) {
  if (undoStack.length >= UNDO_LIMIT) undoStack.shift();
  undoStack.push(snapshot ?? takeSnapshot());
  redoStack.length = 0;
  state._dirty = true;
  state._savedManually = false;
}

// Classify what Ctrl-Z should act on (Track A #1). Multi-click tools
// accumulate clicks in state.pendingPoints (tools.js) and the DXF point-pick
// in state.inspectionPickPoints (events-mouse.js); neither is covered by the
// undo stack — snapshots happen on finalize — so the keyboard handler pops
// them directly before falling through to history undo.
export function undoTarget(s) {
  if (s.inspectionPickTarget && s.inspectionPickPoints.length > 0) return "pick-point";
  if (s.pendingPoints.length > 0) return "pending-point";
  return "history";
}

// ── TOOL_STATUS ─────────────────────────────────────────────────────────────
export const TOOL_STATUS = {
  "select":         "Select",
  "calibrate":      "Click — place two points or select a circle",
  "distance":       "Distance · Direct — click to place point 1",
  "angle":          "Angle — click a line (two-lines) or empty space (three-points)",
  "circle":         "Circle/Arc · 3-point — click to place point 1",
  "arc-fit":        "Circle/Arc · Best-fit — place points (double-click to confirm)",
  "detect":         "Click — detect features",
  "area":           "Area · Polygon — click to place points (double-click to confirm)",
  "area-shape":     "Area · From shape — click a closed shape or a segment of a closed loop",
  "arc-measure":    "Circle/Arc · Arc measure — place 3 points on arc",
  "spline":         "Area · Spline — place anchor points (double-click or Enter to finish)",
  "fit-line":       "Flatness — place points on a line (double-click or Enter to confirm)",
  "comment":        "Click — place a note on the canvas",
  "point":          "Point — click to place a reference point",
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
