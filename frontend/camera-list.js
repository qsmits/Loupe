import { apiFetch, withTimeout } from './api.js';
import { state } from './state.js';

// Discovery belongs to the device list, not the menu's open/close lifecycle.
// Keep it for this page session, including failures (retry is explicit).
let attempted = false;
let cameras = [];
let pending = null;
const rendered = new WeakMap();

function discoveryStatus(message) {
  const el = document.getElementById('camera-discovery-status');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

export function renderCameraList() {
  const info = state._cameraInfo;
  const browserActive = state.browserCamera?.active;
  const deviceId = state.browserCamera?.deviceId;
  const currentId = browserActive
    ? (deviceId ? `browser-cam-${deviceId}` : 'browser-cam')
    : (!info?.no_camera && info?.device_id !== 'n/a' ? info?.device_id : '');
  const scientific = cameras.filter(c => !c.id.startsWith('opencv-'));
  const webcams = cameras.filter(c => c.id.startsWith('opencv-'));
  const browser = state.browserCameraDevices?.length
    ? state.browserCameraDevices.filter(d => d.deviceId).map(d => ({
        id: `browser-cam-${d.deviceId}`, label: d.label,
      }))
    : [];
  if (!browser.length) browser.push({ id: 'browser-cam', label: 'Default webcam' });
  const groups = [
    ['Scientific cameras', scientific],
    ['Webcams', webcams],
    ['Browser cameras', browser],
  ];
  // An open device may be missing from enumeration. Never silently display
  // the first discovered device as though it were the active camera.
  if (currentId && !groups.some(([, entries]) => entries.some(c => c.id === currentId))) {
    groups.unshift(['Current camera', [{
      id: currentId, label: browserActive ? 'Browser camera (current)' : `${info.model || currentId} (current)`,
    }]]);
  }
  const signature = JSON.stringify([currentId || '', groups]);
  for (const id of ['camera-select', 'camera-select-top']) {
    const target = document.getElementById(id);
    if (!target) continue;
    if (rendered.get(target) !== signature) {
      target.innerHTML = '';
      if (!currentId) {
        const option = document.createElement('option');
        option.value = '';
        option.disabled = true;
        option.textContent = 'Select camera…';
        target.appendChild(option);
      }
      for (const [label, entries] of groups) {
        if (!entries.length) continue;
        const group = document.createElement('optgroup');
        group.label = label;
        for (const camera of entries) {
          const option = document.createElement('option');
          option.value = camera.id;
          option.textContent = camera.label;
          group.appendChild(option);
        }
        target.appendChild(group);
      }
      rendered.set(target, signature);
    }
    target.value = currentId || '';
  }
}

export function loadCameraList({ includeWebcams = false, refresh = false } = {}) {
  if (pending) return pending;
  renderCameraList();
  if (attempted && !refresh && !includeWebcams) return Promise.resolve();
  attempted = true;
  const refreshBtn = document.getElementById('btn-refresh-cameras');
  const scanBtn = document.getElementById('btn-scan-webcams');
  if (refreshBtn) refreshBtn.disabled = true;
  if (scanBtn) scanBtn.disabled = true;
  discoveryStatus(includeWebcams ? 'Scanning webcams…' : 'Looking for cameras…');

  pending = (async () => {
    // Covers all backend probes together, including webcam enumeration.
    const timeout = withTimeout(30000);
    try {
      const params = new URLSearchParams();
      if (includeWebcams) params.set('include_webcams', 'true');
      if (refresh) params.set('refresh', 'true');
      const query = params.toString();
      const response = await apiFetch(`/cameras${query ? `?${query}` : ''}`, { signal: timeout.signal });
      if (!response.ok) throw new Error('Camera discovery failed');
      const payload = await response.json();
      if (!Array.isArray(payload.cameras)) throw new Error('Invalid camera list');
      const incomplete = payload.status === 'timeout' || payload.status === 'error';
      // A partial scan must not discard known devices. Scientific refreshes
      // also retain webcams without probing them again (e.g. Continuity Camera).
      const retained = incomplete ? cameras : cameras.filter(c => !includeWebcams && c.id.startsWith('opencv-'));
      cameras = [...new Map([...retained, ...payload.cameras].map(c => [c.id, c])).values()];
      if (includeWebcams && scanBtn) scanBtn.textContent = 'Rescan webcams';
      renderCameraList();
      discoveryStatus(incomplete
        ? `Camera discovery ${payload.status === 'timeout' ? 'timed out' : 'failed'}. Existing choices kept. Use Refresh cameras to retry.`
        : cameras.length ? '' : 'No hardware cameras found. Connect a camera and use Refresh cameras, or choose a browser camera.');
    } catch {
      discoveryStatus(`Camera discovery ${timeout.didTimeout() ? 'timed out' : 'failed'}. Existing choices kept. Use Refresh cameras to retry.`);
    } finally {
      timeout.cancel();
      if (refreshBtn) refreshBtn.disabled = false;
      if (scanBtn) scanBtn.disabled = false;
      pending = null;
    }
  })();
  return pending;
}
