import {test} from 'node:test';
import assert from 'node:assert/strict';
import {circleRegionFromPoints, regionBounds, moveRegion, resizeRegion, regionContains, regionFromDrag} from '../../frontend/fringe-region.js';
import {zoomSurfaceAt, clampSurfacePan} from '../../frontend/fringe-viewport.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const circle = () => circleRegionFromPoints([{x: .7, y: .5}, {x: .5, y: .9}, {x: .3, y: .5}], 800, 400);

test('three clicks on a non-square image fit a circle in pixels, not normalized coordinates', () => {
  const r = circle();
  assert.equal(r.shape, 'circle');
  for (const p of r.vertices) near(Math.hypot((p.x - .5) * 800, (p.y - .5) * 400), 160);
  assert.equal(circleRegionFromPoints([{x: .2, y: .5}, {x: .4, y: .5}, {x: .8, y: .5}], 800, 400), null);
  assert.equal(circleRegionFromPoints([{x: .2, y: .2}, {x: .2, y: .2}, {x: .2, y: .2}], 800, 400), null);
  assert.equal(circleRegionFromPoints([{x: 0, y: 0}, {x: 1, y: 0}, {x: .5, y: 1}], 800, 400), null);
});

test('move clamps the whole region at image edges without deforming it', () => {
  const original = circle(), moved = moveRegion(original, 2, -2), b = regionBounds(moved);
  near(b.x1, 1); near(b.y0, 0);
  near(b.x1 - b.x0, .4); near(b.y1 - b.y0, .8);
  near(regionBounds(original).x0, .3);
  assert.equal(regionContains(moved, {x: .8, y: .4}), true);
  assert.equal(regionContains(moved, {x: .61, y: .01}), false);
});

test('corner resizing keeps a three-point circle round and inside the image', () => {
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const r = resizeRegion(circle(), corner, {x: corner.includes('w') ? .1 : .9, y: corner.includes('n') ? .1 : .9});
    const b = regionBounds(r);
    near((b.x1 - b.x0) * 800, (b.y1 - b.y0) * 400);
    assert.ok(b.x0 >= -1e-10 && b.y0 >= -1e-10 && b.x1 <= 1 + 1e-10 && b.y1 <= 1 + 1e-10);
  }
  const smaller = resizeRegion(circle(), 'se', {x: .5, y: .5});
  near(regionBounds(smaller).x1 - regionBounds(smaller).x0, .2);
});

test('rectangles resize independently on each axis and never invert', () => {
  const r = regionFromDrag({x: .2, y: .3}, {x: .6, y: .7}, 'rectangle', false);
  const resized = resizeRegion(r, 'se', {x: .9, y: .5});
  const b = regionBounds(resized);
  near(b.x0, .2); near(b.y0, .3); near(b.x1, .9); near(b.y1, .5);
  assert.equal(resized.include, false);
  const crossed = regionBounds(resizeRegion(r, 'nw', {x: .9, y: .9}));
  assert.ok(crossed.x1 > crossed.x0 && crossed.y1 > crossed.y0);
});

const view = {width: 1000, height: 600, imageWidth: 600, imageHeight: 600};
function imagePoint(state, cursor) {
  return {x: (cursor.x - (view.width - view.imageWidth) / 2 - state.x) / state.zoom,
    y: (cursor.y - (view.height - view.imageHeight) / 2 - state.y) / state.zoom};
}
test('surface zoom anchors to the centered image, including after panning', () => {
  const current = {zoom: 2, x: -250, y: -200}, cursor = {x: 550, y: 300};
  const next = zoomSurfaceAt(view, current, cursor, 1.15);
  const before = imagePoint(current, cursor), after = imagePoint(next, cursor);
  near(before.x, after.x); near(before.y, after.y);
  const back = zoomSurfaceAt(view, next, cursor, 1 / 1.15);
  near(back.zoom, current.zoom); near(back.x, current.x); near(back.y, current.y);
});

test('zooming the center stays centered and zooming out returns to fit without drift', () => {
  let current = {zoom: 1, x: 0, y: 0};
  for (let i = 0; i < 12; i++) current = zoomSurfaceAt(view, current, {x: 500, y: 300}, 1.15);
  near(imagePoint(current, {x: 500, y: 300}).x, 300);
  near(imagePoint(current, {x: 500, y: 300}).y, 300);
  for (let i = 0; i < 30; i++) current = zoomSurfaceAt(view, current, {x: 850, y: 100}, 1 / 1.15);
  assert.deepEqual(current, {zoom: 1, x: 0, y: 0});
});

test('pan limits keep the map covering the viewport at high zoom and centered when smaller', () => {
  const pan = clampSurfacePan(view, 2, 9999, 9999);
  near(pan.x, -200); near(pan.y, 0);
  assert.deepEqual(clampSurfacePan(view, 2, -9999, -9999), {x: -400, y: -600});
  assert.deepEqual(clampSurfacePan(view, 1, -9999, 9999), {x: 0, y: 0});
});
