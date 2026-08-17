// ── Math helpers ─────────────────────────────────────────────────────────────

export function parseDistanceInput(input) {
  // accepts "1.5 mm", "500 µm", "0.5mm", etc.
  const m = input.trim().match(/^([0-9.]+)\s*(mm|µm|um)?$/i);
  if (!m) { alert("Could not parse distance. Use format like '1.5 mm' or '500 µm'"); return null; }
  const value = parseFloat(m[1]);
  const unit = (m[2] || "mm").replace("um", "µm").toLowerCase();
  const mm = unit === "µm" ? value / 1000 : value;
  return { value, unit, mm };
}

// Pixels-per-mm from a calibration annotation. Pure — shared by
// applyCalibration (annotations.js) and the calibration drag path in
// handleDrag (tools.js), so dragging a calibration endpoint can never leave
// state.calibration.pixelsPerMm stale relative to the drawn reference.
// ann: two-point { x1,y1,x2,y2 } or circle { r } (known value is the
// diameter), plus { knownValue, unit } where unit is "mm" or "µm"
// (anything else is treated as mm, matching parseDistanceInput output).
// Returns null for degenerate input (zero/non-finite length or known value).
export function calibrationPixelsPerMm(ann) {
  const pixelDist = ann.x1 !== undefined
    ? Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1)
    : ann.r * 2;
  const knownMm = ann.unit === "µm" ? ann.knownValue / 1000 : ann.knownValue;
  if (!Number.isFinite(pixelDist) || !Number.isFinite(knownMm)) return null;
  if (pixelDist <= 0 || knownMm <= 0) return null;
  return pixelDist / knownMm;
}

// Types whose pixel span is the distance between two stored endpoints.
const _SPAN_ENDPOINT_TYPES = new Set(["distance", "perp-dist", "para-dist", "center-dist"]);
// Types whose known dimension is a diameter (calibration convention: the user
// enters the diameter, matching the existing circle-calibration flow).
const _SPAN_DIAMETER_TYPES = new Set(["circle", "arc-fit", "arc-measure"]);

/** Pixel magnitude of a measurement, for calibrating from it.
 *
 * Returns null when the annotation carries no self-contained scale:
 * angle/parallelism are dimensionless, fit-line is a flatness zone width, and
 * slot-dist/pt-circle-dist/intersect are derived from *other* annotations
 * looked up by id, so they cannot be resolved from `ann` alone. Detections are
 * excluded too — elevate them to a measurement first.
 *
 * @param {object} ann
 * @returns {{ span: number, kind: 'length'|'diameter'|'area' } | null}
 */
export function measurementPixelSpan(ann) {
  if (!ann || typeof ann !== "object") return null;
  let span = null;
  let kind = null;
  if (_SPAN_ENDPOINT_TYPES.has(ann.type)) {
    if (!ann.a || !ann.b) return null;
    span = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    kind = "length";
  } else if (ann.type === "spline") {
    span = ann.length_px;
    kind = "length";
  } else if (_SPAN_DIAMETER_TYPES.has(ann.type)) {
    span = ann.r * 2;
    kind = "diameter";
  } else if (ann.type === "area") {
    if (!Array.isArray(ann.points) || ann.points.length < 3) return null;
    span = polygonArea(ann.points);
    kind = "area";
  } else {
    return null;
  }
  if (!Number.isFinite(span) || span <= 0) return null;
  return { span, kind };
}

/** Unit-bearing area input: "25 mm²", "25 mm2", "4000 µm²", "25" (bare → mm²).
 * Requires exponent marker (² or 2) when a unit is given; rejects multiple dots,
 * stray exponents, and units without exponents. Unlike parseDistanceInput this
 * never alerts — math.js is imported by Node unit tests, where alert() does not
 * exist. Callers report bad input.
 * @returns {{ value: number, unit: 'mm'|'µm', mm2: number } | null}
 */
export function parseAreaInput(input) {
  const m = String(input ?? "").trim().match(/^(\d+(?:\.\d+)?)(?:\s*(mm|µm|um)\s*(?:²|2))?$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] || "mm").replace(/um/i, "µm").toLowerCase();
  const mm2 = unit === "µm" ? value / 1e6 : value;
  return { value, unit, mm2 };
}

/** Pixels-per-mm implied by a measurement of known true size.
 * Length and diameter are a direct ratio; an area gives the uniform scale
 * √(px² / mm²). Returns null on degenerate input.
 * @param {number} span    pixel magnitude from measurementPixelSpan
 * @param {'length'|'diameter'|'area'} kind
 * @param {number} knownMm known true size — mm for length/diameter, mm² for area
 * @returns {number | null}
 */
export function calibrationPpmFromMeasurement(span, kind, knownMm) {
  if (!Number.isFinite(span) || !Number.isFinite(knownMm)) return null;
  if (span <= 0 || knownMm <= 0) return null;
  if (kind === "length" || kind === "diameter") return span / knownMm;
  if (kind === "area") return Math.sqrt(span / knownMm);
  return null;
}

