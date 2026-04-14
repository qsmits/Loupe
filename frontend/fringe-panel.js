// fringe-panel.js — Left panel template, capture workflow, mask drawing,
// averaging, and focus polling for fringe mode.
//
// Extracted from fringe.js (Task 6 of fringe UI restructure).

import { fr, $ } from './fringe.js';
import { getSubtractTerms } from './fringe.js';
import { apiFetch } from './api.js';
import { analyzeWithProgress, createProgressBar } from './fringe-progress.js';

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
          <div class="fringe-enlarge-overlay" id="fringe-enlarge-overlay" hidden>
            <img id="fringe-enlarge-img" />
            <button class="fringe-enlarge-close" id="fringe-enlarge-close">&#10005;</button>
          </div>
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
          <button class="detect-btn" id="fringe-btn-mask" style="padding:4px 10px;font-size:11px;flex:1">
            Draw Mask
          </button>
          <button class="detect-btn" id="fringe-btn-mask-hole" style="padding:4px 10px;font-size:11px;flex:1" hidden>
            + Add Hole
          </button>
          <button class="detect-btn" id="fringe-btn-mask-clear" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
            Clear All
          </button>
        </div>
        <div id="fringe-mask-hint" style="font-size:10px;opacity:0.5;text-align:center" hidden>
          Click vertices to draw polygon. Double-click to close. Right-click to undo last vertex.
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
  _drawPolygonsOnCtx(ctx, canvas.width, canvas.height, fr.maskPolygons, []);
}

