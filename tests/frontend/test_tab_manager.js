/**
 * TabManager lifecycle: open/activate/close state transitions, swap-on-
 * activate isolation, autosave dirty-gating, open-tab-set persistence.
 *
 * Scope: pure state-transition logic only, per the task brief — camera
 * stream src swapping and canvas re-fit-on-activate are DOM-coupled and
 * are covered by the manual verification steps instead (see
 * .superpowers/sdd/b7-brief.md Step 3). "One tab per instrument" swap
 * confirmation (deflectometry/fringe) opens a modal (shell.js showNotice)
 * that never resolves without a real Preact-rendered click, so those
 * paths are exercised manually too; everything here uses "microscopy",
 * which never hits that branch.
 *
 * tab-manager.js is a module singleton (tabs/activeTabId live at module
 * scope, no reset hook — matching the brief's file verbatim). Each test
 * gets a fresh instance via a cache-busting dynamic import query string;
 * its dependencies (state.js, workspace.js, projects-db.js, ...) keep
 * their normal shared-singleton identity, matching production, and are
 * reset explicitly in beforeEach.
 *
 * Run with: node --test tests/frontend/test_tab_manager.js
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import './dom-stub.js';
import { createIdbStub } from './idb-stub.js';
import { _setIndexedDbFactory, getProject } from '../../frontend/projects-db.js';
import { state } from '../../frontend/state.js';
import { restoreWorkspace, freshWorkspaceRecord } from '../../frontend/workspace.js';
import { setImageSize } from '../../frontend/viewport.js';

// ── Timer bookkeeping: initTabManager() starts a 2s autosave interval and
// registers a beforeunload listener per boot. Track and clear so the test
// process exits promptly instead of idling on open handles. ──────────────
const _timers = [];
const _origSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = _origSetInterval(fn, ms, ...rest);
  _timers.push(h);
  return h;
};
after(() => { for (const h of _timers) clearInterval(h); });

let _seq = 0;
/** A fresh tab-manager.js module instance (fresh `tabs`/`activeTabId`), for
 *  test isolation, while state.js/workspace.js/projects-db.js stay shared
 *  singletons (as in production). */
async function freshTabManager() {
  _seq += 1;
  return import(`../../frontend/tab-manager.js?test=${_seq}`);
}

beforeEach(() => {
  _setIndexedDbFactory(createIdbStub());
  localStorage.clear();
  restoreWorkspace(freshWorkspaceRecord());
});

describe('newProject', () => {
  it('creates and activates a tab, persisting ISO timestamps', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'Bracket' });

    assert.ok(tab, 'newProject should return the created tab');
    assert.equal(tm.getActiveTabId(), tab.id);
    assert.deepEqual(tm.getTabs().map(t => t.id), [tab.id]);

    const proj = await getProject(tab.id);
    assert.equal(proj.name, 'Bracket');
    assert.equal(proj.type, 'microscopy');
    // ISO-8601, not Date.now() or a locale string — required for the
    // lexicographic updatedAt sort in listProjectSummaries.
    assert.match(proj.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(proj.createdAt, proj.updatedAt);
  });

  it('defaults the name from the type and creation time when omitted', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy');
    assert.match(tab.name, /^Microscopy \d{4}-\d{2}-\d{2}/);
  });
});

