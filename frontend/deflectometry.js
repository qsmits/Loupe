// deflectometry.js — Phase-measuring deflectometry wizard UI.
//
// Drives a deflectometry session from the measurement PC:
//   1. Starts a backend session (server issues a pairing URL for the iPad).
//   2. Polls iPad connection status while the dialog is open.
//   3. Triggers a capture sequence (displays 8 phase-shifted fringe patterns
//      on the iPad and grabs a frame per pattern).
//   4. Computes phase maps and shows them side-by-side with PV/RMS/Mean stats.
//
// Mirrors the zstack / superres / stitch wizard pattern: a single dialog
// built on first open, reused on subsequent opens, closed via the header
// `×` button. State is scoped to this module — does NOT touch core `state`.

import { apiFetch } from './api.js';

const df = {
  sessionId: null,
  polling: null,         // setInterval handle while dialog is open
  initialized: false,    // has the first-open /status probe run?
};

function $(id) { return document.getElementById(id); }

function buildDialog() {
  if ($("deflectometry-dialog")) return;

  const dlg = document.createElement("div");
  dlg.id = "deflectometry-dialog";
  dlg.className = "dialog-overlay";
  dlg.hidden = true;
  dlg.innerHTML = `
    <div class="dialog-content" style="max-width:900px;width:92vw">
      <div class="dialog-header">
        <span class="dialog-title">Deflectometry (Phase-Measuring)</span>
        <button class="dialog-close" id="btn-deflectometry-close">✕</button>
      </div>
      <div style="padding:14px 18px;flex:1;min-height:0;overflow-y:auto">
        <p style="margin:0 0 10px;opacity:0.85;font-size:13px">
          Pair an iPad as a fringe display, then capture an 8-step phase-shift
          sequence. The backend computes wrapped phase maps in X and Y; PV/RMS
          of the phase are a direct proxy for the specular surface's local
          slope error.
        </p>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 10px;background:#161616;border:1px solid #2a2a2a;border-radius:3px;flex-wrap:wrap">
          <label style="font-size:13px">iPad pairing code:</label>
          <input type="text" id="deflectometry-pair-code" maxlength="4" placeholder="A3X7" style="width:80px;text-transform:uppercase;font-family:monospace;font-size:18px;text-align:center;letter-spacing:4px" />
          <button class="detect-btn" id="btn-deflectometry-pair" style="flex-shrink:0">Pair</button>
          <span id="deflectometry-ipad-status" style="font-size:12px;padding:3px 8px;border-radius:3px;background:#3a1a1a;color:#f87171;border:1px solid #7a2a2a">iPad: disconnected</span>
        </div>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <label style="font-size:13px">Fringe frequency (cycles):</label>
          <input type="number" id="deflectometry-freq" min="2" max="64" step="1" value="16"
                 style="width:90px" />
          <button class="detect-btn" id="btn-deflectometry-flatfield" style="margin-left:8px;min-width:80px">Flat Field</button>
          <button class="detect-btn" id="btn-deflectometry-capture" style="min-width:150px">Capture Sequence</button>
          <button class="detect-btn" id="btn-deflectometry-compute" style="min-width:110px">Compute</button>
          <button class="detect-btn" id="btn-deflectometry-reset" style="min-width:80px">Reset</button>
          <button class="detect-btn" id="btn-deflectometry-diag" style="min-width:100px">Diagnostics</button>
        </div>

        <div id="deflectometry-progress" style="font-size:12px;opacity:0.85;min-height:1.4em;margin-bottom:10px;font-variant-numeric:tabular-nums"></div>

        <div id="deflectometry-result" hidden style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px">
          <div>
            <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Phase X (vertical fringes)</div>
            <img id="deflectometry-phase-x-img" style="width:100%;border:1px solid #444;background:#111;display:block" />
            <pre id="deflectometry-phase-x-stats" style="margin:6px 0 0;padding:6px 8px;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:3px;font-size:11px;font-variant-numeric:tabular-nums;white-space:pre">—</pre>
          </div>
          <div>
            <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Phase Y (horizontal fringes)</div>
            <img id="deflectometry-phase-y-img" style="width:100%;border:1px solid #444;background:#111;display:block" />
            <pre id="deflectometry-phase-y-stats" style="margin:6px 0 0;padding:6px 8px;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:3px;font-size:11px;font-variant-numeric:tabular-nums;white-space:pre">—</pre>
          </div>
        </div>

        <div id="deflectometry-diag-result" hidden style="margin-top:14px;border-top:1px solid #2a2a2a;padding-top:12px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">Diagnostics</div>
          <pre id="deflectometry-diag-framestats" style="margin:0 0 10px;padding:6px 8px;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:3px;font-size:11px;overflow-x:auto">—</pre>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Modulation X (fringe contrast)</div>
              <img id="deflectometry-diag-mod-x" style="width:100%;border:1px solid #444;background:#111;display:block" />
              <pre id="deflectometry-diag-mod-x-stats" style="margin:4px 0 0;padding:4px 6px;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:3px;font-size:10px">—</pre>
            </div>
            <div>
              <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Modulation Y (fringe contrast)</div>
              <img id="deflectometry-diag-mod-y" style="width:100%;border:1px solid #444;background:#111;display:block" />
              <pre id="deflectometry-diag-mod-y-stats" style="margin:4px 0 0;padding:4px 6px;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:3px;font-size:10px">—</pre>
            </div>
            <div>
              <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Wrapped phase X</div>
              <img id="deflectometry-diag-wrap-x" style="width:100%;border:1px solid #444;background:#111;display:block" />
            </div>
            <div>
              <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Wrapped phase Y</div>
              <img id="deflectometry-diag-wrap-y" style="width:100%;border:1px solid #444;background:#111;display:block" />
            </div>
            <div>
              <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Unwrapped X (before tilt removal)</div>
              <img id="deflectometry-diag-unw-x" style="width:100%;border:1px solid #444;background:#111;display:block" />
            </div>
            <div>
              <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Unwrapped Y (before tilt removal)</div>
              <img id="deflectometry-diag-unw-y" style="width:100%;border:1px solid #444;background:#111;display:block" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  $("btn-deflectometry-close").addEventListener("click", closeDialog);
  $("btn-deflectometry-pair").addEventListener("click", pairIpad);
  $("btn-deflectometry-flatfield").addEventListener("click", flatField);
  $("btn-deflectometry-capture").addEventListener("click", captureSequence);
  $("btn-deflectometry-compute").addEventListener("click", compute);
  $("btn-deflectometry-reset").addEventListener("click", resetSession);
  $("btn-deflectometry-diag").addEventListener("click", runDiagnostics);
}

function setProgress(text) {
  const el = $("deflectometry-progress");
  if (el) el.textContent = text || "";
}

function setIpadStatus(connected) {
  const el = $("deflectometry-ipad-status");
  if (!el) return;
  if (connected) {
    el.textContent = "iPad: connected";
    el.style.background = "#0f2a16";
    el.style.color = "#4ade80";
    el.style.borderColor = "#1f5a2e";
  } else {
    el.textContent = "iPad: disconnected";
    el.style.background = "#3a1a1a";
    el.style.color = "#f87171";
    el.style.borderColor = "#7a2a2a";
  }
}

async function pairIpad() {
  const input = $("deflectometry-pair-code");
  if (!input) return;
  const code = input.value.trim().toUpperCase();
  if (!code || code.length < 1) {
    setProgress("Enter the code shown on the iPad.");
    return;
  }
  setProgress("Pairing...");
  try {
    const r = await apiFetch("/deflectometry/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (r.status === 404) {
      setProgress("No iPad with that code found.");
      return;
    }
    if (!r.ok) {
      const msg = await r.text();
      setProgress("Pair failed: " + msg);
      return;
    }
    input.value = "";
    setIpadStatus(true);
    setProgress("iPad paired.");
  } catch (e) {
    setProgress("Pair failed: " + (e && e.message ? e.message : String(e)));
  }
}

async function flatField() {
  const btn = $("btn-deflectometry-flatfield");
  if (btn) btn.disabled = true;
  setProgress("Capturing flat field\u2026");
  try {
    const r = await apiFetch("/deflectometry/flat-field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      setProgress("Flat field failed: " + msg);
      return;
    }
    setProgress("Flat field captured.");
  } catch (e) {
    setProgress("Flat field failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function formatStats(stats) {
  if (!stats) return "—";
  const pv = Number.isFinite(stats.pv) ? stats.pv.toFixed(3) : "—";
  const rms = Number.isFinite(stats.rms) ? stats.rms.toFixed(3) : "—";
  const mean = Number.isFinite(stats.mean) ? stats.mean.toFixed(3) : "—";
  return `PV:   ${pv} rad\nRMS:  ${rms} rad\nMean: ${mean} rad`;
}

function renderResult(result) {
  if (!result) return;
  const resultEl = $("deflectometry-result");
  if (!resultEl) return;
  if (result.phase_x_png_b64) {
    $("deflectometry-phase-x-img").src = `data:image/png;base64,${result.phase_x_png_b64}`;
  }
  if (result.phase_y_png_b64) {
    $("deflectometry-phase-y-img").src = `data:image/png;base64,${result.phase_y_png_b64}`;
  }
  $("deflectometry-phase-x-stats").textContent = formatStats(result.stats_x);
  $("deflectometry-phase-y-stats").textContent = formatStats(result.stats_y);
  resultEl.hidden = false;
}

async function refreshStatus() {
  try {
    const r = await apiFetch("/deflectometry/status");
    if (!r.ok) return null;
    const data = await r.json();
    setIpadStatus(!!data.ipad_connected);
    return data;
  } catch {
    return null;
  }
}

function startPolling() {
  stopPolling();
  df.polling = setInterval(refreshStatus, 1000);
}

function stopPolling() {
  if (df.polling) {
    clearInterval(df.polling);
    df.polling = null;
  }
}

async function startSession() {
  const r = await apiFetch("/deflectometry/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) {
    setProgress("Failed to start deflectometry session.");
    return false;
  }
  const data = await r.json();
  df.sessionId = data.session_id;
  setIpadStatus(!!data.ipad_connected);
  return true;
}

async function captureSequence() {
  const btn = $("btn-deflectometry-capture");
  const freqEl = $("deflectometry-freq");
  let freq = parseInt(freqEl ? freqEl.value : "16", 10);
  if (!Number.isFinite(freq) || freq < 2) freq = 2;
  if (freq > 64) freq = 64;
  if (btn) { btn.disabled = true; }
  setProgress(`Capturing phase-shift sequence (freq=${freq})…`);
  try {
    const r = await apiFetch("/deflectometry/capture-sequence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freq }),
    });
    if (!r.ok) {
      const msg = await r.text();
      setProgress("Capture failed: " + msg);
      return;
    }
    setProgress("Captured 8/8. Click Compute.");
  } catch (e) {
    setProgress("Capture failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function compute() {
  const btn = $("btn-deflectometry-compute");
  if (btn) { btn.disabled = true; }
  setProgress("Computing phase maps…");
  try {
    const r = await apiFetch("/deflectometry/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      setProgress("Compute failed: " + msg);
      return;
    }
    const data = await r.json();
    renderResult(data);
    setProgress("Compute complete.");
  } catch (e) {
    setProgress("Compute failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runDiagnostics() {
  const btn = $("btn-deflectometry-diag");
  if (btn) btn.disabled = true;
  setProgress("Running diagnostics…");
  try {
    const r = await apiFetch("/deflectometry/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      setProgress("Diagnostics failed: " + msg);
      return;
    }
    const d = await r.json();
    const diagEl = $("deflectometry-diag-result");
    if (!diagEl) return;

    // Frame stats table
    const lines = d.frame_stats.map(f =>
      `${f.name.padEnd(16)} min:${f.min.toFixed(1).padStart(6)} max:${f.max.toFixed(1).padStart(6)} mean:${f.mean.toFixed(1).padStart(6)} std:${f.std.toFixed(1).padStart(6)}`
    );
    $("deflectometry-diag-framestats").textContent = lines.join("\n");

    // Modulation maps
    const b64 = s => `data:image/png;base64,${s}`;
    $("deflectometry-diag-mod-x").src = b64(d.modulation_x.png_b64);
    $("deflectometry-diag-mod-y").src = b64(d.modulation_y.png_b64);
    const fmtMod = m => `min:${m.min.toFixed(1)} max:${m.max.toFixed(1)} mean:${m.mean.toFixed(1)} median:${m.median.toFixed(1)}`;
    $("deflectometry-diag-mod-x-stats").textContent = fmtMod(d.modulation_x);
    $("deflectometry-diag-mod-y-stats").textContent = fmtMod(d.modulation_y);

    // Wrapped + unwrapped phase
    $("deflectometry-diag-wrap-x").src = b64(d.wrapped_x_png_b64);
    $("deflectometry-diag-wrap-y").src = b64(d.wrapped_y_png_b64);
    $("deflectometry-diag-unw-x").src = b64(d.unwrapped_raw_x_png_b64);
    $("deflectometry-diag-unw-y").src = b64(d.unwrapped_raw_y_png_b64);

    diagEl.hidden = false;
    setProgress(`Diagnostics complete. Raw frames saved to ${d.frames_saved_to}`);
  } catch (e) {
    setProgress("Diagnostics failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resetSession() {
  const btn = $("btn-deflectometry-reset");
  if (btn) { btn.disabled = true; }
  try {
    const r = await apiFetch("/deflectometry/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      setProgress("Reset failed: " + msg);
      return;
    }
    const resultEl = $("deflectometry-result");
    if (resultEl) resultEl.hidden = true;
    setProgress("");
  } catch (e) {
    setProgress("Reset failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function openDialog() {
  buildDialog();
  const dlg = $("deflectometry-dialog");
  dlg.hidden = false;

  // First open: probe /status. If no session exists, start one. If a session
  // exists and has a last_result, rehydrate the result area so reopening the
  // dialog doesn't lose the user's work.
  if (!df.initialized) {
    df.initialized = true;
    const status = await refreshStatus();
    if (!status || !status.session_id) {
      await startSession();
    } else {
      df.sessionId = status.session_id;
      // /start is idempotent — re-call to ensure session is active.
      await startSession();
      if (status.has_result && status.last_result) {
        renderResult(status.last_result);
      }
    }
  } else {
    // Subsequent opens: just refresh the connection indicator.
    refreshStatus();
  }

  startPolling();
}

function closeDialog() {
  const dlg = $("deflectometry-dialog");
  if (dlg) dlg.hidden = true;
  stopPolling();
}

export function initDeflectometry() {
  const btn = $("btn-deflectometry");
  if (btn) btn.addEventListener("click", openDialog);
}
