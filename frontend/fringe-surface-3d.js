import { physicalOrientation } from './fringe-orientation.js';

export function surface3dDescription(data) {
  return physicalOrientation(data).polarity === 'unverified'
    ? 'Unverified height direction — showing recovered gap departure; bumps and hollows may be reversed.'
    : 'Part deviation (user-checked) — higher parts rise in 3D; colors match the 2D map. Overall slope and selected form are removed.';
}

// Convert only the display geometry to specimen height. Keep the measurement
// arrays and gap-based colors unchanged so corresponding regions match in 2D.
export function surface3dValues(data, heights, mask, zScale) {
  const sign = physicalOrientation(data).polarity === 'red-larger-gap' ? -1 : 1;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) if (mask[i] && Number.isFinite(heights[i])) {
    min = Math.min(min, heights[i]);
    max = Math.max(max, heights[i]);
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  const range = max - min;
  // The 2D map centers its diverging palette on zero, not the midrange.
  const colorLimit = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const z = new Float32Array(heights.length);
  const colors = new Float32Array(heights.length * 3);
  for (let i = 0; i < heights.length; i++) {
    const valid = mask[i] && Number.isFinite(heights[i]);
    const t = valid ? 0.5 + heights[i] / (2 * colorLimit) : 0.5;
    z[i] = valid && range ? sign * ((heights[i] - min) / range - 0.5) * zScale * 0.01 : 0;
    colors[i * 3] = t < 0.5 ? 0.3 + t * 1.4 : 1;
    colors[i * 3 + 1] = t < 0.5 ? 0.3 + t * 1.4 : 1 - (t - 0.5) * 1.4;
    colors[i * 3 + 2] = t < 0.5 ? 1 : 1 - (t - 0.5) * 1.4;
  }
  return { z, colors };
}
