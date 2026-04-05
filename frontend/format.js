/**
 * Pure formatting functions extracted from render.js and session.js.
 * No DOM dependencies — safe to test under Node.
 */

import { polygonArea } from './math.js';

/**
 * Return display-ready {a, b} endpoints for a line-like annotation.
 * @param {object} ann  - annotation object
 * @param {object} ctx  - { canvasWidth, imageHeight } (only needed for detected-line)
 */
export function getLineEndpoints(ann, ctx = {}) {
  if (ann.type === "distance" || ann.type === "perp-dist" ||
      ann.type === "para-dist" || ann.type === "parallelism") {
    return { a: ann.a, b: ann.b };
  }
  if (ann.type === "calibration" && ann.x1 !== undefined) {
    return { a: { x: ann.x1, y: ann.y1 }, b: { x: ann.x2, y: ann.y2 } };
  }
  if (ann.type === "detected-line") {
    const sx = (ctx.canvasWidth || 1)  / ann.frameWidth;
    const sy = (ctx.imageHeight || 1) / ann.frameHeight;
    return { a: { x: ann.x1 * sx, y: ann.y1 * sy },
             b: { x: ann.x2 * sx, y: ann.y2 * sy } };
  }
  return null;
}

/**
 * Angle of a line annotation in degrees (-180..180).
 * @param {object} ann - annotation object
 * @param {object} ctx - forwarded to getLineEndpoints
 */
export function lineAngleDeg(ann, ctx = {}) {
  const ep = getLineEndpoints(ann, ctx);
  if (!ep) return 0;
  return Math.atan2(ep.b.y - ep.a.y, ep.b.x - ep.a.x) * 180 / Math.PI;
}

/**
 * Format an annotation into a human-readable measurement label string.
 * @param {object} ann - annotation object
 * @param {object} ctx - { calibration, annotations, origin, imageWidth, imageHeight, canvasWidth, canvasHeight }
 */
