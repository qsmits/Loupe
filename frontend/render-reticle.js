/**
 * render-reticle.js — Digital reticle overlay renderer.
 *
 * Renders the active reticle in screen-space (HUD layer, after ctx.restore()
 * ends the viewport transform). All element coordinates are in mm; they are
 * scaled to canvas pixels via: scale = pixelsPerMm * zoom * dpr.
 *
 * The coordinate origin is always the viewport center.
 */

import { state } from './state.js';
import { viewport } from './viewport.js';
import { ctx, canvas } from './render.js';

// Fallback pixels-per-mm when no calibration is available.
const UNCAL_PX_PER_MM = 100;

// Rotation handle: rendered at this many *screen pixels* above center.
// Hit area uses a slightly larger radius than the visual circle.
const HANDLE_SCREEN_PX = 80;
const HANDLE_VISUAL_R  = 7;   // visual radius in screen px
const HANDLE_HIT_R     = 11;  // hit-test radius in screen px

/**
 * Resolve the effective style for a reticle element, merging (in priority order):
 *   1. User override from state (highest priority)
 *   2. Element-level style override
 *   3. Reticle-level style defaults
 *   4. Hard-coded fallback
 */
function _resolveStyle(reticle, elementStyle) {
  const reticleStyle = reticle.style || {};
  const elStyle      = elementStyle   || {};

  const color     = state.reticleColorOverride
                  ?? elStyle.color
                  ?? reticleStyle.color
                  ?? "#ffffff";

  const opacity   = state.reticleOpacityOverride != null
                  ? state.reticleOpacityOverride
                  : (elStyle.opacity != null ? elStyle.opacity
                  : (reticleStyle.opacity != null ? reticleStyle.opacity : 0.85));

  const lineWidth = elStyle.lineWidth ?? reticleStyle.lineWidth ?? 1;  // in screen px

  return { color, opacity, lineWidth };
}

/**
 * Compute scale factor from mm to canvas pixels.
 * Returns { scale, pixelsPerMm, uncalibrated }.
 */
function _computeScale() {
  const dpr = canvas.width / canvas.clientWidth;
  const cal = state.calibration;
  let pixelsPerMm, uncalibrated;
  if (cal && cal.pixelsPerMm > 0) {
    pixelsPerMm  = cal.pixelsPerMm;
    uncalibrated = false;
  } else {
    pixelsPerMm  = UNCAL_PX_PER_MM;
    uncalibrated = true;
  }
  const scale = pixelsPerMm * viewport.zoom * dpr;
  return { scale, pixelsPerMm, uncalibrated, dpr };
}

/**
 * Draw the "UNCALIBRATED" warning badge in the top-right of the canvas.
 */
function _drawUncalibratedBadge() {
  const dpr     = canvas.width / canvas.clientWidth;
  const padding = 6 * dpr;
  const fontSize = 11 * dpr;
  ctx.save();
  ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
  const text = "UNCALIBRATED";
  const tw   = ctx.measureText(text).width;
  const bw   = tw + padding * 2;
  const bh   = fontSize + padding * 2;
  const bx   = canvas.width - bw - 4 * dpr;
  const by   = 4 * dpr;
  ctx.fillStyle = "rgba(234, 179, 8, 0.85)";
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 3 * dpr);
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.textAlign  = "left";
  ctx.textBaseline = "top";
  ctx.fillText(text, bx + padding, by + padding);
  ctx.restore();
}

/**
 * Compute the screen-space position of the rotation handle.
 * The handle sits HANDLE_SCREEN_PX above center *in the rotated frame*,
 * so after rotation it ends up at a position orbiting the center.
 */
function _handleScreenPos(angleRad, canvasW, canvasH, dpr) {
  const cx = (canvasW / 2);
  const cy = (canvasH / 2);
  // "above center" in rotated frame = (0, -HANDLE_SCREEN_PX * dpr) before rotation
  const dx =  Math.sin(angleRad) * HANDLE_SCREEN_PX * dpr;
  const dy = -Math.cos(angleRad) * HANDLE_SCREEN_PX * dpr;
  return { x: cx + dx, y: cy + dy };
}

