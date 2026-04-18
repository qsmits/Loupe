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
  // Phase 3A Track E: wizard state (cleared when wizard closes)
  wizardState: null,
  wizardStep: 1,
  // Summary of the currently bound CalibrationSession (from /status), or null
  activeCalSession: null,
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

// Phase 4 Wave 3: when slope_method === "geometric", slopes live in mm/mm
// (dimensionless gradient); display as mrad (×1000). Phase_proxy keeps rad.
function formatSlopeStats(stats, slopeMethod) {
  if (!stats) return "\u2014";
  if (slopeMethod === "geometric") {
    const k = 1000;
    const pv = Number.isFinite(stats.pv) ? (stats.pv * k).toFixed(3) : "\u2014";
    const rms = Number.isFinite(stats.rms) ? (stats.rms * k).toFixed(3) : "\u2014";
    const mean = Number.isFinite(stats.mean) ? (stats.mean * k).toFixed(3) : "\u2014";
    return `PV:   ${pv} mrad\nRMS:  ${rms} mrad\nMean: ${mean} mrad`;
  }
  const pv = Number.isFinite(stats.pv) ? stats.pv.toFixed(3) : "\u2014";
  const rms = Number.isFinite(stats.rms) ? stats.rms.toFixed(3) : "\u2014";
  const mean = Number.isFinite(stats.mean) ? stats.mean.toFixed(3) : "\u2014";
  return `PV:   ${pv} rad\nRMS:  ${rms} rad\nMean: ${mean} rad`;
}

