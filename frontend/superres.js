// superres.js — Super-resolution (shift-and-add) wizard UI.
//
// The user captures multiple frames at known sub-pixel shifts using
// micrometer handwheels.  The backend estimates the actual shifts via
// phase correlation and reconstructs a higher-resolution image via
// shift-and-add averaging.

import { apiFetch } from './api.js';
import { state } from './state.js';
import { img, showStatus, resizeCanvas } from './render.js';
import { setImageSize, viewport } from './viewport.js';
import { cacheImageData } from './subpixel-js.js';
import { updateFreezeUI } from './sidebar.js';

// Local UI state (scoped — does NOT touch core `state`)
const sr = {
  sessionId: null,
  scale: 2,
  pixelPitchUm: null,
  frameCount: 0,
  totalNeeded: 0,
  shiftsUm: [],
  shiftsFrac: [],
  currentStep: 0,
  result: null, // { width, height, scale, resultUrl }
};

function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// Dialog DOM
// ---------------------------------------------------------------------------

function buildDialog() {
  if ($("superres-dialog")) return;

  const dlg = document.createElement("div");
  dlg.id = "superres-dialog";
  dlg.className = "dialog-overlay";
  dlg.hidden = true;

  const content = document.createElement("div");
  content.className = "dialog-content";
  content.style.cssText = "max-width:620px;width:88vw";

  // Header
  const header = document.createElement("div");
  header.className = "dialog-header";
  const title = document.createElement("span");
  title.className = "dialog-title";
  title.textContent = "Super-Resolution";
  const closeBtn = document.createElement("button");
  closeBtn.className = "dialog-close";
  closeBtn.id = "btn-superres-close";
  closeBtn.textContent = "\u2715";
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Body
  const body = document.createElement("div");
  body.style.cssText = "padding:14px 18px;flex:1;min-height:0;overflow-y:auto";

  // Intro
  const intro = document.createElement("p");
  intro.style.cssText = "margin:0 0 10px;opacity:0.85;font-size:13px";
  intro.textContent =
    "Capture multiple frames at sub-pixel shifts using your micrometer handwheels. " +
    "The backend estimates actual shifts via phase correlation and reconstructs a higher-resolution image.";

  // Config row
  const configRow = document.createElement("div");
  configRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap";

  const scaleLabel = document.createElement("label");
  scaleLabel.style.fontSize = "13px";
  scaleLabel.textContent = "Upscale:";

  const scaleSelect = document.createElement("select");
  scaleSelect.id = "superres-scale";
  scaleSelect.style.cssText = "padding:3px 6px;background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:3px";
  const opt2 = document.createElement("option");
  opt2.value = "2"; opt2.textContent = "2\u00d7 (4 frames)"; opt2.selected = true;
  const opt4 = document.createElement("option");
  opt4.value = "4"; opt4.textContent = "4\u00d7 (16 frames)";
  scaleSelect.appendChild(opt2);
  scaleSelect.appendChild(opt4);

  const pitchLabel = document.createElement("label");
  pitchLabel.style.cssText = "font-size:13px;margin-left:12px";
  pitchLabel.textContent = "Pixel pitch:";

  const pitchInput = document.createElement("input");
  pitchInput.type = "number";
  pitchInput.id = "superres-pitch";
  pitchInput.step = "0.01";
  pitchInput.min = "0.01";
  pitchInput.placeholder = "e.g. 4.5";
  pitchInput.style.cssText = "width:80px";

  const pitchUnit = document.createElement("span");
  pitchUnit.style.fontSize = "13px";
  pitchUnit.textContent = "\u00b5m/px";

  configRow.appendChild(scaleLabel);
  configRow.appendChild(scaleSelect);
  configRow.appendChild(pitchLabel);
  configRow.appendChild(pitchInput);
  configRow.appendChild(pitchUnit);

  // Start button row
  const startRow = document.createElement("div");
  startRow.style.cssText = "display:flex;gap:8px;margin-bottom:12px";

  const startBtn = document.createElement("button");
  startBtn.className = "detect-btn";
  startBtn.id = "btn-superres-start";
  startBtn.textContent = "Start Session";
  startBtn.style.cssText = "min-width:130px";

  startRow.appendChild(startBtn);

  // Capture section (hidden until session started)
  const captureSection = document.createElement("div");
  captureSection.id = "superres-capture-section";
  captureSection.hidden = true;

  // Grid + instructions row
  const gridRow = document.createElement("div");
  gridRow.style.cssText = "display:flex;gap:16px;margin-bottom:10px;align-items:flex-start";

  const gridBox = document.createElement("div");
  gridBox.style.cssText = "flex-shrink:0";
  const gridTitle = document.createElement("div");
  gridTitle.style.cssText = "font-size:11px;opacity:0.7;margin-bottom:4px";
  gridTitle.textContent = "Shift Grid";
  const gridCanvas = document.createElement("canvas");
  gridCanvas.id = "superres-grid";
  gridCanvas.style.cssText = "border:1px solid #555;border-radius:3px;background:#111";
  gridBox.appendChild(gridTitle);
  gridBox.appendChild(gridCanvas);

  const instrBox = document.createElement("div");
  instrBox.style.cssText = "flex:1;min-width:0";
  const stepLabel = document.createElement("div");
  stepLabel.id = "superres-step-label";
  stepLabel.style.cssText = "font-size:14px;font-weight:600;margin-bottom:6px";
  const shiftInfo = document.createElement("div");
  shiftInfo.id = "superres-shift-info";
  shiftInfo.style.cssText = "font-size:13px;opacity:0.9;margin-bottom:4px";
  const captureTip = document.createElement("div");
  captureTip.style.cssText = "font-size:12px;opacity:0.7";
  const kbd = document.createElement("kbd");
  kbd.style.cssText = "font-family:inherit;padding:1px 5px;border:1px solid #555;border-radius:3px;background:#222";
  kbd.textContent = "Space";
  captureTip.appendChild(kbd);
  captureTip.appendChild(document.createTextNode(" to capture"));

  instrBox.appendChild(stepLabel);
  instrBox.appendChild(shiftInfo);
  instrBox.appendChild(captureTip);

  gridRow.appendChild(gridBox);
  gridRow.appendChild(instrBox);

  // Count
  const countDiv = document.createElement("div");
  countDiv.id = "superres-count";
  countDiv.style.cssText = "opacity:0.85;font-size:12px;margin-bottom:8px";

  // Buttons row
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;margin-bottom:10px";

  const reconstructBtn = document.createElement("button");
  reconstructBtn.className = "detect-btn";
  reconstructBtn.id = "btn-superres-reconstruct";
  reconstructBtn.textContent = "Reconstruct";
  reconstructBtn.disabled = true;
  reconstructBtn.style.cssText = "min-width:130px";

  const resetBtn = document.createElement("button");
  resetBtn.className = "detect-btn";
  resetBtn.id = "btn-superres-reset";
  resetBtn.textContent = "Reset";
  resetBtn.style.cssText = "min-width:80px";

  btnRow.appendChild(reconstructBtn);
  btnRow.appendChild(resetBtn);

  captureSection.appendChild(gridRow);
  captureSection.appendChild(countDiv);
  captureSection.appendChild(btnRow);

  // Result section
  const resultSection = document.createElement("div");
  resultSection.id = "superres-result-section";
  resultSection.hidden = true;

  const resultInfo = document.createElement("div");
  resultInfo.id = "superres-result-info";
  resultInfo.style.cssText = "font-size:13px;opacity:0.9;margin-bottom:8px";

  const resultImg = document.createElement("img");
  resultImg.id = "superres-result-img";
  resultImg.style.cssText = "width:100%;border:1px solid #444;background:#111;margin-bottom:8px";

  const resultBtnRow = document.createElement("div");
  resultBtnRow.style.cssText = "display:flex;gap:8px";

  const useBtn = document.createElement("button");
  useBtn.className = "detect-btn";
  useBtn.id = "btn-superres-use";
  useBtn.textContent = "Use as image";
  useBtn.style.cssText = "min-width:120px";

  const dlBtn = document.createElement("a");
  dlBtn.className = "detect-btn";
  dlBtn.id = "superres-download";
  dlBtn.download = "superres-result.png";
  dlBtn.style.cssText = "display:inline-block;text-decoration:none;min-width:120px;text-align:center";
  dlBtn.textContent = "Download PNG";

  resultBtnRow.appendChild(useBtn);
  resultBtnRow.appendChild(dlBtn);

  resultSection.appendChild(resultInfo);
  resultSection.appendChild(resultImg);
  resultSection.appendChild(resultBtnRow);

  // Assemble body
  body.appendChild(intro);
  body.appendChild(configRow);
  body.appendChild(startRow);
  body.appendChild(captureSection);
  body.appendChild(resultSection);

  content.appendChild(header);
  content.appendChild(body);
  dlg.appendChild(content);
  document.body.appendChild(dlg);

  // Wire events
  $("btn-superres-close").addEventListener("click", closeDialog);
  $("btn-superres-start").addEventListener("click", startSession);
  $("btn-superres-reconstruct").addEventListener("click", doReconstruct);
  $("btn-superres-reset").addEventListener("click", resetSession);
  $("btn-superres-use").addEventListener("click", useResultAsImage);
}

