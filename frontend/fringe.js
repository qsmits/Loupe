// fringe.js — Coordinator for the fringe analysis workspace.
//
// Owns: shared state (fr), DOM helper ($), wavelength presets,
//       workspace assembly (buildWorkspace), and init lifecycle.
// Delegates to: fringe-panel.js (left column), fringe-results.js (right column),
//               fringe-measure.js (measurement tools), fringe-progress.js (SSE).
//
// Lives inside #mode-fringe, managed by modes.js.

import { registerModeHooks } from './tab-manager.js';
import { captureInstrument, restoreInstrument } from './instrument-workspace.js';
import { hideProgress } from './fringe-progress.js';
import { apiFetch } from './api.js';
import { mimeFromBase64 } from './fringe-upload.js';
import { state } from './state.js';
import { renderFringeLensDropdown } from './fringe-lens-profiles.js';
import { wireMeasureEvents } from './fringe-measure.js';
import { buildPanelHtml, wirePanelEvents, startPolling, stopPolling, clearDroppedImage, cancelFringeWork, updateAnalysisSource } from './fringe-panel.js';
import { buildResultsHtml, wireResultsEvents, restoreFringeResult, captureFringeOptions } from './fringe-results.js';

export const fr = {
  polling: null,
  built: false,
  threeLoaded: false,
  lastResult: null,
  lastMask: null,
  maskPolygons: [],        // [{vertices: [{x,y},...], include: bool}, ...]
  measureMode: null,       // null | "cursor" | "distance" | "point2point" | "lineProfile" | "area" | "step"
  measurePoints: [],       // normalized points: {nx,ny} for height tools; {x,y} for lateral distance
  stepRegions: [],         // [{x0,y0,x1,y1}, ...] normalized rects for Step tool (0..2 committed)
  stepDragIdx: -1,         // index of rect currently being translated, -1 if none
  stepDragOffset: null,    // {dx, dy} drag offset in normalized coords
  heightGrid: null,        // Float32Array from server
  maskGrid: null,          // Uint8Array from server
  trustedMaskGrid: null,   // Uint8Array from server (M1.6) — subset of maskGrid
  useTrustedOnly: false,   // M1.6 — measurement tools may honor this flag
  gridRows: 0,
  gridCols: 0,
  avgCaptures: [],        // [{id, rms_nm, accepted, reason}]
  avgRejectThreshold: 3,  // reject if capture RMS > threshold × average RMS
  avgSurfaceHeight: 0,
  avgSurfaceWidth: 0,
  // Task 9: explicit orientation flag for the running-average widget. The
  // server never inverts averaging source captures, so every recomputeAverage()
  // fetch starts un-inverted; when this is true it is reapplied to
  // fr.lastResult after each recompute so an active invert survives
  // toggling captures in/out. Reset whenever a fresh, non-recompute result
  // replaces fr.lastResult (see fringe-panel.js/_onAnalysisResult and the
  // subtract/average dialogs in fringe-results.js).
  avgInverted: false,
  carrierOverride: null,   // {y, x} or null
  lensK1: 0,
  sourceName: null,
  analyzedAt: null,
  analysisBusy: false,
  analysisEngine: "server",
  analysisMethod: "current",
  droppedImageB64: null,   // base64 string when analyzing a dropped file
  droppedObjectUrl: null,  // blob URL for preview display
  sessionCaptures: [],     // M1.7 — list of capture summaries from /fringe/session/captures
  selectedCaptureId: null, // M1.7 — currently selected capture for the detail panel
  // M4.1 — Workflow mode. UI-only concept; backend ignores it. Tagged onto
  // every Step/Area measurement so saved values carry their mode of origin.
  // One of: "surface", "step", "averaging", "subtraction".
  mode: "surface",
  measurements: [],         // M4.1 — recorded Step/Area measurements with mode tag
};

function workspaceControls() {
  return {querySelectorAll: selector => [
    ...($("mode-fringe")?.querySelectorAll(selector) ?? []),
    ...($("fringe-setup-settings")?.querySelectorAll(selector) ?? []),
  ]};
}

const WORKSPACE_DEFAULTS = {
  lastResult: null, lastMask: null, maskPolygons: [], measurements: [], analysisEngine: "server", analysisMethod: "current",
  useTrustedOnly: false, lensK1: 0, droppedImageB64: null, sourceName: null, analyzedAt: null, carrierOverride: null,
  mode: "surface", measureMode: null, lastAreaRect: null, stepRegions: [], avgRejectThreshold: 3,
};

export function $(id) { return document.getElementById(id); }

// ── Wavelength presets ──────────────────────────────────────────────────
// Defaults; overridden at init from /config/fringe if available.
// "custom" is a UI-only entry, always appended by rebuildWavelengthSelect().

let WAVELENGTHS = [
  { id: "sodium", label: "Sodium (589.3 nm)", nm: 589.3 },
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
      <div class="fringe-results-col fringe-image-drop-target">
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
  let initial;
  const presetsReady = loadWavelengthPresets().then(() => {
    initial = captureInstrument(fr, WORKSPACE_DEFAULTS, workspaceControls());
  });
  registerModeHooks("fringe", {
    serialize: () => ({...captureInstrument(fr, WORKSPACE_DEFAULTS, workspaceControls()), options: captureFringeOptions()}),
    restore: async snapshot => {
      await presetsReady;
      cancelFringeWork();
      clearDroppedImage();
      restoreInstrument(fr, WORKSPACE_DEFAULTS, {...snapshot, controls: {...initial.controls, ...snapshot?.controls}}, workspaceControls());
      const unsavedLens = renderFringeLensDropdown(fr.lensK1);
      const lensSaveRow = $('fringe-lens-save-row');
      if (lensSaveRow) { lensSaveRow.hidden = !unsavedLens; lensSaveRow.style.display = unsavedLens ? 'flex' : ''; }
      hideProgress();
      fr.analysisBusy = false;
      fr.heightGrid = fr.maskGrid = fr.trustedMaskGrid = null;
      fr.gridRows = fr.gridCols = 0;
      fr.avgCaptures = []; fr.avgInverted = false;
      fr.sessionCaptures = []; fr.selectedCaptureId = null;
      if (fr.droppedImageB64) {
        const preview = $("fringe-preview");
        if (preview) preview.src = `data:${mimeFromBase64(fr.droppedImageB64)};base64,` + fr.droppedImageB64;
      }
      restoreFringeResult(fr.lastResult, snapshot?.options);
      updateAnalysisSource();
    },
  });

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
