// fringe-panel.js — Left panel template, capture workflow, mask drawing,
// averaging, and focus polling for fringe mode.
//
// Extracted from fringe.js (Task 6 of fringe UI restructure).

import { fr, $ } from './fringe.js';
import { state } from './state.js';
import { getSubtractTerms, getFormModel, mergeReanalyzeResult } from './fringe-results.js';
import { apiFetch } from './api.js';
import { analyzeWithProgress, createProgressBar } from './fringe-progress.js';
import { initCrossMode } from './cross-mode.js';
import { switchMode } from './modes.js';
import { loadFringeLensProfiles, renderFringeLensDropdown, saveFringeLensProfile } from './fringe-lens-profiles.js';
import {
  getActiveCalibration,
  calibrationPayload,
  saveCalibration,
  listCalibrations,
  setActiveCalibrationId,
  deleteCalibration,
  exportCalibrationsJson,
  importCalibrationsJson,
} from './fringe-calibration.js';
import {
  listRecipes,
  saveRecipe,
  deleteRecipe,
  getActiveRecipe,
  getActiveRecipeId,
  setActiveRecipeId,
  recipePayload,
  recipeToMaskPolygons,
  exportRecipesJson,
  importRecipesJson,
} from './fringe-geometry.js';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Wavelength used for analysis. Sourced from the active calibration, with
 * the UI wavelength select acting as a write-through editor for the active
 * calibration (M1.2 keeps the input box functional).
 */
export function getWavelength() {
  const active = getActiveCalibration();
  if (active && Number.isFinite(active.wavelength_nm) && active.wavelength_nm > 0) {
    return active.wavelength_nm;
  }
  // Fallback to the input box if the active calibration is somehow malformed.
  const sel = $("fringe-wavelength");
  if (!sel) return 589.0;
  if (sel.value === "custom") {
    const el = $("fringe-custom-wl");
    const v = parseFloat(el?.value || "589.0");
    return Number.isFinite(v) && v > 0 ? v : 589.0;
  }
  const opt = sel.selectedOptions[0];
  if (opt && opt.dataset.nm) return parseFloat(opt.dataset.nm);
  return 589.0;
}

/** Build the `calibration` payload for /fringe/analyze* requests. */
export function getCalibrationPayload() {
  return calibrationPayload(getActiveCalibration());
}

/**
 * Write-through: when the wavelength input changes, update the active
 * calibration's wavelength_nm so it persists across reloads.
 */
function _persistWavelengthChange() {
  const sel = $("fringe-wavelength");
  if (!sel) return;
  let nm;
  if (sel.value === "custom") {
    const el = $("fringe-custom-wl");
    nm = parseFloat(el?.value || "");
  } else {
    const opt = sel.selectedOptions[0];
    nm = opt ? parseFloat(opt.dataset.nm) : NaN;
  }
  if (!Number.isFinite(nm) || nm <= 0) return;
  const active = getActiveCalibration();
  if (!active || active.wavelength_nm === nm) return;
  try {
    saveCalibration({ ...active, wavelength_nm: nm });
  } catch (_) { /* swallow — invalid values already filtered */ }
  // Refresh the indicator after write-through.
  const wlEl = document.getElementById("fringe-summary-wl");
  if (wlEl) {
    const a = getActiveCalibration();
    wlEl.textContent = `${a.name} \u00B7 ${a.wavelength_nm} nm`;
  }
}

export function getMaskThreshold() {
  const el = $("fringe-mask-thresh");
  return el ? parseInt(el.value, 10) / 100 : 0.15;
}

/**
 * LPF σ override as a fraction of the fringe period. Returns null when the
 * "auto" checkbox is checked so the backend keeps its computed default.
 */
