// deflectometry.js — Full-window deflectometry workspace.
//
// Two-column layout:
//   Left:   camera preview + status badges + setup + sphere cal + settings
//   Right:  action bar + tabbed results
//
// Tabs (Phase 1 spec): Height | X Slope | Y Slope | Slope Mag | Curl | Diagnostics
//
// Lives inside #mode-deflectometry, managed by modes.js.

import { apiFetch } from './api.js';
import { state } from './state.js';
import { initCrossMode } from './cross-mode.js';
import { switchMode } from './modes.js';

const df = {
  polling: null,
  built: false,
  threeLoaded: false,
  maskPolygons: [],
  // Cached last result so we can re-render on tab switch / cal change
  lastResult: null,
  lastHeightmap: null,
  // Phase 2 Track 3: full envelope (with numeric grids) fetched lazily
  // from /deflectometry/result/{id} after compute. Used to recompute
  // stats under the "trusted pixels only" toggle and to render the
  // per-pixel quality map overlays.
  lastEnvelope: null,
  useTrustedOnly: false,
  // User-selected capture style. "multi_freq" is the recommended default
  // (matches backend default); "fast" is the legacy single-period mode.
  captureStyle: "multi_freq",
  // Tracks which slope tab the user picked so we don't auto-jump
  activeTab: "height",
};

// Phase 2 Track 3: consistency threshold used by the backend for the
// "trusted" predicate. Keep in sync with DEFAULT_CONSISTENCY_THRESHOLD in
// backend/vision/deflectometry.py.
const TRUSTED_CONSISTENCY_THRESHOLD = 0.7;

const TAB_IDS = ["height", "x_slope", "y_slope", "slope_mag", "curl", "diag"];

function $(id) { return document.getElementById(id); }

function setBadge(id, active) {
  const el = $(id);
  if (!el) return;
  if (active) el.classList.add("active");
  else el.classList.remove("active");
}

// Format stats. Always honest: shows µm only when calFactor is set, otherwise rad.
function formatStats(stats, calFactor) {
  if (!stats) return "\u2014";
  if (calFactor) {
    const k = Math.abs(calFactor) * 1000;
    const pv = Number.isFinite(stats.pv) ? (stats.pv * k).toFixed(2) : "\u2014";
    const rms = Number.isFinite(stats.rms) ? (stats.rms * k).toFixed(2) : "\u2014";
    const mean = Number.isFinite(stats.mean) ? (stats.mean * k).toFixed(2) : "\u2014";
    return `PV:   ${pv} \u00b5m\nRMS:  ${rms} \u00b5m\nMean: ${mean} \u00b5m`;
  }
  const pv = Number.isFinite(stats.pv) ? stats.pv.toFixed(3) : "\u2014";
  const rms = Number.isFinite(stats.rms) ? stats.rms.toFixed(3) : "\u2014";
  const mean = Number.isFinite(stats.mean) ? stats.mean.toFixed(3) : "\u2014";
  return `PV:   ${pv} rad\nRMS:  ${rms} rad\nMean: ${mean} rad`;
}

// Slope stats stay in radians regardless of cal_factor (per Phase 1 spec —
// height-cal does not legitimize slope-as-µm-per-pixel until Phase 4).
function formatSlopeStats(stats) {
  if (!stats) return "\u2014";
  const pv = Number.isFinite(stats.pv) ? stats.pv.toFixed(3) : "\u2014";
  const rms = Number.isFinite(stats.rms) ? stats.rms.toFixed(3) : "\u2014";
  const mean = Number.isFinite(stats.mean) ? stats.mean.toFixed(3) : "\u2014";
  return `PV:   ${pv} rad\nRMS:  ${rms} rad\nMean: ${mean} rad`;
}

