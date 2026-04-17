// fringe-results.js — Results column rendering, Zernike subtraction pills,
// tab switching, carrier diagnostics, 3D view, export (CSV/PDF).
//
// Extracted from fringe.js (Task 7 of fringe UI restructure).

import { fr, $ } from './fringe.js';
import { apiFetch } from './api.js';
import { getWavelength, getMaskThreshold, getLpfSigmaFrac, getDcMarginOverride, getCorrect2piJumps, getCalibrationPayload, getAperturePayload } from './fringe-panel.js';
import { getActiveRecipe, recipeToMaskPolygons } from './fringe-geometry.js';
import { drawPeakValleyMarkers, resetSurfaceZoom, refreshLastMeasurement } from './fringe-measure.js';
import {
  getActiveCalibration,
  listCalibrations,
  setActiveCalibrationId,
  saveCalibration,
  deleteCalibration,
  exportCalibrationsJson,
  importCalibrationsJson,
} from './fringe-calibration.js';
import { renderTrend } from './fringe-trend.js';

// ── Subtraction pill state ──────────────────────────────────────────────

const SUBTRACT_PILLS = [
  { id: "tilt",      terms: [2, 3],  label: "Tilt",       locked: false },
  { id: "power",     terms: [4],     label: "Curvature",  locked: false },
  { id: "astig",     terms: [5, 6],  label: "Twist",      locked: false },
  { id: "coma",      terms: [7, 8],  label: "Coma",       locked: false },
  { id: "spherical", terms: [11],    label: "Spherical",  locked: false },
];

const pillState = { tilt: true, power: false, astig: false, coma: false, spherical: false };

let formModel = "zernike";
export function getFormModel() { return formModel; }

export function getSubtractTerms() {
  // M4.2: when the per-term Zernike table has been used to toggle terms
  // outside the canonical pill set, the latest subtracted_terms list is
  // the authoritative source. Fall back to the pill state otherwise so
  // a fresh analyze (no result yet) still works.
  if (fr.lastResult && Array.isArray(fr.lastResult.subtracted_terms)
      && fr.lastResult.subtracted_terms.length > 0) {
    const set = new Set(fr.lastResult.subtracted_terms.map(Number));
    set.add(1); // piston is always implicitly subtracted
    return Array.from(set).sort((a, b) => a - b);
  }
  const terms = [1]; // piston always
  for (const pill of SUBTRACT_PILLS) {
    if (pillState[pill.id]) terms.push(...pill.terms);
  }
  return terms;
}

// M1.4 helpers — keep mask_polygons + aperture_recipe in sync for
// /fringe/reanalyze-carrier the same way fringe-panel.js does for /analyze.
function _buildCarrierMaskPayload() {
  if (fr.maskPolygons.length > 0) {
    return fr.maskPolygons.map(p => ({
      vertices: p.vertices.map(v => [v.x, v.y]),
      include: p.include,
    }));
  }
  const active = getActiveRecipe();
  if (active) {
    const polys = recipeToMaskPolygons(active);
    if (polys.length > 0) return polys;
  }
  return undefined;
}

function _getAperturePayloadOrNull() {
  return getAperturePayload();
}

// ── Results column HTML ─────────────────────────────────────────────────

export function buildResultsHtml() {
  const pillButtons = SUBTRACT_PILLS.map(p => {
    const classes = ["fringe-pill"];
    if (pillState[p.id]) classes.push("active");
    if (p.locked) classes.push("locked");
    return `<button class="${classes.join(" ")}" data-pill="${p.id}"${p.locked ? " disabled" : ""}>${p.label}</button>`;
  }).join("\n          ");

  return `
        <div class="fringe-summary-bar" id="fringe-summary-bar" hidden title="PV = total range of surface error. RMS = average deviation. Lower = flatter.">
          <div class="fringe-stat" style="margin-right:4px">
            <select id="fringe-mode-select" title="Workflow mode \u2014 gates which tools show. UI-only; backend ignores it." style="font-size:11px;padding:2px 4px">
              <option value="surface">Surface</option>
              <option value="step">Small-step (&lt; \u03bb/4)</option>
              <option value="averaging">Averaging</option>
              <option value="subtraction">Subtraction</option>
            </select>
          </div>
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
            <span id="fringe-summary-wl" style="font-size:12px;opacity:0.7" title="Active calibration">-- nm</span>
            <span id="fringe-summary-recipe" hidden style="margin-left:8px;font-size:11px;padding:1px 6px;border-radius:999px;background:rgba(10,132,255,0.15);color:#4a9eff" title="Saved aperture recipe — sent with every analyze.">\u{1F532} <span id="fringe-summary-recipe-name"></span></span>
            <a href="#" id="fringe-cal-change" style="font-size:11px;opacity:0.7;margin-left:6px;text-decoration:underline;cursor:pointer" title="Change calibration">change\u2026</a>
            <button class="fringe-pill" id="fringe-cal-export" style="margin-left:6px;padding:1px 6px;font-size:10px" title="Export all calibrations as JSON">Export\u2026</button>
            <button class="fringe-pill" id="fringe-cal-import" style="margin-left:4px;padding:1px 6px;font-size:10px" title="Import calibrations from a JSON file">Import\u2026</button>
            <input type="file" id="fringe-cal-import-file" accept=".json,application/json" hidden />
            <span style="margin-left:12px;font-size:11px;opacity:0.5" id="fringe-summary-sub">Tilt subtracted</span>
          </div>
        </div>

        <div class="fringe-confidence-row" id="fringe-confidence-row" hidden>
          <span class="fringe-conf-badge" id="fringe-conf-carrier" title="Carrier detection confidence">
            <span class="fringe-conf-dot"></span> Carrier: <span class="fringe-conf-val">--</span>
          </span>
          <span class="fringe-conf-badge" id="fringe-conf-modulation" title="Fringe modulation coverage">
            <span class="fringe-conf-dot"></span> Modulation: <span class="fringe-conf-val">--</span>
          </span>
          <span class="fringe-conf-badge" id="fringe-conf-unwrap" title="Phase unwrap reliability">
            <span class="fringe-conf-dot"></span> Unwrap: <span class="fringe-conf-val">--</span>
          </span>
          <span class="fringe-conf-badge" id="fringe-conf-trusted" title="Fraction of the analysis mask that is both well-modulated and unwrap-reliable">
            <span class="fringe-conf-dot"></span> Trusted area: <span id="fringe-trusted-area">--</span>
          </span>
        </div>

        <div class="fringe-confidence-row" id="fringe-carrier-diagnostics" hidden style="flex-wrap:wrap;gap:8px 16px;font-size:11px;opacity:0.85" title="Carrier diagnostics from the current analysis">
          <span class="fringe-conf-badge" id="fringe-diag-chosen" style="cursor:default">
            <span class="fringe-conf-dot" style="background:#30d158"></span>
            <span>Chosen: period <span id="fringe-diag-chosen-period">--</span> px &middot; angle <span id="fringe-diag-chosen-angle">--</span>&deg; &middot; distance <span id="fringe-diag-chosen-dist">--</span> px from DC</span>
          </span>
          <span class="fringe-conf-badge" id="fringe-diag-confidence" style="cursor:default">
            <span class="fringe-conf-dot" style="background:var(--muted)"></span>
            <span>Confidence: peak ratio <span id="fringe-diag-conf-ratio">--</span>&times; &middot; SNR <span id="fringe-diag-conf-snr">--</span> dB &middot; DC margin <span id="fringe-diag-conf-dc">--</span> px</span>
          </span>
          <span class="fringe-conf-badge" id="fringe-diag-override-badge" hidden style="cursor:default;background:rgba(234,179,8,0.2);color:#eab308;padding:1px 6px;border-radius:3px;font-weight:600" title="Carrier was set manually">MANUAL</span>
          <span id="fringe-diag-tuning" hidden style="flex-basis:100%;font-size:10px;opacity:0.6" title="Tuning parameters applied to this analysis"></span>
          <span id="fringe-diag-alternates-list" style="flex-basis:100%;display:flex;flex-wrap:wrap;gap:4px 12px;opacity:0.75"></span>
        </div>

        <div class="fringe-carrier-row" id="fringe-carrier-row" hidden style="display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:11px;opacity:0.8;border-bottom:1px solid var(--border);cursor:pointer" title="Click to open Diagnostics tab">
          <span id="fringe-carrier-dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0"></span>
          <span>Carrier: <span id="fringe-carrier-period">--</span>px period @ <span id="fringe-carrier-angle">--</span>&deg;</span>
          <span style="margin-left:auto;opacity:0.6">Confidence: <span id="fringe-carrier-confidence">--</span></span>
        </div>

        <div class="fringe-subtract-row" id="fringe-subtract-row">
          <select id="fringe-form-model" style="font-size:11px;padding:2px 4px;margin-right:4px"
                  title="Form-removal model. Zernike: orthogonal basis on a circular aperture. Plane: linear tilt only. Poly2: 2nd-degree polynomial for non-circular apertures. Poly3: 3rd-degree polynomial for higher-order non-circular aberrations.">
            <option value="zernike" title="Orthogonal basis on a circular aperture. Use when the aperture is ~round.">Zernike</option>
            <option value="plane" title="Linear tilt only. Use when you want to keep curvature as part of the measurement.">Plane</option>
            <option value="poly2" title="Low-order polynomial (2nd degree). Use for non-circular apertures.">Poly2</option>
            <option value="poly3" title="3rd-degree polynomial. Handles higher-order non-circular aberrations.">Poly3</option>
          </select>
          <span id="fringe-pill-group">
            <span class="fringe-sub-label">Subtract:</span>
            ${pillButtons}
          </span>
          <div class="fringe-pill-divider"></div>
          <button class="fringe-pill" id="fringe-btn-invert" disabled>\u2195 Invert</button>
        </div>

        <div class="fringe-tab-bar" id="fringe-tab-bar">
          <button class="fringe-tab active" data-tab="surface">Surface Map</button>
          <button class="fringe-tab" data-tab="3d">3D View</button>
          <button class="fringe-tab" data-tab="zernike">Zernike</button>
          <button class="fringe-tab" data-tab="profiles">Profiles</button>
          <button class="fringe-tab" data-tab="psf">PSF / MTF</button>
          <button class="fringe-tab" data-tab="diagnostics">Diagnostics</button>
          <button class="fringe-tab" data-tab="session">Session</button>
          <button class="fringe-tab" data-tab="trend" title="Per-capture PV/RMS trend over the session">Trend</button>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-surface">
          <div class="fringe-empty-state" id="fringe-empty">
            <div style="max-width:420px;text-align:left;line-height:1.6">
              <div style="font-size:14px;font-weight:600;margin-bottom:8px;text-align:center">Freeze a frame or drop an interferogram to analyze</div>
              <div style="font-size:12px;opacity:0.7;margin-top:12px">
                <div style="font-weight:600;margin-bottom:4px">Tips for best results:</div>
                <ul style="margin:0;padding-left:18px">
                  <li>Clean both surfaces thoroughly \u2014 dust particles create false fringes</li>
                  <li>Place the flat gently, don\u2019t press \u2014 pressure causes stress fringes</li>
                  <li>Slide slightly to \u201cwring\u201d the flat \u2014 this minimizes the air gap</li>
                  <li>Aim for 3\u20135 fringes across the surface for best accuracy</li>
                  <li>Closed circular fringes indicate trapped dust or burrs</li>
                  <li>Use monochromatic light (sodium lamp or HeNe laser)</li>
                </ul>
              </div>
            </div>
          </div>
          <div id="fringe-surface-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <div class="fringe-overlay-toggles" id="fringe-overlay-toggles" hidden>
              <button class="fringe-overlay-btn active" data-overlay="surface">Surface</button>
              <button class="fringe-overlay-btn" data-overlay="confidence">Confidence</button>
              <button class="fringe-overlay-btn" data-overlay="modulation">Modulation</button>
            </div>
            <div class="fringe-measure-toolbar" id="fringe-measure-toolbar">
              <button class="fringe-measure-btn active" data-mode="" title="Pan / zoom (no measurement)">\u2194 Pan</button>
              <button class="fringe-measure-btn" data-mode="cursor" title="Hover to see height at cursor">\u22b9 Cursor</button>
              <button class="fringe-measure-btn" data-mode="point2point" title="Click two points to measure height difference">\u2b0d \u0394h</button>
              <button class="fringe-measure-btn" data-mode="lineProfile" title="Click two points to draw a line profile">\u2572 Profile</button>
              <button class="fringe-measure-btn" data-mode="area" title="Click two corners to get area statistics">\u25ad Area</button>
              <button class="fringe-measure-btn" data-mode="step" title="Measure small height differences between two regions. Valid for smooth surfaces and steps < &#955;/4 (~158 nm for He-Ne). Larger steps cannot be measured by single-shot single-wavelength interferometry &#8212; the 2&#960; wrap ambiguity makes step and step &#177; n&#183;&#955;/2 indistinguishable.">
                <svg width="12" height="10" viewBox="0 0 12 10" style="vertical-align:-1px" aria-hidden="true">
                  <path d="M1 8 H5 V4 H11" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                </svg> Step
              </button>
              <label style="font-size:11px;display:inline-flex;align-items:center;gap:4px;margin-left:8px;opacity:0.85;cursor:pointer" title="Restrict measurements to pixels that are both well-modulated and unwrap-reliable (set by the server's trusted-area mask)">
                <input type="checkbox" id="fringe-use-trusted-only" />
                use trusted pixels only
              </label>
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
          <div id="fringe-diag-content" hidden style="padding:8px">
            <div id="fringe-diag-assessment" style="padding:8px 12px;margin-bottom:8px;border-radius:6px;font-size:12px;display:none"></div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
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
                <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Modulation Map</p>
                <img id="fringe-modulation-img" style="max-width:300px;border:1px solid var(--border)" />
              </div>
              <div>
                <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Unwrap Risk Map</p>
                <img id="fringe-unwrap-risk-img" style="max-width:300px;border:1px solid var(--border)" />
              </div>
              <div style="min-width:200px">
                <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Carrier Statistics</p>
                <table id="fringe-carrier-table" style="font-size:11px;border-collapse:collapse">
                  <tbody>
                    <tr><td style="padding:2px 8px;opacity:0.6">Period</td><td id="fringe-diag-period" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Angle</td><td id="fringe-diag-angle" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Peak ratio</td><td id="fringe-diag-ratio" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">SNR</td><td id="fringe-diag-snr" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">DC margin</td><td id="fringe-diag-dc-margin" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Alternates</td><td id="fringe-diag-alternates" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">fx (cpp)</td><td id="fringe-diag-fx" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">fy (cpp)</td><td id="fringe-diag-fy" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Valid pixels</td><td id="fringe-diag-valid" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Coverage</td><td id="fringe-diag-coverage" style="padding:2px 8px">--</td></tr>
                  </tbody>
                </table>
                <p style="font-size:11px;opacity:0.6;margin:12px 0 6px">Unwrap Statistics</p>
                <table style="font-size:11px;border-collapse:collapse">
                  <tbody>
                    <tr><td style="padding:2px 8px;opacity:0.6">Reliable</td><td id="fringe-diag-reliable" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Corrected</td><td id="fringe-diag-corrected" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Edge risk</td><td id="fringe-diag-edge-risk" style="padding:2px 8px">--</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-session" hidden>
          <div style="display:flex;flex:1;min-height:0;gap:8px;padding:8px">
            <div style="flex:1;display:flex;flex-direction:column;min-width:280px">
              <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);margin-bottom:6px;flex-wrap:wrap">
                <span id="fringe-session-count" style="font-size:12px;font-weight:600">0 captures in this session</span>
                <button id="fringe-session-avg-mode" class="fringe-pill" style="padding:2px 8px;font-size:11px" title="Pick 2 or more captures to average">Select for average&hellip;</button>
                <a href="#" id="fringe-session-avg-cancel" hidden style="font-size:11px;color:#4a9eff;text-decoration:underline">Cancel</a>
                <button id="fringe-session-refresh" class="fringe-pill" style="margin-left:auto;padding:2px 8px;font-size:11px" title="Re-fetch the captures list">Refresh</button>
                <button id="fringe-session-import" class="fringe-pill" style="padding:2px 8px;font-size:11px" title="Import a previously-exported capture JSON file">Import result</button>
                <input type="file" id="fringe-session-import-file" accept=".json,application/json" hidden />
                <button id="fringe-session-clear" class="fringe-pill" style="padding:2px 8px;font-size:11px;opacity:0.75" title="Clear all captures for this session">Clear session</button>
              </div>
              <div id="fringe-session-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:4px"></div>
            </div>
            <div id="fringe-session-detail" style="flex:1;min-width:260px;border-left:1px solid var(--border);padding-left:10px;overflow-y:auto;font-size:12px">
              <div style="opacity:0.6;text-align:center;padding-top:24px">Click a capture to view details.</div>
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-trend" hidden>
          <div style="padding:8px 12px;display:flex;flex-direction:column;gap:8px;flex:1;min-height:0">
            <div style="display:flex;align-items:center;gap:10px;font-size:12px;flex-wrap:wrap">
              <strong>In-session trend</strong>
              <span style="opacity:0.65">PV (orange) and RMS (blue) per capture</span>
              <label style="margin-left:auto;display:inline-flex;align-items:center;gap:4px">
                Group by:
                <select id="fringe-trend-group" style="font-size:11px;padding:2px 4px">
                  <option value="none">(none)</option>
                  <option value="calibration">Calibration</option>
                  <option value="origin">Origin</option>
                </select>
              </label>
            </div>
            <div id="fringe-trend-host" style="flex:1;min-height:200px;overflow:auto;border:1px solid var(--border);border-radius:4px;background:#0f0f10"></div>
          </div>
        </div>
  `;
}

