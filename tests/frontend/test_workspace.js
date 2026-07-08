/**
 * Swap-completeness gate + workspace serialize/restore round-trip.
 *
 * THE GATE (most important test in Track B): every key of `state` must be
 * explicitly classified in workspace.js STATE_FIELDS as one of
 * "swapped" | "transient" | "global". A new state field that isn't
 * classified fails this suite — so new fields can never silently leak
 * between tabs.
 *
 * Run with: node --test tests/frontend/test_workspace.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, undoStack, redoStack } from '../../frontend/state.js';
import { viewport, imageWidth, imageHeight, setImageSize } from '../../frontend/viewport.js';
import {
  STATE_FIELDS, FIELD_DEFAULTS, freshWorkspaceRecord,
  serializeWorkspace, restoreWorkspace, captureEpoch, isStale,
  registerWorkspaceDom,
} from '../../frontend/workspace.js';

const CATEGORIES = new Set(['swapped', 'transient', 'global']);

describe('swap-completeness gate', () => {
  it('every key of state is classified in STATE_FIELDS', () => {
    for (const key of Object.keys(state)) {
      assert.ok(key in STATE_FIELDS,
        `state.${key} is NOT classified — add it to STATE_FIELDS in ` +
        `frontend/workspace.js as "swapped", "transient" or "global"`);
    }
  });

  it('STATE_FIELDS contains no stale keys that are not in state', () => {
    for (const key of Object.keys(STATE_FIELDS)) {
      assert.ok(key in state,
        `STATE_FIELDS.${key} does not exist on state — remove the stale entry`);
    }
  });

  it('every classification is a valid category', () => {
    for (const [key, cls] of Object.entries(STATE_FIELDS)) {
      assert.ok(CATEGORIES.has(cls), `STATE_FIELDS.${key} = "${cls}" is not a valid category`);
    }
  });

  it('every swapped and transient key has a default factory; globals have none', () => {
    for (const [key, cls] of Object.entries(STATE_FIELDS)) {
      if (cls === 'global') {
        assert.ok(!(key in FIELD_DEFAULTS), `global key ${key} must NOT have a default`);
      } else {
        assert.equal(typeof FIELD_DEFAULTS[key], 'function',
          `${cls} key ${key} needs a default factory in FIELD_DEFAULTS`);
      }
    }
  });

  it('default factories produce independent values (no shared mutables)', () => {
    const a = FIELD_DEFAULTS.annotations();
    const b = FIELD_DEFAULTS.annotations();
    assert.notEqual(a, b);
    const s1 = FIELD_DEFAULTS.selected();
    const s2 = FIELD_DEFAULTS.selected();
    assert.notEqual(s1, s2);
    assert.ok(s1 instanceof Set);
  });

  it('spot-check defaults match the state.js literal', () => {
    assert.equal(FIELD_DEFAULTS.tool(), 'select');
    assert.equal(FIELD_DEFAULTS.nextId(), 1);
    assert.equal(FIELD_DEFAULTS.frozen(), false);
    assert.deepEqual(FIELD_DEFAULTS.tolerances(), { warn: 0.10, fail: 0.25 });
    assert.deepEqual(FIELD_DEFAULTS.pendingPoints(), []);
    assert.deepEqual(FIELD_DEFAULTS.mousePos(), { x: 0, y: 0 });
  });

  it('load-bearing classifications', () => {
    // These specific classifications are relied on by other tasks.
    assert.equal(STATE_FIELDS.annotations, 'swapped');
    assert.equal(STATE_FIELDS.frozenBackground, 'swapped');
    assert.equal(STATE_FIELDS.frozenBlob, 'swapped');
    assert.equal(STATE_FIELDS.calibration, 'swapped');
    assert.equal(STATE_FIELDS._dirty, 'swapped');
    assert.equal(STATE_FIELDS.pendingPoints, 'transient');
    assert.equal(STATE_FIELDS.dragState, 'transient');
    assert.equal(STATE_FIELDS._epoch, 'global');
    assert.equal(STATE_FIELDS._hosted, 'global');
    assert.equal(STATE_FIELDS.settings, 'global');
  });
});

describe('serialize → restore round-trip', () => {
  beforeEach(() => {
    // Reset to a fresh workspace so tests are order-independent.
    restoreWorkspace(freshWorkspaceRecord());
  });

  it('round-trips swapped fields by reference', () => {
    const bg = { fake: 'image-element' };
    state.annotations = [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 5, y: 0 } }];
    state.calibration = { pixelsPerMm: 10, displayUnit: 'mm' };
    state.frozenBackground = bg;
    state.frozen = true;
    state.selected = new Set([1]);
    state.nextId = 2;
    undoStack.push('{"annotations":[]}');
    viewport.zoom = 2.5; viewport.panX = 10; viewport.panY = -4;
    setImageSize(1920, 1080);

    const rec = serializeWorkspace();

    restoreWorkspace(freshWorkspaceRecord());   // simulate switching away
    assert.equal(state.annotations.length, 0);
    assert.equal(state.frozenBackground, null);
    assert.equal(undoStack.length, 0);

    restoreWorkspace(rec);                       // switch back
    assert.equal(state.annotations.length, 1);
    assert.equal(state.annotations[0].b.x, 5);
    assert.equal(state.frozenBackground, bg, 'live refs must survive by identity');
    assert.equal(state.frozen, true);
    assert.ok(state.selected.has(1));
    assert.equal(state.nextId, 2);
    assert.deepEqual(undoStack, ['{"annotations":[]}']);
    assert.equal(viewport.zoom, 2.5);
    assert.equal(viewport.panX, 10);
    assert.equal(viewport.panY, -4);
    assert.equal(imageWidth, 1920);
    assert.equal(imageHeight, 1080);
  });

  it('resets transient fields on restore (in-progress picks do not leak)', () => {
    state.pendingPoints = [{ x: 1, y: 2 }];
    state.dragState = { dragging: true };
    state.dxfAlignMode = true;
    const rec = serializeWorkspace();
    restoreWorkspace(rec);   // even restoring the SAME tab resets transients
    assert.deepEqual(state.pendingPoints, []);
    assert.equal(state.dragState, null);
    assert.equal(state.dxfAlignMode, false);
  });

  it('leaves global fields alone', () => {
    state._hosted = true;
    state.circleMode = 'center-edge';
    restoreWorkspace(freshWorkspaceRecord());
    assert.equal(state._hosted, true);
    assert.equal(state.circleMode, 'center-edge');
    state._hosted = false;   // cleanup
    state.circleMode = '3-point';
  });

  it('record.viewport === null leaves fit-to-window to the DOM hook', () => {
    viewport.zoom = 3;
    const rec = freshWorkspaceRecord();
    assert.equal(rec.viewport, null);
    restoreWorkspace(rec);
    // zoom untouched by restore itself — afterRestore hook (main.js) calls fitToWindow
    assert.equal(viewport.zoom, 3);
  });

  it('freshWorkspaceRecord produces independent records', () => {
    const a = freshWorkspaceRecord();
    const b = freshWorkspaceRecord();
    a.state.annotations.push({ type: 'distance', id: 1 });
    assert.equal(b.state.annotations.length, 0);
  });
});

describe('epoch guard', () => {
  it('restoreWorkspace bumps the epoch; captured epochs go stale', () => {
    const before = captureEpoch();
    assert.equal(isStale(before), false);
    restoreWorkspace(freshWorkspaceRecord());
    assert.equal(isStale(before), true);
    assert.equal(isStale(captureEpoch()), false);
  });

  it('epoch is monotonic across multiple swaps', () => {
    const e0 = captureEpoch();
    restoreWorkspace(freshWorkspaceRecord());
    restoreWorkspace(freshWorkspaceRecord());
    assert.ok(captureEpoch() >= e0 + 2);
  });
});

describe('registerWorkspaceDom hook', () => {
  beforeEach(() => {
    // Reset workspace and clear any registered hook before each test
    registerWorkspaceDom(null);
    restoreWorkspace(freshWorkspaceRecord());
  });

  afterEach(() => {
    // Clean up: unregister the hook so it doesn't leak to other test files
    registerWorkspaceDom(null);
  });

  it('hook fires on restore', () => {
    let hookWasCalled = false;
    const hook = {
      afterRestore: () => { hookWasCalled = true; }
    };

    registerWorkspaceDom(hook);
    restoreWorkspace(freshWorkspaceRecord());

    assert.equal(hookWasCalled, true);
  });

  it('hook receives the correct record argument', () => {
    let capturedRecord = null;
    const hook = {
      afterRestore: (record) => { capturedRecord = record; }
    };

    registerWorkspaceDom(hook);
    const record = freshWorkspaceRecord();
    record.state.tool = 'distance';  // Modify to make it unique
    restoreWorkspace(record);

    assert.equal(capturedRecord, record, 'hook must receive the exact record object');
    assert.equal(capturedRecord.state.tool, 'distance');
  });

  it('hook fires exactly once per restore', () => {
    let callCount = 0;
    const hook = {
      afterRestore: () => { callCount += 1; }
    };

    registerWorkspaceDom(hook);
    restoreWorkspace(freshWorkspaceRecord());

    assert.equal(callCount, 1);
  });

  it('re-registration overwrites, not accumulates', () => {
    const callLog = [];
    const hookA = {
      afterRestore: () => { callLog.push('A'); }
    };
    const hookB = {
      afterRestore: () => { callLog.push('B'); }
    };

    registerWorkspaceDom(hookA);
    registerWorkspaceDom(hookB);
    restoreWorkspace(freshWorkspaceRecord());

    assert.deepEqual(callLog, ['B'], 'only hook B should fire; hook A was overwritten');
  });

  it('hook is graceful no-op when none registered', () => {
    registerWorkspaceDom(null);
    // Should not throw
    assert.doesNotThrow(() => {
      restoreWorkspace(freshWorkspaceRecord());
    });
  });

  it('hook is graceful no-op when hook has no afterRestore method', () => {
    registerWorkspaceDom({});  // Empty object, no afterRestore
    // Should not throw
    assert.doesNotThrow(() => {
      restoreWorkspace(freshWorkspaceRecord());
    });
  });
});
