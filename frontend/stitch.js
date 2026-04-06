// stitch.js — XY image stitching wizard UI.
//
// Lets the user capture a grid of overlapping tiles at known XY positions
// (via micrometer handwheels) and stitch them into a seamless panorama.
// Follows the same dialog pattern as zstack.js.

import { apiFetch } from './api.js';
import { state } from './state.js';
import { img, showStatus, resizeCanvas } from './render.js';
import { setImageSize, viewport } from './viewport.js';
import { cacheImageData } from './subpixel-js.js';
import { updateFreezeUI } from './sidebar.js';

// Local UI state (scoped -- does NOT touch core `state`)
const ss = {
  sessionId: null,
  gridCols: 3,
  gridRows: 2,
  overlapPct: 20,
  pxPerMm: null,
  captured: new Set(),
  currentStep: 0,
  scanOrder: [],
  stepXmm: null,
  stepYmm: null,
  result: null, // { width, height, resultUrl }
};

function $(id) { return document.getElementById(id); }

// -- Helpers ------------------------------------------------------------------

function capturedKey(col, row) { return col + "," + row; }

function computeScanOrder(cols, rows) {
  const order = [];
  for (let r = 0; r < rows; r++) {
    if (r % 2 === 0) {
      for (let c = 0; c < cols; c++) order.push([c, r]);
    } else {
      for (let c = cols - 1; c >= 0; c--) order.push([c, r]);
    }
  }
  return order;
}

function stepCoordsMm(col, row) {
  if (!ss.stepXmm || !ss.stepYmm) return null;
  return {
    x: +(col * ss.stepXmm).toFixed(3),
    y: +(row * ss.stepYmm).toFixed(3),
  };
}

// -- Grid view ----------------------------------------------------------------

function renderGrid() {
  const grid = $("stitch-grid");
  if (!grid) return;
  grid.innerHTML = "";
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = `repeat(${ss.gridCols}, 40px)`;
  grid.style.gap = "3px";

  const order = ss.scanOrder.length ? ss.scanOrder : computeScanOrder(ss.gridCols, ss.gridRows);

  for (let r = 0; r < ss.gridRows; r++) {
    for (let c = 0; c < ss.gridCols; c++) {
      const stepIdx = order.findIndex(([oc, or_]) => oc === c && or_ === r);
      const cell = document.createElement("div");
      cell.style.cssText =
        "width:40px;height:32px;display:flex;align-items:center;justify-content:center;" +
        "font-size:12px;font-weight:600;border-radius:3px;user-select:none;";

      const key = capturedKey(c, r);
      if (ss.captured.has(key)) {
        cell.style.background = "#30d158";
        cell.style.color = "#000";
      } else if (stepIdx === ss.currentStep) {
        cell.style.background = "#ff9f0a";
        cell.style.color = "#000";
      } else {
        cell.style.background = "#2a2a2a";
        cell.style.color = "#888";
      }
      cell.textContent = String(stepIdx + 1);
      grid.appendChild(cell);
    }
  }
}

function renderInstructions() {
  const el = $("stitch-instructions");
  if (!el) return;

  const total = ss.gridCols * ss.gridRows;
  if (ss.currentStep >= total) {
    el.textContent = "All tiles captured!";
    return;
  }

  const [col, row] = ss.scanOrder[ss.currentStep] || [0, 0];
  const coords = stepCoordsMm(col, row);
  if (coords) {
    el.textContent = `Move X to ${coords.x.toFixed(3)} mm, Y to ${coords.y.toFixed(3)} mm  (step ${ss.currentStep + 1} of ${total})`;
  } else {
    el.textContent = `Grid position [${col}, ${row}]  —  enter pixel pitch above for micrometer coordinates  (step ${ss.currentStep + 1} of ${total})`;
  }
}

