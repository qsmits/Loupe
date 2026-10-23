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