export function getLpfSigmaFrac() {
  const autoEl = $("fringe-lpf-sigma-auto");
  if (!autoEl || autoEl.checked) return null;
  const el = $("fringe-lpf-sigma");
  if (!el) return null;
  const v = parseFloat(el.value);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * DC margin override in FFT bins. Returns null when the "auto" checkbox is
 * checked so the backend keeps its hard-coded default of 2.
 */
export function getDcMarginOverride() {
  const autoEl = $("fringe-dc-margin-auto");
  if (!autoEl || autoEl.checked) return null;
  const el = $("fringe-dc-margin");
  if (!el) return null;
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export function getCorrect2piJumps() {
  const el = $("fringe-correct-2pi-jumps");
  // Default true preserves legacy behavior when the control is missing.
  return el ? !!el.checked : true;
}

// ── Left panel HTML template ───────────────────────────────────────────

export function buildPanelHtml() {
  return `
        <div class="fringe-preview-container" id="fringe-preview-container" style="position:relative;cursor:pointer" title="Click to expand preview">
          <img id="fringe-preview" alt="Camera preview" />
          <canvas id="fringe-roi-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
        </div>
        <div class="fringe-focus-bar-container">
          <label style="font-size:11px;opacity:0.7">Focus</label>
          <div class="fringe-focus-bar">
            <div class="fringe-focus-fill" id="fringe-focus-fill" style="width:0%"></div>
          </div>
          <span id="fringe-focus-score" style="font-size:11px;min-width:30px;text-align:right">--</span>
        </div>

        <button class="detect-btn" id="fringe-btn-analyze" style="padding:4px 10px;font-size:11px">
          Freeze &amp; Analyze
        </button>

        <div id="fringe-avg-controls" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="display:flex;gap:4px;align-items:center">
            <button class="detect-btn" id="fringe-btn-avg-add" style="padding:4px 10px;font-size:11px;flex:1" disabled title="Freeze a frame and add its Zernike coefficients to the running average">
              + Add to Avg
            </button>
            <span id="fringe-avg-count" style="font-size:11px;opacity:0.6;min-width:20px;text-align:center">0</span>
            <button class="detect-btn" id="fringe-btn-avg-reset" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
              Reset
            </button>
          </div>
          <div style="display:flex;gap:4px;align-items:center;margin-top:2px">
            <label style="font-size:10px;opacity:0.5">Reject &gt;</label>
            <input type="number" id="fringe-avg-reject" min="1.5" max="10" step="0.5" value="3" style="width:40px;font-size:10px;padding:1px 3px" title="Auto-reject captures with RMS exceeding this multiple of the average" />
            <span style="font-size:10px;opacity:0.5">&times; avg</span>
          </div>
          <div id="fringe-avg-log" style="max-height:80px;overflow-y:auto;font-size:10px;margin-top:2px"></div>
        </div>

        <div style="display:flex;gap:4px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <button class="detect-btn" id="fringe-btn-edit-mask" style="padding:4px 10px;font-size:11px;flex:1">
            Edit Mask
          </button>
          <button class="detect-btn" id="fringe-btn-mask-clear" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
            Clear Mask
          </button>
        </div>
        <div id="fringe-mask-status" style="font-size:10px;opacity:0.5;text-align:center" hidden></div>

        <div style="display:flex;gap:4px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <label style="font-size:11px;opacity:0.7;white-space:nowrap">Lens:</label>
          <select id="fringe-lens-profile" style="flex:1;font-size:11px;padding:2px 4px"></select>
          <button class="detect-btn" id="fringe-btn-lens-cal" style="padding:4px 10px;font-size:11px">Calibrate</button>
        </div>
        <div id="fringe-lens-save-row" hidden style="gap:4px;align-items:center;margin-top:4px">
          <input type="text" id="fringe-lens-save-name" placeholder="Profile name" style="flex:1;font-size:11px;padding:2px 4px" />
          <button class="detect-btn" id="fringe-btn-lens-save" style="padding:4px 8px;font-size:11px">Save</button>
        </div>

        <div class="fringe-drop-zone" id="fringe-drop-zone" style="margin-top:8px">
          <span style="opacity:0.5;font-size:12px">or drag &amp; drop an image</span>
        </div>
  `;
}

// ── Mask polygon overlay (small preview canvas) ────────────────────────

export function drawMaskOverlay() {
  const canvas = $("fringe-roi-canvas");
  const img = $("fringe-preview");
  if (!canvas || !img) return;
  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width;
  const h = canvas.height;

  for (const poly of fr.maskPolygons) {
    if (poly.vertices.length < 2) continue;
    const color = poly.include ? "#0a84ff" : "#ff453a";
    const fill  = poly.include ? "rgba(10,132,255,0.15)" : "rgba(255,69,58,0.15)";
    ctx.beginPath();
    ctx.moveTo(poly.vertices[0].x * w, poly.vertices[0].y * h);
    for (let i = 1; i < poly.vertices.length; i++) {
      ctx.lineTo(poly.vertices[i].x * w, poly.vertices[i].y * h);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Update mask status label and clear button state
  const status = $("fringe-mask-status");
  if (status) {
    if (fr.maskPolygons.length > 0) {
      status.textContent = `Mask: ${fr.maskPolygons.length} region${fr.maskPolygons.length !== 1 ? 's' : ''}`;
      status.hidden = false;
    } else {
      status.hidden = true;
    }
  }
  const clearBtn = $("fringe-btn-mask-clear");
  if (clearBtn) {
    clearBtn.disabled = fr.maskPolygons.length === 0;
    clearBtn.style.opacity = fr.maskPolygons.length === 0 ? "0.6" : "1";
  }
}

// ── Analysis (SSE streaming) ───────────────────────────────────────────

/**
 * Build the `mask_polygons` payload for /fringe/analyze*.
 *
 * Precedence:
 *   1. Hand-drawn `fr.maskPolygons` win if non-empty (user explicitly edited
 *      the mask for this capture).
 *   2. Otherwise, the active geometry recipe (if any) contributes its
 *      polygon approximation.
 *   3. Otherwise, undefined → backend auto-masks.
 */
function _buildMaskPayload() {
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

/** Recipe payload (or null) for the `aperture_recipe` field. */
export function getAperturePayload() {
  return recipePayload(getActiveRecipe());
}

/**
 * Resolution-mismatch check between a recipe's `source_resolution` and the
 * current preview image.  Emits a console warning on mismatch.
 */
function _checkRecipeResolution() {
  const recipe = getActiveRecipe();
  if (!recipe || !recipe.source_resolution) return;
  const img = document.getElementById('fringe-preview');
  const w = img && img.naturalWidth ? img.naturalWidth : 0;
  const h = img && img.naturalHeight ? img.naturalHeight : 0;
  if (!w || !h) return;
  const rw = recipe.source_resolution.width;
  const rh = recipe.source_resolution.height;
  if (rw === w && rh === h) return;
  const msg = `[fringe] Recipe "${recipe.name}" saved for ${rw}\u00d7${rh}; applying to ${w}\u00d7${h} (normalized coords rescale automatically).`;
  console.warn(msg);
  // Best-effort banner into the summary bar.
  const slot = document.getElementById('fringe-summary-recipe');
  if (slot) slot.title = msg;
}

function _onAnalysisResult(data) {
  fr.lastResult = data;
  document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: data }));

  const avgBtn = $("fringe-btn-avg-add");
  if (avgBtn) avgBtn.disabled = false;
  const invBtn = $("fringe-btn-invert");
  if (invBtn) invBtn.disabled = false;
  const pdfBtn = $("fringe-btn-export-pdf");
  if (pdfBtn) pdfBtn.disabled = false;
  const csvBtn = $("fringe-btn-export-csv");
  if (csvBtn) csvBtn.disabled = false;
}

function analyzeFromCamera() {
  clearDroppedImage();
  _runAnalysis();
}

/** Shared analysis dispatch — uses dropped image if available, else camera. */
function _runAnalysis() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;

  _checkRecipeResolution();
  const payload = {
    wavelength_nm: getWavelength(),
    mask_threshold: getMaskThreshold(),
    lpf_sigma_frac: getLpfSigmaFrac(),
    dc_margin_override: getDcMarginOverride(),
    subtract_terms: getSubtractTerms(),
    mask_polygons: _buildMaskPayload(),
    form_model: getFormModel(),
    lens_k1: fr.lensK1,
    correct_2pi_jumps: getCorrect2piJumps(),
    calibration: getCalibrationPayload(),
    aperture_recipe: getAperturePayload(),
  };
  if (fr.droppedImageB64) payload.image_b64 = fr.droppedImageB64;

  analyzeWithProgress(
    payload,
    (data) => {
      _onAnalysisResult(data);
      if (btn) btn.disabled = false;
    },
    (errMsg) => {
      console.warn("Fringe analysis failed:", errMsg);
      if (btn) btn.disabled = false;
    },
    () => _runAnalysis(),  // retry
  );
}

async function analyzeFromFile(file) {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;

  try {
    const arrayBuf = await file.arrayBuffer();
    const u8 = new Uint8Array(arrayBuf);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);

    // Store dropped image so re-analysis (mask, settings) uses it
    fr.droppedImageB64 = b64;
    if (fr.droppedObjectUrl) URL.revokeObjectURL(fr.droppedObjectUrl);
    fr.droppedObjectUrl = URL.createObjectURL(file);

    // Update preview to show the dropped image
    const preview = $("fringe-preview");
    if (preview) preview.src = fr.droppedObjectUrl;

    if (!state._hosted) _runAnalysis();
    if (btn) btn.disabled = false;
  } catch (e) {
    console.warn("Fringe file read error:", e);
    if (btn) btn.disabled = false;
  }
}