export function fitCircle(p1, p2, p3) {
  const ax = p1.x, ay = p1.y;
  const bx = p2.x, by = p2.y;
  const cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-10) throw new Error("collinear");
  const sqA = ax*ax + ay*ay, sqB = bx*bx + by*by, sqC = cx*cx + cy*cy;
  const ux = (sqA*(by-cy) + sqB*(cy-ay) + sqC*(ay-by)) / d;
  const uy = (sqA*(cx-bx) + sqB*(ax-cx) + sqC*(bx-ax)) / d;
  const r  = Math.hypot(ax - ux, ay - uy);
  return { cx: ux, cy: uy, r };
}

export function fitCircleAlgebraic(points) {
  if (points.length < 3) return null;
  const n = points.length;
  // Centre the input to improve numerical conditioning
  let mx = 0, my = 0;
  for (const {x, y} of points) { mx += x; my += y; }
  mx /= n; my /= n;
  let sx=0, sy=0, sx2=0, sy2=0, sxy=0, sx3=0, sy3=0, sx2y=0, sxy2=0;
  for (const {x: px, y: py} of points) {
    const x = px - mx, y = py - my;
    sx+=x; sy+=y; sx2+=x*x; sy2+=y*y; sxy+=x*y;
    sx3+=x*x*x; sy3+=y*y*y; sx2y+=x*x*y; sxy2+=x*y*y;
  }
  const M = [[sx2,sxy,sx],[sxy,sy2,sy],[sx,sy,n]];
  const b = [-(sx3+sxy2), -(sx2y+sy3), -(sx2+sy2)];
  function det3(m) {
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
          -m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
          +m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  }
  const d = det3(M);
  if (Math.abs(d) < 1e-6) return null;
  const sub = (col, bv) => M.map((row, i) => row.map((v, j) => j === col ? bv[i] : v));
  const D = det3(sub(0, b)) / d;
  const E = det3(sub(1, b)) / d;
  const F = det3(sub(2, b)) / d;
  // cx/cy are in centred space — translate back to canvas space
  const cx = -D / 2 + mx, cy = -E / 2 + my;
  // radius uses centred cx/cy for the calculation
  const cxc = -D / 2, cyc = -E / 2;
  const r = Math.sqrt(Math.max(0, cxc*cxc + cyc*cyc - F));
  if (!isFinite(r) || r <= 0) return null;
  // Collinear points produce a near-infinite radius — treat as degenerate
  if (r > 1e6) return null;
  return { cx, cy, r };
}

export function polygonArea(pts) {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(s) / 2;
}

export function distPointToSegment(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx*dx + dy*dy;
  if (lenSq < 1e-10) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x-a.x)*dx + (pt.y-a.y)*dy) / lenSq));
  return Math.hypot(pt.x - (a.x + t*dx), pt.y - (a.y + t*dy));
}

/**
 * Least-squares line fit through N points (eigenvector method / orthogonal distance regression).
 * Returns { cx, cy, dx, dy, x1, y1, x2, y2 } or null if < 2 points.
 */
/**
 * Compute Catmull-Rom Bézier control points for segment pts[i] → pts[i+1].
 * Clamps boundary indices so endpoints get mirror tangents.
 */
export function catmullRomControlPoints(pts, i) {
  const n = pts.length;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n - 1, i + 2)];
  return {
    cp1x: p1.x + (p2.x - p0.x) / 6,
    cp1y: p1.y + (p2.y - p0.y) / 6,
    cp2x: p2.x - (p3.x - p1.x) / 6,
    cp2y: p2.y - (p3.y - p1.y) / 6,
  };
}

/**
 * Approximate arc length of a Catmull-Rom spline through points[].
 */
export function splineArcLength(points) {
  const n = points.length;
  if (n < 2) return 0;
  let total = 0;
  const SAMPLES = 20;
  for (let i = 0; i < n - 1; i++) {
    const { cp1x, cp1y, cp2x, cp2y } = catmullRomControlPoints(points, i);
    const p1 = points[i], p2 = points[i + 1];
    let prevX = p1.x, prevY = p1.y;
    for (let j = 1; j <= SAMPLES; j++) {
      const t = j / SAMPLES, mt = 1 - t;
      const bx = mt*mt*mt*p1.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p2.x;
      const by = mt*mt*mt*p1.y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p2.y;
      total += Math.hypot(bx - prevX, by - prevY);
      prevX = bx; prevY = by;
    }
  }
  return total;
}

/**
 * Signed perpendicular distance from pt to infinite line through (cx,cy) with direction (dx,dy).
 * Positive on the left side of the direction vector.
 */
export function signedDistPointToLine(pt, cx, cy, dx, dy) {
  const nx = -dy, ny = dx;
  return (pt.x - cx) * nx + (pt.y - cy) * ny;
}

export function fitLine(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(theta), dy = Math.sin(theta);
  let tMin = Infinity, tMax = -Infinity;
  for (const p of points) {
    const t = (p.x - cx) * dx + (p.y - cy) * dy;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  return {
    cx, cy, dx, dy,
    x1: cx + tMin * dx, y1: cy + tMin * dy,
    x2: cx + tMax * dx, y2: cy + tMax * dy,
  };
}
