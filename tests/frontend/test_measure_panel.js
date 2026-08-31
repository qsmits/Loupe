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
import { state, undoStack } from '../../frontend/state.js';
import { MeasurePanel, setPanelWidth } from '../../frontend/measure-panel.js';

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

// The vnode owns the panel width (not the DOM): a resize drag calls
// setPanelWidth(), which is baked into the style prop of the rendered root
// on every re-render. This is what makes collapsing always win over a
// previous resize — the collapsed root simply never receives a style prop,
// so `.mp-panel.mp-collapsed { width: 26px }` is never out-ranked by a
// leftover inline width (see main.js's fix-round-1 commit for the bug this
// guards against: a DOM-owned width survives a class-only collapse).
describe('MeasurePanel width ownership', () => {
  it('collapsing after a resize drops the inline width — the collapsed root carries no style', () => {
    state.tool = 'distance';
    setPanelWidth(400);
    state.measurePanelCollapsed = true;
    const root = MeasurePanel();
    assert.ok(hasClass(root, 'mp-collapsed'));
    assert.equal(root.props.style, undefined);
  });
  it('an expanded root carries setPanelWidth\'s clamped width', () => {
    state.tool = 'distance';
    state.measurePanelCollapsed = false;
    setPanelWidth(999);   // clamps to the 420px max
    const root = MeasurePanel();
    assert.equal(root.props.style.width, '420px');
  });
});

describe('panel buttons dispatch', () => {
  it('finish button dispatches measure-panel-action', () => {
    state.tool = 'arc-fit';
    state.pendingPoints = [{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: -10 }];
    let got = null;
    const h = e => { got = e.detail; };
    document.addEventListener('measure-panel-action', h);
    const tree = expand(MeasurePanel());
    // find the primary button and invoke its onClick
    const btns = tree.filter(n => hasClass(n, 'mp-btn-pri'));
    assert.equal(btns.length, 1);
    btns[0].props.onClick();
    document.removeEventListener('measure-panel-action', h);
    assert.deepEqual(got, { action: 'finish' });
  });
});

describe('properties face', () => {
  it('shows number, name, value and PASS chip for a toleranced measurement', () => {
    state.calibration = { pixelsPerMm: 100, displayUnit: 'mm' };
    state.annotations = [{ id: 7, type: 'distance', name: 'hole-pitch', purpose: 'measurement',
                           a: { x: 0, y: 0 }, b: { x: 362.5, y: 0 },
                           spec: { nominal: 3.6, upper: 0.05, lower: -0.05 } }];
    state.selected = new Set([7]);
    state.tool = 'select';
    const txt = textOf(expand(MeasurePanel())).join(' ');
    assert.match(txt, /\[1\]/);
    assert.match(txt, /3\.625 mm/);
    assert.match(txt, /PASS/);
    assert.match(txt, /▲\+0\.025 mm/);
  });
  it('shows FAIL when out of band', () => {
    state.calibration = { pixelsPerMm: 100, displayUnit: 'mm' };
    state.annotations = [{ id: 7, type: 'distance', name: '', purpose: 'measurement',
                           a: { x: 0, y: 0 }, b: { x: 367.5, y: 0 },
                           spec: { nominal: 3.6, upper: 0.05, lower: -0.05 } }];
    state.selected = new Set([7]);
    state.tool = 'select';
    assert.match(textOf(expand(MeasurePanel())).join(' '), /FAIL/);
  });
  it('multi-select shows only a count', () => {
    state.annotations = [
      { id: 1, type: 'distance', purpose: 'measurement', a: {x:0,y:0}, b: {x:1,y:0} },
      { id: 2, type: 'distance', purpose: 'measurement', a: {x:0,y:0}, b: {x:2,y:0} }];
    state.selected = new Set([1, 2]);
    state.tool = 'select';
    assert.match(textOf(expand(MeasurePanel())).join(' '), /2 selected/);
  });
  it('the properties face root carries the panel-owned width style', () => {
    state.calibration = null;
    state.annotations = [{ id: 7, type: 'distance', purpose: 'measurement',
                           a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }];
    state.selected = new Set([7]);
    state.tool = 'select';
    setPanelWidth(300);
    const root = MeasurePanel();
    assert.ok(hasClass(root, 'mp-panel'));
    assert.equal(root.props.style.width, '300px');
  });
  it('clearing the nominal field deletes ann.spec', () => {
    state.calibration = { pixelsPerMm: 100, displayUnit: 'mm' };
    const ann = { id: 7, type: 'distance', name: '', purpose: 'measurement',
                  a: { x: 0, y: 0 }, b: { x: 362.5, y: 0 },
                  spec: { nominal: 3.6, upper: 0.05, lower: -0.05 } };
    state.annotations = [ann];
    state.selected = new Set([7]);
    state.tool = 'select';
    const nodes = expand(MeasurePanel());
    const nominalInput = nodes.filter(n => hasClass(n, 'mp-in'))[0];
    nominalInput.props.onFocus();
    nominalInput.props.onInput({ target: { value: '' } });
    assert.equal(ann.spec, undefined);
  });
});

