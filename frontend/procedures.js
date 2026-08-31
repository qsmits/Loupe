// frontend/procedures.js — per-tool guided-procedure definitions.
// Single source of truth for step text: the status bar (tools.js) and the
// Measure panel (measure-panel.js) both read from here so they cannot drift.
import { fitCircleAlgebraic, fitLine } from './math.js';

function fmtLen(px, cal) {
  if (!cal || !(cal.pixelsPerMm > 0)) return `${px.toFixed(1)} px`;
  const mm = px / cal.pixelsPerMm;
  return cal.displayUnit === 'µm' ? `${(mm * 1000).toFixed(2)} µm` : `${mm.toFixed(3)} mm`;
}

function circleFitLive(s) {
  const pts = s.pendingPoints || [];
  if (pts.length < 3) return null;
  const fit = fitCircleAlgebraic(pts);
  if (!fit) return null;
  const rms = Math.sqrt(pts.reduce((acc, p) => {
    const e = Math.hypot(p.x - fit.cx, p.y - fit.cy) - fit.r;
    return acc + e * e;
  }, 0) / pts.length);
  return `Preview: Ø ${fmtLen(fit.r * 2, s.calibration)} · RMS ${fmtLen(rms, s.calibration)}`;
}

function lineFitLive(s) {
  const pts = s.pendingPoints || [];
  if (pts.length < 2) return null;
  const fit = fitLine(pts);
  if (!fit) return null;
  const rms = Math.sqrt(pts.reduce((acc, p) => {
    // perpendicular residual to the fitted line through (cx,cy) with direction (dx,dy)
    const e = (p.x - fit.cx) * -fit.dy + (p.y - fit.cy) * fit.dx;
    return acc + e * e;
  }, 0) / pts.length);
  return `${pts.length} points · RMS ${fmtLen(rms, s.calibration)}`;
}

const nPts = s => (s.pendingPoints || []).length;