// Phase 4 Wave 3: Height-tab stats for geometric mode. Takes paraboloid_fit
// (PV/RMS in mm) and uncertainty_um (±µm). Returns null if paraboloid_fit
// is missing — caller falls back to the legacy formatStats.
function formatHeightStatsGeometric(paraboloidFit, uncertaintyUm) {
  if (!paraboloidFit) return null;
  const pv_um = Number.isFinite(paraboloidFit.pv_mm) ? paraboloidFit.pv_mm * 1000 : NaN;
  const rms_um = Number.isFinite(paraboloidFit.rms_mm) ? paraboloidFit.rms_mm * 1000 : NaN;
  const pvU = uncertaintyUm?.pv_uncertainty_um;
  const rmsU = uncertaintyUm?.rms_uncertainty_um;
  const fmt = (v, u, d = 2) => {
    const vStr = Number.isFinite(v) ? v.toFixed(d) : "\u2014";
    if (!Number.isFinite(u)) return vStr + " \u00b5m";
    return `${vStr} \u00b1 ${u.toFixed(d)} \u00b5m`;
  };
  return `PV:   ${fmt(pv_um, pvU)}\nRMS:  ${fmt(rms_um, rmsU)}`;
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
        <!-- Phase 3A Track E: active cal session indicator -->
        <div class="defl-cal-active-badge" id="defl-cal-active-badge" hidden>
          <span class="defl-cal-check">\u2713</span>
          <span id="defl-cal-active-label">Calibrated</span>
          <span style="opacity:0.6;font-size:9px">\u25be</span>
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
          <div class="defl-mask-hint" id="defl-mask-hint" hidden>
            No aperture mask defined \u2014 detection uses the full modulation mask.
            Use \u201cEdit Mask\u201d to restrict.
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
              <option value="ipad_air_1" data-pitch="0.0962" data-width-mm="197.12" data-height-mm="147.84">iPad Air 1 (264 ppi)</option>
              <option value="ipad_air_2" data-pitch="0.0962" data-width-mm="197.12" data-height-mm="147.84">iPad Air 2 (264 ppi)</option>
              <option value="ipad_pro_11" data-pitch="0.0846" data-width-mm="202.0" data-height-mm="141.1">iPad Pro 11" (264 ppi)</option>
              <option value="ipad_pro_12_9" data-pitch="0.0846" data-width-mm="262.8" data-height-mm="196.6">iPad Pro 12.9" (264 ppi)</option>
              <option value="custom" data-pitch="" data-width-mm="" data-height-mm="">Custom\u2026</option>
            </select>
          </label>
          <label id="defl-custom-pitch-label" hidden>Pixel pitch (mm)
            <input type="number" id="defl-custom-pitch" min="0.01" max="1" step="0.001" value="0.096" />
          </label>
          <!-- Phase 3B Wave 2: saved screen shape indicator -->
          <div class="defl-screen-shape-row" id="defl-screen-shape-row" hidden>
            <div class="defl-screen-shape-label" id="defl-screen-shape-label">Screen shape: \u2014</div>
            <button class="detect-btn" id="defl-btn-open-screen-shape" title="Open the ball-calibration wizard step">Recalibrate</button>
          </div>
          <!-- Microscope-cal drift indicator: red if unset, amber if drifted,
               green if matches the bound session's snapshot. Click opens
               microscope mode so the user can recalibrate. -->
          <div class="defl-microscope-cal-row" id="defl-microscope-cal-row">
            <div class="defl-microscope-cal-label" id="defl-microscope-cal-label">Microscope cal: \u2014</div>
            <button class="detect-btn" id="defl-btn-open-microscope-cal" title="Switch to microscope mode to (re)calibrate lateral scale">Calibrate</button>
          </div>
          <label>Averages per phase step
            <input type="number" id="defl-averages" min="1" max="10" step="1" value="3" style="width:65px" />
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
          <!-- Phase 4 Wave 3: advanced compute options (developer-tuning) -->
          <details class="defl-advanced-compute" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">
            <summary style="cursor:pointer;font-size:11px;opacity:0.65">Advanced compute options</summary>
            <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
              <label style="font-size:11px">Slope solver
                <select id="defl-slope-solver" style="font-size:11px">
                  <option value="auto" selected>Auto (geometric when calibrated)</option>
                  <option value="geometric">Force geometric</option>
                  <option value="phase_proxy">Force phase-proxy</option>
                </select>
              </label>
              <label style="font-size:11px">Screen distance override (mm)
                <input type="number" id="defl-screen-distance-override" min="1" max="5000" step="1" placeholder="(default 250)" style="font-size:11px;width:90px" />
              </label>
              <div style="font-size:10px;opacity:0.55">
                Leave at defaults unless you are intentionally tuning the solver.
              </div>
            </div>
          </details>
        </div>
      </div>

      <!-- Right: action bar + results -->
      <div class="defl-results-col">
        <!-- Phase 3A Track E: CALIBRATION REQUIRED banner -->
        <div class="defl-cal-required-banner" id="defl-cal-required-banner" hidden>
          <div class="defl-cal-banner-text">
            <span class="defl-cal-banner-title">Calibration required</span>
            <span>Complete the guided calibration before capturing parts.</span>
          </div>
          <button id="defl-btn-start-wizard">Start calibration</button>
          <button id="defl-btn-load-previous-cal">Load previous\u2026</button>
        </div>
        <!-- Phase 4 Wave 3: slope-method indicator badge -->
        <div class="defl-slope-method-row" id="defl-slope-method-row" hidden>
          <button class="defl-slope-method-badge" id="defl-slope-method-badge" type="button">
            <span class="defl-sm-title" id="defl-sm-title">\u2014</span>
            <span class="defl-sm-uncert" id="defl-sm-uncert" hidden></span>
            <span class="defl-sm-chevron" aria-hidden="true">\u24d8</span>
          </button>
        </div>
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
                <!-- Phase 4 Wave 3: geometric-mode affirmation (replaces uncal banner when cal is complete) -->
                <div id="defl-geo-banner" class="defl-geo-banner" hidden>
                  <span id="defl-geo-banner-text">Geometric height</span>
                </div>
                <!-- Phase 4 Wave 3: compact Height stats block (±µm error bars in geometric mode) -->
                <pre id="defl-height-stats" class="defl-height-stats" hidden>\u2014</pre>
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
                <div class="defl-single-label">X Slope <span class="defl-unit-tag" id="defl-x-slope-unit">(phase-radians)</span></div>
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
                <div class="defl-single-label">Y Slope <span class="defl-unit-tag" id="defl-y-slope-unit">(phase-radians)</span></div>
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
                <div class="defl-single-label">Slope Magnitude <span class="defl-unit-tag" id="defl-slope-mag-unit">(phase-radians)</span></div>
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
            <!-- Phase 4 Wave 3: dismissible phase-proxy note -->
            <div class="defl-phase-proxy-note" id="defl-phase-proxy-note" hidden>
              <span>Running in phase-proxy mode. Complete calibration to unlock \u00b5m-scale measurements with quoted uncertainty.</span>
              <button id="defl-phase-proxy-note-dismiss" title="Dismiss">&times;</button>
            </div>
            <details id="defl-q-warnings-details" class="defl-quality-warnings">
              <summary id="defl-q-warnings-summary">No warnings</summary>
              <ul id="defl-q-warnings-list"></ul>
            </details>
          </aside>
        </div>
      </div>

      <!-- Phase 3A Track E: Calibration wizard modal host -->
      <div id="defl-wizard-host"></div>
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
  // Display: store the option label as model ("iPad Air 1 (264 ppi)", "Custom…",
  // ...) and the pitch from data-pitch for presets / custom input for Custom.
  const deviceSel = document.getElementById("defl-display-device");
  const selOpt = deviceSel?.selectedOptions?.[0];
  const isCustom = (deviceSel?.value === "custom");
  let displayModel = "";
  if (selOpt) displayModel = selOpt.textContent.trim();
  let pitch = 0.0962;
  if (isCustom) {
    const customPitchEl = document.getElementById("defl-custom-pitch");
    const v = parseFloat(customPitchEl?.value);
    if (Number.isFinite(v) && v > 0) pitch = v;
  } else if (selOpt) {
    const v = parseFloat(selOpt.dataset?.pitch);
    if (Number.isFinite(v) && v > 0) pitch = v;
  }
  const profile = {
    name,
    display: {
      model: displayModel,
      pixel_pitch_mm: pitch,
    },
    capture: {
      freq: getFreq(),
      averages: getAverages(),
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
    const maskValEl = document.getElementById("defl-mask-thresh-val");
    if (maskValEl && threshEl) maskValEl.textContent = threshEl.value + "%";
    const smoothEl = document.getElementById("defl-smooth");
    if (smoothEl) smoothEl.value = p.processing?.smooth_sigma ?? 0;
    const smoothValEl = document.getElementById("defl-smooth-val");
    if (smoothValEl && smoothEl) smoothValEl.textContent = smoothEl.value;
    const averagesEl = document.getElementById("defl-averages");
    if (averagesEl && p.capture?.averages != null) averagesEl.value = p.capture.averages;
    // Display: match stored model (option label text). If no match, fall back
    // to "Custom…" and populate the custom pitch input with pixel_pitch_mm.
    const deviceEl = document.getElementById("defl-display-device");
    const customLabel = document.getElementById("defl-custom-pitch-label");
    const customPitchEl = document.getElementById("defl-custom-pitch");
    if (deviceEl) {
      const storedModel = (p.display?.model || "").trim();
      const storedPitch = parseFloat(p.display?.pixel_pitch_mm);
      let matched = null;
      if (storedModel) {
        for (const opt of deviceEl.options) {
          if (opt.textContent.trim() === storedModel) { matched = opt; break; }
        }
      }
      if (matched) {
        deviceEl.value = matched.value;
        if (customLabel) customLabel.hidden = (matched.value !== "custom");
        if (matched.value === "custom" && customPitchEl && Number.isFinite(storedPitch) && storedPitch > 0) {
          customPitchEl.value = storedPitch;
        }
      } else {
        deviceEl.value = "custom";
        if (customLabel) customLabel.hidden = false;
        if (customPitchEl && Number.isFinite(storedPitch) && storedPitch > 0) {
          customPitchEl.value = storedPitch;
        }
      }
    }
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
        // Phase 3A Track E: refresh aperture hint visibility
        if (typeof applyCalGating === "function") applyCalGating();
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
  applyCalGating();
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

  // Phase 4 Wave 3: slope-method badge → details modal
  $("defl-slope-method-badge")?.addEventListener("click", () => {
    showSlopeMethodDetails();
  });

  // Phase 4 Wave 3: phase-proxy note dismiss
  $("defl-phase-proxy-note-dismiss")?.addEventListener("click", () => {
    const b = $("defl-phase-proxy-note");
    if (b) b.hidden = true;
    df.phaseProxyNoteDismissed = true;
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

  // Phase 3A Track E: wizard + gating wires
  $("defl-btn-start-wizard")?.addEventListener("click", () => openWizard());
  $("defl-btn-load-previous-cal")?.addEventListener("click", () => openCalPicker());
  // Phase 3B Wave 2: jump into wizard screen-shape step
  $("defl-btn-open-screen-shape")?.addEventListener("click", () => openWizard({ startStep: 5 }));
  // Jump to microscope mode so the user can (re)calibrate the lateral scale.
  // Microscope cal uses the two-point calibration flow there — there's no
  // programmatic hand-off, so we switch modes and let the user trigger the
  // "C" shortcut or sidebar button.
  $("defl-btn-open-microscope-cal")?.addEventListener("click", () => {
    const sel = document.getElementById("mode-switcher");
    if (sel) sel.value = "microscope";
    switchMode("microscope");
  });
  $("defl-cal-active-badge")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleCalBadgeMenu();
  });
  // Click outside to close badge menu
  document.addEventListener("click", () => {
    const menu = document.getElementById("defl-cal-active-menu");
    if (menu) menu.remove();
  });
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

function getAverages() {
  const el = $("defl-averages");
  let n = parseInt(el ? el.value : "3", 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 10) n = 10;
  return n;
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
        averages: getAverages(),
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
        averages: getAverages(),
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
    // Phase 4 Wave 3: advanced solver options (Auto/geometric/phase_proxy +
    // optional screen-distance override). Auto (null) is the default.
    const solverSel = $("defl-slope-solver");
    const solver = solverSel?.value || "auto";
    if (solver === "geometric" || solver === "phase_proxy") {
      payload.slope_method = solver;
    }
    const sdOvr = $("defl-screen-distance-override");
    const sdVal = sdOvr ? parseFloat(sdOvr.value) : NaN;
    if (Number.isFinite(sdVal) && sdVal > 0) payload.screen_distance_mm = sdVal;
    const ppm = state.calibration?.pixelsPerMm;
    if (ppm && ppm > 0) payload.pixels_per_mm = ppm;
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
  // Phase 4 Wave 3: hide slope-method badge + affirmation/proxy banners
  const smRow = $("defl-slope-method-row");
  if (smRow) smRow.hidden = true;
  const geoBan = $("defl-geo-banner");
  if (geoBan) geoBan.hidden = true;
  const ppNote = $("defl-phase-proxy-note");
  if (ppNote) ppNote.hidden = true;
  const heightStats = $("defl-height-stats");
  if (heightStats) { heightStats.hidden = true; heightStats.textContent = "\u2014"; }
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
  // Phase 4 Wave 3 fields. Gracefully degrade when missing.
  const slopeMethod = result.slope_method || null;
  const paraboloidFit = result.paraboloid_fit || null;
  const uncertaintyUm = result.uncertainty_um || null;
  const isGeometric = slopeMethod === "geometric";

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

  // Slope stats — mrad in geometric mode, rad in phase-proxy (legacy).
  $("defl-phase-x-stats").textContent = formatSlopeStats(result.stats_x, slopeMethod);
  $("defl-phase-y-stats").textContent = formatSlopeStats(result.stats_y, slopeMethod);
  $("defl-slope-mag-stats").textContent = formatSlopeStats(result.stats_slope_mag, slopeMethod);
  // Curl stays in phase-units regardless of slope_method (diagnostic-only).
  $("defl-curl-stats").textContent = formatSlopeStats(result.stats_curl, null);

  // Slope tab unit tags (phase-radians vs mrad)
  const slopeUnitTag = isGeometric ? "(mrad)" : "(phase-rad — uncalibrated slope proxy)";
  const xUnit = $("defl-x-slope-unit");
  const yUnit = $("defl-y-slope-unit");
  const smUnit = $("defl-slope-mag-unit");
  if (xUnit) xUnit.textContent = slopeUnitTag;
  if (yUnit) yUnit.textContent = slopeUnitTag;
  if (smUnit) smUnit.textContent = slopeUnitTag;

  // Show Height empty-state cleared (3D/2D will populate when load3dSurface runs)
  const he = $("defl-height-empty");
  const hc = $("defl-height-content");
  if (he) he.hidden = true;
  if (hc) hc.hidden = false;

  // Phase 4 Wave 3: Height banners — affirmation in geometric mode,
  // dismissible "uncalibrated" only in phase_proxy mode.
  const uncalBanner = $("defl-uncal-banner");
  const geoBanner = $("defl-geo-banner");
  const geoText = $("defl-geo-banner-text");
  if (isGeometric) {
    if (uncalBanner) uncalBanner.hidden = true;
    if (geoBanner && geoText) {
      const rmsU = uncertaintyUm?.rms_uncertainty_um;
      const pvU = uncertaintyUm?.pv_uncertainty_um;
      const parts = ["Geometric height"];
      if (Number.isFinite(rmsU)) parts.push(`\u00b1${rmsU.toFixed(2)} \u00b5m RMS`);
      if (Number.isFinite(pvU)) parts.push(`\u00b1${pvU.toFixed(2)} \u00b5m PV`);
      geoText.textContent = parts.join(" \u2014 ").replace("Geometric height \u2014 ", "Geometric height: ");
      geoBanner.hidden = false;
    }
  } else {
    if (geoBanner) geoBanner.hidden = true;
    if (uncalBanner) {
      // Legacy: show for truly uncalibrated phase_proxy results, honoring dismiss.
      if (!cal && !df.uncalDismissed) uncalBanner.hidden = false;
      else uncalBanner.hidden = true;
    }
  }

  // Phase 4 Wave 3: top-of-results slope-method indicator badge
  renderSlopeMethodBadge(slopeMethod, uncertaintyUm);

  // Phase 4 Wave 3: compact Height stats block with ±µm error bars (geometric)
  const heightStats = $("defl-height-stats");
  if (heightStats) {
    if (isGeometric) {
      const txt = formatHeightStatsGeometric(paraboloidFit, uncertaintyUm);
      if (txt) {
        heightStats.textContent = txt;
        heightStats.hidden = false;
      } else {
        heightStats.hidden = true;
      }
    } else {
      heightStats.hidden = true;
    }
  }

  // Per-axis warnings (filtered from quality.warnings)
  renderAxisWarnings(result.quality);

  // Quality sidebar — now aware of geometric-mode extras.
  renderQualitySidebar(result.quality, slopeMethod, paraboloidFit, uncertaintyUm);

  // Curl tab: unwrap-jump-risk headline badge
  renderJumpRiskBadge(result.quality);
}

// Phase 4 Wave 3: slope-method details modal. Pulls status + screen-shape
// to explain why the current solver path was chosen.
async function showSlopeMethodDetails() {
  const host = $("defl-wizard-host");
  if (!host) return;
  // Show a lightweight loading modal first.
  host.innerHTML = `
    <div class="defl-wizard-overlay" id="defl-sm-details-overlay">
      <div class="defl-wizard-modal" style="width:520px">
        <div class="defl-wizard-header">
          <div class="defl-wizard-title">Slope solver status</div>
          <button class="defl-wizard-close" id="defl-sm-details-close">\u00d7</button>
        </div>
        <div class="defl-wizard-body" id="defl-sm-details-body">
          <div style="font-size:12px;opacity:0.6">Loading\u2026</div>
        </div>
      </div>
    </div>
  `;
  $("defl-sm-details-close")?.addEventListener("click", () => { host.innerHTML = ""; });
  const body = $("defl-sm-details-body");
  try {
    const [statusR, shapeR] = await Promise.all([
      apiFetch("/deflectometry/status"),
      apiFetch("/deflectometry/screen-shape"),
    ]);
    const status = statusR.ok ? await statusR.json() : {};
    let shape = null;
    try { shape = shapeR.ok ? await shapeR.json() : null; } catch { shape = null; }
    const active = status.active_cal_session || null;
    const comp = active?.completeness || {};
    const result = df.lastResult || {};
    const slopeMethod = result.slope_method || (result.tuning && result.tuning.slope_method) || null;
    const calSnap = result.calibration_snapshot || {};
    const tuning = result.tuning || {};
    const uu = result.uncertainty_um || null;
    const isGeo = slopeMethod === "geometric";
    const check = (b) => b ? "\u2713" : "\u2717";
    const screenDist = (result.geometry && result.geometry.screen_distance_mm)
      ?? calSnap.estimated_screen_distance_mm
      ?? null;
    const shapeLoaded = !!shape;
    let uncertLines = "";
    if (uu && isGeo) {
      const comps = uu.components_um || {};
      uncertLines = `
        <div class="defl-sm-details-row" style="margin-top:10px">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px">Uncertainty breakdown (RMS)</div>
          <div style="font-size:11px;opacity:0.85">
            <div>Total: \u00b1${Number(uu.rms_uncertainty_um).toFixed(3)} \u00b5m RMS / \u00b1${Number(uu.pv_uncertainty_um).toFixed(3)} \u00b5m PV</div>
            ${Number.isFinite(comps.fit) ? `<div>&nbsp;\u2022 fit residual: ${comps.fit.toFixed(3)} \u00b5m</div>` : ""}
            ${Number.isFinite(comps.cal_factor_rms) ? `<div>&nbsp;\u2022 cal-factor: ${comps.cal_factor_rms.toFixed(3)} \u00b5m</div>` : ""}
            ${Number.isFinite(comps.pose) ? `<div>&nbsp;\u2022 pose: ${comps.pose.toFixed(3)} \u00b5m</div>` : ""}
          </div>
        </div>
      `;
    }
    body.innerHTML = `
      <div class="defl-sm-details-badge ${isGeo ? "defl-sm-geo" : "defl-sm-proxy"}" style="margin-bottom:10px">
        ${isGeo ? "Geometric slope solver" : "Phase-proxy fallback"}
      </div>
      <div style="font-size:11px;opacity:0.7;margin-bottom:10px">
        ${isGeo
          ? "Height in \u00b5m, slopes in mm/mm \u2014 derived from the full reflection geometry."
          : "Height in phase-rad (uncalibrated proxy). Complete calibration to enable the geometric solver."}
      </div>
      <div class="defl-sm-details-section">
        <div style="font-weight:600;font-size:12px;margin-bottom:4px">Calibration status</div>
        <div style="font-size:11px;line-height:1.6">
          <div>${check(!!comp.display)} Display response${comp.display ? " calibrated" : " missing"}</div>
          <div>${check(!!comp.corner)} Corner check${comp.corner ? " passed" : " missing"}</div>
          <div>${check(!!comp.sphere)} Sphere calibration${comp.sphere ? " fitted" : " missing"}</div>
          <div>${check(shapeLoaded)} Screen shape${shapeLoaded ? " saved" : " not saved (flat default in use)"}</div>
          <div>${check(!!calSnap.geometry_complete)} Geometry complete (per envelope)</div>
        </div>
      </div>
      <div class="defl-sm-details-section" style="margin-top:10px">
        <div style="font-weight:600;font-size:12px;margin-bottom:4px">Current compute parameters</div>
        <div style="font-size:11px;line-height:1.6">
          <div>slope_method: <code>${slopeMethod || "\u2014"}</code> (tuning.slope_method: <code>${tuning.slope_method || "\u2014"}</code>)</div>
          <div>screen_distance_mm: <code>${screenDist != null ? Number(screenDist).toFixed(2) : "\u2014"}</code></div>
          <div>pixels_per_mm: <code>${state.calibration?.pixelsPerMm != null ? Number(state.calibration.pixelsPerMm).toFixed(3) : "\u2014"}</code></div>
        </div>
      </div>
      ${uncertLines}
      ${!isGeo ? `
        <div style="margin-top:12px;font-size:11px;opacity:0.7">
          To unlock geometric mode, complete the calibration wizard (display, corner,
          sphere) and save a screen shape via the ball calibration flow.
        </div>
      ` : ""}
    `;
  } catch (e) {
    body.innerHTML = `<div style="font-size:12px;color:#f87171">Error: ${e?.message || e}</div>`;
  }
}

// Phase 4 Wave 3: slope-method indicator badge (prominent, above tab bar).
function renderSlopeMethodBadge(slopeMethod, uncertaintyUm) {
  const row = $("defl-slope-method-row");
  const badge = $("defl-slope-method-badge");
  const title = $("defl-sm-title");
  const uncert = $("defl-sm-uncert");
  if (!row || !badge || !title || !uncert) return;
  if (!slopeMethod) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  if (slopeMethod === "geometric") {
    badge.className = "defl-slope-method-badge defl-sm-geo";
    title.textContent = "Geometric slope solver";
    const rmsU = uncertaintyUm?.rms_uncertainty_um;
    if (Number.isFinite(rmsU)) {
      uncert.hidden = false;
      uncert.textContent = `\u00b1${rmsU.toFixed(2)} \u00b5m RMS`;
      // Full breakdown in title tooltip
      const comps = uncertaintyUm?.components_um || {};
      const bits = [];
      if (Number.isFinite(comps.fit)) bits.push(`fit: ${comps.fit.toFixed(2)} \u00b5m`);
      if (Number.isFinite(comps.cal_factor_rms)) bits.push(`cal: ${comps.cal_factor_rms.toFixed(2)} \u00b5m`);
      if (Number.isFinite(comps.pose)) bits.push(`pose: ${comps.pose.toFixed(2)} \u00b5m`);
      badge.title = bits.length
        ? `Uncertainty breakdown (RMS): ${bits.join(", ")}. Click for details.`
        : "Height in µm, slopes in mm/mm — derived from the full reflection geometry. Click for details.";
    } else {
      uncert.hidden = true;
      uncert.textContent = "";
      badge.title = "Height in µm, slopes in mm/mm — derived from the full reflection geometry. Click for details.";
    }
  } else {
    badge.className = "defl-slope-method-badge defl-sm-proxy";
    title.textContent = "Phase-proxy fallback";
    uncert.hidden = true;
    uncert.textContent = "";
    badge.title = "Height in phase-rad (uncalibrated proxy). Run full calibration to enable the geometric slope solver. Click for details.";
  }
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
  // Phase 4 Wave 3: respect slope_method when formatting.
  const sm = df.lastResult?.slope_method || null;
  const pre = (id, s) => {
    const el = $(id);
    if (!el) return;
    el.textContent = formatSlopeStats(s, sm);
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

function renderQualitySidebar(quality, slopeMethod, paraboloidFit, uncertaintyUm) {
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
    // Phase 4 Wave 3: extra rows for geometric mode (paraboloid fit + ±µm).
    let geoRows = "";
    if (slopeMethod === "geometric" && paraboloidFit) {
      const resid = paraboloidFit.residual_rms_mm;
      const outFrac = paraboloidFit.outlier_fraction;
      const outPct = Number.isFinite(outFrac) ? outFrac * 100 : NaN;
      const outCls = (Number.isFinite(outPct) && outPct > 5) ? "warn" : "";
      geoRows += `
        <div class="defl-q-row"><span>Paraboloid fit residual</span><span>${fmt(resid, 3)} <span class="defl-q-unit">mm RMS</span></span></div>
        <div class="defl-q-row ${outCls}"><span>Paraboloid outliers</span><span>${Number.isFinite(outPct) ? outPct.toFixed(1) + "%" : "\u2014"}</span></div>
      `;
    }
    if (slopeMethod === "geometric" && uncertaintyUm) {
      const pvU = uncertaintyUm.pv_uncertainty_um;
      const rmsU = uncertaintyUm.rms_uncertainty_um;
      geoRows += `
        <div class="defl-q-row"><span>Uncertainty (RMS)</span><span>\u00b1${Number.isFinite(rmsU) ? rmsU.toFixed(2) : "\u2014"} <span class="defl-q-unit">\u00b5m</span></span></div>
        <div class="defl-q-row"><span>Uncertainty (PV)</span><span>\u00b1${Number.isFinite(pvU) ? pvU.toFixed(2) : "\u2014"} <span class="defl-q-unit">\u00b5m</span></span></div>
      `;
    }
    rows.innerHTML = `
      <div class="defl-q-row ${covCls}"><span>Modulation coverage</span><span>${fmt(cov, 1, "%")}</span></div>
      <div class="defl-q-row"><span>Mod X / Y median</span><span>${fmt(modX, 1)} / ${fmt(modY, 1)}</span></div>
      <div class="defl-q-row ${imbCls}"><span>Mod imbalance</span><span>${modImb !== null ? modImb.toFixed(0) + "%" : "\u2014"}</span></div>
      <div class="defl-q-row ${clippedCls}"><span>Clipped pixels</span><span>${fmt(clipped, 1, "%")}</span></div>
      <div class="defl-q-row"><span>Mask valid</span><span>${Number.isFinite(maskValid) ? (maskValid * 100).toFixed(1) + "%" : "\u2014"}</span></div>
      <div class="defl-q-row ${curlCls}"><span>Curl RMS</span><span>${fmt(curlRms, 4)} <span class="defl-q-unit">phase-units</span></span></div>
      ${geoRows}
    `;
  }

  // Phase 4 Wave 3: phase-proxy dismissible note (one-time per session)
  const phaseProxyNote = $("defl-phase-proxy-note");
  if (phaseProxyNote) {
    if (slopeMethod === "phase_proxy" && !df.phaseProxyNoteDismissed) {
      phaseProxyNote.hidden = false;
    } else {
      phaseProxyNote.hidden = true;
    }
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
    // Phase 3A Track E: update cal-gating UI from status.active_cal_session
    const prev = df.activeCalSession?.id || null;
    df.activeCalSession = d.active_cal_session || null;
    const nowId = df.activeCalSession?.id || null;
    // When the bound session changes, fetch the microscope-cal snapshot
    // from the full envelope so drift detection works. We only refetch on
    // id change to keep the 1Hz poll cheap.
    if (nowId !== prev) {
      df._microscopeSnapshotPxPerMm = null;
      if (nowId) {
        try {
          const full = await apiFetch(`/deflectometry/calibrations/${encodeURIComponent(nowId)}`);
          if (full.ok) {
            const fullJson = await full.json();
            const mc = fullJson?.microscope_calibration;
            const ppm = mc?.pixels_per_mm;
            df._microscopeSnapshotPxPerMm = Number.isFinite(ppm) && ppm > 0 ? ppm : null;
          }
        } catch { /* ignore */ }
      }
    }
    applyCalGating();
  } catch { /* ignore */ }
}

// ────── Phase 3A Track E: cal gating, badge, mask hint ──────

function _completenessOk(comp) {
  if (!comp) return false;
  return !!(comp.display && comp.corner && comp.sphere);
}

// Read current rig inputs (display model, pixel pitch, pixels/mm) from
// the settings panel. Returns the params object suitable for
// GET /deflectometry/rig-fingerprint.
function _currentRigParams() {
  const deviceSel = $("defl-display-device");
  const selOpt = deviceSel?.selectedOptions?.[0];
  let displayModel = "";
  if (selOpt) displayModel = selOpt.textContent.trim();
  let pitch = 0.0962;
  if (deviceSel?.value === "custom") {
    const v = parseFloat($("defl-custom-pitch")?.value);
    if (Number.isFinite(v) && v > 0) pitch = v;
  } else if (selOpt) {
    const v = parseFloat(selOpt.dataset?.pitch);
    if (Number.isFinite(v) && v > 0) pitch = v;
  }
  const ppm = state.calibration?.pixelsPerMm || null;
  return {
    display_model: displayModel,
    pixel_pitch_mm: pitch,
    pixels_per_mm: ppm,
    // Microscope lateral cal — flows into the rig fingerprint so a
    // microscope re-cal invalidates silent cross-rig reuse of old
    // sphere-cal sessions.
    microscope_px_per_mm: ppm,
  };
}

function applyCalGating() {
  const comp = df.activeCalSession?.completeness;
  const valid = df.activeCalSession && _completenessOk(comp);
  // Banner visibility
  const banner = $("defl-cal-required-banner");
  if (banner) banner.hidden = !!valid;
  // Capture/reference/compute button gating
  const captureBtn = $("defl-btn-capture");
  const refBtn = $("defl-btn-ref");
  for (const btn of [captureBtn, refBtn]) {
    if (!btn) continue;
    btn.disabled = !valid;
    btn.title = valid ? "" : "Calibration required — complete the wizard first";
    btn.style.opacity = valid ? "" : "0.5";
  }
  // Calibrated badge
  const badge = $("defl-cal-active-badge");
  const label = $("defl-cal-active-label");
  if (badge && label) {
    if (valid) {
      badge.hidden = false;
      const capturedAt = df.activeCalSession.captured_at;
      // Phase 3B Wave 2: also note screen-shape completeness in the label.
      // Uses a dimmer "screen ✗" to signal optional-but-missing.
      const hasShape = !!comp?.screen_shape;
      const shapeFlag = hasShape
        ? ` \u2022 screen \u2713`
        : ` \u2022 <span style="opacity:0.55">screen \u2717</span>`;
      // Microscope cal match indicator — amber signal if it drifted.
      const microDrift = _microscopeCalDrifted();
      const microFlag = microDrift === "drifted"
        ? ` \u2022 <span style="color:#f5a623">microscope \u26a0</span>`
        : microDrift === "missing"
          ? ` \u2022 <span style="opacity:0.55">microscope \u2717</span>`
          : ` \u2022 microscope \u2713`;
      label.innerHTML = "Calibrated " + _relativeTime(capturedAt) + shapeFlag + microFlag;
    } else {
      badge.hidden = true;
    }
  }
  // Aperture mask hint
  const hint = $("defl-mask-hint");
  if (hint) {
    hint.hidden = !(valid && (!df.maskPolygons || df.maskPolygons.length === 0));
  }
  // Microscope-cal settings-panel row — always refresh so unset/drifted
  // states are surfaced even if no cal session is bound.
  _refreshMicroscopeCalIndicator();
}

// Compare the saved session's snapshot of microscope mm/px against the
// current state.calibration.pixelsPerMm. Returns:
//   "matches"  — current is within 0.5% of the snapshot (or both unset)
//   "drifted"  — snapshot + current both present but diverge by > 0.5%
//   "missing"  — either snapshot absent (legacy session) or no current cal
function _microscopeCalDrifted() {
  const cachedSnap = df._microscopeSnapshotPxPerMm;  // cached by refreshStatus
  const current = state.calibration?.pixelsPerMm || null;
  if (!cachedSnap && !current) return "matches";
  if (!cachedSnap || !current) return "missing";
  const rel = Math.abs(cachedSnap - current) / Math.max(cachedSnap, current);
  return rel > 0.005 ? "drifted" : "matches";
}

function _refreshMicroscopeCalIndicator() {
  const row = $("defl-microscope-cal-row");
  const label = $("defl-microscope-cal-label");
  if (!row || !label) return;
  const current = state.calibration?.pixelsPerMm || null;
  const snap = df._microscopeSnapshotPxPerMm;
  row.classList.remove("state-ok", "state-amber", "state-missing");
  if (!current) {
    row.classList.add("state-missing");
    label.textContent = "Microscope cal: not set";
    return;
  }
  const cur = current.toFixed(3);
  if (!snap) {
    // No bound session, or legacy session w/o snapshot. Still surface the
    // live value so the user knows microscope cal is active.
    label.textContent = `Microscope cal: ${cur} px/mm`;
    row.classList.add("state-ok");
    return;
  }
  const rel = Math.abs(snap - current) / Math.max(snap, current);
  if (rel > 0.005) {
    row.classList.add("state-amber");
    label.textContent =
      `Microscope cal: ${cur} px/mm (changed; saved ${snap.toFixed(3)})`;
  } else {
    row.classList.add("state-ok");
    label.textContent = `Microscope cal: ${cur} px/mm (matches)`;
  }
}

// Phase 3B Wave 2: show the saved screen shape (if any) under the Display
// device selector, with a button to jump straight to the wizard's screen
// shape step.
async function refreshScreenShapeIndicator() {
  const row = $("defl-screen-shape-row");
  const label = $("defl-screen-shape-label");
  if (!row || !label) return;
  try {
    const r = await apiFetch("/deflectometry/screen-shape");
    if (!r.ok) { row.hidden = true; return; }
    const shape = await r.json();  // null if unset
    if (!shape) {
      label.textContent = "Screen shape: Rectangular2D (default)";
      row.hidden = false;
      return;
    }
    if (shape.kind === "distorted_2d") {
      const rms = Number(shape.residual_rms_mm);
      const ctrl = Array.isArray(shape.control_uv) ? shape.control_uv.length : 0;
      const rmsStr = Number.isFinite(rms) ? ` (RMS ${rms.toFixed(3)} mm, ${ctrl} ctrl pts)` : "";
      label.textContent = `Screen shape: Distorted2D${rmsStr}`;
    } else {
      label.textContent = "Screen shape: Rectangular2D";
    }
    row.hidden = false;
  } catch { row.hidden = true; }
}

function _relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const delta = Date.now() - then;
  if (delta < 60_000) return "just now";
  const m = Math.round(delta / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

function toggleCalBadgeMenu() {
  const existing = document.getElementById("defl-cal-active-menu");
  if (existing) { existing.remove(); return; }
  const badge = $("defl-cal-active-badge");
  if (!badge) return;
  const menu = document.createElement("div");
  menu.id = "defl-cal-active-menu";
  menu.className = "defl-cal-active-menu";
  menu.innerHTML = `
    <button data-action="recal">Re-calibrate\u2026</button>
    <button data-action="swap">Swap calibration\u2026</button>
    <button data-action="details">View details</button>
  `;
  menu.addEventListener("click", (ev) => {
    const action = ev.target?.dataset?.action;
    menu.remove();
    if (action === "recal") openWizard();
    else if (action === "swap") openCalPicker();
    else if (action === "details") showCalDetails();
  });
  badge.appendChild(menu);
}

async function showCalDetails() {
  const s = df.activeCalSession;
  if (!s) return;
  try {
    const r = await apiFetch(`/deflectometry/calibrations/${encodeURIComponent(s.id)}`);
    if (!r.ok) { alert("Failed to load calibration details"); return; }
    const full = await r.json();
    const sc = full.sphere_cal || {};
    const dr = full.display_response || {};
    const cc = full.corner_check || {};
    const mc = full.microscope_calibration || null;
    const microStr = mc?.pixels_per_mm
      ? `${mc.pixels_per_mm.toFixed(3)} px/mm`
      : "(not snapshotted)";
    const drift = _microscopeCalDrifted();
    const matchStr = drift === "drifted"
      ? " (changed since save)"
      : drift === "missing"
        ? " (current: unset)"
        : " (matches)";
    const warnLines = (df._autoRebindWarnings || []).map(w => "\u26a0 " + w);
    const lines = [
      `ID: ${full.id}`,
      `Captured: ${full.captured_at}`,
      `Rig: ${full.rig_fingerprint}`,
      `Notes: ${full.notes || "(none)"}`,
      "",
      `Display response: max deviation from gamma = ${dr.max_deviation_from_gamma ?? "?"}%`,
      `Corner check: ${cc.corners_found ?? "?"}/4 corners, ${cc.status ?? "?"}`,
      `Sphere cal: cal_factor = ${sc.cal_factor ?? "?"}, R = ${sc.fitted_radius_mm ?? "?"} mm`,
      `Reference flat: ${full.reference_flat ? "captured" : "none"}`,
      `Microscope cal: ${microStr}${matchStr}`,
      ...(warnLines.length ? ["", ...warnLines] : []),
    ];
    alert(lines.join("\n"));
  } catch (e) {
    alert("Error: " + (e?.message || e));
  }
}

// Load previous calibrations for the current rig and let the user pick one
async function openCalPicker() {
  const rigParams = _currentRigParams();
  let fp = null;
  try {
    const qs = new URLSearchParams();
    if (rigParams.display_model) qs.set("display_model", rigParams.display_model);
    if (rigParams.pixel_pitch_mm) qs.set("pixel_pitch_mm", rigParams.pixel_pitch_mm);
    if (rigParams.pixels_per_mm) qs.set("pixels_per_mm", rigParams.pixels_per_mm);
    if (rigParams.microscope_px_per_mm) qs.set("microscope_px_per_mm", rigParams.microscope_px_per_mm);
    const fpr = await apiFetch(`/deflectometry/rig-fingerprint?${qs}`);
    if (fpr.ok) {
      const fpd = await fpr.json();
      fp = fpd.rig_fingerprint;
    }
  } catch { /* ignore — will list all */ }

  const params = fp ? `?rig_fingerprint=${encodeURIComponent(fp)}` : "";
  let list = [];
  try {
    const r = await apiFetch(`/deflectometry/calibrations${params}`);
    if (r.ok) list = await r.json();
  } catch { /* ignore */ }

  // If filtering yielded nothing, offer the unfiltered list as a fallback.
  if ((!list || list.length === 0) && fp) {
    try {
      const r = await apiFetch("/deflectometry/calibrations");
      if (r.ok) list = await r.json();
    } catch { /* ignore */ }
  }

  if (!list || list.length === 0) {
    alert("No saved calibrations found. Run the calibration wizard to create one.");
    return;
  }
  _showCalPickerModal(list);
}

function _showCalPickerModal(list) {
  const host = $("defl-wizard-host");
  if (!host) return;
  host.innerHTML = `
    <div class="defl-wizard-overlay" id="defl-cal-picker-overlay">
      <div class="defl-wizard-modal" style="width:540px">
        <div class="defl-wizard-header">
          <div class="defl-wizard-title">Load previous calibration</div>
          <button class="defl-wizard-close" id="defl-cal-picker-close">\u00d7</button>
        </div>
        <div class="defl-wizard-body">
          <div class="defl-wizard-explain">Pick a saved calibration to bind as the active session.</div>
          <div class="defl-cal-picker-list" id="defl-cal-picker-list"></div>
        </div>
      </div>
    </div>
  `;
  const ul = $("defl-cal-picker-list");
  for (const item of list) {
    const complete = _completenessOk(item.completeness);
    const row = document.createElement("div");
    row.className = "defl-cal-picker-item";
    row.innerHTML = `
      <span class="defl-cal-picker-id">${(item.id || "").slice(0, 8)}</span>
      <span class="defl-cal-picker-date">${item.captured_at || "?"}</span>
      <span class="defl-cal-picker-notes">${item.notes ? item.notes : (complete ? "" : "incomplete")}</span>
    `;
    if (!complete) {
      row.style.opacity = "0.45";
      row.title = "Incomplete — cannot be bound";
    } else {
      row.addEventListener("click", async () => {
        try {
          const r = await apiFetch(`/deflectometry/calibrations/bind/${encodeURIComponent(item.id)}`, {
            method: "POST",
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            alert("Failed to bind: " + (err.detail || r.status));
            return;
          }
          host.innerHTML = "";
          refreshStatus();
        } catch (e) {
          alert("Error: " + (e?.message || e));
        }
      });
    }
    ul.appendChild(row);
  }
  $("defl-cal-picker-close")?.addEventListener("click", () => { host.innerHTML = ""; });
}

// ────── Phase 3A Track E: calibration wizard ──────

function openWizard(opts = {}) {
  df.wizardState = {
    display_response: null,
    corner_check: null,
    sphere_cal: null,
    reference_flat: null,
    // Phase 3B Wave 2: screen shape cal state
    ball_samples: [],
    last_detected_ball: null,   // {envelope_id, center_px, radius_px, preview_png_b64}
    screen_shape: null,         // populated after a successful solve
    fit_diagnostics: null,
    screen_shape_warnings: [],
    notes: "",
  };
  df.wizardStep = Number.isInteger(opts.startStep) ? opts.startStep : 1;
  renderWizard();
  // Always refresh the sample list from the backend on open — the live
  // _Session is the source of truth even if we don't expect samples yet.
  _refreshBallSamples().catch(() => {});
}

function closeWizard() {
  const host = $("defl-wizard-host");
  if (host) host.innerHTML = "";
  df.wizardState = null;
  df.wizardStep = 1;
}

const WIZARD_STEPS = 6;  // 4 data + 1 optional screen-shape + 1 review

function renderWizard() {
  const host = $("defl-wizard-host");
  if (!host) return;
  const step = df.wizardStep;
  const progress = Math.round(((step - 1) / (WIZARD_STEPS - 1)) * 100);
  const title = {
    1: "Display response calibration",
    2: "Corner check",
    3: "Sphere calibration",
    4: "Reference flat (optional)",
    5: "Screen shape (optional)",
    6: "Review & save",
  }[step] || "Calibration";

  host.innerHTML = `
    <div class="defl-wizard-overlay" id="defl-wizard-overlay">
      <div class="defl-wizard-modal">
        <div class="defl-wizard-header">
          <div class="defl-wizard-title">Calibration wizard</div>
          <div class="defl-wizard-step-label">Step ${step} of ${WIZARD_STEPS}</div>
          <button class="defl-wizard-close" id="defl-wizard-btn-close">\u00d7</button>
        </div>
        <div class="defl-wizard-progress"><div class="defl-wizard-progress-bar" style="width:${progress}%"></div></div>
        <div class="defl-wizard-body" id="defl-wizard-body">
          <div class="defl-wizard-step-title">${title}</div>
          <div id="defl-wizard-step-content"></div>
        </div>
        <div class="defl-wizard-footer">
          <button id="defl-wizard-back" ${step === 1 ? "disabled" : ""}>Back</button>
          <div class="defl-wizard-spacer"></div>
          <button id="defl-wizard-skip" hidden>Skip</button>
          <button id="defl-wizard-next" class="primary" disabled>Next</button>
        </div>
      </div>
    </div>
  `;

  $("defl-wizard-btn-close")?.addEventListener("click", () => closeWizard());
  $("defl-wizard-back")?.addEventListener("click", () => {
    if (df.wizardStep > 1) { df.wizardStep -= 1; renderWizard(); }
  });

  renderWizardStep(step);
}

function renderWizardStep(step) {
  const content = $("defl-wizard-step-content");
  if (!content) return;
  if (step === 1) return renderWizardStep1(content);
  if (step === 2) return renderWizardStep2(content);
  if (step === 3) return renderWizardStep3(content);
  if (step === 4) return renderWizardStep4(content);
  if (step === 5) return renderWizardStep5(content);
  if (step === 6) return renderWizardStep6(content);
}

function _wizardNext(label, handler, opts = {}) {
  const btn = $("defl-wizard-next");
  if (!btn) return;
  btn.disabled = !!opts.disabled;
  btn.textContent = label || "Next";
  btn.onclick = handler;
}

function _wizardSkip(label, handler) {
  const btn = $("defl-wizard-skip");
  if (!btn) return;
  if (!label) { btn.hidden = true; btn.onclick = null; return; }
  btn.hidden = false;
  btn.textContent = label;
  btn.onclick = handler;
}

// ── Step 1: Display response calibration ──
function renderWizardStep1(container) {
  const prev = df.wizardState.display_response;
  container.innerHTML = `
    <div class="defl-wizard-explain">
      The iPad\u2019s pixel-to-light response is not perfectly gamma 2.2. This step
      measures the response across 12 grayscale steps and builds a
      linearization LUT that the iPad applies during fringe display.
    </div>
    <div class="defl-wizard-controls">
      <button class="defl-wizard-big-btn" id="defl-w1-start">${prev ? "Re-run" : "Start"}</button>
    </div>
    <div class="defl-wizard-result" id="defl-w1-result" style="display:none"></div>
  `;
  if (prev) _renderStep1Result(prev);
  _wizardNext("Next", () => { df.wizardStep = 2; renderWizard(); }, { disabled: !prev });
  _wizardSkip(null);

  $("defl-w1-start").addEventListener("click", async () => {
    const btn = $("defl-w1-start");
    const resEl = $("defl-w1-result");
    btn.disabled = true;
    btn.textContent = "Calibrating\u2026 (12 steps, ~15s)";
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result";
    resEl.textContent = "Sweeping grayscale steps\u2026";
    try {
      const r = await apiFetch("/deflectometry/calibrate-display", { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        resEl.className = "defl-wizard-result err";
        resEl.textContent = "Failed: " + (err.detail || r.status);
        btn.disabled = false;
        btn.textContent = prev ? "Re-run" : "Start";
        return;
      }
      const data = await r.json();
      df.wizardState.display_response = data;
      _renderStep1Result(data);
      _wizardNext("Next", () => { df.wizardStep = 2; renderWizard(); }, { disabled: false });
      btn.disabled = false;
      btn.textContent = "Re-run";
    } catch (e) {
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Error: " + (e?.message || e);
      btn.disabled = false;
      btn.textContent = prev ? "Re-run" : "Start";
    }
  });
}

function _renderStep1Result(data) {
  const el = $("defl-w1-result");
  if (!el) return;
  el.style.display = "block";
  el.className = "defl-wizard-result ok";
  el.textContent =
    `\u2713 Display LUT built (${data.n_steps || 12} steps)\n` +
    `Max deviation from gamma 2.2: ${data.max_deviation_from_gamma}%`;
}

// ── Step 2: Corner check ──
function renderWizardStep2(container) {
  const prev = df.wizardState.corner_check;
  container.innerHTML = `
    <div class="defl-wizard-explain">
      Four corner markers will be projected. We detect them in the camera and
      check that the display is visible, square, and covering enough of the field.
    </div>
    <div class="defl-wizard-controls">
      <button class="defl-wizard-big-btn" id="defl-w2-start">${prev ? "Re-run" : "Start"}</button>
    </div>
    <div class="defl-wizard-result" id="defl-w2-result" style="display:none"></div>
  `;
  if (prev) _renderStep2Result(prev);
  _wizardNext("Next", () => { df.wizardStep = 3; renderWizard(); }, { disabled: !prev });
  _wizardSkip(null);

  $("defl-w2-start").addEventListener("click", async () => {
    const btn = $("defl-w2-start");
    const resEl = $("defl-w2-result");
    btn.disabled = true;
    btn.textContent = "Checking\u2026";
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result";
    resEl.textContent = "Projecting corner markers\u2026";
    try {
      const r = await apiFetch("/deflectometry/check-display", { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        resEl.className = "defl-wizard-result err";
        resEl.textContent = "Failed: " + (err.detail || r.status);
        btn.disabled = false;
        btn.textContent = prev ? "Re-run" : "Start";
        return;
      }
      const data = await r.json();
      df.wizardState.corner_check = data;
      _renderStep2Result(data);
      _wizardNext("Next", () => { df.wizardStep = 3; renderWizard(); }, { disabled: false });
      btn.disabled = false;
      btn.textContent = "Re-run";
    } catch (e) {
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Error: " + (e?.message || e);
      btn.disabled = false;
      btn.textContent = prev ? "Re-run" : "Start";
    }
  });
}

function _renderStep2Result(data) {
  const el = $("defl-w2-result");
  if (!el) return;
  el.style.display = "block";
  const statusClass = data.status === "good" ? "ok" : (data.status === "poor" ? "err" : "warn");
  el.className = "defl-wizard-result " + statusClass;
  const lines = [];
  const icon = data.status === "good" ? "\u2713" : (data.status === "poor" ? "\u2717" : "\u26a0");
  lines.push(`${icon} Status: ${data.status || "unknown"}`);
  lines.push(`Corners found: ${data.corners_found ?? "?"}/4`);
  if (Number.isFinite(data.rotation_deg)) lines.push(`Rotation: ${data.rotation_deg.toFixed(2)}\u00b0`);
  if (Number.isFinite(data.coverage_fraction)) lines.push(`Coverage: ${(data.coverage_fraction * 100).toFixed(0)}%`);
  if (Array.isArray(data.warnings) && data.warnings.length) {
    lines.push("");
    for (const w of data.warnings) lines.push("\u2022 " + w);
  }
  el.textContent = lines.join("\n");
}

// ── Step 3: Sphere calibration ──
function renderWizardStep3(container) {
  const prev = df.wizardState.sphere_cal;
  const curDiam = $("defl-sphere-diam")?.value || "25.0";
  const curStyle = df.captureStyle === "fast" ? "fast" : "multi_freq";
  container.innerHTML = `
    <div class="defl-wizard-explain">
      Place a sphere of known diameter in the mask area. We capture a measurement,
      fit a paraboloid, and derive the phase-radian \u2192 mm scale factor.
      Multi-frequency capture is more reliable for this step.
    </div>
    <div class="defl-wizard-controls">
      <label>Sphere diameter (mm)
        <input type="number" id="defl-w3-diam" min="0.1" max="500" step="0.1" value="${curDiam}" />
      </label>
      <label>Capture style
        <select id="defl-w3-style">
          <option value="multi_freq" ${curStyle === "multi_freq" ? "selected" : ""}>Multi-frequency (~24s, recommended)</option>
          <option value="fast" ${curStyle === "fast" ? "selected" : ""}>Fast (~8s)</option>
        </select>
      </label>
      <button class="defl-wizard-big-btn" id="defl-w3-start">${prev ? "Re-run" : "Capture sphere"}</button>
      <div style="font-size:11px;opacity:0.55" id="defl-w3-progress"></div>
    </div>
    <div class="defl-wizard-result" id="defl-w3-result" style="display:none"></div>
  `;
  if (prev) _renderStep3Result(prev);
  _wizardNext("Next", () => { df.wizardStep = 4; renderWizard(); }, { disabled: !prev });
  _wizardSkip(null);

  $("defl-w3-start").addEventListener("click", () => _runSphereCal());
}

async function _runSphereCal() {
  const btn = $("defl-w3-start");
  const progEl = $("defl-w3-progress");
  const resEl = $("defl-w3-result");
  const diamEl = $("defl-w3-diam");
  const styleEl = $("defl-w3-style");

  const diam = parseFloat(diamEl?.value);
  if (!Number.isFinite(diam) || diam <= 0) {
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result err";
    resEl.textContent = "Enter a valid sphere diameter.";
    return;
  }
  const style = styleEl?.value === "fast" ? "fast" : "multi_freq";
  // pixels/mm — required for cal-sphere. Pull from the main microscope cal.
  const ppm = state.calibration?.pixelsPerMm;
  if (!ppm || ppm <= 0) {
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result err";
    resEl.textContent = "Camera pixels/mm calibration is required. Calibrate the microscope first.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Running\u2026";
  resEl.style.display = "none";
  const setProg = (t) => { if (progEl) progEl.textContent = t; };
  try {
    // 1) Capture
    setProg("1/3 Capturing fringes\u2026");
    const captureR = await apiFetch("/deflectometry/capture-sequence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freq: getFreq(),
        gamma: getGamma(),
        averages: getAverages(),
        capture_style: style,
      }),
    });
    if (!captureR.ok) {
      const msg = await captureR.text();
      resEl.style.display = "block";
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Capture failed: " + msg;
      btn.disabled = false; btn.textContent = "Capture sphere";
      setProg("");
      return;
    }

    // 2) Compute
    setProg("2/3 Computing phases\u2026");
    const payload = { mask_threshold: getMaskThreshold(), smooth_sigma: getSmoothSigma() };
    if (df.maskPolygons.length > 0) {
      payload.mask_polygons = df.maskPolygons.map(p => ({
        vertices: p.vertices.map(v => [v.x, v.y]),
        include: p.include,
      }));
    }
    const computeR = await apiFetch("/deflectometry/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!computeR.ok) {
      const msg = await computeR.text();
      resEl.style.display = "block";
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Compute failed: " + msg;
      btn.disabled = false; btn.textContent = "Capture sphere";
      setProg("");
      return;
    }
    const computeData = await computeR.json();
    df.lastResult = computeData;

    // 3) Sphere cal
    setProg("3/3 Fitting sphere\u2026");
    const sphereR = await apiFetch("/deflectometry/calibrate-sphere", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sphere_diameter_mm: diam, px_per_mm: ppm }),
    });
    if (!sphereR.ok) {
      const msg = await sphereR.text();
      resEl.style.display = "block";
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Sphere fit failed: " + msg;
      btn.disabled = false; btn.textContent = "Capture sphere";
      setProg("");
      return;
    }
    const sphereData = await sphereR.json();
    // Persist the diameter alongside the result so Review can show it.
    sphereData.sphere_diameter_mm = diam;
    sphereData.capture_style = style;
    df.wizardState.sphere_cal = sphereData;

    setProg("");
    _renderStep3Result(sphereData);
    _wizardNext("Next", () => { df.wizardStep = 4; renderWizard(); }, { disabled: false });
    btn.disabled = false; btn.textContent = "Re-run";
  } catch (e) {
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result err";
    resEl.textContent = "Error: " + (e?.message || e);
    btn.disabled = false; btn.textContent = "Capture sphere";
    setProg("");
  }
}

function _renderStep3Result(data) {
  const el = $("defl-w3-result");
  if (!el) return;
  el.style.display = "block";
  const nominal = data.sphere_diameter_mm ? (data.sphere_diameter_mm / 2.0) : null;
  const fitted = Number(data.fitted_radius_mm);
  let cls = "ok";
  let warn = "";
  if (nominal && Number.isFinite(fitted)) {
    const dev = Math.abs(fitted - nominal) / nominal;
    if (dev > 0.10) {
      cls = "warn";
      warn = `\n\u26a0 Fitted radius differs from input by ${(dev * 100).toFixed(0)}% — check mask and re-run.`;
    }
  }
  el.className = "defl-wizard-result " + cls;
  const lines = [
    "\u2713 Sphere fit complete",
    `cal_factor    : ${Number(data.cal_factor).toExponential(4)}`,
    `cal_factor_\u00b5m : ${Number(data.cal_factor_um).toFixed(4)} \u00b5m/rad`,
    `fitted R      : ${fitted.toFixed(2)} mm${nominal ? ` (nominal ${nominal.toFixed(2)} mm)` : ""}`,
    `residual RMS  : ${Number(data.residual_rms_um).toFixed(3)} \u00b5m`,
    `outlier frac  : ${(Number(data.outlier_fraction) * 100).toFixed(1)}%`,
  ];
  el.textContent = lines.join("\n") + warn;
}

// ── Step 4: Reference flat (optional) ──
function renderWizardStep4(container) {
  const prev = df.wizardState.reference_flat;
  const curStyle = df.wizardState.sphere_cal?.capture_style || df.captureStyle;
  container.innerHTML = `
    <div class="defl-wizard-explain">
      Optionally capture a reference flat to subtract from subsequent
      measurements. This removes systematic errors at the cost of needing a
      well-characterized reference part. You can skip this step.
    </div>
    <div class="defl-wizard-controls">
      <button class="defl-wizard-big-btn" id="defl-w4-start">${prev ? "Re-run" : "Capture reference now"}</button>
    </div>
    <div class="defl-wizard-result" id="defl-w4-result" style="display:none"></div>
  `;
  if (prev) _renderStep4Result(prev);
  _wizardNext("Next", () => { df.wizardStep = 5; renderWizard(); }, { disabled: false });
  _wizardSkip("Skip", () => {
    df.wizardState.reference_flat = null;
    df.wizardStep = 5; renderWizard();
  });

  $("defl-w4-start").addEventListener("click", async () => {
    const btn = $("defl-w4-start");
    const resEl = $("defl-w4-result");
    btn.disabled = true;
    btn.textContent = "Capturing\u2026";
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result";
    resEl.textContent = "Capturing reference fringes\u2026";
    try {
      const r = await apiFetch("/deflectometry/capture-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          freq: getFreq(),
          gamma: getGamma(),
          averages: getAverages(),
          capture_style: curStyle,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        resEl.className = "defl-wizard-result err";
        resEl.textContent = "Failed: " + (err.detail || r.status);
        btn.disabled = false;
        btn.textContent = "Capture reference now";
        return;
      }
      const data = await r.json();
      // Store only small metadata — the big phase arrays stay on _Session.
      const meta = {
        captured_at: new Date().toISOString(),
        capture_style: data.capture_style,
        periods: data.periods,
      };
      df.wizardState.reference_flat = meta;
      _renderStep4Result(meta);
      btn.disabled = false;
      btn.textContent = "Re-run";
    } catch (e) {
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Error: " + (e?.message || e);
      btn.disabled = false;
      btn.textContent = "Capture reference now";
    }
  });
}

function _renderStep4Result(data) {
  const el = $("defl-w4-result");
  if (!el) return;
  el.style.display = "block";
  el.className = "defl-wizard-result ok";
  el.textContent =
    `\u2713 Reference flat captured\n` +
    `captured_at : ${data.captured_at}\n` +
    `style       : ${data.capture_style}\n` +
    (Array.isArray(data.periods) ? `periods     : ${data.periods.join(", ")}` : "");
}

// ── Step 5: Screen shape (ball calibration, optional) ──
// G20 ball inventory the user has on the bench. 20 mm is a practical default.
const BALL_DIAMETERS_MM = [10, 15, 20, 25, 30, 40];

function renderWizardStep5(container) {
  const w = df.wizardState;
  const samples = w.ball_samples || [];
  const curStyle = w.sphere_cal?.capture_style || df.captureStyle || "multi_freq";
  const nSamples = samples.length;
  const canSolve = nSamples >= 4;
  const canBow = nSamples >= 6;

  container.innerHTML = `
    <div class="defl-wizard-explain">
      Calibrate the iPad\u2019s 3D pose and optional panel-bow shape using G20 balls
      on the specimen fixture. Place a ball, capture, detect it, confirm \u2014 repeat
      with different sizes/positions. More balls = better calibration. 4+ balls
      recommended; 6+ enables panel-bow fit.
    </div>

    <div class="defl-wizard-controls defl-ball-capture-controls">
      <label>Ball diameter (mm)
        <select id="defl-w5-diam">
          ${BALL_DIAMETERS_MM.map(d => `<option value="${d}" ${d === 20 ? "selected" : ""}>${d}</option>`).join("")}
        </select>
      </label>
      <label>Capture style
        <select id="defl-w5-style">
          <option value="multi_freq" ${curStyle === "multi_freq" ? "selected" : ""}>Multi-frequency (~24s, recommended)</option>
          <option value="fast" ${curStyle === "fast" ? "selected" : ""}>Fast (~8s)</option>
        </select>
      </label>
      <label>World X (mm)
        <input type="number" id="defl-w5-posx" step="0.1" value="0" style="width:70px" />
      </label>
      <label>World Y (mm)
        <input type="number" id="defl-w5-posy" step="0.1" value="0" style="width:70px" />
      </label>
      <label>World Z (mm)
        <input type="number" id="defl-w5-posz" step="0.1" value="0" style="width:70px" />
      </label>
      <label>Label
        <input type="text" id="defl-w5-label" placeholder="e.g. center / NW / ..." style="width:130px" />
      </label>
      <button class="defl-wizard-big-btn" id="defl-w5-capture">Capture ball</button>
      <div style="font-size:11px;opacity:0.55" id="defl-w5-progress"></div>
    </div>

    <!-- Detection preview + confirm-or-override -->
    <div id="defl-w5-detect-panel" class="defl-ball-detect-panel" style="display:none">
      <div class="defl-ball-detect-preview">
        <img id="defl-w5-detect-preview" alt="detected ball preview" />
      </div>
      <div class="defl-ball-detect-fields">
        <div style="font-weight:600;font-size:12px;margin-bottom:4px">Detected ball</div>
        <label>Center X (px)
          <input type="number" id="defl-w5-detect-cx" step="0.5" />
        </label>
        <label>Center Y (px)
          <input type="number" id="defl-w5-detect-cy" step="0.5" />
        </label>
        <label>Radius (px)
          <input type="number" id="defl-w5-detect-r" step="0.5" min="1" />
        </label>
        <label>Score
          <input type="text" id="defl-w5-detect-score" readonly style="opacity:0.6" />
        </label>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="defl-wizard-big-btn" id="defl-w5-add-sample" style="flex:1">Add to calibration</button>
          <button class="detect-btn" id="defl-w5-redetect" title="Re-run auto-detection with current values as hints">Re-detect</button>
          <button class="detect-btn" id="defl-w5-discard" title="Discard this capture">Discard</button>
        </div>
      </div>
    </div>

    <div class="defl-wizard-result" id="defl-w5-result" style="display:none"></div>

    <div id="defl-w5-samples-block">
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:10px">
        <div style="font-size:12px;font-weight:600">Ball samples</div>
        <div style="font-size:11px;opacity:0.6" id="defl-w5-samples-count">${nSamples} collected \u2014 ${canBow ? "panel-bow fit enabled" : (canSolve ? "pose-only fit" : "need " + (4 - nSamples) + " more for minimum solve")}</div>
      </div>
      <div class="defl-ball-sample-list" id="defl-w5-sample-list"></div>
    </div>

    <div style="margin-top:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <label style="font-size:11px">Estimated screen distance (mm)
        <input type="number" id="defl-w5-dist" min="1" max="5000" step="5" value="250" />
      </label>
      <label style="font-size:11px">Screen orientation
        <select id="defl-w5-orient">
          <option value="facing_down" selected>iPad above, screen facing down (180\u00b0 X)</option>
          <option value="facing_up">iPad above, screen facing up (identity)</option>
        </select>
      </label>
      <button class="defl-wizard-big-btn" id="defl-w5-solve" ${canSolve ? "" : "disabled"} style="margin-left:auto">
        Solve screen shape from ${nSamples} samples
      </button>
    </div>

    <div id="defl-w5-diagnostics" class="defl-fit-diagnostics" style="display:none"></div>
    <div id="defl-w5-heatmap-host" class="defl-screen-shape-heatmap" style="display:none"></div>
  `;

  _renderBallSampleList();

  if (w.screen_shape && w.fit_diagnostics) {
    _renderFitDiagnostics(w.fit_diagnostics, w.screen_shape_warnings || []);
    _renderPanelBowHeatmap(w.screen_shape);
  } else {
    // If we have a saved shape on disk (from a previous session), preview it
    // so the user can see what they had before.
    apiFetch("/deflectometry/screen-shape").then(r => r.ok ? r.json() : null)
      .then(shape => {
        if (!shape || df.wizardStep !== 5) return;
        if (df.wizardState.screen_shape) return;  // user already solved
        _renderPanelBowHeatmap(shape);
      }).catch(() => {});
  }

  // Always allow navigation: this step is optional.
  _wizardNext("Next", () => { df.wizardStep = 6; renderWizard(); }, { disabled: false });
  _wizardSkip("Skip", () => {
    df.wizardState.screen_shape = null;
    df.wizardState.fit_diagnostics = null;
    df.wizardStep = 6;
    renderWizard();
  });

  $("defl-w5-capture")?.addEventListener("click", _captureBallForCal);
  $("defl-w5-redetect")?.addEventListener("click", _redetectBall);
  $("defl-w5-discard")?.addEventListener("click", () => {
    df.wizardState.last_detected_ball = null;
    const p = $("defl-w5-detect-panel");
    if (p) p.style.display = "none";
  });
  $("defl-w5-add-sample")?.addEventListener("click", _addBallSample);
  $("defl-w5-solve")?.addEventListener("click", _solveScreenShape);

  if (w.last_detected_ball) _showBallDetectPanel(w.last_detected_ball);
}

async function _refreshBallSamples() {
  try {
    const r = await apiFetch("/deflectometry/ball-cal-samples");
    if (!r.ok) return;
    const d = await r.json();
    if (df.wizardState) df.wizardState.ball_samples = d.samples || [];
    _renderBallSampleList();
  } catch { /* ignore */ }
}

function _renderBallSampleList() {
  const host = $("defl-w5-sample-list");
  if (!host) return;
  const samples = df.wizardState?.ball_samples || [];
  if (samples.length === 0) {
    host.innerHTML = `<div class="defl-ball-sample-empty">No samples yet. Capture a ball above.</div>`;
  } else {
    host.innerHTML = samples.map((s, i) => {
      const pos = s.ball_position_world_mm || [0, 0, 0];
      const label = s.label ? `<span class="defl-ball-sample-label">${_escapeHtml(s.label)}</span>` : "";
      return `
        <div class="defl-ball-sample-tile" data-index="${i}">
          <div class="defl-ball-sample-meta">
            <div><strong>#${i + 1}</strong> \u2014 \u2205 ${s.ball_diameter_mm.toFixed(1)} mm</div>
            <div style="font-size:10px;opacity:0.7">
              center (${s.ball_center_px[0].toFixed(0)}, ${s.ball_center_px[1].toFixed(0)}) px \u2022
              r ${s.ball_radius_px.toFixed(1)} px
            </div>
            <div style="font-size:10px;opacity:0.55">
              world (${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}, ${pos[2].toFixed(1)}) mm ${label}
            </div>
          </div>
          <button class="defl-ball-sample-remove" data-index="${i}" title="Remove this sample">\u00d7</button>
        </div>
      `;
    }).join("");
    host.querySelectorAll(".defl-ball-sample-remove").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        const idx = parseInt(ev.currentTarget.dataset.index, 10);
        if (!Number.isInteger(idx)) return;
        try {
          const r = await apiFetch(`/deflectometry/ball-cal-samples/${idx}`, { method: "DELETE" });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            alert("Failed to remove: " + (err.detail || r.status));
            return;
          }
        } catch (e) {
          alert("Error: " + (e?.message || e));
          return;
        }
        await _refreshBallSamples();
        if (df.wizardStep === 5) renderWizardStep5($("defl-wizard-step-content"));
      });
    });
  }
  const counter = $("defl-w5-samples-count");
  if (counter) {
    const n = samples.length;
    const canSolve = n >= 4;
    const canBow = n >= 6;
    counter.textContent = `${n} collected \u2014 ${canBow ? "panel-bow fit enabled" : (canSolve ? "pose-only fit" : "need " + Math.max(0, 4 - n) + " more for minimum solve")}`;
  }
  const solveBtn = $("defl-w5-solve");
  if (solveBtn) {
    const n = samples.length;
    solveBtn.disabled = n < 4;
    solveBtn.textContent = `Solve screen shape from ${n} samples`;
  }
}

