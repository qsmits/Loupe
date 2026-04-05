/**
 * hit-test.js — Hit-testing functions for annotations and DXF entities.
 * Extracted from tools.js (Task 7).
 */
import { state } from './state.js';
import { getLineEndpoints, lineAngleDeg } from './format.js';
import { distPointToSegment, catmullRomControlPoints } from './math.js';
import { viewport, imageWidth, imageHeight } from './viewport.js';
import { canvas, ctx, pw } from './render.js';
import { dxfToCanvas } from './render-dxf.js';

// Bounding box of a comment's text box in image coords (matches drawComment layout).
export function commentLabelBox(ann) {
  const z = viewport.zoom;
  const offset = ann.labelOffset || { dx: 0, dy: 0 };
  const lx = ann.x + 12 + offset.dx;
  const ly = ann.y - 12 + offset.dy;
  const lines = String(ann.text || "").split("\n");
  // Match drawLabel font metrics
  const fontSize = pw(12);
  ctx.save();
  ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  ctx.restore();
  const lineH = pw(16);
  const padX = pw(2);
  const padTop = pw(13);
  const boxX = lx - padX;
  const boxY = ly - padTop;
  const boxW = maxW + pw(4);
  const boxH = lineH * lines.length;
  return { x: boxX, y: boxY, w: boxW, h: boxH };
}

