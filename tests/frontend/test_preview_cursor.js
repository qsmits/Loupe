import './dom-stub.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreviewCursor } from '../../frontend/render-hud.js';

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