// ---------------------------------------------------------------------------
// Shift grid visualisation
// ---------------------------------------------------------------------------

function drawGrid() {
  const canvas = $("superres-grid");
  if (!canvas) return;
  const cellSize = 28;
  const padding = 6;
  const dim = sr.scale;
  const size = dim * cellSize + padding * 2;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  for (let iy = 0; iy < dim; iy++) {
    for (let ix = 0; ix < dim; ix++) {
      const idx = iy * dim + ix;
      const cx = padding + ix * cellSize + cellSize / 2;
      const cy = padding + iy * cellSize + cellSize / 2;
      const r = cellSize * 0.32;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);

      if (idx < sr.frameCount) {
        // Captured — green
        ctx.fillStyle = "#4caf50";
        ctx.fill();
      } else if (idx === sr.currentStep) {
        // Current — yellow
        ctx.fillStyle = "#ffc107";
        ctx.fill();
        // Draw a ring
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Pending — gray
        ctx.fillStyle = "#555";
        ctx.fill();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step instructions
// ---------------------------------------------------------------------------

function updateStepInfo() {
  const stepLabel = $("superres-step-label");
  const shiftInfo = $("superres-shift-info");
  const countDiv = $("superres-count");
  const reconstructBtn = $("btn-superres-reconstruct");

  if (sr.frameCount >= sr.totalNeeded) {
    if (stepLabel) stepLabel.textContent = "All frames captured!";
    if (shiftInfo) shiftInfo.textContent = "Ready to reconstruct.";
    if (reconstructBtn) reconstructBtn.disabled = false;
  } else {
    const step = sr.currentStep + 1;
    if (stepLabel) stepLabel.textContent = `Step ${step} of ${sr.totalNeeded}:`;
    if (shiftInfo && sr.shiftsUm.length > sr.currentStep) {
      const [dx, dy] = sr.shiftsUm[sr.currentStep];
      const rx = Math.round(dx), ry = Math.round(dy);
      shiftInfo.textContent = `Shift X: ${rx >= 0 ? "+" : ""}${rx} \u00b5m    Shift Y: ${ry >= 0 ? "+" : ""}${ry} \u00b5m`;
    }
    if (reconstructBtn) reconstructBtn.disabled = true;
  }

  if (countDiv) countDiv.textContent = `Captured: ${sr.frameCount} / ${sr.totalNeeded}`;
  drawGrid();
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession() {
  const scale = parseInt($("superres-scale").value, 10);
  const pitchStr = $("superres-pitch").value.trim();
  const pitchUm = pitchStr ? parseFloat(pitchStr) : 1.0;

  if (pitchUm <= 0 || !Number.isFinite(pitchUm)) {
    showStatus("Invalid pixel pitch");
    return;
  }

  try {
    const resp = await apiFetch("/superres/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scale, pixel_pitch_um: pitchUm }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      showStatus("Start failed: " + (err.detail || resp.statusText));
      return;
    }
    const data = await resp.json();
    sr.sessionId = data.session_id;
    sr.scale = data.scale;
    sr.totalNeeded = data.total_frames;
    sr.shiftsUm = data.shifts_um;
    sr.shiftsFrac = data.shifts_frac;
    sr.frameCount = 0;
    sr.currentStep = 0;
    sr.result = null;
    sr.pixelPitchUm = pitchUm;

    $("superres-capture-section").hidden = false;
    $("superres-result-section").hidden = true;
    updateStepInfo();
    showStatus(`Super-res session started (${sr.scale}\u00d7, ${sr.totalNeeded} frames)`);
  } catch (err) {
    showStatus("Start failed: " + err.message);
  }
}

async function captureFrame() {
  if (sr.frameCount >= sr.totalNeeded) return;
  try {
    const resp = await apiFetch("/superres/capture", { method: "POST" });
    if (!resp.ok) {
      const err = await resp.json();
      showStatus("Capture failed: " + (err.detail || resp.statusText));
      return;
    }
    const data = await resp.json();
    sr.frameCount = data.frame_count;
    sr.currentStep = sr.frameCount;
    updateStepInfo();
    showStatus(`Frame ${data.frame_count} / ${sr.totalNeeded} captured`);
  } catch (err) {
    showStatus("Capture failed: " + err.message);
  }
}

async function doReconstruct() {
  const btn = $("btn-superres-reconstruct");
  if (btn) { btn.disabled = true; btn.textContent = "Computing\u2026"; }
  try {
    const resp = await apiFetch("/superres/compute", { method: "POST" });
    if (!resp.ok) {
      const err = await resp.json();
      showStatus("Reconstruct failed: " + (err.detail || resp.statusText));
      return;
    }
    const data = await resp.json();
    sr.result = data;

    const resultSection = $("superres-result-section");
    if (resultSection) resultSection.hidden = false;

    const resultInfo = $("superres-result-info");
    if (resultInfo) {
      // Compute original dimensions from result
      const origW = Math.round(data.width / data.scale);
      const origH = Math.round(data.height / data.scale);
      resultInfo.textContent = `Original: ${origW}\u00d7${origH} \u2192 Enhanced: ${data.width}\u00d7${data.height}`;
    }

    const resultImg = $("superres-result-img");
    if (resultImg) resultImg.src = data.result_url + "?t=" + Date.now();

    const dlLink = $("superres-download");
    if (dlLink) dlLink.href = data.result_url;

    showStatus("Super-resolution reconstruction complete");
  } catch (err) {
    showStatus("Reconstruct failed: " + err.message);
  } finally {
    if (btn) { btn.textContent = "Reconstruct"; btn.disabled = sr.frameCount < sr.totalNeeded; }
  }
}

async function resetSession() {
  try {
    await apiFetch("/superres/reset", { method: "POST" });
  } catch {}
  sr.sessionId = null;
  sr.frameCount = 0;
  sr.totalNeeded = 0;
  sr.shiftsUm = [];
  sr.shiftsFrac = [];
  sr.currentStep = 0;
  sr.result = null;

  const captureSection = $("superres-capture-section");
  if (captureSection) captureSection.hidden = true;
  const resultSection = $("superres-result-section");
  if (resultSection) resultSection.hidden = true;
  showStatus("Super-res session reset");
}

async function useResultAsImage() {
  if (!sr.result) return;
  try {
    const resp = await fetch(sr.result.result_url);
    if (!resp.ok) throw new Error("failed to fetch result");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const loadedImg = await new Promise((resolve, reject) => {
      const bmp = new Image();
      bmp.onload = () => resolve(bmp);
      bmp.onerror = () => reject(new Error("decode failed"));
      bmp.src = url;
    });

    // Upload to backend so detection/inspection operate on the super-res image
    const fd = new FormData();
    fd.append("file", blob, "superres-result.png");
    const up = await apiFetch("/load-image", { method: "POST", body: fd });
    if (!up.ok) throw new Error("upload failed");
    const { width, height } = await up.json();

    state.frozenSize = { w: width, h: height };
    setImageSize(width, height);
    viewport.zoom = 1;
    viewport.panX = 0;
    viewport.panY = 0;
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    cacheImageData(loadedImg, width, height);
    updateFreezeUI();
    resizeCanvas();
    showStatus("Super-res image loaded as working image");
    closeDialog();
  } catch (err) {
    showStatus("Use result failed: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Keyboard handler
// ---------------------------------------------------------------------------

function onSuperResKey(e) {
  if (e.key !== " " && e.code !== "Space") return;
  const dlg = $("superres-dialog");
  if (!dlg || dlg.hidden) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  if (e.repeat) return;
  e.preventDefault();
  e.stopPropagation();
  captureFrame();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function openSuperResDialog() {
  buildDialog();
  const dlg = $("superres-dialog");
  dlg.hidden = false;
  window.addEventListener("keydown", onSuperResKey, true);

  // Pre-fill pixel pitch from global calibration (µm/px = 1000 / px/mm)
  const pitchInp = $("superres-pitch");
  if (pitchInp && !pitchInp.value && state.calibration && state.calibration.pixelsPerMm > 0) {
    pitchInp.value = (1000 / state.calibration.pixelsPerMm).toFixed(2);
  }

  // Probe backend for existing session state
  try {
    const resp = await apiFetch("/superres/status");
    if (resp.ok) {
      const status = await resp.json();
      if (status.total_needed > 0) {
        sr.sessionId = status.session_id;
        sr.scale = status.scale;
        sr.frameCount = status.frame_count;
        sr.totalNeeded = status.total_needed;
        sr.shiftsUm = status.shifts_um || [];
        sr.pixelPitchUm = status.pixel_pitch_um;
        sr.currentStep = sr.frameCount;
        sr.result = status.has_result ? { result_url: "/superres/result.png" } : null;

        $("superres-scale").value = String(sr.scale);
        if (sr.pixelPitchUm) $("superres-pitch").value = String(sr.pixelPitchUm);

        $("superres-capture-section").hidden = false;
        updateStepInfo();

        if (sr.result) {
          $("superres-result-section").hidden = false;
          const resultImg = $("superres-result-img");
          if (resultImg) resultImg.src = "/superres/result.png?t=" + Date.now();
          const dlLink = $("superres-download");
          if (dlLink) dlLink.href = "/superres/result.png";
        }
      }
    }
  } catch {}
}

function closeDialog() {
  const dlg = $("superres-dialog");
  if (dlg) dlg.hidden = true;
  window.removeEventListener("keydown", onSuperResKey, true);
}

export function initSuperRes() {
  const btn = $("btn-superres");
  if (btn) btn.addEventListener("click", openSuperResDialog);
}
