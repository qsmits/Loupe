import './dom-stub.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeFormRemoval} from '../../frontend/fringe-form.js';
import {captureFringeOptions,restoreFringeResult} from '../../frontend/fringe-results.js';

test('new workspaces default to Plane, while explicit saved options survive',()=>{
 restoreFringeResult(null);
 assert.equal(captureFringeOptions().formModel,'plane');
 restoreFringeResult(null,{formModel:'zernike'});
 assert.equal(captureFringeOptions().formModel,'zernike');
 restoreFringeResult(null);
});
test('plane and offset-plus-tilt Zernike are flatness, not higher-order residuals',()=>{
 for(const data of [{form_model:'plane'},{form_model:'zernike',subtracted_terms:[1,2,3]},{}]) {
  const form=describeFormRemoval(data);
  assert.equal(form.tiltOnly,true);assert.equal(form.residual,false);
  assert.match(form.detail,/not minimum-zone/);
 }
});
test('any higher term or polynomial must be labelled residual and withheld from flatness comparison',()=>{
 for(const data of [{form_model:'poly2'},{form_model:'poly3'}, {subtracted_terms:[1,2,3,4]}, {subtracted_terms:[1,2,3,66]}]) {
  const form=describeFormRemoval(data);
  assert.equal(form.metric,'Residual');assert.equal(form.tiltOnly,false);
  assert.match(form.detail,/not total flatness/);
 }
});
test('selective or no tilt removal must not claim flatness',()=>{
 for(const terms of [[],[1],[1,2],[1,3]]) {
  const form=describeFormRemoval({subtracted_terms:terms});
  assert.equal(form.tiltOnly,false);assert.match(form.label,/partial\/no tilt/);
 }
});

test('trusted-only refresh preserves residual labels across form changes', async()=>{
 const {registerElement,resetElements}=await import('./dom-stub.js');
 const {fr}=await import('../../frontend/fringe.js');
 const {refreshTrustedOnlyDisplay}=await import('../../frontend/fringe-results.js');
 const labels=[];
 try {
  for(const suffix of ['pv','rms']) {
   const label={textContent:'Gap',dataset:{baseLabel:'Gap'},title:''}; labels.push(label);
   registerElement(`fringe-${suffix}-nm`,{style:{},classList:{toggle(){}},parentElement:{querySelector:()=>label}});
  }
  fr.lastResult={form_model:'plane',pv_nm:10,rms_nm:2}; fr.useTrustedOnly=false;
  refreshTrustedOnlyDisplay();assert.equal(labels[0].textContent,'Gap PV');
  fr.lastResult.form_model='poly2';
  refreshTrustedOnlyDisplay();assert.equal(labels[0].textContent,'Residual PV');
  fr.useTrustedOnly=true;
  refreshTrustedOnlyDisplay();assert.equal(labels[1].textContent,'Residual RMS (trusted)');
 } finally {resetElements();fr.lastResult=null;fr.useTrustedOnly=false;}
});
