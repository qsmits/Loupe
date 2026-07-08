/**
 * Storage-unavailable banner trigger (Task 12).
 *
 * frontend/main.js is a plain wiring script — it has no exports and throws
 * on import without a full browser DOM (see dom-stub.js's header note that
 * it isn't a faithful DOM), so it can't be imported directly under
 * `node --test`. Real DOM rendering of the banner is manual/deferred per
 * the task brief (verify in a Safari private window / DevTools storage
 * block).
 *
 * What IS pure and testable here:
 *   1. The banner handler's own idempotency guard (never creates a second
 *      #storage-banner element no matter how many times it's invoked).
 *   2. That it wires correctly to the real onStorageUnavailable() seam
 *      (frontend/projects-db.js, Task 3) — in particular the "late
 *      subscriber" guarantee, which is what makes it safe for main.js to
 *      register this handler at boot even if some other code path (e.g.
 *      listProjectSummaries() during tab restore) already triggered the
 *      fallback before initShell() ran.
 *
 * `makeStorageBannerHandler` below is a byte-for-byte copy of the callback
 * passed to onStorageUnavailable() directly after initShell() in
 * frontend/main.js — keep the two in sync if that snippet changes.
 *
 * Run with: node --test tests/frontend/test_storage_banner.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { onStorageUnavailable, _setIndexedDbFactory, putProject } from '../../frontend/projects-db.js';

/** Minimal document stub: just enough surface for the banner snippet
 *  (getElementById / createElement / body.prepend), with prepend() indexing
 *  by id so getElementById can find what was just inserted — mirroring a
 *  real DOM closely enough to exercise the idempotency guard. */
function makeDocumentStub() {
  const byId = new Map();
  const body = {
    children: [],
    prepend(el) {
      body.children.unshift(el);
      if (el.id) byId.set(el.id, el);
    },
  };
  return {
    body,
    getElementById: id => byId.get(id) ?? null,
    createElement: tag => ({ tagName: tag, id: '', textContent: '' }),
  };
}

// Exact copy of the frontend/main.js onStorageUnavailable callback.
function makeStorageBannerHandler(doc) {
  return () => {
    if (doc.getElementById("storage-banner")) return;
    const banner = doc.createElement("div");
    banner.id = "storage-banner";
    banner.textContent =
      "Storage unavailable (private browsing?) — projects will NOT persist. " +
      "Export anything important as .loupe.";
    doc.body.prepend(banner);
  };
}

describe('storage-unavailable banner handler', () => {
  it('creates exactly one banner even when invoked repeatedly (idempotent)', () => {
    const doc = makeDocumentStub();
    const handler = makeStorageBannerHandler(doc);

    handler();
    handler();
    handler();

    assert.equal(doc.body.children.length, 1, 'must never insert a second banner');
    assert.equal(doc.body.children[0].id, 'storage-banner');
    assert.match(doc.body.children[0].textContent, /will NOT persist/);
    assert.match(doc.body.children[0].textContent, /\.loupe/);
  });

  it('fires for a subscriber registered AFTER the fallback already engaged (late-subscriber guarantee)', async () => {
    _setIndexedDbFactory(null);   // simulate Safari private mode / IDB blocked
    // Something else (e.g. a tab-restore listProjectSummaries() call) trips
    // the fallback before the banner handler gets a chance to register.
    await putProject({
      id: 'warm', type: 'microscopy', name: 'x',
      createdAt: 'a', updatedAt: 'a', thumbnail: null, image: null,
      imageMeta: null, workspace: null,
    });

    const doc = makeDocumentStub();
    onStorageUnavailable(makeStorageBannerHandler(doc));

    assert.equal(doc.body.children.length, 1, 'late subscriber must still get the banner immediately');
    assert.equal(doc.body.children[0].id, 'storage-banner');
  });

  it('fires when the fallback engages after the handler is already registered', async () => {
    _setIndexedDbFactory(null);
    const doc = makeDocumentStub();
    onStorageUnavailable(makeStorageBannerHandler(doc));
    assert.equal(doc.body.children.length, 0, 'must not fire before the fallback has actually engaged');

    await putProject({
      id: 'a', type: 'microscopy', name: 'x',
      createdAt: 'a', updatedAt: 'a', thumbnail: null, image: null,
      imageMeta: null, workspace: null,
    });

    assert.equal(doc.body.children.length, 1);
  });
});
