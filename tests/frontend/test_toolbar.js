/**
 * Tests for frontend/toolbar.js — the row-2 flat toolbar that replaced the
 * floating #tool-strip dock, its flyouts, and the floating sub-mode selector
 * (Track B Task 9).
 *
 * toolbar.js is a Preact/htm component: calling `html`/`h()` only builds
 * plain vnode objects ({ type, props, ... }) — it never touches the DOM.
 * That means we can test the toolbar's structure and active-state logic
 * without a browser or jsdom: call `Toolbar()` directly (no `render()`),
 * then "shallow-expand" the vnode tree by invoking any function-component
 * node (`ToolButton`, `SubModeSegment`) with its own props, recursing until
 * only host (string-typed) elements remain. This exercises the exact same
 * label/active/dispatch logic a real render would, with no fabricated DOM
 * assertions.
 *
 * `dispatch()` does call `document.dispatchEvent`, so dom-stub.js is loaded
 * for that one slice of behavior (click -> CustomEvent).
 *
 * Run with: node --test tests/frontend/test_toolbar.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './dom-stub.js';
import { state } from '../../frontend/state.js';
import { Toolbar } from '../../frontend/toolbar.js';

// ── Shallow-expand helper ────────────────────────────────────────────────────
// Recurses into arrays and function-component vnodes (by calling them),
// collecting only host-element vnodes (type is a string, e.g. "button").
function expand(node, out = []) {
  if (node == null || node === false || typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) { node.forEach(n => expand(n, out)); return out; }
  if (typeof node.type === 'function') {
    expand(node.type(node.props), out);
    return out;
  }
  out.push(node);
  const kids = node.props && node.props.children;
  if (kids != null) expand(kids, out);
  return out;
}

function hasClass(node, cls) {
  return (node.props.class || '').split(/\s+/).includes(cls);
}

function render() {
  return expand(Toolbar());
}

function toolButtons(nodes) {
  return nodes.filter(n => n.type === 'button' && hasClass(n, 'tb-btn'));
}

function segButtons(nodes) {
  return nodes.filter(n => n.type === 'button' && hasClass(n, 'tb-seg-btn'));
}

// Snapshot/restore the handful of state fields the toolbar reads, so tests
// don't leak into each other or into other test files run in the same
// process (state is a module singleton).
const SNAPSHOT_KEYS = ['tool', 'circleMode', 'arcFitMode', 'arcMeasureMode', 'angleMode', '_originMode'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(SNAPSHOT_KEYS.map(k => [k, state[k]]));
});
function restore() {
  Object.assign(state, saved);
}

describe('Toolbar — flat tool buttons', () => {
  it('renders exactly one button per underlying tool, plus Calibrate/Origin/Undo/Redo', () => {
    const nodes = render();
    const btns = toolButtons(nodes);
    // 13 measurement/select/pan/note tools (TOOL_BUTTONS minus the divider)
    // + Calibrate + Origin + Undo + Redo = 17.
    assert.equal(btns.length, 17);
    restore();
  });

  it('includes every tool reachable via setTool (no hidden/flyout-only tools)', () => {
    const nodes = render();
    const btns = toolButtons(nodes);
    const titles = btns.map(b => b.props.title);
    const expectedTools = [
      'Select', 'Pan', 'Note', 'Distance', 'Angle', 'Circle', 'Best fit', 'Arc',
      'Area', 'Shape', 'Spline', 'Flatness', 'Point', 'Calibrate', 'Set origin', 'Undo', 'Redo',
    ];
    for (const label of expectedTools) {
      assert.ok(
        titles.some(t => t.startsWith(label)),
        `expected a toolbar button labeled "${label}", got titles: ${titles.join(', ')}`,
      );
    }
    restore();
  });

  it('renders 3 dividers (after Note, after sub-mode segment, before Undo)', () => {
    const nodes = render();
    const dividers = nodes.filter(n => n.type === 'div' && (n.props.class || '') === 'tb-divider');
    assert.equal(dividers.length, 3);
    restore();
  });

  it('every button has a non-empty inline-SVG icon (no emoji)', () => {
    const nodes = render();
    const svgs = nodes.filter(n => n.type === 'svg');
    // One svg per tb-btn (Calibrate/Origin/Undo/Redo + 13 tools = 17).
    assert.equal(svgs.length, 17);
    for (const svg of svgs) {
      const html = svg.props.dangerouslySetInnerHTML?.__html;
      assert.ok(html && html.length > 0, 'icon markup should not be empty');
      assert.ok(html.includes('<path') || html.includes('<circle'), 'icon should be SVG path/circle markup');
    }
    restore();
  });
});

describe('Toolbar — active-state derivation', () => {
  it('highlights the button matching state.tool and no other', () => {
    state.tool = 'distance';
    const nodes = render();
    const btns = toolButtons(nodes);
    const active = btns.filter(b => hasClass(b, 'active'));
    assert.equal(active.length, 1);
    assert.equal(active[0].props.title, 'Distance (D)');
    restore();
  });

  it('highlights Calibrate when state.tool === "calibrate"', () => {
    state.tool = 'calibrate';
    const nodes = render();
    const btns = toolButtons(nodes);
    const active = btns.filter(b => hasClass(b, 'active'));
    assert.equal(active.length, 1);
    assert.equal(active[0].props.title, 'Calibrate (C)');
    restore();
  });

  it('highlights Origin when state._originMode is true, independent of state.tool', () => {
    state.tool = 'select';
    state._originMode = true;
    const nodes = render();
    const originBtn = toolButtons(nodes).find(b => b.props.title === 'Set origin');
    assert.ok(originBtn);
    assert.ok(hasClass(originBtn, 'active'));
    restore();
  });

  it('Undo/Redo are never highlighted (stateless actions)', () => {
    const nodes = render();
    const btns = toolButtons(nodes);
    const undo = btns.find(b => b.props.title.startsWith('Undo'));
    const redo = btns.find(b => b.props.title.startsWith('Redo'));
    assert.ok(!hasClass(undo, 'active'));
    assert.ok(!hasClass(redo, 'active'));
    restore();
  });
});

describe('Toolbar — contextual sub-mode segment', () => {
  it('shows no segment for tools without sub-modes (e.g. select, distance, area)', () => {
    for (const tool of ['select', 'pan', 'distance', 'area', 'spline', 'fit-line', 'point']) {
      state.tool = tool;
      const nodes = render();
      assert.equal(segButtons(nodes).length, 0, `expected no sub-mode segment for "${tool}"`);
    }
    restore();
  });

  it('circle tool shows 3-point / Center+edge, matching state.circleMode', () => {
    state.tool = 'circle';
    state.circleMode = 'center-edge';
    const nodes = render();
    const segs = segButtons(nodes);
    assert.equal(segs.length, 2);
    assert.ok(segs.some(b => hasClass(b, 'active') && flattenText(b).includes('Center+edge')));
    assert.ok(segs.some(b => !hasClass(b, 'active') && flattenText(b).includes('3-point')));
    restore();
  });

  it('arc-fit tool shows Circle / Arc, matching state.arcFitMode', () => {
    state.tool = 'arc-fit';
    state.arcFitMode = 'circle';
    const nodes = render();
    const segs = segButtons(nodes);
    assert.equal(segs.length, 2);
    assert.ok(segs.some(b => hasClass(b, 'active') && flattenText(b).includes('Circle')));
    restore();
  });

  it('arc-measure tool shows Sequential / Ends first, matching state.arcMeasureMode', () => {
    state.tool = 'arc-measure';
    state.arcMeasureMode = 'ends-first';
    const nodes = render();
    const segs = segButtons(nodes);
    assert.equal(segs.length, 2);
    assert.ok(segs.some(b => hasClass(b, 'active') && flattenText(b).includes('Ends first')));
    restore();
  });

  it('angle tool shows Two lines / Three points, matching state.angleMode', () => {
    state.tool = 'angle';
    state.angleMode = 'three-points';
    const nodes = render();
    const segs = segButtons(nodes);
    assert.equal(segs.length, 2);
    assert.ok(segs.some(b => hasClass(b, 'active') && flattenText(b).includes('Three points')));
    restore();
  });
});

describe('Toolbar — dispatch wiring', () => {
  it('clicking a tool button dispatches set-tool with the right tool', () => {
    state.tool = 'select';
    const nodes = render();
    const distanceBtn = toolButtons(nodes).find(b => b.props.title === 'Distance (D)');
    let captured = null;
    const handler = e => { captured = e.detail; };
    document.addEventListener('set-tool', handler);
    distanceBtn.props.onClick();
    document.removeEventListener('set-tool', handler);
    assert.deepEqual(captured, { tool: 'distance' });
    restore();
  });

  it('clicking a sub-mode option dispatches set-tool with the tool + mode field', () => {
    state.tool = 'circle';
    state.circleMode = '3-point';
    const nodes = render();
    const centerEdgeBtn = segButtons(nodes).find(b => flattenText(b).includes('Center+edge'));
    let captured = null;
    const handler = e => { captured = e.detail; };
    document.addEventListener('set-tool', handler);
    centerEdgeBtn.props.onClick();
    document.removeEventListener('set-tool', handler);
    assert.deepEqual(captured, { tool: 'circle', circleMode: 'center-edge' });
    restore();
  });

  it('clicking Origin dispatches toolbar-action origin', () => {
    const nodes = render();
    const originBtn = toolButtons(nodes).find(b => b.props.title === 'Set origin');
    let captured = null;
    const handler = e => { captured = e.detail; };
    document.addEventListener('toolbar-action', handler);
    originBtn.props.onClick();
    document.removeEventListener('toolbar-action', handler);
    assert.deepEqual(captured, { action: 'origin' });
    restore();
  });

  it('clicking Undo/Redo dispatches toolbar-action undo/redo', () => {
    const nodes = render();
    const btns = toolButtons(nodes);
    const undoBtn = btns.find(b => b.props.title.startsWith('Undo'));
    const redoBtn = btns.find(b => b.props.title.startsWith('Redo'));
    const captured = [];
    const handler = e => captured.push(e.detail);
    document.addEventListener('toolbar-action', handler);
    undoBtn.props.onClick();
    redoBtn.props.onClick();
    document.removeEventListener('toolbar-action', handler);
    assert.deepEqual(captured, [{ action: 'undo' }, { action: 'redo' }]);
    restore();
  });
});

function flattenText(node) {
  const kids = node.props && node.props.children;
  if (kids == null) return '';
  if (typeof kids === 'string') return kids;
  if (Array.isArray(kids)) return kids.map(flattenText).join('');
  if (typeof kids === 'object' && 'props' in kids) return flattenText(kids);
  return String(kids);
}
