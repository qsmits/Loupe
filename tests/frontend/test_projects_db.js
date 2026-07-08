/**
 * Project store against the in-memory IndexedDB stub, plus the
 * IDB-unavailable memory fallback.
 * Run with: node --test tests/frontend/test_projects_db.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createIdbStub } from './idb-stub.js';
import {
  putProject, getProject, listProjectSummaries, deleteProjectRecord,
  isPersistent, onStorageUnavailable, _setIndexedDbFactory,
} from '../../frontend/projects-db.js';

function proj(id, name, updatedAt, extra = {}) {
  return {
    id, type: 'microscopy', name,
    createdAt: '2026-07-08T08:00:00Z', updatedAt,
    thumbnail: null, image: null, imageMeta: null, workspace: null,
    ...extra,
  };
}
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('projects-db against the IDB stub', () => {
  beforeEach(() => { _setIndexedDbFactory(createIdbStub()); });

  it('put → get round-trips a record, including a Blob image', async () => {
    const image = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
    await putProject(proj(ID_A, 'Bracket', '2026-07-08T10:00:00Z', {
      image, imageMeta: { w: 4, h: 3, source: 'file', filename: 'b.png' },
      workspace: { version: 4, annotations: [] },
    }));
    const got = await getProject(ID_A);
    assert.equal(got.name, 'Bracket');
    assert.ok(got.image instanceof Blob);
    assert.equal(got.image.size, 15);
    assert.equal(got.workspace.version, 4);
  });

  it('getProject returns null for unknown ids', async () => {
    assert.equal(await getProject(ID_A), null);
  });

  it('listProjectSummaries sorts by updatedAt desc and reports image size', async () => {
    await putProject(proj(ID_A, 'Old', '2026-07-01T00:00:00Z'));
    await putProject(proj(ID_B, 'New', '2026-07-08T00:00:00Z', {
      image: new Blob(['12345'], { type: 'image/jpeg' }),
    }));
    const list = await listProjectSummaries();
    assert.deepEqual(list.map(s => s.name), ['New', 'Old']);
    assert.equal(list[0].imageBytes, 5);
    assert.equal(list[1].imageBytes, 0);
    assert.ok(!('workspace' in list[0]), 'summaries must not carry the workspace');
    assert.ok(!('image' in list[0]), 'summaries must not carry the full image');
  });

  it('put overwrites by id (upsert)', async () => {
    await putProject(proj(ID_A, 'v1', '2026-07-01T00:00:00Z'));
    await putProject(proj(ID_A, 'v2', '2026-07-02T00:00:00Z'));
    assert.equal((await getProject(ID_A)).name, 'v2');
    assert.equal((await listProjectSummaries()).length, 1);
  });

  it('deleteProjectRecord removes the record', async () => {
    await putProject(proj(ID_A, 'Doomed', '2026-07-01T00:00:00Z'));
    await deleteProjectRecord(ID_A);
    assert.equal(await getProject(ID_A), null);
  });

  it('is persistent when IDB works', async () => {
    await putProject(proj(ID_A, 'x', '2026-07-01T00:00:00Z'));
    assert.equal(isPersistent(), true);
  });
});

describe('memory fallback when IndexedDB is unavailable', () => {
  it('falls back, notifies once, and keeps working in-memory', async () => {
    let notified = 0;
    _setIndexedDbFactory(null);            // simulate Safari private mode
    onStorageUnavailable(() => { notified += 1; });
    await putProject(proj(ID_A, 'Ephemeral', '2026-07-08T00:00:00Z'));
    await putProject(proj(ID_B, 'Also', '2026-07-09T00:00:00Z'));
    assert.equal(isPersistent(), false);
    assert.equal(notified, 1);
    assert.equal((await getProject(ID_A)).name, 'Ephemeral');
    assert.deepEqual((await listProjectSummaries()).map(s => s.name), ['Also', 'Ephemeral']);
    await deleteProjectRecord(ID_A);
    assert.equal(await getProject(ID_A), null);
  });

  it('late subscriber is notified immediately when fallback already engaged', async () => {
    _setIndexedDbFactory(null);
    await putProject(proj(ID_A, 'x', '2026-07-08T00:00:00Z')); // trigger fallback engagement
    let notified = 0;
    onStorageUnavailable(() => { notified += 1; });
    // The subscriber must fire immediately, synchronously, without requiring another await
    assert.equal(notified, 1, 'late subscriber should fire immediately');
  });

  it('early subscriber fires exactly once (no double-fire)', async () => {
    _setIndexedDbFactory(null);
    let notified = 0;
    onStorageUnavailable(() => { notified += 1; });
    // Now trigger the fallback
    await putProject(proj(ID_A, 'x', '2026-07-08T00:00:00Z'));
    assert.equal(notified, 1, 'early subscriber should fire exactly once');
    // Register a second subscriber after fallback is engaged
    let notified2 = 0;
    onStorageUnavailable(() => { notified2 += 1; });
    assert.equal(notified2, 1, 'second subscriber should also fire exactly once (immediate)');
    assert.equal(notified, 1, 'first subscriber should not fire again');
  });

  it('stub captures pre-mutation snapshot on put (direct stub test)', async () => {
    // Test the stub's clone timing directly, since the module's async nature
    // makes it hard to test through putProject. This proves the fix works.
    const stub = createIdbStub();
    const openReq = stub.open('test-db', 1);
    // Wait for open to complete
    const db = await new Promise(resolve => {
      openReq.onsuccess = () => resolve(openReq.result);
    });
    db.createObjectStore('test-store', { keyPath: 'id' });
    const store = db.transaction('test-store', 'readwrite').objectStore('test-store');

    // Create a record with a nested object
    const record = { id: 'test-1', name: 'original', nested: { field: 'value' } };
    // Call put() synchronously — the clone must happen now, not in the async callback
    const putReq = store.put(record);
    // Mutate the original record immediately, before the async callback runs
    record.name = 'mutated-name';
    record.nested.field = 'mutated-value';
    // Wait for the put callback to run
    await new Promise(resolve => { putReq.onsuccess = resolve; });

    // Retrieve the stored record
    const getReq = store.get('test-1');
    const stored = await new Promise(resolve => {
      getReq.onsuccess = () => resolve(getReq.result);
    });

    // The stored record must have the original values, not the mutated ones
    assert.equal(stored.name, 'original',
      'stored record name must be the pre-mutation snapshot');
    assert.equal(stored.nested.field, 'value',
      'stored record nested field must be the pre-mutation snapshot');
  });
});
