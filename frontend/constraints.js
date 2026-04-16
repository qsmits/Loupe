// ── Constraint CRUD ──────────────────────────────────────────────────────────
import { state, pushUndo } from './state.js';
import { redraw } from './render.js';
import { renderSidebar } from './sidebar.js';

// ── Helpers: classify annotations ────────────────────────────────────────────
const LINE_TYPES = new Set(['distance', 'perp-dist', 'para-dist', 'parallelism', 'slot-dist', 'fit-line']);
const CIRCLE_TYPES = new Set(['circle', 'arc-fit', 'arc-measure']);
const POINT_TYPE = 'point';

function isLine(ann)   { return LINE_TYPES.has(ann.type); }
function isCircle(ann) { return CIRCLE_TYPES.has(ann.type); }
function isPoint(ann)  { return ann.type === POINT_TYPE; }

function hasEndpoints(ann) {
  return !!(ann.a && ann.b) || ann.type === POINT_TYPE;
}

// ── Valid constraint types for a pair of annotations ─────────────────────────
export function validConstraintsForPair(ann0, ann1) {
  const types = [];
  const bothLines = isLine(ann0) && isLine(ann1);
  const lineAndCircle = (isLine(ann0) && isCircle(ann1)) || (isCircle(ann0) && isLine(ann1));
  const bothCircles = isCircle(ann0) && isCircle(ann1);
  const pointAndLine = (isPoint(ann0) && isLine(ann1)) || (isLine(ann0) && isPoint(ann1));
  const pointAndCircle = (isPoint(ann0) && isCircle(ann1)) || (isCircle(ann0) && isPoint(ann1));

  if (bothLines) {
    types.push('perpendicular', 'parallel', 'angle');
  }
  if (lineAndCircle) {
    types.push('tangent-line-circle');
  }
  if (bothCircles) {
    types.push('concentric', 'tangent-circles');
  }
  if (pointAndLine) {
    types.push('point-on-line', 'midpoint');
  }
  if (pointAndCircle) {
    types.push('point-on-circle');
  }
  // Coincident-point: any two annotations that have usable anchor points
  if (hasEndpoints(ann0) && hasEndpoints(ann1)) {
    types.push('coincident');
  }
  return [...new Set(types)]; // dedupe
}

// ── Constraint display labels ────────────────────────────────────────────────
export const CONSTRAINT_LABELS = {
  'perpendicular': '⊥ Perpendicular',
  'parallel':      '∥ Parallel',
  'angle':         '∠ Angle…',
  'tangent-line-circle': 'T Tangent',
  'tangent-circles': 'T Tangent',
  'concentric':    '⊙ Concentric',
  'coincident':    '• Coincident',
  'point-on-line': '• Point on line',
  'point-on-circle': '• Point on circle',
  'midpoint':      'M Midpoint',
};

export const CONSTRAINT_ICONS = {
  'perpendicular': '⊥',
  'parallel':      '∥',
  'angle':         '∠',
  'tangent-line-circle': 'T',
  'tangent-circles': 'T',
  'concentric':    '⊙',
  'coincident':    '•',
  'point-on-line': '·⎯',
  'point-on-circle': '·○',
  'midpoint':      'M',
};

// ── Auto-compute contact point ───────────────────────────────────────────────
function computeContactPoint(ann0, anchor0, ann1, anchor1) {
  const pt0 = _getPoint(ann0, anchor0);
  const pt1 = _getPoint(ann1, anchor1);
  if (pt0 && pt1) {
    return { x: (pt0.x + pt1.x) / 2, y: (pt0.y + pt1.y) / 2 };
  }
  if (pt0) return { ...pt0 };
  if (pt1) return { ...pt1 };
  if (ann0.a && ann0.b) return { x: (ann0.a.x + ann0.b.x) / 2, y: (ann0.a.y + ann0.b.y) / 2 };
  if (ann0.cx != null) return { x: ann0.cx, y: ann0.cy };
  return { x: 0, y: 0 };
}

function _getPoint(ann, anchor) {
  if (anchor === 'a' && ann.a) return ann.a;
  if (anchor === 'b' && ann.b) return ann.b;
  if (anchor === 'center') return { x: ann.cx, y: ann.cy };
  if (ann.type === POINT_TYPE) return { x: ann.x, y: ann.y };
  return null;
}

// ── Auto-select best anchors for a pair ──────────────────────────────────────
function autoAnchors(ann0, ann1, constraintType) {
  if (['perpendicular', 'parallel', 'angle'].includes(constraintType)) {
    if (ann0.a && ann1.a) {
      let bestDist = Infinity, bestA = 'a', bestB = 'a';
      for (const ka of ['a', 'b']) {
        for (const kb of ['a', 'b']) {
          const d = Math.hypot(ann0[ka].x - ann1[kb].x, ann0[ka].y - ann1[kb].y);
          if (d < bestDist) { bestDist = d; bestA = ka; bestB = kb; }
        }
      }
      return [bestA, bestB];
    }
  }
  if (constraintType === 'concentric' || constraintType === 'tangent-circles') {
    if (isCircle(ann0) && isCircle(ann1)) return ['center', 'center'];
  }
  if (constraintType === 'tangent-line-circle') {
    if (isLine(ann0) && isCircle(ann1)) return ['a', 'center'];
    if (isCircle(ann0) && isLine(ann1)) return ['center', 'a'];
  }
  if (isPoint(ann0)) return ['center', isPoint(ann1) ? 'center' : isLine(ann1) ? 'a' : 'center'];
  if (isPoint(ann1)) return [isLine(ann0) ? 'a' : 'center', 'center'];
  return ['a', 'a'];
}

// ── Add constraint ───────────────────────────────────────────────────────────
export function addConstraint(type, ann0Id, ann1Id, options = {}) {
  const ann0 = state.annotations.find(a => a.id === ann0Id);
  const ann1 = state.annotations.find(a => a.id === ann1Id);
  if (!ann0 || !ann1) return null;

  pushUndo();

  const [anchor0, anchor1] = autoAnchors(ann0, ann1, type);
  const constraint = {
    id: state.nextConstraintId++,
    type,
    refs: [
      { annId: ann0Id, anchor: anchor0 },
      { annId: ann1Id, anchor: anchor1 },
    ],
    contactPoint: computeContactPoint(ann0, anchor0, ann1, anchor1),
    enabled: true,
    status: 'ok',
  };
  if (type === 'angle') {
    constraint.angleDeg = options.angleDeg ?? 0;
  }
  state.constraints.push(constraint);
  renderSidebar();
  redraw();
  return constraint;
}

// ── Remove constraint ────────────────────────────────────────────────────────
export function removeConstraint(constraintId) {
  pushUndo();
  state.constraints = state.constraints.filter(c => c.id !== constraintId);
  renderSidebar();
  redraw();
}

// ── Toggle constraint enabled/disabled ───────────────────────────────────────
export function toggleConstraint(constraintId) {
  const c = state.constraints.find(c => c.id === constraintId);
  if (!c) return;
  pushUndo();
  c.enabled = !c.enabled;
  if (!c.enabled) c.status = 'ok';
  renderSidebar();
  redraw();
}

// ── Get constraints for an annotation ────────────────────────────────────────
export function constraintsForAnnotation(annId) {
  return state.constraints.filter(c =>
    c.refs.some(r => r.annId === annId)
  );
}

// ── Cascade delete: remove constraints referencing a deleted annotation ──────
export function cascadeDeleteConstraints(annId) {
  state.constraints = state.constraints.filter(c =>
    !c.refs.some(r => r.annId === annId)
  );
}
