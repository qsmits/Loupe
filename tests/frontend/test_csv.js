/**
 * Tests for formatCsvValue from frontend/format.js and buildCsvRows from
 * frontend/session.js.
 * Run with: node --test tests/frontend/test_csv.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// dom-stub must be imported before any frontend module that touches the DOM
// at load time (session.js pulls in render.js/sidebar.js, which do).
import './dom-stub.js';

// Stub alert (polygonArea's dependency math.js may call it)
globalThis.alert = globalThis.alert || (() => {});

import { formatCsvValue } from '../../frontend/format.js';
import { buildCsvRows } from '../../frontend/session.js';

describe('formatCsvValue', () => {
  it('distance calibrated mm', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
    assert.deepStrictEqual(formatCsvValue(ann, cal, 640), { value: '5.000', unit: 'mm' });
  });

  it('distance uncalibrated', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    assert.deepStrictEqual(formatCsvValue(ann, null, 640), { value: '500.0', unit: 'px' });
  });

  it('angle 90 degrees', () => {
    const ann = { type: 'angle', vertex: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, p3: { x: 0, y: 1 } };
    assert.deepStrictEqual(formatCsvValue(ann, null, 640), { value: '90.00', unit: '\u00b0' });
  });

  it('circle calibrated mm', () => {
    const ann = { type: 'circle', cx: 0, cy: 0, r: 50 };
    const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
    assert.deepStrictEqual(formatCsvValue(ann, cal, 640), { value: '1.000', unit: 'mm' });
  });

  it('detected-circle scales by imgWidth/frameWidth', () => {
    const ann = { type: 'detected-circle', x: 0, y: 0, radius: 25, frameWidth: 320, frameHeight: 240 };
    // sx = 640/320 = 2, diam = 25*2*2 = 100
    const r = formatCsvValue(ann, null, 640);
    assert.deepStrictEqual(r, { value: '100.0', unit: 'px' });
  });

  it('arc-measure returns {value, unit} (was a bare string)', () => {
    const ann = { type: 'arc-measure', r: 100, span_deg: 90, chord_px: 141.4, cx: 50, cy: 50 };
    const r = formatCsvValue(ann, null, 640);
    assert.equal(typeof r, 'object');
    assert.equal(typeof r.value, 'string');
    assert.ok(r.value.includes('r='), `expected value to include "r=", got: ${r.value}`);
    assert.ok(r.unit.length > 0);
  });

  it('unknown type returns empty value/unit', () => {
    const ann = { type: 'totally-unknown' };
    assert.deepStrictEqual(formatCsvValue(ann, null, 640), { value: '', unit: '' });
  });

  it('pt-circle-dist resolves via ctx.annotations (was blank)', () => {
    const circle = { id: 1, type: 'circle', cx: 0, cy: 0, r: 100 };
    const ann = { type: 'pt-circle-dist', circleId: 1, px: 300, py: 0 };
    const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
    const r = formatCsvValue(ann, cal, 640, { annotations: [circle, ann] });
    assert.deepStrictEqual(r, { value: '2.000', unit: 'mm' });
  });

  it('slot-dist resolves via ctx.annotations (was blank)', () => {
    const l1 = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const l2 = { id: 2, type: 'distance', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } };
    const ann = { type: 'slot-dist', lineAId: 1, lineBId: 2 };
    const r = formatCsvValue(ann, null, 640, { annotations: [l1, l2, ann] });
    assert.deepStrictEqual(r, { value: '50.0', unit: 'px' });
  });

  it('intersect exports coordinates instead of blank', () => {
    const l1 = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const l2 = { id: 2, type: 'distance', a: { x: 50, y: -50 }, b: { x: 50, y: 50 } };
    const ann = { type: 'intersect', lineAId: 1, lineBId: 2 };
    const r = formatCsvValue(ann, null, 640, { annotations: [l1, l2, ann] });
    assert.deepStrictEqual(r, { value: '50.0, 0.0', unit: 'px' });
  });
});

describe('buildCsvRows', () => {
  const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
  const mctx = { calibration: cal, annotations: [], origin: null };

  it('header includes the spec/tolerance columns', () => {
    const rows = buildCsvRows([], cal, 640, mctx);
    assert.deepEqual(rows[0], [
      "#", "Name", "Value", "Unit", "Nominal", "Upper", "Lower", "Deviation", "Result", "type", "label",
    ]);
  });

  it('spec columns blank for annotations without ann.spec', () => {
    const ann = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    const rows = buildCsvRows([ann], cal, 640, { ...mctx, annotations: [ann] });
    const [, name, value, unit, nominal, upper, lower, deviation, result] = rows[1];
    assert.equal(value, '5.000');
    assert.equal(unit, 'mm');
    assert.equal(nominal, '');
    assert.equal(upper, '');
    assert.equal(lower, '');
    assert.equal(deviation, '');
    assert.equal(result, '');
  });

  it('exports spec columns when ann.spec present (pass)', () => {
    const ann = {
      id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 362.5, y: 0 },
      spec: { nominal: 3.6, upper: 0.05, lower: -0.05 },
    };
    const rows = buildCsvRows([ann], cal, 640, { ...mctx, annotations: [ann] });
    const [, , value, unit, nominal, upper, lower, deviation, result] = rows[1];
    assert.equal(value, '3.625');
    assert.equal(unit, 'mm');
    assert.equal(nominal, '3.600');
    assert.equal(upper, '0.050');
    assert.equal(lower, '-0.050');
    assert.equal(deviation, '0.025');
    assert.equal(result, 'PASS');
  });

  it('exports FAIL when the deviation is out of tolerance', () => {
    const ann = {
      id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 362.5, y: 0 },
      spec: { nominal: 3.6, upper: 0.01, lower: -0.01 },
    };
    const rows = buildCsvRows([ann], cal, 640, { ...mctx, annotations: [ann] });
    assert.equal(rows[1][8], 'FAIL');
  });

  it('skips valueless annotations (origin/overlays) same as before', () => {
    const origin = { id: 1, type: 'origin', x: 0, y: 0 };
    const rows = buildCsvRows([origin], cal, 640, { ...mctx, annotations: [origin] });
    assert.equal(rows.length, 1); // header only
  });
});