/**
 * Render the rotation drag handle (a blue circle with a rotation-arrow hint).
 */
function _drawHandle(angleRad) {
  const dpr = canvas.width / canvas.clientWidth;
  const { x, y } = _handleScreenPos(angleRad, canvas.width, canvas.height, dpr);
  const r = HANDLE_VISUAL_R * dpr;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(59, 130, 246, 0.85)";  // blue-500
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();

  // Thin leader line from center to handle
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, canvas.height / 2);
  ctx.lineTo(x, y);
  ctx.strokeStyle = "rgba(59, 130, 246, 0.35)";
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}

/**
 * Draw a fan reticle — lines converging at a vertex near the top of the screen,
 * fanning downward. Used for threading tool angle measurement.
 *
 * Each element in reticle.angles: { deg, lineWidth?, label?, labelSizePx? }
 *   deg: angle from vertical centerline (positive = clockwise)
 */
function _drawFanReticle(angleRad, dpr, reticle) {
  const { color, opacity, lineWidth } = _resolveStyle(reticle, null);
  const vertexFrac = reticle.vertexScreenY ?? 0.1;  // fraction from top
  const vx = canvas.width / 2;
  const vy = canvas.height * vertexFrac;
  // Lines extend to the bottom edge (plus margin for rotation)
  const lineLen = Math.max(canvas.width, canvas.height) * 1.2;

  ctx.save();
  ctx.translate(vx, vy);
  ctx.rotate(angleRad);
  ctx.globalAlpha = opacity;

  for (const a of (reticle.angles || [])) {
    const { color: aColor, opacity: aOpacity, lineWidth: aLW } = _resolveStyle(reticle, a.style);
    const rad = (a.deg * Math.PI) / 180;
    const ex = Math.sin(rad) * lineLen;
    const ey = Math.cos(rad) * lineLen;  // positive = downward in canvas

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = aColor;
    ctx.globalAlpha = aOpacity;
    ctx.lineWidth = (a.lineWidth ?? lineWidth) * dpr;
    ctx.stroke();

    if (a.label) {
      const labelDist = 30 * dpr;  // label offset from vertex in screen px
      const lx = Math.sin(rad) * labelDist;
      const ly = Math.cos(rad) * labelDist;
      const fontSize = (a.labelSizePx ?? 10) * dpr;
      ctx.font = `${fontSize}px ui-monospace, monospace`;
      ctx.fillStyle = aColor;
      ctx.textAlign = rad >= 0 ? "left" : "right";
      ctx.textBaseline = "middle";
      const nudge = (rad >= 0 ? 4 : -4) * dpr;
      ctx.fillText(a.label, lx + nudge, ly);
    }
  }

  ctx.restore();

  // Name badge in top-left corner
  if (reticle.name) {
    const { color: badgeColor, opacity: badgeOpacity } = _resolveStyle(reticle, null);
    const fontSize = 14 * dpr;
    const pad = 8 * dpr;
    ctx.save();
    ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
    ctx.fillStyle = badgeColor;
    ctx.globalAlpha = badgeOpacity;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(reticle.name, pad, pad);
    ctx.restore();
  }
}

/**
 * Draw a crosshair reticle — edge-to-edge dashed lines in screen-space.
 */
function _drawCrosshairReticle(cxCanvas, cyCanvas, angleRad, dpr, color, opacity, lineWidth) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth * dpr;
  ctx.setLineDash([4 * dpr, 4 * dpr]);

  if (angleRad === 0) {
    ctx.beginPath();
    ctx.moveTo(cxCanvas, 0);
    ctx.lineTo(cxCanvas, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cyCanvas);
    ctx.lineTo(canvas.width, cyCanvas);
    ctx.stroke();
  } else {
    const len = Math.max(canvas.width, canvas.height);
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    ctx.beginPath();
    ctx.moveTo(cxCanvas - cosA * len, cyCanvas - sinA * len);
    ctx.lineTo(cxCanvas + cosA * len, cyCanvas + sinA * len);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cxCanvas + sinA * len, cyCanvas - cosA * len);
    ctx.lineTo(cxCanvas - sinA * len, cyCanvas + cosA * len);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw a single reticle element in mm-space (called inside the scaled transform).
 */
