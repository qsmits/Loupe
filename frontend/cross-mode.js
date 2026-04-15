// cross-mode.js — Cross-mode mask editing: state management,
// microscope state stash/restore, action bar, polygon extraction.
//
// Used when fringe mode delegates mask drawing to microscope mode.
// The workflow: fringe captures a preview frame, sets window.crossMode,
// switches to microscope mode. Microscope detects crossMode, stashes
// its own state, loads the fringe preview as a frozen image, and lets
// the user draw mask regions. On Apply, closed annotations become
// normalized mask polygons sent back to fringe via callback.

import { state, undoStack, redoStack } from './state.js';

let stashedState = null;

/**
 * Initialize crossMode on window — called from fringe panel's "Edit Mask" button.
 * @param {Object} opts - { imageBlob, existingMask, callback }
 */
export function initCrossMode({ imageBlob, existingMask, callback }) {
  window.crossMode = {
    source: 'fringe',
    imageBlob,
    existingMask: existingMask || [],
    callback: callback || (() => {}),
  };
}

/** True when a cross-mode mask-edit session is active. */
export function isCrossModeActive() {
  return !!(window.crossMode && window.crossMode.source);
}

/** Clear crossMode state. */
export function clearCrossMode() {
  window.crossMode = null;
}

/**
 * Stash current microscope state so it can be restored after mask editing.
 * Deep-copies mutable fields.
 */
export function stashMicroscopeState() {
  stashedState = {
    frozen: state.frozen,
    frozenBackground: state.frozenBackground,
    frozenSize: state.frozenSize ? { ...state.frozenSize } : null,
    annotations: JSON.parse(JSON.stringify(state.annotations)),
    calibration: state.calibration ? { ...state.calibration } : null,
    undoStack: undoStack.map(s => s),
    redoStack: redoStack.map(s => s),
    tool: state.tool,
  };
}

/**
 * Restore microscope state from stash. Called on Apply or Cancel.
 */
export function restoreMicroscopeState() {
  if (!stashedState) return;

  state.frozen = stashedState.frozen;
  state.frozenBackground = stashedState.frozenBackground;
  state.frozenSize = stashedState.frozenSize;
  state.annotations = stashedState.annotations;
  state.calibration = stashedState.calibration;

  // Restore undo/redo stacks (in-place to preserve references)
  undoStack.length = 0;
  undoStack.push(...stashedState.undoStack);
  redoStack.length = 0;
  redoStack.push(...stashedState.redoStack);

  state.tool = stashedState.tool;
  stashedState = null;
}
