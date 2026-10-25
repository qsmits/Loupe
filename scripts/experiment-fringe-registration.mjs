// Analytic display-grid registration/fusion study, independent of reconstruction.
import {writeFileSync} from 'node:fs';
import {combineCaptures} from '../frontend/fringe-multicapture.js';
const points=[{x:.28,y:.28},{x:.72,y:.3},{x:.46,y:.76}];
const W=240,H=180,cols=120,rows=90;
const truth=(x,y)=>55*(x*x+.6*y*y)+12*Math.exp(-((x-.18)**2+(y+.1)**2)/.012);
function result(id,angle,sign,kind){
  const a=Math.cos(angle),b=Math.sin(angle),tx=W/2-a*W/2+b*H/2,ty=H/2-b*W/2-a*H/2;
  const c={version:1,grid_rows:rows,grid_cols:cols,surface_width:W,surface_height:H,form_model:'plane',wavelength_nm:632.8,
    sources:[{id:1,method:'hybrid',capture_index:0}],summaries:[1,2,3].map(cutoff=>({cutoff})),aperture_label:'drawn area',height_grid_nm:[],quality_grid:[],source_grid:[],conflict_grid:[],aperture_grid:[]};
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const x=(a*col*W/cols-b*row*H/rows+tx)/W-.5,y=(b*col*W/cols+a*row*H/rows+ty)/H-.5;
    const aperture=(x/.44)**2+(y/.44)**2<1&&Math.hypot(x+.12,y-.08)>.045;
    const visible=aperture&&(id==='reference'?x<.2:x>-.2);
    let z=truth(x,y);
    if(id!=='reference'){
      z+=8+13*x-6*y;
      if(kind==='patch'&&Math.hypot(x-.1,y-.1)<.035)z+=40;
      if(kind==='wrong-curvature')z+=500*(x*x+y*y);
      if(kind==='noise')z+=.8*Math.sin(col*19.17+row*8.23);
      z*=sign;
    }
    c.height_grid_nm.push(z);c.aperture_grid.push(aperture?1:0);c.quality_grid.push(visible?1:0);c.source_grid.push(visible?1:0);c.conflict_grid.push(0);
  }
  return {id,composite:c,t:{a,b,tx,ty}};
}
const records=[];
for(const angle of [0,.13,-.27])for(const kind of ['clean','noise','patch','wrong-curvature'])for(const sign of [1,-1]){
  const r=result('reference',0,1,kind),s=result('incoming',angle,sign,kind),t=s.t;
  const incomingPoints=points.map(p=>{const x=p.x*W-t.tx,y=p.y*H-t.ty;return {x:(t.a*x+t.b*y)/W,y:(-t.b*x+t.a*y)/H};});
  const record={angle_rad:angle,kind,sign,limit_nm:5};
  try{const c=combineCaptures(r,s,{referencePoints:points,incomingPoints,sign,thresholdNm:5});
    const good=c.quality_grid.map((q,i)=>q>0&&!c.conflict_grid[i]),added=good.map((v,i)=>v&&!r.composite.quality_grid[i]);
    const errors=c.height_grid_nm.map((z,i)=>Math.abs(z-truth((i%cols)/cols-.5,Math.floor(i/cols)/rows-.5))).filter((_,i)=>added[i]);
    Object.assign(record,{accepted:true,baseline_coverage_pct:100*r.composite.quality_grid.filter(Boolean).length/c.aperture_pixels,
      coverage_pct:c.summaries[1].coverage_pct,added_pixels:errors.length,added_max_error_nm:Math.max(0,...errors),
      heldout_p90_nm:c.registration.heldout_p90_nm,conflict_pixels:c.conflict_pixels,
      outside_pixels:good.filter((v,i)=>v&&!r.composite.aperture_grid[i]).length});
  }catch(error){Object.assign(record,{accepted:false,reason:error.message});}
  records.push(record);
}
writeFileSync(process.argv[2]||'/tmp/loupe-registration.json',JSON.stringify(records,null,2)+'\n');
console.log(JSON.stringify({cases:records.length,accepted:records.filter(r=>r.accepted).length,
  worst_added_nm:Math.max(...records.filter(r=>r.accepted).map(r=>r.added_max_error_nm)),
  wrong_curvature_rejected:records.filter(r=>r.kind==='wrong-curvature'&&!r.accepted).length,
  outside_pixels:records.reduce((a,r)=>a+(r.outside_pixels||0),0)},null,2));
