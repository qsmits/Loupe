import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, undoStack, redoStack } from '../../frontend/state.js';
import { captureImageGeometry, clearImageGeometry, restoreImageGeometry } from '../../frontend/image-geometry.js';
import { _computeDstCorners, _computeHomography } from '../../frontend/perspective-math.js';

test('perspective rectangle has one metric scale and maps all four measured corners', () => {
  const src = [{x:10,y:20},{x:100,y:10},{x:120,y:80},{x:0,y:90}];
  const dst = _computeDstCorners(src, 20, 10);
  const ppm = (dst[1].x-dst[0].x)/20;
  assert.ok(Math.abs((dst[2].y-dst[1].y)/10-ppm)<1e-10);
  const h = _computeHomography(src, dst);
  src.forEach((p,i) => {
    const d = h[2][0]*p.x+h[2][1]*p.y+h[2][2];
    assert.ok(Math.abs((h[0][0]*p.x+h[0][1]*p.y+h[0][2])/d-dst[i].x)<1e-8);
    assert.ok(Math.abs((h[1][0]*p.x+h[1][1]*p.y+h[1][2])/d-dst[i].y)<1e-8);
  });
});
test('warp clears stale geometry and undo restores it together with calibration', () => {
  state.annotations = [{type:'circle',cx:5,cy:8,r:3}];
  state.calibration = {pixelsPerMm:123};
  state.inspectionResults = [{pass:true}];
  undoStack.push('before'); redoStack.push('redo');
  const snapshot = captureImageGeometry();
  clearImageGeometry({pixelsPerMm:4});
  assert.equal(state.calibration.pixelsPerMm,4);
  assert.equal(state.annotations.length,0);
  assert.equal(state.inspectionResults.length,0);
  assert.equal(undoStack.length,0);
  restoreImageGeometry(snapshot);
  assert.equal(state.calibration.pixelsPerMm,123);
  assert.equal(state.annotations[0].r,3);
  assert.deepEqual(undoStack,['before']);
  assert.deepEqual(redoStack,['redo']);
});