export function measurementLabel(ann, ctx) {
  const cal = ctx.calibration && ctx.calibration.pixelsPerMm > 0 ? ctx.calibration : null;
  if (ann.type === "distance") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `${(mm * 1000).toFixed(2)} \u00b5m`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "center-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `${(mm * 1000).toFixed(2)} \u00b5m`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "angle") {
    const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
    const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
    const dot = v1.x*v2.x + v1.y*v2.y;
    const mag = Math.hypot(v1.x,v1.y) * Math.hypot(v2.x,v2.y);
    const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1,Math.min(1,dot/mag))) * 180/Math.PI;
    return `${deg.toFixed(2)}\u00b0`;
  }
  if (ann.type === "circle") {
    if (!cal) return `\u2300 ${(ann.r * 2).toFixed(1)} px`;
    const mm = (ann.r * 2) / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `\u2300 ${(mm * 1000).toFixed(2)} \u00b5m`
      : `\u2300 ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "arc-fit") {
    const isArc = ann.startAngle !== undefined;
    // Roundness: range of radii from fit points to fit center
    let roundnessStr = "";
    if (ann.points && ann.points.length >= 3) {
      const radii = ann.points.map(p => Math.hypot(p.x - ann.cx, p.y - ann.cy));
      const roundnessPx = Math.max(...radii) - Math.min(...radii);
      if (cal) {
        const roundnessMm = roundnessPx / cal.pixelsPerMm;
        roundnessStr = cal.displayUnit === "\u00b5m"
          ? `  \u25cb ${(roundnessMm * 1000).toFixed(2)} \u00b5m`
          : `  \u25cb ${roundnessMm.toFixed(3)} mm`;
      } else {
        roundnessStr = `  \u25cb ${roundnessPx.toFixed(1)} px`;
      }
    }
    if (isArc) {
      if (!cal) return `R ${ann.r.toFixed(1)} px${roundnessStr}`;
      const mm = ann.r / cal.pixelsPerMm;
      return cal.displayUnit === "\u00b5m"
        ? `R ${(mm * 1000).toFixed(2)} \u00b5m${roundnessStr}`
        : `R ${mm.toFixed(3)} mm${roundnessStr}`;
    } else {
      if (!cal) return `\u2300 ${(ann.r * 2).toFixed(1)} px${roundnessStr}`;
      const mm = (ann.r * 2) / cal.pixelsPerMm;
      return cal.displayUnit === "\u00b5m"
        ? `\u2300 ${(mm * 1000).toFixed(2)} \u00b5m${roundnessStr}`
        : `\u2300 ${mm.toFixed(3)} mm${roundnessStr}`;
    }
  }
  if (ann.type === "fit-line") {
    const zoneWidth = ann.zoneWidth || 0;
    if (!cal) return `\u23e5 ${zoneWidth.toFixed(1)} px`;
    const mm = zoneWidth / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `\u23e5 ${(mm * 1000).toFixed(2)} \u00b5m`
      : `\u23e5 ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-circle") {
    const sx = ctx.imageWidth / ann.frameWidth;
    const r = ann.radius * sx;
    if (!cal) return `\u2300 ${(r * 2).toFixed(1)} px`;
    const mm = (r * 2) / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `\u2300 ${(mm * 1000).toFixed(2)} \u00b5m`
      : `\u2300 ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-line") {
    const sx = ctx.imageWidth / ann.frameWidth;
    const lenPx = ann.length * sx;
    if (!cal) return `${lenPx.toFixed(1)} px`;
    const mm = lenPx / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `${(mm * 1000).toFixed(2)} \u00b5m`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-line-merged") {
    const sx = ann.frameWidth ? ctx.imageWidth / ann.frameWidth : 1;
    const lenPx = Math.hypot((ann.x2 - ann.x1) * sx, (ann.y2 - ann.y1) * sx);
    if (!cal) return `${lenPx.toFixed(1)} px`;
    const mm = lenPx / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `${(mm * 1000).toFixed(2)} \u00b5m`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-arc-partial") {
    const sx = ann.frameWidth ? ctx.imageWidth / ann.frameWidth : 1;
    const rPx = ann.r * sx;
    const spanDeg = ann.end_deg >= ann.start_deg
      ? ann.end_deg - ann.start_deg
      : 360 - (ann.start_deg - ann.end_deg);
    if (!cal) return `r ${rPx.toFixed(1)} px  ${spanDeg.toFixed(0)}\u00b0`;
    const mm = rPx / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `r ${(mm * 1000).toFixed(2)} \u00b5m  ${spanDeg.toFixed(0)}\u00b0`
      : `r ${mm.toFixed(3)} mm  ${spanDeg.toFixed(0)}\u00b0`;
  }
  if (ann.type === "arc-measure") {
    const rPx = ann.r;
    const spanDeg = ann.span_deg ?? 0;
    if (!cal) return `r ${rPx.toFixed(1)} px  ${spanDeg.toFixed(0)}\u00b0`;
    const mm = rPx / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `r ${(mm * 1000).toFixed(2)} \u00b5m  ${spanDeg.toFixed(0)}\u00b0`
      : `r ${mm.toFixed(3)} mm  ${spanDeg.toFixed(0)}\u00b0`;
  }
  if (ann.type === "spline") {
    const lenPx = ann.length_px || 0;
    if (!cal) return `~ ${lenPx.toFixed(1)} px`;
    const mm = lenPx / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m"
      ? `~ ${(mm * 1000).toFixed(2)} \u00b5m`
      : `~ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "calibration") {
    const prefix = ann.x1 !== undefined ? "\u27f7" : "\u2300";
    return `${prefix} ${ann.knownValue} ${ann.unit}`;
  }
  if (ann.type === "perp-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `\u22a5 ${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m" ? `\u22a5 ${(mm * 1000).toFixed(2)} \u00b5m`
                                    : `\u22a5 ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "para-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `\u2225 ${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "\u00b5m" ? `\u2225 ${(mm * 1000).toFixed(2)} \u00b5m`
                                    : `\u2225 ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "parallelism") {
    return `\u2225 ${ann.angleDeg.toFixed(2)}\u00b0`;
  }
  if (ann.type === "area") {
    const px2 = polygonArea(ann.points);
    if (!cal) return `\u25a1 ${px2.toFixed(1)} px\u00b2`;
    const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
    return cal.displayUnit === "\u00b5m"
      ? `\u25a1 ${(mm2 * 1e6).toFixed(2)} \u00b5m\u00b2`
      : `\u25a1 ${mm2.toFixed(4)} mm\u00b2`;
  }
  if (ann.type === "origin") return "";
  if (ann.type === "pt-circle-dist") {
    const circle = ctx.annotations.find(a => a.id === ann.circleId);
    if (!circle) return "\u2299 ref deleted";
    let cx, cy, r;
    if (circle.type === "circle") {
      cx = circle.cx; cy = circle.cy; r = circle.r;
    } else {
      const sx = ctx.canvasWidth / circle.frameWidth;
      const sy = ctx.canvasHeight / circle.frameHeight;
      cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
    }
    const dist = Math.hypot(ann.px - cx, ann.py - cy);
    const gapPx = dist - r;
    const cal2 = ctx.calibration;
    if (!cal2) return `\u2299 ${gapPx.toFixed(1)} px`;
    const mm = gapPx / cal2.pixelsPerMm;
    return cal2.displayUnit === "\u00b5m"
      ? `\u2299 ${(mm * 1000).toFixed(2)} \u00b5m`
      : `\u2299 ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "intersect") {
    const annA = ctx.annotations.find(a => a.id === ann.lineAId);
    const annB = ctx.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "\u2295 ref deleted";
    const epA = getLineEndpoints(annA, ctx);
    const epB = getLineEndpoints(annB, ctx);
    const dA = lineAngleDeg(annA, ctx), dB = lineAngleDeg(annB, ctx);
    let diff = Math.abs(dA - dB) % 180;
    if (diff > 90) diff = 180 - diff;
    if (diff < 1) return "\u2225 no intersection";
    const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const denom = dx_a * dy_b - dy_a * dx_b;
    if (Math.abs(denom) < 1e-10) return "\u2225 no intersection";
    const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
    const ix = epA.a.x + t * dx_a;
    const iy = epA.a.y + t * dy_a;
    const margin = Math.max(ctx.canvasWidth, ctx.canvasHeight);
    const offScreen = ix < -margin || ix > ctx.canvasWidth + margin ||
                      iy < -margin || iy > ctx.canvasHeight + margin;
    const cal2 = ctx.calibration;
    const org = ctx.origin;
    if (org) {
      const cosA = Math.cos(-(org.angle ?? 0)), sinA = Math.sin(-(org.angle ?? 0));
      const rx = ix - org.x, ry = iy - org.y;
      const ux = rx * cosA - ry * sinA;
      const uy = rx * sinA + ry * cosA;
      if (cal2) {
        const xVal = ux / cal2.pixelsPerMm;
        const yVal = uy / cal2.pixelsPerMm;
        const unit = cal2.displayUnit === "\u00b5m" ? "\u00b5m" : "mm";
        const scale = cal2.displayUnit === "\u00b5m" ? 1000 : 1;
        const xStr = (xVal * scale).toFixed(cal2.displayUnit === "\u00b5m" ? 2 : 3);
        const yStr = (yVal * scale).toFixed(cal2.displayUnit === "\u00b5m" ? 2 : 3);
        return offScreen
          ? `\u2295 off-screen  X: ${xStr} ${unit}  Y: ${yStr} ${unit}`
          : `\u2295 X: ${xStr} ${unit}  Y: ${yStr} ${unit}`;
      }
      return offScreen
        ? `\u2295 off-screen  X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`
        : `\u2295 X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`;
    }
    return offScreen
      ? `\u2295 off-screen  (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`
      : `\u2295 (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`;
  }
  if (ann.type === "slot-dist") {
    const annA = ctx.annotations.find(a => a.id === ann.lineAId);
    const annB = ctx.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "\u27fa ref deleted";
    const epA = getLineEndpoints(annA, ctx);
    const epB = getLineEndpoints(annB, ctx);
    const midA = {
      x: (epA.a.x + epA.b.x) / 2,
      y: (epA.a.y + epA.b.y) / 2,
    };
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const lenSqB = dx_b * dx_b + dy_b * dy_b;
    if (lenSqB < 1e-10) return "\u27fa 0 px";
    const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
    const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };
    const gapPx = Math.hypot(midA.x - projA.x, midA.y - projA.y);
    const dA = lineAngleDeg(annA, ctx), dB = lineAngleDeg(annB, ctx);
    let angleDiff = Math.abs(dA - dB) % 180;
    if (angleDiff > 90) angleDiff = 180 - angleDiff;
    const angSuffix = angleDiff > 2 ? ` (\u00b1${angleDiff.toFixed(1)}\u00b0)` : "";
    const cal2 = ctx.calibration;
    if (!cal2) return `\u27fa ${gapPx.toFixed(1)} px${angSuffix}`;
    const mm = gapPx / cal2.pixelsPerMm;
    const valStr = cal2.displayUnit === "\u00b5m"
      ? `${(mm * 1000).toFixed(2)} \u00b5m`
      : `${mm.toFixed(3)} mm`;
    return `\u27fa ${valStr}${angSuffix}`;
  }
  return "";
}

