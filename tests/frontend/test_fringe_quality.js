import './dom-stub.js';
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {coveragePixels, qualityDescription} from '../../frontend/fringe-quality.js';

it('distinguishes measured, boundary, outside and trusted-only pixels', () => {
  const data={grid_rows:2,grid_cols:2, mask_grid:[1,1,0,0], diagnostic_mask_grid:[1,1,1,0],trusted_mask_grid:[1,0,0,0]};
  assert.deepEqual([...coveragePixels(data,true)], [45,212,191,100,157,110,229,175,245,158,11,190,0,0,0,160]);
  assert.deepEqual([...coveragePixels(data,false).slice(4,8)], [45,212,191,100]);
  assert.equal(coveragePixels({...data,diagnostic_mask_grid:[]}),null);
});
it('states coverage denominators, filter floors and trusted statistics explicitly', () => {
  const text=qualityDescription({coverage:{aperture_pixels:100, measured_pixels:60, boundary_excluded_pixels:40,requested_pixels:120}, analysis_filter:{sigma_across_px:5,sigma_along_px:2}},true).join(' ');
  assert.match(text,/60.0% of the detected/); assert.match(text,/50.0% of the drawn/);
  assert.match(text,/minimum filter width/); assert.match(text,/trusted subset/);
  assert.match(qualityDescription({}).join(' '),/unavailable/);
});

it('edge inspection leaves interior fringes clear and distinguishes selected rejected areas', async()=>{
  const {edgeInspectionPixels}=await import('../../frontend/fringe-quality.js');
  const info={grid_rows:3,grid_cols:3,regions:new Array(9).fill(1)};
  assert.deepEqual([...edgeInspectionPixels(info).slice(16,20)],[45,212,191,0]);
  for(const [region,rgb] of [[2,[245,158,11]],[3,[96,165,250]]]) {
    info.regions.fill(region);
    assert.deepEqual([...edgeInspectionPixels(info).slice(16,20)],[...rgb,35]);
  }
  assert.equal(edgeInspectionPixels({...info,grid_rows:10000}),null);
  assert.equal(edgeInspectionPixels({...info,regions:[]}),null);
});
it('discloses boundary width and possible loss of real roll-off',()=>{
  const text=qualityDescription({analysis_filter:{boundary_band_px:15}}).join(' ');
  assert.match(text,/15.0 analysis pixels/);
  assert.match(text,/not proof/);assert.match(text,/roll-off may be excluded/);
});

it('explains directional guards separately from the physical outline',()=>{
  const text=qualityDescription({
    coverage:{aperture_pixels:100,measured_pixels:60,boundary_excluded_pixels:40,requested_pixels:120,outline_source:'drawn'},
    analysis_filter:{boundary_band_px:27.5,boundary_across_px:27.5,boundary_along_px:15,preliminary_rim_px:0}
  }).join(' ');
  assert.match(text,/27.5 analysis pixels across \/ 15.0 along/);
  assert.match(text,/No additional fixed-width rim trim/);
  assert.match(text,/Drawing an area does not make every pixel valid/);
  assert.doesNotMatch(text,/square support|Earlier aperture trimming/);
});

