// fringe-progress.js — SSE streaming client + progress bar for fringe analysis.
//
// Streams POST /fringe/analyze-stream, updates a progress bar with stage
// labels, handles 30s inactivity timeout and error/retry states.

import { $ } from './fringe.js';

const TIMEOUT_MS = 30_000;

/**
 * Create the progress bar DOM and insert it after the analyze button.
 * Call once during init. Returns the container element.
 */
export function createProgressBar() {
  const btn = $("fringe-btn-analyze");
  if (!btn) return null;

  const container = document.createElement("div");
  container.className = "fringe-progress";
  container.hidden = true;
  container.innerHTML = `
    <div class="fringe-progress-bar">
      <div class="fringe-progress-fill" id="fringe-progress-fill"></div>
    </div>
    <div class="fringe-progress-label">
      <span id="fringe-progress-msg"></span>
      <button class="fringe-progress-retry" id="fringe-progress-retry" hidden>Retry</button>
    </div>
  `;

  btn.insertAdjacentElement("afterend", container);
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
  const container = document.querySelector(".fringe-progress");
  const fill = $("fringe-progress-fill");
  const msg = $("fringe-progress-msg");
  const retryBtn = $("fringe-progress-retry");

  if (!container || !fill || !msg) {
    onError("Progress bar not initialized");
    return;
  }

  // Reset state
  container.hidden = false;
  fill.style.width = "0%";
  fill.className = "fringe-progress-fill";
  msg.textContent = "Starting...";
  if (retryBtn) {
    retryBtn.hidden = true;
    if (onRetry) {
      retryBtn.onclick = () => {
        retryBtn.hidden = true;
        onRetry();
      };
    }
  }

  const controller = new AbortController();
  let timeoutId = null;

  function resetTimeout() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      controller.abort();
      fill.className = "fringe-progress-fill timeout";
      msg.textContent = "Analysis timed out (no response for 30s).";
      if (retryBtn && onRetry) retryBtn.hidden = false;
      onError("Timeout");
    }, TIMEOUT_MS);
  }

  try {
    resetTimeout();

    const response = await fetch("/fringe/analyze-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
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
          fill.style.width = "100%";
          fill.className = "fringe-progress-fill done";
          msg.textContent = "Complete";
          if (timeoutId) clearTimeout(timeoutId);
          setTimeout(() => { container.hidden = true; }, 1500);
          onResult(event.result);
          return;
        }

        if (event.stage === "error") {
          fill.className = "fringe-progress-fill error";
          msg.textContent = event.message || "Analysis failed";
          if (retryBtn && onRetry) retryBtn.hidden = false;
          if (timeoutId) clearTimeout(timeoutId);
          onError(event.message);
          return;
        }

        // Progress update
        if (typeof event.progress === "number") {
          fill.style.width = (event.progress * 100) + "%";
        }
        if (event.message) {
          msg.textContent = event.message;
        }
      }
    }

    // Stream ended without done/error event
    if (timeoutId) clearTimeout(timeoutId);
    fill.className = "fringe-progress-fill error";
    msg.textContent = "Stream ended unexpectedly";
    if (retryBtn && onRetry) retryBtn.hidden = false;
    onError("Stream ended unexpectedly");

  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId);
    if (e.name === "AbortError") return; // timeout already handled
    fill.className = "fringe-progress-fill error";
    msg.textContent = "Connection lost";
    if (retryBtn && onRetry) retryBtn.hidden = false;
    onError(e.message);
  }
}

/**
 * Hide and reset the progress bar.
 */
export function hideProgress() {
  const container = document.querySelector(".fringe-progress");
  if (container) container.hidden = true;
}
