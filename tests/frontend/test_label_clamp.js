/**
 * Tests for clampBoxToView() — pure geometry behind off-viewport label
 * clamping (Track A #2). A measurement label whose natural anchor is outside
 * the visible viewport (e.g. the diameter label of a large fitted circle) is
 * translated back into view; a leader line to the true anchor is drawn by
 * render.js.
 *
 * Run with: node --test tests/frontend/test_label_clamp.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampBoxToView } from '../../frontend/label-clamp.js';

const view = { left: 100, top: 50, right: 900, bottom: 650 };

describe('clampBoxToView', () => {
  it('leaves a fully visible box untouched', () => {
    const r = clampBoxToView({ x: 400, y: 300, w: 80, h: 16 }, view, 8);
    assert.deepEqual(r, { dx: 0, dy: 0, clamped: false });
  });

  it('pulls a box left of the view to the padded left edge', () => {
    const r = clampBoxToView({ x: 20, y: 300, w: 80, h: 16 }, view, 8);
    assert.equal(r.dx, 100 + 8 - 20);
    assert.equal(r.dy, 0);
    assert.equal(r.clamped, true);
  });

  it('pulls a box past the right edge back inside', () => {
    const r = clampBoxToView({ x: 880, y: 300, w: 80, h: 16 }, view, 8);
    assert.equal(r.dx, (900 - 8) - (880 + 80));
    assert.equal(r.clamped, true);
  });

  it('clamps far-above anchors (diameter label of a large fitted circle)', () => {
    const r = clampBoxToView({ x: 400, y: -5000, w: 80, h: 16 }, view, 8);
    assert.equal(r.dy, (50 + 8) - (-5000));
    assert.equal(r.dx, 0);
    assert.equal(r.clamped, true);
  });

  it('clamps below-view boxes up to the padded bottom edge', () => {
    const r = clampBoxToView({ x: 400, y: 10000, w: 80, h: 16 }, view, 8);
    assert.equal(r.dy, (650 - 8) - (10000 + 16));
    assert.equal(r.clamped, true);
  });

  it('centers a box wider than the view instead of jamming it against an edge', () => {
    const r = clampBoxToView({ x: 0, y: 300, w: 2000, h: 16 }, view, 8);
    // padded span is [108, 892] → center 500; box center is 1000 → shift -500
    assert.equal(r.dx, -500);
    assert.equal(r.clamped, true);
  });

  it('applies both axes independently (corner case)', () => {
    const r = clampBoxToView({ x: -50, y: 700, w: 80, h: 16 }, view, 0);
    assert.equal(r.dx, 100 - (-50));
    assert.equal(r.dy, 650 - (700 + 16));
    assert.equal(r.clamped, true);
  });

  it('pad defaults to 0', () => {
    const r = clampBoxToView({ x: 100, y: 50, w: 80, h: 16 }, view);
    assert.deepEqual(r, { dx: 0, dy: 0, clamped: false });
  });
});
