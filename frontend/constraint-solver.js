/**
 * constraint-solver.js — Pure geometry constraint solver (zero DOM dependencies)
 *
 * Implements 10 projection functions + iterative Gauss-Seidel solver.
 * Annotation structure mirrors the main app's annotation objects:
 *   - Line-type:   { type, a:{x,y}, b:{x,y} }
 *   - Circle-type: { type, cx, cy, r }
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const SOLVER_ITERATIONS = 5;
const CONVERGENCE_THRESHOLD = 1e-4;

// ── Type guards ───────────────────────────────────────────────────────────────

const LINE_TYPES = new Set([
  'distance', 'perp-dist', 'para-dist', 'parallelism', 'slot-dist', 'fit-line',
]);
const CIRCLE_TYPES = new Set(['circle', 'arc-fit', 'arc-measure']);

/** Returns true if annotation is a line-like type (has a/b endpoints). */
export function isLineType(ann) { return LINE_TYPES.has(ann.type); }

/** Returns true if annotation is a circle-like type (has cx/cy/r). */
export function isCircleType(ann) { return CIRCLE_TYPES.has(ann.type); }

// ── Anchor access ─────────────────────────────────────────────────────────────

/**
 * Returns the {x, y} point object for a named anchor on an annotation.
 * Supported anchors:
 *   - 'a', 'b' for line-types
 *   - 'center' for circle-types
 *   - 'p1', 'p2', 'p3' for arc-measure
 *   - 'pt' for pt-circle-dist
 */
export function getAnchorPoint(ann, anchor) {
  if (ann.type === 'point') return { x: ann.x, y: ann.y };
  if (anchor === 'a') return ann.a;
  if (anchor === 'b') return ann.b;
  if (anchor === 'center') return { x: ann.cx, y: ann.cy };
  if (anchor === 'p1') return ann.p1;
  if (anchor === 'p2') return ann.p2;
  if (anchor === 'p3') return ann.p3;
  if (anchor === 'pt') return { x: ann.px, y: ann.py };
  return null;
}

/**
 * Sets the {x, y} for a named anchor on an annotation (mutates in place).
 */
