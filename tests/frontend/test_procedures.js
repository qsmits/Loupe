import './dom-stub.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROCEDURES, statusLine } from '../../frontend/procedures.js';
import { TOOL_BUTTONS } from '../../frontend/toolbar.js';

// NOTE: TOOL_BUTTONS export is added in Step 3 below (currently module-private).

const FRESH = { pendingPoints: [], pendingRefLine: null, pendingCenterCircle: null,
                pendingCircleRef: null, angleMode: 'two-lines', circleMode: '3-point',
                arcMeasureMode: 'sequential', calibration: null };

describe('procedures completeness gate', () => {
  it('every toolbar tool plus calibrate has a procedure', () => {
    const toolIds = TOOL_BUTTONS.filter(Boolean).map(b => b.tool).concat(['calibrate']);
    for (const id of toolIds) {
      assert.ok(PROCEDURES[id], `no PROCEDURES entry for tool "${id}"`);
      const p = PROCEDURES[id];
      assert.equal(typeof p.title, 'string');
      const steps = p.steps(FRESH);
      assert.ok(Array.isArray(steps) && steps.length >= 1, `steps() empty for "${id}"`);
      const cur = p.currentStep(FRESH);
      assert.ok(cur >= 0 && cur < steps.length, `currentStep out of range for "${id}"`);
    }
  });
});

describe('statusLine', () => {
  it('advances with pending points for distance', () => {
    assert.equal(statusLine('distance', FRESH), 'Distance — Click the first point');
    assert.equal(statusLine('distance', { ...FRESH, pendingPoints: [{ x: 1, y: 1 }] }),
                 'Distance — Click the second point');
  });
  it('arc-fit reports live fit once 3+ points placed', () => {
    const pts = [{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 }];
    const s = { ...FRESH, pendingPoints: pts };
    // Past the 3-point minimum the status bar stays on live progress text
    // rather than jumping to "Finish" purely because a count was exceeded —
    // finishing is a discrete action (Enter/double-click), not a point count.
    assert.match(statusLine('arc-fit', s), /4 points placed/);
    assert.match(PROCEDURES['arc-fit'].liveLine(s), /Ø.*px/);
  });
  it('arc-fit shows count-aware progress before and after the 3-point threshold', () => {
    assert.equal(statusLine('arc-fit', FRESH), 'Best fit — Place at least 3 points on the edge');
    assert.equal(
      statusLine('arc-fit', { ...FRESH, pendingPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
      'Best fit — 2 points placed — need 1 more');
    assert.match(
      statusLine('arc-fit', { ...FRESH, pendingPoints: [{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 }] }),
      /4 points placed/);
  });
  it('area shows count-aware progress before the 3-vertex threshold', () => {
    assert.equal(
      statusLine('area', { ...FRESH, pendingPoints: [{ x: 0, y: 0 }] }),
      'Area — 1 vertex placed — need 2 more');
  });
  it('spline shows count-aware progress before the 2-anchor threshold', () => {
    assert.equal(
      statusLine('spline', { ...FRESH, pendingPoints: [{ x: 0, y: 0 }] }),
      'Spline — 1 anchor placed');
  });
  it('fit-line shows count-aware progress before the 2-point threshold', () => {
    assert.equal(
      statusLine('fit-line', { ...FRESH, pendingPoints: [{ x: 0, y: 0 }] }),
      'Flatness — 1 point placed');
  });
  it('unknown tool falls back to the tool id', () => {
    assert.equal(statusLine('nonsense', FRESH), 'nonsense');
  });
});
