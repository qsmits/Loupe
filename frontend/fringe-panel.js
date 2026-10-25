// fringe-panel.js — Left panel template, capture workflow, mask drawing,
// averaging, and focus polling for fringe mode.
//
// Extracted from fringe.js (Task 6 of fringe UI restructure).

import { fr, $ } from './fringe.js';
import { recoverOrientationObservations } from './fringe-orientation.js';
import { state } from './state.js';
import { getSubtractTerms, getFormModel, mergeReanalyzeResult, applySignFlipToLastResult, restoreFringeResult, captureFringeOptions } from './fringe-results.js';
import { apiFetch } from './api.js';
import { fringeFetch, isBrowserResult } from './fringe-compute.js';
import { analyzeWithProgress, cancelAnalysis, hideProgress } from './fringe-progress.js';
import { initFringeSetup, openFringeSetup, closeFringeSetup, showFringeAnalysisProgress, showFringeAnalysisError, refreshRegionEditor } from './fringe-setup.js';
import { openFringeLensCal } from './fringe-lens-cal.js';
import { imageWidth, imageHeight } from './viewport.js';
import { lensK1ToDiagNormalized } from './math.js';
import { showToast } from './shell.js';
import { prepareInterferogramUpload, bytesToBase64, mimeFromBase64, FRINGE_UPLOAD_MAX_DIM } from './fringe-upload.js';
import { bindImageDropTargets } from './image-drop.js';
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
  if (!sel) return 589.3;
  if (sel.value === "custom") {
    const el = $("fringe-custom-wl");
    const v = parseFloat(el?.value || "589.3");
    return Number.isFinite(v) && v > 0 ? v : 589.3;
  }
  const opt = sel.selectedOptions[0];
  if (opt && opt.dataset.nm) return parseFloat(opt.dataset.nm);
  return 589.3;
}

/** Build the `calibration` payload for /fringe/analyze* requests. */
export function getCalibrationPayload() {
  const payload = calibrationPayload(getActiveCalibration());
  return payload ? { ...payload, lens_k1: fr.lensK1 } : payload;
}

function _setAppliedLensK1(k1) {
  fr.lensK1 = Number.isFinite(Number(k1)) ? Number(k1) : 0;
  // Every caller of _setAppliedLensK1 passes an already-converted,
  // dimensionless k1 (a fresh fit, 0 for "None", or an already-converted
  // profile value) — never an unconverted pixel_v0 number. Recorded
  // explicitly so a later profile save never has to guess.
  fr.lensK1Space = "diag_normalized_v1";
  const active = getActiveCalibration();
  if (active && active.lens_k1 !== fr.lensK1) {
    try { saveCalibration({ ...active, lens_k1: fr.lensK1 }); }
    catch (_) { /* validated above; persistence failure is non-fatal */ }
  }
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
  return el ? parseInt(el.value, 10) / 100 : 0.30;
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
        <div class="fringe-preview-container fringe-image-drop-target" id="fringe-preview-container" style="position:relative;cursor:pointer" title="Drop an interferogram here, or click to expand preview">
          <img id="fringe-preview" alt="Camera preview" draggable="false" />
          <canvas id="fringe-roi-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
        </div>
        <div class="fringe-focus-bar-container">
          <label style="font-size:11px;opacity:0.7">Focus</label>
          <div class="fringe-focus-bar">
            <div class="fringe-focus-fill" id="fringe-focus-fill" style="width:0%"></div>
          </div>
          <span id="fringe-focus-score" style="font-size:11px;min-width:30px;text-align:right">--</span>
        </div>

        <div class="fringe-source-card">
          <strong id="fringe-source-name">No image selected</strong>
          <span id="fringe-analysis-status" role="status">Choose an image to get started.</span>
        </div>
        <div class="fringe-source-actions">
          <button class="detect-btn fringe-primary" id="fringe-btn-open">Open image…</button>
          <button class="detect-btn" id="fringe-btn-camera">Capture camera</button>
          <button class="detect-btn" id="fringe-btn-analyze" disabled>Analysis settings…</button>
          <button class="detect-btn" id="fringe-btn-reset" disabled>Reset analysis</button>
        </div>
        <input type="file" id="fringe-image-file" accept="image/*" hidden />

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
          <label style="font-size:11px;opacity:0.7;white-space:nowrap">Lens:</label>
          <select id="fringe-lens-profile" style="flex:1;font-size:11px;padding:2px 4px"></select>
          <button class="detect-btn" id="fringe-btn-lens-cal" style="padding:4px 10px;font-size:11px">Calibrate</button>
        </div>
        <div id="fringe-lens-save-row" hidden style="gap:4px;align-items:center;margin-top:4px">
          <input type="text" id="fringe-lens-save-name" placeholder="Profile name" style="flex:1;font-size:11px;padding:2px 4px" />
          <button class="detect-btn" id="fringe-btn-lens-save" style="padding:4px 8px;font-size:11px">Save</button>
        </div>

        <button class="fringe-drop-zone" id="fringe-drop-zone">Drop an interferogram here, or click to choose an image</button>
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
  // A brand-new capture is unrelated to any pending running-average
  // orientation toggle (Task 9) — don't let a stale flag auto-invert it.
  fr.avgInverted = false;
  document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: data }));

  const avgBtn = $("fringe-btn-avg-add");
  if (avgBtn) { avgBtn.disabled = isBrowserResult(data); avgBtn.title = isBrowserResult(data) ? "Analyze separate images, then average their captures in Session." : "Capture another camera frame for averaging"; }
  const invBtn = $("fringe-btn-invert");
  if (invBtn) invBtn.disabled = false;
  const pdfBtn = $("fringe-btn-export-pdf");
  if (pdfBtn) pdfBtn.disabled = false;
  const csvBtn = $("fringe-btn-export-csv");
  if (csvBtn) csvBtn.disabled = false;
}

