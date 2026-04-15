// fringe-panel.js — Left panel template, capture workflow, mask drawing,
// averaging, and focus polling for fringe mode.
//
// Extracted from fringe.js (Task 6 of fringe UI restructure).

import { fr, $ } from './fringe.js';
import { getSubtractTerms, getFormModel, mergeReanalyzeResult } from './fringe-results.js';
import { apiFetch } from './api.js';
import { analyzeWithProgress, createProgressBar } from './fringe-progress.js';
import { initCrossMode } from './cross-mode.js';
import { switchMode } from './modes.js';
import { loadFringeLensProfiles, renderFringeLensDropdown, saveFringeLensProfile } from './fringe-lens-profiles.js';

// ── Helpers ────────────────────────────────────────────────────────────

export function getWavelength() {
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

export function getMaskThreshold() {
  const el = $("fringe-mask-thresh");
  return el ? parseInt(el.value, 10) / 100 : 0.15;
}

// ── Left panel HTML template ───────────────────────────────────────────

export function buildPanelHtml() {
  return `
        <div class="fringe-preview-container" style="position:relative">
          <img id="fringe-preview" src="/stream" alt="Camera preview" />
          <canvas id="fringe-roi-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
        </div>
        <div class="fringe-focus-bar-container">
          <label style="font-size:11px;opacity:0.7">Focus quality</label>
          <div class="fringe-focus-bar">
            <div class="fringe-focus-fill" id="fringe-focus-fill" style="width:0%"></div>
          </div>
          <span id="fringe-focus-score" style="font-size:11px;min-width:30px;text-align:right">--</span>
        </div>

        <button class="detect-btn" id="fringe-btn-analyze" style="padding:4px 10px;font-size:11px;width:100%">
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
        <div id="fringe-lens-save-row" hidden style="display:flex;gap:4px;align-items:center;margin-top:4px">
          <input type="text" id="fringe-lens-save-name" placeholder="Profile name" style="flex:1;font-size:11px;padding:2px 4px" />
          <button class="detect-btn" id="fringe-btn-lens-save" style="padding:4px 8px;font-size:11px">Save</button>
        </div>

        <div class="fringe-drop-zone" id="fringe-drop-zone" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
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

function _buildMaskPayload() {
  return fr.maskPolygons.length > 0
    ? fr.maskPolygons.map(p => ({
        vertices: p.vertices.map(v => [v.x, v.y]),
        include: p.include,
      }))
    : undefined;
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
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;

  const payload = {
    wavelength_nm: getWavelength(),
    mask_threshold: getMaskThreshold(),
    subtract_terms: getSubtractTerms(),
    mask_polygons: _buildMaskPayload(),
    form_model: getFormModel(),
    lens_k1: fr.lensK1,
  };
  console.log("[fringe] analyze payload:", JSON.stringify(payload));

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
    () => analyzeFromCamera(),  // retry
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

    const payload = {
      wavelength_nm: getWavelength(),
      mask_threshold: getMaskThreshold(),
      subtract_terms: getSubtractTerms(),
      image_b64: b64,
      mask_polygons: _buildMaskPayload(),
      form_model: getFormModel(),
      lens_k1: fr.lensK1,
    };

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
      () => analyzeFromFile(file),  // retry
    );
  } catch (e) {
    console.warn("Fringe file read error:", e);
    if (btn) btn.disabled = false;
  }
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

  const resp = await apiFetch("/fringe/reanalyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      coefficients: avgCoeffs,
      subtract_terms: getSubtractTerms(),
      wavelength_nm: getWavelength(),
      surface_height: fr.avgSurfaceHeight,
      surface_width: fr.avgSurfaceWidth,
    }),
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
        subtract_terms: getSubtractTerms(),
        mask_polygons: _buildMaskPayload(),
        form_model: getFormModel(),
        lens_k1: fr.lensK1,
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

async function pollFocusQuality() {
  try {
    const r = await apiFetch("/fringe/focus-quality");
    if (!r.ok) return;
    const data = await r.json();
    const fill = $("fringe-focus-fill");
    const label = $("fringe-focus-score");
    if (fill) fill.style.width = data.score + "%";
    if (label) label.textContent = data.score.toFixed(0);
    // Color: red < 30, yellow 30-60, green > 60
    if (fill) {
      if (data.score < 30) fill.style.background = "var(--danger)";
      else if (data.score < 60) fill.style.background = "var(--warning)";
      else fill.style.background = "var(--success)";
    }
  } catch { /* ignore */ }
}

export function startPolling() {
  stopPolling();
  pollFocusQuality();
  fr.polling = setInterval(pollFocusQuality, 2000);
}

export function stopPolling() {
  if (fr.polling) {
    clearInterval(fr.polling);
    fr.polling = null;
  }
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
    if (fr.lastResult) analyzeFromCamera();
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
  $("fringe-btn-analyze")?.addEventListener("click", analyzeFromCamera);

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
      // Freeze the current camera frame so the mask edit uses a still image
      await apiFetch("/freeze", { method: "POST" });

      // Fetch the frame image, undistorted when a lens correction is active
      const frameUrl = fr.lensK1 ? `/frame?lens_k1=${fr.lensK1}` : "/frame";
      const resp = await apiFetch(frameUrl);
      if (!resp.ok) throw new Error("Frame fetch failed");
      const blob = await resp.blob();

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
          // Auto-analyze with new mask
          if (polygons.length > 0) {
            analyzeFromCamera();
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
        if (saveRow) saveRow.hidden = false;
        // Clear dropdown (no saved profile yet)
        const sel = $("fringe-lens-profile");
        if (sel) sel.value = "";
        // Re-analyze if results exist
        if (fr.lastResult) analyzeFromCamera();
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

  // Wavelength dropdown (now in top bar)
  const wlSel = $("fringe-wavelength");
  if (wlSel) {
    wlSel.addEventListener("change", () => {
      const customLabel = $("fringe-custom-wl-label");
      if (customLabel) customLabel.hidden = wlSel.value !== "custom";
    });
  }

  // Mask threshold slider (now in top bar)
  const maskSlider = $("fringe-mask-thresh");
  const maskLabel = $("fringe-mask-thresh-val");
  if (maskSlider && maskLabel) {
    maskSlider.addEventListener("input", () => {
      maskLabel.textContent = maskSlider.value + "%";
    });
  }
}
