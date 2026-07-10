// api.js — session-aware fetch for multi-user hosted mode + per-tab sessions.
//
// X-Session-ID is resolved PER CALL:
//   1. the registered provider (tab-manager registers the active project's
//      UUID — the project id doubles as the server session id, spec §tabs)
//   2. fallback: a stable client-generated UUID (kept in sessionStorage so
//      reloads reuse it; plain variable when sessionStorage is unavailable)
//
// apiFetchFrame() wraps frame-dependent endpoints (/detect-*, /align-*,
// /inspect-guided, /fit-feature, /refine-point, gear endpoints): when the
// server answers 400 "No frame stored" (TTL expiry, server restart, or a
// project restored from IndexedDB), it silently re-uploads the stored image
// Blob via the existing /load-image and retries exactly once.
//
// Node-importable: no top-level await, no unguarded DOM/sessionStorage.

import { state } from './state.js';
import { maybeShowUploadNotice } from './upload-notice.js';

let _sessionIdProvider = null;

/** Register `() => activeProjectId | null`. Pass null to unregister. */
export function setSessionIdProvider(fn) { _sessionIdProvider = fn; }

let _fallbackId = null;
function fallbackId() {
  if (_fallbackId) return _fallbackId;
  if (typeof sessionStorage !== "undefined") {
    _fallbackId = sessionStorage.getItem("sessionId") || crypto.randomUUID();
    try { sessionStorage.setItem("sessionId", _fallbackId); } catch { /* private mode */ }
  } else {
    _fallbackId = crypto.randomUUID();
  }
  return _fallbackId;
}

/** Current session ID (also used by sendBeacon/keepalive callers). */
export function getSessionId() {
  return _sessionIdProvider?.() || fallbackId();
}

/**
 * AbortController + timer factory for capping how long a fetch may run.
 * Pass `signal` into the fetch options; call `cancel()` on every completion
 * path (success or error) to clear the pending timer — otherwise it fires
 * later for nothing. `didTimeout()` distinguishes "this timer fired the
 * abort" from any other reason the signal might be aborted, so callers can
 * show a timeout-specific message only when that's actually what happened.
 */
export function withTimeout(ms) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    cancel() { clearTimeout(timer); },
    didTimeout: () => timedOut,
  };
}

/** Drop-in replacement for fetch() that adds X-Session-ID. */
export async function apiFetch(url, options = {}) {
  // Hosted instances: first frame-compute call shows a one-time
  // "image is sent to the server" notice and waits for acknowledgment.
  await maybeShowUploadNotice(url);
  const headers = new Headers(options.headers || {});
  headers.set("X-Session-ID", getSessionId());
  return fetch(url, { ...options, headers });
}

let _frameProvider = null;

/** Register `async () => Blob | null` returning the active tab's frozen
 *  frame. Pass null to unregister. */
export function setFrameProvider(fn) { _frameProvider = fn; }

const NO_FRAME_RE = /no frame stored/i;

function rebuildFailure(text, original) {
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
}

/**
 * apiFetch + one silent recovery: "No frame stored" → POST the stored
 * frame Blob to /load-image → retry the original request once.
 * The no-frame condition surfaces as 400 (most detect endpoints) or 404
 * (/refine-point); either status is only treated as recoverable when the
 * body matches NO_FRAME_RE — an unrelated 400/404 passes straight through.
 * NOTE: options.body must be re-sendable (string / FormData / Blob — all
 * callers qualify; never pass a ReadableStream).
 */
export async function apiFetchFrame(url, options = {}) {
  const first = await apiFetch(url, options);
  if (first.status !== 400 && first.status !== 404) return first;
  const text = await first.text();
  if (!NO_FRAME_RE.test(text)) return rebuildFailure(text, first);
  const blob = await _frameProvider?.();
  if (!blob) return rebuildFailure(text, first);
  const fd = new FormData();
  fd.append("file", blob, "frame.jpg");
  const up = await apiFetch("/load-image", { method: "POST", body: fd });
  if (!up.ok) {
    console.debug("[api] frame re-upload failed:", up.status);
    return rebuildFailure(text, first);
  }
  console.debug("[api] re-uploaded stored frame after 'No frame stored'; retrying", url);
  return apiFetch(url, options);
}

/**
 * Upload a corrected canvas so backend analysis operates on the corrected
 * image. Also updates state.frozenBlob so persistence and lazy re-upload
 * carry the corrected frame.
 * @param {HTMLCanvasElement} canvas
 */
export async function uploadCorrectedFrame(canvas) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) return;
  state.frozenBlob = blob;
  const fd = new FormData();
  fd.append("file", blob, "frame.jpg");
  await apiFetchFrame("/update-frame", { method: "POST", body: fd });
}
