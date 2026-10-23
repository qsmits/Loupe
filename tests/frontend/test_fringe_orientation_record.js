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

const {orientationGuidance, confirmOrientation, clearOrientationVerification, orientationDescription, shapeInterpretation}=await import('../../frontend/fringe-orientation.js');
function scene(direction='right', fx=.08, fy=0) {
  return {carrier:{fx_cpp:fx,fy_cpp:fy},carrier_phase_sign:1,absolute_sign_known:false,
    reference_marks:[{label:'A',x:.5,y:.5}],physical_orientation:{contact_label:'A',gap_direction:direction},
    height_grid:[-10,0,10],pv_nm:20,rms_nm:8};
}
it('requires physical evidence and explicit confirmation; never changes measurements',()=>{
  const data=scene(), heights=data.height_grid.slice();
  assert.equal(orientationGuidance(data).polarity,'red-larger-gap');
  assert.match(polarityDescription(data),/unverified/);
  assert.equal(confirmOrientation(data),true);
  assert.match(polarityDescription(data),/red = lower/);
  assert.equal(data.absolute_sign_known,false);
  assert.deepEqual(data.height_grid,heights); assert.equal(data.pv_nm,20);
  assert.match(orientationDescription(data).join(' '),/user-confirmed contact/);
  assert.match(shapeInterpretation(physicalOrientation(data).polarity),/redder.*concave/);
  clearOrientationVerification(data);
  assert.match(polarityDescription(data),/unverified/);
});
it('matches externally known wedge direction for both sidebands and every image direction',()=>{
  const vectors={right:[1,0],left:[-1,0],up:[0,-1],down:[0,1],'up-right':[1,-1],'down-left':[-1,1],'down-right':[1,1],'up-left':[-1,-1]};
  for(const [direction,[dx,dy]] of Object.entries(vectors)) for(const side of [-1,1]) {
    const data=scene(direction,dx*.08*side,dy*.08*side);
    const expected=side===1?'red-larger-gap':'red-smaller-gap';
    assert.equal(orientationGuidance(data).polarity,expected);
    // An inversion before verification must also be tracked.
    flipRecordedPolarity(data);
    assert.notEqual(orientationGuidance(data).polarity,expected);
    assert.ok(confirmOrientation(data));
    const timestamp=data.physical_orientation.recorded_at;
    flipRecordedPolarity(data);
    assert.equal(physicalOrientation(data).polarity,expected);
    assert.equal(data.physical_orientation.recorded_at,timestamp);
    assert.equal(orientationGuidance(data).polarity,expected);
  }
});
it('blocks absent or inconsistent evidence and legacy or derived carrier histories',()=>{
  const cases=[d=>delete d.reference_marks,d=>d.physical_orientation.gap_direction='unknown',
    d=>delete d.carrier_phase_sign,d=>d.carrier.fx_cpp=NaN,
    d=>d.physical_orientation.gap_direction='up',d=>d.warnings=['The surface sidebands run into DC.'],
    d=>{d.reference_marks[0].x=1;d.grid_rows=3;d.grid_cols=3;d.mask_grid=Array(9).fill(1);}];
  for(const mutate of cases) {
    const data=scene();mutate(data);
    assert.equal(orientationGuidance(data).polarity,null);
    assert.equal(confirmOrientation(data),false);
    assert.equal(physicalOrientation(data).polarity,'unverified');
  }
});
it('invalidates moved or deleted contact and changed direction, including saved records',()=>{
  for(const mutate of [d=>d.reference_marks[0].x=.6,d=>d.reference_marks=[],d=>d.physical_orientation.gap_direction='left']) {
    const data=scene();confirmOrientation(data);
    const saved=structuredClone(data);
    mutate(data);
    assert.equal(physicalOrientation(data).polarity,'unverified');
    assert.equal(physicalOrientation(JSON.parse(JSON.stringify(data))).polarity,'unverified');
    assert.equal(physicalOrientation(saved).polarity,'red-larger-gap');
  }
});
it('anchors the gap arrow at the contact on both views',()=>{
  const data=scene();data.reference_marks[0]={label:'A',x:.2,y:.7};
  assert.match(orientationSvg(data,200,100),/M52,70L84,70/);
});
it('warns when removed curvature makes original shape interpretation unavailable', async()=>{
  const {formRemovalNotice}=await import('../../frontend/fringe-orientation.js');
  for(const data of [{form_model:'poly2'},{form_model:'poly3'},{subtracted_terms:[1,2,3,4]}]) {
    assert.match(formRemovalNotice(data),/Curvature has been removed/);
  }
  assert.doesNotMatch(formRemovalNotice({form_model:'plane'}),/has been removed/);
});
it('offers a recovery action for legacy results and preserves only aligned observations', async()=>{
  const {recoverOrientationObservations}=await import('../../frontend/fringe-orientation.js');
  const previous=scene();delete previous.carrier_phase_sign;
  previous.reference_image_b64='aligned';previous.surface_width=200;previous.surface_height=100;
  previous.physical_orientation.polarity='red-smaller-gap';
  assert.equal(orientationGuidance(previous).action,'reanalyze');
  const next={reference_image_b64:'aligned',surface_width:200,surface_height:100,carrier_phase_sign:1,carrier:previous.carrier};
  assert.equal(recoverOrientationObservations(previous,next),true);
  assert.deepEqual(next.reference_marks,previous.reference_marks);
  assert.equal(physicalOrientation(next).polarity,'unverified');
  assert.equal(orientationGuidance(next).polarity,'red-larger-gap');
  next.reference_marks[0].x=.6;
  assert.equal(previous.reference_marks[0].x,.5);
  for(const other of [{reference_image_b64:'different'}, {...next,surface_width:300}]) {
    assert.equal(recoverOrientationObservations(previous,other),false);
  }
});

it('distinguishes zero contact gap from the colored residual map in guidance and exports', async()=>{
  const {contactMapExplanation}=await import('../../frontend/fringe-orientation.js');
  const data=scene();
  assert.match(contactMapExplanation(data),/contact A, the actual air gap is zero/);
  assert.match(contactMapExplanation(data),/contact point can therefore be any color/);
  assert.match(orientationGuidance(data).reason,/after slope\/form removal/);
  assert.ok(confirmOrientation(data));
  assert.match(polarityDescription(data),/after slope\/form removal/);
  assert.match(orientationDescription(data).join(' '),/does not give the absolute gap/);
});