function updateCapturedCount() {
  const el = $("stitch-count");
  if (el) {
    const total = ss.gridCols * ss.gridRows;
    el.textContent = `Captured: ${ss.captured.size} / ${total}`;
  }

  const buildBtn = $("btn-stitch-build");
  if (buildBtn) {
    const total = ss.gridCols * ss.gridRows;
    buildBtn.disabled = ss.captured.size < total;
  }
}

// -- API calls ----------------------------------------------------------------

async function startSession() {
  const cols = parseInt($("stitch-cols").value) || 3;
  const rows = parseInt($("stitch-rows").value) || 2;
  const overlap = parseFloat($("stitch-overlap").value) || 20;
  // Use dialog input, or fall back to the global calibration from the sidebar
  let pitch = $("stitch-pitch").value ? parseFloat($("stitch-pitch").value) : null;
  if ((!pitch || pitch <= 0) && state.calibration && state.calibration.pixelsPerMm > 0) {
    pitch = state.calibration.pixelsPerMm;
    // Show the auto-filled value so the user knows where it came from
    $("stitch-pitch").value = pitch.toFixed(1);
  }

  const body = { cols, rows, overlap_pct: overlap };
  if (pitch && pitch > 0) body.px_per_mm = pitch;

  const r = await apiFetch("/stitch/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const msg = await r.text();
    showStatus("Stitch start failed: " + msg);
    return;
  }

  const data = await r.json();
  ss.sessionId = data.session_id;
  ss.gridCols = data.grid_shape[0];
  ss.gridRows = data.grid_shape[1];
  ss.overlapPct = overlap;
  ss.pxPerMm = pitch;
  ss.scanOrder = data.scan_order;
  ss.stepXmm = data.step_x_mm;
  ss.stepYmm = data.step_y_mm;
  ss.captured = new Set();
  ss.currentStep = 0;
  ss.result = null;

  $("stitch-result-section").hidden = true;
  renderGrid();
  renderInstructions();
  updateCapturedCount();
  showStatus(`Stitch session started: ${ss.gridCols}x${ss.gridRows} grid`);
}

async function captureCurrentTile() {
  const total = ss.gridCols * ss.gridRows;
  if (ss.currentStep >= total) {
    showStatus("All tiles already captured");
    return;
  }

  const [col, row] = ss.scanOrder[ss.currentStep];

  const r = await apiFetch("/stitch/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ col, row }),
  });

  if (!r.ok) {
    const msg = await r.text();
    showStatus("Capture failed: " + msg);
    return;
  }

  const data = await r.json();
  ss.captured.add(capturedKey(col, row));
  ss.currentStep++;

  renderGrid();
  renderInstructions();
  updateCapturedCount();
  showStatus(`Captured tile [${col}, ${row}] (${data.captured_count}/${data.total_tiles})`);
}

async function buildPanorama() {
  showStatus("Building panorama...");
  const buildBtn = $("btn-stitch-build");
  if (buildBtn) buildBtn.disabled = true;

  const r = await apiFetch("/stitch/compute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!r.ok) {
    const msg = await r.text();
    showStatus("Build failed: " + msg);
    if (buildBtn) buildBtn.disabled = false;
    return;
  }

  const data = await r.json();
  ss.result = {
    width: data.width,
    height: data.height,
    resultUrl: data.result_url + "?t=" + Date.now(),
  };

  const preview = $("stitch-preview-img");
  if (preview) preview.src = ss.result.resultUrl;

  const dims = $("stitch-result-dims");
  if (dims) dims.textContent = `${data.width} x ${data.height} px`;

  $("stitch-result-section").hidden = false;
  showStatus(`Panorama built: ${data.width}x${data.height} px`);
}

async function useAsImage() {
  if (!ss.result) return;
  try {
    const resp = await fetch(ss.result.resultUrl);
    if (!resp.ok) throw new Error("failed to fetch stitched image");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const loadedImg = await new Promise((resolve, reject) => {
      const bmp = new Image();
      bmp.onload = () => resolve(bmp);
      bmp.onerror = () => reject(new Error("decode failed"));
      bmp.src = url;
    });

    // Upload to backend so detection/inspection operate on the panorama
    const fd = new FormData();
    fd.append("file", blob, "stitch-panorama.png");
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
    showStatus("Panorama loaded as working image");
    closeDialog();
  } catch (err) {
    showStatus("Use panorama failed: " + err.message);
  }
}