function buildWorkspace() {
  if (df.built) return;
  df.built = true;

  const root = $("mode-deflectometry");
  if (!root) return;

  root.innerHTML = `
    <div class="defl-workspace">
      <!-- Left: preview + settings -->
      <div class="defl-preview-col">
        <div style="position:relative">
          <img id="defl-preview" alt="Camera preview" />
          <canvas id="defl-mask-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
        </div>
        <div class="defl-badge-row">
          <span class="defl-badge" id="defl-badge-ipad">iPad: \u2014</span>
          <span class="defl-badge" id="defl-badge-flat">Flat field: \u2014</span>
          <span class="defl-badge" id="defl-badge-ref">Baseline: \u2014</span>
          <span class="defl-badge" id="defl-badge-cal">Calibration: \u2014</span>
          <span class="defl-badge" id="defl-badge-display-cal">Display: \u2014</span>
        </div>
        <div id="defl-display-check-result" style="font-size:11px;margin-top:4px" hidden></div>
        <div class="defl-setting-group" style="margin-top:6px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Setup</div>
          <div style="display:flex;align-items:center;gap:6px">
            <button class="detect-btn" id="defl-btn-flat">Flat Field</button>
            <span class="defl-step-status" id="defl-status-flat" style="font-size:11px;opacity:0.7">\u2014</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <button class="detect-btn" id="defl-btn-ref">Baseline</button>
            <span class="defl-step-status" id="defl-status-ref" style="font-size:11px;opacity:0.7">Optional</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <button class="detect-btn" id="defl-btn-display-cal" style="padding:4px 8px;font-size:11px">Calibrate Display</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <button class="detect-btn" id="defl-btn-check-display" style="padding:4px 8px;font-size:11px">Check Display</button>
          </div>
          <div style="display:flex;gap:4px;margin-top:6px">
            <button class="detect-btn" id="defl-btn-edit-mask" style="padding:4px 8px;font-size:11px">Edit Mask</button>
            <button class="detect-btn" id="defl-btn-clear-mask" style="padding:4px 8px;font-size:11px;opacity:0.6" disabled>Clear Mask</button>
          </div>
        </div>
        <div class="defl-setting-group" style="margin-top:6px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Sphere Calibration</div>
          <label>Sphere diameter (mm)
            <input type="number" id="defl-sphere-diam" min="0.1" max="500" step="0.1" value="25.0" />
          </label>
          <div class="defl-step-controls">
            <button class="detect-btn" id="defl-btn-calibrate">Calibrate Sphere</button>
          </div>
          <div class="defl-step-status" id="defl-status-calibrate">\u2014</div>
        </div>
        <div class="defl-setting-group" style="margin-top:6px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Settings</div>
          <div class="defl-profile-row" style="margin-bottom:8px;display:flex;gap:4px;align-items:center">
            <select id="defl-profile-select" style="flex:1;font-size:11px">
              <option value="">— No profile —</option>
            </select>
            <button id="defl-btn-save-profile" class="detect-btn" style="font-size:10px;padding:2px 6px">Save</button>
            <button id="defl-btn-delete-profile" class="detect-btn" style="font-size:10px;padding:2px 6px;opacity:0.6" disabled>Del</button>
          </div>
          <label>Default tab
            <select id="defl-default-tab" style="font-size:11px">
              <option value="height">Height</option>
              <option value="x_slope">X Slope</option>
              <option value="y_slope">Y Slope</option>
              <option value="slope_mag">Slope Magnitude</option>
              <option value="curl">Curl</option>
              <option value="diag">Diagnostics</option>
            </select>
          </label>
          <label>Display device
            <select id="defl-display-device">
              <option value="0.0962">iPad Air 1 (264 ppi)</option>
              <option value="0.0962">iPad Air 2 (264 ppi)</option>
              <option value="0.0846">iPad Pro 11" (264 ppi)</option>
              <option value="0.0846">iPad Pro 12.9" (264 ppi)</option>
              <option value="custom">Custom\u2026</option>
            </select>
          </label>
          <label id="defl-custom-pitch-label" hidden>Pixel pitch (mm)
            <input type="number" id="defl-custom-pitch" min="0.01" max="1" step="0.001" value="0.096" />
          </label>
          <label>Capture style
            <select id="defl-capture-style" style="font-size:11px">
              <option value="multi_freq">Multi-frequency (recommended, ~24s)</option>
              <option value="fast">Fast single-frequency (~8s)</option>
            </select>
          </label>
          <label id="defl-freq-label">Fringe frequency (cycles)
            <input type="number" id="defl-freq" min="2" max="64" step="1" value="16" />
          </label>
          <div id="defl-periods-display" style="font-size:11px;opacity:0.7;padding:2px 0" hidden>
            Periods: 3, 12, 48 cycles
            <!-- TODO: expose periods editing in UI. Backend accepts a
                 periods override on capture requests; UI keeps it locked
                 to the default list for simplicity. -->
          </div>
          <label>Display gamma
            <input type="number" id="defl-gamma" min="1.0" max="3.0" step="0.1" value="2.2" style="width:65px" />
          </label>
          <label style="font-size:11px;opacity:0.7;margin-top:6px">Geometry Notes</label>
          <textarea id="defl-geometry-notes" rows="2" style="width:100%;font-size:11px;resize:vertical;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:3px;padding:4px" placeholder="Distance, fixture, lens, mirror..."></textarea>
        </div>
      </div>

      <!-- Right: action bar + results -->
      <div class="defl-results-col">
        <div class="defl-action-bar">
          <button class="detect-btn" id="defl-btn-capture" style="padding:6px 16px;font-size:13px;font-weight:600">Capture Part</button>
          <span class="defl-step-status" id="defl-status-capture" style="font-size:11px;opacity:0.7">\u2014</span>
          <button class="detect-btn" id="defl-btn-compute" style="padding:6px 16px;font-size:13px;font-weight:600">Compute</button>
          <span class="defl-step-status" id="defl-status-compute" style="font-size:11px;opacity:0.7">\u2014</span>
          <button class="detect-btn" id="defl-btn-reset" style="font-size:11px;padding:2px 8px">Reset</button>
          <button class="detect-btn" id="defl-btn-export" style="font-size:11px;padding:2px 8px">Export Run</button>
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px">
            Mask <input type="range" id="defl-mask-thresh" min="0" max="20" step="1" value="2" style="width:80px" />
            <span id="defl-mask-thresh-val" style="min-width:22px;font-size:11px">2%</span>
            Smoothing <input type="range" id="defl-smooth" min="0" max="5" step="0.5" value="0" style="width:80px" />
            <span id="defl-smooth-val" style="min-width:22px;font-size:11px">0</span>
            <button class="detect-btn" id="defl-btn-auto-smooth" style="font-size:10px;padding:1px 6px">Auto</button>
          </span>
        </div>

        <!-- Results body: tabs on top, content + sidebar quality block side-by-side -->
        <div class="defl-results-body">
          <div class="defl-results-main">
            <div class="defl-tab-bar">
              <button class="defl-tab active" data-tab="height">Height</button>
              <button class="defl-tab" data-tab="x_slope">X Slope</button>
              <button class="defl-tab" data-tab="y_slope">Y Slope</button>
              <button class="defl-tab" data-tab="slope_mag">Slope Mag</button>
              <button class="defl-tab" data-tab="curl">Curl</button>
              <button class="defl-tab" data-tab="diag">Diagnostics</button>
            </div>

            <!-- Height: 3D + 2D pseudocolor -->
            <div class="defl-tab-panel" id="defl-panel-height">
              <div class="defl-empty-state" id="defl-height-empty">Capture a part and compute to see results.</div>
              <div id="defl-height-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0;gap:10px">
                <div id="defl-uncal-banner" class="defl-uncal-banner" hidden>
                  <span>Uncalibrated &mdash; phase-radian proxy. Run Sphere Calibration to convert to physical units.</span>
                  <button id="defl-uncal-dismiss" title="Dismiss">&times;</button>
                </div>
                <div class="defl-height-views">
                  <div class="defl-height-view-3d">
                    <div class="defl-height-label">3D Surface <span id="defl-height-unit-3d" class="defl-unit-tag"></span></div>
                    <div class="defl-3d-host" id="defl-3d-host">
                      <div class="defl-3d-controls" id="defl-3d-controls">
                        <label style="font-size:12px">Z exaggeration:
                          <input type="range" id="defl-3d-z-scale" min="1" max="200" step="1" value="10" style="width:120px" />
                          <span id="defl-3d-z-val">10x</span>
                        </label>
                      </div>
                    </div>
                  </div>
                  <div class="defl-height-view-2d">
                    <div class="defl-height-label">2D Height Map <span id="defl-height-unit-2d" class="defl-unit-tag"></span></div>
                    <div class="defl-2d-host">
                      <canvas id="defl-height-2d-canvas"></canvas>
                      <div class="defl-2d-colorbar" id="defl-height-colorbar"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Slope tabs: large image + stats -->
            <div class="defl-tab-panel" id="defl-panel-x_slope" hidden>
              <div class="defl-empty-state" id="defl-x_slope-empty">Compute results first.</div>
              <div id="defl-x_slope-content" hidden class="defl-single-view">
                <div class="defl-single-label">X Slope (phase-radians)</div>
                <div class="defl-single-img-host">
                  <img id="defl-phase-x-img" />
                </div>
                <pre id="defl-phase-x-stats">\u2014</pre>
                <div class="defl-axis-warn" id="defl-x-warn" hidden></div>
              </div>
            </div>

            <div class="defl-tab-panel" id="defl-panel-y_slope" hidden>
              <div class="defl-empty-state" id="defl-y_slope-empty">Compute results first.</div>
              <div id="defl-y_slope-content" hidden class="defl-single-view">
                <div class="defl-single-label">Y Slope (phase-radians)</div>
                <div class="defl-single-img-host">
                  <img id="defl-phase-y-img" />
                </div>
                <pre id="defl-phase-y-stats">\u2014</pre>
                <div class="defl-axis-warn" id="defl-y-warn" hidden></div>
              </div>
            </div>

            <div class="defl-tab-panel" id="defl-panel-slope_mag" hidden>
              <div class="defl-empty-state" id="defl-slope_mag-empty">Compute results first.</div>
              <div id="defl-slope_mag-content" hidden class="defl-single-view">
                <div class="defl-single-label">Slope Magnitude (phase-radians)</div>
                <div class="defl-single-img-host">
                  <img id="defl-slope-mag-img" />
                </div>
                <pre id="defl-slope-mag-stats">\u2014</pre>
              </div>
            </div>

            <div class="defl-tab-panel" id="defl-panel-curl" hidden>
              <div class="defl-empty-state" id="defl-curl-empty">Compute results first.</div>
              <div id="defl-curl-content" hidden class="defl-single-view">
                <div class="defl-single-label" style="display:flex;align-items:center;gap:8px">
                  <span>Curl Residual (phase-units)</span>
                  <span class="defl-jump-risk-badge" id="defl-jump-risk-badge" hidden>—</span>
                </div>
                <div class="defl-single-img-host">
                  <img id="defl-curl-img" />
                </div>
                <pre id="defl-curl-stats">\u2014</pre>
                <div class="defl-axis-warn" id="defl-curl-warn" hidden></div>
                <div style="font-size:10px;opacity:0.55;margin-top:6px">
                  Curl is reported in phase-units regardless of calibration. A high curl
                  value indicates the slope field is non-conservative (likely from noise
                  or unmodeled distortion); the integrated height map is suspect there.
                </div>
                <div style="font-size:10px;opacity:0.55;margin-top:4px" id="defl-jump-risk-caption" hidden></div>
              </div>
            </div>

            <div class="defl-tab-panel" id="defl-panel-diag" hidden>
              <div class="defl-empty-state" id="defl-diag-empty">Run diagnostics to see detailed frame analysis.</div>
              <div id="defl-diag-content" hidden>
                <pre id="defl-diag-framestats" style="margin:0 0 10px;padding:6px 8px;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:3px;font-size:11px;overflow-x:auto">\u2014</pre>
                <div class="defl-diag-grid">
                  <div>
                    <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Modulation X</div>
                    <img id="defl-diag-mod-x" />
                    <pre id="defl-diag-mod-x-stats">\u2014</pre>
                  </div>
                  <div>
                    <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Modulation Y</div>
                    <img id="defl-diag-mod-y" />
                    <pre id="defl-diag-mod-y-stats">\u2014</pre>
                  </div>
                  <div>
                    <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Wrapped phase X</div>
                    <img id="defl-diag-wrap-x" />
                  </div>
                  <div>
                    <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Wrapped phase Y</div>
                    <img id="defl-diag-wrap-y" />
                  </div>
                  <div>
                    <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Unwrapped X (before tilt removal)</div>
                    <img id="defl-diag-unw-x" />
                  </div>
                  <div>
                    <div style="font-size:11px;opacity:0.7;margin-bottom:2px">Unwrapped Y (before tilt removal)</div>
                    <img id="defl-diag-unw-y" />
                  </div>
                </div>

                <!-- Phase 2 Track 3: Per-pixel quality maps (from envelope grids) -->
                <details class="defl-quality-maps" id="defl-quality-maps" open style="margin-top:14px">
                  <summary style="cursor:pointer;font-size:12px;font-weight:600;opacity:0.8;margin-bottom:8px">
                    Per-pixel quality maps
                  </summary>
                  <div id="defl-quality-maps-empty" style="font-size:11px;opacity:0.55;padding:6px 0">
                    Compute a capture to populate quality maps.
                  </div>
                  <div id="defl-quality-maps-body" hidden>
                    <div class="defl-quality-maps-grid">
                      <div>
                        <div class="defl-qmap-label">Modulation (fringe contrast)</div>
                        <div class="defl-qmap-host">
                          <canvas id="defl-qmap-mod"></canvas>
                          <div class="defl-qmap-cb">
                            <div class="defl-cb-strip"></div>
                            <div class="defl-cb-labels" id="defl-qmap-mod-labels">
                              <span>max</span><span>0</span>
                            </div>
                          </div>
                        </div>
                        <div class="defl-qmap-caption">min(mod_x, mod_y). Higher = stronger fringe signal.</div>
                      </div>
                      <div>
                        <div class="defl-qmap-label">Phase consistency (multi-freq agreement)</div>
                        <div class="defl-qmap-host">
                          <canvas id="defl-qmap-cons"></canvas>
                          <div class="defl-qmap-cb">
                            <div class="defl-cb-strip"></div>
                            <div class="defl-cb-labels">
                              <span>1.0</span><span>0.0</span>
                            </div>
                          </div>
                        </div>
                        <div class="defl-qmap-caption">
                          1.0 = perfect agreement, &lt;0.7 = unreliable.
                          Fast captures show uniform 1.0 (single-period).
                        </div>
                      </div>
                      <!-- TODO: Standardized-residual map — requires backend to expose
                           IRLS residuals from fit_sphere_calibration in the envelope.
                           Not in Track 2's scope. -->
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </div>

          <!-- Quality sidebar: always visible after compute -->
          <aside class="defl-quality-sidebar" id="defl-quality-sidebar" hidden>
            <div class="defl-quality-title">Quality Summary</div>
            <div class="defl-quality-overall" id="defl-q-overall">—</div>
            <label class="defl-trusted-toggle" id="defl-trusted-toggle-wrap" hidden>
              <input type="checkbox" id="defl-trusted-toggle" />
              <span>Use trusted pixels only</span>
              <span class="defl-trusted-hint" id="defl-trusted-hint" hidden>—</span>
            </label>
            <div class="defl-quality-rows" id="defl-q-rows"></div>
            <details id="defl-q-warnings-details" class="defl-quality-warnings">
              <summary id="defl-q-warnings-summary">No warnings</summary>
              <ul id="defl-q-warnings-list"></ul>
            </details>
          </aside>
        </div>
      </div>
    </div>
  `;

  wireEvents();
}

