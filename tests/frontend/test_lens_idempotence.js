import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-stub.js';
import { state } from '../../frontend/state.js';
import { setImageSize } from '../../frontend/viewport.js';
import { applyLensCorrection } from '../../frontend/lens-cal.js';
import { buildLoupeObject, parseLoupe } from '../../frontend/project-format.js';

// A tiny pixel canvas suffices to observe which image the remapper samples.
const create = document.createElement.bind(document);
const sampled = [];
document.createElement = tag => {
  const el = create(tag);
  if (tag === 'canvas') {
    const ctx = el.getContext('2d');
    el.getContext = () => ctx;
    ctx.createImageData = (w,h) => ({data:new Uint8ClampedArray(w*h*4)});
    ctx.getImageData = (x,y,w,h) => ({data:new Uint8ClampedArray(w*h*4),width:w,height:h});
    ctx.drawImage = image => sampled.push(image);
    el.toBlob = cb => cb(new Blob(['pixels'],{type:'image/png'}));
  }
  return el;
};
globalThis.fetch = async () => new Response('{}');

test('repeated and changed lens profiles sample the original; zero restores it', async () => {
  setImageSize(4,4);
  const original = {width:4,height:4};
  state.frozenBackground = original;
  state.frozenBlob = new Blob(['original']);
  state.lensSource = null;
  assert.equal(await applyLensCorrection(.1),true);
  const first = state.frozenBackground;
  const calls = sampled.length;
  await applyLensCorrection(.1);
  assert.equal(state.frozenBackground,first);
  assert.equal(sampled.length,calls);
  sampled.length=0;
  await applyLensCorrection(.2);
  assert.equal(sampled[0],original);
  await applyLensCorrection(0);
  assert.equal(state.frozenBackground,original);
  assert.equal(state.lensK1,0);
});
test('old corrected files without original pixels cannot be compounded', async () => {
  state.lensSource = {output:state.frozenBackground, k1:.1, unavailable:true};
  assert.equal(await applyLensCorrection(.1),true);
  assert.equal(await applyLensCorrection(.2),false);
});
test('original image is included in portable project round trip', () => {
  const data = 'data:image/png;base64,YQ==';
  const obj = buildLoupeObject({type:'microscopy',name:'Lens'},null,data,data);
  assert.equal(parseLoupe(JSON.stringify(obj)).lensOriginalDataUrl,data);
});

test('rejected correction leaves image, stored blob and measurements unchanged', async () => {
  const original = {width:4,height:4};
  const blob = new Blob(['original']);
  state.frozenBackground=original;
  state.frozenBlob=blob;
  state.annotations=[{type:'circle',id:1}];
  state.lensSource=null;
  state.lensK1=0;
  globalThis.fetch=async()=>new Response('Image too large',{status:413});
  assert.equal(await applyLensCorrection(.1),false);
  assert.equal(state.frozenBackground,original);
  assert.equal(state.frozenBlob,blob);
  assert.equal(state.lensK1,0);
  assert.equal(state.annotations.length,1);
});

test('fringe lens dropdown restores unsaved and saved coefficients accurately', async () => {
  const {registerElement}=await import('./dom-stub.js');
  const {renderFringeLensDropdown,saveFringeLensProfile}=await import('../../frontend/fringe-lens-profiles.js');
  const select=document.createElement('select');
  registerElement('fringe-lens-profile',select);
  assert.equal(renderFringeLensDropdown(.12),true);
  assert.equal(select.value,'__current_lens_calibration__');
  saveFringeLensProfile('Test lens',.12);
  assert.equal(renderFringeLensDropdown(.12),false);
  assert.equal(select.value,'Test lens');
  renderFringeLensDropdown(0);
  assert.equal(select.value,'');
});