export function hitTestAnnotation(ann, pt) {
  const z = viewport.zoom;
  if (ann.type === "distance" || ann.type === "center-dist" ||
      ann.type === "perp-dist" || ann.type === "para-dist" ||
      ann.type === "parallelism") {
    return distPointToSegment(pt, ann.a, ann.b) < 8 / z;
  }
  if (ann.type === "angle") {
    if (ann.fromLines) {
      // Hit on the arc ring (radius = ann.arcRadius) within the angle span.
      const d = Math.hypot(pt.x - ann.vertex.x, pt.y - ann.vertex.y);
      const r = ann.arcRadius || 40 / z;
      if (Math.abs(d - r) > 8 / z) return false;
      const a  = Math.atan2(pt.y - ann.vertex.y, pt.x - ann.vertex.x);
      const a1 = Math.atan2(ann.p1.y - ann.vertex.y, ann.p1.x - ann.vertex.x);
      const a3 = Math.atan2(ann.p3.y - ann.vertex.y, ann.p3.x - ann.vertex.x);
      const norm = x => ((x % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
      let delta = a3 - a1;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      const start = delta >= 0 ? a1 : a3;
      const span  = Math.abs(delta);
      const off   = norm(a - start);
      return off <= span + 0.05;
    }
    return distPointToSegment(pt, ann.p1, ann.vertex) < 8 / z ||
           distPointToSegment(pt, ann.vertex, ann.p3) < 8 / z;
  }
  if (ann.type === "circle" || ann.type === "arc-fit") {
    const d = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    return Math.abs(d - ann.r) < 10 / z || d < 10 / z;
  }
  if (ann.type === "calibration") {
    if (ann.x1 !== undefined) {
      return distPointToSegment(pt, { x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }) < 8 / z;
    } else {
      return distPointToSegment(pt, { x: ann.cx - ann.r, y: ann.cy }, { x: ann.cx + ann.r, y: ann.cy }) < 8 / z;
    }
  }
  if (ann.type === "area") {
    const n = ann.points.length;
    for (let i = 0; i < n; i++) {
      if (distPointToSegment(pt, ann.points[i], ann.points[(i + 1) % n]) < 8 / z) return true;
    }
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ann.points[i].x, yi = ann.points[i].y;
      const xj = ann.points[j].x, yj = ann.points[j].y;
      if ((yi > pt.y) !== (yj > pt.y) &&
          pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  if (ann.type === "origin") {
    const angle = ann.angle ?? 0;
    const axisLen = 30;
    const xTip = { x: ann.x + Math.cos(angle) * axisLen, y: ann.y + Math.sin(angle) * axisLen };
    const yTip = { x: ann.x + Math.sin(angle) * axisLen, y: ann.y - Math.cos(angle) * axisLen };
    const orig = { x: ann.x, y: ann.y };
    return Math.hypot(pt.x - orig.x, pt.y - orig.y) < 10 / z
      || distPointToSegment(pt, orig, xTip) < 6 / z
      || distPointToSegment(pt, orig, yTip) < 6 / z;
  }
  if (ann.type === "slot-dist") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return false;
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const midA = {
      x: (epA.a.x + epA.b.x) / 2,
      y: (epA.a.y + epA.b.y) / 2,
    };
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const lenSqB = dx_b * dx_b + dy_b * dy_b;
    if (lenSqB < 1e-10) return false;
    const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
    const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };
    return distPointToSegment(pt, midA, projA) < 6 / z;
  }
  if (ann.type === "intersect") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return false;
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let diff = Math.abs(dA - dB) % 180;
    if (diff > 90) diff = 180 - diff;
    if (diff < 1) return false;
    const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const denom = dx_a * dy_b - dy_a * dx_b;
    if (Math.abs(denom) < 1e-10) return false;
    const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
    const ix = epA.a.x + t * dx_a;
    const iy = epA.a.y + t * dy_a;
    const margin = Math.max(canvas.width, canvas.height);
    if (ix < -margin || ix > canvas.width + margin || iy < -margin || iy > canvas.height + margin) return false;
    return Math.hypot(pt.x - ix, pt.y - iy) < 8 / z;
  }
  if (ann.type === "pt-circle-dist") {
    if (Math.hypot(pt.x - ann.px, pt.y - ann.py) < 8 / z) return true;
    const circle = state.annotations.find(a => a.id === ann.circleId);
    if (!circle) return false;
    let cx, cy, r;
    if (circle.type === "circle") {
      cx = circle.cx; cy = circle.cy; r = circle.r;
    } else {
      const sx = canvas.width / circle.frameWidth;
      const sy = canvas.height / circle.frameHeight;
      cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
    }
    const dist = Math.hypot(ann.px - cx, ann.py - cy);
    if (dist < 1e-6) return false;
    const edgePt = {
      x: cx + (ann.px - cx) / dist * r,
      y: cy + (ann.py - cy) / dist * r,
    };
    return distPointToSegment(pt, { x: ann.px, y: ann.py }, edgePt) < 6 / z;
  }
  if (ann.type === "arc-measure") {
    const d = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    if (Math.abs(d - ann.r) < 8 / z) {
      const a1 = Math.atan2(ann.p1.y - ann.cy, ann.p1.x - ann.cx);
      const a3 = Math.atan2(ann.p3.y - ann.cy, ann.p3.x - ann.cx);
      const ap = Math.atan2(pt.y - ann.cy, pt.x - ann.cx);
      const twoPi = 2 * Math.PI;
      const norm_p = ((ap - a1) % twoPi + twoPi) % twoPi;
      const norm_3 = ((a3 - a1) % twoPi + twoPi) % twoPi;
      const ccw = !((((Math.atan2(ann.p2.y - ann.cy, ann.p2.x - ann.cx) - a1) % twoPi + twoPi) % twoPi) < norm_3);
      if (ccw ? norm_p >= (twoPi - norm_3) || norm_p === 0 : norm_p <= norm_3) return true;
    }
    if (d < 10 / z) return true;
    if (Math.hypot(pt.x - ann.p1.x, pt.y - ann.p1.y) < 8 / z) return true;
    if (Math.hypot(pt.x - ann.p2.x, pt.y - ann.p2.y) < 8 / z) return true;
    if (Math.hypot(pt.x - ann.p3.x, pt.y - ann.p3.y) < 8 / z) return true;
    return false;
  }
  if (ann.type === "fit-line") {
    if (!ann.x1 && !ann.x2) return false;
    return distPointToSegment(pt, { x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }) < 8 / z;
  }
  if (ann.type === "spline") {
    const pts = ann.points;
    if (!pts || pts.length < 2) return false;
    const n = pts.length;
    const threshold = 8 / z;
    for (const p of pts) {
      if (Math.hypot(pt.x - p.x, pt.y - p.y) < threshold) return true;
    }
    for (let i = 0; i < n - 1; i++) {
      const { cp1x, cp1y, cp2x, cp2y } = catmullRomControlPoints(pts, i);
      const p1 = pts[i], p2 = pts[i + 1];
      let prevX = p1.x, prevY = p1.y;
      for (let j = 1; j <= 20; j++) {
        const t = j / 20, mt = 1 - t;
        const bx = mt*mt*mt*p1.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p2.x;
        const by = mt*mt*mt*p1.y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p2.y;
        if (Math.hypot(pt.x - bx, pt.y - by) < threshold) return true;
        prevX = bx; prevY = by;
      }
    }
    return false;
  }
  if (ann.type === "comment") {
    // Pin hit
    if (Math.hypot(pt.x - ann.x, pt.y - ann.y) < 10 / z) return true;
    // Text box hit
    const box = commentLabelBox(ann);
    return pt.x >= box.x && pt.x <= box.x + box.w &&
           pt.y >= box.y && pt.y <= box.y + box.h;
  }
  if (ann.type === "detected-circle") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const cx = ann.x * sx, cy = ann.y * sy, r = ann.radius * sx;
    const d = Math.hypot(pt.x - cx, pt.y - cy);
    return Math.abs(d - r) < 10 / z || d < 10 / z;
  }
  if (ann.type === "detected-line") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const x1 = ann.x1 * sx, y1 = ann.y1 * sy, x2 = ann.x2 * sx, y2 = ann.y2 * sy;
    return distPointToSegment(pt, { x: x1, y: y1 }, { x: x2, y: y2 }) < 8 / z;
  }
  if (ann.type === "detected-line-merged") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const x1 = ann.x1 * sx, y1 = ann.y1 * sy, x2 = ann.x2 * sx, y2 = ann.y2 * sy;
    return distPointToSegment(pt, { x: x1, y: y1 }, { x: x2, y: y2 }) < 8 / z;
  }
  if (ann.type === "detected-arc-partial") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const cx = ann.cx * sx, cy = ann.cy * sy, r = ann.r * sx;
    const dist = Math.hypot(pt.x - cx, pt.y - cy);
    if (Math.abs(dist - r) > 8 / z) return false;
    let angle = Math.atan2(pt.y - cy, pt.x - cx) * 180 / Math.PI;
    let start = ann.start_deg, end = ann.end_deg;
    angle = ((angle % 360) + 360) % 360;
    start = ((start % 360) + 360) % 360;
    end = ((end % 360) + 360) % 360;
    if (start <= end) return angle >= start && angle <= end;
    return angle >= start || angle <= end;
  }
  return false;
}