function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function _captureBallForCal() {
  const btn = $("defl-w5-capture");
  const progEl = $("defl-w5-progress");
  const resEl = $("defl-w5-result");
  const setProg = (t) => { if (progEl) progEl.textContent = t; };
  const setErr = (msg) => {
    if (!resEl) return;
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result err";
    resEl.textContent = msg;
  };

  const diamEl = $("defl-w5-diam");
  const styleEl = $("defl-w5-style");
  const style = styleEl?.value === "fast" ? "fast" : "multi_freq";

  btn.disabled = true;
  btn.textContent = "Capturing\u2026";
  resEl.style.display = "none";
  const detectPanel = $("defl-w5-detect-panel");
  if (detectPanel) detectPanel.style.display = "none";

  try {
    setProg("1/3 Capturing fringes\u2026");
    const captureR = await apiFetch("/deflectometry/capture-sequence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freq: getFreq(), gamma: getGamma(), averages: getAverages(),
        capture_style: style,
      }),
    });
    if (!captureR.ok) { setErr("Capture failed: " + await captureR.text()); return; }

    setProg("2/3 Computing phases\u2026");
    const payload = { mask_threshold: getMaskThreshold(), smooth_sigma: getSmoothSigma() };
    if (df.maskPolygons && df.maskPolygons.length > 0) {
      payload.mask_polygons = df.maskPolygons.map(p => ({
        vertices: p.vertices.map(v => [v.x, v.y]),
        include: p.include,
      }));
    }
    const computeR = await apiFetch("/deflectometry/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!computeR.ok) { setErr("Compute failed: " + await computeR.text()); return; }
    const computeData = await computeR.json();
    const envelopeId = computeData.id;
    if (!envelopeId) { setErr("Compute returned no envelope id"); return; }

    setProg("3/3 Detecting ball\u2026");
    const detectR = await apiFetch("/deflectometry/detect-ball", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope_id: envelopeId }),
    });
    if (!detectR.ok) {
      const err = await detectR.json().catch(() => ({}));
      setErr("Ball detection failed: " + (err.detail || detectR.status)
        + "\nCheck the ball is visible and in focus, then retry.");
      return;
    }
    const detectData = await detectR.json();
    const info = {
      envelope_id: envelopeId,
      center_px: detectData.center_px,
      radius_px: detectData.radius_px,
      score: detectData.score,
      preview_png_b64: detectData.preview_png_b64,
      // Stash at capture-time so the sample is not affected by later UI edits.
      ball_diameter_mm: parseFloat(diamEl?.value || "20"),
      world_pos: [
        parseFloat($("defl-w5-posx")?.value || "0"),
        parseFloat($("defl-w5-posy")?.value || "0"),
        parseFloat($("defl-w5-posz")?.value || "0"),
      ],
      label: $("defl-w5-label")?.value || "",
    };
    df.wizardState.last_detected_ball = info;
    setProg("");
    _showBallDetectPanel(info);
  } catch (e) {
    setErr("Error: " + (e?.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = "Capture ball";
    setProg("");
  }
}

function _showBallDetectPanel(info) {
  const panel = $("defl-w5-detect-panel");
  if (!panel) return;
  panel.style.display = "";
  const img = $("defl-w5-detect-preview");
  if (img) img.src = "data:image/png;base64," + info.preview_png_b64;
  const cxEl = $("defl-w5-detect-cx");
  const cyEl = $("defl-w5-detect-cy");
  const rEl = $("defl-w5-detect-r");
  const sEl = $("defl-w5-detect-score");
  if (cxEl) cxEl.value = Number(info.center_px[0]).toFixed(1);
  if (cyEl) cyEl.value = Number(info.center_px[1]).toFixed(1);
  if (rEl) rEl.value = Number(info.radius_px).toFixed(1);
  if (sEl) sEl.value = Number.isFinite(info.score) ? info.score.toFixed(3) : "\u2014";
}

async function _redetectBall() {
  const info = df.wizardState?.last_detected_ball;
  if (!info) return;
  const cx = parseFloat($("defl-w5-detect-cx")?.value);
  const cy = parseFloat($("defl-w5-detect-cy")?.value);
  const r = parseFloat($("defl-w5-detect-r")?.value);
  const body = { envelope_id: info.envelope_id };
  if (Number.isFinite(cx) && Number.isFinite(cy)) body.center_hint_px = [cx, cy];
  if (Number.isFinite(r) && r > 0) body.radius_hint_px = r;
  const btn = $("defl-w5-redetect");
  if (btn) { btn.disabled = true; btn.textContent = "\u2026"; }
  try {
    const r2 = await apiFetch("/deflectometry/detect-ball", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r2.ok) {
      const err = await r2.json().catch(() => ({}));
      alert("Re-detect failed: " + (err.detail || r2.status));
      return;
    }
    const d = await r2.json();
    info.center_px = d.center_px;
    info.radius_px = d.radius_px;
    info.score = d.score;
    info.preview_png_b64 = d.preview_png_b64;
    _showBallDetectPanel(info);
  } catch (e) {
    alert("Error: " + (e?.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Re-detect"; }
  }
}

async function _addBallSample() {
  const info = df.wizardState?.last_detected_ball;
  if (!info) return;
  const cx = parseFloat($("defl-w5-detect-cx")?.value);
  const cy = parseFloat($("defl-w5-detect-cy")?.value);
  const rad = parseFloat($("defl-w5-detect-r")?.value);
  if (![cx, cy, rad].every(Number.isFinite) || rad <= 0) {
    alert("Invalid center/radius values.");
    return;
  }
  const btn = $("defl-w5-add-sample");
  if (btn) { btn.disabled = true; btn.textContent = "Adding\u2026"; }
  try {
    const r = await apiFetch("/deflectometry/add-ball-cal-sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        envelope_id: info.envelope_id,
        ball_diameter_mm: info.ball_diameter_mm,
        ball_center_px: [cx, cy],
        ball_radius_px: rad,
        ball_position_world_mm: info.world_pos,
        label: info.label || "",
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert("Failed to add sample: " + (err.detail || r.status));
      return;
    }
    const d = await r.json();
    df.wizardState.ball_samples = d.samples || [];
    df.wizardState.last_detected_ball = null;
    const panel = $("defl-w5-detect-panel");
    if (panel) panel.style.display = "none";
    if (df.wizardStep === 5) renderWizardStep5($("defl-wizard-step-content"));
  } catch (e) {
    alert("Error: " + (e?.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Add to calibration"; }
  }
}

function _buildScreenShapeRequest() {
  const params = _currentRigParams();
  const ppm = params.pixels_per_mm;
  if (!ppm || ppm <= 0) {
    return { error: "Camera pixels/mm calibration required. Calibrate the microscope first." };
  }
  // Preset options carry display width/height (mm) as data attrs. Custom mode
  // falls back to a sensible iPad Air default; the user can switch to a
  // preset to correct it.
  const deviceSel = $("defl-display-device");
  const selOpt = deviceSel?.selectedOptions?.[0];
  let widthMm = parseFloat(selOpt?.dataset?.widthMm);
  let heightMm = parseFloat(selOpt?.dataset?.heightMm);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
    widthMm = 197.12;
    heightMm = 147.84;
  }
  const distance = parseFloat($("defl-w5-dist")?.value);
  if (!Number.isFinite(distance) || distance <= 0) {
    return { error: "Enter a valid estimated screen distance (mm)." };
  }
  const orient = $("defl-w5-orient")?.value || "facing_down";
  // Pose.from_dict expects {rotation_matrix: 3x3, translation: [x,y,z]}.
  // 180° about X: [[1,0,0],[0,-1,0],[0,0,-1]]
  const flipX = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ];
  const identity = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const rotationMatrix = (orient === "facing_down") ? flipX : identity;

  return {
    camera_model: {
      mode: "telecentric",
      px_size_mm: 1.0 / ppm,
    },
    camera_pose: { rotation_matrix: identity, translation: [0.0, 0.0, 0.0] },
    screen_width_mm: widthMm,
    screen_height_mm: heightMm,
    estimated_screen_distance_mm: distance,
    estimated_screen_rotation: {
      rotation_matrix: rotationMatrix,
      translation: [0.0, 0.0, distance],
    },
  };
}

async function _solveScreenShape() {
  const btn = $("defl-w5-solve");
  const resEl = $("defl-w5-result");
  const diagHost = $("defl-w5-diagnostics");
  const heatHost = $("defl-w5-heatmap-host");
  const setErr = (msg) => {
    if (!resEl) return;
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result err";
    resEl.textContent = msg;
  };

  const req = _buildScreenShapeRequest();
  if (req.error) { setErr(req.error); return; }

  btn.disabled = true;
  btn.textContent = "Solving\u2026";
  resEl.style.display = "none";
  if (diagHost) diagHost.style.display = "none";
  if (heatHost) heatHost.style.display = "none";

  try {
    const r = await apiFetch("/deflectometry/calibrate-screen-shape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setErr("Solve failed: " + (err.detail || r.status));
      return;
    }
    const data = await r.json();
    df.wizardState.screen_shape = data.shape || null;
    df.wizardState.fit_diagnostics = data.fit_diagnostics || null;
    df.wizardState.screen_shape_warnings = data.warnings || [];
    _renderFitDiagnostics(data.fit_diagnostics, data.warnings || []);
    _renderPanelBowHeatmap(data.shape);
    refreshScreenShapeIndicator().catch(() => {});
  } catch (e) {
    setErr("Error: " + (e?.message || e));
  } finally {
    btn.disabled = false;
    const n = df.wizardState?.ball_samples?.length ?? 0;
    btn.textContent = `Solve screen shape from ${n} samples`;
  }
}

function _renderFitDiagnostics(diag, warnings) {
  const host = $("defl-w5-diagnostics");
  if (!host || !diag) return;
  host.style.display = "";
  const rows = [];
  const push = (label, value) => rows.push(
    `<div class="defl-fit-diag-row"><span>${label}</span><span>${value}</span></div>`
  );
  if (Number.isFinite(diag.pose_rms_mm)) push("Pose RMS", `${diag.pose_rms_mm.toFixed(4)} mm`);
  if (Number.isFinite(diag.residual_rms_mm)) push("Residual RMS", `${diag.residual_rms_mm.toFixed(4)} mm`);
  if (Number.isFinite(diag.control_points)) push("Control points", String(diag.control_points));
  if (Number.isFinite(diag.coverage_fraction)) push("Coverage", `${(diag.coverage_fraction * 100).toFixed(1)}%`);
  if (typeof diag.stage2_enabled === "boolean") push("Stage 2 (panel bow)", diag.stage2_enabled ? "\u2713 enabled" : "\u2013 skipped");
  if (Number.isFinite(diag.num_samples)) push("Samples used", String(diag.num_samples));

  const warnHtml = (warnings && warnings.length)
    ? `<div class="defl-fit-diag-warnings">${warnings.map(w => `<div>\u26a0 ${_escapeHtml(w)}</div>`).join("")}</div>`
    : "";
  host.innerHTML = `
    <div class="defl-fit-diag-title">Fit diagnostics</div>
    <div class="defl-fit-diag-grid">${rows.join("")}</div>
    ${warnHtml}
  `;
}

// 64×64 heatmap of z-deviation (panel bow) from a saved shape dict.
// For Rectangular2D: flat, nothing to show. For Distorted2D: inverse-distance
// interpolation of z-component from the control points — fast to compute
// client-side and good enough for a preview.
function _renderPanelBowHeatmap(shapeDict) {
  const host = $("defl-w5-heatmap-host");
  if (!host || !shapeDict) return;
  host.style.display = "";

  const N = 64;
  const wMm = shapeDict.width_mm || 1;
  const hMm = shapeDict.height_mm || 1;

  const zGrid = new Float64Array(N * N);
  let zMin = Infinity, zMax = -Infinity;
  let rms2 = 0, nValid = 0;

  if (shapeDict.kind === "distorted_2d"
      && Array.isArray(shapeDict.control_uv)
      && Array.isArray(shapeDict.control_xyz_mm)) {
    const ctrlUv = shapeDict.control_uv;
    const ctrlXyz = shapeDict.control_xyz_mm;
    for (let j = 0; j < N; j++) {
      const v = j / (N - 1);
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        let sumW = 0, sumZ = 0;
        for (let k = 0; k < ctrlUv.length; k++) {
          const du = ctrlUv[k][0] - u;
          const dv = ctrlUv[k][1] - v;
          const d2 = du * du + dv * dv + 1e-9;
          const wgt = 1.0 / d2;
          sumW += wgt;
          sumZ += wgt * (ctrlXyz[k][2] || 0);
        }
        const z = sumW > 0 ? (sumZ / sumW) : 0;
        zGrid[j * N + i] = z;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
        rms2 += z * z;
        nValid++;
      }
    }
  } else {
    zMin = 0; zMax = 0; rms2 = 0; nValid = N * N;
  }

  const rms = nValid > 0 ? Math.sqrt(rms2 / nValid) : 0;
  const absMax = Math.max(Math.abs(zMin), Math.abs(zMax), 1e-6);

  const colorFor = (t) => {
    if (!Number.isFinite(t)) return [200, 200, 200];
    t = Math.max(-1, Math.min(1, t));
    if (t >= 0) {
      const f = t;
      return [255, Math.round(255 * (1 - f)), Math.round(255 * (1 - f))];
    }
    const f = -t;
    return [Math.round(255 * (1 - f)), Math.round(255 * (1 - f)), 255];
  };

  const resRms = df.wizardState?.fit_diagnostics?.residual_rms_mm;
  const subtitle = (shapeDict.kind === "distorted_2d")
    ? `max bow ${zMax.toFixed(3)} mm, min ${zMin.toFixed(3)} mm, RMS ${rms.toFixed(3)} mm${Number.isFinite(resRms) ? `, residual ${Number(resRms).toFixed(3)} mm` : ""}`
    : `Flat panel (Rectangular2D) \u2014 no bow to visualize.`;

  host.innerHTML = `
    <div class="defl-heatmap-title">iPad flatness deviation (mm)</div>
    <div class="defl-heatmap-subtitle">${subtitle}</div>
    <div class="defl-heatmap-body">
      <canvas id="defl-w5-heatmap-canvas" width="${N}" height="${N}"
              style="width:320px;height:${Math.round(320 * (hMm / wMm))}px;image-rendering:pixelated;border:1px solid #2a2a2a"></canvas>
      <div class="defl-heatmap-cb" id="defl-w5-heatmap-cb"></div>
    </div>
  `;

  const canvas = $("defl-w5-heatmap-canvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(N, N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const z = zGrid[j * N + i];
        const t = z / absMax;
        const [r, g, b] = colorFor(t);
        const k = (j * N + i) * 4;
        img.data[k] = r;
        img.data[k + 1] = g;
        img.data[k + 2] = b;
        img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  const cb = $("defl-w5-heatmap-cb");
  if (cb) {
    cb.innerHTML = `
      <div class="defl-heatmap-cb-strip"></div>
      <div class="defl-heatmap-cb-labels">
        <span>+${absMax.toFixed(3)} mm</span>
        <span>0</span>
        <span>\u2212${absMax.toFixed(3)} mm</span>
      </div>
    `;
  }
}

// ── Step 6: Review & save ──
function renderWizardStep6(container) {
  const w = df.wizardState;
  const shapeDetail = (() => {
    if (!w.screen_shape) return "skipped";
    const kind = w.screen_shape.kind === "distorted_2d" ? "Distorted2D" : "Rectangular2D";
    const rms = w.fit_diagnostics?.residual_rms_mm;
    const n = w.ball_samples?.length ?? 0;
    const parts = [`${kind} (${n} ${n === 1 ? "ball" : "balls"})`];
    if (Number.isFinite(rms)) parts.push(`residual ${Number(rms).toFixed(3)} mm`);
    return parts.join(", ");
  })();
  const items = [
    {
      key: "display_response",
      title: "Display response",
      detail: w.display_response
        ? `max deviation ${w.display_response.max_deviation_from_gamma}% (${w.display_response.n_steps || 12} steps)`
        : "not captured",
    },
    {
      key: "corner_check",
      title: "Corner check",
      detail: w.corner_check
        ? `status: ${w.corner_check.status} — ${w.corner_check.corners_found ?? 0}/4 corners`
        : "not captured",
    },
    {
      key: "sphere_cal",
      title: "Sphere calibration",
      detail: w.sphere_cal
        ? `cal_factor ${Number(w.sphere_cal.cal_factor).toExponential(3)}, R ${Number(w.sphere_cal.fitted_radius_mm).toFixed(2)} mm`
        : "not captured",
    },
    {
      key: "reference_flat",
      title: "Reference flat (optional)",
      detail: w.reference_flat
        ? `captured ${w.reference_flat.captured_at}`
        : "skipped",
    },
    {
      key: "screen_shape",
      title: "Screen shape (optional)",
      detail: shapeDetail,
      optional: true,
    },
  ];
  const itemsHtml = items.map(it => {
    const has = !!w[it.key];
    const cls = has ? "ok" : (it.optional ? "skip" : "skip");
    const icon = has ? "\u2713" : (it.optional ? "\u2013" : "\u2717");
    return `
      <div class="defl-wizard-review-item ${cls}">
        <span class="defl-wizard-review-icon">${icon}</span>
        <div class="defl-wizard-review-body">
          <div class="defl-wizard-review-title">${it.title}</div>
          <div class="defl-wizard-review-detail">${it.detail}</div>
        </div>
      </div>
    `;
  }).join("");

  const requiredOk = !!(w.display_response && w.corner_check && w.sphere_cal);

  container.innerHTML = `
    <div class="defl-wizard-explain">
      Review the captured steps. The three required steps (display, corner,
      sphere) must be present; the reference flat is optional.
    </div>
    <div class="defl-wizard-review">${itemsHtml}</div>
    <label style="display:flex;flex-direction:column;gap:4px;margin-top:6px;font-size:12px">
      Notes (optional)
      <textarea id="defl-w5-notes" placeholder="Date, operator, sphere serial, \u2026">${w.notes || ""}</textarea>
    </label>
    <div class="defl-wizard-result" id="defl-w5-result" style="display:none"></div>
  `;

  _wizardSkip(null);
  _wizardNext("Save & activate", saveWizardSession, { disabled: !requiredOk });
  if (!requiredOk) {
    const btn = $("defl-wizard-next");
    if (btn) btn.title = "Complete steps 1\u20133 before saving.";
  }
}

async function saveWizardSession() {
  const w = df.wizardState;
  const resEl = $("defl-w5-result");
  const nextBtn = $("defl-wizard-next");
  const backBtn = $("defl-wizard-back");
  const notes = $("defl-w5-notes")?.value || "";
  w.notes = notes;

  if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = "Saving\u2026"; }
  if (backBtn) backBtn.disabled = true;
  if (resEl) {
    resEl.style.display = "block";
    resEl.className = "defl-wizard-result";
    resEl.textContent = "Building rig fingerprint\u2026";
  }

  try {
    // 1) rig fingerprint
    const params = _currentRigParams();
    const qs = new URLSearchParams();
    qs.set("display_model", params.display_model || "");
    qs.set("pixel_pitch_mm", String(params.pixel_pitch_mm || 0.0962));
    if (params.pixels_per_mm) qs.set("pixels_per_mm", String(params.pixels_per_mm));
    if (params.microscope_px_per_mm) qs.set("microscope_px_per_mm", String(params.microscope_px_per_mm));
    const fpr = await apiFetch(`/deflectometry/rig-fingerprint?${qs}`);
    if (!fpr.ok) {
      const err = await fpr.json().catch(() => ({}));
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Rig fingerprint failed: " + (err.detail || fpr.status);
      if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = "Save & activate"; }
      if (backBtn) backBtn.disabled = false;
      return;
    }
    const fpd = await fpr.json();

    // 2) save session — snapshot the microscope lateral cal so future
    // sessions can warn if it drifts. Source tag lets consumers tell
    // "snapshot was taken" apart from "user never calibrated".
    const microscope_calibration = params.microscope_px_per_mm
      ? {
          pixels_per_mm: params.microscope_px_per_mm,
          calibrated_at: null,
          source: "microscope_mode_cal",
        }
      : null;
    resEl.textContent = "Saving CalibrationSession\u2026";
    const saveR = await apiFetch("/deflectometry/calibrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rig_fingerprint: fpd.rig_fingerprint,
        display_response: w.display_response,
        corner_check: w.corner_check,
        sphere_cal: w.sphere_cal,
        reference_flat: w.reference_flat,
        screen_shape: w.screen_shape,
        microscope_calibration,
        notes: w.notes || "",
      }),
    });
    if (!saveR.ok) {
      const err = await saveR.json().catch(() => ({}));
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Save failed: " + (err.detail || saveR.status);
      if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = "Save & activate"; }
      if (backBtn) backBtn.disabled = false;
      return;
    }
    const saved = await saveR.json();

    // 3) bind
    resEl.textContent = "Binding as active session\u2026";
    const bindR = await apiFetch(`/deflectometry/calibrations/bind/${encodeURIComponent(saved.id)}`, {
      method: "POST",
    });
    if (!bindR.ok) {
      const err = await bindR.json().catch(() => ({}));
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Bind failed: " + (err.detail || bindR.status);
      if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = "Save & activate"; }
      if (backBtn) backBtn.disabled = false;
      return;
    }

    resEl.className = "defl-wizard-result ok";
    resEl.textContent = "\u2713 Calibration saved and active.";
    closeWizard();
    _showToast("Calibration saved and active");
    refreshStatus();
  } catch (e) {
    if (resEl) {
      resEl.className = "defl-wizard-result err";
      resEl.textContent = "Error: " + (e?.message || e);
    }
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = "Save & activate"; }
    if (backBtn) backBtn.disabled = false;
  }
}

