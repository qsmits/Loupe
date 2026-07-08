/**
 * Tests for undoTarget() — the Ctrl-Z dispatcher for in-progress picks
 * (Track A #1). During a multi-click measurement, Ctrl-Z must remove the
 * last placed point instead of reverting the previous committed measurement;
 * with no pick in progress it falls through to history undo.
 *
 * Run with: node --test tests/frontend/test_undo_pending_point.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, undoTarget } from '../../frontend/state.js';

function resetPickState() {
  state.pendingPoints = [];
  state.inspectionPickTarget = null;
  state.inspectionPickPoints = [];
  state.inspectionPickFit = null;
}

describe('undoTarget', () => {
  beforeEach(resetPickState);

  it('returns "history" when nothing is in progress', () => {
    assert.equal(undoTarget(state), 'history');
  });

  it('returns "pending-point" while a multi-click tool has points', () => {
    state.pendingPoints = [{ x: 10, y: 20 }];
    assert.equal(undoTarget(state), 'pending-point');
  });

  it('returns "pending-point" for every count >= 1 (not just the first click)', () => {
    state.pendingPoints = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    assert.equal(undoTarget(state), 'pending-point');
  });

  it('returns "pick-point" while a DXF point-pick has points', () => {
    state.inspectionPickTarget = [{ type: 'line', handle: 'A1' }];
    state.inspectionPickPoints = [{ x: 5, y: 5 }];
    assert.equal(undoTarget(state), 'pick-point');
  });

  it('pick active but zero points falls through to history undo', () => {
    state.inspectionPickTarget = [{ type: 'line', handle: 'A1' }];
    state.inspectionPickPoints = [];
    assert.equal(undoTarget(state), 'history');
  });

  it('an active pick wins over stale pendingPoints', () => {
    state.inspectionPickTarget = [{ type: 'circle', handle: 'C1' }];
    state.inspectionPickPoints = [{ x: 1, y: 1 }];
    state.pendingPoints = [{ x: 9, y: 9 }];
    assert.equal(undoTarget(state), 'pick-point');
  });
});