describe('swap-on-activate', () => {
  it('keeps swapped state isolated across two tabs (no bleed)', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    state.annotations = [{ type: 'distance', id: 1, points: [] }];
    state.tool = 'distance';

    const tabB = await tm.newProject('microscopy', { name: 'B' });
    // Activating B must have serialized A's edits away and started B fresh.
    assert.deepEqual(state.annotations, []);
    assert.equal(state.tool, 'select');

    state.annotations = [{ type: 'circle', id: 1, cx: 5, cy: 5, r: 2 }];
    state.tool = 'circle';

    await tm.activateTab(tabA.id);
    assert.deepEqual(state.annotations, [{ type: 'distance', id: 1, points: [] }]);
    assert.equal(state.tool, 'distance');

    await tm.activateTab(tabB.id);
    assert.deepEqual(state.annotations, [{ type: 'circle', id: 1, cx: 5, cy: 5, r: 2 }]);
    assert.equal(state.tool, 'circle');
  });

  it('bumps the epoch on every activation, invalidating in-flight async work', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    const epochAfterA = state._epoch;
    const tabB = await tm.newProject('microscopy', { name: 'B' });
    assert.ok(state._epoch > epochAfterA, 'epoch must increase on activate');
    const epochAfterB = state._epoch;
    await tm.activateTab(tabA.id);
    assert.ok(state._epoch > epochAfterB, 'epoch must increase again switching back');
  });

  it('resets transient (in-progress) fields on every switch, even for the outgoing tab', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    state.pendingPoints = [{ x: 10, y: 10 }];   // mid-gesture: one point of a Distance placed

    const tabB = await tm.newProject('microscopy', { name: 'B' });
    assert.deepEqual(state.pendingPoints, [], 'new tab must not see the old pending point');

    await tm.activateTab(tabA.id);
    assert.deepEqual(state.pendingPoints, [], 'switching back must not resurrect the pending point either');
  });
});

describe('dirty flag (getTabs)', () => {
  it('tracks the live state for the active tab', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    assert.equal(tm.getTabs().find(t => t.id === tabA.id).dirty, false);

    state._dirty = true;
    assert.equal(tm.getTabs().find(t => t.id === tabA.id).dirty, true, 'active tab dirty must track state._dirty live');
  });

  it('switching tabs flushes the outgoing dirty tab, so it reads clean once inactive', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    state._dirty = true;
    const before = await getProject(tabA.id);
    await new Promise(r => setTimeout(r, 5));

    const tabB = await tm.newProject('microscopy', { name: 'B' });

    // deactivateCurrent() flushes before serializing, so A must have been
    // persisted (autosave "flush on tab switch") and read back clean.
    assert.equal(tm.getTabs().find(t => t.id === tabA.id).dirty, false);
    assert.equal(tm.getTabs().find(t => t.id === tabB.id).dirty, false);
    const after = await getProject(tabA.id);
    assert.notEqual(after.updatedAt, before.updatedAt, 'switching tabs must flush the outgoing dirty tab to IndexedDB');
  });
});

describe('autosave (flushAutosave)', () => {
  it('no-ops when the active tab is not dirty', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'A' });
    const before = await getProject(tab.id);
    await new Promise(r => setTimeout(r, 5));
    await tm.flushAutosave();
    const after = await getProject(tab.id);
    assert.equal(after.updatedAt, before.updatedAt, 'a non-dirty flush must not touch updatedAt');
  });

  it('persists the workspace and clears the dirty flag when dirty', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'A' });
    state.annotations = [{ type: 'distance', id: 1, points: [] }];
    state._dirty = true;
    await new Promise(r => setTimeout(r, 5));   // let the ISO-ms clock advance past createdAt

    await tm.flushAutosave();

    assert.equal(state._dirty, false, 'flush must clear the dirty flag');
    const proj = await getProject(tab.id);
    assert.equal(proj.workspace.version, 4);
    assert.equal(proj.workspace.annotations.length, 1);
    assert.notEqual(proj.updatedAt, proj.createdAt, 'updatedAt must advance past the creation stamp');
  });

  it('is a no-op for a non-microscopy active tab', async () => {
    const tm = await freshTabManager();
    // deflectometry has no pre-existing tab, so newProject never touches the
    // showNotice() swap-confirmation path (which never resolves in tests).
    const tab = await tm.newProject('deflectometry', { name: 'D' });
    state._dirty = true;
    await tm.flushAutosave();               // must not throw / must not persist a workspace
    const proj = await getProject(tab.id);
    assert.equal(proj.workspace, null);
  });
});

