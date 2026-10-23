// fringe-progress.js — SSE streaming client + progress bar for fringe analysis.
//
// Streams POST /fringe/analyze-stream, updates a progress bar with stage
// labels, handles 30s inactivity timeout and error/retry states.

import { apiFetch } from './api.js';
import { state } from './state.js';
import { runBrowserAnalysis, cancelBrowserAnalysis } from './fringe-browser.js';
import { rememberBrowserResult } from './fringe-compute.js';
import { getSessionId } from './api.js';

const $ = id => document.getElementById(id);
let activeController = null;

export function cancelAnalysis(preserveIdle=false) {
  activeController?.abort();
  cancelBrowserAnalysis(preserveIdle);
  activeController = null;
}

function getTimeoutMs() { return state._hosted ? 120_000 : 30_000; }

/**
 * Create the progress bar and activity log inside the dialog's progress host.
 * Call once during init. Returns the container element.
 */
export function createProgressBar(host) {
  if (!host) return null;

  const container = document.createElement("div");
  container.className = "fringe-progress";
  container.hidden = true;
  container.innerHTML = `
    <div class="fringe-progress-bar" role="progressbar" aria-label="Analysis progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="fringe-progress-bar">
      <div class="fringe-progress-fill" id="fringe-progress-fill"></div>
    </div>
    <div class="fringe-progress-label">
      <span id="fringe-progress-msg" role="status"></span>
      <span id="fringe-progress-percent">0%</span>
      <button class="fringe-progress-retry" id="fringe-progress-retry" hidden>Retry</button>
    </div>
    <ol id="fringe-progress-log" class="fringe-progress-log" role="log" aria-label="Analysis activity"></ol>
  `;

  host.appendChild(container);
  return container;
}

/**
 * Run fringe analysis with SSE progress streaming.
 *
 * @param {object} body - JSON body for /fringe/analyze-stream
 * @param {function} onResult - called with the analysis result on success
 * @param {function} onError - called with error message string on failure
 * @param {function} [onRetry] - if provided, wired to the Retry button
 */
export async function analyzeWithProgress(body, onResult, onError, onRetry) {
  cancelAnalysis(true);
  const controller = new AbortController();
  activeController = controller;
  const epoch = state._epoch;
  const session = getSessionId();
  const local = body.execution_engine === "browser";
  const current = () => state._epoch === epoch && activeController === controller && !controller.signal.aborted;
  const container = document.querySelector(".fringe-progress");
  const fill = $("fringe-progress-fill");
  const msg = $("fringe-progress-msg");
  const retryBtn = $("fringe-progress-retry");

  if (!container || !fill || !msg) {
    activeController = null;
    onError("Progress bar not initialized");
    return;
  }

  const log = $("fringe-progress-log");
  if (log) log.textContent = "";
  const started = Date.now();
  let lastMessage = "";
  function activity(message) {
    if (!message || message === lastMessage) return;
    lastMessage = message;
    msg.textContent = message;
    if (log) {
      const item = document.createElement("li");
      item.textContent = `${((Date.now() - started) / 1000).toFixed(1)}s · ${message}`;
      log.appendChild(item);
      log.scrollTop = log.scrollHeight;
    }
  }
  function progress(value) {
    const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
    fill.style.width = percent + "%";
    $("fringe-progress-bar")?.setAttribute("aria-valuenow", String(percent));
    if ($("fringe-progress-percent")) $("fringe-progress-percent").textContent = percent + "%";
  }

  // Reset state
  container.hidden = false;
  progress(0);
  fill.className = "fringe-progress-fill";
  activity(local ? "Starting analysis in this browser — image stays on this device…" : "Sending image and starting analysis…");
  if (retryBtn) {
    retryBtn.hidden = true;
    if (onRetry) {
      retryBtn.onclick = () => {
        retryBtn.hidden = true;
        onRetry();
      };
    }
  }

  let timeoutId = null;

  function resetTimeout() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      if (!current()) return;
      controller.abort();
      fill.className = "fringe-progress-fill timeout";
      activity(`Analysis timed out (no response for ${getTimeoutMs() / 1000}s).`);
      if (retryBtn && onRetry) retryBtn.hidden = false;
      onError("Timeout");
    }, getTimeoutMs());
  }

  try {
    if (local) {
      const result = await runBrowserAnalysis('analyze', body, {signal:controller.signal,
        onProgress: event => { if (current()) { if (typeof event.progress === 'number') progress(event.progress); activity(event.message); } }});
      if (!current()) return;
      rememberBrowserResult(result, session);
      progress(1); fill.className = 'fringe-progress-fill done';
      activity('Complete in this browser — opening results.');
      onResult(result);
      return;
    }
    resetTimeout();

    const response = await apiFetch("/fringe/analyze-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!current()) { controller.abort(); return; }
    if (!response.ok) {
      let detail = "";
      try {
        const raw = await response.text();
        try {
          const j = JSON.parse(raw);
          if (j && typeof j.detail === "string") detail = j.detail;
        } catch { detail = raw.trim().slice(0, 200); }
      } catch { /* ignore */ }
      throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (!current()) { await reader.cancel(); return; }
      if (done) break;

      resetTimeout();
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        if (event.stage === "done") {
          progress(1);
          fill.className = "fringe-progress-fill done";
          activity("Complete — opening results.");
          if (timeoutId) clearTimeout(timeoutId);
          onResult(event.result);
          return;
        }

        if (event.stage === "error") {
          fill.className = "fringe-progress-fill error";
          activity(event.message || "Analysis failed");
          if (retryBtn && onRetry) retryBtn.hidden = false;
          if (timeoutId) clearTimeout(timeoutId);
          onError(event.message);
          return;
        }

        // Progress update
        if (typeof event.progress === "number") {
          progress(event.progress);
        }
        if (event.message) {
          activity(event.message);
        }
      }
    }

    // Stream ended without done/error event
    if (timeoutId) clearTimeout(timeoutId);
    fill.className = "fringe-progress-fill error";
    activity("Stream ended unexpectedly");
    if (retryBtn && onRetry) retryBtn.hidden = false;
    onError("Stream ended unexpectedly");

  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId);
    if (!current() || e.name === "AbortError") return; // timeout already handled
    fill.className = "fringe-progress-fill error";
    activity(local ? `Browser analysis failed: ${e.message}` : (String(e.message || "").startsWith("HTTP ") ? e.message : "Connection lost"));
    if (retryBtn && onRetry) retryBtn.hidden = false;
    onError(e.message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (activeController === controller) activeController = null;
  }
}

/**
 * Hide and reset the progress bar.
 */
export function hideProgress() {
  cancelAnalysis();
  const container = document.querySelector(".fringe-progress");
  if (container) container.hidden = true;
}
