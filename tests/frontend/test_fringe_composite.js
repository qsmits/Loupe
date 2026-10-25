import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compositeView,compositeCsv,reconstructionView} from '../../frontend/fringe-composite.js';
function result(){return {composite:{version:1,grid_rows:2,grid_cols:3,form_model:'plane',wavelength_nm:632.8,
  quality_grid:[1,2,3,1,0,2],source_grid:[1,2,3,1,0,3],conflict_grid:[0,0,0,1,0,0],aperture_grid:[1,1,1,1,1,1],
  height_grid_nm:[1,2,3,999,0,4],summaries:[1,2,3].map(cutoff=>({cutoff,pixels:cutoff*10})),
  sources:[{id:1},{id:2},{id:3}]}};}
test('cutoff is nested, keeps heights fixed and excludes conflicts at every level',()=>{
  const r=result(),original=structuredClone(r);
  assert.deepEqual([...compositeView(r,1).included],[1,0,0,0,0,0]);
  assert.deepEqual([...compositeView(r,2).included],[1,1,0,0,0,1]);
  assert.deepEqual([...compositeView(r,3).included],[1,1,1,0,0,1]);
  assert.equal(compositeView(r,1).limit,compositeView(r,3).limit);
  assert.equal(compositeView(r,1).stats.pixels,10); // full-resolution record, not grid count
  assert.deepEqual(r,original);
});
test('export respects cutoff and retains provenance without assigning excluded heights',()=>{
  const csv=compositeCsv(compositeView(result(),2));
  assert.match(csv,/0,0,1,1.0000,Stronger agreement,0,hybrid,0/);
  assert.match(csv,/2,0,0,,Limited corroboration,0,coverage_local_consensus,0/);
  assert.match(csv,/0,1,0,,Stronger agreement,1,hybrid,0/);
  assert.doesNotMatch(csv,/999/);
  assert.match(csv,/not uncertainty/);
});
test('malformed or missing provenance fails closed',()=>{
  assert.throws(()=>compositeView({}),/Invalid/);
  const r=result();r.composite.quality_grid[0]=4;
  assert.throws(()=>compositeView(r),/provenance/);
  assert.throws(()=>compositeView(result(),9),/cutoff/);
  const incomplete=result();incomplete.composite.summaries=[];
  assert.throws(()=>compositeView(incomplete),/statistics/);
});
test('analysis-time snapshot survives JSON and later main-result edits',()=>{
  const r=result();const restored=JSON.parse(JSON.stringify(r));
  restored.height_grid=[-9];restored.form_model='poly2';
  assert.equal(compositeView(restored).c.height_grid_nm[0],1);
  assert.equal(compositeView(restored).c.form_model,'plane');
});

test('photographic recovery is visible only at limited cutoff and toggles exact saved statistics',()=>{
  const r=result(),c=r.composite;c.source_grid[2]=5;
  c.sources.push({id:5,method:'photographic_recovery',capture_index:0});
  c.without_photographic_summaries=c.summaries.map(s=>({...s,pixels:17}));
  const withRecovery=compositeView(r,3),without=compositeView(r,3,false);
  assert.equal(withRecovery.included[2],1);assert.equal(without.included[2],0);
  assert.equal(compositeView(r,2).included[2],0);
  assert.equal(without.stats.pixels,17);assert.equal(withRecovery.stats.pixels,30);
  assert.equal(withRecovery.limit,without.limit);
  assert.equal(without.c.height_grid_nm[2],3);
  assert.match(compositeCsv(withRecovery),/2,0,1,3.0000,Limited corroboration,0,photographic_recovery,0/);
  assert.match(compositeCsv(without),/2,0,0,,Limited corroboration,0,photographic_recovery,0/);
  assert.match(compositeCsv(without),/Photographic recovery: hidden/);
  delete c.without_photographic_summaries;
  assert.throws(()=>compositeView(r,3,false),/statistics/);
});

test('older composites still support all cutoffs without photographic metadata',()=>{
  assert.deepEqual(compositeView(result(),3,false).included,compositeView(result(),3).included);
});

test('reconstructed display never changes measurements, cutoff statistics, or exports',()=>{
  const r=result(),c=r.composite;c.aperture_pixels=60;
  c.reconstruction={version:1,kind:'inferred_not_measured',reconstructed_pixels:9,
    reconstructed_grid:[0,0,0,0,1,0],height_grid_nm:[0,0,0,0,120,0],diagnostics:{converged:true}};
  const saved=structuredClone(r),v=compositeView(r,3),csv=compositeCsv(v);
  const off=reconstructionView(v,false),on=reconstructionView(v,true);
  assert.equal(off.limit,on.limit);assert.equal(on.limit,120);
  assert.deepEqual([...on.reconstructed],[0,0,0,0,1,0]);assert.equal(on.pixels,9);
  assert.equal(v.included[4],0);assert.equal(v.stats.pixels,30);
  assert.equal(compositeCsv(v),csv);assert.doesNotMatch(csv,/120/);
  assert.deepEqual(r,saved);
  assert.equal(reconstructionView(compositeView(result()),true).available,false);
  c.kind='multi';assert.equal(reconstructionView(compositeView(r),true).available,false);
});

test('malformed reconstruction cannot paint over accepted values, conflicts or mask exclusions',()=>{
  for(const index of [0,3,4]){
    const r=result(),c=r.composite;c.aperture_pixels=60;
    if(index===4)c.aperture_grid[4]=0;
    c.reconstruction={version:1,kind:'inferred_not_measured',reconstructed_pixels:1,
      reconstructed_grid:Array(6).fill(0),height_grid_nm:Array(6).fill(1)};
    c.reconstruction.reconstructed_grid[index]=1;
    assert.throws(()=>reconstructionView(compositeView(r),true),/overlaps/);
  }
});
