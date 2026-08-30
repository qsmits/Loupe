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
    steps: () => ['Place at least 3 points on the edge',
                  'Add points — more improves the fit',
                  'Finish — Enter or double-click'],
    currentStep: s => (nPts(s) < 3 ? 0 : nPts(s) === 3 ? 1 : 2),
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
    steps: () => ['Click to place vertices (≥3)', 'Finish — Enter or double-click'],
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
    steps: () => ['Click anchor points (≥2)', 'Finish — Enter or double-click'],
    currentStep: s => (nPts(s) >= 2 ? 1 : 0),
    finish: { minPoints: 2, hint: 'Enter or double-click' },
  },
  'fit-line': {
    title: 'Flatness',
    steps: () => ['Place points along the line (≥2)', 'Finish — Enter or double-click'],
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
};

export function statusLine(toolId, state) {
  const p = PROCEDURES[toolId];
  if (!p) return String(toolId);
  const steps = p.steps(state);
  return `${p.title} — ${steps[Math.min(p.currentStep(state), steps.length - 1)]}`;
}
