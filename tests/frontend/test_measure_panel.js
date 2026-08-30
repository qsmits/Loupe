/**
 * Tests for frontend/measure-panel.js — the Measure panel column: collapsed
 * strip while idle, guided-procedure face while a tool is armed, properties
 * placeholder face when idle with a selection (Task 9 fills that face in).
 *
 * measure-panel.js only builds plain vnode objects via htm/preact's `h()` —
 * it never touches the DOM — so we can test structure/text without a
 * browser or jsdom: call `MeasurePanel()` directly (no `render()`), then
 * recursively expand function-component vnodes and flatten nested arrays
 * (htm leaves a `${arr.map(...)}` interpolation as a *nested* array inside
 * `props.children`, so any expander must check `Array.isArray` before
 * `typeof node.type === 'function'`, exactly like the recursion in
 * tests/frontend/test_toolbar.js's `expand()`).
 *
 * Run with: node --test tests/frontend/test_measure_panel.js
 */
import './dom-stub.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';
import { MeasurePanel } from '../../frontend/measure-panel.js';

// Recursively expand function-component vnodes and flatten nested arrays
// (the same recursion test_toolbar.js's expand() uses, checking
// Array.isArray before typeof node.type === 'function'), collecting every
// host-element vnode encountered along the way, in document order.
function expand(node, out = []) {
  if (node == null || node === false || node === true ||
      typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) { node.forEach(n => expand(n, out)); return out; }
  if (typeof node.type === 'function') {
    expand(node.type(node.props ?? {}), out);
    return out;
  }
  out.push(node);
  if (node.props?.children != null) expand(node.props.children, out);
  return out;
}

// Same recursion, collecting string leaves instead of host vnodes.
function textOf(node, acc = []) {
  if (node == null || node === false || node === true) return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { node.forEach(n => textOf(n, acc)); return acc; }
  if (typeof node.type === 'function') { textOf(node.type(node.props ?? {}), acc); return acc; }
  textOf(node.props?.children, acc);
  return acc;
}

function hasClass(node, cls) {
  return (node.props.class || '').split(/\s+/).includes(cls);
}

beforeEach(() => {
  Object.assign(state, { tool: 'select', selected: new Set(), pendingPoints: [],
                         pendingRefLine: null, measurePanelCollapsed: false,
                         angleMode: 'two-lines', circleMode: '3-point',
                         arcMeasureMode: 'sequential', calibration: null, annotations: [] });
});

describe('MeasurePanel faces', () => {
  it('renders the collapsed strip when idle in select mode', () => {
    const txt = textOf(MeasurePanel()).join(' ');
    assert.match(txt, /MEASURE/);
  });
  it('renders procedure steps when a tool is armed', () => {
    state.tool = 'distance';
    const txt = textOf(MeasurePanel()).join(' ');
    assert.match(txt, /Click the first point/);
    assert.match(txt, /Click the second point/);
  });
  it('marks the current step', () => {
    state.tool = 'distance';
    state.pendingPoints = [{ x: 1, y: 1 }];
    const nodes = expand(MeasurePanel());
    // exactly one element carries the mp-step-current class
    const current = nodes.filter(n => hasClass(n, 'mp-step-current'));
    assert.equal(current.length, 1);
  });
  it('shows the live fit line for arc-fit with 3+ points', () => {
    state.tool = 'arc-fit';
    state.pendingPoints = [{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 }];
    const txt = textOf(MeasurePanel()).join(' ');
    // procedures.js::circleFitLive emits "Ø" (U+00D8, Latin O-stroke), not
    // the diameter sign "⌀" (U+2300) the brief's draft assertion used.
    assert.match(txt, /Preview: Ø/);
  });
});
