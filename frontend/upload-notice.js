// upload-notice.js — one-time "image is sent to the server" notice (Track A #4).
//
// On the hosted instance (state._hosted, set from /config/ui), the first
// server-side compute feature the user triggers (edge/circle/line/arc
// detection, DXF alignment, guided inspection, feature fitting, server-side
// sub-pixel refinement, gradient overlay) shows a dialog explaining that the
// frozen image is sent to the server for processing. Acknowledged once per
// page load; "don't show again" persists across reloads via localStorage.
// api.js::apiFetch awaits maybeShowUploadNotice() before every request, so
// new call sites are covered automatically as long as their endpoint is
// listed below. Never shown on a local bench server (state._hosted false).

import { state } from './state.js';

const STORAGE_KEY = 'loupe-upload-notice-ack';

// Endpoints that read the per-session frozen frame on the server.
// Keep in sync with backend/api.py when adding compute endpoints.
export const FRAME_UPLOAD_ENDPOINTS = [
  '/detect-edges', '/detect-circles', '/detect-lines', '/detect-lines-merged',
  '/detect-arcs-partial', '/preprocessed-view',
  '/align-dxf', '/align-dxf-edges',
  '/inspect-guided', '/fit-feature',
  '/refine-point', '/gradient-overlay',
  // Gear-analysis compute endpoints that read the frozen frame
  '/analyze-gear', '/detect-gear-teeth', '/auto-phase-gear',
];

/** Pure: does this URL hit a server-side frame-compute endpoint? */
export function isFrameUploadEndpoint(url) {
  const path = String(url).split('?')[0];
  return FRAME_UPLOAD_ENDPOINTS.some(p => path === p || path.startsWith(p + '/'));
}

let _acknowledged = false;   // once per page load
let _pending = null;         // in-flight dialog promise (double-click guard)

/**
 * Resolve immediately unless this is the hosted instance's first
 * frame-compute call this page load, in which case show the notice dialog
 * and resolve when the user clicks Continue.
 * @returns {Promise<void>}
 */
export function maybeShowUploadNotice(url) {
  if (_acknowledged || !state._hosted || !isFrameUploadEndpoint(url)) return Promise.resolve();
  try {
    if (localStorage.getItem(STORAGE_KEY) === '1') { _acknowledged = true; return Promise.resolve(); }
  } catch { /* storage unavailable (private mode) — show the dialog each load */ }
  if (_pending) return _pending;

  const dialog = document.getElementById('upload-notice-dialog');
  const okBtn = document.getElementById('btn-upload-notice-ok');
  const dontShow = document.getElementById('upload-notice-dont-show');
  if (!dialog || !okBtn) return Promise.resolve();  // markup missing — never block requests

  _pending = new Promise(resolve => {
    dialog.hidden = false;
    okBtn.addEventListener('click', () => {
      dialog.hidden = true;
      _acknowledged = true;
      _pending = null;
      if (dontShow?.checked) {
        try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
      }
      resolve();
    }, { once: true });
  });
  return _pending;
}
