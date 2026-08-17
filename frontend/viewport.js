// ── Viewport state for zoom & pan ─────────────────────────────────────────
// All annotation coordinates are in image-space. The viewport transforms
// between image-space and screen-space (canvas pixels on screen).
// At zoom=1 and pan=(0,0), transforms are identity — no visible change.

export const viewport = {
  zoom: 1.0,    // scale factor (1.0 = fit-to-window)
  panX: 0,      // image-space X offset of viewport's top-left corner
  panY: 0,      // image-space Y offset of viewport's top-left corner
};

export let imageWidth = 0;
export let imageHeight = 0;

export function setImageSize(w, h) {
  imageWidth = w;
  imageHeight = h;
}

/** Guard for seeding imageWidth/imageHeight from a DOM rect (the
 * render.js::resizeCanvas fallback). Seeding from a hidden or collapsed
 * container bakes letterbox/zero dimensions into image-space and shifts
 * every annotation (aspect-ratio bug, Track A #5).
 * PERMANENT — Track B keeps this as the hidden-DOM guard.
 * @param {number} rectW  viewer rect width in CSS px
 * @param {number} rectH  viewer rect height in CSS px
 * @param {boolean} containerHidden  true when #mode-microscope is hidden
 * @returns {boolean} true when seeding is safe
 */
export function canSeedImageSize(rectW, rectH, containerHidden) {
  if (containerHidden) return false;
  return rectW >= 2 && rectH >= 2;
}

/** Should a camera's reported resolution become the workspace image size?
 *
 * Live view: yes — annotations are kept in camera-pixel coordinates from the
 * start so nothing shifts at freeze time.
 *
 * Frozen: never. A loaded, pasted or frozen image owns the coordinate frame.
 * Adopting camera dimensions there restretches the image under annotations
 * that keep their old coordinates, silently detaching every measurement and
 * invalidating any calibration — and the damage is autosaved.
 *
 * @param {number} camW  camera width from /camera/info
 * @param {number} camH  camera height from /camera/info
 * @param {number} curW  current imageWidth
 * @param {number} curH  current imageHeight
 * @param {boolean} frozen  state.frozen
 * @returns {boolean}
 */
export function shouldAdoptCameraImageSize(camW, camH, curW, curH, frozen) {
  if (frozen) return false;
  if (!(camW > 0) || !(camH > 0)) return false;
  return camW !== curW || camH !== curH;
}

/** Pure version — takes viewport as parameter (for testing) */
export function imageToScreenPure(x, y, vp) {
  return { x: (x - vp.panX) * vp.zoom, y: (y - vp.panY) * vp.zoom };
}

export function screenToImagePure(x, y, vp) {
  return { x: x / vp.zoom + vp.panX, y: y / vp.zoom + vp.panY };
}

/** Image-space → screen-space (for rendering outside viewport transform) */
export function imageToScreen(x, y) { return imageToScreenPure(x, y, viewport); }

/** Screen-space → image-space (for mouse events) */
export function screenToImage(x, y) { return screenToImagePure(x, y, viewport); }

/** Reset viewport to fit the full image in the canvas, centered on both axes.
 * When canvas aspect ≠ image aspect the letterboxed axis gets a negative pan
 * (equal margins on both sides); with matching aspects this is exactly (0,0). */
export function fitToWindow(canvasWidth, canvasHeight) {
  if (imageWidth === 0 || imageHeight === 0) return;
  viewport.zoom = Math.min(canvasWidth / imageWidth, canvasHeight / imageHeight);
  viewport.panX = (imageWidth - canvasWidth / viewport.zoom) / 2;
  viewport.panY = (imageHeight - canvasHeight / viewport.zoom) / 2;
}

/** Set zoom to show 1:1 pixels, centered */
export function zoomOneToOne(canvasCssWidth, canvasCssHeight) {
  if (imageWidth === 0) return;
  viewport.zoom = 1.0;
  const visibleW = canvasCssWidth;
  const visibleH = canvasCssHeight;
  viewport.panX = (imageWidth - visibleW) / 2;
  viewport.panY = (imageHeight - visibleH) / 2;
}

/** Clamp pan so the image doesn't scroll completely off-screen.
 * Axes where the visible extent covers the whole image are locked centered;
 * zoomed-in axes keep a ±10% margin of scroll past the image edge. */
export function clampPan(canvasCssWidth, canvasCssHeight) {
  const margin = 0.1;
  const visibleW = canvasCssWidth / viewport.zoom;
  const visibleH = canvasCssHeight / viewport.zoom;
  if (visibleW >= imageWidth) {
    viewport.panX = (imageWidth - visibleW) / 2;
  } else {
    const maxPanX = imageWidth - visibleW * (1 - margin);
    viewport.panX = Math.max(-visibleW * margin, Math.min(maxPanX, viewport.panX));
  }
  if (visibleH >= imageHeight) {
    viewport.panY = (imageHeight - visibleH) / 2;
  } else {
    const maxPanY = imageHeight - visibleH * (1 - margin);
    viewport.panY = Math.max(-visibleH * margin, Math.min(maxPanY, viewport.panY));
  }
}
