/**
 * Pure unit tests for the /inspect-guided request-body builder.
 * Run with: node --test tests/frontend/test_inspect_request.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInspectGuidedBody } from '../../frontend/inspect-request.js';

function baseArgs(overrides = {}) {
  return {
    entities: [{ type: 'circle', handle: 'C1' }],
    pixelsPerMm: 10,
    tx: 100,
    ty: 200,
    angleDeg: 0,
    flipH: false,
    flipV: false,
    corridorPx: 15,
    smoothing: 1,
    cannyLow: 50,
    cannyHigh: 130,
    toleranceWarn: 0.1,
    toleranceFail: 0.25,
    featureTolerances: {},
    featureSpecs: {},
    defaultTol: null,
    subpixel: 'parabola',
    ...overrides,
  };
}

describe('buildInspectGuidedBody', () => {
  it('maps every camelCase field to its snake_case wire name', () => {
    const body = buildInspectGuidedBody(baseArgs());
    assert.deepEqual(body, {
      entities: [{ type: 'circle', handle: 'C1' }],
      pixels_per_mm: 10,
      tx: 100,
      ty: 200,
      angle_deg: 0,
      flip_h: false,
      flip_v: false,
      corridor_px: 15,
      smoothing: 1,
      canny_low: 50,
      canny_high: 130,
      tolerance_warn: 0.1,
      tolerance_fail: 0.25,
      feature_tolerances: {},
      feature_specs: {},
      default_tol: null,
      subpixel: 'parabola',
    });
  });

  it('carries feature_specs through untouched (keyed by handle)', () => {
    const spec = { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 };
    const body = buildInspectGuidedBody(baseArgs({ featureSpecs: { C1: spec } }));
    assert.deepEqual(body.feature_specs, { C1: spec });
  });

  it('passes a numeric default_tol through as-is', () => {
    const body = buildInspectGuidedBody(baseArgs({ defaultTol: 0.15 }));
    assert.equal(body.default_tol, 0.15);
  });

  it('a null default_tol (no per-drawing default set) stays null on the wire', () => {
    const body = buildInspectGuidedBody(baseArgs({ defaultTol: null }));
    assert.equal(body.default_tol, null);
  });

  it('does not mutate the entities array reference (same identity, not a copy)', () => {
    const entities = [{ type: 'line' }];
    const body = buildInspectGuidedBody(baseArgs({ entities }));
    assert.equal(body.entities, entities);
  });
});
