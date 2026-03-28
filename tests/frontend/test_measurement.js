/**
 * Tests for measurementLabel from frontend/format.js.
 * Run with: node --test tests/frontend/test_measurement.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stub alert (polygonArea's dependency math.js may call it)
globalThis.alert = globalThis.alert || (() => {});

import { measurementLabel } from '../../frontend/format.js';

const CTX = { calibration: null, annotations: [], origin: null, imageWidth: 640, imageHeight: 480, canvasWidth: 640, canvasHeight: 480 };
const CAL_CTX = { ...CTX, calibration: { pixelsPerMm: 100, displayUnit: 'mm' } };
const CAL_UM_CTX = { ...CTX, calibration: { pixelsPerMm: 100, displayUnit: '\u00b5m' } };

describe('measurementLabel', () => {
  it('distance uncalibrated', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    assert.equal(measurementLabel(ann, CTX), '500.0 px');
  });

  it('distance calibrated mm', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    assert.equal(measurementLabel(ann, CAL_CTX), '5.000 mm');
  });

  it('distance calibrated \u00b5m', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    assert.equal(measurementLabel(ann, CAL_UM_CTX), '5000.00 \u00b5m');
  });

  it('center-dist uncalibrated', () => {
    const ann = { type: 'center-dist', a: { x: 0, y: 0 }, b: { x: 30, y: 40 } };
    assert.equal(measurementLabel(ann, CTX), '50.0 px');
  });

  it('angle 90 degrees', () => {
    const ann = { type: 'angle', vertex: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, p3: { x: 0, y: 1 } };
    assert.equal(measurementLabel(ann, CTX), '90.00\u00b0');
  });

  it('circle uncalibrated', () => {
    const ann = { type: 'circle', cx: 100, cy: 100, r: 50 };
    assert.equal(measurementLabel(ann, CTX), '\u2300 100.0 px');
  });

  it('circle calibrated mm', () => {
    const ann = { type: 'circle', cx: 100, cy: 100, r: 50 };
    assert.equal(measurementLabel(ann, CAL_CTX), '\u2300 1.000 mm');
  });

  it('arc-measure uncalibrated', () => {
    const ann = { type: 'arc-measure', r: 100, span_deg: 90 };
    assert.equal(measurementLabel(ann, CTX), 'r 100.0 px  90\u00b0');
  });

  it('perp-dist uncalibrated', () => {
    const ann = { type: 'perp-dist', a: { x: 0, y: 0 }, b: { x: 0, y: 100 } };
    assert.equal(measurementLabel(ann, CTX), '\u22a5 100.0 px');
  });

  it('para-dist uncalibrated', () => {
    const ann = { type: 'para-dist', a: { x: 0, y: 0 }, b: { x: 0, y: 50 } };
    assert.equal(measurementLabel(ann, CTX), '\u2225 50.0 px');
  });

  it('parallelism', () => {
    const ann = { type: 'parallelism', angleDeg: 1.5 };
    assert.equal(measurementLabel(ann, CTX), '\u2225 1.50\u00b0');
  });

  it('area uncalibrated (10x10 square)', () => {
    const ann = { type: 'area', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
    assert.equal(measurementLabel(ann, CTX), '\u25a1 100.0 px\u00b2');
  });

  it('calibration line', () => {
    const ann = { type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 1, unit: 'mm' };
    assert.equal(measurementLabel(ann, CTX), '\u27f7 1 mm');
  });

  it('calibration circle', () => {
    const ann = { type: 'calibration', knownValue: 5, unit: 'mm' };
    assert.equal(measurementLabel(ann, CTX), '\u2300 5 mm');
  });

  it('origin returns empty string', () => {
    const ann = { type: 'origin' };
    assert.equal(measurementLabel(ann, CTX), '');
  });

  it('detected-circle scales by imageWidth/frameWidth', () => {
    const ann = { type: 'detected-circle', x: 100, y: 100, radius: 25, frameWidth: 320, frameHeight: 240 };
    // sx = 640/320 = 2, diam = 25*2*2 = 100
    assert.equal(measurementLabel(ann, CTX), '\u2300 100.0 px');
  });

  it('detected-line scales length', () => {
    const ann = { type: 'detected-line', x1: 0, y1: 0, x2: 100, y2: 0, length: 100, frameWidth: 640, frameHeight: 480 };
    // sx = 640/640 = 1, len = 100
    assert.equal(measurementLabel(ann, CTX), '100.0 px');
  });

  it('pt-circle-dist with circle ref', () => {
    const circle = { id: 'c1', type: 'circle', cx: 0, cy: 0, r: 50 };
    const ann = { type: 'pt-circle-dist', circleId: 'c1', px: 100, py: 0 };
    const ctx = { ...CTX, annotations: [circle] };
    // dist = 100, gap = 100-50 = 50
    assert.equal(measurementLabel(ann, ctx), '\u2299 50.0 px');
  });

  it('pt-circle-dist with missing ref', () => {
    const ann = { type: 'pt-circle-dist', circleId: 'gone', px: 100, py: 0 };
    assert.equal(measurementLabel(ann, CTX), '\u2299 ref deleted');
  });

  it('slot-dist with two parallel lines', () => {
    const lineA = { id: 'a', type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const lineB = { id: 'b', type: 'distance', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } };
    const ann = { type: 'slot-dist', lineAId: 'a', lineBId: 'b' };
    const ctx = { ...CTX, annotations: [lineA, lineB] };
    assert.equal(measurementLabel(ann, ctx), '\u27fa 50.0 px');
  });

  it('unknown type returns empty string', () => {
    const ann = { type: 'totally-unknown' };
    assert.equal(measurementLabel(ann, CTX), '');
  });
});
