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
    assert.match(statusLine('arc-fit', s), /Finish/);
    assert.match(PROCEDURES['arc-fit'].liveLine(s), /Ø.*px/);
  });
  it('unknown tool falls back to the tool id', () => {
    assert.equal(statusLine('nonsense', FRESH), 'nonsense');
  });
});