// Invalidates file decoding/camera captures as well as streamed analyses.
let sourceVersion = 0;
let orientationRecovery = null;

export function cancelFringeWork() {
  orientationRecovery = null;
  sourceVersion++;
  cancelAnalysis();
  closeFringeSetup();
  if (fr.analysisBusy) {
    fr.analysisBusy = false;
    updateAnalysisSource('Analysis cancelled — ready to try again.');
  }
}

export function updateAnalysisSource(message) {
  const name = fr.sourceName || (fr.droppedImageB64 ? 'Imported interferogram' : 'No image selected');
  if ($('fringe-source-name')) $('fringe-source-name').textContent = name;
  if ($('fringe-analysis-status')) $('fringe-analysis-status').textContent = message ||
    (fr.lastResult ? 'Analysis complete' + (fr.analyzedAt ? ' · ' + new Date(fr.analyzedAt).toLocaleTimeString() : '')
      : fr.droppedImageB64 ? 'Image loaded — not analyzed yet.' : 'Choose an image to get started.');
  if ($('fringe-btn-analyze')) $('fringe-btn-analyze').disabled = !fr.droppedImageB64 || fr.analysisBusy;
  if ($('fringe-btn-reset')) $('fringe-btn-reset').disabled = !fr.droppedImageB64 && !fr.lastResult && !fr.analysisBusy;
  if ($('fringe-btn-camera')) $('fringe-btn-camera').hidden = !!state._hosted;
  const focus = document.querySelector('.fringe-focus-bar-container');
  if (focus) focus.hidden = !!fr.droppedImageB64 || !!state._hosted;
}

function clearCurrentResult() {
  const options = captureFringeOptions();
  fr.lastResult = fr.lastMask = null;
  fr.heightGrid = fr.maskGrid = fr.trustedMaskGrid = null;
  fr.gridRows = fr.gridCols = 0;
  fr.measurePoints = []; fr.stepRegions = []; fr.measurements = [];
  fr.measureMode = null; fr.lastAreaRect = null; fr.stepDragIdx = -1; fr.stepDragOffset = null;
  fr.carrierOverride = null; fr.analyzedAt = null;
  fr.selectedCaptureId = null;
  resetAverage();
  restoreFringeResult(null, options);
  if ($('fringe-btn-avg-add')) $('fringe-btn-avg-add').disabled = true;
  document.querySelector('.fringe-tab[data-tab="surface"]')?.click();
}