// ── Trusted-only client-side recompute (M1.6 wiring) ────────────────────
//
// When fr.useTrustedOnly is set, recompute PV/RMS from the cached
// heightGrid filtered by trustedMaskGrid (subset of maskGrid). No backend
// re-analyze; everything is local. Display updates the four summary spans
// and tints them so it's obvious the numbers are derived from the
// trusted-only subset.

function recomputeStats(useTrusted) {
  const h = fr.heightGrid;
  const m = useTrusted ? fr.trustedMaskGrid : fr.maskGrid;
  if (!h || !m || h.length !== m.length) return null;
  let n = 0, sum = 0, sumsq = 0, vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (!m[i]) continue;
    const v = h[i];
    if (!Number.isFinite(v)) continue;
    n++; sum += v; sumsq += v * v;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  if (n === 0) return null;
  const mean = sum / n;
  const variance = Math.max(0, sumsq / n - mean * mean);
  return { pv_nm: vmax - vmin, rms_nm: Math.sqrt(variance), n_valid: n, mean };
}

function applyStatsDisplay({ pv_nm, rms_nm, useTrusted }) {
  const wl = (fr.lastResult && Number.isFinite(fr.lastResult.wavelength_nm))
    ? fr.lastResult.wavelength_nm : 632.8;
  const fmt = (v) => Number.isFinite(v) ? v.toFixed(3) : "--";
  const fmtNm = (v) => Number.isFinite(v) ? v.toFixed(1) : "--";
  const pvWaves = Number.isFinite(pv_nm) ? pv_nm / wl : NaN;
  const rmsWaves = Number.isFinite(rms_nm) ? rms_nm / wl : NaN;
  const pvWavesEl = $("fringe-pv-waves");
  const pvNmEl = $("fringe-pv-nm");
  const rmsWavesEl = $("fringe-rms-waves");
  const rmsNmEl = $("fringe-rms-nm");
  if (pvWavesEl) pvWavesEl.textContent = fmt(pvWaves);
  if (pvNmEl) pvNmEl.textContent = fmtNm(pv_nm);
  if (rmsWavesEl) rmsWavesEl.textContent = fmt(rmsWaves);
  if (rmsNmEl) rmsNmEl.textContent = fmtNm(rms_nm);
  // Tint amber + tooltip when showing trusted-only stats.
  const tint = useTrusted ? "#ff9f0a" : "";
  const title = useTrusted ? "Computed from trusted pixels only" : "";
  for (const el of [pvWavesEl, pvNmEl, rmsWavesEl, rmsNmEl]) {
    if (!el) continue;
    el.style.color = tint;
    el.title = title;
    el.classList.toggle("fringe-stat-trusted", !!useTrusted);
  }
  // Toggle a "(trusted)" suffix on the PV/RMS labels.
  const pvLabel = pvNmEl?.parentElement?.querySelector(".fringe-stat-label");
  const rmsLabel = rmsNmEl?.parentElement?.querySelector(".fringe-stat-label");
  for (const lab of [pvLabel, rmsLabel]) {
    if (!lab) continue;
    if (!lab.dataset.baseLabel) lab.dataset.baseLabel = lab.textContent;
    lab.textContent = useTrusted ? `${lab.dataset.baseLabel} (trusted)` : lab.dataset.baseLabel;
  }
}

export function refreshTrustedOnlyDisplay() {
  const useTrusted = !!fr.useTrustedOnly;
  if (!useTrusted) {
    // Restore baseline values from lastResult.
    const data = fr.lastResult;
    if (data) applyStatsDisplay({ pv_nm: data.pv_nm, rms_nm: data.rms_nm, useTrusted: false });
    else applyStatsDisplay({ pv_nm: NaN, rms_nm: NaN, useTrusted: false });
  } else {
    const stats = recomputeStats(true);
    if (stats) applyStatsDisplay({ pv_nm: stats.pv_nm, rms_nm: stats.rms_nm, useTrusted: true });
    else applyStatsDisplay({ pv_nm: NaN, rms_nm: NaN, useTrusted: true });
  }
  // Keep the surface-map untrusted overlay in sync.
  refreshTrustedOverlay();
}

// ── Trusted-only surface map overlay ────────────────────────────────────
//
// Semi-transparent canvas dimming pixels that were analyzed but flagged
// as untrusted (maskGrid==1 && trustedMaskGrid==0). Lives inside
// #fringe-surface-wrapper so it inherits the wrapper's zoom/pan
// transform automatically.

function _ensureTrustedOverlay() {
  const wrapper = $("fringe-surface-wrapper");
  if (!wrapper) return null;
  let canvas = document.getElementById("fringe-surface-trusted-overlay");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "fringe-surface-trusted-overlay";
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    canvas.style.display = "none";
    canvas.style.zIndex = "5";
    // Insert before the SVG so measure overlays remain on top.
    const svg = document.getElementById("fringe-measure-svg");
    if (svg && svg.parentElement === wrapper) {
      wrapper.insertBefore(canvas, svg);
      svg.style.zIndex = svg.style.zIndex || "10";
    } else {
      wrapper.appendChild(canvas);
    }
  }
  return canvas;
}

export function refreshTrustedOverlay() {
  const canvas = _ensureTrustedOverlay();
  if (!canvas) return;
  if (!fr.useTrustedOnly) {
    canvas.style.display = "none";
    return;
  }
  const img = $("fringe-surface-img");
  const mask = fr.maskGrid;
  const trusted = fr.trustedMaskGrid;
  const rows = fr.gridRows | 0;
  const cols = fr.gridCols | 0;
  if (!img || !mask || !trusted || rows <= 0 || cols <= 0 ||
      mask.length !== rows * cols || trusted.length !== rows * cols) {
    canvas.style.display = "none";
    return;
  }
  // Display canvas matches the rendered (CSS) size of the image so it
  // overlays the visible PNG 1:1 in wrapper-local coordinates. The
  // wrapper's transform (zoom/pan) is inherited by both nodes.
  const dispW = img.clientWidth || img.naturalWidth || cols;
  const dispH = img.clientHeight || img.naturalHeight || rows;
  if (dispW <= 0 || dispH <= 0) {
    canvas.style.display = "none";
    return;
  }
  canvas.style.display = "block";
  canvas.width = dispW;
  canvas.height = dispH;
  canvas.style.width = dispW + "px";
  canvas.style.height = dispH + "px";

  // Build the dim mask at native grid resolution, then scale up.
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const offCtx = off.getContext("2d");
  const imgData = offCtx.createImageData(cols, rows);
  const px = imgData.data;
  for (let i = 0; i < mask.length; i++) {
    const j = i * 4;
    if (mask[i] && !trusted[i]) {
      px[j] = 0; px[j + 1] = 0; px[j + 2] = 0; px[j + 3] = 110;
    } else {
      px[j] = 0; px[j + 1] = 0; px[j + 2] = 0; px[j + 3] = 0;
    }
  }
  offCtx.putImageData(imgData, 0, 0);

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, dispW, dispH);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, dispW, dispH);
}

// ── Rendering ───────────────────────────────────────────────────────────