function _drawElement(el, reticle, scale, dpr) {
  const { color, opacity, lineWidth } = _resolveStyle(reticle, el.style);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  // lineWidth is in screen px. scale = ppm * zoom * dpr already includes dpr,
  // so to get `lineWidth` screen px we need: localWidth * scale = lineWidth * dpr
  ctx.lineWidth   = lineWidth * dpr / scale;

  switch (el.type) {
    case "line":
      ctx.beginPath();
      ctx.moveTo(el.x1, el.y1);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
      break;
    case "circle":
      ctx.beginPath();
      ctx.arc(el.cx, el.cy, el.r, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "arc": {
      const startRad = (el.startDeg * Math.PI) / 180;
      const endRad   = (el.endDeg   * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(el.cx, el.cy, el.r, startRad, endRad);
      ctx.stroke();
      break;
    }
    case "text": {
      const fontSizeMm = el.sizeMm || 1.5;
      ctx.font         = `${fontSizeMm}px sans-serif`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(el.value ?? "", el.x, el.y);
      break;
    }
  }

  ctx.restore();
}

/**
 * Draw the active reticle onto the canvas in HUD (screen) space.
 * Called from redraw() after ctx.restore() ends the viewport transform.
 */
export function drawReticle() {
  const reticle = state.activeReticle;
  if (!reticle) return;
  const hasElements = Array.isArray(reticle.elements) && reticle.elements.length > 0;
  const hasAngles   = Array.isArray(reticle.angles)   && reticle.angles.length > 0;
  if (!hasElements && !hasAngles && !reticle.crosshair && !reticle.fan) return;

  const { scale, uncalibrated, dpr } = _computeScale();
  const angleRad = (state.reticleRotationDeg * Math.PI) / 180;
  const cxCanvas = canvas.width / 2;
  const cyCanvas = canvas.height / 2;

  const { color, opacity, lineWidth } = _resolveStyle(reticle, null);
  const isScreenSpace = reticle.crosshair || reticle.fan;

  if (reticle.fan) {
    _drawFanReticle(angleRad, dpr, reticle);
  } else if (reticle.crosshair) {
    _drawCrosshairReticle(cxCanvas, cyCanvas, angleRad, dpr, color, opacity, lineWidth);
  } else {
    // Normal reticle: mm-space elements
    ctx.save();
    ctx.translate(cxCanvas, cyCanvas);
    ctx.rotate(angleRad);
    ctx.scale(scale, scale);

    for (const el of reticle.elements) {
      _drawElement(el, reticle, scale, dpr);
    }

    ctx.restore();
  }

  // Draw rotation handle (always for fan/mm-space, only when rotated for crosshair)
  if (!reticle.crosshair || state.reticleRotationDeg !== 0) {
    _drawHandle(angleRad);
  }

  // Uncalibrated badge (skip for screen-space reticles)
  if (!isScreenSpace && uncalibrated) {
    _drawUncalibratedBadge();
  }
}

/**
 * Hit-test the rotation drag handle.
 *
 * @param {{ x: number, y: number }} screenPt  — canvas-pixel coordinates (DPR-scaled)
 * @returns {boolean}
 */
export function hitTestReticleHandle(screenPt) {
  if (!state.activeReticle) return false;
  const dpr = canvas.width / canvas.clientWidth;
  const angleRad = (state.reticleRotationDeg * Math.PI) / 180;
  const { x, y } = _handleScreenPos(angleRad, canvas.width, canvas.height, dpr);
  const dist = Math.hypot(screenPt.x - x, screenPt.y - y);
  return dist <= HANDLE_HIT_R * dpr;
}
