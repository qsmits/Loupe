// fringe.js — Coordinator for the fringe analysis workspace.
//
// Owns: shared state (fr), DOM helper ($), wavelength presets,
//       workspace assembly (buildWorkspace), and init lifecycle.
// Delegates to: fringe-panel.js (left column), fringe-results.js (right column),
//               fringe-measure.js (measurement tools), fringe-progress.js (SSE).
//
// Lives inside #mode-fringe, managed by modes.js.

import { apiFetch } from './api.js';
import { wireMeasureEvents } from './fringe-measure.js';
import { buildPanelHtml, wirePanelEvents, startPolling, stopPolling } from './fringe-panel.js';
import { buildResultsHtml, wireResultsEvents } from './fringe-results.js';

export const fr = {
  polling: null,
  built: false,
  threeLoaded: false,
  lastResult: null,
  lastMask: null,
  maskPolygons: [],        // [{vertices: [{x,y},...], include: bool}, ...]
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
        ${buildResultsHtml()}
      </div>
    </div>
  `;

  wireEvents();
}

// ── Event wiring ────────────────────────────────────────────────────────

function wireEvents() {
  // Panel events (analyze, averaging, mask, drag/drop, preview, etc.)
  wirePanelEvents();

  // Results column events (tabs, pills, carrier, export, etc.)
  wireResultsEvents();

  // Measurement tools
  wireMeasureEvents();
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
