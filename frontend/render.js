import { state, _deviationHitBoxes } from './state.js';
import { fitCircleAlgebraic, polygonArea } from './math.js';
import { viewport, imageWidth, imageHeight, setImageSize } from './viewport.js';

/** Pixel width compensated for zoom — keeps screen size constant */
function pw(px) { return px / viewport.zoom; }

// ── DOM refs ──────────────────────────────────────────────────────────────────
export const img       = document.getElementById("stream-img");
export const canvas    = document.getElementById("overlay-canvas");
export const ctx       = canvas.getContext("2d");
export const statusEl  = document.getElementById("status-text");
export const listEl    = document.getElementById("measurement-list");
export const cameraInfoEl = document.getElementById("camera-info");

// NEW: replaces all inline statusEl.textContent = "..." patterns in other modules
export function showStatus(msg) {
  statusEl.textContent = msg;
}

export function getStatus() {
  return statusEl.textContent;
}

// ── Canvas sizing ──────────────────────────────────────────────────────────────
export function resizeCanvas() {
  const r = img.getBoundingClientRect();
  const vr = img.parentElement.getBoundingClientRect();
  canvas.style.left   = (r.left - vr.left) + "px";
  canvas.style.top    = (r.top  - vr.top)  + "px";
  canvas.style.width  = r.width  + "px";
  canvas.style.height = r.height + "px";
  // Internal resolution scales with zoom (capped at image resolution)
  const iw = imageWidth || Math.round(r.width);
  const ih = imageHeight || Math.round(r.height);
  canvas.width  = Math.min(iw, Math.round(r.width * viewport.zoom));
  canvas.height = Math.min(ih, Math.round(r.height * viewport.zoom));
  if (!imageWidth) setImageSize(canvas.width, canvas.height);
  redraw();
}

