import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-stub.js';
import { state } from '../../frontend/state.js';
import { serializeWorkspace, restoreWorkspace, freshWorkspaceRecord } from '../../frontend/workspace.js';
import { hasPerspectiveCorrection } from '../../frontend/tilt-cal.js';

test('perspective undo belongs to its project and exact corrected image', () => {
  restoreWorkspace(freshWorkspaceRecord());
  const imageA = {};
  state.frozenBackground = imageA;
  state.perspectiveUndo = {image:{},corrected:imageA};
  const a = serializeWorkspace();
  assert.equal(hasPerspectiveCorrection(),true);
  restoreWorkspace(freshWorkspaceRecord());
  assert.equal(hasPerspectiveCorrection(),false);
  restoreWorkspace(a);
  assert.equal(hasPerspectiveCorrection(),true);
  state.frozenBackground = {};
  assert.equal(hasPerspectiveCorrection(),false);
});
