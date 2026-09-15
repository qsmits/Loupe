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
  subpixel,
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
  };
}
