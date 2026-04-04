/**
 * render-annotations.js — Individual annotation draw functions and the main dispatcher.
 * Extracted from render.js (Task 7).
 */
import { state, _labelHitBoxes } from './state.js';
import { getLineEndpoints, lineAngleDeg } from './format.js';
import { viewport, imageWidth, imageHeight } from './viewport.js';
import { catmullRomControlPoints } from './math.js';
import {
  ctx, canvas, pw, drawLine, drawHandle, drawDiamondHandle, drawLabel,
  drawMeasurementLabel, _annColor, measurementLabel,
} from './render.js';

export function drawDistance(ann, sel) {
  drawLine(ann.a, ann.b, _annColor(ann, sel, "#facc15"), sel ? 2 : 1.5);
  if (sel) {
    (ann.a.snapped ? drawDiamondHandle : drawHandle)(ann.a, "#60a5fa");
    (ann.b.snapped ? drawDiamondHandle : drawHandle)(ann.b, "#60a5fa");
  }
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  drawMeasurementLabel(ann, measurementLabel(ann), mx + 5, my - 5, mx, my);
}

export function drawAngle(ann, sel) {
  const c = _annColor(ann, sel, "#a78bfa");
  drawLine(ann.p1, ann.vertex, c, sel ? 2 : 1.5);
  drawLine(ann.vertex, ann.p3, c, sel ? 2 : 1.5);
  if (sel) { [ann.p1, ann.vertex, ann.p3].forEach(p => (p.snapped ? drawDiamondHandle : drawHandle)(p, "#60a5fa")); }
  drawMeasurementLabel(ann, measurementLabel(ann), ann.vertex.x + 8, ann.vertex.y - 8, ann.vertex.x, ann.vertex.y);
}

export function drawCircle(ann, sel) {
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, 0, Math.PI * 2);
  const circColor = _annColor(ann, sel, "#34d399");
  ctx.strokeStyle = circColor;
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.stroke();
  if (sel) {
    drawHandle({ x: ann.cx, y: ann.cy }, "#60a5fa");
    drawHandle({ x: ann.cx + ann.r, y: ann.cy }, "#60a5fa");
  }
  drawMeasurementLabel(ann, measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5, ann.cx, ann.cy);
}

export function drawArcMeasure(ann, sel) {
  const a1 = Math.atan2(ann.p1.y - ann.cy, ann.p1.x - ann.cx);
  const a2 = Math.atan2(ann.p2.y - ann.cy, ann.p2.x - ann.cx);
  const a3 = Math.atan2(ann.p3.y - ann.cy, ann.p3.x - ann.cx);
  const twoPi = 2 * Math.PI;
  const norm2 = ((a2 - a1) % twoPi + twoPi) % twoPi;
  const norm3 = ((a3 - a1) % twoPi + twoPi) % twoPi;
  const ccw = !(norm2 < norm3);
  const arcColor = _annColor(ann, sel, "#bf5af2");
  ctx.save();
  ctx.strokeStyle = arcColor;
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, a1, a3, ccw);
  ctx.stroke();
  ctx.fillStyle = arcColor;
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, 3, 0, 2 * Math.PI);
  ctx.fill();
  if (sel) {
    drawHandle(ann.p1, "#60a5fa");
    drawHandle(ann.p2, "#60a5fa");
    drawHandle(ann.p3, "#60a5fa");
  }
  ctx.restore();
  drawMeasurementLabel(ann, measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5, ann.cx, ann.cy);
}

export function drawArcFit(ann, sel) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, 0, Math.PI * 2);
  const color = _annColor(ann, sel, "#34d399");
  ctx.strokeStyle = color;
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.setLineDash([pw(5), pw(3)]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  if (sel) {
    drawHandle({ x: ann.cx, y: ann.cy }, "#60a5fa");
    drawHandle({ x: ann.cx + ann.r, y: ann.cy }, "#60a5fa");
  }
  drawMeasurementLabel(ann, measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5, ann.cx, ann.cy);
}

export function drawSpline(ann, sel) {
  if (!ann.points || ann.points.length < 2) return;
  const pts = ann.points;
  const n = pts.length;
  const color = _annColor(ann, sel, "#06b6d4");

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < n - 1; i++) {
    const { cp1x, cp1y, cp2x, cp2y } = catmullRomControlPoints(pts, i);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pts[i + 1].x, pts[i + 1].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.stroke();
  if (sel) pts.forEach(p => drawHandle(p, "#60a5fa"));
  ctx.restore();

  const mid = pts[Math.floor((n - 1) / 2)];
  drawMeasurementLabel(ann, measurementLabel(ann), mid.x + 5, mid.y - 5, mid.x, mid.y);
}