async function loadProfileList() {
  try {
    const r = await apiFetch("/deflectometry/profiles");
    if (!r.ok) return;
    const profiles = await r.json();
    const sel = document.getElementById("defl-profile-select");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">— No profile —</option>';
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
    const delBtn = document.getElementById("defl-btn-delete-profile");
    if (delBtn) {
      delBtn.disabled = !sel.value;
      delBtn.style.opacity = sel.value ? "1" : "0.6";
    }
  } catch { /* ignore */ }
}

async function saveProfile() {
  const name = prompt("Profile name:", document.getElementById("defl-profile-select")?.value || "");
  if (!name) return;
  const defaultTab = document.getElementById("defl-default-tab")?.value || "height";
  const profile = {
    name,
    display: {
      model: document.getElementById("defl-display-device")?.value || "",
      pixel_pitch_mm: parseFloat(document.getElementById("defl-pixel-pitch")?.value) || 0.0962,
    },
    capture: {
      freq: getFreq(),
      averages: parseInt(document.getElementById("defl-averages")?.value) || 3,
      gamma: getGamma(),
      capture_style: df.captureStyle === "fast" ? "fast" : "multi_freq",
    },
    processing: {
      mask_threshold: getMaskThreshold(),
      smooth_sigma: getSmoothSigma(),
    },
    geometry: {
      notes: document.getElementById("defl-geometry-notes")?.value || "",
    },
    calibration: {
      cal_factor: null,
      sphere_diameter_mm: null,
    },
    ui: {
      default_tab: TAB_IDS.includes(defaultTab) ? defaultTab : "height",
    },
  };
  try {
    const statusR = await apiFetch("/deflectometry/status");
    if (statusR.ok) {
      const st = await statusR.json();
      if (st.cal_factor) profile.calibration.cal_factor = st.cal_factor;
    }
  } catch { /* ignore */ }
  try {
    const r = await apiFetch("/deflectometry/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (r.ok) await loadProfileList();
    const sel = document.getElementById("defl-profile-select");
    if (sel) sel.value = name;
  } catch (e) {
    console.warn("Failed to save profile:", e);
  }
}

async function loadSelectedProfile() {
  const sel = document.getElementById("defl-profile-select");
  if (!sel || !sel.value) return;
  try {
    const r = await apiFetch("/deflectometry/profiles/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sel.value }),
    });
    if (!r.ok) return;
    const p = await r.json();
    const freqEl = document.getElementById("defl-freq");
    if (freqEl) freqEl.value = p.capture?.freq ?? 16;
    const gammaEl = document.getElementById("defl-gamma");
    if (gammaEl) gammaEl.value = p.capture?.gamma ?? 2.2;
    // Capture style: older profiles without this field default to multi_freq
    // (matches the Phase 2 plan decision and backend ProfileCapture default).
    const style = (p.capture?.capture_style === "fast") ? "fast" : "multi_freq";
    df.captureStyle = style;
    const styleEl = document.getElementById("defl-capture-style");
    if (styleEl) styleEl.value = style;
    applyCaptureStyleUI();
    const threshEl = document.getElementById("defl-mask-thresh");
    if (threshEl) threshEl.value = Math.round((p.processing?.mask_threshold ?? 0.02) * 100);
    const smoothEl = document.getElementById("defl-smooth");
    if (smoothEl) smoothEl.value = p.processing?.smooth_sigma ?? 0;
    const pitchEl = document.getElementById("defl-pixel-pitch");
    if (pitchEl) pitchEl.value = p.display?.pixel_pitch_mm ?? 0.0962;
    const deviceEl = document.getElementById("defl-display-device");
    if (deviceEl) deviceEl.value = p.display?.model || "";
    const notesEl = document.getElementById("defl-geometry-notes");
    if (notesEl) notesEl.value = p.geometry?.notes || "";
    // UI: default tab. Old profiles without ui field default to "height".
    const defaultTab = (p.ui && TAB_IDS.includes(p.ui.default_tab)) ? p.ui.default_tab : "height";
    const dtEl = document.getElementById("defl-default-tab");
    if (dtEl) dtEl.value = defaultTab;
    activateTab(defaultTab);
    const delBtn = document.getElementById("defl-btn-delete-profile");
    if (delBtn) { delBtn.disabled = false; delBtn.style.opacity = "1"; }
  } catch (e) {
    console.warn("Failed to load profile:", e);
  }
}

async function deleteSelectedProfile() {
  const sel = document.getElementById("defl-profile-select");
  if (!sel || !sel.value) return;
  try {
    await apiFetch(`/deflectometry/profiles/${encodeURIComponent(sel.value)}`, { method: "DELETE" });
    await loadProfileList();
  } catch (e) {
    console.warn("Failed to delete profile:", e);
  }
}

