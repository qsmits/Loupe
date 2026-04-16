/**
 * Tests for frontend/constraint-solver.js
 * Run with: node --test tests/test_constraint_solver.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lineDir,
  rotateAroundPoint,
  getAnchorPoint,
  setAnchorPoint,
  getLineDirection,
  isLineType,
  isCircleType,
  projectPerpendicular,
  projectParallel,
  projectAngle,
  projectCoincidentPoint,
  projectPointOnLine,
  projectPointOnCircle,
  projectTangentLineCircle,
  projectTangentCircleCircle,
  projectConcentric,
  projectMidpoint,
  solveConstraints,
} from '../frontend/constraint-solver.js';

// ── tolerance ────────────────────────────────────────────────────────────────
const EPS = 1e-9;

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

function assertApprox(actual, expected, eps = 1e-6, label = '') {
  if (!approx(actual, expected, eps)) {
    throw new assert.AssertionError({
      message: `${label} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
      actual,
      expected,
    });
  }
}

// ── Helper: build a simple distance annotation ────────────────────────────────
function makeLine(id, ax, ay, bx, by) {
  return { id, type: 'distance', a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

function makeCircle(id, cx, cy, r) {
  return { id, type: 'circle', cx, cy, r };
}

// ── lineDir ───────────────────────────────────────────────────────────────────
test('lineDir returns unit vector and length', () => {
  const r = lineDir({ x: 0, y: 0 }, { x: 3, y: 4 });
  assertApprox(r.dx, 3 / 5, 1e-9, 'dx');
  assertApprox(r.dy, 4 / 5, 1e-9, 'dy');
  assertApprox(r.len, 5, 1e-9, 'len');
});

test('lineDir handles zero-length (degenerate)', () => {
  const r = lineDir({ x: 1, y: 1 }, { x: 1, y: 1 });
  // len uses || 1e-12 guard so dx/dy are finite (0), not NaN
  assert.ok(isFinite(r.dx), 'dx should be finite');
  assert.ok(isFinite(r.dy), 'dy should be finite');
});

// ── rotateAroundPoint ─────────────────────────────────────────────────────────
test('rotateAroundPoint 90 degrees', () => {
  const cosA = Math.cos(Math.PI / 2);
  const sinA = Math.sin(Math.PI / 2);
  const pt = { x: 1, y: 0 };
  const pivot = { x: 0, y: 0 };
  const r = rotateAroundPoint(pt, pivot, cosA, sinA);
  assertApprox(r.x, 0, 1e-9, 'x');
  assertApprox(r.y, 1, 1e-9, 'y');
});

test('rotateAroundPoint around non-origin pivot', () => {
  const cosA = 0; // 90 deg
  const sinA = 1;
  const pt = { x: 2, y: 1 };
  const pivot = { x: 1, y: 1 };
  const r = rotateAroundPoint(pt, pivot, cosA, sinA);
  // (2-1, 1-1) = (1, 0) rotated 90deg = (0, 1), +pivot = (1, 2)
  assertApprox(r.x, 1, 1e-9, 'x');
  assertApprox(r.y, 2, 1e-9, 'y');
});

// ── getAnchorPoint / setAnchorPoint ──────────────────────────────────────────
test('getAnchorPoint returns a / b for line type', () => {
  const ann = makeLine(1, 0, 0, 10, 0);
  const a = getAnchorPoint(ann, 'a');
  assert.equal(a.x, 0);
  assert.equal(a.y, 0);
  const b = getAnchorPoint(ann, 'b');
  assert.equal(b.x, 10);
  assert.equal(b.y, 0);
});

test('getAnchorPoint returns center for circle type', () => {
  const c = makeCircle(1, 5, 7, 3);
  const ctr = getAnchorPoint(c, 'center');
  assert.equal(ctr.x, 5);
  assert.equal(ctr.y, 7);
});

test('setAnchorPoint updates a for line type', () => {
  const ann = makeLine(1, 0, 0, 10, 0);
  setAnchorPoint(ann, 'a', 2, 3);
  assert.equal(ann.a.x, 2);
  assert.equal(ann.a.y, 3);
});

test('setAnchorPoint updates center for circle type', () => {
  const c = makeCircle(1, 0, 0, 5);
  setAnchorPoint(c, 'center', 9, 8);
  assert.equal(c.cx, 9);
  assert.equal(c.cy, 8);
});

// ── isLineType / isCircleType ─────────────────────────────────────────────────
test('isLineType detects all line-ish types', () => {
  const types = ['distance', 'perp-dist', 'para-dist', 'parallelism', 'slot-dist', 'fit-line'];
  for (const t of types) {
    assert.ok(isLineType({ type: t }), `expected lineType for ${t}`);
  }
  assert.ok(!isLineType({ type: 'circle' }));
});

test('isCircleType detects all circle-ish types', () => {
  const types = ['circle', 'arc-fit', 'arc-measure'];
  for (const t of types) {
    assert.ok(isCircleType({ type: t }), `expected circleType for ${t}`);
  }
  assert.ok(!isCircleType({ type: 'distance' }));
});

// ── getLineDirection ──────────────────────────────────────────────────────────
test('getLineDirection returns unit direction for distance ann', () => {
  const ann = makeLine(1, 0, 0, 3, 4);
  const d = getLineDirection(ann);
  assertApprox(d.dx, 3 / 5, 1e-9);
  assertApprox(d.dy, 4 / 5, 1e-9);
  assertApprox(d.len, 5, 1e-9);
});

// ── projectPerpendicular ──────────────────────────────────────────────────────
test('projectPerpendicular makes follower perpendicular to driver', () => {
  // Driver is horizontal (1, 0). Follower also horizontal → should become vertical
  const driver = makeLine(1, 0, 0, 10, 0);
  const follower = makeLine(2, 5, 5, 15, 5); // also horizontal
  const driverDir = getLineDirection(driver);
  const contact = { x: 5, y: 5 }; // rotate around midpoint of follower

  projectPerpendicular(follower, driverDir, contact);

  const fd = getLineDirection(follower);
  // Dot product with driverDir should be ~0
  const dot = fd.dx * driverDir.dx + fd.dy * driverDir.dy;
  assertApprox(dot, 0, 1e-6, 'perpendicularity dot product');
});

test('projectPerpendicular preserves length', () => {
  const driver = makeLine(1, 0, 0, 10, 0);
  const follower = makeLine(2, 5, 5, 15, 5);
  const origLen = getLineDirection(follower).len;
  projectPerpendicular(follower, getLineDirection(driver), follower.a);
  const newLen = getLineDirection(follower).len;
  assertApprox(newLen, origLen, 1e-6, 'length preserved');
});

// ── projectParallel ────────────────────────────────────────────────────────────
test('projectParallel makes follower parallel to driver', () => {
  const driver = makeLine(1, 0, 0, 10, 0); // horizontal
  const follower = makeLine(2, 5, 0, 5, 10); // vertical
  const driverDir = getLineDirection(driver);

  projectParallel(follower, driverDir, follower.a);

  const fd = getLineDirection(follower);
  // cross product should be ~0 (parallel)
  const cross = fd.dx * driverDir.dy - fd.dy * driverDir.dx;
  assertApprox(cross, 0, 1e-6, 'parallelism cross product');
});

test('projectParallel preserves length', () => {
  const driver = makeLine(1, 0, 0, 10, 0);
  const follower = makeLine(2, 5, 0, 5, 10);
  const origLen = getLineDirection(follower).len;
  projectParallel(follower, getLineDirection(driver), follower.a);
  const newLen = getLineDirection(follower).len;
  assertApprox(newLen, origLen, 1e-6);
});

// ── projectAngle ──────────────────────────────────────────────────────────────
test('projectAngle sets specific angle between lines', () => {
  const driver = makeLine(1, 0, 0, 10, 0); // horizontal
  const follower = makeLine(2, 5, 5, 15, 5); // also horizontal initially
  const driverDir = getLineDirection(driver);

  projectAngle(follower, driverDir, follower.a, 45);

  const fd = getLineDirection(follower);
  const dot = fd.dx * driverDir.dx + fd.dy * driverDir.dy;
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.abs(dot)))) * 180 / Math.PI;
  assertApprox(angle, 45, 1e-4, 'angle');
});

test('projectAngle 0 deg = parallel', () => {
  const driver = makeLine(1, 0, 0, 10, 0);
  const follower = makeLine(2, 5, 0, 5, 10); // vertical
  const driverDir = getLineDirection(driver);

  projectAngle(follower, driverDir, follower.a, 0);

  const fd = getLineDirection(follower);
  const cross = fd.dx * driverDir.dy - fd.dy * driverDir.dx;
  assertApprox(cross, 0, 1e-6, 'parallel cross = 0');
});

test('projectAngle 90 deg = perpendicular', () => {
  const driver = makeLine(1, 0, 0, 10, 0);
  const follower = makeLine(2, 5, 5, 15, 5);
  const driverDir = getLineDirection(driver);

  projectAngle(follower, driverDir, follower.a, 90);

  const fd = getLineDirection(follower);
  const dot = fd.dx * driverDir.dx + fd.dy * driverDir.dy;
  assertApprox(dot, 0, 1e-6, 'perp dot = 0');
});

// ── projectCoincidentPoint ────────────────────────────────────────────────────
test('projectCoincidentPoint moves follower to driver', () => {
  const driver = { x: 7, y: 3 };
  const follower = { x: 1, y: 1 };
  projectCoincidentPoint(follower, driver);
  assert.equal(follower.x, 7);
  assert.equal(follower.y, 3);
});

// ── projectPointOnLine ────────────────────────────────────────────────────────
test('projectPointOnLine projects onto horizontal line', () => {
  const pt = { x: 5, y: 7 };
  projectPointOnLine(pt, { x: 0, y: 0 }, { dx: 1, dy: 0, len: 1 });
  assertApprox(pt.x, 5, 1e-9);
  assertApprox(pt.y, 0, 1e-9);
});

test('projectPointOnLine projects onto diagonal line', () => {
  // Line through origin with dir (1,1)/sqrt2
  const pt = { x: 0, y: 4 };
  const dir = lineDir({ x: 0, y: 0 }, { x: 1, y: 1 });
  projectPointOnLine(pt, { x: 0, y: 0 }, dir);
  // Projection of (0,4) onto y=x line is (2,2)
  assertApprox(pt.x, 2, 1e-6);
  assertApprox(pt.y, 2, 1e-6);
});

// ── projectPointOnCircle ──────────────────────────────────────────────────────
test('projectPointOnCircle moves point to circumference', () => {
  const circle = { cx: 0, cy: 0, r: 5 };
  const pt = { x: 3, y: 4 };
  projectPointOnCircle(pt, circle);
  const dist = Math.hypot(pt.x - circle.cx, pt.y - circle.cy);
  assertApprox(dist, 5, 1e-6, 'on circumference');
  // Direction preserved
  assertApprox(pt.x, 3, 1e-6, 'x direction');
  assertApprox(pt.y, 4, 1e-6, 'y direction');
});

test('projectPointOnCircle point at center → place at +x', () => {
  const circle = { cx: 2, cy: 3, r: 5 };
  const pt = { x: 2, y: 3 }; // at center
  projectPointOnCircle(pt, circle);
  assertApprox(pt.x, 7, 1e-6, 'placed at +x = cx+r');
  assertApprox(pt.y, 3, 1e-6, 'y unchanged');
});

test('projectPointOnCircle point outside circle → still on circumference', () => {
  const circle = { cx: 0, cy: 0, r: 3 };
  const pt = { x: 10, y: 0 };
  projectPointOnCircle(pt, circle);
  assertApprox(pt.x, 3, 1e-6);
  assertApprox(pt.y, 0, 1e-6);
});

// ── projectTangentLineCircle ──────────────────────────────────────────────────
test('projectTangentLineCircle moves circle to touch horizontal line', () => {
  // Horizontal line through origin: origin=(0,0), dir=(1,0)
  // Normal is (0,-1) — line normal points "down" in image convention
  const circle = { cx: 3, cy: 10, r: 2 };
  const lineOrigin = { x: 0, y: 0 };
  const lineDir_ = { dx: 1, dy: 0, len: 1 };
  projectTangentLineCircle(circle, lineOrigin, lineDir_);
  // Circle should touch line (y=0), so cy should be ±r
  const distToLine = Math.abs(circle.cy - 0);
  assertApprox(distToLine, circle.r, 1e-6, 'circle touches line');
});

test('projectTangentLineCircle: cx unchanged, only cy shifts', () => {
  const circle = { cx: 5, cy: 8, r: 3 };
  const origCx = circle.cx;
  projectTangentLineCircle(circle, { x: 0, y: 0 }, { dx: 1, dy: 0, len: 1 });
  assertApprox(circle.cx, origCx, 1e-9, 'cx unchanged');
});

// ── projectTangentCircleCircle ────────────────────────────────────────────────
test('projectTangentCircleCircle makes circles externally tangent', () => {
  const driver = { cx: 0, cy: 0, r: 3 };
  const follower = { cx: 10, cy: 0, r: 2 };
  projectTangentCircleCircle(follower, driver);
  const dist = Math.hypot(follower.cx - driver.cx, follower.cy - driver.cy);
  assertApprox(dist, driver.r + follower.r, 1e-6, 'centers = sum of radii');
});

test('projectTangentCircleCircle direction preserved', () => {
  const driver = { cx: 0, cy: 0, r: 3 };
  const follower = { cx: 0, cy: 10, r: 2 };
  projectTangentCircleCircle(follower, driver);
  // follower should be above driver
  assert.ok(follower.cy > 0, 'follower above driver');
  assertApprox(follower.cx, 0, 1e-6, 'cx unchanged');
});

// ── projectConcentric ─────────────────────────────────────────────────────────
test('projectConcentric moves follower center to driver center', () => {
  const driver = { cx: 4, cy: 7 };
  const follower = { cx: 0, cy: 0, r: 3 };
  projectConcentric(follower, driver);
  assertApprox(follower.cx, 4, 1e-9);
  assertApprox(follower.cy, 7, 1e-9);
});

// ── projectMidpoint ───────────────────────────────────────────────────────────
test('projectMidpoint moves point to midpoint of segment', () => {
  const lineA = { x: 0, y: 0 };
  const lineB = { x: 10, y: 4 };
  const pt = { x: 99, y: 99 };
  projectMidpoint(pt, lineA, lineB);
  assertApprox(pt.x, 5, 1e-9);
  assertApprox(pt.y, 2, 1e-9);
});

// ── solveConstraints ──────────────────────────────────────────────────────────

function makeAnnotations(arr) {
  return arr;
}

function makeConstraint(id, type, refs, opts = {}) {
  return { id, type, refs, enabled: true, status: 'pending', ...opts };
}

test('solveConstraints maintains perpendicularity after solve', () => {
  const ann1 = makeLine(1, 0, 0, 10, 0);   // horizontal — driver
  const ann2 = makeLine(2, 0, 0, 0, 10);   // vertical — already perp (edge case: confirm stays)

  // Perturb ann2 to be non-perpendicular
  ann2.b = { x: 5, y: 10 };

  const annotations = [ann1, ann2];
  const constraints = [
    makeConstraint(1, 'perpendicular', [
      { annId: 1, anchor: 'a' },
      { annId: 2, anchor: 'a' },
    ]),
  ];

  solveConstraints(annotations, constraints, null);

  const d1 = getLineDirection(ann1);
  const d2 = getLineDirection(ann2);
  const dot = d1.dx * d2.dx + d1.dy * d2.dy;
  assertApprox(dot, 0, 1e-4, 'perpendicular after solve');
  assert.equal(constraints[0].status, 'ok');
});

test('solveConstraints: disabled constraint is skipped', () => {
  const ann1 = makeLine(1, 0, 0, 10, 0);   // horizontal
  const ann2 = makeLine(2, 0, 0, 5, 10);   // diagonal — NOT perp

  const annotations = [ann1, ann2];
  const constraints = [
    { id: 1, type: 'perpendicular', refs: [
      { annId: 1, anchor: 'a' },
      { annId: 2, anchor: 'a' },
    ], enabled: false, status: 'pending' },
  ];

  const origB = { ...ann2.b };
  solveConstraints(annotations, constraints, null);

  // ann2 should be unchanged since constraint is disabled
  assertApprox(ann2.b.x, origB.x, 1e-9);
  assertApprox(ann2.b.y, origB.y, 1e-9);
  // status should remain 'pending' (not touched)
  assert.equal(constraints[0].status, 'pending');
});

test('solveConstraints: missing annotation → status conflict', () => {
  const ann1 = makeLine(1, 0, 0, 10, 0);
  const annotations = [ann1];
  const constraints = [
    makeConstraint(1, 'perpendicular', [
      { annId: 1, anchor: 'a' },
      { annId: 999, anchor: 'a' }, // doesn't exist
    ]),
  ];

  solveConstraints(annotations, constraints, null);
  assert.equal(constraints[0].status, 'conflict');
});

test('solveConstraints: dragged annotation is immutable (driver)', () => {
  const ann1 = makeLine(1, 0, 0, 10, 0);   // horizontal — will be dragged
  const ann2 = makeLine(2, 0, 0, 5, 10);   // follower

  const origAnn1 = { a: { ...ann1.a }, b: { ...ann1.b } };

  const annotations = [ann1, ann2];
  const constraints = [
    makeConstraint(1, 'perpendicular', [
      { annId: 1, anchor: 'a' },
      { annId: 2, anchor: 'a' },
    ]),
  ];

  solveConstraints(annotations, constraints, 1 /* ann1 is dragged */);

  // ann1 should NOT have changed
  assertApprox(ann1.a.x, origAnn1.a.x, 1e-9, 'ann1.a.x');
  assertApprox(ann1.b.x, origAnn1.b.x, 1e-9, 'ann1.b.x');
  assertApprox(ann1.b.y, origAnn1.b.y, 1e-9, 'ann1.b.y');
});

