/**
 * lens-cal.js — Lens distortion calibration.
 *
 * User measures the same physical dimension at N positions across the image.
 * We fit the radial distortion coefficient k1 by minimizing the variance of
 * the corrected lengths (golden-section search). No calibration target required —
 * any feature of repeating known size works (grid, holes, slots, …).
 *
 * Distortion model (Brown–Conrady, first-order radial only):
 *   undistort: p_u = center + (p_d - center) / (1 + k1 * r_d²)
 *   remap:     for each undistorted pixel, sample distorted source at
 *              src = center + (dst - center) * (1 + k1 * r²)
 */

import { state } from './state.js';
import { imageWidth, imageHeight } from './viewport.js';
import { ctx, showStatus, redraw, pw, drawHandle } from './render.js';
import { cacheImageData } from './subpixel-js.js';
import { uploadCorrectedFrame } from './api.js';

// ── Module-private state ──────────────────────────────────────────────────────
let _active    = false;
let _pendingP1 = null;
let _mousePos  = null;
let _samples   = [];    // [{p1: {x,y}, p2: {x,y}}, …]

// ── Public interface ──────────────────────────────────────────────────────────
export function isLensCalMode() { return _active; }

export function initLensCal() {
  // btn-lens-cal-open is wired in main.js via closeAllDropdowns + _openDialog;
  // keep legacy btn-lens-cal selector in case it exists in old HTML
  document.getElementById("btn-lens-cal")
    ?.addEventListener("click", _openDialog);
  document.getElementById("btn-lens-cal-cancel")
    ?.addEventListener("click", _cancelDialog);
  document.getElementById("btn-lens-cal-confirm")
    ?.addEventListener("click", _confirmCal);
  document.getElementById("btn-lens-cal-clear")
    ?.addEventListener("click", () => {
      _samples   = [];
      _pendingP1 = null;
      _updateUI();
      redraw();
    });
}

/** Called from events-mouse.js on left-click when lens cal is active.
 *  Returns true to consume the event. */
export function lensCalClick(pt) {
  if (!_active) return false;
  if (!_pendingP1) {
    _pendingP1 = pt;
  } else {
    const d = Math.hypot(pt.x - _pendingP1.x, pt.y - _pendingP1.y);
    if (d > 5) {
      _samples.push({ p1: _pendingP1, p2: pt });
      _updateUI();
    }
    _pendingP1 = null;
  }
  redraw();
  return true;
}

/** Called from events-mouse.js on mousemove when lens cal is active. */
export function lensCalMouseMove(pt) {
  if (!_active) return;
  _mousePos = pt;
  if (_pendingP1) redraw();
}