function drawDeflMaskOverlay() {
  const canvas = document.getElementById("defl-mask-canvas");
  const preview = document.getElementById("defl-preview");
  if (!canvas || !preview) return;
  const w = preview.naturalWidth || preview.width || canvas.width;
  const h = preview.naturalHeight || preview.height || canvas.height;
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!df.maskPolygons || df.maskPolygons.length === 0) return;

  const sx = canvas.width / w;
  const sy = canvas.height / h;
  const scale = Math.min(sx, sy);
  const ox = (canvas.width - w * scale) / 2;
  const oy = (canvas.height - h * scale) / 2;

  for (const poly of df.maskPolygons) {
    const color = poly.include ? "#0a84ff" : "#ff453a";
    const fill = poly.include ? "rgba(10,132,255,0.15)" : "rgba(255,69,58,0.15)";
    ctx.beginPath();
    const v0 = poly.vertices[0];
    ctx.moveTo(ox + v0.x * w * scale, oy + v0.y * h * scale);
    for (let i = 1; i < poly.vertices.length; i++) {
      const v = poly.vertices[i];
      ctx.lineTo(ox + v.x * w * scale, oy + v.y * h * scale);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

async function editMask() {
  const btn = document.getElementById("defl-btn-edit-mask");
  if (btn) { btn.disabled = true; btn.textContent = "Capturing..."; }
  try {
    await apiFetch("/freeze", { method: "POST" });
    const resp = await apiFetch("/frame");
    if (!resp.ok) throw new Error("Frame fetch failed");
    const blob = await resp.blob();

    initCrossMode({
      imageBlob: blob,
      existingMask: df.maskPolygons.length > 0
        ? JSON.parse(JSON.stringify(df.maskPolygons))
        : [],
      callback: (polygons) => {
        df.maskPolygons = polygons;
        drawDeflMaskOverlay();
        const clearBtn = document.getElementById("defl-btn-clear-mask");
        if (clearBtn) {
          clearBtn.disabled = polygons.length === 0;
          clearBtn.style.opacity = polygons.length === 0 ? "0.6" : "1";
        }
      },
    });
    window.crossMode.source = 'deflectometry';

    switchMode("microscope");
    const sel = document.getElementById("mode-switcher");
    if (sel) sel.value = "microscope";
  } catch (e) {
    console.warn("[deflectometry] Edit Mask failed:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Edit Mask"; }
  }
}

function clearMask() {
  df.maskPolygons = [];
  drawDeflMaskOverlay();
  const clearBtn = document.getElementById("defl-btn-clear-mask");
  if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.6"; }
}

function activateTab(tabId) {
  if (!TAB_IDS.includes(tabId)) tabId = "height";
  df.activeTab = tabId;
  document.querySelectorAll(".defl-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tabId);
  });
  document.querySelectorAll(".defl-tab-panel").forEach(p => {
    p.hidden = (p.id !== "defl-panel-" + tabId);
  });
  // Lazy-init expensive panels
  if (tabId === "height" && df.lastResult) {
    load3dSurface();
  }
  if (tabId === "diag") {
    runDiagnostics();
  }
}

function wireEvents() {
  // Tab switching — single handler
  document.querySelectorAll(".defl-tab").forEach(tab => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });

  // Display device dropdown
  const deviceSel = $("defl-display-device");
  const customLabel = $("defl-custom-pitch-label");
  if (deviceSel && customLabel) {
    deviceSel.addEventListener("change", () => {
      customLabel.hidden = deviceSel.value !== "custom";
    });
  }

  // Mask threshold slider
  const maskSlider = $("defl-mask-thresh");
  const maskLabel = $("defl-mask-thresh-val");
  let _maskDebounce = null;
  if (maskSlider && maskLabel) {
    maskSlider.addEventListener("input", () => {
      maskLabel.textContent = maskSlider.value + "%";
      if (_maskDebounce) clearTimeout(_maskDebounce);
      _maskDebounce = setTimeout(() => {
        if (df.lastResult) compute();
      }, 300);
    });
  }

  // Smoothing slider
  const smoothSlider = $("defl-smooth");
  const smoothLabel = $("defl-smooth-val");
  if (smoothSlider && smoothLabel) {
    smoothSlider.addEventListener("input", () => {
      smoothLabel.textContent = smoothSlider.value;
    });
  }

  // Profile buttons
  document.getElementById("defl-profile-select")?.addEventListener("change", loadSelectedProfile);
  document.getElementById("defl-btn-save-profile")?.addEventListener("click", saveProfile);
  document.getElementById("defl-btn-delete-profile")?.addEventListener("click", deleteSelectedProfile);

  // Workflow buttons
  $("defl-btn-flat")?.addEventListener("click", flatField);
  $("defl-btn-ref")?.addEventListener("click", captureReference);
  $("defl-btn-display-cal")?.addEventListener("click", calibrateDisplay);
  $("defl-btn-check-display")?.addEventListener("click", checkDisplay);
  $("defl-btn-edit-mask")?.addEventListener("click", editMask);
  $("defl-btn-clear-mask")?.addEventListener("click", clearMask);
  $("defl-btn-capture")?.addEventListener("click", captureSequence);
  $("defl-btn-compute")?.addEventListener("click", compute);
  $("defl-btn-calibrate")?.addEventListener("click", calibrateSphere);
  $("defl-btn-auto-smooth")?.addEventListener("click", autoSmooth);
  $("defl-btn-reset")?.addEventListener("click", resetSession);
  $("defl-btn-export")?.addEventListener("click", exportRun);

  // Uncalibrated banner dismiss (per-session)
  $("defl-uncal-dismiss")?.addEventListener("click", () => {
    const b = $("defl-uncal-banner");
    if (b) b.hidden = true;
    df.uncalDismissed = true;
  });

  // Capture style toggle (multi_freq | fast). Drives UI visibility + state.
  const captureStyleEl = $("defl-capture-style");
  if (captureStyleEl) {
    captureStyleEl.value = df.captureStyle;
    applyCaptureStyleUI();
    captureStyleEl.addEventListener("change", () => {
      df.captureStyle = captureStyleEl.value === "fast" ? "fast" : "multi_freq";
      applyCaptureStyleUI();
    });
  }

  // "Use trusted pixels only" toggle (Phase 2 Track 3)
  const trustedEl = $("defl-trusted-toggle");
  if (trustedEl) {
    trustedEl.addEventListener("change", () => {
      df.useTrustedOnly = !!trustedEl.checked;
      applyTrustedFilterToDisplays();
    });
  }
}

// Reflect df.captureStyle into the settings panel + action bar.
function applyCaptureStyleUI() {
  const style = df.captureStyle === "fast" ? "fast" : "multi_freq";
  const freqLabel = $("defl-freq-label");
  const periodsDisplay = $("defl-periods-display");
  const captureBtn = $("defl-btn-capture");
  if (freqLabel) freqLabel.hidden = (style !== "fast");
  if (periodsDisplay) periodsDisplay.hidden = (style === "fast");
  if (captureBtn) {
    captureBtn.textContent = (style === "fast")
      ? "Capture (~8s)"
      : "Capture (~24s)";
  }
}

function getFreq() {
  const el = $("defl-freq");
  let freq = parseInt(el ? el.value : "16", 10);
  if (!Number.isFinite(freq) || freq < 2) freq = 2;
  if (freq > 64) freq = 64;
  return freq;
}

function getGamma() {
  const el = $("defl-gamma");
  let g = parseFloat(el ? el.value : "2.2");
  if (!Number.isFinite(g) || g < 1.0) g = 1.0;
  if (g > 3.0) g = 3.0;
  return g;
}

function getMaskThreshold() {
  const el = $("defl-mask-thresh");
  return el ? parseInt(el.value, 10) / 100 : 0.02;
}

function getSmoothSigma() {
  const el = $("defl-smooth");
  return el ? parseFloat(el.value) : 0;
}

