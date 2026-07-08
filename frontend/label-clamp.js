// label-clamp.js — pure geometry for keeping annotation labels on screen.
//
// Used by render.js::drawMeasurementLabel (Track A #2): when a label's
// natural anchor is outside the visible viewport (e.g. the diameter label of
// a large fitted circle), the label box is translated back into view and a
// leader line is drawn to the true anchor. All coordinates share one space
// (image-space in practice); the function is unit-agnostic and DOM-free so
// it can be tested with node --test.

/**
 * Compute the translation that moves `box` inside `view`, inset by `pad`.
 *
 * @param {{x:number, y:number, w:number, h:number}} box - label rect (top-left + size)
 * @param {{left:number, top:number, right:number, bottom:number}} view - visible area
 * @param {number} [pad=0] - inset from the view edges (same units as box/view)
 * @returns {{dx:number, dy:number, clamped:boolean}} translation to apply;
 *   clamped=false means the box was already fully visible (dx=dy=0).
 */
export function clampBoxToView(box, view, pad = 0) {
  const dx = _axisShift(box.x, box.w, view.left + pad, view.right - pad);
  const dy = _axisShift(box.y, box.h, view.top + pad, view.bottom - pad);
  return { dx, dy, clamped: dx !== 0 || dy !== 0 };
}

/** 1-D clamp: shift [pos, pos+size] into [lo, hi]; center when it can't fit. */
function _axisShift(pos, size, lo, hi) {
  if (size >= hi - lo) return (lo + hi) / 2 - (pos + size / 2); // too big: center
  if (pos < lo) return lo - pos;
  if (pos + size > hi) return hi - (pos + size);
  return 0;
}
