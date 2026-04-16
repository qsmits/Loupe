/**
 * render-hud.js — HUD elements: minimap, grid, crosshair, pending points, loupe.
 * Extracted from render.js (Task 7).
 */
import { state } from './state.js';
import { viewport, imageWidth, imageHeight } from './viewport.js';
import { ctx, canvas, pw, drawHandle } from './render.js';
import { CONSTRAINT_ICONS } from './constraints.js';

// Tools that trigger the loupe (any tool that places measurement points)
const _LOUPE_TOOLS = new Set([
  "distance", "angle", "circle", "arc-fit", "arc-measure",
  "perp-dist", "para-dist", "center-dist", "pt-circle-dist",
  "intersect", "slot-dist", "area", "calibrate", "spline", "fit-line",
]);

export function drawGrid() {
  if (!state.showGrid) return;
  const cal = state.calibration;

  let spacingPx;
  if (cal && cal.pixelsPerMm > 0) {
    const targetScreenPx = 40;
    const mmPerScreenPx = 1 / (cal.pixelsPerMm * viewport.zoom);
    const targetMm = targetScreenPx * mmPerScreenPx;
    const niceIntervals = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50];
    let spacing_mm = niceIntervals[0];
    for (const n of niceIntervals) {
      if (n >= targetMm) { spacing_mm = n; break; }
    }
    spacingPx = spacing_mm * cal.pixelsPerMm;
  } else {
    spacingPx = 50;
  }

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = pw(0.5);
  ctx.setLineDash([]);

  const x0 = viewport.panX;
  const y0 = viewport.panY;
  const x1 = x0 + (canvas.clientWidth / viewport.zoom);
  const y1 = y0 + (canvas.clientHeight / viewport.zoom);

  const startX = Math.floor(x0 / spacingPx) * spacingPx;
  const startY = Math.floor(y0 / spacingPx) * spacingPx;

  for (let x = startX; x <= x1; x += spacingPx) {
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }
  for (let y = startY; y <= y1; y += spacingPx) {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }

  ctx.restore();
}

export function drawMinimap() {
  if (!state.frozenBackground || imageWidth === 0) return;
  const fitZoom = Math.min(canvas.clientWidth / imageWidth, canvas.clientHeight / imageHeight);
  if (viewport.zoom <= fitZoom * 1.05) return;

  const padding = 8;
  const maxW = 180;
  const maxH = 120;

  const aspect = imageWidth / imageHeight;
  let mmW, mmH;
  if (aspect > maxW / maxH) {
    mmW = maxW;
    mmH = maxW / aspect;
  } else {
    mmH = maxH;
    mmW = maxH * aspect;
  }

  const mmX = padding;
  const mmY = canvas.clientHeight - mmH - padding;

  const dpr = canvas.width / canvas.clientWidth;
  const x = mmX * dpr, y = mmY * dpr, w = mmW * dpr, h = mmH * dpr;

  ctx.save();

  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);

  ctx.drawImage(state.frozenBackground, x, y, w, h);

  const visibleW = canvas.clientWidth / viewport.zoom;
  const visibleH = canvas.clientHeight / viewport.zoom;

  const rectX = x + (viewport.panX / imageWidth) * w;
  const rectY = y + (viewport.panY / imageHeight) * h;
  const rectW = (visibleW / imageWidth) * w;
  const rectH = (visibleH / imageHeight) * h;

  ctx.strokeStyle = "#60a5fa";
  ctx.lineWidth = 1.5 * dpr;
  ctx.setLineDash([]);
  ctx.strokeRect(rectX, rectY, rectW, rectH);

  ctx.fillStyle = "rgba(96, 165, 250, 0.1)";
  ctx.fillRect(rectX, rectY, rectW, rectH);

  ctx.restore();
}

export function drawPendingPoints() {
  state.pendingPoints.forEach(pt => drawHandle(pt, "#fb923c"));
}

/**
 * Draw a circular magnifier loupe into the dedicated #loupe-canvas element
 * (NOT the main overlay canvas). This complete isolation prevents any loupe
 * rendering error from affecting the main canvas or its event handling.
 *
 * The loupe canvas sits as an absolutely-positioned sibling with pointer-events:none
 * so it cannot intercept clicks on anything.
 */
const _loupeCanvas = document.getElementById("loupe-canvas");
const _loupeCtx    = _loupeCanvas ? _loupeCanvas.getContext("2d") : null;