export function setAnchorPoint(ann, anchor, x, y) {
  if (ann.type === 'point') { ann.x = x; ann.y = y; }
  else if (anchor === 'a') { ann.a.x = x; ann.a.y = y; }
  else if (anchor === 'b') { ann.b.x = x; ann.b.y = y; }
  else if (anchor === 'center') { ann.cx = x; ann.cy = y; }
  else if (anchor === 'p1') { ann.p1.x = x; ann.p1.y = y; }
  else if (anchor === 'p2') { ann.p2.x = x; ann.p2.y = y; }
  else if (anchor === 'p3') { ann.p3.x = x; ann.p3.y = y; }
  else if (anchor === 'pt') { ann.px = x; ann.py = y; }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Returns unit direction vector and length for a line from point a to b.
 * @returns {{ dx: number, dy: number, len: number }}
 */
export function lineDir(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-12;
  return { dx: dx / len, dy: dy / len, len };
}

/**
 * Rotates point pt around pivot by (cosA, sinA). Returns new {x, y}.
 */
export function rotateAroundPoint(pt, pivot, cosA, sinA) {
  const rx = pt.x - pivot.x;
  const ry = pt.y - pivot.y;
  return {
    x: pivot.x + rx * cosA - ry * sinA,
    y: pivot.y + rx * sinA + ry * cosA,
  };
}

/**
 * Returns the unit direction vector for a line-type annotation.
 */
export function getLineDirection(ann) {
  return lineDir(ann.a, ann.b);
}

// ── Projection functions ──────────────────────────────────────────────────────

/**
 * Rotates follower line so its direction is perpendicular to driverDir.
 * Rotation around contact point. Preserves line length.
 *
 * @param {{ a:{x,y}, b:{x,y} }} follower  – mutated in place
 * @param {{ dx:number, dy:number }} driverDir – unit direction of driver
 * @param {{ x:number, y:number }} contact – pivot for rotation
 */
export function projectPerpendicular(follower, driverDir, contact) {
  // Perpendicular direction to driverDir: rotate 90° → (-dy, dx)
  const targetDx = -driverDir.dy;
  const targetDy = driverDir.dx;
  _rotateLine(follower, targetDx, targetDy, contact);
}

/**
 * Rotates follower line so its direction is parallel to driverDir.
 * Rotation around contact point. Preserves line length.
 */
export function projectParallel(follower, driverDir, contact) {
  _rotateLine(follower, driverDir.dx, driverDir.dy, contact);
}

/**
 * Rotates follower so the angle between follower and driver = angleDeg.
 * Rotation around contact point. Preserves line length.
 */
export function projectAngle(follower, driverDir, contact, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  // Target direction = rotate driverDir by angleDeg
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const targetDx = driverDir.dx * cosA - driverDir.dy * sinA;
  const targetDy = driverDir.dx * sinA + driverDir.dy * cosA;
  _rotateLine(follower, targetDx, targetDy, contact);
}

/**
 * Moves followerPt to match driverPt. Mutates followerPt in place.
 */
export function projectCoincidentPoint(followerPt, driverPt) {
  followerPt.x = driverPt.x;
  followerPt.y = driverPt.y;
}

/**
 * Projects point onto infinite line through lineOrigin with direction lineDirection.
 * Mutates point in place.
 *
 * @param {{ x:number, y:number }} point
 * @param {{ x:number, y:number }} lineOrigin
 * @param {{ dx:number, dy:number }} lineDirection – unit vector
 */
export function projectPointOnLine(point, lineOrigin, lineDirection) {
  // t = dot(point - origin, dir)
  const t = (point.x - lineOrigin.x) * lineDirection.dx +
            (point.y - lineOrigin.y) * lineDirection.dy;
  point.x = lineOrigin.x + t * lineDirection.dx;
  point.y = lineOrigin.y + t * lineDirection.dy;
}

/**
 * Projects point onto the circumference of circle.
 * Degenerate case (point at center): places at +x direction.
 * Mutates point in place.
 */
export function projectPointOnCircle(point, circle) {
  const dx = point.x - circle.cx;
  const dy = point.y - circle.cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-10) {
    // Degenerate: place at +x
    point.x = circle.cx + circle.r;
    point.y = circle.cy;
    return;
  }
  point.x = circle.cx + (dx / dist) * circle.r;
  point.y = circle.cy + (dy / dist) * circle.r;
}

/**
 * Translates circle so its circumference is tangent to the infinite line.
 * Uses signed distance to line normal — preserves which side of the line the
 * circle center is on.
 * Mutates circle in place.
 *
 * @param {{ cx:number, cy:number, r:number }} circle
 * @param {{ x:number, y:number }} lineOrigin
 * @param {{ dx:number, dy:number }} lineDirection – unit vector
 */
export function projectTangentLineCircle(circle, lineOrigin, lineDirection) {
  // Normal to line: perpendicular to direction
  const nx = -lineDirection.dy;
  const ny = lineDirection.dx;
  // Signed distance from lineOrigin to circle center along normal
  const signedDist = (circle.cx - lineOrigin.x) * nx + (circle.cy - lineOrigin.y) * ny;
  // Which side of the line is the center on?
  const sign = signedDist >= 0 ? 1 : -1;
  // Move center so |signedDist| = r
  const correction = sign * circle.r - signedDist;
  circle.cx += correction * nx;
  circle.cy += correction * ny;
}

/**
 * Translates follower circle so circumferences are externally tangent.
 * targetDist = r1 + r2.
 * Mutates follower in place.
 */
