/**
 * render-dxf.js — DXF overlay rendering, guided inspection results, and deviation callouts.
 * Extracted from render.js (Task 7).
 */
import { state, _deviationHitBoxes, _labelHitBoxes } from './state.js';
import { viewport, imageWidth, imageHeight } from './viewport.js';
import { ctx, canvas, pw, drawLabel } from './render.js';

function _deviationColor(r) {
  const magnitude = Math.abs(r.perp_dev_mm ?? r.radius_dev_mm ?? 0);
  const tol_w = r.tolerance_warn ?? state.tolerances.warn;
  const tol_f = r.tolerance_fail ?? state.tolerances.fail;

  if (magnitude <= tol_w) return "#32d74b";  // green — pass

  const mode = state.featureModes[r.handle] || state.featureModes[r.parent_handle] || "die";
  const radiusDev = r.radius_dev_mm;

  if (radiusDev != null && magnitude > tol_w) {
    const reworkable = (mode === "die" && radiusDev < 0)
                    || (mode === "punch" && radiusDev > 0);
    return reworkable ? "#ff9f0a" : "#ff453a";
  }

  return magnitude <= tol_f ? "#ff9f0a" : "#ff453a";
}

function _drawFeatureNumber(x, y, num, color) {
  const r = pw(7);
  const fontSize = pw(9);
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(num), x, y);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

