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
import { _setNoticeHandler, _setToastHandler } from '../../frontend/shell.js';

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

let _idb;   // the current test's in-memory IDB stub, for fault-injection (see deleteProjectEverywhere)
beforeEach(() => {
  _idb = createIdbStub();
  _setIndexedDbFactory(_idb);
  localStorage.clear();
  restoreWorkspace(freshWorkspaceRecord());
  _setNoticeHandler(null);
  _setToastHandler(null);
  window.crossMode = null;
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

  it('surfaces a "storage may be full" toast pointing at project management on write failure, does not throw, and does not clear dirty', async () => {
    // Same fault-injection pattern as the deleteProjectEverywhere / adoptProject
    // failure tests: sabotage the IDB store's put() so putProject rejects like
    // a real QuotaExceededError, then drive the failure through the actual
    // flushAutosave code path (no stubbing of flushAutosave itself).
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'A' });
    const store = _idb._databases.get('loupe').stores.get('projects');
    store.data.set = () => { throw new Error('simulated QuotaExceededError'); };

    state.annotations = [{ type: 'distance', id: 1, points: [] }];
    state._dirty = true;

    let toastMessage = null, toastOpts = null;
    _setToastHandler((msg, opts) => { toastMessage = msg; toastOpts = opts; });

    await assert.doesNotReject(tm.flushAutosave());

    assert.match(toastMessage, /storage may be full/);
    assert.equal(toastOpts?.actionLabel, 'Manage projects');
    assert.equal(state._dirty, true, 'a failed flush must not clear the dirty flag (nothing was actually saved)');
  });

  it('does not re-toast on a second consecutive failed flush (warn-once guard)', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'A' });
    const store = _idb._databases.get('loupe').stores.get('projects');
    store.data.set = () => { throw new Error('simulated QuotaExceededError'); };

    state.annotations = [{ type: 'distance', id: 1, points: [] }];
    state._dirty = true;

    let toastCount = 0;
    _setToastHandler(() => { toastCount += 1; });

    await tm.flushAutosave();
    await tm.flushAutosave();

    assert.equal(toastCount, 1, 'repeated failures while still dirty must only toast once');
  });

  // ── Autosave dirty-flag race (Track B whole-branch review, Fix 1) ────────
  // flushAutosave used to clear state._dirty AFTER its awaits (getProject /
  // makeThumbnail / putProject), unconditionally against the live `state`
  // singleton. That's wrong for two reasons, covered by the next two tests:
  //  (a) same-tab: an edit landing during those awaits is not in the
  //      already-snapshotted `record`, yet got marked clean anyway — lost
  //      until the next edit happened to re-dirty it.
  //  (b) cross-tab: a tab switch during those awaits installs the INCOMING
  //      tab's state via restoreWorkspace() into the same `state` singleton
  //      — the outgoing flush's post-await clear then wiped the incoming
  //      tab's own dirty flag.
  // The fix clears state._dirty synchronously, right after the snapshot is
  // taken and before the first await — see tab-manager.js::flushAutosave.
  //
  // Both tests use idb-stub.js's put() fault-injection seam extended for
  // this task (asAsyncRequest) to hold a flush open across an await, the
  // same store.data.set override idiom the failure tests above use for a
  // synchronous throw, but here resolving on a controllable gate instead.
  it('a same-tab edit made while a flush is in-flight survives (is not clobbered by the flush completing)', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'A' });
    state.annotations = [{ type: 'distance', id: 1, points: [] }];
    state._dirty = true;

    const store = _idb._databases.get('loupe').stores.get('projects');
    const realSet = store.data.set.bind(store.data);
    let releasePut;
    const gate = new Promise(resolve => { releasePut = resolve; });
    store.data.set = (...args) => gate.then(() => realSet(...args));

    const flushPromise = tm.flushAutosave();
    // flushAutosave() runs synchronously up to its first await (getProject),
    // which is reached before the gated put() — so by now the dirty flag
    // must already be cleared, proving the clear happens at snapshot time,
    // not after putProject() resolves.
    assert.equal(state._dirty, false,
      'the dirty flag must clear synchronously at snapshot time, before any await');

    // Simulate an edit landing while the save is still in flight (held open
    // by the gate above, currently parked at the awaited putProject()).
    state._dirty = true;

    releasePut();
    await flushPromise;

    assert.equal(state._dirty, true,
      'an edit made during the flush\'s awaits must survive as a re-dirtied flag ' +
      '(persisted by this save or picked up by the next cycle), not be cleared by ' +
      'the flush\'s completion');
  });

  it('cross-tab: a swap during an in-flight flush does not clear the incoming tab\'s dirty flag', async () => {
    const tm = await freshTabManager();
    const tabA = await tm.newProject('microscopy', { name: 'A' });
    const tabB = await tm.newProject('microscopy', { name: 'B' });   // B ends up active

    const store = _idb._databases.get('loupe').stores.get('projects');
    const realSet = store.data.set.bind(store.data);

    // Leave B's stored record dirty by forcing ITS switch-away flush to fail
    // (same throw-based fault-injection idiom as the "storage may be full"
    // test above): deactivateCurrent()'s flushAutosave() call fails while B
    // is still the active tab, so Fix 1's catch branch restores
    // state._dirty = true before tab.record = serializeWorkspace() captures
    // it — giving B a genuinely dirty record to switch back into below.
    state.annotations = [{ type: 'distance', id: 1, points: [] }];
    state._dirty = true;
    store.data.set = () => { throw new Error('simulated failure — keep B dirty'); };
    _setToastHandler(() => {});   // swallow the "storage may be full" toast
    await tm.activateTab(tabA.id);   // B -> A; B's flush fails and stays dirty
    store.data.set = realSet;        // real writes work again from here on

    assert.equal(tm.getTabs().find(t => t.id === tabB.id).dirty, true,
      'B must still read dirty after its failed switch-away flush');

    // Dirty A and start a flush whose putProject() is held open on a gate.
    state.annotations = [{ type: 'circle', id: 2, cx: 1, cy: 1, r: 1 }];
    state._dirty = true;
    let releasePut;
    const gate = new Promise(resolve => { releasePut = resolve; });
    store.data.set = (...args) => gate.then(() => realSet(...args));

    const flushPromise = tm.flushAutosave();   // flushes A
    assert.equal(state._dirty, false, 'Fix 1: A\'s dirty flag must clear synchronously at snapshot time');

    // Swap back to B WHILE A's flush is still awaiting its gated putProject().
    await tm.activateTab(tabB.id);
    assert.equal(state._dirty, true,
      'switching in must install the incoming (B) tab\'s own dirty flag');

    releasePut();
    await flushPromise;   // A's flush now completes

    assert.equal(state._dirty, true,
      'A\'s flush completing must not clear B\'s dirty flag now that B is active — ' +
      'the cross-tab swap/edit race this fix closes');
    assert.equal(tm.getTabs().find(t => t.id === tabA.id).dirty, false,
      'A must read clean — its own flush completed successfully');
    assert.equal(tm.getTabs().find(t => t.id === tabB.id).dirty, true,
      'B must still read dirty — active-tab dirty tracks live state._dirty, untouched by A\'s flush');
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

describe('singleton tabs (deflectometry/fringe)', () => {
  // Task 7 already implements the one-tab-per-instrument gate in newProject
  // (showNotice() swap-confirmation); Task 8 is the first task that makes it
  // reachable end-to-end (console shim -> "new-project" event -> newProject).
  // The modal itself can't be driven here (see the file header + dom-stub.js:
  // showNotice() renders via Preact into `shell-overlays`, which this stub
  // does not provide, so its promise never resolves without a real click).
  // What IS testable without a DOM/Preact renderer is the gate itself: a
  // second open of an already-open singleton type must not create a second
  // tab, and must block (stay pending) until the modal is answered — proving
  // newProject() doesn't race ahead of the confirmation.
  it('blocks a second open of the same singleton type pending the swap-confirmation modal', async () => {
    const tm = await freshTabManager();
    const first = await tm.newProject('deflectometry', { name: 'D1' });
    assert.equal(tm.getTabs().length, 1);
    assert.equal(tm.getActiveTabId(), first.id);

    let settled = false;
    tm.newProject('deflectometry', { name: 'D2' }).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 20));

    assert.equal(settled, false, 'newProject must block on the confirmation modal, not race ahead');
    assert.equal(tm.getTabs().length, 1, 'no second tab should exist while the modal is unanswered');
    assert.equal(tm.getTabs()[0].id, first.id, 'the original singleton tab must remain untouched while blocked');
    assert.equal(tm.getActiveTabId(), first.id, 'the original tab must still be active while blocked');
    // Intentionally left pending: nothing in this environment can click the
    // modal to resolve it. It holds no timer/handle, so it doesn't keep the
    // test process alive.
  });

  it('allows a fresh open of a different singleton type without prompting', async () => {
    const tm = await freshTabManager();
    const defl = await tm.newProject('deflectometry', { name: 'D1' });
    assert.equal(tm.getTabs().length, 1);

    // Different type (fringe, not deflectometry) — no existing tab of this
    // type, so newProject must resolve immediately (no showNotice branch).
    const fringe = await tm.newProject('fringe', { name: 'F1' });
    assert.equal(tm.getTabs().length, 2);
    assert.equal(tm.getActiveTabId(), fringe.id);
    assert.ok(tm.getTabs().some(t => t.id === defl.id), 'the deflectometry tab must remain open alongside fringe');
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

describe('deleteProjectEverywhere', () => {
  // showNotice() normally renders a Preact modal into #shell-overlays and
  // resolves only on a real button click — dom-stub.js doesn't provide that
  // mount, so the promise would hang forever here (see the file header /
  // "singleton tabs" describe block above for the same limitation). Use the
  // _setNoticeHandler/_setToastHandler test seams (frontend/shell.js) to
  // simulate the user's choice and observe the resulting toast, instead of
  // faking a click.

  it('confirm ("delete") deletes the record and closes the tab if it was open', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'ToDelete' });
    _setNoticeHandler(() => 'delete');

    await tm.deleteProjectEverywhere(tab.id);

    assert.equal(await getProject(tab.id), null, 'record must be gone from IndexedDB');
    assert.equal(tm.getTabs().some(t => t.id === tab.id), false, 'the open tab must have been closed');
    assert.equal(tm.getActiveTabId(), null, 'closing the only open tab falls back to the home screen');
  });

  it('cancel ("cancel", i.e. anything but "delete") preserves the record and leaves the tab open', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'KeepMe' });
    _setNoticeHandler(() => 'cancel');   // the dialog's Cancel button id — anything !== "delete"

    await tm.deleteProjectEverywhere(tab.id);

    const proj = await getProject(tab.id);
    assert.ok(proj, 'record must still exist after cancel');
    assert.equal(proj.name, 'KeepMe');
    assert.ok(tm.getTabs().some(t => t.id === tab.id), 'the tab must remain open after cancel');
    assert.equal(tm.getActiveTabId(), tab.id, 'the active tab must be unchanged after cancel');
  });

  it('surfaces a toast and does not throw when deleteProjectRecord itself fails', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'FailMe' });
    _setNoticeHandler(() => 'delete');

    // Force the underlying IDB delete() to reject without a purpose-built
    // failing stub: reach into idb-stub.js's introspection map (`_databases`,
    // already exported for tests) and make the "projects" store's backing
    // Map throw on delete, simulating e.g. a full/locked store.
    const store = _idb._databases.get('loupe').stores.get('projects');
    store.data.delete = () => { throw new Error('simulated IDB delete failure'); };

    let toastMessage = null;
    _setToastHandler(msg => { toastMessage = msg; });

    await assert.doesNotReject(tm.deleteProjectEverywhere(tab.id));

    assert.equal(toastMessage, 'Delete failed', 'failure must surface a toast, matching other tab-manager failure paths');
    const proj = await getProject(tab.id);
    assert.ok(proj, 'record must still exist — the delete call failed');
  });

  it('aborts before the confirm dialog and leaves everything untouched when cross-mode is active', async () => {
    const tm = await freshTabManager();
    const tab = await tm.newProject('microscopy', { name: 'Guarded' });
    let noticeCalled = false;
    _setNoticeHandler(() => { noticeCalled = true; return 'delete'; });
    let toastMessage = null;
    _setToastHandler(msg => { toastMessage = msg; });

    window.crossMode = { source: 'fringe' };
    try {
      await tm.deleteProjectEverywhere(tab.id);
    } finally {
      window.crossMode = null;
    }

    assert.equal(noticeCalled, false, 'must abort before even showing the confirm dialog');
    assert.ok(toastMessage, 'must surface a toast explaining the refusal');
    assert.ok(tm.getTabs().some(t => t.id === tab.id), 'tab must remain open');
    assert.ok(await getProject(tab.id), 'record must remain in IndexedDB');
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

  it('shows the home screen (no tabs) when nothing was persisted', async () => {
    const tm = await freshTabManager();
    await tm.initTabManager();
    assert.equal(tm.getTabs().length, 0);
    assert.equal(tm.getActiveTabId(), null);
    assert.equal(tm.isHomeVisible(), true);
  });

  it('shows the home screen on boot when tabs were open but none was active', async () => {
    const tm1 = await freshTabManager();
    const tabA = await tm1.newProject('microscopy', { name: 'A' });
    await tm1.showHomeScreen();   // tabs stay open in the strip; no active tab

    const tm2 = await freshTabManager();
    await tm2.initTabManager();
    assert.equal(tm2.isHomeVisible(), true);
    assert.equal(tm2.getActiveTabId(), null);
    assert.deepEqual(tm2.getTabs().map(t => t.id), [tabA.id], 'the open tab set is preserved');
  });

  it('activates the first tab on boot if the saved active id no longer exists', async () => {
    const tm1 = await freshTabManager();
    const tabA = await tm1.newProject('microscopy', { name: 'A' });
    localStorage.setItem('loupe-open-tabs', JSON.stringify({ open: [tabA.id], active: 'missing-id' }));

    const tm2 = await freshTabManager();
    await tm2.initTabManager();
    assert.equal(tm2.getActiveTabId(), tabA.id);
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