function renderResults(data) {
  // Summary bar
  const summaryBar = $("fringe-summary-bar");
  if (summaryBar) summaryBar.hidden = false;

  // M3.6: subtracted-result provenance chip + warnings banner.
  _renderSubtractedProvenance(data);
  _renderSubtractionWarnings(data);
  // M4.4: generic warnings banner for analyze (capture) results.
  _renderGenericWarnings(data);

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
  updateCalibrationIndicator();
  const subEl = $("fringe-summary-sub");
  if (subEl) {
    if (formModel === "plane") {
      subEl.textContent = "Plane removed";
    } else if (formModel === "poly2") {
      subEl.textContent = "Poly2 removed";
    } else if (formModel === "poly3") {
      subEl.textContent = "Poly3 removed";
    } else {
      const sub = getSubtractTerms();
      const names = [];
      if (sub.includes(2)) names.push("Tilt");
      if (sub.includes(4)) names.push("Curvature");
      if (sub.includes(5)) names.push("Twist");
      if (sub.includes(7)) names.push("Coma");
      if (sub.includes(11)) names.push("Sph");
      subEl.textContent = names.length ? names.join(", ") + " subtracted" : "None subtracted";
    }
  }

  // Enable invert button once we have results
  const invertBtn = $("fringe-btn-invert");
  if (invertBtn) invertBtn.disabled = false;

  // Confidence badges
  const trustedBadgeColor = (score) => score >= 80 ? "#30d158" : score >= 40 ? "#ff9f0a" : "#ff453a";
  if (data.confidence) {
    const confRow = $("fringe-confidence-row");
    if (confRow) confRow.hidden = false;
    const badgeColor = (score) => score >= 70 ? "#30d158" : score >= 30 ? "#ff9f0a" : "#ff453a";
    const badgeLabel = (score) => score >= 70 ? "Good" : score >= 30 ? "Fair" : "Low";
    for (const key of ["carrier", "modulation", "unwrap"]) {
      const badge = $(`fringe-conf-${key}`);
      if (!badge) continue;
      const score = data.confidence[key];
      const dot = badge.querySelector(".fringe-conf-dot");
      const val = badge.querySelector(".fringe-conf-val");
      if (dot) dot.style.background = badgeColor(score);
      if (val) {
        if (key === "carrier") val.textContent = badgeLabel(score);
        else val.textContent = Math.round(score) + "%";
      }
    }
  }

  // M1.6: trusted-area badge. Shown independently of data.confidence so
  // it appears whenever the backend reports it.
  if (Number.isFinite(data.trusted_area_pct)) {
    const confRow = $("fringe-confidence-row");
    if (confRow) confRow.hidden = false;
    const trustedBadge = $("fringe-conf-trusted");
    const trustedVal = $("fringe-trusted-area");
    if (trustedVal) trustedVal.textContent = data.trusted_area_pct.toFixed(1) + "%";
    if (trustedBadge) {
      const dot = trustedBadge.querySelector(".fringe-conf-dot");
      if (dot) dot.style.background = trustedBadgeColor(data.trusted_area_pct);
    }
  }

  // Cache height grid for measurements. M1.3: prefer the explicit
  // display_height_grid_nm when present, fall back to legacy height_grid.
  const displayGrid = data.display_height_grid_nm ?? data.height_grid;
  if (displayGrid) {
    fr.heightGrid = new Float32Array(displayGrid);
    fr.maskGrid = new Uint8Array(data.mask_grid);
    if (data.trusted_mask_grid) fr.trustedMaskGrid = new Uint8Array(data.trusted_mask_grid);
    fr.gridRows = data.grid_rows;
    fr.gridCols = data.grid_cols;
  }

  // Surface map
  const surfaceContent = $("fringe-surface-content");
  const empty = $("fringe-empty");
  if (surfaceContent && data.surface_map) {
    surfaceContent.hidden = false;
    if (empty) empty.hidden = true;
    resetSurfaceZoom();
    const surfImg = $("fringe-surface-img");
    surfImg.onload = () => {
      drawPeakValleyMarkers();
      // Recompute the untrusted-pixel overlay every time the surface PNG
      // changes (new analyze, reanalyze, overlay-toggle PNG swap).
      refreshTrustedOverlay();
    };
    surfImg.src = "data:image/png;base64," + data.surface_map;
  }

  // Cache confidence map sources for overlay toggles
  if (data.confidence_maps && data.surface_map) {
    const surfImg = $("fringe-surface-img");
    if (surfImg) {
      surfImg.dataset.surfaceSrc = "data:image/png;base64," + data.surface_map;
      surfImg.dataset.confidenceSrc = "data:image/png;base64," + data.confidence_maps.composite;
      surfImg.dataset.modulationSrc = "data:image/png;base64," + (data.modulation_map || "");
    }
    const toggles = $("fringe-overlay-toggles");
    if (toggles) toggles.hidden = false;
  }

  // Zernike chart
  const zernikeContent = $("fringe-zernike-content");
  const zernikeEmpty = $("fringe-zernike-empty");
  if (zernikeContent && data.zernike_chart) {
    zernikeContent.hidden = false;
    if (zernikeEmpty) zernikeEmpty.hidden = true;
    $("fringe-zernike-chart").src = "data:image/png;base64," + data.zernike_chart;

    // Build grouped Zernike coefficient table (M4.2).
    const tableContainer = $("fringe-zernike-table-container");
    if (tableContainer && fr.lastResult) {
      tableContainer.innerHTML = _renderZernikeTable(fr.lastResult);
      _wireZernikeTableToggles(tableContainer);
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

  // M1.6: keep trusted-only PV/RMS + overlay consistent across renders.
  refreshTrustedOnlyDisplay();
}

// ── Per-term Zernike table (M4.2) ──────────────────────────────────────

// Group definition: each row's Noll indices, plus a label and tooltip.
// "Higher" collapses j ≥ 12 into one row by default with an expand toggle.
const _ZERNIKE_GROUPS = [
  { id: "piston",     label: "Piston",        terms: [1] },
  { id: "tilt",       label: "Tilt",          terms: [2, 3] },
  { id: "defocus",    label: "Defocus",       terms: [4] },
  { id: "astig",      label: "Astigmatism",   terms: [5, 6] },
  { id: "coma",       label: "Coma",          terms: [7, 8] },
  { id: "trefoil",    label: "Trefoil",       terms: [9, 10] },
  { id: "spherical",  label: "Spherical",     terms: [11] },
  // M4.2: 4th order and beyond live behind a single "Higher" row that
  // expands on click. Default collapsed so the dominant terms stay visible.
  { id: "higher",     label: "Higher (\u22654th order)", terms: null },
];

// Local UI state for the Zernike table — which higher-order group is expanded.
let _zernikeHigherExpanded = false;

function _renderZernikeTable(result) {
  const coeffs = result.coefficients || [];
  if (coeffs.length === 0) return "";
  const names = result.coefficient_names || {};
  const subtracted = new Set((result.subtracted_terms || []).map(Number));
  const rmsNm = result.zernike_rms_nm || [];
  const wl = result.wavelength_nm || 632.8;

  const _esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const _coeffNm = (c) => c * wl / (4 * Math.PI);
  const _termRmsNm = (i) => Number.isFinite(rmsNm[i]) ? rmsNm[i] : Math.abs(_coeffNm(coeffs[i]));

  // Render one row for a Zernike term j (1-based Noll).
  const _renderTermRow = (j) => {
    const i = j - 1;
    if (i >= coeffs.length) return "";
    const name = names[String(j)] || `Z${j}`;
    const coeff = coeffs[i];
    const surfNm = _coeffNm(coeff);
    const trms = _termRmsNm(i);
    const isSub = subtracted.has(j);
    const cls = isSub ? "fringe-z-subtracted" : "";
    const subBadge = isSub ? " <span style='font-size:10px;opacity:0.8'>(sub)</span>" : "";
    return `<tr class="${cls}">
      <td style="padding:2px 8px">${j}</td>
      <td style="padding:2px 8px">${_esc(name)}${subBadge}</td>
      <td style="padding:2px 8px;text-align:right">${coeff.toFixed(3)}</td>
      <td style="padding:2px 8px;text-align:right">${surfNm.toFixed(1)}</td>
      <td style="padding:2px 8px;text-align:right" title="Per-term RMS on the current aperture.">${trms.toFixed(1)}</td>
      <td style="padding:2px 8px;text-align:center">
        <input type="checkbox" class="fringe-z-toggle" data-noll="${j}" ${isSub ? "checked" : ""}
               title="Subtract / un-subtract this term" />
      </td>
    </tr>`;
  };

  // Build group rows. Within each group, sort by |rms_nm| desc so the
  // dominant term in the group surfaces first.
  const _groupRows = (g) => {
    const terms = g.terms ? [...g.terms] : [];
    terms.sort((a, b) => _termRmsNm(b - 1) - _termRmsNm(a - 1));
    const rows = terms.map(_renderTermRow).join("");
    return `<tbody class="fringe-z-group" data-group="${g.id}">
      <tr><th colspan="6" style="text-align:left;padding:6px 8px 2px 8px;font-size:11px;opacity:0.75;background:rgba(255,255,255,0.04)">${_esc(g.label)}</th></tr>
      ${rows}
    </tbody>`;
  };

  // "Higher" group spans j=12..coeffs.length; collapsible.
  const higherTerms = [];
  for (let j = 12; j <= coeffs.length; j++) higherTerms.push(j);
  higherTerms.sort((a, b) => _termRmsNm(b - 1) - _termRmsNm(a - 1));

  const groupSections = _ZERNIKE_GROUPS
    .filter(g => g.id !== "higher")
    .map(_groupRows)
    .join("");

  let higherSection = "";
  if (higherTerms.length > 0) {
    const expanded = _zernikeHigherExpanded;
    const arrow = expanded ? "\u25BE" : "\u25B8";
    const rows = expanded ? higherTerms.map(_renderTermRow).join("") : "";
    // Compose a small summary stat for the collapsed view: number of terms
    // and sum-of-squares RMS as a visual hint.
    let sumSq = 0;
    for (const j of higherTerms) sumSq += _termRmsNm(j - 1) ** 2;
    const summaryRms = Math.sqrt(sumSq).toFixed(1);
    higherSection = `<tbody class="fringe-z-group" data-group="higher">
      <tr>
        <th colspan="6" style="text-align:left;padding:6px 8px 2px 8px;font-size:11px;opacity:0.75;background:rgba(255,255,255,0.04);cursor:pointer" id="fringe-z-higher-toggle">
          ${arrow} Higher (\u22654th order) \u2014 ${higherTerms.length} terms, RMS \u2248 ${summaryRms} nm
        </th>
      </tr>
      ${rows}
    </tbody>`;
  }

  return `<table style="width:100%;font-size:12px;border-collapse:collapse">
    <thead>
      <tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:4px 8px">Noll</th>
        <th style="text-align:left;padding:4px 8px">Term</th>
        <th style="text-align:right;padding:4px 8px">Coeff (rad)</th>
        <th style="text-align:right;padding:4px 8px">Surface (nm)</th>
        <th style="text-align:right;padding:4px 8px" title="Per-term RMS on the current aperture.">RMS (nm)</th>
        <th style="text-align:center;padding:4px 8px" title="Toggle to subtract / restore this term">Subtract</th>
      </tr>
    </thead>
    ${groupSections}
    ${higherSection}
  </table>`;
}

function _wireZernikeTableToggles(container) {
  // Per-term toggles: rebuild the subtract_terms set and reanalyze.
  container.querySelectorAll(".fringe-z-toggle").forEach(cb => {
    cb.addEventListener("change", () => {
      const noll = parseInt(cb.dataset.noll, 10);
      if (!Number.isFinite(noll)) return;
      const sub = new Set((fr.lastResult?.subtracted_terms || []).map(Number));
      if (cb.checked) sub.add(noll);
      else sub.delete(noll);
      // Stash the new set so getSubtractTerms (driven by pillState) doesn't
      // overwrite it on the next reanalyze. Use the result's subtracted_terms
      // as the authoritative list.
      if (fr.lastResult) fr.lastResult.subtracted_terms = Array.from(sub).sort((a, b) => a - b);
      // Sync the common pills so Tilt / Defocus / etc reflect reality.
      _syncPillStateFromSubtracted(fr.lastResult.subtracted_terms);
      // Trigger a reanalyze using the merged subtract set.
      doReanalyze();
    });
  });

  // Higher-group expand/collapse toggle.
  const higherToggle = container.querySelector("#fringe-z-higher-toggle");
  if (higherToggle) {
    higherToggle.addEventListener("click", () => {
      _zernikeHigherExpanded = !_zernikeHigherExpanded;
      if (fr.lastResult) {
        container.innerHTML = _renderZernikeTable(fr.lastResult);
        _wireZernikeTableToggles(container);
      }
    });
  }
}

// Update pill toggles to match the current subtracted_terms set so the pill
// row stays consistent with per-term toggles in the table.
function _syncPillStateFromSubtracted(terms) {
  const set = new Set((terms || []).map(Number));
  for (const pill of SUBTRACT_PILLS) {
    pillState[pill.id] = pill.terms.every(t => set.has(t));
    const btn = document.querySelector(`.fringe-pill[data-pill="${pill.id}"]`);
    if (btn) btn.classList.toggle("active", pillState[pill.id]);
  }
}

// ── Subtracted-result presentation (M3.6) ───────────────────────────────

function _renderSubtractedProvenance(data) {
  // The chip lives just inside the summary bar's right-hand cluster.  We
  // maintain a single #fringe-sub-chip span and toggle its visibility.
  // Used for both "subtracted" and "average" origins (M3.3).
  const summaryBar = $("fringe-summary-bar");
  if (!summaryBar) return;
  let chip = document.getElementById("fringe-sub-chip");
  const origin = data?.origin;
  const isSub = origin === "subtracted";
  const isAvg = origin === "average";
  if (data && (isSub || isAvg)) {
    if (!chip) {
      chip = document.createElement("span");
      chip.id = "fringe-sub-chip";
      chip.style.cssText = "margin-left:8px;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;cursor:default";
      const wlEl = $("fringe-summary-wl");
      if (wlEl && wlEl.parentElement) {
        wlEl.parentElement.appendChild(chip);
      } else {
        summaryBar.appendChild(chip);
      }
    }
    const src = Array.isArray(data.source_ids) ? data.source_ids : [];
    if (isSub) {
      chip.style.background = "rgba(217,119,6,0.25)";
      chip.style.color = "#d97706";
      chip.textContent = "A − B";
      chip.title = src.length === 2
        ? `Subtracted result — measurement ${src[0]} minus reference ${src[1]}`
        : "Subtracted result";
    } else {
      chip.style.background = "rgba(13,148,136,0.25)";
      chip.style.color = "#0d9488";
      chip.textContent = `avg(${src.length})`;
      chip.title = src.length >= 2
        ? `Averaged result — sources:\n${src.join("\n")}`
        : "Averaged result";
    }
    chip.hidden = false;
  } else if (chip) {
    chip.hidden = true;
  }
}

function _renderSubtractionWarnings(data) {
  // Banner lives above the surface-map panel, prepended to the results host.
  // Covers subtract + average warnings and (for averages) rejection stats.
  let banner = document.getElementById("fringe-subtract-warnings");
  const origin = data?.origin;
  const isSub = origin === "subtracted";
  const isAvg = origin === "average";
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  const rejection = data?.rejection_stats;
  const caps = fr.sessionCaptures || [];
  const indexById = new Map();
  caps.forEach((c, i) => indexById.set(c.id, i + 1));

  // Build rejection-stats per-layer readout (skip 0s).
  let rejectionHtml = "";
  if (isAvg && rejection && Array.isArray(rejection.n_rejected_per_layer)) {
    const srcIds = Array.isArray(data.source_ids) ? data.source_ids : [];
    const lines = [];
    rejection.n_rejected_per_layer.forEach((n, i) => {
      if (!n) return;
      const sid = srcIds[i];
      const idx = sid ? indexById.get(sid) : null;
      const tag = idx != null ? `#${idx}` : (sid ? _escapeHtml(sid.slice(0, 6)) : `layer ${i + 1}`);
      lines.push(`<li>rejected ${n.toLocaleString()} pixel${n === 1 ? "" : "s"} from capture ${tag}</li>`);
    });
    if (lines.length) {
      rejectionHtml = `<div style="margin-top:6px;font-size:11px;opacity:0.9">
        <strong>Outlier rejection (${data.rejection_method || "—"}, threshold ${Number(data.rejection_threshold || 0).toFixed(1)}):</strong>
        <ul style="margin:2px 0 0 0;padding-left:20px">${lines.join("")}</ul>
      </div>`;
    }
  }

  const show = (isSub || isAvg) && (warnings.length > 0 || rejectionHtml);
  if (!show) {
    if (banner) banner.hidden = true;
    return;
  }

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fringe-subtract-warnings";
    banner.style.cssText = "margin:6px 12px;padding:8px 12px;border-radius:4px;background:rgba(255,159,10,0.15);border:1px solid rgba(255,159,10,0.45);color:#ff9f0a;font-size:12px;line-height:1.45";
    const tabBar = $("fringe-tab-bar");
    if (tabBar && tabBar.parentElement) {
      tabBar.parentElement.insertBefore(banner, tabBar);
    } else {
      document.body.appendChild(banner);
    }
  }
  const title = isSub ? "Subtraction warnings" : "Average warnings";
  const items = warnings.map(w => `<li>${_escapeHtml(String(w))}</li>`).join("");
  const warnHtml = warnings.length
    ? `<strong>${title}:</strong><ul style="margin:4px 0 0 0;padding-left:20px">${items}</ul>`
    : "";
  banner.innerHTML = warnHtml + rejectionHtml;
  banner.hidden = false;
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

  // Enhanced carrier diagnostics
  if (carrier.snr_db != null) {
    const snrEl = $("fringe-diag-snr");
    if (snrEl) snrEl.textContent = carrier.snr_db.toFixed(1) + " dB";
  }
  if (carrier.dc_margin_px != null) {
    const dcEl = $("fringe-diag-dc-margin");
    if (dcEl) dcEl.textContent = carrier.dc_margin_px.toFixed(0) + " px";
  }
  const alts = carrier.candidates || carrier.alternate_peaks || [];
  const altEl = $("fringe-diag-alternates");
  if (altEl) {
    altEl.textContent = alts.length > 0
      ? alts.map((a, i) => `#${i + 1}: ${a.peak_ratio.toFixed(1)}x`).join(", ")
      : "none";
  }

  // M1.5: summary carrier-diagnostics panel under the confidence row.
  const diagRow = $("fringe-carrier-diagnostics");
  if (diagRow) {
    diagRow.hidden = false;
    const chosen = carrier.chosen || {
      fringe_period_px: carrier.fringe_period_px,
      fringe_angle_deg: carrier.fringe_angle_deg,
      distance_px: carrier.distance_px,
    };
    const conf = carrier.confidence || {
      peak_ratio: carrier.peak_ratio,
      snr_db: carrier.snr_db,
      dc_margin_px: carrier.dc_margin_px,
    };
    const fmtNum = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : "--";
    $("fringe-diag-chosen-period").textContent = fmtNum(chosen.fringe_period_px, 1);
    $("fringe-diag-chosen-angle").textContent = fmtNum(chosen.fringe_angle_deg, 1);
    $("fringe-diag-chosen-dist").textContent = fmtNum(chosen.distance_px, 1);
    $("fringe-diag-conf-ratio").textContent = fmtNum(conf.peak_ratio, 2);
    $("fringe-diag-conf-snr").textContent = fmtNum(conf.snr_db, 1);
    $("fringe-diag-conf-dc").textContent = fmtNum(conf.dc_margin_px, 0);

    const overrideBadge = $("fringe-diag-override-badge");
    if (overrideBadge) overrideBadge.hidden = !carrier.override;

    // M2.5: surface the tuning parameters the server actually used.
    const tuningEl = $("fringe-diag-tuning");
    if (tuningEl) {
      const t = data.tuning;
      if (t) {
        const sigma = t.lpf_sigma_frac == null ? "auto" : Number(t.lpf_sigma_frac).toFixed(2);
        const dc = t.dc_margin_override == null ? "auto" : String(t.dc_margin_override);
        const mask = t.mask_threshold == null ? "--" : Number(t.mask_threshold).toFixed(2);
        tuningEl.textContent = `tuning: \u03C3=${sigma} \u00B7 dc=${dc} \u00B7 mask=${mask}`;
        tuningEl.hidden = false;
      } else {
        tuningEl.hidden = true;
      }
    }

    const altsList = $("fringe-diag-alternates-list");
    if (altsList) {
      if (alts.length > 0) {
        altsList.innerHTML = alts.map((a, i) => {
          const period = Number.isFinite(a.fringe_period_px) ? a.fringe_period_px.toFixed(1) : "--";
          const angle = Number.isFinite(a.fringe_angle_deg) ? a.fringe_angle_deg.toFixed(1) : "--";
          const ratio = Number.isFinite(a.peak_ratio) ? a.peak_ratio.toFixed(1) : "--";
          return `<span>#${i + 1}: period ${period} px &middot; angle ${angle}&deg; &middot; ratio vs chosen ${ratio}&times;</span>`;
        }).join("");
      } else {
        altsList.innerHTML = "<span>No alternate peaks</span>";
      }
    }
  }

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

  // Unwrap risk map
  if (data.confidence_maps && data.confidence_maps.unwrap_risk) {
    const riskImg = $("fringe-unwrap-risk-img");
    if (riskImg) riskImg.src = "data:image/png;base64," + data.confidence_maps.unwrap_risk;
  }

  // Unwrap statistics
  if (data.unwrap_stats) {
    const us = data.unwrap_stats;
    const relEl = $("fringe-diag-reliable");
    if (relEl) relEl.textContent = us.n_reliable.toLocaleString();
    const corEl = $("fringe-diag-corrected");
    if (corEl) corEl.textContent = us.n_corrected.toLocaleString();
    const edgeEl = $("fringe-diag-edge-risk");
    if (edgeEl) edgeEl.textContent = us.n_edge_risk.toLocaleString();
  }

  // Overall assessment
  if (data.confidence) {
    const assessEl = $("fringe-diag-assessment");
    if (assessEl) {
      const c = data.confidence;
      const stages = [["carrier", c.carrier], ["modulation", c.modulation], ["unwrap", c.unwrap]];
      const weakest = stages.sort((a, b) => a[1] - b[1])[0];
      let msg, bg;
      if (c.overall >= 70) {
        msg = "Result is reliable.";
        bg = "rgba(48,209,88,0.15)";
      } else if (c.overall >= 30) {
        const advice = {
          carrier: "Fringe pattern may be weak. Consider adjusting flat angle for better contrast.",
          modulation: "Modulation is marginal. Check illumination and flat contact.",
          unwrap: "Some unwrap uncertainty. Check surface map for discontinuities.",
        };
        msg = `${weakest[0].charAt(0).toUpperCase() + weakest[0].slice(1)} is marginal \u2014 ${advice[weakest[0]] || "review diagnostics."}`;
        bg = "rgba(255,159,10,0.15)";
      } else {
        const advice = {
          carrier: "Fringe pattern is weak or ambiguous. Improve fringe contrast or adjust the optical flat angle.",
          modulation: "Too few pixels with usable fringes. Check illumination and flat contact.",
          unwrap: "Phase unwrapping had difficulty. Check surface map for discontinuities.",
        };
        msg = `${weakest[0].charAt(0).toUpperCase() + weakest[0].slice(1)} is poor \u2014 ${advice[weakest[0]] || "review diagnostics."}`;
        bg = "rgba(255,69,58,0.15)";
      }
      assessEl.textContent = msg;
      assessEl.style.background = bg;
      assessEl.style.display = "block";
    }
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
    const imgH = fr.lastResult.image_height || fr.lastResult.surface_height;
    const imgW = fr.lastResult.image_width || fr.lastResult.surface_width;
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
          lpf_sigma_frac: getLpfSigmaFrac(),
          dc_margin_override: getDcMarginOverride(),
          subtract_terms: getSubtractTerms(),
          n_zernike: 36,
          mask_polygons: _buildCarrierMaskPayload(),
          lens_k1: fr.lensK1,
          correct_2pi_jumps: getCorrect2piJumps(),
          image_b64: fr.droppedImageB64 || undefined,
          calibration: getCalibrationPayload(),
          aperture_recipe: _getAperturePayloadOrNull(),
        }),
      });
      if (!resp.ok) { console.warn("Carrier override failed"); return; }
      const data = await resp.json();
      fr.lastResult = data;
      renderResults(data);
      updateCarrierDisplay(data);
      $("fringe-btn-carrier-reset").hidden = false;
      fr.carrierOverride = { y: carrierY, x: carrierX };
      // M1.7: reanalyze-carrier doesn't append a capture, but refreshing keeps
      // the sidebar consistent if another tab/window made changes.
      fetchSessionCaptures();
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

  // Carrier row clicks -> switch to diagnostics tab
  $("fringe-carrier-row")?.addEventListener("click", () => {
    document.querySelectorAll(".fringe-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".fringe-tab-panel").forEach(p => p.hidden = true);
    const diagTab = document.querySelector('.fringe-tab[data-tab="diagnostics"]');
    if (diagTab) diagTab.classList.add("active");
    const panel = $("fringe-panel-diagnostics");
    if (panel) panel.hidden = false;
  });
}

