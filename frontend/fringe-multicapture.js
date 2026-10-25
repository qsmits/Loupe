// Experimental fusion of measured display samples. No inferred heights in holes.
import {compositeView} from './fringe-composite.js';
const finite=Number.isFinite;
const median=a=>quantile(a,.5);
function quantile(a,p){const b=[...a].sort((x,y)=>x-y);return b[Math.min(b.length-1,Math.floor(p*b.length))];}
function solve(a,b){
  const m=a.map((row,i)=>[...row,b[i]]);
  for(let j=0;j<3;j++){
    let k=j;for(let i=j+1;i<3;i++)if(Math.abs(m[i][j])>Math.abs(m[k][j]))k=i;
    [m[j],m[k]]=[m[k],m[j]];
    if(Math.abs(m[j][j])<1e-9)throw new Error('Overlap is too narrow to align slope.');
    const d=m[j][j];for(let t=j;t<4;t++)m[j][t]/=d;
    for(let i=0;i<3;i++)if(i!==j){const v=m[i][j];for(let t=j;t<4;t++)m[i][t]-=v*m[j][t];}
  }
  return m.map(row=>row[3]);
}
function fitPlane(points){
  let coef=[median(points.map(p=>p[2])),0,0];
  for(let iter=0;iter<6;iter++){
    const errors=points.map(([x,y,z])=>Math.abs(z-coef[0]-coef[1]*x-coef[2]*y));
    const scale=Math.max(.05,1.4826*median(errors));
    const a=Array.from({length:3},()=>[0,0,0]),b=[0,0,0];
    points.forEach(([x,y,z],i)=>{const v=[1,x,y],w=Math.min(1,1.5*scale/Math.max(errors[i],1e-12));
      for(let j=0;j<3;j++){b[j]+=w*v[j]*z;for(let k=0;k<3;k++)a[j][k]+=w*v[j]*v[k];}});
    coef=solve(a,b);
  }
  return coef;
}
const area=p=>(p[1].x-p[0].x)*(p[2].y-p[0].y)-(p[1].y-p[0].y)*(p[2].x-p[0].x);
export function registerLandmarks(reference,incoming,referenceSize,incomingSize){
  if(reference.length!==3||incoming.length!==3)throw new Error('Choose three matching landmarks in each image.');
  const convert=(points,size)=>{
    if(![size.width,size.height].every(v=>finite(v)&&v>1))throw new Error('Invalid image geometry.');
    if(points.some(p=>![p.x,p.y].every(v=>finite(v)&&v>=0&&v<=1)))throw new Error('Landmarks must lie on the images.');
    if(Math.abs(area(points))<.005)throw new Error('Spread the three landmarks across the part; avoid a straight line.');
    return points.map(p=>({x:p.x*size.width,y:p.y*size.height}));
  };
  const r=convert(reference,referenceSize),s=convert(incoming,incomingSize);
  if(area(r)*area(s)<=0)throw new Error('Landmarks imply a reflection. Use the same physical side and landmark order.');
  const mean=p=>({x:p.reduce((a,v)=>a+v.x,0)/3,y:p.reduce((a,v)=>a+v.y,0)/3});
  const rc=mean(r),sc=mean(s);let dot=0,cross=0,den=0;
  for(let i=0;i<3;i++){const x=s[i].x-sc.x,y=s[i].y-sc.y,u=r[i].x-rc.x,v=r[i].y-rc.y;dot+=x*u+y*v;cross+=x*v-y*u;den+=x*x+y*y;}
  const a=dot/den,b=cross/den,tx=rc.x-a*sc.x+b*sc.y,ty=rc.y-b*sc.x-a*sc.y;
  const errors=r.map((p,i)=>Math.hypot(a*s[i].x-b*s[i].y+tx-p.x,b*s[i].x+a*s[i].y+ty-p.y));
  const rms=Math.sqrt(errors.reduce((t,v)=>t+v*v,0)/3);
  if(Math.max(...errors)>2.5)throw new Error('Landmarks do not align within 2.5 analysis pixels. Check the points or camera perspective.');
  return {a,b,tx,ty,rms_px:rms,scale:Math.hypot(a,b)};
}
// Payload grids use cv2 nearest sampling: their actual sample sites are floor(k*size/count).
function interval(value,size,count){
  if(value<0||value>Math.floor((count-1)*size/count))return null;
  let k=Math.min(count-2,Math.floor(value*count/size));
  while(k<count-2&&Math.floor((k+1)*size/count)<value)k++;
  const lo=Math.floor(k*size/count),hi=Math.floor((k+1)*size/count);
  return [k,(value-lo)/(hi-lo)];
}
function sample(c,x,y){
  const ix=interval(x,c.surface_width,c.grid_cols),iy=interval(y,c.surface_height,c.grid_rows);
  if(!ix||!iy)return null;
  const [col,u]=ix,[row,v]=iy,ids=[row*c.grid_cols+col,row*c.grid_cols+col+1,(row+1)*c.grid_cols+col,(row+1)*c.grid_cols+col+1];
  if(ids.some(i=>!c.aperture_grid[i]||!c.quality_grid[i]||c.conflict_grid[i]||!finite(c.height_grid_nm[i])))return null;
  const weights=[(1-u)*(1-v),u*(1-v),(1-u)*v,u*v];
  return {height:ids.reduce((sum,i,j)=>sum+c.height_grid_nm[i]*weights[j],0),quality:Math.max(...ids.map(i=>c.quality_grid[i]))};
}
export function combineCaptures(reference,incoming,{referencePoints,incomingPoints,sign,thresholdNm=20}={}){
  const ref=compositeView(reference,3).c,src=compositeView(incoming,3).c;
  if(ref.kind==='multi'||src.kind==='multi')throw new Error('Combine original captures, not previously combined results.');
  if(reference===incoming||(reference.id&&reference.id===incoming.id))throw new Error('Choose a different capture.');
  if(ref.form_model!=='plane'||src.form_model!=='plane')throw new Error('Both captures must use Plane removal. Analyze them with Plane first.');
  if(![ref,src].every(c=>[c.surface_width,c.surface_height].every(v=>Number.isInteger(v)&&v>=2)&&c.grid_rows>=2&&c.grid_cols>=2&&c.surface_width>=c.grid_cols&&c.surface_height>=c.grid_rows))throw new Error('Invalid image geometry.');
  if(![1,-1].includes(sign))throw new Error('Confirm whether the analysis-time height directions are the same or reversed.');
  if(!finite(thresholdNm)||thresholdNm<=0||thresholdNm>1000)throw new Error('Overlap limit must be greater than zero and at most 1000 nm.');
  const t=registerLandmarks(referencePoints,incomingPoints,{width:ref.surface_width,height:ref.surface_height},{width:src.surface_width,height:src.surface_height});
  const n=ref.grid_rows*ref.grid_cols,other=Array(n).fill(null),overlap=[];
  const usable=i=>ref.aperture_grid[i]&&ref.quality_grid[i]>0&&!ref.conflict_grid[i]&&finite(ref.height_grid_nm[i]);
  for(let i=0;i<n;i++){
    if(!ref.aperture_grid[i])continue;
    const col=i%ref.grid_cols,row=Math.floor(i/ref.grid_cols),x=Math.floor(col*ref.surface_width/ref.grid_cols),y=Math.floor(row*ref.surface_height/ref.grid_rows);
    const dx=x-t.tx,dy=y-t.ty,den=t.a*t.a+t.b*t.b;
    const s=sample(src,(t.a*dx+t.b*dy)/den,(-t.b*dx+t.a*dy)/den);
    if(!s)continue;s.height*=sign;other[i]=s;
    if(usable(i)&&ref.quality_grid[i]<=2&&s.quality<=2)overlap.push([col/ref.grid_cols-.5,row/ref.grid_rows-.5,ref.height_grid_nm[i]-s.height,i]);
  }
  if(overlap.length<100)throw new Error('Need at least 100 overlapping grid samples with stronger or expanded evidence.');
  for(const axis of [0,1]){
    let low=Infinity,high=-Infinity;for(const p of overlap){low=Math.min(low,p[axis]);high=Math.max(high,p[axis]);}
    if(high-low<.25)throw new Error('Reliable overlap must span at least a quarter of the image in both directions.');
  }
  const fold=p=>(Math.floor((p[3]%ref.grid_cols)/8)+Math.floor(Math.floor(p[3]/ref.grid_cols)/8))%2;
  const train=overlap.filter(p=>!fold(p)),test=overlap.filter(fold);
  if(Math.min(train.length,test.length)<40)throw new Error('Not enough separate overlap blocks to validate alignment.');
  const held=fitPlane(train),errors=test.map(([x,y,z])=>Math.abs(z-held[0]-held[1]*x-held[2]*y));
  const p90=quantile(errors,.9);
  if(p90>thresholdNm)throw new Error(`Held-out overlap differs by ${p90.toFixed(2)} nm (90th percentile), above the ${thresholdNm} nm limit. Check alignment and direction; do not combine yet.`);
  const plane=fitPlane(overlap),c={...ref,kind:'multi',statistics_resolution:'display_grid',diagnostics:undefined,
    photographic_pixels:undefined,without_photographic_summaries:undefined,
    source_grid:Array(n).fill(0),quality_grid:Array(n).fill(0),height_grid_nm:Array(n).fill(0),conflict_grid:Array(n).fill(0),reason_grid:Array(n).fill(0),
    support_grid:Array(n).fill(0),spread_grid_nm:Array(n).fill(null),
    sources:[{id:1,capture_index:0,capture_id:reference.id||null,method:'registered_capture',wavelength_nm:ref.wavelength_nm},
      {id:2,capture_index:1,capture_id:incoming.id||null,method:'registered_capture',wavelength_nm:src.wavelength_nm}],
    registration:{...t,reference_points:referencePoints,incoming_points:incomingPoints,sign,threshold_nm:thresholdNm,overlap_pixels:overlap.length,heldout_p90_nm:p90,alignment_plane_nm:plane},
    reference:'Reference capture air-gap departure; incoming offset and tilt aligned on overlap. Physical direction unverified.'};
  for(let i=0;i<n;i++){
    if(!ref.aperture_grid[i])continue;
    const r=usable(i)?{height:ref.height_grid_nm[i],quality:ref.quality_grid[i],source:1}:null;
    const s=other[i]?{...other[i],source:2}:null;
    if(s)s.height+=plane[0]+plane[1]*(i%ref.grid_cols/ref.grid_cols-.5)+plane[2]*(Math.floor(i/ref.grid_cols)/ref.grid_rows-.5);
    const values=[r,s].filter(Boolean);c.support_grid[i]=values.length;
    // Known ambiguity in the reference is not silently replaced by another frame.
    if(ref.conflict_grid[i]){c.conflict_grid[i]=1;c.reason_grid[i]=ref.reason_grid?.[i]||1;}
    if(!values.length)continue;
    const best=r&&(!s||r.quality<=s.quality)?r:s;
    c.height_grid_nm[i]=best.height;c.quality_grid[i]=Math.max(best.quality,values.length===1?2:1);c.source_grid[i]=best.source;
    if(values.length===2){c.spread_grid_nm[i]=Math.abs(r.height-s.height);if(c.spread_grid_nm[i]>thresholdNm){c.conflict_grid[i]=1;c.reason_grid[i]|=4;}}
  }
  c.aperture_pixels=c.aperture_grid.filter(Boolean).length;c.conflict_pixels=c.conflict_grid.filter(Boolean).length;
  c.summaries=[1,2,3].map(cutoff=>{const values=c.height_grid_nm.filter((_,i)=>c.quality_grid[i]>0&&c.quality_grid[i]<=cutoff&&!c.conflict_grid[i]);
    const mean=values.reduce((a,v)=>a+v,0)/values.length;
    let low=Infinity,high=-Infinity;for(const value of values){low=Math.min(low,value);high=Math.max(high,value);}
    return {cutoff,pixels:values.length,coverage_pct:100*values.length/Math.max(1,c.aperture_pixels),pv_nm:values.length?high-low:null,rms_nm:values.length?Math.sqrt(values.reduce((a,v)=>a+(v-mean)**2,0)/values.length):null};});
  return c;
}
