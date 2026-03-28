/**
 * Tests for formatCsvValue from frontend/format.js.
 * Run with: node --test tests/frontend/test_csv.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stub alert (polygonArea's dependency math.js may call it)
globalThis.alert = globalThis.alert || (() => {});

import { formatCsvValue } from '../../frontend/format.js';

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

  it('arc-measure returns a string', () => {
    const ann = { type: 'arc-measure', r: 100, span_deg: 90, chord_px: 141.4, cx: 50, cy: 50 };
    const r = formatCsvValue(ann, null, 640);
    assert.equal(typeof r, 'string');
    assert.ok(r.includes('r='), `expected string to include "r=", got: ${r}`);
  });

  it('unknown type returns empty value/unit', () => {
    const ann = { type: 'totally-unknown' };
    assert.deepStrictEqual(formatCsvValue(ann, null, 640), { value: '', unit: '' });
  });
});
