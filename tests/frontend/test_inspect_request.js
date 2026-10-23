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

describe('caliper recipes', () => {
  it('sends raw-profile options independently of Canny settings', () => {
    const caliper = { width: 5, sigma: 1.5, polarity: 'rising', selection: 'unique' };
    const body = buildInspectGuidedBody(baseArgs({ edgeMethod: 'caliper', caliper }));
    assert.equal(body.edge_method, 'caliper');
    assert.deepEqual(body.caliper, caliper);
  });
});

// ── S1: legacy overlays stay on contours; new overlays opt in to calipers ────
import fs from 'node:fs';
import { inspectionOptions, newOverlayInspectionOptions } from '../../frontend/inspect-request.js';
import { migrateV3ToV4 } from '../../frontend/project-format.js';

describe('inspectionOptions defaults (S1)', () => {
  it('missing options resolve to contour with the legacy 15 px corridor', () => {
    for (const saved of [undefined, null]) {
      const o = inspectionOptions(saved);
      assert.equal(o.edgeMethod, 'contour');
      assert.equal(o.corridorPx, 15);
    }
  });
  it('an explicit caliper choice is kept', () => {
    assert.equal(inspectionOptions({ edgeMethod: 'caliper', corridorPx: 8 }).edgeMethod, 'caliper');
    assert.equal(inspectionOptions({ edgeMethod: 'caliper', corridorPx: 8 }).corridorPx, 8);
  });
  it('an explicit contour choice is kept', () => {
    assert.equal(inspectionOptions({ edgeMethod: 'contour' }).edgeMethod, 'contour');
  });
  it('new overlays carry caliper plus the menu values at creation time', () => {
    const o = newOverlayInspectionOptions({
      corridorPx: 12, caliper: { width: 7, sigma: 2, polarity: 'rising', selection: 'first' },
    });
    assert.equal(o.edgeMethod, 'caliper');
    assert.equal(o.corridorPx, 12);
    assert.equal(o.caliper.width, 7);
    assert.equal(o.caliper.polarity, 'rising');
    assert.equal(o.caliper.selection, 'first');
    assert.equal(newOverlayInspectionOptions().edgeMethod, 'caliper');
  });
  it('every DXF overlay creation site in dxf.js passes explicit inspectionOptions', () => {
    const src = fs.readFileSync(new URL('../../frontend/dxf.js', import.meta.url), 'utf8');
    const sites = src.split(/addAnnotation\(\{\s*type: "dxf-overlay"/).slice(1);
    assert.ok(sites.length >= 2);
    for (const s of sites) {
      assert.match(s.slice(0, 600), /inspectionOptions:\s*newOverlayInspectionOptions\(\)/);
    }
  });
});

describe('legacy records keep contour through project-format (S1)', () => {
  it('a v3 session overlay without inspectionOptions migrates and resolves to contour', () => {
    const v4 = migrateV3ToV4({ version: 3, annotations: [
      { type: 'dxf-overlay', id: 1, entities: [], offsetX: 0, offsetY: 0 }] });
    const ov = v4.annotations.find(a => a.type === 'dxf-overlay');
    assert.equal(ov.inspectionOptions, undefined);
    assert.equal(inspectionOptions(ov.inspectionOptions).edgeMethod, 'contour');
  });
  it('a JSON round-tripped old v4 record keeps contour; an explicit caliper survives', () => {
    const rt = o => JSON.parse(JSON.stringify(o));
    const old = rt(migrateV3ToV4({ version: 3, annotations: [
      { type: 'dxf-overlay', id: 1, entities: [] }] }));
    assert.equal(inspectionOptions(old.annotations[0].inspectionOptions).edgeMethod, 'contour');
    const fresh = rt({ ...old, annotations: [{ type: 'dxf-overlay', id: 1, entities: [],
      inspectionOptions: newOverlayInspectionOptions() }] });
    assert.equal(inspectionOptions(fresh.annotations[0].inspectionOptions).edgeMethod, 'caliper');
  });
});

// ── New-overlay defaults must not leak hidden menu state ────────────────────
import './dom-stub.js';
import { registerElement, resetElements } from './dom-stub.js';
import { resultBadge } from '../../frontend/inspect-request.js';
import { state } from '../../frontend/state.js';
import { serializeWorkspace, restoreWorkspace, freshWorkspaceRecord } from '../../frontend/workspace.js';

describe('new overlay option defaults', () => {
  it('match the backend CaliperParams defaults', () => {
    assert.deepStrictEqual(newOverlayInspectionOptions(), {
      edgeMethod: 'caliper', corridorPx: 15,
      caliper: { width: 5, sigma: 1, spacing: 5, min_contrast: 20,
        polarity: 'any', selection: 'unique' },
    });
  });

  it('dxf.js creation stamps defaults, never reading the menu DOM', async () => {
    const src = fs.readFileSync(new URL('../../frontend/dxf.js', import.meta.url), 'utf8');
    assert.ok(!/menuInspectionOptions/.test(src));
    assert.equal((src.match(/inspectionOptions: newOverlayInspectionOptions\(\)/g) || []).length, 2);
  });

  it('with no overlay the menu is reset to the defaults', async () => {
    const { updateDxfControlsVisibility } = await import('../../frontend/sidebar.js');
    resetElements();
    const ids = ['inspection-method', 'inspection-corridor', 'caliper-width',
      'caliper-sigma', 'caliper-polarity', 'caliper-selection'];
    const els = Object.fromEntries(ids.map(id => [id, { value: 'stale', disabled: true }]));
    for (const id of ids) registerElement(id, els[id]);
    state.annotations = [];
    updateDxfControlsVisibility();
    assert.equal(els['inspection-method'].value, 'caliper');
    assert.equal(els['inspection-corridor'].value, 15);
    assert.equal(els['caliper-width'].value, 5);
    assert.equal(els['caliper-sigma'].value, 1);
    assert.equal(els['caliper-polarity'].value, 'any');
    assert.equal(els['caliper-selection'].value, 'unique');
    assert.equal(els['caliper-width'].disabled, false);
    resetElements();
  });
});

describe('ambiguous matched results', () => {
  const r = { handle: 'A', matched: true, pass_fail: 'pass', ambiguous: true, reason: 'two edges' };
  it('badge is amber PASS? with the reason, pass_fail untouched', () => {
    const b = resultBadge(r);
    assert.equal(b.cls, 'badge-ambiguous');
    assert.equal(b.text, 'PASS?');
    assert.equal(b.title, 'two edges');
    assert.equal(r.pass_fail, 'pass');
    assert.equal(resultBadge({ ...r, pass_fail: 'fail' }).text, 'FAIL?');
  });
  it('non-ambiguous and unmatched badges are unchanged', () => {
    assert.equal(resultBadge({ matched: true, pass_fail: 'pass' }).cls, 'badge-pass');
    assert.equal(resultBadge({ matched: false, ambiguous: true }).cls, 'badge-unmatched');
  });
  it('survives workspace serialize/restore', () => {
    state.inspectionResults = [r];
    const rec = serializeWorkspace();
    restoreWorkspace(freshWorkspaceRecord());
    assert.deepStrictEqual(state.inspectionResults, []);
    restoreWorkspace(rec);
    assert.equal(state.inspectionResults[0].ambiguous, true);
    assert.equal(state.inspectionResults[0].pass_fail, 'pass');
    restoreWorkspace(freshWorkspaceRecord());
  });
});
