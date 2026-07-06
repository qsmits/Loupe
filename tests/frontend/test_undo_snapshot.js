/**
 * Tests for the undo snapshot machinery in frontend/state.js.
 *
 * Covers two confirmed defects:
 *
 * 1. takeSnapshot() JSON.stringified state.annotations wholesale. The
 *    edges-overlay / preprocessed-overlay annotations carry a live
 *    HTMLImageElement in `.image`, which serializes to `{}`. After an
 *    undo/redo restored such a snapshot, drawEdgesOverlay called
 *    ctx.drawImage({}) and threw inside every redraw, bricking the canvas.
 *    Fix: snapshots exclude OVERLAY_TYPES; undo/redo re-attach the
 *    currently-live overlays via mergeRestoredAnnotations().
 *
 * 2. Metadata maps (featureModes, featureNames, measurementGroups) were
 *    not part of the snapshot, so pushUndo() before a punch/die toggle or
 *    a group rename could not actually revert the change.
 *    Fix: takeSnapshot() includes them; undo()/redo() restore them.
 *
 * Also covers pushUndo(snapshot) — the optional pre-captured snapshot
 * parameter used by the drag-undo fix (snapshot taken on mousedown, pushed
 * on mouseup only if the drag actually moved something).
 *
 * Run with: node --test tests/frontend/test_undo_snapshot.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  state, pushUndo, takeSnapshot, undoStack, redoStack,
  OVERLAY_TYPES, mergeRestoredAnnotations, pruneOrphanGroupEntries,
} from '../../frontend/state.js';

function resetState() {
  undoStack.length = 0;
  redoStack.length = 0;
  state.annotations = [];
  state.calibration = null;
  state.origin = null;
  state.constraints = [];
  state.selected = new Set();
  state.featureModes = {};
  state.featureNames = {};
  state.measurementGroups = {};
  state.nextId = 1;
  state._dirty = false;
  state._savedManually = true;
}

// A stand-in for the live HTMLImageElement detect.js stores on overlays.
// Like the real thing, it JSON-serializes to {} (methods/DOM state lost).
function fakeImage() {
  const img = Object.create({ decode() {} });
  return img;
}

// ── takeSnapshot: overlay exclusion ──────────────────────────────────────────

describe('takeSnapshot — live-image overlay exclusion', () => {
  beforeEach(resetState);

  it('OVERLAY_TYPES names exactly the two live-image overlay types', () => {
    assert.deepEqual([...OVERLAY_TYPES].sort(),
      ['edges-overlay', 'preprocessed-overlay']);
  });

  it('excludes edges-overlay and preprocessed-overlay from the snapshot', () => {
    state.annotations = [
      { type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { type: 'edges-overlay', id: 2, image: fakeImage() },
      { type: 'preprocessed-overlay', id: 3, image: fakeImage() },
    ];
    const snap = JSON.parse(takeSnapshot());
    assert.deepEqual(snap.annotations.map(a => a.type), ['distance'],
      'snapshot must never contain a serialized (dead) overlay');
  });

  it('keeps detections and the dxf-overlay in the snapshot (undo of clear/align must still work)', () => {
    state.annotations = [
      { type: 'detected-circle', id: 1, x: 5, y: 5, radius: 2 },
      { type: 'detected-line', id: 2, x1: 0, y1: 0, x2: 1, y2: 1 },
      { type: 'dxf-overlay', id: 3, offsetX: 10, offsetY: 20, entities: [] },
    ];
    const snap = JSON.parse(takeSnapshot());
    assert.deepEqual(snap.annotations.map(a => a.type),
      ['detected-circle', 'detected-line', 'dxf-overlay']);
  });

  it('does not mutate state.annotations (filter, not splice)', () => {
    state.annotations = [
      { type: 'edges-overlay', id: 1, image: fakeImage() },
      { type: 'distance', id: 2, a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
    ];
    takeSnapshot();
    assert.equal(state.annotations.length, 2);
    assert.equal(state.annotations[0].type, 'edges-overlay');
  });
});

// ── takeSnapshot: metadata maps ──────────────────────────────────────────────

describe('takeSnapshot — metadata maps', () => {
  beforeEach(resetState);

  it('includes featureModes, featureNames and measurementGroups', () => {
    state.featureModes = { A1: 'punch' };
    state.featureNames = { A1: 'Left cavity' };
    state.measurementGroups = { 7: 'Slot' };
    const snap = JSON.parse(takeSnapshot());
    assert.deepEqual(snap.featureModes, { A1: 'punch' });
    assert.deepEqual(snap.featureNames, { A1: 'Left cavity' });
    assert.deepEqual(snap.measurementGroups, { 7: 'Slot' });
  });

  it('round-trips a punch/die toggle: pushUndo before mutation captures the pre-state', () => {
    state.featureModes = { A1: 'die' };
    pushUndo();
    state.featureModes.A1 = 'punch';
    const snap = JSON.parse(undoStack[undoStack.length - 1]);
    assert.equal(snap.featureModes.A1, 'die');
  });
});

// ── mergeRestoredAnnotations ─────────────────────────────────────────────────

describe('mergeRestoredAnnotations', () => {
  it('appends the currently-live overlays after the restored set (detect.js draw order: overlays last)', () => {
    const liveOverlay = { type: 'edges-overlay', id: 9, image: fakeImage() };
    const restored = [{ type: 'distance', id: 1 }];
    const current = [{ type: 'distance', id: 1 }, { type: 'circle', id: 2 }, liveOverlay];
    const merged = mergeRestoredAnnotations(restored, current);
    assert.deepEqual(merged.map(a => a.type), ['distance', 'edges-overlay']);
    assert.equal(merged[1], liveOverlay, 'the LIVE object must be kept, not a copy');
  });

  it('never resurrects a dead overlay from the restored snapshot', () => {
    // Even if an old snapshot somehow contains a serialized overlay, it must
    // be dropped — its .image is {} and would brick every redraw.
    const restored = [
      { type: 'edges-overlay', id: 4, image: {} },
      { type: 'distance', id: 1 },
    ];
    const merged = mergeRestoredAnnotations(restored, []);
    assert.deepEqual(merged.map(a => a.type), ['distance']);
  });

  it('keeps multiple live overlays in their current relative order', () => {
    const e = { type: 'edges-overlay', id: 5, image: fakeImage() };
    const p = { type: 'preprocessed-overlay', id: 6, image: fakeImage() };
    const merged = mergeRestoredAnnotations([], [p, e]);
    assert.deepEqual(merged, [p, e]);
  });

  it('is pure: does not mutate its inputs', () => {
    const restored = [{ type: 'distance', id: 1 }];
    const current = [{ type: 'edges-overlay', id: 2, image: fakeImage() }];
    mergeRestoredAnnotations(restored, current);
    assert.equal(restored.length, 1);
    assert.equal(current.length, 1);
  });
});

// ── pushUndo(snapshot) — pre-captured snapshot for drag undo ─────────────────

describe('pushUndo — optional pre-captured snapshot', () => {
  beforeEach(resetState);

  it('default call still snapshots the current state', () => {
    state.annotations = [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 5, y: 0 } }];
    pushUndo();
    const snap = JSON.parse(undoStack[0]);
    assert.equal(snap.annotations[0].b.x, 5);
  });

  it('pushes the given snapshot verbatim (pre-drag state, not post-drag)', () => {
    state.annotations = [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 5, y: 0 } }];
    const preDrag = takeSnapshot();
    // simulate handleDrag mutating during mousemove
    state.annotations[0].b.x = 99;
    pushUndo(preDrag);
    const snap = JSON.parse(undoStack[0]);
    assert.equal(snap.annotations[0].b.x, 5,
      'undo entry must capture the state BEFORE the drag mutations');
  });

  it('clears the redo stack and marks the session dirty, same as the default path', () => {
    redoStack.push('{"annotations":[]}');
    state._dirty = false;
    state._savedManually = true;
    pushUndo(takeSnapshot());
    assert.equal(redoStack.length, 0);
    assert.equal(state._dirty, true);
    assert.equal(state._savedManually, false);
  });
});

// ── pruneOrphanGroupEntries ──────────────────────────────────────────────────

describe('pruneOrphanGroupEntries', () => {
  beforeEach(resetState);

  it('drops group entries whose annotation no longer exists', () => {
    state.annotations = [{ type: 'distance', id: 2 }];
    state.measurementGroups = { 1: 'Slot', 2: 'Slot' };
    pruneOrphanGroupEntries();
    assert.deepEqual(state.measurementGroups, { 2: 'Slot' });
  });

  it('keeps entries for annotations that still exist (string/number key coercion)', () => {
    state.annotations = [{ type: 'circle', id: 11 }, { type: 'distance', id: 12 }];
    state.measurementGroups = { 11: 'Bores', 12: 'Bores' };
    pruneOrphanGroupEntries();
    assert.equal(Object.keys(state.measurementGroups).length, 2);
  });
});