export function resetFringeAnalysis() {
  cancelFringeWork();
  hideProgress();
  clearCurrentResult();
  clearDroppedImage();
  fr.maskPolygons = [];
  setActiveRecipeId(null);
  refreshRecipeUi();
  drawMaskOverlay();
  updateAnalysisSource('Reset — choose an image for a new analysis.');
}

export function showAnalysisSetup() {
  if (fr.analysisBusy) return;
  if (!fr.droppedImageB64) { $('fringe-image-file')?.click(); return; }
  openFringeSetup(fr.droppedObjectUrl || `data:${mimeFromBase64(fr.droppedImageB64)};base64,${fr.droppedImageB64}`,
    fr.sourceName || 'Imported interferogram');
}

async function analyzeFromCamera() {
  if (state._hosted) return;
  cancelFringeWork();
  const version = sourceVersion, epoch = state._epoch;
  const btn = $('fringe-btn-camera');
  btn.disabled = true;
  updateAnalysisSource('Capturing camera image…');
  try {
    const frozen = await apiFetch('/freeze', {method: 'POST'});
    if (!frozen.ok) throw new Error('Could not capture camera frame');
    if (version !== sourceVersion || epoch !== state._epoch) return;
    const response = await apiFetch('/frame');
    if (!response.ok) throw new Error('Camera returned no frame');
    const blob = await response.blob();
    if (version !== sourceVersion || epoch !== state._epoch) return;
    await analyzeFromFile(new File([blob], 'Camera capture', {type: blob.type || 'image/jpeg'}));
  } catch (error) {
    if (version !== sourceVersion || epoch !== state._epoch) return;
    updateAnalysisSource(error.message);
    showToast(error.message);
  } finally { btn.disabled = false; }
}

/** Only the dialog's Analyze action starts a new analysis. */
function _runAnalysis(formModel = getFormModel(), engine = fr.analysisEngine, method = fr.analysisMethod) {
  if (fr.analysisBusy || !fr.droppedImageB64) return;
  fr.analysisEngine = engine === "browser" ? "browser" : "server";
  fr.analysisMethod = method === "hybrid" ? "hybrid" : "current";
  const version = sourceVersion, epoch = state._epoch;
  const recovery=orientationRecovery;
  orientationRecovery=null;
  _checkRecipeResolution();
  const payload = {
    wavelength_nm: getWavelength(),
    mask_threshold: getMaskThreshold(),
    analysis_method: fr.analysisMethod,
    lpf_sigma_frac: getLpfSigmaFrac(),
    dc_margin_override: getDcMarginOverride(),
    subtract_terms: getSubtractTerms(),
    mask_polygons: _buildMaskPayload(),
    form_model: formModel,
    lens_k1: fr.lensK1,
    correct_2pi_jumps: getCorrect2piJumps(),
    calibration: getCalibrationPayload(),
    aperture_recipe: getAperturePayload(),
    execution_engine: fr.analysisEngine,
    image_b64: fr.droppedImageB64,
  };
  clearCurrentResult();
  restoreFringeResult(null, {...captureFringeOptions(), formModel});
  fr.analysisBusy = true;
  updateAnalysisSource('Analyzing…');
  showFringeAnalysisProgress();
  analyzeWithProgress(payload, data => {
    if (version !== sourceVersion || epoch !== state._epoch) return;
    fr.analysisBusy = false;
    fr.analyzedAt = new Date().toISOString();
    const recovered=recovery && recoverOrientationObservations(recovery, data);
    _onAnalysisResult(data);
    closeFringeSetup();
    if (recovery) {
      $('fringe-orientation-open')?.click();
      if (!recovered) showToast('The analysis image alignment changed. Place the contact mark again before checking direction.');
    }
    updateAnalysisSource();
  }, errMsg => {
    if (version !== sourceVersion || epoch !== state._epoch) return;
    fr.analysisBusy = false;
    orientationRecovery=recovery;
    updateAnalysisSource('Analysis failed — adjust settings and try again.');
    showFringeAnalysisError();
    console.warn('Fringe analysis failed:', errMsg);
  });
}

