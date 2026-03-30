// api.js — Session-aware fetch wrapper for multi-user hosted mode.

if (!sessionStorage.getItem("sessionId")) {
  sessionStorage.setItem("sessionId", crypto.randomUUID());
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