test('solveConstraints: parallel constraint', () => {
  const ann1 = makeLine(1, 0, 0, 10, 0);     // horizontal
  const ann2 = makeLine(2, 5, 5, 5, 15);     // vertical — should become parallel (horizontal)

  const annotations = [ann1, ann2];
  const constraints = [
    makeConstraint(1, 'parallel', [
      { annId: 1, anchor: 'a' },
      { annId: 2, anchor: 'a' },
    ]),
  ];

  solveConstraints(annotations, constraints, null);

  const d1 = getLineDirection(ann1);
  const d2 = getLineDirection(ann2);
  const cross = d1.dx * d2.dy - d1.dy * d2.dx;
  assertApprox(cross, 0, 1e-4, 'parallel cross = 0');
  assert.equal(constraints[0].status, 'ok');
});

test('solveConstraints: coincident constraint', () => {
  const ann1 = makeLine(1, 0, 0, 10, 0);  // driver
  const ann2 = makeLine(2, 5, 5, 15, 5);  // follower — point a should go to ann1.a

  const annotations = [ann1, ann2];
  const constraints = [
    makeConstraint(1, 'coincident', [
      { annId: 1, anchor: 'a' },
      { annId: 2, anchor: 'a' },
    ]),
  ];

  solveConstraints(annotations, constraints, null);

  assertApprox(ann2.a.x, ann1.a.x, 1e-4);
  assertApprox(ann2.a.y, ann1.a.y, 1e-4);
  assert.equal(constraints[0].status, 'ok');
});

