// Client-side sub-pixel edge snapping using cached ImageData.
// Replaces the server-side /refine-point call when subpixel_method is
// "parabola-js" or "gaussian-js". Works entirely in the browser using
// the frozen image pixel data — no network round-trip, instant response.

let _pixels = null; // Uint8ClampedArray (RGBA) from getImageData
let _iw = 0;
let _ih = 0;

/**
 * Cache the frozen image as raw pixel data.
 * Call this whenever state.frozenBackground is set.
 */
export function cacheImageData(img, width, height) {
  if (!img || width <= 0 || height <= 0) { _pixels = null; return; }
  try {
    const oc = new OffscreenCanvas(width, height);
    const octx = oc.getContext('2d');
    octx.drawImage(img, 0, 0, width, height);
    const imgData = octx.getImageData(0, 0, width, height);
    _pixels = imgData.data;
    _iw = width;
    _ih = height;
  } catch {
    _pixels = null; // CORS or decode error — fall back gracefully
  }
}

export function clearImageCache() {
  _pixels = null;
}

// Grayscale luminance at integer pixel (x, y), clamped to image bounds
function luma(x, y) {
  const xi = x | 0, yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= _iw || yi >= _ih) return 0;
  const i = (yi * _iw + xi) << 2;
  return (_pixels[i] * 77 + _pixels[i + 1] * 150 + _pixels[i + 2] * 29) >> 8;
}

// Sobel gradient magnitude and angle at (x, y)
function sobel(x, y) {
  const gx =
    -luma(x-1,y-1) + luma(x+1,y-1) +
    -2*luma(x-1,y) + 2*luma(x+1,y) +
    -luma(x-1,y+1) + luma(x+1,y+1);
  const gy =
    -luma(x-1,y-1) - 2*luma(x,y-1) - luma(x+1,y-1) +
     luma(x-1,y+1) + 2*luma(x,y+1) + luma(x+1,y+1);
  return { mag: Math.sqrt(gx*gx + gy*gy), angle: Math.atan2(gy, gx) };
}

// Parabola fit: sub-pixel offset from 3 samples at -1, 0, +1
function parabolaOffset(gm, g0, gp) {
  const denom = 2 * (gp - 2*g0 + gm);
  if (Math.abs(denom) < 1e-6) return 0;
  return Math.max(-1, Math.min(1, -(gp - gm) / denom));
}

// Gaussian fit: more robust for soft/asymmetric peaks
function gaussianOffset(gm, g0, gp) {
  if (gm <= 0 || g0 <= 0 || gp <= 0) return parabolaOffset(gm, g0, gp);
  const lm = Math.log(gm), l0 = Math.log(g0), lp = Math.log(gp);
  const denom = 2 * (lp - 2*l0 + lm);
  if (Math.abs(denom) < 1e-6) return 0;
  return Math.max(-1, Math.min(1, -(lp - lm) / denom));
}

/**
 * Refine a cursor position to the nearest sub-pixel edge.
 *
 * @param {number} cx - cursor X in image pixels
 * @param {number} cy - cursor Y in image pixels
 * @param {number} searchRadius - search radius in image pixels
 * @param {string} method - "parabola-js" or "gaussian-js"
 * @returns {{ x, y, magnitude }} or null if no strong edge found
 */
export function refinePointJS(cx, cy, searchRadius, method) {
  if (!_pixels) return null;

  const r = Math.max(2, Math.round(searchRadius));
  let bestMag = 0, bestX = Math.round(cx), bestY = Math.round(cy), bestAngle = 0;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const ix = Math.round(cx) + dx;
      const iy = Math.round(cy) + dy;
      const { mag, angle } = sobel(ix, iy);
      if (mag > bestMag) { bestMag = mag; bestX = ix; bestY = iy; bestAngle = angle; }
    }
  }

  if (bestMag < 20) return null; // edge too faint

  // Sub-pixel refinement along the gradient direction
  const cos = Math.cos(bestAngle);
  const sin = Math.sin(bestAngle);
  const gm = sobel(Math.round(bestX - cos), Math.round(bestY - sin)).mag;
  const gp = sobel(Math.round(bestX + cos), Math.round(bestY + sin)).mag;

  const offset = method === 'gaussian-js'
    ? gaussianOffset(gm, bestMag, gp)
    : parabolaOffset(gm, bestMag, gp);

  return { x: bestX + offset * cos, y: bestY + offset * sin, magnitude: bestMag };
}