/** Clear the dropped image state and revert preview to live camera. */
export function clearDroppedImage() {
  fr.droppedImageB64 = null;
  if (fr.droppedObjectUrl) {
    URL.revokeObjectURL(fr.droppedObjectUrl);
    fr.droppedObjectUrl = null;
  }
  const preview = $("fringe-preview");
  if (preview) preview.src = state._hosted ? "" : "/stream";
}

// ── Averaging helpers ──────────────────────────────────────────────────

function computeAverage() {
  const accepted = fr.avgCaptures.filter(c => c.accepted);
  if (accepted.length === 0) return null;
  const n = accepted[0].coefficients.length;
  const avg = new Float64Array(n);
  for (const cap of accepted) {
    for (let i = 0; i < n; i++) avg[i] += cap.coefficients[i];
  }
  for (let i = 0; i < n; i++) avg[i] /= accepted.length;
  return Array.from(avg);
}

function renderAvgLog() {
  const log = $("fringe-avg-log");
  if (!log) return;
  log.textContent = "";  // clear children
  for (let i = 0; i < fr.avgCaptures.length; i++) {
    const cap = fr.avgCaptures[i];
    const el = document.createElement("div");
    el.style.cssText = "cursor:pointer;padding:1px 0;display:flex;align-items:center;gap:4px";
    el.title = cap.accepted ? "Click to exclude from average" : "Click to include in average";

    const iconSpan = document.createElement("span");
    iconSpan.style.color = cap.accepted ? "#30d158" : "#ff453a";
    iconSpan.textContent = cap.accepted ? "\u2713" : "\u2717";

    const textSpan = document.createElement("span");
    const reason = cap.reason ? ` (${cap.reason})` : "";
    textSpan.textContent = `#${i + 1}: ${cap.rms_nm.toFixed(1)}nm${reason}`;

    el.appendChild(iconSpan);
    el.appendChild(textSpan);

    const idx = i;
    el.addEventListener("click", () => toggleCapture(idx));
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
}

async function toggleCapture(idx) {
  fr.avgCaptures[idx].accepted = !fr.avgCaptures[idx].accepted;
  renderAvgLog();
  await recomputeAverage();
}

async function recomputeAverage() {
  const accepted = fr.avgCaptures.filter(c => c.accepted);
  $("fringe-avg-count").textContent = `${accepted.length}/${fr.avgCaptures.length}`;

  if (accepted.length < 1) return;
  const avgCoeffs = computeAverage();
  if (!avgCoeffs || accepted.length < 2) return;

  const body = {
    coefficients: avgCoeffs,
    subtract_terms: getSubtractTerms(),
    wavelength_nm: getWavelength(),
    surface_height: fr.avgSurfaceHeight,
    surface_width: fr.avgSurfaceWidth,
  };
  // Full-fidelity path — preserve high-frequency detail when recomputing the
  // averaged surface (e.g. after toggling a subtract pill or changing form
  // model). Guard: the averaged result may lack a raw grid, in which case
  // the backend transparently falls back to coefficient-only reconstruction.
  if (fr.lastResult && fr.lastResult.raw_height_grid_nm
      && fr.lastResult.grid_rows && fr.lastResult.grid_cols) {
    body.raw_height_grid_nm = fr.lastResult.raw_height_grid_nm;
    body.raw_grid_rows = fr.lastResult.grid_rows;
    body.raw_grid_cols = fr.lastResult.grid_cols;
  }
  const resp = await apiFetch("/fringe/reanalyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return;
  const avgData = await resp.json();
  mergeReanalyzeResult(avgData);
  fr.lastResult.coefficients = avgCoeffs;
  document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: fr.lastResult }));
}

