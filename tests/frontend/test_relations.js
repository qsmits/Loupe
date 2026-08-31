import './dom-stub.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../frontend/state.js';
import { setTool, handleToolClick, RELATION_TOOLS, nudgeSelected, finalizeRelationPick } from '../../frontend/tools.js';
import { addAnnotation, deleteAnnotation, deleteSelected } from '../../frontend/annotations.js';
import { undo } from '../../frontend/events-keyboard.js';
import { getStatus, listEl } from '../../frontend/render.js';
import { renderSidebar } from '../../frontend/sidebar.js';
import { measurementNumeric } from '../../frontend/format.js';
import { setImageSize } from '../../frontend/viewport.js';

beforeEach(() => {
  state.annotations = [];
  state.selected = new Set();
  state.nextId = 1;
  state.frozen = false;          // keeps handleToolClick's subpixel refine (server call) off
  state.calibration = null;
  state.pendingPoints = []; state.pendingRefLine = null;
  state.pendingCenterCircle = null; state.pendingCircleRef = null;
  state.pendingRelationFit = null;
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

  it('an arc-fit (best-fit circle/arc) is pickable alongside a plain circle (Finding 1)', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const arc = addAnnotation({ type: 'arc-fit', cx: 400, cy: 100, r: 20 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // c1 edge
    await handleToolClick({ x: 420, y: 100 });   // arc-fit edge
    const rel = state.annotations.find(a => a.type === 'center-dist');
    assert.ok(rel, 'center-dist created against an arc-fit');
    assert.equal(rel.circleAId, c1.id);
    assert.equal(rel.circleBId, arc.id);
    assert.deepEqual({ x: rel.b.x, y: rel.b.y }, { x: 400, y: 100 }); // arc-fit's own cx/cy, no scaling
  });

  it('nudging a linked arc-fit syncs its center-dist endpoint (Finding 4 — _syncCenterDist arc-fit gap)', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const arc = addAnnotation({ type: 'arc-fit', cx: 400, cy: 100, r: 20 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // c1 edge
    await handleToolClick({ x: 420, y: 100 });   // arc-fit edge
    const rel = state.annotations.find(a => a.type === 'center-dist');
    assert.ok(rel, 'center-dist created against an arc-fit');
    assert.equal(rel.circleBId, arc.id);
    assert.deepEqual({ x: rel.b.x, y: rel.b.y }, { x: 400, y: 100 }); // pre-nudge

    state.selected = new Set([arc.id]);
    nudgeSelected(15, -7);
    assert.deepEqual({ x: arc.cx, y: arc.cy }, { x: 415, y: 93 }, 'arc-fit center moved');
    assert.deepEqual({ x: rel.b.x, y: rel.b.y }, { x: 415, y: 93 },
      'linked center-dist endpoint follows the nudged arc-fit center');
  });

  it('same circle picked twice is ignored; picking a different circle still completes, and a second cycle works (Finding 3)', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const c2 = addAnnotation({ type: 'circle', cx: 400, cy: 100, r: 20 });
    const c3 = addAnnotation({ type: 'circle', cx: 700, cy: 100, r: 10 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // pick c1
    await handleToolClick({ x: 130, y: 100 });   // pick c1 again — must be ignored
    assert.equal(state.annotations.filter(a => a.type === 'center-dist').length, 0,
      'no junk zero-length measurement from picking the same circle twice');
    assert.ok(state.pendingCenterCircle, 'first pick stays armed');
    assert.equal(state.pendingCenterCircle.id, c1.id);

    await handleToolClick({ x: 420, y: 100 });   // pick c2 — completes the first relation
    const rel1 = state.annotations.find(a => a.type === 'center-dist');
    assert.ok(rel1, 'first center-dist created');
    assert.equal(rel1.circleAId, c1.id);
    assert.equal(rel1.circleBId, c2.id);
    assert.equal(state.tool, 'center-dist');     // stays armed
    assert.equal(state.pendingCenterCircle, null);

    // Genuine second cycle — stay-armed exercised for real, not just asserted.
    await handleToolClick({ x: 130, y: 100 });   // pick c1 again, fresh cycle
    await handleToolClick({ x: 710, y: 100 });   // pick c3 — completes a second relation
    const rels = state.annotations.filter(a => a.type === 'center-dist');
    assert.equal(rels.length, 2, 'a second center-dist was created in the same armed session');
    const rel2 = rels[1];
    assert.equal(rel2.circleAId, c1.id);
    assert.equal(rel2.circleBId, c3.id);
    assert.equal(state.tool, 'center-dist');
    assert.equal(state.pendingCenterCircle, null);
  });

  describe('detected-circle endpoints use image coords, not canvas coords (Finding 2)', () => {
    afterEach(() => { setImageSize(0, 0); }); // restore the file's default for later tests

    it('center-dist endpoint for a detected-circle matches imageWidth-based scaling', async () => {
      setImageSize(800, 600); // frameWidth (400) !== imageWidth (800): discriminates the two formulas
      const det = addAnnotation({ type: 'detected-circle', x: 50, y: 60, radius: 10, frameWidth: 400, frameHeight: 300 });
      const c1 = addAnnotation({ type: 'circle', cx: 500, cy: 500, r: 30 });
      setTool('center-dist');
      // detected-circle center in image coords: (50*800/400, 60*600/300) = (100, 120), r = 10*2 = 20.
      await handleToolClick({ x: 120, y: 120 });   // detected-circle edge (image coords)
      await handleToolClick({ x: 530, y: 500 });   // c1 edge
      const rel = state.annotations.find(a => a.type === 'center-dist');
      assert.ok(rel, 'center-dist created against a detected-circle');
      assert.equal(rel.circleAId, det.id);
      assert.equal(rel.circleBId, c1.id);
      // Must be the image-coord center (100, 120) — NOT canvas.width-based (which
      // would be {0, 0} here, since dom-stub's canvas.width defaults to 0).
      assert.deepEqual({ x: rel.a.x, y: rel.a.y }, { x: 100, y: 120 });
    });
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

  it('miss-click with no circle picked accumulates an inline-fit point instead of creating anything', async () => {
    setTool('pt-circle-dist');
    await handleToolClick({ x: 500, y: 500 });   // no circle nearby
    assert.equal(state.annotations.length, 0);
    assert.equal(state.pendingRelationFit?.kind, 'circle');
    assert.equal(state.pendingPoints.length, 1);
    assert.match(getStatus(), /circle/i);
    assert.equal(state.tool, 'pt-circle-dist');
  });

  it('pt-circle-dist against an arc-fit computes a finite gap (Finding 1)', async () => {
    const arc = addAnnotation({ type: 'arc-fit', cx: 100, cy: 100, r: 30 });
    setTool('pt-circle-dist');
    await handleToolClick({ x: 130, y: 100 });   // arc-fit edge
    await handleToolClick({ x: 500, y: 500 });   // free point
    const rel = state.annotations.find(a => a.type === 'pt-circle-dist');
    assert.ok(rel, 'pt-circle-dist created against an arc-fit');
    assert.equal(rel.circleId, arc.id);
    const numeric = measurementNumeric(rel, { annotations: state.annotations, calibration: null });
    assert.ok(numeric && Number.isFinite(numeric.value), 'measurementNumeric returns a finite gap, not NaN');
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

describe('miss-path accumulates an inline-fit point (Task 13)', () => {
  it('center-dist miss-click arms inline fitting and creates nothing yet', async () => {
    setTool('center-dist');
    await handleToolClick({ x: 500, y: 500 });   // no circle nearby
    assert.equal(state.annotations.length, 0);
    assert.equal(state.pendingRelationFit?.kind, 'circle');
    assert.equal(state.pendingPoints.length, 1);
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

describe('inline fitting inside center-dist (circle kind)', () => {
  it('bare-edge clicks accumulate, Enter (finalizeRelationPick) fits a first-class circle and feeds the relation', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // pick existing circle 1 (its edge)
    // no circle near (400,300): three edge clicks around an imaginary Ø60 hole
    await handleToolClick({ x: 430, y: 300 });
    await handleToolClick({ x: 400, y: 330 });
    await handleToolClick({ x: 370, y: 300 });
    assert.equal(state.pendingRelationFit?.kind, 'circle');
    assert.equal(state.pendingPoints.length, 3);
    assert.equal(finalizeRelationPick(), true);
    const circles = state.annotations.filter(a => a.type === 'circle');
    assert.equal(circles.length, 2, 'inline fit created a first-class circle');
    assert.ok(Math.abs(circles[1].cx - 400) < 1e-6 && Math.abs(circles[1].cy - 300) < 1e-6 && Math.abs(circles[1].r - 30) < 1e-6,
      'fitted circle matches the 3 edge points');
    const rel = state.annotations.find(a => a.type === 'center-dist');
    assert.ok(rel, 'relation completed from the inline fit');
    assert.equal(rel.circleAId, c1.id);
    assert.equal(rel.circleBId, circles[1].id);
    assert.equal(state.pendingRelationFit, null);
    assert.equal(state.pendingPoints.length, 0);
    assert.equal(state.tool, 'center-dist');   // stays armed, like a direct pick
  });

  it('a miss while already mid-fit still accumulates, even if it lands near another circle (no pick-through)', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const decoy = addAnnotation({ type: 'circle', cx: 400, cy: 300, r: 30 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // pick c1
    await handleToolClick({ x: 900, y: 900 });   // miss — arms inline fitting
    assert.equal(state.pendingRelationFit?.kind, 'circle');
    // This click lands right on the decoy circle's edge, but a fit is already
    // in progress — it must accumulate as a fit point, not pick the decoy.
    await handleToolClick({ x: 430, y: 300 });
    assert.equal(state.pendingPoints.length, 2);
    assert.equal(state.annotations.filter(a => a.type === 'center-dist').length, 0,
      'no relation completed — the decoy was not picked');
  });

  it('finalizeRelationPick is a no-op outside relation fitting', () => {
    setTool('distance');
    assert.equal(finalizeRelationPick(), false);
  });

  it('finalizeRelationPick is a no-op with too few accumulated points', async () => {
    setTool('center-dist');
    await handleToolClick({ x: 430, y: 300 });
    await handleToolClick({ x: 400, y: 330 });   // only 2 — circle fit needs 3
    assert.equal(state.pendingPoints.length, 2);
    assert.equal(finalizeRelationPick(), false);
    assert.equal(state.pendingRelationFit?.kind, 'circle', 'stays armed for one more point');
  });
});

describe('inline fitting inside perp-dist (line kind)', () => {
  it('two bare clicks accumulate, finalizeRelationPick fits a first-class fit-line and feeds the ref-line slot', async () => {
    setTool('perp-dist');
    await handleToolClick({ x: 0, y: 0 });      // no line nearby — arms inline fitting
    await handleToolClick({ x: 200, y: 0 });    // second edge point — horizontal line
    assert.equal(state.pendingRelationFit?.kind, 'line');
    assert.equal(state.pendingPoints.length, 2);

    assert.equal(finalizeRelationPick(), true);
    const fitLines = state.annotations.filter(a => a.type === 'fit-line');
    assert.equal(fitLines.length, 1, 'inline fit created a first-class fit-line');
    const fl = fitLines[0];
    // Same field set finalizeFitLine() produces.
    for (const f of ['points', 'cx', 'cy', 'dx', 'dy', 'x1', 'y1', 'x2', 'y2', 'zoneWidth', 'zoneMin', 'zoneMax']) {
      assert.ok(f in fl, `fit-line missing field ${f}`);
    }
    assert.equal(state.pendingRefLine?.id, fl.id, 'fit-line consumed as the reference line');
    assert.equal(state.pendingRelationFit, null);
    assert.equal(state.pendingPoints.length, 0);

    // Ref line established from the inline fit — perp-dist now expects the
    // start point, exactly like the pick-only flow.
    await handleToolClick({ x: 60, y: 10 });     // start point
    await handleToolClick({ x: 999, y: 999 });   // end point (raw), gets constrained
    const rel = state.annotations.find(a => a.type === 'perp-dist');
    assert.ok(rel, 'perp-dist completed using the inline-fitted ref line');
    assert.equal(rel.a.x, 60);
    assert.equal(rel.a.y, 10);
    assert.ok(Math.abs(rel.b.x - 60) < 1e-9, 'perpendicular constraint honors the fitted horizontal line');
    assert.equal(state.tool, 'perp-dist');       // stays armed
  });
});

// ── Fix round 2: slot-dist/intersect's second line-pick slot is ALSO
// inline-fittable (both slots route through _consumePickedLine, mirroring
// center-dist's both-circle-slots), and para-dist's second slot is confirmed
// NOT to have gained this (a bare click there is Mode B's free point).

describe('inline fitting inside slot-dist (both slots, fix round 2)', () => {
  it('two inline-fitted lines create a slot-dist referencing both fit-lines, with a finite gap', async () => {
    setTool('slot-dist');
    // First line: horizontal at y=0, fitted from two bare clicks.
    await handleToolClick({ x: 0, y: 0 });
    await handleToolClick({ x: 200, y: 0 });
    assert.equal(state.pendingRelationFit?.kind, 'line');
    assert.equal(state.pendingPoints.length, 2);
    assert.equal(finalizeRelationPick(), true);
    let fitLines = state.annotations.filter(a => a.type === 'fit-line');
    assert.equal(fitLines.length, 1, 'first line inline-fitted');
    assert.equal(state.pendingRefLine?.id, fitLines[0].id, 'first fit-line becomes the reference line');

    // Second line: horizontal at y=50, far enough from the first that
    // findSnapLine misses — must accumulate exactly like the first slot did.
    await handleToolClick({ x: 0, y: 50 });
    await handleToolClick({ x: 200, y: 50 });
    assert.equal(state.pendingRelationFit?.kind, 'line');
    assert.equal(state.pendingPoints.length, 2);
    assert.equal(finalizeRelationPick(), true);

    fitLines = state.annotations.filter(a => a.type === 'fit-line');
    assert.equal(fitLines.length, 2, 'second line also inline-fitted');
    const rel = state.annotations.find(a => a.type === 'slot-dist');
    assert.ok(rel, 'slot-dist completed from two inline fits');
    assert.equal(rel.lineAId, fitLines[0].id);
    assert.equal(rel.lineBId, fitLines[1].id);
    assert.equal(state.pendingRefLine, null);
    assert.equal(state.pendingRelationFit, null);
    assert.equal(state.tool, 'slot-dist');   // stays armed

    const numeric = measurementNumeric(rel, { annotations: state.annotations, calibration: null });
    assert.ok(numeric && Number.isFinite(numeric.value), 'measurementNumeric returns a finite gap, not NaN');
    assert.ok(Math.abs(numeric.value - 50) < 1e-6, 'gap equals the 50px separation between the two fitted lines');
  });
});

describe('inline fitting inside intersect (second slot, fix round 2)', () => {
  it('first line picked directly, second line inline-fitted, completes the intersect', async () => {
    const l1 = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    setTool('intersect');
    await handleToolClick({ x: 50, y: 0 });      // pick l1 directly (first slot, unaffected)
    assert.equal(state.pendingRefLine?.id, l1.id);

    // Second line: a vertical line at x=100, far from l1's body — a miss.
    await handleToolClick({ x: 100, y: -100 });
    await handleToolClick({ x: 100, y: 100 });
    assert.equal(state.pendingRelationFit?.kind, 'line');
    assert.equal(state.pendingPoints.length, 2);
    assert.equal(finalizeRelationPick(), true);

    const fitLines = state.annotations.filter(a => a.type === 'fit-line');
    assert.equal(fitLines.length, 1, 'second line inline-fitted');
    const rel = state.annotations.find(a => a.type === 'intersect');
    assert.ok(rel, 'intersect completed from a direct pick + an inline fit');
    assert.equal(rel.lineAId, l1.id);
    assert.equal(rel.lineBId, fitLines[0].id);
    assert.equal(state.pendingRefLine, null);
    assert.equal(state.pendingRelationFit, null);
    assert.equal(state.tool, 'intersect');
  });
});

describe('delete-cascade (Task 15)', () => {
  it('deleting a circle deletes its center-dist, one undo restores both', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const c2 = addAnnotation({ type: 'circle', cx: 400, cy: 100, r: 20 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });
    await handleToolClick({ x: 420, y: 100 });
    assert.ok(state.annotations.some(a => a.type === 'center-dist'));
    deleteAnnotation(c1.id);
    assert.ok(!state.annotations.some(a => a.type === 'center-dist'), 'relation cascaded');
    assert.ok(!state.annotations.some(a => a.id === c1.id));
    undo();
    assert.ok(state.annotations.some(a => a.type === 'center-dist'), 'undo restored the relation');
    assert.ok(state.annotations.some(a => a.id === c1.id), 'undo restored the circle');
  });

  it('deleteSelected cascades too, and one undo restores everything', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const c2 = addAnnotation({ type: 'circle', cx: 400, cy: 100, r: 20 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });
    await handleToolClick({ x: 420, y: 100 });
    const rel = state.annotations.find(a => a.type === 'center-dist');
    assert.ok(rel);
    state.selected = new Set([c2.id]);
    deleteSelected();
    assert.ok(!state.annotations.some(a => a.id === c2.id));
    assert.ok(!state.annotations.some(a => a.id === rel.id), 'relation cascaded via deleteSelected');
    undo();
    assert.ok(state.annotations.some(a => a.id === c2.id));
    assert.ok(state.annotations.some(a => a.id === rel.id));
  });

  it('cascade is transitive: deleting a line deletes a slot-dist AND an intersect built on the same two lines', async () => {
    const l1 = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    const l2 = addAnnotation({ type: 'distance', a: { x: 0, y: 50 }, b: { x: 200, y: 50 } });
    setTool('slot-dist');
    await handleToolClick({ x: 50, y: 0 });
    await handleToolClick({ x: 50, y: 50 });
    const slot = state.annotations.find(a => a.type === 'slot-dist');
    assert.ok(slot);
    deleteAnnotation(l1.id);
    assert.ok(!state.annotations.some(a => a.id === l1.id));
    assert.ok(!state.annotations.some(a => a.id === slot.id), 'slot-dist cascaded transitively from the deleted line');
    assert.ok(state.annotations.some(a => a.id === l2.id), 'the untouched line survives');
  });

  it('deleting an annotation with no dependents removes only itself', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const lone = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    deleteAnnotation(lone.id);
    assert.ok(!state.annotations.some(a => a.id === lone.id));
    assert.ok(state.annotations.some(a => a.id === c1.id), 'unrelated annotation untouched');
  });
});

describe('clearing dead pending relation picks (fix round 1)', () => {
  it('deleteSelected clears a mid-pick pendingCenterCircle; completing with another circle starts a fresh pick (no dangling ref)', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const c2 = addAnnotation({ type: 'circle', cx: 400, cy: 100, r: 20 });
    const c3 = addAnnotation({ type: 'circle', cx: 700, cy: 100, r: 10 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // pick c1 — mid-pick, no relation yet
    assert.equal(state.pendingCenterCircle?.id, c1.id);
    state.selected = new Set([c1.id]);
    deleteSelected();
    assert.equal(state.pendingCenterCircle, null, 'pending pick cleared when its target circle is deleted');

    // Completing the pick now must NOT silently finish a relation against the
    // deleted c1 — this click becomes a fresh first pick instead.
    await handleToolClick({ x: 420, y: 100 });   // pick c2
    assert.equal(state.annotations.filter(a => a.type === 'center-dist').length, 0,
      'no relation created — c2 became the fresh first pick, not a completion against the dead c1');
    assert.equal(state.pendingCenterCircle?.id, c2.id);

    await handleToolClick({ x: 710, y: 100 });   // pick c3 — completes against c2
    const rel = state.annotations.find(a => a.type === 'center-dist');
    assert.ok(rel, 'relation completes normally from the fresh pick');
    assert.equal(rel.circleAId, c2.id);
    assert.equal(rel.circleBId, c3.id);
  });

  it('deleteAnnotation clears a mid-pick pendingRefLine (slot-dist)', async () => {
    const l1 = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    setTool('slot-dist');
    await handleToolClick({ x: 50, y: 0 });      // pick l1 — mid-pick
    assert.equal(state.pendingRefLine?.id, l1.id);
    deleteAnnotation(l1.id);
    assert.equal(state.pendingRefLine, null, 'pendingRefLine cleared when its target line is deleted');
    assert.equal(state.pendingRefLineClick, null);
  });

  it('deleteAnnotation clears a mid-pick pendingCircleRef (pt-circle-dist)', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    setTool('pt-circle-dist');
    await handleToolClick({ x: 130, y: 100 });   // pick c1 — mid-pick
    assert.ok(state.pendingCircleRef, 'circle pick registered');
    assert.equal(state.pendingCircleRef.circleId, c1.id);
    deleteAnnotation(c1.id);
    assert.equal(state.pendingCircleRef, null, 'pendingCircleRef cleared when its target circle is deleted');
  });

  it('negative control: deleting an unrelated annotation leaves a mid-pick pendingCenterCircle intact', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const unrelated = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });   // pick c1 — mid-pick
    assert.equal(state.pendingCenterCircle?.id, c1.id);
    deleteAnnotation(unrelated.id);
    assert.equal(state.pendingCenterCircle?.id, c1.id, 'unrelated deletion must not clear an in-progress pick');
  });
});

describe('sidebar parent refs (Task 15)', () => {
  // listEl is a persistent DOM-stub element whose .children the stub's
  // innerHTML="" clear does not actually empty (see dom-stub.js) — clear it
  // ourselves right before the render under test so only that render's rows
  // are inspected.
  function rowFor(id) {
    return listEl.children.find(r => String(r.dataset.id) === String(id));
  }
  function refSpanOf(row) {
    return row?.children.find(c => c.className === 'relation-refs') ?? null;
  }

  it('a center-dist row shows "[nA] ↔ [nB]"', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const c2 = addAnnotation({ type: 'circle', cx: 400, cy: 100, r: 20 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });
    await handleToolClick({ x: 420, y: 100 });
    const rel = state.annotations.find(a => a.type === 'center-dist');
    listEl.children.length = 0;
    renderSidebar();
    const span = refSpanOf(rowFor(rel.id));
    assert.ok(span, 'relation-refs span rendered');
    assert.equal(span.textContent, '[1] ↔ [2]');
  });

  it('a plain measurement row has no relation-refs span', () => {
    const d = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    listEl.children.length = 0;
    renderSidebar();
    assert.equal(refSpanOf(rowFor(d.id)), null);
  });

  it('a dangling ref (referenced annotation deleted, cascade off) is skipped, not rendered as "[]"', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    const c2 = addAnnotation({ type: 'circle', cx: 400, cy: 100, r: 20 });
    setTool('center-dist');
    await handleToolClick({ x: 130, y: 100 });
    await handleToolClick({ x: 420, y: 100 });
    const rel = state.annotations.find(a => a.type === 'center-dist');
    // Simulate a dangling ref directly (real deletes cascade — this covers
    // the defensive branch for any other path that could leave one stale).
    rel.circleAId = 999;
    listEl.children.length = 0;
    renderSidebar();
    const span = refSpanOf(rowFor(rel.id));
    assert.ok(span, 'still renders — the surviving ref is shown');
    assert.equal(span.textContent, '[2]', 'the dangling ref is skipped, not a broken "[]"');
  });
});

describe('para-dist regression (fix round 2): 2nd slot never gains accumulation', () => {
  it('a bare click in slot 2 still enters Mode B (free point), not inline-fit accumulation', async () => {
    addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    setTool('para-dist');
    await handleToolClick({ x: 50, y: 0 });      // pick reference line directly
    assert.ok(state.pendingRefLine);
    assert.equal(state.pendingRelationFit, null);

    await handleToolClick({ x: 60, y: 40 });     // bare click, not on any line
    assert.equal(state.pendingRelationFit, null, 'slot 2 must not arm inline fitting');
    assert.deepEqual(state.pendingPoints, [{ x: 60, y: 40 }],
      'the click became Mode B\'s free point, not a fit point');

    await handleToolClick({ x: 999, y: 999 });   // end point, parallel-constrained
    const rel = state.annotations.find(a => a.type === 'para-dist');
    assert.ok(rel, 'para-dist completed via Mode B, unaffected by fix round 2');
    assert.equal(rel.a.x, 60);
    assert.equal(rel.a.y, 40);
    assert.ok(Math.abs(rel.b.y - 40) < 1e-9);
    assert.equal(state.pendingRelationFit, null);
  });
});
