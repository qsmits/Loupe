// projects-db.js — the ONLY persistence layer for projects.
//
// HARD RULE (spec): the server NEVER stores or lists projects. Everything
// here is browser-local IndexedDB ("loupe" DB, "projects" store, key = the
// project UUID which doubles as X-Session-ID for transient server frames).
//
// When IndexedDB is unavailable (e.g. Safari private mode) we fall back to
// an in-memory Map so the app stays usable, report it once via
// onStorageUnavailable (Task 12 shows a persistent banner), and
// isPersistent() returns false.

const DB_NAME = "loupe";
const DB_VERSION = 1;
const STORE = "projects";

let _factory = (typeof indexedDB !== "undefined") ? indexedDB : null;
let _dbPromise = null;
let _memory = null;              // Map<id, record> once fallen back
let _onUnavailable = null;
let _notified = false;

/** Test seam: swap the IndexedDB implementation (pass null to force the
 *  memory fallback). Resets all cached connections/fallback state. */
export function _setIndexedDbFactory(factory) {
  _factory = factory;
  _dbPromise = null;
  _memory = null;
  _notified = false;
  _onUnavailable = null;
}

export function isPersistent() { return _memory === null; }

export function onStorageUnavailable(fn) {
  _onUnavailable = fn;
  // If the fallback has already engaged, notify immediately so late subscribers
  // (e.g. banner component in private mode) don't miss the notification.
  if (_notified) {
    try { fn(); } catch { /* never let the banner break storage */ }
  }
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!_factory) { reject(new Error("IndexedDB unavailable")); return; }
    let req;
    try { req = _factory.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return _dbPromise;
}

/** Resolve the backing store: an IDB connection, or null after engaging the
 *  in-memory fallback (side effect: notifies once). */
async function backend() {
  if (_memory) return null;
  try {
    return await openDb();
  } catch (e) {
    console.warn("[projects-db] IndexedDB unavailable — using in-memory fallback:", e?.message ?? e);
    _memory = new Map();
    if (!_notified) {
      _notified = true;
      try { _onUnavailable?.(); } catch { /* never let the banner break storage */ }
    }
    return null;
  }
}

function memClone(value) {
  try { return structuredClone(value); } catch { return value; }
}

/** Insert or replace a full project record. Throws on write failure
 *  (e.g. QuotaExceededError) — callers surface a toast. */
export async function putProject(record) {
  if (!record || typeof record.id !== "string" || !record.id) {
    throw new Error("putProject: record.id required");
  }
  const db = await backend();
  if (!db) { _memory.set(record.id, memClone(record)); return; }
  await reqAsPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put(record));
}

export async function getProject(id) {
  const db = await backend();
  if (!db) return _memory.has(id) ? memClone(_memory.get(id)) : null;
  const result = await reqAsPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
  return result ?? null;
}

/** Lightweight listing for the home screen / tab restore — never includes
 *  the full image Blob or workspace. Sorted updatedAt desc. */
export async function listProjectSummaries() {
  const db = await backend();
  const all = db
    ? await reqAsPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll())
    : [..._memory.values()].map(memClone);
  return all
    .map(r => ({
      id: r.id,
      type: r.type,
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      thumbnail: r.thumbnail ?? null,
      imageBytes: r.image?.size ?? 0,
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteProjectRecord(id) {
  const db = await backend();
  if (!db) { _memory.delete(id); return; }
  await reqAsPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
}