test('solveConstraints: concentric constraint', () => {
  const ann1 = makeCircle(1, 5, 5, 10);  // driver
  const ann2 = makeCircle(2, 0, 0, 3);   // follower — should move to same center

  const annotations = [ann1, ann2];
  const constraints = [
    makeConstraint(1, 'concentric', [
      { annId: 1, anchor: 'center' },
      { annId: 2, anchor: 'center' },
    ]),
  ];

  solveConstraints(annotations, constraints, null);

  assertApprox(ann2.cx, 5, 1e-4);
  assertApprox(ann2.cy, 5, 1e-4);
  assert.equal(constraints[0].status, 'ok');
});

test('length is preserved after perpendicular projection', () => {
  const ann1 = makeLine(1, 0, 0, 6, 8);   // length 10
  const ann2 = makeLine(2, 0, 0, 10, 0);  // horizontal length 10
  const origLen = getLineDirection(ann2).len;

  projectPerpendicular(ann2, getLineDirection(ann1), ann2.a);

  const newLen = getLineDirection(ann2).len;
  assertApprox(newLen, origLen, 1e-6, 'length preserved after perp projection');
});

test('contradictory constraints (perpendicular + parallel) produce conflict', () => {
  const ann1 = makeLine(1, 0, 0, 10, 0);
  const ann2 = makeLine(2, 0, 5, 10, 5);

  const constraints = [
    makeConstraint(1, 'perpendicular', [
      { annId: 1, anchor: 'a' }, { annId: 2, anchor: 'a' },
    ]),
    makeConstraint(2, 'parallel', [
      { annId: 1, anchor: 'a' }, { annId: 2, anchor: 'a' },
    ]),
  ];

  solveConstraints([ann1, ann2], constraints, null);

  // At least one must be in conflict — they can't both be satisfied
  const statuses = constraints.map(c => c.status);
  assert.ok(statuses.includes('conflict'),
    `at least one constraint should conflict, got: ${statuses}`);
});