export function measurementLabel(ann) {
  const cal = state.calibration;
  if (ann.type === "distance") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "center-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "angle") {
    const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
    const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
    const dot = v1.x*v2.x + v1.y*v2.y;
    const mag = Math.hypot(v1.x,v1.y) * Math.hypot(v2.x,v2.y);
    const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1,Math.min(1,dot/mag))) * 180/Math.PI;
    return `${deg.toFixed(2)}°`;
  }
  if (ann.type === "circle") {
    if (!cal) return `⌀ ${(ann.r * 2).toFixed(1)} px`;
    const mm = (ann.r * 2) / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⌀ ${(mm * 1000).toFixed(2)} µm`
      : `⌀ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-circle") {
    const sx = imageWidth / ann.frameWidth;
    const r = ann.radius * sx;
    if (!cal) return `⌀ ${(r * 2).toFixed(1)} px`;
    const mm = (r * 2) / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⌀ ${(mm * 1000).toFixed(2)} µm`
      : `⌀ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-line") {
    const sx = imageWidth / ann.frameWidth;
    const lenPx = ann.length * sx;
    if (!cal) return `${lenPx.toFixed(1)} px`;
    const mm = lenPx / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-line-merged") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const lenPx = Math.hypot((ann.x2 - ann.x1) * sx, (ann.y2 - ann.y1) * sx);
    if (!cal) return `${lenPx.toFixed(1)} px`;
    const mm = lenPx / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-arc-partial") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const rPx = ann.r * sx;
    const spanDeg = ann.end_deg >= ann.start_deg
      ? ann.end_deg - ann.start_deg
      : 360 - (ann.start_deg - ann.end_deg);
    if (!cal) return `r ${rPx.toFixed(1)} px  ${spanDeg.toFixed(0)}°`;
    const mm = rPx / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `r ${(mm * 1000).toFixed(2)} µm  ${spanDeg.toFixed(0)}°`
      : `r ${mm.toFixed(3)} mm  ${spanDeg.toFixed(0)}°`;
  }
  if (ann.type === "calibration") {
    const prefix = ann.x1 !== undefined ? "⟷" : "⌀";
    return `${prefix} ${ann.knownValue} ${ann.unit}`;
  }
  if (ann.type === "perp-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `⊥ ${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm" ? `⊥ ${(mm * 1000).toFixed(2)} µm`
                                    : `⊥ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "para-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `∥ ${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm" ? `∥ ${(mm * 1000).toFixed(2)} µm`
                                    : `∥ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "parallelism") {
    return `∥ ${ann.angleDeg.toFixed(2)}°`;
  }
  if (ann.type === "area") {
    const px2 = polygonArea(ann.points);
    if (!cal) return `□ ${px2.toFixed(1)} px²`;
    const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
    return cal.displayUnit === "µm"
      ? `□ ${(mm2 * 1e6).toFixed(2)} µm²`
      : `□ ${mm2.toFixed(4)} mm²`;
  }
  if (ann.type === "origin") return "";
  if (ann.type === "pt-circle-dist") {
    const circle = state.annotations.find(a => a.id === ann.circleId);
    if (!circle) return "⊙ ref deleted";
    let cx, cy, r;
    if (circle.type === "circle") {
      cx = circle.cx; cy = circle.cy; r = circle.r;
    } else {
      const sx = canvas.width / circle.frameWidth;
      const sy = canvas.height / circle.frameHeight;
      cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
    }
    const dist = Math.hypot(ann.px - cx, ann.py - cy);
    const gapPx = dist - r;
    const cal = state.calibration;
    if (!cal) return `⊙ ${gapPx.toFixed(1)} px`;
    const mm = gapPx / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⊙ ${(mm * 1000).toFixed(2)} µm`
      : `⊙ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "intersect") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "⊕ ref deleted";
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let diff = Math.abs(dA - dB) % 180;
    if (diff > 90) diff = 180 - diff;
    if (diff < 1) return "∥ no intersection";
    const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const denom = dx_a * dy_b - dy_a * dx_b;
    if (Math.abs(denom) < 1e-10) return "∥ no intersection";
    const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
    const ix = epA.a.x + t * dx_a;
    const iy = epA.a.y + t * dy_a;
    const margin = Math.max(canvas.width, canvas.height);
    const offScreen = ix < -margin || ix > canvas.width + margin ||
                      iy < -margin || iy > canvas.height + margin;
    const cal = state.calibration;
    const org = state.origin;
    if (org) {
      const cosA = Math.cos(-(org.angle ?? 0)), sinA = Math.sin(-(org.angle ?? 0));
      const rx = ix - org.x, ry = iy - org.y;
      const ux = rx * cosA - ry * sinA;
      const uy = rx * sinA + ry * cosA;
      if (cal) {
        const xVal = ux / cal.pixelsPerMm;
        const yVal = uy / cal.pixelsPerMm;
        const unit = cal.displayUnit === "µm" ? "µm" : "mm";
        const scale = cal.displayUnit === "µm" ? 1000 : 1;
        const xStr = (xVal * scale).toFixed(cal.displayUnit === "µm" ? 2 : 3);
        const yStr = (yVal * scale).toFixed(cal.displayUnit === "µm" ? 2 : 3);
        return offScreen
          ? `⊕ off-screen  X: ${xStr} ${unit}  Y: ${yStr} ${unit}`
          : `⊕ X: ${xStr} ${unit}  Y: ${yStr} ${unit}`;
      }
      return offScreen
        ? `⊕ off-screen  X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`
        : `⊕ X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`;
    }
    return offScreen
      ? `⊕ off-screen  (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`
      : `⊕ (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`;
  }
  if (ann.type === "slot-dist") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "⟺ ref deleted";
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const midA = {
      x: (epA.a.x + epA.b.x) / 2,
      y: (epA.a.y + epA.b.y) / 2,
    };
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const lenSqB = dx_b * dx_b + dy_b * dy_b;
    if (lenSqB < 1e-10) return "⟺ 0 px";
    const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
    const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };
    const gapPx = Math.hypot(midA.x - projA.x, midA.y - projA.y);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let angleDiff = Math.abs(dA - dB) % 180;
    if (angleDiff > 90) angleDiff = 180 - angleDiff;
    const angSuffix = angleDiff > 2 ? ` (±${angleDiff.toFixed(1)}°)` : "";
    const cal = state.calibration;
    if (!cal) return `⟺ ${gapPx.toFixed(1)} px${angSuffix}`;
    const mm = gapPx / cal.pixelsPerMm;
    const valStr = cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
    return `⟺ ${valStr}${angSuffix}`;
  }
  return "";
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
  drawAnnotations();
  drawPendingPoints();
  // Snap indicator
  if (state.snapTarget && state.tool !== "select") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(state.snapTarget.x, state.snapTarget.y, pw(6), 0, Math.PI * 2);
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = pw(1.5);
    ctx.stroke();
    ctx.restore();
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
    // Live fit preview (dashed green)
    if (state.inspectionPickFit) {
      ctx.strokeStyle = "rgba(50, 215, 75, 0.7)";
      ctx.lineWidth = pw(1.5);
      ctx.setLineDash([pw(4), pw(4)]);
      const f = state.inspectionPickFit;
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
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

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
}

export function drawAnnotations() {
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
    else if (ann.type === "edges-overlay")    drawEdgesOverlay(ann);
    else if (ann.type === "preprocessed-overlay") drawPreprocessedOverlay(ann);
    else if (ann.type === "dxf-overlay")      { drawDxfOverlay(ann); if (state.showDeviations) drawDeviations(ann); if (ann.guidedResults) drawGuidedResults(ann); }
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
    requestAnimationFrame(() => redraw());
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

export function drawArcMeasure(ann, sel) {
  const a1 = Math.atan2(ann.p1.y - ann.cy, ann.p1.x - ann.cx);
  const a2 = Math.atan2(ann.p2.y - ann.cy, ann.p2.x - ann.cx);
  const a3 = Math.atan2(ann.p3.y - ann.cy, ann.p3.x - ann.cx);
  // Determine winding: check if p2 is on the CW arc from p1→p3.
  // Normalize angles to [0, 2π) relative to a1.
  const twoPi = 2 * Math.PI;
  const norm2 = ((a2 - a1) % twoPi + twoPi) % twoPi;
  const norm3 = ((a3 - a1) % twoPi + twoPi) % twoPi;
  // If p2's angle (relative to p1) is between 0 and p3's angle, then CW arc
  // from a1→a3 passes through p2. Otherwise we need CCW.
  const ccw = !(norm2 < norm3);
  ctx.save();
  ctx.strokeStyle = sel ? "#60a5fa" : "#bf5af2";  // lighter blue when selected
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, a1, a3, ccw);
  ctx.stroke();
  // Draw center marker
  ctx.fillStyle = sel ? "#60a5fa" : "#bf5af2";
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, 3, 0, 2 * Math.PI);
  ctx.fill();
  if (sel) {
    drawHandle(ann.p1, "#60a5fa");
    drawHandle(ann.p2, "#60a5fa");
    drawHandle(ann.p3, "#60a5fa");
  }
  ctx.restore();
  drawLabel(measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5);
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

export function drawGuidedResults(ann) {
  const results = ann.guidedResults;
  if (!results || results.length === 0) return;

  for (const r of results) {
    if (r.matched && r.fit) {
      const color = r.pass_fail === "fail" ? "#ff453a"
        : r.pass_fail === "warn" ? "#ff9f0a"
        : "#32d74b";

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = pw(2);

      if (r.fit.type === "line") {
        ctx.beginPath();
        ctx.moveTo(r.fit.x1, r.fit.y1);
        ctx.lineTo(r.fit.x2, r.fit.y2);
        ctx.stroke();
        const mx = (r.fit.x1 + r.fit.x2) / 2;
        const my = (r.fit.y1 + r.fit.y2) / 2;
        drawLabel(`\u22a5 ${r.perp_dev_mm?.toFixed(3)} mm`, mx + pw(5), my - pw(5));
      } else {
        ctx.beginPath();
        ctx.arc(r.fit.cx, r.fit.cy, r.fit.r, 0, Math.PI * 2);
        ctx.stroke();
        drawLabel(`\u0394c ${(r.center_dev_mm ?? 0).toFixed(3)} \u0394r ${(r.radius_dev_mm ?? 0).toFixed(3)}`,
          r.fit.cx + r.fit.r + pw(5), r.fit.cy);
      }
      ctx.restore();

      // Edge points (subtle dots)
      if (r.edge_points_sample && r.edge_points_sample.length > 0) {
        ctx.save();
        ctx.fillStyle = "rgba(150, 150, 150, 0.5)";
        for (const [x, y] of r.edge_points_sample) {
          ctx.beginPath();
          ctx.arc(x, y, pw(1.5), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }
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

export function drawDistance(ann, sel) {
  drawLine(ann.a, ann.b, sel ? "#60a5fa" : "#facc15", sel ? 2 : 1.5);
  if (sel) { drawHandle(ann.a, "#60a5fa"); drawHandle(ann.b, "#60a5fa"); }
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

export function drawAngle(ann, sel) {
  drawLine(ann.p1, ann.vertex, sel ? "#60a5fa" : "#a78bfa", sel ? 2 : 1.5);
  drawLine(ann.vertex, ann.p3, sel ? "#60a5fa" : "#a78bfa", sel ? 2 : 1.5);
  if (sel) { [ann.p1, ann.vertex, ann.p3].forEach(p => drawHandle(p, "#60a5fa")); }
  drawLabel(measurementLabel(ann), ann.vertex.x + 8, ann.vertex.y - 8);
}

export function drawCircle(ann, sel) {
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, 0, Math.PI * 2);
  ctx.strokeStyle = sel ? "#60a5fa" : "#34d399";
  ctx.lineWidth = sel ? pw(2) : pw(1.5);
  ctx.stroke();
  if (sel) {
    drawHandle({ x: ann.cx, y: ann.cy }, "#60a5fa");
    drawHandle({ x: ann.cx + ann.r, y: ann.cy }, "#60a5fa");
  }
  drawLabel(measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5);
}

export function drawEdgesOverlay(ann) {
  ctx.globalAlpha = 0.7;
  ctx.drawImage(ann.image, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1.0;
}

export function drawPreprocessedOverlay(ann) {
  ctx.globalAlpha = 0.75;
  ctx.drawImage(ann.image, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1.0;
}

export function drawDxfOverlay(ann) {
  const { entities, offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  const originAngle = state.origin?.angle ?? 0;

  ctx.save();
  ctx.strokeStyle = "#00d4ff";
  ctx.setLineDash([6 / (scale * viewport.zoom), 3 / (scale * viewport.zoom)]);

  // Build transform — ctx calls are applied to coordinates in REVERSE call order.
  // Desired coordinate pipeline: rotate(annAngle in DXF Y-up) → flip → scale+Y-invert → rotate(originAngle) → translate
  // Since scale(s,-s) inverts Y, ctx.rotate(-annAngle) in that space equals rotate(+annAngle) in Y-up space.
  ctx.translate(offsetX, offsetY);
  if (originAngle) ctx.rotate(originAngle);
  ctx.scale(scale, -scale);   // DXF Y-up → canvas Y-down
  if (flipH) ctx.scale(-1, 1);
  if (flipV) ctx.scale(1, -1);
  if (annAngle) ctx.rotate(-annAngle * Math.PI / 180);  // rotate in DXF Y-up space
  ctx.lineWidth = 1 / (scale * viewport.zoom);  // compensate for DXF scale and viewport zoom

  for (const en of entities) {
    ctx.beginPath();
    if (en.type === "line") {
      ctx.moveTo(en.x1, en.y1);
      ctx.lineTo(en.x2, en.y2);
    } else if (en.type === "circle") {
      ctx.arc(en.cx, en.cy, en.radius, 0, Math.PI * 2);
    } else if (en.type === "arc") {
      const sr = en.start_angle * Math.PI / 180;
      const er = en.end_angle * Math.PI / 180;
      // DXF arcs are CCW. The base transform (scale(s,-s)) is LEFT-handed,
      // so anticlockwise=false renders CCW visually — correct for DXF.
      // Each additional reflection (flipH XOR flipV) flips handedness,
      // inverting winding. Compensate when exactly one flip is active.
      ctx.arc(en.cx, en.cy, en.radius, sr, er, flipH !== flipV);
    } else if (en.type === "polyline") {
      if (en.points.length < 2) continue;
      ctx.moveTo(en.points[0].x, en.points[0].y);
      for (let i = 1; i < en.points.length; i++) {
        ctx.lineTo(en.points[i].x, en.points[i].y);
      }
      if (en.closed) ctx.closePath();
    } else if (en.type === "polyline_line") {
      ctx.moveTo(en.x1, en.y1);
      ctx.lineTo(en.x2, en.y2);
    } else if (en.type === "polyline_arc") {
      const sr = en.start_angle * Math.PI / 180;
      const er = en.end_angle * Math.PI / 180;
      ctx.arc(en.cx, en.cy, en.radius, sr, er, flipH !== flipV);
    }
    ctx.stroke();
  }

  ctx.restore();
}

export function dxfToCanvas(x, y, ann) {
  const { offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  const originAngle = state.origin?.angle ?? 0;

  // 1. Flip in DXF space (before rotation)
  const xf = flipH ? -x : x;
  const yf = flipV ? -y : y;

  // 2. Apply DXF overlay rotation in DXF space (Y-up)
  const cosA = Math.cos(annAngle * Math.PI / 180);
  const sinA = Math.sin(annAngle * Math.PI / 180);
  const xr = xf * cosA - yf * sinA;
  const yr = xf * sinA + yf * cosA;

  // 3. Scale + Y-flip (DXF Y-up → canvas Y-down)
  let cx = xr * scale;
  let cy = -yr * scale;

  // 4. Apply canvas/origin rotation (existing behaviour)
  if (originAngle) {
    const cos2 = Math.cos(originAngle), sin2 = Math.sin(originAngle);
    [cx, cy] = [cx * cos2 - cy * sin2, cx * sin2 + cy * cos2];
  }

  return { x: offsetX + cx, y: offsetY + cy };
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
    // Two-point: line with tick marks at each end
    drawLine({ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }, color, sel ? 2 : 1.5);
    // Tick marks perpendicular to the line
    const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1) + Math.PI / 2;
    const tx = Math.cos(angle) * tickLen, ty = Math.sin(angle) * tickLen;
    drawLine({ x: ann.x1 - tx, y: ann.y1 - ty }, { x: ann.x1 + tx, y: ann.y1 + ty }, color, sel ? 2 : 1.5);
    drawLine({ x: ann.x2 - tx, y: ann.y2 - ty }, { x: ann.x2 + tx, y: ann.y2 + ty }, color, sel ? 2 : 1.5);
    if (sel) { drawHandle({ x: ann.x1, y: ann.y1 }, "#60a5fa"); drawHandle({ x: ann.x2, y: ann.y2 }, "#60a5fa"); }
    const mx = (ann.x1 + ann.x2) / 2, my = (ann.y1 + ann.y2) / 2;
    drawLabel(measurementLabel(ann), mx + 4, my - 8);
  } else {
    // Circle: horizontal diameter line through center
    const x1 = ann.cx - ann.r, x2 = ann.cx + ann.r;
    drawLine({ x: x1, y: ann.cy }, { x: x2, y: ann.cy }, color, sel ? 2 : 1.5);
    // Tick marks at each end
    drawLine({ x: x1, y: ann.cy - tickLen }, { x: x1, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
    drawLine({ x: x2, y: ann.cy - tickLen }, { x: x2, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
    if (sel) { drawHandle({ x: x1, y: ann.cy }, "#60a5fa"); drawHandle({ x: x2, y: ann.cy }, "#60a5fa"); }
    drawLabel(measurementLabel(ann), ann.cx + 4, ann.cy - ann.r - 8);
  }
}

export function drawPerpDist(ann, sel) {
  drawDistance(ann, sel);
  // Right-angle indicator at ann.a, oriented along the perp-dist line direction
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;   // unit along line
    const vx = -uy, vy = ux;              // perpendicular to line
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
  // Two parallel tick marks centered on the line body (4px apart)
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;
    const vx = -uy * 5, vy = ux * 5; // perpendicular, 5px half-length
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
  if (sel) { drawHandle(ann.a, "#60a5fa"); drawHandle(ann.b, "#60a5fa"); }
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

  const epA = getLineEndpoints(annA);
  const epB = getLineEndpoints(annB);

  const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
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

  const epA = getLineEndpoints(annA);
  const epB = getLineEndpoints(annB);

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
  // X-axis direction
  const xcos = Math.cos(angle), xsin = Math.sin(angle);
  // Y-axis direction: 90° CCW as seen on screen (canvas Y is down, so use (sin θ, -cos θ))
  const ycos = xsin, ysin = -xcos;

  // X axis arrow
  const xTip = { x: ann.x + xcos * axisLen, y: ann.y + xsin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, xTip, color, 1.5);
  // Arrowhead on X
  const ax = xcos * 6, ay = xsin * 6;
  const bx = -xsin * 3, by = xcos * 3;
  ctx.beginPath();
  ctx.moveTo(xTip.x, xTip.y);
  ctx.lineTo(xTip.x - ax + bx, xTip.y - ay + by);
  ctx.lineTo(xTip.x - ax - bx, xTip.y - ay - by);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Y axis arrow
  const yTip = { x: ann.x + ycos * axisLen, y: ann.y + ysin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, yTip, color, 1.5);
  // Arrowhead on Y
  const cx2 = ycos * 6, cy2 = ysin * 6;
  const dx2 = -ysin * 3, dy2 = ycos * 3;
  ctx.beginPath();
  ctx.moveTo(yTip.x, yTip.y);
  ctx.lineTo(yTip.x - cx2 + dx2, yTip.y - cy2 + dy2);
  ctx.lineTo(yTip.x - cx2 - dx2, yTip.y - cy2 - dy2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Small circle at origin
  ctx.beginPath();
  ctx.arc(ann.x, ann.y, pw(3), 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = pw(1);
  ctx.stroke();

  // Axis labels — wrapped in save/restore to prevent ctx.font and ctx.fillStyle leaking
  ctx.save();
  ctx.font = `bold ${pw(10)}px ui-monospace, monospace`;
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
  ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);
  ctx.restore();

  // Axis handle dot (drag target for rotation) — outside save/restore intentionally
  drawHandle(xTip, sel ? "#60a5fa" : "#facc15");
}

export function drawPendingPoints() {
  state.pendingPoints.forEach(pt => drawHandle(pt, "#fb923c"));
}

export function drawCrosshair() {
  if (!state.crosshair) return;
  const { crosshairOpacity } = state.settings;
  const rawColor = state.settings.crosshairColor;
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : "#ffffff";
  const r = parseInt(safeColor.slice(1, 3), 16);
  const g = parseInt(safeColor.slice(3, 5), 16);
  const b = parseInt(safeColor.slice(5, 7), 16);
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.strokeStyle = `rgba(${r},${g},${b},${crosshairOpacity})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, canvas.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
  ctx.setLineDash([]);
}

export function getLineEndpoints(ann) {
  if (ann.type === "distance" || ann.type === "perp-dist" ||
      ann.type === "para-dist" || ann.type === "parallelism") {
    return { a: ann.a, b: ann.b };
  }
  if (ann.type === "calibration" && ann.x1 !== undefined) {
    return { a: { x: ann.x1, y: ann.y1 }, b: { x: ann.x2, y: ann.y2 } };
  }
  if (ann.type === "detected-line") {
    const sx = canvas.width  / ann.frameWidth;
    const sy = imageHeight / ann.frameHeight;
    return { a: { x: ann.x1 * sx, y: ann.y1 * sy },
             b: { x: ann.x2 * sx, y: ann.y2 * sy } };
  }
  return null;
}

// Returns the angle of a line annotation in degrees (-180..180).
// Uses atan2(dy, dx) on the ep.a→ep.b vector.
export function lineAngleDeg(ann) {
  const ep = getLineEndpoints(ann);
  return Math.atan2(ep.b.y - ep.a.y, ep.b.x - ep.a.x) * 180 / Math.PI;
}

export function deviationColor(delta_mm, handle = null) {
  const tol = (handle && state.featureTolerances[handle]) || state.tolerances;
  if (delta_mm <= tol.warn) return "#30d158";   // green
  if (delta_mm <= tol.fail) return "#ff9f0a";   // amber
  return "#ff453a";                              // red
}

function matchDxfToDetected(ann) {
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) return [];
  const ppm = cal.pixelsPerMm;

  const detected = state.annotations
    .filter(a => a.type === "detected-circle")
    .map(a => ({
      cx: a.x * (canvas.width / a.frameWidth),
      cy: a.y * (canvas.height / a.frameHeight),
      r:  a.radius * (canvas.width / a.frameWidth),
    }));

  return ann.entities
    .filter(e => e.type === "circle")
    .map(e => {
      const nominal = dxfToCanvas(e.cx, e.cy, ann);
      const r_px = e.radius * ann.scale;
      const threshold = Math.max(10, 0.5 * r_px);
      let best = null, bestDist = Infinity;
      for (const d of detected) {
        const dist = Math.hypot(d.cx - nominal.x, d.cy - nominal.y);
        if (dist < threshold && dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      if (!best) return { nominal, r_px, matched: false, handle: e.handle ?? null };
      const delta_xy_mm = bestDist / ppm;
      const delta_r_mm  = Math.abs(best.r - r_px) / ppm;
      return {
        nominal, r_px,
        detected: best,
        matched: true,
        delta_xy_mm,
        delta_r_mm,
        color: deviationColor(Math.max(delta_xy_mm, delta_r_mm), e.handle ?? null),
        handle: e.handle ?? null,
      };
    });
}

export function drawDeviations(ann) {
  _deviationHitBoxes.length = 0;
  const matches = matchDxfToDetected(ann);
  for (const m of matches) {
    if (!m.matched) {
      // Unmatched: muted dashed circle + crosshair at nominal
      ctx.save();
      ctx.strokeStyle = "#636366";
      ctx.setLineDash([pw(4), pw(3)]);
      ctx.lineWidth = pw(1);
      ctx.beginPath();
      ctx.arc(m.nominal.x, m.nominal.y, m.r_px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(m.nominal.x - pw(5), m.nominal.y); ctx.lineTo(m.nominal.x + pw(5), m.nominal.y);
      ctx.moveTo(m.nominal.x, m.nominal.y - pw(5)); ctx.lineTo(m.nominal.x, m.nominal.y + pw(5));
      ctx.stroke();
      ctx.fillStyle = "#636366";
      ctx.font = `${pw(9)}px ui-monospace, monospace`;
      ctx.fillText("not detected", m.nominal.x + m.r_px + pw(4), m.nominal.y);
      ctx.restore();
    } else {
      const { nominal, r_px, detected: det, delta_xy_mm, delta_r_mm, color } = m;
      ctx.save();
      // Nominal circle (dashed blue)
      ctx.strokeStyle = "#0a84ff";
      ctx.setLineDash([pw(4), pw(3)]);
      ctx.lineWidth = pw(1);
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(nominal.x, nominal.y, r_px, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(nominal.x - pw(5), nominal.y); ctx.lineTo(nominal.x + pw(5), nominal.y);
      ctx.moveTo(nominal.x, nominal.y - pw(5)); ctx.lineTo(nominal.x, nominal.y + pw(5));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Detected circle (solid, colour-coded)
      ctx.strokeStyle = color;
      ctx.lineWidth = pw(1.5);
      ctx.beginPath(); ctx.arc(det.cx, det.cy, det.r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(det.cx, det.cy, pw(2.5), 0, Math.PI * 2); ctx.fill();
      // Labels
      ctx.font = `${pw(10)}px ui-monospace, monospace`;
      ctx.fillStyle = color;
      const labelX = det.cx + det.r + 4;
      const labelText = `\u0394 ${delta_xy_mm.toFixed(3)} mm`;
      ctx.fillText(labelText, labelX, det.cy);
      const textW = ctx.measureText(labelText).width;
      _deviationHitBoxes.push({ handle: m.handle, x: labelX, y: det.cy - 10, w: textW, h: 14 });
      const tol = (m.handle && state.featureTolerances[m.handle]) || state.tolerances;
      if (delta_r_mm > tol.warn) {
        ctx.fillText(`Δr ${delta_r_mm.toFixed(3)} mm`, labelX, det.cy + 13);
      }
      ctx.restore();
    }
  }

  // ── Line deviation callouts ────────────────────────────────────────────────
  for (const r of (ann.lineMatchResults ?? [])) {
    const en = ann.entities?.find(e => e.handle === r.handle);
    if (!en) continue;
    const mx_mm = (en.x1 + en.x2) / 2;
    const my_mm = (en.y1 + en.y2) / 2;
    const nominal = dxfToCanvas(mx_mm, my_mm, ann);

    const color = r.pass_fail === "fail" ? "#ff453a"
      : r.pass_fail === "warn" ? "#ff9f0a"
      : r.pass_fail === "pass" ? "#32d74b"
      : "#636366";

    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${pw(10)}px ui-monospace, monospace`;

    if (!r.matched) {
      ctx.fillStyle = "#636366";
      ctx.fillText("not detected", nominal.x + pw(4), nominal.y);
    } else {
      const devText = `⊥ ${r.perp_dev_mm?.toFixed(3)} mm`;
      const angText = r.angle_error_deg != null ? `  ∠ ${r.angle_error_deg.toFixed(1)}°` : "";
      const text = `${devText}${angText}`;
      ctx.fillText(text, nominal.x + pw(4), nominal.y - pw(4));
      const textW = ctx.measureText(text).width;
      _deviationHitBoxes.push({ handle: r.handle, x: nominal.x + pw(4), y: nominal.y - pw(14), w: textW, h: pw(14) });

      // Small crosshair at nominal midpoint
      ctx.strokeStyle = "#0a84ff";
      ctx.setLineDash([pw(3), pw(2)]);
      ctx.lineWidth = pw(1);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(nominal.x - pw(5), nominal.y); ctx.lineTo(nominal.x + pw(5), nominal.y);
      ctx.moveTo(nominal.x, nominal.y - pw(5)); ctx.lineTo(nominal.x, nominal.y + pw(5));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ── Arc deviation callouts ─────────────────────────────────────────────────
  for (const r of (ann.arcMatchResults ?? [])) {
    const en = ann.entities?.find(e => e.handle === r.handle);
    if (!en) continue;
    const nominal = dxfToCanvas(en.cx, en.cy, ann);
    const r_px = (en.radius ?? 0) * (ann.scale ?? 1);

    const color = r.pass_fail === "fail" ? "#ff453a"
      : r.pass_fail === "warn" ? "#ff9f0a"
      : r.pass_fail === "pass" ? "#32d74b"
      : "#636366";

    ctx.save();
    if (!r.matched) {
      ctx.strokeStyle = "#636366";
      ctx.setLineDash([pw(4), pw(3)]);
      ctx.lineWidth = pw(1);
      ctx.beginPath();
      ctx.arc(nominal.x, nominal.y, r_px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#636366";
      ctx.font = `${pw(10)}px ui-monospace, monospace`;
      ctx.fillText("not detected", nominal.x + r_px + pw(4), nominal.y);
    } else {
      // Nominal arc dashed
      ctx.strokeStyle = "#0a84ff";
      ctx.setLineDash([pw(4), pw(3)]);
      ctx.lineWidth = pw(1);
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(nominal.x, nominal.y, r_px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      ctx.fillStyle = color;
      ctx.font = `${pw(10)}px ui-monospace, monospace`;
      const labelX = nominal.x + r_px + pw(4);
      const devText = `Δ ${r.center_dev_mm?.toFixed(3)} mm  Δr ${r.radius_dev_mm?.toFixed(3)} mm`;
      ctx.fillText(devText, labelX, nominal.y);
      const textW = ctx.measureText(devText).width;
      _deviationHitBoxes.push({ handle: r.handle, x: labelX, y: nominal.y - pw(10), w: textW, h: pw(14) });
    }
    ctx.restore();
  }
}