// ── Profiles ────────────────────────────────────────────────────────────

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

// ── MTF chart ───────────────────────────────────────────────────────────

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

  // Build per-vertex mask: true if this vertex has valid height data
  const vertexValid = new Uint8Array(gridSize * gridSize);
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const gx = (c / (gridSize - 1)) * (fr.gridCols - 1);
      const gy = (r / (gridSize - 1)) * (fr.gridRows - 1);
      const gi = Math.round(gy) * fr.gridCols + Math.round(gx);
      vertexValid[r * gridSize + c] = fr.maskGrid[gi] ? 1 : 0;
    }
  }

  // Filter index buffer: keep only triangles where ALL vertices are valid
  const origIndex = geo.index.array;
  const kept = [];
  for (let i = 0; i < origIndex.length; i += 3) {
    const a = origIndex[i], b = origIndex[i + 1], c = origIndex[i + 2];
    if (vertexValid[a] && vertexValid[b] && vertexValid[c]) {
      kept.push(a, b, c);
    }
  }
  geo.setIndex(kept);

  const zSlider = $("fringe-3d-z-scale");
  const zLabel = $("fringe-3d-z-val");
  let zScale = zSlider ? parseFloat(zSlider.value) : 10;

  function applyZ() {
    let zMin = Infinity, zMax = -Infinity;
    const zVals = new Float32Array(gridSize * gridSize);
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
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

// ── Analysis ────────────────────────────────────────────────────────────

/**
 * Project a full analyze response down to the WavefrontResult envelope.
 *
 * Stage-1 of the M1.1 migration: the server returns envelope fields
 * (id, origin, source_ids, captured_at, calibration_snapshot, warnings,
 * aperture_recipe, raw_height_grid_nm, raw_mask_grid) alongside every
 * existing field. This helper hands callers the envelope subset without
 * the heavy PNG/base64 render outputs, so downstream code that doesn't
 * care about display payload can work with the pure data model.
 *
 * Returns null if result is falsy. Accepts stage-1 responses without
 * envelope fields by falling back to height_grid/mask_grid.
 */
export function wavefrontView(result) {
  if (!result) return null;
  return {
    id: result.id ?? null,
    origin: result.origin ?? "capture",
    source_ids: Array.isArray(result.source_ids) ? result.source_ids : [],
    captured_at: result.captured_at ?? null,
    calibration_snapshot: result.calibration_snapshot ?? null,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    aperture_recipe: result.aperture_recipe ?? null,
    raw_height_grid_nm: result.raw_height_grid_nm ?? result.height_grid ?? null,
    raw_mask_grid: result.raw_mask_grid ?? result.mask_grid ?? null,
    grid_rows: result.grid_rows ?? null,
    grid_cols: result.grid_cols ?? null,
    surface_height: result.surface_height ?? null,
    surface_width: result.surface_width ?? null,
    wavelength_nm: result.wavelength_nm ?? null,
    pv_nm: result.pv_nm ?? null,
    rms_nm: result.rms_nm ?? null,
  };
}

/**
 * Merge reanalyze API response fields into fr.lastResult.
 * Used by doReanalyze, invertWavefront, and recomputeAverage (in fringe-panel.js).
 */
export function mergeReanalyzeResult(data) {
  for (const key of [
    "surface_map", "zernike_chart", "profile_x", "profile_y",
    "pv_nm", "rms_nm", "pv_waves", "rms_waves", "subtracted_terms",
    "height_grid", "display_height_grid_nm", "raw_height_grid_nm",
    "mask_grid", "trusted_mask_grid", "trusted_area_pct",
    "grid_rows", "grid_cols",
  ]) {
    if (data[key] !== undefined) fr.lastResult[key] = data[key];
  }
  if (data.strehl !== undefined) fr.lastResult.strehl = data.strehl;
  if (data.psf) fr.lastResult.psf = data.psf;
  if (data.mtf) fr.lastResult.mtf = data.mtf;

  // Refresh cached typed arrays so the Step tool and 3D view see the
  // post-subtraction surface, not the stale pre-reanalyze grid. M1.3:
  // prefer the explicit display grid when present; fall back to the
  // legacy height_grid for stage-1 responses.
  const displayGrid = data.display_height_grid_nm ?? data.height_grid;
  if (displayGrid) {
    fr.heightGrid = new Float32Array(displayGrid);
    fr.maskGrid = new Uint8Array(data.mask_grid);
    if (data.trusted_mask_grid) fr.trustedMaskGrid = new Uint8Array(data.trusted_mask_grid);
    fr.gridRows = data.grid_rows;
    fr.gridCols = data.grid_cols;
  }
  // M1.6: keep trusted-only PV/RMS + overlay consistent across reanalyze.
  refreshTrustedOnlyDisplay();
}

async function doReanalyze() {
  if (!fr.lastResult) return;
  try {
    const body = {
      coefficients: fr.lastResult.coefficients,
      subtract_terms: getSubtractTerms(),
      wavelength_nm: getWavelength(),
      surface_height: fr.lastResult.surface_height || 128,
      surface_width: fr.lastResult.surface_width || 128,
      form_model: formModel,
    };
    // Full-fidelity path: supply the raw height grid so the backend refits
    // Zernike on the real data and preserves high-frequency content in the
    // displayed surface map. Without these, the backend falls back to the
    // legacy coefficient-only reconstruction which discards detail beyond
    // what the Zernike basis can represent. See M1.3.
    if (fr.lastResult.raw_height_grid_nm && fr.lastResult.grid_rows && fr.lastResult.grid_cols) {
      body.raw_height_grid_nm = fr.lastResult.raw_height_grid_nm;
      body.raw_grid_rows = fr.lastResult.grid_rows;
      body.raw_grid_cols = fr.lastResult.grid_cols;
    }
    const r = await apiFetch("/fringe/reanalyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return;
    const data = await r.json();
    mergeReanalyzeResult(data);
    renderResults(fr.lastResult);
  } catch (e) {
    console.warn("Re-analyze error:", e);
  }
}

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
    const body = {
      coefficients: inverted,
      subtract_terms: getSubtractTerms(),
      wavelength_nm: getWavelength(),
      surface_height: fr.lastResult.surface_height || 128,
      surface_width: fr.lastResult.surface_width || 128,
      form_model: formModel,
    };
    // Full-fidelity path — invert the raw grid too so high-frequency content
    // is preserved in the displayed (inverted) surface map.
    if (fr.lastResult.raw_height_grid_nm && fr.lastResult.grid_rows && fr.lastResult.grid_cols) {
      body.raw_height_grid_nm = fr.lastResult.raw_height_grid_nm.map(v => -v);
      body.raw_grid_rows = fr.lastResult.grid_rows;
      body.raw_grid_cols = fr.lastResult.grid_cols;
    }
    const r = await apiFetch("/fringe/reanalyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return;
    const data = await r.json();
    mergeReanalyzeResult(data);
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

// ── Calibration indicator + prompt flow ─────────────────────────────────

/** Refresh the summary-bar indicator from the active calibration. */
export function updateCalibrationIndicator() {
  const wlEl = $("fringe-summary-wl");
  if (!wlEl) return;
  const active = getActiveCalibration();
  if (active) {
    const wl = Number.isFinite(active.wavelength_nm) ? active.wavelength_nm : "--";
    wlEl.textContent = `${active.name} \u00B7 ${wl} nm`;
    wlEl.title = `Active calibration\nmm/px: ${active.mm_per_pixel || 0}\nmethod: ${active.method || "--"}`;
  } else {
    wlEl.textContent = "-- nm";
  }
  // Keep the wavelength <select> / custom input in sync when possible.
  const sel = $("fringe-wavelength");
  if (sel && active) {
    const nm = Number(active.wavelength_nm);
    let matched = false;
    for (const opt of sel.options) {
      if (opt.dataset && Number(opt.dataset.nm) === nm) {
        sel.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) {
      sel.value = "custom";
      const custom = $("fringe-custom-wl");
      if (custom) custom.value = String(nm);
      const label = $("fringe-custom-wl-label");
      if (label) label.hidden = false;
    }
  }
}

function _promptPickCalibration() {
  const list = listCalibrations();
  const active = getActiveCalibration();
  const lines = list.map((c, i) =>
    `${i + 1}. ${c.name} (${c.wavelength_nm} nm)${c.id === active.id ? "  [active]" : ""}`
  ).join("\n");
  const raw = window.prompt(
    `Active: ${active.name}\n\nCalibrations:\n${lines}\n\n` +
    `Enter a number to select, "new" to create, "delete <n>" to remove:`,
    ""
  );
  if (raw === null) return;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return;

  if (trimmed === "new") {
    const name = window.prompt("New calibration name:", "Untitled");
    if (!name) return;
    const wlStr = window.prompt("Wavelength (nm):", String(active.wavelength_nm || 589.3));
    if (!wlStr) return;
    const wl = parseFloat(wlStr);
    if (!Number.isFinite(wl) || wl <= 0) {
      window.alert("Invalid wavelength.");
      return;
    }
    try {
      const created = saveCalibration({ name, wavelength_nm: wl, method: "manual" });
      setActiveCalibrationId(created.id);
      updateCalibrationIndicator();
    } catch (e) {
      window.alert("Could not save: " + e.message);
    }
    return;
  }

  if (trimmed.startsWith("delete")) {
    const parts = trimmed.split(/\s+/);
    const n = parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(n) || n < 1 || n > list.length) {
      window.alert("Invalid index.");
      return;
    }
    if (list.length === 1) {
      window.alert("Cannot delete the last calibration.");
      return;
    }
    const victim = list[n - 1];
    if (!window.confirm(`Delete "${victim.name}"?`)) return;
    deleteCalibration(victim.id);
    updateCalibrationIndicator();
    return;
  }

  // Numeric pick
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > list.length) {
    window.alert("Invalid selection.");
    return;
  }
  setActiveCalibrationId(list[n - 1].id);
  updateCalibrationIndicator();
  // Re-analyze if we have results so wavelength change is reflected.
  if (fr.lastResult && typeof window !== 'undefined') {
    // Use the existing reanalyze-cheap path via the form model change.
    doReanalyze();
  }
}

function _handleExportCalibrations() {
  try {
    const json = exportCalibrationsJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `loupe-fringe-calibrations-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    window.alert("Export failed: " + e.message);
  }
}

function _handleImportCalibrations(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = importCalibrationsJson(String(reader.result || ""));
    const msg = result.errors.length > 0
      ? `Imported ${result.added} calibration(s).\nErrors:\n- ${result.errors.join("\n- ")}`
      : `Imported ${result.added} calibration(s).`;
    window.alert(msg);
    updateCalibrationIndicator();
  };
  reader.onerror = () => window.alert("Could not read file.");
  reader.readAsText(file);
}

// ── Session captures sidebar (M1.7) ─────────────────────────────────────

const ORIGIN_BADGE_STYLE = {
  capture:        "background:#3a3a3c;color:#e8e8e8",
  average:        "background:#0d9488;color:#ffffff",
  subtracted:     "background:#d97706;color:#ffffff",
  reconstruction: "background:#475569;color:#ffffff",
};

// M3.3 — session select-mode (for averaging). Held as module-level state so
// renderSessionPanel can key off it without threading a context through.
let _selectMode = false;
const _selectedIds = new Set();

function _setSelectMode(on) {
  _selectMode = !!on;
  if (!on) _selectedIds.clear();
  renderSessionPanel();
}
function _toggleSelected(id) {
  if (!id) return;
  if (_selectedIds.has(id)) _selectedIds.delete(id);
  else _selectedIds.add(id);
  renderSessionPanel();
}

function _relativeTime(iso) {
  if (!iso) return "--";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const s = Math.floor(diffMs / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d ago";
  // Fall back to ISO for old captures (locale may not be available here).
  try {
    return new Date(t).toLocaleString();
  } catch (_e) {
    return iso;
  }
}

function _fmtNum(v, digits = 1) {
  return Number.isFinite(v) ? v.toFixed(digits) : "--";
}

function _escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function fetchSessionCaptures() {
  try {
    const r = await apiFetch("/fringe/session/captures");
    if (!r.ok) return;
    const data = await r.json();
    fr.sessionCaptures = Array.isArray(data.captures) ? data.captures : [];
    renderSessionPanel();
    // M4.5: keep the trend chart fresh whenever the captures list changes,
    // even if the user is currently looking at it.
    const trendPanel = $("fringe-panel-trend");
    if (trendPanel && !trendPanel.hidden) _renderTrendTab();
  } catch (e) {
    console.warn("Session captures fetch failed:", e);
  }
}

async function clearSession() {
  if (!window.confirm("Clear all captures from this session? This cannot be undone.")) return;
  try {
    const r = await apiFetch("/fringe/session/clear", { method: "POST" });
    if (!r.ok) {
      console.warn("Clear session failed");
      return;
    }
    fr.selectedCaptureId = null;
  } catch (e) {
    console.warn("Clear session error:", e);
  }
  await fetchSessionCaptures();
}

function renderSessionPanel() {
  const list = $("fringe-session-list");
  const count = $("fringe-session-count");
  const caps = fr.sessionCaptures || [];
  if (count) count.textContent = `${caps.length} capture${caps.length === 1 ? "" : "s"} in this session`;

  // M3.3: toolbar state — "Select for average…" becomes "Average N selected"
  // while in select mode; a cancel link becomes visible.
  const avgBtn = $("fringe-session-avg-mode");
  const cancelLink = $("fringe-session-avg-cancel");
  if (avgBtn) {
    if (_selectMode) {
      const n = _selectedIds.size;
      avgBtn.textContent = `Average ${n} selected`;
      avgBtn.disabled = n < 2;
      avgBtn.style.opacity = n < 2 ? "0.5" : "1";
      avgBtn.style.cursor = n < 2 ? "not-allowed" : "pointer";
      avgBtn.title = n < 2 ? "Pick at least 2 captures" : `Average ${n} selected captures`;
    } else {
      avgBtn.textContent = "Select for average…";
      avgBtn.disabled = caps.length < 2;
      avgBtn.style.opacity = caps.length < 2 ? "0.5" : "1";
      avgBtn.style.cursor = caps.length < 2 ? "not-allowed" : "pointer";
      avgBtn.title = caps.length < 2
        ? "Need at least 2 captures to average"
        : "Pick 2 or more captures to average";
    }
  }
  if (cancelLink) cancelLink.hidden = !_selectMode;

  if (!list) return;

  if (caps.length === 0) {
    list.innerHTML = `<div style="opacity:0.6;text-align:center;padding:24px 8px">No captures yet &mdash; run an analysis.</div>`;
    _renderCaptureDetail(null);
    return;
  }

  // Drop stale selections (captures that were evicted since last tick).
  if (_selectMode) {
    const liveIds = new Set(caps.map(c => c.id));
    for (const id of Array.from(_selectedIds)) {
      if (!liveIds.has(id)) _selectedIds.delete(id);
    }
  }

  // Index map by id so subtracted tiles can resolve their source-capture numbers.
  const indexById = new Map();
  caps.forEach((c, i) => indexById.set(c.id, i + 1));

  // Compare is enabled whenever there are >= 2 captures in the session
  // (chain-subtract supports capture / average / subtracted origins).
  const compareEnabled = caps.length >= 2;

  // Oldest first; tiles number 1..N.
  const rows = caps.map((c, i) => {
    const n = i + 1;
    const origin = c.origin || "capture";
    const badgeStyle = ORIGIN_BADGE_STYLE[origin] || ORIGIN_BADGE_STYLE.capture;
    const calName = c.calibration_snapshot && c.calibration_snapshot.name;
    const calTag = calName
      ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(255,255,255,0.08);opacity:0.8;margin-left:4px" title="Calibration: ${_escapeHtml(calName)}">${_escapeHtml(calName)}</span>`
      : "";
    const rel = _escapeHtml(_relativeTime(c.captured_at));
    const pv = _fmtNum(c.pv_nm, 1);
    const rms = _fmtNum(c.rms_nm, 1);
    const wl = Number.isFinite(c.wavelength_nm) ? c.wavelength_nm.toFixed(1) : "--";
    const isActive = c.id === fr.selectedCaptureId;
    const activeStyle = isActive ? "border:1px solid #4a9eff;background:rgba(74,158,255,0.08)" : "border:1px solid var(--border)";

    // M3.6 / M3.3: show source links on subtracted ("A − B") and averaged
    // ("sources: #A, #B, #C") tiles.
    let sourceLinks = "";
    if (origin === "subtracted" && Array.isArray(c.source_ids) && c.source_ids.length === 2) {
      const [mId, rId] = c.source_ids;
      const mN = indexById.get(mId);
      const rN = indexById.get(rId);
      const mTxt = mN != null ? `#${mN}` : "?";
      const rTxt = rN != null ? `#${rN}` : "?";
      sourceLinks = `
        <div style="margin-top:3px;font-size:10px;opacity:0.75">
          sources:
          <a href="#" class="fringe-session-source" data-capture-id="${_escapeHtml(mId)}"
             style="color:#4a9eff;text-decoration:underline;margin:0 2px" title="${_escapeHtml(mId)}">${mTxt}</a>
          &minus;
          <a href="#" class="fringe-session-source" data-capture-id="${_escapeHtml(rId)}"
             style="color:#4a9eff;text-decoration:underline;margin:0 2px" title="${_escapeHtml(rId)}">${rTxt}</a>
        </div>`;
    } else if (origin === "average" && Array.isArray(c.source_ids) && c.source_ids.length >= 2) {
      const srcIds = c.source_ids;
      const visible = srcIds.slice(0, 5);
      const overflow = srcIds.length - visible.length;
      const links = visible.map((sid, idx) => {
        const sN = indexById.get(sid);
        const txt = sN != null ? `#${sN}` : "?";
        const sep = idx === 0 ? "" : ", ";
        return `${sep}<a href="#" class="fringe-session-source" data-capture-id="${_escapeHtml(sid)}"
             style="color:#4a9eff;text-decoration:underline;margin:0 2px" title="${_escapeHtml(sid)}">${txt}</a>`;
      }).join("");
      const more = overflow > 0 ? `<span style="opacity:0.65">&hellip; +${overflow} more</span>` : "";
      sourceLinks = `
        <div style="margin-top:3px;font-size:10px;opacity:0.75">
          sources: ${links}${more}
        </div>`;
    }

    const compareTitle = compareEnabled
      ? "Subtract another capture from this one"
      : "Need at least 2 captures to compare";
    const compareStyle = compareEnabled
      ? "padding:1px 8px;font-size:10px;cursor:pointer"
      : "padding:1px 8px;font-size:10px;opacity:0.4;cursor:not-allowed";
    const compareDisabled = compareEnabled ? "" : "disabled";

    // M3.3: select-mode checkbox column.
    const selected = _selectMode && _selectedIds.has(c.id);
    const checkbox = _selectMode
      ? `<input type="checkbox" class="fringe-session-check" data-capture-id="${_escapeHtml(c.id)}"
              ${selected ? "checked" : ""}
              style="margin-right:4px;transform:scale(1.1);cursor:pointer" />`
      : "";

    // In select mode, highlight selected tile.
    const tileStyle = _selectMode && selected
      ? "border:1px solid #0d9488;background:rgba(13,148,136,0.10)"
      : activeStyle;

    // Hide the action button row while in select mode (UI is all about
    // picking tiles; dialog runs from the toolbar button).
    const actionRow = _selectMode ? "" : `
        <div style="display:flex;gap:6px;margin-top:5px">
          <button class="fringe-pill fringe-session-compare" data-capture-id="${_escapeHtml(c.id)}"
                  ${compareDisabled} style="${compareStyle}"
                  title="${compareTitle}">Compare</button>
          <button class="fringe-pill fringe-session-export" data-capture-id="${_escapeHtml(c.id)}"
                  style="padding:2px 8px;font-size:10px"
                  title="Download this capture (full grids) as JSON">Export \u2b07</button>
        </div>`;

    return `
      <div class="fringe-session-tile" data-capture-id="${_escapeHtml(c.id)}"
           style="${tileStyle};border-radius:6px;padding:6px 8px;cursor:pointer;font-size:12px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          ${checkbox}
          <span style="font-weight:600;opacity:0.85">#${n}</span>
          <span style="display:inline-block;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:600;${badgeStyle}">${_escapeHtml(origin)}</span>
          ${calTag}
          <span style="margin-left:auto;font-size:10px;opacity:0.65" title="${_escapeHtml(c.captured_at || "")}">${rel}</span>
        </div>
        <div style="display:flex;gap:12px;font-size:11px;opacity:0.9">
          <span>PV <strong>${pv}</strong> nm</span>
          <span>RMS <strong>${rms}</strong> nm</span>
          <span>&lambda; ${wl} nm</span>
        </div>
        ${sourceLinks}
        ${actionRow}
      </div>
    `;
  }).join("");
  list.innerHTML = rows;

  // Wire Compare buttons (M3.6).
  list.querySelectorAll(".fringe-session-compare").forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.captureId;
      if (id) _openCompareDialog(id);
    });
  });

  // M3.7: per-tile Export buttons.
  list.querySelectorAll(".fringe-session-export").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.captureId;
      if (!id) return;
      try {
        const resp = await apiFetch(`/fringe/session/capture/${encodeURIComponent(id)}`);
        if (!resp.ok) {
          let detail = `HTTP ${resp.status}`;
          try { detail = (await resp.json()).detail || detail; } catch (_) {}
          window.alert(`Export failed: ${detail}`);
          return;
        }
        const data = await resp.json();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        a.href = url;
        a.download = `${id}-${ts}.fringe.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        window.alert(`Export failed: ${err.message || err}`);
      }
    });
  });

  // Wire source-link clicks: switch session selection to that capture.
  list.querySelectorAll(".fringe-session-source").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = a.dataset.captureId;
      if (!id) return;
      fr.selectedCaptureId = id;
      renderSessionPanel();
    });
  });

  // M3.3: wire checkboxes explicitly so clicking them doesn't bubble to the
  // tile click handler with unintended side-effects.
  list.querySelectorAll(".fringe-session-check").forEach(cb => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = cb.dataset.captureId;
      _toggleSelected(id);
    });
  });

  // Wire tile clicks. In select mode, clicking the tile body toggles
  // the checkbox (don't require clicking the checkbox directly).
  list.querySelectorAll(".fringe-session-tile").forEach(tile => {
    tile.addEventListener("click", (e) => {
      // Ignore clicks on disabled buttons (they shouldn't fire anyway, but
      // defensive in case a future change enables them).
      if (e.target.closest("button")) return;
      if (e.target.closest("a")) return;
      const id = tile.dataset.captureId;
      if (_selectMode) {
        _toggleSelected(id);
        return;
      }
      fr.selectedCaptureId = id;
      renderSessionPanel();
    });
  });

  // Update detail panel for current selection.
  const selected = caps.find(c => c.id === fr.selectedCaptureId) || null;
  _renderCaptureDetail(selected);
}

function _renderCaptureDetail(cap) {
  const panel = $("fringe-session-detail");
  if (!panel) return;
  if (!cap) {
    panel.innerHTML = `<div style="opacity:0.6;text-align:center;padding-top:24px">Click a capture to view details.</div>`;
    return;
  }

  // Prefer a sensible field ordering for the table.
  const order = [
    "id", "origin", "captured_at", "source_ids",
    "pv_nm", "rms_nm", "pv_waves", "rms_waves", "strehl",
    "wavelength_nm", "n_valid_pixels", "n_total_pixels",
    "surface_height", "surface_width", "calibration_snapshot",
  ];
  const seen = new Set(order);
  const keys = [...order.filter(k => k in cap), ...Object.keys(cap).filter(k => !seen.has(k))];

  const fmtVal = (k, v) => {
    if (v == null) return "<span style='opacity:0.5'>--</span>";
    if (Array.isArray(v)) return _escapeHtml(v.length === 0 ? "[]" : v.join(", "));
    if (typeof v === "object") {
      try { return `<pre style="margin:0;white-space:pre-wrap;font-size:10px;opacity:0.85">${_escapeHtml(JSON.stringify(v, null, 2))}</pre>`; }
      catch (_e) { return _escapeHtml(String(v)); }
    }
    if (typeof v === "number") {
      if (k.endsWith("_nm") || k.endsWith("_waves") || k === "strehl") return _fmtNum(v, k.endsWith("_waves") ? 4 : 3);
      return String(v);
    }
    return _escapeHtml(String(v));
  };

  const rows = keys.map(k => `
    <tr>
      <td style="padding:2px 8px 2px 0;opacity:0.65;vertical-align:top;white-space:nowrap">${_escapeHtml(k)}</td>
      <td style="padding:2px 0;word-break:break-all">${fmtVal(k, cap[k])}</td>
    </tr>
  `).join("");

  panel.innerHTML = `
    <div style="font-size:12px;font-weight:600;margin-bottom:6px">Capture details</div>
    <table style="font-size:11px;border-collapse:collapse;width:100%">
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:12px;padding:8px;border-radius:4px;background:rgba(255,159,10,0.12);font-size:11px;line-height:1.4;opacity:0.9">
      Full surface map not persisted. Re-running analysis on the original image will re-create it.
      (Averaging, subtraction, and export will use the summary + session data directly when those land.)
    </div>
  `;
}

// ── Compare / Subtract dialog (M3.6) ───────────────────────────────────

/**
 * Open the inline "Subtract from #N" modal for a measurement capture.
 * Positioned fixed, backdrop-dismissable, ESC-dismissable.  On success
 * the new subtracted result is loaded into the main view.
 */
function _openCompareDialog(measurementId) {
  const caps = fr.sessionCaptures || [];
  const measurement = caps.find(c => c.id === measurementId);
  if (!measurement) return;
  if (caps.length < 2) return;

  // Default reference: first capture that isn't the measurement.
  const others = caps.filter(c => c.id !== measurementId);
  if (others.length === 0) return;
  let referenceId = others[0].id;

  // Build the DOM.
  const root = document.createElement("div");
  root.className = "fringe-compare-modal";
  root.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55)";

  const panel = document.createElement("div");
  panel.style.cssText = "background:var(--bg, #1e1e1e);color:var(--fg, #e8e8e8);border:1px solid var(--border, #444);border-radius:8px;padding:16px 18px;min-width:420px;max-width:560px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-size:12px";
  root.appendChild(panel);
  document.body.appendChild(root);

  const measIdx = caps.indexOf(measurement) + 1;
  const measPv = _fmtNum(measurement.pv_nm, 1);
  const measRms = _fmtNum(measurement.rms_nm, 1);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    root.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });

  function render() {
    const reference = caps.find(c => c.id === referenceId);
    const banners = [];
    let redCount = 0;
    let amberCount = 0;

    const mkBanner = (kind, msg) => {
      if (kind === "red") redCount++;
      else amberCount++;
      const bg = kind === "red" ? "rgba(255,69,58,0.18)" : "rgba(255,159,10,0.18)";
      const fg = kind === "red" ? "#ff453a" : "#ff9f0a";
      return `<div style="padding:6px 8px;margin:4px 0;border-radius:4px;background:${bg};color:${fg};font-weight:600;font-size:11px">${msg}</div>`;
    };

    // Shape check
    const mH = measurement.surface_height, mW = measurement.surface_width;
    const rH = reference?.surface_height, rW = reference?.surface_width;
    const shapeMatch = mH === rH && mW === rW;
    if (!shapeMatch) {
      banners.push(mkBanner("red",
        `Grid mismatch &mdash; subtraction disabled (measurement ${mH}&times;${mW} vs reference ${rH}&times;${rW}).`));
    }

    // Wavelength check
    const mWl = Number(measurement.wavelength_nm);
    const rWl = Number(reference?.wavelength_nm);
    if (Number.isFinite(mWl) && Number.isFinite(rWl) && Math.abs(mWl - rWl) > 0.1) {
      banners.push(mkBanner("amber",
        `Wavelength mismatch &mdash; results may be biased (${mWl.toFixed(2)} nm vs ${rWl.toFixed(2)} nm).`));
    }

    // Calibration mm/pixel check
    const mMpp = Number(measurement.calibration_snapshot?.mm_per_pixel);
    const rMpp = Number(reference?.calibration_snapshot?.mm_per_pixel);
    if (Number.isFinite(mMpp) && Number.isFinite(rMpp) && mMpp > 0 && rMpp > 0) {
      const diff = Math.abs(mMpp - rMpp) / Math.max(mMpp, rMpp);
      if (diff > 0.01) {
        banners.push(mkBanner("amber",
          `Calibration mm/pixel differs by ${(diff * 100).toFixed(1)}% (${mMpp.toFixed(5)} vs ${rMpp.toFixed(5)}).`));
      }
    }

    // Origin check — warn when chaining operations on derived wavefronts.
    const mOrigin = measurement.origin || "capture";
    const rOrigin = reference?.origin || "capture";
    if (mOrigin === "subtracted") {
      banners.push(mkBanner("amber",
        `You're subtracting from a subtracted result. This is a second-order difference &mdash; interpretation depends on the original chain.`));
    }
    if (rOrigin === "subtracted") {
      banners.push(mkBanner("amber",
        `Reference is a subtracted result. This is a second-order difference &mdash; interpretation depends on the original chain.`));
    }
    if (rOrigin === "average") {
      banners.push(mkBanner("amber",
        `Reference is an averaged result. Ensure it represents the intended systematic (e.g., flat-only, not sample-included).`));
    }

    // Reference picker options — default selection matches referenceId.
    const options = others.map(c => {
      const n = caps.indexOf(c) + 1;
      const origin = c.origin || "capture";
      const pv = _fmtNum(c.pv_nm, 1);
      const rms = _fmtNum(c.rms_nm, 1);
      const age = _escapeHtml(_relativeTime(c.captured_at));
      const sel = c.id === referenceId ? " selected" : "";
      return `<option value="${_escapeHtml(c.id)}"${sel}>#${n} · PV ${pv} nm · RMS ${rms} nm · ${_escapeHtml(origin)} · ${age}</option>`;
    }).join("");

    const mNValid = Number.isFinite(measurement.n_valid_pixels) ? measurement.n_valid_pixels.toLocaleString() : "--";
    const rNValid = Number.isFinite(reference?.n_valid_pixels) ? reference.n_valid_pixels.toLocaleString() : "--";

    const summaryLine = `<div style="font-size:11px;opacity:0.8;margin-top:6px">${banners.length} warning${banners.length === 1 ? "" : "s"} (${redCount} blocking, ${amberCount} advisory).</div>`;

    panel.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
        <div style="font-size:14px;font-weight:600">Subtract from #${measIdx}</div>
        <div style="font-size:11px;opacity:0.75">PV ${measPv} nm · RMS ${measRms} nm</div>
        <button id="_cmp-x" style="margin-left:auto;background:none;border:none;color:inherit;font-size:16px;cursor:pointer;opacity:0.6" title="Close (Esc)">×</button>
      </div>

      <label style="display:block;font-size:11px;opacity:0.75;margin-bottom:3px">Reference capture</label>
      <select id="_cmp-ref" style="width:100%;padding:4px 6px;margin-bottom:10px;background:var(--input-bg, #2a2a2a);color:inherit;border:1px solid var(--border, #444);border-radius:4px;font-size:12px">${options}</select>

      <div style="font-size:11px;font-weight:600;opacity:0.85;margin-bottom:4px">Compatibility</div>
      <table style="font-size:11px;width:100%;border-collapse:collapse;margin-bottom:6px">
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">Shape</td>
          <td>${mH}×${mW}${shapeMatch ? "" : ` <span style="color:#ff453a">vs ${rH}×${rW}</span>`}</td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">Wavelength</td>
          <td>${Number.isFinite(mWl) ? mWl.toFixed(2) : "--"} nm · ref ${Number.isFinite(rWl) ? rWl.toFixed(2) : "--"} nm</td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">mm/pixel</td>
          <td>${Number.isFinite(mMpp) ? mMpp.toFixed(5) : "--"} · ref ${Number.isFinite(rMpp) ? rMpp.toFixed(5) : "--"}</td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">Valid pixels</td>
          <td>${mNValid} · ref ${rNValid}
            <span style="font-size:10px;opacity:0.6;margin-left:4px">(actual mask overlap computed server-side)</span>
          </td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">Origin</td>
          <td>${_escapeHtml(mOrigin)} &rarr; ${_escapeHtml(rOrigin)}</td>
        </tr>
      </table>

      ${banners.join("")}
      ${summaryLine}

      <div id="_cmp-err" style="color:#ff453a;font-size:11px;margin-top:6px;min-height:14px"></div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button id="_cmp-cancel" class="fringe-pill" style="padding:4px 12px">Cancel</button>
        <button id="_cmp-ok" class="fringe-pill" style="padding:4px 12px;background:#0d9488;color:#fff;border:none" ${redCount > 0 ? "disabled" : ""}>
          <span id="_cmp-ok-label">Subtract</span>
        </button>
      </div>
    `;

    // Rewire elements on each render.
    panel.querySelector("#_cmp-x").addEventListener("click", close);
    panel.querySelector("#_cmp-cancel").addEventListener("click", close);
    panel.querySelector("#_cmp-ref").addEventListener("change", (e) => {
      referenceId = e.target.value;
      render();
    });
    panel.querySelector("#_cmp-ok").addEventListener("click", () => _doSubtract(measurementId, referenceId, panel, close));
  }

  render();
}

async function _doSubtract(measurementId, referenceId, panel, close) {
  const btn = panel.querySelector("#_cmp-ok");
  const label = panel.querySelector("#_cmp-ok-label");
  const err = panel.querySelector("#_cmp-err");
  if (!btn || !label) return;

  err.textContent = "";
  btn.disabled = true;
  const origLabel = label.textContent;
  label.innerHTML = "<span style='display:inline-block;width:10px;height:10px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:frCmpSpin 0.8s linear infinite;vertical-align:-1px;margin-right:5px'></span>Subtracting…";

  // Ensure spinner keyframes exist.
  if (!document.getElementById("_cmp-spin-style")) {
    const style = document.createElement("style");
    style.id = "_cmp-spin-style";
    style.textContent = "@keyframes frCmpSpin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
  }

  let activeWl = null;
  try {
    const active = getActiveCalibration();
    if (active && Number.isFinite(Number(active.wavelength_nm))) {
      activeWl = Number(active.wavelength_nm);
    }
  } catch (_e) { /* getActiveCalibration may not be available in edge cases */ }

  const payload = { measurement_id: measurementId, reference_id: referenceId };
  if (activeWl != null) payload.wavelength_nm = activeWl;

  try {
    const resp = await apiFetch("/fringe/subtract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      let msg = `Error ${resp.status}`;
      try {
        const j = await resp.json();
        if (j && j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch (_e) { /* non-json */ }
      if (resp.status >= 500) console.error("Subtract 5xx:", msg);
      err.textContent = msg;
      btn.disabled = false;
      label.textContent = origLabel;
      return;
    }
    const data = await resp.json();

    // Close modal, load result into main view, flash new tile.
    close();
    fr.lastResult = data;
    renderResults(data);
    await fetchSessionCaptures();
    _scrollAndFlashTile(data.id);
  } catch (e) {
    console.error("Subtract failed:", e);
    err.textContent = "Network error: " + (e.message || String(e));
    btn.disabled = false;
    label.textContent = origLabel;
  }
}

// ── Average dialog (M3.3) ──────────────────────────────────────────────

/**
 * Open the inline Average dialog for a set of selected captures.  Models on
 * the Compare modal: fixed-position, ESC/backdrop dismissable.  Ordered by
 * the captures-list order so "#A, #B, #C" in source_ids lines up with the
 * visible tile numbers.
 */
function _openAverageDialog(selectedIds) {
  const caps = fr.sessionCaptures || [];
  // Order by index in the captures list for deterministic source_ids.
  const ordered = caps.filter(c => selectedIds.includes(c.id));
  if (ordered.length < 2) return;

  let method = "none";
  let threshold = 3.0;

  const root = document.createElement("div");
  root.className = "fringe-average-modal";
  root.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55)";

  const panel = document.createElement("div");
  panel.style.cssText = "background:var(--bg, #1e1e1e);color:var(--fg, #e8e8e8);border:1px solid var(--border, #444);border-radius:8px;padding:16px 18px;min-width:440px;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-size:12px";
  root.appendChild(panel);
  document.body.appendChild(root);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    root.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });

  function render() {
    // Indices on the captures-list (1-based).
    const idxs = ordered.map(c => caps.indexOf(c) + 1);
    const idxLabel = idxs.map(i => `#${i}`).join(", ");

    // Stats summary
    const pvs = ordered.map(c => Number(c.pv_nm)).filter(Number.isFinite);
    const rmss = ordered.map(c => Number(c.rms_nm)).filter(Number.isFinite);
    const pvRange = pvs.length
      ? `${Math.min(...pvs).toFixed(1)}–${Math.max(...pvs).toFixed(1)} nm`
      : "--";
    const rmsRange = rmss.length
      ? `${Math.min(...rmss).toFixed(1)}–${Math.max(...rmss).toFixed(1)} nm`
      : "--";

    // Shapes + wavelengths + calibrations compatibility.
    const shape0 = `${ordered[0].surface_height}\u00d7${ordered[0].surface_width}`;
    const allShapeMatch = ordered.every(c =>
      c.surface_height === ordered[0].surface_height &&
      c.surface_width === ordered[0].surface_width);

    const wls = ordered.map(c => Number(c.wavelength_nm)).filter(Number.isFinite);
    const wl0 = Number(ordered[0].wavelength_nm);
    const wlSpread = wls.length >= 2 ? Math.max(...wls) - Math.min(...wls) : 0;

    const mpps = ordered.map(c => Number(c.calibration_snapshot?.mm_per_pixel))
      .filter(v => Number.isFinite(v) && v > 0);
    let mppSpread = 0;
    if (mpps.length === ordered.length && mpps.length >= 2) {
      mppSpread = (Math.max(...mpps) - Math.min(...mpps)) / Math.min(...mpps);
    }

    const banners = [];
    const mkBanner = (kind, msg) => {
      const bg = kind === "red" ? "rgba(255,69,58,0.18)" : "rgba(255,159,10,0.18)";
      const fg = kind === "red" ? "#ff453a" : "#ff9f0a";
      return `<div style="padding:6px 8px;margin:4px 0;border-radius:4px;background:${bg};color:${fg};font-weight:600;font-size:11px">${msg}</div>`;
    };

    let canRun = true;
    if (!allShapeMatch) {
      banners.push(mkBanner("red",
        `Grid shapes differ across selected captures &mdash; averaging disabled.`));
      canRun = false;
    }
    if (wlSpread > 0.1) {
      banners.push(mkBanner("amber",
        `Wavelength spread ${wlSpread.toFixed(2)} nm across selected captures &mdash; results may be biased.`));
    }
    if (mppSpread > 0.01) {
      banners.push(mkBanner("amber",
        `Calibration mm/pixel varies by ${(mppSpread * 100).toFixed(1)}% across selected captures.`));
    }

    // Origin checks — warn about derived wavefronts and mixed-origin selections.
    const originList = ordered.map(c => c.origin || "capture");
    const uniqueOrigins = [...new Set(originList)];
    const nonCapture = [...new Set(originList.filter(o => o !== "capture"))];
    if (nonCapture.length > 0) {
      banners.push(mkBanner("amber",
        `Selected captures include derived wavefronts (${_escapeHtml(nonCapture.join(", "))}). Averaging non-capture origins inherits residuals from their sources.`));
    }
    if (uniqueOrigins.length > 1) {
      banners.push(mkBanner("amber",
        `Mixed origins in selection (${_escapeHtml(uniqueOrigins.join(", "))}). Physical interpretation is non-trivial.`));
    }

    // List of selected capture rows.
    const tileRows = ordered.map((c, i) => {
      const n = caps.indexOf(c) + 1;
      const origin = c.origin || "capture";
      const pv = _fmtNum(c.pv_nm, 1);
      const rms = _fmtNum(c.rms_nm, 1);
      return `<li style="font-size:11px;opacity:0.85;margin:1px 0">
        <strong>#${n}</strong> &middot; ${_escapeHtml(origin)} &middot; PV ${pv} nm &middot; RMS ${rms} nm
      </li>`;
    }).join("");

    const methodRadios = [
      ["none",  "Simple mean"],
      ["sigma", "Sigma rejection"],
      ["mad",   "MAD rejection"],
    ].map(([v, label]) => `
      <label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;cursor:pointer">
        <input type="radio" name="_avg-method" value="${v}" ${method === v ? "checked" : ""} />
        ${label}
      </label>`).join("");

    const thrDisabled = method === "none";
    panel.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
        <div style="font-size:14px;font-weight:600">Average ${ordered.length} captures</div>
        <div style="font-size:11px;opacity:0.75">${_escapeHtml(idxLabel)}</div>
        <button id="_avg-x" style="margin-left:auto;background:none;border:none;color:inherit;font-size:16px;cursor:pointer;opacity:0.6" title="Close (Esc)">×</button>
      </div>

      <ul style="margin:0 0 10px 0;padding-left:18px">${tileRows}</ul>

      <table style="font-size:11px;width:100%;border-collapse:collapse;margin-bottom:8px">
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">PV range</td>
          <td>${pvRange}</td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">RMS range</td>
          <td>${rmsRange}</td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">Shape</td>
          <td>${shape0}${allShapeMatch ? "" : ` <span style="color:#ff453a">(mismatched!)</span>`}</td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">Wavelength</td>
          <td>${Number.isFinite(wl0) ? wl0.toFixed(2) : "--"} nm${wlSpread > 0.1 ? ` <span style="color:#ff9f0a">(&plusmn;${(wlSpread / 2).toFixed(2)} nm)</span>` : ""}</td>
        </tr>
        <tr>
          <td style="opacity:0.65;padding:2px 8px 2px 0">mm/pixel</td>
          <td>${mpps.length ? mpps[0].toFixed(5) : "--"}${mppSpread > 0.01 ? ` <span style="color:#ff9f0a">(&plusmn;${((mppSpread / 2) * 100).toFixed(1)}%)</span>` : ""}</td>
        </tr>
      </table>

      <div style="font-size:11px;font-weight:600;opacity:0.85;margin-bottom:4px">Outlier rejection</div>
      <div style="margin-bottom:6px">${methodRadios}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;${thrDisabled ? "opacity:0.5" : ""}">
        <label for="_avg-thr" style="font-size:11px">Threshold</label>
        <input type="range" id="_avg-thr" min="1.0" max="5.0" step="0.5" value="${threshold}" ${thrDisabled ? "disabled" : ""} style="flex:1"/>
        <span id="_avg-thr-val" style="font-size:11px;min-width:32px;text-align:right">${threshold.toFixed(1)}&sigma;</span>
      </div>

      ${banners.join("")}

      <div id="_avg-err" style="color:#ff453a;font-size:11px;margin-top:6px;min-height:14px"></div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button id="_avg-cancel" class="fringe-pill" style="padding:4px 12px">Cancel</button>
        <button id="_avg-ok" class="fringe-pill" style="padding:4px 12px;background:#0d9488;color:#fff;border:none" ${canRun ? "" : "disabled"}>
          <span id="_avg-ok-label">Run average</span>
        </button>
      </div>
    `;

    panel.querySelector("#_avg-x").addEventListener("click", close);
    panel.querySelector("#_avg-cancel").addEventListener("click", close);
    panel.querySelectorAll("input[name='_avg-method']").forEach(radio => {
      radio.addEventListener("change", (e) => {
        method = e.target.value;
        render();
      });
    });
    const thrSlider = panel.querySelector("#_avg-thr");
    const thrLabel = panel.querySelector("#_avg-thr-val");
    if (thrSlider) {
      thrSlider.addEventListener("input", (e) => {
        threshold = parseFloat(e.target.value);
        if (thrLabel) thrLabel.textContent = `${threshold.toFixed(1)}\u03c3`;
      });
    }
    panel.querySelector("#_avg-ok").addEventListener("click", () =>
      _doAverage(ordered.map(c => c.id), method, threshold,
                 Number.isFinite(wl0) ? wl0 : null, panel, close));
  }

  render();
}

async function _doAverage(sourceIds, method, threshold, wl0, panel, close) {
  const btn = panel.querySelector("#_avg-ok");
  const label = panel.querySelector("#_avg-ok-label");
  const err = panel.querySelector("#_avg-err");
  if (!btn || !label) return;

  err.textContent = "";
  btn.disabled = true;
  const origLabel = label.textContent;
  label.innerHTML = "<span style='display:inline-block;width:10px;height:10px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:frCmpSpin 0.8s linear infinite;vertical-align:-1px;margin-right:5px'></span>Averaging&hellip;";
  if (!document.getElementById("_cmp-spin-style")) {
    const style = document.createElement("style");
    style.id = "_cmp-spin-style";
    style.textContent = "@keyframes frCmpSpin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
  }

  const payload = {
    source_ids: sourceIds,
    rejection: method,
    rejection_threshold: threshold,
  };
  // Prefer the active calibration's wavelength (same behavior as subtract).
  try {
    const active = getActiveCalibration();
    if (active && Number.isFinite(Number(active.wavelength_nm))) {
      payload.wavelength_nm = Number(active.wavelength_nm);
    } else if (wl0 != null) {
      payload.wavelength_nm = wl0;
    }
  } catch (_e) {
    if (wl0 != null) payload.wavelength_nm = wl0;
  }

  try {
    const resp = await apiFetch("/fringe/average", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      let msg = `Error ${resp.status}`;
      try {
        const j = await resp.json();
        if (j && j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch (_e) { /* non-json */ }
      if (resp.status >= 500) console.error("Average 5xx:", msg);
      err.textContent = msg;
      btn.disabled = false;
      label.textContent = origLabel;
      return;
    }
    const data = await resp.json();
    close();
    fr.lastResult = data;
    renderResults(data);
    _setSelectMode(false);
    await fetchSessionCaptures();
    _scrollAndFlashTile(data.id);
  } catch (e) {
    console.error("Average failed:", e);
    err.textContent = "Network error: " + (e.message || String(e));
    btn.disabled = false;
    label.textContent = origLabel;
  }
}

function _scrollAndFlashTile(captureId) {
  // Defer to next tick so the re-render has happened.
  setTimeout(() => {
    const list = $("fringe-session-list");
    if (!list) return;
    const tile = list.querySelector(`.fringe-session-tile[data-capture-id="${CSS.escape(captureId)}"]`);
    if (!tile) return;
    try { tile.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_e) { tile.scrollIntoView(); }
    const prevBg = tile.style.background;
    const prevBorder = tile.style.border;
    tile.style.background = "rgba(255,159,10,0.25)";
    tile.style.border = "1px solid #ff9f0a";
    tile.style.transition = "background 1.5s ease-out, border 1.5s ease-out";
    setTimeout(() => {
      tile.style.background = prevBg;
      tile.style.border = prevBorder;
    }, 1500);
  }, 50);
}

// ── M4.1 — Mode-aware tool visibility ───────────────────────────────────

/**
 * Apply mode-specific visibility to the measurement toolbar and other
 * mode-dependent UI. The mode is a UI-only concept — the backend doesn't
 * see it. It just hides/emphasizes tools that don't apply to the current
 * workflow.
 *
 *   surface     → all measurement tools visible (default behavior).
 *   step        → emphasize Step tool, hide Area tool, surface λ/4 hint.
 *   averaging   → hide measurement tools; highlight averaging toolbar.
 *   subtraction → hide measurement tools; auto-open Session tab.
 */
function _applyModeVisibility(mode) {
  const toolbar = $("fringe-measure-toolbar");
  if (!toolbar) return;
  const buttons = toolbar.querySelectorAll(".fringe-measure-btn");
  buttons.forEach(btn => {
    const m = btn.dataset.mode;
    btn.style.display = "";
    btn.style.outline = "";
    btn.style.outlineOffset = "";
    btn.title = btn.getAttribute("data-orig-title") || btn.title;
    if (!btn.hasAttribute("data-orig-title") && btn.title) {
      btn.setAttribute("data-orig-title", btn.title);
    }
    if (mode === "step") {
      // Hide Area; emphasize Step.
      if (m === "area") btn.style.display = "none";
      if (m === "step") {
        btn.style.outline = "2px solid #ff9f0a";
        btn.style.outlineOffset = "1px";
      }
    } else if (mode === "averaging" || mode === "subtraction") {
      // Hide all measurement-mode tools; pan stays.
      if (m && m !== "") btn.style.display = "none";
    }
  });

  // Mode-specific banner at the top of the surface tab. Use a small inline
  // pill rather than a banner — no banner pollution.
  let modeChip = document.getElementById("fringe-mode-chip");
  if (!modeChip) {
    modeChip = document.createElement("span");
    modeChip.id = "fringe-mode-chip";
    modeChip.style.cssText = "margin-left:8px;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;cursor:default;background:rgba(74,158,255,0.2);color:#4a9eff";
    const summaryRight = $("fringe-summary-wl");
    if (summaryRight && summaryRight.parentElement) {
      summaryRight.parentElement.insertBefore(modeChip, summaryRight);
    }
  }
  const labels = {
    surface: "Surface",
    step: "Small-step (\u003c \u03bb/4)",
    averaging: "Averaging",
    subtraction: "Subtraction",
  };
  modeChip.textContent = "mode: " + (labels[mode] || mode);
  modeChip.title = "Workflow mode \u2014 UI-only.";

  // Auto-open Session tab in averaging/subtraction modes.
  if (mode === "averaging" || mode === "subtraction") {
    const sessionTab = document.querySelector('.fringe-tab[data-tab="session"]');
    if (sessionTab && !sessionTab.classList.contains("active")) {
      sessionTab.click();
    }
    if (mode === "averaging") {
      const avgBtn = $("fringe-session-avg-mode");
      if (avgBtn) {
        avgBtn.style.outline = "2px solid #ff9f0a";
        avgBtn.style.outlineOffset = "1px";
      }
    }
  } else {
    const avgBtn = $("fringe-session-avg-mode");
    if (avgBtn) {
      avgBtn.style.outline = "";
      avgBtn.style.outlineOffset = "";
    }
  }
}

// ── M4.4 — Generic warnings banner ─────────────────────────────────────

const _dismissedWarningsForResultId = new Set();

function _renderGenericWarnings(data) {
  // Reuses the #fringe-subtract-warnings element so subtract/average warnings
  // and generic analyze warnings flow through the same banner. Generic
  // warnings (analyze) appear when origin is "capture" or unset, and
  // subtract/average warnings continue to be handled by
  // _renderSubtractionWarnings (which fires for non-capture origins).
  if (!data) return;
  const origin = data.origin;
  if (origin === "subtracted" || origin === "average") return;  // handled separately
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  let banner = document.getElementById("fringe-subtract-warnings");
  const id = data.id || data.captured_at || "anon";
  if (warnings.length === 0 || _dismissedWarningsForResultId.has(id)) {
    if (banner) banner.hidden = true;
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fringe-subtract-warnings";
    banner.style.cssText = "margin:6px 12px;padding:8px 12px;border-radius:4px;background:rgba(255,159,10,0.15);border:1px solid rgba(255,159,10,0.45);color:#ff9f0a;font-size:12px;line-height:1.45";
    const tabBar = $("fringe-tab-bar");
    if (tabBar && tabBar.parentElement) {
      tabBar.parentElement.insertBefore(banner, tabBar);
    } else {
      document.body.appendChild(banner);
    }
  }
  const items = warnings.map(w => `<li>${_escapeHtml(String(w))}</li>`).join("");
  banner.innerHTML = `<div style="display:flex;align-items:flex-start;gap:8px">
    <div style="flex:1"><strong>\u26a0 Warnings:</strong><ul style="margin:4px 0 0 0;padding-left:20px">${items}</ul></div>
    <button id="fringe-warnings-dismiss" title="Dismiss for this result"
      style="background:none;border:none;color:inherit;cursor:pointer;font-size:14px;opacity:0.7;line-height:1">\u00D7</button>
  </div>`;
  banner.hidden = false;
  banner.querySelector("#fringe-warnings-dismiss")?.addEventListener("click", () => {
    _dismissedWarningsForResultId.add(id);
    banner.hidden = true;
  });
}

// ── M4.5 — Trend tab ──────────────────────────────────────────────────

function _renderTrendTab() {
  const host = $("fringe-trend-host");
  if (!host) return;
  const groupSel = $("fringe-trend-group");
  const groupBy = groupSel ? groupSel.value : "none";
  renderTrend(host, fr.sessionCaptures || [], { groupBy });
}

// ── Event wiring ────────────────────────────────────────────────────────

export function wireResultsEvents() {
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
      // M1.7: lazy-fetch session captures when entering the Session tab.
      if (tab.dataset.tab === "session") {
        fetchSessionCaptures();
      }
      // M4.5: render the trend chart on tab activation.
      if (tab.dataset.tab === "trend") {
        _renderTrendTab();
      }
    });
  });

  // Reference standard change -> re-color PV
  $("fringe-standard")?.addEventListener("change", () => {
    if (fr.lastResult) renderResults(fr.lastResult);
  });

  // M4.1 — Workflow mode selector. UI-only; backend ignores it. Tagged onto
  // measurements so saved/exported values carry the mode of origin.
  const modeSel = $("fringe-mode-select");
  if (modeSel) {
    modeSel.value = fr.mode || "surface";
    modeSel.addEventListener("change", () => {
      fr.mode = modeSel.value;
      _applyModeVisibility(fr.mode);
    });
    _applyModeVisibility(fr.mode || "surface");
  }

  // Form model selector. Zernike is the only model that consumes
  // subtract_terms; plane / poly2 / poly3 hide the per-term pill group.
  $("fringe-form-model")?.addEventListener("change", (e) => {
    formModel = e.target.value;
    const pillGroup = $("fringe-pill-group");
    if (pillGroup) pillGroup.hidden = formModel !== "zernike";
    doReanalyze();
  });

  // Invert and export buttons
  $("fringe-btn-invert")?.addEventListener("click", invertWavefront);
  $("fringe-btn-export-pdf")?.addEventListener("click", exportFringePdf);
  $("fringe-btn-export-csv")?.addEventListener("click", exportFringeCsv);

  // Subtraction pill click handlers
  let _reanalyzeDebounce = null;
  document.querySelectorAll(".fringe-pill[data-pill]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.pill;
      const pill = SUBTRACT_PILLS.find(p => p.id === id);
      if (!pill || pill.locked) return;
      pillState[id] = !pillState[id];
      btn.classList.toggle("active", pillState[id]);
      if (_reanalyzeDebounce) clearTimeout(_reanalyzeDebounce);
      _reanalyzeDebounce = setTimeout(() => {
        if (fr.lastResult) doReanalyze();
      }, 150);
    });
  });

  // M1.6: "use trusted pixels only" measurement flag. Downstream tools may
  // read fr.useTrustedOnly. We also recompute the PV/RMS summary spans
  // from heightGrid + trustedMaskGrid (no backend round-trip) and toggle
  // a dim overlay on the surface map for the analyzed-but-untrusted
  // pixels.
  $("fringe-use-trusted-only")?.addEventListener("change", (e) => {
    fr.useTrustedOnly = !!e.target.checked;
    refreshTrustedOnlyDisplay();
    // M1.6: also refresh any committed Step/Area readout in place.
    refreshLastMeasurement();
  });

  // Overlay toggle buttons
  document.querySelectorAll(".fringe-overlay-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fringe-overlay-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const surfImg = $("fringe-surface-img");
      if (!surfImg) return;
      const srcKey = btn.dataset.overlay + "Src";
      if (surfImg.dataset[srcKey]) surfImg.src = surfImg.dataset[srcKey];
    });
  });

  // Confidence badge clicks -> open diagnostics tab
  for (const key of ["carrier", "modulation", "unwrap"]) {
    $(`fringe-conf-${key}`)?.addEventListener("click", () => {
      const diagTab = document.querySelector('[data-tab="diagnostics"]');
      if (diagTab) diagTab.click();
    });
  }

  // Carrier override + diagnostics tab
  wireCarrierOverride();

  // Calibration indicator: change / export / import
  $("fringe-cal-change")?.addEventListener("click", (e) => {
    e.preventDefault();
    _promptPickCalibration();
  });
  $("fringe-cal-export")?.addEventListener("click", (e) => {
    e.preventDefault();
    _handleExportCalibrations();
  });
  $("fringe-cal-import")?.addEventListener("click", (e) => {
    e.preventDefault();
    const input = $("fringe-cal-import-file");
    if (input) input.click();
  });
  $("fringe-cal-import-file")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    _handleImportCalibrations(file);
    e.target.value = "";  // reset so selecting the same file re-fires
  });

  // Initial summary-bar indicator render (before first analyze).
  updateCalibrationIndicator();

  // Listen for fringe:analyzed events from panel module
  document.addEventListener("fringe:analyzed", (e) => {
    renderResults(e.detail);
    // M1.7: every successful analyze (capture or stream) appends a summary
    // server-side; refresh the sidebar so it stays in sync.
    fetchSessionCaptures();
  });

  // M1.7: session-captures sidebar wiring.
  $("fringe-session-refresh")?.addEventListener("click", () => fetchSessionCaptures());
  $("fringe-session-clear")?.addEventListener("click", () => clearSession());

  // M3.7: import a previously-exported capture JSON.
  const importBtn = $("fringe-session-import");
  const importFile = $("fringe-session-import-file");
  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch (_) {
          window.alert("Import failed: file is not valid JSON.");
          return;
        }
        const resp = await apiFetch("/fringe/session/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result: payload }),
        });
        if (!resp.ok) {
          let detail = `HTTP ${resp.status}`;
          try { detail = (await resp.json()).detail || detail; } catch (_) {}
          window.alert(`Import failed: ${detail}`);
          return;
        }
        const imported = await resp.json();
        await fetchSessionCaptures();
        // Flash the new tile by selecting it.
        if (imported && imported.id) {
          fr.selectedCaptureId = imported.id;
          renderSessionPanel();
          const tile = document.querySelector(
            `.fringe-session-tile[data-capture-id="${CSS.escape(imported.id)}"]`,
          );
          if (tile) {
            tile.style.transition = "background-color 0.4s ease";
            const orig = tile.style.background;
            tile.style.background = "rgba(48,209,88,0.30)";
            setTimeout(() => { tile.style.background = orig; }, 1400);
          }
        }
      } catch (e) {
        window.alert(`Import failed: ${e.message || e}`);
      } finally {
        importFile.value = "";
      }
    });
  }

  // M3.3: select-for-average toolbar wiring.
  $("fringe-session-avg-mode")?.addEventListener("click", () => {
    if (!_selectMode) {
      _setSelectMode(true);
    } else if (_selectedIds.size >= 2) {
      _openAverageDialog(Array.from(_selectedIds));
    }
  });
  $("fringe-session-avg-cancel")?.addEventListener("click", (e) => {
    e.preventDefault();
    _setSelectMode(false);
  });

  // M1.7: initial population so a reloaded tab with an active session shows
  // its captures without needing to enter the tab.
  fetchSessionCaptures();
  // Render the empty list immediately so the count reads "0 captures" before
  // the fetch resolves (defensive against very-first-load latency).
  renderSessionPanel();

  // M4.5: trend group-by selector + auto-refresh on captures change.
  $("fringe-trend-group")?.addEventListener("change", () => _renderTrendTab());
}
