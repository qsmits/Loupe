import { state, _deviationHitBoxes, _labelHitBoxes } from './state.js';
import { fitCircleAlgebraic, fitLine, polygonArea } from './math.js';
import { viewport, imageWidth, imageHeight, setImageSize } from './viewport.js';
import { measurementLabel as _measurementLabel, getLineEndpoints, lineAngleDeg } from './format.js';
export { getLineEndpoints, lineAngleDeg } from './format.js';
import { isCrossModeActive } from './cross-mode.js';

// ── Shared primitives (used by sub-modules via import from render.js) ────────

/** Pixel width compensated for zoom — keeps screen size constant */
export function pw(px) { return px / viewport.zoom; }

// ── DOM refs ──────────────────────────────────────────────────────────────────
export const img       = document.getElementById("stream-img");
export const canvas    = document.getElementById("overlay-canvas");
export const ctx       = canvas.getContext("2d");
export const statusEl  = document.getElementById("status-text");
export const listEl    = document.getElementById("measurement-list");

// NEW: replaces all inline statusEl.textContent = "..." patterns in other modules
export function showStatus(msg) {
  statusEl.textContent = msg;
}

export function getStatus() {
  return statusEl.textContent;
}

export function measurementLabel(ann) {
  return _measurementLabel(ann, {
    calibration: state.calibration,
    annotations: state.annotations,
    origin: state.origin,
    imageWidth,
    imageHeight,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
}

const GROUP_COLOR = "#38bdf8";  // sky blue for grouped measurements

export function _annColor(ann, sel, defaultColor) {
  if (sel) return "#60a5fa";
  if (state.measurementGroups[ann.id]) return GROUP_COLOR;
  return defaultColor;
}

export function drawLine(a, b, color, width) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = pw(width);
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

export function drawHandle(pt, color) {
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, pw(5), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = pw(1);
  ctx.stroke();
}

export function drawDiamondHandle(pt, color) {
  const s = pw(4);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = pw(1);
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - s);
  ctx.lineTo(pt.x + s, pt.y);
  ctx.lineTo(pt.x, pt.y + s);
  ctx.lineTo(pt.x - s, pt.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function drawLabel(text, x, y) {
  const fontSize = pw(12);
  ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  const m = ctx.measureText(text);
  ctx.fillRect(x - pw(2), y - pw(13), m.width + pw(4), pw(16));
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x, y);
}

/** Draw a measurement label with optional drag offset and leader line. Records hitbox. */
export function drawMeasurementLabel(ann, text, defaultX, defaultY, refX, refY) {
  if (ann.purpose && ann.purpose !== 'measurement') return; // suppress label for drawing/helper
  const offset = ann.labelOffset || { dx: 0, dy: 0 };
  const lx = defaultX + offset.dx;
  const ly = defaultY + offset.dy;

  // Leader line if offset
  if (offset.dx !== 0 || offset.dy !== 0) {
    ctx.save();
    ctx.strokeStyle = "rgba(150, 150, 150, 0.5)";
    ctx.lineWidth = pw(0.5);
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(refX ?? defaultX, refY ?? defaultY);
    ctx.stroke();
    ctx.restore();
  }

  drawLabel(text, lx, ly);

  // Record hitbox for dragging
  const fontSize = pw(12);
  ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
  const textW = ctx.measureText(text).width;
  _labelHitBoxes.push({
    annId: ann.id,
    handle: null,  // null = regular measurement (not guided result)
    x: lx - pw(2), y: ly - pw(13),
    w: textW + pw(4), h: pw(16),
    refX: refX ?? defaultX, refY: refY ?? defaultY,
  });
}

// ── Sub-module imports (after shared primitives are defined) ──────────────────

import { drawAnnotations } from './render-annotations.js';
import { drawDxfOverlay, dxfToCanvas, drawGuidedResults, drawDeviations,
         drawEdgesOverlay, drawPreprocessedOverlay, deviationColor } from './render-dxf.js';
import { drawGrid, drawMinimap, drawPendingPoints, drawCrosshair, drawLoupe } from './render-hud.js';
import { drawLensCalOverlay } from './lens-cal.js';
import { drawTiltCalOverlay } from './tilt-cal.js';

// Re-export sub-module functions for backward compatibility
export { drawAnnotations } from './render-annotations.js';
export { drawDxfOverlay, dxfToCanvas, drawGuidedResults, drawDeviations,
         drawEdgesOverlay, drawPreprocessedOverlay, deviationColor } from './render-dxf.js';
export { drawGrid, drawMinimap, drawPendingPoints, drawCrosshair, drawLoupe } from './render-hud.js';

// Re-export annotation draw functions that other modules import from render.js
export { drawDistance, drawAngle, drawCircle, drawArcMeasure,
         drawDetectedCircle, drawDetectedLine, drawCalibration,
         drawPerpDist, drawParaDist, drawParallelism,
         drawPtCircleDist, drawIntersect, drawSlotDist,
         drawArea, drawAreaPreview, drawOrigin,
         drawArcFit, drawSpline, drawSplinePreview } from './render-annotations.js';

// ── Canvas sizing ──────────────────────────────────────────────────────────────
export function resizeCanvas() {
  const streamEl = state.browserCamera?.active
    ? document.getElementById("browser-cam-video")
    : img;
  const r = streamEl.getBoundingClientRect();
  const vr = streamEl.parentElement.getBoundingClientRect();

  let displayW = r.width;
  let displayH = r.height;
  const iw = imageWidth || Math.round(r.width);
  const ih = imageHeight || Math.round(r.height);
  if (iw > 0 && ih > 0) {
    const imgAspect = iw / ih;
    const elemAspect = r.width / r.height;
    if (elemAspect > imgAspect) {
      displayW = r.height * imgAspect;
    } else {
      displayH = r.width / imgAspect;
    }
  }

  const offsetLeft = (r.width - displayW) / 2;
  const offsetTop = (r.height - displayH) / 2;
  canvas.style.left   = (r.left - vr.left + offsetLeft) + "px";
  canvas.style.top    = (r.top  - vr.top + offsetTop) + "px";
  canvas.style.width  = displayW  + "px";
  canvas.style.height = displayH + "px";

  canvas.width  = Math.round(displayW);
  canvas.height = Math.round(displayH);
  if (!imageWidth) setImageSize(canvas.width, canvas.height);
  redraw();
}

// DXF draw function references for the annotation dispatcher
const _dxfFns = {
  drawDxfOverlay,
  drawDeviations,
  drawGuidedResults,
  drawEdgesOverlay,
  drawPreprocessedOverlay,
};

function drawGearPickOverlay() {
  if (!state.gearPickMode) return;
  ctx.save();
  for (const a of state.annotations) {
    if (a.type !== "circle" && a.type !== "arc-fit") continue;
    const isHover = state.gearPickHover === a.id;
    const isPickedTip = state.gearPickBuffer && state.gearPickBuffer.tipCircle === a;
    // Tip already picked: draw confirmed-green. Hover: bright yellow. Otherwise: dim yellow halo.
    let color, width;
    if (isPickedTip) { color = "#34d399"; width = pw(2.5); }
    else if (isHover) { color = "#fde047"; width = pw(3); }
    else { color = "rgba(250, 204, 21, 0.45)"; width = pw(1.5); }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(a.cx, a.cy, a.r, 0, Math.PI * 2);
    ctx.stroke();
    if (isHover || isPickedTip) {
      // Glow ring (slightly larger, low alpha) for emphasis.
      ctx.strokeStyle = isPickedTip ? "rgba(52, 211, 153, 0.25)" : "rgba(253, 224, 71, 0.35)";
      ctx.lineWidth = pw(6);
      ctx.beginPath();
      ctx.arc(a.cx, a.cy, a.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawGearAnalysis() {
  const ga = state.gearAnalysis;
  if (!ga || !ga.teeth || ga.teeth.length === 0) return;
  const cx = ga.cx;
  const cy = ga.cy;
  const r = ga.pcd_radius_px;

  ctx.save();

  // PCD circle (dashed cyan)
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = pw(1);
  ctx.setLineDash([pw(4), pw(4)]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Per-tooth L→R arcs on the PCD (solid yellow)
  ctx.strokeStyle = "#ffeb3b";
  ctx.lineWidth = pw(3);
  for (const t of ga.teeth) {
    const lRad = (t.l_angle_deg * Math.PI) / 180;
    const rRad = (t.r_angle_deg * Math.PI) / 180;
    let startA = lRad;
    let endA = rRad;
    if (endA < startA) endA += Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, endA, false);
    ctx.stroke();
  }

  // Tooth index labels at center angle, outside the PCD
  ctx.fillStyle = "#ffeb3b";
  ctx.font = `${pw(12)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const labelR = r * 1.12;
  for (const t of ga.teeth) {
    const cRad = (t.center_angle_deg * Math.PI) / 180;
    const lx = cx + labelR * Math.cos(cRad);
    const ly = cy + labelR * Math.sin(cRad);
    ctx.fillText(`T${t.index}`, lx, ly);
  }

  ctx.restore();
}

/** Mask preview overlay for cross-mode mask editing.
 *  Dims areas that would be excluded by the current mask annotations. */
function drawMaskPreviewOverlay() {
  const iw = imageWidth || canvas.width;
  const ih = imageHeight || canvas.height;

  const punches = [];
  const dies = [];
  for (const ann of state.annotations) {
    if (ann.type !== 'area' || !ann.points || ann.points.length < 3) continue;
    if (ann.mode === 'die') {
      dies.push(ann.points);
    } else {
      punches.push(ann.points);
    }
  }

  if (punches.length === 0 && dies.length === 0) return;

  ctx.save();
  ctx.globalAlpha = 0.4;

  if (punches.length > 0) {
    // Darken everything, cut out punch regions, re-darken die regions
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, iw, ih);

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#fff';
    for (const pts of punches) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    }

    if (dies.length > 0) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000';
      for (const pts of dies) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }
  } else {
    // No punch regions, only die: darken just the die regions
    ctx.fillStyle = '#000';
    for (const pts of dies) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

export function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ── Viewport transform (all image-space drawing goes inside) ──
  ctx.save();
  ctx.scale(viewport.zoom, viewport.zoom);
  ctx.translate(-viewport.panX, -viewport.panY);

  // Frozen background at native image size (NOT canvas size)
  if (state.frozenBackground) {
    ctx.drawImage(state.frozenBackground, 0, 0, imageWidth || canvas.width, imageHeight || canvas.height);
  }
  if (state.showGradientOverlay && state._gradientOverlayImg) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.drawImage(state._gradientOverlayImg, 0, 0, imageWidth || canvas.width, imageHeight || canvas.height);
    ctx.restore();
  }
  drawGrid();
  drawAnnotations(redraw, _dxfFns);
  // Cross-mode mask preview overlay: dim excluded areas during mask editing
  if (isCrossModeActive()) {
    drawMaskPreviewOverlay();
  }
  drawPendingPoints();
  // Snap indicator (annotation snap — blue circle)
  if (state.snapTarget && state.tool !== "select") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(state.snapTarget.x, state.snapTarget.y, pw(6), 0, Math.PI * 2);
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = pw(1.5);
    ctx.stroke();
    ctx.restore();
  }
  // Sub-pixel edge snap preview (orange crosshair)
  if (state._subpixelSnapTarget) {
    const sp = state._subpixelSnapTarget;
    const s = pw(6);
    ctx.save();
    ctx.strokeStyle = "#fb923c";
    ctx.lineWidth = pw(1.5);
    ctx.beginPath();
    ctx.moveTo(sp.x - s, sp.y); ctx.lineTo(sp.x + s, sp.y);
    ctx.moveTo(sp.x, sp.y - s); ctx.lineTo(sp.x, sp.y + s);
    ctx.stroke();
    // Small dot at center
    ctx.fillStyle = "#fb923c";
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, pw(1.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Fit-line preview: show best-fit line while collecting points
  if (state.tool === "fit-line" && state.pendingPoints.length >= 2) {
    const fit = fitLine(state.pendingPoints);
    if (fit) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(fit.x1, fit.y1);
      ctx.lineTo(fit.x2, fit.y2);
      ctx.strokeStyle = "rgba(245,158,11,0.6)";
      ctx.lineWidth = pw(1.5);
      ctx.setLineDash([pw(5), pw(4)]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
  // Arc-fit preview: show current best-fit circle while collecting points
  if (state.tool === "arc-fit" && state.pendingPoints.length >= 3) {
    const fit = fitCircleAlgebraic(state.pendingPoints);
    if (fit) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(fit.cx, fit.cy, fit.r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(251,146,60,0.6)";
      ctx.lineWidth = pw(1.5);
      ctx.setLineDash([pw(5), pw(4)]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
  // DXF alignment mode indicators
  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      if (state.dxfAlignHover) {
        const p = state.dxfAlignHover.canvas;
        ctx.save();
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = pw(1.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, pw(6), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (state.dxfAlignStep === 1 && state.dxfAlignPick) {
        const p = state.dxfAlignPick.canvas;
        ctx.save();
        ctx.fillStyle = "#facc15";
        ctx.beginPath();
        ctx.arc(p.x, p.y, pw(4), 0, Math.PI * 2);
        ctx.fill();
        if (state.mousePos) {
          ctx.strokeStyle = "rgba(250,204,21,0.6)";
          ctx.lineWidth = pw(1);
          ctx.setLineDash([pw(4), pw(4)]);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(state.mousePos.x, state.mousePos.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }
    }
  }

  // Lens calibration overlay (blue sample lines + preview)
  drawLensCalOverlay();
  // Perspective correction overlay (corner markers)
  drawTiltCalOverlay();

  // Point-pick mode rendering
  if (state.inspectionPickTarget) {
    // Orange dots for placed points
    ctx.save();
    ctx.fillStyle = "#fb923c";
    for (const p of state.inspectionPickPoints) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, pw(4), 0, Math.PI * 2);
      ctx.fill();
    }
    // Live fit preview (dashed green) — supports multiple fits for compound features
    if (state.inspectionPickFit && state.inspectionPickFit.fits) {
      ctx.strokeStyle = "rgba(50, 215, 75, 0.7)";
      ctx.lineWidth = pw(1.5);
      ctx.setLineDash([pw(4), pw(4)]);
      for (const f of state.inspectionPickFit.fits) {
        if (!f) continue;
        if (f.x1 != null) {
          ctx.beginPath();
          ctx.moveTo(f.x1, f.y1);
          ctx.lineTo(f.x2, f.y2);
          ctx.stroke();
        } else if (f.cx != null) {
          ctx.beginPath();
          ctx.arc(f.cx, f.cy, f.r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Gear pick mode overlay: highlight circle annotations the user can click.
  drawGearPickOverlay();

  // Gear analysis overlay (PCD + per-tooth L→R arcs + labels)
  drawGearAnalysis();

  ctx.restore();
  // ── End viewport transform ──

  // ── HUD (screen-space, not affected by zoom/pan) ──
  drawCrosshair();

  // Zoom indicator badge
  const badge = document.getElementById("zoom-badge");
  if (badge) {
    if (viewport.zoom !== 1.0 || viewport.panX !== 0 || viewport.panY !== 0) {
      badge.textContent = viewport.zoom >= 1
        ? `${viewport.zoom.toFixed(1)}x`
        : `${(viewport.zoom * 100).toFixed(0)}%`;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // Minimap overlay (bottom-left corner, only when zoomed in)
  drawMinimap();
}
