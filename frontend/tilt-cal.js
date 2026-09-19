/**
 * tilt-cal.js — Perspective (tilt) correction calibration.
 *
 * The user clicks 4 corners of a known rectangle (e.g. on graph paper) in
 * clockwise order: top-left → top-right → bottom-right → bottom-left.
 * They enter the real-world width and height in mm.  The module computes the
 * homography that maps those 4 points to a perfect rectangle and warps the
 * frozen image in-place.
 */

import { state } from './state.js';
import { canvas, showStatus, redraw } from './render.js';
import { imageWidth, imageHeight } from './viewport.js';
import { cacheImageData } from './subpixel-js.js';
import { uploadCorrectedFrame } from './api.js';
import { captureImageGeometry, clearImageGeometry, restoreImageGeometry } from './image-geometry.js';
import { renderSidebar, updateCalibrationButton } from './sidebar.js';
import { _computeDstCorners, _computeHomography, _inv3x3 } from './perspective-math.js';

// ── Module state ──────────────────────────────────────────────────────────────
let _active   = false;
let _points   = [];   // up to 4 {x, y} image-space points
let _mousePos = null;
let _dialogEpoch = -1;

export function hasPerspectiveCorrection() {
  return !!state.perspectiveUndo && state.perspectiveUndo.corrected === state.frozenBackground;
}

export async function undoPerspectiveCorrection() {
  if (!hasPerspectiveCorrection()) return;
  const saved = state.perspectiveUndo;
  const epoch = state._epoch;
  state.frozenBackground = saved.image;
  state.lensSource = saved.lensSource;
  restoreImageGeometry(saved.geometry);
  renderSidebar();
  updateCalibrationButton();
  state.perspectiveUndo = null;
  cacheImageData(state.frozenBackground, imageWidth, imageHeight);
  redraw();
  showStatus("Perspective correction undone — syncing to server…");
  // uploadCorrectedFrame expects a canvas, so draw the image into one first
  const offscreen = document.createElement("canvas");
  offscreen.width = imageWidth;
  offscreen.height = imageHeight;
  offscreen.getContext("2d").drawImage(state.frozenBackground, 0, 0);
  await uploadCorrectedFrame(offscreen);
  if (state._epoch !== epoch) return;
  showStatus("Perspective correction undone");
  document.dispatchEvent(new CustomEvent("perspective-correction-changed"));
}

export function isTiltCalMode() { return _active && _dialogEpoch === state._epoch; }

// ── Public interface ──────────────────────────────────────────────────────────
export function initTiltCal() {
  document.getElementById("btn-tilt-cal-cancel")
    ?.addEventListener("click", _cancelDialog);
  document.getElementById("btn-tilt-cal-apply")
    ?.addEventListener("click", _applyCorrection);
  document.getElementById("btn-tilt-cal-reset")
    ?.addEventListener("click", () => { _points = []; _updateUI(); redraw(); });
}

export function tiltCalClick(pt) {
  if (!isTiltCalMode()) return false;
  if (_points.length >= 4) return true;
  _points.push({ x: pt.x, y: pt.y });
  _updateUI();
  redraw();
  return true;
}

export function tiltCalMouseMove(pt) {
  if (!isTiltCalMode()) return;
  _mousePos = pt;
  if (_points.length < 4) redraw();
}