test('projectAngle with obtuse angle (135°)', () => {
  const driver = makeLine(1, 0, 0, 10, 0);   // horizontal
  const follower = makeLine(2, 0, 0, 10, 0);  // starts horizontal
  const driverDir = getLineDirection(driver);

  projectAngle(follower, driverDir, follower.a, 135);

  const fDir = getLineDirection(follower);
  const dot = driverDir.dx * fDir.dx + driverDir.dy * fDir.dy;
  assertApprox(dot, Math.cos(135 * Math.PI / 180), 1e-6, '135° angle');
});

test('tangent-line-circle works when circle is driver (line moves)', () => {
  const circle = makeCircle(1, 0, 8, 3);      // center at (0,8), r=3
  const line = makeLine(2, -10, 0, 10, 0);     // horizontal at y=0

  const constraints = [
    makeConstraint(1, 'tangent-line-circle', [
      { annId: 1, anchor: 'center' }, { annId: 2, anchor: 'a' },
    ]),
  ];

  // Circle is driver (being dragged)
  solveConstraints([circle, line], constraints, 1);

  // Line should move so distance from circle center to line = r
  const dir = getLineDirection(line);
  const nx = -dir.dy, ny = dir.dx;
  const signedDist = (circle.cx - line.a.x) * nx + (circle.cy - line.a.y) * ny;
  assertApprox(Math.abs(signedDist), circle.r, 1e-4, 'line tangent to circle');
  assert.equal(constraints[0].status, 'ok');
});
