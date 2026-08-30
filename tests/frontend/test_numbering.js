/**
 * Tests for frontend/numbering.js — the single numbering authority shared by
 * the sidebar and canvas labels. Must replicate renderSidebar's exact
 * partition semantics (sidebar.js:171-197): overlay types and detections are
 * excluded outright, 'origin' never receives a number, grouped members are
 * numbered ahead of ungrouped ones (groups in first-appearance order), and
 * the purpose filter ('drawing'/'helper' rows are hidden from the *ungrouped*
 * list only — grouped members of any purpose are still numbered).
 *
 * Pure module — no DOM dependencies.
 *
 * Run with: node --test tests/frontend/test_numbering.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotationNumbers } from '../../frontend/numbering.js';

const A = (id, type = 'distance', extra = {}) =>
  ({ id, type, a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, purpose: 'measurement', ...extra });

describe('annotationNumbers', () => {
  it('numbers sequentially in annotation order, skipping origin and detections', () => {
    const anns = [A(1), { id: 2, type: 'origin', x: 0, y: 0, angle: 0 },
                  A(3, 'circle', { cx: 0, cy: 0, r: 5 }),
                  { id: 4, type: 'detected-circle', x: 1, y: 1, radius: 2 }];
    const m = annotationNumbers(anns);
    assert.equal(m.get(1), 1);
    assert.equal(m.get(3), 2);
    assert.equal(m.has(2), false);
    assert.equal(m.has(4), false);
  });
  it('grouped members come first, groups in first-appearance order', () => {
    const anns = [A(1), A(2), A(3), A(4)];
    // array order is 1,2,3,4 → the first grouped annotation encountered is ann 2 (g2),
    // so g2's members are numbered before g1's, then the ungrouped follow.
    const groups = { 3: 'g1', 2: 'g2' };
    const m = annotationNumbers(anns, groups);
    assert.equal(m.get(2), 1);  // g2 member
    assert.equal(m.get(3), 2);  // g1 member
    assert.equal(m.get(1), 3);  // ungrouped
    assert.equal(m.get(4), 4);
  });
  it('works past 20 items', () => {
    const anns = Array.from({ length: 25 }, (_, k) => A(k + 1));
    const m = annotationNumbers(anns);
    assert.equal(m.get(25), 25);
  });

  // ── Parity coverage: predicates ported from renderSidebar ────────────────

  it('skips overlay types (edges-overlay, preprocessed-overlay, dxf-overlay)', () => {
    const anns = [A(1), { id: 2, type: 'edges-overlay' }, { id: 3, type: 'preprocessed-overlay' },
                  { id: 4, type: 'dxf-overlay' }, A(5)];
    const m = annotationNumbers(anns);
    assert.equal(m.get(1), 1);
    assert.equal(m.get(5), 2);
    assert.equal(m.has(2), false);
    assert.equal(m.has(3), false);
    assert.equal(m.has(4), false);
  });

  it('skips all DETECTION_TYPES, not just detected-circle', () => {
    const anns = [A(1), { id: 2, type: 'detected-line' }, { id: 3, type: 'detected-line-merged' },
                  { id: 4, type: 'detected-arc-partial' }, A(5)];
    const m = annotationNumbers(anns);
    assert.equal(m.get(1), 1);
    assert.equal(m.get(5), 2);
    assert.equal(m.has(2), false);
    assert.equal(m.has(3), false);
    assert.equal(m.has(4), false);
  });

  it('an ungrouped non-measurement-purpose annotation is excluded (matches renderSidebar\'s isMeasurement filter)', () => {
    const anns = [A(1), A(2, 'distance', { purpose: 'drawing' }), A(3, 'distance', { purpose: 'helper' }), A(4)];
    const m = annotationNumbers(anns);
    assert.equal(m.get(1), 1);
    assert.equal(m.get(4), 2);
    assert.equal(m.has(2), false);
    assert.equal(m.has(3), false);
  });

  it('a GROUPED non-measurement-purpose annotation still gets a number (purpose filter is ungrouped-only)', () => {
    const anns = [A(1), A(2, 'distance', { purpose: 'drawing' }), A(3)];
    const groups = { 2: 'g1' };
    const m = annotationNumbers(anns, groups);
    assert.equal(m.get(2), 1);   // grouped, drawing-purpose — still numbered
    assert.equal(m.get(1), 2);   // ungrouped
    assert.equal(m.get(3), 3);
  });

  it('calibration-type annotations are ordinary measurements (not skipped)', () => {
    const anns = [A(1), { id: 2, type: 'calibration', x1: 0, y1: 0, x2: 1, y2: 1,
                          knownValue: 1, unit: 'mm', purpose: 'measurement' }, A(3)];
    const m = annotationNumbers(anns);
    assert.equal(m.get(1), 1);
    assert.equal(m.get(2), 2);
    assert.equal(m.get(3), 3);
  });

  it('defaults measurementGroups to {} (no group map argument)', () => {
    const anns = [A(1), A(2)];
    const m = annotationNumbers(anns);
    assert.equal(m.get(1), 1);
    assert.equal(m.get(2), 2);
  });
});
