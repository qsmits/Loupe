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

/** Image-space → screen-space (for rendering outside viewport transform) */
export function imageToScreen(x, y) {
  return {
    x: (x - viewport.panX) * viewport.zoom,
    y: (y - viewport.panY) * viewport.zoom,
  };
}

/** Screen-space → image-space (for mouse events) */
export function screenToImage(x, y) {
  return {
    x: x / viewport.zoom + viewport.panX,
    y: y / viewport.zoom + viewport.panY,
  };
}

/** Reset viewport to fit the full image in the canvas */
export function fitToWindow(canvasWidth, canvasHeight) {
  if (imageWidth === 0 || imageHeight === 0) return;
  viewport.zoom = Math.min(canvasWidth / imageWidth, canvasHeight / imageHeight);
  viewport.panX = 0;
  viewport.panY = 0;
}

/** Set zoom to show 1:1 pixels, centered */
export function zoomOneToOne(canvasCssWidth, canvasCssHeight) {
  if (imageWidth === 0) return;
  viewport.zoom = 1.0;
  const visibleW = canvasCssWidth;
  const visibleH = canvasCssHeight;
  viewport.panX = Math.max(0, (imageWidth - visibleW) / 2);
  viewport.panY = Math.max(0, (imageHeight - visibleH) / 2);
}

/** Clamp pan so the image doesn't scroll completely off-screen */
export function clampPan(canvasCssWidth, canvasCssHeight) {
  const margin = 0.1;
  const visibleW = canvasCssWidth / viewport.zoom;
  const visibleH = canvasCssHeight / viewport.zoom;
  const maxPanX = imageWidth - visibleW * (1 - margin);
  const maxPanY = imageHeight - visibleH * (1 - margin);
  viewport.panX = Math.max(-visibleW * margin, Math.min(maxPanX, viewport.panX));
  viewport.panY = Math.max(-visibleH * margin, Math.min(maxPanY, viewport.panY));
}