export async function analyzeFromFile(file) {
  cancelFringeWork();
  const version = sourceVersion, epoch = state._epoch;
  updateAnalysisSource('Preparing image…');
  try {
    const prepared = await prepareInterferogramUpload(file);
    if (version !== sourceVersion || epoch !== state._epoch) return;
    const b64 = bytesToBase64(prepared.bytes);
    clearCurrentResult();
    clearDroppedImage();
    fr.maskPolygons = [];
    fr.sourceName = file.name || 'Imported interferogram';
    fr.droppedImageB64 = b64;
    fr.droppedObjectUrl = URL.createObjectURL(prepared.blob);
    const preview = $('fringe-preview');
    if (preview) { preview.style.transform = ''; preview.src = fr.droppedObjectUrl; }
    drawMaskOverlay();
    updateAnalysisSource();
    showAnalysisSetup();
    if (prepared.scaled) showToast(`Downscaled ${prepared.originalWidth}×${prepared.originalHeight} → ${prepared.width}×${prepared.height} for analysis (limit ${FRINGE_UPLOAD_MAX_DIM} px).`);
  } catch (error) {
    if (version !== sourceVersion || epoch !== state._epoch) return;
    updateAnalysisSource('Could not load image: ' + error.message);
    showToast('Could not load image: ' + error.message);
  }
}

/** Clear the selected source; settings and saved calibration remain available. */
export function clearDroppedImage() {
  fr.droppedImageB64 = null;
  fr.sourceName = null;
  if (fr.droppedObjectUrl) URL.revokeObjectURL(fr.droppedObjectUrl);
  fr.droppedObjectUrl = null;
  const preview = $('fringe-preview');
  if (preview) { preview.style.transform = ''; preview.src = state._hosted ? '' : '/stream'; }
}

// ── Averaging helpers ──────────────────────────────────────────────────

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

/**
 * Surface a failed recompute to the user instead of silently freezing the
 * display (Task 9). Logged to the console, toasted, and appended to the
 * averaging log so it's visible even after the toast times out.
 */
function _reportAvgError(msg) {
  console.warn("[fringe] average recompute:", msg);
  showToast(msg);
  const log = $("fringe-avg-log");
  if (log) {
    const el = document.createElement("div");
    el.style.cssText = "padding:2px 0;color:#ff9f0a;font-weight:600";
    el.textContent = `⚠ ${msg}`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }
}