function downloadResult() {
  if (!ss.result) return;
  const a = document.createElement("a");
  a.href = ss.result.resultUrl;
  a.download = "stitch-panorama.png";
  a.click();
}

async function resetSession() {
  await apiFetch("/stitch/reset", { method: "POST" });
  ss.sessionId = null;
  ss.captured = new Set();
  ss.currentStep = 0;
  ss.scanOrder = [];
  ss.stepXmm = null;
  ss.stepYmm = null;
  ss.result = null;
  $("stitch-result-section").hidden = true;
  renderGrid();
  renderInstructions();
  updateCapturedCount();
  showStatus("Stitch session reset");
}

// -- Dialog -------------------------------------------------------------------

function buildDialog() {
  if ($("stitch-dialog")) return;

  const dlg = document.createElement("div");
  dlg.id = "stitch-dialog";
  dlg.className = "dialog-overlay";
  dlg.hidden = true;

  const content = document.createElement("div");
  content.className = "dialog-content";
  content.style.cssText = "max-width:720px;width:90vw;";

  // Header
  const header = document.createElement("div");
  header.className = "dialog-header";
  const title = document.createElement("span");
  title.className = "dialog-title";
  title.textContent = "Image Stitching";
  const closeBtn = document.createElement("button");
  closeBtn.className = "dialog-close";
  closeBtn.id = "btn-stitch-close";
  closeBtn.textContent = "\u2715";
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Body
  const body = document.createElement("div");
  body.style.cssText = "padding:14px 18px;flex:1;min-height:0;overflow-y:auto;";

  // Description
  const desc = document.createElement("p");
  desc.style.cssText = "margin:0 0 10px;opacity:0.85;font-size:13px;";
  desc.textContent = "Capture a grid of overlapping tiles and stitch them into a seamless panorama. ";
  const tip = document.createElement("span");
  tip.style.opacity = "0.7";
  const kbd = document.createElement("kbd");
  kbd.style.cssText = "font-family:inherit;padding:1px 5px;border:1px solid #555;border-radius:3px;background:#222;";
  kbd.textContent = "Space";
  tip.textContent = "Tip: press ";
  tip.appendChild(kbd);
  const tipEnd = document.createTextNode(" to capture.");
  tip.appendChild(tipEnd);
  desc.appendChild(tip);

  // Config row
  const configRow = document.createElement("div");
  configRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;";

  const makeLabel = (text) => {
    const l = document.createElement("label");
    l.style.fontSize = "13px";
    l.textContent = text;
    return l;
  };

  const makeInput = (id, type, value, width, extra) => {
    const inp = document.createElement("input");
    inp.type = type;
    inp.id = id;
    inp.value = value;
    inp.style.width = width;
    if (extra) Object.assign(inp, extra);
    return inp;
  };

  configRow.appendChild(makeLabel("Grid:"));
  configRow.appendChild(makeInput("stitch-cols", "number", "3", "50px", { min: "1", max: "20", step: "1" }));
  const times = document.createElement("span");
  times.textContent = "\u00d7";
  times.style.cssText = "font-size:14px;opacity:0.7;";
  configRow.appendChild(times);
  configRow.appendChild(makeInput("stitch-rows", "number", "2", "50px", { min: "1", max: "20", step: "1" }));

  configRow.appendChild(makeLabel("Overlap:"));
  const overlapInp = makeInput("stitch-overlap", "number", "20", "60px", { min: "1", max: "80", step: "1" });
  configRow.appendChild(overlapInp);
  const pctLabel = document.createElement("span");
  pctLabel.textContent = "%";
  pctLabel.style.cssText = "font-size:13px;opacity:0.7;";
  configRow.appendChild(pctLabel);

  configRow.appendChild(makeLabel("Pixel pitch:"));
  configRow.appendChild(makeInput("stitch-pitch", "number", "", "80px", { step: "0.1", placeholder: "px/mm" }));

  // Start button
  const startBtn = document.createElement("button");
  startBtn.className = "detect-btn";
  startBtn.id = "btn-stitch-start";
  startBtn.textContent = "Start Session";
  startBtn.style.marginLeft = "8px";
  configRow.appendChild(startBtn);

  // Grid + instructions row
  const gridRow = document.createElement("div");
  gridRow.style.cssText = "display:flex;gap:16px;margin-bottom:12px;align-items:flex-start;";

  const gridWrap = document.createElement("div");
  const gridLabel = document.createElement("div");
  gridLabel.style.cssText = "font-size:11px;opacity:0.6;margin-bottom:4px;";
  gridLabel.textContent = "Grid View";
  const gridDiv = document.createElement("div");
  gridDiv.id = "stitch-grid";
  gridDiv.style.cssText = "padding:6px;background:#111;border:1px solid #2a2a2a;border-radius:3px;";
  gridWrap.appendChild(gridLabel);
  gridWrap.appendChild(gridDiv);

  const instrWrap = document.createElement("div");
  instrWrap.style.flex = "1";
  const instrLabel = document.createElement("div");
  instrLabel.style.cssText = "font-size:11px;opacity:0.6;margin-bottom:4px;";
  instrLabel.textContent = "Instructions";
  const instrDiv = document.createElement("div");
  instrDiv.id = "stitch-instructions";
  instrDiv.style.cssText = "font-size:14px;padding:8px;background:#111;border:1px solid #2a2a2a;border-radius:3px;min-height:40px;";
  instrDiv.textContent = "Press Start Session to begin.";
  instrWrap.appendChild(instrLabel);
  instrWrap.appendChild(instrDiv);

  gridRow.appendChild(gridWrap);
  gridRow.appendChild(instrWrap);

  // Count + action buttons
  const countDiv = document.createElement("div");
  countDiv.id = "stitch-count";
  countDiv.style.cssText = "font-size:12px;opacity:0.85;margin-bottom:8px;";
  countDiv.textContent = "Captured: 0 / 0";

  const actionRow = document.createElement("div");
  actionRow.style.cssText = "display:flex;gap:8px;margin-bottom:12px;";

  const buildBtn = document.createElement("button");
  buildBtn.className = "detect-btn";
  buildBtn.id = "btn-stitch-build";
  buildBtn.textContent = "Build Panorama";
  buildBtn.disabled = true;

  const resetBtn = document.createElement("button");
  resetBtn.className = "detect-btn";
  resetBtn.id = "btn-stitch-reset";
  resetBtn.textContent = "Reset";

  actionRow.appendChild(buildBtn);
  actionRow.appendChild(resetBtn);

  // Result section
  const resultSection = document.createElement("div");
  resultSection.id = "stitch-result-section";
  resultSection.hidden = true;
  resultSection.style.cssText = "padding:10px;background:#111;border:1px solid #2a2a2a;border-radius:3px;";

  const resultLabel = document.createElement("div");
  resultLabel.style.cssText = "font-size:11px;opacity:0.6;margin-bottom:4px;";
  resultLabel.textContent = "Result";

  const resultDims = document.createElement("div");
  resultDims.id = "stitch-result-dims";
  resultDims.style.cssText = "font-size:12px;opacity:0.85;margin-bottom:6px;";

  const previewImg = document.createElement("img");
  previewImg.id = "stitch-preview-img";
  previewImg.style.cssText = "width:100%;border:1px solid #444;background:#0a0a0a;margin-bottom:8px;";

  const resultBtns = document.createElement("div");
  resultBtns.style.cssText = "display:flex;gap:8px;";

  const useBtn = document.createElement("button");
  useBtn.className = "detect-btn";
  useBtn.id = "btn-stitch-use";
  useBtn.textContent = "Use as image";

  const dlBtn = document.createElement("button");
  dlBtn.className = "detect-btn";
  dlBtn.id = "btn-stitch-download";
  dlBtn.textContent = "Download PNG";

  resultBtns.appendChild(useBtn);
  resultBtns.appendChild(dlBtn);

  resultSection.appendChild(resultLabel);
  resultSection.appendChild(resultDims);
  resultSection.appendChild(previewImg);
  resultSection.appendChild(resultBtns);

  // Assemble body
  body.appendChild(desc);
  body.appendChild(configRow);
  body.appendChild(gridRow);
  body.appendChild(countDiv);
  body.appendChild(actionRow);
  body.appendChild(resultSection);

  content.appendChild(header);
  content.appendChild(body);
  dlg.appendChild(content);
  document.body.appendChild(dlg);

  // Wire events
  closeBtn.addEventListener("click", closeDialog);
  startBtn.addEventListener("click", startSession);
  buildBtn.addEventListener("click", buildPanorama);
  resetBtn.addEventListener("click", resetSession);
  useBtn.addEventListener("click", useAsImage);
  dlBtn.addEventListener("click", downloadResult);
}

