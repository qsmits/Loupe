import { registerElement, resetElements } from './dom-stub.js';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';

let list, select, status, requests;
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  resetElements();
  state._cameraInfo = { device_id: 'science-1', model: 'Microscope' };
  state.browserCamera = null;
  state.browserCameraDevices = null;
  for (const id of ['camera-select-top', 'camera-discovery-status', 'btn-refresh-cameras', 'btn-scan-webcams']) {
    const el = document.createElement(id === 'camera-select-top' ? 'select' : 'div');
    Object.defineProperty(el, 'innerHTML', { set() { this.children = []; } });
    registerElement(id, el);
  }
  select = document.getElementById('camera-select-top');
  status = document.getElementById('camera-discovery-status');
  requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    return Response.json({ status: 'ok', cameras: [{ id: 'science-1', label: 'Microscope' }] });
  };
  list = await import(`../../frontend/camera-list.js?test=${Math.random()}`);
});
afterEach(() => { globalThis.fetch = originalFetch; });
const options = () => select.children.flatMap(c => c.tagName === 'OPTGROUP' ? c.children : [c]);

test('reopening uses the existing list and leaves option nodes intact', async () => {
  await list.loadCameraList();
  const nodes = [...select.children];
  await list.loadCameraList();
  await list.loadCameraList();
  assert.deepEqual(requests, ['/cameras']);
  assert.equal(select.children[0], nodes[0]);
  assert.equal(select.value, 'science-1');
});

test('refresh keeps choices usable and coalesces overlapping discovery', async () => {
  await list.loadCameraList();
  const nodes = [...select.children];
  let resolve;
  globalThis.fetch = url => {
    requests.push(url);
    return new Promise(r => { resolve = r; });
  };
  const refresh = list.loadCameraList({ refresh: true });
  assert.equal(list.loadCameraList(), refresh);
  assert.equal(select.children[0], nodes[0]);
  assert.notEqual(select.disabled, true);
  assert.equal(document.getElementById('btn-refresh-cameras').disabled, true);
  await new Promise(r => setImmediate(r));
  resolve(Response.json({ status: 'ok', cameras: [{ id: 'science-2', label: 'New camera' }] }));
  await refresh;
  assert.deepEqual(requests, ['/cameras', '/cameras?refresh=true']);
  assert.equal(document.getElementById('btn-refresh-cameras').disabled, false);
  assert.equal(select.value, 'science-1');
  assert.ok(options().some(o => o.value === 'science-2'));
});

test('failed and partial discovery preserve known devices and report a retry action', async () => {
  await list.loadCameraList();
  globalThis.fetch = async () => Response.json({ status: 'timeout', cameras: [{ id: 'dc1394-2', label: 'FireWire' }] });
  await list.loadCameraList({ refresh: true });
  assert.match(status.textContent, /timed out.*Refresh cameras/);
  assert.ok(options().some(o => o.value === 'science-1'));
  assert.ok(options().some(o => o.value === 'dc1394-2'));
  globalThis.fetch = async () => new Response('Offline', { status: 503 });
  await list.loadCameraList({ refresh: true });
  assert.match(status.textContent, /failed/);
  assert.ok(options().some(o => o.value === 'dc1394-2'));
});

test('initial failure leaves browser camera selectable and reopening does not retry', async () => {
  state._cameraInfo = { no_camera: true };
  globalThis.fetch = async url => { requests.push(url); throw new Error('Offline'); };
  await list.loadCameraList();
  await list.loadCameraList();
  assert.deepEqual(requests, ['/cameras']);
  assert.equal(select.value, '');
  assert.ok(options().some(o => o.value === 'browser-cam'));
  assert.notEqual(select.disabled, true);
  assert.match(status.textContent, /Refresh cameras/);
});

test('discovered cameras are not presented as selected when none is active', async () => {
  state._cameraInfo = { no_camera: true, device_id: 'n/a' };
  await list.loadCameraList();
  assert.equal(select.value, '');
  assert.equal(options()[0].textContent, 'Select camera…');
});

test('switching cameras updates selection without discovery and rolls back failed choices', async () => {
  await list.loadCameraList();
  state._cameraInfo = { device_id: 'science-2', model: 'Second camera' };
  list.renderCameraList();
  assert.equal(select.value, 'science-2');
  select.value = 'browser-cam';
  await list.loadCameraList();
  assert.equal(select.value, 'science-2');
  state.browserCamera = { active: true, deviceId: 'usb' };
  state.browserCameraDevices = [{ deviceId: 'usb', label: 'USB webcam' }];
  await list.loadCameraList();
  assert.equal(select.value, 'browser-cam-usb');
  assert.deepEqual(requests, ['/cameras']);
});

test('scientific refresh retains scanned webcams without probing webcams again', async () => {
  globalThis.fetch = async url => {
    requests.push(url);
    return Response.json({ status: 'ok', cameras: url.includes('include_webcams') ? [{ id: 'opencv-0', label: 'Webcam' }] : [] });
  };
  await list.loadCameraList({ includeWebcams: true });
  await list.loadCameraList({ refresh: true });
  assert.deepEqual(requests, ['/cameras?include_webcams=true', '/cameras?refresh=true']);
  assert.ok(options().some(o => o.value === 'opencv-0'));
  await list.loadCameraList({ includeWebcams: true });
  assert.equal(requests[2], '/cameras?include_webcams=true');
});
