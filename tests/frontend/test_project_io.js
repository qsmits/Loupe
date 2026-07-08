/**
 * project-io.js: the import-type dispatcher (image vs .loupe vs v3-session
 * vs garbage), the .loupe build->parse->reconstruct round trip, the
 * v3->v4 migration-to-project path, and the legacy-autosave migration-offer
 * decision logic (convert/discard/no-op).
 *
 * Scope, per the task brief: file-download (exportProjectAsLoupe, needs a
 * browser FileReader for blobToDataUrl) and real drag/drop DOM wiring are
 * manual/deferred — not tested here. Everything below drives importFile()
 * and offerAutosaveMigration() end to end against the real tab-manager.js
 * (adoptProject -> putProject/openProject) over the in-memory IDB stub, the
 * same harness test_tab_manager.js uses.
 *
 * tab-manager.js is a module singleton with no reset hook; project-io.js
 * imports it via a fixed (non-cache-busted) specifier, so this file cannot
 * get a fresh tab-manager instance per test the way test_tab_manager.js
 * does (that would desync project-io.js's internal adoptProject from this
 * file's own tab-manager handle). Instead, every assertion reads back the
 * project that was JUST imported via getActiveTabId()/getActiveTab() (the
 * import path always ends in openProject -> activateTab, so the imported
 * project is always the active tab immediately after awaiting importFile),
 * rather than depending on tab count or a reset tabs array.
 *
 * Run with: node --test tests/frontend/test_project_io.js
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import './dom-stub.js';
import { createIdbStub } from './idb-stub.js';
import { _setIndexedDbFactory, getProject, putProject } from '../../frontend/projects-db.js';
import { restoreWorkspace, freshWorkspaceRecord } from '../../frontend/workspace.js';
import { buildWorkspaceV4 } from '../../frontend/project-format.js';
import { _setNoticeHandler, _setToastHandler } from '../../frontend/shell.js';
import * as tm from '../../frontend/tab-manager.js';
import { importFile, offerAutosaveMigration, initProjectIo } from '../../frontend/project-io.js';

// initTabManager() (called indirectly by nothing here — we drive newProject/
// adoptProject directly) is never invoked in this file, so no setInterval/
// beforeunload handles are created; nothing to tear down.

let _idb;
let notices;   // captured showNotice({title,message,buttons}) calls, this test
let toasts;    // captured showToast(message, opts) calls, this test
beforeEach(() => {
  _idb = createIdbStub();
  _setIndexedDbFactory(_idb);
  localStorage.clear();
  restoreWorkspace(freshWorkspaceRecord());
  notices = [];
  toasts = [];
  // Safe default: resolve any notice with its "affirmative" id so a stray
  // "one tab per instrument" swap-confirm (unrelated to what a given test is
  // probing) never hangs. Tests that care about notice content install their
  // own capturing stub below instead.
  _setNoticeHandler(opts => { notices.push(opts); return opts.buttons.at(-1).id; });
  _setToastHandler((message, opts) => { toasts.push({ message, opts }); });
});
after(() => { _setNoticeHandler(null); _setToastHandler(null); });

function fakeFile(name, type, text) {
  return { name, type, text: async () => text };
}

describe('importFile dispatcher', () => {
  it('routes an image/* file to a new microscopy project carrying that image', async () => {
    const file = new File(['jpeg-bytes'], 'gear-photo.jpg', { type: 'image/jpeg' });
    await importFile(file);

    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.type, 'microscopy');
    assert.equal(proj.name, 'gear-photo');
    assert.equal(proj.imageMeta.source, 'file');
    assert.equal(proj.imageMeta.filename, 'gear-photo.jpg');
    assert.equal(proj.imageMeta.w, 8);   // FakeImage stub's default natural size
    assert.equal(proj.imageMeta.h, 6);
    assert.ok(proj.image, 'the dropped file must be stored as the project image');
    assert.equal(proj.workspace, null, 'a fresh image import has no prior workspace');
  });

  it('strips a multi-dot extension only once when naming from the filename', async () => {
    const file = new File(['x'], 'part.v2.png', { type: 'image/png' });
    await importFile(file);
    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.name, 'part.v2');
  });

  it('routes a .loupe file to importLoupeText regardless of its MIME type', async () => {
    const loupeObj = {
      format: 'loupe-project', loupeVersion: 1,
      project: {
        id: null, type: 'microscopy', name: 'From Loupe File',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      imageMeta: null, imageDataUrl: null, workspace: null,
    };
    const file = fakeFile('bracket.loupe', '', JSON.stringify(loupeObj));
    await importFile(file);

    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.type, 'microscopy');
    assert.equal(proj.name, 'From Loupe File');
  });

  it('routes a renamed .loupe payload (JSON body, no .loupe extension) by its "format" field', async () => {
    // A user can rename/save a .loupe file with a .json extension (or none);
    // the dispatcher must still recognize it by content, not just suffix.
    const loupeObj = {
      format: 'loupe-project', loupeVersion: 1,
      project: {
        id: null, type: 'microscopy', name: 'Renamed Loupe',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      imageMeta: null, imageDataUrl: null, workspace: null,
    };
    const file = fakeFile('exported-project.json', '', JSON.stringify(loupeObj));
    await importFile(file);

    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.type, 'microscopy');
    assert.equal(proj.name, 'Renamed Loupe',
      'must be recognized as a .loupe payload by "format", not fall through to the session importer');
  });

  it('routes plain v3 session JSON (an annotations array, not loupe-project) to the migration path', async () => {
    const v3 = {
      version: 3, annotations: [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 5, y: 0 } }],
    };
    const file = fakeFile('microscope-session-20260101.json', '', JSON.stringify(v3));
    await importFile(file);

    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.type, 'microscopy');
    assert.equal(proj.name, 'microscope-session-20260101');
    assert.equal(proj.image, null, 'v3 sessions never carry the image');
    assert.equal(proj.workspace.version, 4);
    assert.equal(proj.workspace.annotations.length, 1);
    assert.ok(toasts.some(t => /do not include the image/.test(t.message)),
      'must toast that the image is missing');
  });

  it('reports a clear error for a file that is neither JSON, .loupe, nor an image', async () => {
    const before = tm.getActiveTabId();
    const file = fakeFile('notes.txt', 'text/plain', 'just some prose, not JSON at all');
    await importFile(file);

    assert.equal(tm.getActiveTabId(), before, 'a garbage import must not open a new tab');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, 'Import failed');
    assert.match(notices[0].message, /not valid JSON/);
  });

  it('reports a clear error for JSON that is neither a loupe project nor a session file', async () => {
    const before = tm.getActiveTabId();
    const file = fakeFile('random.json', '', JSON.stringify({ hello: 'world' }));
    await importFile(file);

    assert.equal(tm.getActiveTabId(), before);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /neither a \.loupe project nor a session file/);
  });

  it('reports the specific parseLoupe error for a corrupt .loupe file (bad JSON)', async () => {
    const file = fakeFile('corrupt.loupe', '', 'not json at all');
    await importFile(file);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, 'Import failed');
    assert.match(notices[0].message, /Not a valid JSON file/);
  });

  it('reports the specific parseLoupe error for an unknown project type', async () => {
    const loupeObj = {
      format: 'loupe-project', loupeVersion: 1,
      project: {
        id: null, type: 'hologram', name: 'X',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const file = fakeFile('weird.loupe', '', JSON.stringify(loupeObj));
    await importFile(file);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /Unknown project type "hologram"/);
  });

  it('reports the specific migrateV3ToV4 error for an invalid session file', async () => {
    const bad = { version: 3, annotations: [], calibration: { pixelsPerMm: -1, displayUnit: 'mm' } };
    const file = fakeFile('bad-session.json', '', JSON.stringify(bad));
    await importFile(file);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /bad calibration/);
  });
});

describe('.loupe build -> parse -> reconstruct round trip', () => {
  it('reconstructs project metadata, workspace and embedded image end to end', async () => {
    const rec = freshWorkspaceRecord();
    rec.state.tool = 'circle';
    rec.state.calibration = { pixelsPerMm: 50, displayUnit: 'mm' };
    rec.state.annotations = [
      { type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, purpose: 'measurement' },
    ];
    const ws = buildWorkspaceV4(rec);

    // 1x1 red PNG, same fixture as test_project_format.js.
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const loupeObj = {
      format: 'loupe-project', loupeVersion: 1,
      project: {
        id: null, type: 'microscopy', name: 'Roundtrip Bracket',
        createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z',
      },
      // Supplying imageMeta up front sidesteps the imageDims() decode path
      // (dom-stub's FakeImage always succeeds, so this isn't load-bearing
      // for correctness, just keeps the test independent of that stub).
      imageMeta: { w: 1, h: 1, source: 'file', filename: 'b.png' },
      imageDataUrl: dataUrl,
      workspace: ws,
    };
    const file = fakeFile('roundtrip.loupe', '', JSON.stringify(loupeObj));
    await importFile(file);

    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.name, 'Roundtrip Bracket');
    assert.equal(proj.type, 'microscopy');
    assert.equal(proj.createdAt, '2026-02-02T00:00:00.000Z');
    assert.ok(proj.image instanceof Blob);
    assert.equal(proj.image.type, 'image/png');
    assert.ok(proj.image.size > 20);
    assert.deepEqual(proj.imageMeta, { w: 1, h: 1, source: 'file', filename: 'b.png' });
    assert.equal(proj.workspace.version, 4);
    assert.equal(proj.workspace.tool, 'circle');
    assert.equal(proj.workspace.calibration.pixelsPerMm, 50);
    assert.equal(proj.workspace.annotations.length, 1);
    assert.equal(proj.workspace.annotations[0].type, 'distance');
  });

  it('regenerates the project id when a null/invalid embedded id round-trips', async () => {
    const loupeObj = {
      format: 'loupe-project', loupeVersion: 1,
      project: {
        id: null, type: 'microscopy', name: 'No Id',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      imageMeta: null, imageDataUrl: null, workspace: null,
    };
    const file = fakeFile('noid.loupe', '', JSON.stringify(loupeObj));
    await importFile(file);
    const id = tm.getActiveTabId();
    assert.match(id, /^[0-9a-f-]{36}$/, 'adoptProject must mint a fresh UUID when the .loupe carried none');
  });

  it('mints a fresh id and leaves the pre-existing project untouched when the imported .loupe id collides', async () => {
    const existing = {
      id: 'collide-id-1234', type: 'microscopy', name: 'Existing Project',
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      thumbnail: null, image: null, imageMeta: null, workspace: null,
    };
    await putProject(existing);

    const loupeObj = {
      format: 'loupe-project', loupeVersion: 1,
      project: {
        id: 'collide-id-1234', type: 'microscopy', name: 'Imported Colliding Project',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      imageMeta: null, imageDataUrl: null, workspace: null,
    };
    const file = fakeFile('collide.loupe', '', JSON.stringify(loupeObj));
    await importFile(file);

    const newId = tm.getActiveTabId();
    assert.notEqual(newId, 'collide-id-1234',
      'adoptProject must mint a fresh id instead of overwriting the existing project with the same id');
    assert.match(newId, /^[0-9a-f-]{36}$/);

    const imported = await getProject(newId);
    assert.equal(imported.name, 'Imported Colliding Project');

    const original = await getProject('collide-id-1234');
    assert.ok(original, 'the pre-existing project must still be retrievable under its original id');
    assert.equal(original.name, 'Existing Project', 'the pre-existing project must be unchanged');
    assert.equal(original.updatedAt, '2025-01-01T00:00:00.000Z');
  });
});

describe('offerAutosaveMigration', () => {
  it('does nothing when no legacy autosave key exists', async () => {
    await offerAutosaveMigration();
    assert.equal(notices.length, 0, 'must not prompt when there is nothing to migrate');
  });

  it('silently discards and does not prompt when the stored value fails migration', async () => {
    localStorage.setItem('microscope-autosave', 'not even json');
    await offerAutosaveMigration();
    assert.equal(notices.length, 0);
    assert.equal(localStorage.getItem('microscope-autosave'), null, 'the unreadable key must be cleared');
  });

  it('offers convert+discard and, on convert, adopts a "Recovered session" project then clears the key', async () => {
    localStorage.setItem('microscope-autosave', JSON.stringify({
      version: 3,
      annotations: [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, purpose: 'measurement' }],
    }));
    _setNoticeHandler(opts => {
      notices.push(opts);
      assert.equal(opts.title, 'Previous session found');
      assert.ok(opts.buttons.some(b => b.id === 'discard'));
      assert.ok(opts.buttons.some(b => b.id === 'convert' && b.primary));
      return 'convert';
    });

    await offerAutosaveMigration();

    assert.equal(localStorage.getItem('microscope-autosave'), null, 'the legacy key must be cleared either way');
    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.name, 'Recovered session');
    assert.equal(proj.type, 'microscopy');
    assert.equal(proj.image, null, 'v3 autosaves never carried the image');
    assert.equal(proj.workspace.annotations.length, 1);
  });

  it('on a failed convert (putProject rejects), preserves the legacy key and shows a failure toast — no data lost', async () => {
    // Force the "loupe"/"projects" store to exist in the in-memory IDB stub
    // before sabotaging it — same pattern as test_tab_manager.js's
    // "surfaces a toast and does not throw when deleteProjectRecord itself
    // fails" — so this drives a REAL rejection through putProject's actual
    // IndexedDB code path (asRequest -> onerror -> reqAsPromise reject),
    // not a stubbed adoptProject.
    await getProject('__warmup__');
    const store = _idb._databases.get('loupe').stores.get('projects');
    store.data.set = () => { throw new Error('simulated QuotaExceededError'); };

    const raw = JSON.stringify({
      version: 3,
      annotations: [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, purpose: 'measurement' }],
    });
    localStorage.setItem('microscope-autosave', raw);
    const before = tm.getActiveTabId();
    _setNoticeHandler(() => 'convert');

    await offerAutosaveMigration();

    assert.equal(localStorage.getItem('microscope-autosave'), raw,
      'a failed convert must NOT clear the legacy key — it is the only copy of the session');
    assert.equal(tm.getActiveTabId(), before, 'a failed convert must not open a new (unsaved) tab');
    assert.equal(toasts.length, 1, 'exactly one failure toast — no second "Project not found" toast on top of it');
    assert.match(toasts[0].message, /storage may be full/);
  });

  it('on discard, clears the key and adopts nothing', async () => {
    localStorage.setItem('microscope-autosave', JSON.stringify({
      version: 3,
      annotations: [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, purpose: 'measurement' }],
    }));
    const before = tm.getActiveTabId();
    _setNoticeHandler(() => 'discard');

    await offerAutosaveMigration();

    assert.equal(localStorage.getItem('microscope-autosave'), null);
    assert.equal(tm.getActiveTabId(), before, 'discard must not open any new tab/project');
  });
});

describe('initProjectIo wiring (smoke)', () => {
  // Full drag/drop DOM behavior (visual "drag-active" class, real File drag
  // events) is manual/deferred per the brief. This just proves the listener
  // registration doesn't throw and that the capture-phase global ".loupe
  // dropped anywhere" handler actually calls importFile — the one piece of
  // initProjectIo with non-trivial logic (deciding which drop to intercept).
  it('registers export-project/import-files/drop listeners without throwing', () => {
    assert.doesNotThrow(() => initProjectIo());
  });

  it('a capture-phase "drop" of a .loupe file anywhere in the app opens it as a new tab', async () => {
    initProjectIo();
    const loupeObj = {
      format: 'loupe-project', loupeVersion: 1,
      project: {
        id: null, type: 'microscopy', name: 'Dropped Anywhere',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      imageMeta: null, imageDataUrl: null, workspace: null,
    };
    const file = new File([JSON.stringify(loupeObj)], 'anywhere.loupe', { type: '' });
    let prevented = false, stopped = false;
    document.dispatchEvent({
      type: 'drop',
      dataTransfer: { files: [file] },
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });
    // The handler kicks off importFile() but doesn't await it (dom-stub's
    // dispatchEvent is synchronous) — give the microtask queue a turn.
    await new Promise(r => setTimeout(r, 0));

    assert.equal(prevented, true, 'must preventDefault so the browser does not navigate to the file');
    assert.equal(stopped, true, 'must stopPropagation so viewer/fringe drop handlers do not also fire');
    const proj = await getProject(tm.getActiveTabId());
    assert.equal(proj.name, 'Dropped Anywhere');
  });

  it('ignores a dropped file that is not a .loupe (leaves it for the mode-specific handler)', async () => {
    initProjectIo();
    const before = tm.getActiveTabId();
    const file = new File(['jpeg-bytes'], 'photo.jpg', { type: 'image/jpeg' });
    let prevented = false;
    document.dispatchEvent({
      type: 'drop',
      dataTransfer: { files: [file] },
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    });
    await new Promise(r => setTimeout(r, 0));

    assert.equal(prevented, false, 'a non-.loupe drop must be left alone for other handlers');
    assert.equal(tm.getActiveTabId(), before, 'must not have opened a new tab itself');
  });
});