// ── Overlay drawing (called by render.js inside the viewport transform) ───────
export function drawTiltCalOverlay() {
  if (!isTiltCalMode()) return;
  const ctx = canvas.getContext("2d");
  const scale = window.devicePixelRatio ?? 1;
  const pw = s => s / (canvas.width / (canvas.getBoundingClientRect().width));

  // Draw lines between placed points + preview line to mouse
  const pts = _mousePos && _points.length < 4
    ? [..._points, _mousePos]
    : _points;

  if (pts.length >= 2) {
    ctx.save();
    ctx.strokeStyle = "rgba(99,102,241,0.8)";
    ctx.lineWidth = pw(1.5);
    ctx.setLineDash([pw(5), pw(3)]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (_points.length === 4) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Draw numbered markers for placed points
  const labels = ["1", "2", "3", "4"];
  const hints  = ["TL", "TR", "BR", "BL"];
  for (let i = 0; i < _points.length; i++) {
    const p = _points[i];
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, pw(8), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(99,102,241,0.9)";
    ctx.fill();
    ctx.font = `bold ${pw(10)}px ui-monospace, monospace`;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(labels[i], p.x, p.y);
    ctx.restore();
    // Corner label
    ctx.save();
    ctx.font = `${pw(9)}px ui-monospace, monospace`;
    ctx.fillStyle = "rgba(99,102,241,1)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(hints[i], p.x + pw(10), p.y - pw(10));
    ctx.restore();
  }
}

// ── Open / close ──────────────────────────────────────────────────────────────
export function openTiltCalDialog() {
  if (!state.frozenBackground) { showStatus("Freeze an image first"); return; }
  _dialogEpoch = state._epoch;
  _active   = true;
  _points   = [];
  _mousePos = null;
  document.getElementById("tilt-cal-dialog").hidden = false;
  _updateUI();
  redraw();
}

function _cancelDialog() {
  _active = false;
  _points = [];
  document.getElementById("tilt-cal-dialog").hidden = true;
  redraw();
}

// ── Apply perspective correction ──────────────────────────────────────────────
async function _applyCorrection() {
  if (!isTiltCalMode() || _points.length < 4) return;
  const wMm = parseFloat(document.getElementById("tilt-cal-width").value);
  const hMm = parseFloat(document.getElementById("tilt-cal-height").value);
  if (!wMm || !hMm || wMm <= 0 || hMm <= 0) {
    showStatus("Enter valid rectangle dimensions"); return;
  }

  const applyBtn = document.getElementById("btn-tilt-cal-apply");
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = "Applying…"; }
  const epoch = state._epoch;
  await new Promise(r => setTimeout(r, 30));
  if (state._epoch !== epoch) return;

  const dstPts = _computeDstCorners(_points, wMm, hMm);
  const H      = _computeHomography(_points, dstPts);
  if (!H) { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "Apply"; } showStatus("Could not compute perspective — try different points"); return; }
  const H_inv  = _inv3x3(H);
  if (!H_inv) { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "Apply"; } showStatus("Degenerate transform — points may be collinear"); return; }

  const saved = { image: state.frozenBackground, geometry: captureImageGeometry(), lensSource: state.lensSource };
  const corrected = _warpImage(H_inv, saved.image);
  state.perspectiveUndo = { ...saved, corrected };
  // The original lens source is in a different perspective coordinate system.
  state.lensSource = { output: corrected, k1: state.lensK1, unavailable: true };
  clearImageGeometry({ pixelsPerMm: (dstPts[1].x - dstPts[0].x) / wMm,
    displayUnit: saved.geometry.fields.calibration?.displayUnit || "mm" });
  renderSidebar();
  updateCalibrationButton();
  state.frozenBackground = corrected;
  cacheImageData(corrected, imageWidth, imageHeight);

  _active = false;
  _points = [];
  document.getElementById("tilt-cal-dialog").hidden = true;
  redraw();
  showStatus("Perspective correction applied — syncing to server…");
  await uploadCorrectedFrame(corrected);
  if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "Apply"; }
  if (state._epoch !== epoch) return;
  showStatus("Perspective corrected and calibrated; old measurements cleared. Undo restores them.");
  document.dispatchEvent(new CustomEvent("perspective-correction-changed"));
}

// ── UI update ─────────────────────────────────────────────────────────────────
function _updateUI() {
  const n = _points.length;
  const hint = document.getElementById("tilt-cal-hint");
  const dimsRow = document.getElementById("tilt-cal-dims-row");
  const applyBtn = document.getElementById("btn-tilt-cal-apply");

  const nextHints = ["top-left", "top-right", "bottom-right", "bottom-left"];
  if (hint) {
    hint.textContent = n < 4
      ? `Click the ${nextHints[n]} corner (${n}/4)`
      : "Enter dimensions. Applying recalibrates the image and clears old measurements; perspective Undo restores them.";
  }
  if (dimsRow)  dimsRow.hidden  = n < 4;
  if (applyBtn) applyBtn.disabled = n < 4;
}

// ── Math ──────────────────────────────────────────────────────────────────────

/** Warp srcImg by the inverse homography H_inv; output same dimensions. */
function _warpImage(H_inv, srcImg) {
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

  const [[a,b2,c],[d,e,f],[g2,hh,ii]] = H_inv;

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const ww = g2*dx + hh*dy + ii;
      const sx = (a*dx + b2*dy + c) / ww;
      const sy = (d*dx + e*dy + f) / ww;

      if (sx < 0 || sx >= w - 1 || sy < 0 || sy >= h - 1) continue;

      // Bilinear interpolation
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;
      const out = (dy * w + dx) * 4;
      const w00 = (1-fx)*(1-fy), w10 = fx*(1-fy);
      const w01 = (1-fx)*fy,     w11 = fx*fy;
      dst[out]   = w00*src[i00]   + w10*src[i10]   + w01*src[i01]   + w11*src[i11];
      dst[out+1] = w00*src[i00+1] + w10*src[i10+1] + w01*src[i01+1] + w11*src[i11+1];
      dst[out+2] = w00*src[i00+2] + w10*src[i10+2] + w01*src[i01+2] + w11*src[i11+2];
      dst[out+3] = 255;
    }
  }

  dstCtx.putImageData(dstImg, 0, 0);
  return dstCanvas;
}
