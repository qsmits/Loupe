import './dom-stub.js';
import { registerElement, resetElements } from './dom-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';
import { regionFromDrag } from '../../frontend/fringe-region.js';
import { analyzeWithProgress, cancelAnalysis } from '../../frontend/fringe-progress.js';
import { fr } from '../../frontend/fringe.js';
import { resetFringeAnalysis, analyzeFromFile, cancelFringeWork } from '../../frontend/fringe-panel.js';

test('mask regions use image coordinates, reverse drags, clamp edges, and reject clicks', () => {
  assert.deepEqual(regionFromDrag({x: 1.2, y: .8}, {x: -.1, y: .2}), {
    include: true, vertices: [{x: 0, y: .2}, {x: 1, y: .2}, {x: 1, y: .8}, {x: 0, y: .8}],
  });
  assert.equal(regionFromDrag({x: .3, y: .3}, {x: .301, y: .5}), null);
  const hole = regionFromDrag({x: .2, y: .3}, {x: .8, y: .7}, 'ellipse', false);
  assert.equal(hole.include, false);
  assert.equal(hole.vertices.length, 64);
  assert.ok(hole.vertices.every(p => Math.abs(((p.x - .5) / .3) ** 2 + ((p.y - .5) / .2) ** 2 - 1) < 1e-10));
});

function progressDom(t) {
  resetElements();
  state._hosted = false;
  const nodes = {};
  for (const name of ['fill', 'msg', 'retry', 'log', 'percent', 'bar']) {
    nodes[name] = document.createElement('div');
    registerElement('fringe-progress-' + name, nodes[name]);
  }
  const container = document.createElement('div');
  t.mock.method(document, 'querySelector', selector => selector === '.fringe-progress' ? container : null);
  return nodes;
}
const encode = text => new TextEncoder().encode(text);
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
function response(chunks) {
  return new Response(new ReadableStream({start(controller) {
    chunks.forEach(chunk => controller.enqueue(encode(chunk)));
    controller.close();
  }}));
}

test('streamed stages update progress and a readable log, including split events and keepalives', async t => {
  const nodes = progressDom(t);
  const stream = event({stage: 'unwrap', progress: .5, message: 'Unwrapping phase…'});
  t.mock.method(globalThis, 'fetch', async () => response([
    ': keepalive\n\n', stream.slice(0, 20), stream.slice(20), event({stage: 'done', result: {pv_nm: 12}}),
  ]));
  let result;
  await analyzeWithProgress({}, data => { result = data; }, assert.fail);
  assert.deepEqual(result, {pv_nm: 12});
  assert.equal(nodes.fill.style.width, '100%');
  assert.equal(nodes.percent.textContent, '100%');
  assert.ok(nodes.log.children.some(el => el.textContent.includes('Unwrapping phase…')));
});

test('an analysis error is visible and never yields a successful result', async t => {
  const nodes = progressDom(t);
  t.mock.method(globalThis, 'fetch', async () => response([event({stage: 'error', message: 'No carrier found'})]));
  let error;
  await analyzeWithProgress({}, assert.fail, message => { error = message; });
  assert.equal(error, 'No carrier found');
  assert.equal(nodes.msg.textContent, error);
  assert.match(nodes.fill.className, /error/);
});

test('HTTP capacity errors remain readable so the user can retry', async t => {
  const nodes = progressDom(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({detail: 'Analysis queue is full'}), {status: 503}));
  let error;
  await analyzeWithProgress({}, assert.fail, message => { error = message; });
  assert.match(error, /503.*Analysis queue is full/);
  assert.equal(nodes.msg.textContent, error);
});

test('cancelling an already streaming response rejects late completion events', async t => {
  progressDom(t);
  let streamController;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { streamController = controller; },
  })));
  const work = analyzeWithProgress({}, assert.fail, assert.fail);
  await new Promise(resolve => setImmediate(resolve));
  cancelAnalysis();
  streamController.enqueue(encode(event({stage: 'done', result: {id: 'late'}})));
  streamController.close();
  await work;
});

