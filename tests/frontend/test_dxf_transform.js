/**
 * Tests for frontend/dxf-transform.js — the DXF→canvas overlay transform.
 *
 * The DXF overlay is drawn through a Canvas-2D CTM (dxfCtmOps/applyCtmOps,
 * used by drawDxfOverlay) while callouts, nominal circles, hit-testing and
 * the rotate pivot are positioned point-by-point via dxfToCanvasPure
 * (dxfToCanvas). These MUST be the same transform, and both must match the
 * backend authority backend/vision/line_arc_matching.py::dxf_to_image_px
 * (flip → rotate(+φ) → scale + Y-flip → offset), which all inspection and
 * alignment math uses. A sign/order mismatch renders a mirror-rotated
 * overlay that detaches from its own callouts and from what the backend
 * inspects.
 *
 * Run with: node --test tests/frontend/test_dxf_transform.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dxfCtmOps, applyCtmOps, dxfToCanvasPure } from '../../frontend/dxf-transform.js';

// ── Fake Canvas-2D context: accumulates an affine matrix ────────────────────
// Matrix (a,b,c,d,e,f) maps (x,y) → (a·x + c·y + e, b·x + d·y + f).
// Each ctx call right-multiplies the CTM, exactly like Canvas 2D.

class MatrixCtx {
  constructor() { this.m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
  _mul(n) {
    const m = this.m;
    this.m = {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f,
    };
  }
  translate(tx, ty) { this._mul({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }); }
  rotate(t) {
    const cos = Math.cos(t), sin = Math.sin(t);
    this._mul({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
  }
  scale(sx, sy) { this._mul({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }); }
  apply(x, y) {
    const m = this.m;
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }
}

function ctmPoint(x, y, ann, originAngle = 0) {
  const ctx = new MatrixCtx();
  applyCtmOps(ctx, dxfCtmOps(ann, originAngle));
  return ctx.apply(x, y);
}

// Reimplementation of the backend authority (line_arc_matching.py::dxf_to_image_px).
function backendDxfToImagePx(x_mm, y_mm, ppm, tx, ty, angleRad, flipH = false, flipV = false) {
  const cx = x_mm * ppm * (flipH ? -1 : 1);
  const cy = y_mm * ppm * (flipV ? -1 : 1);
  const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
  return {
    x: cx * cosA - cy * sinA + tx,
    y: -(cx * sinA + cy * cosA) + ty,
  };
}

// ── Test grids ───────────────────────────────────────────────────────────────

const POINTS = [];
for (const x of [1, -1, 2.5, -2.5, 0]) {
  for (const y of [1, -1, 2.5, -2.5, 0]) POINTS.push({ x, y });
}
const ANGLES = [0, 30, 90, -45, 180];
const FLIPS = [
  { flipH: false, flipV: false },
  { flipH: true, flipV: false },
  { flipH: false, flipV: true },
  { flipH: true, flipV: true },
];
const PLACEMENTS = [
  { offsetX: 0, offsetY: 0, scale: 1 },
  { offsetX: 320.5, offsetY: 241.25, scale: 12.5 },
  { offsetX: 1296, offsetY: 972, scale: 457.2 },   // gear-at-watch-magnification regime
];
const TOL = 1e-9;

// ── The core desync invariant ────────────────────────────────────────────────

describe('CTM (drawDxfOverlay) ≡ dxfToCanvas (callouts, pivot, hit-testing)', () => {
  for (const place of PLACEMENTS) {
    for (const flips of FLIPS) {
      for (const angle of ANGLES) {
        const ann = { ...place, ...flips, angle };
        const label = `scale=${place.scale} flipH=${flips.flipH} flipV=${flips.flipV} φ=${angle}°`;
        it(label, () => {
          for (const p of POINTS) {
            const viaCtm = ctmPoint(p.x, p.y, ann);
            const viaFn = dxfToCanvasPure(p.x, p.y, ann);
            assert.ok(Math.abs(viaCtm.x - viaFn.x) < TOL && Math.abs(viaCtm.y - viaFn.y) < TOL,
              `point (${p.x},${p.y}): CTM → (${viaCtm.x},${viaCtm.y}) but dxfToCanvas → (${viaFn.x},${viaFn.y})`);
          }
        });
      }
    }
  }

  it('also agrees under a rotated origin (originAngle ≠ 0)', () => {
    const originAngle = 0.3;  // radians, as stored in state.origin.angle
    const ann = { offsetX: 100, offsetY: 50, scale: 7, flipH: true, flipV: false, angle: 30 };
    for (const p of POINTS) {
      const viaCtm = ctmPoint(p.x, p.y, ann, originAngle);
      const viaFn = dxfToCanvasPure(p.x, p.y, ann, originAngle);
      assert.ok(Math.abs(viaCtm.x - viaFn.x) < TOL && Math.abs(viaCtm.y - viaFn.y) < TOL,
        `point (${p.x},${p.y}): CTM → (${viaCtm.x},${viaCtm.y}) but dxfToCanvas → (${viaFn.x},${viaFn.y})`);
    }
  });
});

// ── Both must match the backend authority ────────────────────────────────────

describe('frontend transform ≡ backend dxf_to_image_px', () => {
  for (const flips of FLIPS) {
    for (const angle of ANGLES) {
      it(`flipH=${flips.flipH} flipV=${flips.flipV} φ=${angle}°`, () => {
        const ann = { offsetX: 320.5, offsetY: 241.25, scale: 12.5, ...flips, angle };
        for (const p of POINTS) {
          const be = backendDxfToImagePx(p.x, p.y, ann.scale, ann.offsetX, ann.offsetY,
            angle * Math.PI / 180, flips.flipH, flips.flipV);
          const fn = dxfToCanvasPure(p.x, p.y, ann);
          assert.ok(Math.abs(be.x - fn.x) < TOL && Math.abs(be.y - fn.y) < TOL,
            `dxfToCanvas (${fn.x},${fn.y}) != backend (${be.x},${be.y}) at (${p.x},${p.y})`);
          const ct = ctmPoint(p.x, p.y, ann);
          assert.ok(Math.abs(be.x - ct.x) < TOL && Math.abs(be.y - ct.y) < TOL,
            `CTM (${ct.x},${ct.y}) != backend (${be.x},${be.y}) at (${p.x},${p.y})`);
        }
      });
    }
  }
});

// ── Convention anchors (document the handedness explicitly) ─────────────────

describe('rotation convention anchors', () => {
  it('DXF (1,0) at φ=+90° lands at canvas (0,−1): up-screen, visually CCW', () => {
    const ann = { offsetX: 0, offsetY: 0, scale: 1, angle: 90 };
    const p = dxfToCanvasPure(1, 0, ann);
    assert.ok(Math.abs(p.x - 0) < TOL && Math.abs(p.y - (-1)) < TOL,
      `expected (0,-1), got (${p.x},${p.y})`);
    const c = ctmPoint(1, 0, ann);
    assert.ok(Math.abs(c.x - 0) < TOL && Math.abs(c.y - (-1)) < TOL,
      `CTM: expected (0,-1), got (${c.x},${c.y})`);
  });

  it('φ=0 is flip → scale + Y-flip → offset only', () => {
    const ann = { offsetX: 10, offsetY: 20, scale: 2, flipH: true, angle: 0 };
    const p = dxfToCanvasPure(3, 4, ann);
    // flipH: x=-3; scale 2: (-6, 8); Y-flip: (-6, -8); offset: (4, 12)
    assert.ok(Math.abs(p.x - 4) < TOL && Math.abs(p.y - 12) < TOL,
      `expected (4,12), got (${p.x},${p.y})`);
  });
});
