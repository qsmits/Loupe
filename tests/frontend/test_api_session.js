/**
 * api.js: per-call session-ID resolution + apiFetchFrame lazy frame
 * re-upload ("400 No frame stored" → POST /load-image → retry once).
 * Run with: node --test tests/frontend/test_api_session.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiFetch, apiFetchFrame, getSessionId, setSessionIdProvider, setFrameProvider,
} from '../../frontend/api.js';

const realFetch = globalThis.fetch;
let calls;      // [{ url, options }]
let script;     // Response[] consumed in order

beforeEach(() => {
  calls = [];
  script = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return script.shift() ?? new Response('{}', { status: 200 });
  };
  setSessionIdProvider(null);
  setFrameProvider(null);
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('session id resolution', () => {
  it('uses the provider (project UUID) when registered', async () => {
    setSessionIdProvider(() => '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    await apiFetch('/detect-circles', { method: 'POST' });
    assert.equal(calls[0].options.headers.get('X-Session-ID'),
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('falls back to a stable client UUID when the provider returns null', async () => {
    setSessionIdProvider(() => null);
    const a = getSessionId();
    const b = getSessionId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.equal(a, b, 'fallback id must be stable within the page');
    await apiFetch('/frame');
    assert.equal(calls[0].options.headers.get('X-Session-ID'), a);
  });
});

describe('apiFetchFrame — lazy frame re-upload', () => {
  const noFrame = (status = 400) =>
    new Response('No frame stored. Call /freeze first.', { status });

  it('on 400 no-frame: uploads the provider blob to /load-image and retries once', async () => {
    setFrameProvider(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
    script = [noFrame(), new Response('{"width":4,"height":3}', { status: 200 }),
              new Response('{"circles":[]}', { status: 200 })];
    const r = await apiFetchFrame('/detect-circles', { method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { circles: [] });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, '/load-image');
    assert.equal(calls[1].options.method, 'POST');
    assert.ok(calls[1].options.body instanceof FormData);
    assert.equal(calls[2].url, '/detect-circles');
  });

  it('on 404 no-frame (e.g. /refine-point): uploads the provider blob to /load-image and retries once', async () => {
    setFrameProvider(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
    script = [noFrame(404), new Response('{"width":4,"height":3}', { status: 200 }),
              new Response('{"x":1,"y":2}', { status: 200 })];
    const r = await apiFetchFrame('/refine-point', { method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { x: 1, y: 2 });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, '/load-image');
    assert.equal(calls[1].options.method, 'POST');
    assert.ok(calls[1].options.body instanceof FormData);
    assert.equal(calls[2].url, '/refine-point');
  });

  it('a 404 WITHOUT the no-frame message passes through untouched (not a blanket 404 retry)', async () => {
    setFrameProvider(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
    script = [new Response('Point not found', { status: 404 })];
    const r = await apiFetchFrame('/refine-point', { method: 'POST' });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'Point not found');
    assert.equal(calls.length, 1, 'must not attempt /load-image');
  });

  it('retries at most once (second 400 is returned as-is)', async () => {
    setFrameProvider(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
    script = [noFrame(), new Response('{}', { status: 200 }), noFrame()];
    const r = await apiFetchFrame('/detect-circles', { method: 'POST' });
    assert.equal(r.status, 400);
    assert.equal(calls.length, 3);
  });

  it('a different 400 passes through untouched (body still readable)', async () => {
    setFrameProvider(async () => new Blob(['x']));
    script = [new Response('Invalid session ID format', { status: 400 })];
    const r = await apiFetchFrame('/detect-circles', { method: 'POST' });
    assert.equal(r.status, 400);
    assert.equal(await r.text(), 'Invalid session ID format');
    assert.equal(calls.length, 1, 'must not attempt /load-image');
  });

  it('no frame provider / no stored blob: original 400 comes back readable', async () => {
    script = [noFrame()];
    const r = await apiFetchFrame('/detect-circles', { method: 'POST' });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /No frame stored/);
    assert.equal(calls.length, 1);
  });

  it('non-400 responses pass straight through', async () => {
    script = [new Response('ok', { status: 200 })];
    const r = await apiFetchFrame('/frame');
    assert.equal(await r.text(), 'ok');
    assert.equal(calls.length, 1);
  });

  it('failed /load-image upload does not retry the original request', async () => {
    setFrameProvider(async () => new Blob(['jpeg']));
    script = [noFrame(), new Response('Image too large', { status: 413 })];
    const r = await apiFetchFrame('/detect-circles', { method: 'POST' });
    assert.equal(r.status, 400);
    assert.equal(calls.length, 2);
  });
});