async function addToAverage() {
  document.body.style.cursor = "wait";
  const loadingOverlay = $("fringe-loading-overlay");
  const loadingText = $("fringe-loading-text");
  if (loadingOverlay) loadingOverlay.hidden = false;
  if (loadingText) loadingText.textContent = "Capturing for average...";

  try {
    const resp = await apiFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wavelength_nm: getWavelength(),
        mask_threshold: getMaskThreshold(),
        lpf_sigma_frac: getLpfSigmaFrac(),
        dc_margin_override: getDcMarginOverride(),
        subtract_terms: getSubtractTerms(),
        mask_polygons: _buildMaskPayload(),
        form_model: getFormModel(),
        lens_k1: fr.lensK1,
        correct_2pi_jumps: getCorrect2piJumps(),
        calibration: getCalibrationPayload(),
        aperture_recipe: getAperturePayload(),
      }),
    });
    if (!resp.ok) {
      console.warn("Average capture failed");
      return;
    }
    const data = await resp.json();

    if (fr.avgCaptures.length === 0) {
      fr.avgSurfaceHeight = data.surface_height;
      fr.avgSurfaceWidth = data.surface_width;
    }

    const capture = {
      coefficients: new Float64Array(data.coefficients),
      rms_nm: data.rms_nm,
      accepted: true,
      reason: "",
    };

    // Auto-rejection: check against running average (only after 2+ accepted captures)
    const accepted = fr.avgCaptures.filter(c => c.accepted);
    if (accepted.length >= 2) {
      const avgRms = accepted.reduce((s, c) => s + c.rms_nm, 0) / accepted.length;
      const threshold = fr.avgRejectThreshold;
      if (capture.rms_nm > threshold * avgRms) {
        capture.accepted = false;
        capture.reason = `${(capture.rms_nm / avgRms).toFixed(1)}\u00d7 avg`;
      }
    }

    fr.avgCaptures.push(capture);
    renderAvgLog();
    $("fringe-btn-avg-reset").disabled = false;

    await recomputeAverage();
  } catch (e) {
    console.warn("Average error:", e);
  } finally {
    if (loadingOverlay) loadingOverlay.hidden = true;
    document.body.style.cursor = "";
  }
}

function resetAverage() {
  fr.avgCaptures = [];
  fr.avgSurfaceHeight = 0;
  fr.avgSurfaceWidth = 0;
  $("fringe-avg-count").textContent = "0";
  const log = $("fringe-avg-log");
  if (log) log.textContent = "";
  $("fringe-btn-avg-reset").disabled = true;
  if (fr.lastResult) {
    document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: fr.lastResult }));
  }
}

