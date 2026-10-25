import {test} from 'node:test';
import assert from 'node:assert/strict';
import {combineCaptures,registerLandmarks} from '../../frontend/fringe-multicapture.js';
import {compositeView,compositeCsv} from '../../frontend/fringe-composite.js';
const points=[{x:.15,y:.2},{x:.8,y:.25},{x:.4,y:.85}];
function fixture(id='a',fn=(x,y)=>30*(x*x+y*y)){
  const rows=48,cols=64,n=rows*cols;
  return {id,composite:{version:1,grid_rows:rows,grid_cols:cols,surface_width:128,surface_height:96,
    form_model:'plane',wavelength_nm:632.8,aperture_label:'drawn area',aperture_pixels:n,
    height_grid_nm:Array.from({length:n},(_,i)=>fn(i%cols/cols-.5,Math.floor(i/cols)/rows-.5)),
    quality_grid:Array(n).fill(1),source_grid:Array(n).fill(1),aperture_grid:Array(n).fill(1),conflict_grid:Array(n).fill(0),reason_grid:Array(n).fill(0),
    sources:[{id:1,method:'hybrid',capture_index:0}],summaries:[1,2,3].map(cutoff=>({cutoff,pixels:n}))}};
}
const options={referencePoints:points,incomingPoints:points,sign:1,thresholdNm:2};
test('similarity registration respects rectangular pixel geometry and rejects reflections and degeneracy',()=>{
  const size={width:200,height:100},s=points.map(p=>({x:p.x*.7+.1,y:p.y*.7+.05}));
  const t=registerLandmarks(points,s,size,size);assert.ok(t.rms_px<1e-12);assert.ok(Math.abs(t.scale-1/.7)<1e-12);
  assert.throws(()=>registerLandmarks(points,[s[0],s[2],s[1]],size,size),/reflection/);
  assert.throws(()=>registerLandmarks(points,[s[0],s[0],s[0]],size,size),/straight line/);
});
test('combines complementary support without changing reference heights or inventing samples in holes',()=>{
  const r=fixture(),s=fixture('b',(x,y)=>30*(x*x+y*y)+12+8*x-5*y),original=structuredClone(r);
  for(let i=0;i<r.composite.source_grid.length;i++){
    if(i%64>49){r.composite.quality_grid[i]=0;r.composite.source_grid[i]=0;}
    if(i%64<10){s.composite.quality_grid[i]=0;s.composite.source_grid[i]=0;}
  }
  const c=combineCaptures(r,s,options),view=compositeView({composite:c},2);
  assert.equal(c.kind,'multi');assert.ok(c.registration.heldout_p90_nm<1e-9);
  assert.equal(c.support_grid[20*64+30],2);assert.equal(c.source_grid[20*64+30],1);
  assert.equal(c.support_grid[20*64+55],1);assert.equal(c.source_grid[20*64+55],2);assert.equal(c.quality_grid[20*64+55],2);
  assert.ok(Math.abs(c.height_grid_nm[20*64+55]-original.composite.height_grid_nm[20*64+55])<1e-9);
  assert.deepEqual(r.composite.height_grid_nm,original.composite.height_grid_nm);
  assert.match(compositeCsv(view),/registered_capture,1/);
  assert.match(compositeCsv(view),/Statistics resolution: display grid/);
});
test('conflicting local patch is striped and excluded; no averaging hides it',()=>{
  const r=fixture(),s=fixture('b');for(let y=18;y<24;y++)for(let x=28;x<34;x++)s.composite.height_grid_nm[y*64+x]+=30;
  const c=combineCaptures(r,s,options),i=20*64+30;
  assert.equal(c.conflict_grid[i],1);assert.equal(c.reason_grid[i],4);
  assert.equal(compositeView({composite:c},3).included[i],0);
  assert.equal(c.height_grid_nm[i],r.composite.height_grid_nm[i]);
});
test('poor held-out agreement, unknown direction, duplicate capture and nonplane forms fail closed',()=>{
  assert.throws(()=>combineCaptures(fixture(),fixture('b'),{...options,sign:0}),/direction/);
  assert.throws(()=>combineCaptures(fixture(),fixture(),options),/different capture/);
  assert.throws(()=>combineCaptures(fixture(),fixture('b',(x,y)=>1000*(x*x+y*y)),options),/Held-out/);
  const s=fixture('b');s.composite.form_model='zernike';assert.throws(()=>combineCaptures(fixture(),s,options),/Plane/);
});
test('reversed height direction is explicit; missing supports and reference conflicts remain unmeasured',()=>{
  const r=fixture(),s=fixture('b',(x,y)=>-30*(x*x+y*y)+10);
  const i=20*64+30;r.composite.conflict_grid[i]=1;r.composite.reason_grid[i]=2;
  const c=combineCaptures(r,s,{...options,sign:-1});assert.ok(c.registration.heldout_p90_nm<1e-8);
  assert.equal(c.reason_grid[i],2);assert.equal(compositeView({composite:c},3).included[i],0);
  for(let j=0;j<s.composite.quality_grid.length;j++)s.composite.quality_grid[j]=0;
  assert.throws(()=>combineCaptures(r,s,options),/100 overlapping/);
});
test('registration rotates a rectangular image in pixels, with scale and translation',()=>{
  const size={width:200,height:100},a=.85*Math.cos(.1),b=.85*Math.sin(.1),tx=8,ty=2;
  const ref=points.map(p=>({x:(a*p.x*200-b*p.y*100+tx)/200,y:(b*p.x*200+a*p.y*100+ty)/100}));
  const t=registerLandmarks(ref,points,size,size);assert.ok(Math.abs(t.a-a)<1e-12);assert.ok(Math.abs(t.b-b)<1e-12);
});
test('sampling never interpolates across excluded pixels or beyond the sampled boundary',()=>{
  const r=fixture(),s=fixture('b');const hole=20*64+30;
  r.composite.quality_grid[hole]=0;r.composite.source_grid[hole]=0;
  s.composite.quality_grid[hole+1]=0;s.composite.source_grid[hole+1]=0;
  const c=combineCaptures(r,s,options);
  assert.equal(c.support_grid[hole],0);assert.equal(c.quality_grid[hole],0);
  assert.equal(c.support_grid[hole+1],1);
});
test('maximum display grid stays within JS argument limits and survives project JSON',()=>{
  const r=fixture(),s=fixture('b');
  for(const result of [r,s]){
    const c=result.composite;c.grid_rows=c.grid_cols=c.surface_width=c.surface_height=256;
    for(const key of ['quality_grid','source_grid','aperture_grid'])c[key]=Array(65536).fill(1);
    for(const key of ['conflict_grid','reason_grid'])c[key]=Array(65536).fill(0);
    c.height_grid_nm=Array.from({length:65536},(_,i)=>10*((i%256/256-.5)**2+(Math.floor(i/256)/256-.5)**2));
  }
  const c=combineCaptures(r,s,options),restored=JSON.parse(JSON.stringify({composite:c}));
  assert.equal(compositeView(restored,2).stats.pixels,65536);
  assert.equal(c.registration.heldout_p90_nm,0);
});
