// ── Inspection / point-pick helpers ────────────────────────────────────────
import { apiFetch } from './api.js';
import { state } from './state.js';
import { canvas, showStatus, redraw, dxfToCanvas } from './render.js';
import { renderInspectionTable } from './sidebar.js';
import { canvasPoint, hitTestDxfEntity } from './tools.js';
import { fitCircle, fitLine, fitCircleAlgebraic, distPointToSegment } from './math.js';
import { viewport } from './viewport.js';
import { imageWidth, imageHeight } from './viewport.js';

export function _hitTestGuidedResult(pt, dxfAnn) {
  const threshold = 10 / viewport.zoom;
  let best = null, bestDist = threshold;
  for (const r of (dxfAnn.guidedResults || [])) {
    if (!r.matched || !r.fit) continue;
    let dist = Infinity;
    if (r.fit.type === "line") {
      dist = distPointToSegment(pt, { x: r.fit.x1, y: r.fit.y1 }, { x: r.fit.x2, y: r.fit.y2 });
    } else if (r.fit.cx != null) {
      dist = Math.abs(Math.hypot(pt.x - r.fit.cx, pt.y - r.fit.cy) - r.fit.r);
    }
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  return best;
}

export function _entityEndpoints(en) {
  /** Get the endpoints of a DXF entity in DXF space. */
  if (en.type === "line" || en.type === "polyline_line") {
    return [{ x: en.x1, y: en.y1 }, { x: en.x2, y: en.y2 }];
  }
  if (en.type === "arc" || en.type === "polyline_arc") {
    const sr = en.start_angle * Math.PI / 180;
    const er = en.end_angle * Math.PI / 180;
    return [
      { x: en.cx + en.radius * Math.cos(sr), y: en.cy + en.radius * Math.sin(sr) },
      { x: en.cx + en.radius * Math.cos(er), y: en.cy + en.radius * Math.sin(er) },
    ];
  }
  return [];
}

export function _findConnectedEntities(startEntity, allEntities) {
  /** Find all standalone entities connected to startEntity via shared endpoints. */
  const TOL = 0.01;  // mm tolerance for endpoint matching in DXF space
  const standalone = allEntities.filter(e => !e.parent_handle && e.type !== "circle");
  const connected = new Set([startEntity.handle]);
  const queue = [startEntity];

  while (queue.length > 0) {
    const current = queue.shift();
    const endpoints = _entityEndpoints(current);
    for (const en of standalone) {
      if (connected.has(en.handle)) continue;
      const enPoints = _entityEndpoints(en);
      // Check if any endpoint of en matches any endpoint of current
      for (const ep of endpoints) {
        for (const cp of enPoints) {
          if (Math.abs(ep.x - cp.x) < TOL && Math.abs(ep.y - cp.y) < TOL) {
            connected.add(en.handle);
            queue.push(en);
          }
        }
      }
    }
  }

  return allEntities.filter(e => connected.has(e.handle));
}

export function _annotationPrimaryPoint(ann) {
  // Frame-scaled types
  if (ann.frameWidth) {
    const sx = imageWidth / ann.frameWidth;
    const sy = imageHeight / ann.frameHeight;
    if (ann.cx != null) return { x: ann.cx * sx, y: ann.cy * sy };
    if (ann.x1 != null) return { x: (ann.x1 + ann.x2) / 2 * sx, y: (ann.y1 + ann.y2) / 2 * sy };
    if (ann.x != null) return { x: ann.x * sx, y: ann.y * sy };
  }
  // Canvas-space types
  if (ann.a && ann.b) return { x: (ann.a.x + ann.b.x) / 2, y: (ann.a.y + ann.b.y) / 2 };
  if (ann.cx != null) return { x: ann.cx, y: ann.cy };
  if (ann.vertex) return { x: ann.vertex.x, y: ann.vertex.y };
  if (ann.x != null) return { x: ann.x, y: ann.y };
  if (ann.points) {
    const cx = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length;
    const cy = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length;
    return { x: cx, y: cy };
  }
  return null;
}

export function _nearestSegmentDist(pt, entity, dxfAnn) {
  /** Distance from pt (image-space) to a projected DXF entity. */
  if (entity.type === "line" || entity.type === "polyline_line") {
    const p1 = dxfToCanvas(entity.x1, entity.y1, dxfAnn);
    const p2 = dxfToCanvas(entity.x2, entity.y2, dxfAnn);
    return distPointToSegment(pt, p1, p2);
  } else if (entity.type === "arc" || entity.type === "polyline_arc" || entity.type === "circle") {
    const c = dxfToCanvas(entity.cx, entity.cy, dxfAnn);
    const r = entity.radius * dxfAnn.scale;
    return Math.abs(Math.hypot(pt.x - c.x, pt.y - c.y) - r);
  }
  return Infinity;
}

export function _updatePickFit() {
  const pts = state.inspectionPickPoints;
  const targets = state.inspectionPickTarget;  // array of entities
  if (!targets || targets.length === 0) return;

  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (!dxfAnn) return;

  if (targets.length === 1) {
    // Single entity — simple fit
    const etype = targets[0].type;
    state.inspectionPickFit = null;
    if ((etype === "line" || etype === "polyline_line") && pts.length >= 2) {
      state.inspectionPickFit = { fits: [fitLine(pts)] };
    } else if ((etype === "arc" || etype === "polyline_arc" || etype === "circle") && pts.length >= 3) {
      const result = fitCircleAlgebraic(pts);
      if (result) state.inspectionPickFit = { fits: [{ type: "circle", cx: result.cx, cy: result.cy, r: result.r }] };
    }
    return;
  }

  // Compound feature: assign each point to nearest sub-segment
  const buckets = targets.map(() => []);
  for (const pt of pts) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) {
      const d = _nearestSegmentDist(pt, targets[i], dxfAnn);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    buckets[bestIdx].push(pt);
  }

  // Fit each sub-segment independently
  const fits = [];
  for (let i = 0; i < targets.length; i++) {
    const seg = targets[i];
    const segPts = buckets[i];
    const etype = seg.type;
    if ((etype === "line" || etype === "polyline_line") && segPts.length >= 2) {
      fits.push(fitLine(segPts));
    } else if ((etype === "arc" || etype === "polyline_arc" || etype === "circle") && segPts.length >= 3) {
      const result = fitCircleAlgebraic(segPts);
      if (result) fits.push({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
    }
    // else: not enough points for this segment yet, skip
  }

  state.inspectionPickFit = fits.length > 0 ? { fits } : null;
}

export async function _finalizePickInspection() {
  const targets = state.inspectionPickTarget;  // array of entities
  const pts = state.inspectionPickPoints;
  if (!targets || !targets.length || pts.length < 2) {
    showStatus("Need at least 2 points");
    return;
  }
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) return;

  // Bucket points to nearest sub-segment (same logic as _updatePickFit)
  const buckets = targets.map(() => []);
  for (const pt of pts) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) {
      const d = _nearestSegmentDist(pt, targets[i], ann);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    buckets[bestIdx].push(pt);
  }

  let successCount = 0;

  try {
    // Fit each sub-segment with enough points
    for (let i = 0; i < targets.length; i++) {
      const entity = targets[i];
      const segPts = buckets[i];
      if (segPts.length < 2) continue;  // not enough points

      const resp = await apiFetch("/fit-feature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity,
          points: segPts.map(p => [p.x, p.y]),
          pixels_per_mm: cal.pixelsPerMm,
          tx: ann.offsetX, ty: ann.offsetY,
          angle_deg: ann.angle ?? 0,
          flip_h: ann.flipH ?? false, flip_v: ann.flipV ?? false,
          tolerance_warn: state.tolerances.warn,
          tolerance_fail: state.tolerances.fail,
          subpixel: state.settings.subpixelMethod,
        }),
      });
      if (!resp.ok) continue;
      const result = await resp.json();
      result.source = "manual";

      // Replace or add to guided results
      if (!ann.guidedResults) ann.guidedResults = [];
      const grIdx = ann.guidedResults.findIndex(r => r.handle === entity.handle);
      if (grIdx >= 0) ann.guidedResults[grIdx] = result;
      else ann.guidedResults.push(result);

      // Update state.inspectionResults
      const sr = {
        handle: result.handle, type: result.type, parent_handle: result.parent_handle,
        matched: result.matched, deviation_mm: result.perp_dev_mm ?? result.center_dev_mm,
        angle_error_deg: result.angle_error_deg,
        tolerance_warn: result.tolerance_warn, tolerance_fail: result.tolerance_fail,
        pass_fail: result.pass_fail, source: "manual",
        tp_dev_mm: result.tp_dev_mm ?? null,
        dx_px: result.dx_px ?? null,
        dy_px: result.dy_px ?? null,
        center_dev_mm: result.center_dev_mm ?? null,
        radius_dev_mm: result.radius_dev_mm ?? null,
      };
      const sIdx = state.inspectionResults.findIndex(r => r.handle === entity.handle);
      if (sIdx >= 0) state.inspectionResults[sIdx] = sr;
      else state.inspectionResults.push(sr);

      successCount++;
    }

    showStatus(`Manual measurement: ${successCount} segment${successCount !== 1 ? "s" : ""} fitted`);
    renderInspectionTable();
  } catch (err) {
    showStatus("Fit error: " + err.message);
  }

  state.inspectionPickTarget = null;
  state.inspectionPickPoints = [];
  state.inspectionPickFit = null;
  redraw();
}
