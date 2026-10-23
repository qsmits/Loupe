import { it } from 'node:test';
import assert from 'node:assert/strict';
import { surface3dValues, surface3dDescription } from '../../frontend/fringe-surface-3d.js';
import { confirmOrientation, clearOrientationVerification, flipRecordedPolarity } from '../../frontend/fringe-orientation.js';

function scene(side = 1) {
  // Known convex specimen: centre raised above its rim. Positive gap carrier
  // gives a negative centre residual; choosing the opposite sideband negates it.
  return {carrier: {fx_cpp: 0, fy_cpp: side * .1}, carrier_phase_sign: 1,
    reference_marks: [{label:'A',x:.5,y:0}],
    physical_orientation: {contact_label:'A',gap_direction:'down'},
    height_grid: [20, -40, 20].map(x => x * side), pv_nm:60, rms_nm:28};
}
const mask = [1,1,1];
it('raises a known convex centre for either checked carrier sign, retaining map colors', () => {
  for (const side of [-1,1]) {
    const data = scene(side), original = data.height_grid.slice();
    const before = surface3dValues(data, data.height_grid, mask, 10);
    assert.ok(confirmOrientation(data));
    const after = surface3dValues(data, data.height_grid, mask, 10);
    assert.ok(after.z[1] > after.z[0]);
    assert.deepEqual(after.colors, before.colors);
    assert.ok(side === 1 ? after.colors[5] > after.colors[3] : after.colors[3] > after.colors[5]);
    assert.deepEqual(data.height_grid, original);
    assert.equal(data.pv_nm,60); assert.equal(data.rms_nm,28);
    assert.match(surface3dDescription(data), /Part deviation.*user-checked/);
  }
});
it('keeps checked geometry fixed through explicit map inversion and restores uncertainty on invalidation', () => {
  const data = scene();
  confirmOrientation(data);
  const before = surface3dValues(data, data.height_grid, mask, 10);
  data.height_grid = data.height_grid.map(v => -v);
  flipRecordedPolarity(data);
  const after = surface3dValues(data, data.height_grid, mask, 10);
  assert.deepEqual(after.z, before.z);
  assert.notDeepEqual(after.colors, before.colors);
  clearOrientationVerification(data);
  assert.match(surface3dDescription(data), /Unverified.*may be reversed/);
});
it('invalidating contact evidence stops interpreting raw heights as specimen geometry', () => {
  const data = scene();
  confirmOrientation(data);
  const checked = surface3dValues(data, data.height_grid, mask, 10);
  data.reference_marks[0].x = .3;
  const unverified = surface3dValues(data, data.height_grid, mask, 10);
  assert.ok(checked.z[1] > checked.z[0]);
  assert.ok(unverified.z[1] < unverified.z[0]);
  assert.match(surface3dDescription(data), /Unverified/);
});
it('uses zero-centered map colors even with an asymmetric range and excludes masked outliers', () => {
  const {z,colors} = surface3dValues({}, [-100,-10,0,20,1e9], [1,1,1,1,0], 20);
  assert.ok(colors[5] > colors[3], 'negative residual stays blue even above the midrange');
  assert.equal(colors[6], colors[8], 'zero is neutral');
  assert.ok(colors[9] > colors[11], 'positive residual is red');
  assert.ok(Math.abs(z[0] + .1) < 1e-7);
  assert.ok(Math.abs(z[3] - .1) < 1e-7);
  assert.deepEqual([...surface3dValues({}, [0,0], [1,1], 10).z], [0,0]);
});
