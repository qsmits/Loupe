// tests/frontend/test_palette.js
import './dom-stub.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, filterTasks } from '../../frontend/palette.js';
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
