// Pure numerical helpers for optical-flat measurements (also tested in Node).

/** Fit two parallel plateaus to raw gap height, not to a form-removed map.
 * z = a*x + b*y + c_region. The shared slope absorbs arbitrary carrier
 * error and wedge tilt; c_A - c_B is independent of region position.
 * This does NOT resolve integer fringe order or absolute physical sign.
 */
export function fitParallelStep(grid, mask, rows, cols, rectA, rectB, corrCells = 1) {
  if (!grid || grid.length !== rows * cols || !mask || mask.length !== grid.length) {
    return { error: 'Raw height data and its matching mask are required.' };
  }
  const points = [[], []], used = new Set();
  for (const [k, rect] of [rectA, rectB].entries()) {
    const c0 = Math.max(0, Math.floor(rect.x0 * cols));
    const c1 = Math.min(cols - 1, Math.floor(rect.x1 * cols));
    const r0 = Math.max(0, Math.floor(rect.y0 * rows));
    const r1 = Math.min(rows - 1, Math.floor(rect.y1 * rows));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * cols + c;
      if (!mask[i] || !Number.isFinite(grid[i])) continue;
      if (used.has(i)) return { error: 'Step regions must not overlap.' };
      used.add(i);
      points[k].push([c / cols, r / rows, grid[i]]);
    }
    if (points[k].length < 6) return { error: 'Each plateau needs at least six valid samples.' };
  }
  const means = points.map(ps => {
    const sum = [0, 0, 0];
    for (const p of ps) {
      sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2];
    }
    return sum.map(v => v / ps.length);
  });
  const moments = points.map((ps, k) => {
    let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
    for (const p of ps) {
      const x = p[0] - means[k][0], y = p[1] - means[k][1], z = p[2] - means[k][2];
      xx += x*x; xy += x*y; yy += y*y; xz += x*z; yz += y*z;
    }
    return { xx, xy, yy, xz, yz };
  });
  const solve = m => {
    const det = m.xx * m.yy - m.xy * m.xy;
    if (!(det > 1e-10 * (m.xx + m.yy) ** 2)) return null;
    return { a: (m.yy*m.xz - m.xy*m.yz)/det, b: (m.xx*m.yz - m.xy*m.xz)/det, det };
  };
  const m = Object.fromEntries(Object.keys(moments[0]).map(k => [k, moments[0][k] + moments[1][k]]));
  const fit = solve(m), individual = moments.map(solve);
  if (!fit || individual.some(v => !v)) return { error: 'Plateaus must have two-dimensional extent to estimate tilt.' };
  const [dx, dy, dz] = means[0].map((v, j) => v - means[1][j]);
  const step = dz - fit.a*dx - fit.b*dy;
  let sse = 0;
  const regions = points.map((ps, k) => {
    let sq = 0;
    for (const p of ps) {
      const residual = p[2] - means[k][2] - fit.a*(p[0]-means[k][0]) - fit.b*(p[1]-means[k][1]);
      sq += residual*residual;
    }
    sse += sq;
    return { mean: means[k][2], rms: Math.sqrt(sq/ps.length), n: ps.length };
  });
  const n = points[0].length + points[1].length;
  // OLS intercept-difference covariance INCLUDING slope extrapolation.
  // Correlation-area inflation remains an approximate scatter-only SEM.
  const leverage = 1/points[0].length + 1/points[1].length
    + (m.yy*dx*dx - 2*m.xy*dx*dy + m.xx*dy*dy)/fit.det;
  const sem = Math.sqrt(sse/Math.max(1, n-4) * leverage * Math.max(1, corrCells));
  const slopeMismatch = Math.hypot(individual[0].a-individual[1].a, individual[0].b-individual[1].b);
  return {
    step, sem, regions, slopeX: fit.a, slopeY: fit.b,
    warnings: slopeMismatch > Math.max(1, 5*sem)
      ? ['Plateau slopes differ: the parallel-plane assumption may be invalid.'] : [],
  };
}
