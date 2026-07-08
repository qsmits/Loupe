/**
 * Minimal in-memory IndexedDB stub — just enough surface for
 * frontend/projects-db.js: open → onupgradeneeded/onsuccess,
 * createObjectStore(keyPath), transaction().objectStore(),
 * put/get/getAll/delete requests with onsuccess/onerror.
 *
 * Values are structuredClone'd on write and read (like real IDB), with a
 * pass-by-reference fallback for anything structuredClone rejects.
 *
 * Not a test file — exports a factory used by test_projects_db.js.
 */

function clone(value) {
  try { return structuredClone(value); } catch { return value; }
}

function asRequest(fn) {
  const req = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      req.result = fn();
      req.onsuccess?.({ target: req });
    } catch (e) {
      req.error = e;
      req.onerror?.({ target: req });
    }
  });
  return req;
}

// Same request-callback contract as asRequest, but `fn`'s return value is
// awaited before firing onsuccess/onerror — used by put() only, so tests can
// fault-inject an in-flight delay (e.g. `store.data.set = (...a) =>
// somePromise.then(() => realSet(...a))`) in addition to the synchronous-
// throw idiom the other request types (get/getAll/delete) already support.
function asAsyncRequest(fn) {
  const req = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    Promise.resolve().then(fn).then(
      (result) => { req.result = result; req.onsuccess?.({ target: req }); },
      (e) => { req.error = e; req.onerror?.({ target: req }); },
    );
  });
  return req;
}

export function createIdbStub() {
  const databases = new Map();   // name → { version, stores: Map<name, {keyPath, data: Map}> }

  function makeStoreApi(store) {
    return {
      put(value) {
        // Clone synchronously at call time, before the async request callback,
        // to match real IndexedDB's behavior. This catches callers who mutate
        // the record after put without awaiting.
        const cloned = clone(value);
        return asAsyncRequest(() => {
          const key = cloned[store.keyPath];
          if (key === undefined) throw new Error("no key");
          return Promise.resolve(store.data.set(key, cloned)).then(() => key);
        });
      },
      get(key) {
        return asRequest(() => {
          const v = store.data.get(key);
          return v === undefined ? undefined : clone(v);
        });
      },
      getAll() {
        return asRequest(() => [...store.data.values()].map(clone));
      },
      delete(key) {
        return asRequest(() => { store.data.delete(key); return undefined; });
      },
    };
  }

  function makeConnection(db) {
    return {
      objectStoreNames: { contains: (n) => db.stores.has(n) },
      createObjectStore(name, opts = {}) {
        db.stores.set(name, { keyPath: opts.keyPath, data: new Map() });
        return makeStoreApi(db.stores.get(name));
      },
      transaction(storeNames, _mode) {
        return {
          objectStore(name) {
            const s = db.stores.get(name);
            if (!s) throw new Error(`no such store: ${name}`);
            return makeStoreApi(s);
          },
        };
      },
      close() {},
    };
  }

  return {
    open(name, version = 1) {
      const req = {
        result: null, error: null,
        onsuccess: null, onerror: null, onupgradeneeded: null,
      };
      queueMicrotask(() => {
        let db = databases.get(name);
        const needsUpgrade = !db || version > db.version;
        if (!db) {
          db = { version, stores: new Map() };
          databases.set(name, db);
        }
        db.version = Math.max(db.version, version);
        req.result = makeConnection(db);
        if (needsUpgrade) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    _databases: databases,   // test introspection
  };
}
