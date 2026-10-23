import './dom-stub.js';
import { registerElement, resetElements } from './dom-stub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectionSummary } from '../../frontend/inspect-request.js';
import { deviationColor } from '../../frontend/deviation-color.js';
import { renderInspectionTable } from '../../frontend/sidebar.js';
import { exportInspectionPdf } from '../../frontend/session.js';
import { state } from '../../frontend/state.js';

const pass = { handle: 'C', type: 'circle', matched: true, pass_fail: 'pass',
  deviation_mm: 0.001, tolerance_warn: 0.1, tolerance_fail: 0.25 };
const ambiguous = { ...pass, ambiguous: true, reason: 'competing edges' };
const unmatched = { ...pass, matched: false, pass_fail: null, deviation_mm: null };

test('summary never approves ambiguous or incomplete inspections', () => {
  assert.equal(inspectionSummary([pass]).text, '1/1 matched — all PASS');
  assert.equal(inspectionSummary([ambiguous]).badge.text, 'PASS?');
  for (const results of [[ambiguous], [unmatched], [pass, unmatched], []]) {
    assert.doesNotMatch(inspectionSummary(results).text, /all PASS/);
    assert.notEqual(inspectionSummary(results).badge.cls, 'badge-pass');
  }
  const mixed = inspectionSummary([ambiguous, { ...pass, pass_fail: 'fail' }, unmatched]);
  assert.match(mixed.text, /1 FAIL.*1 ambiguous.*1 unmatched/);
  assert.equal(inspectionSummary([pass, unmatched]).badge.text, 'INCOMPLETE');
});

test('ambiguous guided geometry stays amber for lines, circles and arcs', () => {
  for (const pass_fail of ['pass', 'warn', 'fail']) {
    for (const radius_dev_mm of [null, -0.5, 0.5]) {
      assert.equal(deviationColor({ ...ambiguous, pass_fail, radius_dev_mm }), '#ff9f0a');
    }
  }
});

test('sidebar group and detail both show uncertainty', () => {
  resetElements();
  document.createTextNode = textContent => ({ textContent });
  const panel = document.createElement('div');
  const count = document.createElement('div');
  const tbody = document.createElement('tbody');
  registerElement('inspection-panel', panel);
  registerElement('inspection-count', count);
  registerElement('inspection-tbody', tbody);
  state.annotations = [];
  state.inspectionResults = [ambiguous];
  renderInspectionTable();
  assert.equal(count.textContent, '1/1 matched — 1 ambiguous');
  const badges = [];
  const visit = el => {
    if (el.className?.includes('insp-badge')) badges.push(el);
    for (const child of el.children || []) visit(child);
  };
  visit(tbody);
  assert.equal(badges.length, 2);
  assert.ok(badges.every(b => b.textContent === 'PASS?' && b.className.includes('badge-ambiguous')));
  state.inspectionResults = [];
  resetElements();
});

test('PDF group and detail use amber uncertainty labels', () => {
  const texts = [];
  let color;
  window.jspdf = { jsPDF: class {
    setFontSize() {} setFont() {} setFillColor() {} rect() {} addPage() {} save() {}
    setTextColor(...rgb) { color = rgb; }
    text(value) { texts.push({ value, color }); }
  } };
  state.annotations = [];
  state.inspectionResults = [ambiguous];
  exportInspectionPdf();
  const verdicts = texts.filter(t => t.value === 'PASS?');
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every(t => String(t.color) === '200,120,0'));
  assert.ok(!texts.some(t => t.value === 'PASS'));
  state.inspectionResults = [];
});
