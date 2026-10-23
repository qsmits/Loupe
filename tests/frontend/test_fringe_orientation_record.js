import './dom-stub.js';
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {physicalOrientation, flipRecordedPolarity, polarityDescription, orientationSvg} from '../../frontend/fringe-orientation.js';
import {fr} from '../../frontend/fringe.js';
import {mergeReanalyzeResult} from '../../frontend/fringe-results.js';

it('keeps user observations separate from measurement zero and sign inference', () => {
  const data={height_grid:[1,-2,3], absolute_sign_known:false, reference_marks:[{label:'A',x:.2,y:.5}],
    physical_orientation:{gap_direction:'up-right',contact_label:'A',polarity:'red-larger-gap',notes:'Known wedge',recorded_at:'2026-10-23T10:00:00Z'}};
  fr.lastResult=data;
  mergeReanalyzeResult({pv_nm:5,absolute_sign_known:false});
  assert.equal(physicalOrientation(data).polarity,'red-larger-gap');
  assert.equal(data.absolute_sign_known,false);
  assert.deepEqual(data.height_grid,[1,-2,3]);
  flipRecordedPolarity(data);
  assert.equal(physicalOrientation(data).polarity,'red-smaller-gap');
  assert.equal(physicalOrientation(data).gap_direction,'up-right');
  assert.equal(physicalOrientation(data).recorded_at,'2026-10-23T10:00:00Z');
  flipRecordedPolarity(data);
  assert.equal(physicalOrientation(data).polarity,'red-larger-gap');
  assert.match(polarityDescription(data),/user-checked/);
});
it('does not inherit a contact or claim checked polarity for fresh results', () => {
  assert.equal(physicalOrientation({}).polarity,'unverified');
  const data={physical_orientation:{contact_label:'A',gap_direction:'<script>',polarity:'bad'}};
  assert.equal(physicalOrientation(data).contact_label,null);
  assert.equal(orientationSvg(data,300,200),'');
  assert.match(orientationSvg({physical_orientation:{gap_direction:'up'}},300,200),/gap opens/);
});
