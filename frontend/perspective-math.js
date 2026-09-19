/** Choose destination corners: a rectangle centred at the source centroid,
 *  scaled so its pixel perimeter matches the source quad's perimeter. */
export function _computeDstCorners(srcPts, wMm, hMm) {
  const cx = srcPts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = srcPts.reduce((s, p) => s + p.y, 0) / 4;

  // Perimeter of source quad
  const perimSrc = srcPts.reduce((s, p, i) => {
    const q = srcPts[(i + 1) % 4];
    return s + Math.hypot(q.x - p.x, q.y - p.y);
  }, 0);
  const perimMm  = 2 * (wMm + hMm);
  const pxPerMm  = perimSrc / perimMm;

  const hw = wMm * pxPerMm / 2;
  const hh = hMm * pxPerMm / 2;
  return [
    { x: cx - hw, y: cy - hh },  // TL
    { x: cx + hw, y: cy - hh },  // TR
    { x: cx + hw, y: cy + hh },  // BR
    { x: cx - hw, y: cy + hh },  // BL
  ];
}

/** Compute 3×3 homography from 4 point correspondences (DLT). */
export function _computeHomography(srcPts, dstPts) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x: sx, y: sy } = srcPts[i];
    const { x: dx, y: dy } = dstPts[i];
    A.push([-sx, -sy, -1,   0,   0,  0, dx*sx, dx*sy]);
    b.push(-dx);
    A.push([  0,   0,  0, -sx, -sy, -1, dy*sx, dy*sy]);
    b.push(-dy);
  }
  const h = _solveLinear(A, b);
  if (!h) return null;
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

/** Gaussian elimination with partial pivoting for an n×n system. */
export function _solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) return null;
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / pivot;
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    x[row] = M[row][n];
    for (let col = row + 1; col < n; col++) x[row] -= M[row][col] * x[col];
    x[row] /= M[row][row];
  }
  return x;
}

/** Invert a 3×3 matrix. */
export function _inv3x3([[a,b,c],[d,e,f],[g,h,k]]) {
  const det = a*(e*k - f*h) - b*(d*k - f*g) + c*(d*h - e*g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    [(e*k-f*h)/det, (c*h-b*k)/det, (b*f-c*e)/det],
    [(f*g-d*k)/det, (a*k-c*g)/det, (c*d-a*f)/det],
    [(d*h-e*g)/det, (b*g-a*h)/det, (a*e-b*d)/det],
  ];
}

