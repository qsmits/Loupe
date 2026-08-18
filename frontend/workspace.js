// workspace.js — swap-on-activate workspace state for project tabs.
//
// The app's singletons (state, viewport, undo/redo stacks) always describe
// the ACTIVE tab. Switching tabs = serializeWorkspace() the outgoing tab,
// restoreWorkspace() the incoming one. This is cross-mode.js's stash/restore
// (cross-mode.js:47-88) promoted to first-class and exhaustive.
//
// DELIBERATELY DOM-FREE so `node --test` can import it. The DOM re-fit that
// must follow a restore (resizeCanvas + fitToWindow/clampPan + redraw) is
// injected from main.js via registerWorkspaceDom().
//
// THE CLASSIFICATION CONTRACT (enforced by tests/frontend/test_workspace.js):
// every key of `state` MUST appear in STATE_FIELDS as exactly one of
//   "swapped"   — travels with the tab; captured BY REFERENCE by
//                 serializeWorkspace() (only one record is ever live in
//                 `state` at a time, so sharing is safe and keeps live
//                 HTMLImageElement refs alive across switches)
//   "transient" — in-progress gesture / hover / async scratch; reset to its
//                 FIELD_DEFAULTS value on every restore
//   "global"    — app- or hardware-level; untouched by tab switches
// Adding a state field without classifying it fails the gate test.

import { state, undoStack, redoStack } from './state.js';
import { viewport, imageWidth, imageHeight, setImageSize } from './viewport.js';

export const STATE_FIELDS = {
  // ── document content & per-project prefs (swapped) ──
  tool: "swapped",
  frozen: "swapped",
  frozenBackground: "swapped",
  frozenBlob: "swapped",
  frozenSource: "swapped",
  frozenFilename: "swapped",
  frozenSize: "swapped",
  crosshair: "swapped",
  showGrid: "swapped",
  calibration: "swapped",
  annotations: "swapped",
  selected: "swapped",
  origin: "swapped",
  showDeviations: "swapped",
  tolerances: "swapped",
  featureTolerances: "swapped",
  featureModes: "swapped",
  inspectionResults: "swapped",
  inspectionFrame: "swapped",
  dxfFilename: "swapped",
  featureNames: "swapped",
  measurementGroups: "swapped",
  constraints: "swapped",
  nextConstraintId: "swapped",
  nextId: "swapped",
  _templateLoaded: "swapped",
  _templateName: "swapped",
  lensK1: "swapped",
  lensK1Space: "swapped",
  _topLevelTool: "swapped",
  _dirty: "swapped",
  _savedManually: "swapped",
  _hideAllAnnotations: "swapped",
  gearAnalysis: "swapped",
  activeReticle: "swapped",
  reticleRotationDeg: "swapped",
  reticleColorOverride: "swapped",
  reticleOpacityOverride: "swapped",

  // ── in-progress gestures / hovers / scratch (transient — reset per swap) ──
  showGradientOverlay: "transient",
  _gradientOverlayImg: "transient",
  pendingPoints: "transient",
  pendingCenterCircle: "transient",
  pendingRefLine: "transient",
  pendingRefLineClick: "transient",
  hoverRefLine: "transient",
  pendingCircleRef: "transient",
  dragState: "transient",
  snapTarget: "transient",
  mousePos: "transient",
  dxfAlignMode: "transient",
  dxfAlignStep: "transient",
  dxfAlignPick: "transient",
  dxfAlignHover: "transient",
  dxfDragMode: "transient",
  dxfDragOrigin: "transient",
  dxfRotateMode: "transient",
  dxfRotateOrigin: "transient",
  inspectionHoverHandle: "transient",
  inspectionPickTarget: "transient",
  inspectionPickPoints: "transient",
  inspectionPickFit: "transient",
  _originMode: "transient",
  _dxfOriginMode: "transient",
  _selectRect: "transient",
  _panStart: "transient",
  _flashExpiry: "transient",
  _labelDrag: "transient",
  _dragUndoSnapshot: "transient",
  _dragMoved: "transient",
  _subpixelSnapTarget: "transient",
  _previewCursor: "transient",
  gearPickMode: "transient",
  gearPickBuffer: "transient",
  gearPickHover: "transient",
  _hoveredConstraintId: "transient",
  _badgeDrag: "transient",
  _reticleDrag: "transient",

  // ── app / hardware level (global — untouched by tab switches) ──
  includeWebcams: "global",
  settings: "global",
  arcMeasureMode: "global",
  arcFitMode: "global",
  angleMode: "global",
  circleMode: "global",
  surfaceMode: "global",
  _noCamera: "global",
  _hosted: "global",
  _epoch: "global",
  browserCamera: "global",
  browserCameraDevices: "global",
  _cameraInfo: "global",
};