function _showToast(msg, opts = {}) {
  let t = document.getElementById("defl-toast");
  if (t) t.remove();
  t = document.createElement("div");
  t.id = "defl-toast";
  t.textContent = msg;
  const bg = opts.amber ? "#b45309" : "#1e40af";
  t.style.cssText = `
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:${bg};color:#fff;padding:8px 16px;border-radius:4px;
    font-size:13px;z-index:10000;box-shadow:0 4px 14px rgba(0,0,0,0.4);
    max-width:80vw;
  `;
  document.body.appendChild(t);
  setTimeout(() => { t?.remove(); }, opts.amber ? 5000 : 2600);
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
  // Phase 3B Wave 2: surface any saved screen shape in the settings panel.
  refreshScreenShapeIndicator().catch(() => {});

  const observer = new MutationObserver(() => {
    const root = $("mode-deflectometry");
    if (!root) return;
    if (root.hidden) {
      stopPolling();
    } else {
      startPolling();
      // Fire-and-forget auto-rebind on mode entry. If the server just
      // restarted and the active cal session id was lost, this restores
      // the latest matching session (including LUT, cal_factor, and
      // ref_phase_x/y from the .npz sidecar) without the user having to
      // click "Load previous cal". Runs AFTER the mode switch so the
      // status poll from startPolling picks up the restored binding.
      tryAutoRebind().catch(() => {});
    }
  });
  const root = $("mode-deflectometry");
  if (root) observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}

