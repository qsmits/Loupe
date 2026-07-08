/**
 * Tests for canSeedImageSize() — the aspect-ratio band-aid guard
 * (Track A #5, PERMANENT — survives into Track B as the hidden-DOM guard).
 * render.js::resizeCanvas may only seed imageWidth/imageHeight from the DOM
 * when the microscope container is visible and the rect is non-degenerate;
 * seeding from a hidden 0×0 container bakes wrong dimensions into
 * image-space and shifts every annotation.
 *
 * Run with: node --test tests/frontend/test_can_seed_image_size.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canSeedImageSize } from '../../frontend/viewport.js';

describe('canSeedImageSize', () => {
  it('allows seeding from a visible, non-degenerate rect', () => {
    assert.equal(canSeedImageSize(800, 600, false), true);
  });

  it('rejects a hidden container even with a plausible rect', () => {
    assert.equal(canSeedImageSize(800, 600, true), false);
  });

  it('rejects 0x0 rects (hidden mode container collapses the viewer)', () => {
    assert.equal(canSeedImageSize(0, 0, false), false);
  });

  it('rejects 1px degenerate slivers on either axis', () => {
    assert.equal(canSeedImageSize(1, 600, false), false);
    assert.equal(canSeedImageSize(800, 1, false), false);
  });

  it('accepts the 2px minimum exactly', () => {
    assert.equal(canSeedImageSize(2, 2, false), true);
  });
});