// ── Focus quality polling ──────────────────────────────────────────────

function _updateFocusUI(score) {
  const color = score < 30 ? "var(--danger)" : score < 60 ? "var(--warning)" : "var(--success)";

  const fill = $("fringe-focus-fill");
  const label = $("fringe-focus-score");
  if (fill) { fill.style.width = score + "%"; fill.style.background = color; }
  if (label) label.textContent = score.toFixed(0);

  // Expanded preview overlay score
  const bigScore = $("fringe-focus-big-score");
  if (bigScore) {
    bigScore.textContent = score.toFixed(0);
    bigScore.style.color = color;
  }
}

async function pollFocusQuality() {
  if (state._hosted) { stopPolling(); return; }
  try {
    const r = await apiFetch("/fringe/focus-quality");
    if (!r.ok) return;
    const data = await r.json();
    _updateFocusUI(data.score);
  } catch { /* ignore */ }
}

let _expandedPolling = null;

export function startPolling() {
  if (state._hosted) return;  // no camera in hosted mode
  // Ensure preview shows the live stream (src is blank until first poll)
  const preview = $("fringe-preview");
  if (preview && !preview.src.includes("/stream") && !fr.droppedImageB64) {
    preview.src = "/stream";
  }
  stopPolling();
  pollFocusQuality();
  fr.polling = setInterval(pollFocusQuality, 2000);
}

export function stopPolling() {
  if (fr.polling) {
    clearInterval(fr.polling);
    fr.polling = null;
  }
  _closeExpandedPreview();
}

function _openExpandedPreview() {
  if ($("fringe-expanded-preview")) return;

  const resultsCol = document.querySelector(".fringe-results-col");
  if (!resultsCol) return;

  const overlay = document.createElement("div");
  overlay.id = "fringe-expanded-preview";
  overlay.className = "fringe-expanded-preview";
  overlay.innerHTML = `
    <img src="${state._hosted ? '' : '/stream'}" draggable="false" style="width:100%;height:100%;object-fit:contain;display:block" />
    <div class="fringe-expanded-focus">
      <span style="font-size:13px;opacity:0.7">Focus</span>
      <span id="fringe-focus-big-score" style="font-size:48px;font-weight:700;line-height:1">--</span>
    </div>
    <div style="position:absolute;bottom:12px;left:0;right:0;text-align:center;font-size:11px;opacity:0.4">
      Click or Esc to close
    </div>
  `;
  overlay.addEventListener("click", _closeExpandedPreview);
  resultsCol.appendChild(overlay);

  // Accelerate polling to 500ms
  if (fr.polling) clearInterval(fr.polling);
  pollFocusQuality();
  _expandedPolling = setInterval(pollFocusQuality, 500);

  // Escape key listener
  overlay._escHandler = (e) => { if (e.key === "Escape") _closeExpandedPreview(); };
  document.addEventListener("keydown", overlay._escHandler);
}

function _closeExpandedPreview() {
  const overlay = $("fringe-expanded-preview");
  if (!overlay) return;

  if (overlay._escHandler) document.removeEventListener("keydown", overlay._escHandler);
  overlay.remove();

  // Restore normal polling rate
  if (_expandedPolling) { clearInterval(_expandedPolling); _expandedPolling = null; }
  if (fr.polling) clearInterval(fr.polling);
  fr.polling = setInterval(pollFocusQuality, 2000);
}

// ── Panel event wiring ─────────────────────────────────────────────────