/** Draw sample lines + live preview; called inside the viewport transform. */
export function drawLensCalOverlay() {
  if (!_active) return;

  ctx.save();

  // Completed samples — solid blue
  for (const s of _samples) {
    ctx.strokeStyle = "rgba(96,165,250,0.85)";
    ctx.lineWidth   = pw(1.5);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(s.p1.x, s.p1.y);
    ctx.lineTo(s.p2.x, s.p2.y);
    ctx.stroke();
    drawHandle(s.p1, "#60a5fa");
    drawHandle(s.p2, "#60a5fa");
  }

  // Pending first point + dashed preview to cursor
  if (_pendingP1) {
    drawHandle(_pendingP1, "#60a5fa");
    if (_mousePos) {
      ctx.strokeStyle = "rgba(96,165,250,0.45)";
      ctx.lineWidth   = pw(1.5);
      ctx.setLineDash([pw(4), pw(4)]);
      ctx.beginPath();
      ctx.moveTo(_pendingP1.x, _pendingP1.y);
      ctx.lineTo(_mousePos.x, _mousePos.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.restore();
}

// ── Dialog logic ──────────────────────────────────────────────────────────────
export function openLensCalDialog() { _openDialog(); }

function _openDialog() {
  if (!state.frozenBackground) {
    showStatus("Freeze an image first");
    return;
  }
  _active    = true;
  _samples   = [];
  _pendingP1 = null;
  document.getElementById("lens-cal-dialog").hidden = false;
  _updateUI();
  redraw();
}

function _cancelDialog() {
  _active    = false;
  _pendingP1 = null;
  document.getElementById("lens-cal-dialog").hidden = true;
  redraw();
}

async function _confirmCal() {
  if (_samples.length < 3) return;

  const k1 = _fitK1(_samples);
  state.lensK1 = k1;

  // Disable confirm while remap runs (can be slow on large images)
  const confirmBtn = document.getElementById("btn-lens-cal-confirm");
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Applying…"; }

  // Give the browser a frame to render the button state, then run the remap
  await new Promise(r => setTimeout(r, 30));

  const corrected = _applyK1(state.frozenBackground, k1);
  state.frozenBackground = corrected;
  cacheImageData(corrected, imageWidth, imageHeight);

  _active    = false;
  _samples   = [];
  _pendingP1 = null;
  document.getElementById("lens-cal-dialog").hidden = true;

  // Update the lens-cal button to reflect applied state
  const btn = document.getElementById("btn-lens-cal");
  if (btn) {
    btn.textContent = "Lens ✓";
    btn.classList.add("lens-calibrated");
  }
  if (confirmBtn) { confirmBtn.textContent = "Apply"; }

  redraw();
  showStatus(`Lens correction applied (k₁ = ${k1.toExponential(2)}) — syncing to server…`);
  await uploadCorrectedFrame(corrected);
  showStatus(`Lens correction applied (k₁ = ${k1.toExponential(2)})`);
}

// ── Fitting ───────────────────────────────────────────────────────────────────
function _correctedLength(s, k1) {
  const cx = imageWidth / 2, cy = imageHeight / 2;
  const ud = p => {
    const dx = p.x - cx, dy = p.y - cy;
    const sc = 1 / (1 + k1 * (dx * dx + dy * dy));
    return { x: cx + dx * sc, y: cy + dy * sc };
  };
  const u1 = ud(s.p1), u2 = ud(s.p2);
  return Math.hypot(u2.x - u1.x, u2.y - u1.y);
}

function _variance(k1, samples) {
  const L = samples.map(s => _correctedLength(s, k1));
  const mean = L.reduce((a, b) => a + b, 0) / L.length;
  return L.reduce((s, l) => s + (l - mean) ** 2, 0) / L.length;
}

function _fitK1(samples) {
  if (samples.length < 2) return 0;
  // Normalise so search range is resolution-independent: k1_norm ∈ [-0.8, 0.8]
  // where k1_raw = k1_norm / (diag/2)²
  const diag2 = (imageWidth ** 2 + imageHeight ** 2) / 4;
  const toRaw = n => n / diag2;

  const phi = (Math.sqrt(5) - 1) / 2;
  let a = toRaw(-0.8), b = toRaw(0.8);
  for (let i = 0; i < 120; i++) {
    const c = b - phi * (b - a);
    const d = a + phi * (b - a);
    if (_variance(c, samples) < _variance(d, samples)) b = d;
    else a = c;
    if (Math.abs(b - a) < 1e-18) break;
  }
  return (a + b) / 2;
}

function _spreadPct(k1, samples) {
  const L = samples.map(s => _correctedLength(s, k1));
  const mean = L.reduce((a, b) => a + b, 0) / L.length;
  return (Math.max(...L.map(l => Math.abs(l - mean))) / mean) * 100;
}

// ── Pixel remap (bilinear, forward distortion model) ──────────────────────────
function _applyK1(srcImg, k1) {
  const w = imageWidth, h = imageHeight;

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = w; srcCanvas.height = h;
  srcCanvas.getContext("2d").drawImage(srcImg, 0, 0, w, h);
  const src = srcCanvas.getContext("2d").getImageData(0, 0, w, h).data;

  const dstCanvas = document.createElement("canvas");
  dstCanvas.width = w; dstCanvas.height = h;
  const dstCtx = dstCanvas.getContext("2d");
  const dstImg = dstCtx.createImageData(w, h);
  const dst    = dstImg.data;

  const cx = w / 2, cy = h / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const r2 = dx * dx + dy * dy;
      // Sample distorted source for this undistorted destination pixel
      const sx = cx + dx * (1 + k1 * r2);
      const sy = cy + dy * (1 + k1 * r2);

      const ix = sx | 0, iy = sy | 0;
      const di = (y * w + x) * 4;

      if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) {
        dst[di + 3] = 255;   // black, fully opaque at edges
        continue;
      }
      const fx = sx - ix, fy = sy - iy;
      const s00 = (iy * w + ix) * 4;
      const s10 = (iy * w + ix + 1) * 4;
      const s01 = ((iy + 1) * w + ix) * 4;
      const s11 = ((iy + 1) * w + ix + 1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 =      fx  * (1 - fy);
      const w01 = (1 - fx) *      fy;
      const w11 =      fx  *      fy;
      dst[di]     = w00 * src[s00]     + w10 * src[s10]     + w01 * src[s01]     + w11 * src[s11];
      dst[di + 1] = w00 * src[s00 + 1] + w10 * src[s10 + 1] + w01 * src[s01 + 1] + w11 * src[s11 + 1];
      dst[di + 2] = w00 * src[s00 + 2] + w10 * src[s10 + 2] + w01 * src[s01 + 2] + w11 * src[s11 + 2];
      dst[di + 3] = 255;
    }
  }

  dstCtx.putImageData(dstImg, 0, 0);
  return dstCanvas;
}

// ── Dialog UI ─────────────────────────────────────────────────────────────────
function _updateUI() {
  _renderSampleList();
  _renderStats();
  const confirmBtn = document.getElementById("btn-lens-cal-confirm");
  if (confirmBtn) confirmBtn.disabled = _samples.length < 3;
}

function _renderSampleList() {
  const el = document.getElementById("lens-cal-samples");
  if (!el) return;
  el.innerHTML = "";

  if (_samples.length === 0) {
    const hint = document.createElement("p");
    hint.className = "lens-cal-hint";
    hint.textContent = "Click two points on the image to measure a dimension. Repeat at several positions.";
    el.appendChild(hint);
    return;
  }

  const cx = imageWidth / 2, cy = imageHeight / 2;
  _samples.forEach((s, i) => {
    const rawLen = Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y);
    const midR   = Math.hypot((s.p1.x + s.p2.x) / 2 - cx, (s.p1.y + s.p2.y) / 2 - cy);

    const row  = document.createElement("div");
    row.className = "lens-cal-row";

    const num  = document.createElement("span");
    num.className = "lens-cal-num";
    num.textContent = `#${i + 1}`;

    const len  = document.createElement("span");
    len.className = "lens-cal-len";
    len.textContent = `${rawLen.toFixed(1)} px`;

    const rad  = document.createElement("span");
    rad.className = "lens-cal-r";
    rad.textContent = `r = ${midR.toFixed(0)} px`;

    const del  = document.createElement("button");
    del.className = "lens-cal-del";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      _samples.splice(i, 1);
      if (_pendingP1) _pendingP1 = null;
      _updateUI();
      redraw();
    });

    row.append(num, len, rad, del);
    el.appendChild(row);
  });
}

