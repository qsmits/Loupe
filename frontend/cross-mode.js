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
import { setTool } from './tools.js';
import { redraw, resizeCanvas, canvas } from './render.js';
import { viewport, setImageSize, fitToWindow } from './viewport.js';
import { switchMode } from './modes.js';
import { openLensCalDialog, closeLensCalDialog } from './lens-cal.js';

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
    nextId: state.nextId,
    selected: new Set(state.selected),
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
  state.nextId = stashedState.nextId;
  state.selected = stashedState.selected;
  stashedState = null;

  // Restore the live stream visibility
  const streamImg = document.getElementById('stream-img');
  if (streamImg) streamImg.style.visibility = '';
}

let actionBar = null;

/**
 * Create and show the floating action bar for mask editing.
 */
function showActionBar(onApply, onCancel, opts = {}) {
  if (actionBar) actionBar.remove();

  actionBar = document.createElement('div');
  actionBar.id = 'cross-mode-action-bar';

  const label = document.createElement('span');
  label.className = 'cross-mode-label';
  label.textContent = opts.label || 'Defining fringe mask';

  actionBar.appendChild(label);

  if (!opts.hideApply && onApply) {
    const applyBtn = document.createElement('button');
    applyBtn.className = 'detect-btn cross-mode-apply';
    applyBtn.textContent = opts.applyLabel || 'Apply Mask';
    applyBtn.addEventListener('click', onApply);
    actionBar.appendChild(applyBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cross-mode-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);
  actionBar.appendChild(cancelBtn);

  document.body.appendChild(actionBar);
}

function hideActionBar() {
  if (actionBar) {
    actionBar.remove();
    actionBar = null;
  }
}

/**
 * Convert existing fringe mask polygons to microscope area annotations
 * so the user can edit their previous mask.
 */
function loadExistingMask(existingMask, imgWidth, imgHeight) {
  for (const poly of existingMask) {
    if (!poly.vertices || poly.vertices.length < 3) continue;
    const points = poly.vertices.map(v => ({
      x: v.x * imgWidth,
      y: v.y * imgHeight,
    }));
    state.annotations.push({
      type: 'area',
      points,
      id: state.nextId++,
      name: '',
      mode: poly.include ? 'punch' : 'die',
    });
  }
}

/**
 * Enter mask-edit session. Called when microscope mode activates with crossMode set.
 */
export async function enterMaskEditSession() {
  if (!window.crossMode) return;

  if (window.crossMode.source === 'fringe-lens-cal') {
    return enterLensCalSession();
  }

  const cm = window.crossMode;

  // 1. Stash current microscope state
  stashMicroscopeState();

  // 2. Clear microscope state for mask editing
  state.annotations = [];
  state.calibration = null;
  state.selected = new Set();
  undoStack.length = 0;
  redoStack.length = 0;

  // 3. Load the fringe preview image as frozen background
  let loadedImg;
  try {
    const url = URL.createObjectURL(cm.imageBlob);
    loadedImg = new Image();
    await new Promise((resolve, reject) => {
      loadedImg.onload = () => { URL.revokeObjectURL(url); resolve(); };
      loadedImg.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load preview image')); };
      loadedImg.src = url;
    });
  } catch (e) {
    console.warn('[cross-mode] Image load failed:', e);
    const errorSource = cm.source || 'fringe';
    restoreMicroscopeState();
    clearCrossMode();
    const errorTarget = errorSource === 'deflectometry' ? 'deflectometry' : 'fringe';
    const switcher = document.getElementById('mode-switcher');
    if (switcher) { switcher.hidden = false; switcher.value = errorTarget; }
    switchMode(errorTarget);
    return;
  }

  const w = loadedImg.naturalWidth;
  const h = loadedImg.naturalHeight;
  state.frozen = true;
  state.frozenBackground = loadedImg;
  state.frozenSize = { w, h };
  setImageSize(w, h);

  // Hide the live stream so the frozen background on the canvas is visible.
  // Use visibility (not hidden) to preserve layout sizing.
  const streamImg = document.getElementById('stream-img');
  if (streamImg) streamImg.style.visibility = 'hidden';

  // Hide the drop overlay during mask editing
  const dropOverlay = document.getElementById('drop-overlay');
  if (dropOverlay) dropOverlay.classList.remove('visible');

  // 4. Convert existing mask polygons to area annotations
  if (cm.existingMask && cm.existingMask.length > 0) {
    loadExistingMask(cm.existingMask, w, h);
  }

  // 5. Set tool to area drawing
  setTool('area');

  // 6. Hide mode switcher
  const switcher = document.getElementById('mode-switcher');
  if (switcher) switcher.hidden = true;

  // 7. Show action bar
  const maskLabel = cm.source === 'deflectometry' ? 'Defining deflectometry mask' : 'Defining fringe mask';
  showActionBar(
    () => applyMask(),
    () => cancelMask(),
    { label: maskLabel },
  );

  // 8. Update canvas — fit image to viewport
  resizeCanvas();
  const rect = canvas.getBoundingClientRect();
  fitToWindow(rect.width, rect.height);
  redraw();
}

/**
 * Extract closed polygon annotations and return as normalized mask polygons.
 */
function extractMaskPolygons() {
  const polygons = [];
  const imgW = state.frozenSize?.w || 1;
  const imgH = state.frozenSize?.h || 1;

  for (const ann of state.annotations) {
    if (ann.type === 'area' && ann.points && ann.points.length >= 3) {
      polygons.push({
        vertices: ann.points.map(p => ({
          x: p.x / imgW,
          y: p.y / imgH,
        })),
        include: ann.mode !== 'die',
      });
    }
  }

  return polygons;
}

function applyMask() {
  if (!window.crossMode) return;

  const polygons = extractMaskPolygons();
  const callback = window.crossMode.callback;

  // Clean up and exit
  _exitMaskEditSession();

  // Deliver polygons to fringe via callback, then redraw
  callback(polygons);
  redraw();
}

async function enterLensCalSession() {
  const cm = window.crossMode;

  // 1. Stash microscope state
  stashMicroscopeState();

  // 2. Hide mode switcher
  const switcher = document.getElementById('mode-switcher');
  if (switcher) switcher.hidden = true;

  // 3. Show action bar (no Apply button — lens cal dialog has its own)
  showActionBar(
    null,
    () => cancelLensCal(),
    { label: 'Calibrating fringe lens', hideApply: true }
  );

  // 4. Open the lens cal dialog with a callback that captures k1
  openLensCalDialog({
    onConfirm: (k1) => {
      const callback = cm.callback;
      _exitMaskEditSession();
      if (callback) callback(k1);
      redraw();
    }
  });
}

function cancelLensCal() {
  closeLensCalDialog();
  _exitMaskEditSession();
  redraw();
}

function _exitMaskEditSession() {
  const source = window.crossMode?.source || 'fringe';
  hideActionBar();
  restoreMicroscopeState();
  clearCrossMode();

  const targetMode = source === 'deflectometry' ? 'deflectometry' : 'fringe';
  const switcher = document.getElementById('mode-switcher');
  if (switcher) { switcher.hidden = false; switcher.value = targetMode; }

  switchMode(targetMode);
}

function cancelMask() {
  _exitMaskEditSession();
  redraw();
}