export function wirePanelEvents() {
  // Create progress bar after analyze button
  createProgressBar();

  // Initialize lens profile dropdown
  renderFringeLensDropdown();

  // Lens profile selection
  $("fringe-lens-profile")?.addEventListener("change", (e) => {
    const sel = e.target;
    if (!sel.value) {
      fr.lensK1 = 0;
    } else {
      const opt = sel.selectedOptions[0];
      fr.lensK1 = parseFloat(opt.dataset.k1) || 0;
    }
    if (fr.lastResult && !state._hosted) _runAnalysis();
  });

  // Save lens profile
  $("fringe-btn-lens-save")?.addEventListener("click", () => {
    const nameInput = $("fringe-lens-save-name");
    const name = nameInput?.value.trim();
    if (!name || !fr.lensK1) return;
    saveFringeLensProfile(name, fr.lensK1);
    renderFringeLensDropdown();
    $("fringe-lens-profile").value = name;
    $("fringe-lens-save-row").hidden = true;
  });

  // Analyze button
  $("fringe-btn-analyze")?.addEventListener("click", () => {
    if (fr.droppedImageB64) _runAnalysis();
    else analyzeFromCamera();
  });

  // Averaging buttons
  $("fringe-btn-avg-add")?.addEventListener("click", addToAverage);
  $("fringe-btn-avg-reset")?.addEventListener("click", resetAverage);
  $("fringe-avg-reject")?.addEventListener("change", (e) => {
    fr.avgRejectThreshold = parseFloat(e.target.value) || 3;
  });

  // Drag and drop
  const dropZone = $("fringe-drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("fringe-drop-active");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("fringe-drop-active");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("fringe-drop-active");
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) {
        analyzeFromFile(file);
      }
    });
  }

  // Preview click to expand
  $("fringe-preview-container")?.addEventListener("click", (e) => {
    // Don't expand on scroll-zoom (wheel events)
    if (e.target.tagName === "CANVAS") return;
    _openExpandedPreview();
  });

  // Preview scroll-to-zoom
  const previewContainer = $("fringe-preview")?.parentElement;
  if (previewContainer) {
    let zoomLevel = 1;
    previewContainer.addEventListener("wheel", (e) => {
      e.preventDefault();
      const img = $("fringe-preview");
      if (!img) return;
      zoomLevel = Math.max(1, Math.min(5, zoomLevel + (e.deltaY < 0 ? 0.2 : -0.2)));
      img.style.transform = `scale(${zoomLevel})`;
      img.style.transformOrigin = "center center";
    });
  }

  // Edit Mask — cross-mode workflow
  $("fringe-btn-edit-mask")?.addEventListener("click", async () => {
    const btn = $("fringe-btn-edit-mask");
    if (btn) { btn.disabled = true; btn.textContent = "Capturing..."; }

    try {
      let blob;
      if (fr.droppedImageB64) {
        // Convert stored base64 to blob (avoids CSP blob: fetch issues)
        const bin = atob(fr.droppedImageB64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        blob = new Blob([u8], { type: "image/png" });
      } else {
        // Freeze the current camera frame so the mask edit uses a still image
        await apiFetch("/freeze", { method: "POST" });
        const frameUrl = fr.lensK1 ? `/frame?lens_k1=${fr.lensK1}` : "/frame";
        const resp = await apiFetch(frameUrl);
        if (!resp.ok) throw new Error("Frame fetch failed");
        blob = await resp.blob();
      }

      // Set up cross-mode state
      initCrossMode({
        imageBlob: blob,
        existingMask: fr.maskPolygons.length > 0
          ? JSON.parse(JSON.stringify(fr.maskPolygons))
          : [],
        callback: (polygons) => {
          fr.maskPolygons = polygons;
          drawMaskOverlay();
          // Update clear button state
          const clearBtn = $("fringe-btn-mask-clear");
          if (clearBtn) {
            clearBtn.disabled = polygons.length === 0;
            clearBtn.style.opacity = polygons.length === 0 ? "0.6" : "1";
          }
          // Auto-analyze with new mask (skip in hosted mode to avoid CPU spikes)
          if (polygons.length > 0 && !state._hosted) {
            _runAnalysis();
          }
        },
      });

      // Switch to microscope mode
      switchMode("microscope");
      const sel = $("mode-switcher");
      if (sel) sel.value = "microscope";
    } catch (e) {
      console.warn("[fringe] Edit Mask failed:", e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Edit Mask"; }
    }
  });

  // Lens calibration — cross-mode workflow
  $("fringe-btn-lens-cal")?.addEventListener("click", () => {
    window.crossMode = {
      source: 'fringe-lens-cal',
      callback: (k1) => {
        fr.lensK1 = k1;
        // Show save prompt
        const saveRow = $("fringe-lens-save-row");
        if (saveRow) { saveRow.hidden = false; saveRow.style.display = 'flex'; }
        // Clear dropdown (no saved profile yet)
        const sel = $("fringe-lens-profile");
        if (sel) sel.value = "";
        // Re-analyze if results exist (skip in hosted mode)
        if (fr.lastResult && !state._hosted) _runAnalysis();
      },
    };

    switchMode("microscope");
    const sel = $("mode-switcher");
    if (sel) sel.value = "microscope";
  });

  // Clear mask
  $("fringe-btn-mask-clear")?.addEventListener("click", () => {
    fr.maskPolygons = [];
    drawMaskOverlay();
    const clearBtn = $("fringe-btn-mask-clear");
    if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.6"; }
  });

  // Wavelength dropdown (now in top bar) — writes through to active calibration
  const wlSel = $("fringe-wavelength");
  if (wlSel) {
    wlSel.addEventListener("change", () => {
      const customLabel = $("fringe-custom-wl-label");
      if (customLabel) customLabel.hidden = wlSel.value !== "custom";
      _persistWavelengthChange();
    });
  }
  const customInput = $("fringe-custom-wl");
  if (customInput) {
    const persist = () => _persistWavelengthChange();
    customInput.addEventListener("change", persist);
    customInput.addEventListener("input", persist);
  }

  // Mask threshold slider (now in top bar)
  const maskSlider = $("fringe-mask-thresh");
  const maskLabel = $("fringe-mask-thresh-val");
  if (maskSlider && maskLabel) {
    maskSlider.addEventListener("input", () => {
      maskLabel.textContent = maskSlider.value + "%";
    });
  }

  // M2.5 — Advanced tuning: LPF σ slider + auto checkbox
  const lpfSlider = $("fringe-lpf-sigma");
  const lpfLabel = $("fringe-lpf-sigma-val");
  const lpfAuto = $("fringe-lpf-sigma-auto");
  const syncLpfLabel = () => {
    if (!lpfLabel) return;
    if (lpfAuto && lpfAuto.checked) lpfLabel.textContent = "auto";
    else if (lpfSlider) lpfLabel.textContent = parseFloat(lpfSlider.value).toFixed(2);
  };
  if (lpfAuto && lpfSlider) {
    lpfAuto.addEventListener("change", () => {
      lpfSlider.disabled = lpfAuto.checked;
      syncLpfLabel();
    });
  }
  if (lpfSlider) lpfSlider.addEventListener("input", syncLpfLabel);
  syncLpfLabel();

  // M2.5 — Advanced tuning: DC margin number input + auto checkbox
  const dcInput = $("fringe-dc-margin");
  const dcAuto = $("fringe-dc-margin-auto");
  if (dcAuto && dcInput) {
    dcAuto.addEventListener("change", () => {
      dcInput.disabled = dcAuto.checked;
    });
  }

  // M1.4 — Aperture recipes.
  _wireRecipeControls();

  // UI honesty affordances — mode tooltip, trend banner, recipe label.
  _injectAffordances();
}

// ── UI affordances: mode tooltip / trend banner / recipe label ─────────
//
// These are pure label/help additions; no behavior change. Inserted after
// the panel HTML is mounted so they live next to existing controls without
// modifying the buildResultsHtml template.

function _injectAffordances() {
  // Item 1 — Mode switcher honesty: (i) icon + tooltip next to dropdown.
  const modeSel = document.getElementById("fringe-mode-select");
  if (modeSel && !document.getElementById("fringe-mode-info")) {
    const info = document.createElement("span");
    info.id = "fringe-mode-info";
    info.textContent = "\u24D8";  // circled lowercase i
    info.title =
      "Mode is a UI label and tool-visibility filter only \u2014 it does not " +
      "change the analysis. To change algorithm behavior, use the Settings \u25BE " +
      "\u2192 Advanced tuning controls.";
    info.style.cssText =
      "margin-left:4px;font-size:11px;opacity:0.55;cursor:help;user-select:none";
    modeSel.insertAdjacentElement("afterend", info);
  }

  // Item 2 — Trend tab session-scope banner.
  const trendPanel = document.getElementById("fringe-panel-trend");
  if (trendPanel && !document.getElementById("fringe-trend-scope-banner")) {
    const banner = document.createElement("div");
    banner.id = "fringe-trend-scope-banner";
    banner.style.cssText =
      "padding:4px 12px;font-size:11px;opacity:0.6;font-style:italic;line-height:1.4";
    banner.textContent =
      "Session-scoped data \u2014 captures are evicted on session timeout " +
      "(default 30 min) or server restart. To preserve a measurement series, " +
      "export each result and reimport in a future session.";
    trendPanel.insertBefore(banner, trendPanel.firstChild);
  }

  // Item 3 — Recipe save: rename + subtitle clarifying polygon-only support.
  const btnSave = document.getElementById("fringe-recipe-save");
  if (btnSave) {
    btnSave.innerHTML = "Save polygon as recipe&hellip;";
    btnSave.title =
      "Snapshot the currently drawn mask polygons as a reusable aperture recipe.";
  }
  const recipeSel = document.getElementById("fringe-recipe-select");
  if (recipeSel && !document.getElementById("fringe-recipe-circle-help")) {
    // Insert subtitle just below the button row (which is the next sibling
    // div with display:flex). Find the existing helper text and insert
    // before it so the order reads: select / buttons / circle-help / helper.
    const buttonRow = recipeSel.parentElement?.querySelector(
      'div[style*="flex-wrap"]'
    );
    if (buttonRow) {
      const sub = document.createElement("div");
      sub.id = "fringe-recipe-circle-help";
      sub.style.cssText =
        "font-size:10px;opacity:0.55;margin-top:3px;line-height:1.3;font-style:italic";
      sub.textContent =
        "Circle and ring apertures: import via the Manage \u2192 Import button " +
        "using a hand-edited JSON. UI for drawing them is not yet built.";
      buttonRow.insertAdjacentElement("afterend", sub);
    }
  }
}

// ── M1.4 — Aperture recipe UI wiring ───────────────────────────────────

/**
 * Refresh the recipe <select> and summary-bar badge to match storage.
 * Called on every change (save/delete/import/active-change).
 */
export function refreshRecipeUi() {
  const sel = document.getElementById("fringe-recipe-select");
  if (sel) {
    const list = listRecipes();
    const activeId = getActiveRecipeId();
    const opts = ['<option value="">None (auto-mask)</option>']
      .concat(list.map((r) => {
        const safe = (r.name || "Untitled").replace(/[<>&"]/g, (c) => ({
          "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;",
        }[c]));
        return `<option value="${r.id}"${r.id === activeId ? " selected" : ""}>${safe} (${r.kind})</option>`;
      }));
    sel.innerHTML = opts.join("");
  }
  const badge = document.getElementById("fringe-summary-recipe");
  const nameEl = document.getElementById("fringe-summary-recipe-name");
  const active = getActiveRecipe();
  if (badge && nameEl) {
    if (active) {
      nameEl.textContent = active.name;
      badge.hidden = false;
    } else {
      badge.hidden = true;
      nameEl.textContent = "";
    }
  }
}

