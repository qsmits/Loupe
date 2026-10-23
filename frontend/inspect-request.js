// inspect-request.js — pure request-body builder for /inspect-guided.
//
// Extracted from the btn-run-inspection click handler (dxf.js) so the
// request shape — in particular the feature_specs/default_tol wiring added
// alongside DXF dimension-tolerance specs — is unit-testable without a DOM.
//
// Node-importable: no DOM access, no imports.

/** Build the /inspect-guided JSON request body from camelCase inputs. */
export function buildInspectGuidedBody({
  entities, pixelsPerMm, tx, ty, angleDeg, flipH, flipV,
  corridorPx, smoothing, cannyLow, cannyHigh,
  toleranceWarn, toleranceFail, featureTolerances, featureSpecs, defaultTol,
  subpixel, edgeMethod, caliper,
}) {
  return {
    entities,
    pixels_per_mm: pixelsPerMm,
    tx,
    ty,
    angle_deg: angleDeg,
    flip_h: flipH,
    flip_v: flipV,
    corridor_px: corridorPx,
    smoothing,
    canny_low: cannyLow,
    canny_high: cannyHigh,
    tolerance_warn: toleranceWarn,
    tolerance_fail: toleranceFail,
    feature_tolerances: featureTolerances,
    feature_specs: featureSpecs,
    default_tol: defaultTol,
    subpixel,
    ...(edgeMethod !== undefined ? { edge_method: edgeMethod } : {}),
    ...(caliper !== undefined ? { caliper } : {}),
  };
}

// Overlay-owned options are saved with sessions and measurement templates.
// A MISSING options object (every project saved before calipers existed) means
// the legacy Canny-contour path; only overlays created with explicit options
// (newOverlayInspectionOptions) use calipers.
export function inspectionOptions(saved) {
  saved = saved ?? {};
  return {
    edgeMethod: saved.edgeMethod ?? 'contour',
    corridorPx: saved.corridorPx ?? 15,
    caliper: { width: 5, sigma: 1, spacing: 5, min_contrast: 20,
      polarity: 'any', selection: 'unique', ...saved.caliper },
  };
}

/** Explicit options stamped on a NEW DXF overlay: calipers plus the Edge
 *  sampling menu's current values (menu: {corridorPx, caliper}). */
export function newOverlayInspectionOptions(menu = {}) {
  return inspectionOptions({ ...menu, edgeMethod: 'caliper' });
}

/** Badge descriptor for a guided-inspection result. A matched result flagged
 *  `ambiguous` (competing edges in the corridor) keeps its pass/fail value but
 *  is shown as "PASS?" / "FAIL?" with the amber `badge-ambiguous` class. */
export function resultBadge(r) {
  if (!r.matched) return { cls: 'badge-unmatched', text: '\u2014', ambiguous: false };
  const base = r.pass_fail === 'pass' ? { cls: 'badge-pass', text: 'PASS' }
    : r.pass_fail === 'warn' ? { cls: 'badge-warn', text: 'WARN' }
    : { cls: 'badge-fail', text: 'FAIL' };
  if (!r.ambiguous) return { ...base, ambiguous: false };
  return { cls: 'badge-ambiguous', text: base.text + '?', ambiguous: true,
    title: r.reason || 'Ambiguous edge selection: competing edges in the corridor' };
}

/** Shared by the on-screen summary, group/tooth badges, and PDF groups. */
export function inspectionSummary(results) {
  const total = results.length;
  const matched = results.filter(r => r.matched).length;
  const unmatched = total - matched;
  const ambiguous = results.filter(r => r.matched && r.ambiguous).length;
  const failed = results.filter(r => r.matched && r.pass_fail === 'fail').length;
  const warned = results.filter(r => r.matched && r.pass_fail === 'warn').length;
  const issues = [];
  if (failed) issues.push(`${failed} FAIL`);
  if (warned) issues.push(`${warned} WARN`);
  if (ambiguous) issues.push(`${ambiguous} ambiguous`);
  if (unmatched) issues.push(`${unmatched} unmatched`);
  const text = `${matched}/${total} matched — ${issues.join(', ') || (total ? 'all PASS' : 'no results')}`;
  let badge = resultBadge({ matched: matched > 0,
    pass_fail: failed ? 'fail' : warned ? 'warn' : 'pass', ambiguous: ambiguous > 0 });
  if (unmatched && !failed) {
    badge = { cls: matched ? 'badge-warn' : 'badge-unmatched',
      text: matched ? 'INCOMPLETE' : 'UNMATCHED' };
  }
  return { text, badge: { ...badge, title: text } };
}

export const inspectionControls = {
  'inspection-method': ['edgeMethod'],
  'inspection-corridor': ['corridorPx'],
  'caliper-width': ['caliper', 'width'],
  'caliper-sigma': ['caliper', 'sigma'],
  'caliper-polarity': ['caliper', 'polarity'],
  'caliper-selection': ['caliper', 'selection'],
};
