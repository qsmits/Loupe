// Client-side sub-pixel edge snapping using cached ImageData.
// Replaces the server-side /refine-point call when subpixel_method is
// "parabola-js" or "gaussian-js". Works entirely in the browser using
// the frozen image pixel data — no network round-trip, instant response.

// Minimum 5x5-Sobel gradient magnitude for a snap: 5 grey levels across a step
// (48 per grey level). Shared with events-mouse.js / tools.js and mirrored by
// backend/vision/subpixel.py; compared with `mag <= SNAP_MIN_MAGNITUDE` rejecting.
export const SNAP_MIN_MAGNITUDE = 240;

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

/**
 * Map the user's subpixel setting to a value safe to POST to the backend.
 * The backend only knows "none"/"parabola"/"gaussian"; the "-js" variants
 * are browser-only (applied during manual clicks in tools.js). Anywhere we
 * hand a subpixel method to the server, route it through this first.
 */
export function serverSubpixelMethod(method) {
  if (method === "parabola-js") return "parabola";
  if (method === "gaussian-js") return "gaussian";
  return method || "none";
}

// Grayscale luminance with reflected borders, matching Sobel's default border.
function luma(x, y) {
  const reflect = (v, size) => {
    if (size <= 1) return 0;
    const period = 2 * (size - 1);
    v = ((v % period) + period) % period;
    return v < size ? v : period - v;
  };
  const i = (reflect(y, _ih) * _iw + reflect(x, _iw)) * 4;
  return (_pixels[i] * 77 + _pixels[i + 1] * 150 + _pixels[i + 2] * 29) / 256;
}

function sobel(x, y) {
  const derivative = [-1, -2, 0, 2, 1], smooth = [1, 4, 6, 4, 1];
  let gx = 0, gy = 0;
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    const value = luma(x + i - 2, y + j - 2);
    gx += value * derivative[i] * smooth[j];
    gy += value * smooth[i] * derivative[j];
  }
  return { mag: Math.hypot(gx, gy), angle: Math.atan2(gy, gx) };
}

function peakOffset(gm, g0, gp, logarithmic) {
  if (g0 < gm || g0 < gp) return null;
  if (logarithmic && gm > 0 && gp > 0) {
    gm = Math.log(gm); g0 = Math.log(g0); gp = Math.log(gp);
  }
  const curvature = gm + gp - 2 * g0;
  if (curvature >= -1e-12) return null;
  const offset = (gm - gp) / (2 * curvature);
  return Math.abs(offset) <= 0.6 ? offset : null;
}

/** Refine the cursor to the nearest qualified gradient ridge. */
export function refinePointJS(cx, cy, searchRadius, method) {
  if (!_pixels || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const r = Math.max(2, Math.round(searchRadius));
  const gradients = new Map();
  const gradient = (x, y) => {
    const key = `${x},${y}`;
    if (!gradients.has(key)) gradients.set(key, sobel(x, y));
    return gradients.get(key);
  };
  // Unit-distance samples along the normal, including diagonal directions.
  const magnitude = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), wx = x - ix, wy = y - iy;
    return gradient(ix, iy).mag * (1-wx) * (1-wy) +
      gradient(ix+1, iy).mag * wx * (1-wy) +
      gradient(ix, iy+1).mag * (1-wx) * wy + gradient(ix+1, iy+1).mag * wx * wy;
  };
  const candidates = [];
  let maxMag = 0;
  for (let y = Math.max(1, Math.round(cy)-r); y <= Math.min(_ih-2, Math.round(cy)+r); y++) {
    for (let x = Math.max(1, Math.round(cx)-r); x <= Math.min(_iw-2, Math.round(cx)+r); x++) {
      const { mag, angle } = gradient(x, y);
      maxMag = Math.max(maxMag, mag);
      if (mag <= SNAP_MIN_MAGNITUDE) continue;
      const nx = Math.cos(angle), ny = Math.sin(angle);
      const offset = peakOffset(magnitude(x-nx, y-ny), mag, magnitude(x+nx, y+ny), method === 'gaussian-js');
      if (offset == null) continue;
      candidates.push({ x: x + offset * nx, y: y + offset * ny, magnitude: mag });
    }
  }
  let best = null, bestDist = Infinity;
  for (const candidate of candidates) {
    if (candidate.magnitude < maxMag * 0.15) continue;
    const distance = (candidate.x-cx)**2 + (candidate.y-cy)**2;
    if (distance < bestDist) { best = candidate; bestDist = distance; }
  }
  return best;
}
