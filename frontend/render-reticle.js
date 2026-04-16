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
 * Draw the active reticle onto the canvas in HUD (screen) space.
 * Called from redraw() after ctx.restore() ends the viewport transform.
 */
export function drawReticle() {
  const reticle = state.activeReticle;
  if (!reticle || !Array.isArray(reticle.elements) || reticle.elements.length === 0) return;

  const { scale, uncalibrated, dpr } = _computeScale();
  const angleRad = (state.reticleRotationDeg * Math.PI) / 180;
  const canvasW  = canvas.width;
  const canvasH  = canvas.height;

  ctx.save();

  // Move to viewport center, apply rotation, then scale mm → pixels
  ctx.translate(canvasW / 2, canvasH / 2);
  ctx.rotate(angleRad);
  ctx.scale(scale, scale);

  // Draw each element
  for (const el of reticle.elements) {
    const { color, opacity, lineWidth } = _resolveStyle(reticle, el.style);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    // lineWidth is in screen pixels — compensate for the active scale transform
    ctx.lineWidth   = lineWidth / (scale * dpr);

    switch (el.type) {
      case "line": {
        ctx.beginPath();
        ctx.moveTo(el.x1, el.y1);
        ctx.lineTo(el.x2, el.y2);
        ctx.stroke();
        break;
      }
      case "circle": {
        ctx.beginPath();
        ctx.arc(el.cx, el.cy, el.r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "arc": {
        const startRad = (el.startDeg * Math.PI) / 180;
        const endRad   = (el.endDeg   * Math.PI) / 180;
        ctx.beginPath();
        ctx.arc(el.cx, el.cy, el.r, startRad, endRad);
        ctx.stroke();
        break;
      }
      case "text": {
        // sizeMm is the desired font height in mm. After ctx.scale(scale, scale),
        // 1 ctx unit = (1/scale) canvas-px, so a font of `sizeMm` px in the
        // scaled coordinate system maps to sizeMm mm on screen. That is exactly
        // what we want: font size in these "mm units" equals sizeMm directly.
        const fontSizeMm = el.sizeMm || 1.5;
        ctx.font         = `${fontSizeMm}px sans-serif`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(el.value ?? "", el.x, el.y);
        break;
      }
      default:
        break;
    }

    ctx.restore();
  }

  ctx.restore();  // undo translate/rotate/scale

  // Draw the rotation handle in screen space (no mm scaling)
  _drawHandle(angleRad);

  // Uncalibrated warning badge
  if (uncalibrated) {
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