export function drawDxfOverlay(ann) {
  const { entities, offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  const originAngle = state.origin?.angle ?? 0;

  ctx.save();
  ctx.strokeStyle = "#00d4ff";
  ctx.setLineDash([6 / (scale * viewport.zoom), 3 / (scale * viewport.zoom)]);

  ctx.translate(offsetX, offsetY);
  if (originAngle) ctx.rotate(originAngle);
  ctx.scale(scale, -scale);   // DXF Y-up → canvas Y-down
  if (flipH) ctx.scale(-1, 1);
  if (flipV) ctx.scale(1, -1);
  if (annAngle) ctx.rotate(-annAngle * Math.PI / 180);
  ctx.lineWidth = 1 / (scale * viewport.zoom);

  // Build set of handles being actively point-picked for highlighting
  const pickHandles = new Set();
  if (state.inspectionPickTarget) {
    for (const t of state.inspectionPickTarget) {
      if (t.handle) pickHandles.add(t.handle);
    }
  }

  for (const en of entities) {
    const isPicked = pickHandles.has(en.handle);
    if (isPicked) {
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = 3 / (scale * viewport.zoom);
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = "#00d4ff";
      ctx.lineWidth = 1 / (scale * viewport.zoom);
      ctx.setLineDash([6 / (scale * viewport.zoom), 3 / (scale * viewport.zoom)]);
    }

    ctx.beginPath();
    if (en.type === "line") {
      ctx.moveTo(en.x1, en.y1);
      ctx.lineTo(en.x2, en.y2);
    } else if (en.type === "circle") {
      ctx.arc(en.cx, en.cy, en.radius, 0, Math.PI * 2);
    } else if (en.type === "arc") {
      const sr = en.start_angle * Math.PI / 180;
      const er = en.end_angle * Math.PI / 180;
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

  // While in drag-rotate mode, draw a small crosshair at the pivot so the
  // user can see where the overlay will rotate from. Pivot = dxfToCanvas(0,0).
  if (state.dxfRotateMode) {
    const pivot = dxfToCanvas(0, 0, ann);
    const size = pw(8);
    ctx.save();
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = pw(1.5);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(pivot.x - size, pivot.y);
    ctx.lineTo(pivot.x + size, pivot.y);
    ctx.moveTo(pivot.x, pivot.y - size);
    ctx.lineTo(pivot.x, pivot.y + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, pw(3), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

export function dxfToCanvas(x, y, ann) {
  const { offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  const originAngle = state.origin?.angle ?? 0;

  const xf = flipH ? -x : x;
  const yf = flipV ? -y : y;

  const cosA = Math.cos(annAngle * Math.PI / 180);
  const sinA = Math.sin(annAngle * Math.PI / 180);
  const xr = xf * cosA - yf * sinA;
  const yr = xf * sinA + yf * cosA;

  let cx = xr * scale;
  let cy = -yr * scale;

  if (originAngle) {
    const cos2 = Math.cos(originAngle), sin2 = Math.sin(originAngle);
    [cx, cy] = [cx * cos2 - cy * sin2, cx * sin2 + cy * cos2];
  }

  return { x: offsetX + cx, y: offsetY + cy };
}

export function drawGuidedResults(ann) {
  const results = ann.guidedResults;
  if (!results || results.length === 0) return;

  // Gear entities carry `tooth_index` — their per-segment deviation labels
  // and feature numbers blanket the tooth and block the view. Suppress both
  // for those; the per-tooth sidebar already exposes the numbers via
  // drill-down, and the fit stroke color still communicates pass/warn/fail
  // at a glance.
  const gearHandles = new Set();
  for (const e of (ann.entities || [])) {
    if (typeof e.tooth_index === "number" && e.handle) {
      gearHandles.add(e.handle);
    }
  }

  let featureIdx = 0;
  for (const r of results) {
    featureIdx++;
    const isGearSegment = gearHandles.has(r.handle);
    if (r.matched && r.fit) {
      // Hover highlight from inspection table. `inspectionHoverHandle` may
      // be a single handle/parent_handle string or an array of handles
      // (e.g. when a gear's per-tooth row is hovered).
      const hover = state.inspectionHoverHandle;
      const isHovered = hover && (
        Array.isArray(hover)
          ? hover.includes(r.handle)
          : (r.handle === hover || r.parent_handle === hover)
      );
      if (isHovered) {
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = pw(5);
        ctx.globalAlpha = 0.4;
        if (r.fit.type === "line") {
          ctx.beginPath();
          ctx.moveTo(r.fit.x1, r.fit.y1);
          ctx.lineTo(r.fit.x2, r.fit.y2);
          ctx.stroke();
        } else if (r.fit.cx != null) {
          ctx.beginPath();
          if (r.fit.start_deg != null && r.fit.type === "arc") {
            ctx.arc(r.fit.cx, r.fit.cy, r.fit.r, r.fit.start_deg * Math.PI / 180, r.fit.end_deg * Math.PI / 180);
          } else {
            ctx.arc(r.fit.cx, r.fit.cy, r.fit.r, 0, Math.PI * 2);
          }
          ctx.stroke();
        }
        ctx.restore();
      }

      const color = _deviationColor(r);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = pw(2);

      if (r.fit.type === "line") {
        ctx.beginPath();
        ctx.moveTo(r.fit.x1, r.fit.y1);
        ctx.lineTo(r.fit.x2, r.fit.y2);
        ctx.stroke();
        if (isGearSegment) { ctx.restore(); continue; }
        const mx = (r.fit.x1 + r.fit.x2) / 2;
        const my = (r.fit.y1 + r.fit.y2) / 2;
        _drawFeatureNumber(mx, my, featureIdx, color);
        const ldx = r.fit.x2 - r.fit.x1, ldy = r.fit.y2 - r.fit.y1;
        const ll = Math.hypot(ldx, ldy) || 1;
        const nx = -ldy / ll, ny = ldx / ll;
        const labelOff = pw(12);
        const defaultLabelX = mx + nx * labelOff;
        const defaultLabelY = my + ny * labelOff;
        const offset = r.labelOffset || { dx: 0, dy: 0 };
        const labelX = defaultLabelX + offset.dx;
        const labelY = defaultLabelY + offset.dy;
        if (offset.dx !== 0 || offset.dy !== 0) {
          ctx.save();
          ctx.strokeStyle = "rgba(150, 150, 150, 0.5)";
          ctx.lineWidth = pw(0.5);
          ctx.beginPath();
          ctx.moveTo(labelX, labelY);
          ctx.lineTo(mx, my);
          ctx.stroke();
          ctx.restore();
        }
        const labelText = `\u22a5 ${r.perp_dev_mm?.toFixed(3)} mm`;
        drawLabel(labelText, labelX, labelY);
        const fontSize = pw(12);
        ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
        const textW = ctx.measureText(labelText).width;
        _labelHitBoxes.push({
          handle: r.handle, x: labelX - pw(2), y: labelY - pw(13),
          w: textW + pw(4), h: pw(16),
          refX: mx, refY: my,
        });
      } else {
        ctx.beginPath();
        if (r.fit.start_deg != null && r.fit.type === "arc") {
          const startRad = r.fit.start_deg * Math.PI / 180;
          const endRad = r.fit.end_deg * Math.PI / 180;
          ctx.arc(r.fit.cx, r.fit.cy, r.fit.r, startRad, endRad);
        } else {
          ctx.arc(r.fit.cx, r.fit.cy, r.fit.r, 0, Math.PI * 2);
        }
        ctx.stroke();
        if (isGearSegment) { ctx.restore(); continue; }
        _drawFeatureNumber(r.fit.cx, r.fit.cy, featureIdx, color);
        let labelAngle = 0;
        if (r.fit.start_deg != null && r.fit.end_deg != null) {
          let mid = (r.fit.start_deg + r.fit.end_deg) / 2;
          if (r.fit.end_deg < r.fit.start_deg) mid += 180;
          labelAngle = mid * Math.PI / 180;
        }
        const labelR = r.fit.r + pw(10);
        const defaultArcLabelX = r.fit.cx + labelR * Math.cos(labelAngle);
        const defaultArcLabelY = r.fit.cy + labelR * Math.sin(labelAngle);
        const arcOffset = r.labelOffset || { dx: 0, dy: 0 };
        const arcLabelX = defaultArcLabelX + arcOffset.dx;
        const arcLabelY = defaultArcLabelY + arcOffset.dy;
        if (arcOffset.dx !== 0 || arcOffset.dy !== 0) {
          ctx.save();
          ctx.strokeStyle = "rgba(150, 150, 150, 0.5)";
          ctx.lineWidth = pw(0.5);
          ctx.beginPath();
          ctx.moveTo(arcLabelX, arcLabelY);
          ctx.lineTo(r.fit.cx, r.fit.cy);
          ctx.stroke();
          ctx.restore();
        }
        const arcLabelText = `\u0394c ${(r.center_dev_mm ?? 0).toFixed(3)} \u0394r ${(r.radius_dev_mm ?? 0).toFixed(3)}`;
        drawLabel(arcLabelText, arcLabelX, arcLabelY);
        const arcFontSize = pw(12);
        ctx.font = `bold ${arcFontSize}px ui-monospace, monospace`;
        const arcTextW = ctx.measureText(arcLabelText).width;
        _labelHitBoxes.push({
          handle: r.handle, x: arcLabelX - pw(2), y: arcLabelY - pw(13),
          w: arcTextW + pw(4), h: pw(16),
          refX: r.fit.cx, refY: r.fit.cy,
        });
      }
      ctx.restore();
    }
  }
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
      ctx.strokeStyle = color;
      ctx.lineWidth = pw(1.5);
      ctx.beginPath(); ctx.arc(det.cx, det.cy, det.r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(det.cx, det.cy, pw(2.5), 0, Math.PI * 2); ctx.fill();
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
      const profText = r.profile_mm != null ? `  ⏥${r.profile_mm.toFixed(3)}` : "";
      const text = `${devText}${angText}${profText}`;
      ctx.fillText(text, nominal.x + pw(4), nominal.y - pw(4));
      const textW = ctx.measureText(text).width;
      _deviationHitBoxes.push({ handle: r.handle, x: nominal.x + pw(4), y: nominal.y - pw(14), w: textW, h: pw(14) });

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