async function autoSmooth() {
  const btn = $("defl-btn-auto-smooth");
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch("/deflectometry/auto-smooth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      console.warn("Auto-smooth failed:", msg);
      return;
    }
    const data = await r.json();
    const slider = $("defl-smooth");
    const label = $("defl-smooth-val");
    if (slider) {
      slider.value = data.sigma;
      if (label) label.textContent = data.sigma;
      if (df.lastResult) compute();
    }
  } catch (e) {
    console.warn("Auto-smooth error:", e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function flatField() {
  const btn = $("defl-btn-flat");
  if (btn) btn.disabled = true;
  const statusEl = $("defl-status-flat");
  if (statusEl) statusEl.textContent = "Capturing\u2026";
  try {
    const r = await apiFetch("/deflectometry/flat-field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const msg = await r.text();
      if (statusEl) statusEl.textContent = "Failed: " + msg;
      return;
    }
    if (statusEl) statusEl.textContent = "Captured";
  } catch (e) {
    if (statusEl) statusEl.textContent = "Failed: " + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function calibrateDisplay() {
  const btn = $("defl-btn-display-cal");
  if (btn) { btn.disabled = true; btn.textContent = "Calibrating\u2026"; }
  try {
    const r = await apiFetch("/deflectometry/calibrate-display", { method: "POST" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn("Display calibration failed:", err.detail || r.status);
      return;
    }
    const data = await r.json();
    const badge = $("defl-badge-display-cal");
    if (badge) {
      badge.textContent = `Display: ${data.max_deviation_from_gamma}% dev`;
      badge.classList.add("active");
    }
  } catch (e) {
    console.warn("Display calibration error:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Calibrate Display"; }
  }
}

async function checkDisplay() {
  const btn = $("defl-btn-check-display");
  if (btn) { btn.disabled = true; btn.textContent = "Checking\u2026"; }
  const resultEl = $("defl-display-check-result");
  try {
    const r = await apiFetch("/deflectometry/check-display", { method: "POST" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn("Display check failed:", err.detail || r.status);
      if (resultEl) {
        resultEl.hidden = false;
        resultEl.style.color = "var(--danger)";
        resultEl.textContent = err.detail || "Check failed";
      }
      return;
    }
    const data = await r.json();
    if (resultEl) {
      resultEl.hidden = false;
      const colors = { good: "var(--success)", fair: "var(--warning)", poor: "var(--danger)" };
      const icons = { good: "\u2713", fair: "\u26a0", poor: "\u2717" };
      resultEl.style.color = colors[data.status] || "var(--text-secondary)";
      if (data.status === "good") {
        resultEl.textContent = `${icons.good} Display OK \u2014 ${data.corners_found}/4 corners, ${(data.coverage_fraction * 100).toFixed(0)}% coverage`;
      } else {
        const warning = data.warnings.length > 0 ? data.warnings[0] : `${data.corners_found}/4 corners found`;
        resultEl.textContent = `${icons[data.status]} ${warning}`;
      }
    }
  } catch (e) {
    console.warn("Display check error:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Check Display"; }
  }
}

async function captureReference() {
  const btn = $("defl-btn-ref");
  if (btn) btn.disabled = true;
  const statusEl = $("defl-status-ref");
  const style = df.captureStyle === "fast" ? "fast" : "multi_freq";
  if (statusEl) statusEl.textContent = "Capturing\u2026";
  try {
    const r = await apiFetch("/deflectometry/capture-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freq: getFreq(),
        gamma: getGamma(),
        capture_style: style,
      }),
    });
    if (!r.ok) {
      const msg = await r.text();
      if (statusEl) statusEl.textContent = "Failed: " + msg;
      return;
    }
    if (statusEl) statusEl.textContent = "Captured";
  } catch (e) {
    if (statusEl) statusEl.textContent = "Failed: " + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function captureSequence() {
  const btn = $("defl-btn-capture");
  if (btn) btn.disabled = true;
  const statusEl = $("defl-status-capture");
  const style = df.captureStyle === "fast" ? "fast" : "multi_freq";
  // Denominator reflects the capture style: fast=16 frames, multi_freq=48 (3 periods × 16)
  const totalFrames = (style === "fast") ? 16 : 48;
  df._lastCaptureTotalFrames = totalFrames;
  if (statusEl) statusEl.textContent = `Capturing 0 of ${totalFrames}\u2026`;
  try {
    const r = await apiFetch("/deflectometry/capture-sequence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freq: getFreq(),
        gamma: getGamma(),
        capture_style: style,
      }),
    });
    if (!r.ok) {
      const msg = await r.text();
      if (statusEl) statusEl.textContent = "Failed: " + msg;
      return;
    }
    const data = await r.json();
    const captured = data.captured_count ?? 0;
    if (statusEl) statusEl.textContent = `${captured} of ${totalFrames} frames`;
  } catch (e) {
    if (statusEl) statusEl.textContent = "Failed: " + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function compute() {
  const btn = $("defl-btn-compute");
  if (btn) btn.disabled = true;
  const statusEl = $("defl-status-compute");
  if (statusEl) statusEl.textContent = "Computing\u2026";
  try {
    const payload = { mask_threshold: getMaskThreshold(), smooth_sigma: getSmoothSigma() };
    if (df.maskPolygons.length > 0) {
      payload.mask_polygons = df.maskPolygons.map(p => ({
        vertices: p.vertices.map(v => [v.x, v.y]),
        include: p.include,
      }));
    }
    const r = await apiFetch("/deflectometry/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const msg = await r.text();
      if (statusEl) statusEl.textContent = "Failed: " + msg;
      return;
    }
    const result = await r.json();
    if (statusEl) statusEl.textContent = "Done";
    df.lastResult = result;
    df.lastEnvelope = null;  // will refetch with grids below
    renderPhaseResult(result);
    // Refresh height views (3D + 2D) if user is on Height tab
    if (df.activeTab === "height") {
      load3dSurface();
    }
    // Phase 2 Track 3: fetch full envelope (with numeric grids) so the
    // "trusted pixels only" toggle can recompute stats without another
    // compute call, and the Diagnostics tab can render quality maps.
    // We picked this approach (as opposed to a trusted-mask-PNG) because
    // (a) the grids are already materialised server-side in the envelope
    // cache, (b) it lets us recompute *per-tab* stats with no additional
    // round-trip, and (c) it future-proofs for later overlays that need
    // other grids (slopes, residuals) without more API surface.
    fetchEnvelopeAsync(result.id).catch(() => {});
  } catch (e) {
    if (statusEl) statusEl.textContent = "Failed: " + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function calibrateSphere() {
  const statusEl = $("defl-status-calibrate");
  const ppm = state.calibration?.pixelsPerMm;
  if (!ppm || ppm <= 0) {
    if (statusEl) statusEl.textContent = "Camera calibration (px/mm) required first";
    return;
  }
  const diamEl = $("defl-sphere-diam");
  let diam = parseFloat(diamEl ? diamEl.value : "25");
  if (!Number.isFinite(diam) || diam <= 0) {
    if (statusEl) statusEl.textContent = "Enter a valid sphere diameter";
    return;
  }
  const btn = $("defl-btn-calibrate");
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = "Calibrating\u2026";
  try {
    const r = await apiFetch("/deflectometry/calibrate-sphere", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sphere_diameter_mm: diam, px_per_mm: ppm }),
    });
    if (!r.ok) {
      const msg = await r.text();
      if (statusEl) statusEl.textContent = "Failed: " + msg;
      return;
    }
    const data = await r.json();
    if (statusEl) statusEl.textContent =
      data.cal_factor_um.toFixed(4) + " \u00b5m/rad, R=" + data.fitted_radius_mm.toFixed(1) + "mm";
    // Re-render phase results with calibrated units
    const status = await apiFetch("/deflectometry/status");
    if (status.ok) {
      const sd = await status.json();
      if (sd.last_result) {
        df.lastResult = sd.last_result;
        renderPhaseResult(sd.last_result);
        if (df.activeTab === "height") load3dSurface();
      }
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = "Failed: " + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resetSession() {
  try {
    await apiFetch("/deflectometry/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch { /* ignore */ }
  const capStatus = $("defl-status-capture");
  if (capStatus) capStatus.textContent = "\u2014";
  const compStatus = $("defl-status-compute");
  if (compStatus) compStatus.textContent = "\u2014";
  df.lastResult = null;
  df.lastHeightmap = null;
  df.lastEnvelope = null;
  df.useTrustedOnly = false;
  const trustedEl = $("defl-trusted-toggle");
  if (trustedEl) trustedEl.checked = false;
  const trustedWrap = $("defl-trusted-toggle-wrap");
  if (trustedWrap) trustedWrap.hidden = true;
  // Hide quality maps (Diagnostics)
  const qmBody = $("defl-quality-maps-body");
  const qmEmpty = $("defl-quality-maps-empty");
  if (qmBody) qmBody.hidden = true;
  if (qmEmpty) qmEmpty.hidden = false;
  // Hide jump-risk badge
  const jrBadge = $("defl-jump-risk-badge");
  if (jrBadge) jrBadge.hidden = true;
  const jrCap = $("defl-jump-risk-caption");
  if (jrCap) jrCap.hidden = true;
  // Hide all result content; show empty states
  for (const id of TAB_IDS) {
    const c = $("defl-" + id + "-content");
    const e = $("defl-" + id + "-empty");
    if (c) c.hidden = true;
    if (e) e.hidden = false;
  }
  // Special-case height (different element id pattern)
  const hc = $("defl-height-content");
  const he = $("defl-height-empty");
  if (hc) hc.hidden = true;
  if (he) he.hidden = false;
  // Hide quality sidebar
  const qs = $("defl-quality-sidebar");
  if (qs) qs.hidden = true;
}

async function exportRun() {
  try {
    const r = await apiFetch("/deflectometry/export-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      console.warn("Export failed:", await r.text());
      return;
    }
    const data = await r.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `deflectometry-run-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn("Export error:", e);
  }
}

function showSlopePanelContent(tabId) {
  const c = $("defl-" + tabId + "-content");
  const e = $("defl-" + tabId + "-empty");
  if (c) c.hidden = false;
  if (e) e.hidden = true;
}

function renderPhaseResult(result) {
  if (!result) return;
  df.lastResult = result;

  const cal = result.cal_factor || null;

  // Per-axis slope panels
  if (result.phase_x_png_b64) {
    $("defl-phase-x-img").src = "data:image/png;base64," + result.phase_x_png_b64;
    showSlopePanelContent("x_slope");
  }
  if (result.phase_y_png_b64) {
    $("defl-phase-y-img").src = "data:image/png;base64," + result.phase_y_png_b64;
    showSlopePanelContent("y_slope");
  }
  if (result.slope_mag_png_b64) {
    $("defl-slope-mag-img").src = "data:image/png;base64," + result.slope_mag_png_b64;
    showSlopePanelContent("slope_mag");
  }
  if (result.curl_png_b64) {
    $("defl-curl-img").src = "data:image/png;base64," + result.curl_png_b64;
    showSlopePanelContent("curl");
  }

  // Slope stats stay in radians (per Phase 1 spec — no silent rad→µm).
  $("defl-phase-x-stats").textContent = formatSlopeStats(result.stats_x);
  $("defl-phase-y-stats").textContent = formatSlopeStats(result.stats_y);
  $("defl-slope-mag-stats").textContent = formatSlopeStats(result.stats_slope_mag);
  $("defl-curl-stats").textContent = formatSlopeStats(result.stats_curl);

  // Show Height empty-state cleared (3D/2D will populate when load3dSurface runs)
  const he = $("defl-height-empty");
  const hc = $("defl-height-content");
  if (he) he.hidden = true;
  if (hc) hc.hidden = false;

  // Uncalibrated banner on Height tab
  const uncalBanner = $("defl-uncal-banner");
  if (uncalBanner) {
    if (!cal && !df.uncalDismissed) {
      uncalBanner.hidden = false;
    } else {
      uncalBanner.hidden = true;
    }
  }

  // Per-axis warnings (filtered from quality.warnings)
  renderAxisWarnings(result.quality);

  // Quality sidebar
  renderQualitySidebar(result.quality);

  // Curl tab: unwrap-jump-risk headline badge
  renderJumpRiskBadge(result.quality);
}

function renderAxisWarnings(quality) {
  const xWarn = $("defl-x-warn");
  const yWarn = $("defl-y-warn");
  const cWarn = $("defl-curl-warn");
  if (xWarn) { xWarn.hidden = true; xWarn.textContent = ""; }
  if (yWarn) { yWarn.hidden = true; yWarn.textContent = ""; }
  if (cWarn) { cWarn.hidden = true; cWarn.textContent = ""; }
  if (!quality || !quality.warnings) return;
  for (const w of quality.warnings) {
    const lower = w.toLowerCase();
    if (xWarn && /x modulation/i.test(w)) {
      xWarn.hidden = false;
      xWarn.textContent = "\u26a0 " + w;
    }
    if (yWarn && /y modulation/i.test(w)) {
      yWarn.hidden = false;
      yWarn.textContent = "\u26a0 " + w;
    }
    if (cWarn && lower.includes("integration residual")) {
      cWarn.hidden = false;
      cWarn.textContent = "\u26a0 " + w;
    }
  }
}

// ──────── Phase 2 Track 3: envelope fetch + trusted-only stats ────────

async function fetchEnvelopeAsync(resultId) {
  if (!resultId) return;
  try {
    const r = await apiFetch(`/deflectometry/result/${encodeURIComponent(resultId)}`);
    if (!r.ok) return;
    const env = await r.json();
    df.lastEnvelope = env;
    // Enable the trusted-only toggle now that grids are available
    const wrap = $("defl-trusted-toggle-wrap");
    if (wrap) wrap.hidden = false;
    // Render per-pixel quality maps (Diagnostics tab) if user is there
    renderQualityMaps(env);
    // If user has already toggled trusted-only, apply it now
    if (df.useTrustedOnly) applyTrustedFilterToDisplays();
  } catch { /* ignore */ }
}

// Iterate a nested 2D grid (rows of numbers/null), yielding pixels as
// (value, rowIdx, colIdx). Calls `visit(value, r, c)`; skips null.
function _iterGrid(grid, visit) {
  if (!Array.isArray(grid)) return;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      visit(v, r, c);
    }
  }
}

// Compute PV/RMS/mean over a 2D grid (nested arrays, null for NaN),
// optionally restricted to pixels where trustedMask[r][c] is truthy
// (1 or true). Returns {pv, rms, mean, count} with NaN when empty.
function statsFromGrid(grid, trustedMask) {
  if (!Array.isArray(grid)) return { pv: NaN, rms: NaN, mean: NaN, count: 0 };
  let n = 0, sum = 0, sumSq = 0, min = Infinity, max = -Infinity;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    const mrow = trustedMask ? trustedMask[r] : null;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null || !Number.isFinite(v)) continue;
      if (trustedMask) {
        const m = mrow ? mrow[c] : 0;
        if (!m) continue;
      }
      n += 1;
      sum += v;
      sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (n === 0) return { pv: NaN, rms: NaN, mean: NaN, count: 0 };
  const mean = sum / n;
  const rms = Math.sqrt(sumSq / n);
  return { pv: (max - min), rms, mean, count: n };
}

// Effective coverage: fraction of image pixels passing the trusted gate.
// If useTrusted is false, returns the envelope's original modulation_coverage.
function effectiveCoverage(envelope, useTrusted) {
  if (!envelope) return null;
  if (!useTrusted) {
    const q = envelope.quality || {};
    return Number.isFinite(q.modulation_coverage) ? q.modulation_coverage : null;
  }
  const mask = envelope.trusted_mask_grid;
  if (!Array.isArray(mask)) return null;
  let total = 0, trusted = 0;
  for (let r = 0; r < mask.length; r++) {
    const row = mask[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      total += 1;
      if (row[c]) trusted += 1;
    }
  }
  return total > 0 ? (trusted / total) * 100 : null;
}

// Recompute stats for each tab and the quality sidebar, either using all
// valid pixels (useTrusted=false) or only trusted pixels (true).
function recomputeStatsWithTrustedMask(envelope, useTrusted) {
  if (!envelope) return;
  const mask = useTrusted ? envelope.trusted_mask_grid : null;

  const statsPhaseX = statsFromGrid(envelope.phase_x_grid, mask);
  const statsPhaseY = statsFromGrid(envelope.phase_y_grid, mask);
  // slope_mag and curl aren't shipped as grids in the envelope today (only
  // the slope_x/slope_y aliases are). Best-effort: derive |∇phase| from
  // phase_x_grid, phase_y_grid (these alias slopes in Phase 0/1/2 until the
  // geometric solver lands in Phase 4). For now, keep the server-computed
  // all-pixel slope/curl stats when useTrusted=false and blank them when
  // we don't have the numeric grid — this is honest about scope.
  // TODO (Phase 4): surface slope_mag_grid + curl_grid in the envelope so
  // these tabs get trusted-only stats too.

  // Update DOM text blocks (preserve original "—" format on NaN).
  const pre = (id, s) => {
    const el = $(id);
    if (!el) return;
    el.textContent = formatSlopeStats(s);
  };
  pre("defl-phase-x-stats", statsPhaseX);
  pre("defl-phase-y-stats", statsPhaseY);
  // slope_mag / curl: if we don't recompute, keep the server values visible
  // via df.lastResult. Those were already rendered by renderPhaseResult.

  // Quality sidebar: patch coverage row when trusted-only is on.
  const covEl = document.querySelector("#defl-q-rows .defl-q-row");
  if (covEl) {
    const cov = effectiveCoverage(envelope, useTrusted);
    const label = useTrusted ? "Effective coverage (trusted)" : "Modulation coverage";
    const covCls = (cov != null && cov < 50) ? "warn" : ((cov != null && cov >= 70) ? "ok" : "");
    covEl.className = "defl-q-row " + covCls;
    covEl.innerHTML = `<span>${label}</span><span>${cov != null ? cov.toFixed(1) + "%" : "\u2014"}</span>`;
  }

  // Hint under the toggle
  const hint = $("defl-trusted-hint");
  if (hint) {
    const covRaw = envelope?.quality?.modulation_coverage;
    const covEff = effectiveCoverage(envelope, true);
    if (useTrusted && Number.isFinite(covRaw) && Number.isFinite(covEff)) {
      hint.hidden = false;
      hint.textContent = `(${covEff.toFixed(0)}% vs ${covRaw.toFixed(0)}% of all pixels)`;
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }
  }
}

function applyTrustedFilterToDisplays() {
  if (!df.lastEnvelope) {
    // No grids yet — fall back to all-pixel rendering from last result
    if (df.lastResult) renderPhaseResult(df.lastResult);
    return;
  }
  recomputeStatsWithTrustedMask(df.lastEnvelope, df.useTrustedOnly);
}

// ──────── Per-pixel quality map overlays (Diagnostics tab) ────────

function renderQualityMaps(envelope) {
  const body = $("defl-quality-maps-body");
  const empty = $("defl-quality-maps-empty");
  if (!body || !empty) return;
  if (!envelope) {
    body.hidden = true;
    empty.hidden = false;
    return;
  }
  body.hidden = false;
  empty.hidden = true;

  // Modulation = min(mod_x, mod_y) element-wise
  const modX = envelope.modulation_x_grid;
  const modY = envelope.modulation_y_grid;
  const cons = envelope.phase_consistency_grid;

  if (Array.isArray(modX) && Array.isArray(modY)) {
    renderGridToCanvas(
      "defl-qmap-mod",
      combineMinGrid(modX, modY),
      { autoRange: true, labelsId: "defl-qmap-mod-labels" },
    );
  }
  if (Array.isArray(cons)) {
    renderGridToCanvas(
      "defl-qmap-cons",
      cons,
      { fixedMin: 0, fixedMax: 1, labelsId: null },
    );
  }
}

function combineMinGrid(a, b) {
  const h = a.length;
  const out = new Array(h);
  for (let r = 0; r < h; r++) {
    const ra = a[r] || [];
    const rb = b[r] || [];
    const w = Math.min(ra.length, rb.length);
    const row = new Array(w);
    for (let c = 0; c < w; c++) {
      const va = ra[c], vb = rb[c];
      if (va == null || vb == null) { row[c] = null; continue; }
      row[c] = Math.min(va, vb);
    }
    out[r] = row;
  }
  return out;
}

function renderGridToCanvas(canvasId, grid, opts) {
  const canvas = $(canvasId);
  if (!canvas || !Array.isArray(grid) || grid.length === 0) return;
  const h = grid.length;
  const w = Array.isArray(grid[0]) ? grid[0].length : 0;
  if (w === 0) return;

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);

  let vMin, vMax;
  if (opts.autoRange) {
    vMin = Infinity; vMax = -Infinity;
    _iterGrid(grid, (v) => {
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    });
    if (!Number.isFinite(vMin)) { vMin = 0; vMax = 1; }
  } else {
    vMin = opts.fixedMin ?? 0;
    vMax = opts.fixedMax ?? 1;
  }
  const range = (vMax - vMin) || 1;

  for (let r = 0; r < h; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < w; c++) {
      const v = row[c];
      const k = (r * w + c) * 4;
      if (v == null || !Number.isFinite(v)) {
        img.data[k] = 0;
        img.data[k + 1] = 0;
        img.data[k + 2] = 0;
        img.data[k + 3] = 0;
      } else {
        const t = (v - vMin) / range;
        const [rr, gg, bb] = viridis(t);
        img.data[k] = rr;
        img.data[k + 1] = gg;
        img.data[k + 2] = bb;
        img.data[k + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  if (opts.labelsId) {
    const labelsEl = $(opts.labelsId);
    if (labelsEl) {
      labelsEl.innerHTML = `<span>${vMax.toFixed(1)}</span><span>${vMin.toFixed(1)}</span>`;
    }
  }
}

// ──────── Unwrap-jump-risk badge (Curl tab) ────────

function renderJumpRiskBadge(quality) {
  const badge = $("defl-jump-risk-badge");
  const caption = $("defl-jump-risk-caption");
  if (!badge || !caption) return;
  const risk = (quality && quality.unwrap_jump_risk) || "unknown";
  const labels = {
    low: "Unwrap OK",
    medium: "Unwrap: some risk",
    high: "Unwrap: high risk",
    unknown: "Unwrap: N/A",
  };
  const captions = {
    low: "Multi-freq phases agree across periods — integrated height is trustworthy where modulation is adequate.",
    medium: "A small fraction of in-mask pixels disagree across periods. Inspect the Phase Consistency map.",
    high: "Significant fraction of pixels show phase inconsistency — unwrap errors likely. Consider recapturing.",
    unknown: "Fast (single-period) capture — no consistency signal available. Switch to multi-frequency to diagnose unwrap errors.",
  };
  badge.hidden = false;
  badge.textContent = labels[risk] || risk;
  badge.className = "defl-jump-risk-badge defl-jr-" + risk;
  caption.hidden = false;
  caption.textContent = captions[risk] || "";
}

function renderQualitySidebar(quality) {
  const sidebar = $("defl-quality-sidebar");
  if (!sidebar) return;
  if (!quality) { sidebar.hidden = true; return; }
  sidebar.hidden = false;

  const overall = quality.overall || "fair";
  const overallEl = $("defl-q-overall");
  const labels = { good: "GOOD", fair: "FAIR", poor: "POOR" };
  const captions = {
    good: "Result is reliable.",
    fair: "Result is usable; check warnings.",
    poor: "Result may be unreliable.",
  };
  if (overallEl) {
    overallEl.className = "defl-quality-overall defl-q-" + overall;
    overallEl.innerHTML =
      `<div class="defl-q-overall-label">${labels[overall] || overall.toUpperCase()}</div>` +
      `<div class="defl-q-overall-caption">${captions[overall] || ""}</div>`;
  }

  const cov = quality.modulation_coverage;
  const modX = quality.modulation_x_median;
  const modY = quality.modulation_y_median;
  const clipped = quality.clipped_fraction;
  const maskValid = quality.mask_valid_frac;  // 0..1
  const curlRms = quality.curl_rms;

  // Modulation imbalance
  let modImb = null;
  if (Number.isFinite(modX) && Number.isFinite(modY)) {
    const m = Math.max(modX, modY, 1e-10);
    modImb = Math.abs(modX - modY) / m * 100;
  }

  const rows = $("defl-q-rows");
  if (rows) {
    const fmt = (v, d = 1, suffix = "") =>
      Number.isFinite(v) ? v.toFixed(d) + suffix : "\u2014";
    const covCls = (cov < 50) ? "warn" : (cov >= 70 ? "ok" : "");
    const clippedCls = (clipped > 5) ? "warn" : "";
    const curlCls = (curlRms > 0.05) ? "warn" : "";
    const imbCls = (modImb !== null && modImb > 20) ? "warn" : "";
    rows.innerHTML = `
      <div class="defl-q-row ${covCls}"><span>Modulation coverage</span><span>${fmt(cov, 1, "%")}</span></div>
      <div class="defl-q-row"><span>Mod X / Y median</span><span>${fmt(modX, 1)} / ${fmt(modY, 1)}</span></div>
      <div class="defl-q-row ${imbCls}"><span>Mod imbalance</span><span>${modImb !== null ? modImb.toFixed(0) + "%" : "\u2014"}</span></div>
      <div class="defl-q-row ${clippedCls}"><span>Clipped pixels</span><span>${fmt(clipped, 1, "%")}</span></div>
      <div class="defl-q-row"><span>Mask valid</span><span>${Number.isFinite(maskValid) ? (maskValid * 100).toFixed(1) + "%" : "\u2014"}</span></div>
      <div class="defl-q-row ${curlCls}"><span>Curl RMS</span><span>${fmt(curlRms, 4)} <span class="defl-q-unit">phase-units</span></span></div>
    `;
  }

  // Warnings collapsible
  const warns = (quality.warnings || []);
  const summary = $("defl-q-warnings-summary");
  const list = $("defl-q-warnings-list");
  const details = $("defl-q-warnings-details");
  if (summary) summary.textContent = warns.length
    ? `${warns.length} warning${warns.length === 1 ? "" : "s"}`
    : "No warnings";
  if (details) details.open = warns.length > 0;
  if (list) {
    list.innerHTML = "";
    for (const w of warns) {
      const li = document.createElement("li");
      li.textContent = w;
      list.appendChild(li);
    }
  }
}

async function refreshStatus() {
  try {
    const r = await apiFetch("/deflectometry/status");
    if (!r.ok) return;
    const d = await r.json();
    const connected = !!d.ipad_connected;
    setBadge("defl-badge-ipad", connected);
    $("defl-badge-ipad").textContent = "iPad: " + (connected ? "connected" : "\u2014");
    setBadge("defl-badge-flat", !!d.has_flat_field);
    $("defl-badge-flat").textContent = "Flat field: " + (d.has_flat_field ? "\u2713" : "\u2014");
    setBadge("defl-badge-ref", !!d.has_reference);
    $("defl-badge-ref").textContent = "Baseline: " + (d.has_reference ? "\u2713" : "\u2014");
    const hasCal = d.cal_factor != null;
    setBadge("defl-badge-cal", hasCal);
    $("defl-badge-cal").textContent = "Calibration: " + (hasCal ? "\u2713" : "\u2014");
    const dispCalBadge = $("defl-badge-display-cal");
    if (dispCalBadge) {
      if (d.has_display_cal) {
        dispCalBadge.classList.add("active");
      } else {
        dispCalBadge.classList.remove("active");
        dispCalBadge.textContent = "Display: \u2014";
      }
    }
    // Render last result if we have one and we don't already have it cached
    if (d.last_result && !df.lastResult) {
      df.lastResult = d.last_result;
      renderPhaseResult(d.last_result);
      const compStatus = $("defl-status-compute");
      if (compStatus) compStatus.textContent = "Done";
    }
  } catch { /* ignore */ }
}

function startPolling() {
  if (state._hosted) return;
  stopPolling();
  const preview = document.getElementById("defl-preview");
  if (preview && !preview.src.includes("/stream")) preview.src = "/stream";
  apiFetch("/deflectometry/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => {});
  refreshStatus();
  df.polling = setInterval(refreshStatus, 1000);
}

function stopPolling() {
  if (df.polling) {
    clearInterval(df.polling);
    df.polling = null;
  }
}

// ──────── Height views ────────

async function load3dSurface() {
  const empty = $("defl-height-empty");
  const content = $("defl-height-content");
  if (empty) empty.textContent = "Loading height map\u2026";
  try {
    const payload = { mask_threshold: getMaskThreshold(), smooth_sigma: getSmoothSigma() };
    if (df.maskPolygons.length > 0) {
      payload.mask_polygons = df.maskPolygons.map(p => ({
        vertices: p.vertices.map(v => [v.x, v.y]),
        include: p.include,
      }));
    }
    const r = await apiFetch("/deflectometry/heightmap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      if (empty) empty.textContent = "Failed to load heightmap.";
      return;
    }
    const hm = await r.json();
    df.lastHeightmap = hm;
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
    // Update unit tags using the heightmap's authoritative unit field
    const unitText = hm.unit === "µm" ? "(µm)" : "(phase-rad — uncalibrated)";
    const u3d = $("defl-height-unit-3d");
    const u2d = $("defl-height-unit-2d");
    if (u3d) u3d.textContent = unitText;
    if (u2d) u2d.textContent = unitText;
    await render3d(hm);
    render2dHeight(hm);
  } catch (e) {
    if (empty) empty.textContent = "Error: " + (e?.message || e);
  }
}

// Viridis colormap approximation (5 stops). Returns [r,g,b] in 0..255.
const VIRIDIS_STOPS = [
  [68, 1, 84],     // 0.00
  [59, 82, 139],   // 0.25
  [33, 145, 140],  // 0.50
  [94, 201, 98],   // 0.75
  [253, 231, 37],  // 1.00
];
function viridis(t) {
  if (!Number.isFinite(t)) return [0, 0, 0];
  t = Math.max(0, Math.min(1, t));
  const x = t * (VIRIDIS_STOPS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS_STOPS[i];
  const b = VIRIDIS_STOPS[Math.min(i + 1, VIRIDIS_STOPS.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function render2dHeight(hm) {
  const canvas = $("defl-height-2d-canvas");
  if (!canvas || !hm) return;
  const w = hm.width, h = hm.height;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);

  // Find min/max
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < hm.data.length; i++) {
    const v = hm.data[i];
    if (v != null && Number.isFinite(v)) {
      if (v < zMin) zMin = v;
      if (v > zMax) zMax = v;
    }
  }
  if (!Number.isFinite(zMin)) { zMin = 0; zMax = 1; }
  const zRange = zMax - zMin || 1;

  for (let i = 0; i < hm.data.length; i++) {
    const v = hm.data[i];
    const k = i * 4;
    if (v == null || !Number.isFinite(v)) {
      // Transparent for masked pixels
      img.data[k] = 0;
      img.data[k + 1] = 0;
      img.data[k + 2] = 0;
      img.data[k + 3] = 0;
    } else {
      const t = (v - zMin) / zRange;
      const [r, g, b] = viridis(t);
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Colorbar: vertical strip with min/max labels
  const cb = $("defl-height-colorbar");
  if (cb) {
    const unit = hm.unit === "µm" ? "µm" : "rad";
    cb.innerHTML = `
      <div class="defl-cb-strip"></div>
      <div class="defl-cb-labels">
        <span>${zMax.toFixed(unit === "µm" ? 2 : 3)} ${unit}</span>
        <span>${zMin.toFixed(unit === "µm" ? 2 : 3)} ${unit}</span>
      </div>
    `;
  }
}

async function render3d(hm) {
  const host = $("defl-3d-host");
  if (!host) return;
  const controlsEl = $("defl-3d-controls");
  host.innerHTML = "";

  if (!df.threeLoaded) {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const { OrbitControls } = await import("https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js");
    df.THREE = THREE;
    df.OrbitControls = OrbitControls;
    df.threeLoaded = true;
  }
  const THREE = df.THREE;
  const OrbitControls = df.OrbitControls;

  const w = host.clientWidth || 600;
  const h = host.clientHeight || 400;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  if (controlsEl) host.appendChild(controlsEl);
  const controls = new OrbitControls(camera, renderer.domElement);

  const cols = hm.width, rows = hm.height;
  const geo = new THREE.PlaneGeometry(cols, rows, cols - 1, rows - 1);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < hm.data.length; i++) {
    const v = hm.data[i];
    if (v != null) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
  }
  const zRange = zMax - zMin || 1;

  const zSlider = $("defl-3d-z-scale");
  const zLabel = $("defl-3d-z-val");
  let zScale = zSlider ? parseFloat(zSlider.value) : 10;

  function applyZ() {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const v = hm.data[idx];
        const z = (v != null) ? ((v - zMin) / zRange - 0.5) * zScale : 0;
        pos.setZ(idx, z);
        const t = (v != null) ? (v - zMin) / zRange : 0;
        const [vr, vg, vb] = viridis(t);
        colors[idx * 3] = vr / 255;
        colors[idx * 3 + 1] = vg / 255;
        colors[idx * 3 + 2] = vb / 255;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  applyZ();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const light1 = new THREE.DirectionalLight(0xffffff, 1);
  light1.position.set(1, 1, 2);
  scene.add(light1);
  scene.add(new THREE.AmbientLight(0x404040));

  camera.position.set(0, -cols * 0.4, cols * 0.6);
  camera.lookAt(0, 0, 0);
  controls.update();

  if (zSlider) {
    zSlider.oninput = () => {
      zScale = parseFloat(zSlider.value);
      if (zLabel) zLabel.textContent = zScale + "x";
      applyZ();
    };
  }

  function animate() {
    if (!host.isConnected) return;
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  const ro = new ResizeObserver(() => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (nw > 0 && nh > 0) {
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
  });
  ro.observe(host);
}

async function runDiagnostics() {
  const empty = $("defl-diag-empty");
  const content = $("defl-diag-content");
  if (empty) empty.textContent = "Running diagnostics\u2026";
  try {
    const payload = { smooth_sigma: getSmoothSigma() };
    if (df.maskPolygons.length > 0) {
      payload.mask_polygons = df.maskPolygons.map(p => ({
        vertices: p.vertices.map(v => [v.x, v.y]),
        include: p.include,
      }));
    }
    const r = await apiFetch("/deflectometry/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const msg = await r.text();
      if (empty) empty.textContent = "Failed: " + msg;
      return;
    }
    const d = await r.json();
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
    const fs = $("defl-diag-framestats");
    if (fs && d.frame_stats) {
      fs.textContent = d.frame_stats.map(f =>
        `${f.name}  min=${f.min.toFixed(0)}  max=${f.max.toFixed(0)}  mean=${f.mean.toFixed(1)}  std=${f.std.toFixed(1)}`
      ).join("\n");
    }
    if (d.modulation_x) {
      $("defl-diag-mod-x").src = "data:image/png;base64," + d.modulation_x.png_b64;
      const el = $("defl-diag-mod-x-stats");
      if (el) el.textContent = `min=${d.modulation_x.min.toFixed(1)} max=${d.modulation_x.max.toFixed(1)} mean=${d.modulation_x.mean.toFixed(1)} median=${d.modulation_x.median.toFixed(1)}`;
    }
    if (d.modulation_y) {
      $("defl-diag-mod-y").src = "data:image/png;base64," + d.modulation_y.png_b64;
      const el = $("defl-diag-mod-y-stats");
      if (el) el.textContent = `min=${d.modulation_y.min.toFixed(1)} max=${d.modulation_y.max.toFixed(1)} mean=${d.modulation_y.mean.toFixed(1)} median=${d.modulation_y.median.toFixed(1)}`;
    }
    const b64 = (id, key) => { const el = $(id); if (el && d[key]) el.src = "data:image/png;base64," + d[key]; };
    b64("defl-diag-wrap-x", "wrapped_x_png_b64");
    b64("defl-diag-wrap-y", "wrapped_y_png_b64");
    b64("defl-diag-unw-x", "unwrapped_raw_x_png_b64");
    b64("defl-diag-unw-y", "unwrapped_raw_y_png_b64");
    // Phase 2 Track 3: render per-pixel quality maps from envelope (if loaded)
    if (df.lastEnvelope) renderQualityMaps(df.lastEnvelope);
  } catch (e) {
    if (empty) empty.textContent = "Error: " + (e?.message || e);
  }
}

export function initDeflectometry() {
  buildWorkspace();
  loadProfileList();

  const observer = new MutationObserver(() => {
    const root = $("mode-deflectometry");
    if (!root) return;
    if (root.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });
  const root = $("mode-deflectometry");
  if (root) observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}
