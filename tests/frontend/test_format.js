/**
 * Tests for frontend/format.js pure formatting functions.
 *
 * getLineEndpoints must map detected-line coordinates from frame space
 * (frameWidth/frameHeight = size of the frame detection ran on) into image
 * space using imageWidth/frameWidth — never canvas dimensions. When no ctx
 * is supplied, or frame dimensions are missing, the scale must default to 1
 * (correct in the common case frameWidth === imageWidth), not collapse the
 * endpoints toward the origin.
 *
 * Run with: node --test tests/frontend/test_format.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLineEndpoints, lineAngleDeg, measurementLabel,
  measurementNumeric, centerDistPx, formatCsvValue,
  fullMeasurementLabel,
} from '../../frontend/format.js';

// Stub alert (polygonArea's dependency math.js may call it)
globalThis.alert = globalThis.alert || (() => {});

const detectedLine = (overrides = {}) => ({
  type: 'detected-line',
  x1: 100, y1: 200, x2: 300, y2: 400,
  frameWidth: 1000, frameHeight: 800,
  ...overrides,
});

describe('getLineEndpoints — detected-line', () => {
  it('identity when frameWidth === imageWidth', () => {
    const ep = getLineEndpoints(detectedLine(), { imageWidth: 1000, imageHeight: 800 });
    assert.deepStrictEqual(ep, { a: { x: 100, y: 200 }, b: { x: 300, y: 400 } });
  });

  it('scales proportionally when frameWidth !== imageWidth', () => {
    const ep = getLineEndpoints(detectedLine(), { imageWidth: 2000, imageHeight: 1600 });
    assert.deepStrictEqual(ep, { a: { x: 200, y: 400 }, b: { x: 600, y: 800 } });
  });

  it('defaults to identity when no ctx is passed (no collapse to origin)', () => {
    const ep = getLineEndpoints(detectedLine());
    assert.deepStrictEqual(ep, { a: { x: 100, y: 200 }, b: { x: 300, y: 400 } });
  });

  it('defaults to identity when frame dimensions are missing', () => {
    const ep = getLineEndpoints(
      detectedLine({ frameWidth: undefined, frameHeight: undefined }),
      { imageWidth: 2000, imageHeight: 1600 },
    );
    assert.deepStrictEqual(ep, { a: { x: 100, y: 200 }, b: { x: 300, y: 400 } });
  });
});

describe('getLineEndpoints — other types', () => {
  it('distance passes a/b through untouched', () => {
    const ann = { type: 'distance', a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    const ep = getLineEndpoints(ann);
    assert.deepStrictEqual(ep, { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
  });

  it('two-point calibration maps x1/y1/x2/y2', () => {
    const ann = { type: 'calibration', x1: 5, y1: 6, x2: 7, y2: 8 };
    const ep = getLineEndpoints(ann);
    assert.deepStrictEqual(ep, { a: { x: 5, y: 6 }, b: { x: 7, y: 8 } });
  });

  it('returns null for non-line types', () => {
    assert.equal(getLineEndpoints({ type: 'circle', cx: 0, cy: 0, r: 5 }), null);
  });
});

describe('lineAngleDeg', () => {
  it('45 degrees for a detected-line along y=x with no ctx', () => {
    const ann = detectedLine({ x1: 0, y1: 0, x2: 100, y2: 100 });
    assert.ok(Math.abs(lineAngleDeg(ann) - 45) < 1e-9);
  });

  it('angle is scale-invariant under uniform frame scaling', () => {
    const ann = detectedLine({ x1: 0, y1: 0, x2: 100, y2: 100 });
    const a1 = lineAngleDeg(ann, { imageWidth: 1000, imageHeight: 800 });
    const a2 = lineAngleDeg(ann, { imageWidth: 2000, imageHeight: 1600 });
    assert.ok(Math.abs(a1 - a2) < 1e-9);
  });
});

describe('measurementLabel — pt-circle-dist referencing a detected-circle', () => {
  it('uses image-space scale for the referenced circle', () => {
    const circle = {
      id: 1, type: 'detected-circle',
      x: 500, y: 400, radius: 100,
      frameWidth: 1000, frameHeight: 800,
    };
    const ann = { type: 'pt-circle-dist', circleId: 1, px: 1000, py: 200 };
    // imageWidth 2000 → sx = 2: center (1000, 800), r 200.
    // dist from (1000,200) = 600 → gap = 400.
    const label = measurementLabel(ann, {
      calibration: null,
      annotations: [circle],
      imageWidth: 2000, imageHeight: 1600,
    });
    assert.equal(label, '⊙ 400.0 px');
  });

  it('identity scale when frameWidth === imageWidth', () => {
    const circle = {
      id: 1, type: 'detected-circle',
      x: 500, y: 400, radius: 100,
      frameWidth: 1000, frameHeight: 800,
    };
    const ann = { type: 'pt-circle-dist', circleId: 1, px: 500, py: 100 };
    // dist = 300 → gap = 200.
    const label = measurementLabel(ann, {
      calibration: null,
      annotations: [circle],
      imageWidth: 1000, imageHeight: 800,
    });
    assert.equal(label, '⊙ 200.0 px');
  });
});

describe('centerDistPx', () => {
  it('plain center-to-center pixel distance', () => {
    const ann = { type: 'center-dist', a: { x: 0, y: 0 }, b: { x: 30, y: 40 } };
    assert.equal(centerDistPx(ann, {}), 50);
  });
});

describe('measurementNumeric', () => {
  const cal = { pixelsPerMm: 100, displayUnit: 'mm' };

  it('distance in mm when calibrated', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    assert.deepEqual(measurementNumeric(ann, { calibration: cal }), { value: 5, unit: 'mm' });
  });

  it('distance in px when uncalibrated', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 30, y: 40 } };
    assert.deepEqual(measurementNumeric(ann, {}), { value: 50, unit: 'px' });
  });

  it('circle reports diameter', () => {
    const ann = { type: 'circle', cx: 0, cy: 0, r: 100 };
    assert.deepEqual(measurementNumeric(ann, { calibration: cal }), { value: 2, unit: 'mm' });
  });

  it('parallelism reports degrees', () => {
    const ann = { type: 'parallelism', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, angleDeg: 1.25 };
    assert.deepEqual(measurementNumeric(ann, {}), { value: 1.25, unit: '°' });
  });

  it('pt-circle-dist resolves the referenced circle', () => {
    const circle = { id: 1, type: 'circle', cx: 0, cy: 0, r: 100 };
    const ann = { type: 'pt-circle-dist', circleId: 1, px: 300, py: 0 };
    assert.deepEqual(measurementNumeric(ann, { calibration: cal, annotations: [circle, ann] }),
                     { value: 2, unit: 'mm' });  // 300px to center − 100px radius = 200px = 2mm
  });

  it('slot-dist resolves both referenced lines', () => {
    const l1 = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const l2 = { id: 2, type: 'distance', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } };
    const ann = { type: 'slot-dist', lineAId: 1, lineBId: 2 };
    assert.deepEqual(measurementNumeric(ann, { calibration: cal, annotations: [l1, l2, ann] }),
                     { value: 0.5, unit: 'mm' });
  });

  it('returns null for valueless types', () => {
    assert.equal(measurementNumeric({ type: 'comment', text: 'x' }, {}), null);
    assert.equal(measurementNumeric({ type: 'intersect', lineAId: 1, lineBId: 2 }, {}), null);
    assert.equal(measurementNumeric({ type: 'point', x: 1, y: 1 }, {}), null);
    assert.equal(measurementNumeric({ type: 'origin', x: 0, y: 0 }, {}), null);
  });

  it('returns null when a ref-resolving type points at a missing annotation', () => {
    assert.equal(measurementNumeric({ type: 'pt-circle-dist', circleId: 99, px: 0, py: 0 },
                                     { calibration: cal, annotations: [] }), null);
    assert.equal(measurementNumeric({ type: 'slot-dist', lineAId: 1, lineBId: 2 },
                                     { calibration: cal, annotations: [] }), null);
  });

  it('label parity: numeric matches the number printed in the label', () => {
    const circle = { id: 1, type: 'circle', cx: 0, cy: 0, r: 40 };
    const l1 = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const l2 = { id: 2, type: 'distance', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } };
    const cases = [
      { ann: { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } } },
      { ann: { type: 'circle', cx: 0, cy: 0, r: 123 } },
      { ann: { type: 'center-dist', a: { x: 0, y: 0 }, b: { x: 250, y: 0 } } },
      { ann: { type: 'perp-dist', a: { x: 0, y: 0 }, b: { x: 0, y: 170 } } },
      { ann: { type: 'para-dist', a: { x: 0, y: 0 }, b: { x: 90, y: 0 } } },
      { ann: { type: 'angle', vertex: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, p3: { x: 0, y: 1 } } },
      { ann: { type: 'parallelism', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, angleDeg: 1.25 } },
      { ann: { type: 'arc-fit', startAngle: 0, r: 120 } },        // arc branch: R
      { ann: { type: 'arc-fit', r: 60 } },                        // full-circle branch: ⌀
      { ann: { type: 'fit-line', zoneWidth: 30 } },
      { ann: { type: 'arc-measure', r: 100, span_deg: 90, chord_px: 141.4, cx: 50, cy: 50 } },
      { ann: { type: 'spline', length_px: 250 } },
      // mm-unit only: a µm-declared calibration intentionally breaks label
      // parity (measurementNumeric normalizes to mm; the label prints
      // knownValue verbatim in ann.unit) — covered separately below, not here.
      { ann: { type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 5, unit: 'mm' } },
      { ann: { type: 'area', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] } },
      { ann: { type: 'detected-arc-partial', r: 80, start_deg: 10, end_deg: 100 } },
      {
        ann: { type: 'detected-circle', radius: 50, frameWidth: 500 },
        ctx: { imageWidth: 1000 },
      },
      {
        ann: { type: 'detected-line', length: 150, frameWidth: 300 },
        ctx: { imageWidth: 600 },
      },
      {
        ann: { type: 'detected-line-merged', x1: 0, y1: 0, x2: 100, y2: 0, frameWidth: 200 },
        ctx: { imageWidth: 400 },
      },
      {
        ann: { type: 'pt-circle-dist', circleId: 1, px: 300, py: 0 },
        ctx: { annotations: [circle] },
      },
      {
        ann: { type: 'slot-dist', lineAId: 1, lineBId: 2 },
        ctx: { annotations: [l1, l2] },
      },
    ];
    for (const { ann, ctx: extra = {} } of cases) {
      const fullCtx = { calibration: cal, annotations: [], ...extra };
      const n = measurementNumeric(ann, fullCtx);
      const label = measurementLabel(ann, fullCtx);
      const printed = parseFloat(label.replace(/[^\d.\-]+/g, ' ').trim().split(/\s+/)[0]);
      assert.ok(n, `${ann.type}: measurementNumeric returned null`);
      assert.ok(Number.isFinite(n.value), `${ann.type}: numeric value is not finite (${n.value})`);
      assert.ok(Math.abs(n.value - printed) < 0.002,
        `${ann.type}: numeric ${n.value} vs label "${label}"`);
    }
  });

  it('calibration normalizes µm to mm (SSOT contract)', () => {
    // Deliberately excluded from the label-parity loop above: the label
    // prints ann.knownValue verbatim in ann.unit ("500 µm"), while
    // measurementNumeric normalizes to mm per the mm/px/°/mm²/px² contract
    // — these two numbers (500 vs 0.5) are expected to diverge.
    const ann = { type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 500, unit: 'µm' };
    assert.deepEqual(measurementNumeric(ann, {}), { value: 0.5, unit: 'mm' });
    const label = measurementLabel(ann, {});
    assert.equal(label, '⟷ 500 µm'); // verbatim — intentionally not 0.5 mm
  });

  it('detected-circle stays finite when ctx.imageWidth is missing', () => {
    const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
    const ann = { type: 'detected-circle', x: 0, y: 0, radius: 50, frameWidth: 500 };
    // No ctx.imageWidth → scale must fall back to 1 (frameWidth/frameWidth),
    // never (undefined / frameWidth) === NaN.
    const n = measurementNumeric(ann, { calibration: cal });
    assert.ok(Number.isFinite(n.value), `expected finite value, got ${n.value}`);
    assert.deepEqual(n, { value: 1, unit: 'mm' }); // radius 50 * 2 / 100 ppm
  });
});

describe('formatCsvValue regressions', () => {
  it('arc-measure returns {value, unit} (was a bare string)', () => {
    // Fixture uses the fields the real measurementLabel arc-measure branch
    // reads (r, span_deg, chord_px, cx, cy) — not p1/p2/p3.
    const ann = { type: 'arc-measure', r: 100, span_deg: 90, chord_px: 141.4, cx: 50, cy: 50 };
    const out = formatCsvValue(ann, { pixelsPerMm: 100, displayUnit: 'mm' }, 1000);
    assert.equal(typeof out.value, 'string');
    assert.ok(out.unit.length > 0);
    assert.ok(out.value.includes('r='));
  });

  it('calibration CSV row normalizes µm to mm, formatted to mm precision', () => {
    const ann = { type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 500, unit: 'µm' };
    const out = formatCsvValue(ann, { pixelsPerMm: 100, displayUnit: 'mm' }, 1000);
    assert.deepEqual(out, { value: '0.500', unit: 'mm' });
  });

  it('pt-circle-dist no longer exports blank', () => {
    const circle = { id: 1, type: 'circle', cx: 0, cy: 0, r: 100 };
    const ann = { type: 'pt-circle-dist', circleId: 1, px: 300, py: 0 };
    const out = formatCsvValue(ann, null, 1000, { annotations: [circle, ann] });
    assert.notEqual(out.value, '');
  });

  it('slot-dist no longer exports blank', () => {
    const l1 = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const l2 = { id: 2, type: 'distance', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } };
    const ann = { type: 'slot-dist', lineAId: 1, lineBId: 2 };
    const out = formatCsvValue(ann, null, 1000, { annotations: [l1, l2, ann] });
    assert.notEqual(out.value, '');
  });

  it('intersect no longer exports blank', () => {
    const l1 = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    const l2 = { id: 2, type: 'distance', a: { x: 50, y: -50 }, b: { x: 50, y: 50 } };
    const ann = { type: 'intersect', lineAId: 1, lineBId: 2 };
    const out = formatCsvValue(ann, null, 1000, { annotations: [l1, l2, ann] });
    assert.notEqual(out.value, '');
    assert.equal(out.unit, 'px');
  });
});

describe('fullMeasurementLabel', () => {
  const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
  const base = { id: 7, type: 'distance', a: { x: 0, y: 0 }, b: { x: 362.5, y: 0 }, purpose: 'measurement' };
  it('plain measurement: [n] value', () => {
    const { text, edge } = fullMeasurementLabel({ ...base, name: '' }, { calibration: cal }, 3);
    assert.equal(text, '[3] 3.625 mm');
    assert.equal(edge, null);
  });
  it('named + spec: [n] name value ▲dev, pass edge', () => {
    const ann = { ...base, name: 'hole-pitch', spec: { nominal: 3.6, upper: 0.05, lower: -0.05 } };
    const { text, edge } = fullMeasurementLabel(ann, { calibration: cal }, 3);
    assert.equal(text, '[3] hole-pitch 3.625 mm ▲+0.025 mm');
    assert.equal(edge, 'pass');
  });
  it('failing spec gets fail edge', () => {
    const ann = { ...base, spec: { nominal: 3.6, upper: 0.01, lower: -0.01 } };
    assert.equal(fullMeasurementLabel(ann, { calibration: cal }, 1).edge, 'fail');
  });
});
