// fringe.js — Full-window fringe analysis workspace.
//
// Two-column layout:
//   Left:   camera preview, focus quality bar, freeze & analyze, settings,
//           Zernike subtraction checkboxes
//   Right:  summary bar (PV/RMS), tabs (Surface Map | 3D View | Zernike | Profiles)
//
// Lives inside #mode-fringe, managed by modes.js.

import { apiFetch } from './api.js';
import { wireMeasureEvents, drawPeakValleyMarkers } from './fringe-measure.js';
import { buildPanelHtml, wirePanelEvents, startPolling, stopPolling, getWavelength, getMaskThreshold, drawMaskOverlay } from './fringe-panel.js';

export const fr = {
  polling: null,
  built: false,
  threeLoaded: false,
  lastResult: null,
  lastMask: null,
  maskPolygons: [],        // [{vertices: [{x,y},...], include: bool}, ...]
  maskDrawing: false,      // currently drawing a polygon?
  maskCurrentVertices: [], // vertices being placed for current polygon
  maskIsHole: false,       // current polygon is a hole?
  measureMode: null,       // null | "cursor" | "point2point" | "lineProfile" | "area"
  measurePoints: [],       // array of {nx, ny} normalized coords for active measurement
  heightGrid: null,        // Float32Array from server
  maskGrid: null,          // Uint8Array from server
  gridRows: 0,
  gridCols: 0,
  avgCaptures: [],        // [{coefficients: Float64Array, rms_nm: number, accepted: bool, reason: string}]
  avgRejectThreshold: 3,  // reject if capture RMS > threshold × average RMS
  avgSurfaceHeight: 0,
  avgSurfaceWidth: 0,
  carrierOverride: null,   // {y, x} or null
};

export function $(id) { return document.getElementById(id); }

// ── Wavelength presets ──────────────────────────────────────────────────
// Defaults; overridden at init from /config/fringe if available.
// "custom" is a UI-only entry, always appended by rebuildWavelengthSelect().

let WAVELENGTHS = [
  { id: "sodium", label: "Sodium (589 nm)",   nm: 589.0 },
  { id: "hene",   label: "HeNe (632.8 nm)",   nm: 632.8 },
  { id: "green",  label: "Green LED (532 nm)", nm: 532.0 },
];

