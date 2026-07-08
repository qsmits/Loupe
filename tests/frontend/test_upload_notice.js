/**
 * Tests for isFrameUploadEndpoint() — the URL allow-list behind the hosted
 * server-upload notice (Track A #4). Matching endpoints read the per-session
 * frozen frame on the server; apiFetch awaits the one-time notice for them.
 *
 * Run with: node --test tests/frontend/test_upload_notice.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFrameUploadEndpoint, FRAME_UPLOAD_ENDPOINTS } from '../../frontend/upload-notice.js';

describe('isFrameUploadEndpoint', () => {
  it('matches every server-side frame-compute endpoint', () => {
    for (const url of [
      '/detect-edges', '/detect-circles', '/detect-lines', '/detect-lines-merged',
      '/detect-arcs-partial', '/preprocessed-view',
      '/align-dxf', '/align-dxf-edges',
      '/inspect-guided', '/fit-feature', '/refine-point', '/gradient-overlay',
      '/analyze-gear', '/detect-gear-teeth', '/auto-phase-gear',
    ]) {
      assert.equal(isFrameUploadEndpoint(url), true, url);
    }
  });

  it('the exported list and the matcher agree', () => {
    for (const p of FRAME_UPLOAD_ENDPOINTS) {
      assert.equal(isFrameUploadEndpoint(p), true, p);
    }
  });

  it('ignores query strings', () => {
    assert.equal(isFrameUploadEndpoint('/detect-circles?x=1'), true);
  });

  it('does not match frame uploads or unrelated endpoints', () => {
    for (const url of [
      '/freeze', '/load-image', '/update-frame', '/frame', '/stream',
      '/camera/info', '/config/ui', '/session/new', '/load-dxf', '/export-dxf',
      '/parts', '/zstack/compute', '/stitch/compute', '/superres/compute',
    ]) {
      assert.equal(isFrameUploadEndpoint(url), false, url);
    }
  });

  it('does not prefix-match into longer names (each endpoint is its own entry)', () => {
    assert.equal(isFrameUploadEndpoint('/align-dxfoo'), false);
    assert.equal(isFrameUploadEndpoint('/detect-edgesx'), false);
  });
});
