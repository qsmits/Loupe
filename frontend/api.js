// api.js — Session-aware fetch wrapper for multi-user hosted mode.

// On first load in a tab, request a server-issued session token.
// If the server is unreachable (offline / local file), fall back to
// a client-generated UUID.  sessionStorage keeps the token for the
// lifetime of the tab so subsequent navigations skip the fetch.
if (!sessionStorage.getItem("sessionId")) {
  try {
    const resp = await fetch("/session/new", { method: "POST" });
    if (resp.ok) {
      const data = await resp.json();
      sessionStorage.setItem("sessionId", data.session_id);
    }
  } catch { /* server unreachable — fall through to client-generated ID */ }
  if (!sessionStorage.getItem("sessionId")) {
    sessionStorage.setItem("sessionId", crypto.randomUUID());
  }
}

const SESSION_ID = sessionStorage.getItem("sessionId");

/**
 * Drop-in replacement for fetch() that adds X-Session-ID header.
 */
export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Session-ID", SESSION_ID);
  return fetch(url, { ...options, headers });
}

/** Get the current session ID (for sendBeacon/keepalive fallback). */
export function getSessionId() {
  return SESSION_ID;
}

/**
 * Upload a corrected canvas to the server so backend analysis (detection,
 * guided inspection, sub-pixel refinement) operates on the corrected image.
 * Call this after any client-side image correction (lens distortion, perspective).
 *
 * @param {HTMLCanvasElement} canvas — the corrected image canvas
 */
export async function uploadCorrectedFrame(canvas) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) return;
  const fd = new FormData();
  fd.append("file", blob, "frame.jpg");
  await apiFetch("/update-frame", { method: "POST", body: fd });
}
