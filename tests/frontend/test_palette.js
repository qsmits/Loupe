// tests/frontend/test_palette.js
import './dom-stub.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, filterTasks, initPalette, renderPalette } from '../../frontend/palette.js';
import { PROCEDURES } from '../../frontend/procedures.js';
import { RELATION_TOOLS } from '../../frontend/tools.js';

describe('palette task registry', () => {
  it('covers all six relation tools', () => {
    const armed = new Set(TASKS.map(t => t.action.tool));
    for (const rt of RELATION_TOOLS) assert.ok(armed.has(rt), `no task arms "${rt}"`);
  });
  it('every task tool has a procedure', () => {
    for (const t of TASKS) assert.ok(PROCEDURES[t.action.tool], `no procedure for task "${t.id}"`);
  });
  it('every task has group, title, desc, icon', () => {
    for (const t of TASKS)
      for (const f of ['group', 'title', 'desc', 'icon'])
        assert.ok(t[f], `task "${t.id}" missing ${f}`);
  });
});

// Finding I6(a): a tab switch (workspace-changed) must re-render the palette
// so it can't show stale content (or a stale open/closed state) from the
// previously-active tab. Preact's render() can't actually mount into
// dom-stub's fake DOM (it's deliberately not a faithful DOM — see its own
// header comment — and the existing measure-panel/toolbar tests all avoid
// invoking it too), so this checks the wiring structurally: spy on
// document.addEventListener and assert initPalette() registered exactly the
// same handler reference renderMeasurePanel's initMeasurePanel() already
// registers for the same event.
describe('palette re-renders on workspace-changed (Finding I6a)', () => {
  it('initPalette registers renderPalette for the workspace-changed event', () => {
    const registered = [];
    const origAdd = document.addEventListener.bind(document);
    document.addEventListener = (type, fn) => { registered.push([type, fn]); origAdd(type, fn); };
    try {
      initPalette();
    } finally {
      document.addEventListener = origAdd;
    }
    assert.ok(
      registered.some(([type, fn]) => type === 'workspace-changed' && fn === renderPalette),
      'expected document.addEventListener("workspace-changed", renderPalette)'
    );
  });
});

describe('filterTasks', () => {
  it('empty query returns all', () => assert.equal(filterTasks(TASKS, '').length, TASKS.length));
  it('matches title, case-insensitive', () => {
    const r = filterTasks(TASKS, 'TWO CIRCLES');
    assert.ok(r.some(t => t.action.tool === 'center-dist'));
  });
  it('matches keywords', () => {
    const r = filterTasks(TASKS, 'diameter');
    assert.ok(r.some(t => t.action.tool === 'circle' || t.action.tool === 'arc-fit'));
  });
  it('no match returns empty', () => assert.equal(filterTasks(TASKS, 'zzzzz').length, 0));
});
