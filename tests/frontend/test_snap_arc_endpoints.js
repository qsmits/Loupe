/**
 * Arc endpoints as snap targets (contour-offer feature, commit 1).
 *
 * snapPoint() previously only exposed arc-measure/arc-fit annotations as
 * snap targets via their CENTER (shared with plain circles). That's fine
 * for radius/center picks, but it means a mixed distance+arc contour could
 * never close precisely — there was no way to snap onto an arc's actual
 * endpoint. This adds:
 *   - arc-measure: both ends (p1, p3) as targets.
 *   - arc-fit: for PARTIAL arcs only (ann.startAngle !== undefined), the
 *     two endpoints computed the same way _extractEndpoints does. Full
 *     circle arc-fits (no startAngle) stay center-only.
 *
 * Run with: node --test tests/frontend/test_snap_arc_endpoints.js
 */
import './dom-stub.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';
import { setTool, snapPoint, SNAP_RADIUS } from '../../frontend/tools.js';
import { addAnnotation } from '../../frontend/annotations.js';

beforeEach(() => {
  state.annotations = [];
  state.selected = new Set();
  state.nextId = 1;
  state.frozen = false;
  state.calibration = null;
});

describe('snapPoint: arc endpoints as snap targets', () => {
  it('an arc-measure\'s p3 endpoint is a snap target', () => {
    addAnnotation({
      type: 'arc-measure', cx: 100, cy: 100, r: 50,
      p1: { x: 150, y: 100 }, p2: { x: 100, y: 150 }, p3: { x: 50, y: 100 },
      span_deg: 90, chord_px: 141,
    });
    setTool('distance');
    const { pt, snapped } = snapPoint({ x: 52, y: 102 }); // within SNAP_RADIUS(8) of p3
    assert.equal(snapped, true, 'must snap onto the arc-measure\'s p3 endpoint');
    assert.deepEqual(pt, { x: 50, y: 100 });
  });

  it('an arc-measure\'s p1 endpoint is also a snap target', () => {
    addAnnotation({
      type: 'arc-measure', cx: 100, cy: 100, r: 50,
      p1: { x: 150, y: 100 }, p2: { x: 100, y: 150 }, p3: { x: 50, y: 100 },
      span_deg: 90, chord_px: 141,
    });
    setTool('distance');
    const { pt, snapped } = snapPoint({ x: 147, y: 103 });
    assert.equal(snapped, true);
    assert.deepEqual(pt, { x: 150, y: 100 });
  });

  it('a PARTIAL arc-fit exposes its two computed endpoints as snap targets', () => {
    // startAngle=0 -> endpoint (cx+r, cy) = (250, 200); endAngle=PI/2 -> (cx, cy+r) = (200, 250).
    addAnnotation({
      type: 'arc-fit', cx: 200, cy: 200, r: 50,
      startAngle: 0, endAngle: Math.PI / 2, anticlockwise: false, points: [],
    });
    setTool('distance');
    const start = snapPoint({ x: 252, y: 198 });
    assert.equal(start.snapped, true, 'must snap onto the arc-fit\'s startAngle endpoint');
    assert.ok(Math.abs(start.pt.x - 250) < 1e-9 && Math.abs(start.pt.y - 200) < 1e-9);

    const end = snapPoint({ x: 198, y: 253 });
    assert.equal(end.snapped, true, 'must snap onto the arc-fit\'s endAngle endpoint');
    assert.ok(Math.abs(end.pt.x - 200) < 1e-9 && Math.abs(end.pt.y - 250) < 1e-9);
  });

  it('the arc-fit\'s center is still a snap target (unchanged)', () => {
    addAnnotation({
      type: 'arc-fit', cx: 200, cy: 200, r: 50,
      startAngle: 0, endAngle: Math.PI / 2, anticlockwise: false, points: [],
    });
    setTool('distance');
    const { pt, snapped } = snapPoint({ x: 202, y: 199 });
    assert.equal(snapped, true);
    assert.deepEqual(pt, { x: 200, y: 200 });
  });

  it('a small arc-fit\'s endpoint takes priority over its center when the two are within SNAP_RADIUS of each other (fix round 1)', () => {
    // r=5 at zoom 1: the whole arc — center AND both endpoints — sits well
    // inside SNAP_RADIUS(8) of every other point on it. Before the fix, the
    // center was pushed to `targets` first and the scan is first-match-wins,
    // so a click exactly on the endpoint (205,200) silently snapped to the
    // center (200,200) instead — defeating endpoint snapping (and the
    // closure offer, which depends on it) for small/zoomed-out arcs.
    addAnnotation({
      type: 'arc-fit', cx: 200, cy: 200, r: 5,
      startAngle: 0, endAngle: Math.PI / 2, anticlockwise: false, points: [],
    });
    setTool('distance');
    const onEndpoint = snapPoint({ x: 205, y: 200 });
    assert.equal(onEndpoint.snapped, true);
    assert.deepEqual(onEndpoint.pt, { x: 205, y: 200 }, 'must snap to the endpoint exactly, not the nearby center');

    // Center snap must not be lost — just lower priority than the endpoints.
    const onCenter = snapPoint({ x: 200, y: 200 });
    assert.equal(onCenter.snapped, true);
    assert.deepEqual(onCenter.pt, { x: 200, y: 200 });
  });

  it('a FULL-circle arc-fit stays center-only — a rim click away from center does not snap', () => {
    addAnnotation({ type: 'arc-fit', cx: 300, cy: 300, r: 50, points: [] }); // no startAngle => full circle
    setTool('distance');
    const { pt, snapped } = snapPoint({ x: 350, y: 300 }); // exactly on the rim, 50px from center
    assert.equal(snapped, false, 'full-circle arc-fit must not expose rim points as snap targets');
    assert.deepEqual(pt, { x: 350, y: 300 });
  });

  it('detections stay excluded (baseline, unaffected by this change)', () => {
    addAnnotation({ type: 'detected-line', x1: 0, y1: 0, x2: 100, y2: 0, frameWidth: 100, frameHeight: 100 });
    setTool('distance');
    const { snapped } = snapPoint({ x: 2, y: 1 });
    assert.equal(snapped, false);
  });
});