export function projectTangentCircleCircle(follower, driver) {
  const dx = follower.cx - driver.cx;
  const dy = follower.cy - driver.cy;
  const dist = Math.hypot(dx, dy);
  const targetDist = follower.r + driver.r;
  if (dist < 1e-10) {
    // Degenerate: place follower to the right
    follower.cx = driver.cx + targetDist;
    return;
  }
  follower.cx = driver.cx + (dx / dist) * targetDist;
  follower.cy = driver.cy + (dy / dist) * targetDist;
}

/**
 * Moves follower center to driver center (concentric).
 * Mutates follower in place.
 */
export function projectConcentric(follower, driver) {
  follower.cx = driver.cx;
  follower.cy = driver.cy;
}

/**
 * Moves point to midpoint of segment lineA→lineB.
 * Mutates point in place.
 */
export function projectMidpoint(point, lineA, lineB) {
  point.x = (lineA.x + lineB.x) / 2;
  point.y = (lineA.y + lineB.y) / 2;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Rotates the follower line's b endpoint around contact so the line direction
 * matches (targetDx, targetDy). Preserves line length. Mutates follower.
 */
function _rotateLine(follower, targetDx, targetDy, contact) {
  const curDir = getLineDirection(follower);
  const len = curDir.len;
  if (len < 1e-10) return;

  // Current direction angle
  const curAngle = Math.atan2(curDir.dy, curDir.dx);
  // Target angle
  const targetAngle = Math.atan2(targetDy, targetDx);
  let delta = targetAngle - curAngle;
  // Normalize to [-π, π]
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  // Lines are undirected (a→b ≡ b→a), so pick the smaller rotation
  if (delta > Math.PI / 2) delta -= Math.PI;
  if (delta < -Math.PI / 2) delta += Math.PI;

  const cosA = Math.cos(delta);
  const sinA = Math.sin(delta);

  // Rotate both endpoints around contact
  const newA = rotateAroundPoint(follower.a, contact, cosA, sinA);
  const newB = rotateAroundPoint(follower.b, contact, cosA, sinA);
  follower.a.x = newA.x; follower.a.y = newA.y;
  follower.b.x = newB.x; follower.b.y = newB.y;
}

/**
 * Computes constraint error for convergence check.
 * Returns a non-negative value; 0 = satisfied.
 */
function _constraintError(constraint, annMap) {
  const [ref0, ref1] = constraint.refs;
  const ann0 = annMap.get(ref0.annId);
  const ann1 = annMap.get(ref1.annId);
  if (!ann0 || !ann1) return Infinity;

  switch (constraint.type) {
    case 'perpendicular': {
      if (!isLineType(ann0) || !isLineType(ann1)) return Infinity;
      const d0 = getLineDirection(ann0);
      const d1 = getLineDirection(ann1);
      return Math.abs(d0.dx * d1.dx + d0.dy * d1.dy); // dot product → 0
    }
    case 'parallel': {
      if (!isLineType(ann0) || !isLineType(ann1)) return Infinity;
      const d0 = getLineDirection(ann0);
      const d1 = getLineDirection(ann1);
      return Math.abs(d0.dx * d1.dy - d0.dy * d1.dx); // cross product → 0
    }
    case 'coincident': {
      const p0 = getAnchorPoint(ann0, ref0.anchor);
      const p1 = getAnchorPoint(ann1, ref1.anchor);
      if (!p0 || !p1) return Infinity;
      return Math.hypot(p0.x - p1.x, p0.y - p1.y);
    }
    case 'concentric': {
      if (!isCircleType(ann0) || !isCircleType(ann1)) return Infinity;
      return Math.hypot(ann0.cx - ann1.cx, ann0.cy - ann1.cy);
    }
    case 'tangent-circles': {
      if (!isCircleType(ann0) || !isCircleType(ann1)) return Infinity;
      const dist = Math.hypot(ann0.cx - ann1.cx, ann0.cy - ann1.cy);
      return Math.abs(dist - (ann0.r + ann1.r));
    }
    case 'angle': {
      if (!isLineType(ann0) || !isLineType(ann1)) return Infinity;
      const d0 = getLineDirection(ann0);
      const d1 = getLineDirection(ann1);
      const dot = d0.dx * d1.dx + d0.dy * d1.dy;
      const angleDeg = constraint.angleDeg || 0;
      const expectedCos = Math.cos(angleDeg * Math.PI / 180);
      // Lines are undirected (a→b vs b→a both valid), so check both orientations
      return Math.min(Math.abs(dot - expectedCos), Math.abs(dot + expectedCos));
    }
    case 'point-on-line': {
      if (!isLineType(ann0) && !isLineType(ann1)) return Infinity;
      const line = isLineType(ann0) ? ann0 : ann1;
      const ptRef = isLineType(ann0) ? ref1 : ref0;
      const ptAnn = isLineType(ann0) ? ann1 : ann0;
      const pt = getAnchorPoint(ptAnn, ptRef.anchor);
      if (!pt) return Infinity;
      const dir = getLineDirection(line);
      // Cross-track distance = |(pt - line.a) × dir|
      const dx = pt.x - line.a.x;
      const dy = pt.y - line.a.y;
      return Math.abs(dx * dir.dy - dy * dir.dx);
    }
    case 'point-on-circle': {
      const circle = isCircleType(ann0) ? ann0 : (isCircleType(ann1) ? ann1 : null);
      const ptRef = isCircleType(ann0) ? ref1 : ref0;
      const ptAnn = isCircleType(ann0) ? ann1 : ann0;
      if (!circle) return Infinity;
      const pt = getAnchorPoint(ptAnn, ptRef.anchor);
      if (!pt) return Infinity;
      return Math.abs(Math.hypot(pt.x - circle.cx, pt.y - circle.cy) - circle.r);
    }
    case 'tangent-line-circle': {
      const line = isLineType(ann0) ? ann0 : (isLineType(ann1) ? ann1 : null);
      const circle = isCircleType(ann0) ? ann0 : (isCircleType(ann1) ? ann1 : null);
      if (!line || !circle) return Infinity;
      const dir = getLineDirection(line);
      const nx = -dir.dy, ny = dir.dx;
      const signedDist = (circle.cx - line.a.x) * nx + (circle.cy - line.a.y) * ny;
      return Math.abs(Math.abs(signedDist) - circle.r);
    }
    case 'midpoint': {
      const line = isLineType(ann0) ? ann0 : (isLineType(ann1) ? ann1 : null);
      const ptRef = isLineType(ann0) ? ref1 : ref0;
      const ptAnn = isLineType(ann0) ? ann1 : ann0;
      if (!line) return Infinity;
      const pt = getAnchorPoint(ptAnn, ptRef.anchor);
      if (!pt) return Infinity;
      const mx = (line.a.x + line.b.x) / 2;
      const my = (line.a.y + line.b.y) / 2;
      return Math.hypot(pt.x - mx, pt.y - my);
    }
    default:
      return Infinity; // unknown → treat as unsatisfied
  }
}

// ── Main solver ───────────────────────────────────────────────────────────────

/**
 * Iterative Gauss-Seidel constraint solver.
 *
 * @param {Array} annotations – full mutable annotation array
 * @param {Array} constraints – full mutable constraint array; status field updated
 * @param {number|null} driverAnnId – annotation ID being dragged (immutable); null if none
 */
export function solveConstraints(annotations, constraints, driverAnnId) {
  // Build O(1) lookup map
  const annMap = new Map(annotations.map(a => [a.id, a]));

  // Filter to enabled constraints only
  const enabled = constraints.filter(c => c.enabled);

  for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
    for (const constraint of enabled) {
      const refs = constraint.refs;
      if (!refs || refs.length < 2) {
        constraint.status = 'conflict';
        continue;
      }

      const [ref0, ref1] = refs;
      const ann0 = annMap.get(ref0.annId);
      const ann1 = annMap.get(ref1.annId);

      if (!ann0 || !ann1) {
        constraint.status = 'conflict';
        continue;
      }

      // Determine driver vs follower
      // The dragged annotation is always the driver (immutable)
      let driver, follower, driverRef, followerRef;
      if (driverAnnId !== null && driverAnnId !== undefined) {
        if (ann0.id === driverAnnId) {
          driver = ann0; driverRef = ref0;
          follower = ann1; followerRef = ref1;
        } else if (ann1.id === driverAnnId) {
          driver = ann1; driverRef = ref1;
          follower = ann0; followerRef = ref0;
        } else {
          // Neither dragged — treat first as driver
          driver = ann0; driverRef = ref0;
          follower = ann1; followerRef = ref1;
        }
      } else {
        // No drag — first ref is driver
        driver = ann0; driverRef = ref0;
        follower = ann1; followerRef = ref1;
      }

      try {
        _applyConstraint(constraint, driver, driverRef, follower, followerRef);
      } catch (e) {
        constraint.status = 'conflict';
      }
    }
  }

  // Evaluate final errors and set status
  for (const constraint of enabled) {
    if (constraint.status === 'conflict') continue;
    const err = _constraintError(constraint, annMap);
    constraint.status = (isFinite(err) && err < CONVERGENCE_THRESHOLD) ? 'ok' : 'conflict';
  }
}