function rebuildWavelengthSelect() {
  const sel = $("fringe-wavelength");
  if (!sel) return;
  sel.innerHTML = "";
  for (const wl of WAVELENGTHS) {
    const opt = document.createElement("option");
    opt.value = wl.id;
    opt.textContent = wl.label;
    opt.dataset.nm = wl.nm;
    sel.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom...";
  sel.appendChild(custom);
}

async function loadWavelengthPresets() {
  try {
    const r = await apiFetch("/config/fringe");
    if (!r.ok) return;
    const cfg = await r.json();
    if (Array.isArray(cfg.fringe_wavelengths) && cfg.fringe_wavelengths.length > 0) {
      WAVELENGTHS = cfg.fringe_wavelengths;
      rebuildWavelengthSelect();
    }
    if (cfg.standards && Array.isArray(cfg.standards)) {
      const sel = $("fringe-standard");
      if (sel) {
        const groups = {};
        for (const s of cfg.standards) {
          const prefix = s.label.split(" ")[0];
          if (!groups[prefix]) groups[prefix] = [];
          groups[prefix].push(s);
        }
        for (const [name, items] of Object.entries(groups)) {
          const optgroup = document.createElement("optgroup");
          optgroup.label = name;
          for (const s of items) {
            const opt = document.createElement("option");
            opt.value = s.id;
            opt.textContent = s.label;
            opt.dataset.pvNm = s.pv_nm;
            optgroup.appendChild(opt);
          }
          sel.appendChild(optgroup);
        }
      }
    }
  } catch (e) { /* use defaults */ }
}

// ── Build workspace DOM ─────────────────────────────────────────────────

function buildWorkspace() {
  if (fr.built) return;
  fr.built = true;

  const root = $("mode-fringe");
  if (!root) return;

  root.innerHTML = `
    <div class="fringe-workspace">
      <!-- Left column: preview + controls -->
      <div class="fringe-preview-col">
        ${buildPanelHtml()}
      </div>

      <!-- Right column: results -->
      <div class="fringe-results-col">
        <div class="fringe-summary-bar" id="fringe-summary-bar" hidden title="PV = total range of surface error. RMS = average deviation. Lower = flatter.">
          <div class="fringe-stat">
            <span class="fringe-stat-label" title="Peak-to-Valley: worst-case surface error">PV</span>
            <span class="fringe-stat-value" id="fringe-pv-waves">--</span>
            <span class="fringe-stat-unit">\u03bb</span>
            <span class="fringe-stat-value fringe-stat-nm" id="fringe-pv-nm">--</span>
            <span class="fringe-stat-unit">nm</span>
          </div>
          <div class="fringe-stat">
            <span class="fringe-stat-label">RMS</span>
            <span class="fringe-stat-value" id="fringe-rms-waves">--</span>
            <span class="fringe-stat-unit">\u03bb</span>
            <span class="fringe-stat-value fringe-stat-nm" id="fringe-rms-nm">--</span>
            <span class="fringe-stat-unit">nm</span>
          </div>
          <div class="fringe-stat">
            <span class="fringe-stat-label" title="Strehl ratio: 1.0 = diffraction-limited. Computed as exp(-(2\u03c0\u00b7RMS)\u00b2)">Strehl</span>
            <span class="fringe-stat-value" id="fringe-strehl">--</span>
          </div>
          <div class="fringe-stat" style="margin-left:auto">
            <span class="fringe-stat-label" style="min-width:auto">\u03bb</span>
            <span id="fringe-summary-wl" style="font-size:12px;opacity:0.7">589 nm</span>
            <span style="margin-left:12px;font-size:11px;opacity:0.5" id="fringe-summary-sub">Tilt subtracted</span>
          </div>
        </div>

        <div class="fringe-carrier-row" id="fringe-carrier-row" hidden style="display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:11px;opacity:0.8;border-bottom:1px solid var(--border);cursor:pointer" title="Click to open Diagnostics tab">
          <span id="fringe-carrier-dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0"></span>
          <span>Carrier: <span id="fringe-carrier-period">--</span>px period @ <span id="fringe-carrier-angle">--</span>&deg;</span>
          <span style="margin-left:auto;opacity:0.6">Confidence: <span id="fringe-carrier-confidence">--</span></span>
        </div>

        <div class="fringe-tab-bar" id="fringe-tab-bar">
          <button class="fringe-tab active" data-tab="surface">Surface Map</button>
          <button class="fringe-tab" data-tab="3d">3D View</button>
          <button class="fringe-tab" data-tab="zernike">Zernike</button>
          <button class="fringe-tab" data-tab="profiles">Profiles</button>
          <button class="fringe-tab" data-tab="psf">PSF / MTF</button>
          <button class="fringe-tab" data-tab="diagnostics">Diagnostics</button>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-surface">
          <div class="fringe-empty-state" id="fringe-empty">
            <div style="max-width:420px;text-align:left;line-height:1.6">
              <div style="font-size:14px;font-weight:600;margin-bottom:8px;text-align:center">Freeze a frame or drop an interferogram to analyze</div>
              <div style="font-size:12px;opacity:0.7;margin-top:12px">
                <div style="font-weight:600;margin-bottom:4px">Tips for best results:</div>
                <ul style="margin:0;padding-left:18px">
                  <li>Clean both surfaces thoroughly — dust particles create false fringes</li>
                  <li>Place the flat gently, don't press — pressure causes stress fringes</li>
                  <li>Slide slightly to "wring" the flat — this minimizes the air gap</li>
                  <li>Aim for 3–5 fringes across the surface for best accuracy</li>
                  <li>Closed circular fringes indicate trapped dust or burrs</li>
                  <li>Use monochromatic light (sodium lamp or HeNe laser)</li>
                </ul>
              </div>
            </div>
          </div>
          <div id="fringe-loading-overlay" hidden style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);z-index:10">
            <div style="text-align:center">
              <div class="fringe-spinner"></div>
              <div style="margin-top:8px;font-size:13px;opacity:0.8" id="fringe-loading-text">Analyzing...</div>
            </div>
          </div>
          <div id="fringe-surface-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <div class="fringe-measure-toolbar" id="fringe-measure-toolbar">
              <button class="fringe-measure-btn active" data-mode="" title="Pan / zoom (no measurement)">↔ Pan</button>
              <button class="fringe-measure-btn" data-mode="cursor" title="Hover to see height at cursor">⊹ Cursor</button>
              <button class="fringe-measure-btn" data-mode="point2point" title="Click two points to measure height difference">⬍ Δh</button>
              <button class="fringe-measure-btn" data-mode="lineProfile" title="Click two points to draw a line profile">╲ Profile</button>
              <button class="fringe-measure-btn" data-mode="area" title="Click two corners to get area statistics">▭ Area</button>
              <span class="fringe-measure-readout" id="fringe-measure-readout"></span>
            </div>
            <div class="fringe-surface-container" id="fringe-surface-viewport" style="overflow:hidden;cursor:grab">
              <div id="fringe-surface-wrapper" style="position:relative;display:inline-block;transform-origin:0 0">
                <img id="fringe-surface-img" draggable="false" style="display:block" />
                <svg id="fringe-measure-svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible"></svg>
              </div>
            </div>
            <canvas id="fringe-line-profile-chart" width="800" height="150" hidden></canvas>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-3d" hidden>
          <div class="fringe-empty-state" id="fringe-3d-empty">Analyze an image first.</div>
          <div id="fringe-3d-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <p style="font-size:11px;opacity:0.6;margin:4px 12px">Drag to rotate, scroll to zoom. Z exaggeration amplifies height differences for visibility.</p>
            <div class="fringe-3d-host" id="fringe-3d-host">
              <div class="fringe-3d-controls" id="fringe-3d-controls">
                <label style="font-size:12px">Z exaggeration:
                  <input type="range" id="fringe-3d-z-scale" min="1" max="200" step="1" value="10" style="width:120px" />
                  <span id="fringe-3d-z-val">10x</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-zernike" hidden>
          <div class="fringe-empty-state" id="fringe-zernike-empty">Analyze an image first.</div>
          <div id="fringe-zernike-content" hidden>
            <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Each bar = one type of surface error (tilt, curvature, astigmatism, etc). Taller bars = more of that error. Gray bars have been subtracted from the surface map.</p>
            <img id="fringe-zernike-chart" style="width:100%;max-width:900px" />
            <div id="fringe-zernike-table-container" style="margin-top:12px;max-height:400px;overflow-y:auto"></div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-profiles" hidden>
          <div class="fringe-empty-state" id="fringe-profiles-empty">Analyze an image first.</div>
          <div id="fringe-profiles-content" hidden>
            <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Cross-sections through the center of the surface. Shows height (nm) across the part horizontally and vertically.</p>
            <canvas id="fringe-profile-x-canvas" width="800" height="200"></canvas>
            <canvas id="fringe-profile-y-canvas" width="800" height="200"></canvas>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-psf" hidden>
          <div class="fringe-empty-state" id="fringe-psf-empty">Analyze an image first.</div>
          <div id="fringe-psf-content" hidden style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
            <div>
              <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Point Spread Function (log scale)</p>
              <img id="fringe-psf-img" style="width:256px;height:256px;image-rendering:pixelated" />
            </div>
            <div style="flex:1;min-width:300px">
              <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Modulation Transfer Function</p>
              <canvas id="fringe-mtf-canvas" width="400" height="250" style="width:100%;max-width:500px"></canvas>
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-diagnostics" hidden>
          <div class="fringe-empty-state" id="fringe-diag-empty">Analyze an image first.</div>
          <div id="fringe-diag-content" hidden style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;padding:8px">
            <div>
              <p style="font-size:11px;opacity:0.6;margin:0 0 6px">FFT Magnitude (click to override carrier)</p>
              <canvas id="fringe-fft-canvas" width="256" height="256" style="cursor:crosshair;image-rendering:pixelated;border:1px solid var(--border)"></canvas>
              <div style="margin-top:4px">
                <button class="detect-btn" id="fringe-btn-carrier-reset" style="padding:2px 8px;font-size:10px" hidden>
                  Reset to Auto
                </button>
              </div>
            </div>
            <div>
              <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Modulation / Quality Map</p>
              <img id="fringe-modulation-img" style="max-width:300px;border:1px solid var(--border)" />
            </div>
            <div style="min-width:200px">
              <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Carrier Statistics</p>
              <table id="fringe-carrier-table" style="font-size:11px;border-collapse:collapse">
                <tbody>
                  <tr><td style="padding:2px 8px;opacity:0.6">Period</td><td id="fringe-diag-period" style="padding:2px 8px">--</td></tr>
                  <tr><td style="padding:2px 8px;opacity:0.6">Angle</td><td id="fringe-diag-angle" style="padding:2px 8px">--</td></tr>
                  <tr><td style="padding:2px 8px;opacity:0.6">Peak ratio</td><td id="fringe-diag-ratio" style="padding:2px 8px">--</td></tr>
                  <tr><td style="padding:2px 8px;opacity:0.6">fx (cpp)</td><td id="fringe-diag-fx" style="padding:2px 8px">--</td></tr>
                  <tr><td style="padding:2px 8px;opacity:0.6">fy (cpp)</td><td id="fringe-diag-fy" style="padding:2px 8px">--</td></tr>
                  <tr><td style="padding:2px 8px;opacity:0.6">Valid pixels</td><td id="fringe-diag-valid" style="padding:2px 8px">--</td></tr>
                  <tr><td style="padding:2px 8px;opacity:0.6">Coverage</td><td id="fringe-diag-coverage" style="padding:2px 8px">--</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  wireEvents();
}

// ── Event wiring ────────────────────────────────────────────────────────

function wireEvents() {
  // Tab switching
  document.querySelectorAll(".fringe-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".fringe-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".fringe-tab-panel").forEach(p => p.hidden = true);
      tab.classList.add("active");
      const panelId = "fringe-panel-" + tab.dataset.tab;
      const panel = $(panelId);
      if (panel) panel.hidden = false;

      // Load 3D view on tab click
      if (tab.dataset.tab === "3d" && fr.lastResult) {
        render3dView();
      }
    });
  });

  // Reference standard change → re-color PV
  $("fringe-standard")?.addEventListener("change", () => {
    if (fr.lastResult) renderResults(fr.lastResult);
  });

  // Buttons that stay in fringe.js
  $("fringe-btn-invert")?.addEventListener("click", invertWavefront);
  $("fringe-btn-export-pdf")?.addEventListener("click", exportFringePdf);
  $("fringe-btn-export-csv")?.addEventListener("click", exportFringeCsv);

  // Panel events (analyze, averaging, mask, drag/drop, preview, etc.)
  wirePanelEvents();

  wireMeasureEvents();

  // Zernike checkbox change → re-analyze
  const checkboxIds = [
    "fringe-sub-power", "fringe-sub-astig",
    "fringe-sub-coma", "fringe-sub-spherical"
  ];
  let _reanalyzeDebounce = null;
  for (const id of checkboxIds) {
    $(id)?.addEventListener("change", () => {
      if (_reanalyzeDebounce) clearTimeout(_reanalyzeDebounce);
      _reanalyzeDebounce = setTimeout(() => {
        if (fr.lastResult) doReanalyze();
      }, 150);
    });
  }

  wireCarrierOverride();

  // Listen for fringe:analyzed events from panel module
  document.addEventListener("fringe:analyzed", (e) => renderResults(e.detail));
}

// Measurement functions moved to fringe-measure.js

// ── Helpers ─────────────────────────────────────────────────────────────

// getWavelength() and getMaskThreshold() moved to fringe-panel.js

export function getSubtractTerms() {
  // Piston + tilt always on
  const terms = [1, 2, 3];
  if ($("fringe-sub-power")?.checked) terms.push(4);
  if ($("fringe-sub-astig")?.checked) terms.push(5, 6);
  if ($("fringe-sub-coma")?.checked) terms.push(7, 8);
  if ($("fringe-sub-spherical")?.checked) terms.push(11);
  return terms;
}

// Utility functions (setMeasureReadout, clearMeasureSvg, findPeakValley,
// drawPeakValleyMarkers, getHeightAt, surfaceMouseCoords, fmtNm)
// moved to fringe-measure.js

// Mask drawing, analysis, and averaging functions moved to fringe-panel.js

async function doReanalyze() {
  if (!fr.lastResult) return;
  try {
    const r = await apiFetch("/fringe/reanalyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coefficients: fr.lastResult.coefficients,
        subtract_terms: getSubtractTerms(),
        wavelength_nm: getWavelength(),
        surface_height: fr.lastResult.surface_height || 128,
        surface_width: fr.lastResult.surface_width || 128,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    // Merge into lastResult
    fr.lastResult.surface_map = data.surface_map;
    fr.lastResult.zernike_chart = data.zernike_chart;
    fr.lastResult.profile_x = data.profile_x;
    fr.lastResult.profile_y = data.profile_y;
    fr.lastResult.pv_nm = data.pv_nm;
    fr.lastResult.rms_nm = data.rms_nm;
    fr.lastResult.pv_waves = data.pv_waves;
    fr.lastResult.rms_waves = data.rms_waves;
    fr.lastResult.subtracted_terms = data.subtracted_terms;
    if (data.strehl !== undefined) fr.lastResult.strehl = data.strehl;
    if (data.psf) fr.lastResult.psf = data.psf;
    if (data.mtf) fr.lastResult.mtf = data.mtf;
    renderResults(fr.lastResult);
  } catch (e) {
    console.warn("Re-analyze error:", e);
  }
}

// ── Rendering ───────────────────────────────────────────────────────────

function renderResults(data) {
  // Summary bar
  const summaryBar = $("fringe-summary-bar");
  if (summaryBar) summaryBar.hidden = false;

  const fmt = (v) => Number.isFinite(v) ? v.toFixed(3) : "--";
  const fmtNm = (v) => Number.isFinite(v) ? v.toFixed(1) : "--";

  $("fringe-pv-waves").textContent = fmt(data.pv_waves);
  $("fringe-pv-nm").textContent = fmtNm(data.pv_nm);
  $("fringe-rms-waves").textContent = fmt(data.rms_waves);
  $("fringe-rms-nm").textContent = fmtNm(data.rms_nm);
  const strehlEl = $("fringe-strehl");
  if (strehlEl) strehlEl.textContent = Number.isFinite(data.strehl) ? data.strehl.toFixed(3) : "--";

  // Standard pass/fail coloring
  const stdSel = $("fringe-standard");
  const pvEl = $("fringe-pv-nm");
  const pvWavesEl = $("fringe-pv-waves");
  if (stdSel && pvEl && stdSel.value) {
    const opt = stdSel.selectedOptions[0];
    const limit = parseFloat(opt.dataset.pvNm);
    if (Number.isFinite(limit) && Number.isFinite(data.pv_nm)) {
      const pass = data.pv_nm <= limit;
      const color = pass ? "#4caf50" : "#f44336";
      pvEl.style.color = color;
      pvWavesEl.style.color = color;
    }
  } else if (pvEl) {
    pvEl.style.color = "";
    if (pvWavesEl) pvWavesEl.style.color = "";
  }

  // Wavelength and subtracted terms in summary bar
  const wlEl = $("fringe-summary-wl");
  if (wlEl) wlEl.textContent = getWavelength() + " nm";
  const subEl = $("fringe-summary-sub");
  if (subEl) {
    const sub = getSubtractTerms();
    const names = [];
    if (sub.includes(2)) names.push("Tilt");
    if (sub.includes(4)) names.push("Power");
    if (sub.includes(5)) names.push("Astig");
    if (sub.includes(7)) names.push("Coma");
    if (sub.includes(11)) names.push("Sph");
    subEl.textContent = names.length ? names.join(", ") + " subtracted" : "None subtracted";
  }

  // Cache height grid for measurements
  if (data.height_grid) {
    fr.heightGrid = new Float32Array(data.height_grid);
    fr.maskGrid = new Uint8Array(data.mask_grid);
    fr.gridRows = data.grid_rows;
    fr.gridCols = data.grid_cols;
  }

  // Surface map
  const surfaceContent = $("fringe-surface-content");
  const empty = $("fringe-empty");
  if (surfaceContent && data.surface_map) {
    surfaceContent.hidden = false;
    if (empty) empty.hidden = true;
    const surfImg = $("fringe-surface-img");
    surfImg.onload = () => drawPeakValleyMarkers();
    surfImg.src = "data:image/png;base64," + data.surface_map;
  }

  // Zernike chart
  const zernikeContent = $("fringe-zernike-content");
  const zernikeEmpty = $("fringe-zernike-empty");
  if (zernikeContent && data.zernike_chart) {
    zernikeContent.hidden = false;
    if (zernikeEmpty) zernikeEmpty.hidden = true;
    $("fringe-zernike-chart").src = "data:image/png;base64," + data.zernike_chart;

    // Build Zernike coefficient table
    const tableContainer = $("fringe-zernike-table-container");
    if (tableContainer && fr.lastResult) {
      const coeffs = fr.lastResult.coefficients || [];
      const names = fr.lastResult.coefficient_names || {};
      const subtracted = new Set((fr.lastResult.subtracted_terms || []).map(Number));
      const wl = fr.lastResult.wavelength_nm || 632.8;

      if (coeffs.length > 0) {
        // Find dominant term (largest |coeff| among non-subtracted)
        let dominantIdx = -1;
        let dominantAbs = 0;
        for (let i = 0; i < coeffs.length; i++) {
          const noll = i + 1;
          if (!subtracted.has(noll) && Math.abs(coeffs[i]) > dominantAbs) {
            dominantAbs = Math.abs(coeffs[i]);
            dominantIdx = i;
          }
        }

        let html = "<table><thead><tr><th>#</th><th>Term</th><th>Coeff (rad)</th><th>Surface (nm)</th></tr></thead><tbody>";
        for (let i = 0; i < coeffs.length; i++) {
          const noll = i + 1;
          const coeff = coeffs[i];
          const name = names[String(noll)] || ("Z" + noll);
          const surfNm = coeff * wl / (4 * Math.PI);
          const isSub = subtracted.has(noll);
          const isDom = i === dominantIdx;
          let cls = "";
          if (isSub) cls = "fringe-z-subtracted";
          else if (isDom) cls = "fringe-z-dominant";
          html += '<tr class="' + cls + '">'
            + "<td>" + noll + "</td>"
            + "<td>" + name + (isSub ? " <span style='font-size:10px'>(sub)</span>" : "") + "</td>"
            + "<td>" + coeff.toFixed(3) + "</td>"
            + "<td>" + surfNm.toFixed(1) + "</td>"
            + "</tr>";
        }
        html += "</tbody></table>";
        tableContainer.innerHTML = html;
      } else {
        tableContainer.innerHTML = "";
      }
    }
  }

  // Profiles
  const profilesContent = $("fringe-profiles-content");
  const profilesEmpty = $("fringe-profiles-empty");
  if (profilesContent && data.profile_x) {
    profilesContent.hidden = false;
    if (profilesEmpty) profilesEmpty.hidden = true;
    drawProfile($("fringe-profile-x-canvas"), data.profile_x, "Horizontal Profile (center row)");
    drawProfile($("fringe-profile-y-canvas"), data.profile_y, "Vertical Profile (center col)");
  }

  // PSF / MTF
  const psfContent = $("fringe-psf-content");
  const psfEmpty = $("fringe-psf-empty");
  if (psfContent && data.psf) {
    psfContent.hidden = false;
    if (psfEmpty) psfEmpty.hidden = true;
    $("fringe-psf-img").src = "data:image/png;base64," + data.psf;
    if (data.mtf) {
      drawMtfChart(data.mtf);
    }
  }

  // Hide 3D empty state if we have results
  if (fr.lastResult) {
    const empty3d = $("fringe-3d-empty");
    if (empty3d) empty3d.textContent = "Click to load 3D view.";
  }

  // Carrier diagnostics
  updateCarrierDisplay(data);
}

// ── Carrier diagnostics ─────────────────────────────────────────────────

function updateCarrierDisplay(data) {
  const carrier = data.carrier;
  if (!carrier) return;

  const row = $("fringe-carrier-row");
  row.hidden = false;

  $("fringe-carrier-period").textContent = carrier.fringe_period_px.toFixed(1);
  $("fringe-carrier-angle").textContent = carrier.fringe_angle_deg.toFixed(1);

  // Confidence color: green >5, amber 2-5, red <2
  const ratio = carrier.peak_ratio;
  const dot = $("fringe-carrier-dot");
  let label;
  if (ratio > 5) { dot.style.background = "#30d158"; label = "Good"; }
  else if (ratio > 2) { dot.style.background = "#ff9f0a"; label = "Fair"; }
  else { dot.style.background = "#ff453a"; label = "Low"; }
  $("fringe-carrier-confidence").textContent = `${label} (${ratio.toFixed(1)})`;

  // Diagnostics tab content
  $("fringe-diag-period").textContent = `${carrier.fringe_period_px.toFixed(1)} px`;
  $("fringe-diag-angle").textContent = `${carrier.fringe_angle_deg.toFixed(1)}\u00B0`;
  $("fringe-diag-ratio").textContent = ratio.toFixed(2);
  $("fringe-diag-fx").textContent = carrier.fx_cpp.toFixed(6);
  $("fringe-diag-fy").textContent = carrier.fy_cpp.toFixed(6);
  $("fringe-diag-valid").textContent = data.n_valid_pixels?.toLocaleString() ?? "--";
  const coverage = data.n_total_pixels ? ((data.n_valid_pixels / data.n_total_pixels) * 100).toFixed(1) : "--";
  $("fringe-diag-coverage").textContent = `${coverage}%`;

  // FFT image
  if (data.fft_image) {
    const canvas = $("fringe-fft-canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
    };
    img.src = "data:image/png;base64," + data.fft_image;
  }

  // Modulation map
  if (data.modulation_map) {
    $("fringe-modulation-img").src = "data:image/png;base64," + data.modulation_map;
  }

  // Show diagnostics content
  $("fringe-diag-empty").hidden = true;
  $("fringe-diag-content").hidden = false;
}

function wireCarrierOverride() {
  const canvas = $("fringe-fft-canvas");
  if (!canvas) return;

  canvas.addEventListener("click", async (e) => {
    if (!fr.lastResult) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) / rect.width;
    const clickY = (e.clientY - rect.top) / rect.height;

    // Convert to fftshift pixel coordinates
    const imgH = fr.lastResult.surface_height;
    const imgW = fr.lastResult.surface_width;
    const carrierY = Math.round(clickY * imgH);
    const carrierX = Math.round(clickX * imgW);

    document.body.style.cursor = "wait";
    try {
      const resp = await apiFetch("/fringe/reanalyze-carrier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          carrier_y: carrierY,
          carrier_x: carrierX,
          wavelength_nm: getWavelength(),
          mask_threshold: getMaskThreshold(),
          subtract_terms: getSubtractTerms(),
          n_zernike: 36,
          mask_polygons: fr.maskPolygons.length > 0
            ? fr.maskPolygons.map(p => ({ vertices: p.vertices.map(v => [v.x, v.y]), include: p.include }))
            : undefined,
        }),
      });
      if (!resp.ok) { console.warn("Carrier override failed"); return; }
      const data = await resp.json();
      fr.lastResult = data;
      renderResults(data);
      updateCarrierDisplay(data);
      $("fringe-btn-carrier-reset").hidden = false;
      fr.carrierOverride = { y: carrierY, x: carrierX };
    } finally {
      document.body.style.cursor = "";
    }
  });

  $("fringe-btn-carrier-reset")?.addEventListener("click", () => {
    fr.carrierOverride = null;
    $("fringe-btn-carrier-reset").hidden = true;
    // Re-analyze with auto carrier
    $("fringe-btn-analyze")?.click();
  });

  // Carrier row clicks → switch to diagnostics tab
  $("fringe-carrier-row")?.addEventListener("click", () => {
    document.querySelectorAll(".fringe-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".fringe-tab-panel").forEach(p => p.hidden = true);
    const diagTab = document.querySelector('.fringe-tab[data-tab="diagnostics"]');
    if (diagTab) diagTab.classList.add("active");
    const panel = $("fringe-panel-diagnostics");
    if (panel) panel.hidden = false;
  });
}

function drawProfile(canvas, profile, title) {
  if (!canvas || !profile) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "#1c1c1e";
  ctx.fillRect(0, 0, w, h);

  const values = profile.values.filter(v => v !== null);
  if (values.length < 2) return;

  let vMin = Infinity, vMax = -Infinity;
  for (const v of values) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
  const vRange = vMax - vMin || 1;

  const padL = 60, padR = 20, padT = 30, padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Grid
  ctx.strokeStyle = "#3a3a3c";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // Title
  ctx.fillStyle = "#e8e8e8";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillText(title, padL, 16);

  // Y-axis labels
  ctx.fillStyle = "#ababab";
  ctx.font = "9px -apple-system, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    const v = vMax - (vRange * i) / 4;
    ctx.fillText(v.toFixed(1), 5, y + 3);
  }

  // Plot line
  ctx.strokeStyle = "#4a9eff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < profile.values.length; i++) {
    const v = profile.values[i];
    if (v === null) { started = false; continue; }
    const x = padL + (i / (profile.values.length - 1)) * plotW;
    const y = padT + ((vMax - v) / vRange) * plotH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawMtfChart(mtfData) {
  const canvas = $("fringe-mtf-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const pad = { top: 20, right: 20, bottom: 35, left: 45 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
  }

  // Axes labels
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Normalized spatial frequency", pad.left + pw / 2, H - 5);
  ctx.save();
  ctx.translate(12, pad.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Contrast", 0, 0);
  ctx.restore();

  // Y-axis tick labels
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph * (1 - i / 4);
    ctx.fillText((i * 0.25).toFixed(2), pad.left - 4, y + 3);
  }

  // X-axis tick labels
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const x = pad.left + pw * i / 4;
    ctx.fillText((i * 0.25).toFixed(2), x, pad.top + ph + 15);
  }

  const n = mtfData.freq.length;

  // Diffraction limit (dashed, white)
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad.left + mtfData.freq[i] * pw;
    const y = pad.top + ph * (1 - mtfData.mtf_diff[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Measured MTF (solid, colored)
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad.left + mtfData.freq[i] * pw;
    const y = pad.top + ph * (1 - mtfData.mtf[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Legend
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#4fc3f7";
  ctx.fillText("Measured", pad.left + pw - 60, pad.top + 12);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("Diffraction limit", pad.left + pw - 60, pad.top + 24);
}

// ── 3D View ─────────────────────────────────────────────────────────────

async function render3dView() {
  if (!fr.lastResult) return;
  const empty = $("fringe-3d-empty");
  const content = $("fringe-3d-content");
  const host = $("fringe-3d-host");
  if (!host) return;

  if (empty) empty.hidden = true;
  if (content) content.hidden = false;

  // Load Three.js if needed
  if (!fr.threeLoaded) {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const { OrbitControls } = await import("https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js");
    fr.THREE = THREE;
    fr.OrbitControls = OrbitControls;
    fr.threeLoaded = true;
  }
  const THREE = fr.THREE;
  const OrbitControls = fr.OrbitControls;

  const controlsEl = $("fringe-3d-controls");
  host.innerHTML = "";

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

  // Use actual height grid data (not profile approximation)
  if (!fr.heightGrid || !fr.maskGrid) return;

  const gridSize = 128;
  const sw = fr.lastResult.surface_width || 1;
  const sh = fr.lastResult.surface_height || 1;
  const aspect = sw / sh;
  const planeW = aspect >= 1 ? 2 : 2 * aspect;
  const planeH = aspect >= 1 ? 2 / aspect : 2;
  const geo = new THREE.PlaneGeometry(planeW, planeH, gridSize - 1, gridSize - 1);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const zSlider = $("fringe-3d-z-scale");
  const zLabel = $("fringe-3d-z-val");
  let zScale = zSlider ? parseFloat(zSlider.value) : 10;

  function applyZ() {
    let zMin = Infinity, zMax = -Infinity;
    const zVals = new Float32Array(gridSize * gridSize);
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        // Sample from height grid
        const gx = (c / (gridSize - 1)) * (fr.gridCols - 1);
        const gy = (r / (gridSize - 1)) * (fr.gridRows - 1);
        const gi = Math.round(gy) * fr.gridCols + Math.round(gx);
        const z = fr.maskGrid[gi] ? fr.heightGrid[gi] : 0;
        zVals[r * gridSize + c] = z;
        if (fr.maskGrid[gi]) {
          if (z < zMin) zMin = z;
          if (z > zMax) zMax = z;
        }
      }
    }
    if (!isFinite(zMin)) { zMin = 0; zMax = 1; }
    const zRange = zMax - zMin || 1;
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = r * gridSize + c;
        const z = zVals[idx];
        const zNorm = ((z - zMin) / zRange - 0.5) * zScale * 0.01;
        pos.setZ(idx, zNorm);
        // Blue-white-red colormap
        const t = (z - zMin) / zRange;
        colors[idx * 3]     = t < 0.5 ? 0.3 + t * 1.4 : 1.0;
        colors[idx * 3 + 1] = t < 0.5 ? 0.3 + t * 1.4 : 1.0 - (t - 0.5) * 1.4;
        colors[idx * 3 + 2] = t < 0.5 ? 1.0 : 1.0 - (t - 0.5) * 1.4;
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

  camera.position.set(0, -1.8, 2.2);
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

// Focus quality polling moved to fringe-panel.js

// ── Wavefront inversion ─────────────────────────────────────────────────

async function invertWavefront() {
  if (!fr.lastResult || !fr.lastResult.coefficients) return;
  // Negate all coefficients
  const inverted = fr.lastResult.coefficients.map(c => -c);
  fr.lastResult.coefficients = inverted;

  // If averaging, also negate all stored capture coefficients
  for (const cap of fr.avgCaptures) {
    for (let i = 0; i < cap.coefficients.length; i++) {
      cap.coefficients[i] = -cap.coefficients[i];
    }
  }

  // Reanalyze with inverted coefficients
  try {
    const r = await apiFetch("/fringe/reanalyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coefficients: inverted,
        subtract_terms: getSubtractTerms(),
        wavelength_nm: getWavelength(),
        surface_height: fr.lastResult.surface_height || 128,
        surface_width: fr.lastResult.surface_width || 128,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    // Merge results
    fr.lastResult.surface_map = data.surface_map;
    fr.lastResult.zernike_chart = data.zernike_chart;
    fr.lastResult.profile_x = data.profile_x;
    fr.lastResult.profile_y = data.profile_y;
    fr.lastResult.pv_nm = data.pv_nm;
    fr.lastResult.rms_nm = data.rms_nm;
    fr.lastResult.pv_waves = data.pv_waves;
    fr.lastResult.rms_waves = data.rms_waves;
    fr.lastResult.subtracted_terms = data.subtracted_terms;
    if (data.strehl !== undefined) fr.lastResult.strehl = data.strehl;
    if (data.psf) fr.lastResult.psf = data.psf;
    if (data.mtf) fr.lastResult.mtf = data.mtf;
    renderResults(fr.lastResult);
  } catch (e) {
    console.warn("Invert error:", e);
  }
}

// ── Export (CSV + PDF) ──────────────────────────────────────────────────

function exportFringeCsv() {
  if (!fr.lastResult) return;
  const coeffs = fr.lastResult.coefficients;
  const names = fr.lastResult.coefficient_names || {};
  const wl = fr.lastResult.wavelength_nm || 632.8;
  const sub = fr.lastResult.subtracted_terms || [];

  let csv = "Index,Name,Coefficient (rad),Surface Error (nm),Subtracted\n";
  for (let i = 0; i < coeffs.length; i++) {
    const j = i + 1;
    const name = names[String(j)] || `Z${j}`;
    const nm = (coeffs[i] * wl / (4 * Math.PI)).toFixed(2);
    const subtracted = sub.includes(j) ? "yes" : "no";
    csv += `${j},"${name}",${coeffs[i].toFixed(6)},${nm},${subtracted}\n`;
  }

  // Add summary
  csv += `\nSummary\n`;
  csv += `PV (nm),${fr.lastResult.pv_nm?.toFixed(1)}\n`;
  csv += `RMS (nm),${fr.lastResult.rms_nm?.toFixed(1)}\n`;
  csv += `PV (waves),${fr.lastResult.pv_waves?.toFixed(4)}\n`;
  csv += `RMS (waves),${fr.lastResult.rms_waves?.toFixed(4)}\n`;
  csv += `Strehl,${fr.lastResult.strehl?.toFixed(4)}\n`;
  csv += `Wavelength (nm),${wl}\n`;

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fringe_zernike_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportFringePdf() {
  if (!fr.lastResult) return;
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { alert("PDF library not loaded"); return; }

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = 297;
  const pageH = 210;
  const margin = 10;
  const data = fr.lastResult;

  // Header
  doc.setFontSize(16);
  doc.text("Fringe Analysis Report", margin, margin + 7);
  doc.setFontSize(9);
  doc.setTextColor(100);
  const ts = new Date().toLocaleString();
  doc.text(`Exported: ${ts}   Wavelength: ${data.wavelength_nm} nm`, margin, margin + 13);

  // Standard
  const stdSel = $("fringe-standard");
  if (stdSel && stdSel.value) {
    const stdOpt = stdSel.selectedOptions[0];
    doc.text(`Reference: ${stdOpt.textContent}  (PV limit: ${stdOpt.dataset.pvNm} nm)`, margin, margin + 18);
  }
  doc.setTextColor(0);

  let y = margin + 24;

  // Stats box
  doc.setFontSize(11);
  const pvStr = `PV: ${data.pv_nm?.toFixed(1)} nm (${data.pv_waves?.toFixed(3)} \u03bb)`;
  const rmsStr = `RMS: ${data.rms_nm?.toFixed(1)} nm (${data.rms_waves?.toFixed(3)} \u03bb)`;
  const strehlStr = `Strehl: ${data.strehl?.toFixed(3)}`;
  doc.text(`${pvStr}     ${rmsStr}     ${strehlStr}`, margin, y);

  // Standard pass/fail
  if (stdSel && stdSel.value) {
    const limit = parseFloat(stdSel.selectedOptions[0].dataset.pvNm);
    const pass = data.pv_nm <= limit;
    doc.setTextColor(pass ? 0 : 200, pass ? 150 : 0, 0);
    doc.text(pass ? "  PASS" : "  FAIL", margin + 180, y);
    doc.setTextColor(0);
  }
  y += 8;

  // Surface map image
  if (data.surface_map) {
    try {
      const imgData = "data:image/png;base64," + data.surface_map;
      // Fit in left half of page
      const imgW = 130;
      const imgH = 100;
      doc.addImage(imgData, "PNG", margin, y, imgW, imgH);

      // PSF in the right area (smaller)
      if (data.psf) {
        const psfData = "data:image/png;base64," + data.psf;
        doc.setFontSize(8);
        doc.text("PSF", margin + imgW + 10, y);
        doc.addImage(psfData, "PNG", margin + imgW + 10, y + 3, 50, 50);
      }

      y += imgH + 5;
    } catch (e) {
      console.warn("PDF image error:", e);
    }
  }

  // Zernike chart
  if (data.zernike_chart && y + 60 < pageH - margin) {
    try {
      const chartData = "data:image/png;base64," + data.zernike_chart;
      const chartW = pageW - margin * 2;
      const chartH = 55;
      doc.addImage(chartData, "PNG", margin, y, chartW, chartH);
      y += chartH + 5;
    } catch (e) {
      console.warn("PDF chart error:", e);
    }
  }

  // If we need a second page for the Zernike table
  if (y + 10 > pageH - margin) {
    doc.addPage();
    y = margin + 7;
  }

  // Zernike coefficient table
  doc.setFontSize(10);
  doc.text("Zernike Coefficients", margin, y);
  y += 5;
  doc.setFontSize(7);

  const coeffs = data.coefficients || [];
  const names = data.coefficient_names || {};
  const sub = data.subtracted_terms || [];
  const wl = data.wavelength_nm || 632.8;

  // Table header
  doc.setFont(undefined, "bold");
  doc.text("#", margin, y);
  doc.text("Term", margin + 8, y);
  doc.text("Coeff (rad)", margin + 50, y);
  doc.text("Surface (nm)", margin + 80, y);
  doc.text("Status", margin + 110, y);
  doc.setFont(undefined, "normal");
  y += 4;

  // Only show terms with |coeff| > 0.001 to keep it concise
  for (let i = 0; i < Math.min(coeffs.length, 36); i++) {
    if (Math.abs(coeffs[i]) < 0.001) continue;
    if (y + 4 > pageH - margin) {
      doc.addPage();
      y = margin + 7;
    }
    const j = i + 1;
    const name = names[String(j)] || `Z${j}`;
    const nm = (coeffs[i] * wl / (4 * Math.PI)).toFixed(1);
    const status = sub.includes(j) ? "(subtracted)" : "";
    if (sub.includes(j)) doc.setTextColor(150);
    doc.text(String(j), margin, y);
    doc.text(name, margin + 8, y);
    doc.text(coeffs[i].toFixed(4), margin + 50, y);
    doc.text(nm, margin + 80, y);
    doc.text(status, margin + 110, y);
    doc.setTextColor(0);
    y += 3.5;
  }

  // Save
  const filename = `fringe_report_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.pdf`;
  doc.save(filename);
}

// ── Public init ─────────────────────────────────────────────────────────

export function initFringe() {
  buildWorkspace();
  loadWavelengthPresets();   // async — overrides defaults from config.json

  // Start/stop polling when mode becomes visible/hidden
  const observer = new MutationObserver(() => {
    const root = $("mode-fringe");
    if (!root) return;
    if (root.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });
  const root = $("mode-fringe");
  if (root) observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}