// Default factories for every swapped + transient key (mirrors the state.js
// literal). Factories, not values — mutable defaults must not be shared
// between records.
export const FIELD_DEFAULTS = {
  // swapped
  tool: () => "select",
  frozen: () => false,
  frozenBackground: () => null,
  frozenBlob: () => null,
  frozenSource: () => null,
  frozenFilename: () => null,
  frozenSize: () => null,
  crosshair: () => false,
  showGrid: () => false,
  calibration: () => null,
  annotations: () => [],
  selected: () => new Set(),
  origin: () => null,
  showDeviations: () => false,
  tolerances: () => ({ warn: 0.10, fail: 0.25 }),
  featureTolerances: () => ({}),
  featureModes: () => ({}),
  inspectionResults: () => [],
  inspectionFrame: () => null,
  dxfFilename: () => null,
  featureNames: () => ({}),
  measurementGroups: () => ({}),
  constraints: () => [],
  nextConstraintId: () => 1,
  nextId: () => 1,
  _templateLoaded: () => false,
  _templateName: () => null,
  lensK1: () => 0,
  lensK1Space: () => "diag_normalized_v1",
  _topLevelTool: () => null,
  _dirty: () => false,
  _savedManually: () => true,
  _hideAllAnnotations: () => false,
  gearAnalysis: () => null,
  activeReticle: () => null,
  reticleRotationDeg: () => 0,
  reticleColorOverride: () => null,
  reticleOpacityOverride: () => null,
  // transient
  showGradientOverlay: () => false,
  _gradientOverlayImg: () => null,
  pendingPoints: () => [],
  pendingCenterCircle: () => null,
  pendingRefLine: () => null,
  pendingRefLineClick: () => null,
  hoverRefLine: () => null,
  pendingCircleRef: () => null,
  dragState: () => null,
  snapTarget: () => null,
  mousePos: () => ({ x: 0, y: 0 }),
  dxfAlignMode: () => false,
  dxfAlignStep: () => 0,
  dxfAlignPick: () => null,
  dxfAlignHover: () => null,
  dxfDragMode: () => false,
  dxfDragOrigin: () => null,
  dxfRotateMode: () => false,
  dxfRotateOrigin: () => null,
  inspectionHoverHandle: () => null,
  inspectionPickTarget: () => null,
  inspectionPickPoints: () => [],
  inspectionPickFit: () => null,
  _originMode: () => false,
  _dxfOriginMode: () => false,
  _selectRect: () => null,
  _panStart: () => null,
  _flashExpiry: () => 0,
  _labelDrag: () => null,
  _dragUndoSnapshot: () => null,
  _dragMoved: () => false,
  _subpixelSnapTarget: () => null,
  _previewCursor: () => null,
  gearPickMode: () => null,
  gearPickBuffer: () => null,
  gearPickHover: () => null,
  _hoveredConstraintId: () => null,
  _badgeDrag: () => null,
  _reticleDrag: () => null,
};

/** A pristine in-memory tab record (new project, nothing loaded).
 *  viewport: null means "fit to window on first activation". */
export function freshWorkspaceRecord() {
  const s = {};
  for (const [key, cls] of Object.entries(STATE_FIELDS)) {
    if (cls === "swapped") s[key] = FIELD_DEFAULTS[key]();
  }
  return {
    state: s,
    viewport: null,
    imageWidth: 0,
    imageHeight: 0,
    undoStack: [],
    redoStack: [],
  };
}

/** Capture the active tab's full workspace as an in-memory record. */
export function serializeWorkspace() {
  const s = {};
  for (const [key, cls] of Object.entries(STATE_FIELDS)) {
    if (cls === "swapped") s[key] = state[key];   // by reference — see header
  }
  return {
    state: s,
    viewport: { zoom: viewport.zoom, panX: viewport.panX, panY: viewport.panY },
    imageWidth,
    imageHeight,
    undoStack: undoStack.slice(),
    redoStack: redoStack.slice(),
  };
}

let _dom = null;
/** main.js injects { afterRestore(record) } — resizeCanvas + fit + redraw +
 *  sidebar refresh. Absent (node tests), restore is state-only. */
export function registerWorkspaceDom(hooks) { _dom = hooks; }

/** True when a stored viewport can be installed as-is. A record persisted with
 *  zoom 0 / NaN pan (reachable before the degenerate-canvas guard, and
 *  structured clone round-trips NaN through IndexedDB verbatim) would restore
 *  to a black canvas that no refresh can fix — the bad value lives in the DB.
 *  Callers treat a rejected viewport exactly like `viewport === null`: leave
 *  the singleton alone and let the DOM hook fit to window. */
export function isUsableViewport(v) {
  return !!v && Number.isFinite(v.zoom) && v.zoom > 0
    && Number.isFinite(v.panX) && Number.isFinite(v.panY);
}

/** Make `record` the active workspace. Bumps the epoch FIRST so any
 *  in-flight async handler from the outgoing tab sees itself stale. */
export function restoreWorkspace(record) {
  state._epoch += 1;
  for (const [key, cls] of Object.entries(STATE_FIELDS)) {
    if (cls === "swapped") state[key] = record.state[key];
    else if (cls === "transient") state[key] = FIELD_DEFAULTS[key]();
    // "global": leave alone
  }
  undoStack.length = 0;
  undoStack.push(...record.undoStack);
  redoStack.length = 0;
  redoStack.push(...record.redoStack);
  setImageSize(record.imageWidth, record.imageHeight);
  if (isUsableViewport(record.viewport)) {
    viewport.zoom = record.viewport.zoom;
    viewport.panX = record.viewport.panX;
    viewport.panY = record.viewport.panY;
  }
  _dom?.afterRestore?.(record);
}

export function captureEpoch() { return state._epoch; }
export function isStale(epoch) { return epoch !== state._epoch; }

/** Invalidate any in-flight async work for the workspace being left, without
 *  otherwise touching state. Call this whenever a tab stops being the active
 *  one — not just when another tab replaces it (restoreWorkspace already
 *  bumps for that) but also when nothing replaces it (e.g. the home screen),
 *  which used to leave the epoch untouched and let a slow response land in
 *  the now-detached workspace. Monotonic; isStale() only ever compares for
 *  inequality, so a redundant bump alongside restoreWorkspace's own is
 *  harmless. */
export function bumpEpoch() { state._epoch += 1; }