export function drawLoupe(forceShow = false) {
  if (!_loupeCanvas || !_loupeCtx) return;

  const show = forceShow || (state.frozenBackground && state.mousePos && _LOUPE_TOOLS.has(state.tool));
  if (!show) {
    _loupeCanvas.hidden = true;
    return;
  }

  const LOUPE_R = 90;   // loupe radius in CSS pixels
  const MAGNIFY = 10;   // 1 image pixel appears as MAGNIFY CSS pixels
  const DIAM    = LOUPE_R * 2;
  const padding = 16;

  // Position the loupe canvas in the bottom-right of the viewer.
  // It is a sibling of overlay-canvas; use the same parent for coordinate reference.
  const canvasRect = canvas.getBoundingClientRect();
  const parentRect = canvas.parentElement.getBoundingClientRect();
  const left = (canvasRect.right  - parentRect.left) - DIAM - padding;
  const top  = (canvasRect.bottom - parentRect.top)  - DIAM - padding;

  _loupeCanvas.style.left   = left + "px";
  _loupeCanvas.style.top    = top  + "px";
  _loupeCanvas.style.width  = DIAM + "px";
  _loupeCanvas.style.height = DIAM + "px";
  _loupeCanvas.width        = DIAM;
  _loupeCanvas.height       = DIAM;
  _loupeCanvas.hidden       = false;

  const lc = _loupeCtx;
  lc.clearRect(0, 0, DIAM, DIAM);

  // Source area in image space: DIAM/MAGNIFY image pixels wide
  const srcW = DIAM / MAGNIFY;
  const srcH = DIAM / MAGNIFY;

  // When a snap target exists, center the loupe on it so it's always visible.
  // The cursor crosshair then shows the offset from snap to actual mouse position.
  const snap = state._subpixelSnapTarget ?? state.snapTarget;
  const center = snap ?? state.mousePos;
  const srcX = center.x - srcW / 2;
  const srcY = center.y - srcH / 2;

  // Skip if completely outside the image
  if (imageWidth > 0 && imageHeight > 0 &&
      (srcX + srcW <= 0 || srcY + srcH <= 0 ||
       srcX >= imageWidth || srcY >= imageHeight)) {
    _loupeCanvas.hidden = true;
    return;
  }

  // Circular clip on the loupe canvas
  lc.save();
  lc.beginPath();
  lc.arc(LOUPE_R, LOUPE_R, LOUPE_R, 0, Math.PI * 2);
  lc.clip();

  // Dark background (visible when cursor is near image edge)
  lc.fillStyle = "#111";
  lc.fillRect(0, 0, DIAM, DIAM);

  // Magnified image patch
  lc.drawImage(state.frozenBackground, srcX, srcY, srcW, srcH, 0, 0, DIAM, DIAM);

  lc.restore();

  // Border ring
  lc.strokeStyle = "rgba(255, 255, 255, 0.7)";
  lc.lineWidth = 1.5;
  lc.beginPath();
  lc.arc(LOUPE_R, LOUPE_R, LOUPE_R - 1, 0, Math.PI * 2);
  lc.stroke();

  // Dim white crosshair at actual cursor position
  const ch = 8;
  const cx = (state.mousePos.x - srcX) * MAGNIFY;
  const cy = (state.mousePos.y - srcY) * MAGNIFY;
  lc.strokeStyle = "rgba(255, 255, 255, 0.35)";
  lc.lineWidth = 1;
  lc.beginPath();
  lc.moveTo(cx - ch, cy); lc.lineTo(cx + ch, cy);
  lc.moveTo(cx, cy - ch); lc.lineTo(cx, cy + ch);
  lc.stroke();

  // Snap target crosshair — always at center when snap is active
  if (snap) {
    const sc = 10;
    lc.strokeStyle = "rgba(251, 146, 60, 0.95)";
    lc.lineWidth = 1.5;
    lc.beginPath();
    lc.moveTo(LOUPE_R - sc, LOUPE_R); lc.lineTo(LOUPE_R + sc, LOUPE_R);
    lc.moveTo(LOUPE_R, LOUPE_R - sc); lc.lineTo(LOUPE_R, LOUPE_R + sc);
    lc.stroke();
    lc.fillStyle = "rgba(251, 146, 60, 0.95)";
    lc.beginPath();
    lc.arc(LOUPE_R, LOUPE_R, 2, 0, Math.PI * 2);
    lc.fill();
  }
}

export function drawConstraintBadges() {
  for (const c of state.constraints) {
    if (!c.contactPoint) continue;
    const { x, y } = c.contactPoint;
    const icon = CONSTRAINT_ICONS[c.type] || '?';
    const pillW = pw(20);
    const pillH = pw(14);
    const fontSize = pw(11);

    ctx.save();

    // Pill background
    ctx.fillStyle = c.status === 'conflict'
      ? 'rgba(239, 68, 68, 0.85)'
      : !c.enabled
        ? 'rgba(234, 179, 8, 0.7)'
        : 'rgba(30, 30, 30, 0.8)';

    const rx = x - pillW / 2, ry = y - pillH / 2;
    ctx.beginPath();
    ctx.roundRect(rx, ry, pillW, pillH, pw(4));
    ctx.fill();

    // Dashed outline for disabled
    if (!c.enabled) {
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.9)';
      ctx.lineWidth = pw(1);
      ctx.setLineDash([pw(3), pw(2)]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Icon text
    ctx.fillStyle = c.status === 'conflict' ? '#fca5a5' : !c.enabled ? '#fde68a' : '#fff';
    ctx.font = `${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, x, y);

    // Angle value for angle constraints
    if (c.type === 'angle' && c.angleDeg != null) {
      ctx.font = `${pw(9)}px monospace`;
      ctx.fillText(`${c.angleDeg}°`, x, y + pillH * 0.7);
    }

    ctx.restore();
  }
}

export function hitTestConstraintBadge(pt) {
  const r = pw(12);
  for (const c of state.constraints) {
    if (!c.contactPoint) continue;
    if (Math.hypot(pt.x - c.contactPoint.x, pt.y - c.contactPoint.y) < r) {
      return c;
    }
  }
  return null;
}

// drawCrosshair() removed — crosshair is now a reticle preset (see render-reticle.js)
