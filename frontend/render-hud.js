/**
 * render-hud.js — HUD elements: minimap, grid, crosshair, pending points, loupe.
 * Extracted from render.js (Task 7).
 */
import { state } from './state.js';
import { viewport, imageWidth, imageHeight } from './viewport.js';
import { ctx, canvas, pw, drawHandle, drawLine } from './render.js';
import { drawAreaPreview, drawSplinePreview } from './render-annotations.js';
import { fitCircle } from './math.js';
import { projectConstrained } from './format.js';
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

  // Draw the grid only over the image — the frozen canvas can extend past it.
  const x0 = Math.max(viewport.panX, 0);
  const y0 = Math.max(viewport.panY, 0);
  const x1 = Math.min(viewport.panX + (canvas.clientWidth / viewport.zoom), imageWidth || Infinity);
  const y1 = Math.min(viewport.panY + (canvas.clientHeight / viewport.zoom), imageHeight || Infinity);

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

  // Intersect the visible region with the image bounds — the frozen canvas
  // can extend past the image (letterbox), and the viewport rect must not
  // paint outside the thumbnail.
  const ix0 = Math.max(0, viewport.panX);
  const iy0 = Math.max(0, viewport.panY);
  const ix1 = Math.min(imageWidth, viewport.panX + visibleW);
  const iy1 = Math.min(imageHeight, viewport.panY + visibleH);

  const rectX = x + (ix0 / imageWidth) * w;
  const rectY = y + (iy0 / imageHeight) * h;
  const rectW = (Math.max(0, ix1 - ix0) / imageWidth) * w;
  const rectH = (Math.max(0, iy1 - iy0) / imageHeight) * h;

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
 * In-progress tool preview (rubber band, circle/arc fit, constrained perp/para
 * band, area polygon, spline). State-driven so it survives any redraw — the
 * debounced sub-pixel snap callback in particular used to erase it.
 * Called from redraw() inside the viewport transform (image space).
 */
export function drawToolPreview() {
  if (!state._previewCursor) return;
  const cur = state._previewCursor;

  // Generic rubber band + circle/arc-measure previews
  if (state.pendingPoints.length > 0 && state.tool !== "select"
      && state.tool !== "arc-fit"
      && state.tool !== "perp-dist"
      && state.tool !== "para-dist"
      && state.tool !== "area"
      && state.tool !== "spline") {
    const last = state.pendingPoints[state.pendingPoints.length - 1];
    if (state.tool === "circle" && state.pendingPoints.length === 2) {
      try {
        const preview = fitCircle(state.pendingPoints[0], state.pendingPoints[1], cur);
        ctx.beginPath();
        ctx.arc(preview.cx, preview.cy, preview.r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(251,146,60,0.6)";
        ctx.lineWidth = pw(1.5);
        ctx.setLineDash([pw(5), pw(4)]);
        ctx.stroke();
        ctx.setLineDash([]);
      } catch {
        // collinear — no preview
      }
    } else if (state.tool === "arc-measure" && state.pendingPoints.length === 2) {
      // In sequential mode pendingPoints = [p1, p2] and the mouse is p3.
      // In ends-first mode pendingPoints = [end1, end2] and the mouse is the mid point.
      let p1, p2, p3;
      if (state.arcMeasureMode === "ends-first") {
        [p1, p2, p3] = [state.pendingPoints[0], cur, state.pendingPoints[1]];
      } else {
        [p1, p2, p3] = [state.pendingPoints[0], state.pendingPoints[1], cur];
      }
      const ax = p2.x - p1.x, ay = p2.y - p1.y;
      const bx = p3.x - p1.x, by = p3.y - p1.y;
      const D = 2 * (ax * by - ay * bx);
      if (Math.abs(D) >= 1e-6) {
        const ux = (by * (ax*ax + ay*ay) - ay * (bx*bx + by*by)) / D;
        const uy = (ax * (bx*bx + by*by) - bx * (ax*ax + ay*ay)) / D;
        const pcx = p1.x + ux, pcy = p1.y + uy;
        const pr  = Math.hypot(ux, uy);
        const pa1 = Math.atan2(p1.y - pcy, p1.x - pcx);
        const pa2 = Math.atan2(p2.y - pcy, p2.x - pcx);
        const pa3 = Math.atan2(p3.y - pcy, p3.x - pcx);
        // Draw the arc from p1 to p3 in the direction that passes through p2.
        const twoPi = 2 * Math.PI;
        const norm = x => ((x % twoPi) + twoPi) % twoPi;
        const ccw13 = norm(pa3 - pa1);
        const ccw12 = norm(pa2 - pa1);
        const ccw    = ccw12 < ccw13;  // CCW sweep passes through p2?
        ctx.beginPath();
        ctx.arc(pcx, pcy, pr, pa1, pa3, !ccw);
        ctx.strokeStyle = "rgba(191,90,242,0.6)";
        ctx.lineWidth = pw(1.5);
        ctx.setLineDash([pw(5), pw(4)]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      drawLine(last, cur, "rgba(251,146,60,0.5)", 1);
    }
  }

  // Constrained rubber-band for perp-dist and para-dist
  if ((state.tool === "perp-dist" || state.tool === "para-dist")
      && state.pendingPoints.length === 1 && state.pendingRefLine) {
    const b = projectConstrained(cur, state.pendingPoints[0], state.pendingRefLine,
                                 state.tool === "perp-dist", { imageWidth, imageHeight });
    drawLine(state.pendingPoints[0], b, "rgba(251,146,60,0.5)", 1);
  }

  // Area polygon preview
  if (state.tool === "area" && state.pendingPoints.length >= 1) {
    drawAreaPreview(state.pendingPoints, cur);
  }

  // Spline preview
  if (state.tool === "spline" && state.pendingPoints.length >= 1) {
    drawSplinePreview(state.pendingPoints, cur);
  }
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

  // Background/cursor check comes first: with forceShow set, the old ordering
  // could reach drawImage(null) below and throw out of the mousemove handler.
  if (!state.frozenBackground || !state.mousePos) {
    _loupeCanvas.hidden = true;
    return;
  }
  const show = forceShow || _LOUPE_TOOLS.has(state.tool);
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