export function drawSplinePreview(pts, cursor) {
  if (pts.length === 0) return;
  const allPts = [...pts, cursor];
  const n = allPts.length;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(allPts[0].x, allPts[0].y);
  for (let i = 0; i < n - 1; i++) {
    const { cp1x, cp1y, cp2x, cp2y } = catmullRomControlPoints(allPts, i);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, allPts[i + 1].x, allPts[i + 1].y);
  }
  ctx.strokeStyle = "rgba(6,182,212,0.45)";
  ctx.lineWidth = pw(1);
  ctx.setLineDash([pw(5), pw(4)]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawDetectedCircle(ann, sel) {
  const sx = imageWidth / ann.frameWidth;
  const sy = imageHeight / ann.frameHeight;
  const cx = ann.x * sx, cy = ann.y * sy, r = ann.radius * sx;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = sel ? "#60a5fa" : "#f472b6";
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.stroke();
  if (sel) drawHandle({ x: cx, y: cy }, "#60a5fa");
  drawLabel(measurementLabel(ann), cx + 5, cy - r - 5);
}

export function drawDetectedLine(ann, sel) {
  const sx = imageWidth / ann.frameWidth;
  const sy = imageHeight / ann.frameHeight;
  const x1 = ann.x1 * sx, y1 = ann.y1 * sy;
  const x2 = ann.x2 * sx, y2 = ann.y2 * sy;
  ctx.beginPath();
  ctx.strokeStyle = sel ? "#60a5fa" : "#fb923c";
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (sel) { drawHandle({ x: x1, y: y1 }, "#60a5fa"); drawHandle({ x: x2, y: y2 }, "#60a5fa"); }
  drawLabel(measurementLabel(ann), (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 4);
}

export function drawCalibration(ann, sel) {
  const color = sel ? "#60a5fa" : "#a78bfa";
  const tickLen = 6;
  if (ann.x1 !== undefined) {
    drawLine({ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }, color, sel ? 2 : 1.5);
    const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1) + Math.PI / 2;
    const tx = Math.cos(angle) * tickLen, ty = Math.sin(angle) * tickLen;
    drawLine({ x: ann.x1 - tx, y: ann.y1 - ty }, { x: ann.x1 + tx, y: ann.y1 + ty }, color, sel ? 2 : 1.5);
    drawLine({ x: ann.x2 - tx, y: ann.y2 - ty }, { x: ann.x2 + tx, y: ann.y2 + ty }, color, sel ? 2 : 1.5);
    if (sel) { drawHandle({ x: ann.x1, y: ann.y1 }, "#60a5fa"); drawHandle({ x: ann.x2, y: ann.y2 }, "#60a5fa"); }
    const mx = (ann.x1 + ann.x2) / 2, my = (ann.y1 + ann.y2) / 2;
    drawLabel(measurementLabel(ann), mx + 4, my - 8);
  } else {
    const x1 = ann.cx - ann.r, x2 = ann.cx + ann.r;
    drawLine({ x: x1, y: ann.cy }, { x: x2, y: ann.cy }, color, sel ? 2 : 1.5);
    drawLine({ x: x1, y: ann.cy - tickLen }, { x: x1, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
    drawLine({ x: x2, y: ann.cy - tickLen }, { x: x2, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
    if (sel) { drawHandle({ x: x1, y: ann.cy }, "#60a5fa"); drawHandle({ x: x2, y: ann.cy }, "#60a5fa"); }
    drawLabel(measurementLabel(ann), ann.cx + 4, ann.cy - ann.r - 8);
  }
}

export function drawPerpDist(ann, sel) {
  drawDistance(ann, sel);
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;
    const vx = -uy, vy = ux;
    const s = 6;
    ctx.beginPath();
    ctx.moveTo(ann.a.x + ux * s, ann.a.y + uy * s);
    ctx.lineTo(ann.a.x + ux * s + vx * s, ann.a.y + uy * s + vy * s);
    ctx.lineTo(ann.a.x + vx * s, ann.a.y + vy * s);
    ctx.strokeStyle = sel ? "#60a5fa" : "#a78bfa";
    ctx.lineWidth = pw(1);
    ctx.stroke();
  }
}

export function drawParaDist(ann, sel) {
  drawDistance(ann, sel);
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;
    const vx = -uy * 5, vy = ux * 5;
    [-2, 2].forEach(offset => {
      const cx = mx + ux * offset, cy = my + uy * offset;
      drawLine({ x: cx - vx, y: cy - vy }, { x: cx + vx, y: cy + vy },
               sel ? "#60a5fa" : "#a78bfa", 1.5);
    });
  }
}

export function drawParallelism(ann, sel) {
  ctx.save();
  ctx.setLineDash([pw(4), pw(4)]);
  drawLine(ann.a, ann.b, sel ? "#60a5fa" : "#facc15", sel ? 2 : 1.5);
  ctx.setLineDash([]);
  ctx.restore();
  if (sel) {
    (ann.a.snapped ? drawDiamondHandle : drawHandle)(ann.a, "#60a5fa");
    (ann.b.snapped ? drawDiamondHandle : drawHandle)(ann.b, "#60a5fa");
  }
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

export function drawPtCircleDist(ann, sel) {
  const circle = state.annotations.find(a => a.id === ann.circleId);
  if (!circle) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(ann.px, ann.py, pw(6), 0, Math.PI * 2);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = pw(1.5);
    ctx.setLineDash([pw(3), pw(3)]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  let cx, cy, r;
  if (circle.type === "circle") {
    cx = circle.cx; cy = circle.cy; r = circle.r;
  } else {
    const sx = canvas.width / circle.frameWidth;
    const sy = canvas.height / circle.frameHeight;
    cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
  }
  const dist = Math.hypot(ann.px - cx, ann.py - cy);
  if (dist < 1e-6) return;
  const edgePt = {
    x: cx + (ann.px - cx) / dist * r,
    y: cy + (ann.py - cy) / dist * r,
  };
  const color = sel ? "#60a5fa" : "#facc15";
  drawLine({ x: ann.px, y: ann.py }, edgePt, color, sel ? 2 : 1.5);
  if (sel) drawHandle({ x: ann.px, y: ann.py }, "#60a5fa");
  const mx = (ann.px + edgePt.x) / 2;
  const my = (ann.py + edgePt.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

export function drawIntersect(ann, sel) {
  const annA = state.annotations.find(a => a.id === ann.lineAId);
  const annB = state.annotations.find(a => a.id === ann.lineBId);
  if (!annA || !annB) return;

  const _fctx = { canvasWidth: canvas.width, canvasHeight: canvas.height, imageHeight };
  const epA = getLineEndpoints(annA, _fctx);
  const epB = getLineEndpoints(annB, _fctx);

  const dA = lineAngleDeg(annA, _fctx), dB = lineAngleDeg(annB, _fctx);
  let diff = Math.abs(dA - dB) % 180;
  if (diff > 90) diff = 180 - diff;
  if (diff < 1) return;

  const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
  const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
  const denom = dx_a * dy_b - dy_a * dx_b;
  if (Math.abs(denom) < 1e-10) return;

  const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
  const ix = epA.a.x + t * dx_a;
  const iy = epA.a.y + t * dy_a;

  const margin = Math.max(canvas.width, canvas.height);
  if (ix < -margin || ix > canvas.width + margin ||
      iy < -margin || iy > canvas.height + margin) return;

  const color = sel ? "#60a5fa" : "#f97316";
  const ARM = 8;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.moveTo(ix - ARM, iy); ctx.lineTo(ix + ARM, iy);
  ctx.moveTo(ix, iy - ARM); ctx.lineTo(ix, iy + ARM);
  ctx.stroke();
  drawLabel(measurementLabel(ann), ix + ARM + 3, iy - ARM);
}

export function drawSlotDist(ann, sel) {
  const annA = state.annotations.find(a => a.id === ann.lineAId);
  const annB = state.annotations.find(a => a.id === ann.lineBId);
  if (!annA || !annB) return;

  const _fctx = { canvasWidth: canvas.width, canvasHeight: canvas.height, imageHeight };
  const epA = getLineEndpoints(annA, _fctx);
  const epB = getLineEndpoints(annB, _fctx);

  const midA = {
    x: (epA.a.x + epA.b.x) / 2,
    y: (epA.a.y + epA.b.y) / 2,
  };

  const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
  const lenSqB = dx_b * dx_b + dy_b * dy_b;
  if (lenSqB < 1e-10) return;
  const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
  const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };

  const color = sel ? "#60a5fa" : "#a78bfa";
  drawLine(midA, projA, color, sel ? 2 : 1.5);

  const mx = (midA.x + projA.x) / 2;
  const my = (midA.y + projA.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

export function drawArea(ann, sel) {
  ctx.beginPath();
  ann.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = sel ? "rgba(96,165,250,0.12)" : "rgba(251,146,60,0.12)";
  ctx.fill();
  ctx.strokeStyle = sel ? "#60a5fa" : "rgba(251,146,60,0.7)";
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.stroke();
  if (sel) ann.points.forEach(p => drawHandle(p, "#60a5fa"));
  const cx = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length;
  const cy = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length;
  drawLabel(measurementLabel(ann), cx + 4, cy);
}

export function drawAreaPreview(pts, cursor) {
  if (pts.length === 0) return;
  const all = [...pts, cursor];
  ctx.beginPath();
  all.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = "rgba(251,146,60,0.08)";
  ctx.fill();
  ctx.strokeStyle = "rgba(251,146,60,0.4)";
  ctx.lineWidth = pw(1);
  ctx.stroke();
}

export function drawOrigin(ann, sel) {
  const color = sel ? "#60a5fa" : "#facc15";
  const angle = ann.angle ?? 0;
  const axisLen = 30;
  const xcos = Math.cos(angle), xsin = Math.sin(angle);
  const ycos = xsin, ysin = -xcos;

  const xTip = { x: ann.x + xcos * axisLen, y: ann.y + xsin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, xTip, color, 1.5);
  const ax = xcos * 6, ay = xsin * 6;
  const bx = -xsin * 3, by = xcos * 3;
  ctx.beginPath();
  ctx.moveTo(xTip.x, xTip.y);
  ctx.lineTo(xTip.x - ax + bx, xTip.y - ay + by);
  ctx.lineTo(xTip.x - ax - bx, xTip.y - ay - by);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  const yTip = { x: ann.x + ycos * axisLen, y: ann.y + ysin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, yTip, color, 1.5);
  const cx2 = ycos * 6, cy2 = ysin * 6;
  const dx2 = -ysin * 3, dy2 = ycos * 3;
  ctx.beginPath();
  ctx.moveTo(yTip.x, yTip.y);
  ctx.lineTo(yTip.x - cx2 + dx2, yTip.y - cy2 + dy2);
  ctx.lineTo(yTip.x - cx2 - dx2, yTip.y - cy2 - dy2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(ann.x, ann.y, pw(3), 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = pw(1);
  ctx.stroke();

  ctx.save();
  ctx.font = `bold ${pw(10)}px ui-monospace, monospace`;
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
  ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);
  ctx.restore();

  drawHandle(xTip, sel ? "#60a5fa" : "#facc15");
}

/**
 * Main annotation dispatcher. Iterates state.annotations and calls per-type draw functions.
 * @param {Function} redrawFn - Reference to the top-level redraw() for flash animation callbacks.
 * @param {Object} dxfFns - DXF draw functions: { drawDxfOverlay, drawDeviations, drawGuidedResults, drawEdgesOverlay, drawPreprocessedOverlay }
 */
export function drawAnnotations(redrawFn, dxfFns) {
  _labelHitBoxes.length = 0;
  const flashActive = Date.now() < state._flashExpiry;
  state.annotations.forEach(ann => {
    const sel = state.selected.has(ann.id);
    const pendingHighlight = state.pendingCenterCircle && ann.id === state.pendingCenterCircle.id;
    if (ann.type === "distance")        drawDistance(ann, sel);
    else if (ann.type === "center-dist") drawDistance(ann, sel);
    else if (ann.type === "perp-dist")   drawPerpDist(ann, sel);
    else if (ann.type === "para-dist")   drawParaDist(ann, sel);
    else if (ann.type === "parallelism") drawParallelism(ann, sel);
    else if (ann.type === "area")        drawArea(ann, sel);
    else if (ann.type === "origin")      drawOrigin(ann, sel);
    else if (ann.type === "angle")      drawAngle(ann, sel);
    else if (ann.type === "circle")     drawCircle(ann, pendingHighlight || sel);
    else if (ann.type === "edges-overlay")    dxfFns.drawEdgesOverlay(ann);
    else if (ann.type === "preprocessed-overlay") dxfFns.drawPreprocessedOverlay(ann);
    else if (ann.type === "dxf-overlay")      { dxfFns.drawDxfOverlay(ann); if (state.showDeviations) dxfFns.drawDeviations(ann); if (ann.guidedResults) dxfFns.drawGuidedResults(ann); }
    else if (ann.type === "detected-circle") drawDetectedCircle(ann, pendingHighlight || sel);
    else if (ann.type === "detected-line")   drawDetectedLine(ann, sel);
    else if (ann.type === "detected-line-merged") {
      ctx.save();
      const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
      const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
      const x1 = ann.x1 * sx, y1 = ann.y1 * sy, x2 = ann.x2 * sx, y2 = ann.y2 * sy;
      ctx.strokeStyle = sel ? "#60a5fa" : "#00e5ff";
      ctx.lineWidth = sel ? pw(2) : pw(1.5);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (sel) {
        drawHandle({ x: x1, y: y1 }, "#60a5fa");
        drawHandle({ x: x2, y: y2 }, "#60a5fa");
      }
      drawLabel(measurementLabel(ann), (x1 + x2) / 2 + 5, (y1 + y2) / 2 - 5);
      ctx.restore();
    }
    else if (ann.type === "detected-arc-partial") {
      ctx.save();
      const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
      const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
      ctx.strokeStyle = sel ? "#60a5fa" : "#ffd60a";
      ctx.lineWidth = sel ? pw(2) : pw(1.5);
      const a1 = ann.start_deg * Math.PI / 180;
      const a2 = ann.end_deg   * Math.PI / 180;
      ctx.beginPath();
      ctx.arc(ann.cx * sx, ann.cy * sy, ann.r * sx, a1, a2);
      ctx.stroke();
      if (sel) {
        const startRad = ann.start_deg * Math.PI / 180;
        const endRad = ann.end_deg * Math.PI / 180;
        drawHandle({ x: ann.cx * sx + ann.r * sx * Math.cos(startRad), y: ann.cy * sy + ann.r * sx * Math.sin(startRad) }, "#60a5fa");
        drawHandle({ x: ann.cx * sx + ann.r * sx * Math.cos(endRad), y: ann.cy * sy + ann.r * sx * Math.sin(endRad) }, "#60a5fa");
      }
      const midAngle = (a1 + a2) / 2;
      const labelR = ann.r * sx + 10;
      drawLabel(measurementLabel(ann), ann.cx * sx + labelR * Math.cos(midAngle), ann.cy * sy + labelR * Math.sin(midAngle));
      ctx.restore();
    }
    else if (ann.type === "calibration") drawCalibration(ann, sel);
    else if (ann.type === "pt-circle-dist") drawPtCircleDist(ann, sel);
    else if (ann.type === "intersect")      drawIntersect(ann, sel);
    else if (ann.type === "slot-dist")      drawSlotDist(ann, sel);
    else if (ann.type === "arc-measure")    drawArcMeasure(ann, sel);
    else if (ann.type === "arc-fit")        drawArcFit(ann, sel);
    else if (ann.type === "spline")         drawSpline(ann, sel);

    if (sel && flashActive) {
      let fx, fy;
      if (ann.a && ann.b) { fx = (ann.a.x + ann.b.x) / 2; fy = (ann.a.y + ann.b.y) / 2; }
      else if (ann.cx != null && ann.frameWidth) { fx = ann.cx * (imageWidth / ann.frameWidth); fy = ann.cy * (imageHeight / ann.frameHeight); }
      else if (ann.cx != null) { fx = ann.cx; fy = ann.cy; }
      else if (ann.vertex) { fx = ann.vertex.x; fy = ann.vertex.y; }
      else if (ann.x != null && ann.frameWidth) { fx = ann.x * (imageWidth / ann.frameWidth); fy = ann.y * (imageHeight / ann.frameHeight); }
      else if (ann.x != null) { fx = ann.x; fy = ann.y; }
      else if (ann.x1 != null && ann.frameWidth) { fx = (ann.x1 + ann.x2) / 2 * (imageWidth / ann.frameWidth); fy = (ann.y1 + ann.y2) / 2 * (imageHeight / ann.frameHeight); }
      else if (ann.x1 != null) { fx = (ann.x1 + ann.x2) / 2; fy = (ann.y1 + ann.y2) / 2; }
      if (fx != null) {
        ctx.save();
        ctx.strokeStyle = "rgba(96, 165, 250, 0.5)";
        ctx.lineWidth = pw(4);
        ctx.beginPath();
        ctx.arc(fx, fy, pw(20), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  });
  if (flashActive) {
    requestAnimationFrame(() => redrawFn());
  }

  if (state._selectRect) {
    const r = state._selectRect;
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = pw(1.5);
    ctx.setLineDash([pw(6), pw(3)]);
    ctx.fillStyle = "rgba(96, 165, 250, 0.15)";
    ctx.beginPath();
    ctx.rect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}
