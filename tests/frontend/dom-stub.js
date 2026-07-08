/**
 * Minimal global browser stubs so tab-manager.js (and the render.js /
 * browser-camera.js / modes.js / cross-mode.js chain it pulls in) can be
 * imported and exercised under `node --test` far enough to drive its
 * PURE state-transition logic (open/activate/close, swap-on-activate,
 * autosave gating, open-set persistence).
 *
 * NOT a faithful DOM. `document.getElementById` returns null for anything
 * not explicitly registered — this matters: several call sites rely on
 * "element doesn't exist yet" (e.g. the home screen isn't built until a
 * later task, cross-mode's action bar only exists during mask editing).
 * Auto-vivifying every id would silently change control flow. The one
 * exception is "overlay-canvas": render.js dereferences it and calls
 * `.getContext("2d")` at module top level, so it must resolve to a
 * working stub for the import itself to succeed.
 *
 * Actual rendering (canvas draws, camera <img> src swaps, Preact DOM
 * output) is out of scope here — those are the manual/deferred
 * verification steps in the task brief.
 *
 * Side effect on import: installs `document`, `window`, `localStorage`,
 * `navigator.mediaDevices` stand-ins on globalThis. Must be imported
 * before any (dynamic or static) import of frontend modules that touch
 * the DOM at load time.
 */

function noop() {}

function makeCtx2d() {
  const ctx = {};
  const methods = [
    'save', 'restore', 'translate', 'scale', 'rotate', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arc', 'arcTo', 'bezierCurveTo', 'quadraticCurveTo',
    'rect', 'fill', 'stroke', 'clip', 'clearRect', 'fillRect', 'strokeRect',
    'drawImage', 'putImageData', 'setTransform', 'transform', 'setLineDash',
  ];
  for (const m of methods) ctx[m] = noop;
  ctx.getImageData = () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
  ctx.measureText = () => ({ width: 0 });
  ctx.createLinearGradient = () => ({ addColorStop: noop });
  ctx.createRadialGradient = () => ({ addColorStop: noop });
  return ctx;
}

function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {},
    children: [],
    hidden: false,
    width: 0,
    height: 0,
    textContent: '',
    value: '',
    naturalWidth: 0,
    naturalHeight: 0,
    videoWidth: 0,
    videoHeight: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(evt) {
      for (const fn of listeners.get(evt.type) ?? []) fn(evt);
      return true;
    },
    appendChild(child) { el.children.push(child); return child; },
    removeChild(child) { el.children = el.children.filter(c => c !== child); },
    remove: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => makeCtx2d(),
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }),
    toBlob(cb, type) { cb({ __fakeBlob: true, type: type || 'image/png' }); },
    getAttribute: () => null,
    setAttribute: noop,
    focus: noop,
    click: noop,
  };
  return el;
}

// id → stub element. Pre-seeded with only what's load-bearing for import.
const elementRegistry = new Map();
elementRegistry.set('overlay-canvas', makeElement('canvas'));

/** Test seam: register a fake element for an id (e.g. "home-screen") when a
 *  test wants to observe DOM-visibility toggling. Not used by default. */
export function registerElement(id, el) { elementRegistry.set(id, el); }

/** Test seam: drop everything back to just the load-bearing canvas stub. */
export function resetElements() {
  elementRegistry.clear();
  elementRegistry.set('overlay-canvas', makeElement('canvas'));
}

const docListeners = new Map();
globalThis.document = {
  title: '',
  body: makeElement('body'),
  getElementById(id) { return elementRegistry.has(id) ? elementRegistry.get(id) : null; },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => makeElement(tag),
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  dispatchEvent(evt) {
    for (const fn of docListeners.get(evt.type) ?? []) fn(evt);
    return true;
  },
};

const winListeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    if (!winListeners.has(type)) winListeners.set(type, new Set());
    winListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
  dispatchEvent(evt) {
    for (const fn of winListeners.get(evt.type) ?? []) fn(evt);
    return true;
  },
};

let lsStore = new Map();
globalThis.localStorage = {
  getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: k => lsStore.delete(k),
  clear: () => lsStore.clear(),
};

/** Fake Image: onload fires (via microtask) with a small natural size, so
 *  the lazy image-restore path in tab-manager.js's ensureRecordLoaded can
 *  be exercised without a real decoder. */
class FakeImage {
  set src(v) {
    this._src = v;
    queueMicrotask(() => {
      this.naturalWidth = this.naturalWidth || 8;
      this.naturalHeight = this.naturalHeight || 6;
      this.onload?.();
    });
  }
  get src() { return this._src; }
}
globalThis.Image = FakeImage;

// Node 21+ already provides a read-only `navigator` global; browser-camera.js
// only touches `navigator.mediaDevices` inside functions we never call here
// (isBrowserCameraActive/stopBrowserCamera don't need it), so nothing to stub.
