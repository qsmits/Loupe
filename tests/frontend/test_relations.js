import './dom-stub.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';
import { setTool, handleToolClick, RELATION_TOOLS } from '../../frontend/tools.js';
import { addAnnotation } from '../../frontend/annotations.js';
import { getStatus } from '../../frontend/render.js';

beforeEach(() => {
  state.annotations = [];
  state.selected = new Set();
  state.nextId = 1;
  state.frozen = false;          // keeps handleToolClick's subpixel refine (server call) off
  state.calibration = null;
  state.pendingPoints = []; state.pendingRefLine = null;
  state.pendingCenterCircle = null; state.pendingCircleRef = null;
});

describe('center-dist resurrection', () => {
  it('two circle clicks create a linked center-dist and the tool stays armed', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const c2 = addAnnotation({ type: 'circle', cx: 400, cy: 100, r: 20 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // on c1 edge (safe for edge- or center-based snapToCircle)
    await handleToolClick({ x: 420, y: 100 });   // on c2 edge
    const rel = state.annotations.find(a => a.type === 'center-dist');
    assert.ok(rel, 'center-dist created');
    assert.equal(rel.circleAId, c1.id);
    assert.equal(rel.circleBId, c2.id);
    assert.deepEqual({ x: rel.a.x, y: rel.a.y }, { x: 100, y: 100 });
    assert.equal(state.tool, 'center-dist');     // stays armed
    assert.equal(state.pendingCenterCircle, null);
  });
});

describe('intersect resurrection', () => {
  it('two line clicks create an intersect annotation', async () => {
    const l1 = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    const l2 = addAnnotation({ type: 'distance', a: { x: 100, y: -100 }, b: { x: 100, y: 100 } });
    setTool('intersect');
    await handleToolClick({ x: 50, y: 0 });      // on l1
    await handleToolClick({ x: 100, y: 50 });    // on l2
    const rel = state.annotations.find(a => a.type === 'intersect');
    assert.ok(rel);
    assert.equal(rel.lineAId, l1.id);
    assert.equal(rel.lineBId, l2.id);
  });
});

describe('pt-circle-dist resurrection', () => {
  it('circle click then free-point click creates a linked pt-circle-dist and stays armed', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    setTool('pt-circle-dist');
    await handleToolClick({ x: 130, y: 100 });   // on c1 edge
    assert.ok(state.pendingCircleRef, 'circle pick registered');
    await handleToolClick({ x: 500, y: 500 });   // free point
    const rel = state.annotations.find(a => a.type === 'pt-circle-dist');
    assert.ok(rel, 'pt-circle-dist created');
    assert.equal(rel.circleId, c1.id);
    assert.equal(rel.px, 500);
    assert.equal(rel.py, 500);
    assert.equal(state.tool, 'pt-circle-dist');  // stays armed
    assert.equal(state.pendingCircleRef, null);
  });

  it('miss-click with no circle picked shows a status hint and creates nothing', async () => {
    setTool('pt-circle-dist');
    await handleToolClick({ x: 500, y: 500 });   // no circle nearby
    assert.equal(state.annotations.length, 0);
    assert.match(getStatus(), /circle/i);
    assert.equal(state.tool, 'pt-circle-dist');
  });
});

describe('perp-dist resurrection', () => {
  it('line pick, start point, end point create a perp-dist constrained perpendicular and stays armed', async () => {
    addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    setTool('perp-dist');
    await handleToolClick({ x: 50, y: 0 });      // pick reference line
    assert.ok(state.pendingRefLine, 'reference line picked');
    await handleToolClick({ x: 60, y: 10 });     // start point
    await handleToolClick({ x: 999, y: 999 });   // end point (raw), gets constrained
    const rel = state.annotations.find(a => a.type === 'perp-dist');
    assert.ok(rel, 'perp-dist created');
    assert.equal(rel.a.x, 60);
    assert.equal(rel.a.y, 10);
    // Reference line is horizontal — perpendicular constraint keeps b.x == a.x.
    assert.ok(Math.abs(rel.b.x - 60) < 1e-9);
    assert.equal(state.tool, 'perp-dist');       // stays armed
    assert.equal(state.pendingRefLine, null);
    assert.deepEqual(state.pendingPoints, []);
  });
});

describe('para-dist resurrection', () => {
  it('Mode B: line pick + free point + end point creates a parallel-constrained para-dist and stays armed', async () => {
    addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    setTool('para-dist');
    await handleToolClick({ x: 50, y: 0 });      // pick reference line
    await handleToolClick({ x: 60, y: 40 });     // free point (not on any line)
    await handleToolClick({ x: 999, y: 999 });   // end point, gets parallel-constrained
    const rel = state.annotations.find(a => a.type === 'para-dist');
    assert.ok(rel, 'para-dist created');
    assert.equal(rel.a.x, 60);
    assert.equal(rel.a.y, 40);
    // Reference line is horizontal — parallel constraint keeps b.y == a.y.
    assert.ok(Math.abs(rel.b.y - 40) < 1e-9);
    assert.equal(state.tool, 'para-dist');       // stays armed
    assert.equal(state.pendingRefLine, null);
  });

  it('Mode A: line pick + second (parallel) line click creates a parallelism annotation and stays armed', async () => {
    addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    addAnnotation({ type: 'distance', a: { x: 0, y: 50 }, b: { x: 200, y: 50 } });
    setTool('para-dist');
    await handleToolClick({ x: 50, y: 0 });      // pick reference line l1
    await handleToolClick({ x: 50, y: 50 });     // pick a different (parallel) line l2
    const rel = state.annotations.find(a => a.type === 'parallelism');
    assert.ok(rel, 'parallelism created');
    assert.equal(rel.angleDeg, 0);
    assert.equal(state.tool, 'para-dist');       // stays armed
    assert.equal(state.pendingRefLine, null);
    assert.equal(rel.a.x, 100); assert.equal(rel.b.x, 100); // midpoints of the two lines
  });
});

describe('slot-dist resurrection', () => {
  it('two parallel-line clicks create a slot-dist and the tool stays armed', async () => {
    const l1 = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    const l2 = addAnnotation({ type: 'distance', a: { x: 0, y: 50 }, b: { x: 200, y: 50 } });
    setTool('slot-dist');
    await handleToolClick({ x: 50, y: 0 });      // pick first line
    await handleToolClick({ x: 50, y: 50 });     // pick second line
    const rel = state.annotations.find(a => a.type === 'slot-dist');
    assert.ok(rel, 'slot-dist created');
    assert.equal(rel.lineAId, l1.id);
    assert.equal(rel.lineBId, l2.id);
    assert.equal(state.tool, 'slot-dist');       // stays armed
    assert.equal(state.pendingRefLine, null);
  });
});

describe('miss-path status hints (pick-only, no inline fitting yet)', () => {
  it('center-dist miss-click shows a hint and creates nothing', async () => {
    setTool('center-dist');
    await handleToolClick({ x: 500, y: 500 });   // no circle nearby
    assert.equal(state.annotations.length, 0);
    assert.match(getStatus(), /circle/i);
    assert.equal(state.tool, 'center-dist');
  });
});

describe('RELATION_TOOLS registry', () => {
  it('contains exactly the six relation tools', () => {
    assert.deepEqual([...RELATION_TOOLS].sort(),
      ['center-dist', 'intersect', 'para-dist', 'perp-dist', 'pt-circle-dist', 'slot-dist']);
  });
});
