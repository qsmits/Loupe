import { resetElements } from './dom-stub.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { surfaceColor, surfaceOverlayPixels, makeImageCalibration, imageDistancePixels, imageDistanceMm, distanceSvg } from '../../frontend/fringe-spatial.js';
import { fr } from '../../frontend/fringe.js';
import { mergeReanalyzeResult } from '../../frontend/fringe-results.js';
import { captureInstrument, restoreInstrument } from '../../frontend/instrument-workspace.js';

it('matches the blue / white / red map endpoints and leaves excluded pixels transparent', () => {
  assert.deepEqual(surfaceColor(-10,10),[5,48,97]);
  assert.deepEqual(surfaceColor(0,10),[247,247,247]);
  assert.deepEqual(surfaceColor(10,10),[103,0,31]);
  const result={surface_color_limit_nm:10,grid_rows:2,grid_cols:2,height_grid:[-10,0,10,NaN],mask_grid:[1,0,1,1]};
  assert.deepEqual([...surfaceOverlayPixels(result)],[5,48,97,255,0,0,0,0,103,0,31,255,0,0,0,0]);
  assert.equal(surfaceOverlayPixels({...result,surface_color_limit_nm:null}),null);
  assert.equal(surfaceOverlayPixels({...result,mask_grid:[1]}),null);
});
it('uses the rendered display values after inversion, with the exact full-resolution range', () => {
  const r={surface_color_limit_nm:20,grid_rows:1,grid_cols:2,height_grid:[-10,10],display_height_grid_nm:[10,-10],mask_grid:[1,1]};
  const pixels=surfaceOverlayPixels(r);
  assert.deepEqual([...pixels.slice(0,3)],surfaceColor(10,20));
  assert.deepEqual([...pixels.slice(4,7)],surfaceColor(-10,20));
});
it('calibrates non-square cropped images and measures in both axes regardless of display size', () => {
  const r={surface_width:800,surface_height:400};
  const a={x:.1,y:.2}, b={x:.6,y:.2};
  assert.equal(imageDistancePixels(r,a,b),400);
  r.lateral_calibration=makeImageCalibration(r,a,b,20);
  assert.equal(imageDistanceMm(r,a,b),20);
  assert.equal(imageDistanceMm(r,{x:.1,y:.1},{x:.1,y:.6}),10);
  assert.equal(imageDistanceMm(r,{x:0,y:0},{x:.3,y:.8}),20); // 240/320/400 triangle
  assert.match(distanceSvg([a,b],800,400),/M80,80 L480,80/);
  assert.match(distanceSvg([a,b],400,200),/M40,40 L240,40/);
});
it('rejects missing, invalid, too-short and mismatched calibrations', () => {
  const r={surface_width:800,surface_height:400},a={x:.1,y:.1},b={x:.6,y:.1};
  for (const mm of [0,-1,NaN,Infinity,'bad']) assert.equal(makeImageCalibration(r,a,b,mm),null);
  assert.equal(makeImageCalibration(r,a,a,20),null);
  assert.equal(makeImageCalibration(r,a,{x:2,y:0},20),null);
  assert.equal(imageDistanceMm(r,a,b),null);
  r.lateral_calibration=makeImageCalibration(r,a,b,20);
  assert.equal(imageDistanceMm({...r,surface_width:400},a,b),null);
});
it('keeps image scale through project save and form/inversion updates, never on a new result', () => {
  resetElements();
  const r={surface_width:800,surface_height:400,wavelength_nm:589.3,pv_nm:10};
  r.lateral_calibration=makeImageCalibration(r,{x:0,y:0},{x:.5,y:0},20);
  fr.lastResult=r;
  const saved=captureInstrument(fr,{lastResult:null},null);
  fr.lastResult.lateral_calibration.length_mm=999;
  restoreInstrument(fr,{lastResult:null},saved,null);
  mergeReanalyzeResult({surface_color_limit_nm:3,height_grid:[1],surface_map:'inverted'});
  assert.equal(fr.lastResult.lateral_calibration.length_mm,20);
  assert.equal(fr.lastResult.wavelength_nm,589.3);
  assert.equal(fr.lastResult.pv_nm,10);
  assert.equal(fr.lastResult.surface_color_limit_nm,3);
  restoreInstrument(fr,{lastResult:null},null,null);
  assert.equal(fr.lastResult,null);
});
