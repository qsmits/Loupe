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
import { getLineEndpoints, lineAngleDeg, measurementLabel } from '../../frontend/format.js';

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
