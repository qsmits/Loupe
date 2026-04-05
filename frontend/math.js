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