async function tryAutoRebind() {
  // Skip if a session is already bound (user ran the wizard this session).
  if (df.activeCalSession) return;
  const params = _currentRigParams();
  // Build rig fingerprint first so /auto-rebind knows which rig to match.
  const qs = new URLSearchParams();
  qs.set("display_model", params.display_model || "");
  qs.set("pixel_pitch_mm", String(params.pixel_pitch_mm || 0.0962));
  if (params.pixels_per_mm) qs.set("pixels_per_mm", String(params.pixels_per_mm));
  if (params.microscope_px_per_mm) qs.set("microscope_px_per_mm", String(params.microscope_px_per_mm));
  let fp = null;
  try {
    const fpr = await apiFetch(`/deflectometry/rig-fingerprint?${qs}`);
    if (!fpr.ok) return;
    const fpd = await fpr.json();
    fp = fpd.rig_fingerprint;
  } catch { return; }
  if (!fp) return;
  let data;
  try {
    const r = await apiFetch("/deflectometry/auto-rebind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rig_fingerprint: fp,
        microscope_px_per_mm: params.microscope_px_per_mm || null,
        display_model: params.display_model || null,
        pixel_pitch_mm: params.pixel_pitch_mm || null,
      }),
    });
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }
  if (!data || !data.restored) return;
  // Toast + refresh. Drift warnings use amber styling.
  const hasWarn = Array.isArray(data.warnings) && data.warnings.length > 0;
  const capturedAt = data.session?.captured_at;
  const rel = capturedAt ? _relativeTime(capturedAt) : "";
  if (hasWarn) {
    _showToast("Calibration restored \u2014 " + data.warnings[0], { amber: true });
  } else {
    _showToast(`Calibration restored${rel ? " (" + rel + ")" : ""}`);
  }
  // Cache the warning so the cal-badge menu can surface it.
  df._autoRebindWarnings = data.warnings || [];
  refreshStatus();
}