// Task 14: center-dist Pattern/Direction radio sections in the properties face.
describe('properties face — center-dist pattern/direction (Task 14)', () => {
  const mkCenterDist = extra => ({
    id: 7, type: 'center-dist', purpose: 'measurement',
    a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, circleAId: 1, circleBId: 2,
    ...extra,
  });

  it('Pattern section is absent for a non-center-dist selection', () => {
    state.annotations = [{ id: 7, type: 'distance', purpose: 'measurement',
                           a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }];
    state.selected = new Set([7]);
    state.tool = 'select';
    state.origin = null;
    const nodes = expand(MeasurePanel());
    assert.equal(nodes.filter(n => hasClass(n, 'mp-radio')).length, 0);
  });

  it('Pattern section renders three radios, Direction is absent without an origin', () => {
    state.annotations = [mkCenterDist({})];
    state.selected = new Set([7]);
    state.tool = 'select';
    state.origin = null;
    const nodes = expand(MeasurePanel());
    const sectTitles = nodes.filter(n => hasClass(n, 'mp-sect-t')).map(n => textOf(n).join(''));
    assert.ok(sectTitles.includes('Pattern'));
    assert.ok(!sectTitles.includes('Direction'), 'no origin → no Direction section');
    assert.equal(nodes.filter(n => hasClass(n, 'mp-radio')).length, 3);
  });

  it('Direction section renders when state.origin exists', () => {
    state.annotations = [mkCenterDist({})];
    state.selected = new Set([7]);
    state.tool = 'select';
    state.origin = { x: 0, y: 0, angle: 0 };
    const nodes = expand(MeasurePanel());
    const sectTitles = nodes.filter(n => hasClass(n, 'mp-sect-t')).map(n => textOf(n).join(''));
    assert.ok(sectTitles.includes('Direction'));
    assert.equal(nodes.filter(n => hasClass(n, 'mp-radio')).length, 6); // 3 pattern + 3 direction
    state.origin = null;
  });

  it('clicking a non-default pattern radio sets the field, pushes undo, dispatches annotations-changed', () => {
    const ann = mkCenterDist({});
    state.annotations = [ann];
    state.selected = new Set([7]);
    state.tool = 'select';
    state.origin = null;
    const before = undoStack.length;
    let fired = false;
    const h = () => { fired = true; };
    document.addEventListener('annotations-changed', h);
    const nodes = expand(MeasurePanel());
    const radios = nodes.filter(n => hasClass(n, 'mp-radio'));
    // order: centers, min, max
    radios[1].props.onClick();
    document.removeEventListener('annotations-changed', h);
    assert.equal(ann.pattern, 'min');
    assert.equal(undoStack.length, before + 1);
    assert.ok(fired);
  });

  it('clicking the default (centers) radio deletes ann.pattern rather than storing it', () => {
    const ann = mkCenterDist({ pattern: 'min' });
    state.annotations = [ann];
    state.selected = new Set([7]);
    state.tool = 'select';
    state.origin = null;
    const nodes = expand(MeasurePanel());
    const radios = nodes.filter(n => hasClass(n, 'mp-radio'));
    radios[0].props.onClick(); // "Between centers" — the default
    assert.equal(ann.pattern, undefined);
  });
});

// The brief's SpecField captures `undoPushed` in a closure scoped to one
// SpecField render. renderMeasurePanel() is NOT called on every keystroke
// (only on blur), so the closure survives an entire focus→blur session —
// this test pins that: multiple onInput calls between one onFocus/onBlur
// pair must push exactly one undo snapshot, and a second session (a fresh
// focus) must push exactly one more.
describe('properties face — undo session granularity', () => {
  it('pushes exactly one undo entry per focus→blur editing session', () => {
    state.calibration = { pixelsPerMm: 100, displayUnit: 'mm' };
    state.annotations = [{ id: 7, type: 'distance', name: '', purpose: 'measurement',
                           a: { x: 0, y: 0 }, b: { x: 362.5, y: 0 } }];
    state.selected = new Set([7]);
    state.tool = 'select';
    const nodes = expand(MeasurePanel());
    const inputs = nodes.filter(n => hasClass(n, 'mp-in'));
    assert.equal(inputs.length, 3); // nominal, upper, lower
    const nominalInput = inputs[0];
    const before = undoStack.length;
    nominalInput.props.onFocus();
    nominalInput.props.onInput({ target: { value: '3.6' } });
    nominalInput.props.onInput({ target: { value: '3.60' } });
    nominalInput.props.onInput({ target: { value: '3.600' } });
    assert.equal(undoStack.length, before + 1, 'three keystrokes in one session push exactly one snapshot');
    nominalInput.props.onBlur();
    assert.equal(undoStack.length, before + 1, 'blur pushes no additional snapshot');
    nominalInput.props.onFocus();
    nominalInput.props.onInput({ target: { value: '3.601' } });
    assert.equal(undoStack.length, before + 2, 'a new focus→blur session pushes exactly one more');
  });
});
