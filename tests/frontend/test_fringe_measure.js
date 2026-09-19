import { registerElement, resetElements } from './dom-stub.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { fr } from '../../frontend/fringe.js';
import { updateStepReadout } from '../../frontend/fringe-measure.js';

let readout;
beforeEach(() => {
  resetElements();
  readout = { textContent: '', innerHTML: '' };
  registerElement('fringe-measure-readout', readout);
  fr.gridRows = 80; fr.gridCols = 100;
  // A poly3-form-removed display is NOT a valid basis for physical steps.
  fr.heightGrid = new Float32Array(8000);
  fr.maskGrid = new Uint8Array(8000).fill(1);
  fr.useTrustedOnly = false;
  fr.lastResult = {
    raw_height_grid_nm: Array.from({length:8000}, (_,i)=>300*(i%100)/100+100*(i%100>=50)),
    wavelength_nm: 589.3,
  };
  fr.stepRegions = [{x0:.1,x1:.39,y0:.2,y1:.8}, {x0:.6,x1:.89,y0:.2,y1:.8}];
});

it('renders the raw parallel-plane result, not the display mean difference', () => {
  updateStepReadout();
  assert.match(readout.innerHTML, /step = -100.0 nm/);
  assert.match(readout.innerHTML, /Fringe order and absolute sign unverified/);
  assert.match(readout.innerHTML, /scatter SEM/);
});

it('never silently falls back to a form-removed grid', () => {
  delete fr.lastResult.raw_height_grid_nm;
  updateStepReadout();
  assert.match(readout.textContent, /Raw height data/);
  assert.equal(readout.innerHTML, '');
});

it('refuses overlapping plateaus', () => {
  fr.stepRegions[1] = {...fr.stepRegions[0]};
  updateStepReadout();
  assert.match(readout.textContent, /must not overlap/);
});