async function _extractErrorDetail(resp) {
  let msg = `HTTP ${resp.status}`;
  try {
    const j = await resp.json();
    if (j && j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
  } catch (_e) { /* non-json body */ }
  return msg;
}

async function recomputeAverage() {
  const version = sourceVersion, epoch = state._epoch;
  const current = () => version === sourceVersion && epoch === state._epoch;
  const accepted = fr.avgCaptures.filter(c => c.accepted);
  $("fringe-avg-count").textContent = `${accepted.length}/${fr.avgCaptures.length}`;

  if (accepted.length < 1) return;

  // A one-item "average" is exactly that capture. Load its full cached
  // result instead of leaving a stale multi-capture average on screen.
  if (accepted.length === 1) {
    const resp = await fringeFetch(
      `/fringe/session/capture/${encodeURIComponent(accepted[0].id)}`
    );
    if (!resp.ok) {
      const detail = await _extractErrorDetail(resp);
      _reportAvgError(`Couldn't load the running average (${detail}). Showing the last successful result.`);
      return;
    }
    const data = await resp.json();
    if (!current()) return;
    fr.lastResult = data;
    // Task 9: reapply an active invert — the fetched capture is server
    // truth and was never inverted.
    if (fr.avgInverted) {
      const ok = await applySignFlipToLastResult();
      if (!ok) {
        _reportAvgError("Averaging updated, but the sign flip couldn't be reapplied — check orientation before trusting sign-sensitive readings.");
      }
    }
    if (current() && fr.lastResult) document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: fr.lastResult }));
    return;
  }

  // New captures need an explicit physical-polarity check. Retain that
  // decision on the capture entry, so toggling/recomputing the same set
  // does not repeatedly prompt. Resetting starts a new set.
  if (accepted.some(c => c.polarity !== 1)) {
    if (!window.confirm("Confirm that these running-average captures share the same physical height sign and the optical-flat wedge has not reversed. If unsure, cancel and use the Session average's per-capture polarity selectors.")) {
      _reportAvgError("Average not updated: relative height polarity was not confirmed. Showing the last successful result.");
      return;
    }
    accepted.forEach(c => { c.polarity = 1; });
  }
  const body = {
    source_ids: accepted.map(c => c.id),
    source_polarities: accepted.map(c => c.polarity),
    wavelength_nm: getWavelength(),
    rejection: "none",
    // Task 9: this is a live-preview recompute (fires on every capture
    // add/toggle), not an explicit save — don't let it consume FIFO
    // capture slots. ~51 averaged frames used to push this past
    // _CAPTURES_PER_SESSION and evict the very source captures the next
    // recompute needed, 404ing on itself.
    record: false,
  };
  const resp = await fringeFetch("/fringe/average", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await _extractErrorDetail(resp);
    _reportAvgError(`Average recompute failed (${detail}). Showing the last successful average.`);
    return;
  }
  const avgData = await resp.json();
  if (!current()) return;
  fr.lastResult = { ...avgData };
  // Task 12: this is the wholesale-replace path -- fr.lastResult was just
  // set fresh from avgData above, a genuinely different derived result
  // from doReanalyze/invertWavefront's same-measurement merges. Let an
  // absent trust field clear rather than inherit anything stale.
  mergeReanalyzeResult(avgData, { clearTrust: true });
  // Task 9: reapply an active invert — the server-computed average was
  // never inverted.
  if (fr.avgInverted) {
    const ok = await applySignFlipToLastResult();
    if (!ok) {
      _reportAvgError("Averaging updated, but the sign flip couldn't be reapplied — check orientation before trusting sign-sensitive readings.");
    }
  }
  if (current() && fr.lastResult) document.dispatchEvent(new CustomEvent("fringe:analyzed", { detail: fr.lastResult }));
}

