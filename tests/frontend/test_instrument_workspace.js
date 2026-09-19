import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureInstrument, restoreInstrument} from '../../frontend/instrument-workspace.js';

test('instrument snapshots preserve results, settings, masks and measurements without live runtime', () => {
  const defaults = {lastResult:null, maskPolygons:[], measurements:[], droppedImageB64:null};
  const model = {lastResult:{height_grid_nm:[1,2,3]},maskPolygons:[{include:true}],
    measurements:[{height_nm:12}], droppedImageB64:'pixels', polling:123, serverJob:'temporary'};
  const input = {id:'wavelength',type:'number',value:'589.3'};
  const file = {id:'file',type:'file',value:'private path'};
  const root = {querySelectorAll:()=>[input,file]};
  const snapshot = captureInstrument(model,defaults,root);
  model.lastResult.height_grid_nm[0]=999;
  input.value='532';
  restoreInstrument(model,defaults,snapshot,root);
  assert.deepEqual(model.lastResult.height_grid_nm,[1,2,3]);
  assert.equal(input.value,'589.3');
  assert.equal(model.measurements[0].height_nm,12);
  assert.equal(model.droppedImageB64,'pixels');
  assert.equal(snapshot.data.polling,undefined);
  assert.equal(snapshot.controls.file,undefined);
  restoreInstrument(model,defaults,null,root);
  assert.equal(model.lastResult,null);
  assert.deepEqual(model.measurements,[]);
});