function _renderStats() {
  const statsEl = document.getElementById("lens-cal-stats");
  const plotEl  = document.getElementById("lens-cal-plot");
  if (!statsEl) return;

  if (_samples.length < 2) {
    statsEl.innerHTML = _samples.length === 1
      ? "<span class='lens-cal-hint-sm'>Add at least 2 more measurements</span>"
      : "";
    if (plotEl) plotEl.innerHTML = "";
    return;
  }

  const k1          = _fitK1(_samples);
  const spreadBefore = _spreadPct(0, _samples);
  const spreadAfter  = _spreadPct(k1, _samples);

  statsEl.innerHTML = `
    <div class="lens-stat-line">
      Spread: <span class="lens-stat-before">±${spreadBefore.toFixed(1)}%</span>
      → <span class="lens-stat-after">±${spreadAfter.toFixed(1)}%</span>
    </div>
    <div class="lens-stat-k1">k₁ = ${k1.toExponential(2)}</div>
  `;

  if (plotEl) _renderPlot(plotEl, k1);
}

function _renderPlot(el, k1) {
  const W = 220, H = 64, PX = 18, PY = 8;
  const cx  = imageWidth / 2, cy = imageHeight / 2;
  const maxR = Math.hypot(imageWidth / 2, imageHeight / 2);

  const pts = _samples.map(s => ({
    r:  Math.hypot((s.p1.x + s.p2.x) / 2 - cx, (s.p1.y + s.p2.y) / 2 - cy),
    L0: Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y),
    L:  _correctedLength(s, k1),
  }));

  const mean0  = pts.reduce((a, p) => a + p.L0, 0) / pts.length;
  const mean   = pts.reduce((a, p) => a + p.L,  0) / pts.length;
  const maxDev = Math.max(
    0.005,
    ...pts.map(p => Math.abs(p.L0 / mean0 - 1)),
    ...pts.map(p => Math.abs(p.L  / mean  - 1)),
  );

  const tx = r   => PX + (r / maxR) * (W - 2 * PX);
  const ty = dev => H / 2 - (dev / maxDev) * (H / 2 - PY);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<line x1="${PX}" y1="${H/2}" x2="${W-PX}" y2="${H/2}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`;
  svg += `<text x="${PX}" y="${H-2}" font-size="8" fill="rgba(255,255,255,0.35)">center</text>`;
  svg += `<text x="${W-PX-16}" y="${H-2}" font-size="8" fill="rgba(255,255,255,0.35)">edge</text>`;

  // Before correction (grey)
  for (const p of pts) {
    const x = tx(p.r).toFixed(1), y = ty(p.L0 / mean0 - 1).toFixed(1);
    svg += `<circle cx="${x}" cy="${y}" r="3.5" fill="rgba(160,160,160,0.6)"/>`;
  }
  // After correction (green)
  for (const p of pts) {
    const x = tx(p.r).toFixed(1), y = ty(p.L / mean - 1).toFixed(1);
    svg += `<circle cx="${x}" cy="${y}" r="3.5" fill="rgba(48,209,88,0.9)"/>`;
  }

  svg += `</svg>`;
  el.innerHTML = svg;
}