/**
 * Hit-test projected DXF entities. Returns the clicked entity or null.
 * If the hit entity has a parent_handle, the compound group can be resolved by the caller.
 */
export function hitTestDxfEntity(pt, ann) {
  if (!ann || !ann.entities) return null;
  const threshold = 10 / viewport.zoom;
  let bestEntity = null;
  let bestDist = threshold;

  for (const en of ann.entities) {
    let dist = Infinity;

    if (en.type === "line" || en.type === "polyline_line") {
      const p1 = dxfToCanvas(en.x1, en.y1, ann);
      const p2 = dxfToCanvas(en.x2, en.y2, ann);
      dist = distPointToSegment(pt, p1, p2);

    } else if (en.type === "circle") {
      const c = dxfToCanvas(en.cx, en.cy, ann);
      const r = en.radius * ann.scale;
      dist = Math.abs(Math.hypot(pt.x - c.x, pt.y - c.y) - r);

    } else if (en.type === "arc" || en.type === "polyline_arc") {
      const c = dxfToCanvas(en.cx, en.cy, ann);
      const r = en.radius * ann.scale;
      const d = Math.hypot(pt.x - c.x, pt.y - c.y);
      if (Math.abs(d - r) < threshold) {
        dist = Math.abs(d - r);
      }
    }

    if (dist < bestDist) {
      bestDist = dist;
      bestEntity = en;
    }
  }

  return bestEntity;
}