/**
 * Format an annotation for CSV export.
 * @param {object} ann - annotation object
 * @param {object} calibration - calibration state (or null)
 * @param {number} imgWidth - image width in pixels
 * @returns {{ value: string, unit: string } | string}
 */
export function formatCsvValue(ann, calibration, imgWidth) {
  const cal = calibration;

  function distResult(px) {
    if (!cal) return { value: px.toFixed(1), unit: "px" };
    const mm = px / cal.pixelsPerMm;
    if (cal.displayUnit === "\u00b5m") return { value: (mm * 1000).toFixed(1), unit: "\u00b5m" };
    return { value: mm.toFixed(3), unit: "mm" };
  }

  function areaResult(px2) {
    if (!cal) return { value: px2.toFixed(1), unit: "px\u00b2" };
    const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
    if (cal.displayUnit === "\u00b5m") return { value: (mm2 * 1e6).toFixed(1), unit: "\u00b5m\u00b2" };
    return { value: mm2.toFixed(4), unit: "mm\u00b2" };
  }

  if (ann.type === "distance" || ann.type === "perp-dist" || ann.type === "para-dist") {
    return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
  }
  if (ann.type === "center-dist") {
    return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
  }
  if (ann.type === "angle") {
    const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
    const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
    const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
    return { value: deg.toFixed(2), unit: "\u00b0" };
  }
  if (ann.type === "circle") {
    return distResult(ann.r * 2);
  }
  if (ann.type === "arc-fit") {
    return distResult(ann.r * 2);
  }
  if (ann.type === "fit-line") {
    return distResult(ann.zoneWidth || 0);
  }
  if (ann.type === "arc-measure") {
    const ppm = cal ? cal.pixelsPerMm : 1;
    const r_mm = ann.r / ppm;
    const chord_mm = ann.chord_px / ppm;
    const cx_mm = ann.cx / ppm;
    const cy_mm = ann.cy / ppm;
    const rStr = cal
      ? (cal.displayUnit === "\u00b5m" ? `${(r_mm * 1000).toFixed(2)} \u00b5m` : `${r_mm.toFixed(3)} mm`)
      : `${ann.r.toFixed(1)} px`;
    const chordStr = cal
      ? (cal.displayUnit === "\u00b5m" ? `${(chord_mm * 1000).toFixed(2)} \u00b5m` : `${chord_mm.toFixed(3)} mm`)
      : `${ann.chord_px.toFixed(1)} px`;
    const centerStr = cal
      ? `(${cx_mm.toFixed(3)}, ${cy_mm.toFixed(3)}) mm`
      : `(${ann.cx.toFixed(1)}, ${ann.cy.toFixed(1)}) px`;
    return `center=${centerStr}  r=${rStr}  span ${ann.span_deg.toFixed(1)}\u00b0  chord=${chordStr}`;
  }
  if (ann.type === "detected-circle") {
    const sx = imgWidth / ann.frameWidth;
    return distResult((ann.radius * sx) * 2);
  }
  if (ann.type === "area") {
    return areaResult(polygonArea(ann.points));
  }
  if (ann.type === "spline") {
    return distResult(ann.length_px || 0);
  }
  if (ann.type === "parallelism") {
    return { value: ann.angleDeg.toFixed(2), unit: "\u00b0" };
  }
  if (ann.type === "calibration") {
    let px;
    if (ann.x1 !== undefined) {
      px = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
    } else {
      px = ann.r * 2;
    }
    return distResult(px);
  }
  return { value: "", unit: "" };
}