for (const action of ['cancel', 'new-analysis', 'project-switch']) {
  test(`${action} prevents an older response from changing the current result`, async t => {
    const nodes = progressDom(t);
    let release;
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { release = resolve; }));
    const old = analyzeWithProgress({}, assert.fail, assert.fail);
    await new Promise(resolve => setImmediate(resolve));
    const releaseOld = release;
    if (action === 'cancel') cancelAnalysis();
    if (action === 'project-switch') state._epoch++;
    if (action === 'new-analysis') {
      t.mock.method(globalThis, 'fetch', async () => response([event({stage: 'done', result: {id: 'new'}})]));
      await analyzeWithProgress({}, data => assert.equal(data.id, 'new'), assert.fail);
    }
    const message = nodes.msg.textContent;
    releaseOld(response([event({stage: 'done', result: {id: 'old'}})]));
    await old;
    assert.equal(nodes.msg.textContent, message);
  });
}

function workspaceDom() {
  resetElements();
  for (const id of ['fringe-avg-count', 'fringe-btn-avg-reset', 'fringe-analysis-status',
    'fringe-source-name', 'fringe-surface-content', 'fringe-empty', 'fringe-3d-content',
    'fringe-3d-empty', 'fringe-profiles-content', 'fringe-profiles-empty', 'fringe-btn-export-csv']) {
    registerElement(id, document.createElement('div'));
  }
}

function pngHeader() {
  const png = new Uint8Array(33);
  png.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  new DataView(png.buffer).setUint32(16, 10);
  new DataView(png.buffer).setUint32(20, 10);
  return png;
}

test('loading a replacement file clears stale results without starting analysis', async t => {
  workspaceDom();
  t.mock.method(globalThis, 'fetch', () => assert.fail('File selection must not start server analysis'));
  Object.assign(fr, {lastResult: {pv_nm: 12}, sourceName: 'old.png', maskPolygons: [{vertices: []}]});
  await analyzeFromFile(new File([pngHeader()], 'replacement.png', {type: 'image/png'}));
  assert.equal(fr.lastResult, null);
  assert.equal(fr.sourceName, 'replacement.png');
  assert.ok(fr.droppedImageB64);
  assert.deepEqual(fr.maskPolygons, []);
  assert.match(document.getElementById('fringe-analysis-status').textContent, /not analyzed yet/);
  resetFringeAnalysis();
});

test('reset clears the displayed source, grids, measurements and results on every result tab', () => {
  workspaceDom();
  Object.assign(fr, {lastResult: {pv_nm: 15}, droppedImageB64: 'abc', sourceName: 'old.png',
    analyzedAt: '2026-10-23T12:00:00Z', heightGrid: new Float32Array([2]), maskGrid: new Uint8Array([1]),
    maskPolygons: [{vertices: []}], measurements: [{value: 2}], avgCaptures: [{id: 'old'}]});
  resetFringeAnalysis();
  assert.equal(fr.lastResult, null);
  assert.equal(fr.droppedImageB64, null);
  assert.equal(fr.heightGrid, null);
  assert.equal(fr.analyzedAt, null);
  assert.deepEqual(fr.measurements, []);
  assert.deepEqual(fr.maskPolygons, []);
  assert.deepEqual(fr.avgCaptures, []);
  for (const id of ['fringe-surface-content', 'fringe-3d-content', 'fringe-profiles-content']) {
    assert.equal(document.getElementById(id).hidden, true);
  }
  assert.equal(document.getElementById('fringe-btn-export-csv').disabled, true);
});

test('a late file decode cannot restore an image after reset', async () => {
  workspaceDom();
  let finishRead;
  const file = {name: 'late.png', type: 'image/png', size: 33,
    arrayBuffer: () => new Promise(resolve => { finishRead = resolve; })};
  const loading = analyzeFromFile(file);
  resetFringeAnalysis();
  finishRead(pngHeader().buffer);
  await loading;
  assert.equal(fr.droppedImageB64, null);
  assert.equal(fr.sourceName, null);
  cancelFringeWork();
});
