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
