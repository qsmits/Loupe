/**
 * Tests for frontend/spec.js — pure per-measurement tolerance spec evaluator.
 * No DOM dependencies.
 *
 * Run with: node --test tests/frontend/test_spec.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSpec, formatDeviation } from '../../frontend/spec.js';

describe('evaluateSpec', () => {
  const spec = { nominal: 3.6, upper: 0.05, lower: -0.05 };
  it('passes inside the band', () => {
    const r = evaluateSpec(3.625, spec);
    // The raw float has a representation artifact (0.025000000000000355);
    // per the brief's Step 4, assert with a tolerance instead of pinning it.
    assert.ok(Math.abs(r.deviation - 0.025) < 1e-9);
    assert.equal(r.pass, true);
  });
  it('fails above upper', () =>
    assert.equal(evaluateSpec(3.675, spec).pass, false));
  it('fails below lower (asymmetric)', () =>
    assert.equal(evaluateSpec(3.4, { nominal: 3.6, upper: 0.2, lower: -0.1 }).pass, false));
  it('boundary values pass (inclusive)', () =>
    assert.equal(evaluateSpec(3.65, spec).pass, true));
  it('null without nominal or value', () => {
    assert.equal(evaluateSpec(3.6, null), null);
    assert.equal(evaluateSpec(3.6, { nominal: NaN }), null);
    assert.equal(evaluateSpec(undefined, spec), null);
    assert.equal(evaluateSpec(null, spec), null);
  });
  it('missing limits default to 0 (exact-nominal spec)', () => {
    assert.equal(evaluateSpec(3.6, { nominal: 3.6 }).pass, true);
    assert.equal(evaluateSpec(3.61, { nominal: 3.6 }).pass, false);
  });
});

describe('formatDeviation', () => {
  it('formats mm', () => assert.equal(formatDeviation(0.025, 'mm', 'mm'), '▲+0.025 mm'));
  it('formats negative', () => assert.equal(formatDeviation(-0.075, 'mm', 'mm'), '▼−0.075 mm'));
  it('converts to µm on µm display', () =>
    assert.equal(formatDeviation(0.0253, 'mm', 'µm'), '▲+25.3 µm'));
  it('degrees pass through', () => assert.equal(formatDeviation(0.12, '°', 'mm'), '▲+0.12 °'));
});
