// Image warps change pixel coordinates. Keep one coherent geometry snapshot
// for dedicated image undo; ordinary measurement undo cannot cross a warp.
import { state, undoStack, redoStack } from './state.js';

const fields = ['annotations', 'calibration', 'origin', 'constraints', 'selected',
  'featureModes', 'featureNames', 'featureSpecs', 'featureTolerances', 'dxfDefaultTol',
  'measurementGroups', 'inspectionResults', 'inspectionFrame', 'dxfFilename',
  'gearAnalysis', 'showDeviations'];

export function captureImageGeometry() {
  return { fields: Object.fromEntries(fields.map(k => [k, state[k]])),
    undo: [...undoStack], redo: [...redoStack] };
}

export function clearImageGeometry(calibration = null) {
  Object.assign(state, { annotations: [], calibration, origin: null, constraints: [],
    selected: new Set(), featureModes: {}, featureNames: {}, featureSpecs: {},
    featureTolerances: {}, dxfDefaultTol: null, measurementGroups: {},
    inspectionResults: [], inspectionFrame: null, dxfFilename: null,
    gearAnalysis: null, showDeviations: false, pendingPoints: [], pendingCenterCircle: null,
    pendingRefLine: null, pendingCircleRef: null, pendingRelationFit: null,
    dragState: null, snapTarget: null, _gradientOverlayImg: null, showGradientOverlay: false,
    _dirty: true });
  undoStack.length = redoStack.length = 0;
}

export function restoreImageGeometry(snapshot) {
  Object.assign(state, snapshot.fields);
  undoStack.splice(0, undoStack.length, ...snapshot.undo);
  redoStack.splice(0, redoStack.length, ...snapshot.redo);
  state._dirty = true;
}