async function addToAverage() {
  if (isBrowserResult()) { showToast("Analyze separate images, then average their captures in Session."); return; }
  const version = sourceVersion, epoch = state._epoch;
  document.body.style.cursor = "wait";
  const loadingOverlay = $("fringe-loading-overlay");
  const loadingText = $("fringe-loading-text");
  if (loadingOverlay) loadingOverlay.hidden = false;
  if (loadingText) loadingText.textContent = "Capturing for average...";

  try {
    const resp = await fringeFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wavelength_nm: getWavelength(),
        mask_threshold: getMaskThreshold(),
        analysis_method: fr.analysisMethod,
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
    if (version !== sourceVersion || epoch !== state._epoch) return;

    if (fr.avgCaptures.length === 0) {
      fr.avgSurfaceHeight = data.surface_height;
      fr.avgSurfaceWidth = data.surface_width;
    }

    const capture = {
      id: data.id,
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

export function resetAverage() {
  fr.avgCaptures = [];
  fr.avgSurfaceHeight = 0;
  fr.avgSurfaceWidth = 0;
  fr.avgInverted = false;
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
  if (state._hosted || fr.droppedImageB64) return;
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
    <img src="${fr.droppedObjectUrl || (fr.droppedImageB64 ? `data:${mimeFromBase64(fr.droppedImageB64)};base64,${fr.droppedImageB64}` : state._hosted ? '' : '/stream')}" draggable="false" style="width:100%;height:100%;object-fit:contain;display:block" />
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
  initFringeSetup(_runAnalysis, cancelFringeWork);
  updateAnalysisSource();

  // Initialize lens profile dropdown
  renderFringeLensDropdown();

  // Lens profile selection
  $("fringe-lens-profile")?.addEventListener("change", (e) => {
    const sel = e.target;
    if (!sel.value) {
      _setAppliedLensK1(0);
    } else {
      const opt = sel.selectedOptions[0];
      const rawK1 = parseFloat(opt.dataset.k1) || 0;
      const w = imageWidth || fr.lastResult?.image_width || 0;
      const h = imageHeight || fr.lastResult?.image_height || 0;
      const diag2 = (w * w + h * h) / 4;
      const k1 = lensK1ToDiagNormalized(rawK1, opt.dataset.coefficientSpace, diag2);
      if (k1 === null) {
        // Diagonal unknown (no interferogram captured/frozen yet) — defer
        // rather than apply an unconverted pixel-space value as if it were
        // already dimensionless. The stored profile keeps its pixel_v0 tag
        // untouched, so reselecting it once an image is available converts
        // it correctly; nothing here overwrites fr.lensK1 in the meantime.
        sel.value = "";
        showToast("Capture or freeze an interferogram first, then reselect this lens profile to apply it.");
        return;
      }
      _setAppliedLensK1(k1);
    }
    if (fr.droppedImageB64) showAnalysisSetup();
  });

  // Save lens profile
  $("fringe-btn-lens-save")?.addEventListener("click", () => {
    const nameInput = $("fringe-lens-save-name");
    const name = nameInput?.value.trim();
    if (!name || !Number.isFinite(fr.lensK1)) return;
    saveFringeLensProfile(name, fr.lensK1, fr.lensK1Space || "diag_normalized_v1");
    renderFringeLensDropdown();
    $("fringe-lens-profile").value = name;
    $("fringe-lens-save-row").hidden = true;
  });

  $('fringe-btn-analyze')?.addEventListener('click', showAnalysisSetup);
  $('fringe-btn-camera')?.addEventListener('click', analyzeFromCamera);
  $('fringe-btn-reset')?.addEventListener('click', resetFringeAnalysis);
  const chooseFile = () => $('fringe-image-file')?.click();
  $('fringe-btn-open')?.addEventListener('click', chooseFile);
  $('fringe-drop-zone')?.addEventListener('click', chooseFile);
  $('fringe-image-file')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) analyzeFromFile(file);
  });
  document.addEventListener('fringe:setup', showAnalysisSetup);
  document.addEventListener('fringe:orientation-reanalyze', () => {
    orientationRecovery=fr.droppedImageB64 ? fr.lastResult : null;
    showAnalysisSetup();
  });

  // Averaging buttons
  $("fringe-btn-avg-add")?.addEventListener("click", addToAverage);
  $("fringe-btn-avg-reset")?.addEventListener("click", resetAverage);
  $("fringe-avg-reject")?.addEventListener("change", (e) => {
    fr.avgRejectThreshold = parseFloat(e.target.value) || 3;
  });

  bindImageDropTargets([
    $("fringe-drop-zone"),
    $("fringe-preview-container"),
    document.querySelector(".fringe-results-col"),
    $("fringe-setup-dialog"),
  ], analyzeFromFile, () => showToast("Drop an image file to load an interferogram."));
  $("fringe-preview")?.addEventListener("load", drawMaskOverlay);

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

  // Lens calibration stays in the fringe project with its own target image.
  $("fringe-btn-lens-cal")?.addEventListener("click", () => {
    const epoch = state._epoch;
    openFringeLensCal({
      isCurrent: () => state._epoch === epoch,
      captureImage: state._hosted || state._noCamera ? null : async () => {
        const frozen = await apiFetch('/freeze', {method:'POST'});
        if (!frozen.ok) throw new Error('Could not capture camera frame');
        const response = await apiFetch('/frame');
        if (!response.ok) throw new Error('Camera returned no frame');
        const blob = await response.blob();
        return new File([blob], 'Camera calibration image', {type:blob.type || 'image/jpeg'});
      },
      onConfirm: (k1) => {
        _setAppliedLensK1(k1);
        // Show save prompt
        const saveRow = $("fringe-lens-save-row");
        if (saveRow) { saveRow.hidden = false; saveRow.style.display = 'flex'; }
        renderFringeLensDropdown(k1);
        // Keep the interferogram and let the user start a corrected analysis.
        if (fr.droppedImageB64) showAnalysisSetup();
      },
    });
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
    btnSave.innerHTML = "Save regions as recipe&hellip;";
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
        "For a ring, include an outer circle and exclude an inner circle using three edge points for each.";
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
  refreshRegionEditor();
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
      fr.maskPolygons = [];
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
      "No mask polygons drawn.  Use the analysis setup first to draw one, then save it as a recipe.\n\n" +
      "Circles, ellipses, and rectangles are saved together as reusable regions."
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
