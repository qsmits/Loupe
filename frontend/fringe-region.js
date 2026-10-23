// Normalized image-space shapes accepted by the fringe polygon-mask API.
export function regionFromDrag(start, end, shape = 'rectangle', include = true) {
  const clamp = v => Math.max(0, Math.min(1, v));
  const x0 = clamp(Math.min(start.x, end.x)), x1 = clamp(Math.max(start.x, end.x));
  const y0 = clamp(Math.min(start.y, end.y)), y1 = clamp(Math.max(start.y, end.y));
  if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return null;
  const vertices = shape === 'ellipse'
    ? Array.from({length: 64}, (_, i) => {
      const angle = i * 2 * Math.PI / 64;
      return {x: (x0 + x1) / 2 + (x1 - x0) / 2 * Math.cos(angle),
        y: (y0 + y1) / 2 + (y1 - y0) / 2 * Math.sin(angle)};
    })
    : [{x: x0, y: y0}, {x: x1, y: y0}, {x: x1, y: y1}, {x: x0, y: y1}];
  return {vertices, include};
}

/** Fit in image pixels: a circle is not circular in normalized non-square images. */
export function circleRegionFromPoints(points, width, height, include = true) {
  if (points.length !== 3 || width <= 0 || height <= 0) return null;
  const [a, b, c] = points.map(p => ({x: p.x * width, y: p.y * height}));
  const bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
  const det = 2 * (bx * cy - by * cx);
  const span = Math.max(bx * bx + by * by, cx * cx + cy * cy);
  if (!span || Math.abs(det) < span * .01) return null;
  const u = (cy * (bx * bx + by * by) - by * (cx * cx + cy * cy)) / det;
  const v = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / det;
  const x = a.x + u, y = a.y + v, radius = Math.hypot(u, v);
  if (radius < Math.min(width, height) * .0025) return null;
  // Keep the fitted circle intact; clipping vertices would distort the shape.
  if (x - radius < -1e-6 || y - radius < -1e-6 || x + radius > width + 1e-6 || y + radius > height + 1e-6) return null;
  return {include, shape: 'circle', vertices: Array.from({length: 64}, (_, i) => {
    const angle = i * 2 * Math.PI / 64;
    return {x: (x + radius * Math.cos(angle)) / width, y: (y + radius * Math.sin(angle)) / height};
  })};
}

export function regionBounds(region) {
  const xs = region.vertices.map(p => p.x), ys = region.vertices.map(p => p.y);
  return {x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys)};
}

export function moveRegion(region, dx, dy) {
  const b = regionBounds(region);
  dx = Math.max(-b.x0, Math.min(1 - b.x1, dx));
  dy = Math.max(-b.y0, Math.min(1 - b.y1, dy));
  return {...region, vertices: region.vertices.map(p => ({x: p.x + dx, y: p.y + dy}))};
}

export function resizeRegion(region, corner, point) {
  const b = regionBounds(region);
  const left = corner.includes('w'), top = corner.includes('n');
  const ax = left ? b.x1 : b.x0, ay = top ? b.y1 : b.y0;
  let w = Math.max(.005, (left ? -1 : 1) * (point.x - ax));
  let h = Math.max(.005, (top ? -1 : 1) * (point.y - ay));
  const maxW = left ? ax : 1 - ax, maxH = top ? ay : 1 - ay;
  if (region.shape === 'circle') {
    const scale = Math.min(maxW / (b.x1 - b.x0), maxH / (b.y1 - b.y0),
      Math.max(w / (b.x1 - b.x0), h / (b.y1 - b.y0)));
    w = (b.x1 - b.x0) * scale; h = (b.y1 - b.y0) * scale;
  } else { w = Math.min(maxW, w); h = Math.min(maxH, h); }
  const x0 = left ? ax - w : ax, y0 = top ? ay - h : ay;
  return {...region, vertices: region.vertices.map(p => ({
    x: x0 + (p.x - b.x0) / (b.x1 - b.x0) * w,
    y: y0 + (p.y - b.y0) / (b.y1 - b.y0) * h,
  }))};
}

export function regionContains(region, point) {
  let inside = false;
  const vs = region.vertices;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const a = vs[i], b = vs[j];
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
