/**
 * Tests for frontend/math.js using Node's built-in test runner.
 * Run with: node --test tests/frontend/test_math.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub `alert` before importing the module (parseDistanceInput calls it on bad input)
globalThis.alert = () => {};

// Resolve path relative to project root so this can be run from any cwd
import { parseDistanceInput, fitCircle, fitCircleAlgebraic, polygonArea, distPointToSegment, fitLine }
  from '../../frontend/math.js';

// ── parseDistanceInput ────────────────────────────────────────────────────────

test('parseDistanceInput: plain mm', () => {
  const r = parseDistanceInput('1.5 mm');
  assert.equal(r.value, 1.5);
  assert.equal(r.unit, 'mm');
  assert.equal(r.mm, 1.5);
});

test('parseDistanceInput: mm no space', () => {
  const r = parseDistanceInput('0.5mm');
  assert.equal(r.value, 0.5);
  assert.equal(r.unit, 'mm');
  assert.equal(r.mm, 0.5);
});

test('parseDistanceInput: µm (unicode)', () => {
  const r = parseDistanceInput('500 µm');
  assert.equal(r.value, 500);
  assert.equal(r.unit, 'µm');
  assert.ok(Math.abs(r.mm - 0.5) < 1e-10, `expected 0.5 mm, got ${r.mm}`);
});

test('parseDistanceInput: um alias normalised to µm', () => {
  const r = parseDistanceInput('250um');
  assert.equal(r.unit, 'µm');
  assert.ok(Math.abs(r.mm - 0.25) < 1e-10);
});

test('parseDistanceInput: no unit defaults to mm', () => {
  const r = parseDistanceInput('3');
  assert.equal(r.unit, 'mm');
  assert.equal(r.mm, 3);
});

test('parseDistanceInput: leading/trailing whitespace is trimmed', () => {
  const r = parseDistanceInput('  2 mm  ');
  assert.equal(r.mm, 2);
});

test('parseDistanceInput: invalid input returns null', () => {
  const r = parseDistanceInput('abc');
  assert.equal(r, null);
});

test('parseDistanceInput: negative value returns null (no sign support)', () => {
  const r = parseDistanceInput('-1 mm');
  assert.equal(r, null);
});

// ── fitCircle ────────────────────────────────────────────────────────────────

const EPS = 1e-9;

function assertClose(actual, expected, eps = EPS, label = '') {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${label}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

test('fitCircle: unit circle centred at origin', () => {
  const r = fitCircle({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 });
  assertClose(r.cx, 0, 1e-9, 'cx');
  assertClose(r.cy, 0, 1e-9, 'cy');
  assertClose(r.r,  1, 1e-9, 'r');
});

test('fitCircle: circle offset from origin', () => {
  // Circle centre (3, 4), radius 5 — 3-4-5 Pythagorean circle
  const cx0 = 3, cy0 = 4, r0 = 5;
  const p1 = { x: cx0 + r0, y: cy0 };
  const p2 = { x: cx0,       y: cy0 + r0 };
  const p3 = { x: cx0 - r0, y: cy0 };
  const res = fitCircle(p1, p2, p3);
  assertClose(res.cx, cx0, 1e-9, 'cx');
  assertClose(res.cy, cy0, 1e-9, 'cy');
  assertClose(res.r,  r0,  1e-9, 'r');
});

test('fitCircle: collinear points throw', () => {
  assert.throws(
    () => fitCircle({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }),
    /collinear/i
  );
});

// ── fitCircleAlgebraic ────────────────────────────────────────────────────────

function circlePoints(cx, cy, r, n = 8) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

test('fitCircleAlgebraic: many points on circle', () => {
  const pts = circlePoints(10, -5, 7, 12);
  const res = fitCircleAlgebraic(pts);
  assert.ok(res !== null);
  assertClose(res.cx, 10,  1e-4, 'cx');
  assertClose(res.cy, -5,  1e-4, 'cy');
  assertClose(res.r,   7,  1e-4, 'r');
});

test('fitCircleAlgebraic: fewer than 3 points returns null', () => {
  assert.equal(fitCircleAlgebraic([]), null);
  assert.equal(fitCircleAlgebraic([{ x: 0, y: 0 }]), null);
  assert.equal(fitCircleAlgebraic([{ x: 0, y: 0 }, { x: 1, y: 0 }]), null);
});

test('fitCircleAlgebraic: collinear points returns null', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 3 },
    { x: 4, y: 4 },
  ];
  const res = fitCircleAlgebraic(pts);
  assert.equal(res, null);
});

test('fitCircleAlgebraic: unit circle', () => {
  const pts = circlePoints(0, 0, 1, 16);
  const res = fitCircleAlgebraic(pts);
  assert.ok(res !== null);
  assertClose(res.r, 1, 1e-4, 'r');
  assertClose(res.cx, 0, 1e-4, 'cx');
  assertClose(res.cy, 0, 1e-4, 'cy');
});

// ── polygonArea ───────────────────────────────────────────────────────────────

test('polygonArea: unit square = 1', () => {
  const sq = [
    { x: 0, y: 0 }, { x: 1, y: 0 },
    { x: 1, y: 1 }, { x: 0, y: 1 },
  ];
  assertClose(polygonArea(sq), 1, 1e-10, 'unit square');
});

test('polygonArea: right triangle base=3 height=4 = 6', () => {
  const tri = [
    { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 4 },
  ];
  assertClose(polygonArea(tri), 6, 1e-10, 'right triangle');
});

test('polygonArea: degenerate (all same point) = 0', () => {
  const pts = [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }];
  assertClose(polygonArea(pts), 0, 1e-10, 'degenerate');
});

test('polygonArea: winding order does not matter (abs value)', () => {
  const cw  = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
  const ccw = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.equal(polygonArea(cw), polygonArea(ccw));
});

// ── distPointToSegment ────────────────────────────────────────────────────────

test('distPointToSegment: point ON segment = 0', () => {
  const d = distPointToSegment({ x: 0.5, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assertClose(d, 0, 1e-10, 'on segment');
});

test('distPointToSegment: perpendicular from point to horizontal segment', () => {
  // Point is directly above midpoint at height 3
  const d = distPointToSegment({ x: 0.5, y: 3 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assertClose(d, 3, 1e-10, 'perpendicular');
});

test('distPointToSegment: beyond endpoint clamps to nearest endpoint', () => {
  // Point at (5, 0), segment from (0,0) to (1,0) — nearest is (1,0), dist=4
  const d = distPointToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assertClose(d, 4, 1e-10, 'beyond end');
});

test('distPointToSegment: before start endpoint clamps to start', () => {
  const d = distPointToSegment({ x: -3, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assertClose(d, 3, 1e-10, 'before start');
});

test('distPointToSegment: zero-length segment returns distance to that point', () => {
  const d = distPointToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
  assertClose(d, 5, 1e-10, 'zero-length segment');
});

// ── fitLine ──────────────────────────────────────────────────────────────────

test('fitLine: fewer than 2 points returns null', () => {
  assert.equal(fitLine([]), null);
  assert.equal(fitLine([{ x: 0, y: 0 }]), null);
});

test('fitLine: horizontal line — dy close to 0', () => {
  const pts = [{ x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }];
  const res = fitLine(pts);
  assert.ok(res !== null);
  // Centre should be mid-x, y=2
  assertClose(res.cy, 2, 1e-10, 'cy');
  assertClose(res.cx, 1.5, 1e-10, 'cx');
  // Direction vector: dx should be ~1, dy ~0 (or flipped)
  assertClose(Math.abs(res.dx), 1, 1e-10, '|dx|');
  assertClose(Math.abs(res.dy), 0, 1e-10, '|dy|');
});

test('fitLine: vertical line — dx close to 0', () => {
  const pts = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }];
  const res = fitLine(pts);
  assert.ok(res !== null);
  assertClose(res.cx, 5, 1e-10, 'cx');
  assertClose(res.cy, 1.5, 1e-10, 'cy');
  assertClose(Math.abs(res.dy), 1, 1e-10, '|dy|');
  assertClose(Math.abs(res.dx), 0, 1e-10, '|dx|');
});

test('fitLine: two-point line endpoints match', () => {
  const pts = [{ x: 0, y: 0 }, { x: 4, y: 3 }];
  const res = fitLine(pts);
  assert.ok(res !== null);
  // The endpoints should cover both input points (in some order)
  const len = Math.hypot(res.x2 - res.x1, res.y2 - res.y1);
  assertClose(len, 5, 1e-9, 'segment length');
});

test('fitLine: result has expected shape', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
  const res = fitLine(pts);
  assert.ok(res !== null);
  for (const key of ['cx', 'cy', 'dx', 'dy', 'x1', 'y1', 'x2', 'y2']) {
    assert.equal(typeof res[key], 'number', `key ${key} should be a number`);
  }
});