export const PROCEDURES = {
  select: {
    title: 'Select',
    steps: () => ['Click an item to select it — Shift+click adds, drag for a marquee'],
    currentStep: () => 0,
  },
  pan: {
    title: 'Pan',
    steps: () => ['Drag to pan the frozen image'],
    currentStep: () => 0,
  },
  comment: {
    title: 'Note',
    steps: () => ['Click to place a note'],
    currentStep: () => 0,
  },
  distance: {
    title: 'Distance',
    steps: () => ['Click the first point', 'Click the second point'],
    currentStep: s => Math.min(nPts(s), 1),
  },
  angle: {
    title: 'Angle',
    steps: s => s.angleMode === 'three-points'
      ? ['Click the first arm point', 'Click the vertex', 'Click the second arm point']
      : ['Click the first line', 'Click the second line'],
    currentStep: s => s.angleMode === 'three-points'
      ? Math.min(nPts(s), 2)
      : (s.pendingRefLine ? 1 : 0),
  },
  circle: {
    title: 'Circle',
    steps: s => s.circleMode === 'center-edge'
      ? ['Click the center', 'Click a point on the edge']
      : ['Click point 1 on the edge', 'Click point 2 on the edge', 'Click point 3 on the edge'],
    currentStep: s => Math.min(nPts(s), s.circleMode === 'center-edge' ? 1 : 2),
  },
  'arc-fit': {
    title: 'Best fit',
    steps: s => {
      const n = nPts(s);
      return [
        n === 0 ? 'Place at least 3 points on the edge' : `${n} point${n === 1 ? '' : 's'} placed — need ${3 - n} more`,
        `${n} points placed — more improves the fit`,
        'Finish — Enter or double-click',
      ];
    },
    // Once the 3-point minimum is met, stay on the live-progress step (index 1)
    // no matter how many extra points are added — index 2 ("Finish") is a
    // discrete action, not something point count alone should trigger.
    currentStep: s => (nPts(s) < 3 ? 0 : 1),
    liveLine: circleFitLive,
    finish: { minPoints: 3, hint: 'Enter or double-click' },
  },
  'arc-measure': {
    title: 'Arc',
    steps: s => s.arcMeasureMode === 'ends-first'
      ? ['Click the first arc end', 'Click the second arc end', 'Click a point mid-arc']
      : ['Click the arc start', 'Click a point mid-arc', 'Click the arc end'],
    currentStep: s => Math.min(nPts(s), 2),
  },
  area: {
    title: 'Area',
    steps: s => {
      const n = nPts(s);
      return [
        n === 0 ? 'Click to place vertices (≥3)' : `${n} vert${n === 1 ? 'ex' : 'ices'} placed${n < 3 ? ` — need ${3 - n} more` : ''}`,
        'Finish — Enter or double-click',
      ];
    },
    currentStep: s => (nPts(s) >= 3 ? 1 : 0),
    finish: { minPoints: 3, hint: 'Enter or double-click' },
  },
  'area-shape': {
    title: 'Shape',
    steps: () => ['Click a closed shape, or one segment of a closed loop'],
    currentStep: () => 0,
  },
  spline: {
    title: 'Spline',
    steps: s => {
      const n = nPts(s);
      return [
        n === 0 ? 'Click anchor points (≥2)' : `${n} anchor${n === 1 ? '' : 's'} placed`,
        'Finish — Enter or double-click',
      ];
    },
    currentStep: s => (nPts(s) >= 2 ? 1 : 0),
    finish: { minPoints: 2, hint: 'Enter or double-click' },
  },
  'fit-line': {
    title: 'Flatness',
    steps: s => {
      const n = nPts(s);
      return [
        n === 0 ? 'Place points along the line (≥2)' : `${n} point${n === 1 ? '' : 's'} placed`,
        'Finish — Enter or double-click',
      ];
    },
    currentStep: s => (nPts(s) >= 2 ? 1 : 0),
    liveLine: lineFitLive,
    finish: { minPoints: 2, hint: 'Enter or double-click' },
  },
  point: {
    title: 'Point',
    steps: () => ['Click to place a reference point'],
    currentStep: () => 0,
  },
  calibrate: {
    title: 'Calibrate',
    steps: () => ['Click near a circle edge, or click the first of two points a known distance apart',
                  'Click the second point'],
    currentStep: s => Math.min(nPts(s), 1),
  },
  detect: {
    title: 'Detect',
    steps: () => ['Click to detect features'],
    currentStep: () => 0,
  },
  // ── Relation tools (resurrected 2026-08-30) — not in TOOL_BUTTONS, so the
  // procedures-completeness gate (test_procedures.js) doesn't require these;
  // Task 16's palette gains its own completeness coverage for them.
  //
  // Task 13 (inline fitting): each tool's pick-a-circle/pick-a-line slot can
  // also be filled by placing ≥3 (circle) / ≥2 (line) edge points and
  // pressing Enter (or double-click, or the panel's Finish button) —
  // finalizeRelationPick() in tools.js. While that slot is mid-fit
  // (s.pendingRelationFit), its step line swaps to a live point count; the
  // `liveLine` preview mirrors arc-fit's/fit-line's Ø·RMS / RMS readout.
  'center-dist': {
    title: 'Circle ↔ circle distance',
    steps: s => {
      const n = nPts(s);
      const cur = s.pendingCenterCircle ? 1 : 0;
      const steps = [
        'Specify the 1st circle — click a fitted circle, or place ≥3 edge points and press Enter',
        'Specify the 2nd circle — click a fitted circle, or place ≥3 edge points and press Enter',
        'Distance appears — set pattern/nominal in Properties',
      ];
      if (s.pendingRelationFit?.kind === 'circle') {
        steps[cur] = n === 0 ? 'Place at least 3 edge points' : `${n} point${n === 1 ? '' : 's'} placed${n < 3 ? ` — need ${3 - n} more` : ''}`;
      }
      return steps;
    },
    currentStep: s => (s.pendingCenterCircle ? 1 : 0),
    liveLine: s => s.pendingRelationFit?.kind === 'circle' ? circleFitLive(s) : null,
    finish: { minPoints: 3, hint: 'Enter or double-click' },
  },
  'pt-circle-dist': {
    title: 'Point ↔ circle distance',
    steps: s => {
      const n = nPts(s);
      const steps = ['Click a fitted circle, or place ≥3 edge points and press Enter',
                     'Click the point to measure from'];
      if (s.pendingRelationFit?.kind === 'circle') {
        steps[0] = n === 0 ? 'Place at least 3 edge points' : `${n} point${n === 1 ? '' : 's'} placed${n < 3 ? ` — need ${3 - n} more` : ''}`;
      }
      return steps;
    },
    currentStep: s => (s.pendingCircleRef ? 1 : 0),
    liveLine: s => s.pendingRelationFit?.kind === 'circle' ? circleFitLive(s) : null,
    finish: { minPoints: 3, hint: 'Enter or double-click' },
  },
  'perp-dist': {
    title: 'Perpendicular distance',
    steps: s => {
      const n = nPts(s);
      const steps = ['Click the reference line, or place ≥2 edge points and press Enter',
                     'Click the start point', 'Click the end point'];
      if (s.pendingRelationFit?.kind === 'line') {
        steps[0] = n === 0 ? 'Place at least 2 edge points' : `${n} point${n === 1 ? '' : 's'} placed${n < 2 ? ` — need ${2 - n} more` : ''}`;
      }
      return steps;
    },
    currentStep: s => (!s.pendingRefLine ? 0 : (s.pendingPoints || []).length === 0 ? 1 : 2),
    liveLine: s => s.pendingRelationFit?.kind === 'line' ? lineFitLive(s) : null,
    finish: { minPoints: 2, hint: 'Enter or double-click' },
  },
  'para-dist': {
    // Accepted limitation (fix round 2 ruling): the 2nd slot stays pick/place
    // only — a bare-edge click there already means Mode B (free-point
    // parallel distance), so it must NOT gain inline-fit accumulation, and
    // this step text must NOT promise it (only the 1st/ref-line slot fits).
    title: 'Parallel distance / parallelism',
    steps: s => {
      const n = nPts(s);
      const steps = ['Click the reference line, or place ≥2 edge points and press Enter',
                     'Click another line for parallelism, or a free point for parallel distance',
                     'Click the end point'];
      if (s.pendingRelationFit?.kind === 'line') {
        steps[0] = n === 0 ? 'Place at least 2 edge points' : `${n} point${n === 1 ? '' : 's'} placed${n < 2 ? ` — need ${2 - n} more` : ''}`;
      }
      return steps;
    },
    currentStep: s => (!s.pendingRefLine ? 0 : (s.pendingPoints || []).length === 0 ? 1 : 2),
    liveLine: s => s.pendingRelationFit?.kind === 'line' ? lineFitLive(s) : null,
    finish: { minPoints: 2, hint: 'Enter or double-click' },
  },
  'slot-dist': {
    // Both slots route through _consumePickedLine/finalizeRelationPick, so
    // both are inline-fittable (fix round 2) — mirrors center-dist, not
    // perp-dist/para-dist.
    title: 'Width between two lines',
    steps: s => {
      const n = nPts(s);
      const cur = s.pendingRefLine ? 1 : 0;
      const steps = [
        'Click the first line, or place ≥2 edge points and press Enter',
        'Click the second line, or place ≥2 edge points and press Enter',
      ];
      if (s.pendingRelationFit?.kind === 'line') {
        steps[cur] = n === 0 ? 'Place at least 2 edge points' : `${n} point${n === 1 ? '' : 's'} placed${n < 2 ? ` — need ${2 - n} more` : ''}`;
      }
      return steps;
    },
    currentStep: s => (s.pendingRefLine ? 1 : 0),
    liveLine: s => s.pendingRelationFit?.kind === 'line' ? lineFitLive(s) : null,
    finish: { minPoints: 2, hint: 'Enter or double-click' },
  },
  intersect: {
    // Both slots inline-fittable — see slot-dist's comment above.
    title: 'Intersection of two lines',
    steps: s => {
      const n = nPts(s);
      const cur = s.pendingRefLine ? 1 : 0;
      const steps = [
        'Click the first line, or place ≥2 edge points and press Enter',
        'Click the second line, or place ≥2 edge points and press Enter',
      ];
      if (s.pendingRelationFit?.kind === 'line') {
        steps[cur] = n === 0 ? 'Place at least 2 edge points' : `${n} point${n === 1 ? '' : 's'} placed${n < 2 ? ` — need ${2 - n} more` : ''}`;
      }
      return steps;
    },
    currentStep: s => (s.pendingRefLine ? 1 : 0),
    liveLine: s => s.pendingRelationFit?.kind === 'line' ? lineFitLive(s) : null,
    finish: { minPoints: 2, hint: 'Enter or double-click' },
  },
};

export function statusLine(toolId, state) {
  const p = PROCEDURES[toolId];
  if (!p) return String(toolId);
  const steps = p.steps(state);
  return `${p.title} — ${steps[Math.min(p.currentStep(state), steps.length - 1)]}`;
}