/**
 * Applies a single constraint between driver and follower annotations.
 * Mutates follower in place.
 */
function _applyConstraint(constraint, driver, driverRef, follower, followerRef) {
  switch (constraint.type) {
    case 'perpendicular': {
      if (!isLineType(driver) || !isLineType(follower)) return;
      const driverDir = getLineDirection(driver);
      const contact = getAnchorPoint(follower, followerRef.anchor) || follower.a;
      projectPerpendicular(follower, driverDir, contact);
      break;
    }

    case 'parallel': {
      if (!isLineType(driver) || !isLineType(follower)) return;
      const driverDir = getLineDirection(driver);
      const contact = getAnchorPoint(follower, followerRef.anchor) || follower.a;
      projectParallel(follower, driverDir, contact);
      break;
    }

    case 'angle': {
      if (!isLineType(driver) || !isLineType(follower)) return;
      const driverDir = getLineDirection(driver);
      const contact = getAnchorPoint(follower, followerRef.anchor) || follower.a;
      const angleDeg = constraint.angleDeg || 0;
      projectAngle(follower, driverDir, contact, angleDeg);
      break;
    }

    case 'coincident': {
      const driverPt = getAnchorPoint(driver, driverRef.anchor);
      const followerPt = getAnchorPoint(follower, followerRef.anchor);
      if (!driverPt || !followerPt) return;
      projectCoincidentPoint(followerPt, driverPt);
      // Write back (for anchors backed by separate properties like cx/cy)
      setAnchorPoint(follower, followerRef.anchor, followerPt.x, followerPt.y);
      break;
    }

    case 'point-on-line': {
      if (isLineType(driver)) {
        // Line is driver → project point onto line
        const followerPt = getAnchorPoint(follower, followerRef.anchor);
        if (!followerPt) return;
        const driverDir = getLineDirection(driver);
        projectPointOnLine(followerPt, driver.a, driverDir);
        setAnchorPoint(follower, followerRef.anchor, followerPt.x, followerPt.y);
      } else if (isLineType(follower)) {
        // Point is driver → translate line so it passes through point
        const driverPt = getAnchorPoint(driver, driverRef.anchor);
        if (!driverPt) return;
        const dir = getLineDirection(follower);
        const nx = -dir.dy, ny = dir.dx;
        const signedDist = (driverPt.x - follower.a.x) * nx + (driverPt.y - follower.a.y) * ny;
        follower.a.x += signedDist * nx; follower.a.y += signedDist * ny;
        follower.b.x += signedDist * nx; follower.b.y += signedDist * ny;
      }
      break;
    }

    case 'point-on-circle': {
      if (isCircleType(driver)) {
        // Circle is driver → project point onto circumference
        const followerPt = getAnchorPoint(follower, followerRef.anchor);
        if (!followerPt) return;
        projectPointOnCircle(followerPt, driver);
        setAnchorPoint(follower, followerRef.anchor, followerPt.x, followerPt.y);
      } else if (isCircleType(follower)) {
        // Point is driver → translate circle so circumference passes through point
        const driverPt = getAnchorPoint(driver, driverRef.anchor);
        if (!driverPt) return;
        const dx = driverPt.x - follower.cx;
        const dy = driverPt.y - follower.cy;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-10) return;
        const shift = dist - follower.r;
        follower.cx += (dx / dist) * shift;
        follower.cy += (dy / dist) * shift;
      }
      break;
    }

    case 'tangent-line-circle': {
      if (isLineType(driver) && isCircleType(follower)) {
        // Move circle to be tangent to line
        const driverDir = getLineDirection(driver);
        projectTangentLineCircle(follower, driver.a, driverDir);
      } else if (isCircleType(driver) && isLineType(follower)) {
        // Move line to be tangent to circle: translate line along its normal
        const dir = getLineDirection(follower);
        const nx = -dir.dy, ny = dir.dx;
        // Project circle center onto line to get foot point, then compute
        // perpendicular distance from circle center to infinite line
        const t = (driver.cx - follower.a.x) * dir.dx + (driver.cy - follower.a.y) * dir.dy;
        const footX = follower.a.x + t * dir.dx;
        const footY = follower.a.y + t * dir.dy;
        const perpDx = driver.cx - footX;
        const perpDy = driver.cy - footY;
        const perpDist = Math.hypot(perpDx, perpDy);
        // signedDist = (center - foot) · normal. Moving line by +delta along
        // normal decreases signedDist by delta. We want |signedDist| = r.
        const side = perpDx * nx + perpDy * ny;
        const sign = side >= 0 ? 1 : -1;
        const targetSignedDist = sign * driver.r;
        // currentSignedDist = sign * perpDist (perpDist is always positive)
        const currentSignedDist = sign * perpDist;
        // delta: translate line so new signedDist = targetSignedDist
        // newSignedDist = currentSignedDist - delta → delta = current - target
        const delta = currentSignedDist - targetSignedDist;
        follower.a.x += delta * nx; follower.a.y += delta * ny;
        follower.b.x += delta * nx; follower.b.y += delta * ny;
      }
      break;
    }

    case 'tangent-circles': {
      if (!isCircleType(driver) || !isCircleType(follower)) return;
      projectTangentCircleCircle(follower, driver);
      break;
    }

    case 'concentric': {
      if (!isCircleType(driver) || !isCircleType(follower)) return;
      projectConcentric(follower, driver);
      break;
    }

    case 'midpoint': {
      if (isLineType(driver)) {
        // Line is driver → move point to midpoint of line
        const followerPt = getAnchorPoint(follower, followerRef.anchor);
        if (!followerPt) return;
        projectMidpoint(followerPt, driver.a, driver.b);
        setAnchorPoint(follower, followerRef.anchor, followerPt.x, followerPt.y);
      } else if (isLineType(follower)) {
        // Point is driver → translate line so its midpoint coincides with point
        const driverPt = getAnchorPoint(driver, driverRef.anchor);
        if (!driverPt) return;
        const mx = (follower.a.x + follower.b.x) / 2;
        const my = (follower.a.y + follower.b.y) / 2;
        const dx = driverPt.x - mx;
        const dy = driverPt.y - my;
        follower.a.x += dx; follower.a.y += dy;
        follower.b.x += dx; follower.b.y += dy;
      }
      break;
    }

    default:
      // Unknown constraint type — leave unchanged
      break;
  }
}
