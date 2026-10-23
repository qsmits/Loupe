import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCpkSummary } from '../../frontend/spc.js';

test('SPC summary accepts the backend schema and undefined capability', () => {
  const el = { innerHTML: '' };
  renderCpkSummary(el, {count: 3, mean: .2, std: 0, min: .2, max: .2,
    cpk: null, cpk_unavailable_reason: 'zero_variance'});
  assert.match(el.innerHTML, /zero observed variation/);
  assert.match(el.innerHTML, /n=3/);
  assert.doesNotMatch(el.innerHTML, /cpk-good|NaN|undefined/);
  renderCpkSummary(el, {count: 1, cpk: null});
  assert.match(el.innerHTML, /Need 2\+ runs/);
});

test('SPC explains excluded uncertain measurements even with insufficient data', () => {
  const el = { innerHTML: '' };
  for (const count of [0, 2]) {
    renderCpkSummary(el, { count, excluded_count: 3, mean: .02, std: .01,
      min: .01, max: .03, cpk: 2 });
    assert.match(el.innerHTML, /3 ambiguous\/unmatched measurements excluded from SPC/);
  }
});