function _drawPolygonsOnCtx(ctx, w, h, polygons, currentVerts) {
  // Draw completed polygons
  for (const poly of polygons) {
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
    // Vertex dots
    ctx.fillStyle = color;
    for (const v of poly.vertices) {
      ctx.beginPath();
      ctx.arc(v.x * w, v.y * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw current in-progress polygon
  if (currentVerts.length > 0) {
    const color = fr.maskIsHole ? "#ff9f0a" : "#30d158";
    ctx.beginPath();
    ctx.moveTo(currentVerts[0].x * w, currentVerts[0].y * h);
    for (let i = 1; i < currentVerts.length; i++) {
      ctx.lineTo(currentVerts[i].x * w, currentVerts[i].y * h);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Vertex dots
    for (let i = 0; i < currentVerts.length; i++) {
      const v = currentVerts[i];
      ctx.beginPath();
      ctx.arc(v.x * w, v.y * h, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "#fff" : color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ── Polygon mask draw mode (enlarge overlay + click-to-place vertices) ──

function enterMaskDrawMode(isHole) {
  fr.maskDrawing = true;
  fr.maskIsHole = isHole;
  fr.maskCurrentVertices = [];

  const maskBtn = $("fringe-btn-mask");
  const maskHint = $("fringe-mask-hint");
  if (maskBtn) { maskBtn.textContent = "Cancel"; maskBtn.style.background = "var(--accent)"; }
  if (maskHint) maskHint.hidden = false;

  // Open the enlarge overlay with a drawing canvas on top
  const overlay = $("fringe-enlarge-overlay");
  const enlargeImg = $("fringe-enlarge-img");
  const preview = $("fringe-preview");
  if (!overlay || !enlargeImg || !preview) return;

  enlargeImg.src = preview.src;
  overlay.hidden = false;

  // Create or reuse the drawing canvas on the enlarge overlay
  let drawCanvas = $("fringe-enlarge-roi-canvas");
  if (!drawCanvas) {
    drawCanvas = document.createElement("canvas");
    drawCanvas.id = "fringe-enlarge-roi-canvas";
    drawCanvas.style.cssText = "position:fixed;cursor:crosshair;z-index:10";
    overlay.appendChild(drawCanvas);
  }
  drawCanvas.style.pointerEvents = "auto";
  drawCanvas.style.cursor = "crosshair";

  const setupCanvas = () => {
    const imgRect = enlargeImg.getBoundingClientRect();
    drawCanvas.width = imgRect.width;
    drawCanvas.height = imgRect.height;
    drawCanvas.style.left = imgRect.left + "px";
    drawCanvas.style.top = imgRect.top + "px";
    drawCanvas.style.width = imgRect.width + "px";
    drawCanvas.style.height = imgRect.height + "px";
    drawEnlargeMaskOverlay(drawCanvas);
  };
  if (enlargeImg.complete && enlargeImg.naturalWidth > 0) {
    requestAnimationFrame(setupCanvas);
  } else {
    enlargeImg.onload = () => requestAnimationFrame(setupCanvas);
  }

  // Helper: get normalized coords from mouse event
  const getNorm = (e) => {
    const rect = drawCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  // Check if cursor is near first vertex (for polygon closing)
  const nearFirst = (nx, ny) => {
    if (fr.maskCurrentVertices.length < 3) return false;
    const first = fr.maskCurrentVertices[0];
    const rect = drawCanvas.getBoundingClientRect();
    const dx = (nx - first.x) * rect.width;
    const dy = (ny - first.y) * rect.height;
    return Math.sqrt(dx * dx + dy * dy) < 10;
  };

  const closePoly = () => {
    if (fr.maskCurrentVertices.length >= 3) {
      fr.maskPolygons.push({
        vertices: [...fr.maskCurrentVertices],
        include: !fr.maskIsHole,
      });
    }
    fr.maskCurrentVertices = [];
    cleanup();
    exitMaskDrawMode();
  };

  let lastClickTime = 0;

  const handleClick = (e) => {
    if (e.button !== 0) return;
    const { x, y } = getNorm(e);

    // Double-click or click near first vertex -> close polygon
    const now = Date.now();
    const isDblClick = now - lastClickTime < 350;
    lastClickTime = now;

    if (nearFirst(x, y) || isDblClick) {
      closePoly();
      return;
    }

    fr.maskCurrentVertices.push({ x, y });
    drawEnlargeMaskOverlay(drawCanvas);
  };

  const handleMove = (e) => {
    const { x, y } = getNorm(e);
    drawEnlargeMaskOverlay(drawCanvas, { x, y }, nearFirst(x, y));
  };

  const handleContext = (e) => {
    e.preventDefault();
    if (fr.maskCurrentVertices.length > 0) {
      fr.maskCurrentVertices.pop();
      drawEnlargeMaskOverlay(drawCanvas);
    } else {
      // No vertices: cancel drawing
      cleanup();
      exitMaskDrawMode();
    }
  };

  drawCanvas.addEventListener("mousedown", handleClick);
  drawCanvas.addEventListener("mousemove", handleMove);
  drawCanvas.addEventListener("contextmenu", handleContext);

  const cleanup = () => {
    drawCanvas.removeEventListener("mousedown", handleClick);
    drawCanvas.removeEventListener("mousemove", handleMove);
    drawCanvas.removeEventListener("contextmenu", handleContext);
    drawCanvas.style.pointerEvents = "none";
    const ctx = drawCanvas.getContext("2d");
    ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  };

  fr._maskCleanup = cleanup;
}

function exitMaskDrawMode() {
  fr.maskDrawing = false;
  fr.maskCurrentVertices = [];
  const maskBtn = $("fringe-btn-mask");
  const maskHint = $("fringe-mask-hint");
  if (maskBtn) { maskBtn.textContent = "Draw Mask"; maskBtn.style.background = ""; }
  if (maskHint) maskHint.hidden = true;
  if (fr._maskCleanup) { fr._maskCleanup(); fr._maskCleanup = null; }

  // Show/hide hole and clear buttons based on current state
  const hasInclude = fr.maskPolygons.some(p => p.include);
  const holeBtn = $("fringe-btn-mask-hole");
  if (holeBtn) holeBtn.hidden = !hasInclude;
  const clearBtn = $("fringe-btn-mask-clear");
  if (clearBtn) {
    clearBtn.disabled = fr.maskPolygons.length === 0;
    clearBtn.style.opacity = fr.maskPolygons.length === 0 ? "0.6" : "1";
  }

  // Close the enlarge overlay
  const overlay = $("fringe-enlarge-overlay");
  if (overlay) overlay.hidden = true;

  // Update the small preview overlay
  drawMaskOverlay();

  // Wire right-click context menu on enlarged view for completed polygons
  _wireEnlargeContextMenu();
}

function drawEnlargeMaskOverlay(canvas, cursor, nearFirst) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width;
  const h = canvas.height;

  _drawPolygonsOnCtx(ctx, w, h, fr.maskPolygons, fr.maskCurrentVertices);

  // Draw rubber-band line from last vertex to cursor
  if (cursor && fr.maskCurrentVertices.length > 0) {
    const last = fr.maskCurrentVertices[fr.maskCurrentVertices.length - 1];
    const color = fr.maskIsHole ? "#ff9f0a" : "#30d158";
    ctx.beginPath();
    ctx.moveTo(last.x * w, last.y * h);
    ctx.lineTo(cursor.x * w, cursor.y * h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Highlight first vertex when near it (close hint)
    if (nearFirst && fr.maskCurrentVertices.length >= 3) {
      const first = fr.maskCurrentVertices[0];
      ctx.beginPath();
      ctx.arc(first.x * w, first.y * h, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

// ── Right-click context menu on completed polygons in the enlarged view ──

function _wireEnlargeContextMenu() {
  const overlay = $("fringe-enlarge-overlay");
  if (!overlay) return;

  // Remove any previously attached handler
  if (overlay._maskContextHandler) {
    overlay.removeEventListener("contextmenu", overlay._maskContextHandler);
  }

  overlay._maskContextHandler = (e) => {
    if (fr.maskDrawing) return;
    const enlargeImg = $("fringe-enlarge-img");
    if (!enlargeImg) return;
    const imgRect = enlargeImg.getBoundingClientRect();
    const nx = (e.clientX - imgRect.left) / imgRect.width;
    const ny = (e.clientY - imgRect.top) / imgRect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    // Point-in-polygon test (ray casting), reverse order for top-most
    let hitIdx = -1;
    for (let i = fr.maskPolygons.length - 1; i >= 0; i--) {
      if (_pointInPolygon(nx, ny, fr.maskPolygons[i].vertices)) {
        hitIdx = i;
        break;
      }
    }
    if (hitIdx === -1) return;
    e.preventDefault();
    _showPolyContextMenu(e.clientX, e.clientY, hitIdx);
  };

  overlay.addEventListener("contextmenu", overlay._maskContextHandler);
}

function _pointInPolygon(px, py, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const intersect = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function _showPolyContextMenu(cx, cy, idx) {
  // Remove any existing popup
  const existing = document.getElementById("fringe-poly-ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "fringe-poly-ctx-menu";
  menu.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;z-index:9999;
    background:var(--surface,#1c1c1e);border:1px solid var(--border,#3a3a3c);
    border-radius:6px;padding:4px 0;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.5);
    font-size:12px`;

  const poly = fr.maskPolygons[idx];
  const toggleLabel = poly.include ? "Convert to Hole (Exclude)" : "Convert to Include";

  const item1 = document.createElement("div");
  item1.textContent = toggleLabel;
  item1.style.cssText = "padding:6px 14px;cursor:pointer;opacity:0.9";
  item1.addEventListener("mouseover", () => { item1.style.background = "var(--accent,#0a84ff)"; });
  item1.addEventListener("mouseout", () => { item1.style.background = ""; });
  item1.addEventListener("click", () => {
    fr.maskPolygons[idx].include = !fr.maskPolygons[idx].include;
    menu.remove();
    // Redraw on the enlarged canvas if open
    const drawCanvas = $("fringe-enlarge-roi-canvas");
    if (drawCanvas && drawCanvas.width > 0) drawEnlargeMaskOverlay(drawCanvas);
    drawMaskOverlay();
  });

  const item2 = document.createElement("div");
  item2.textContent = "Delete";
  item2.style.cssText = "padding:6px 14px;cursor:pointer;color:#ff453a";
  item2.addEventListener("mouseover", () => { item2.style.background = "rgba(255,69,58,0.15)"; });
  item2.addEventListener("mouseout", () => { item2.style.background = ""; });
  item2.addEventListener("click", () => {
    fr.maskPolygons.splice(idx, 1);
    menu.remove();
    const hasInclude = fr.maskPolygons.some(p => p.include);
    const holeBtn = $("fringe-btn-mask-hole");
    if (holeBtn) holeBtn.hidden = !hasInclude;
    const clearBtn = $("fringe-btn-mask-clear");
    if (clearBtn) {
      clearBtn.disabled = fr.maskPolygons.length === 0;
      clearBtn.style.opacity = fr.maskPolygons.length === 0 ? "0.6" : "1";
    }
    const drawCanvas = $("fringe-enlarge-roi-canvas");
    if (drawCanvas && drawCanvas.width > 0) drawEnlargeMaskOverlay(drawCanvas);
    drawMaskOverlay();
  });

  menu.appendChild(item1);
  menu.appendChild(item2);
  document.body.appendChild(menu);

  // Close menu on any outside click
  const dismiss = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
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
    const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));

    const payload = {
      wavelength_nm: getWavelength(),
      mask_threshold: getMaskThreshold(),
      subtract_terms: getSubtractTerms(),
      image_b64: b64,
      mask_polygons: _buildMaskPayload(),
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
  fr.lastResult.surface_map = avgData.surface_map;
  fr.lastResult.zernike_chart = avgData.zernike_chart;
  fr.lastResult.profile_x = avgData.profile_x;
  fr.lastResult.profile_y = avgData.profile_y;
  fr.lastResult.psf = avgData.psf;
  fr.lastResult.mtf = avgData.mtf;
  fr.lastResult.pv_nm = avgData.pv_nm;
  fr.lastResult.rms_nm = avgData.rms_nm;
  fr.lastResult.pv_waves = avgData.pv_waves;
  fr.lastResult.rms_waves = avgData.rms_waves;
  fr.lastResult.strehl = avgData.strehl;
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

  // Preview click-to-enlarge
  const preview = $("fringe-preview");
  if (preview) {
    preview.style.cursor = "zoom-in";
    preview.addEventListener("click", () => {
      const overlay = $("fringe-enlarge-overlay");
      const enlargeImg = $("fringe-enlarge-img");
      if (overlay && enlargeImg) {
        enlargeImg.src = preview.src;
        overlay.hidden = false;
      }
    });
  }
  $("fringe-enlarge-close")?.addEventListener("click", () => {
    if (fr.maskDrawing) { exitMaskDrawMode(); return; }
    const overlay = $("fringe-enlarge-overlay");
    if (overlay) overlay.hidden = true;
  });
  $("fringe-enlarge-overlay")?.addEventListener("click", (e) => {
    if (fr.maskDrawing) return; // don't close during mask drawing
    if (e.target === e.currentTarget) {
      e.currentTarget.hidden = true;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (fr.maskDrawing) { exitMaskDrawMode(); return; }
      const overlay = $("fringe-enlarge-overlay");
      if (overlay && !overlay.hidden) overlay.hidden = true;
    }
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

  // Mask polygon drawing
  $("fringe-btn-mask")?.addEventListener("click", () => {
    if (fr.maskDrawing) {
      exitMaskDrawMode();
    } else {
      enterMaskDrawMode(false);
    }
  });
  $("fringe-btn-mask-hole")?.addEventListener("click", () => {
    enterMaskDrawMode(true);
  });
  $("fringe-btn-mask-clear")?.addEventListener("click", () => {
    fr.maskPolygons = [];
    drawMaskOverlay();
    const clearBtn = $("fringe-btn-mask-clear");
    if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.6"; }
    const holeBtn = $("fringe-btn-mask-hole");
    if (holeBtn) holeBtn.hidden = true;
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