it('opens edge inspection before image decoding without replacing the photo, and toggles only the outlines', async () => {
  const {registerElement, resetElements} = await import('./dom-stub.js');
  const {refreshQuality} = await import('../../frontend/fringe-quality.js');
  const createElement = document.createElement;
  const ImageClass = globalThis.Image;
  const photo = {}, toggle = {checked:true}, close = {}, note = {};
  let drawn;
  const overlay = {getContext:()=>({
    createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
    putImageData:image=>{drawn=image.data;},
  })};
  const parts = {'[data-edge-image]':photo,'[data-edge-overlay]':toggle,
    '[data-edge-close]':close,'[data-edge-note]':note,'[data-edge-outlines]':overlay};
  const dialog = {style:{},setAttribute(){},querySelector:s=>parts[s],querySelectorAll:()=>[],
    addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},remove(){}};
  const button = {};
  registerElement('fringe-edge-inspection-button',button);
  document.createElement = tag => tag==='dialog' ? dialog : createElement(tag);
  // The photo deliberately never loads. Opening and toggling must not depend
  // on a second Image instance, canvas drawImage, or a serialized composite.
  globalThis.Image = class {constructor(){throw new Error('Unexpected photo compositing');}};
  try {
    refreshQuality({edge_inspection:{image_b64:'original-photo',grid_rows:3,grid_cols:3,regions:Array(9).fill(1)}});
    button.onclick();
    assert.equal(dialog.open,true);
    assert.equal(photo.src,'data:image/png;base64,original-photo');
    assert.equal(drawn[19],0); // measured interior remains transparent
    assert.equal(drawn[3],230); // boundary is visible
    for (const checked of [false,true,false,true]) {
      toggle.checked=checked;toggle.onchange();
      assert.equal(overlay.hidden,!checked);
      assert.equal(photo.src,'data:image/png;base64,original-photo');
    }
    close.onclick();
    button.onclick();
    assert.equal(dialog.open,true);
    assert.equal(photo.src,'data:image/png;base64,original-photo');
  } finally {
    refreshQuality(null);
    document.createElement=createElement;globalThis.Image=ImageClass;resetElements();
  }
});

it('draws a shared measured boundary in teal without a second amber outline', async()=>{
  const {edgeInspectionPixels}=await import('../../frontend/fringe-quality.js');
  const regions=Array.from({length:7*7},(_,i)=>{
    const x=i%7,y=Math.floor(i/7);
    return x===0||y===0||x===6||y===6 ? 0 : x>=2&&x<=4&&y>=2&&y<=4 ? 1 : 2;
  });
  const pixels=edgeInspectionPixels({grid_rows:7,grid_cols:7,regions});
  const at=(x,y)=>[...pixels.slice((y*7+x)*4,(y*7+x)*4+4)];
  assert.deepEqual(at(2,3),[45,212,191,230]);
  assert.deepEqual(at(1,3),[245,158,11,35]);
  assert.deepEqual(at(1,1),[245,158,11,220]);
  assert.deepEqual(at(3,3),[45,212,191,0]);
});

it('explains absent blue regions without implying rejected pixels are measured', async()=>{
  const {edgeSelectionLegend}=await import('../../frontend/fringe-quality.js');
  assert.match(edgeSelectionLegend({edge_inspection:{regions:[0,1,2],has_user_selection:false}}),/Automatic area.*no blue region/);
  assert.match(edgeSelectionLegend({edge_inspection:{regions:[0,1,2,3],has_user_selection:true}}),/color:#60a5fa.*selected area rejected/);
  assert.match(edgeSelectionLegend({edge_inspection:{regions:[0,1,2],has_user_selection:true},coverage:{selected_rejected_pixels:4}}),/too small.*preview resolution/);
  assert.match(edgeSelectionLegend({edge_inspection:{regions:[0,1,2],has_user_selection:true},coverage:{selected_rejected_pixels:0}}),/No selected rejected area/);
});

it('explains fit rejection and full fallback without implying independent confirmation',()=>{
  const text=qualityDescription({analysis_method:'hybrid',hybrid_diagnostics:{
    local_pixels:0,added_pixels:0,fallback_pixels:60,sigma_across_px:5,sigma_along_px:2,
    fit_checks:{aperture_pixels:100,passed_pixels:0,first_rejection:{conditioning:2,contrast:3,image_residual:95,window_disagreement:0}},
    merge_checks:{transition_supported:0,insufficient_anchor_pixels:0,anchor_disagreement_pixels:0}
  }}).join(' ');
  assert.match(text,/Current estimate everywhere/);
  assert.match(text,/0 of 100 pixels passed/);
  assert.match(text,/image does not fit the fringe model: 95/);
  assert.match(text,/do not independently confirm/);
});