function _wireRecipeControls() {
  const sel = $("fringe-recipe-select");
  const btnSave = $("fringe-recipe-save");
  const btnManage = $("fringe-recipe-manage");
  const btnExport = $("fringe-recipe-export");
  const btnImport = $("fringe-recipe-import");
  const fileInput = $("fringe-recipe-import-file");

  refreshRecipeUi();

  if (sel) {
    sel.addEventListener("change", () => {
      setActiveRecipeId(sel.value || null);
      refreshRecipeUi();
    });
  }

  if (btnSave) {
    btnSave.addEventListener("click", () => _saveCurrentAsRecipe());
  }

  if (btnManage) {
    btnManage.addEventListener("click", () => _manageRecipes());
  }

  if (btnExport) {
    btnExport.addEventListener("click", () => {
      try {
        const json = exportRecipesJson();
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `loupe-aperture-recipes-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        window.alert(`Export failed: ${e.message || e}`);
      }
    });
  }

  if (btnImport && fileInput) {
    btnImport.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const result = importRecipesJson(text);
        refreshRecipeUi();
        const msg = [`Imported ${result.added} recipe(s).`]
          .concat(result.errors.length > 0 ? ["Errors:", ...result.errors] : [])
          .join("\n");
        window.alert(msg);
      } catch (e) {
        window.alert(`Import failed: ${e.message || e}`);
      } finally {
        fileInput.value = "";
      }
    });
  }
}

/**
 * "Save current as recipe" — snapshot the currently drawn mask polygons
 * into a polygon recipe.  Requires at least one mask polygon.
 */
function _saveCurrentAsRecipe() {
  if (!Array.isArray(fr.maskPolygons) || fr.maskPolygons.length === 0) {
    window.alert(
      "No mask polygons drawn.  Use \"Edit Mask\" first to draw one, then save it as a recipe.\n\n" +
      "(Only polygon recipes can be saved from the UI; circle/ring recipes can be imported from JSON.)"
    );
    return;
  }
  const defaultName = `Recipe ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const name = window.prompt("Name for this aperture recipe:", defaultName);
  if (!name) return;
  // Snapshot the current preview resolution for cross-resolution warnings.
  const img = document.getElementById("fringe-preview");
  const srcRes = (img && img.naturalWidth && img.naturalHeight)
    ? { width: img.naturalWidth, height: img.naturalHeight }
    : null;
  const polygons = fr.maskPolygons.map((p) => ({
    vertices: p.vertices.map((v) => [v.x, v.y]),
    include: p.include !== false,
  }));
  try {
    const saved = saveRecipe({
      kind: "polygon",
      name: name.trim(),
      polygons,
      notes: "",
      ...(srcRes ? { source_resolution: srcRes } : {}),
    });
    setActiveRecipeId(saved.id);
    refreshRecipeUi();
  } catch (e) {
    window.alert(`Could not save recipe: ${e.message || e}`);
  }
}

/**
 * Minimal "Manage" flow: numbered list with a delete-by-number UX, per the
 * M1.2 calibration manage pattern.
 */
function _manageRecipes() {
  const list = listRecipes();
  if (list.length === 0) {
    window.alert("No saved recipes.");
    return;
  }
  const activeId = getActiveRecipeId();
  const lines = list.map((r, i) => {
    const marker = r.id === activeId ? "  [active]" : "";
    return `${i + 1}. ${r.name} (${r.kind})${marker}`;
  }).join("\n");
  const raw = window.prompt(
    `Saved aperture recipes:\n${lines}\n\n` +
    `Enter a number to activate, "delete <n>" to remove, "clear" to deactivate:`,
    ""
  );
  if (raw === null) return;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return;
  if (trimmed === "clear") {
    setActiveRecipeId(null);
    refreshRecipeUi();
    return;
  }
  const delMatch = trimmed.match(/^delete\s+(\d+)$/);
  if (delMatch) {
    const idx = parseInt(delMatch[1], 10) - 1;
    const target = list[idx];
    if (!target) { window.alert("Out of range."); return; }
    if (window.confirm(`Delete "${target.name}"?`)) {
      deleteRecipe(target.id);
      refreshRecipeUi();
    }
    return;
  }
  const idx = parseInt(trimmed, 10) - 1;
  const target = list[idx];
  if (!target) { window.alert("Out of range."); return; }
  setActiveRecipeId(target.id);
  refreshRecipeUi();
}
