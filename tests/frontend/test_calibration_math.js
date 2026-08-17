/**
 * Tests for the calibration scale math shared by applyCalibration
 * (frontend/annotations.js) and the calibration drag path
 * (frontend/tools.js handleDrag).
 *
 * Covers two confirmed bugs:
 *
 * 1. Dragging a calibration endpoint changed the reference geometry but never
 *    recomputed state.calibration.pixelsPerMm. The fix extracts the
 *    pixels-per-mm math into the pure helper calibrationPixelsPerMm
 *    (frontend/math.js) which both applyCalibration and the drag path call.
 *
 * 2. applyCalibration double-pushed undo (its own pushUndo + the one inside
 *    addAnnotation), leaving an inconsistent intermediate snapshot (new
 *    calibration, no calibration annotation). The fix keeps a single
 *    pushUndo BEFORE any mutation. The sequence invariant is verified here
 *    against the state.js undo machinery (the real applyCalibration is
 *    DOM-bound and cannot be imported under Node).
 *
 * Run with: node --test tests/frontend/test_calibration_math.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationPixelsPerMm, measurementPixelSpan, parseAreaInput, calibrationPpmFromMeasurement } from '../../frontend/math.js';
import { state, pushUndo, takeSnapshot, undoStack, redoStack } from '../../frontend/state.js';

// ── Two-point calibration ────────────────────────────────────────────────────

describe('calibrationPixelsPerMm — two-point', () => {
  it('horizontal 100 px over 1 mm → 100 px/mm', () => {
    const ann = { x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 1, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(ann), 100);
  });

  it('diagonal 3-4-5 (50 px) over 0.5 mm → 100 px/mm', () => {
    const ann = { x1: 10, y1: 20, x2: 40, y2: 60, knownValue: 0.5, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(ann), 100);
  });

  it('µm unit converts to mm: 200 px over 500 µm → 400 px/mm', () => {
    const ann = { x1: 0, y1: 0, x2: 200, y2: 0, knownValue: 500, unit: 'µm' };
    assert.equal(calibrationPixelsPerMm(ann), 400);
  });

  it('missing unit is treated as mm (parity with applyCalibration)', () => {
    const ann = { x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 2 };
    assert.equal(calibrationPixelsPerMm(ann), 50);
  });

  it('endpoint order does not matter', () => {
    const a = { x1: 0, y1: 0, x2: 80, y2: 60, knownValue: 1, unit: 'mm' };
    const b = { x1: 80, y1: 60, x2: 0, y2: 0, knownValue: 1, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(a), calibrationPixelsPerMm(b));
  });
});

// ── Circle (diameter) calibration ───────────────────────────────────────────

describe('calibrationPixelsPerMm — circle', () => {
  it('uses the diameter: r=250 over 5 mm → 100 px/mm', () => {
    const ann = { cx: 400, cy: 300, r: 250, knownValue: 5, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(ann), 100);
  });

  it('circle with µm: r=100 over 200 µm → 1000 px/mm', () => {
    const ann = { cx: 0, cy: 0, r: 100, knownValue: 200, unit: 'µm' };
    assert.equal(calibrationPixelsPerMm(ann), 1000);
  });

  it('x1===undefined selects the circle branch even when cx/cy present', () => {
    // Body-dragging a circle calibration mutates cx/cy only; the scale must
    // depend only on r.
    const before = { cx: 0, cy: 0, r: 150, knownValue: 3, unit: 'mm' };
    const after = { cx: 999, cy: -42, r: 150, knownValue: 3, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(before), calibrationPixelsPerMm(after));
  });
});

// ── Recompute-on-drag semantics (BUG 1) ──────────────────────────────────────

describe('calibrationPixelsPerMm — drag recompute semantics', () => {
  it('endpoint drag that stretches the line changes the scale proportionally', () => {
    const ann = { x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 1, unit: 'mm' };
    const before = calibrationPixelsPerMm(ann);
    // simulate handleDrag handleKey "b": ann.x2 += dx
    ann.x2 += 50;
    const after = calibrationPixelsPerMm(ann);
    assert.equal(before, 100);
    assert.equal(after, 150);
  });

  it('body drag (translate both endpoints) leaves the scale unchanged', () => {
    const ann = { x1: 10, y1: 10, x2: 110, y2: 10, knownValue: 1, unit: 'mm' };
    const before = calibrationPixelsPerMm(ann);
    ann.x1 += 33; ann.y1 -= 7; ann.x2 += 33; ann.y2 -= 7;
    assert.equal(calibrationPixelsPerMm(ann), before);
  });
});

// ── Degenerate input ─────────────────────────────────────────────────────────

describe('calibrationPixelsPerMm — degenerate input', () => {
  it('zero-length two-point → null', () => {
    const ann = { x1: 5, y1: 5, x2: 5, y2: 5, knownValue: 1, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(ann), null);
  });

  it('zero known value → null', () => {
    const ann = { x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 0, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(ann), null);
  });

  it('zero radius circle → null', () => {
    const ann = { cx: 0, cy: 0, r: 0, knownValue: 1, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(ann), null);
  });

  it('non-finite known value → null', () => {
    const ann = { x1: 0, y1: 0, x2: 100, y2: 0, knownValue: NaN, unit: 'mm' };
    assert.equal(calibrationPixelsPerMm(ann), null);
  });
});

// ── Undo-sequence invariant (BUG 2) ──────────────────────────────────────────
//
// The real applyCalibration lives in annotations.js, which cannot be imported
// under Node (DOM access at module scope in its import graph). This mirrors
// the exact mutation sequence applyCalibration now performs against the real
// state.js undo machinery, and replicates the restore logic of undo()
// (events-keyboard.js: pop → JSON.parse → assign) to assert that ONE undo step
// lands on a consistent pre-calibration state.

function restoreLikeUndo() {
  // Mirrors undo() in frontend/events-keyboard.js (DOM-bound, not importable)
  redoStack.push(takeSnapshot());
  const snap = JSON.parse(undoStack.pop());
  state.annotations = snap.annotations;
  state.calibration = snap.calibration;
  state.origin = snap.origin;
  state.constraints = snap.constraints ?? [];
}

function applyCalibrationSequence(ann) {
  // Mirrors the fixed applyCalibration in frontend/annotations.js:
  //   1. single pushUndo BEFORE any mutation
  //   2. remove existing calibration annotation
  //   3. set state.calibration from the pure helper
  //   4. append the annotation WITHOUT an inner pushUndo (skipUndo)
  const ppm = calibrationPixelsPerMm(ann);
  if (ppm == null) return;
  pushUndo();
  state.annotations = state.annotations.filter(a => a.type !== 'calibration');
  state.calibration = { pixelsPerMm: ppm, displayUnit: ann.unit };
  state.annotations.push({ ...ann, id: state.nextId++, name: '', purpose: 'measurement' });
}

describe('applyCalibration undo sequence (BUG 2)', () => {
  beforeEach(() => {
    undoStack.length = 0;
    redoStack.length = 0;
    state.annotations = [];
    state.calibration = null;
    state.origin = null;
    state.constraints = [];
    state.selected = new Set();
    state.nextId = 1;
  });

  it('pushes exactly ONE undo entry per calibration', () => {
    applyCalibrationSequence({ type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 1, unit: 'mm' });
    assert.equal(undoStack.length, 1, 'one calibration must create one undo step');
  });

  it('one undo restores calibration AND annotations together (no inconsistent intermediate)', () => {
    // Pre-existing calibration
    applyCalibrationSequence({ type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 1, unit: 'mm' });
    const oldPpm = state.calibration.pixelsPerMm;
    const oldAnnCount = state.annotations.length;

    // Recalibrate
    applyCalibrationSequence({ type: 'calibration', x1: 0, y1: 0, x2: 200, y2: 0, knownValue: 1, unit: 'mm' });
    assert.equal(state.calibration.pixelsPerMm, 200);
    assert.equal(undoStack.length, 2);

    // A single undo must land on the FULLY consistent previous state:
    // old scale AND the old calibration annotation, never "new scale +
    // no calibration annotation" (the old double-push intermediate).
    restoreLikeUndo();
    assert.equal(state.calibration.pixelsPerMm, oldPpm, 'scale must revert in one step');
    assert.equal(state.annotations.length, oldAnnCount, 'annotation list must revert in the same step');
    const calAnns = state.annotations.filter(a => a.type === 'calibration');
    assert.equal(calAnns.length, 1, 'previous calibration annotation must be back');
    assert.equal(calAnns[0].x2, 100, 'restored annotation geometry must match restored scale');
  });

  it('undoing the very first calibration lands on no-calibration state', () => {
    applyCalibrationSequence({ type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 1, unit: 'mm' });
    restoreLikeUndo();
    assert.equal(state.calibration, null);
    assert.equal(state.annotations.filter(a => a.type === 'calibration').length, 0);
    assert.equal(undoStack.length, 0, 'stack must be empty — no second phantom step');
  });
});

describe('measurementPixelSpan', () => {
  it('distance: endpoint separation as a length', () => {
    const r = measurementPixelSpan({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 30, y: 40 } });
    assert.deepStrictEqual(r, { span: 50, kind: 'length' });
  });

  it('perp-dist, para-dist and center-dist use the same endpoints', () => {
    for (const type of ['perp-dist', 'para-dist', 'center-dist']) {
      const r = measurementPixelSpan({ type, a: { x: 0, y: 0 }, b: { x: 3, y: 4 } });
      assert.deepStrictEqual(r, { span: 5, kind: 'length' }, type);
    }
  });

  it('spline: arc length', () => {
    const r = measurementPixelSpan({ type: 'spline', length_px: 123.5 });
    assert.deepStrictEqual(r, { span: 123.5, kind: 'length' });
  });

  it('circle and arc-fit: diameter, not radius', () => {
    assert.deepStrictEqual(measurementPixelSpan({ type: 'circle', r: 25 }),
      { span: 50, kind: 'diameter' });
    assert.deepStrictEqual(measurementPixelSpan({ type: 'arc-fit', r: 10 }),
      { span: 20, kind: 'diameter' });
    assert.deepStrictEqual(measurementPixelSpan({ type: 'arc-measure', r: 4 }),
      { span: 8, kind: 'diameter' });
  });

  it('area: polygon area in px squared', () => {
    const square = { type: 'area', points: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };
    assert.deepStrictEqual(measurementPixelSpan(square), { span: 10000, kind: 'area' });
  });

  it('returns null for types with no self-contained scale', () => {
    // angle/parallelism are dimensionless; fit-line is a flatness zone;
    // slot-dist/pt-circle-dist/intersect are derived from other annotations.
    for (const type of ['angle', 'parallelism', 'fit-line', 'comment', 'point',
                        'slot-dist', 'pt-circle-dist', 'intersect', 'detected-circle']) {
      assert.equal(measurementPixelSpan({ type }), null, type);
    }
    assert.equal(measurementPixelSpan(null), null);
  });

  it('returns null for degenerate geometry', () => {
    assert.equal(measurementPixelSpan({ type: 'distance', a: { x: 5, y: 5 }, b: { x: 5, y: 5 } }), null);
    assert.equal(measurementPixelSpan({ type: 'circle', r: 0 }), null);
    assert.equal(measurementPixelSpan({ type: 'area', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), null);
  });
});

describe('parseAreaInput', () => {
  it('parses mm² in both spellings', () => {
    assert.deepStrictEqual(parseAreaInput('25 mm²'), { value: 25, unit: 'mm', mm2: 25 });
    assert.deepStrictEqual(parseAreaInput('25 mm2'), { value: 25, unit: 'mm', mm2: 25 });
  });

  it('parses µm² and converts to mm²', () => {
    assert.deepStrictEqual(parseAreaInput('4000 µm²'), { value: 4000, unit: 'µm', mm2: 0.004 });
    assert.deepStrictEqual(parseAreaInput('4000 um2'), { value: 4000, unit: 'µm', mm2: 0.004 });
  });

  it('treats a bare number as mm²', () => {
    assert.deepStrictEqual(parseAreaInput('25'), { value: 25, unit: 'mm', mm2: 25 });
  });

  it('returns null for garbage without alerting', () => {
    assert.equal(parseAreaInput('wide'), null);
    assert.equal(parseAreaInput(''), null);
    assert.equal(parseAreaInput('25 inches'), null);
  });
});

describe('calibrationPpmFromMeasurement', () => {
  it('length: pixels per mm is span over known', () => {
    assert.equal(calibrationPpmFromMeasurement(500, 'length', 2), 250);
  });

  it('diameter behaves identically to length', () => {
    assert.equal(calibrationPpmFromMeasurement(500, 'diameter', 2), 250);
  });

  it('area: uniform scale is the square root of the area ratio', () => {
    // 10000 px² over 4 mm² -> 2500 px²/mm² -> 50 px/mm
    assert.equal(calibrationPpmFromMeasurement(10000, 'area', 4), 50);
  });

  it('returns null on degenerate input', () => {
    assert.equal(calibrationPpmFromMeasurement(0, 'length', 2), null);
    assert.equal(calibrationPpmFromMeasurement(500, 'length', 0), null);
    assert.equal(calibrationPpmFromMeasurement(NaN, 'length', 2), null);
    assert.equal(calibrationPpmFromMeasurement(500, 'length', NaN), null);
    assert.equal(calibrationPpmFromMeasurement(500, 'nonsense', 2), null);
  });
});
