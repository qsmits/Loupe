/**
 * Pure unit tests for frontend/deviation-color.js.
 * Run with: node --test tests/frontend/test_deviation_color.js
 *
 * Fix round 1 (I1): _deviationColor used to recompute pass/warn/fail from
 * `tolerance_warn`/`tolerance_fail` + state.tolerances, which are stale
 * global values for a feature judged by a DXF drawing spec or default_tol —
 * it now trusts the backend's `pass_fail` verdict directly. These tests
 * pin that a result's own pass_fail decides color "regardless of globals",
 * while the punch/die reworkable-hue nuance is preserved.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';
import { deviationColor } from '../../frontend/deviation-color.js';

const GREEN = "#32d74b";
const AMBER = "#ff9f0a";
const RED   = "#ff453a";

beforeEach(() => {
  state.featureModes = {};
  // Deliberately hostile globals: if deviationColor still consulted these,
  // every one of the tests below that expect a definitive pass_fail-driven
  // color would get the wrong answer instead.
  state.tolerances = { warn: 999, fail: 9999 };
});

describe('deviationColor', () => {
  it('pass_fail "pass" is always green, regardless of globals', () => {
    const r = { pass_fail: 'pass', perp_dev_mm: 50, radius_dev_mm: null };
    assert.equal(deviationColor(r), GREEN);
  });

  it('pass_fail "fail" on a line (no radius_dev_mm) is red, regardless of globals', () => {
    const r = { pass_fail: 'fail', perp_dev_mm: 0.0001, radius_dev_mm: null };
    assert.equal(deviationColor(r), RED);
  });

  it('pass_fail "warn" on a line (no radius_dev_mm) is amber, regardless of globals', () => {
    const r = { pass_fail: 'warn', perp_dev_mm: 0.0001, radius_dev_mm: null };
    assert.equal(deviationColor(r), AMBER);
  });

  it('a spec/default-tol-judged fail on a circle still colors danger', () => {
    // e.g. a DWG-spec size verdict of 'fail' with a tiny center_dev_mm that
    // would have looked like "pass" under the old tolerance_warn/fail-based
    // recomputation.
    const r = {
      pass_fail: 'fail', radius_dev_mm: 5.0,   // wrong-direction, non-reworkable below
      handle: 'C1', tolerance_warn: 999, tolerance_fail: 9999,
    };
    state.featureModes = { C1: 'die' };  // die + positive radius dev = not reworkable
    assert.equal(deviationColor(r), RED);
  });

  describe('punch/die reworkable-hue nuance (preserved from before extraction)', () => {
    it('die mode, undersize (radius_dev < 0) is reworkable -> amber even on fail', () => {
      const r = { pass_fail: 'fail', radius_dev_mm: -0.5, handle: 'C1' };
      state.featureModes = { C1: 'die' };
      assert.equal(deviationColor(r), AMBER);
    });

    it('die mode, oversize (radius_dev > 0) is NOT reworkable -> red', () => {
      const r = { pass_fail: 'fail', radius_dev_mm: 0.5, handle: 'C1' };
      state.featureModes = { C1: 'die' };
      assert.equal(deviationColor(r), RED);
    });

    it('punch mode, oversize (radius_dev > 0) is reworkable -> amber even on fail', () => {
      const r = { pass_fail: 'fail', radius_dev_mm: 0.5, handle: 'C1' };
      state.featureModes = { C1: 'punch' };
      assert.equal(deviationColor(r), AMBER);
    });

    it('punch mode, undersize (radius_dev < 0) is NOT reworkable -> red', () => {
      const r = { pass_fail: 'fail', radius_dev_mm: -0.5, handle: 'C1' };
      state.featureModes = { C1: 'punch' };
      assert.equal(deviationColor(r), RED);
    });

    it('falls back to parent_handle when featureModes has no entry for handle', () => {
      const r = { pass_fail: 'fail', radius_dev_mm: -0.5, handle: 'seg_1', parent_handle: 'GEAR1' };
      state.featureModes = { GEAR1: 'die' };
      assert.equal(deviationColor(r), AMBER);
    });

    it('defaults to "die" mode when neither handle nor parent_handle is configured', () => {
      const r = { pass_fail: 'fail', radius_dev_mm: -0.5, handle: 'C9' };
      state.featureModes = {};
      assert.equal(deviationColor(r), AMBER);  // die + undersize = reworkable
    });
  });
});