function onStitchKey(e) {
  if (e.key !== " " && e.code !== "Space") return;
  const dlg = $("stitch-dialog");
  if (!dlg || dlg.hidden) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  if (e.repeat) return;
  e.preventDefault();
  e.stopPropagation();
  captureCurrentTile();
}

async function rehydrateFromStatus() {
  try {
    const r = await apiFetch("/stitch/status");
    if (!r.ok) return;
    const data = await r.json();

    if (data.captured && data.captured.length > 0) {
      ss.sessionId = data.session_id;
      ss.gridCols = data.grid_shape[0];
      ss.gridRows = data.grid_shape[1];
      ss.overlapPct = data.overlap_pct || 20;
      ss.pxPerMm = data.px_per_mm;
      ss.captured = new Set(data.captured.map(([c, r]) => capturedKey(c, r)));
      ss.scanOrder = computeScanOrder(ss.gridCols, ss.gridRows);
      ss.currentStep = ss.captured.size;
      ss.stepXmm = data.step_x_mm;
      ss.stepYmm = data.step_y_mm;

      // Update input fields
      const colsInp = $("stitch-cols");
      if (colsInp) colsInp.value = ss.gridCols;
      const rowsInp = $("stitch-rows");
      if (rowsInp) rowsInp.value = ss.gridRows;
      const overlapInp = $("stitch-overlap");
      if (overlapInp) overlapInp.value = ss.overlapPct;

      if (data.has_result && data.result_dims) {
        ss.result = {
          width: data.result_dims.width,
          height: data.result_dims.height,
          resultUrl: "/stitch/result.png?t=" + Date.now(),
        };
        const preview = $("stitch-preview-img");
        if (preview) preview.src = ss.result.resultUrl;
        const dims = $("stitch-result-dims");
        if (dims) dims.textContent = `${ss.result.width} x ${ss.result.height} px`;
        $("stitch-result-section").hidden = false;
      }

      renderGrid();
      renderInstructions();
      updateCapturedCount();
    }
  } catch {
    // Backend may not have stitch router wired yet; ignore.
  }
}

async function openStitchDialog() {
  buildDialog();
  const dlg = $("stitch-dialog");
  dlg.hidden = false;
  window.addEventListener("keydown", onStitchKey, true);
  await rehydrateFromStatus();
}

function closeDialog() {
  const dlg = $("stitch-dialog");
  if (dlg) dlg.hidden = true;
  window.removeEventListener("keydown", onStitchKey, true);
}

function initStitch() {
  const btn = $("btn-stitch");
  if (btn) btn.addEventListener("click", openStitchDialog);
}

export { initStitch, openStitchDialog };
