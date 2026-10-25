import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeMethodComparison,compareMethodGrids,comparisonCsv} from '../../frontend/fringe-method-comparison.js';
function result(method,mask=Array(20).fill(1)){
  return {analysis_method:method,grid_rows:4,grid_cols:5,surface_width:50,surface_height:40,image_width:60,image_height:50,
    form_model:'plane',wavelength_nm:632.8,reference_image_b64:'same-crop',mask_grid:mask,
    display_height_grid_nm:Array.from({length:20},(_,i)=>(i%5-2)**2)};
}
test('comparison snapshots remain independent from later sign/form edits and survive JSON save',()=>{
  const a=result('current'),b=result('hybrid'),pair=makeMethodComparison(a,b);
  a.display_height_grid_nm[0]=999;b.mask_grid[0]=0;
  const restored=JSON.parse(JSON.stringify(pair));
  assert.equal(restored.current.display_height_grid_nm[0],4);
  assert.equal(restored.hybrid.mask_grid[0],1);
  assert.equal(compareMethodGrids(restored).rms,0);
});
test('alignment rejects changed crops even when grid dimensions happen to match',()=>{
  assert.throws(()=>makeMethodComparison(result('current'),{...result('hybrid'),reference_image_b64:'different-crop'}),/alignment/);
  assert.throws(()=>makeMethodComparison(result('current'),{...result('hybrid'),wavelength_nm:500}),/resolution/);
  assert.throws(()=>compareMethodGrids({current:result('current'),hybrid:{...result('hybrid'),mask_grid:[]}}),/Invalid/);
});
test('extra pixels are counted separately and never get invented difference heights',()=>{
  const a=result('current'),b=result('hybrid');a.mask_grid[0]=0;b.mask_grid[1]=0;a.mask_grid[2]=b.mask_grid[2]=0;
  b.display_height_grid_nm[3]=NaN;
  const g=compareMethodGrids(makeMethodComparison(a,b),false);
  assert.equal(g.shared,16);assert.equal(g.added,1);assert.equal(g.removed,2);
  assert.ok(Number.isNaN(g.difference[0]));assert.ok(Number.isNaN(g.difference[1]));
  const csv=comparisonCsv(g);assert.match(csv,/0,0,hybrid only,,4.0000,/);assert.doesNotMatch(csv,/2,0,/);
});
test('shared-area registration removes only offset and tilt, retaining curvature differences',()=>{
  const a=result('current'),b=result('hybrid');
  b.display_height_grid_nm=b.display_height_grid_nm.map((v,i)=>v+12+2*(i%5+.5)/5-3*(Math.floor(i/5)+.5)/4);
  const pair=makeMethodComparison(a,b),raw=compareMethodGrids(pair,false),aligned=compareMethodGrids(pair,true);
  assert.ok(raw.rms>10);assert.ok(aligned.max<1e-10);
  b.display_height_grid_nm=b.display_height_grid_nm.map((v,i)=>v+(i%5-2)**2);
  const curvature=compareMethodGrids(makeMethodComparison(a,b),true);
  assert.ok(curvature.rms>1);assert.ok(curvature.max>=2);
});
test('no overlap and collinear overlap cannot produce a misleading alignment or RMS',()=>{
  const a=result('current',Array(20).fill(0)),b=result('hybrid');
  let g=compareMethodGrids(makeMethodComparison(a,b));assert.equal(g.rms,null);assert.equal(g.plane,null);
  a.mask_grid=[1,1,1,1,1,...Array(15).fill(0)];
  g=compareMethodGrids(makeMethodComparison(a,b));assert.equal(g.plane,null);assert.equal(g.rms,0);
});

test('fallback diagnostics survive snapshots and distinguish identical fallback from agreement',async()=>{
  const {hybridFallbackNotice}=await import('../../frontend/fringe-method-comparison.js');
  const a=result('current'),b=result('hybrid');
  b.hybrid_diagnostics={local_pixels:0,fit_checks:{passed_pixels:3}};
  const pair=makeMethodComparison(a,b);
  b.hybrid_diagnostics.local_pixels=20;
  assert.match(hybridFallbackNotice(pair.hybrid.hybrid_diagnostics),/Current estimate everywhere/);
  assert.match(hybridFallbackNotice(pair.hybrid.hybrid_diagnostics),/do not independently confirm/);
  assert.equal(hybridFallbackNotice(b.hybrid_diagnostics),'');
  assert.equal(hybridFallbackNotice(undefined),'');
});
