/**
 * Pure unit tests for frontend/tolerance-format.js.
 * Run with: node --test tests/frontend/test_tolerance_format.js
 *
 * Fix round 1 (I2, I5): the sidebar table, CSV export, and PDF export used
 * to each print their own ±tolerance_warn/tolerance_fail text, which is
 * stale for a feature judged by a DXF drawing spec or a default_tol.
 * formatToleranceCell() is the single source of truth all three now share;
 * these tests pin its DWG/DEF precedence, the Ø/R kind prefix (radius specs
 * must read differently from diameter specs since scoring doubles them),
 * and that a spec'd feature's CSV row carries the spec band, not the
 * globals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatToleranceCell, buildInspectionCsvRow, INSPECTION_CSV_HEADERS,
  formatToleranceTooltipLines,
} from '../../frontend/tolerance-format.js';

function baseResult(overrides = {}) {
  return {
    handle: 'C1',
    type: 'circle',
    matched: true,
    deviation_mm: 0.01,
    pass_fail: 'pass',
    tolerance_warn: 0.1,
    tolerance_fail: 0.25,
    ...overrides,
  };
}

describe('formatToleranceCell', () => {
  it('a diameter-kind spec is prefixed with the diameter symbol and tagged DWG', () => {
    const r = baseResult({ spec: { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 } });
    const cell = formatToleranceCell(r);
    assert.equal(cell.text, '⌀20.000 +0.050/-0.020');
    assert.equal(cell.tag, 'DWG');
  });

  it('a radius-kind spec is prefixed "R" (not ⌀) — must read visibly differently from diameter', () => {
    const r = baseResult({ spec: { kind: 'radius', nominal: 10, upper: 0.01, lower: -0.01 } });
    const cell = formatToleranceCell(r);
    assert.equal(cell.text, 'R10.000 +0.010/-0.010');
    assert.equal(cell.tag, 'DWG');
    assert.notEqual(cell.text[0], '⌀');
  });

  it('spec takes precedence over spec_source "default" when both are present', () => {
    const r = baseResult({
      spec: { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 },
      spec_source: 'default',
      default_tol_used: 0.15,
    });
    assert.equal(formatToleranceCell(r).tag, 'DWG');
  });

  it('default_tol (no spec) is a plain ±x tagged DEF', () => {
    const r = baseResult({ spec_source: 'default', default_tol_used: 0.15 });
    const cell = formatToleranceCell(r);
    assert.equal(cell.text, '±0.15');
    assert.equal(cell.tag, 'DEF');
  });

  it('no spec, no default_tol falls back to today\'s ±warn/fail with no tag', () => {
    const r = baseResult();
    const cell = formatToleranceCell(r);
    assert.equal(cell.text, '±0.1/0.25');
    assert.equal(cell.tag, null);
  });

  it('spec_source "default" without a captured default_tol_used still falls back (defensive)', () => {
    const r = baseResult({ spec_source: 'default', default_tol_used: null });
    const cell = formatToleranceCell(r);
    assert.equal(cell.tag, null);
  });
});

describe('buildInspectionCsvRow', () => {
  it('a spec-judged feature\'s row contains the spec band, not the global tolerance_warn/fail', () => {
    const r = baseResult({
      spec: { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 },
      size_dev_mm: 0.01,
      tolerance_warn: 999,   // hostile globals: if these leaked into the row, the test fails
      tolerance_fail: 9999,
    });
    const row = buildInspectionCsvRow(r, 'partA', '2026-01-01T00:00:00.000Z');
    const idx = name => INSPECTION_CSV_HEADERS.indexOf(name);
    assert.equal(row[idx('tolerance')], '⌀20.000 +0.050/-0.020');
    assert.equal(row[idx('tolerance_tag')], 'DWG');
    assert.equal(row[idx('size_dev_mm')], '0.0100');
    assert.ok(!row.includes(999) && !row.includes(9999), 'hostile globals must not appear anywhere in the row');
  });

  it('a default-tol-judged feature\'s row contains ±x tagged DEF', () => {
    const r = baseResult({ spec_source: 'default', default_tol_used: 0.15, tolerance_warn: 999, tolerance_fail: 9999 });
    const row = buildInspectionCsvRow(r, 'partA', 't');
    const idx = name => INSPECTION_CSV_HEADERS.indexOf(name);
    assert.equal(row[idx('tolerance')], '±0.15');
    assert.equal(row[idx('tolerance_tag')], 'DEF');
  });

  it('an ordinary (no spec, no default_tol) feature keeps today\'s ±warn/fail with an empty tag', () => {
    const r = baseResult();
    const row = buildInspectionCsvRow(r, 'partA', 't');
    const idx = name => INSPECTION_CSV_HEADERS.indexOf(name);
    assert.equal(row[idx('tolerance')], '±0.1/0.25');
    assert.equal(row[idx('tolerance_tag')], '');
  });

  it('size_dev_mm column is blank when no spec applies, even if the field happens to be set', () => {
    const r = baseResult({ size_dev_mm: 0.5 });  // no r.spec -> should not surface
    const row = buildInspectionCsvRow(r, 'partA', 't');
    const idx = name => INSPECTION_CSV_HEADERS.indexOf(name);
    assert.equal(row[idx('size_dev_mm')], '');
  });

  it('unmatched features report UNMATCHED as their result', () => {
    const r = baseResult({ matched: false, deviation_mm: null, pass_fail: null });
    const row = buildInspectionCsvRow(r, 'partA', 't');
    const idx = name => INSPECTION_CSV_HEADERS.indexOf(name);
    assert.equal(row[idx('result')], 'UNMATCHED');
  });

  it('row length matches INSPECTION_CSV_HEADERS length', () => {
    const row = buildInspectionCsvRow(baseResult(), 'partA', 't');
    assert.equal(row.length, INSPECTION_CSV_HEADERS.length);
  });
});

// Fix round 2: the canvas hover tooltip (events-mouse.js) printed a raw
// `Tolerance: warn ±x  fail ±y` line unconditionally, showing the stale
// global band for a DWG/DEF-scored feature. formatToleranceTooltipLines is
// the thin, prose-shaped sibling of formatToleranceCell that fixes it.
describe('formatToleranceTooltipLines', () => {
  it('a diameter-kind spec renders "Tolerance: ⌀nominal +u/-l (DWG)"', () => {
    const r = baseResult({ spec: { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 } });
    const lines = formatToleranceTooltipLines(r);
    assert.equal(lines[0], 'Tolerance: ⌀20.000 +0.050/-0.020 (DWG)');
  });

  it('a radius-kind spec is R-prefixed, not ⌀ (must read differently — scoring doubles it)', () => {
    const r = baseResult({ spec: { kind: 'radius', nominal: 10, upper: 0.01, lower: -0.01 } });
    const lines = formatToleranceTooltipLines(r);
    assert.equal(lines[0], 'Tolerance: R10.000 +0.010/-0.010 (DWG)');
  });

  it('includes a size-deviation line when r.spec and r.size_dev_mm are set', () => {
    const r = baseResult({
      spec: { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 },
      size_dev_mm: 0.01,
    });
    const lines = formatToleranceTooltipLines(r);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^Size dev: \+0\.0100 mm/);
  });

  it('a radius-kind spec\'s size-deviation line reports the diameter-basis nominal (2x), not the radius', () => {
    const r = baseResult({
      spec: { kind: 'radius', nominal: 10, upper: 0.01, lower: -0.01 },
      size_dev_mm: -0.005,
    });
    const lines = formatToleranceTooltipLines(r);
    assert.match(lines[1], /nominal 20\.000/);
  });

  it('omits the size-deviation line when r.size_dev_mm is absent, even with a spec', () => {
    const r = baseResult({ spec: { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 } });
    const lines = formatToleranceTooltipLines(r);
    assert.equal(lines.length, 1);
  });

  it('a default-tol-judged (no-spec) feature renders "Tolerance: ±x (DEF)"', () => {
    const r = baseResult({ spec_source: 'default', default_tol_used: 0.15 });
    assert.deepEqual(formatToleranceTooltipLines(r), ['Tolerance: ±0.15 (DEF)']);
  });

  it('no spec, no default_tol keeps today\'s exact "warn ±x  fail ±y" prose', () => {
    const r = baseResult({ tolerance_warn: 0.1, tolerance_fail: 0.25 });
    assert.deepEqual(formatToleranceTooltipLines(r), ['Tolerance: warn ±0.1  fail ±0.25']);
  });

  it('ignores hostile globals when a spec is present', () => {
    const r = baseResult({
      spec: { kind: 'diameter', nominal: 20, upper: 0.05, lower: -0.02 },
      tolerance_warn: 999, tolerance_fail: 9999,
    });
    const lines = formatToleranceTooltipLines(r);
    assert.ok(!lines.join('\n').includes('999'));
  });
});
