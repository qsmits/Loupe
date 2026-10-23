import { registerElement, resetElements } from './dom-stub.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { referenceMarks, referencePosition, addReferenceMark, referenceSvg, refreshReferenceMarks } from '../../frontend/fringe-reference.js';
import { fr } from '../../frontend/fringe.js';
import { mergeReanalyzeResult } from '../../frontend/fringe-results.js';
import { captureInstrument, restoreInstrument } from '../../frontend/instrument-workspace.js';

it('keeps landmark coordinates unchanged under zoom and translation', () => {
  assert.deepEqual(referencePosition(140, 120, {left:100,top:80,width:200,height:100}), {x:.2,y:.4});
  assert.deepEqual(referencePosition(40, 60, {left:-80,top:-60,width:600,height:300}), {x:.2,y:.4});
  assert.deepEqual(referencePosition(-1, 200, {left:0,top:0,width:200,height:100}), {x:0,y:1});
  assert.equal(referencePosition(0, 0, {width:0,height:0}), null);
});

it('keeps labels stable after deletion and limits them to safe unique letters', () => {
  const marks = [{label:'A', x:.2,y:.4}, {label:'C', x:.8,y:.3}];
  assert.equal(addReferenceMark(marks, {x:.1,y:.2}).at(-1).label, 'B');
  const all = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(label => ({label,x:.5,y:.5}));
  assert.deepEqual(addReferenceMark(all, {x:0,y:0}), all);
  assert.deepEqual(referenceMarks({reference_image_b64:'png', reference_marks:[...marks,
    {label:'A',x:0,y:0}, {label:'<script>',x:0,y:0}, {label:'D',x:NaN,y:0}, {label:'E',x:2,y:0}]}), marks);
  assert.deepEqual(referenceMarks({reference_marks:marks}), []);
});

it('places asymmetric landmarks identically on both images without swapping axes', () => {
  const marks = [{label:'A',x:.2,y:.7}, {label:'B',x:.8,y:.1}];
  const svg = referenceSvg(marks, 200, 100);
  assert.match(svg, /cx="40" cy="70"/);
  assert.match(svg, /cx="160" cy="10"/);
  assert.match(referenceSvg(marks, 600, 300), /cx="120" cy="210"/);
});

it('persists references with the result and preserves them through form/sign recomputation', () => {
  resetElements();
  fr.lastResult = {reference_image_b64:'aligned',reference_marks:[{label:'A',x:.2,y:.7}]};
  const snapshot = captureInstrument(fr, {lastResult:null}, null);
  fr.lastResult.reference_marks[0].x = .9;
  restoreInstrument(fr, {lastResult:null}, snapshot, null);
  mergeReanalyzeResult({pv_nm:10, surface_map:'updated'});
  assert.deepEqual(fr.lastResult.reference_marks, [{label:'A',x:.2,y:.7}]);
  assert.equal(fr.lastResult.reference_image_b64, 'aligned');
  restoreInstrument(fr, {lastResult:null}, null, null);
  assert.equal(fr.lastResult, null);
});

it('clears the overlay for reset, legacy and unrelated derived results', () => {
  resetElements();
  const svg = {setAttribute(){}, innerHTML:''};
  const btn = {};
  registerElement('fringe-reference-svg', svg);
  registerElement('fringe-reference-open', btn);
  registerElement('fringe-surface-img', {clientWidth:200,clientHeight:100});
  refreshReferenceMarks({reference_image_b64:'png',reference_marks:[{label:'A',x:.2,y:.7}]});
  assert.match(svg.innerHTML, /cx="40" cy="70"/);
  assert.equal(btn.disabled, false);
  for (const result of [null, {}, {surface_map:'average'}]) {
    refreshReferenceMarks(result);
    assert.equal(svg.innerHTML, '');
    assert.equal(btn.disabled, true);
  }
});
