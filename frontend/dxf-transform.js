/**
 * dxf-transform.js — pure DXF→canvas transform math for the overlay.
 *
 * Extracted from render-dxf.js so it can be unit-tested in Node
 * (render-dxf.js imports DOM-bound modules and can't load outside a browser).
 *
 * INVARIANT (enforced by tests/frontend/test_dxf_transform.js): the affine
 * matrix produced by `dxfCtmOps` must map any DXF point to exactly the same
 * canvas point as `dxfToCanvasPure`. Both must match the backend authority
 * `backend/vision/line_arc_matching.py::dxf_to_image_px`: flip → rotate(+φ)
 * → scale + Y-flip → origin rotation → offset. If you change one, change all.
 */

/**
 * Ordered Canvas-2D transform ops (as applied via ctx.translate/rotate/scale,
 * composing left-to-right) that map raw DXF mm coordinates to canvas pixels.
 */
export function dxfCtmOps(ann, originAngle = 0) {
  const { offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  // dxfToCanvasPure applies, to a point: flip → rotate(+φ) → diag(scale, −scale)
  // → origin rotation → offset. As a matrix that's T·R(origin)·D(s,−s)·R(+φ)·F,
  // and CTM calls right-multiply, so they are emitted outermost-first:
  const ops = [];
  ops.push(["translate", offsetX, offsetY]);
  if (originAngle) ops.push(["rotate", originAngle]);
  ops.push(["scale", scale, -scale]);   // DXF Y-up → canvas Y-down
  if (annAngle) ops.push(["rotate", annAngle * Math.PI / 180]);
  if (flipH) ops.push(["scale", -1, 1]);
  if (flipV) ops.push(["scale", 1, -1]);
  return ops;
}

/** Apply an op list from dxfCtmOps to a Canvas-2D-like context. */
export function applyCtmOps(ctx, ops) {
  for (const [op, a, b] of ops) {
    if (op === "translate") ctx.translate(a, b);
    else if (op === "rotate") ctx.rotate(a);
    else ctx.scale(a, b);
  }
}

/**
 * Map a single DXF point (mm, Y-up) to canvas pixels (Y-down).
 * Mirrors backend `dxf_to_image_px`: flip, rotate(+φ), scale + Y-flip,
 * then origin rotation and offset.
 */
export function dxfToCanvasPure(x, y, ann, originAngle = 0) {
  const { offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;

  const xf = flipH ? -x : x;
  const yf = flipV ? -y : y;

  const cosA = Math.cos(annAngle * Math.PI / 180);
  const sinA = Math.sin(annAngle * Math.PI / 180);
  const xr = xf * cosA - yf * sinA;
  const yr = xf * sinA + yf * cosA;

  let cx = xr * scale;
  let cy = -yr * scale;

  if (originAngle) {
    const cos2 = Math.cos(originAngle), sin2 = Math.sin(originAngle);
    [cx, cy] = [cx * cos2 - cy * sin2, cx * sin2 + cy * cos2];
  }

  return { x: offsetX + cx, y: offsetY + cy };
}