describe('closeTab', () => {
  it('is never destructive: the project stays in IndexedDB after close', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    const tabB = await tm.newProject('microscopy', { name: 'B' });

    await tm.closeTab(tabB.id);

    assert.deepEqual(tm.getTabs().map(t => t.id), [tabA.id]);
    const stillThere = await getProject(tabB.id);
    assert.ok(stillThere, 'closing a tab must not delete its project');
    assert.equal(stillThere.name, 'B');
  });

  it('falls back to a neighboring tab when the active tab closes', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    const tabB = await tm.newProject('microscopy', { name: 'B' });
    const tabC = await tm.newProject('microscopy', { name: 'C' });   // C active

    await tm.closeTab(tabB.id);   // close a non-active middle tab
    assert.equal(tm.getActiveTabId(), tabC.id, 'closing an inactive tab must not change the active tab');

    await tm.closeTab(tabC.id);   // close the active tab -> falls back to a remaining neighbor
    assert.equal(tm.getActiveTabId(), tabA.id);
  });

  it('shows the home screen when the last tab closes', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'Solo' });
    await tm.closeTab(tab.id);
    assert.equal(tm.getActiveTabId(), null);
    assert.equal(tm.isHomeVisible(), true);
  });
});

describe('renameProject', () => {
  it('updates the tab name and the persisted record with a fresh updatedAt', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'Old' });
    const before = await getProject(tab.id);
    await new Promise(r => setTimeout(r, 5));

    await tm.renameProject(tab.id, 'New Name');

    assert.equal(tm.getTabs().find(t => t.id === tab.id).name, 'New Name');
    const after = await getProject(tab.id);
    assert.equal(after.name, 'New Name');
    assert.ok(after.updatedAt > before.updatedAt);
  });
});

describe('open-tab-set persistence', () => {
  it('persists the open ids + active id to localStorage after each operation', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    const tabB = await tm.newProject('microscopy', { name: 'B' });

    let saved = JSON.parse(localStorage.getItem('loupe-open-tabs'));
    assert.deepEqual(saved.open.slice().sort(), [tabA.id, tabB.id].sort());
    assert.equal(saved.active, tabB.id);

    await tm.activateTab(tabA.id);
    saved = JSON.parse(localStorage.getItem('loupe-open-tabs'));
    assert.equal(saved.active, tabA.id);
  });

  it('restores the same open tabs, active tab, and workspace content on the next boot', async () => {
    const tm1 = await freshTabManager();
    const tabA = await tm1.newProject('microscopy', { name: 'A' });
    state.annotations = [{ type: 'distance', id: 1, points: [] }];
    state._dirty = true;
    await tm1.flushAutosave();
    const tabB = await tm1.newProject('microscopy', { name: 'B' });
    await tm1.activateTab(tabA.id);   // A is the active tab when the "browser" closes

    // Simulate a page reload: a fresh tab-manager module instance, same
    // underlying IndexedDB + localStorage.
    const tm2 = await freshTabManager();
    await tm2.initTabManager();

    assert.equal(tm2.getActiveTabId(), tabA.id, 'the previously active tab must be active again');
    assert.deepEqual(tm2.getTabs().map(t => t.id).sort(), [tabA.id, tabB.id].sort());
    // applyWorkspaceV4 stamps a default `purpose` on read, so compare the
    // fields that came from the autosave rather than the whole object.
    assert.equal(state.annotations.length, 1,
      'the autosaved workspace content must come back, not just the tab shell');
    assert.equal(state.annotations[0].type, 'distance');
    assert.equal(state.annotations[0].id, 1);
  });

  it('opens a fresh microscopy project when nothing was persisted (transitional boot path)', async () => {
    const tm = await freshTabManager();
    await tm.initTabManager();
    assert.equal(tm.getTabs().length, 1);
    assert.equal(tm.getTabs()[0].type, 'microscopy');
  });
});

describe('lazy image restore', () => {
  it('reloads a stored frozen image as the frozen background on first activation', async () => {
    const tm1 = await freshTabManager();
    const tab = await tm1.newProject('microscopy', { name: 'WithImage' });
    setImageSize(8, 6);
    state.frozen = true;
    state.frozenBlob = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
    state.frozenSource = 'file';
    state._dirty = true;
    await tm1.flushAutosave();

    // New tab-manager instance + close/reopen forces the lazy-load path
    // (ensureRecordLoaded only runs when tab.record is not already cached).
    const tm2 = await freshTabManager();
    await tm2.openProject(tab.id);

    assert.equal(state.frozen, true);
    assert.ok(state.frozenBackground, 'frozenBackground image element must be populated');
    assert.equal(state.frozenSource, 'file');
  });
});
