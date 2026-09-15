/**
 * Closed-contour area offer (contour-offer feature, commit 2).
 *
 * When a manually drawn contour of endpoint-snapped measurements (distance
 * or arc-measure segments) closes into a loop, tools.js offers — via a
 * toast with an action button — to create an `area` annotation from that
 * loop. The offer only fires when BOTH ends of the just-completed segment
 * already join another chainable annotation's endpoint (an open chain never
 * offers), and only when the loop's enclosed area is non-degenerate.
 *
 * Uses shell.js's `_setToastHandler` test seam (see test_project_io.js /
 * test_tab_manager.js for the same pattern) to capture showToast(message,
 * opts) calls instead of driving the real Preact overlay.
 *
 * Run with: node --test tests/frontend/test_contour_offer.js
 */
import './dom-stub.js';

// dom-stub.js deliberately doesn't provide requestAnimationFrame (nothing in
// the existing suite exercises a redraw() while state._flashExpiry is live).
// _createAreaFromLoop sets that flash flag before its final setTool("select")
// -> redraw() — a real browser has requestAnimationFrame; give the stub a
// harmless no-op so that pre-existing flash-highlight side effect doesn't
// crash the test instead of exercising the offer logic under test.
globalThis.requestAnimationFrame ??= () => 0;

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';
import { setTool, handleToolClick } from '../../frontend/tools.js';
import { undo } from '../../frontend/events-keyboard.js';
import { _setToastHandler } from '../../frontend/shell.js';
import { polygonArea } from '../../frontend/math.js';

let toasts; // captured showToast(message, opts) calls, this test

beforeEach(() => {
  state.annotations = [];
  state.selected = new Set();
  state.nextId = 1;
  state.frozen = false;              // keeps handleToolClick's subpixel refine (server call) off
  state.settings.subpixelMethod = "none"; // belt-and-suspenders determinism
  state.calibration = null;
  state.pendingPoints = [];
  state.pendingRefLine = null;
  state.pendingCenterCircle = null;
  state.pendingCircleRef = null;
  state.pendingRelationFit = null;
  state.arcMeasureMode = null; // default (not "ends-first"): clicks are [end1, mid, end2]
  toasts = [];
  _setToastHandler((message, opts) => { toasts.push({ message, opts }); });
});

after(() => { _setToastHandler(null); });

// Straight-sided triangle: (100,100) -> (400,100) -> (100,400) -> back to (100,100).
const P0 = { x: 100, y: 100 };
const P1 = { x: 400, y: 100 };
const P2 = { x: 100, y: 400 };
const TRIANGLE_AREA = polygonArea([P0, P1, P2]); // 45000

describe('closed-contour area offer: triangle of distances', () => {
  it('fires the toast exactly once, on the closing segment, and its action creates one area annotation matching the triangle (within undo)', async () => {
    setTool('distance');
    await handleToolClick(P0);
    await handleToolClick(P1);              // segment 1: P0-P1 — no other annotation to join, no toast
    assert.equal(toasts.length, 0);

    await handleToolClick({ x: P1.x + 1, y: P1.y + 2 }); // snaps onto P1
    await handleToolClick(P2);              // segment 2: P1-P2 — one end joins, other is free: no toast
    assert.equal(toasts.length, 0);

    await handleToolClick({ x: P2.x - 2, y: P2.y + 2 }); // snaps onto P2
    await handleToolClick({ x: P0.x + 2, y: P0.y - 2 }); // snaps onto P0 — closes the loop

    assert.equal(state.annotations.filter(a => a.type === 'distance').length, 3, 'three distance segments drawn');
    assert.equal(toasts.length, 1, 'toast fires exactly once, on the closing segment');
    assert.equal(toasts[0].message, 'Closed contour detected');
    assert.equal(toasts[0].opts.actionLabel, 'Create area');
    assert.equal(typeof toasts[0].opts.onAction, 'function');

    const beforeCount = state.annotations.length;
    toasts[0].opts.onAction();

    const areas = state.annotations.filter(a => a.type === 'area');
    assert.equal(areas.length, 1, 'exactly one area annotation created');
    assert.equal(state.annotations.length, beforeCount + 1, 'a single addAnnotation — one undo step');
    const createdArea = polygonArea(areas[0].points);
    assert.ok(Math.abs(createdArea - TRIANGLE_AREA) / TRIANGLE_AREA < 0.01,
      `area ${createdArea} should match the triangle area ${TRIANGLE_AREA} within 1%`);

    undo();
    assert.equal(state.annotations.filter(a => a.type === 'area').length, 0, 'undo removed the area');
    assert.equal(state.annotations.filter(a => a.type === 'distance').length, 3, 'undo left the three distances intact');
  });
});

describe('closed-contour area offer: open chain never offers', () => {
  it('two joined distances (no closure) produce no toast', async () => {
    setTool('distance');
    await handleToolClick(P0);
    await handleToolClick(P1);
    assert.equal(toasts.length, 0);

    await handleToolClick({ x: P1.x + 1, y: P1.y - 1 }); // snaps onto P1
    await handleToolClick(P2); // far end left open — never closes
    assert.equal(toasts.length, 0, 'an open two-segment chain must never offer an area');
    assert.equal(state.annotations.filter(a => a.type === 'distance').length, 2);
  });
});

describe('closed-contour area offer: mixed distance + arc-measure closure', () => {
  it('an arc-measure closing the loop fires the toast, and the resulting area exceeds the straight-line triangle (bulge counts)', async () => {
    setTool('distance');
    await handleToolClick(P0);
    await handleToolClick(P1);                          // segment 1: P0-P1
    await handleToolClick({ x: P1.x + 1, y: P1.y - 2 }); // snaps onto P1
    await handleToolClick(P2);                           // segment 2: P1-P2
    assert.equal(toasts.length, 0, 'no toast yet — chain still open at this point');

    setTool('arc-measure');
    // Ends-first vs default ordering: default mode takes clicks as [end1, mid, end2]
    // directly (no reordering) — see tools.js's arc-measure branch.
    await handleToolClick({ x: P2.x - 2, y: P2.y + 2 }); // p1: snaps onto P2, closing one end
    await handleToolClick({ x: 50, y: 250 });            // mid: bulges outward (away from the triangle), no snap target nearby
    await handleToolClick({ x: P0.x + 2, y: P0.y - 2 }); // p3: snaps onto P0, closing the other end

    const arcAnn = state.annotations.find(a => a.type === 'arc-measure');
    assert.ok(arcAnn, 'arc-measure created');
    assert.deepEqual(arcAnn.p1, P2, 'arc-measure p1 snapped exactly onto the chain end at P2');
    assert.deepEqual(arcAnn.p3, P0, 'arc-measure p3 snapped exactly onto the chain end at P0');

    assert.equal(toasts.length, 1, 'toast fires from the arc-measure completion, closing the loop');
    assert.equal(toasts[0].opts.actionLabel, 'Create area');

    toasts[0].opts.onAction();
    const areas = state.annotations.filter(a => a.type === 'area');
    assert.equal(areas.length, 1);
    const createdArea = polygonArea(areas[0].points);
    assert.ok(createdArea > TRIANGLE_AREA * 1.01,
      `arc bulge must add measurable area: got ${createdArea}, straight triangle is ${TRIANGLE_AREA}`);
  });
});
