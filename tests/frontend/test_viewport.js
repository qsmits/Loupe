/**
 * Tests for frontend/viewport.js pure transform functions.
 * Run with: node --test tests/frontend/test_viewport.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { imageToScreenPure, screenToImagePure } from '../../frontend/viewport.js';

describe('imageToScreenPure', () => {
  it('identity at zoom=1, pan=0,0', () => {
    const vp = { zoom: 1, panX: 0, panY: 0 };
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 50, y: 50 });
  });

  it('zoom only (zoom=2, pan=0): (50,50) -> (100,100)', () => {
    const vp = { zoom: 2, panX: 0, panY: 0 };
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 100, y: 100 });
  });

  it('pan only (zoom=1, pan=10,20): (50,50) -> (40,30)', () => {
    const vp = { zoom: 1, panX: 10, panY: 20 };
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 40, y: 30 });
  });

  it('zoom + pan combined', () => {
    const vp = { zoom: 3, panX: 10, panY: 20 };
    // (50-10)*3 = 120, (50-20)*3 = 90
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 120, y: 90 });
  });

  it('fractional zoom (zoom=0.5)', () => {
    const vp = { zoom: 0.5, panX: 0, panY: 0 };
    const r = imageToScreenPure(100, 200, vp);
    assert.deepStrictEqual(r, { x: 50, y: 100 });
  });
});

describe('screenToImagePure', () => {
  it('identity at zoom=1, pan=0,0', () => {
    const vp = { zoom: 1, panX: 0, panY: 0 };
    const r = screenToImagePure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 50, y: 50 });
  });

  it('round-trip with non-trivial zoom/pan', () => {
    const vp = { zoom: 2.5, panX: 17, panY: -33 };
    const orig = { x: 123.456, y: 789.012 };
    const screen = imageToScreenPure(orig.x, orig.y, vp);
    const back = screenToImagePure(screen.x, screen.y, vp);
    assert.ok(Math.abs(back.x - orig.x) < 1e-10, `x: expected ${orig.x}, got ${back.x}`);
    assert.ok(Math.abs(back.y - orig.y) < 1e-10, `y: expected ${orig.y}, got ${back.y}`);
  });
});
