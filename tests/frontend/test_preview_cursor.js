import './dom-stub.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreviewCursor } from '../../frontend/render-hud.js';
import { subpixelPreviewApplies } from '../../frontend/events-mouse.js';

describe('resolvePreviewCursor — preview matches the click path', () => {
  const pc = { x: 100, y: 100, annotationSnapped: false };
  const sub = { x: 103.4, y: 98.2 };
  it('uses the sub-pixel target when annotation snap did not fire', () =>
    assert.deepEqual(resolvePreviewCursor(pc, sub), sub));
  it('annotation snap wins over the sub-pixel target (click skips refine)', () =>
    assert.deepEqual(resolvePreviewCursor({ ...pc, annotationSnapped: true }, sub),
                     { x: 100, y: 100, annotationSnapped: true }));
  it('falls back to the cursor when no sub-pixel target exists', () =>
    assert.deepEqual(resolvePreviewCursor(pc, null), pc));
  it('null cursor stays null (no preview active)', () =>
    assert.equal(resolvePreviewCursor(null, sub), null));
});

describe('subpixelPreviewApplies — marker gate mirrors the click refine gate', () => {
  it('relation pick/fit tools always show the marker', () => {
    for (const t of ['pt-circle-dist', 'slot-dist', 'intersect']) {
      assert.equal(subpixelPreviewApplies(t, null), true, t);
    }
  });
  it('center-dist: no marker while picking, marker while inline-fitting', () => {
    assert.equal(subpixelPreviewApplies('center-dist', null), false);
    assert.equal(subpixelPreviewApplies('center-dist', { kind: 'circle' }), true);
  });
  it('non-refining tools stay off', () => {
    assert.equal(subpixelPreviewApplies('select', null), false);
    assert.equal(subpixelPreviewApplies('pan', null), false);
  });
  it('existing measurement tools unchanged', () => {
    assert.equal(subpixelPreviewApplies('circle', null), true);
  });
});
